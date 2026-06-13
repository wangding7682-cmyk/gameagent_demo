import { callArkChat, extractJsonObject } from './arkChatService.js';
import { extractHeroEntities } from './domainRouterService.js';

/**
 * 检测分支输出是否含上下文外英雄名（主角幻觉）。
 * - sticky_hero 缺失：跳过判定
 * - 战术：检 tactic_title
 * - 视频：检 video_query / video_title
 * 返回 { hallucinated: bool, fields: [{field, value, others: [..]}] }
 */
function detectHeroHallucination(branchOutput = {}, intent = '', stickyHero = null) {
  const stickyName = stickyHero?.hero || '';
  if (!stickyName || !branchOutput || typeof branchOutput !== 'object') {
    return { hallucinated: false, fields: [] };
  }
  const candidateFields = [];
  if (intent === 'strategy') {
    candidateFields.push({ field: 'tactic_title', value: branchOutput.tactic_title || '' });
  }
  if (intent === 'video') {
    candidateFields.push({ field: 'video_query', value: branchOutput.video_query || '' });
    candidateFields.push({ field: 'video_title', value: branchOutput.video_title || '' });
  }
  const flagged = [];
  for (const item of candidateFields) {
    const text = String(item.value || '').trim();
    if (!text) continue;
    const heroes = extractHeroEntities(text);
    const others = heroes.filter((h) => h.hero !== stickyName);
    if (others.length > 0) {
      flagged.push({ field: item.field, value: text, others: others.map((h) => h.hero) });
    }
  }
  return { hallucinated: flagged.length > 0, fields: flagged };
}

/**
 * 【自我反思 / 后台教练】reflectorAgentService
 *
 * 通俗职责：每轮对话结束后，旁路跑一个"教练"做复盘，给本轮打分、预测下一句、
 * 决定要不要主动找话题、并把这次的"长期记忆候选"标好层级（情景/经验/事实）。
 *
 * 输出 5 件事：
 *   1. 本轮质量评分（quality_score / completeness / intent_match / gaps）
 *   2. 下一轮预测（predicted_intents / predicted_query / preload_actions）
 *   3. 主动引导话术（bridge_question / trigger_after_idle_ms / confidence）
 *   4. 会话目标推断（session_goal_inference）
 *   5. 记忆升级建议（memory_promotion）  — 决定把 episodic 升级到 semantic/procedural
 *
 * 严格约束：
 *   - 必须 fire-and-forget，永远不阻塞主链路
 *   - 任何异常都吞掉返回 fallback，禁止抛错回到 orchestrator
 *   - 输出必须可序列化为 JSON，schema 不合法时走 fallback
 *   - LLM 调用使用低延迟模型，超时 30s，失败立即兜底
 */

const REFLECTOR_TIMEOUT_MS = 30000;
const REFLECTOR_LITE_TIMEOUT_MS = 12000;

const REFLECTOR_LITE_SYSTEM_PROMPT = `你是「轻量反思器」，仅在闲聊场景下判断是否产生了值得长期记住的用户事实/偏好。
你只输出严格的 JSON，不要解释、不要 markdown、不要任何额外文本。

JSON 字段定义：
{
  "memory_promotion": {
    "should_promote": true/false，本轮是否产生了值得长期保留的用户偏好/事实/互动经验,
    "target_layer": "semantic" | "procedural" | "none"，
        - semantic: 关于用户的客观事实/偏好/回避（最爱吃榴莲、玩什么位、讨厌什么打法）
        - procedural: 跟这个用户互动的有效方式（讲解风格/节奏/避雷）
        - none: 仅为情景片段，不需要升级
    "content": 字符串 < 60 字，用第三人称客观描述要长期记住的事实（仅当 should_promote=true 时填）,
    "confidence": 0-1 浮点
  }
}

判定原则（重要）：
- 用户主动透露稳定偏好/习惯/身份（如「我最喜欢吃榴莲」「我主玩中单」「我讨厌选辅助」）→ should_promote=true，target_layer=semantic
- 用户回顾互动方式（如「你之前那种短句解释挺好的」）→ target_layer=procedural
- 普通寒暄、无意义闲聊（如「你好」「在吗」「最近怎么样」）→ should_promote=false
- 用户主动询问"你记住了什么"，本身不属于偏好暴露，不要 promote
- confidence < 0.6 时一律视为 should_promote=false`;


const REFLECTOR_SYSTEM_PROMPT = `你是「反思器」，负责评估一轮 AI 陪玩对话的质量并预测下一步。
你只输出严格的 JSON，不要解释、不要 markdown、不要任何额外文本。

【架构常识】
- 主脑（RTC 端到端 LLM）和子 agent（strategy_agent / video_agent）是两条独立链路。
- 主脑的话直接被 TTS 播给用户，但主脑无法保证子 agent 真的会被触发。
- 系统会在输入里给你 subagent_activity，标明本轮哪些子 agent 真实启动 (activated_subagents)，
  以及主脑话术是否含「承诺词」(promises_detected) 与是否构成「空头支票」(is_empty_promise)。

JSON 字段定义：
{
  "this_turn": {
    "quality_score": 0-1 浮点，本轮整体质量,
    "intent_match": true/false，意图判断是否对题,
    "completeness": 0-1 浮点，回答完整度,
    "promise_keeping": 0-1 浮点，承诺-兑现一致性（空头支票 = 0；未做承诺 = 1；承诺并启动 = 1；含糊承诺未兑现 ≤ 0.4）,
    "gaps": [字符串数组，每个 < 30 字，描述未覆盖的细节或承诺漏洞，最多 3 条],
    "should_followup": true/false，是否值得下一轮主动补充
  },
  "next_turn_hint": {
    "predicted_intents": ["smalltalk" | "strategy" | "video" 中的 1-2 个],
    "predicted_query": 字符串 < 40 字，预测用户下一句最可能说的话,
    "preload_actions": [
      { "type": "knowledge" | "video", "query": 字符串 < 30 字 }
    ]，最多 2 条
  },
  "proactive": {
    "should_initiate": true/false，是否值得主动开启话题,
    "trigger_after_idle_ms": 整数，建议沉默多少毫秒后触发，10000-30000,
    "bridge_question": 字符串 < 40 字 必须以问号结尾，主动衔接的话术,
    "confidence": 0-1 浮点
  },
  "session_goal_inference": {
    "primary_goal": 字符串 < 30 字，推断用户本会话的主要目标,
    "covered": [字符串数组，已完成的子目标，最多 3 条],
    "uncovered": [字符串数组，未完成的子目标，最多 3 条]
  },
  "memory_promotion": {
    "should_promote": true/false，本轮是否产生了值得长期保留的记忆,
    "target_layer": "semantic" | "procedural" | "none"，
        - semantic: 关于用户的客观事实/偏好/回避（玩什么位/讨厌什么打法）
        - procedural: 跟这个用户互动的有效方式（讲解风格/节奏/避雷）
        - none: 仅为情景片段，不需要升级
    "content": 字符串 < 60 字，要长期记住的那一句话（仅当 should_promote=true 时填）,
    "confidence": 0-1 浮点
  }
}

评分原则（quality_score）：
- 0.8+ : 紧扣问题，给出可执行步骤，叙事自然，且无空头支票
- 0.5-0.8 : 大致对题但有遗漏或泛泛而谈
- 0.5- : 答非所问 / 拒绝回答 / 内容空洞 / 空头支票 / 字段格式异常
- 当 subagent_activity.this_turn.is_empty_promise = true 时，quality_score 上限不得超过 0.5；
  并必须在 gaps 中明确写出"空头支票：承诺了 X 但未触发子 agent"。

预测原则（predicted_query）：
- 基于游戏陪玩场景：英雄出装、对线、视野、团战、视频集锦
- 不要给出"无法判断"，必须给出最可能的下一句

主动话术原则（bridge_question）：
- 必须以问号结尾，必须是邀请式不能陈述
- 不能暴露"子脑/Agent/规划/反思"等内部术语
- 例：好的："对了，刚学的反野要不要看个高分段集锦？"
- 反例：差的："我反思了一下你刚才的提问，还有什么疑问吗？"

记忆升级原则（memory_promotion）：
- 仅当本轮明确暴露了"用户长期偏好/事实"或"对该用户有效的互动套路"时 should_promote=true
- 一次普通问答（如"亚索连招怎么打"）不应升级为长期记忆，target_layer=none
- 谨慎，confidence < 0.6 时一律视为 should_promote=false`;

function buildReflectorUserPrompt(input = {}) {
  const {
    user_query = '',
    intent = '',
    main_summary = '',
    branch_output = {},
    session_history = [],
    subagent_activity = null,
  } = input;

  const historyLine = session_history
    .slice(-3)
    .map((t, i) => `  ${i + 1}. user: ${t.user_query} | intent: ${t.intent} | summary: ${(t.summary || '').slice(0, 50)}`)
    .join('\n') || '  (会话开始，无历史)';

  const branchSummary = (() => {
    if (!branch_output || typeof branch_output !== 'object') return '(无分支输出)';
    if (intent === 'strategy') {
      return `战术标题: ${branch_output.tactic_title || ''}\n要点数: ${branch_output.details_count || 0}\n降级: ${branch_output.degraded ? '是' : '否'}`;
    }
    if (intent === 'video') {
      return `视频 query: ${branch_output.video_query || ''}\n标题: ${branch_output.video_title || ''}\n降级: ${branch_output.degraded ? '是' : '否'}`;
    }
    return JSON.stringify(branch_output).slice(0, 200);
  })();

  const activityBlock = (() => {
    if (!subagent_activity || typeof subagent_activity !== 'object') return '(本轮无活动账本)';
    const t = subagent_activity.this_turn || {};
    const recentEmpty = (subagent_activity.recent || [])
      .filter((e) => e?.is_empty_promise)
      .map((e) => `  - ${e.turn_id}: 承诺[${(e.empty_promises || []).join('/')}] 启动[${(e.activated_subagents || []).join('/')||'无'}]`)
      .join('\n');
    return [
      `本轮承诺词: ${(t.promises_detected || []).join('/') || '无'}`,
      `本轮启动子 agent: ${(t.activated_subagents || []).join('/') || '无'}`,
      `空头支票: ${t.is_empty_promise ? '是' : '否'}${t.is_empty_promise ? `（漏兑现: ${(t.empty_promises||[]).join('/')}）` : ''}`,
      recentEmpty ? `近 3 轮空头支票记录:\n${recentEmpty}` : '',
    ].filter(Boolean).join('\n');
  })();

  return `# 本轮对话
用户提问: ${user_query}
识别意图: ${intent}
主脑摘要: ${main_summary}

# 分支输出
${branchSummary}

# 子 agent 活动账本（subagent_activity）
${activityBlock}

# 最近 3 轮上下文
${historyLine}

请只输出 JSON。`;
}

const FALLBACK_REFLECTION = Object.freeze({
  this_turn: {
    quality_score: 0.5,
    intent_match: true,
    completeness: 0.5,
    promise_keeping: 1,
    gaps: [],
    should_followup: false,
  },
  next_turn_hint: {
    predicted_intents: [],
    predicted_query: '',
    preload_actions: [],
  },
  proactive: {
    should_initiate: false,
    trigger_after_idle_ms: 15000,
    bridge_question: '',
    confidence: 0,
  },
  session_goal_inference: {
    primary_goal: '',
    covered: [],
    uncovered: [],
  },
  memory_promotion: {
    should_promote: false,
    target_layer: 'none',
    content: '',
    confidence: 0,
  },
});

function clamp(num, min, max, fallback = min) {
  const n = Number(num);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function ensureStringArray(arr, maxLen = 3, maxItemLen = 60) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => typeof x === 'string' && x.trim())
    .slice(0, maxLen)
    .map((x) => x.trim().slice(0, maxItemLen));
}

export function normalizeReflection(raw = {}, ctx = {}) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const t = safe.this_turn || {};
  const n = safe.next_turn_hint || {};
  const p = safe.proactive || {};
  const g = safe.session_goal_inference || {};
  const m = safe.memory_promotion || {};

  const predictedIntents = ensureStringArray(n.predicted_intents, 2, 20).filter((x) =>
    ['smalltalk', 'strategy', 'video'].includes(x)
  );

  const preloadActions = Array.isArray(n.preload_actions)
    ? n.preload_actions
        .filter((a) => a && typeof a === 'object' && a.query)
        .slice(0, 2)
        .map((a) => ({
          type: ['knowledge', 'video'].includes(a.type) ? a.type : 'knowledge',
          query: String(a.query).trim().slice(0, 30),
        }))
    : [];

  let bridge = String(p.bridge_question || '').trim().slice(0, 40);
  if (bridge && !/[?？]$/.test(bridge)) {
    bridge = `${bridge}？`;
  }

  const promotionLayer = ['semantic', 'procedural'].includes(m.target_layer) ? m.target_layer : 'none';
  const promotionConfidence = clamp(m.confidence, 0, 1, 0);
  const promotionContent = String(m.content || '').trim().slice(0, 60);
  const shouldPromote =
    m.should_promote === true &&
    promotionLayer !== 'none' &&
    promotionConfidence >= 0.6 &&
    promotionContent.length > 0;

  // 承诺-兑现：基于 ctx.subagent_activity 强制覆盖（防模型不老实）
  const activityThis = ctx?.subagent_activity?.this_turn || {};
  const isEmptyPromise = activityThis.is_empty_promise === true;
  const promiseDefault = isEmptyPromise ? 0 : 1;
  let promiseKeeping = clamp(t.promise_keeping, 0, 1, promiseDefault);
  if (isEmptyPromise && promiseKeeping > 0.4) promiseKeeping = 0;

  let qualityScore = clamp(t.quality_score, 0, 1, 0.5);
  let gaps = ensureStringArray(t.gaps, 3, 30);
  if (isEmptyPromise) {
    if (qualityScore > 0.5) qualityScore = 0.5;
    const tag = `空头支票:${(activityThis.empty_promises || []).join('/') || '?'}`;
    if (!gaps.some((x) => x.includes('空头支票'))) {
      gaps = [tag, ...gaps].slice(0, 3);
    }
  }

  // 主角幻觉钳制：分支输出（tactic_title / video_query / video_title）若出现 sticky_hero 之外英雄名
  // → quality_score ≤ 0.5，gaps 加"主角幻觉"标记
  const heroHallu = detectHeroHallucination(ctx?.branch_output || {}, ctx?.intent || '', ctx?.sticky_hero || null);
  if (heroHallu.hallucinated) {
    if (qualityScore > 0.5) qualityScore = 0.5;
    const otherHeroes = Array.from(new Set(heroHallu.fields.flatMap((f) => f.others))).slice(0, 3);
    const tag = `主角幻觉:实际${ctx.sticky_hero?.hero || '?'}/输出含${otherHeroes.join('/') || '?'}`;
    if (!gaps.some((x) => x.includes('主角幻觉'))) {
      gaps = [tag, ...gaps].slice(0, 3);
    }
  }

  return {
    this_turn: {
      quality_score: qualityScore,
      intent_match: t.intent_match !== false,
      completeness: clamp(t.completeness, 0, 1, 0.5),
      promise_keeping: promiseKeeping,
      gaps,
      should_followup: t.should_followup === true,
    },
    next_turn_hint: {
      predicted_intents: predictedIntents,
      predicted_query: String(n.predicted_query || '').trim().slice(0, 40),
      preload_actions: preloadActions,
    },
    proactive: {
      should_initiate: p.should_initiate === true,
      trigger_after_idle_ms: clamp(p.trigger_after_idle_ms, 10000, 30000, 15000),
      bridge_question: bridge,
      confidence: clamp(p.confidence, 0, 1, 0),
    },
    session_goal_inference: {
      primary_goal: String(g.primary_goal || '').trim().slice(0, 30),
      covered: ensureStringArray(g.covered, 3, 30),
      uncovered: ensureStringArray(g.uncovered, 3, 30),
    },
    memory_promotion: {
      should_promote: shouldPromote,
      target_layer: shouldPromote ? promotionLayer : 'none',
      content: shouldPromote ? promotionContent : '',
      confidence: promotionConfidence,
    },
  };
}

function withTimeout(promise, ms, label = 'reflector') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildReflectorLiteUserPrompt(input = {}) {
  const {
    user_query = '',
    main_summary = '',
    session_history = [],
  } = input;

  const historyLine = session_history
    .slice(-3)
    .map((t, i) => `  ${i + 1}. user: ${t.user_query} | summary: ${(t.summary || '').slice(0, 50)}`)
    .join('\n') || '  (会话开始，无历史)';

  return `# 本轮闲聊
用户: ${user_query}
助手轻量回复: ${main_summary}

# 最近 3 轮上下文
${historyLine}

只判断 memory_promotion，输出 JSON。`;
}

export async function runReflector(input = {}) {
  if (input?.lite_mode === true) {
    return runReflectorLite(input);
  }
  const startedAt = Date.now();
  try {
    const userPrompt = buildReflectorUserPrompt(input);
    const result = await withTimeout(
      callArkChat({
        systemPrompt: REFLECTOR_SYSTEM_PROMPT,
        userPrompt,
        temperature: 0.3,
        maxTokens: 600,
        timeoutMs: REFLECTOR_TIMEOUT_MS, // 新增：将超时传递给底层的 callArkChat 避免内部挂起
      }),
      REFLECTOR_TIMEOUT_MS,
      'reflector_chat'
    );
    const rawContent = typeof result === 'string' ? result : (result?.content || '');
    const parsed = extractJsonObject(rawContent);
    const normalized = normalizeReflection(parsed, {
      subagent_activity: input.subagent_activity,
      branch_output: input.branch_output,
      intent: input.intent,
      sticky_hero: input.sticky_hero,
    });
    return {
      reflection: normalized,
      latency_ms: Date.now() - startedAt,
      degraded: false,
      error: null,
      raw_text: rawContent.slice(0, 1000),
      mode: 'full',
    };
  } catch (error) {
    return {
      reflection: { ...FALLBACK_REFLECTION },
      latency_ms: Date.now() - startedAt,
      degraded: true,
      error: error?.message || 'reflector_unknown_error',
      raw_text: '',
      mode: 'full',
    };
  }
}

async function runReflectorLite(input = {}) {
  const startedAt = Date.now();
  try {
    const userPrompt = buildReflectorLiteUserPrompt(input);
    const result = await withTimeout(
      callArkChat({
        systemPrompt: REFLECTOR_LITE_SYSTEM_PROMPT,
        userPrompt,
        temperature: 0.2,
        maxTokens: 200,
        timeoutMs: REFLECTOR_LITE_TIMEOUT_MS, // 新增：将超时传递给底层的 callArkChat 避免内部挂起
      }),
      REFLECTOR_LITE_TIMEOUT_MS,
      'reflector_lite_chat'
    );
    const rawContent = typeof result === 'string' ? result : (result?.content || '');
    const parsed = extractJsonObject(rawContent) || {};
    const merged = { ...FALLBACK_REFLECTION, memory_promotion: parsed.memory_promotion || {} };
    const normalized = normalizeReflection(merged, {
      subagent_activity: input.subagent_activity,
      branch_output: input.branch_output,
      intent: input.intent,
      sticky_hero: input.sticky_hero,
    });
    return {
      reflection: normalized,
      latency_ms: Date.now() - startedAt,
      degraded: false,
      error: null,
      raw_text: rawContent.slice(0, 500),
      mode: 'lite',
    };
  } catch (error) {
    return {
      reflection: { ...FALLBACK_REFLECTION },
      latency_ms: Date.now() - startedAt,
      degraded: true,
      error: error?.message || 'reflector_lite_unknown_error',
      raw_text: '',
      mode: 'lite',
    };
  }
}

export const __INTERNAL = {
  buildReflectorUserPrompt,
  REFLECTOR_SYSTEM_PROMPT,
  FALLBACK_REFLECTION,
};
