// 验证 buildScreenContextSummary 的注入摘要逻辑（不联网，不依赖 LLM）
import { buildScreenContextSummary } from '../src/services/screenEventService.js';

let pass = 0;
let fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

const NOW = 1_700_000_000_000;

// 1. null / 空状态
check('null 输入返回 null', buildScreenContextSummary(null) === null);
check('空对象返回 null', buildScreenContextSummary({}, { now: NOW }) === null);

// 2. 新鲜状态 + 多字段
{
  const state = {
    last_game: 'hok',
    last_scene: 'in_game',
    last_hp_pct: 0.32,
    last_ult_ready: true,
    recent_events: [
      { type: 'ganked', label: '被 gank', priority: 'high', confidence: 0.82, ts: NOW - 12_000 },
      { type: 'ult_ready', label: '大招就绪', priority: 'normal', confidence: 0.9, ts: NOW - 30_000 },
    ],
    updated_at_ms: NOW - 2000,
  };
  const out = buildScreenContextSummary(state, { now: NOW });
  check('新鲜状态返回非 null', out !== null);
  check('isFresh=true', out && out.isFresh === true);
  check('summary 含游戏:王者荣耀', out && out.summary.includes('王者荣耀'));
  check('summary 含场景:对局中', out && out.summary.includes('对局中'));
  check('summary 含血量:32%', out && out.summary.includes('血量:32%'));
  check('summary 含大招就绪', out && out.summary.includes('大招就绪'));
  check('summary 含 12秒前:被 gank', out && out.summary.includes('12秒前') && out.summary.includes('被 gank'));
  check('summary 长度 <= 80', out && out.summary.length <= 80, out && `len=${out.summary.length} text=${out.summary}`);
  check('recentEvents 长度 <= 3', out && out.recentEvents.length <= 3);
  check('recentEvents[0].ageSec ~= 12', out && out.recentEvents[0].ageSec === 12);
}

// 3. 过期状态 - 只有近期事件
{
  const state = {
    last_game: 'lol',
    last_scene: 'in_game',
    last_hp_pct: 0.5,
    last_ult_ready: false,
    recent_events: [
      { type: 'death', label: '阵亡', priority: 'high', confidence: 0.95, ts: NOW - 5000 },
    ],
    updated_at_ms: NOW - 60_000, // 60s 前，超过 10s 阈值
  };
  const out = buildScreenContextSummary(state, { now: NOW, freshnessMs: 10000 });
  check('过期状态仍返回（因为有近期事件）', out !== null);
  check('isFresh=false', out && out.isFresh === false);
  check('过期时不暴露血量', out && !out.summary.includes('血量'));
  check('过期时不暴露大招', out && !out.summary.includes('大招'));
  check('过期时不暴露场景', out && !out.summary.includes('场景'));
  check('过期时仍显示近期事件', out && out.summary.includes('阵亡'));
}

// 4. 完全无内容
{
  const out = buildScreenContextSummary({
    last_game: '',
    last_scene: '',
    recent_events: [],
    updated_at_ms: NOW - 60_000,
  }, { now: NOW });
  check('全空 + 过期返回 null', out === null);
}

// 5. recentEvents 截断到 3 条
{
  const state = {
    last_game: 'hok',
    last_scene: 'in_game',
    recent_events: [
      { type: 'death', label: '阵亡', priority: 'high', confidence: 0.9, ts: NOW - 1000 },
      { type: 'ganked', label: '被 gank', priority: 'high', confidence: 0.8, ts: NOW - 5000 },
      { type: 'team_fight', label: '团战开始', priority: 'high', confidence: 0.7, ts: NOW - 8000 },
      { type: 'ult_ready', label: '大招就绪', priority: 'normal', confidence: 0.6, ts: NOW - 12_000 },
      { type: 'level_up', label: '升级', priority: 'low', confidence: 0.5, ts: NOW - 20_000 },
    ],
    updated_at_ms: NOW - 1000,
  };
  const out = buildScreenContextSummary(state, { now: NOW });
  check('recentEvents 截到 3 条', out.recentEvents.length === 3);
  check('summary 长度仍 <= 80', out.summary.length <= 80, `len=${out.summary.length} text=${out.summary}`);
}

console.log(results.join('\n'));
console.log(`\nTotal: ${pass + fail}, Pass: ${pass}, Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
