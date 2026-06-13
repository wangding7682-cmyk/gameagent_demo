import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

/**
 * 【会话状态 / 跨轮黑板】agentSessionStateService
 *
 * 通俗职责：把每轮对话的关键事和动态上下文写进一块"黑板"，
 * 包括最近 N 轮 turn、屏幕白板、会话目标等，下一轮所有模块都从这里读。
 * 落盘到 data/agent-session-state.json，进程崩了不丢状态。
 */

const stateFilePath = path.resolve(config.projectRoot, './data/agent-session-state.json');
const MAX_TURNS = 10;

function ensureStateFile() {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  if (!fs.existsSync(stateFilePath)) {
    fs.writeFileSync(stateFilePath, '{}\n', 'utf8');
  }
}

function readStore() {
  ensureStateFile();
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, 'utf8') || '{}');
  } catch (_) {
    return {};
  }
}

function writeStore(store) {
  ensureStateFile();
  fs.writeFileSync(stateFilePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export function getAgentSessionState(sessionId = 'default') {
  const store = readStore();
  return store[sessionId] || {
    session_id: sessionId,
    recent_turns: [],
    dynamic_context: {},
    updated_at: null,
  };
}

export function appendAgentSessionTurn(sessionId = 'default', turn = {}) {
  const store = readStore();
  const current = getAgentSessionState(sessionId);
  const recentTurns = Array.isArray(current.recent_turns) ? current.recent_turns : [];
  const nextState = {
    ...current,
    session_id: sessionId,
    recent_turns: [...recentTurns, turn].slice(-MAX_TURNS),
    updated_at: new Date().toISOString(),
  };
  store[sessionId] = nextState;
  writeStore(store);
  return nextState;
}

export function upsertAgentDynamicContext(sessionId = 'default', context = {}) {
  const store = readStore();
  const current = getAgentSessionState(sessionId);
  const nextState = {
    ...current,
    session_id: sessionId,
    dynamic_context: {
      ...(current.dynamic_context || {}),
      ...context,
      updated_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
  store[sessionId] = nextState;
  writeStore(store);
  return nextState;
}

export function clearAgentSessionState(sessionId = 'default') {
  const store = readStore();
  delete store[sessionId];
  writeStore(store);
  return { session_id: sessionId, cleared: true };
}
