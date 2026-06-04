import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { taskStore } from './taskFsmService.js';

const DATA_ROOT = path.resolve(config.projectRoot, './data');

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

export function loadUserProfile(userId = 'default') {
  const id = safeId(userId || 'default');
  const filePath = path.join(DATA_ROOT, 'users', `${id}.json`);
  const profile = deepMerge(DEFAULT_USER_PROFILE, readJsonFile(filePath, {}));
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
  // 3. 文件回退
  const filePath = path.join(DATA_ROOT, 'memory', `${id}.longterm.json`);
  const memory = deepMerge(DEFAULT_LONG_TERM_MEMORY, readJsonFile(filePath, {}));
  const result = { ...memory, user_id: memory.user_id || id };
  ltmCache.set(id, { data: result, expiresAt: now + LTM_CACHE_TTL_MS });
  if (turnId) taskStore.setTurnCache(turnId, `ltm:${id}`, result);
  return result;
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
