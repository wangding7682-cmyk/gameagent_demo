import { callArkEmbedding, cosineSimilarity } from './embeddingService.js';
import { ragCache } from './ragCacheService.js';

const RERANK_TIMEOUT_MS = 12000;
const VERBOSE_LOG = process.env.RAG_DEBUG_LOG === '1' || process.env.RAG_DEBUG_LOG === 'true';

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const e = new Error(`${label} 超时`);
        e.code = 'TIMEOUT';
        reject(e);
      }, ms);
    }),
  ]);
}

export function minMaxRerank(candidates) {
  const bySource = new Map();
  for (const c of candidates) {
    const key = c.sourceType || 'unknown';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(c);
  }
  const normalizedMap = new Map();
  for (const [, list] of bySource) {
    const scores = list.map((c) => c.nativeScore || 0);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;
    for (const c of list) {
      const norm = range > 0 ? (c.nativeScore - min) / range : 0.5;
      normalizedMap.set(c, norm);
    }
  }
  return candidates.map((c) => ({
    ...c,
    rerankScore: normalizedMap.get(c) ?? 0,
    rerankSource: 'minmax',
  }));
}

// 优化版 embedding rerank：
// 1) query embedding 命中缓存就跳过
// 2) chunk content embedding 命中缓存（按内容指纹）就直接用，不重复请求
// 3) 已携带 raw embedding（如 user_local 上传时已算的向量）就直接复用
export async function embeddingRerank(query, candidates) {
  if (!candidates.length) return [];

  // ---- query embedding ----
  let qvec = ragCache.getQueryEmbedding(query);
  let queryEmbedHit = !!qvec;
  let needArkEmbed = [];
  if (!qvec) needArkEmbed.push({ type: 'query', text: query });

  // ---- chunk embeddings：按优先级检查复用 ----
  const chunkPlan = candidates.map((c) => {
    const text = `${c.title || ''}\n${c.content || ''}`.slice(0, 1500);
    if (Array.isArray(c.embedding) && c.embedding.length > 0) {
      return { c, vec: c.embedding, source: 'inline' };
    }
    const cached = ragCache.getChunkEmbedding(text);
    if (cached) return { c, vec: cached, source: 'cache' };
    needArkEmbed.push({ type: 'chunk', text, ref: c });
    return { c, vec: null, source: 'request', text };
  });

  // ---- 一次 batch 请求所有缺失向量 ----
  if (needArkEmbed.length > 0) {
    const { vectors } = await withTimeout(
      callArkEmbedding({ texts: needArkEmbed.map((x) => x.text) }),
      RERANK_TIMEOUT_MS,
      '统一 rerank embedding'
    );
    if (!vectors || vectors.length !== needArkEmbed.length) {
      throw new Error('rerank embedding 数量不匹配');
    }
    needArkEmbed.forEach((req, i) => {
      const v = vectors[i];
      if (req.type === 'query') {
        qvec = v;
        ragCache.setQueryEmbedding(query, v);
      } else {
        const planEntry = chunkPlan.find((p) => p.c === req.ref && !p.vec);
        if (planEntry) {
          planEntry.vec = v;
          planEntry.source = 'request';
          ragCache.setChunkEmbedding(req.text, v);
        }
      }
    });
  }

  if (!qvec) throw new Error('query embedding 丢失');

  const reranked = chunkPlan.map(({ c, vec, source }) => {
    const sim = cosineSimilarity(qvec, vec || []);
    return {
      ...c,
      rerankScore: Math.max(0, Math.min(1, sim)),
      rerankSource: 'embedding',
      _embedSource: source,
    };
  });

  if (VERBOSE_LOG) {
    const stats = chunkPlan.reduce(
      (acc, p) => { acc[p.source] = (acc[p.source] || 0) + 1; return acc; },
      {}
    );
    console.log('[RAG][rerank] embedding cost', {
      query: query.slice(0, 50),
      total: candidates.length,
      queryEmbedHit,
      chunkSource: stats,
      arkRequestCount: needArkEmbed.length,
    });
  }

  return reranked;
}

export async function rerankCandidates(query, candidates, { strategy = 'embedding' } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (strategy === 'none') {
    return candidates.map((c) => ({ ...c, rerankScore: c.nativeScore || 0, rerankSource: 'native' }));
  }
  if (strategy === 'minmax') {
    return minMaxRerank(candidates);
  }
  try {
    return await embeddingRerank(query, candidates);
  } catch (e) {
    // 降级告警默认打印，不依赖 DEBUG 开关——这是需要监控的异常路径
    console.warn('[RAG][rerank] embedding 失败，降级 minmax', {
      query: query.slice(0, 50),
      candidateCount: candidates.length,
      error: e.message,
      code: e.code,
    });
    return minMaxRerank(candidates);
  }
}
