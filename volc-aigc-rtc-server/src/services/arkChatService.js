import { config } from '../config.js';

function assertArkChatConfig() {
  const missing = [];
  if (!config.ark?.apiKey) missing.push('ARK_API_KEY');
  if (!config.ark?.chatModel) missing.push('ARK_CHAT_MODEL');
  if (missing.length > 0) {
    throw new Error(`缺少配置: ${missing.join(', ')}`);
  }
}

function normalizeChatPath(pathValue) {
  const raw = String(pathValue || '').trim();
  if (!raw) {
    return '/api/v3/chat/completions';
  }
  const normalized = raw.replace(/\\/g, '/').replace(/\s+/g, '').toLowerCase();
  if (normalized === '/api/v3/chat/completions' || normalized.endsWith('/chat/completions')) {
    return '/api/v3/chat/completions';
  }
  return raw;
}

function extractMessageContent(responseData) {
  const content = responseData?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => item.text || item.content || '').filter(Boolean).join('\n');
  }
  return '';
}

function extractDeltaContent(responseData) {
  const content = responseData?.choices?.[0]?.delta?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => item.text || item.content || '').filter(Boolean).join('\n');
  }
  return '';
}

export function extractJsonObject(text = '') {
  const content = String(text || '').trim();
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || content.match(/\{[\s\S]*\}/)?.[0] || content;
  return JSON.parse(candidate);
}

export async function callArkChat({ systemPrompt, userPrompt, temperature = 0.2, maxTokens = 800 } = {}) {
  assertArkChatConfig();
  const cleanSystemPrompt = String(systemPrompt || '').trim();
  const cleanUserPrompt = String(userPrompt || '').trim();
  if (!cleanUserPrompt) {
    throw new Error('Ark Chat 需要 userPrompt');
  }

  const response = await fetch(`https://${config.ark.host}${normalizeChatPath(config.ark.chatPath)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ark.apiKey}`,
    },
    body: JSON.stringify({
      model: config.ark.chatModel,
      messages: [
        cleanSystemPrompt ? { role: 'system', content: cleanSystemPrompt } : null,
        { role: 'user', content: cleanUserPrompt },
      ].filter(Boolean),
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    throw new Error(`Ark Chat 返回非 JSON 响应: ${rawText.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`Ark Chat API 返回 HTTP ${response.status}: ${rawText.slice(0, 300)}`);
  }

  const content = extractMessageContent(data).trim();
  if (!content) {
    throw new Error(`Ark Chat 响应缺少内容: ${JSON.stringify(data).slice(0, 200)}`);
  }

  return {
    content,
    raw: data,
  };
}

export async function callArkChatStream({
  systemPrompt,
  userPrompt,
  temperature = 0.2,
  maxTokens = 800,
  onDelta = () => {},
} = {}) {
  assertArkChatConfig();
  const cleanSystemPrompt = String(systemPrompt || '').trim();
  const cleanUserPrompt = String(userPrompt || '').trim();
  if (!cleanUserPrompt) {
    throw new Error('Ark Chat Stream 需要 userPrompt');
  }

  const response = await fetch(`https://${config.ark.host}${normalizeChatPath(config.ark.chatPath)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ark.apiKey}`,
    },
    body: JSON.stringify({
      model: config.ark.chatModel,
      messages: [
        cleanSystemPrompt ? { role: 'system', content: cleanSystemPrompt } : null,
        { role: 'user', content: cleanUserPrompt },
      ].filter(Boolean),
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const rawText = await response.text().catch(() => '');
    throw new Error(`Ark Chat Stream API 返回 HTTP ${response.status}: ${rawText.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const evt of events) {
      const lines = evt.split(/\r?\n/).filter((line) => line.startsWith('data:'));
      for (const line of lines) {
        const dataText = line.slice(5).trim();
        if (!dataText || dataText === '[DONE]') {
          continue;
        }
        let data = null;
        try {
          data = JSON.parse(dataText);
        } catch (_) {
          continue;
        }
        const delta = extractDeltaContent(data);
        if (delta) {
          fullContent += delta;
          await onDelta(delta, fullContent);
        }
      }
    }
  }

  if (buffer.trim()) {
    const lines = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    for (const line of lines) {
      const dataText = line.slice(5).trim();
      if (!dataText || dataText === '[DONE]') continue;
      try {
        const data = JSON.parse(dataText);
        const delta = extractDeltaContent(data);
        if (delta) {
          fullContent += delta;
          await onDelta(delta, fullContent);
        }
      } catch (_) {
        // Ignore incomplete trailing SSE payloads.
      }
    }
  }

  const content = fullContent.trim();
  if (!content) {
    throw new Error('Ark Chat Stream 响应缺少内容');
  }

  return {
    content,
    raw: null,
  };
}
