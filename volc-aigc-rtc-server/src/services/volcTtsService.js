import { assertTtsConfig, config } from '../config.js';
import { safeFetchRaw } from '../utils/http.js';

function extractJsonObjects(streamText = '') {
  const objects = [];
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < streamText.length; index += 1) {
    const char = streamText[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        const jsonText = streamText.slice(startIndex, index + 1);
        try {
          objects.push(JSON.parse(jsonText));
        } catch (_) {
          // Ignore malformed fragments and keep scanning.
        }
        startIndex = -1;
      }
    }
  }

  return objects;
}

async function decompressStream(response) {
  const contentEncoding = (response.headers.get('content-encoding') || '').toLowerCase();
  if (contentEncoding === 'gzip' || contentEncoding === 'br' || contentEncoding === 'deflate') {
    try {
      const importCreateGunzip = (await import('node:zlib')).createGunzip;
      if (contentEncoding === 'br') {
        const { createBrotliDecompress } = await import('node:zlib');
        const decompressor = createBrotliDecompress();
        return response.body.pipe(decompressor);
      }
      return response.body.pipe(importCreateGunzip());
    } catch (_) {
      return response.body;
    }
  }
  return response.body;
}

export async function synthesizeVolcTts(body = {}) {
  assertTtsConfig();

  const rawText = String(body.text || '').trim();
  const text = rawText
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!text) {
    throw new Error('TTS 合成需要 text');
  }

  const speaker = body.speaker || config.tts.speaker;
  const requestBody = {
    user: {
      uid: String(body.uid || 'game_ai_demo_user'),
    },
    req_params: {
      text,
      speaker,
      audio_params: {
        format: body.format || 'mp3',
        sample_rate: Number(body.sampleRate || config.tts.sampleRate),
        bit_rate: Number(body.bitRate || config.tts.bitRate),
      },
      additions: JSON.stringify({
        explicit_language: body.explicitLanguage || 'zh-cn',
        disable_markdown_filter: true,
        cache_config: {
          text_type: 1,
          use_cache: true,
        },
      }),
    },
  };

  const response = await safeFetchRaw(`https://${config.tts.host}${config.tts.path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': config.tts.appId,
      'X-Api-Access-Key': config.tts.accessToken,
      'X-Api-Resource-Id': config.tts.resourceId,
      'X-Api-Request-Id': `tts-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      'X-Control-Require-Usage-Tokens-Return': '*',
    },
    body: JSON.stringify(requestBody),
    timeoutMs: 15000,
  });

  if (!response.ok) {
    const errorText = await response.text();
    response._clearTimeout?.();
    throw new Error(`火山 TTS 接口返回 HTTP ${response.status}: ${errorText}`);
  }

  let streamText;
  try {
    const decompressed = await decompressStream(response);
    const reader = decompressed.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      response._resetTimeout?.();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const combined = Buffer.concat(chunks, totalLen);
    streamText = combined.toString('utf8');
  } catch (_) {
    streamText = await response.text();
  } finally {
    response._clearTimeout?.();
  }

  const messages = extractJsonObjects(streamText);
  if (messages.length === 0) {
    throw new Error('火山 TTS 接口未返回可解析的音频数据');
  }

  const audioChunks = messages
    .filter(item => item.code === 0 && typeof item.data === 'string' && item.data)
    .map(item => Buffer.from(item.data, 'base64'));

  let audioBuffer;
  let audioBase64 = '';

  if (audioChunks.length > 0) {
    audioBuffer = Buffer.concat(audioChunks);
    audioBase64 = audioBuffer.toString('base64');
  }

  if (!audioBase64) {
    const lastMessage = messages[messages.length - 1] || {};
    const errCode = lastMessage.code;
    const errMsg = lastMessage.message || '';
    if (errCode === 20000000) {
      throw new Error(`火山 TTS 合成完成但无音频内容，请检查音色是否正确授权: ${errMsg}`);
    }
    throw new Error(`火山 TTS 未返回音频内容(code=${errCode}): ${errMsg}`);
  }

  const completedMessage = messages.find(item => item.code === 20000000) || {};

  return {
    text,
    speaker,
    mimeType: 'audio/mpeg',
    audioBuffer,
    audioBase64,
    audioUrl: `data:audio/mpeg;base64,${audioBase64}`,
    usage: completedMessage.usage || null,
  };
}
