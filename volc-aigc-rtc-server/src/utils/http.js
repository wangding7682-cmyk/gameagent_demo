import http from 'node:http';
import https from 'node:https';

/**
 * 带有超时保护的增强版 fetch。
 * 由于原生 fetch 默认没有全局超时机制（连接可能假死），
 * 在并发大或者上游服务端挂起时容易导致本地 socket 池被耗尽，
 * 所以必须强制为所有网络请求加上超时控制。
 */
export async function safeFetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const fetchOptions = { ...options, signal: controller.signal };
  delete fetchOptions.timeoutMs;

  try {
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
    }
    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`[safeFetchJson] 请求/读取超时（${timeoutMs}ms）: ${url.toString().split('?')[0]}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function safeFetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const fetchOptions = { ...options, signal: controller.signal };
  delete fetchOptions.timeoutMs;

  try {
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
    }
    return await response.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`[safeFetchText] 请求/读取超时（${timeoutMs}ms）: ${url.toString().split('?')[0]}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function safeFetchRaw(url, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const controller = new AbortController();
  let timeoutId;
  const resetIdleTimeout = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  };
  resetIdleTimeout();

  const fetchOptions = { ...options, signal: controller.signal };
  delete fetchOptions.timeoutMs;

  try {
    const response = await fetch(url, fetchOptions);
    // 将 timeoutId 绑定到 response 上，方便调用方在读取完流后清除，或者调用方自己保证不会挂起
    response._clearTimeout = () => clearTimeout(timeoutId);
    response._resetTimeout = resetIdleTimeout;
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`[safeFetchRaw] 请求超时（${timeoutMs}ms）: ${url.toString().split('?')[0]}`);
    }
    throw err;
  }
}

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload, null, 2));
}

export async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`请求体不是合法 JSON: ${error.message}`);
  }
}

export function requestJson({
  protocol = 'https:',
  hostname,
  method = 'GET',
  path = '/',
  headers = {},
  body = '',
}) {
  const transport = protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol,
        hostname,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let data = null;

          if (rawBody) {
            try {
              data = JSON.parse(rawBody);
            } catch (error) {
              reject(
                new Error(`上游返回了非 JSON 响应，HTTP ${res.statusCode}: ${rawBody}`)
              );
              return;
            }
          }

          resolve({
            statusCode: res.statusCode || 500,
            headers: res.headers,
            data,
            rawBody,
          });
        });
      }
    );

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}
