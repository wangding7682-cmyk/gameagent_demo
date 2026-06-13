import { config } from '../config.js';
import { safeFetchJson } from '../utils/http.js';

const DEFAULT_EMBEDDING_MODEL =
  process.env.ARK_EMBEDDING_MODEL || 'doubao-embedding-text-240715';

const EMBEDDING_PATH =
  process.env.ARK_EMBEDDING_PATH || '/api/v3/embeddings';

function assertConfig() {
  if (!config.ark?.apiKey) {
    throw new Error('缺少 ARK_API_KEY');
  }
  if (!config.ark?.host) {
    throw new Error('缺少 ARK_HOST');
  }
}

// Ark Embeddings API：单批最多 256 条建议；这里限制 64 条/批，避免超大请求。
const BATCH_LIMIT = 64;

async function doEmbedBatch(batch, usedModel, isMultimodal) {
  const path = isMultimodal
    ? `${EMBEDDING_PATH}/multimodal`
    : EMBEDDING_PATH;

  if (!isMultimodal) {
    const data = await safeFetchJson(`https://${config.ark.host}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ark.apiKey}`,
      },
      body: JSON.stringify({
        model: usedModel,
        input: batch,
        encoding_format: 'float',
      }),
      timeoutMs: 15000,
    });

    const list = Array.isArray(data?.data) ? data.data : [];
    const vectors = [];
    for (const item of list) {
      const vec = Array.isArray(item?.embedding) ? item.embedding : [];
      vectors.push(vec);
    }
    return vectors;
  }

  // Multimodal API：逐条调用，避免"整体向量化"导致出参数量不匹配
  const vectors = [];
  for (const text of batch) {
    const data = await safeFetchJson(`https://${config.ark.host}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ark.apiKey}`,
      },
      body: JSON.stringify({
        model: usedModel,
        input: [{ type: 'text', text }],
        encoding_format: 'float',
      }),
      timeoutMs: 15000,
    });
    const item = data?.data?.[0];
    const vec = Array.isArray(item?.embedding) ? item.embedding : [];
    vectors.push(vec);
  }
  return vectors;
}

export async function callArkEmbedding({ texts = [], model } = {}) {
  assertConfig();
  const cleaned = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  if (cleaned.length === 0) return { vectors: [], dim: 0 };

  const usedModel = model || DEFAULT_EMBEDDING_MODEL;
  const vectors = [];
  let useMultimodal = false;

  for (let i = 0; i < cleaned.length; i += BATCH_LIMIT) {
    const batch = cleaned.slice(i, i + BATCH_LIMIT);

    let batchVectors;
    try {
      batchVectors = await doEmbedBatch(batch, usedModel, useMultimodal);
    } catch (err) {
      const msg = err.message || '';
      const isUnsupported =
        msg.includes('does not support this api') ||
        msg.includes('InvalidParameter') ||
        msg.includes('InvalidEndpointOrModel');

      if (isUnsupported && !useMultimodal) {
        console.warn(
          `[Embedding] 标准 API 不支持模型 ${usedModel}，fallback 到 multimodal API`
        );
        useMultimodal = true;
        batchVectors = await doEmbedBatch(batch, usedModel, useMultimodal);
      } else {
        throw err;
      }
    }

    vectors.push(...batchVectors);
  }

  const dim = vectors[0]?.length || 0;
  return { vectors, dim, model: usedModel };
}

export function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
