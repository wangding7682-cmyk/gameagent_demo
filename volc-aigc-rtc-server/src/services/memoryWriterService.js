import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { callArkChat, extractJsonObject } from './arkChatService.js';
import { appendAgentTrace } from './agentTraceLoggerService.js';
import {
  loadAgentPreferences,
  loadLongTermMemory,
  loadUserProfile,
  writeLongTermMemoryOverlay,
} from './agentProfileLoaderService.js';
import { vikingAddEvent } from './volcVikingMemoryService.js';
import { encodeLayerSummary, inferMemoryLayer } from './memoryLayerService.js';
import { extractHeroEntities } from './domainRouterService.js';

/**
 * 反幻觉过滤：丢弃候选事实中含 sticky_hero 之外英雄名的条目。
 * 例如上下文主角是「冰晶凤凰」，但 LLM 生成的 candidate.value 含「盲僧」，则该候选会被丢弃。
 * 当 stickyHero 不存在时，跳过过滤（无法判断幻觉）。
 */
function filterHallucinatedCandidates(candidates = [], stickyHero = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { kept: [], dropped: [] };
  }
  const stickyName = stickyHero?.hero || '';
  if (!stickyName) {
    return { kept: candidates.slice(), dropped: [] };
  }
  const kept = [];
  const dropped = [];
  for (const candidate of candidates) {
    const text = String(candidate?.value || '');
    if (!text) {
      kept.push(candidate);
      continue;
    }
    const heroes = extractHeroEntities(text);
    const others = heroes.filter((h) => h.hero !== stickyName);
    if (others.length === 0) {
      kept.push(candidate);
    } else {
      dropped.push({
        ...candidate,
        hallucinated_heroes: others.map((h) => h.hero),
        sticky_hero: stickyName,
      });
    }
  }
  return { kept, dropped };
}

const MEMORY_ROOT = path.resolve(config.projectRoot, './data/memory');
const ALLOWED_BUCKETS = new Set(['facts', 'preferences', 'avoidances']);
const CURRENT_SCHEMA_VERSION = 2;

function safeId(value = 'default') {
  return String(value || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80) || 'default';
}

function ensureMemoryRoot() {
  fs.mkdirSync(MEMORY_ROOT, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function generateMemoryItemId(bucket = '') {
  const prefix = bucket.slice(0, 4) || 'mem';
  return `mem_${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeText(value = '') {
  return String(value || '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .replace(/\s*([,，。；;！!？?:：])\s*/g, '$1')
    .replace(/\s*[（(][^()（）]{0,24}[)）]\s*$/g, '')
    .replace(/[。；;，,！!？?:：、]+$/g, '')
    .trim();
}

function canonicalizeMemoryValue(value = '', bucket = '') {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/^(用户|他|她|ta)\s*/i, '')
    .trim();

  if (!normalized) {
    return '';
  }

  if (bucket === 'preferences') {
    return normalized
      .replace(/^(回答上|回复上|表达上|内容上|整体上)\s*/i, '')
      .replace(/^(偏好|喜欢|更喜欢|希望|倾向于|习惯)\s*/i, '')
      .trim();
  }

  if (bucket === 'avoidances') {
    return normalized
      .replace(/^(回答上|回复上|表达上|内容上|整体上)\s*/i, '')
      .replace(/^(不要|别|请别|尽量不要|应避免|避免|不喜欢|讨厌)\s*/i, '')
      .trim();
  }

  if (bucket === 'facts') {
    return normalized
      .replace(/^(用户|他|她|ta)\s*/i, '')
      .replace(/^(是|属于)\s*/i, '')
      .trim();
  }

  return normalized;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeJsonPointer(segment = '') {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function decodeJsonPointer(pointer = '') {
  if (!pointer || pointer === '/') {
    return [];
  }
  return String(pointer)
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getContainerAndKey(document, pathSegments) {
  let target = document;
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index];
    if (Array.isArray(target)) {
      const arrayIndex = Number(segment);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= target.length) {
        throw new Error(`JSON Patch 路径非法: /${pathSegments.join('/')}`);
      }
      target = target[arrayIndex];
      continue;
    }
    if (!target || typeof target !== 'object' || !(segment in target)) {
      throw new Error(`JSON Patch 路径不存在: /${pathSegments.join('/')}`);
    }
    target = target[segment];
  }
  return {
    container: target,
    key: pathSegments[pathSegments.length - 1],
  };
}

export function applyJsonPatch(document = {}, operations = []) {
  const nextDocument = cloneJson(document);
  for (const operation of operations) {
    const op = String(operation?.op || '').trim();
    const pathValue = String(operation?.path || '').trim();
    if (!op || !pathValue.startsWith('/')) {
      throw new Error(`非法 JSON Patch 操作: ${JSON.stringify(operation)}`);
    }
    const segments = decodeJsonPointer(pathValue);
    if (segments.length === 0) {
      throw new Error('当前最小骨架不支持替换根节点');
    }
    const { container, key } = getContainerAndKey(nextDocument, segments);
    if (Array.isArray(container)) {
      if (op === 'add') {
        if (key === '-') {
          container.push(operation.value);
        } else {
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0 || index > container.length) {
            throw new Error(`JSON Patch 数组下标非法: ${pathValue}`);
          }
          container.splice(index, 0, operation.value);
        }
        continue;
      }
      if (op === 'replace') {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= container.length) {
          throw new Error(`JSON Patch 数组下标非法: ${pathValue}`);
        }
        container[index] = operation.value;
        continue;
      }
      if (op === 'remove') {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= container.length) {
          throw new Error(`JSON Patch 数组下标非法: ${pathValue}`);
        }
        container.splice(index, 1);
        continue;
      }
      throw new Error(`当前最小骨架暂不支持的 JSON Patch op: ${op}`);
    }

    if (!container || typeof container !== 'object') {
      throw new Error(`JSON Patch 容器非法: ${pathValue}`);
    }

    if (op === 'add' || op === 'replace') {
      container[key] = operation.value;
      continue;
    }
    if (op === 'remove') {
      delete container[key];
      continue;
    }
    throw new Error(`当前最小骨架暂不支持的 JSON Patch op: ${op}`);
  }
  return nextDocument;
}

function getMemoryFilePath(userId = 'default') {
  ensureMemoryRoot();
  // 兼容旧调用：实际写入交由 writeLongTermMemoryOverlay 处理；这里仅作展示用途路径。
  return path.join(MEMORY_ROOT, `${safeId(userId)}.overlay.longterm.json`);
}

function writeLongTermMemory(userId = 'default', nextMemory = {}) {
  // 写入 overlay（带 3h TTL）；baseline 保持不变。
  return writeLongTermMemoryOverlay(userId, nextMemory);
}

export function buildMemoryWriterSystemPrompt() {
  return `【System Contract：MemoryWriter 阶段 A】
你是长期记忆沉淀器，只负责从单轮对话结果里提取值得长期保留的用户事实候选。
你的输出只允许是 JSON，不要输出 Markdown，不要解释。

目标：
1. 只提取对未来多轮对话仍有价值的稳定偏好、长期事实、明确禁忌。
2. 不要写瞬时任务结果、一次性问题、泛泛总结、系统内部状态。
3. 候选必须短句、可复用、中文表达、避免重复已有记忆。

分类规则：
- facts：稳定背景、习惯、常玩英雄/位置、实力特征、明确身份信息。
- preferences：回答偏好、打法偏好、信息密度偏好、内容偏好。
- avoidances：明确不喜欢、应避免的讲解方式或内容。

硬性约束：
- 最多返回 3 条 candidates。
- confidence 取值 0 到 1。
- 没有高价值信息时返回空数组。
- 不要生成 JSON Patch，只生成候选 fact。

输出 Schema：
{
  "summary": "本轮是否值得沉淀的简短结论",
  "candidates": [
    {
      "bucket": "facts|preferences|avoidances",
      "value": "短句候选",
      "reason": "提取理由",
      "confidence": 0.0
    }
  ]
}`;
}

export function buildMemoryWriterUserPrompt(payload = {}) {
  const longTermMemory = payload.longTermMemory || {};
  const userProfile = payload.userProfile || {};
  return JSON.stringify({
    task_id: payload.taskId || '',
    turn_id: payload.turnId || '',
    user_id: payload.userId || 'default',
    session_id: payload.sessionId || 'default',
    source: payload.source || 'unknown',
    intent: payload.intent || 'unknown',
    user_query: payload.userQuery || '',
    main_summary: payload.mainSummary || '',
    route_reason: payload.routeReason || '',
    trace_output: payload.traceOutput || {},
    rag_summary: payload.ragSummary || '',
    short_memory_summary: payload.shortMemorySummary || '',
    existing_long_term_memory: {
      facts: Array.isArray(longTermMemory.facts) ? longTermMemory.facts : [],
      preferences: Array.isArray(longTermMemory.preferences) ? longTermMemory.preferences : [],
      avoidances: Array.isArray(longTermMemory.avoidances) ? longTermMemory.avoidances : [],
    },
    user_profile: {
      primary_game: userProfile.game_profile?.primary_game || '',
      rank_tier: userProfile.game_profile?.rank_tier || '',
      preferred_roles: userProfile.game_profile?.preferred_roles || [],
      frequent_champions: userProfile.game_profile?.frequent_champions || [],
      play_style: userProfile.game_profile?.play_style || '',
      detail_level: userProfile.communication_preferences?.detail_level || '',
      dislikes: userProfile.communication_preferences?.dislikes || [],
    },
    instructions: [
      '仅输出高价值长期信息候选',
      '避免与 existing_long_term_memory 重复',
      '不要记录本轮临时任务结果',
      '没有高价值信息时返回空数组',
    ],
  });
}

function normalizeCandidate(candidate = {}) {
  const bucket = String(candidate.bucket || '').trim();
  const value = normalizeText(candidate.value);
  const reason = normalizeText(candidate.reason);
  const confidence = Number(candidate.confidence);
  return {
    bucket,
    value,
    reason,
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

function heuristicCandidates(payload = {}) {
  const candidates = [];
  const query = String(payload.userQuery || '');
  const profile = payload.userProfile || {};
  const detailLevel = profile.communication_preferences?.detail_level;
  const dislikes = profile.communication_preferences?.dislikes || [];

  if (/别讲基础|不要讲基础|不用讲基础/.test(query)) {
    candidates.push({
      bucket: 'avoidances',
      value: '不要重复讲基础英雄机制',
      reason: '用户明确要求跳过基础内容',
      confidence: 0.88,
    });
  }
  if (/具体|细一点|展开|详细/.test(query) || detailLevel === 'high') {
    candidates.push({
      bucket: 'preferences',
      value: '偏好更具体、更可执行的战术细节',
      reason: '用户本轮表达了更高细节偏好',
      confidence: 0.72,
    });
  }
  for (const dislike of dislikes) {
    const text = normalizeText(dislike);
    if (text) {
      candidates.push({
        bucket: 'avoidances',
        value: text,
        reason: '来自既有用户画像中的明确不喜欢项',
        confidence: 0.6,
      });
    }
  }
  return candidates.slice(0, 3);
}

export async function generateCandidateFacts(payload = {}) {
  const preferences = loadAgentPreferences();
  const llmPrefs = preferences.llm?.main_agent || {};
  try {
    const response = await callArkChat({
      systemPrompt: buildMemoryWriterSystemPrompt(),
      userPrompt: buildMemoryWriterUserPrompt(payload),
      temperature: 0.1,
      maxTokens: Math.min(llmPrefs.max_tokens ?? 700, 500),
    });
    const parsed = extractJsonObject(response.content);
    const candidates = Array.isArray(parsed?.candidates)
      ? parsed.candidates.map(normalizeCandidate)
      : [];
    return {
      summary: normalizeText(parsed?.summary || ''),
      candidates,
      raw: response.content,
      fallback: false,
    };
  } catch (error) {
    return {
      summary: `候选 fact 生成降级: ${error.message}`,
      candidates: heuristicCandidates(payload).map(normalizeCandidate),
      raw: null,
      fallback: true,
      error,
    };
  }
}

export function buildJsonPatchFromCandidates(currentMemory = {}, candidates = [], context = {}) {
  const nextCandidates = Array.isArray(candidates) ? candidates : [];
  const currentValues = {
    facts: new Set((currentMemory.facts || []).map((item) => canonicalizeMemoryValue(item, 'facts')).filter(Boolean)),
    preferences: new Set((currentMemory.preferences || []).map((item) => canonicalizeMemoryValue(item, 'preferences')).filter(Boolean)),
    avoidances: new Set((currentMemory.avoidances || []).map((item) => canonicalizeMemoryValue(item, 'avoidances')).filter(Boolean)),
  };
  const globalValues = new Set([
    ...currentValues.facts,
    ...currentValues.preferences,
    ...currentValues.avoidances,
  ]);
  const operations = [];
  const newMemoryItems = [];

  for (const rawCandidate of nextCandidates) {
    const candidate = normalizeCandidate(rawCandidate);
    if (!ALLOWED_BUCKETS.has(candidate.bucket)) {
      continue;
    }
    if (!candidate.value || candidate.confidence < 0.65) {
      continue;
    }
    const dedupeKey = canonicalizeMemoryValue(candidate.value, candidate.bucket);
    if (!dedupeKey || currentValues[candidate.bucket].has(dedupeKey) || globalValues.has(dedupeKey)) {
      continue;
    }
    currentValues[candidate.bucket].add(dedupeKey);
    globalValues.add(dedupeKey);
    operations.push({
      op: 'add',
      path: `/${escapeJsonPointer(candidate.bucket)}/-`,
      value: candidate.value,
    });
    newMemoryItems.push({
      id: generateMemoryItemId(candidate.bucket),
      bucket: candidate.bucket,
      value: candidate.value,
      confidence: candidate.confidence,
      source_turn_id: context.turnId || '',
      source_intent: context.intent || '',
      evidence: candidate.reason || '',
      first_seen_at: nowIso(),
      last_seen_at: nowIso(),
      status: 'active',
      write_count: 1,
    });
    if (operations.length >= 3) {
      break;
    }
  }

  if (operations.length > 0) {
    operations.push({
      op: 'replace',
      path: '/updated_at',
      value: nowIso(),
    });
  }

  return { operations, newMemoryItems };
}

function migrateStringsToMemoryItems(memory = {}) {
  const items = [];
  for (const bucket of ['facts', 'preferences', 'avoidances']) {
    const strings = Array.isArray(memory[bucket]) ? memory[bucket] : [];
    for (const value of strings) {
      const text = normalizeText(value);
      if (!text) continue;
      items.push({
        id: generateMemoryItemId(bucket),
        bucket,
        value: text,
        confidence: null,
        source_turn_id: null,
        source_intent: null,
        evidence: null,
        first_seen_at: null,
        last_seen_at: null,
        status: 'active',
        write_count: 1,
      });
    }
  }
  return items;
}

export function writeLongTermMemoryPatch({ userId = 'default', operations = [], newMemoryItems = [] } = {}) {
  const currentMemory = loadLongTermMemory(userId);
  if (!Array.isArray(operations) || operations.length === 0) {
    return {
      changed: false,
      filePath: getMemoryFilePath(userId),
      currentMemory,
      nextMemory: currentMemory,
      operations: [],
      newMemoryItems: [],
    };
  }
  let nextMemory = applyJsonPatch(currentMemory, operations);
  if (!nextMemory.schema_version) {
    nextMemory.schema_version = CURRENT_SCHEMA_VERSION;
  }
  if (!Array.isArray(nextMemory.memory_items)) {
    nextMemory.memory_items = migrateStringsToMemoryItems(nextMemory);
  }
  for (const item of newMemoryItems) {
    nextMemory.memory_items.push(item);
  }
  const filePath = writeLongTermMemory(userId, nextMemory);
  return {
    changed: true,
    filePath,
    currentMemory,
    nextMemory,
    operations,
    newMemoryItems,
  };
}

export async function runMemoryWriterForTurn(payload = {}) {
  const userId = payload.userId || 'default';
  const currentMemory = loadLongTermMemory(userId);
  const userProfile = loadUserProfile(userId);
  const tracePayload = {
    taskId: payload.taskId,
    turnId: payload.turnId,
    userId,
    sessionId: payload.sessionId,
    source: payload.source,
    intent: payload.intent,
    userQuery: payload.userQuery,
    mainSummary: payload.mainSummary,
    routeReason: payload.routeReason,
    traceOutput: payload.traceOutput,
    ragSummary: payload.ragSummary,
    shortMemorySummary: payload.shortMemorySummary,
    longTermMemory: currentMemory,
    userProfile,
  };

  const candidateResult = await generateCandidateFacts(tracePayload);
  const stickyHero = payload.stickyHero || null;
  const { kept: filteredCandidates, dropped: hallucinatedCandidates } = filterHallucinatedCandidates(
    candidateResult.candidates,
    stickyHero,
  );
  if (hallucinatedCandidates.length > 0) {
    appendAgentTrace({
      task_id: payload.taskId || '',
      turn_id: payload.turnId || '',
      user_id: userId,
      session_id: payload.sessionId || 'default',
      source: 'memory_writer',
      user_query: payload.userQuery || '',
      orchestration_input: payload.userQuery || '',
      intent: payload.intent || 'unknown',
      trace_type: 'memory_writer_hallucination_filtered',
      route_reason: '反幻觉过滤：丢弃含主角外英雄名的候选事实',
      status: 'warn',
      output: {
        stage: 'memory_writer_filter',
        sticky_hero: stickyHero?.hero || null,
        dropped_count: hallucinatedCandidates.length,
        kept_count: filteredCandidates.length,
        dropped: hallucinatedCandidates,
      },
    });
  }
  const { operations, newMemoryItems } = buildJsonPatchFromCandidates(currentMemory, filteredCandidates, {
    turnId: payload.turnId,
    intent: payload.intent,
    userQuery: payload.userQuery,
  });
  const writeResult = writeLongTermMemoryPatch({ userId, operations, newMemoryItems });

  let vikingResult = null;
  if (config.memory.mode === 'viking') {
    try {
      const messages = [];
      if (payload.userQuery) {
        messages.push({ role: 'user', content: payload.userQuery });
      }
      if (payload.mainSummary || payload.traceOutput) {
        const assistantContent = [
          payload.mainSummary || '',
          payload.traceOutput ? `意图: ${payload.intent || 'unknown'}` : '',
          candidateResult.candidates.length > 0
            ? `沉淀候选: ${candidateResult.candidates.map((c) => `[${c.bucket}]${c.value}`).join('; ')}`
            : '',
        ].filter(Boolean).join(' | ');
        if (assistantContent) {
          messages.push({ role: 'assistant', content: assistantContent });
        }
      }
      const topCandidate = candidateResult.candidates[0];
      const layer = inferMemoryLayer({
        source: 'memory_writer',
        bucket: topCandidate?.bucket || '',
        confidence: topCandidate?.confidence || 0,
        isEvent: false,
      });
      const rawSummary = messages.map((m) => `${m.role}:${m.content}`).join(' | ');
      const layeredSummary = encodeLayerSummary(layer, rawSummary);
      vikingResult = await vikingAddEvent({
        messages,
        summary: layeredSummary,
        user_id: userId,
        assistant_id: 'game_ai_agent',
        conversation_id: payload.sessionId || payload.turnId || '',
        group_id: payload.sessionId || '',
      });
    } catch (vikingError) {
      vikingResult = {
        error: true,
        message: vikingError.message,
        code: vikingError.code,
      };
    }
  }

  return {
    userId,
    summary: candidateResult.summary,
    candidates: candidateResult.candidates,
    operations,
    newMemoryItems,
    writeResult,
    vikingResult,
    fallback: candidateResult.fallback,
    raw: candidateResult.raw,
    error: candidateResult.error || null,
  };
}

export function triggerMemoryWriterForTurn(payload = {}) {
  const traceContext = {
    task_id: payload.taskId || '',
    turn_id: payload.turnId || '',
    user_id: payload.userId || 'default',
    session_id: payload.sessionId || 'default',
    source: 'memory_writer',
    user_query: payload.userQuery || '',
    orchestration_input: payload.userQuery || '',
    intent: payload.intent || 'unknown',
    trace_type: 'memory_writer',
    route_reason: '阶段 A：MemoryWriter 异步沉淀',
  };

  appendAgentTrace({
    ...traceContext,
    status: 'queued',
    output: {
      stage: 'memory_writer_queued',
      from_source: payload.source || 'unknown',
    },
  });

  void runMemoryWriterForTurn(payload)
    .then((result) => {
      appendAgentTrace({
        ...traceContext,
        status: result.writeResult.changed ? 'done' : 'skipped',
        output: {
          stage: 'memory_writer_done',
          summary: result.summary,
          fallback: result.fallback,
          candidate_count: result.candidates.length,
          operations: result.operations,
          changed: result.writeResult.changed,
          file_path: result.writeResult.filePath,
          viking_event_id: result.vikingResult?.data?.event_id || null,
          viking_error: result.vikingResult?.error ? result.vikingResult.message : null,
        },
      });
    })
    .catch((error) => {
      appendAgentTrace({
        ...traceContext,
        status: 'failed',
        error: {
          message: error.message,
        },
      });
    });
}
