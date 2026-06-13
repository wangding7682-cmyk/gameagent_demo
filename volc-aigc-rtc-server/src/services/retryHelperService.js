/**
 * 【健壮性 / 失败重试 + 自纠话】retryHelperService
 *
 * 通俗职责：调外部服务超时或挂掉时，先重试一次；如果还是不行，把用户原话简化
 * （去"能不能/帮我/那种"这类口水词）再试一次，给关键词留干净的检索词面。
 *
 * 提供两个工具：
 *   1) withRetry(fn, options) — 带退避的通用重试包装
 *   2) rewriteFailedQuery(originalQuery, errorReason) — 失败后改写 query 的轻量自纠
 *
 * 设计要点：
 *   - 不引入 LLM 调用：query 改写用规则替换，零延迟、零成本
 *   - 只对「可重试错误」(timeout / 5xx / fetch failed) 重试，4xx 直接抛出
 *   - 第一次重试不改 query；第二次重试用 rewriteFailedQuery 简化 query
 */

const RETRYABLE_HINTS = ['timeout', 'TIMEOUT', '超时', 'fetch failed', 'ECONNRESET', 'ETIMEDOUT', '5'];

export function isRetryableError(err) {
  if (!err) return false;
  if (err.code === 'TIMEOUT') return true;
  const msg = String(err.message || '');
  if (RETRYABLE_HINTS.some((h) => msg.includes(h))) return true;
  const status = err.status || err.response?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  return false;
}

/**
 * @param {Function} fn  async () => result
 * @param {object} options
 *   - maxAttempts 默认 2
 *   - delayMs 默认 1000
 *   - onAttempt(attempt, err)
 *   - shouldRetry(err) 默认 isRetryableError
 */
export async function withRetry(fn, options = {}) {
  const maxAttempts = Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : 2;
  const delayMs = Number(options.delayMs) >= 0 ? Number(options.delayMs) : 1000;
  const shouldRetry = typeof options.shouldRetry === 'function' ? options.shouldRetry : isRetryableError;
  const onAttempt = typeof options.onAttempt === 'function' ? options.onAttempt : () => {};

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      onAttempt(attempt, null);
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      onAttempt(attempt, err);
      if (attempt >= maxAttempts || !shouldRetry(err)) {
        throw err;
      }
      const wait = delayMs * attempt;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * 失败后简化 query：去掉模糊修饰词、限定到核心实体。
 * 用于第二次重试时把 query 改得更"易命中"。
 */
const FILLER_WORDS = [
  '能不能', '可不可以', '帮我', '请', '我想要', '我想', '我要', '麻烦', '一下', '看看', '搞一下',
  '可能', '大概', '应该', '估计', '差不多', '随便', '稍微',
  '最好', '那种', '谢谢',
  '对吧', '是吧', '吧', '呢', '啦', '哦', '啊', '吗', '嘛',
];

const SOFT_PUNCT = /[，。！？!?,.\s]+/g;

export function rewriteFailedQuery(originalQuery = '', errorReason = '') {
  let q = String(originalQuery || '').trim();
  if (!q) return '';

  for (const w of FILLER_WORDS) {
    q = q.split(w).join('');
  }

  q = q.replace(SOFT_PUNCT, ' ').replace(/\s+/g, ' ').trim();

  if (q.length > 30) {
    const tokens = q.split(' ').filter(Boolean);
    if (tokens.length > 4) {
      q = tokens.slice(0, 4).join(' ');
    } else {
      q = q.slice(0, 30);
    }
  }

  if (!q) {
    q = String(originalQuery).slice(0, 12);
  }

  return q;
}

export const __INTERNAL = { FILLER_WORDS, RETRYABLE_HINTS };
