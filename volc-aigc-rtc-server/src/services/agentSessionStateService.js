import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

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
