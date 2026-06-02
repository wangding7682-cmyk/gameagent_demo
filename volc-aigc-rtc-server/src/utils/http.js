import http from 'node:http';
import https from 'node:https';

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
