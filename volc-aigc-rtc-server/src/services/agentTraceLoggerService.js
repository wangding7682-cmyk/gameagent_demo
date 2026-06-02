import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

const traceFilePath = path.resolve(config.projectRoot, './data/agent-traces.jsonl');
const MAX_TRACE_ROWS = 2000;

function ensureTraceFile() {
  fs.mkdirSync(path.dirname(traceFilePath), { recursive: true });
  if (!fs.existsSync(traceFilePath)) {
    fs.writeFileSync(traceFilePath, '', 'utf8');
  }
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function readAllTraces() {
  ensureTraceFile();
  const lines = fs.readFileSync(traceFilePath, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map(safeJsonParse).filter(Boolean);
}

function normalizeTrace(input = {}) {
  const now = new Date().toISOString();
  const turnId = input.turn_id || input.turnId || `turn_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  return {
    trace_id: input.trace_id || input.traceId || `trace_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    turn_id: turnId,
    session_id: input.session_id || input.sessionId || 'default',
    source: input.source || 'unknown',
    user_query: String(input.user_query || input.userQuery || input.query || '').slice(0, 500),
    orchestration_input: String(input.orchestration_input || input.orchestrationInput || input.user_query || input.userQuery || input.query || '').slice(0, 500),
    raw_asr_text: String(input.raw_asr_text || input.rawAsrText || '').slice(0, 1000),
    intent: input.intent || 'unknown',
    status: input.status || 'done',
    route_reason: input.route_reason || input.routeReason || '',
    timeline: Array.isArray(input.timeline) ? input.timeline : [],
    rag: input.rag || null,
    output: input.output || null,
    error: input.error || null,
    created_at: input.created_at || input.createdAt || now,
    updated_at: now,
  };
}

function trimTraceFileIfNeeded() {
  const traces = readAllTraces();
  if (traces.length <= MAX_TRACE_ROWS) {
    return;
  }
  const retained = traces.slice(-MAX_TRACE_ROWS);
  fs.writeFileSync(traceFilePath, `${retained.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
}

export function appendAgentTrace(input = {}) {
  ensureTraceFile();
  const trace = normalizeTrace(input);
  fs.appendFileSync(traceFilePath, `${JSON.stringify(trace)}\n`, 'utf8');
  trimTraceFileIfNeeded();
  return trace;
}

export function listAgentTraces(filters = {}) {
  const limit = Math.max(1, Math.min(200, Number(filters.limit || 50) || 50));
  const offset = Math.max(0, Number(filters.offset || 0) || 0);
  const sessionId = String(filters.sessionId || filters.session_id || '').trim();
  const intent = String(filters.intent || '').trim();
  const status = String(filters.status || '').trim();
  const keyword = String(filters.keyword || filters.q || '').trim().toLowerCase();

  let traces = readAllTraces().reverse();
  if (sessionId) {
    traces = traces.filter((item) => item.session_id === sessionId);
  }
  if (intent) {
    traces = traces.filter((item) => item.intent === intent);
  }
  if (status) {
    traces = traces.filter((item) => item.status === status);
  }
  if (keyword) {
    traces = traces.filter((item) =>
      [item.user_query, item.route_reason, item.intent, item.status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    );
  }

  return {
    total: traces.length,
    limit,
    offset,
    list: traces.slice(offset, offset + limit),
  };
}

export function getAgentTrace(turnId) {
  const target = String(turnId || '').trim();
  if (!target) {
    return null;
  }
  return readAllTraces()
    .reverse()
    .find((item) => item.turn_id === target || item.trace_id === target) || null;
}
