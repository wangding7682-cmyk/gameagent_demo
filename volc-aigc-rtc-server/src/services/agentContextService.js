import { searchMockKnowledge } from './mockKnowledgeService.js';
import { searchVolcKnowledge } from './volcKnowledgeApi.js';
import { getAgentSessionState, upsertAgentDynamicContext } from './agentSessionStateService.js';
import { loadLongTermMemory, loadUserProfile } from './agentProfileLoaderService.js';

const KNOWLEDGE_TIMEOUT_MS = 12000;

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(`${label} 超时`);
        error.code = 'TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]);
}

function stripInvisibleChars(text = '') {
  return String(text)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\u200B-\u200D\u2060-\u2064]/g, '')
    .trim();
}

function normalizeKnowledgeItem(item = {}) {
  return {
    id: item.id || item.point_id || '',
    title: stripInvisibleChars(item.chunk_title || item.title || item.doc_info?.title || '知识片段'),
    content: stripInvisibleChars(String(item.content || item.description || '')).slice(0, 700),
    score: item.rerank_score || item.score || 0,
    docName: item.doc_info?.doc_name || item.docName || '',
  };
}

export function summarizeKnowledgeResult(result = {}) {
  const list = result?.data?.result_list || result?.result_list || [];
  return list
    .slice(0, 5)
    .map(normalizeKnowledgeItem)
    .filter((item) => item.content)
    .map((item, index) => `${index + 1}. ${item.title}: ${item.content}`)
    .join('\n');
}

export async function retrieveAgentKnowledge({ query, forceMock = false, limit = 4 } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) {
    throw new Error('Agent 知识检索需要 query');
  }

  if (forceMock) {
    const result = searchMockKnowledge(cleanQuery, limit);
    return {
      provider: 'mock',
      fallback: false,
      query: cleanQuery,
      result,
      items: (result?.data?.result_list || []).map(normalizeKnowledgeItem),
      summary: summarizeKnowledgeResult(result),
    };
  }

  try {
    const result = await withTimeout(
      searchVolcKnowledge({
        query: cleanQuery,
        limit,
      }),
      KNOWLEDGE_TIMEOUT_MS,
      '知识库检索'
    );
    return {
      provider: 'volc',
      fallback: false,
      query: cleanQuery,
      result,
      items: (result?.data?.result_list || []).map(normalizeKnowledgeItem),
      summary: summarizeKnowledgeResult(result),
      error: null,
    };
  } catch (error) {
    return {
      provider: 'volc',
      fallback: true,
      query: cleanQuery,
      result: null,
      items: [],
      summary: '',
      error: {
        code: error.code || 'KNOWLEDGE_ERROR',
        message: error.message || '知识库检索失败',
      },
    };
  }
}

export async function buildAgentContext(body = {}, turnId = '') {
  const sessionId = String(body.sessionId || body.session_id || body.userId || body.user_id || 'default').trim();
  const userId = String(body.userId || body.user_id || sessionId || 'default').trim();
  const userQuery = String(body.text || body.query || body.user_query || '').trim();
  const orchestrationInput = String(body.orchestrationInput || body.orchestration_input || userQuery).trim();
  const rawAsrText = String(body.rawAsrText || body.raw_asr_text || '').trim();
  const forceMock = body.forceMock === true || body.source === 'demo_button';
  const incomingContext = body.context && typeof body.context === 'object' ? body.context : {};
  const userProfile = loadUserProfile(userId);
  const longTermMemory = loadLongTermMemory(userId, turnId);

  if (Object.keys(incomingContext).length > 0) {
    upsertAgentDynamicContext(sessionId, incomingContext);
  }

  const sessionState = getAgentSessionState(sessionId);
  const dynamicContext = {
    ...(sessionState.dynamic_context || {}),
    ...incomingContext,
  };
  const dynamicSummary = [
    dynamicContext.frameContext?.summary,
    dynamicContext.imagePushContext?.summary,
    dynamicContext.screenContext?.summary,
    dynamicContext.summary,
  ].filter(Boolean).join('\n');

  const recentSummary = (sessionState.recent_turns || [])
    .slice(-6)
    .map((turn) => `${turn.intent || 'unknown'}: ${turn.user_query || ''} -> ${turn.summary || turn.main_summary || ''}`)
    .join('\n');

  const ragQuery = [userQuery, dynamicSummary].filter(Boolean).join('\n当前视觉/图文上下文: ');
  const knowledge = await retrieveAgentKnowledge({
    query: ragQuery || userQuery,
    forceMock,
    limit: Number(body.knowledgeLimit || 4),
  });

  return {
    sessionId,
    userId,
    userQuery,
    orchestrationInput,
    rawAsrText,
    source: body.source || 'unknown',
    forceMock,
    userProfile,
    longTermMemory,
    shortMemory: {
      recent_turns: sessionState.recent_turns || [],
      summary: recentSummary,
    },
    dynamicContext,
    dynamicSummary,
    rag: knowledge,
  };
}
