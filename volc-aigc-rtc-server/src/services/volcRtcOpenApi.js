import { config, assertOpenApiConfig } from '../config.js';
import { requestJson } from '../utils/http.js';
import { buildQueryString, getUtcXDate, signVolcOpenApiRequest } from '../utils/volcSigner.js';

function normalizeError(responseData) {
  const meta = responseData?.ResponseMetadata;
  const error = meta?.Error;
  if (!error) {
    return null;
  }

  const detail = new Error(error.Message || error.Code || '火山引擎 OpenAPI 调用失败');
  detail.code = error.Code;
  detail.codeN = error.CodeN;
  detail.requestId = meta?.RequestId;
  detail.response = responseData;
  return detail;
}

export async function callRtcOpenApi(action, body) {
  assertOpenApiConfig();

  const query = {
    Action: action,
    Version: config.openApi.version,
  };

  const bodyText = JSON.stringify(body);
  const xDate = getUtcXDate();
  const headers = {
    Host: config.openApi.host,
    'Content-Type': 'application/json',
    'X-Date': xDate,
  };

  if (config.openApi.sessionToken) {
    headers['X-Security-Token'] = config.openApi.sessionToken;
  }

  const signed = signVolcOpenApiRequest({
    method: 'POST',
    pathname: '/',
    query,
    headers,
    body: bodyText,
    accessKeyId: config.openApi.accessKeyId,
    secretAccessKey: config.openApi.secretAccessKey,
    region: config.openApi.region,
    service: config.openApi.service,
    requestDate: xDate,
  });

  const canonicalHeaders = Object.entries(headers)
    .map(([key, value]) => `${key.toLowerCase().trim()}:${String(value).trim()}`)
    .sort(([left], [right]) => left.localeCompare(right))
    .join('\n');

  headers.Authorization = signed.authorization;

  console.log('[DEBUG-volcRtcOpenApi] ===== 签名调试信息 =====');
  console.log('[DEBUG-volcRtcOpenApi] Action:', action);
  console.log('[DEBUG-volcRtcOpenApi] Body:', bodyText);
  console.log('[DEBUG-volcRtcOpenApi] X-Date:', xDate);
  console.log('[DEBUG-volcRtcOpenApi] SignedHeaders:', signed.signedHeaders);
  console.log('[DEBUG-volcRtcOpenApi] CanonicalHeaders:', canonicalHeaders);
  console.log('[DEBUG-volcRtcOpenApi] HashedPayload:', signed.hashedPayload);
  console.log('[DEBUG-volcRtcOpenApi] Authorization:', signed.authorization);
  console.log('[DEBUG-volcRtcOpenApi] ==========================');

  const response = await requestJson({
    protocol: 'https:',
    hostname: config.openApi.host,
    method: 'POST',
    path: `/${buildQueryString(query)}`,
    headers,
    body: bodyText,
  });

  const apiError = normalizeError(response.data);
  if (apiError) {
    throw apiError;
  }

  if (response.statusCode >= 400) {
    const unknownError = new Error(`火山引擎 OpenAPI 返回 HTTP ${response.statusCode}`);
    unknownError.response = response.data;
    throw unknownError;
  }

  return response.data;
}
