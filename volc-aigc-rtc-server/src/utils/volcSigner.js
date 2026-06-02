import crypto from 'node:crypto';

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

export function signVolcOpenApiRequest({
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
  };
}

export function getUtcXDate(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

export function buildQueryString(query) {
  const canonical = buildCanonicalQuery(query);
  return canonical ? `?${canonical}` : '';
}
