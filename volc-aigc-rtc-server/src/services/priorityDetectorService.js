const HIGH_URGENCY_PATTERNS = [
  /\b赶紧\b/,
  /\b赶快\b/,
  /\b快速\b/,
  /\b快点\b/,
  /\b来不及\b/,
  /\b没时间\b/,
  /\b等不了\b/,
  /\b现在就要\b/,
  /\b马上要\b/,
  /\b立刻?\b/,
  /\b马上\b/,
  /\b马上就要\b/,
  /\b现在就\b/,
  /\b急\b.{0,4}(要|想|需|帮|告诉|说)\b/,
  /\b(要|想|需).{0,3}死\b/,
  /\b团战?\b.{0,6}(怎么|如何|怎么办)\b/,
  /\b(正在|在)?\b(打|对线|被抓|被gank|被蹲|被抓单)\b.{0,3}(救命|帮忙|快来|支援|救)\b/,
  /\b(对面|敌人|对方)\b.{0,4}(来了|进|入侵|在|开|打)\b/,
  /\b(快|马上)?.{0,2}(来人|帮忙|支援|救我|救命|tui|推|守)\b/,
  /\b(别|不要|不用)(等|慢|拖|犹豫)\b/,
  /\b时间不多了?\b/,
  /\b(血量|血|hp|HP)\b.{0,3}(不够|危险|快没了?|很低|见底)\b/,
  /\b(技能|大招|R|r)\b.{0,3}(好了?|转好|CD好了?)\b/,
];

const LOW_URGENCY_PATTERNS = [
  /\b待会\b/,
  /\b等下\b/,
  /\b等会儿\b/,
  /\b一会?\b.{0,2}(再说|再问|再看|再查|再弄)\b/,
  /\b先不急\b/,
  /\b有空\b.{0,3}(再说|再问|再看|再查)\b/,
  /\b回头\b.{0,3}(看|问|查|研究|分析)\b/,
  /\b慢慢\b/,
  /\b不急\b/,
  /\b先收藏\b/,
  /\b先记下来\b/,
  /\b以后?\b.{0,3}(再说|再看|再学|再练)\b/,
  /\b下次?\b.{0,3}(再说|再问|再看)\b/,
  /\b闲了?\b.{0,3}(再说|再问|再看|再查)\b/,
  /\b(复盘|总结|回顾|整理)\b/,
  /\b(理论|原理|机制|底层)\b.{0,3}(学习|了解|研究)\b/,
];

function nowIso() {
  return new Date().toISOString();
}

function logPriority(message, data = {}) {
  console.log(`[PriorityDetector] ${message}`, {
    at: nowIso(),
    ...data,
  });
}

function matchAny(text, patterns) {
  if (!text) return false;
  const s = String(text);
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(s)) {
      return { matched: true, pattern: String(patterns[i]), index: i };
    }
  }
  return false;
}

export function detectRequestPriority(userQuery = '', intent = '') {
  const text = String(userQuery || '').trim();
  const detectedIntent = String(intent || 'unknown').toLowerCase();

  if (!text) {
    return { priority: 'normal', reason: 'empty_query', matched_pattern: null };
  }

  const isStrategyOrVideo = ['strategy', 'video'].includes(detectedIntent);

  const highMatch = matchAny(text, HIGH_URGENCY_PATTERNS);
  if (highMatch) {
    logPriority('detected_high', {
      user_query: text,
      intent: detectedIntent,
      pattern: highMatch.pattern,
      is_strategy_or_video: isStrategyOrVideo,
    });
    return {
      priority: 'high',
      reason: 'urgency_keyword',
      matched_pattern: highMatch.pattern,
      applies_to_pool: isStrategyOrVideo,
    };
  }

  const lowMatch = matchAny(text, LOW_URGENCY_PATTERNS);
  if (lowMatch) {
    logPriority('detected_low', {
      user_query: text,
      intent: detectedIntent,
      pattern: lowMatch.pattern,
      is_strategy_or_video: isStrategyOrVideo,
    });
    return {
      priority: 'low',
      reason: 'deferral_keyword',
      matched_pattern: lowMatch.pattern,
      applies_to_pool: isStrategyOrVideo,
    };
  }

  logPriority('detected_normal', {
    user_query: text,
    intent: detectedIntent,
    is_strategy_or_video: isStrategyOrVideo,
  });

  return {
    priority: 'normal',
    reason: 'no_match',
    matched_pattern: null,
    applies_to_pool: isStrategyOrVideo,
  };
}

export function resolvePoolPriority(detectResult = {}, explicitPriority = null) {
  if (explicitPriority && ['high', 'normal', 'low'].includes(String(explicitPriority).toLowerCase())) {
    return String(explicitPriority).toLowerCase();
  }
  return detectResult.priority || 'normal';
}
