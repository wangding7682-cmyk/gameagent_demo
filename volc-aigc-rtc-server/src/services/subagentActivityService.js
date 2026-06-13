/**
 * 【子 agent 活动账本 / 承诺-兑现追踪】subagentActivityService
 *
 * 通俗职责：
 *   RTC 主脑（路径①火山端到端 LLM）的话直接被 TTS 播给用户，但它并不知道
 *   orchestrator（路径②）这一轮到底有没有真的去跑 strategy_agent / video_agent。
 *   主脑常会"答应整理卡片"但后台并未启动 → 形成"空头支票"。
 *
 *   本服务维护一份 session 级账本，记录：
 *     - 主脑 main_summary 中是否含有"承诺词"
 *     - 子 agent 是否真的启动 / 完成 / 失败
 *     - 是否构成"空头支票"（承诺但未启动）
 *
 *   用途：
 *     1. 给 Reflector 输入 subagent_activity，用于评估 promise_keeping
 *     2. 给下一轮 dynamicSummary 注入"上轮空头支票警示"，提醒主脑别再编
 *     3. 前端 SSE 可见，便于排查
 *
 * 严格约束：
 *   - 进程内 Map，不持久化（重启后清空，下游容忍）
 *   - 单 session 最多保留 20 轮，FIFO 淘汰
 */

const SESSION_LEDGER_LIMIT = 20;
const sessionLedgers = new Map();

const PROMISE_PATTERNS = {
  card: /(整理.*?(卡片|卡|攻略|战术).*(弹|出|发|给))|(帮你.*?整理)|(整理.*?后.*?(弹|出))|(给你.*?(整理|生成).*?卡)|(画一张)|(生成.*?(图|卡))/,
  video: /(找.*?视频)|(找.*?(集锦|高光))|(给你.*?(找|搜).*?(视频|集锦))|(看.*?视频)/,
  strategy: /(整理.*?(战术|思路|打法|建议))|(等.*?(片刻|一下|稍等).*?(战术|攻略|建议))/,
};

const VAGUE_PATTERNS = /(我去.*?(看|查|找))|(帮你.*?看看)|(我帮你.*?(整理|看|查|找))|(稍等.*?(我|为你).*?(查|整理|找))/;

function detectPromises(text = '') {
  const flat = String(text || '').replace(/\s+/g, '');
  if (!flat) return { card: false, video: false, strategy: false, vague: false, hits: [] };

  const hits = [];
  const card = PROMISE_PATTERNS.card.test(flat);
  const video = PROMISE_PATTERNS.video.test(flat);
  const strategy = PROMISE_PATTERNS.strategy.test(flat);
  const vague = VAGUE_PATTERNS.test(flat);

  if (card) hits.push('card');
  if (video) hits.push('video');
  if (strategy) hits.push('strategy');
  if (vague) hits.push('vague');

  return { card, video, strategy, vague, hits };
}

function getOrCreateLedger(sessionId) {
  const key = String(sessionId || 'default');
  if (!sessionLedgers.has(key)) {
    sessionLedgers.set(key, []);
  }
  return sessionLedgers.get(key);
}

function pushTurn(sessionId, entry) {
  const ledger = getOrCreateLedger(sessionId);
  ledger.push(entry);
  while (ledger.length > SESSION_LEDGER_LIMIT) ledger.shift();
}

/**
 * 在每轮结束（done/degraded）后调用，生成本轮的承诺-兑现快照。
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.turnId
 * @param {string} params.intent          - smalltalk / strategy / video
 * @param {string} params.mainSummary     - 主脑 main_summary（最接近 TTS 字幕的代理）
 * @param {string[]} params.activatedSubagents - ['strategy_agent','video_agent'] 等已真实启动的列表
 * @param {boolean} params.degraded
 * @returns {object} entry
 */
export function recordTurnActivity({
  sessionId = 'default',
  turnId,
  intent = 'unknown',
  mainSummary = '',
  activatedSubagents = [],
  degraded = false,
} = {}) {
  const promises = detectPromises(mainSummary);
  const activated = Array.isArray(activatedSubagents) ? activatedSubagents.filter(Boolean) : [];
  const activatedSet = new Set(activated);

  // 空头支票判定：
  //  - 承诺了卡片/战术 但 strategy_agent 没启动
  //  - 承诺了视频     但 video_agent     没启动
  //  - 含糊承诺（"我帮你看看"）但任何子 agent 都没启动
  const emptyPromises = [];
  if (promises.card && !activatedSet.has('strategy_agent')) emptyPromises.push('card');
  if (promises.strategy && !activatedSet.has('strategy_agent')) emptyPromises.push('strategy');
  if (promises.video && !activatedSet.has('video_agent')) emptyPromises.push('video');
  if (promises.vague && activated.length === 0 && intent === 'smalltalk') emptyPromises.push('vague');

  const entry = {
    turn_id: turnId,
    intent,
    main_summary_snippet: String(mainSummary || '').slice(0, 80),
    promises_detected: promises.hits,
    activated_subagents: activated,
    empty_promises: Array.from(new Set(emptyPromises)),
    is_empty_promise: emptyPromises.length > 0,
    degraded: Boolean(degraded),
    created_at: new Date().toISOString(),
  };

  pushTurn(sessionId, entry);
  return entry;
}

/**
 * 取最近 N 轮活动（按时间正序）。供 Reflector 输入与 dynamicSummary 注入使用。
 */
export function getRecentActivity(sessionId, limit = 3) {
  const ledger = getOrCreateLedger(sessionId);
  return ledger.slice(-Math.max(1, limit));
}

/**
 * 拼接成给主脑下一轮看的「上轮承诺-兑现」一句话警示。空头支票存在时才返回非空。
 */
export function buildEmptyPromiseWarning(sessionId) {
  const recent = getRecentActivity(sessionId, 3);
  const offenders = recent.filter((e) => e.is_empty_promise);
  if (offenders.length === 0) return '';
  const last = offenders[offenders.length - 1];
  const kinds = last.empty_promises.join('/');
  return `[上轮空头支票] 你上轮答应了「${kinds}」但后台子任务未启动，本轮严禁再做同类承诺；如用户未提战术词/卡片词/视频词，请直接闲聊。`;
}

/** 测试与排查用，不在生产路径调用 */
export function __resetForTest() {
  sessionLedgers.clear();
}

export const __INTERNAL = {
  detectPromises,
  PROMISE_PATTERNS,
  VAGUE_PATTERNS,
};
