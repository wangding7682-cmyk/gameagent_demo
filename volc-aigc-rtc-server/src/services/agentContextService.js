import { searchDefaultLocalKnowledge } from './defaultLocalKnowledgeService.js';
import { multiSourceSearch } from './multiSourceKnowledgeService.js';
import { getAgentSessionState, upsertAgentDynamicContext } from './agentSessionStateService.js';
import { loadLongTermMemory, loadUserProfile } from './agentProfileLoaderService.js';
import { searchLayered } from './memoryLayerService.js';
import { summarizeSessionGoal } from './sessionGoalTrackerService.js';
import { buildScreenContextSummary } from './screenEventService.js';
import { extractHeroEntities } from './domainRouterService.js';
import { deriveTaskEngagementContext } from './rtcTaskEngagementService.js';
import { config } from '../config.js';

/**
 * 【上下文装配 / 提示词注入官】agentContextService
 *
 * 通俗职责：每轮对话开始时，把"用户画像 + 长期记忆 + 分层记忆 + 会话目标 +
 * 屏幕白板 + 短期对话历史 + 知识检索"全部拉好、拼成结构化 context 喂给主脑，
 * 同时拼一段 dynamicSummary 短文本注入提示词。
 */

const KNOWLEDGE_TIMEOUT_MS = 10000;
const LAYERED_MEMORY_TIMEOUT_MS = 1500;

// 代词正则：当前轮 query 命中任一项即视为"指代历史主语"
// 含汉语/口语化常见代词，"那个/这个"易误伤但代词指代场景下命中即可触发实体粘性补全
const PRONOUN_REGEX = /(他|她|它|他们|她们|它们|这个英雄|那个英雄|这位英雄|那位英雄|这个角色|那个角色|刚才说的|刚才那个|刚才那位|上面那|前面那|这英雄|那英雄)/;
const PRODUCT_META_QUERY_REGEX = /(弹窗|窗口|卡片|转圈|加载|不弹|不显示|日志|任务|前端|后端|页面|按钮|刷新|报错|错误|bug|接口|连接|重启|服务|链路)/i;
const HERO_CONTEXT_QUERY_REGEX = /(英雄|角色|技能|连招|出装|符文|天赋|对线|对位|克制|打野|刷野|开野|抓人|控龙|河蟹|反野|团战|打法|怎么玩|怎么打|教学|教程|示范|集锦|高光|操作|攻略|阵容|节奏|发育|补刀|gank|上路|中路|下路|辅助|adc|射手|法师|刺客|战士|坦克|大招|被动|视频|链接|资料)/i;

function shouldUseHistoricalStickyHero(query = '') {
  const text = String(query || '').trim();
  if (!text) return false;
  // 产品/调试语境里的“视频、链接、任务、弹窗”不是游戏主角追问，不能继承历史英雄。
  if (PRODUCT_META_QUERY_REGEX.test(text)) return false;
  return PRONOUN_REGEX.test(text) || HERO_CONTEXT_QUERY_REGEX.test(text);
}

/**
 * 实体粘性：当前轮显式英雄优先，否则回退最近 3 轮的 Top1。
 *
 * 修复用例：上一轮聊"亚索"，本轮用户说「我想玩冰晶凤凰，帮我看看这个英雄怎么出装」
 *   - 当前轮已显式提到「冰晶凤凰」 → 当轮主角 = 冰晶凤凰，覆盖历史的"亚索"
 *   - 否则（如「他的技能怎么样？」）→ 仍取历史 Top1 做代词消解
 *
 * @returns {{ hero:string, domain:string, count:number, source:'current'|'history' } | null}
 */
function pickStickyHero(recentTurns = [], domainHint = '', currentQuery = '') {
  // 1) 优先扫当前轮 query 自身
  const currentList = extractHeroEntities(String(currentQuery || ''), domainHint);
  if (currentList.length > 0) {
    return { ...currentList[0], source: 'current' };
  }
  if (!shouldUseHistoricalStickyHero(currentQuery)) {
    return null;
  }
  // 2) 回退最近 3 轮历史
  const text = recentTurns
    .slice(-3)
    .map((t) => `${t.user_query || ''} ${t.summary || t.main_summary || ''}`)
    .join(' ');
  const list = extractHeroEntities(text, domainHint);
  if (list.length === 0) return null;
  return { ...list[0], source: 'history' };
}

/**
 * 代词指代消解：仅当 sticky 来自历史 + 当前 query 含代词且不含主角名时，前置注入主角名
 * 当 sticky 来自当前轮（用户当前轮已显式说出英雄）时绝不改写——避免重复 [关于X] X...
 */
function rewriteWithStickyHero(query = '', stickyHero = null) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery || !stickyHero) return cleanQuery;
  // sticky 来自当前轮 → 主角已经在 query 里，不改写
  if (stickyHero.source === 'current') return cleanQuery;
  // 当前 query 已显式包含主角名 → 不重复注入
  if (cleanQuery.includes(stickyHero.hero)) return cleanQuery;
  // 含我/你时为自指疑问，不对历史 stickyHero 做改写（防止"我配谁"被误改写成 stickyHero 的队友问题）
  if (/[我你]/.test(cleanQuery)) return cleanQuery;
  if (!PRONOUN_REGEX.test(cleanQuery)) return cleanQuery;
  return `[关于${stickyHero.hero}] ${cleanQuery}`;
}



function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(`${label} 超时`);
        error.code = 'TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]);
}

function stripInvisibleChars(text = '') {
  return String(text)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\u200B-\u200D\u2060-\u2064]/g, '')
    .trim();
}

function normalizeKnowledgeItem(item = {}) {
  return {
    id: item.id || item.point_id || '',
    title: stripInvisibleChars(item.chunk_title || item.title || item.doc_info?.title || '知识片段'),
    content: stripInvisibleChars(String(item.content || item.description || '')).slice(0, 700),
    score: item.rerank_score || item.score || 0,
    docName: item.doc_info?.doc_name || item.docName || '',
  };
}

function turnMatchesCurrentHero(turn = {}, stickyHero = null) {
  const currentHero = String(stickyHero?.hero || '').trim();
  if (!currentHero) return true;
  const heroFocus = String(turn?.hero_focus || '').trim();
  if (heroFocus && heroFocus === currentHero) return true;
  const query = String(turn?.user_query || '');
  if (query.includes(currentHero)) return true;
  const ragItems = Array.isArray(turn?.rag_top_items) ? turn.rag_top_items : [];
  return ragItems.some((item) => `${item?.title || ''} ${item?.content || ''}`.includes(currentHero));
}

function buildHistoricalRagContext(recentTurns = [], stickyHero = null) {
  const turns = Array.isArray(recentTurns) ? recentTurns.slice(-5) : [];
  const filtered = turns.filter((turn) => {
    const hasSummary = Boolean(String(turn?.rag_summary || '').trim());
    const hasItems = Array.isArray(turn?.rag_top_items) && turn.rag_top_items.length > 0;
    return (hasSummary || hasItems) && turnMatchesCurrentHero(turn, stickyHero);
  });
  return filtered.map((turn) => {
    const topItems = (Array.isArray(turn?.rag_top_items) ? turn.rag_top_items : [])
      .slice(0, 2)
      .map((item) => `${String(item?.title || '').slice(0, 24)}: ${String(item?.content || '').slice(0, 80)}`)
      .join('；');
    const ragSummary = String(turn?.rag_summary || '').trim();
    return [
      `[历史参考][${turn?.intent || 'unknown'}] ${String(turn?.user_query || '').slice(0, 60)}`,
      ragSummary ? `摘要：${ragSummary.slice(0, 140)}` : '',
      topItems ? `片段：${topItems}` : '',
    ].filter(Boolean).join(' | ');
  }).join('\n');
}

export function summarizeKnowledgeResult(result = {}) {
  const list = result?.data?.result_list || result?.result_list || [];
  return list
    .slice(0, 5)
    .map(normalizeKnowledgeItem)
    .filter((item) => item.content)
    .map((item, index) => `${index + 1}. ${item.title}: ${item.content}`)
    .join('\n');
}

const DEFAULT_BUILTIN_SOURCES = [
  { type: 'default_local', domain: 'lol', label: '内置·英雄联盟示例库', enabled: true, topK: 5 },
  { type: 'default_local', domain: 'wzry', label: '内置·王者荣耀示例库', enabled: true, topK: 5 },
  { type: 'house_volc', label: '官方云端库', enabled: true, topK: 5 },
];

const DEMO_ONLY_SOURCES = [
  { type: 'default_local', domain: 'lol', label: '内置·英雄联盟示例库', enabled: true, topK: 5 },
  { type: 'default_local', domain: 'wzry', label: '内置·王者荣耀示例库', enabled: true, topK: 5 },
];

function normalizeIncomingSources(rawSources) {
  if (!Array.isArray(rawSources)) return null;
  return rawSources
    .filter((s) => s && typeof s === 'object' && typeof s.type === 'string')
    .map((s) => ({
      type: s.type,
      domain: s.domain || null,
      label: s.label || '',
      enabled: s.enabled !== false,
      topK: Number(s.topK) > 0 ? Number(s.topK) : 5,
      items: Array.isArray(s.items) ? s.items : undefined,
      apiKey: s.apiKey || undefined,
      serviceResourceId: s.serviceResourceId || undefined,
    }))
    .filter((s) => s.enabled);
}

function buildLegacyResultFromMulti(multi) {
  const list = (multi?.items || []).map((it) => ({
    point_id: it.id,
    chunk_title: it.title,
    content: it.content,
    rerank_score: it.relevance,
    score: it.relevance,
    doc_info: { doc_name: it.docName || it.sourceLabel || '', title: it.title },
  }));
  return { data: { result_list: list } };
}

export async function retrieveAgentKnowledge({
  query,
  forceMock = false,
  limit = 4,
  sources = null,
  rerankStrategy = 'embedding',
  domainContext = '',
  strictDomain = true,
} = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) {
    throw new Error('Agent 知识检索需要 query');
  }

  const userSources = normalizeIncomingSources(sources);

  let effectiveSources;
  if (forceMock) {
    effectiveSources = DEMO_ONLY_SOURCES.slice();
  } else if (userSources && userSources.length > 0) {
    effectiveSources = userSources;
  } else {
    effectiveSources = DEFAULT_BUILTIN_SOURCES.slice();
  }

  try {
    const multi = await withTimeout(
      multiSourceSearch({
        query: cleanQuery,
        sources: effectiveSources,
        topK: limit,
        rerankStrategy,
        domainContext,
        strictDomain,
      }),
      KNOWLEDGE_TIMEOUT_MS,
      '多源知识库检索'
    );

    const legacyResult = buildLegacyResultFromMulti(multi);
    return {
      provider: 'multi_source',
      forceMock,
      query: cleanQuery,
      result: legacyResult,
      items: multi.items.map((it) => ({
        id: it.id,
        title: it.title,
        content: it.content,
        score: it.relevance,
        sourceType: it.sourceType,
        sourceLabel: it.sourceLabel,
        sourceDomain: it.sourceDomain,
        docName: it.docName,
        nativeScore: it.nativeScore,
        rerankScore: it.rerankScore,
        rerankSource: it.rerankSource,
        relevance: it.relevance,
      })),
      summary: multi.summary,
      detectedDomains: multi.detectedDomains,
      domainSource: multi.domainSource,
      strictMode: multi.strictMode,
      skipped: multi.skipped,
      rerankSource: multi.rerankSource,
      poolSize: multi.poolSize,
      sources: effectiveSources.map((s) => ({ type: s.type, domain: s.domain, label: s.label })),
      error: null,
    };
  } catch (error) {
    const fallbackResult = searchDefaultLocalKnowledge(cleanQuery, limit);
    return {
      provider: 'multi_source',
      fallback: true,
      fallbackProvider: 'default_local',
      query: cleanQuery,
      result: fallbackResult,
      items: (fallbackResult?.data?.result_list || []).map(normalizeKnowledgeItem),
      summary: summarizeKnowledgeResult(fallbackResult),
      sources: effectiveSources.map((s) => ({ type: s.type, domain: s.domain, label: s.label })),
      error: {
        code: error.code || 'KNOWLEDGE_ERROR',
        message: error.message || '多源知识库检索失败',
      },
    };
  }
}

export async function buildAgentContext(body = {}, turnId = '') {
  const sessionId = String(body.sessionId || body.session_id || body.userId || body.user_id || 'default').trim();
  const userId = String(body.userId || body.user_id || sessionId || 'default').trim();
  const userQuery = String(body.text || body.query || body.user_query || '').trim();
  const orchestrationInput = String(body.orchestrationInput || body.orchestration_input || userQuery).trim();
  const rawAsrText = String(body.rawAsrText || body.raw_asr_text || '').trim();
  const forceMock = body.forceMock === true || body.source === 'demo_button';
  const incomingContext = body.context && typeof body.context === 'object' ? body.context : {};
  const knowledgeSources = body.knowledgeSources || body.knowledge_sources || body.sources || null;
  const rerankStrategy = String(body.rerankStrategy || body.rerank_strategy || 'embedding');
  const userProfile = loadUserProfile(userId);
  const longTermMemory = loadLongTermMemory(userId, turnId);
  const sessionStateBeforeUpdate = getAgentSessionState(sessionId);
  const normalizedIncomingContext = deriveTaskEngagementContext({
    userQuery,
    source: body.source || '',
    previousDynamicContext: sessionStateBeforeUpdate?.dynamic_context || {},
    incomingContext,
  });

  if (Object.keys(normalizedIncomingContext).length > 0) {
    upsertAgentDynamicContext(sessionId, normalizedIncomingContext);
  }

  const sessionState = getAgentSessionState(sessionId);
  const dynamicContext = {
    ...(sessionState.dynamic_context || {}),
    ...normalizedIncomingContext,
  };

  // 屏幕观察 → 当前画面摘要（10s 新鲜度门槛 + 80 字硬限）
  const screenObservation = buildScreenContextSummary(
    dynamicContext.screen_event_state || sessionState?.dynamic_context?.screen_event_state,
    { freshnessMs: 10000 }
  );
  const screenContextBlock = screenObservation
    ? `[当前画面] ${screenObservation.summary}${screenObservation.isFresh ? '' : '（信息已过期，仅供参考）'}`
    : '';

  const dynamicSummary = [
    dynamicContext.frameContext?.summary,
    dynamicContext.imagePushContext?.summary,
    dynamicContext.screenContext?.summary,
    screenContextBlock,
    dynamicContext.summary,
  ].filter(Boolean).join('\n');

  const recentSummary = (sessionState.recent_turns || [])
    .slice(-6)
    .map((turn) => `${turn.intent || 'unknown'}: ${turn.user_query || ''} -> ${turn.summary || turn.main_summary || ''}`)
    .join('\n');

  // 实体粘性 + 代词消解：让 video_query / strategy_title 不再丢主角
  // - stickyHero：当前轮显式英雄优先，否则回退最近 3 轮 Top1
  // - orchestrationInputResolved：仅 sticky.source==='history' 且含代词时前置注入
  const stickyHero = pickStickyHero(sessionState.recent_turns || [], '', userQuery);
  const orchestrationInputResolved = rewriteWithStickyHero(orchestrationInput || userQuery, stickyHero);
  const userQueryResolved = rewriteWithStickyHero(userQuery, stickyHero);
  const coreferenceApplied = orchestrationInputResolved !== (orchestrationInput || userQuery);
  const historicalRagContext = buildHistoricalRagContext(sessionState.recent_turns || [], stickyHero);

  const ragQuery = [userQueryResolved, dynamicSummary].filter(Boolean).join('\n当前视觉/图文上下文: ');

  // sticky domain context：从最近 3 轮拼出 domain 探测语料，喂给 multiSourceSearch
  // 让"他们的技能/这个英雄"等指代场景能回退到上轮 domain（如 lol），避免被王者跨域文档污染
  const recentForDomain = (sessionState.recent_turns || [])
    .slice(-3)
    .map((turn) => `${turn.user_query || ''} ${turn.summary || turn.main_summary || ''}`)
    .filter(Boolean)
    .join(' ');

  const knowledgePromise = retrieveAgentKnowledge({
    query: ragQuery || userQuery,
    forceMock,
    limit: Number(body.knowledgeLimit || 4),
    sources: knowledgeSources,
    rerankStrategy,
    domainContext: recentForDomain,
    strictDomain: true,
  });

  const layeredMemoryPromise = (async () => {
    if (config.memory.mode !== 'viking') {
      return { items: [], counts_per_layer: {}, raw_count: 0, skipped: 'memory_mode_not_viking' };
    }
    if (!userQuery) {
      return { items: [], counts_per_layer: {}, raw_count: 0, skipped: 'empty_query' };
    }
    try {
      return await withTimeout(
        searchLayered({ query: userQuery, userId, limit: 8, turnId }),
        LAYERED_MEMORY_TIMEOUT_MS,
        '分层记忆召回'
      );
    } catch (err) {
      return { items: [], counts_per_layer: {}, raw_count: 0, error: err?.message || 'layered_memory_failed' };
    }
  })();

  const [knowledge, layeredMemory] = await Promise.all([knowledgePromise, layeredMemoryPromise]);

  const sessionGoalRaw = sessionState?.dynamic_context?.session_goal || null;
  const sessionGoalSummary = summarizeSessionGoal(sessionGoalRaw);

  return {
    sessionId,
    userId,
    userQuery,
    // userQueryResolved/orchestrationInput：经过代词消解后的 query，主链路下游应优先使用
    // 保留 raw userQuery 供日志/Reflector 复盘原始输入
    userQueryResolved,
    orchestrationInput: orchestrationInputResolved,
    orchestrationInputRaw: orchestrationInput,
    rawAsrText,
    // stickyHero：最近 3 轮的主角实体（Top1），video/strategy/reflector 据此约束输出
    stickyHero,
    coreferenceApplied,
    // source：调用方显式传递的入口标签；若所有上游兜底都没拦住，最终兜底为 direct_invoke
    // （区别于真正"识别失败"的 unknown，方便前端做诊断映射）
    source: body.source || 'direct_invoke',
    // proactive_check：silence 评测专用标记，true 时表示"无显式提问、仅画面信号"，
    // 下游 Interaction/Main Agent 据此进入克制模式（emotional_reply≤8字 + main_summary 空 + branch_wait_reply 空）
    proactiveCheck: body.proactive_check === true || body.proactiveCheck === true,
    forceMock,
    userProfile,
    longTermMemory,
    layeredMemory,
    sessionGoal: sessionGoalRaw,
    sessionGoalSummary,
    screenObservation,
    shortMemory: {
      recent_turns: sessionState.recent_turns || [],
      summary: recentSummary,
    },
    historicalRagContext,
    dynamicContext,
    dynamicSummary,
    rag: knowledge,
  };
}
