import { callArkChatStream, extractJsonObject } from './arkChatService.js';
import { getAgentProfileBundle } from './agentProfileLoaderService.js';
import { trimMainAgentOutput } from './outputTrimmerService.js';

function cleanText(value = '') {
  return String(value || '')
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonStringLiteral(value = '') {
  try {
    return JSON.parse(`"${value}"`);
  } catch (_) {
    return String(value || '');
  }
}

function extractSpeechDeltasFromPartialJson(content = '', emittedCount = 0) {
  const match = String(content || '').match(/"speech_delta"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
  if (!match) {
    return [];
  }
  const items = [];
  const itemPattern = /"((?:\\.|[^"\\])*)"/g;
  let itemMatch = null;
  while ((itemMatch = itemPattern.exec(match[1])) !== null) {
    const parsed = cleanText(parseJsonStringLiteral(itemMatch[1]));
    if (parsed) {
      items.push(parsed);
    }
  }
  return items.slice(emittedCount);
}

// 战术信号词正则（与 system prompt 决策树对齐）
// 注意："连招"不单独作为战术词，因为"连招视频/连招示范"是明确的 video 信号词组合
// 用途：作为 LLM 路由的兜底护栏——只有原句含纯战术词（非 video 修饰词）时，主意图才是 strategy
const STRATEGY_SIGNAL_REGEX = /(怎么打|怎么练|怎么帮|怎么对|怎么入侵|怎么应对|怎么反|对线|出装|克制|翻盘|阵容|上分|咋办|打法|攻略|技巧|被反|被针对|被压|被打爆|帮.{0,3}(ADC|adc|打野|上单|中单|辅助|队友))/;
const PRODUCT_VIDEO_META_REGEX = /(弹窗|窗口|卡片|转圈|加载|不弹|不显示|页面已无|打不开|报错|错误|日志|任务)/;
const SILENCE_QUERY_REGEX = /^(啊+|嗯+|哎+|额+|呃+|\.{2,}|…+|我靠差点死了)[。！？!?，,\s.…”“]*$/;
const HIGH_PRESSURE_EVENTS = new Set(['team_fight', 'low_hp', 'escape', 'enemy_nearby', 'skill_cast']);

function getScreenEventState(context = {}) {
  return context.dynamicContext?.screen_event_state
    || context.screen_event_state
    || context.screenEventState
    || {};
}

function buildSilenceGuardOutput(context = {}, reason = 'silence_guard') {
  const userQuery = String(context.userQuery || '').trim();
  const screenState = getScreenEventState(context);
  const events = Array.isArray(screenState.recent_events) ? screenState.recent_events.map((e) => e?.type).filter(Boolean) : [];
  const hasPressureEvent = events.some((type) => HIGH_PRESSURE_EVENTS.has(type));
  const isLobby = screenState.last_scene === 'in_lobby';
  const isLowHp = typeof screenState.last_hp_pct === 'number' && screenState.last_hp_pct <= 12;
  const isPassiveLane = events.some((type) => ['normal_lane', 'farming'].includes(type));
  const shouldGuard = context.proactiveCheck === true
    || (SILENCE_QUERY_REGEX.test(userQuery) && (hasPressureEvent || isLowHp || isLobby || isPassiveLane));
  if (!shouldGuard) return null;

  const shortReply = isLobby ? '在呢' : (isLowHp || events.includes('escape') ? '稳住稳住' : (hasPressureEvent ? '稳住' : '嗯'));
  return {
    task_id: context.taskId || '',
    fsm_state: 'MAIN_REPLIED',
    intent: 'smalltalk',
    popup_mode: 'chat_reply',
    strategy_output_mode: 'none',
    needs_image: false,
    image_query: null,
    speakable: Boolean(shortReply),
    emotional_reply: shortReply,
    understanding_reply: '',
    branch_wait_reply: '',
    main_tts_bundle: shortReply,
    main_summary: '',
    route_reason: reason,
    strategy_query: null,
    video_query_seed: null,
    queue_hint: '',
    tts_priority: 'low',
    speech_delta: shortReply ? [shortReply] : [],
  };
}

export function hasStrategySignalWord(userQuery = '') {
  return STRATEGY_SIGNAL_REGEX.test(String(userQuery || ''));
}

export function buildLocalRouteHint(userQuery = '') {
  const text = String(userQuery || '');
  if (PRODUCT_VIDEO_META_REGEX.test(text) && /(视频|链接|抖音|B站|b站|卡片|弹窗|页面)/.test(text)) {
    return {
      intent: 'smalltalk',
      hint_confidence: 0.95,
      placeholder_type: 'soft',
      ui_commit: false,
      reason: 'product_video_meta',
    };
  }
  const hasVideoCue = /(视频|集锦|高光|教学|示范|看看|演示|录像|教程|链接|资料链接|教程链接|看个)/.test(text);
  const hasNewTopicConnector = /(另外|还有|顺便|同时|此外|对了|哦对了|再)/.test(text);
  if (hasVideoCue && hasNewTopicConnector && isExplicitStrategyAsk(text)) {
    return {
      intent: 'strategy',
      hint_confidence: 0.78,
      placeholder_type: 'soft',
      ui_commit: false,
      reason: 'compound_strategy_primary_hint',
    };
  }
  // 优先检查 video 关键词——含"视频/示范/连招视频/教程"的_query强暗示视频意图，
  // 应优先于 strategy 信号词（如"连招"）判断，防止"亚索连招视频"被误路由到 strategy
  if (/视频教学|视频示范|连招视频|操作视频|看个示范|发个视频|找个视频|教学视频|实战视频|教程视频|有没有视频|视频链接/.test(text)
    || /(找|搜|检索|推荐|给|给我|有没有|有无|发).{0,16}(视频|示范|演示)/.test(text)
    || /(找|搜|检索|推荐|给|给我|有没有|有无|发).{0,16}(链接|资料链接|教程链接)/.test(text)
    || /视频|集锦|高光|操作秀|操作集锦|精彩操作|抖音|B站|b站|教学录像|实战录像|名场面|神仙操作/.test(text)) {
    return {
      intent: 'video',
      hint_confidence: 0.86,
      placeholder_type: 'soft',
      ui_commit: false,
      reason: 'video_keyword_hint',
    };
  }
  // 然后检查 strategy（明确卡片 or 强战术词 or 主题+动作组合）
  if (isExplicitStrategyAsk(text)) {
    return {
      intent: 'strategy',
      hint_confidence: 0.82,
      placeholder_type: 'soft',
      ui_commit: false,
      reason: 'strategy_keyword_hint',
    };
  }
  return {
    intent: 'smalltalk',
    hint_confidence: 0.7,
    placeholder_type: 'soft',
    ui_commit: false,
    reason: 'default_smalltalk',
  };
}

export function localRouteIntent(userQuery = '') {
  return buildLocalRouteHint(userQuery).intent;
}

// 收紧后的战术词：去掉「连招/思路/节奏/卡片」等单字易误判项，保留明确求助词
// 注：「连招」单独出现含义模糊，必须结合上下文（若是"连招视频/教学"会被 video 检查优先捕获）
const STRATEGY_STRONG_KEYWORDS = ['怎么打', '打法', '怎么处理', '克制', '对线', '出装', '战术', '阵容', '入侵', '防守', '攻略', '资源交换', '兵线处理'];
// 主题词（英雄/位置/资源），需配合"动作/求助"出现才算战术意图
const STRATEGY_TOPIC_KEYWORDS = ['英雄', '中单', '上单', '打野', '辅助', '射手', 'adc', 'AD', '装备', '技能', '兵线', '大龙', '先锋', '小龙', '峡谷'];
const STRATEGY_ACTION_KEYWORDS = ['怎么', '如何', '应该', '该不该', '推荐', '帮我', '给我', '教我', '建议'];
// 卡片/图文是高显式信号，单独成立
const STRATEGY_CARD_KEYWORDS = ['知识卡片', '知识卡', '战术卡片', '战术卡', '图文', '配图', '生成图', '画一张', '出一张', '做成图', '做成卡'];

function isExplicitStrategyAsk(text = '') {
  const lower = String(text || '').toLowerCase();
  // 1) 明确卡片需求
  if (STRATEGY_CARD_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    return true;
  }
  // 2) 强战术词直接命中
  if (STRATEGY_STRONG_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    return true;
  }
  // 3) 主题词 + 动作词组合（避免「我有思路」「节奏不错」误判）
  const hasTopic = STRATEGY_TOPIC_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  const hasAction = STRATEGY_ACTION_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  return hasTopic && hasAction;
}

export function shouldGenerateStrategyImage(userQuery = '') {
  return ['知识卡片', '知识卡', '战术卡片', '战术卡', '卡片', '图片', '生图', '画一张', '出一张', '生成图', '配图', '做成图', '做成卡']
    .some((kw) => String(userQuery || '').includes(kw));
}

export function buildVideoSearchSeed(userQuery = '') {
  const normalized = String(userQuery || '')
    .replace(/[，。！？!?、；;：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/打野/.test(normalized) && /(视野|插眼)/.test(normalized) && /反蹲/.test(normalized)) {
    return '打野视野反蹲教学';
  }
  const text = normalized
    .replace(/哎呀|哎哟|哎|欸|呃|额|嗯嗯|嗯/g, ' ')
    .replace(/我让你|让我|你给我|帮我|给我|你|那个|这个|一个/g, ' ')
    .replace(/之前的|刚才的|上次的|上一个|那条|这条/g, ' ')
    .replace(/生成的|整理的|发的|找的|说的/g, ' ')
    .replace(/有没有|有吗|在哪里|在哪|在哪儿|哪里|哪儿|指导|呢|吧|好吧|可以|看看|看一下|看下/g, ' ')
    .replace(/的视频|教学视频|视频链接|资料链接|教程链接|视频|链接/g, ' ')
    .replace(/\b个\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/亚索/.test(text) && /骚操作|极限|精彩|集锦|操作/.test(text)) {
    return '亚索极限操作集锦';
  }
  if (text) {
    if (/集锦|高光|精彩|操作/.test(text)) {
      return text;
    }
    if (/教学|教程|连招|打法|技巧|思路|出装|对线/.test(text)) {
      return /教学|教程/.test(text) ? text : `${text} 教学视频`;
    }
    return `${text} 教学视频`;
  }
  return '教学视频';
}

function inferCanonicalVideoSeed(text = '') {
  const source = String(text || '');
  if (/打野/.test(source) && /(视野|插眼)/.test(source) && /反蹲/.test(source)) {
    return '打野视野反蹲教学';
  }
  return '';
}

function extractVideoSeedAnchors(text = '') {
  const source = String(text || '');
  const anchors = new Set();
  const patterns = [
    /[A-Za-z]{2,}/g,
    /(ADC|adc|AD|ad|打野|上单|中单|辅助|射手|下路|团战|站位|视野|插眼|反蹲|入侵|路线|抗压|游走|带节奏|gank|Gank|连招|对线|出装|教学|教程|集锦|高光|实战|反杀|劫|亚索|盲僧|瑞兹|狐狸)/g,
    /[\u4e00-\u9fa5]{2,4}/g,
  ];
  for (const pattern of patterns) {
    const matches = source.match(pattern) || [];
    for (const item of matches) {
      const token = cleanText(item);
      if (token && !/^(怎么|如何|应该|给我|帮我|一个|相关|内容|视频|看看|看个|指导)$/.test(token)) {
        anchors.add(token.toLowerCase());
      }
    }
  }
  return [...anchors];
}

function isVideoSeedGroundedInQuery(seed = '', userQuery = '') {
  const candidate = String(seed || '').toLowerCase();
  if (!candidate || candidate === '教学视频') return false;
  const anchors = extractVideoSeedAnchors(userQuery);
  if (anchors.length === 0) return true;
  return anchors.some((token) => candidate.includes(token));
}

function isLikelyVideoFollowup(userQuery = '') {
  const text = String(userQuery || '').trim();
  if (!text) return false;
  const hasVideoWord = /(视频|链接|教程|教学)/.test(text);
  const hasFollowupWord = /(上次|刚才|之前|刚刚|那个|这条|那条|上一个|还没|怎么还没|没发|发过来|在哪|在哪儿|呢)/.test(text);
  return hasVideoWord && hasFollowupWord;
}

function pickRecentVideoQuery(recentTurns = [], stickyHero = '') {
  const turns = Array.isArray(recentTurns) ? [...recentTurns].reverse() : [];
  let fallbackQuery = '';
  for (const turn of turns) {
    const query = cleanText(turn?.video_query || '');
    if (!query) continue;
    if (stickyHero && query.includes(stickyHero)) {
      return query;
    }
    if (!fallbackQuery) {
      fallbackQuery = query;
    }
  }
  return fallbackQuery;
}

function resolveVideoSearchSeed(context = {}, candidateSeed = '') {
  const stickyHero = context.stickyHero?.hero || '';
  const recentTurns = context.shortMemory?.recent_turns || [];
  const rawUserQuery = context.userQuery || '';
  const resolvedUserQuery = context.userQueryResolved || rawUserQuery;
  const canonicalSeed = inferCanonicalVideoSeed(rawUserQuery || resolvedUserQuery);
  if (canonicalSeed) {
    return canonicalSeed.slice(0, 120);
  }

  if (isLikelyVideoFollowup(rawUserQuery) || isLikelyVideoFollowup(resolvedUserQuery)) {
    const recentQuery = pickRecentVideoQuery(recentTurns, stickyHero);
    if (recentQuery && isVideoSeedGroundedInQuery(recentQuery, rawUserQuery || resolvedUserQuery)) {
      return recentQuery;
    }
  }

  const explicitSeed = cleanText(candidateSeed || '');
  if (explicitSeed && explicitSeed !== '教学视频') {
    if (isVideoSeedGroundedInQuery(explicitSeed, rawUserQuery || resolvedUserQuery)) {
      return explicitSeed.slice(0, 120);
    }
  }

  const builtSeed = buildVideoSearchSeed(rawUserQuery || resolvedUserQuery);
  if (builtSeed && builtSeed !== '教学视频') {
    return builtSeed.slice(0, 120);
  }

  if (stickyHero) {
    return `${stickyHero} 教学视频`.slice(0, 120);
  }

  return (explicitSeed || builtSeed || '教学视频').slice(0, 120);
}

export function extractKeywordSnippet(userQuery = '') {
  const stopWords = ['帮我', '给我', '我想', '请问', '能不能', '可以', '做一张', '做一份', '整理', '生成', '来个', '一下', '一张', '一份', '知识卡片', '知识卡', '战术卡片', '战术卡', '卡片', '图片', '的', '了', '吗', '呢', '啊'];
  let text = String(userQuery || '').trim();
  for (const word of stopWords) {
    text = text.replace(new RegExp(word, 'g'), '');
  }
  return text.replace(/\s+/g, '').slice(0, 16) || String(userQuery || '').slice(0, 12) || '当前问题';
}

export function fallbackForIntent(context = {}, reason = '') {
  const userQuery = context.userQuery || '';
  const intent = localRouteIntent(userQuery);
  const needsImage = intent === 'strategy' && shouldGenerateStrategyImage(userQuery);
  const snippet = extractKeywordSnippet(userQuery);
  const videoSeed = intent === 'video' ? resolveVideoSearchSeed(context) : null;
  const videoSeedForReply = String(videoSeed || '匹配视频').slice(0, 20);

  const output = trimMainAgentOutput({
    task_id: context.taskId || '',
    fsm_state: 'MAIN_REPLIED',
    intent,
    popup_mode: intent === 'video' ? 'video_search' : intent === 'strategy' ? (needsImage ? 'strategy_card' : 'strategy_text') : 'chat_reply',
    strategy_output_mode: intent === 'strategy' ? (needsImage ? 'card_with_image' : 'text_only') : 'none',
    needs_image: needsImage,
    image_query: needsImage ? userQuery : null,
    speakable: true,
    emotional_reply: intent === 'video'
      ? '我先找匹配视频。'
      : intent === 'strategy'
        ? '稳住，我帮你拆。'
        : '我懂你意思。',
    understanding_reply: intent === 'video'
      ? `你想看${videoSeedForReply}相关内容，我先帮你检索。`
      : intent === 'strategy'
        ? `你想处理的是${snippet}这块问题。`
        : '',
    branch_wait_reply: intent === 'video'
      ? '我先检索匹配视频，稍后给你展示结果。'
      : intent === 'strategy'
        ? (needsImage ? '我整理成图文卡片后直接弹出。' : '我整理好战术建议后直接弹出。')
        : '',
    main_summary: intent === 'smalltalk'
      ? '这个问题我先接住。简单说，先别急着给自己下结论，把当前局面拆成一个最小目标，会更容易稳住。'
      : '',
    route_reason: reason || 'Interaction_Agent fallback',
    strategy_query: intent === 'strategy' ? userQuery : null,
    video_query_seed: videoSeed,
    queue_hint: intent === 'strategy' || intent === 'video' ? '后台任务静默执行' : '',
    tts_priority: 'high',
  });
  return {
    ...output,
    speech_delta: buildSpeechDeltas(output),
  };
}

function summarizeMemory(memory = {}) {
  const facts = Array.isArray(memory.facts) ? memory.facts.slice(0, 3) : [];
  const preferences = Array.isArray(memory.preferences) ? memory.preferences.slice(0, 3) : [];
  return [
    facts.length ? `长期事实：${facts.join('；')}` : '',
    preferences.length ? `偏好：${preferences.join('；')}` : '',
  ].filter(Boolean).join('\n') || '暂无长期记忆';
}

function buildInteractionSystemPrompt({ persona = {}, userProfile = {}, preferences = {} } = {}) {
  const style = persona.speaking_style || {};
  const game = userProfile.game_profile || {};
  const limits = preferences.output_limits || {};

  return `【Interaction_Agent 系统契约】
你是游戏纸片人智能体的低延迟交互层，只负责本轮首句语音与轻量意图识别。
你不是 Strategy_Agent 或 Video_Agent，不生成完整攻略、卡片内容、视频链接，不描述内部工具。

核心目标：
1. 用极短时间输出可播回复，避免用户等待完整后台 Agent。
2. intent 只能是 smalltalk、strategy、video。
3. smalltalk 输出 emotional_reply + main_summary；branch_wait_reply 必须为空。
4. strategy/video 输出 emotional_reply + understanding_reply + branch_wait_reply；main_summary 必须为空。
5. strategy/video 的后台任务会静默执行，不能承诺已经完成，只能说“整理后弹出/找到后弹出”。
6. 所有给用户看的字段禁止括号内容、工具调用、系统说明、内部 Agent 名称。
7. 严格只返回 JSON。
8. speech_delta 必须紧跟 intent 输出，并按可播顺序拆成 1-3 个短句；这是实时 TTS 输入。

路由规则：
- 用户要聊天、观点确认、情绪安慰、玩法哲学、连跪心态、宏观选择时选 smalltalk。
- 用户要打法、战术、克制、对线、出装、阵容、连招、知识卡片、图文卡片时选 strategy。
- 用户要找/看/搜视频、集锦、高光、抖音、B站、实战录像、操作演示时选 video。

【复合意图主路由硬规则（优先级高于上面三条）】
**主原则：复合句一律返回 strategy 作为主意图（除非完全没有战术成分）。** 视频检索作为附属子任务由 TaskPlanner 异步并行触发，不需要靠主意图来承载。

**判定决策树（按顺序检查）**：
0. **【优先级最高】句中含"视频/示范/演示/教程/链接"等明确 video 信号词**：
   - 若同时含"连招视频/连招示范/连招演示"，**intent 必须为 video**（"连招"在此是视频类型修饰词，不是战术词）
   - 若含"操作视频/高光集锦/实战演示/B站视频/抖音视频"，**intent 必须为 video**
   - video 信号词列表：视频、示范、演示、教程、链接、资料链接、找/搜/给/发+视频/集锦/高光
1. 然后检查是否含**战术信号词**？战术信号词包括："怎么打" "怎么练" "怎么帮" "怎么对" "对线" "出装" "克制" "翻盘" "阵容" "上分" "咋办" "打法" "攻略" "技巧" "被反" "被针对" "被压" "被打爆" "帮ADC" "帮打野" "帮上单" "帮中单" "帮辅助"。
2. 如果含**任意一个战术信号词**，且步骤0未命中，**intent 必须为 strategy**。视频部分会由 TaskPlanner 异步派发，不影响主路由。
3. 只有完全不含任何战术信号词，仅有"看视频/找视频/集锦/高光/教学"的纯视频请求，才允许 video。
4. 完全是聊天/情绪/观点，无战术也无视频，才是 smalltalk。

**严禁误判（这些是 strategy，不是 video）**：
- "瑞兹怎么打狐狸？" → strategy（含"怎么打"）
- "辅助怎么帮ADC上分？" → strategy（含"怎么帮"+"上分"）
- "我被人吐槽走A难看，怎么练走A？" → strategy（含"怎么练"）
- "打野前期怎么入侵？" → strategy（含"怎么入侵"）
- "心态崩了，怎么对线劫？" → strategy（含"对线"）

**正确 video 路由（这些才是 video）**：
- "给我看亚索五杀视频" → video（无战术词，纯视频请求）
- "找个王者打野的高光集锦" → video（无战术词，纯视频请求）
- "B站有没有李白连招的教学" → video（"教学"是视频载体，"连招"是视频类型修饰词，不是战术问题词）
- "亚索E接Q连招视频教学有没有" → video（"连招视频"是明确的 video 信号组合）

**branch_wait_reply 双承接**：strategy 主意图但句中含视频请求时，branch_wait_reply 应同时承接两个动作（如"我先把对线打法说给你，再去给你找一个连招视频"），不要只提视频。

【silence 克制模式（proactive_check=true 专用，最高优先级）】
当 user_prompt 中 proactive_check=true 时，表示玩家此刻并未发言，仅有屏幕画面信号触发了"AI 该不该主动开口"的评估。
- 默认行为是闭嘴：除非画面里出现明确且紧迫的战术信号（low_hp_warning/ult_ready 且 last_hp_pct<0.3、ganked、objective_spawn 且自身在场、team_fight 已开），否则一律保持沉默。
- 沉默时输出：intent="smalltalk"，emotional_reply 必须 ≤8 字（如"嗯。""我在看。""稳住。"），main_summary 留空字符串，understanding_reply 留空字符串，branch_wait_reply 留空字符串，speech_delta=[]。
- 严禁在沉默场景输出战术词（开团/推塔/打野/支援/兵线/视野等）、提问、追问"需要我帮你..."、或 18+ 字的解释。
- 仅当画面信号确实触发"必须提醒"时，才允许 emotional_reply 8-12 字 + main_summary ≤30 字 简短预警，且只能针对画面里出现的事实，不允许编造英雄/段位/连败等画面没给的信息。
- 任何情况下严禁把 user_query 占位文本"(玩家未发言，仅有屏幕画面信号)"复述出来，更不能拿它当问题回答。

语气约束：
助手名称：${persona.name || '小纸'}
语气：${style.tone || '轻松但专业'}
句式：${style.sentence_length || '短句为主'}
用户段位：${game.rank_tier || '未知'}${game.rank_division || ''}
emotional_reply：必须 ${limits.emotional_reply_min || 8}-${limits.emotional_reply_max || 16} 字（少于 8 字会被判越界）。
understanding_reply：strategy/video 时必须 ${limits.understanding_reply_min || 18}-${limits.understanding_reply_max || 45} 字（少于 18 字会被判越界）；smalltalk 时为空字符串。
branch_wait_reply：strategy/video 时必须 ${limits.branch_wait_reply_min || 16}-${limits.branch_wait_reply_max || 36} 字（少于 16 字会被判越界）；smalltalk 时为空字符串。
main_summary：smalltalk 时 10-${limits.main_summary_max || 120} 字，直接给轻量观点或安慰；strategy/video 时为空字符串。
字数硬约束（重要）：以上字数区间由 RTC 链路 TTS 节奏决定，少于下限会被判失败。请在生成时主动数字数补足，不要写"加油""好的"这种不够字的短回复。

输出 Schema：
{
  "intent": "smalltalk|strategy|video",
  "speech_delta": ["第一段可播短句", "第二段可播短句"],
  "emotional_reply": "可播开场",
  "understanding_reply": "strategy/video 对需求的理解；smalltalk 为空",
  "branch_wait_reply": "strategy/video 等候语；smalltalk 为空",
  "main_summary": "smalltalk 的轻量回复；strategy/video 为空",
  "strategy_query": "strategy 查询词，否则 null",
  "video_query_seed": "video 搜索词，否则 null",
  "route_reason": "简短路由原因"
}`;
}

function buildInteractionUserPrompt(context = {}) {
  const profile = context.userProfile || {};
  const game = profile.game_profile || {};
  return JSON.stringify({
    task_id: context.taskId || '',
    user_query: context.userQuery || '',
    source: context.source || 'unknown',
    proactive_check: context.proactiveCheck === true,
    rag_summary: context.rag?.summary || '暂无知识库结果',
    short_memory: context.shortMemory?.summary || '暂无短期记忆',
    long_term_memory: summarizeMemory(context.longTermMemory),
    dynamic_context: context.dynamicSummary || '暂无屏幕/图文上下文',
    user_profile: {
      rank_tier: game.rank_tier || '未知',
      rank_division: game.rank_division || '',
      preferred_roles: game.preferred_roles || [],
      frequent_champions: game.frequent_champions || [],
      play_style: game.play_style || '未知',
    },
  });
}

function normalizeInteractionOutput(parsed = {}, context = {}) {
  const userQuery = context.userQuery || '';

  // silence 旁路：proactive_check=true 时不走 trimMainAgentOutput 兜底文案，直接尊重 LLM 的克制输出
  if (context.proactiveCheck === true) {
    return buildSilenceGuardOutput(context, cleanText(parsed.route_reason || 'silence:proactive_check')) || buildSilenceGuardOutput({ ...context, proactiveCheck: true });
  }

  const fallbackIntent = localRouteIntent(userQuery);
  let intent = ['smalltalk', 'strategy', 'video'].includes(parsed.intent) ? parsed.intent : fallbackIntent;
  if (fallbackIntent === 'video' && intent !== 'video') intent = 'video';
  if (fallbackIntent === 'strategy' && intent === 'smalltalk') intent = 'strategy';

  const needsImage = intent === 'strategy' && shouldGenerateStrategyImage(userQuery);
  const videoSeed = intent === 'video'
    ? resolveVideoSearchSeed(context, parsed.video_query_seed)
    : null;
  const snippet = extractKeywordSnippet(userQuery);
  const videoSeedForReply = String(videoSeed || '匹配视频').slice(0, 20);
  const strategyHasVideoCue = intent === 'strategy' && /(视频|集锦|高光|教学|示范|演示|教程)/.test(userQuery);

  const output = trimMainAgentOutput({
    task_id: context.taskId || '',
    fsm_state: 'MAIN_REPLIED',
    intent,
    popup_mode: intent === 'video' ? 'video_search' : intent === 'strategy' ? (needsImage ? 'strategy_card' : 'strategy_text') : 'chat_reply',
    strategy_output_mode: intent === 'strategy' ? (needsImage ? 'card_with_image' : 'text_only') : 'none',
    needs_image: needsImage,
    image_query: needsImage ? userQuery : null,
    speakable: true,
    emotional_reply: intent === 'video' ? '我先找匹配视频。' : (intent === 'strategy' ? '先看关键处理点。' : cleanText(parsed.emotional_reply || '我懂你意思。')),
    understanding_reply: intent === 'smalltalk' ? '' : (intent === 'video' ? `你想看${videoSeedForReply}相关内容，我先帮你检索。` : cleanText(parsed.understanding_reply || `你想处理的是${snippet}这块问题。`)),
    branch_wait_reply: intent === 'smalltalk' ? '' : (intent === 'video' ? '我先检索匹配视频，稍后给你展示结果。' : (strategyHasVideoCue ? '我先拆核心打法，视频任务同步检索中。' : cleanText(parsed.branch_wait_reply || (needsImage ? '我整理成图文卡片后直接弹出。' : '我整理好战术建议后直接弹出。')))),
    main_summary: intent === 'smalltalk'
      ? cleanText(parsed.main_summary || '我先接住这个问题。先别急着给自己下结论，把它拆成一个小目标，会更容易稳住。')
      : '',
    route_reason: cleanText(parsed.route_reason || 'Interaction_Agent 轻量路由').slice(0, 120),
    strategy_query: intent === 'strategy' ? cleanText(parsed.strategy_query || userQuery).slice(0, 120) : null,
    video_query_seed: videoSeed,
    queue_hint: intent === 'strategy' || intent === 'video' ? '后台任务静默执行' : '',
    tts_priority: 'high',
  });
  return {
    ...output,
    speech_delta: normalizeSpeechDeltas(parsed.speech_delta, output),
  };
}

export function buildInteractionSpeech(output = {}) {
  if (Array.isArray(output.speech_delta) && output.speech_delta.length > 0) {
    return cleanText(output.speech_delta.join(' '));
  }
  if (output.intent === 'strategy' || output.intent === 'video') {
    return cleanText([output.emotional_reply, output.understanding_reply, output.branch_wait_reply].filter(Boolean).join(' '));
  }
  return cleanText([output.emotional_reply, output.main_summary].filter(Boolean).join(' '));
}

function buildSpeechDeltas(output = {}) {
  if (output.intent === 'strategy' || output.intent === 'video') {
    return [output.emotional_reply, output.understanding_reply, output.branch_wait_reply]
      .map((item) => cleanText(item))
      .filter(Boolean);
  }
  return [output.emotional_reply, output.main_summary]
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function normalizeSpeechDeltas(value, output = {}) {
  const deltas = Array.isArray(value)
    ? value.map((item) => cleanText(item)).filter(Boolean)
    : [];
  return deltas.length > 0 ? deltas : buildSpeechDeltas(output);
}

export async function runInteractionAgent(context = {}, options = {}) {
  const silenceGuard = buildSilenceGuardOutput(context);
  if (silenceGuard) {
    for (const item of silenceGuard.speech_delta) {
      await options.onSpeechDelta?.({ index: 1, text: item });
    }
    return {
      ...silenceGuard,
      speech_streamed: silenceGuard.speech_delta.length > 0,
      raw: null,
      degraded: false,
    };
  }

  const profileBundle = getAgentProfileBundle({
    userId: context.userId || context.sessionId || 'default',
    personaId: context.personaId || 'main-agent',
  });
  const systemPrompt = buildInteractionSystemPrompt({
    persona: profileBundle.persona,
    userProfile: context.userProfile || profileBundle.userProfile,
    preferences: profileBundle.preferences,
  });
  const userPrompt = buildInteractionUserPrompt({
    ...context,
    userProfile: context.userProfile || profileBundle.userProfile,
    longTermMemory: context.longTermMemory || profileBundle.longTermMemory,
  });
  const prefs = profileBundle.preferences?.llm?.interaction_agent || {};
  let emittedSpeechDeltaCount = 0;
  const emitSpeechDelta = async (text = '') => {
    const clean = cleanText(text);
    if (!clean) return;
    emittedSpeechDeltaCount += 1;
    await options.onSpeechDelta?.({
      index: emittedSpeechDeltaCount,
      text: clean,
    });
  };

  try {
    const result = await callArkChatStream({
      systemPrompt,
      userPrompt,
      temperature: prefs.temperature ?? 0.2,
      maxTokens: prefs.max_tokens ?? 260,
      onDelta: async (_delta, fullContent) => {
        const nextDeltas = extractSpeechDeltasFromPartialJson(fullContent, emittedSpeechDeltaCount);
        for (const item of nextDeltas) {
          await emitSpeechDelta(item);
        }
      },
    });
    const parsed = extractJsonObject(result.content);
    const output = normalizeInteractionOutput(parsed, context);
    // 路由强校正：只有当 LLM 误判为 video 但实际不含明确 video 意图词时，才纠正为 strategy
    // 如果 userQuery 含"视频/示范/教程/链接"等明确 video 信号，保留 video 主意图（连招视频 → video）
    // 注意："连招" 在 STRATEGY_SIGNAL_REGEX 中，但"连招视频/连招示范" 应视为 video 意图的修饰词
    const userQuery = context.userQuery || '';
    const hasVideoSignal = /(视频|示范|教程|链接|演示|教学|高光|集锦)/.test(userQuery);
    if (output.intent === 'video' && hasStrategySignalWord(userQuery) && !hasVideoSignal) {
      const originalIntent = output.intent;
      output.intent = 'strategy';
      output.route_reason = `${output.route_reason || ''} | postcorrect:${originalIntent}->strategy(纯战术词误判)`.trim();
    }
    if (emittedSpeechDeltaCount === 0) {
      for (const item of output.speech_delta) {
        await emitSpeechDelta(item);
      }
    }
    return {
      ...output,
      speech_streamed: emittedSpeechDeltaCount > 0,
      raw: result.content,
    };
  } catch (error) {
    const fallback = fallbackForIntent(context, `Interaction_Agent 兜底: ${error.message}`);
    if (emittedSpeechDeltaCount === 0) {
      for (const item of fallback.speech_delta) {
        await emitSpeechDelta(item);
      }
    }
    return {
      ...fallback,
      speech_streamed: emittedSpeechDeltaCount > 0,
      raw: null,
      degraded: true,
      degraded_reason: error.message,
    };
  }
}
