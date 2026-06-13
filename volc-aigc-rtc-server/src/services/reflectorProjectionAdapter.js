import { extractHeroEntities } from './domainRouterService.js';

function cleanText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimText(value = '', max = 36) {
  return cleanText(value).slice(0, max);
}

function containsConflictingHero(text = '', stickyHero = '') {
  const currentHero = String(stickyHero || '').trim();
  if (!currentHero) return false;
  const found = extractHeroEntities(String(text || ''));
  return found.some((item) => item.hero && item.hero !== currentHero);
}

function deriveHintText(reflection = {}) {
  const nextTurn = reflection?.next_turn_hint || {};
  const goal = reflection?.session_goal_inference || {};
  const gaps = Array.isArray(reflection?.this_turn?.gaps) ? reflection.this_turn.gaps : [];

  if (String(nextTurn.predicted_query || '').trim()) {
    return `用户大概率继续追问${String(nextTurn.predicted_query).trim()}`;
  }
  if (Array.isArray(nextTurn.preload_actions) && nextTurn.preload_actions.length > 0) {
    const first = nextTurn.preload_actions[0];
    if (first?.query) {
      return first.type === 'video'
        ? `优先补视频方向：${String(first.query).trim()}`
        : `优先补知识方向：${String(first.query).trim()}`;
    }
  }
  if (Array.isArray(goal.uncovered) && goal.uncovered.length > 0) {
    return `优先补${String(goal.uncovered[0]).trim()}，别停在泛泛建议`;
  }
  if (gaps.length > 0) {
    return `下一句先补${String(gaps[0]).trim()}`;
  }
  return '';
}

export function buildReflectorBriefHint(reflection = {}, context = {}, state = {}) {
  if (!reflection || typeof reflection !== 'object') {
    return '';
  }

  const qualityScore = Number(reflection?.this_turn?.quality_score || 0);
  const stickyHero = String(context?.stickyHero?.hero || '').trim();
  const currentIntent = String(state?.intent || '').trim();
  const predictedIntents = Array.isArray(reflection?.next_turn_hint?.predicted_intents)
    ? reflection.next_turn_hint.predicted_intents
    : [];

  if (qualityScore < 0.7) return '';
  if (predictedIntents.length > 0 && currentIntent && !predictedIntents.includes(currentIntent)) {
    return '';
  }

  const rawHint = deriveHintText(reflection);
  if (!rawHint) return '';
  if (containsConflictingHero(rawHint, stickyHero)) return '';

  const compact = trimText(rawHint, 36);
  if (!compact) return '';
  if (/空头支票|主角幻觉|质量分|session goal|subagent/i.test(compact)) {
    return '';
  }

  return compact;
}
