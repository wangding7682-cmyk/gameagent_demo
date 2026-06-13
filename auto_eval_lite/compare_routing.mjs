// Step 1 vs Quick Run 路由准确率对比
import fs from 'fs';

// 加载 cases
const cases = fs.readFileSync('data/cases.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const expected = {};
for (const c of cases) expected[c.id] = c.expected_intent;

// 旧版（关键词路由）：从 quick_run 的 judged_results.jsonl
const oldRows = fs.readFileSync('runs/20260609_144026/judged_results.jsonl', 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(r => r.track === 'main_fast');

// 新版（LLM 路由）：从 llm_route_run_console.log 解析预测阶段（PowerShell 重定向产生 UTF-16 LE）
const buf = fs.readFileSync('runs/llm_route_run_console.log');
const isUtf16Le = buf[0] === 0xff && buf[1] === 0xfe;
const log = (isUtf16Le ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
const newIntents = {};
for (const line of log.split('\n')) {
  const m = line.match(/AGC-(\d+).*intent=(\w+)/);
  if (m) newIntents['AGC-' + m[1]] = m[2];
}

let oldHit = 0, newHit = 0, total = 0;
const flipped = [];
for (const id of Object.keys(expected)) {
  const exp = expected[id];
  const oldR = oldRows.find(r => r.case_id === id);
  const oldI = oldR ? oldR.actual_intent : null;
  const newI = newIntents[id];
  if (!newI) continue;  // skip timeout
  total++;
  if (oldI === exp) oldHit++;
  if (newI === exp) newHit++;
  if (oldI !== newI) flipped.push({ id, q: cases.find(c => c.id === id).question.slice(0, 30), exp, oldI, newI });
}

console.log('===== 路由准确率对比（main_fast 50 cases）=====');
console.log('旧版 (规则路由):  ' + oldHit + '/' + total + ' = ' + (oldHit / total * 100).toFixed(1) + '%');
console.log('新版 (LLM 路由):  ' + newHit + '/' + total + ' = ' + (newHit / total * 100).toFixed(1) + '%');
console.log('提升:             +' + ((newHit - oldHit) / total * 100).toFixed(1) + 'pp');
console.log('');
console.log('===== 路由变化明细（共 ' + flipped.length + ' 条）=====');
for (const f of flipped) {
  const oldOk = f.oldI === f.exp ? '✓' : '✗';
  const newOk = f.newI === f.exp ? '✓' : '✗';
  const verdict = f.oldI !== f.exp && f.newI === f.exp ? ' [修复]' : f.oldI === f.exp && f.newI !== f.exp ? ' [回归]' : '';
  console.log('  ' + f.id + ' expected=' + f.exp.padEnd(10) + ' old=' + f.oldI.padEnd(10) + oldOk + ' new=' + f.newI.padEnd(10) + newOk + ' | ' + f.q + verdict);
}
