import { config, getMemoryConfigSummary } from '../config.js';
import { safeFetchText } from '../utils/http.js';

function assertMemoryConfig() {
  const missing = [];
  if (!config.memory.host) missing.push('VOLC_MEMORY_HOST');
  if (!config.memory.apiKey) missing.push('VOLC_MEMORY_API_KEY');

  if (missing.length > 0) {
    const error = new Error(`缺少环境变量: ${missing.join(', ')}`);
    error.code = 'VOLC_MEMORY_CONFIG_MISSING';
    throw error;
  }
}

function normalizeBaseUrl(host) {
  const raw = String(host || '').trim();
  if (!raw) {
    return '';
  }
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withProtocol.replace(/\/$/, '');
}

function buildPath(template, params = {}) {
  return String(template || '')
    .replace('{memoryId}', encodeURIComponent(params.memoryId || ''))
    .replace('{eventId}', encodeURIComponent(params.eventId || ''));
}

function buildHeaders() {
  return {
    Authorization: `Token ${config.memory.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function requestMemoryApi(path, options = {}) {
  assertMemoryConfig();
  const baseUrl = normalizeBaseUrl(config.memory.host);
  const url = `${baseUrl}${path}`;
  
  let text = '';
  try {
    text = await safeFetchText(url, {
      method: options.method || 'GET',
      headers: {
        ...buildHeaders(),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      timeoutMs: 8000,
    });
  } catch (error) {
    // safeFetchText throws Error(`HTTP ${status}: ${text}`)
    // Let's parse it if possible
    if (error.message.startsWith('HTTP ')) {
      const match = error.message.match(/^HTTP (\d+): (.*)$/s);
      if (match) {
        const status = match[1];
        const errText = match[2];
        let json = null;
        try { json = JSON.parse(errText); } catch (_) {}
        const wrappedError = new Error(
          json?.message || json?.detail || `Mem0 请求失败: HTTP ${status}`
        );
        wrappedError.code = `HTTP_${status}`;
        wrappedError.response = json || errText;
        throw wrappedError;
      }
    }
    throw error;
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    json = null;
  }

  return json;
}

function normalizeMemoryItem(item = {}) {
  return {
    id: item.id || item.memory_id || '',
    memoryId: item.id || item.memory_id || '',
    summary: item.memory || item.summary || item.value || '',
    content: item.memory || item.content || item.summary || item.value || '',
    score: item.score || item.similarity || 0,
    categories: item.categories || [],
    metadata: item.metadata || {},
    userId: item.user_id || item.userId || '',
    agentId: item.agent_id || item.agentId || item.metadata?.agentId || '',
    createdAt: item.created_at || item.createdAt || '',
    updatedAt: item.updated_at || item.updatedAt || '',
    raw: item,
  };
}

function buildAddPayload(payload = {}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const normalizedMessages =
    messages.length > 0
      ? messages
      : [
          {
            role: 'user',
            content: payload.content || payload.summary || '',
          },
        ].filter((item) => item.content);

  return {
    messages: normalizedMessages,
    user_id: payload.userId,
    async_mode: payload.asyncMode !== false,
  };
}

export async function searchVolcMemory(payload = {}) {
  const body = {
    query: payload.query || '',
    user_id: payload.userId || '',
    limit: Number(payload.limit || config.memory.limit || 10),
  };
  const json = await requestMemoryApi(config.memory.searchPath, {
    method: 'POST',
    body,
  });
  const results = Array.isArray(json?.results) ? json.results : [];
  return {
    profile: null,
    count: results.length,
    items: results.map(normalizeMemoryItem),
    raw: json,
  };
}

export async function saveVolcMemory(payload = {}) {
  const json = await requestMemoryApi(config.memory.addPath, {
    method: 'POST',
    body: buildAddPayload(payload),
  });
  return {
    count: Array.isArray(json?.results) ? json.results.length : 0,
    record: null,
    results: json?.results || [],
    raw: json,
  };
}

export async function listVolcMemory(payload = {}) {
  const params = new URLSearchParams();
  if (payload.userId) {
    params.set('user_id', payload.userId);
  }
  if (payload.limit) {
    params.set('limit', String(payload.limit));
  }
  const path = `${config.memory.listPath}${params.toString() ? `?${params.toString()}` : ''}`;
  const json = await requestMemoryApi(path);
  const results = Array.isArray(json?.results)
    ? json.results
    : Array.isArray(json)
      ? json
      : [];
  return {
    count: results.length,
    items: results.map(normalizeMemoryItem),
    profile: null,
    raw: json,
  };
}

export async function getVolcMemory(memoryId) {
  const json = await requestMemoryApi(buildPath(config.memory.itemPathTemplate, { memoryId }));
  return {
    item: normalizeMemoryItem(json),
    raw: json,
  };
}

export async function getVolcMemoryHistory(memoryId) {
  const json = await requestMemoryApi(buildPath(config.memory.historyPathTemplate, { memoryId }));
  const history = Array.isArray(json?.results)
    ? json.results
    : Array.isArray(json)
      ? json
      : [];
  return {
    history,
    raw: json,
  };
}

export async function updateVolcMemory(memoryId, value) {
  const json = await requestMemoryApi(buildPath(config.memory.itemPathTemplate, { memoryId }), {
    method: 'PUT',
    body: {
      text: value,
    },
  });
  return {
    item: normalizeMemoryItem(json),
    raw: json,
  };
}

export async function deleteVolcMemory(memoryId) {
  const json = await requestMemoryApi(buildPath(config.memory.itemPathTemplate, { memoryId }), {
    method: 'DELETE',
  });
  return {
    deleted: true,
    memoryId,
    raw: json,
  };
}

export async function deleteAllVolcMemory(payload = {}) {
  const params = new URLSearchParams();
  if (payload.userId) {
    params.set('user_id', payload.userId);
  }
  const path = `${config.memory.listPath}${params.toString() ? `?${params.toString()}` : ''}`;
  const json = await requestMemoryApi(path, {
    method: 'DELETE',
  });
  return {
    deleted: true,
    userId: payload.userId || '',
    raw: json,
  };
}

export async function getVolcMemoryJobStatus(eventId) {
  const json = await requestMemoryApi(buildPath(config.memory.jobPathTemplate, { eventId }));
  return json;
}

export async function checkVolcMemoryHealth(payload = {}) {
  try {
    const result = await listVolcMemory({
      userId: payload.userId || 'healthcheck_probe',
      limit: 1,
    });
    return {
      ready: true,
      reachable: true,
      checkedAt: new Date().toISOString(),
      provider: 'volc',
      config: getMemoryConfigSummary(),
      probe: {
        count: result.count,
      },
    };
  } catch (error) {
    return {
      ready: false,
      reachable: false,
      checkedAt: new Date().toISOString(),
      provider: 'volc',
      config: getMemoryConfigSummary(),
      error: {
        message: error.message,
        code: error.code,
      },
    };
  }
}
