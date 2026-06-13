#!/usr/bin/env node
/**
 * Step 2 LLM TaskPlanner 自测脚本
 *
 * 不依赖后端 8788，直接 import planTasks 验证：
 *  - smalltalk / unknown → 空 task_plan（不调 LLM）
 *  - 纯单意图短句 → 走 regex fallback，task_plan=1（不调 LLM，省时间）
 *  - 疑似复合句 → 调 LLM TaskPlanner 拆解，task_plan>=2
 *  - LLM 不可达 → 自动 fallback 到 regex
 *
 * 运行：node scripts/step2-task-planner-selftest.mjs
 */
import { planTasks, __INTERNAL } from '../src/services/taskPlannerService.js';
// arkChatService 通过 src/config.js 自动加载 .env，无需 dotenv

const cases = [
  // 1) smalltalk → 空
  {
    id: 'S1',
    label: 'smalltalk → 空 plan',
    args: { user_query: '今天好烦啊', main_intent: 'smalltalk', main_reply: {} },
    expect: { mode: 'single', task_count: 0, reasonStarts: 'no_branch' },
  },
  // 2) unknown → 空
  {
    id: 'S2',
    label: 'unknown → 空 plan',
    args: { user_query: '哈哈哈', main_intent: 'unknown', main_reply: {} },
    expect: { mode: 'single', task_count: 0, reasonStarts: 'no_branch' },
  },
  // 3) 纯单意图短句 → 跳过 LLM 直接 regex
  {
    id: 'S3',
    label: '短战术 → 跳 LLM',
    args: { user_query: '盲僧怎么打野？', main_intent: 'strategy', main_reply: { strategy_query: '盲僧打野' } },
    expect: { mode: 'single', task_count: 1, reasonNot: 'llm:' },
  },
  {
    id: 'S4',
    label: '短视频 → 跳 LLM',
    args: { user_query: '亚索连招集锦', main_intent: 'video', main_reply: { video_query_seed: '亚索 连招 高光' } },
    expect: { mode: 'single', task_count: 1, reasonNot: 'llm:' },
  },
  // 5) 关键复合句（用户日常会问）→ 应被 isLikelyCompound 命中 → 调 LLM
  {
    id: 'S5',
    label: '复合：战术+视频 → LLM',
    args: { user_query: '亚索打盲僧怎么对线？另外给我个连招视频看看', main_intent: 'strategy', main_reply: { strategy_query: '亚索打盲僧 对线' } },
    expect: { mode: 'compound', task_count_min: 2, tools_should_include: ['strategy', 'video'] },
  },
  {
    id: 'S6',
    label: '复合：战术+视频（reorder）→ LLM',
    args: { user_query: '想看看艾克的高光视频，顺便帮我看看艾克怎么打卡萨', main_intent: 'video', main_reply: {} },
    expect: { mode: 'compound', task_count_min: 2, tools_should_include: ['strategy', 'video'] },
  },
  // 7) 启发式不命中（含连接词但只有一类意图标志词）→ 不调 LLM
  {
    id: 'S7',
    label: '弱启发式 → 不调 LLM',
    args: { user_query: '盲僧怎么打野，怎么开团', main_intent: 'strategy', main_reply: { strategy_query: '盲僧打野' } },
    expect: { mode: 'single', task_count: 1, reasonNot: 'llm:' },
  },
];

function checkExpect(result, expect) {
  const fails = [];
  if (expect.mode && result.mode !== expect.mode) {
    fails.push(`mode=${result.mode} (expect ${expect.mode})`);
  }
  if (typeof expect.task_count === 'number' && result.task_plan.length !== expect.task_count) {
    fails.push(`task_count=${result.task_plan.length} (expect ${expect.task_count})`);
  }
  if (typeof expect.task_count_min === 'number' && result.task_plan.length < expect.task_count_min) {
    fails.push(`task_count=${result.task_plan.length} (expect >= ${expect.task_count_min})`);
  }
  if (expect.reasonStarts && !String(result.reason).startsWith(expect.reasonStarts)) {
    fails.push(`reason="${result.reason}" (expect startsWith "${expect.reasonStarts}")`);
  }
  if (expect.reasonNot && String(result.reason).startsWith(expect.reasonNot)) {
    fails.push(`reason="${result.reason}" (must NOT startsWith "${expect.reasonNot}")`);
  }
  if (Array.isArray(expect.tools_should_include)) {
    const tools = new Set(result.task_plan.map((t) => t.tool));
    for (const need of expect.tools_should_include) {
      if (!tools.has(need)) fails.push(`tools missing ${need}`);
    }
  }
  return fails;
}

async function run() {
  console.log('===== Step 2 LLM TaskPlanner 自测 =====');
  console.log('启发式预筛：');
  for (const c of cases) {
    const hit = __INTERNAL.isLikelyCompound(c.args.user_query);
    console.log(`  [${c.id}] isLikelyCompound=${hit ? 'Y' : 'N'} | ${c.args.user_query}`);
  }

  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    let res;
    let err = null;
    try {
      res = await planTasks(c.args);
    } catch (e) {
      err = e;
    }
    const ms = Date.now() - t0;
    if (err) {
      console.log(`  [${c.id}] FAIL: ${err.message} (${ms}ms)`);
      results.push({ id: c.id, ok: false, ms, errors: [err.message] });
      continue;
    }
    const fails = checkExpect(res, c.expect);
    const status = fails.length === 0 ? 'OK' : 'FAIL';
    const tools = res.task_plan.map((t) => `${t.tool}:${t.query}`).join(' | ');
    console.log(`  [${c.id}] ${status} ${ms}ms | mode=${res.mode} reason="${res.reason}" tasks=[${tools}]`);
    if (fails.length) {
      for (const f of fails) console.log(`         ✗ ${f}`);
    }
    results.push({ id: c.id, ok: fails.length === 0, ms, mode: res.mode, reason: res.reason, errors: fails });
  }

  const okCount = results.filter((r) => r.ok).length;
  const llmHits = results.filter((r) => String(r.reason).startsWith('llm:')).length;
  const fallbacks = results.filter((r) => String(r.reason).startsWith('llm_failed_fallback')).length;
  console.log('\n===== 汇总 =====');
  console.log(`通过率: ${okCount}/${results.length}`);
  console.log(`LLM 真正命中: ${llmHits}（应为 2，对应 S5/S6）`);
  console.log(`LLM 失败回退: ${fallbacks}`);
  console.log(`平均耗时: ${(results.reduce((s, r) => s + r.ms, 0) / results.length).toFixed(0)}ms`);

  process.exit(okCount === results.length ? 0 : 1);
}

run().catch((e) => {
  console.error('SELFTEST_CRASH:', e);
  process.exit(2);
});
