import { assertArkImageConfig, config } from '../config.js';
import { safeFetchJson } from '../utils/http.js';
import { sanitizeKnowledgeCardImagePrompt } from './knowledgeCardStyleService.js';

function normalizeImageError(responseData) {
  if (!responseData || typeof responseData !== 'object') {
    return null;
  }

  if (!responseData.error) {
    return null;
  }

  const error = new Error(
    responseData.error.message || '方舟图片生成接口调用失败'
  );
  error.code = responseData.error.code || 'ARK_IMAGE_ERROR';
  error.response = responseData;
  return error;
}

function pickImageUrl(responseData) {
  const candidates = Array.isArray(responseData?.data) ? responseData.data : [];
  const firstItem = candidates[0] || {};

  return (
    firstItem.url ||
    firstItem.image_url ||
    firstItem.imageUrl ||
    responseData?.url ||
    ''
  );
}

export async function generateArkImage(body = {}) {
  assertArkImageConfig();
  const startedAt = Date.now();

  // 兜底守门：所有进来的 prompt 都强制走"信息卡片"风格过滤
  // 即使 strategyAgentService 没过滤，这里也一定会过滤
  const sanitized = sanitizeKnowledgeCardImagePrompt(body.prompt);
  const prompt = String(sanitized || '').trim();
  if (!prompt) {
    throw new Error('图片生成需要 prompt');
  }

  const payload = {
    model: body.model || config.ark.imageModel,
    prompt,
    sequential_image_generation:
      body.sequentialImageGeneration || config.ark.sequentialImageGeneration,
    response_format: body.responseFormat || config.ark.responseFormat,
    size: body.size || config.ark.imageSize,
    stream: body.stream === true,
    watermark:
      body.watermark === undefined ? config.ark.watermark : body.watermark === true,
  };

  let responseData;
  try {
    responseData = await safeFetchJson(
      `https://${config.ark.host}${config.ark.imageGenerationPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.ark.apiKey}`,
        },
        body: JSON.stringify(payload),
        timeoutMs: config.ark.imageTimeoutMs,
      }
    );
  } finally {
    console.log('[arkImageService] image request finished', {
      elapsed_ms: Date.now() - startedAt,
      model: payload.model,
      size: payload.size,
    });
  }

  const apiError = normalizeImageError(responseData);
  if (apiError) {
    throw apiError;
  }

  const imageUrl = pickImageUrl(responseData);
  if (!imageUrl) {
    const noDataError = new Error('方舟图片生成成功，但响应中没有可用图片地址');
    noDataError.response = responseData;
    throw noDataError;
  }

  return {
    prompt,
    model: payload.model,
    size: payload.size,
    url: imageUrl,
    created: responseData?.created || Date.now(),
    raw: responseData,
  };
}
