const BRACKET_PATTERN = /\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）/g;

export const TRIM_RULES = {
  L0_SPEAKABLE: {
    emotional_reply: 16,
    understanding_reply: 45,
    branch_wait_reply: 36,
    main_tts_bundle: 70,
    voice_chunk: 36,
    max_voice_chunks: 4,
  },
  L1_UI_BRIEF: {
    main_summary: 120,
    popup_title: 28,
    popup_subtitle: 50,
    ability_feedback: 80,
    queue_hint: 40,
  },
  L2_STRUCTURED_ASSET: {
    card_title: 24,
    card_detail: 24,
    card_detail_count: 5,
    image_prompt_text: 260,
    video_query: 80,
    video_title: 40,
    video_summary: 120,
  },
  L3_DEBUG_RAW: {
    raw_preview: 600,
    route_reason: 120,
    error_message: 160,
  },
};

export function cleanText(value = '', { removeBrackets = true } = {}) {
  let text = String(value || '');
  if (removeBrackets) {
    text = text.replace(BRACKET_PATTERN, '');
  }
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\u200B-\u200D\u2060-\u2064]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function trimText(value, maxLength, fallback = '', options = {}) {
  const text = cleanText(value || fallback, options);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function trimList(values, { maxItems, maxItemLength, removeBrackets = true } = {}) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((item) => trimText(item, maxItemLength, '', { removeBrackets }))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function normalizeIntent(value) {
  const intent = cleanText(value).toLowerCase();
  return ['smalltalk', 'strategy', 'video'].includes(intent) ? intent : 'smalltalk';
}

export function normalizeFsmState(value, fallback = 'MAIN_REPLIED') {
  const state = cleanText(value).toUpperCase();
  const allowed = [
    'CREATED',
    'CONTEXT_LOADING',
    'ROUTING',
    'MAIN_REPLIED',
    'BRANCH_QUEUED',
    'BRANCH_EXEC',
    'PARTIAL_STREAMING',
    'ASSET_READY',
    'DONE',
    'DEGRADED',
    'FAILED',
    'CANCELLED',
  ];
  return allowed.includes(state) ? state : fallback;
}

export function popupModeForIntent(intent, strategyOutputMode = 'text_only') {
  if (intent === 'strategy') {
    return strategyOutputMode === 'card_with_image' ? 'strategy_card' : 'strategy_text';
  }
  if (intent === 'video') {
    return 'video_search';
  }
  return 'chat_reply';
}

export function trimMainAgentOutput(output = {}) {
  const intent = normalizeIntent(output.intent);
  const rawStrategyMode = cleanText(output.strategy_output_mode || '').toLowerCase();
  const strategyOutputMode = intent === 'strategy'
    ? (rawStrategyMode === 'card_with_image' ? 'card_with_image' : 'text_only')
    : 'none';
  const needsImage = intent === 'strategy' && strategyOutputMode === 'card_with_image' && output.needs_image === true;
  const emotionalReply = trimText(output.emotional_reply, TRIM_RULES.L0_SPEAKABLE.emotional_reply, '收到！');
  const understandingReply = trimText(output.understanding_reply, TRIM_RULES.L0_SPEAKABLE.understanding_reply);
  let branchWaitReply = trimText(output.branch_wait_reply, TRIM_RULES.L0_SPEAKABLE.branch_wait_reply);

  if (intent === 'strategy' && !branchWaitReply) {
    branchWaitReply = needsImage ? '我来整理成图文战术卡片。' : '我来整理一份文字战术建议。';
  } else if (intent === 'video' && !branchWaitReply) {
    branchWaitReply = '我来帮你找可播放视频。';
  } else if (intent === 'smalltalk') {
    branchWaitReply = '';
  }

  return {
    task_id: trimText(output.task_id, 80, '', { removeBrackets: false }),
    fsm_state: normalizeFsmState(output.fsm_state),
    intent,
    popup_mode: trimText(output.popup_mode, 24, popupModeForIntent(intent, strategyOutputMode)),
    strategy_output_mode: strategyOutputMode,
    needs_image: needsImage,
    image_query: needsImage ? trimText(output.image_query, TRIM_RULES.L2_STRUCTURED_ASSET.image_prompt_text) : null,
    speakable: output.speakable !== false,
    emotional_reply: emotionalReply,
    understanding_reply: understandingReply,
    branch_wait_reply: branchWaitReply,
    main_tts_bundle: trimText(`${emotionalReply} ${understandingReply}`.trim(), TRIM_RULES.L0_SPEAKABLE.main_tts_bundle),
    main_summary: trimText(output.main_summary || output.summary, TRIM_RULES.L1_UI_BRIEF.main_summary, '我会结合当前上下文给你一个简洁建议。'),
    route_reason: trimText(output.route_reason, TRIM_RULES.L3_DEBUG_RAW.route_reason),
    strategy_query: intent === 'strategy' ? trimText(output.strategy_query, 120) : null,
    video_query_seed: intent === 'video' ? trimText(output.video_query_seed, 120) : null,
    queue_hint: intent === 'strategy' || intent === 'video'
      ? trimText(output.queue_hint, TRIM_RULES.L1_UI_BRIEF.queue_hint, '任务已创建，等待异步执行')
      : '',
    tts_priority: ['high', 'normal', 'low'].includes(output.tts_priority) ? output.tts_priority : 'normal',
  };
}

export function trimTacticData(data = {}) {
  const rawStrategyMode = cleanText(data.strategy_output_mode || '').toLowerCase();
  const strategyOutputMode = rawStrategyMode === 'card_with_image' ? 'card_with_image' : 'text_only';
  const needsImage = data.needs_image === true && strategyOutputMode === 'card_with_image';

  return {
    title: trimText(data.title, TRIM_RULES.L2_STRUCTURED_ASSET.card_title, '战术处理建议'),
    details: trimList(data.details, {
      maxItems: TRIM_RULES.L2_STRUCTURED_ASSET.card_detail_count,
      maxItemLength: TRIM_RULES.L2_STRUCTURED_ASSET.card_detail,
    }),
    strategy_output_mode: strategyOutputMode,
    needs_image: needsImage,
    image_prompt_text: needsImage
      ? trimText(data.image_prompt_text, TRIM_RULES.L2_STRUCTURED_ASSET.image_prompt_text)
      : null,
    voice_chunks: trimList(data.voice_chunks, {
      maxItems: TRIM_RULES.L0_SPEAKABLE.max_voice_chunks,
      maxItemLength: TRIM_RULES.L0_SPEAKABLE.voice_chunk,
    }),
  };
}

export function trimVideoData(data = {}) {
  return {
    query: trimText(data.query, TRIM_RULES.L2_STRUCTURED_ASSET.video_query),
    title: trimText(data.title, TRIM_RULES.L2_STRUCTURED_ASSET.video_title, '精彩视频'),
    summary: trimText(data.summary, TRIM_RULES.L2_STRUCTURED_ASSET.video_summary),
    videoUrl: cleanText(data.videoUrl, { removeBrackets: false }),
    linkUrl: cleanText(data.linkUrl, { removeBrackets: false }),
    coverUrl: cleanText(data.coverUrl, { removeBrackets: false }),
    is_embed: Boolean(data.is_embed),
  };
}
