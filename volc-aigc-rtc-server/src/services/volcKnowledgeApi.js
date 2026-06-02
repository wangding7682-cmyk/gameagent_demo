import { assertKnowledgeConfig, config } from '../config.js';
import { requestJson } from '../utils/http.js';

function normalizeKnowledgeError(responseData) {
  if (!responseData || typeof responseData !== 'object') {
    return null;
  }

  if (Number(responseData.code) === 0) {
    return null;
  }

  const error = new Error(responseData.message || '火山引擎知识库检索失败');
  error.code = responseData.code;
  error.requestId = responseData.request_id;
  error.response = responseData;
  return error;
}

function trimUndefinedValues(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

export function buildKnowledgeSearchPayload(body = {}) {
  if (config.knowledge.apiStyle === 'service_chat') {
    const query = body.query;
    const messageContent = Array.isArray(query) ? query : String(query || '').trim();

    if (
      (typeof messageContent === 'string' && !messageContent) ||
      (Array.isArray(messageContent) && messageContent.length === 0)
    ) {
      throw new Error('知识库对话需要 query');
    }

    return trimUndefinedValues({
      service_resource_id:
        body.serviceResourceId || config.knowledge.serviceResourceId,
      messages:
        body.messages ||
        [
          {
            role: 'user',
            content: messageContent,
          },
        ],
      stream: body.stream ?? false,
    });
  }

  const limit = Number(body.limit || config.knowledge.limit || 5);
  const payload = trimUndefinedValues({
    project: body.project || config.knowledge.project,
    name: body.name || config.knowledge.collectionName,
    resource_id: body.resourceId || config.knowledge.resourceId,
    query: String(body.query || '').trim(),
    limit,
    dense_weight:
      body.denseWeight !== undefined ? Number(body.denseWeight) : undefined,
    query_param: body.queryParam,
    image_query: body.imageQuery,
    pipeline_name: body.pipelineName,
  });

  if (body.preProcessing || body.messages || body.rewrite !== undefined) {
    payload.pre_processing = trimUndefinedValues({
      ...body.preProcessing,
      rewrite: body.rewrite,
      messages: body.messages,
      return_token_usage: body.returnTokenUsage,
      need_instruction: body.needInstruction,
    });
  }

  if (body.postProcessing || body.rerankSwitch !== undefined) {
    payload.post_processing = trimUndefinedValues({
      ...body.postProcessing,
      rerank_switch: body.rerankSwitch,
      rerank_model: body.rerankModel,
      retrieve_count: body.retrieveCount,
      chunk_group: body.chunkGroup,
      chunk_diffusion_count: body.chunkDiffusionCount,
      get_attachment_link: body.getAttachmentLink,
      rerank_only_chunk: body.rerankOnlyChunk,
    });
  }

  if (!payload.query) {
    throw new Error('知识库检索需要 query');
  }

  if (!payload.resource_id && !payload.name) {
    throw new Error('知识库检索需要 resourceId 或 name');
  }

  return payload;
}

function normalizeKnowledgeResponse(responseData) {
  if (config.knowledge.apiStyle !== 'service_chat') {
    return responseData;
  }

  const data = responseData?.data || {};
  const assistantMessage =
    data.generated_answer ||
    data.answer ||
    data.output_text ||
    data.message?.content ||
    data.messages?.find((item) => item.role === 'assistant')?.content ||
    responseData?.answer ||
    '';

  const textContent = Array.isArray(assistantMessage)
    ? assistantMessage
        .map((part) => part.text || part.content || part.image_url?.url || '')
        .filter(Boolean)
        .join('\n')
    : String(assistantMessage || '');

  return {
    code: Number(responseData?.code ?? 0),
    message: responseData?.message || 'success',
    request_id: responseData?.request_id || '',
    data: {
      collection_name: config.knowledge.serviceResourceId || 'knowledge-service',
      count: textContent ? 1 : 0,
      result_list: textContent
        ? [
            {
              id: data.conversation_id || 'service-chat-result',
              point_id: data.conversation_id || 'service-chat-result',
              chunk_title: '知识库服务回答',
              content: textContent,
              score: 1,
              chunk_type: 'chat_answer',
              doc_info: {
                doc_name: 'knowledge-service',
                title: '知识库服务回答',
              },
            },
          ]
        : [],
      raw: data,
    },
  };
}

export async function searchVolcKnowledge(body = {}) {
  assertKnowledgeConfig();

  const payload = buildKnowledgeSearchPayload(body);
  const bodyText = JSON.stringify(payload);
  const headers = {
    Host: config.knowledge.host,
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (config.knowledge.apiStyle === 'service_chat') {
    headers.Accept = 'application/json';
    headers.Authorization = `Bearer ${config.knowledge.apiKey}`;
  } else {
    headers.Accept = 'application/json';
    headers['Authorization'] = `Bearer ${config.knowledge.apiKey}`;
    headers['X-Api-Key'] = config.knowledge.apiKey;
  }

  const response = await requestJson({
    protocol: 'https:',
    hostname: config.knowledge.host,
    method: 'POST',
    path: config.knowledge.endpointPath,
    headers,
    body: bodyText,
  });

  const normalizedResponse = normalizeKnowledgeResponse(response.data);
  const apiError = normalizeKnowledgeError(normalizedResponse);
  if (apiError) {
    throw apiError;
  }

  if (response.statusCode >= 400) {
    const unknownError = new Error(`火山引擎知识库接口返回 HTTP ${response.statusCode}`);
    unknownError.response = response.data;
    throw unknownError;
  }

  return normalizedResponse;
}
