import { bm25Search } from './bm25Service.js';
import {
  detectDomains,
  isAmbiguousDomain,
  isCrossDomain,
  getDomainLabel,
} from './domainRouterService.js';
import { getDefaultLocalKnowledgeItems } from './defaultLocalKnowledgeService.js';
import { getDefaultWzryKnowledgeItems } from './defaultLocalWzryKnowledgeService.js';
import { searchVolcKnowledge } from './volcKnowledgeApi.js';
import { callArkEmbedding, cosineSimilarity } from './embeddingService.js';
import { rerankCandidates } from './rerankService.js';
import { ragCache, buildResultKey, buildSourcesFingerprint } from './ragCacheService.js';

const VERBOSE_LOG = process.env.RAG_DEBUG_LOG === '1' || process.env.RAG_DEBUG_LOG === 'true';

const SOURCE_TIMEOUT_MS = 12000;

const SOURCE_WEIGHTS = {
  user_local: 1.5,
  user_cloud: 1.3,
  house_volc: 1.0,
  default_local: 0.7,
};

const THRESHOLDS = {
  inDomain: 0.08,      // 放宽：本域阈值从 0.15 降到 0.08
  crossDomain: 0.18,   // 放宽：跨域从 0.30 降到 0.18
  ambiguous: 0.12,     // 放宽：模糊域从 0.20 降到 0.12
};

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(`${label} 超时`);
        error.code = 'TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]);
}

function pickThreshold(detectedDomains, sourceDomain) {
  if (isAmbiguousDomain(detectedDomains)) {
    return THRESHOLDS.ambiguous;
  }
  if (isCrossDomain(detectedDomains, sourceDomain)) {
    return THRESHOLDS.crossDomain;
  }
  return THRESHOLDS.inDomain;
}

function pickDomainBonus(detectedDomains, sourceDomain) {
  if (isAmbiguousDomain(detectedDomains)) return 1.0;
  if (!sourceDomain) return 0.95;
  if (detectedDomains.includes(sourceDomain)) return 1.2;
  return 0.6; // 跨域惩罚从 0.3 提高到 0.6，避免误杀但仍保留区分度
}

function clamp01(x) {
  if (typeof x !== 'number' || Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizeBaseItem(item, sourceType, sourceLabel, sourceDomain) {
  return {
    id: item.id || item.point_id || `${sourceType}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(item.chunk_title || item.title || item.doc_info?.title || '知识片段').trim(),
    content: String(item.content || item.description || '').trim().slice(0, 800),
    sourceType,
    sourceLabel,
    sourceDomain: item.domain || sourceDomain || null,
    docName: item.doc_info?.doc_name || item.docName || sourceLabel,
  };
}

async function recallUserLocal(query, source) {
  const items = Array.isArray(source.items) ? source.items : [];
  if (items.length === 0) return [];

  // BM25 召回（关键词侧）
  const bm25Hits = bm25Search(
    query,
    items.map((it, i) => ({
      id: it.id || `user-local-${i}`,
      point_id: it.id || `user-local-${i}`,
      chunk_title: it.title || it.chunk_title || '',
      content: it.content || it.text || '',
      score: 0,
      domain: source.domain || null,
      doc_info: { doc_name: source.label || 'user_local', title: it.title || '' },
      __raw: it,
    })),
    { topK: Math.max(source.topK || 5, 10), minScore: 0.001 }
  );
  const bm25Map = new Map();
  for (const { item, score } of bm25Hits) {
    bm25Map.set(item.id, { item, bm25: score });
  }

  // 向量召回（语义侧）：仅当 chunk 自带 embedding 时启用，否则降级为纯 BM25。
  const itemsWithEmbedding = items.filter(
    (it) => Array.isArray(it.embedding) && it.embedding.length > 0
  );
  const vectorMap = new Map();
  if (itemsWithEmbedding.length > 0) {
    try {
      const { vectors } = await callArkEmbedding({ texts: [query] });
      const qvec = vectors?.[0] || [];
      if (qvec.length > 0) {
        for (const it of itemsWithEmbedding) {
          const sim = cosineSimilarity(qvec, it.embedding);
          if (sim > 0) {
            const id = it.id || `user-local-vec-${it.title || ''}`;
            vectorMap.set(id, sim);
          }
        }
      }
    } catch (_) {
      // 向量召回失败不影响 BM25 主路
    }
  }

  // 候选集 = BM25 命中 ∪ 向量 topN
  const candidateIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
  const idToItem = new Map();
  for (const it of items) {
    idToItem.set(it.id || `user-local-${items.indexOf(it)}`, it);
  }

  const HYBRID_BM25_W = 0.4;
  const HYBRID_VEC_W = 0.6;
  const merged = [];
  for (const id of candidateIds) {
    const raw = idToItem.get(id) || bm25Map.get(id)?.item?.__raw;
    if (!raw) continue;
    const bm25 = bm25Map.get(id)?.bm25 || 0;
    const vec = vectorMap.get(id) || 0;
    const fused = vectorMap.size > 0 ? bm25 * HYBRID_BM25_W + vec * HYBRID_VEC_W : bm25;
    merged.push({
      raw,
      fused,
      bm25,
      vec,
    });
  }
  merged.sort((a, b) => b.fused - a.fused);
  const top = merged.slice(0, source.topK || 5);

  return top.map(({ raw, fused, bm25, vec }) => ({
    base: normalizeBaseItem(
      {
        id: raw.id,
        chunk_title: raw.title || raw.chunk_title || '',
        content: raw.content || raw.text || '',
        doc_info: { doc_name: source.label || 'user_local', title: raw.title || '' },
      },
      'user_local',
      source.label || '我的本地库',
      source.domain || null
    ),
    nativeScore: clamp01(fused),
    scoreSource: vectorMap.size > 0 ? 'local_hybrid' : 'local_bm25',
    debug: { bm25, vec },
  }));
}

// 用户私有云端知识库：直接透传火山 search_knowledge 的原生 rerank/相关度分数。
// 火山内部已混合 BM25+Embedding+rerank，前端不再重复跑本地 BM25 重排，避免量纲冲突与重复计算。
async function recallUserCloud(query, source) {
  if (!source.apiKey || !source.serviceResourceId) return [];
  try {
    const result = await withTimeout(
      searchVolcKnowledge({
        query,
        limit: source.topK || 5,
        serviceResourceId: source.serviceResourceId,
      }),
      SOURCE_TIMEOUT_MS,
      '用户云端知识库'
    );
    const list = result?.data?.result_list || [];
    return list.map((it) => {
      const native = typeof it.rerank_score === 'number'
        ? it.rerank_score
        : (typeof it.score === 'number' ? it.score : 0.5);
      return {
        base: normalizeBaseItem(it, 'user_cloud', source.label || '我的云端库', source.domain || null),
        nativeScore: clamp01(native),
        scoreSource: 'volc_native',
      };
    });
  } catch (error) {
    return [];
  }
}

// 官方云端知识库（house）：同 user_cloud，直接透传火山原生 score，不做本地 BM25 重排。
async function recallHouseVolc(query, source) {
  try {
    const result = await withTimeout(
      searchVolcKnowledge({
        query,
        limit: source.topK || 5,
      }),
      SOURCE_TIMEOUT_MS,
      '官方云端知识库'
    );
    const list = result?.data?.result_list || [];
    return list.map((it) => {
      const native = typeof it.rerank_score === 'number'
        ? it.rerank_score
        : (typeof it.score === 'number' ? it.score : 0.5);
      return {
        base: normalizeBaseItem(it, 'house_volc', source.label || '官方云端库', null),
        nativeScore: clamp01(native),
        scoreSource: 'volc_native',
      };
    });
  } catch (error) {
    return [];
  }
}

async function recallDefaultLocal(query, source) {
  let items = [];
  if (source.domain === 'lol') items = getDefaultLocalKnowledgeItems();
  else if (source.domain === 'wzry') items = getDefaultWzryKnowledgeItems();
  if (items.length === 0) return [];

  const hits = bm25Search(query, items, { topK: source.topK || 5, minScore: 0.001 });
  return hits.map(({ item, score }) => ({
    base: normalizeBaseItem(item, 'default_local', source.label || `内置${getDomainLabel(source.domain)}库`, source.domain),
    nativeScore: clamp01(score),
    scoreSource: 'local_bm25',
  }));
}

const RECALLERS = {
  user_local: recallUserLocal,
  user_cloud: recallUserCloud,
  house_volc: recallHouseVolc,
  default_local: recallDefaultLocal,
};

export async function multiSourceSearch({
  query,
  sources = [],
  topK = 5,
  rerankStrategy = 'embedding',
  candidatePoolMultiplier = 2,
  bypassCache = false,
  domainContext = '',
  strictDomain = true,
} = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) {
    return { items: [], detectedDomains: [], summary: '', skipped: [], rerankSource: null, cacheHit: false };
  }

  // ---- 结果级缓存（30s）：同一轮对话 + 相同 query/sources/strategy → 直接返回 ----
  const sourcesFingerprint = buildSourcesFingerprint(sources);
  const cacheKey = buildResultKey({ query: cleanQuery, sourcesFingerprint, rerankStrategy, topK });
  if (!bypassCache) {
    const cached = ragCache.getResult(cacheKey);
    if (cached) {
      if (VERBOSE_LOG) console.log('[RAG][cache] HIT result', { query: cleanQuery.slice(0, 40) });
      return { ...cached, cacheHit: true };
    }
  }

  // 域检测：本轮 query 优先；若 ambiguous，回退到 domainContext（最近会话粘性域）
  const queryDomains = detectDomains(cleanQuery);
  let detectedDomains = queryDomains;
  let domainSource = 'query';
  if (queryDomains.length === 0 && domainContext) {
    const ctxDomains = detectDomains(String(domainContext));
    if (ctxDomains.length > 0) {
      detectedDomains = ctxDomains;
      domainSource = 'sticky_context';
    }
  }
  // 严格 domain 模式：当且仅当本轮+粘性 domain 收敛到唯一域时启用硬过滤
  const strictMode = strictDomain && detectedDomains.length === 1;

  // 用户要求：官方库（house_volc）和私有库（user_local/default_local）全部并行召回
  // 不再提前跳过，保证官方库内容始终参与排序
  const enabledSources = sources.filter((s) => s && s.type && s.enabled !== false);
  const skippedSources = [];
  const recalls = [];

  // 所有源并行召回，不做提前跳过
  const allTasks = enabledSources.map(async (source) => {
    const fn = RECALLERS[source.type];
    if (!fn) return { source, hits: [], error: 'recaller not found' };
    try {
      const hits = await fn(cleanQuery, source);
      return { source, hits };
    } catch (error) {
      return { source, hits: [], error: error.message };
    }
  });
  const allResults = await Promise.all(allTasks);
  recalls.push(...allResults);

  const merged = [];
  const skipped = [];

  for (const { source, hits } of recalls) {
    const sourceWeight = SOURCE_WEIGHTS[source.type] ?? 1.0;
    const sourceDomain = source.domain || null;

    for (const { base, nativeScore, scoreSource } of hits) {
      const itemDomain = base.sourceDomain || sourceDomain;

      // 严格 domain 模式：当本轮明确收敛到单一 domain 时，跨域文档直接 reject
      if (strictMode && itemDomain && isCrossDomain(detectedDomains, itemDomain)) {
        skipped.push({
          id: base.id,
          title: base.title,
          sourceType: base.sourceType,
          sourceDomain: itemDomain,
          nativeScore,
          scoreSource,
          finalScore: 0,
          threshold: 0,
          reason: 'cross_domain_strict',
        });
        continue;
      }

      const itemThreshold = pickThreshold(detectedDomains, itemDomain);
      const itemDomainBonus = pickDomainBonus(detectedDomains, itemDomain);

      const finalScore = nativeScore * sourceWeight * itemDomainBonus;
      if (finalScore < itemThreshold) {
        skipped.push({
          id: base.id,
          title: base.title,
          sourceType: base.sourceType,
          sourceDomain: itemDomain,
          nativeScore,
          scoreSource,
          finalScore,
          threshold: itemThreshold,
          reason: itemDomain && isCrossDomain(detectedDomains, itemDomain) ? 'cross_domain' : 'low_score',
        });
        continue;
      }

      merged.push({
        ...base,
        nativeScore,
        scoreSource,
        sourceWeight,
        domainBonus: itemDomainBonus,
        threshold: itemThreshold,
        relevance: Math.min(1, finalScore),
        finalScore,
      });
    }
  }

  // 第一阶段：扩大候选池（pool = topK * multiplier）
  merged.sort((a, b) => b.finalScore - a.finalScore);
  const poolSize = Math.max(topK * candidatePoolMultiplier, topK);
  const candidatePool = merged.slice(0, poolSize);

  // 第二阶段：统一 rerank
  let rerankSource = 'native';
  let reranked = candidatePool;
  if (rerankStrategy !== 'none' && candidatePool.length > 0) {
    reranked = await rerankCandidates(cleanQuery, candidatePool, { strategy: rerankStrategy });
    rerankSource = reranked[0]?.rerankSource || rerankStrategy;
  } else {
    reranked = candidatePool.map((c) => ({ ...c, rerankScore: c.relevance, rerankSource: 'native' }));
  }

  // 第三阶段：rerank 后再叠加来源/域权重
  const finalRanked = reranked.map((it) => {
    const fused = it.rerankScore * (it.sourceWeight || 1.0) * (it.domainBonus || 1.0);
    return {
      ...it,
      relevance: Math.min(1, it.rerankScore),
      finalScore: fused,
    };
  });
  finalRanked.sort((a, b) => b.finalScore - a.finalScore);

  // ---- rerank 结果可观测性（默认打印，便于线上排查）----
  const degraded = rerankStrategy === 'embedding' && rerankSource === 'minmax';
  console.log(
    `[RAG][compare] query="${cleanQuery.slice(0, 50)}" pool=${candidatePool.length} strategy=${rerankStrategy} → ${rerankSource}${degraded ? ' ⚠️降级' : ''}`
  );
  if (VERBOSE_LOG) {
    const beforeMap = new Map(candidatePool.map((c, i) => [c.id, { rank: i + 1, native: c.nativeScore, weighted: c.finalScore }]));
    const compare = finalRanked.map((it, i) => {
      const before = beforeMap.get(it.id) || {};
      return {
        afterRank: i + 1,
        beforeRank: before.rank ?? '-',
        delta: before.rank ? before.rank - (i + 1) : '-',
        title: (it.title || '').slice(0, 30),
        source: it.sourceType,
        nativeScore: typeof it.nativeScore === 'number' ? it.nativeScore.toFixed(3) : '-',
        rerankScore: typeof it.rerankScore === 'number' ? it.rerankScore.toFixed(3) : '-',
        finalScore: typeof it.finalScore === 'number' ? it.finalScore.toFixed(3) : '-',
      };
    });
    console.table(compare.slice(0, Math.min(10, compare.length)));
  }

  const topItems = finalRanked.slice(0, topK);
  const summary = topItems
    .map(
      (it, i) =>
        `${i + 1}. [${it.sourceLabel}|相关度${Math.round(it.relevance * 100)}%] ${it.title}: ${it.content}`
    )
    .join('\n');

  const result = {
    items: topItems,
    detectedDomains,
    domainSource,
    strictMode,
    summary,
    skipped,
    skippedSources,
    rerankSource,
    poolSize: candidatePool.length,
    cacheHit: false,
  };

  if (!bypassCache) ragCache.setResult(cacheKey, result);
  return result;
}
