import { extractHeroEntities } from './domainRouterService.js';
import { summarizeSessionGoal } from './sessionGoalTrackerService.js';
import { getResumableBranchHint } from './rtcTaskEngagementService.js';

const FIELD_LIMITS = {
  sticky_hero: 10,
  session_topic: 16,
  recent_summary_brief: 40,
  latest_rag_brief: 45,
  reflector_brief_hint: 36,
  current_game_state: 40,
  unresolved_need: 32,
  task_engagement_state: 14,
  resumable_branch_hint: 32,
};

function cleanText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[（(][^)）]*[)）]/g, '')
    .trim();
}

function trimField(value = '', maxLength = 40) {
  return cleanText(value).slice(0, maxLength);
}

function pickStickyHero(recentTurns = [], currentQuery = '') {
  const currentList = extractHeroEntities(String(currentQuery || ''));
  if (currentList.length > 0) {
    return currentList[0];
  }
  const historyList = [...(Array.isArray(recentTurns) ? recentTurns : [])]
    .reverse()
    .map((turn) => String(turn?.hero_focus || '').trim())
    .filter(Boolean);
  if (historyList.length > 0) {
    return { hero: historyList[0] };
  }
  const historyText = (Array.isArray(recentTurns) ? recentTurns : [])
    .slice(-3)
    .map((turn) => `${turn?.user_query || ''} ${turn?.summary || turn?.main_summary || ''}`)
    .join(' ');
  const extracted = extractHeroEntities(historyText);
  return extracted[0] || null;
}

function inferTopicLabel(query = '', stickyHero = '') {
  const text = String(query || '');
  if (/视频|链接|集锦|高光|教学/.test(text)) {
    return `${stickyHero || '当前'}视频检索`.replace(/^当前/, '');
  }
  if (/打野|刷野|开野|抓人|控龙|反野/.test(text)) {
    return `${stickyHero || '当前英雄'}打野打法`;
  }
  if (/对线|对位|克制|换血|兵线/.test(text)) {
    return `${stickyHero || '当前英雄'}对线处理`;
  }
  if (/出装|连招|打法|怎么打|攻略|思路|技巧|知识卡片|战术卡/.test(text)) {
    return `${stickyHero || '当前英雄'}玩法建议`;
  }
  return stickyHero ? `${stickyHero}话题延续` : '当前对话延续';
}

function buildLatestRagBrief(retrievedKnowledge = '', recentTurns = []) {
  const current = trimField(retrievedKnowledge, FIELD_LIMITS.latest_rag_brief);
  if (current) {
    return current;
  }
  const historyTurn = [...(Array.isArray(recentTurns) ? recentTurns : [])]
    .reverse()
    .find((turn) => String(turn?.rag_summary || '').trim());
  return trimField(historyTurn?.rag_summary || '', FIELD_LIMITS.latest_rag_brief);
}

function buildRecentSummaryBrief(currentQuery = '', recentTurns = []) {
  const latestTurn = [...(Array.isArray(recentTurns) ? recentTurns : [])].reverse()[0] || null;
  const latestSummary = trimField(latestTurn?.summary || latestTurn?.main_summary || '', FIELD_LIMITS.recent_summary_brief);
  if (latestSummary) {
    return latestSummary;
  }
  if (currentQuery) {
    return trimField(`用户当前在问：${currentQuery}`, FIELD_LIMITS.recent_summary_brief);
  }
  return '';
}

function normalizeEngagementState(value = '') {
  const state = String(value || '').trim().toLowerCase();
  if (['active', 'paused', 'cancelled', 'light_chat', 'resumable'].includes(state)) {
    return state;
  }
  return 'active';
}

function buildEngagementAwareTopic(taskEngagementState = 'active', sessionTopic = '') {
  if (taskEngagementState === 'paused') return '当前话题暂停';
  if (taskEngagementState === 'cancelled') return '当前话题收住';
  if (taskEngagementState === 'light_chat') return '轻互动延续';
  return sessionTopic;
}

function buildEngagementAwareSummary(taskEngagementState = 'active', currentQuery = '', recentTurns = [], resumableBranchHint = '') {
  if (taskEngagementState === 'paused') {
    return trimField(
      resumableBranchHint ? `刚暂停：${resumableBranchHint}` : '用户暂时不继续当前任务',
      FIELD_LIMITS.recent_summary_brief
    );
  }
  if (taskEngagementState === 'cancelled') {
    return trimField(
      resumableBranchHint ? `刚收住：${resumableBranchHint}` : '用户当前不继续原任务',
      FIELD_LIMITS.recent_summary_brief
    );
  }
  if (taskEngagementState === 'light_chat') {
    return trimField(
      resumableBranchHint ? `当前轻互动，刚停在：${resumableBranchHint}` : '当前在轻互动，不推进原任务',
      FIELD_LIMITS.recent_summary_brief
    );
  }
  return buildRecentSummaryBrief(currentQuery, recentTurns);
}

function buildUnresolvedNeed(currentQuery = '', sessionGoal = null, stickyHero = '') {
  const uncovered = Array.isArray(sessionGoal?.uncovered) ? sessionGoal.uncovered.filter(Boolean) : [];
  if (uncovered.length > 0) {
    return trimField(`需要补充：${uncovered[0]}`, FIELD_LIMITS.unresolved_need);
  }
  const text = String(currentQuery || '');
  if (/视频|链接|集锦|高光|教学/.test(text)) {
    return trimField(`需要补充${stickyHero || '相关'}视频/链接`, FIELD_LIMITS.unresolved_need);
  }
  if (/打野|刷野|开野|抓人|控龙|反野/.test(text)) {
    return trimField(`需要给${stickyHero || '当前英雄'}前期节奏建议`, FIELD_LIMITS.unresolved_need);
  }
  if (/对线|对位|克制|换血|兵线/.test(text)) {
    return trimField(`需要给${stickyHero || '当前英雄'}对线建议`, FIELD_LIMITS.unresolved_need);
  }
  if (/出装|连招|打法|怎么打|攻略|思路|技巧|知识卡片|战术卡/.test(text)) {
    return trimField(`需要给${stickyHero || '当前英雄'}玩法建议`, FIELD_LIMITS.unresolved_need);
  }
  return trimField(currentQuery, FIELD_LIMITS.unresolved_need);
}

export function buildRtcProjection({
  body = {},
  agentSessionState = null,
  retrievedKnowledge = '',
  dynamicGameState = '',
  projectionOverrides = {},
} = {}) {
  const recentTurns = Array.isArray(agentSessionState?.recent_turns) ? agentSessionState.recent_turns : [];
  const dynamicContext = agentSessionState?.dynamic_context || {};
  const sessionGoal = dynamicContext?.session_goal || null;
  const currentQuery = String(body.userQuery || body.text || '').trim();
  const stickyHero = pickStickyHero(recentTurns, currentQuery);
  const stickyHeroName = trimField(stickyHero?.hero || '', FIELD_LIMITS.sticky_hero);
  const taskEngagementState = normalizeEngagementState(dynamicContext?.task_engagement_state);
  const resumableBranchHint = trimField(getResumableBranchHint(dynamicContext), FIELD_LIMITS.resumable_branch_hint);
  const inferredSessionTopic = trimField(
    sessionGoal?.primary_goal || inferTopicLabel(currentQuery, stickyHeroName),
    FIELD_LIMITS.session_topic
  );
  const sessionTopic = trimField(
    buildEngagementAwareTopic(taskEngagementState, inferredSessionTopic),
    FIELD_LIMITS.session_topic
  );
  const projection = {
    sticky_hero: stickyHeroName,
    session_topic: sessionTopic,
    recent_summary_brief: buildEngagementAwareSummary(taskEngagementState, currentQuery, recentTurns, resumableBranchHint),
    latest_rag_brief: buildLatestRagBrief(retrievedKnowledge, recentTurns),
    current_game_state: trimField(dynamicGameState || '暂无明确实时画面，仅基于语音问题回答', FIELD_LIMITS.current_game_state),
    unresolved_need: taskEngagementState === 'active' ? buildUnresolvedNeed(currentQuery, sessionGoal, stickyHeroName) : '',
    session_goal_brief: trimField(summarizeSessionGoal(sessionGoal), 80),
    task_engagement_state: trimField(taskEngagementState, FIELD_LIMITS.task_engagement_state),
    resumable_branch_hint: taskEngagementState === 'active' ? '' : resumableBranchHint,
  };

  return {
    ...projection,
    ...Object.fromEntries(
      Object.entries(projectionOverrides || {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, trimField(String(value || ''), FIELD_LIMITS[key] || 80)])
    ),
  };
}

export function buildRtcProjectionMessage(projection = {}) {
  const orderedFields = [
    ['sticky_hero', projection.sticky_hero],
    ['session_topic', projection.session_topic],
    ['recent_summary_brief', projection.recent_summary_brief],
    ['latest_rag_brief', projection.latest_rag_brief],
    ['reflector_brief_hint', projection.reflector_brief_hint],
    ['current_game_state', projection.current_game_state],
    ['unresolved_need', projection.unresolved_need],
    ['task_engagement_state', projection.task_engagement_state],
    ['resumable_branch_hint', projection.resumable_branch_hint],
  ].filter(([, value]) => String(value || '').trim());

  if (orderedFields.length === 0) {
    return '';
  }

  return [
    '# RTC Context Projection',
    ...orderedFields.map(([key, value]) => `${key}: ${value}`),
  ].join('\n');
}
