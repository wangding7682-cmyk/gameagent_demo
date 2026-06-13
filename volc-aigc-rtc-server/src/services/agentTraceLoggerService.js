import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

const traceFilePath = path.resolve(config.projectRoot, './data/agent-traces.jsonl');
const MAX_TRACE_ROWS = 2000;
// 内存态：每个 turn_id 的最新完整状态，用于支持每步写 trace + 最终去重读
const traceLiveState = new Map();

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
  const prev = traceLiveState.get(turnId) || {};
  return {
    trace_id: input.trace_id || input.traceId || `trace_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    turn_id: turnId,
    session_id: input.session_id || input.sessionId || prev.session_id || 'default',
    source: input.source || prev.source || 'unspecified',
    user_query: String(input.user_query || input.userQuery || input.query || prev.user_query || '').slice(0, 500),
    orchestration_input: String(input.orchestration_input || input.orchestrationInput || input.user_query || input.userQuery || input.query || prev.orchestration_input || prev.user_query || '').slice(0, 500),
    raw_asr_text: String(input.raw_asr_text || input.rawAsrText || prev.raw_asr_text || '').slice(0, 1000),
    intent: input.intent || prev.intent || 'unknown',
    status: input.status || prev.status || 'done',
    route_reason: input.route_reason || input.routeReason || prev.route_reason || '',
    latest_stage: input.latest_stage || input.stage || prev.latest_stage || '',
    stage_text: input.stage_text || buildStageText(input.stage || prev.latest_stage || '', input.intent || prev.intent || ''),
    timeline: Array.isArray(input.timeline) ? input.timeline : (prev.timeline || []),
    rag: input.rag !== undefined ? input.rag : (prev.rag || null),
    output: input.output !== undefined ? input.output : (prev.output || null),
    error: input.error !== undefined ? input.error : (prev.error || null),
    created_at: input.created_at || input.createdAt || prev.created_at || now,
    updated_at: now,
  };
}

function buildStageText(stage = '', intent = '') {
  const map = {
    input_received: '已接收输入',
    context_ready: '上下文就绪',
    interaction_placeholder_emitted: '意图占位符已发出',
    interaction_agent_done: '意图识别完成',
    interaction_reply_emitted: '主回复已发出',
    main_reply_emitted: '主回复已确认',
    strategy_agent_done: '战术生成完成',
    video_agent_done: '视频检索完成',
    reflector_done: '反思完成',
    done: '全部完成',
    error: '处理出错',
    empty_promise_detected: '空承诺检测',
    reflector_skipped: '反思跳过',
    reflector_dispatched: '反思已派发',
    memory_writer_done: '记忆已沉淀',
    task_queued: '任务排队中',
  };
  return map[stage] || stage || '';
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
  // 写入前先更新内存态，确保同一 turn_id 的后续调用能继承之前的数据
  traceLiveState.set(trace.turn_id, trace);
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
  const userOnly = ['1', 'true', 'yes'].includes(String(filters.userOnly || filters.user_only || '').toLowerCase());
  const groupByTurn = ['1', 'true', 'yes'].includes(String(filters.groupByTurn || filters.group_by_turn || '').toLowerCase());
  const excludeSources = String(filters.excludeSource || filters.exclude_source || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let traces = readAllTraces().reverse();
  if (userOnly) {
    traces = traces.filter((item) => {
      const hasUserInput = Boolean(String(item.orchestration_input || item.user_query || item.raw_asr_text || '').trim());
      const source = String(item.source || '').toLowerCase();
      return hasUserInput && !['memory_writer', 'orchestrator', 'reflector'].includes(source);
    });
  }
  if (excludeSources.length > 0) {
    traces = traces.filter((item) => !excludeSources.includes(item.source));
  }
  if (groupByTurn) {
    // 按 turn_id 分组，每组取最新条目（updated_at 最大）
    const grouped = new Map();
    for (const item of traces) {
      const key = item.turn_id || item.trace_id;
      const existing = grouped.get(key);
      if (!existing || new Date(item.updated_at || 0) > new Date(existing.updated_at || 0)) {
        grouped.set(key, item);
      }
    }
    traces = Array.from(grouped.values());
  }
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
  const matches = readAllTraces()
    .reverse()
    .filter((item) => item.turn_id === target || item.trace_id === target);
  if (matches.length === 0) {
    return null;
  }
  const preferred = matches.find((item) => {
    const source = String(item.source || '').toLowerCase();
    const hasUserInput = Boolean(String(item.orchestration_input || item.user_query || item.raw_asr_text || '').trim());
    return hasUserInput && !['orchestrator', 'memory_writer', 'reflector'].includes(source);
  });
  return preferred || matches[0] || null;
}
