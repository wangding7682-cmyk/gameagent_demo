import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { taskStore } from './taskFsmService.js';

const DATA_ROOT = path.resolve(config.projectRoot, './data');

// Overlay 三小时 TTL，惰性回退：超时仅在读取时忽略，不真删文件，避免并发问题。
const OVERLAY_TTL_MS = 3 * 60 * 60 * 1000;

// 长期记忆本地缓存：userId -> { data, expiresAt }
const ltmCache = new Map();
const LTM_CACHE_TTL_MS = 50_000;

const DEFAULT_PERSONA = {
  id: 'main-agent-default',
  name: '小纸',
  role: '游戏战术顾问',
  personality: ['干练但不啰嗦', '像陪练而不是老师', '能根据紧急程度调整语气'],
  speaking_style: {
    tone: '轻松但有专业感',
    emoji_usage: '极少',
    slang_level: '适中',
    sentence_length: '短句为主，复杂内容分条',
    forbidden_phrases: ['作为一个AI语言模型', '根据我的分析', '请注意'],
  },
  game_knowledge_scope: {
    games: ['英雄联盟'],
    depth: '钻石以上段位理解',
    role_preference: '偏向打野和中单视角',
  },
};

const DEFAULT_USER_PROFILE = {
  user_id: 'default',
  game_profile: {
    primary_game: '英雄联盟',
    rank_tier: '未知',
    preferred_roles: [],
    frequent_champions: [],
    play_style: '未知',
  },
  communication_preferences: {
    detail_level: 'medium',
    likes_examples: true,
    response_language: '中文',
    tts_acceptable: true,
  },
};

const DEFAULT_LONG_TERM_MEMORY = {
  user_id: 'default',
  schema_version: 2,
  facts: [],
  preferences: [],
  avoidances: [],
  memory_items: [],
  updated_at: null,
};

const DEFAULT_AGENT_PREFERENCES = {
  llm: {
    main_agent: { temperature: 0.1, max_tokens: 700 },
    strategy_agent: { temperature: 0.2, max_tokens: 900 },
    video_agent: { temperature: 0.2, max_tokens: 300 },
  },
  output_limits: {
    emotional_reply_min: 8,
    emotional_reply_max: 16,
    understanding_reply_min: 18,
    understanding_reply_max: 45,
    branch_wait_reply_min: 16,
    branch_wait_reply_max: 36,
    main_summary_max: 180,
    route_reason_max: 120,
  },
  behavior: {
    expose_internal_agent_names: false,
    require_rag_for_all_intents: true,
    strategy_default_output_mode: 'text_only',
  },
};

function safeId(value = 'default') {
  return String(value || 'default')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80) || 'default';
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn('[AgentProfileLoader] 读取 JSON 失败，使用兜底配置', {
      filePath,
      message: error.message,
    });
    return fallback;
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const output = { ...(base || {}) };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function loadPersona(personaId = 'main-agent') {
  const id = safeId(personaId || 'main-agent');
  const filePath = path.join(DATA_ROOT, 'personas', `${id}.json`);
  return deepMerge(DEFAULT_PERSONA, readJsonFile(filePath, {}));
}

// ---- Baseline + Overlay 路径解析 ----
// 读取顺序：overlay (未过期) > 旧 legacy 文件 > baseline > 默认。
// 写入路径统一指向 overlay；baseline 仅在 createUserProfile 时落盘，且后续不再修改。

function getUserPaths(id) {
  return {
    overlay: path.join(DATA_ROOT, 'users', `${id}.overlay.json`),
    baseline: path.join(DATA_ROOT, 'users', `${id}.baseline.json`),
    legacy: path.join(DATA_ROOT, 'users', `${id}.json`),
  };
}

function getMemoryPaths(id) {
  return {
    overlay: path.join(DATA_ROOT, 'memory', `${id}.overlay.longterm.json`),
    baseline: path.join(DATA_ROOT, 'memory', `${id}.baseline.longterm.json`),
    legacy: path.join(DATA_ROOT, 'memory', `${id}.longterm.json`),
  };
}

// 取 overlay 数据；若过期返回 null 让上层回退 baseline。
function readOverlayIfFresh(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const overlay = readJsonFile(filePath, null);
  if (!overlay || typeof overlay !== 'object') return null;
  const updatedAt = Date.parse(overlay.updated_at || '') || 0;
  if (!updatedAt) return null;
  if (Date.now() - updatedAt > OVERLAY_TTL_MS) return null;
  return overlay;
}

// 兼容旧版本：将 legacy {id}.json / {id}.longterm.json 视为 baseline 提升。
function readBaselineWithLegacyFallback(baselinePath, legacyPath, fallback) {
  if (fs.existsSync(baselinePath)) {
    return readJsonFile(baselinePath, fallback);
  }
  if (fs.existsSync(legacyPath)) {
    const legacy = readJsonFile(legacyPath, null);
    if (legacy && typeof legacy === 'object') {
      try {
        fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
        fs.writeFileSync(baselinePath, JSON.stringify(legacy, null, 2), 'utf8');
      } catch (e) {
        console.warn('[AgentProfileLoader] baseline 升级失败', e?.message);
      }
      return legacy;
    }
  }
  return fallback;
}

export function loadUserProfile(userId = 'default') {
  const id = safeId(userId || 'default');
  const { overlay: overlayPath, baseline: baselinePath, legacy: legacyPath } = getUserPaths(id);
  const overlay = readOverlayIfFresh(overlayPath);
  if (overlay) {
    const merged = deepMerge(DEFAULT_USER_PROFILE, overlay);
    return { ...merged, user_id: merged.user_id || id };
  }
  const baseline = readBaselineWithLegacyFallback(baselinePath, legacyPath, {});
  const profile = deepMerge(DEFAULT_USER_PROFILE, baseline);
  return { ...profile, user_id: profile.user_id || id };
}

export function loadLongTermMemory(userId = 'default', turnId = '') {
  const id = safeId(userId || 'default');
  // 1. 单轮缓存（turn-level）
  if (turnId) {
    const turnCached = taskStore.getTurnCache(turnId, `ltm:${id}`);
    if (turnCached !== undefined) {
      console.log(`[LoadLongTermMemory] 命中单轮缓存 turnId=${turnId} userId=${id}`);
      return turnCached;
    }
  }
  const now = Date.now();
  // 2. 进程内存缓存
  const cached = ltmCache.get(id);
  if (cached && cached.expiresAt > now) {
    const result = { ...cached.data, user_id: cached.data.user_id || id };
    if (turnId) taskStore.setTurnCache(turnId, `ltm:${id}`, result);
    return result;
  }
  // 3. 文件回退（overlay 优先，其次 baseline）
  const { overlay: overlayPath, baseline: baselinePath, legacy: legacyPath } = getMemoryPaths(id);
  const overlay = readOverlayIfFresh(overlayPath);
  let memorySource;
  if (overlay) {
    memorySource = overlay;
  } else {
    memorySource = readBaselineWithLegacyFallback(baselinePath, legacyPath, {});
  }
  const memory = deepMerge(DEFAULT_LONG_TERM_MEMORY, memorySource);
  const result = { ...memory, user_id: memory.user_id || id };
  // overlay 期间使用更短缓存，避免长期记忆/喜好回退后用户仍读到老 overlay
  const cacheTtl = overlay ? Math.min(LTM_CACHE_TTL_MS, 10_000) : LTM_CACHE_TTL_MS;
  ltmCache.set(id, { data: result, expiresAt: now + cacheTtl });
  if (turnId) taskStore.setTurnCache(turnId, `ltm:${id}`, result);
  return result;
}

// ---- Overlay 写入 ----
// 任意修改 user profile 或 long term memory 都写入 overlay 文件并刷新 updated_at。

export function writeUserProfileOverlay(userId, nextProfile) {
  const id = safeId(userId || 'default');
  const { overlay } = getUserPaths(id);
  fs.mkdirSync(path.dirname(overlay), { recursive: true });
  const payload = {
    ...nextProfile,
    user_id: nextProfile?.user_id || id,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(overlay, JSON.stringify(payload, null, 2), 'utf8');
  return overlay;
}

export function writeLongTermMemoryOverlay(userId, nextMemory) {
  const id = safeId(userId || 'default');
  const { overlay } = getMemoryPaths(id);
  fs.mkdirSync(path.dirname(overlay), { recursive: true });
  const payload = {
    ...nextMemory,
    user_id: nextMemory?.user_id || id,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(overlay, JSON.stringify(payload, null, 2), 'utf8');
  ltmCache.delete(id);
  return overlay;
}

// 主动重置：删除 overlay 文件，立即回到 baseline。
export function resetUserOverlay(userId) {
  const id = safeId(userId || 'default');
  const { overlay: userOverlay } = getUserPaths(id);
  const { overlay: memOverlay } = getMemoryPaths(id);
  for (const p of [userOverlay, memOverlay]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
  ltmCache.delete(id);
  return { user_id: id };
}

// 计算 overlay 状态（供 UI 展示剩余时间 / 是否生效）
export function getOverlayStatus(userId) {
  const id = safeId(userId || 'default');
  const { overlay: userOverlay } = getUserPaths(id);
  const { overlay: memOverlay } = getMemoryPaths(id);

  function inspect(filePath) {
    if (!fs.existsSync(filePath)) return { exists: false, active: false, expires_at: null, expires_in_ms: 0 };
    const data = readJsonFile(filePath, null);
    const updatedAt = Date.parse(data?.updated_at || '') || 0;
    if (!updatedAt) return { exists: true, active: false, expires_at: null, expires_in_ms: 0 };
    const expiresAt = updatedAt + OVERLAY_TTL_MS;
    const remain = expiresAt - Date.now();
    return {
      exists: true,
      active: remain > 0,
      updated_at: new Date(updatedAt).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      expires_in_ms: Math.max(0, remain),
    };
  }

  return {
    user_id: id,
    overlay_ttl_ms: OVERLAY_TTL_MS,
    user_profile: inspect(userOverlay),
    long_term_memory: inspect(memOverlay),
  };
}

export function loadAgentPreferences() {
  const filePath = path.join(DATA_ROOT, 'preferences', 'agent-preferences.json');
  return deepMerge(DEFAULT_AGENT_PREFERENCES, readJsonFile(filePath, {}));
}

export function getAgentProfileBundle({ userId = 'default', personaId = 'main-agent' } = {}) {
  return {
    persona: loadPersona(personaId),
    userProfile: loadUserProfile(userId),
    longTermMemory: loadLongTermMemory(userId),
    preferences: loadAgentPreferences(),
  };
}

export function listUserProfiles() {
  const dir = path.join(DATA_ROOT, 'users');
  const idSet = new Set();
  try {
    for (const name of fs.readdirSync(dir)) {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.json')) continue;
      let id;
      if (lower.endsWith('.baseline.json')) id = name.slice(0, -'.baseline.json'.length);
      else if (lower.endsWith('.overlay.json')) id = name.slice(0, -'.overlay.json'.length);
      else id = name.slice(0, -'.json'.length);
      if (id) idSet.add(id);
    }
  } catch (e) {
    return [];
  }
  const list = [];
  for (const id of idSet) {
    try {
      const profile = loadUserProfile(id);
      const overlayStatus = getOverlayStatus(id);
      const memoryPaths = getMemoryPaths(id);
      const hasLtm = fs.existsSync(memoryPaths.baseline)
        || fs.existsSync(memoryPaths.legacy)
        || fs.existsSync(memoryPaths.overlay);
      list.push({
        user_id: profile.user_id || id,
        display_name: profile.display_name || profile.user_id || id,
        primary_game: profile.game_profile?.primary_game || '',
        rank_tier: profile.game_profile?.rank_tier || '',
        preferred_roles: Array.isArray(profile.game_profile?.preferred_roles)
          ? profile.game_profile.preferred_roles
          : [],
        has_long_term_memory: hasLtm,
        overlay: {
          user_profile_active: overlayStatus.user_profile.active,
          long_term_memory_active: overlayStatus.long_term_memory.active,
          expires_in_ms: Math.max(
            overlayStatus.user_profile.expires_in_ms,
            overlayStatus.long_term_memory.expires_in_ms,
          ),
        },
      });
    } catch (e) {
      list.push({ user_id: id, display_name: id, has_long_term_memory: false });
    }
  }
  list.sort((a, b) => {
    if (a.user_id === 'default') return -1;
    if (b.user_id === 'default') return 1;
    return String(a.user_id).localeCompare(String(b.user_id));
  });
  return list;
}

export function createUserProfile({ userId = '', displayName = '' } = {}) {
  const id = safeId(userId || '').toLowerCase();
  if (!id || id === 'default') {
    throw new Error('用户 ID 非法');
  }
  const { baseline: userBaseline, legacy: userLegacy } = getUserPaths(id);
  if (fs.existsSync(userBaseline) || fs.existsSync(userLegacy)) {
    throw new Error(`用户 ${id} 已存在`);
  }
  const profile = {
    ...DEFAULT_USER_PROFILE,
    user_id: id,
    display_name: displayName || id,
  };
  fs.mkdirSync(path.dirname(userBaseline), { recursive: true });
  fs.writeFileSync(userBaseline, JSON.stringify(profile, null, 2), 'utf8');

  const { baseline: memoryBaseline } = getMemoryPaths(id);
  if (!fs.existsSync(memoryBaseline)) {
    fs.mkdirSync(path.dirname(memoryBaseline), { recursive: true });
    const ltm = { ...DEFAULT_LONG_TERM_MEMORY, user_id: id };
    fs.writeFileSync(memoryBaseline, JSON.stringify(ltm, null, 2), 'utf8');
  }
  ltmCache.delete(id);
  return profile;
}
