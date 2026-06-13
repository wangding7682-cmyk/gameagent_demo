function tokenize(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/[，。！？；：、""''（）【】《》,.!?;:()\[\]<>"']/g, ' ');

  const tokens = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[a-z0-9_]/.test(ch)) {
      let j = i + 1;
      while (j < cleaned.length && /[a-z0-9_]/.test(cleaned[j])) j += 1;
      tokens.push(cleaned.slice(i, j));
      i = j;
      continue;
    }
    if (/[\u4e00-\u9fa5]/.test(ch)) {
      tokens.push(ch);
      if (i + 1 < cleaned.length && /[\u4e00-\u9fa5]/.test(cleaned[i + 1])) {
        tokens.push(cleaned.slice(i, i + 2));
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function buildIndex(items) {
  const docs = items.map((item) => {
    const text = [item.chunk_title, item.content, item.doc_info?.title].filter(Boolean).join(' ');
    const tokens = tokenize(text);
    const tf = new Map();
    for (const tk of tokens) {
      tf.set(tk, (tf.get(tk) || 0) + 1);
    }
    return { item, tokens, tf, length: tokens.length };
  });

  const docCount = docs.length;
  const df = new Map();
  for (const doc of docs) {
    for (const tk of new Set(doc.tokens)) {
      df.set(tk, (df.get(tk) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [tk, count] of df.entries()) {
    idf.set(tk, Math.log(1 + (docCount - count + 0.5) / (count + 0.5)));
  }

  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docCount, 1);

  return { docs, idf, avgdl, docCount };
}

const indexCache = new WeakMap();

function getIndex(items) {
  if (indexCache.has(items)) {
    return indexCache.get(items);
  }
  const idx = buildIndex(items);
  indexCache.set(items, idx);
  return idx;
}

const k1 = 1.5;
const b = 0.75;

export function bm25Search(query, items, { topK = 5, minScore = 0 } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const { docs, idf, avgdl } = getIndex(items);
  const scored = docs.map((doc) => {
    let score = 0;
    for (const qt of queryTokens) {
      const f = doc.tf.get(qt);
      if (!f) continue;
      const tokenIdf = idf.get(qt) || 0;
      const denom = f + k1 * (1 - b + b * (doc.length / avgdl || 1));
      score += tokenIdf * ((f * (k1 + 1)) / denom);
    }
    return { item: doc.item, score };
  });

  const maxScore = scored.reduce((max, s) => Math.max(max, s.score), 0);
  const normalized = maxScore > 0
    ? scored.map((s) => ({ item: s.item, score: s.score / maxScore }))
    : scored;

  return normalized
    .filter((s) => s.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function tokenizeForDebug(text) {
  return tokenize(text);
}
