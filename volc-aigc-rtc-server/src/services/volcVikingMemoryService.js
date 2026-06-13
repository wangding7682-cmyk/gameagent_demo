import { config } from '../config.js';
import { taskStore } from './taskFsmService.js';
import { safeFetchJson } from '../utils/http.js';

// Viking 检索内存缓存：key = `${userId}:${query}` -> { data, expiresAt }
const vikingSearchCache = new Map();
const VIKING_CACHE_TTL_MS = 50_000;

function assertVikingConfig() {
  const missing = [];
  if (!config.vikingMemory.apiKey) missing.push('VIKING_MEMORY_API_KEY');
  if (!config.vikingMemory.resourceId && !config.vikingMemory.collectionName) {
    missing.push('VIKING_MEMORY_RESOURCE_ID 或 VIKING_MEMORY_COLLECTION_NAME');
  }
  if (!config.vikingMemory.host) missing.push('VIKING_MEMORY_HOST');
  if (missing.length > 0) {
    const error = new Error(`Viking 记忆库配置缺失: ${missing.join(', ')}`);
    error.code = 'VIKING_MEMORY_CONFIG_MISSING';
    throw error;
  }
}

function buildVikingHeaders() {
  return {
    Authorization: `Bearer ${config.vikingMemory.apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function requestVikingApi(path, options = {}) {
  assertVikingConfig();
  const url = `https://${config.vikingMemory.host}${path}`;
  try {
    return await safeFetchJson(url, {
      method: options.method || 'POST',
      headers: {
        ...buildVikingHeaders(),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      timeoutMs: 5000,
    });
  } catch (error) {
    if (error.code && error.code.startsWith('HTTP_')) {
      throw error;
    }
    const wrapped = new Error(`Viking 记忆库网络错误: ${error.message}`);
    wrapped.code = 'VIKING_NETWORK_ERROR';
    wrapped.cause = error;
    throw wrapped;
  }
}

function buildCollectionIdentifier() {
  const body = {};
  if (config.vikingMemory.resourceId) {
    body.resource_id = config.vikingMemory.resourceId;
  }
  if (config.vikingMemory.collectionName) {
    body.collection_name = config.vikingMemory.collectionName;
  }
  return body;
}

function buildConversationSummary(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  return messages
    .map((m) => {
      const role = String(m.role || 'unknown').trim();
      const content = String(m.content || '').trim();
      if (!content) return '';
      const label = role === 'user' ? '用户' : role === 'assistant' ? '助手' : role;
      return `${label}：${content}`;
    })
    .filter(Boolean)
    .join('\n');
}

export async function vikingAddEvent(payload = {}) {
  const eventType = payload.event_type || config.vikingMemory.eventType || 'event_v1';
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const directSummary = payload.summary || '';
  const summary = directSummary || buildConversationSummary(messages);

  const body = {
    ...buildCollectionIdentifier(),
    event_type: eventType,
    memory_info: {
      summary,
    },
    user_id: payload.user_id || payload.userId || '',
    assistant_id: payload.assistant_id || payload.assistantId || 'game_ai_agent',
  };
  if (payload.conversation_id || payload.conversationId) {
    body.conversation_id = payload.conversation_id || payload.conversationId;
  }
  if (payload.group_id) {
    body.group_id = payload.group_id;
  }
  if (payload.time) {
    body.time = payload.time;
  }

  console.log(`[VikingAddEvent] event_type="${eventType}" user_id="${body.user_id}" assistant_id="${body.assistant_id}" conversation_id="${body.conversation_id || ''}" summary_len=${summary.length} messages_count=${messages.length}`);

  const result = await requestVikingApi(config.vikingMemory.addEventPath, {
    method: 'POST',
    body,
  });

  if (result && result.code === 0 && result.data) {
    const d = result.data;
    console.log(`[VikingAddEvent] => OK event_id="${d.event_id || 'N/A'}" event_type="${d.event_type || ''}" embedding_tokens=${d.usage?.embedding_tokens ?? 'N/A'} summary_returned="${(d.memory_info?.summary || '').slice(0, 60)}${(d.memory_info?.summary || '').length > 60 ? '...' : ''}"`);
  } else {
    console.log(`[VikingAddEvent] => FAIL code=${result?.code} message=${result?.message}`);
  }

  return result;
}

export async function vikingSearchProfile(payload = {}) {
  const body = {
    ...buildCollectionIdentifier(),
    query: payload.query || '',
    filter: {
      user_id: payload.user_id || payload.userId || '',
      memory_type: payload.memory_types || [config.vikingMemory.profileType || 'profile_v1'],
    },
    limit: Math.max(1, Math.min(5000, Number(payload.limit || config.memory.limit || 10))),
  };
  if (payload.assistant_id) {
    body.filter.assistant_id = payload.assistant_id;
  }

  const result = await requestVikingApi(config.vikingMemory.searchProfilePath, {
    method: 'POST',
    body,
  });

  if (result && result.code === 0 && result.data) {
    const items = result.data.result_list || [];
    console.log(`[VikingSearchProfile] query="${body.query}" user_id="${body.filter.user_id}" memory_types=[${body.filter.memory_type.join(',')}] limit=${body.limit} => count=${items.length}`);
    for (const [idx, item] of items.entries()) {
      const profileContent = item.memory_info?.user_profile || item.memory_info?.summary || '';
      const truncated = profileContent.length > 80 ? profileContent.slice(0, 80) + '...' : profileContent;
      console.log(`  [#${idx}] type=${item.memory_type} score=${typeof item.score === 'number' ? item.score.toFixed(4) : 'N/A'} profile="${truncated}"`);
    }
  } else {
    console.log(`[VikingSearchProfile] query="${body.query}" => code=${result?.code} message=${result?.message}`);
  }

  return result;
}

export async function vikingSearchEvent(payload = {}) {
  const body = {
    ...buildCollectionIdentifier(),
    query: payload.query || '',
    filter: {
      user_id: payload.user_id || payload.userId || '',
      memory_type: payload.memory_types || [config.vikingMemory.eventType || 'event_v1'],
    },
    limit: Math.max(1, Math.min(5000, Number(payload.limit || config.memory.limit || 10))),
  };
  if (payload.assistant_id) {
    body.filter.assistant_id = payload.assistant_id;
  }

  const result = await requestVikingApi(config.vikingMemory.searchEventPath, {
    method: 'POST',
    body,
  });

  if (result && result.code === 0 && result.data) {
    const items = result.data.result_list || [];
    console.log(`[VikingSearchEvent] query="${body.query}" user_id="${body.filter.user_id}" memory_types=[${body.filter.memory_type.join(',')}] limit=${body.limit} => count=${items.length}`);
    for (const [idx, item] of items.entries()) {
      const summaryText = item.memory_info?.summary || '';
      const truncated = summaryText.length > 80 ? summaryText.slice(0, 80) + '...' : summaryText;
      console.log(`  [#${idx}] type=${item.memory_type} score=${typeof item.score === 'number' ? item.score.toFixed(4) : 'N/A'} event_id=${item.event_id || 'N/A'} summary="${truncated}"`);
    }
  } else {
    console.log(`[VikingSearchEvent] query="${body.query}" => code=${result?.code} message=${result?.message}`);
  }

  return result;
}

export async function vikingSearchMemory(payload = {}, turnId = '') {
  const defaultMemoryTypes = [
    config.vikingMemory.eventType || 'event_v1',
    config.vikingMemory.profileType || 'profile_v1',
  ];
  const userId = payload.user_id || payload.userId || '';
  const query = payload.query || '';
  const cacheKey = `${userId}:${query}`;
  // 1. 单轮缓存（turn-level）
  if (turnId) {
    const turnCached = taskStore.getTurnCache(turnId, `viking:${cacheKey}`);
    if (turnCached !== undefined) {
      console.log(`[VikingSearchMemory] 命中单轮缓存 turnId=${turnId} query="${query}" user_id="${userId}"`);
      return turnCached;
    }
  }
  const now = Date.now();
  // 2. 进程内存缓存
  const cached = vikingSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if (turnId) taskStore.setTurnCache(turnId, `viking:${cacheKey}`, cached.data);
    return cached.data;
  }

  const body = {
    ...buildCollectionIdentifier(),
    query,
    filter: {
      user_id: userId,
      memory_type: payload.memory_types || defaultMemoryTypes,
    },
    limit: Math.max(1, Math.min(5000, Number(payload.limit || config.memory.limit || 10))),
  };
  if (payload.assistant_id) {
    body.filter.assistant_id = payload.assistant_id;
  }
  const result = await requestVikingApi(config.vikingMemory.searchMemoryPath, {
    method: 'POST',
    body,
  });
  if (result && result.code === 0 && result.data) {
    const items = result.data.result_list || [];
    console.log(`[VikingSearchMemory] query="${body.query}" user_id="${body.filter.user_id}" memory_types=[${body.filter.memory_type.join(',')}] limit=${body.limit} => count=${items.length}`);
    for (const [idx, item] of items.entries()) {
      const summaryText = item.memory_info?.summary || '';
      const truncated = summaryText.length > 80 ? summaryText.slice(0, 80) + '...' : summaryText;
      console.log(`  [#${idx}] type=${item.memory_type} score=${typeof item.score === 'number' ? item.score.toFixed(4) : 'N/A'} event_id=${item.event_id || 'N/A'} summary="${truncated}"`);
    }
  } else {
    console.log(`[VikingSearchMemory] query="${body.query}" => code=${result?.code} message=${result?.message}`);
  }

  vikingSearchCache.set(cacheKey, { data: result, expiresAt: now + VIKING_CACHE_TTL_MS });
  if (turnId) taskStore.setTurnCache(turnId, `viking:${cacheKey}`, result);
  return result;
}

export async function vikingGetContext(payload = {}) {
  const body = {
    ...buildCollectionIdentifier(),
    conversation_id: payload.conversation_id || payload.conversationId || 'default',
    query: payload.query || '',
    event_search_config: payload.event_search_config || {
      filter: {
        user_id: payload.user_id || payload.userId || '',
        memory_type: [config.vikingMemory.eventType || 'event_v1'],
      },
      limit: 10,
    },
    profile_search_config: payload.profile_search_config || {
      filter: {
        user_id: payload.user_id || payload.userId || '',
        memory_type: [config.vikingMemory.profileType || 'profile_v1'],
      },
      limit: 5,
    },
  };
  return requestVikingApi(config.vikingMemory.getContextPath, {
    method: 'POST',
    body,
  });
}

export async function vikingCollectionInfo() {
  const body = {
    ...buildCollectionIdentifier(),
  };
  return requestVikingApi(config.vikingMemory.collectionInfoPath, {
    method: 'POST',
    body,
  });
}

export async function checkVikingMemoryHealth() {
  const summary = {
    configured: Boolean(
      config.vikingMemory.apiKey &&
      (config.vikingMemory.resourceId || config.vikingMemory.collectionName) &&
      config.vikingMemory.host
    ),
    host: config.vikingMemory.host,
    resourceIdConfigured: Boolean(config.vikingMemory.resourceId),
    collectionName: config.vikingMemory.collectionName,
    apiKeyConfigured: Boolean(config.vikingMemory.apiKey),
  };
  if (!summary.configured) {
    return {
      ...summary,
      ready: false,
      reachable: false,
      checkedAt: new Date().toISOString(),
      message: 'Viking 记忆库配置不完整',
    };
  }
  try {
    const result = await vikingSearchProfile({
      query: 'healthcheck',
      user_id: 'healthcheck_probe',
      limit: 1,
    });
    const isOk = result && (result.code === 0 || result.code === undefined);
    return {
      ...summary,
      ready: isOk,
      reachable: isOk,
      checkedAt: new Date().toISOString(),
      probeResult: {
        code: result?.code,
        message: result?.message,
        count: result?.data?.count,
      },
    };
  } catch (error) {
    return {
      ...summary,
      ready: false,
      reachable: false,
      checkedAt: new Date().toISOString(),
      error: {
        message: error.message,
        code: error.code,
      },
    };
  }
}
