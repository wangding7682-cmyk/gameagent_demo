// 轻量 RAG 多层缓存：避免单轮对话内反复跑 embedding/召回。
// - 全召回结果缓存 (query+sources hash → result)：120s TTL
// - query embedding 缓存：120s TTL，复用 rerank 阶段
// - chunk content embedding 缓存：10min TTL（按内容哈希），跨 query 复用
const RESULT_TTL_MS = 120_000;
const QUERY_EMB_TTL_MS = 120_000;
const CHUNK_EMB_TTL_MS = 600_000;
const MAX_ENTRIES = 200;

function makeLRU(maxSize) {
  const store = new Map();
  return {
    get(key) {
      const v = store.get(key);
      if (!v) return undefined;
      if (v.expiresAt < Date.now()) {
        store.delete(key);
        return undefined;
      }
      // LRU touch
      store.delete(key);
      store.set(key, v);
      return v.value;
    },
    set(key, value, ttl) {
      if (store.size >= maxSize) {
        const firstKey = store.keys().next().value;
        if (firstKey !== undefined) store.delete(firstKey);
      }
      store.set(key, { value, expiresAt: Date.now() + ttl });
    },
    delete(key) { store.delete(key); },
    size() { return store.size; },
  };
}

const resultCache = makeLRU(MAX_ENTRIES);
const queryEmbCache = makeLRU(MAX_ENTRIES);
const chunkEmbCache = makeLRU(MAX_ENTRIES * 4);

function fnv1a(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

export function hashKey(text) {
  return fnv1a(String(text || ''));
}

// 召回结果缓存 key 必须包含 sources 指纹（同 query + 不同来源开关 = 不同结果）
export function buildResultKey({ query, sourcesFingerprint, rerankStrategy, topK }) {
  return `${hashKey(query)}|${sourcesFingerprint}|${rerankStrategy}|${topK}`;
}

export function buildSourcesFingerprint(sources = []) {
  const parts = sources.map((s) => {
    const item = `${s.type}:${s.domain || ''}:${s.enabled !== false ? 1 : 0}:${s.topK || 5}`;
    if (s.type === 'user_local' && Array.isArray(s.items)) {
      // user_local 包含 chunk 数据，需要把内容指纹也算进去
      const itemsHash = hashKey(s.items.map((it) => `${it.id}:${(it.content || '').length}`).join('|'));
      return `${item}:${itemsHash}`;
    }
    if (s.type === 'user_cloud') {
      return `${item}:${hashKey(s.serviceResourceId || '')}`;
    }
    return item;
  });
  return hashKey(parts.join(';'));
}

export const ragCache = {
  getResult(key) { return resultCache.get(key); },
  setResult(key, value) { resultCache.set(key, value, RESULT_TTL_MS); },

  getQueryEmbedding(query) {
    return queryEmbCache.get(hashKey(query));
  },
  setQueryEmbedding(query, vector) {
    queryEmbCache.set(hashKey(query), vector, QUERY_EMB_TTL_MS);
  },

  getChunkEmbedding(content) {
    return chunkEmbCache.get(hashKey(content));
  },
  setChunkEmbedding(content, vector) {
    chunkEmbCache.set(hashKey(content), vector, CHUNK_EMB_TTL_MS);
  },

  stats() {
    return {
      resultCacheSize: resultCache.size(),
      queryEmbCacheSize: queryEmbCache.size(),
      chunkEmbCacheSize: chunkEmbCache.size(),
    };
  },
};
