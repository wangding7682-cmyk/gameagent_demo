/**
 * 【会话目标追踪 / 主线记账员】sessionGoalTrackerService
 *
 * 通俗职责：跨轮记账。把每轮 Reflector 推断出的"用户这次到底想干啥"用频次投票合并，
 * 维护一条稳定的主线目标 + 已聊过/还没聊到的子点列表，喂给下一轮 main agent。
 *
 * 设计要点：
 *   - 不做 LLM 调用，纯算法 merge，调用零成本
 *   - primary_goal 用「频次胜出」原则：累积投票，最高的胜出，避免 Reflector 单次抖动
 *   - covered ∪ uncovered 维护 Set 去重；新出现在 covered 的会从 uncovered 移除
 *   - 写入 sessionState.dynamic_context.session_goal 字段
 *   - 加载侧由 agentContextService 透出 context.sessionGoal
 */

import { getAgentSessionState, upsertAgentDynamicContext } from './agentSessionStateService.js';

const MAX_SET_SIZE = 12;
const MAX_VOTE_KEEP = 8;

function uniqShortStrings(arr = [], maxItem = 30) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(arr) ? arr : []) {
    const s = String(raw || '').trim().slice(0, maxItem);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function mergeSessionGoal(prevGoal = {}, inference = {}) {
  const prev = (prevGoal && typeof prevGoal === 'object') ? prevGoal : {};
  const inf = (inference && typeof inference === 'object') ? inference : {};

  const newPrimary = String(inf.primary_goal || '').trim().slice(0, 30);
  const votes = { ...(prev.primary_goal_votes || {}) };
  if (newPrimary) {
    votes[newPrimary] = (votes[newPrimary] || 0) + 1;
  }
  const sortedVotes = Object.entries(votes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_VOTE_KEEP);
  const trimmedVotes = Object.fromEntries(sortedVotes);
  const winner = sortedVotes[0]?.[0] || prev.primary_goal || newPrimary || '';

  const prevCovered = uniqShortStrings(prev.covered || [], 30);
  const newCovered = uniqShortStrings(inf.covered || [], 30);
  const mergedCoveredSet = new Set([...prevCovered, ...newCovered]);
  const covered = Array.from(mergedCoveredSet).slice(-MAX_SET_SIZE);

  const prevUncovered = uniqShortStrings(prev.uncovered || [], 30);
  const newUncovered = uniqShortStrings(inf.uncovered || [], 30);
  const mergedUncoveredRaw = [...prevUncovered, ...newUncovered];
  const uncovered = uniqShortStrings(mergedUncoveredRaw, 30)
    .filter((s) => !mergedCoveredSet.has(s))
    .slice(-MAX_SET_SIZE);

  return {
    primary_goal: winner,
    primary_goal_votes: trimmedVotes,
    covered,
    uncovered,
    turn_count: (prev.turn_count || 0) + 1,
    last_updated: new Date().toISOString(),
  };
}

export function updateSessionGoalFromReflection({ sessionId, reflection, degraded }) {
  if (degraded) return null;
  if (!sessionId) return null;
  const inference = reflection?.session_goal_inference;
  if (!inference || typeof inference !== 'object') return null;
  const hasContent = Boolean(inference.primary_goal) ||
    (Array.isArray(inference.covered) && inference.covered.length) ||
    (Array.isArray(inference.uncovered) && inference.uncovered.length);
  if (!hasContent) return null;

  const state = getAgentSessionState(sessionId);
  const prevGoal = state?.dynamic_context?.session_goal || {};
  const merged = mergeSessionGoal(prevGoal, inference);
  upsertAgentDynamicContext(sessionId, { session_goal: merged });
  return merged;
}

export function getSessionGoal(sessionId = 'default') {
  const state = getAgentSessionState(sessionId);
  return state?.dynamic_context?.session_goal || null;
}

export function summarizeSessionGoal(goal) {
  if (!goal || typeof goal !== 'object') return '';
  const parts = [];
  if (goal.primary_goal) parts.push(`主线: ${goal.primary_goal}`);
  if (Array.isArray(goal.covered) && goal.covered.length) {
    parts.push(`已覆盖: ${goal.covered.slice(-3).join('、')}`);
  }
  if (Array.isArray(goal.uncovered) && goal.uncovered.length) {
    parts.push(`待覆盖: ${goal.uncovered.slice(0, 3).join('、')}`);
  }
  return parts.join(' | ').slice(0, 160);
}

export const __INTERNAL = { uniqShortStrings, MAX_SET_SIZE };
