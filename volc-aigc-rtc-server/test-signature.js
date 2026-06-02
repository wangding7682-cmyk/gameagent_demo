import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

function parseEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) {
    return env;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  content.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  });
  return env;
}

const env = parseEnvFile(path.join(process.cwd(), '.env'));

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function hmacBuffer(key, content) {
  return crypto.createHmac('sha256', key).update(content).digest();
}

function hmacHex(key, content) {
  return crypto.createHmac('sha256', key).update(content).digest('hex');
}

function encodeRFC3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function buildCanonicalQuery(query) {
  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRFC3986(key)}=${encodeRFC3986(value)}`)
    .join('&');
}

function buildSignedHeaders(headers) {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase().trim(), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right));
}

function signVolcOpenApiRequest({
  method,
  pathname = '/',
  query,
  headers,
  body,
  accessKeyId,
  secretAccessKey,
  region,
  service,
  requestDate,
}) {
  const bodyText = body || '';
  const canonicalQueryString = buildCanonicalQuery(query);
  const signedHeaderEntries = buildSignedHeaders(headers);
  const canonicalHeaders = signedHeaderEntries
    .map(([key, value]) => `${key}:${value}\n`)
    .join('');
  const signedHeaders = signedHeaderEntries.map(([key]) => key).join(';');
  const hashedPayload = sha256Hex(bodyText);

  const canonicalRequest = [
    method.toUpperCase(),
    pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const shortDate = requestDate.slice(0, 8);
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    requestDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacBuffer(secretAccessKey, shortDate);
  const kRegion = hmacBuffer(kDate, region);
  const kService = hmacBuffer(kRegion, service);
  const kSigning = hmacBuffer(kService, 'request');
  const signature = hmacHex(kSigning, stringToSign);

  const authorization = [
    `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return {
    authorization,
    canonicalQueryString,
    hashedPayload,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

function getUtcXDate(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

function requestJson({ hostname, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const options = { hostname, method, path, headers };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let data = null;
        if (rawBody) {
          try { data = JSON.parse(rawBody); } catch (e) { data = rawBody; }
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, data, rawBody });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

const config = {
  accessKeyId: env.VOLCENGINE_ACCESS_KEY || '',
  secretAccessKey: env.VOLCENGINE_SECRET_KEY || '',
  region: env.VOLC_RTC_OPENAPI_REGION || 'cn-north-1',
  service: 'rtc',
  host: env.VOLC_RTC_OPENAPI_HOST || 'rtc.volcengineapi.com',
};

const testBody = {
  AppId: env.VOLC_RTC_APP_ID || '',
  RoomId: 'TestRoom001',
  TaskId: 'TestTask001',
  BusinessId: '',
  Config: {},
  AgentConfig: {
    UserId: 'agent_001',
    EnableMicrophone: true,
    EnableSpeaker: true,
    TargetUserId: ['user_001'],
  },
};

if (!config.accessKeyId || !config.secretAccessKey) {
  console.error('错误: 未找到 VOLCENGINE_ACCESS_KEY 或 VOLCENGINE_SECRET_KEY');
  process.exit(1);
}

const bodyText = JSON.stringify(testBody);
const xDate = getUtcXDate();
const query = {
  Action: 'StartVoiceChat',
  Version: '2025-06-01',
};

const queryString = buildCanonicalQuery(query);

const headers = {
  Host: config.host,
  'Content-Type': 'application/json',
  'X-Date': xDate,
};

console.log('===== 签名测试脚本 =====\n');
console.log('当前 UTC 时间:', xDate);
console.log('从 .env 读取的配置:');
console.log('  VOLCENGINE_ACCESS_KEY:', config.accessKeyId.slice(0, 8) + '...');
console.log('  VOLCENGINE_SECRET_KEY:', config.secretAccessKey ? config.secretAccessKey.slice(0, 8) + '...' : 'N/A');
console.log('  VOLC_RTC_APP_ID:', config.testBody?.AppId || env.VOLC_RTC_APP_ID || 'N/A');
console.log('  Region:', config.region);
console.log('  Service:', config.service);
console.log('  Host:', config.host);

const signed = signVolcOpenApiRequest({
  method: 'POST',
  pathname: '/',
  query,
  headers,
  body: bodyText,
  accessKeyId: config.accessKeyId,
  secretAccessKey: config.secretAccessKey,
  region: config.region,
  service: config.service,
  requestDate: xDate,
});

headers['Authorization'] = signed.authorization;

console.log('\n===== 签名结果 =====\n');
console.log('SignedHeaders:', signed.signedHeaders);
console.log('HashedPayload:', signed.hashedPayload);
console.log('CanonicalRequest:\n', signed.canonicalRequest);
console.log('\nStringToSign:\n', signed.stringToSign);
console.log('\nSignature:', signed.signature);
console.log('\nAuthorization:', signed.authorization);

console.log('\n===== 发送测试请求 =====\n');
console.log('URL: POST https://', config.host, '/?', queryString);

try {
  const response = await requestJson({
    hostname: config.host,
    method: 'POST',
    path: '/?' + queryString,
    headers,
    body: bodyText,
  });

  console.log('\n===== 响应结果 =====\n');
  console.log('Status:', response.statusCode);
  if (response.statusCode === 200) {
    console.log('✅ 签名验证成功！');
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } else {
    console.log('❌ 签名验证失败');
    console.log('Response:', JSON.stringify(response.data, null, 2));
  }
} catch (error) {
  console.log('\n===== 请求失败 =====\n');
  console.log('Error:', error.message);
}
