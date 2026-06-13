// 端到端 mock 验证：自主 Agent 的 P0–P5 全链路
// 不联网，不依赖 LLM；通过直接调函数 + 注入伪造数据来观察出参是否符合设计预期。
// 跑：node scripts/mock-end-to-end-eval.mjs

import {
  normalizeReflection,
  __INTERNAL as REF_I,
} from '../src/services/reflectorAgentService.js';

import {
  encodeLayerSummary,
  decodeLayerSummary,
  inferMemoryLayer,
  computeTimeDecay,
  LAYER_CONFIG,
} from '../src/services/memoryLayerService.js';

import {
  isRetryableError,
  withRetry,
  rewriteFailedQuery,
} from '../src/services/retryHelperService.js';

import {
  mergeSessionGoal,
  summarizeSessionGoal,
  updateSessionGoalFromReflection,
  getSessionGoal,
} from '../src/services/sessionGoalTrackerService.js';

import { planTasks } from '../src/services/taskPlannerService.js';

import {
  normalizeGameEvent,
  normalizeFrameSnapshot,
  shouldEmitProactive,
  processFrame,
  buildScreenContextSummary,
} from '../src/services/screenEventService.js';

import {
  getAgentSessionState,
  upsertAgentDynamicContext,
  clearAgentSessionState,
  appendAgentSessionTurn,
} from '../src/services/agentSessionStateService.js';

// ============== 框架 ==============
let pass = 0;
let fail = 0;
const sectionLog = [];
const issues = [];   // 实际偏离设计的现象
const suggestions = []; // 我的设计建议

function assert(name, cond, detail) {
  if (cond) { pass++; sectionLog.push(`  PASS  ${name}`); }
  else {
    fail++;
    sectionLog.push(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
    issues.push(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

function section(title) {
  sectionLog.push(`\n========== ${title} ==========`);
}

// ============== Section 1：Reflector schema ==============
section('1. Reflector — normalizeReflection schema 防御');
{
  // 1.1 完全乱七八糟的输入
  const empty = normalizeReflection(null);
  assert('null 输入返回完整 schema', empty && empty.this_turn && empty.next_turn_hint && empty.proactive && empty.session_goal_inference && empty.memory_promotion);
  assert('null 输入 quality_score 默认中性 0.5', empty.this_turn.quality_score === 0.5);
  assert('null 输入 should_initiate 默认 false', empty.proactive.should_initiate === false);
  assert('null 输入 should_promote 默认 false', empty.memory_promotion.should_promote === false);
  assert('null 输入 target_layer 默认 none', empty.memory_promotion.target_layer === 'none');

  // 1.2 quality_score 越界 clamp
  const oob = normalizeReflection({
    this_turn: { quality_score: 1.5, completeness: -0.3 },
  });
  assert('quality_score>1 被 clamp 到 1', oob.this_turn.quality_score === 1, `got ${oob.this_turn.quality_score}`);
  assert('completeness<0 被 clamp 到 0', oob.this_turn.completeness === 0, `got ${oob.this_turn.completeness}`);

  // 1.3 bridge_question 必须问号结尾（设计声称强制）
  const noQ = normalizeReflection({
    proactive: { should_initiate: true, bridge_question: '要不要试试看反野', confidence: 0.8 },
  });
  // 这里观察是否会被强制补问号或拒绝
  if (!noQ.proactive.bridge_question.endsWith('？') && !noQ.proactive.bridge_question.endsWith('?')) {
    issues.push(`[设计偏离] bridge_question 未以问号结尾时未被纠正：'${noQ.proactive.bridge_question}'`);
    suggestions.push('Reflector: normalizeReflection 应对非问号结尾的 bridge_question 自动补"?"或将 should_initiate 置 false。');
  } else {
    sectionLog.push('  PASS  bridge_question 问号纠正');
  }

  // 1.4 gaps 限 3 条 + 长度 30 字
  const longGaps = normalizeReflection({
    this_turn: { gaps: ['短的', '另一个', '第三个', '第四个不应进', '一个非常非常非常非常非常非常非常非常非常长的描述应被截断'] },
  });
  assert('gaps 最多 3 条', longGaps.this_turn.gaps.length <= 3, `got ${longGaps.this_turn.gaps.length}`);
  if (longGaps.this_turn.gaps.some((g) => g.length > 30)) {
    issues.push(`[设计偏离] gaps 单条长度未截到 30 字: ${JSON.stringify(longGaps.this_turn.gaps)}`);
    suggestions.push('Reflector: normalizeReflection 应在 gaps 入参时按 30 字硬截。');
  }

  // 1.5 trigger_after_idle_ms 范围 10000-30000（已修复）
  const idleLow = normalizeReflection({ proactive: { trigger_after_idle_ms: 5000 } });
  assert('trigger_after_idle_ms<10000 被 clamp 到 10000', idleLow.proactive.trigger_after_idle_ms === 10000, `got ${idleLow.proactive.trigger_after_idle_ms}`);
  const idleHigh = normalizeReflection({ proactive: { trigger_after_idle_ms: 60000 } });
  assert('trigger_after_idle_ms>30000 被 clamp 到 30000', idleHigh.proactive.trigger_after_idle_ms === 30000, `got ${idleHigh.proactive.trigger_after_idle_ms}`);

  // 1.6 memory_promotion 严格门槛
  const promoteOk = normalizeReflection({
    memory_promotion: { should_promote: true, target_layer: 'semantic', content: '用户主玩 ADC 位', confidence: 0.8 },
  });
  assert('合规升级 should_promote=true', promoteOk.memory_promotion.should_promote === true);
  assert('合规升级 target_layer=semantic', promoteOk.memory_promotion.target_layer === 'semantic');

  const promoteLowConf = normalizeReflection({
    memory_promotion: { should_promote: true, target_layer: 'semantic', content: '用户主玩 ADC', confidence: 0.4 },
  });
  assert('confidence<0.6 时 should_promote 被强制 false', promoteLowConf.memory_promotion.should_promote === false);
  assert('confidence<0.6 时 target_layer 被改回 none', promoteLowConf.memory_promotion.target_layer === 'none');

  const promoteBadLayer = normalizeReflection({
    memory_promotion: { should_promote: true, target_layer: 'random_xxx', content: '内容', confidence: 0.9 },
  });
  assert('未知 target_layer 被改回 none', promoteBadLayer.memory_promotion.target_layer === 'none');

  const promoteEmpty = normalizeReflection({
    memory_promotion: { should_promote: true, target_layer: 'procedural', content: '', confidence: 0.9 },
  });
  assert('空 content 时 should_promote=false', promoteEmpty.memory_promotion.should_promote === false);
}

// ============== Section 2：分层记忆 ==============
section('2. 分层记忆 — 编码/解码/层推断/时间衰减');
{
  // 2.1 编码/解码 round-trip
  const encoded = encodeLayerSummary('episodic', '用户问亚索连招');
  assert('编码包含 [L:episodic|TTL:7|', encoded.includes('[L:episodic|TTL:7|'));
  const decoded = decodeLayerSummary(encoded);
  assert('解码 layer=episodic', decoded.layer === 'episodic');
  assert('解码 ttl=7', decoded.ttl_days === 7);
  assert('解码 weight=1.2', Math.abs(decoded.weight - 1.2) < 0.01);
  assert('解码 content=原文', decoded.content === '用户问亚索连招');

  // 2.2 无前缀解码兜底
  const noPrefix = decodeLayerSummary('普通文本');
  assert('无前缀 has_prefix=false', noPrefix.has_prefix === false);
  assert('无前缀 layer 默认 semantic', noPrefix.layer === 'semantic');

  // 2.3 inferMemoryLayer 路由（按当前实际契约：source='reflector'+isEvent 才走 episodic，bucket 类需 confidence>=0.7）
  assert('reflector+isEvent → episodic', inferMemoryLayer({ source: 'reflector', isEvent: true }) === 'episodic');
  assert('reflector+!isEvent → procedural', inferMemoryLayer({ source: 'reflector', isEvent: false }) === 'procedural');
  assert('facts+conf=0.8 → semantic', inferMemoryLayer({ bucket: 'facts', confidence: 0.8 }) === 'semantic');
  assert('preferences+conf=0.75 → semantic', inferMemoryLayer({ bucket: 'preferences', confidence: 0.75 }) === 'semantic');
  assert('avoidances+conf=0.75 → semantic', inferMemoryLayer({ bucket: 'avoidances', confidence: 0.75 }) === 'semantic');
  assert('facts+conf=0.5 不达标 → working', inferMemoryLayer({ bucket: 'facts', confidence: 0.5 }) === 'working');
  assert('其他 → working（长尾兜底）', inferMemoryLayer({}) === 'working');

  // 2.4 时间衰减半衰期约束（注意：实现是 age>=ttl 直接 return 0）
  const decay0 = computeTimeDecay({ ttl_days: 7, age_days: 0 });
  const decayHalf = computeTimeDecay({ ttl_days: 7, age_days: 3.5 });
  const decayJustBeforeTtl = computeTimeDecay({ ttl_days: 7, age_days: 6.9 });
  const decayTtl = computeTimeDecay({ ttl_days: 7, age_days: 7 });
  const decayPast = computeTimeDecay({ ttl_days: 7, age_days: 14 });
  assert('age=0 衰减=1', Math.abs(decay0 - 1) < 0.01, `got ${decay0}`);
  assert('age=半衰期(ttl/2) 衰减≈0.5', Math.abs(decayHalf - 0.5) < 0.05, `got ${decayHalf}`);
  assert('age 接近 ttl 时仍>0', decayJustBeforeTtl > 0.2 && decayJustBeforeTtl < 0.3, `got ${decayJustBeforeTtl}`);
  assert('age>=ttl 硬截 0（设计选 A）', decayTtl === 0 && decayPast === 0);

  // 2.5 LAYER_CONFIG 权重对齐项目硬约束
  const w = (k) => LAYER_CONFIG[k]?.weight;
  if (w('working') !== 1.5) issues.push(`[设计偏离] working 权重应=1.5，实际=${w('working')}`);
  if (w('episodic') !== 1.2) issues.push(`[设计偏离] episodic 权重应=1.2，实际=${w('episodic')}`);
  if (w('semantic') !== 1.0) issues.push(`[设计偏离] semantic 权重应=1.0，实际=${w('semantic')}`);
  if (w('procedural') !== 0.6) issues.push(`[设计偏离] procedural 权重应=0.6，实际=${w('procedural')}`);
  assert('权重配置完全对齐项目硬约束', w('working') === 1.5 && w('episodic') === 1.2 && w('semantic') === 1.0 && w('procedural') === 0.6);
}

// ============== Section 3：retry helper ==============
section('3. 失败重试 + query 自纠');
{
  // 3.1 isRetryableError
  assert('timeout 错误可重试', isRetryableError(new Error('request timeout')));
  assert('5xx code 可重试', isRetryableError({ status: 503, message: 'service busy' }));
  assert('400 不可重试', !isRetryableError({ status: 400, message: 'bad request' }));
  assert('null 不崩溃', isRetryableError(null) === false);

  // 3.2 withRetry：第二次成功
  let calls = 0;
  const ok = await withRetry(async () => {
    calls++;
    if (calls < 2) throw new Error('fetch failed');
    return 'ok';
  }, { maxAttempts: 3, delayMs: 5 });
  assert('withRetry 重试后成功', ok === 'ok');
  assert('withRetry 调用 2 次', calls === 2);

  // 3.3 withRetry：不可重试立即抛
  let calls2 = 0;
  let threw = false;
  try {
    await withRetry(async () => {
      calls2++;
      const e = new Error('bad request');
      e.status = 400;
      throw e;
    }, { maxAttempts: 3, delayMs: 5 });
  } catch (_) { threw = true; }
  assert('不可重试错误立即抛', threw === true);
  assert('不可重试不重复执行', calls2 === 1);

  // 3.4 rewriteFailedQuery 去 filler
  const cleaned = rewriteFailedQuery('能不能帮我看看亚索连招那种教学视频啊', 'timeout');
  assert('rewriteFailedQuery 去掉"能不能"', !cleaned.includes('能不能'));
  assert('rewriteFailedQuery 去掉"那种"', !cleaned.includes('那种'));
  assert('rewriteFailedQuery 保留核心词', cleaned.includes('亚索') && cleaned.includes('连招'));
  assert('rewriteFailedQuery 长度 ≤ 30', cleaned.length <= 30);
}

// ============== Section 4：会话目标 ==============
section('4. 会话目标追踪 — 频次胜出 + 双向移动');
{
  // 4.1 频次胜出（A 票数高于 B 时仍胜出）
  let goal = mergeSessionGoal({}, { primary_goal: 'A 学连招', covered: ['基础'], uncovered: ['进阶', '团战'] });
  goal = mergeSessionGoal(goal, { primary_goal: 'A 学连招', covered: ['进阶'], uncovered: ['团战'] });
  goal = mergeSessionGoal(goal, { primary_goal: 'B 学打野', covered: [], uncovered: ['野区'] });
  assert('A 票=2 胜出 B 票=1', goal.primary_goal === 'A 学连招', `got ${goal.primary_goal}`);
  assert('covered 累积 [基础, 进阶]', goal.covered.includes('基础') && goal.covered.includes('进阶'));
  assert('uncovered 不包含已 covered 的 [基础, 进阶]', !goal.uncovered.includes('基础') && !goal.uncovered.includes('进阶'));
  assert('uncovered 包含新增 [团战]', goal.uncovered.includes('团战'));
  assert('turn_count=3', goal.turn_count === 3);

  // 4.2 摘要 ≤ 160 字
  const sum = summarizeSessionGoal(goal);
  assert('summary 含主线', sum.includes('主线'));
  assert('summary 长度 ≤ 160', sum.length <= 160, `len=${sum.length}`);

  // 4.3 与 sessionState 集成
  clearAgentSessionState('test-goal');
  const merged = updateSessionGoalFromReflection({
    sessionId: 'test-goal',
    reflection: { session_goal_inference: { primary_goal: '学野区', covered: ['刷野'], uncovered: ['gank'] } },
    degraded: false,
  });
  assert('updateFromReflection 返回非空', merged !== null);
  const stored = getSessionGoal('test-goal');
  assert('getSessionGoal 能读回', stored && stored.primary_goal === '学野区');

  // 4.4 degraded=true 不写
  const degraded = updateSessionGoalFromReflection({
    sessionId: 'test-goal',
    reflection: { session_goal_inference: { primary_goal: '不应写入' } },
    degraded: true,
  });
  assert('degraded 时不更新', degraded === null);
  const stored2 = getSessionGoal('test-goal');
  assert('degraded 时旧值保留', stored2 && stored2.primary_goal === '学野区');

  clearAgentSessionState('test-goal');
}

// ============== Section 5：Task Planner ==============
section('5. 任务编排 — 单 vs 复合');
{
  // 5.1 single
  const single = await planTasks({ user_query: '盲僧怎么打野？', main_intent: 'strategy', main_reply: { strategy_query: '盲僧打野' } });
  assert('single mode', single.mode === 'single');
  assert('single 1 个任务', single.task_plan.length === 1);
  assert('single 工具=strategy', single.task_plan[0].tool === 'strategy');

  // 5.2 compound
  const compound = await planTasks({
    user_query: '盲僧怎么打野，顺便给我看个教学视频',
    main_intent: 'strategy',
    main_reply: {},
  });
  assert('compound mode', compound.mode === 'compound', `got ${compound.mode} reason=${compound.reason}`);
  assert('compound 至少 2 个任务', compound.task_plan.length >= 2);
  const tools = compound.task_plan.map((t) => t.tool).sort();
  assert('compound 含 strategy + video', tools.includes('strategy') && tools.includes('video'));

  // 5.3 smalltalk → 不分发
  const small = await planTasks({ user_query: '你好啊', main_intent: 'smalltalk', main_reply: {} });
  assert('smalltalk 任务清单为空', small.task_plan.length === 0);

  // 5.4 边界：复合关键词但无连接词 → 仍单分支
  const edge = await planTasks({
    user_query: '盲僧打野怎么打',
    main_intent: 'strategy',
    main_reply: {},
  });
  assert('无连接词 → single', edge.mode === 'single');

  // 5.5 复杂复合：观察 query 抽取质量
  const compEdge = await planTasks({
    user_query: '亚索的连招怎么打，再帮我搜个高分段集锦',
    main_intent: 'strategy',
    main_reply: {},
  });
  if (compEdge.mode === 'compound') {
    const stratTask = compEdge.task_plan.find((t) => t.tool === 'strategy');
    if (stratTask && /集锦|视频|教学|示范|演示/.test(stratTask.query)) {
      issues.push(`[潜在 bug] compound strategy_query 未清理视频词: '${stratTask.query}'`);
      suggestions.push('TaskPlanner: extractStrategyQuery 正则可能漏判"再帮我搜个X集锦"语序，建议补一条规则或换用 LLM 复合意图拆分。');
    }
  } else {
    issues.push(`[设计偏离] '亚索连招怎么打,再搜个集锦' 未被识别为 compound (mode=${compEdge.mode}, reason=${compEdge.reason})`);
    suggestions.push('TaskPlanner: COMPOUND_PATTERNS 的 test 正则对"连招"+"集锦"语序覆盖不全。');
  }
}

// ============== Section 6：屏幕观察 ==============
section('6. 屏幕观察 — 标准化 + 冷却 + 注入摘要');
{
  // 6.1 normalizeGameEvent 白名单过滤
  const valid = normalizeGameEvent({ type: 'low_hp_warning', confidence: 0.8 });
  assert('low_hp_warning 通过', valid && valid.type === 'low_hp_warning');
  const invalid = normalizeGameEvent({ type: 'random_xxx', confidence: 0.8 });
  assert('未知 type 被过滤', invalid === null);

  // 6.2 frame snapshot 完整性
  const snap = normalizeFrameSnapshot({
    game: 'lol',
    scene: 'in_game',
    hp_pct: 0.3,
    ult_ready: true,
    events: [{ type: 'low_hp_warning', confidence: 0.9 }],
    frame_id: 'f1',
  });
  assert('snap.game=lol', snap.game === 'lol');
  assert('snap.events 长度 1', snap.events.length === 1);

  // 6.3 processFrame 端到端
  clearAgentSessionState('test-screen');
  const out1 = processFrame({
    rawFrame: { game: 'hok', scene: 'in_game', events: [{ type: 'ganked', confidence: 0.9 }], frame_id: 'f1' },
    sessionId: 'test-screen',
    now: 1_700_000_000_000,
  });
  assert('首帧 allowed=true', out1.allowed === true);
  assert('首帧 picked=ganked', out1.picked && out1.picked.type === 'ganked');

  // 6.4 5 秒后同事件被冷却（ganked 冷却 10s）
  const out2 = processFrame({
    rawFrame: { game: 'hok', scene: 'in_game', events: [{ type: 'ganked', confidence: 0.9 }], frame_id: 'f2' },
    sessionId: 'test-screen',
    now: 1_700_000_005_000,
  });
  assert('5s 后同事件被冷却', out2.allowed === false);
  assert('cooldown_left_ms ≈ 5000', out2.cooldown_left_ms >= 4500 && out2.cooldown_left_ms <= 5500, `got ${out2.cooldown_left_ms}`);

  // 6.5 不同事件不互相冷却
  const out3 = processFrame({
    rawFrame: { game: 'hok', scene: 'in_game', events: [{ type: 'ult_ready', confidence: 0.9 }], frame_id: 'f3' },
    sessionId: 'test-screen',
    now: 1_700_000_005_500,
  });
  assert('不同 type 不互相冷却', out3.allowed === true, `got ${out3.allowed_reason}`);

  // 6.6 recent_events 流水
  const state = getAgentSessionState('test-screen').dynamic_context.screen_event_state;
  assert('recent_events 累积 2 条 (ganked + ult_ready)', state.recent_events.length === 2);
  assert('recent_events[0]=最新 ult_ready', state.recent_events[0].type === 'ult_ready');

  // 6.7 buildScreenContextSummary 注入
  const obs = buildScreenContextSummary(state, { now: 1_700_000_005_500 });
  assert('注入摘要非空', obs !== null);
  assert('summary 含被 gank 或 大招就绪', obs.summary.includes('gank') || obs.summary.includes('大招'));

  // 6.8 过期 (>10s) 不暴露 hp/ult 状态（注意：recent_events label 里出现"大招就绪"是流水，不算"当前状态"）
  const stale = buildScreenContextSummary(state, { now: 1_700_000_020_000 });
  assert('过期 isFresh=false', stale && stale.isFresh === false);
  assert('过期不暴露 当前血量', !stale.summary.includes('血量'));
  assert('过期不暴露 当前场景', !stale.summary.includes('场景'));

  // 6.9 scene !== in_game 不进 picked
  const out4 = processFrame({
    rawFrame: { game: 'hok', scene: 'lobby', events: [{ type: 'ganked', confidence: 0.9 }], frame_id: 'f4' },
    sessionId: 'test-screen',
    now: 1_700_000_030_000,
  });
  assert('lobby 不 pick 事件', out4.picked === null);

  clearAgentSessionState('test-screen');
}

// ============== Section 7：自闭环（Reflector → Goal → Context 注入） ==============
section('7. 自闭环 — 模拟一轮对话 → Reflector → 下一轮上下文带上 goal + screen');
{
  const SID = 'test-loop';
  clearAgentSessionState(SID);

  // 模拟主链路落盘一轮 turn
  appendAgentSessionTurn(SID, {
    user_query: '盲僧怎么打野',
    intent: 'strategy',
    main_summary: '清野线路 + 小龙节奏 + 反野时机',
  });

  // Reflector 输出（模拟）→ 写 goal
  const inference = {
    primary_goal: '学盲僧打野',
    covered: ['清野线路'],
    uncovered: ['反野', '小龙节奏'],
  };
  const merged = updateSessionGoalFromReflection({
    sessionId: SID,
    reflection: { session_goal_inference: inference },
    degraded: false,
  });
  assert('Reflector → goal 已写入', merged && merged.primary_goal === '学盲僧打野');

  // 屏幕观察一帧 → 写白板
  processFrame({
    rawFrame: { game: 'lol', scene: 'in_game', hp_pct: 0.3, ult_ready: true, events: [{ type: 'low_hp_warning', confidence: 0.9 }], frame_id: 'L1' },
    sessionId: SID,
    now: Date.now(),
  });

  // 取出 sessionState 验证两类信息都在 dynamic_context
  const state = getAgentSessionState(SID);
  assert('dynamic_context.session_goal 存在', state.dynamic_context && state.dynamic_context.session_goal && state.dynamic_context.session_goal.primary_goal === '学盲僧打野');
  assert('dynamic_context.screen_event_state 存在', state.dynamic_context && state.dynamic_context.screen_event_state && state.dynamic_context.screen_event_state.last_scene === 'in_game');

  // 上下文摘要应同时反映两者
  const goalSummary = summarizeSessionGoal(state.dynamic_context.session_goal);
  const screenObs = buildScreenContextSummary(state.dynamic_context.screen_event_state);
  assert('goal summary 含 主线/已覆盖', goalSummary.includes('主线') && goalSummary.includes('已覆盖'));
  assert('screen summary 含 血量 或 大招', screenObs && (screenObs.summary.includes('血量') || screenObs.summary.includes('大招')));

  clearAgentSessionState(SID);
}

// ============== 总结 ==============
console.log(sectionLog.join('\n'));
console.log(`\n========== 总结 ==========`);
console.log(`Total: ${pass + fail}, Pass: ${pass}, Fail: ${fail}`);

if (issues.length > 0) {
  console.log('\n========== 发现的问题 / 设计偏离 ==========');
  issues.forEach((i, idx) => console.log(`${idx + 1}. ${i}`));
}
if (suggestions.length > 0) {
  console.log('\n========== 设计建议 ==========');
  suggestions.forEach((s, idx) => console.log(`${idx + 1}. ${s}`));
}

process.exit(fail === 0 ? 0 : 1);
