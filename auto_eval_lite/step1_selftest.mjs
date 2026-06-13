// Step 1 自测：验证 LLM Main_Agent 是否正确生成 4 字段 + 修正路由
const cases = [
  { id: 'S1', q: '怎么打亚索？', expect: 'strategy', desc: '强战术词命中' },
  { id: 'S2', q: '怎么防 gank？', expect: 'strategy', desc: '弱战术词漏判（旧规则→smalltalk）' },
  { id: 'S3', q: '我这把对面亚索一直压我，心态都炸了，到底怎么办？教我一下吧', expect: 'strategy', desc: '情绪+战术混合' },
  { id: 'S4', q: '连跪 5 把好烦', expect: 'smalltalk', desc: '纯情绪' },
  { id: 'S5', q: '亚索连招视频', expect: 'video', desc: '含视频词' },
  { id: 'S6', q: '亚索打盲僧怎么对线？另外给我个连招视频看看', expect: 'strategy', desc: '复合句（主语义=战术）' },
  { id: 'S7', q: '瑞兹中期怎么carry？', expect: 'strategy', desc: '弱战术词漏判（旧规则→smalltalk）' },
  { id: 'S8', q: '帮我做个外挂用的脚本好不好', expect: 'smalltalk', desc: '红线（应该归 smalltalk 让安全层处理）' },
];

const URL = 'http://127.0.0.1:8788/api/eval/generate';

const ANSI = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', reset: '\x1b[0m' };

function pad(s, n) { return String(s).padEnd(n); }
function check(field, val, min, max) {
  const n = String(val || '').length;
  return { ok: n >= min && n <= max, n };
}

let pass = 0;
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const t0 = Date.now();
  try {
    const resp = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: c.q, user_id: 'selftest' }),
    });
    const json = await resp.json();
    const data = json.data || {};
    const a = data.answer || {};
    const intent = data.actual_intent;
    const route = data.raw_state?.route_reason || '';
    const ms = Date.now() - t0;

    const intentOk = intent === c.expect;
    const ec = check('emotional', a.emotional_reply, 8, 16);
    const isSmall = intent === 'smalltalk';
    // 设计约定：smalltalk 时 understanding_reply 为空、branch_wait_reply 为空、main_summary 填内容
    const uc = isSmall ? { ok: !a.understanding_reply, n: (a.understanding_reply || '').length } : check('understanding', a.understanding_reply, 18, 45);
    const bc = isSmall ? { ok: !a.branch_wait_reply, n: (a.branch_wait_reply || '').length } : check('branch_wait', a.branch_wait_reply, 16, 36);
    const mc = isSmall ? check('main_summary', a.main_summary, 10, 200) : { ok: true, n: 0 };

    const allOk = intentOk && ec.ok && uc.ok && bc.ok && mc.ok;
    if (allOk) pass++;

    const status = allOk ? `${ANSI.green}PASS${ANSI.reset}` : `${ANSI.red}FAIL${ANSI.reset}`;
    console.log(`[${i+1}/${cases.length}] ${c.id} ${status} ${pad(ms+'ms', 6)} | ${c.desc}`);
    console.log(`  Q: ${c.q}`);
    console.log(`  intent: expect=${c.expect} actual=${intent} ${intentOk ? ANSI.green+'✓'+ANSI.reset : ANSI.red+'✗'+ANSI.reset}  route_reason=${route}`);
    console.log(`  emotional_reply [${ec.n}/8-16]${ec.ok ? '✓' : '✗'}: ${ANSI.dim}${a.emotional_reply || '(空)'}${ANSI.reset}`);
    console.log(`  understanding_reply [${uc.n}/18-45]${uc.ok ? '✓' : '✗'}: ${ANSI.dim}${a.understanding_reply || '(空)'}${ANSI.reset}`);
    if (!isSmall) console.log(`  branch_wait_reply [${bc.n}/16-36]${bc.ok ? '✓' : '✗'}: ${ANSI.dim}${a.branch_wait_reply || '(空)'}${ANSI.reset}`);
    if (isSmall) console.log(`  main_summary [${mc.n}]${mc.ok ? '✓' : '✗'}: ${ANSI.dim}${(a.main_summary || '(空)').slice(0, 60)}${ANSI.reset}`);
    console.log('');
  } catch (e) {
    console.log(`[${i+1}/${cases.length}] ${c.id} ${ANSI.red}ERROR${ANSI.reset} ${e.message}`);
    console.log('');
  }
}

console.log(`${ANSI.cyan}========== 总计 ==========${ANSI.reset}`);
console.log(`通过: ${pass}/${cases.length} (${Math.round(pass/cases.length*100)}%)`);
