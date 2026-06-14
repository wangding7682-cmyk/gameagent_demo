import { callArkChat, extractJsonObject } from './arkChatService.js';
import { getAgentProfileBundle } from './agentProfileLoaderService.js';
import { trimMainAgentOutput } from './outputTrimmerService.js';

export function localRouteFallback(userQuery = '') {
  const text = String(userQuery || '').toLowerCase();
  const videoKeywords = ['视频', '看一下', '给我看', '给我找一个', '集锦', '高光', '操作秀', '操作集锦', '极限操作', '花式', '抖音', '精彩', '精彩视频', '精彩操作', '骚操作', '甩旋风', '回旋踢', '名场面', '神仙操作', '想看', '给我找'];
  if (videoKeywords.some((kw) => text.includes(kw))) {
    return 'video';
  }
  if (isExplicitStrategyAsk(text)) {
    return 'strategy';
  }
  return 'smalltalk';
}

// 收紧后的战术词：去掉「思路/节奏/卡片」等单字易误判项
const STRATEGY_STRONG_KEYWORDS = ['怎么打', '打法', '怎么处理', '克制', '对线', '出装', '战术', '阵容', '入侵', '防守', '连招', '攻略', '资源交换', '兵线处理'];
const STRATEGY_TOPIC_KEYWORDS = ['英雄', '中单', '上单', '打野', '辅助', '射手', 'adc', 'ad', '装备', '技能', '兵线', '大龙', '先锋', '小龙', '峡谷'];
const STRATEGY_ACTION_KEYWORDS = ['怎么', '如何', '应该', '该不该', '推荐', '帮我', '给我', '教我', '建议'];
const STRATEGY_CARD_KEYWORDS = ['知识卡片', '知识卡', '战术卡片', '战术卡', '图文', '配图', '生成图', '画一张', '出一张', '做成图', '做成卡'];

function isExplicitStrategyAsk(text = '') {
  const lower = String(text || '').toLowerCase();
  if (STRATEGY_CARD_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) return true;
  if (STRATEGY_STRONG_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) return true;
  const hasTopic = STRATEGY_TOPIC_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  const hasAction = STRATEGY_ACTION_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  return hasTopic && hasAction;
}

function stripNoise(text = '') {
  return String(text)
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildVideoSearchSeed(userQuery = '') {
  const text = String(userQuery || '')
    .replace(/[，。！？!?、]/g, ' ')
    .replace(/给我|帮我|你|那个|一个|的视频|视频|链接|吧|好吧|可以|看看|看一下/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/亚索/.test(text) && /骚操作|极限|精彩|集锦|操作/.test(text)) {
    return '亚索极限操作集锦';
  }
  if (text) {
    return /集锦|高光|精彩|操作/.test(text) ? text : `${text}精彩操作集锦`;
  }
  return '精彩操作集锦';
}

function shouldGenerateStrategyImage(userQuery = '') {
  const text = String(userQuery || '').toLowerCase();
  return ['知识卡片', '知识卡', '战术卡片', '战术卡', '卡片', '图片', '生图', '画一张', '出一张', '生成图', '配图', '做成图', '做成卡']
    .some((kw) => text.includes(kw));
}

const VIDEO_PHRASE_POOL = {
  emotional: [
    '好嘞，我这就去找。',
    '收到，马上帮你扒。',
    '稍等，立刻给你找来。',
    '好的，我去翻视频。',
    '没问题，立马安排。',
  ],
  understanding: [
    (seed) => `你想看的是${seed}相关的视频，我来帮你挑一条好的。`,
    (seed) => `OK，关键词锁定在${seed}，我从多个平台找。`,
    (seed) => `理解了，要找${seed}方向的实战或集锦。`,
    (seed) => `懂了，你想要${seed}的演示或教学，我去搜。`,
  ],
  branchWait: [
    '正在检索可播放视频，找到就弹给你。',
    '已经在多平台搜，挑到合适的会马上推。',
    '稍等十几秒，我把能直接播放的链接捞出来。',
    '正在筛选可直接播放的视频，马上推送。',
  ],
  mainSummary: [
    (seed) => `正在为你搜索[${seed}]的精彩视频。`,
    (seed) => `我从B站、抖音和通用源同时找[${seed}]，挑能直接播放的优先。`,
    (seed) => `已经在抓[${seed}]的实战或高光，找到一条就立刻弹出。`,
    (seed) => `先把[${seed}]的可播放链接搜出来，然后弹给你看。`,
  ],
};

function pickRandom(list = []) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list[Math.floor(Math.random() * list.length)];
}

function pickVideoPhrases(seed = '相关') {
  const safeSeed = String(seed || '相关').trim() || '相关';
  const understanding = pickRandom(VIDEO_PHRASE_POOL.understanding);
  const mainSummary = pickRandom(VIDEO_PHRASE_POOL.mainSummary);
  return {
    emotional: pickRandom(VIDEO_PHRASE_POOL.emotional),
    understanding: typeof understanding === 'function' ? understanding(safeSeed) : String(understanding),
    branchWait: pickRandom(VIDEO_PHRASE_POOL.branchWait),
    mainSummary: typeof mainSummary === 'function' ? mainSummary(safeSeed) : String(mainSummary),
  };
}

const STRATEGY_PHRASE_POOL = {
  emotional: [
    '别急，我帮你拆这局。',
    '稳住，我先帮你理思路。',
    '收到，我来盘一下打法。',
    '懂，我立刻给你拆解。',
  ],
  understanding: [
    (snippet) => `你想了解的是${snippet}相关的打法思路。`,
    (snippet) => `OK，我抓住关键点了：${snippet}。`,
    (snippet) => `懂了，重点是${snippet}这块怎么处理。`,
    (snippet) => `理解你的意思，${snippet}这一手要拆细。`,
  ],
  branchWaitText: [
    '我来整理一份文字战术建议。',
    '稍等，我把这局思路给你串成一段。',
    '马上整理可执行的战术要点给你。',
    '正在帮你梳理打法节奏，几秒就好。',
  ],
  branchWaitCard: [
    '稍等，我整理成图文战术卡片给你看。',
    '正在做成图文战术卡片，马上推给你。',
    '稍等十几秒，我把战术配图整理给你。',
    '我把要点画成战术卡片，立刻发你。',
  ],
  mainSummaryFallback: [
    '我会结合当前问题给你一个简洁、可执行的建议。',
    '马上给你一份直接能用的战术结论。',
    '稍等，给你一份贴合你打法的简短建议。',
  ],
};

const SMALLTALK_FAST_PHRASE_POOL = {
  emotional: [
    '我在呢。',
    '听得到，我在。',
    '来啦，我在这。',
    '嗯嗯，我在。',
  ],
  summary: [
    '你直接说就行，我会先帮你判断要聊天、看视频，还是整理战术。',
    '我在这边听着，你把问题说出来，我马上接住。',
    '收到，我会尽量用短句先回应，再把复杂内容慢慢补齐。',
    '可以的，我在线。你想聊两句，还是要我帮你查游戏内容？',
  ],
};

function extractKeywordSnippet(userQuery = '') {
  const text = String(userQuery || '').trim();
  const stopWords = ['帮我','给我','我想','请问','能不能','可以','做一张','做一份','整理','生成','来个','一下','一张','一份','知识卡片','知识卡','战术卡片','战术卡','卡片','图片','的','了','吗','呢','啊','哈'];
  let cleaned = text;
  for (const w of stopWords) {
    cleaned = cleaned.replace(new RegExp(w, 'g'), '');
  }
  cleaned = cleaned.replace(/\s+/g, '').slice(0, 12);
  return cleaned || text.slice(0, 8);
}

function pickStrategyPhrases(userQuery = '', { needsImage = false } = {}) {
  const snippet = extractKeywordSnippet(userQuery);
  const understanding = pickRandom(STRATEGY_PHRASE_POOL.understanding);
  return {
    emotional: pickRandom(STRATEGY_PHRASE_POOL.emotional),
    understanding: typeof understanding === 'function' ? understanding(snippet) : String(understanding),
    branchWait: needsImage
      ? pickRandom(STRATEGY_PHRASE_POOL.branchWaitCard)
      : pickRandom(STRATEGY_PHRASE_POOL.branchWaitText),
    mainSummaryFallback: pickRandom(STRATEGY_PHRASE_POOL.mainSummaryFallback),
  };
}

function isObviousSmalltalk(userQuery = '', context = {}) {
  const text = String(userQuery || '')
    .replace(/[，。！？、,.!?~～\s]/g, '')
    .toLowerCase();
  if (!text) return false;
  if (context.source === 'pet_tap' && text.length <= 12) return true;
  if (/^(你好|您好|哈喽|hello|hi|在吗|在不在|听得到吗|能听到吗|听得见吗|喂|早上好|晚上好|下午好)$/.test(text)) {
    return true;
  }
  if (/^(戳一下|摸摸|点一下|碰一下|叫你一下|测试一下|语音测试|说句话)$/.test(text)) {
    return true;
  }
  return false;
}

function hasExplicitVideoIntent(userQuery = '') {
  const text = String(userQuery || '');
  return /视频|集锦|高光|操作秀|操作集锦|精彩操作|抖音|B站|b站|教学录像|实战录像|名场面|神仙操作/.test(text)
    || /(找|搜|检索|推荐|想看|看看|看一下).{0,12}(视频|集锦|高光|录像|演示)/.test(text);
}

function hasExplicitStrategyIntent(userQuery = '') {
  const text = String(userQuery || '');
  if (hasExplicitVideoIntent(text)) return false;
  return isExplicitStrategyAsk(text);
}

function normalizeMainOutput(parsed = {}, context = {}, forcedIntent = null) {
  const userQuery = context.userQuery || '';
  let intent = ['smalltalk', 'strategy', 'video'].includes(parsed.intent)
    ? parsed.intent
    : localRouteFallback(userQuery);
  if (forcedIntent && forcedIntent !== intent) {
    intent = forcedIntent;
  }

  const text = String(userQuery || '').toLowerCase();
  // 二级判定：当 LLM 输出 smalltalk 时，仅在用户「明确求助 + 战术主题」或「明确卡片需求」时才纠正为 strategy
  if (intent === 'smalltalk' && isExplicitStrategyAsk(text)) {
    intent = 'strategy';
  }
  const videoQuerySeed = parsed.video_query_seed
    ? String(parsed.video_query_seed).slice(0, 120)
    : (intent === 'video' ? buildVideoSearchSeed(userQuery).slice(0, 120) : null);
  const needsImage = intent === 'strategy' && (parsed.needs_image === true || shouldGenerateStrategyImage(userQuery));
  const strategyOutputMode = intent === 'strategy'
    ? (needsImage ? 'card_with_image' : 'text_only')
    : 'none';
  const popupMode = intent === 'video'
    ? 'video_search'
    : intent === 'strategy'
      ? (needsImage ? 'strategy_card' : 'strategy_text')
      : 'chat_reply';

  const videoPhrases = intent === 'video' ? pickVideoPhrases(videoQuerySeed || '相关') : null;
  const strategyPhrases = intent === 'strategy' ? pickStrategyPhrases(userQuery, { needsImage }) : null;

  return trimMainAgentOutput({
    task_id: context.taskId || parsed.task_id || '',
    fsm_state: parsed.fsm_state || 'MAIN_REPLIED',
    intent,
    popup_mode: popupMode,
    strategy_output_mode: strategyOutputMode,
    needs_image: needsImage,
    image_query: needsImage ? (parsed.image_query || parsed.image_prompt_text || userQuery) : null,
    speakable: parsed.speakable !== false,
    emotional_reply: intent === 'video'
      ? videoPhrases.emotional
      : stripNoise(String(
        parsed.emotional_reply ||
        (intent === 'strategy' ? strategyPhrases.emotional : '收到，我先帮你判断一下。')
      )).slice(0, 40),
    understanding_reply: intent === 'video'
      ? videoPhrases.understanding
      : stripNoise(String(
        parsed.understanding_reply ||
        (intent === 'strategy'
          ? strategyPhrases.understanding
          : '我会结合知识库给你轻量回复。')
      )),
    branch_wait_reply: intent === 'video'
      ? videoPhrases.branchWait
      : stripNoise(String(
        parsed.branch_wait_reply ||
        (intent === 'strategy' ? strategyPhrases.branchWait : '')
      )),
    main_summary: intent === 'video'
      ? videoPhrases.mainSummary.slice(0, 180)
      : stripNoise(String(
        parsed.main_summary ||
        parsed.summary ||
        (intent === 'strategy' ? strategyPhrases.mainSummaryFallback : '我会结合当前上下文给你一个简洁建议。')
      )).slice(0, 180),
    route_reason: String(parsed.route_reason || '').slice(0, 120),
    strategy_query: parsed.strategy_query ? String(parsed.strategy_query).slice(0, 120) : null,
    video_query_seed: videoQuerySeed,
    queue_hint: intent === 'strategy' || intent === 'video' ? '任务已创建，等待异步执行' : '',
    tts_priority: parsed.tts_priority || 'normal',
  });
}

function buildSmalltalkFastOutput(context = {}, reason = 'smalltalk fast path') {
  return trimMainAgentOutput({
    task_id: context.taskId || '',
    fsm_state: 'MAIN_REPLIED',
    intent: 'smalltalk',
    popup_mode: 'chat_reply',
    strategy_output_mode: 'none',
    needs_image: false,
    image_query: null,
    speakable: true,
    emotional_reply: pickRandom(SMALLTALK_FAST_PHRASE_POOL.emotional),
    understanding_reply: '',
    branch_wait_reply: '',
    main_summary: pickRandom(SMALLTALK_FAST_PHRASE_POOL.summary),
    route_reason: reason,
    strategy_query: null,
    video_query_seed: null,
    queue_hint: '',
    tts_priority: 'high',
    raw: null,
  });
}

export function detectLocalFirstRoute(context = {}) {
  const userQuery = context.userQuery || '';
  if (isObviousSmalltalk(userQuery, context)) {
    return {
      mode: 'smalltalk_fast',
      intent: 'smalltalk',
      confidence: 0.98,
      reason: '命中本地明确闲聊/触摸/连通性快路径',
    };
  }

  if (hasExplicitVideoIntent(userQuery)) {
    return {
      mode: 'preview',
      intent: 'video',
      confidence: 0.86,
      reason: '命中本地明确 video 关键词，先发首句预览',
    };
  }

  if (hasExplicitStrategyIntent(userQuery)) {
    return {
      mode: 'preview',
      intent: 'strategy',
      confidence: 0.86,
      reason: '命中本地明确 strategy 关键词，先发首句预览',
    };
  }

  return {
    mode: 'llm',
    intent: 'smalltalk',
    confidence: 0.45,
    reason: '未命中明确快路径，等待 Main_Agent；超时后使用本地兜底',
  };
}

export function buildLocalFirstMainOutput(context = {}, options = {}) {
  const intent = options.intent || localRouteFallback(context.userQuery);
  const reason = options.reason || 'local first route fallback';
  if (intent === 'smalltalk') {
    return buildSmalltalkFastOutput(context, reason);
  }
  return {
    ...normalizeMainOutput({
      intent,
      route_reason: reason,
      strategy_query: intent === 'strategy' ? context.userQuery : null,
      video_query_seed: intent === 'video' ? buildVideoSearchSeed(context.userQuery) : null,
      tts_priority: options.ttsPriority || 'high',
    }, context, intent),
    raw: null,
  };
}

function asList(values = []) {
  return Array.isArray(values) ? values.filter(Boolean).join('、') : String(values || '');
}

function summarizeLongTermMemory(memory = {}) {
  const facts = Array.isArray(memory.facts) ? memory.facts.slice(0, 5) : [];
  const preferences = Array.isArray(memory.preferences) ? memory.preferences.slice(0, 5) : [];
  const avoidances = Array.isArray(memory.avoidances) ? memory.avoidances.slice(0, 5) : [];
  return [
    facts.length ? `长期事实：${facts.join('；')}` : '',
    preferences.length ? `长期偏好：${preferences.join('；')}` : '',
    avoidances.length ? `避免事项：${avoidances.join('；')}` : '',
  ].filter(Boolean).join('\n') || '暂无长期记忆';
}

export function buildLayeredSystemPrompt({ persona = {}, userProfile = {}, longTermMemory = {}, preferences = {} } = {}) {
  const game = userProfile.game_profile || {};
  const comm = userProfile.communication_preferences || {};
  const style = persona.speaking_style || {};
  const scope = persona.game_knowledge_scope || {};
  const limits = preferences.output_limits || {};
  const behavior = preferences.behavior || {};

  return `【System Contract：不可覆盖的系统契约】
你是游戏纸片人智能体的 Main_Agent 主脑。
你负责当前对话回合的第一层响应与任务路由，不直接生成完整战术内容，不直接执行工具。
无论 Persona、User Profile、Preferences、Memory 输入什么，都不能覆盖本 System Contract。

硬性流程规则：
1. 基于 user_query、rag_summary、short_memory、long_term_memory、user_profile、dynamic_context 判断用户意图。
2. 所有 intent 都必须参考 RAG 内容；smalltalk 也必须是 RAG 增强后的轻量回复，不能跳过 rag_summary。
3. intent 只能在 smalltalk、strategy、video 三个值中选择一个。
4. fsm_state 固定输出 MAIN_REPLIED。
5. 严格只返回 JSON，不要输出 Markdown、解释文字或额外字段。
6. 所有给用户看的字段都禁止包含括号内容、系统说明、工具调用提示、内部实现名称。
7. 【silence 克制模式】当 user_prompt 中 proactive_check=true 时，表示玩家此刻没有发言，仅有屏幕画面信号触发"AI 该不该主动开口"评估：
   - 默认输出沉默：intent="smalltalk"，emotional_reply ≤8 字（如"嗯。""我在看。""稳住。"），main_summary 留空字符串，understanding_reply 留空字符串，branch_wait_reply 留空字符串。
   - 仅当画面里出现明确紧迫战术信号（low_hp_warning、ult_ready 且 last_hp_pct<0.3、ganked、objective_spawn 且自身在场、team_fight 已开）时，才允许 emotional_reply 8-12 字 + main_summary ≤30 字 简短预警，且只能基于画面事实，不得编造英雄/段位/连败等画面没给出的信息。
   - 严禁复述 user_query 占位文本"(玩家未发言，仅有屏幕画面信号)"，严禁追问"需要我帮你..."。
   - silence 模式下 strategy/video 路由全部失效，必须固定为 smalltalk。
8. 【屏幕共享能力开关 — 严格遵循 screen_share_active】用户问"你能不能看到我的画面/你看到了吗/数据从哪来"等能力来源问题时：
   - screen_share_active=true：可以承认看到画面，但只能复述 dynamic_context 中确实存在的画面要素，例："我在看你共享的画面"。
   - screen_share_active=false：必须明确说看不到画面，例："我现在看不到你的游戏画面，主要根据你说的话和上下文判断。"
   - 即使 dynamic_context 里有历史画面摘要，只要 screen_share_active=false 也不得声称"现在看到"，最多说"上次看到的画面是…"。
   - 严禁在 screen_share_active=false 时编造任何当前画面观察。

路由规则（优先级从高到低，高优先规则命中后不再进入下层）：

【意图区分核心原则：轻量建议 vs 复杂策略】
- 轻量建议（走 smalltalk）：针对具体的小情境追问、是非判断（如“那这波该打吗？”、“3级要去抓吗？”），不要求系统性长篇大论，仅需你在聊天流内给出 1-2 句口语化的简短回应。
- 复杂策略（走 strategy）：针对系统性的知识查询（如“盲僧怎么打野”、“亚索怎么对线劫”、“出什么装备”），或用户明确要求“知识卡片”、“战术总结”时，后台子系统会生成长篇的文字报告或图文卡片。

【第一优先：smalltalk 拦截层 — 以下模式必须选 smalltalk，即使问题中包含战术词汇】
1. 观点确认/寻求验证类：问题包含"真的…吗""是不是""有没有效""好不好""值不值得""该不该""能不能""可不可以""需要...吗""要不要"等是非疑问词，且用户核心意图是寻求观点确认、简单情境的是非判断或情绪价值，而非索要长篇操作步骤。例："只玩一个英雄上分有效吗？""专精一个位置更好吗？""3级的时候盲僧需要去拿人头吗？""这波要不要打？"
2. 自我怀疑/情绪宣泄类：问题包含"是不是我太菜了""为什么总是""我是不是不适合""我是不是不配""感觉""心态""烦""气"等自我否定或强情绪词。例："连跪5把是不是我太菜了？""为什么我总是被对面打野抓？""这游戏越来越没意思了"
3. 玩法哲学/宏观选择类：问题关于整体策略方向、长期选择、段位/定位讨论、比较优劣的开放式话题，而非具体的"怎么做某件事"。例："玩什么位置好上分？""应该主玩AD还是中单？""单排和双排哪个效率更高？""这个版本什么最强？"
4. 纯陪伴/复盘情绪/闲聊/吐槽/求助安慰。
5. 简单战术追问：用户在连续对话中发出的短句、具体情境下的是非判断（如“那打野要不要去帮下路？”、“3级要去抓吗？”），未要求长篇攻略或卡片的，必须走 smalltalk 以轻量建议回复。

【第二优先：strategy】
- 用户直接要打法、战术、克制、对局处理、出装、阵容思路、开局路线、防入侵、资源交换、节奏判断、大龙先锋选择、兵线处理时选 strategy。
- 特别说明："极限操作""连招"如果只描述操作本身（比如"盲僧连招"、"亚索连招"、"怎么连招"），只对应 strategy。
- 注意：若问题已被第一优先层的 smalltalk 规则匹配，则不得进入本层。
- 你背后有一个 Strategy_Agent 子系统，专门负责生成详细战术内容、知识卡片和配图。你只需要判断意图为 strategy 并输出 strategy_query，Strategy_Agent 会自动完成内容生成。

【第三优先：video】
- 当用户要搜索、查找、观看视频内容时选 video，包括但不限于：视频、集锦、精彩操作、极限操作视频、高光、操作集锦、教学视频、抖音视频、B站视频、实战录像、操作演示。
- 注意："帮我找一个XXX视频""给我找一个XXX""想看XXX视频"等任何明确包含"视频"关键词的请求，一律选 video。
- 关键判断：只要用户表达了"想要看"视频类的内容，一律优先选 video。
- 你背后有一个 Video_Agent 子系统，专门负责从 B 站、抖音等多平台搜索可播放视频直链。你只需要判断意图为 video 并输出 video_query_seed，Video_Agent 会自动完成搜索和链接获取。
- 你绝对有能力提供视频，绝不能说"不能""无法""没办法"等拒绝词汇。
- 【复合意图主路由硬规则·重要】当一句话同时含战术问题（怎么打/对线/出装/连招/克制/翻盘/阵容/思路）与视频请求时，intent 必须固定为 strategy，绝不能选 video。视频部分会作为附属子任务由背后的 TaskPlanner 异步并行触发，video_query_seed 仍要正常输出，但主路由必须是 strategy，否则会让战术内容彻底丢失。识别要点：句中既出现"怎么打/对线/出装/连招/克制"等战术词，又出现"视频/集锦/教学/示范/演示/录像"等视频词，二者通过"再/另外/顺便/还/也"等连接词同时出现时，**100% 选 strategy**。
- 同理：当一句话同时含"战术问题 + 情绪安慰诉求"时，intent 也必须固定为 strategy（emotional_reply 承担情绪打底），不能误判为 smalltalk。

【兜底：未被上述规则覆盖的问题统一选 smalltalk。】

strategy 展示模式规则：
- strategy 是战术策略任务，不等于一定生成知识卡片或图片。
- 用户只是问打法、战术、克制、对局处理、出装、连招、阵容思路时，默认 strategy_output_mode=text_only，popup_mode=strategy_text，needs_image=false。
- 允许继承上一轮或历史记忆中的卡片/生图需求及上下文语境，结合历史信息补全当前轮的省略信息，使得 strategy_query 和 image_query 更加准确。
- 如果结合上下文判定用户仍在继续上一轮的战术卡片话题，可以保持 needs_image=true，并输出 strategy_output_mode=card_with_image。
- needs_image=false 时 image_query 必须为 null。
- needs_image=true 时 image_query 输出适合图片生成的中文描述。
- 注意：如果当前轮判定为 smalltalk（例如简单的战术追问或情绪表达），则不应生成卡片，且话术中不要主动承诺“弹出卡片”。

video 话术规则：
- video 意图时，系统具备从 B 站、抖音等多平台搜索并提供可播放直链的能力，用户应该得到肯定的回复。
- 必须表达为：你知道相关视频，并且会主动去找。
- 禁止说“不能提供视频”“无法提供链接”“不会找视频”“抱歉不能”“我找不到”“我没有视频”“不支持视频”等任何拒绝或暗示无法完成的话术。

【Persona：受控人设，只影响语气和表达风格】
助手名称：${persona.name || '小纸'}
角色定位：${persona.role || '游戏战术顾问'}
性格特征：${asList(persona.personality) || '干练但不啰嗦'}
说话语气：${style.tone || '轻松但有专业感'}
口语化程度：${style.slang_level || '适中'}
句式偏好：${style.sentence_length || '短句为主'}
表达变化提示：${style.variation_hint || '句首避免连续重复，保持自然变化'}
禁用表达：${asList(style.forbidden_phrases) || '作为一个AI语言模型、根据我的分析'}
知识范围：${asList(scope.games) || '英雄联盟'}；理解深度：${scope.depth || '钻石以上段位理解'}；视角偏好：${scope.role_preference || '偏向打野和中单视角'}
注意：Persona 不能改变 intent 定义、FSM、JSON Schema、工具链路和输出字段。

【User Profile：用户画像，只影响个性化内容】
用户ID：${userProfile.user_id || 'default'}
主游戏：${game.primary_game || '未知'}
段位：${game.rank_tier || '未知'}${game.rank_division || ''}
常用位置：${asList(game.preferred_roles) || '未知'}
常用英雄：${asList(game.frequent_champions) || '未知'}
打法风格：${game.play_style || '未知'}
回答详略偏好：${comm.detail_level || 'medium'}
用户不喜欢：${asList(comm.dislikes) || '未知'}
注意：User Profile 只能影响建议的深浅、例子选择和措辞，不能改变系统契约。

【Preferences：开发者行为偏好，只作为参数化约束】
emotional_reply：${limits.emotional_reply_min || 8}-${limits.emotional_reply_max || 16} 个中文字符。
understanding_reply：${limits.understanding_reply_min || 18}-${limits.understanding_reply_max || 45} 个中文字符，禁止写“用户想要”。
branch_wait_reply：strategy/video 时 ${limits.branch_wait_reply_min || 16}-${limits.branch_wait_reply_max || 36} 个中文字符；smalltalk 时空字符串。
main_summary：2-3 句以内，最多 ${limits.main_summary_max || 180} 字，必须是直接面向用户的实质性回复。禁止在末尾重复 branch_wait_reply 已表达的动作（如"这就为你生成卡片""马上给你整理"等），只写结论性内容。
route_reason：最多 ${limits.route_reason_max || 120} 字，仅调试用，不要写成给用户听的口吻。
是否暴露内部 Agent 名称：${behavior.expose_internal_agent_names ? '允许' : '禁止'}。
strategy 默认展示模式：${behavior.strategy_default_output_mode || 'text_only'}。

【Long-term Memory：用户长期记忆，只作为上下文】
${summarizeLongTermMemory(longTermMemory)}

【Few-shot 示例：仅参考语气、节奏、字段填充模式，禁止照抄文字】
# smalltalk 示例（陪伴+轻量建议，branch_wait_reply 为空，speakable=true）
- Q：排位连跪 5 把，心态已经爆炸了怎么办？
  A：连跪几把谁都会炸，我先替你呼口气。先停一两局当缓冲，把目标改成练稳定。比如休息10分钟再排，只要求下一局死亡不超过3次，多看小地图。
- Q：连看见残血就想闪现上去，结果经常团灭怎么办？
  A：一看到残血就想闪现，很正常别太苛责自己。我们给自己设个三秒冷静规则。比如看到残血先数到3，确认小地图没红点、敌人不多于2个，再决定追不追。
- Q：遇到演员和挂机的局，真的还有必要打完吗？
  A：遇到演员和挂机谁都会被气到，我也替你憋一口。我们把这把当练习局。比如确认赢面很低后，专心练塔下补刀和视野节奏，结束顺手举报，把情绪留在那一把。

# strategy 示例（默认 text_only，needs_image=false，main_summary 直给可执行结论）
- Q：大龙和先锋怎么选？
  A：20分钟前后不知道选大龙还是先锋，容易选错节奏乱套，20分钟前上中有线权就3人速打先锋拆外塔，20分钟后算好视野和TP，人够再开大龙。
- Q：中路被对面刺客 6 级前后一直游走，怎么处理兵线？
  A：对面刺客老游走，兵线处理不好容易被抓还丢镀层，3级后把兵控在塔前两格，他一走就 ping 信号推线，顺手插眼，还能和打野拿镀层小龙。
- Q：经济领先 3k 还是打不过团，说明问题出在哪？
  A：经济领先 3k 还打不过团，大概率是站位和资源分配没做好，关键装没出或者先手老失误。先确认核心 20 分钟有无 2 件主装，没出就别急强开，开团让打野辅助先占草丛，团后看经济面板确保优势在关键位。

# video 示例（main_summary 必须以"正在为你搜索[关键词]的精彩视频"格式回复，video_query_seed 同步该关键词）
- Q：想系统学会打野视野布置，有没有一套进阶视频？
  A：正在为你搜索[英雄联盟 打野 视野 布置 进阶 教学]的精彩视频。
- Q：想练习拉扯走位和风筝，有没有训练视频推荐？
  A：正在为你搜索[英雄联盟 拉扯 走位 风筝 训练 教程]的精彩视频。
- Q：给我找一个亚索甩旋风的精彩视频
  A：正在为你搜索[亚索 甩旋风 精彩操作]的精彩视频。
- Q：想看盲僧回旋踢的集锦
  A：正在为你搜索[盲僧 回旋踢 集锦]的精彩视频。

【输出 Schema：必须严格返回】
{
  "task_id": "原样回传输入 task_id",
  "fsm_state": "MAIN_REPLIED",
  "intent": "smalltalk|strategy|video",
  "popup_mode": "chat_reply|strategy_text|strategy_card|video_search",
  "strategy_output_mode": "none|text_only|card_with_image",
  "needs_image": false,
  "image_query": null,
  "speakable": true,
  "emotional_reply": "8-16字即时确认语",
  "understanding_reply": "18-45字用户问题理解陈述",
  "branch_wait_reply": "strategy/video异步等待提示；smalltalk为空字符串",
  "main_summary": "2-3句以内直接面向用户的回复",
  "route_reason": "路由原因，仅用于调试",
  "strategy_query": "strategy时的查询词，否则null",
  "video_query_seed": "video时的视频搜索种子词，否则null",
  "queue_hint": "strategy/video任务提示；smalltalk为空字符串",
  "tts_priority": "high|normal"
}`;
}

export function buildMainUserPrompt(context = {}) {
  const profile = context.userProfile || {};
  const game = profile.game_profile || {};
  const comm = profile.communication_preferences || {};
  const layeredItems = Array.isArray(context.layeredMemory?.items) ? context.layeredMemory.items.slice(0, 4) : [];
  const layeredSummary = layeredItems.length > 0
    ? layeredItems.map((it) => `[${it.layer}|score=${(it.final_score || 0).toFixed(2)}] ${it.content}`).join('\n')
    : '暂无分层记忆命中';
  return JSON.stringify({
    task_id: context.taskId || '',
    user_id: context.userId || profile.user_id || 'default',
    user_query: context.userQuery,
    source: context.source,
    proactive_check: context.proactiveCheck === true,
    rag_summary: context.rag?.summary || '暂无知识库结果',
    short_memory: context.shortMemory?.summary || '暂无短期记忆',
    long_term_memory: summarizeLongTermMemory(context.longTermMemory),
    layered_memory: layeredSummary,
    dynamic_context: context.dynamicSummary || '暂无图文/视频帧上下文',
    screen_share_active: context.screenShareActive === true,
    user_profile: {
      rank_tier: game.rank_tier || '未知',
      rank_division: game.rank_division || '',
      preferred_roles: game.preferred_roles || [],
      frequent_champions: game.frequent_champions || [],
      play_style: game.play_style || '未知',
      detail_preference: comm.detail_level || 'medium',
      dislikes: comm.dislikes || [],
    },
    required_json: {
      task_id: '原样回传输入 task_id',
      fsm_state: '固定 MAIN_REPLIED',
      intent: 'smalltalk|strategy|video',
      popup_mode: 'chat_reply|strategy_text|strategy_card|video_search',
      strategy_output_mode: 'none|text_only|card_with_image',
      needs_image: false,
      image_query: 'needs_image=true时的图片生成描述，否则null',
      speakable: true,
      emotional_reply: '8-16字，可直接TTS',
      understanding_reply: '18-45字，简短说明你理解到的用户需求',
      branch_wait_reply: 'strategy/video时的异步等待提示；smalltalk为空字符串',
      main_summary: '2-3句结论性内容，禁止重复branch_wait_reply的动作',
      route_reason: '路由原因',
      strategy_query: 'strategy时的检索/战术查询词，否则null',
      video_query_seed: 'video时的视频搜索种子词，否则null',
      queue_hint: 'strategy/video任务提示；smalltalk为空字符串',
      tts_priority: 'high|normal',
    },
  });
}

export async function runMainAgent(context) {
  if (context.forceMock && context.source === 'demo_button') {
    const query = String(context.userQuery || '');
    const isVideo = localRouteFallback(query) === 'video';
    const needsImage = !isVideo && shouldGenerateStrategyImage(query);
    const demoVideoSeed = isVideo ? buildVideoSearchSeed(query) : null;
    const demoVideoPhrases = isVideo ? pickVideoPhrases(demoVideoSeed || '相关') : null;
    const demoStrategyPhrases = !isVideo ? pickStrategyPhrases(query, { needsImage }) : null;
    return {
      intent: isVideo ? 'video' : 'strategy',
      task_id: context.taskId || '',
      fsm_state: 'MAIN_REPLIED',
      popup_mode: isVideo ? 'video_search' : needsImage ? 'strategy_card' : 'strategy_text',
      strategy_output_mode: isVideo ? 'none' : needsImage ? 'card_with_image' : 'text_only',
      needs_image: needsImage,
      image_query: needsImage ? query : null,
      speakable: true,
      emotional_reply: isVideo ? demoVideoPhrases.emotional : demoStrategyPhrases.emotional,
      understanding_reply: isVideo ? demoVideoPhrases.understanding : demoStrategyPhrases.understanding,
      branch_wait_reply: isVideo ? demoVideoPhrases.branchWait : demoStrategyPhrases.branchWait,
      main_summary: isVideo ? demoVideoPhrases.mainSummary : demoStrategyPhrases.mainSummaryFallback,
      route_reason: 'demo_button 强制走演示分支',
      strategy_query: isVideo ? null : query,
      video_query_seed: isVideo ? (demoVideoSeed || query) : null,
      queue_hint: '任务已创建，等待异步执行',
      tts_priority: 'normal',
      raw: null,
    };
  }

  const profileBundle = getAgentProfileBundle({
    userId: context.userId || context.sessionId || 'default',
    personaId: context.personaId || 'main-agent',
  });
  const systemPrompt = buildLayeredSystemPrompt({
    persona: profileBundle.persona,
    userProfile: context.userProfile || profileBundle.userProfile,
    longTermMemory: context.longTermMemory || profileBundle.longTermMemory,
    preferences: profileBundle.preferences,
  });
  const userPrompt = buildMainUserPrompt({
    ...context,
    userProfile: context.userProfile || profileBundle.userProfile,
    longTermMemory: context.longTermMemory || profileBundle.longTermMemory,
  });
  const mainLlmPrefs = profileBundle.preferences?.llm?.main_agent || {};

  try {
    const result = await callArkChat({
      systemPrompt,
      userPrompt,
      temperature: mainLlmPrefs.temperature ?? 0.1,
      maxTokens: mainLlmPrefs.max_tokens ?? 700,
    });
    const llmParsed = extractJsonObject(result.content);
    const llmIntent = llmParsed.intent;
    const fallbackIntent = localRouteFallback(context.userQuery);
    const llmIntentValid = ['smalltalk', 'strategy', 'video'].includes(llmIntent);
    const safeIntent = llmIntentValid ? llmIntent : fallbackIntent;
    let finalIntent = safeIntent;
    // 仅在 LLM 返回无效值（降级到 fallback）时才考虑 override；LLM 有效返回时尊重其判断
    if (!llmIntentValid && safeIntent === 'strategy' && fallbackIntent === 'video') {
      finalIntent = 'video';
    }
    if (!llmIntentValid && safeIntent === 'smalltalk' && (fallbackIntent === 'video' || fallbackIntent === 'strategy')) {
      finalIntent = fallbackIntent;
    }
    return {
      ...normalizeMainOutput(llmParsed, context, finalIntent),
      raw: result.content,
    };
  } catch (error) {
    const intent = localRouteFallback(context.userQuery);
    const needsImage = intent === 'strategy' && shouldGenerateStrategyImage(context.userQuery);
    const fallbackVideoSeed = intent === 'video' ? buildVideoSearchSeed(context.userQuery) : null;
    const fallbackVideoPhrases = intent === 'video' ? pickVideoPhrases(fallbackVideoSeed || '相关') : null;
    const fallbackStrategyPhrases = intent === 'strategy' ? pickStrategyPhrases(context.userQuery, { needsImage }) : null;
    return trimMainAgentOutput({
      task_id: context.taskId || '',
      fsm_state: 'MAIN_REPLIED',
      intent,
      popup_mode: intent === 'video' ? 'video_search' : intent === 'strategy' ? (needsImage ? 'strategy_card' : 'strategy_text') : 'chat_reply',
      strategy_output_mode: intent === 'strategy' ? (needsImage ? 'card_with_image' : 'text_only') : 'none',
      needs_image: needsImage,
      image_query: needsImage ? context.userQuery : null,
      speakable: true,
      emotional_reply: intent === 'video'
        ? fallbackVideoPhrases.emotional
        : intent === 'strategy' ? fallbackStrategyPhrases.emotional : '收到，我给你简短建议。',
      understanding_reply: intent === 'video'
        ? fallbackVideoPhrases.understanding
        : intent === 'strategy'
          ? fallbackStrategyPhrases.understanding
          : '我会结合知识库给你轻量回复。',
      branch_wait_reply: intent === 'video'
        ? fallbackVideoPhrases.branchWait
        : intent === 'strategy'
          ? fallbackStrategyPhrases.branchWait
          : '',
      main_summary: intent === 'video'
        ? fallbackVideoPhrases.mainSummary
        : context.rag?.summary
        ? context.rag.summary.split('\n').slice(0, 2).join('。').slice(0, 160)
        : intent === 'strategy'
          ? fallbackStrategyPhrases.mainSummaryFallback
          : '我会结合当前问题给你一个简洁、可执行的建议。',
      route_reason: `Main_Agent 兜底路由: ${error.message}`,
      strategy_query: intent === 'strategy' ? context.userQuery : null,
      video_query_seed: fallbackVideoSeed,
      queue_hint: intent === 'strategy' || intent === 'video' ? '任务已创建，等待异步执行' : '',
      tts_priority: 'normal',
      raw: null,
    });
  }
}
