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

export function localRouteIntent(userQuery = '') {
  const text = String(userQuery || '');
  if (/视频|集锦|高光|操作秀|操作集锦|精彩操作|抖音|B站|b站|教学录像|实战录像|名场面|神仙操作/.test(text)
    || /(找|搜|检索|推荐|想看|看看|看一下).{0,12}(视频|集锦|高光|录像|演示)/.test(text)) {
    return 'video';
  }
  if (/怎么打|打法|怎么处理|克制|对线|出装|战术|思路|阵容|入侵|防守|连招|攻略|大龙|先锋|兵线|节奏|资源交换|知识卡片|知识卡|战术卡片|战术卡|卡片|图文|配图|生成图/.test(text)) {
    return 'strategy';
  }
  return 'smalltalk';
}

export function shouldGenerateStrategyImage(userQuery = '') {
  return ['知识卡片', '知识卡', '战术卡片', '战术卡', '卡片', '图片', '生图', '画一张', '出一张', '生成图', '配图', '做成图', '做成卡']
    .some((kw) => String(userQuery || '').includes(kw));
}

export function buildVideoSearchSeed(userQuery = '') {
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

export function extractKeywordSnippet(userQuery = '') {
  const stopWords = ['帮我', '给我', '我想', '请问', '能不能', '可以', '做一张', '做一份', '整理', '生成', '来个', '一下', '一张', '一份', '知识卡片', '知识卡', '战术卡片', '战术卡', '卡片', '图片', '的', '了', '吗', '呢', '啊'];
  let text = String(userQuery || '').trim();
  for (const word of stopWords) {
    text = text.replace(new RegExp(word, 'g'), '');
  }
  return text.replace(/\s+/g, '').slice(0, 16) || String(userQuery || '').slice(0, 12) || '当前问题';
}

function fallbackForIntent(context = {}, reason = '') {
  const userQuery = context.userQuery || '';
  const intent = localRouteIntent(userQuery);
  const needsImage = intent === 'strategy' && shouldGenerateStrategyImage(userQuery);
  const snippet = extractKeywordSnippet(userQuery);
  const videoSeed = intent === 'video' ? buildVideoSearchSeed(userQuery) : null;

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
      ? '好嘞，我去找。'
      : intent === 'strategy'
        ? '稳住，我帮你拆。'
        : '我懂你意思。',
    understanding_reply: intent === 'video'
      ? `你想看${videoSeed}相关内容，我先帮你检索。`
      : intent === 'strategy'
        ? `你想处理的是${snippet}这块问题。`
        : '',
    branch_wait_reply: intent === 'video'
      ? '找到合适视频后，我直接弹给你。'
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

语气约束：
助手名称：${persona.name || '小纸'}
语气：${style.tone || '轻松但专业'}
句式：${style.sentence_length || '短句为主'}
用户段位：${game.rank_tier || '未知'}${game.rank_division || ''}
emotional_reply：最多 ${limits.emotional_reply_max || 16} 字。
understanding_reply：最多 ${limits.understanding_reply_max || 45} 字。
branch_wait_reply：最多 ${limits.branch_wait_reply_max || 36} 字。
main_summary：最多 ${limits.main_summary_max || 120} 字，直接给轻量观点或安慰，不要展开成长篇攻略。

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
  const fallbackIntent = localRouteIntent(userQuery);
  let intent = ['smalltalk', 'strategy', 'video'].includes(parsed.intent) ? parsed.intent : fallbackIntent;
  if (fallbackIntent === 'video' && intent !== 'video') intent = 'video';
  if (fallbackIntent === 'strategy' && intent === 'smalltalk') intent = 'strategy';

  const needsImage = intent === 'strategy' && shouldGenerateStrategyImage(userQuery);
  const videoSeed = intent === 'video'
    ? cleanText(parsed.video_query_seed || buildVideoSearchSeed(userQuery)).slice(0, 120)
    : null;
  const snippet = extractKeywordSnippet(userQuery);

  const output = trimMainAgentOutput({
    task_id: context.taskId || '',
    fsm_state: 'MAIN_REPLIED',
    intent,
    popup_mode: intent === 'video' ? 'video_search' : intent === 'strategy' ? (needsImage ? 'strategy_card' : 'strategy_text') : 'chat_reply',
    strategy_output_mode: intent === 'strategy' ? (needsImage ? 'card_with_image' : 'text_only') : 'none',
    needs_image: needsImage,
    image_query: needsImage ? userQuery : null,
    speakable: true,
    emotional_reply: cleanText(parsed.emotional_reply || (intent === 'video' ? '好嘞，我去找。' : intent === 'strategy' ? '稳住，我帮你拆。' : '我懂你意思。')),
    understanding_reply: intent === 'smalltalk' ? '' : cleanText(parsed.understanding_reply || (intent === 'video' ? `你想看${videoSeed}相关内容。` : `你想处理的是${snippet}这块问题。`)),
    branch_wait_reply: intent === 'smalltalk' ? '' : cleanText(parsed.branch_wait_reply || (intent === 'video' ? '找到合适视频后，我直接弹给你。' : needsImage ? '我整理成图文卡片后直接弹出。' : '我整理好战术建议后直接弹出。')),
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
