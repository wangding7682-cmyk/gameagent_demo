import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

/**
 * P0 Reflector 日志独立落盘
 * 与 agent-traces.jsonl 解耦，便于离线分析 quality_score 分布
 */

const reflectionFilePath = path.resolve(config.projectRoot, './data/agent-reflections.jsonl');
const MAX_REFLECTION_ROWS = 5000;

function ensureFile() {
  fs.mkdirSync(path.dirname(reflectionFilePath), { recursive: true });
  if (!fs.existsSync(reflectionFilePath)) {
    fs.writeFileSync(reflectionFilePath, '', 'utf8');
  }
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function readAll() {
  ensureFile();
  return fs.readFileSync(reflectionFilePath, 'utf8').split(/\r?\n/).filter(Boolean).map(safeJsonParse).filter(Boolean);
}

function trimIfNeeded() {
  const rows = readAll();
  if (rows.length <= MAX_REFLECTION_ROWS) return;
  const retained = rows.slice(-MAX_REFLECTION_ROWS);
  fs.writeFileSync(reflectionFilePath, `${retained.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

export function appendReflectionLog(entry = {}) {
  ensureFile();
  const row = {
    logged_at: new Date().toISOString(),
    turn_id: entry.turn_id || '',
    session_id: entry.session_id || 'default',
    source: entry.source || 'unknown',
    user_query: String(entry.user_query || '').slice(0, 500),
    intent: entry.intent || 'unknown',
    main_summary: String(entry.main_summary || '').slice(0, 300),
    branch_output: entry.branch_output || null,
    reflection: entry.reflection || null,
    latency_ms: Number.isFinite(entry.latency_ms) ? entry.latency_ms : null,
    degraded: Boolean(entry.degraded),
    error: entry.error || null,
  };
  fs.appendFileSync(reflectionFilePath, `${JSON.stringify(row)}\n`, 'utf8');
  trimIfNeeded();
  return row;
}

export function listReflectionLogs(filters = {}) {
  const limit = Math.max(1, Math.min(500, Number(filters.limit || 100) || 100));
  const offset = Math.max(0, Number(filters.offset || 0) || 0);
  const sessionId = String(filters.sessionId || filters.session_id || '').trim();
  const intent = String(filters.intent || '').trim();

  let rows = readAll().reverse();
  if (sessionId) rows = rows.filter((r) => r.session_id === sessionId);
  if (intent) rows = rows.filter((r) => r.intent === intent);

  return {
    total: rows.length,
    limit,
    offset,
    list: rows.slice(offset, offset + limit),
  };
}

export function summarizeReflectionLogs(filters = {}) {
  const rows = readAll();
  const filtered = filters.intent
    ? rows.filter((r) => r.intent === filters.intent)
    : rows;
  if (filtered.length === 0) {
    return { count: 0, intents: {}, quality: null, latency: null, degraded_rate: 0 };
  }

  const scores = [];
  const latencies = [];
  let degraded = 0;
  const intents = {};
  const buckets = { low: 0, mid: 0, high: 0 };

  filtered.forEach((r) => {
    const q = r?.reflection?.this_turn?.quality_score;
    if (Number.isFinite(q)) {
      scores.push(q);
      if (q < 0.5) buckets.low += 1;
      else if (q < 0.8) buckets.mid += 1;
      else buckets.high += 1;
    }
    if (Number.isFinite(r.latency_ms)) latencies.push(r.latency_ms);
    if (r.degraded) degraded += 1;
    intents[r.intent] = (intents[r.intent] || 0) + 1;
  });

  const avg = (arr) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);
  const percentile = (arr, p) => {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  };

  return {
    count: filtered.length,
    intents,
    quality: scores.length > 0
      ? {
          avg: Number(avg(scores).toFixed(3)),
          p50: percentile(scores, 50),
          p10: percentile(scores, 10),
          p90: percentile(scores, 90),
          buckets,
        }
      : null,
    latency: latencies.length > 0
      ? {
          avg_ms: Math.round(avg(latencies)),
          p50_ms: percentile(latencies, 50),
          p90_ms: percentile(latencies, 90),
          p99_ms: percentile(latencies, 99),
        }
      : null,
    degraded_rate: Number((degraded / filtered.length).toFixed(3)),
  };
}
