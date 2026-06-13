#!/usr/bin/env node
/**
 * P0 Reflector Mock 评测脚本
 *
 * 用法：
 *   cd volc-aigc-rtc-server
 *   node scripts/mock-reflector-eval.mjs            # 跑 50 个 mock case，真调 Ark
 *   node scripts/mock-reflector-eval.mjs --offline  # 仅跑 schema 校验，不调 LLM
 *   node scripts/mock-reflector-eval.mjs --n=20     # 只跑前 N 个
 *
 * 作用：
 *   1. 准备覆盖三类质量梯度的 mock 输入（高/中/低）
 *   2. 调用 runReflector 拿真实 LLM 反思结果
 *   3. 统计 quality_score 分布，验证：
 *      - 高质量样本 score 是否 ≥ 0.7（True Positive）
 *      - 低质量样本 score 是否 ≤ 0.5（True Negative）
 *      - bridge_question 是否合规（以问号结尾、无术语暴露）
 *      - latency 分布是否在可接受范围
 *   4. 写入 data/agent-reflections.jsonl，可被 listReflectionLogs 查询
 */

import { runReflector, normalizeReflection, __INTERNAL } from '../src/services/reflectorAgentService.js';
import { appendReflectionLog, summarizeReflectionLogs } from '../src/services/reflectionLoggerService.js';

function parseArgs() {
  const opts = { offline: false, n: null, verbose: false };
  for (const raw of process.argv.slice(2)) {
    if (raw === '--offline') opts.offline = true;
    else if (raw === '--verbose' || raw === '-v') opts.verbose = true;
    else if (raw.startsWith('--n=')) opts.n = Number(raw.slice(4));
  }
  return opts;
}

const HIGH_QUALITY_CASES = [
  {
    label: 'high_strategy_yasuo',
    expected_min: 0.7,
    user_query: '盲僧前期入侵反野，对面豹女怎么打？',
    intent: 'strategy',
    main_summary: '盲僧 1 级 Q W 双修，2 级抢点位与队友联动反野，注意豹女 Q 跳走。',
    branch_output: { tactic_title: '盲僧 vs 豹女反野手册', details_count: 5, degraded: false },
  },
  {
    label: 'high_strategy_concrete',
    expected_min: 0.7,
    user_query: '亚索对面劫怎么打',
    intent: 'strategy',
    main_summary: '亚索对劫核心是错开 R 节奏，3 级前不主动消耗，等 6 级抓 R 真实伤害冷却。',
    branch_output: { tactic_title: '亚索对线劫的三个时间窗', details_count: 4, degraded: false },
  },
  {
    label: 'high_video_match',
    expected_min: 0.7,
    user_query: '想看看亚索极限操作集锦',
    intent: 'video',
    main_summary: '帮你找一段亚索极限操作集锦。',
    branch_output: { video_query: '亚索极限操作集锦', video_title: '亚索神操作 TOP10', has_video_url: true, degraded: false },
  },
];

const MID_QUALITY_CASES = [
  {
    label: 'mid_strategy_generic',
    expected_max: 0.8,
    user_query: '我想问一下出装',
    intent: 'strategy',
    main_summary: '出装要根据局势选择，前期出基础装，后期出大件。',
    branch_output: { tactic_title: '通用出装思路', details_count: 2, degraded: false },
  },
  {
    label: 'mid_video_partial',
    expected_max: 0.8,
    user_query: '高分段视频',
    intent: 'video',
    main_summary: '我帮你找高分段视频。',
    branch_output: { video_query: '高分段视频', video_title: '', has_video_url: false, degraded: false },
  },
];

const LOW_QUALITY_CASES = [
  {
    label: 'low_strategy_degraded',
    expected_max: 0.5,
    user_query: '盲僧反野怎么打',
    intent: 'strategy',
    main_summary: '',
    branch_output: { tactic_title: '战术建议（降级）', details_count: 0, degraded: true, degraded_reason: 'Strategy_Agent 重试耗尽' },
  },
  {
    label: 'low_video_no_result',
    expected_max: 0.5,
    user_query: '想看团战集锦',
    intent: 'video',
    main_summary: '',
    branch_output: { video_query: '团战集锦', video_title: '', has_video_url: false, degraded: true, degraded_reason: '视频解析失败' },
  },
  {
    label: 'low_intent_mismatch',
    expected_max: 0.6,
    user_query: '今天天气不错',
    intent: 'strategy',
    main_summary: '我推荐前期攻速装。',
    branch_output: { tactic_title: '前期攻速装', details_count: 3, degraded: false },
  },
];

const HISTORY_FIXTURE = [
  { user_query: '盲僧出装顺序', intent: 'strategy', summary: '黑切→死亡之舞→守护天使' },
  { user_query: '看个亚索操作', intent: 'video', summary: '已找到亚索 op 集锦' },
];

const ALL_CASES = [
  ...HIGH_QUALITY_CASES.map((c) => ({ ...c, tier: 'high' })),
  ...MID_QUALITY_CASES.map((c) => ({ ...c, tier: 'mid' })),
  ...LOW_QUALITY_CASES.map((c) => ({ ...c, tier: 'low' })),
];

function offlineMockReflection(caseItem) {
  const tier = caseItem.tier;
  const score = tier === 'high' ? 0.82 : tier === 'mid' ? 0.6 : 0.35;
  return normalizeReflection({
    this_turn: {
      quality_score: score,
      intent_match: tier !== 'low' || caseItem.label !== 'low_intent_mismatch',
      completeness: score - 0.05,
      gaps: tier === 'high' ? [] : ['细节不够具体'],
      should_followup: tier !== 'high',
    },
    next_turn_hint: {
      predicted_intents: caseItem.intent === 'strategy' ? ['video'] : ['strategy'],
      predicted_query: caseItem.intent === 'strategy' ? '能给个相关的集锦吗' : '这英雄怎么出装',
      preload_actions: [{ type: 'video', query: '相关集锦' }],
    },
    proactive: {
      should_initiate: tier === 'high',
      trigger_after_idle_ms: 15000,
      bridge_question: tier === 'high' ? '要不要看看实战集锦巩固一下？' : '',
      confidence: tier === 'high' ? 0.78 : 0.3,
    },
    session_goal_inference: {
      primary_goal: '掌握当前英雄的对线打法',
      covered: ['对线起手'],
      uncovered: ['团战站位'],
    },
  });
}

function validateBridge(bridge) {
  if (!bridge) return { ok: true, reason: 'empty_skip' };
  if (!/[?？]$/.test(bridge)) return { ok: false, reason: 'no_question_mark' };
  if (/(子脑|Agent|插件|反思|规划)/i.test(bridge)) return { ok: false, reason: 'leak_internal_term' };
  if (bridge.length > 40) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

async function main() {
  const args = parseArgs();
  const cases = args.n ? ALL_CASES.slice(0, args.n) : ALL_CASES;

  console.log(`[mock-eval] 共 ${cases.length} 个 case，模式 = ${args.offline ? 'offline (mock)' : 'online (Ark LLM)'}`);
  if (!args.offline) {
    if (!process.env.ARK_API_KEY) {
      console.error('[mock-eval] ❌ 缺少 ARK_API_KEY 环境变量，online 模式无法运行');
      console.error('[mock-eval] 提示：使用 --offline 跳过 LLM，仅校验 schema/fallback');
      process.exit(1);
    }
  }

  const records = [];
  let truePositiveHigh = 0;
  let trueNegativeLow = 0;
  let bridgeOk = 0;
  let bridgeBad = 0;
  let degradedCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const inputForReflector = {
      user_query: c.user_query,
      intent: c.intent,
      main_summary: c.main_summary,
      branch_output: c.branch_output,
      session_history: HISTORY_FIXTURE,
    };

    let result;
    if (args.offline) {
      const reflection = offlineMockReflection(c);
      result = { reflection, latency_ms: 0, degraded: false, error: null, raw_text: '(offline-mock)' };
    } else {
      result = await runReflector(inputForReflector);
    }

    if (result.degraded) degradedCount += 1;

    const score = result.reflection?.this_turn?.quality_score ?? 0;
    const bridge = result.reflection?.proactive?.bridge_question || '';
    const bridgeCheck = validateBridge(bridge);
    if (bridgeCheck.ok) bridgeOk += 1;
    else bridgeBad += 1;

    if (c.tier === 'high' && score >= (c.expected_min || 0.7)) truePositiveHigh += 1;
    if (c.tier === 'low' && score <= (c.expected_max || 0.5)) trueNegativeLow += 1;

    appendReflectionLog({
      turn_id: `mock_${Date.now()}_${i}`,
      session_id: 'mock_eval',
      source: 'mock_eval',
      user_query: c.user_query,
      intent: c.intent,
      main_summary: c.main_summary,
      branch_output: c.branch_output,
      reflection: result.reflection,
      latency_ms: result.latency_ms,
      degraded: result.degraded,
      error: result.error,
    });

    const oneLine = `[${i + 1}/${cases.length}] ${c.label} tier=${c.tier} score=${score.toFixed(2)} bridge=${bridge || '(空)'} bridge_ok=${bridgeCheck.ok}${bridgeCheck.ok ? '' : '/' + bridgeCheck.reason} latency=${result.latency_ms}ms${result.degraded ? ' DEGRADED' : ''}`;
    console.log(oneLine);
    if (args.verbose) {
      console.log('  reflection:', JSON.stringify(result.reflection));
    }

    records.push({ case: c, result, bridgeCheck });
  }

  const highCases = cases.filter((c) => c.tier === 'high');
  const lowCases = cases.filter((c) => c.tier === 'low');

  console.log('\n[mock-eval] ========== 统计 ==========');
  console.log(`总样本: ${cases.length}`);
  console.log(`Reflector 降级数: ${degradedCount}`);
  console.log(`高质量样本（应 score ≥ 0.7）: ${truePositiveHigh}/${highCases.length}  TPR = ${(truePositiveHigh / Math.max(1, highCases.length) * 100).toFixed(0)}%`);
  console.log(`低质量样本（应 score ≤ 0.5）: ${trueNegativeLow}/${lowCases.length}  TNR = ${(trueNegativeLow / Math.max(1, lowCases.length) * 100).toFixed(0)}%`);
  console.log(`bridge_question 合规: ${bridgeOk}/${cases.length}  违规: ${bridgeBad}`);

  const summary = summarizeReflectionLogs({});
  console.log('\n[mock-eval] reflection log summary:');
  console.log(JSON.stringify(summary, null, 2));

  console.log('\n[mock-eval] 完成。日志已落到 data/agent-reflections.jsonl');
}

main().catch((err) => {
  console.error('[mock-eval] 致命错误', err);
  process.exit(1);
});
