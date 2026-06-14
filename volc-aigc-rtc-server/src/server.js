import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Agent, setGlobalDispatcher } from 'undici';

// 配置全局 HTTP 代理，提升连接复用率，避免并发时 Socket 耗尽导致请求挂起
// 这个设置对整个 Node.js 进程的所有原生 fetch 生效
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
  connections: 200, // 允许更大的并发连接数
  pipelining: 1
}));

import { config, getMemoryConfigSummary } from './config.js';
import { searchDefaultLocalKnowledge } from './services/defaultLocalKnowledgeService.js';
import { generateArkImage } from './services/arkImageService.js';
import { recognizeIntent } from './services/intentService.js';
import { resolveDouyinVideo, searchDouyinVideo } from './services/douyinVideoSearchService.js';
import { synthesizeVolcTts } from './services/volcTtsService.js';
import {
  deleteAllMockMemory,
  deleteMockMemory,
  getMockJobStatus,
  getMockMemory,
  getMockMemoryHealth,
  getMockMemoryHistory,
  listMockMemory,
  saveMockMemory,
  searchMockMemory,
  updateMockMemory,
} from './services/mockMemoryService.js';
import { saveSessionRecord, listSessionRecords } from './services/sessionRecordService.js';
import {
  checkVolcMemoryHealth,
  deleteAllVolcMemory,
  deleteVolcMemory,
  getVolcMemory,
  getVolcMemoryHistory,
  getVolcMemoryJobStatus,
  listVolcMemory,
  saveVolcMemory,
  searchVolcMemory,
  updateVolcMemory,
} from './services/volcMemoryApi.js';
import {
  checkVolcMemoryManagementHealth,
  describeVolcMemoryProjectDetail,
  describeVolcMemoryProjects,
} from './services/volcMemoryOpenApi.js';
import {
  vikingAddEvent,
  vikingSearchProfile,
  vikingSearchEvent,
  vikingSearchMemory,
  vikingGetContext,
  vikingCollectionInfo,
  checkVikingMemoryHealth,
} from './services/volcVikingMemoryService.js';
import {
  loadLongTermMemory,
  loadUserProfile,
  listUserProfiles,
  createUserProfile,
  getOverlayStatus,
  resetUserOverlay,
} from './services/agentProfileLoaderService.js';
import {
  formatRtcPersonaProfileForPrompt,
  getRtcPersonaProfile,
  updateRtcPersonaProfile,
} from './services/rtcPersonaProfileService.js';
import {
  buildRtcProjection,
  buildRtcProjectionMessage,
} from './services/rtcProjectionService.js';
import {
  appendRtcSessionMessage,
  getRecentRtcUserPrompts,
  getRtcSessionState,
  upsertRtcSessionState,
} from './services/rtcSessionStateService.js';
import { searchVolcKnowledge } from './services/volcKnowledgeApi.js';
import { multiSourceSearch } from './services/multiSourceKnowledgeService.js';
import { predictDocumentDomain } from './services/predictDomainService.js';
import { callArkEmbedding } from './services/embeddingService.js';
import { callRtcOpenApi } from './services/volcRtcOpenApi.js';
import { generateRtcToken } from './services/tokenService.js';
import { appendAgentTrace, getAgentTrace, listAgentTraces } from './services/agentTraceLoggerService.js';
import { listReflectionLogs, summarizeReflectionLogs } from './services/reflectionLoggerService.js';
import { appendAgentSessionTurn, clearAgentSessionState, getAgentSessionState, upsertAgentDynamicContext } from './services/agentSessionStateService.js';
import { runAgentOrchestration } from './services/agentOrchestratorService.js';
import { planTasks as planTasksDirect } from './services/taskPlannerService.js';
import { handleRtcLlmStream } from './services/rtcLlmStreamService.js';
import { handleRtcPushTts } from './services/rtcPushTtsService.js';
import {
  appendSessionEvent,
  getSessionEvents,
  hasSessionBuffer,
  isOrchestrationRunning,
  isOrchestrationDone,
  markOrchestrationRunning,
  markOrchestrationDone,
  subscribeSessionEvents,
  waitForOrchestrationStart,
} from './services/rtcLlmBridgeService.js';
import { readJsonBody, sendJson } from './utils/http.js';

const sessionEventBus = new Map();

function publishToEventBus(sessionId, event, data) {
  const subscribers = sessionEventBus.get(sessionId);
  if (subscribers) {
    for (const cb of subscribers) {
      try { cb(event, data); } catch (_) {}
    }
  }
}

function subscribeToEventBus(sessionId, callback) {
  if (!sessionEventBus.has(sessionId)) {
    sessionEventBus.set(sessionId, new Set());
  }
  sessionEventBus.get(sessionId).add(callback);
  return () => {
    sessionEventBus.get(sessionId)?.delete(callback);
    if (sessionEventBus.get(sessionId)?.size === 0) {
      sessionEventBus.delete(sessionId);
    }
  };
}

const frontendRoot = path.resolve(config.projectRoot, '..');
const staticEntryFileMap = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/main.js', 'main.js'],
]);
const staticDirectoryPrefixes = ['/src/', '/vendor/', '/dist/'];
const staticMimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function resolveStaticFilePath(pathname) {
  if (staticEntryFileMap.has(pathname)) {
    return path.resolve(frontendRoot, staticEntryFileMap.get(pathname));
  }

  if (!staticDirectoryPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  const filePath = path.resolve(frontendRoot, `.${pathname}`);
  if (!filePath.startsWith(`${frontendRoot}${path.sep}`)) {
    return null;
  }

  return filePath;
}

function sendStaticFile(response, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'Content-Type': staticMimeTypes[extension] || 'application/octet-stream',
  });
  response.end(fs.readFileSync(filePath));
  return true;
}

function writeSseEvent(response, event, data = {}) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function normalizeTargetUserId(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function buildDefaultAgentConfig(body) {
  const defaultAgentConfig = config.defaults.startVoiceChat?.AgentConfig || {};
  const targetUserIds = normalizeTargetUserId(
    body.targetUserId ?? body.agentConfig?.TargetUserId ?? defaultAgentConfig.TargetUserId
  );

  const agentConfig = {
    ...defaultAgentConfig,
    TargetUserId: targetUserIds,
    UserId:
      body.agentUserId ||
      body.agentConfig?.UserId ||
      defaultAgentConfig.UserId ||
      config.defaults.agentUserId,
    WelcomeMessage:
      body.welcomeMessage ||
      body.agentConfig?.WelcomeMessage ||
      defaultAgentConfig.WelcomeMessage ||
      config.defaults.welcomeMessage,
  };

  if (
    body.agentConfig?.EnableConversationStateCallback !== undefined ||
    defaultAgentConfig.EnableConversationStateCallback !== undefined
  ) {
    agentConfig.EnableConversationStateCallback =
      body.agentConfig?.EnableConversationStateCallback ??
      defaultAgentConfig.EnableConversationStateCallback;
  }

  const callbackUrl =
    body.agentConfig?.ServerMessageURLForRTS ||
    defaultAgentConfig.ServerMessageURLForRTS ||
    config.defaults.rtsCallbackUrl;
  const callbackSignature =
    body.agentConfig?.ServerMessageSignatureForRTS ||
    defaultAgentConfig.ServerMessageSignatureForRTS ||
    config.defaults.rtsCallbackSignature;

  if (callbackUrl) {
    agentConfig.ServerMessageURLForRTS = callbackUrl;
  }

  if (callbackSignature) {
    agentConfig.ServerMessageSignatureForRTS = callbackSignature;
  }

  return {
    ...agentConfig,
    ...body.agentConfig,
  };
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => {
    const value = body[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new Error(`缺少必填字段: ${missing.join(', ')}`);
  }
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ensureRtcIgnoreBracketText(rtcConfig = {}) {
  const nextConfig = cloneJson(rtcConfig) || {};
  const ttsConfig = ensureObject(nextConfig.TTSConfig);
  const providerParams = ensureObject(ttsConfig.ProviderParams);

  delete providerParams.IgnoreBracketText;
  ttsConfig.ProviderParams = providerParams;
  ttsConfig.IgnoreBracketText = [1, 2, 3, 4, 5];
  nextConfig.TTSConfig = ttsConfig;

  return nextConfig;
}

function parseVolcanoAsrParameters(rawValue) {
  if (!rawValue) {
    return {};
  }

  if (typeof rawValue === 'string') {
    try {
      return JSON.parse(rawValue);
    } catch (error) {
      throw new Error(`VolcanoASRParameters 解析失败: ${error.message}`);
    }
  }

  if (typeof rawValue === 'object') {
    return cloneJson(rawValue);
  }

  return {};
}

function serializeVolcanoAsrParameters(value) {
  return JSON.stringify(value || {});
}

function getRtcVoiceFeatureState(startVoiceChatConfig = config.defaults.startVoiceChat || {}) {
  const agentConfig = ensureObject(startVoiceChatConfig.AgentConfig);
  const rtcConfig = ensureObject(startVoiceChatConfig.Config);
  const asrConfig = ensureObject(rtcConfig.ASRConfig);
  const providerParams = ensureObject(asrConfig.ProviderParams);
  const volcanoParams = parseVolcanoAsrParameters(providerParams.VolcanoASRParameters);
  const requestParams = ensureObject(volcanoParams.request);
  const voicePrint = ensureObject(agentConfig.VoicePrint);
  const aiVadEnabled =
    Number.isFinite(Number(requestParams.vad_segment_duration)) ||
    Number.isFinite(Number(requestParams.end_window_size));
  const voicePrintEnabled =
    Number(voicePrint.Mode) === 1 &&
    voicePrint.EnableSV === true;
  const aiDenoiseEnabled = Number(agentConfig.AnsMode) > 0;

  return {
    aiVad: {
      enabled: aiVadEnabled,
      vadSegmentDuration: Number(requestParams.vad_segment_duration) || 1000,
      endWindowSize: Number(requestParams.end_window_size) || 500,
    },
    voicePrintRealtime: {
      enabled: voicePrintEnabled,
      mode: Number(voicePrint.Mode) || 1,
      enableSV: voicePrint.EnableSV === true,
      voiceDuration: Number(voicePrint.VoiceDuration) || 20,
    },
    aiDenoise: {
      enabled: aiDenoiseEnabled,
      ansMode: Number(agentConfig.AnsMode) || 2,
    },
    constraints: {
      voicePrintRealtimeAndAiDenoiseMutuallyExclusive: true,
    },
  };
}

function persistDefaultStartVoiceChatConfig(nextConfig) {
  const filePath = config.defaults.startVoiceChatConfigPath;
  fs.writeFileSync(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  config.defaults.startVoiceChat = nextConfig;
}

function updateRtcVoiceFeatureState(body = {}) {
  const currentConfig = cloneJson(config.defaults.startVoiceChat || {});
  const nextConfig = ensureObject(currentConfig);
  const nextAgentConfig = ensureObject(nextConfig.AgentConfig);
  const nextRtcConfig = ensureObject(nextConfig.Config);
  const nextAsrConfig = ensureObject(nextRtcConfig.ASRConfig);
  const nextProviderParams = ensureObject(nextAsrConfig.ProviderParams);
  const volcanoParams = parseVolcanoAsrParameters(nextProviderParams.VolcanoASRParameters);
  const requestParams = ensureObject(volcanoParams.request);
  const lastChangedFeatureKey = String(body.lastChangedFeatureKey || '').trim();

  const aiVadEnabled = Boolean(body.aiVadEnabled);
  const voicePrintEnabled = Boolean(body.voicePrintRealtimeEnabled);
  const aiDenoiseEnabled = Boolean(body.aiDenoiseEnabled);

  if (aiVadEnabled) {
    requestParams.vad_segment_duration =
      Number(body.aiVadVadSegmentDuration) > 0 ? Number(body.aiVadVadSegmentDuration) : 1000;
    requestParams.end_window_size =
      Number(body.aiVadEndWindowSize) > 0 ? Number(body.aiVadEndWindowSize) : 500;
  } else {
    delete requestParams.vad_segment_duration;
    delete requestParams.end_window_size;
  }

  volcanoParams.request = requestParams;
  nextProviderParams.VolcanoASRParameters = serializeVolcanoAsrParameters(volcanoParams);
  nextAsrConfig.ProviderParams = nextProviderParams;
  nextRtcConfig.ASRConfig = nextAsrConfig;

  if (voicePrintEnabled) {
    nextAgentConfig.VoicePrint = {
      Mode: 1,
      EnableSV: true,
      VoiceDuration:
        Number(body.voicePrintVoiceDuration) > 0 ? Number(body.voicePrintVoiceDuration) : 20,
    };
    if (lastChangedFeatureKey === 'voicePrintRealtime' || !aiDenoiseEnabled) {
      delete nextAgentConfig.AnsMode;
    }
  } else {
    delete nextAgentConfig.VoicePrint;
  }

  if (aiDenoiseEnabled) {
    nextAgentConfig.AnsMode =
      Number(body.aiDenoiseAnsMode) > 0 ? Number(body.aiDenoiseAnsMode) : 2;
    if (lastChangedFeatureKey === 'aiDenoise' || !voicePrintEnabled) {
      delete nextAgentConfig.VoicePrint;
    }
  } else if (!voicePrintEnabled) {
    delete nextAgentConfig.AnsMode;
  }

  nextConfig.AgentConfig = nextAgentConfig;
  nextConfig.Config = nextRtcConfig;

  persistDefaultStartVoiceChatConfig(nextConfig);

  return {
    configPath: config.defaults.startVoiceChatConfigPath,
    features: getRtcVoiceFeatureState(nextConfig),
    requestConfig: nextConfig,
  };
}

function normalizeUserPrompts(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const role = String(item?.Role || item?.role || '').trim();
      const content = String(item?.Content || item?.content || '').trim();
      if (!role || !content) {
        return null;
      }
      if (!['system', 'user', 'assistant'].includes(role)) {
        return null;
      }
      return {
        Role: role,
        Content: content,
      };
    })
    .filter(Boolean);
}

function resolvePlayerUserId(body, agentConfig) {
  const candidate =
    body.userId ||
    body.playerUserId ||
    body.targetUserId ||
    body.agentConfig?.TargetUserId ||
    agentConfig?.TargetUserId?.[0];

  if (Array.isArray(candidate)) {
    return String(candidate[0] || '').trim();
  }

  return String(candidate || '').trim();
}

function resolveDynamicGameState(body) {
  return String(
    body.dynamicGameState ||
      body.dynamic_game_state ||
      body.memoryContext?.dynamicGameState ||
      body.context?.dynamicGameState ||
      ''
  ).trim();
}

function resolveRetrievedKnowledge(body, session = null) {
  const candidate =
    body.retrievedKnowledge ??
    body.retrieved_knowledge ??
    body.parameters?.retrievedKnowledge ??
    body.parameters?.retrieved_knowledge ??
    body.memoryContext?.retrievedKnowledge ??
    body.memoryContext?.retrieved_knowledge ??
    body.context?.retrievedKnowledge ??
    body.context?.retrieved_knowledge ??
    session?.metadata?.retrievedKnowledge ??
    '';

  if (Array.isArray(candidate)) {
    return candidate.map((item) => String(item || '').trim()).filter(Boolean).join('\n');
  }

  if (candidate && typeof candidate === 'object') {
    if (Array.isArray(candidate.result_list)) {
      return candidate.result_list
        .map((item) => String(item?.content || item?.chunk_title || '').trim())
        .filter(Boolean)
        .join('\n');
    }
    return JSON.stringify(candidate);
  }

  return String(candidate || '').trim();
}

function buildRtcDynamicContextMessage({ profilePrompt, retrievedKnowledge, dynamicGameState, rtcProjectionMessage = '' }) {
  return [
    '# Dynamic Context (由系统状态机动态注入)',
    rtcProjectionMessage || '',
    '',
    '<memory_profile>',
    profilePrompt || '暂无长期画像',
    '</memory_profile>',
    '',
    '<retrieved_knowledge>',
    retrievedKnowledge || '暂无最近检索知识',
    '</retrieved_knowledge>',
    '',
    '<current_game_state>',
    dynamicGameState || '当前暂无明确实时局势信息',
    '</current_game_state>',
  ].join('\n');
}

function buildRtcSystemMessages(baseSystemMessages, context = {}) {
  const normalizedBaseMessages = Array.isArray(baseSystemMessages)
    ? baseSystemMessages.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  return [buildRtcDynamicContextMessage(context), ...normalizedBaseMessages].filter(Boolean);
}

function buildPersonaFunctionTool() {
  return {
    type: 'function',
    function: {
      name: 'update_user_profile',
      description:
        '当玩家明确表达游戏习惯、情绪偏好、禁忌、近期位置偏好或沟通偏好时，更新该玩家的长期画像档案',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '画像字段名，例如 近期偏好、常玩位置、沟通风格、雷区',
          },
          value: {
            type: 'string',
            description: '画像字段值，要求简洁、可复用、可覆盖',
          },
        },
        required: ['key', 'value'],
      },
    },
  };
}

function buildKnowledgeQueryFunctionTool() {
  return {
    type: 'function',
    function: {
      name: 'query_game_knowledge',
      description:
        '当遇到英雄克制、阵容理解、版本强势点、开局路线、防入侵等知识盲区时，检索最新游戏知识',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索语句，需包含英雄名、阵容关系、时间节点或战术目标',
          },
          top_k: {
            type: 'integer',
            description: '返回条数，建议 1 到 5',
          },
        },
        required: ['query'],
      },
    },
  };
}

function buildCoachPlanFunctionTool() {
  return {
    type: 'function',
    function: {
      name: 'submit_coach_plan',
      description: '输出结构化的赛前 BP 与前 3 分钟战术计划，供业务层记录与展示',
      parameters: {
        type: 'object',
        properties: {
          trigger: {
            type: 'string',
            description: '触发攻略建议的直接原因，如敌方一楼盲僧、我方软辅、用户怕被抓',
          },
          objective: {
            type: 'string',
            description: '本轮最核心的赢局条件或战术目标',
          },
          timing: {
            type: 'string',
            description: '适用时间段，如BP期、0-90秒、0-180秒',
          },
          plan: {
            type: 'array',
            description: '可执行步骤列表，建议 1 到 5 条',
            items: {
              type: 'string',
            },
          },
          risks: {
            type: 'array',
            description: '关键风险点或反制点，建议 0 到 3 条',
            items: {
              type: 'string',
            },
          },
        },
        required: ['trigger', 'objective', 'timing', 'plan'],
      },
    },
  };
}

function upsertFunctionTool(existingTools = [], toolDefinition) {
  const functionName = toolDefinition?.function?.name;
  if (!functionName) {
    return Array.isArray(existingTools) ? existingTools : [];
  }

  const nextTools = Array.isArray(existingTools)
    ? existingTools.filter((item) => item?.function?.name !== functionName)
    : [];
  nextTools.push(toolDefinition);
  return nextTools;
}

async function applyRtcMemoryContext(startVoiceChatConfig, body, agentConfig, turnId = '') {
  const nextConfig = cloneJson(startVoiceChatConfig) || {};
  const nextLlmConfig = cloneJson(nextConfig.LLMConfig) || {};
  const playerUserId = resolvePlayerUserId(body, agentConfig);
  const currentSession = String(body.taskId || '').trim() ? getRtcSessionState(body.taskId) : null;
  const agentSessionState = getAgentSessionState(body.sessionId || body.session_id || playerUserId || 'default');
  const dynamicGameState = resolveDynamicGameState(body);
  const retrievedKnowledge = resolveRetrievedKnowledge(body, currentSession);
  const profile = getRtcPersonaProfile(playerUserId);
  const rtcProfilePrompt = formatRtcPersonaProfileForPrompt(profile);
  const longTermMemory = loadLongTermMemory(playerUserId, turnId);
  const userProfile = loadUserProfile(playerUserId);
  const memoryLines = [];
  if (Array.isArray(longTermMemory.facts) && longTermMemory.facts.length > 0) {
    memoryLines.push('【事实】', ...longTermMemory.facts.slice(0, 8).map((f) => `- ${f}`));
  }
  if (Array.isArray(longTermMemory.preferences) && longTermMemory.preferences.length > 0) {
    memoryLines.push('【偏好】', ...longTermMemory.preferences.slice(0, 8).map((p) => `- ${p}`));
  }
  if (Array.isArray(longTermMemory.avoidances) && longTermMemory.avoidances.length > 0) {
    memoryLines.push('【禁忌】', ...longTermMemory.avoidances.slice(0, 4).map((a) => `- ${a}`));
  }
  let vikingMemoryLines = [];
  if (config.memory.mode === 'viking') {
    try {
      const vikingResult = await vikingSearchMemory({
        query: `${body.userQuery || body.text || ''} ${userProfile?.game_profile?.frequent_champions?.join(' ') || ''}`,
        user_id: playerUserId,
        limit: 5,
      }, turnId);
      if (vikingResult && vikingResult.code === 0 && vikingResult.data) {
        const items = vikingResult.data.result_list || [];
        const relevantItems = items.filter((item) => typeof item.score === 'number' && item.score >= 0.15);
        if (relevantItems.length > 0) {
          vikingMemoryLines = relevantItems.map((item) => {
            const summary = item.memory_info?.summary || '';
            const tag = item.memory_type === 'profile_v1' ? '画像' : '事件';
            return `[云端${tag}] ${summary}`;
          });
        }
      }
    } catch (vikingError) {
      console.log(`[applyRtcMemoryContext] Viking 检索失败，降级到本地记忆: ${vikingError.message}`);
    }
  }
  const allMemoryLines = [...vikingMemoryLines, ...memoryLines];
  const profilePrompt = [
    rtcProfilePrompt !== '暂无长期画像。' ? `RTC画像:\n${rtcProfilePrompt}` : '',
    allMemoryLines.length > 0 ? `长期记忆:\n${allMemoryLines.join('\n')}` : '',
    userProfile?.game_profile?.rank_tier ? `段位: ${userProfile.game_profile.rank_tier}` : '',
    userProfile?.game_profile?.preferred_roles?.length ? `常玩位置: ${userProfile.game_profile.preferred_roles.join('/')}` : '',
    userProfile?.game_profile?.frequent_champions?.length ? `常玩英雄: ${userProfile.game_profile.frequent_champions.join('/')}` : '',
    userProfile?.game_profile?.play_style ? `风格: ${userProfile.game_profile.play_style}` : '',
  ].filter(Boolean).join('\n') || '暂无长期画像';
  const rtcProjection = buildRtcProjection({
    body,
    agentSessionState,
    retrievedKnowledge,
    dynamicGameState,
  });
  const rtcProjectionMessage = buildRtcProjectionMessage(rtcProjection);
  const historyLength = 0;
  const shortPromptMessageLimit = 0;

  const interactionAgentPrompt = [
    '你是游戏语音助手"小G"，负责实时语音交互与轻量意图识别。',
    '你不是 Strategy_Agent 或 Video_Agent，不生成完整攻略、卡片内容、视频链接。',
    '',
    '核心目标：',
    '1. 用极短时间输出可播回复，避免用户等待完整后台 Agent。',
    '2. 判断用户意图并自然路由：',
    '   - smalltalk：聊天/情绪/观点/心态/玩法哲学/对队友/对自身/无明确战术索取 → 直接给轻量观点或安慰，1-2句',
    '   - strategy：打法/战术/出装/克制/对线/明确要"知识卡片/战术卡片"等卡片词 → 简短确认 + 等候语',
    '   - video：找视频/集锦/高光/抖音/B站/明确要看视频 → 简短确认 + 等候语',
    '',
    '【关键反空头支票规则 — 最高优先级】',
    '- 你的话直接被 TTS 播给用户，但你并不能保证后端 Strategy_Agent / Video_Agent 真的会被触发。',
    '- 因此，**只有当用户的请求显式包含战术词或卡片词或视频词时，才允许说"整理后弹出"或"找到后弹出"这类动作承诺**。',
    '  - 战术词示例：怎么打、克制、出装、连招、对线、入侵、阵容、战术、节奏',
    '  - 卡片词示例：知识卡片、知识卡、战术卡片、战术卡、卡片、生成图、画一张、配图',
    '  - 视频词示例：视频、集锦、高光、抖音、B站、操作演示',
    '- 如果用户只是闲聊、问情绪、问感受、问队友是谁、问"刚才发生了什么"、说自己的事，**严禁承诺生成卡片/查找视频/整理战术**，只能用闲聊语气直接给一个简短回应或反问。',
    '- 含糊的话术（如"我去帮你看看"、"我帮你整理下"）也不能用在闲聊上，因为后台不会真的做。',
    '- 严禁编造游戏内事件、英雄、对位、操作等用户没说过的具体事实（"对面打野是XXX""你被XXX绕后"）。',
    '',
    '语气约束：',
    '- 助手名称：小G',
    '- 语气：轻松但有专业感',
    '- 短句为主，先结论后动作',
    '- 不要寒暄，不要客套，不要重复用户原话',
    '- 每次回复最多3句，每句尽量简短',
    '- 信息不足时先给保守且可执行的建议',
    '- 不要编造版本结论、英雄机制、敌我位置或画面内容',
    '',
    '轻思考感播报规则：',
    '- 你的回复必须带一点“判断感”，不要只做机械确认。',
    '- 优先采用“先判断，再给半句依据，最后说下一步”的口语节奏。',
    '- 第一短句优先给当前判断，例如“这波先稳刷到6。”“这个视频先看控龙节奏。”“这把先别急着接团。”',
    '- 第二短句只补一个最关键的依据，优先引用 <current_game_state>、RTC Context Projection 里的 unresolved_need / latest_rag_brief / session_topic。',
    '- 第三短句才允许说下一步动作；如果是 strategy/video，可说“我继续帮你整理/筛视频，稍后弹出”。',
    '- 禁止空起手：不要用“收到”“好的”“好嘞”“明白”“哈哈”“这就为你”“安排上了”作为第一句。',
    '- 禁止把卡片正文、列表条目、完整攻略直接念出来；RTC 只负责短判断，不负责朗读完整资产内容。',
    '- 小句里允许有教练感，但不要居高临下，不要夸张，不要卖萌。',
    '',
    '连续追问规则：',
    '- 如果用户说“那个呢”“那这个呢”“还是围绕...”“刚才那个视频呢”“继续说这个”，优先视为延续当前话题，而不是新开闲聊。',
    '- 遇到代词追问时，先参考 RTC Context Projection 中的 sticky_hero、session_topic、unresolved_need，再决定回复内容。',
    '- 只有用户明确换英雄、换主题、换需求时，才允许跳出当前话题。',
    '- 连续追问场景下，第一句必须直接给“方向判断”或“局势判断”，例如“先盯控龙时机。”“这波先接龙。”不要先说“明白，就...”这类执行确认。',
    '- 视频追问场景下，如果 projection 已经显示具体英雄/主题，回复里要带上该主题，例如“我继续按龙女打野教学这个方向筛”。不要泛泛说“我去找视频”。',
    '- strategy 追问场景下，如果用户是在追问上个战术点，优先延续上个判断，不要先退回泛化安抚。',
    '',
    '任务参与度规则：',
    '- 如果 RTC Context Projection 里的 task_engagement_state 是 paused 或 cancelled，说明用户刚把原任务收住了；这一轮只能确认暂停/取消，不要继续推进旧任务。',
    '- 如果 task_engagement_state 是 light_chat，说明用户还在和你说话，但当前不在推进原任务；只做轻互动，不要自动恢复旧任务，更不要继续说“我继续筛视频/继续整理”。',
    '- 如果 projection 里有 resumable_branch_hint，只有用户当前这句话明确表达“继续刚才那个/还是看那个/继续说这个”时，才允许恢复该任务。',
    '- 用户说“不要”“不用”“没必要”“自己可以”时，优先理解为收束当前任务，而不是继续围绕旧任务展开。',
    '- 用户说“哈哈”“没错”“挺好”“好的”这类反馈时，优先按轻互动处理；除非用户同句里明确提到继续当前任务，否则不要自动接回旧主线。',
    '',
    '输出规则：',
    '- 直接输出可播文本，不要输出JSON、标记、括号内容',
    '- 禁止工具调用描述、系统说明、内部Agent名称',
    '- 严禁输出 <think> 标签或任何思考过程，直接给最终结论',
    '- 不要展开完整攻略，那是后台的事',
    '- 只把真正需要播报给用户的内容放在回复里',
    '- smalltalk：直接给“判断 + 建议”，不要空附和。',
    '- strategy：给“判断 + 一句依据 + 等待动作”，但不要把完整攻略念出来。',
    '- video：给“判断 + 视频方向/筛选依据 + 等待动作”，但不要假装视频已经拿到，除非系统明确告知已找到。',
    '',
    '上下文优先级：',
    '1. <current_game_state>',
    '2. 当前轮次中系统明确提供的视觉或画面信息',
    '3. <retrieved_knowledge>',
    '4. <memory_profile>',
    '5. 历史对话',
    '',
    '记忆意识：',
    '- 当用户明确表达长期偏好、习惯、禁忌时，在回复中自然确认，例如"记住了，以后我直接讲抓人时机"',
    '- 不要说"我已将此写入记忆"之类的系统术语，用自然对话确认即可',
    '- 系统会自动将高价值信息沉淀为长期记忆，你不需要做额外操作',
    '',
    '回复示例风格（只学语气，不要照抄内容）：',
    '- strategy 例：这把先稳刷到6。龙女前两波更看等级和河道资源，我先把前期节奏整理给你。',
    '- strategy follow-up 例：这波控龙要看线权。你要是还围绕龙女打野，我就按控龙时机继续帮你补重点。',
    '- video 例：这个视频先看教学向。你现在更缺控龙和开野节奏，我继续按龙女打野教学这个方向筛，找到就弹。',
    '- video follow-up 例：刚才那个视频我还在按龙女打野教学筛。优先给你找能直接看控龙时机和刷野路线的。',
    '- video focus follow-up 例：先盯控龙时机。你现在有河道视野和线权，我优先找对应场景的教学片段。',
    '- smalltalk 例：这波先别急着自责。你现在更需要把关键失误点拎出来，我先陪你捋顺。',
  ].join('\n');

  nextLlmConfig.SystemMessages = [
    buildRtcDynamicContextMessage({ profilePrompt, retrievedKnowledge, dynamicGameState, rtcProjectionMessage }),
    interactionAgentPrompt,
  ];
  nextLlmConfig.HistoryLength = 10;
  delete nextLlmConfig.UserPrompts;
  delete nextLlmConfig.Tools;
  delete nextLlmConfig.FunctionCallingConfig;

  nextConfig.LLMConfig = nextLlmConfig;
  const normalizedConfig = ensureRtcIgnoreBracketText(nextConfig);

  return {
    config: normalizedConfig,
    playerUserId,
    dynamicGameState,
    retrievedKnowledge,
    rtcProjection,
    historyLength,
    shortPromptMessageLimit,
    profile,
  };
}

function pickTokenRequest(body) {
  requireFields(body, ['roomId', 'userId']);

  return {
    roomId: body.roomId,
    userId: body.userId,
    expireInSeconds: Number(body.expireInSeconds || 7200),
  };
}

async function buildStartVoiceChatRequest(body) {
  requireFields(body, ['roomId', 'taskId']);

  const agentConfig = buildDefaultAgentConfig(body);
  if (!Array.isArray(agentConfig.TargetUserId) || agentConfig.TargetUserId.length === 0) {
    throw new Error('startVoiceChat 需要 targetUserId 或 agentConfig.TargetUserId');
  }

  const defaultStartVoiceChat = config.defaults.startVoiceChat || {};
  const startVoiceChatConfig = body.config || body.Config || defaultStartVoiceChat.Config;

  if (!startVoiceChatConfig) {
    throw new Error('startVoiceChat 需要 config');
  }

  const useCustomLlm = Boolean(config.rtcLlmBridge.customLlmBaseUrl);

  if (useCustomLlm) {
    const customLlmConfig = buildCustomLlmConfig(body);
    const asrConfig = startVoiceChatConfig.ASRConfig || defaultStartVoiceChat.Config?.ASRConfig;
    const ttsConfig = startVoiceChatConfig.TTSConfig || defaultStartVoiceChat.Config?.TTSConfig;
    const subtitleConfig = startVoiceChatConfig.SubtitleConfig || defaultStartVoiceChat.Config?.SubtitleConfig;
    const interruptMode = startVoiceChatConfig.InterruptMode ?? defaultStartVoiceChat.Config?.InterruptMode ?? 0;

    const finalConfig = {
      ASRConfig: asrConfig,
      TTSConfig: ttsConfig,
      LLMConfig: customLlmConfig,
      SubtitleConfig: subtitleConfig,
      InterruptMode: interruptMode,
    };

    return {
      payload: {
        AppId: body.appId || config.rtcAppId,
        RoomId: body.roomId,
        TaskId: body.taskId,
        BusinessId: body.businessId || defaultStartVoiceChat.BusinessId,
        Config: finalConfig,
        AgentConfig: agentConfig,
      },
      context: {
        playerUserId: resolvePlayerUserId(body, agentConfig),
        dynamicGameState: resolveDynamicGameState(body),
        historyLength: 0,
        shortPromptMessageLimit: 0,
        profile: getRtcPersonaProfile(resolvePlayerUserId(body, agentConfig)),
        agentUserId: agentConfig.UserId,
        customLlmMode: true,
      },
    };
  }

  const memoryContext = await applyRtcMemoryContext(startVoiceChatConfig, body, agentConfig, body.turnId || '');

  return {
    payload: {
      AppId: body.appId || config.rtcAppId,
      RoomId: body.roomId,
      TaskId: body.taskId,
      BusinessId: body.businessId || defaultStartVoiceChat.BusinessId,
      Config: memoryContext.config,
      AgentConfig: agentConfig,
    },
    context: {
      playerUserId: memoryContext.playerUserId,
      dynamicGameState: memoryContext.dynamicGameState,
      historyLength: memoryContext.historyLength,
      shortPromptMessageLimit: memoryContext.shortPromptMessageLimit,
      profile: memoryContext.profile,
      rtcProjection: memoryContext.rtcProjection,
      agentUserId: agentConfig.UserId,
    },
  };
}

function buildCustomLlmConfig(body) {
  const sessionId = body.taskId || 'default';
  const baseUrl = config.rtcLlmBridge.customLlmBaseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/api/agent/rtc-llm-stream?sessionId=${encodeURIComponent(sessionId)}`;
  const llmConfig = {
    Mode: 'CustomLLM',
    Url: url,
    HistoryLength: 0,
  };
  if (config.rtcLlmBridge.customLlmApiKey) {
    llmConfig.APIKey = config.rtcLlmBridge.customLlmApiKey;
  }
  return llmConfig;
}

function buildUpdateVoiceChatBody(body) {
  requireFields(body, ['roomId', 'taskId', 'command']);

  const payload = {
    AppId: body.appId || config.rtcAppId,
    RoomId: body.roomId,
    TaskId: body.taskId,
    Command: body.command,
  };

  if (body.message !== undefined && body.message !== null) {
    payload.Message = body.message;
  }
  if (body.interruptMode !== undefined && body.interruptMode !== null) {
    payload.InterruptMode = body.interruptMode;
  }
  if (body.imageConfig !== undefined && body.imageConfig !== null) {
    payload.ImageConfig = body.imageConfig;
  }
  if (body.parameters !== undefined && body.parameters !== null) {
    payload.Parameters = body.parameters;
  }

  return payload;
}

function buildStopVoiceChatBody(body) {
  requireFields(body, ['roomId', 'taskId']);

  return {
    AppId: body.appId || config.rtcAppId,
    RoomId: body.roomId,
    TaskId: body.taskId,
  };
}

function sanitizeResponse(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  return JSON.parse(JSON.stringify(result));
}

function maskSecret(value) {
  if (!value) {
    return '';
  }

  const text = String(value);
  if (text.length <= 8) {
    return `${text.slice(0, 2)}***`;
  }

  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

async function handleKnowledgeSearch(body) {
  const provider = body.provider || config.knowledge.mode || 'mock';
  const allowFallback = body.allowFallback !== false;

  if (provider !== 'volc') {
    return {
      provider: 'default_local',
      fallback: false,
      result: searchDefaultLocalKnowledge(body.query, Number(body.limit || config.knowledge.limit || 5)),
    };
  }

  try {
    return {
      provider: 'volc',
      fallback: false,
      result: await searchVolcKnowledge(body),
    };
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    return {
      provider: 'default_local',
      fallback: true,
      fallbackReason: error.message,
      result: searchDefaultLocalKnowledge(body.query, Number(body.limit || config.knowledge.limit || 5)),
    };
  }
}

async function handleImageGenerate(body) {
  return generateArkImage(body);
}

async function handleDouyinVideoSearch(body) {
  return searchDouyinVideo(body);
}

async function handleIntentRecognition(body) {
  const startedAt = Date.now();
  const text = String(body.text || body.query || '').trim();
  if (!text) {
    throw new Error('意图识别需要 text 或 query 参数');
  }

  let intentResult;
  let fallbackReason = '';
  try {
    intentResult = await recognizeIntent(text);
  } catch (llmError) {
    console.warn('[handleIntentRecognition] Ark Chat 调用失败，切换本地兜底', llmError.message);
    fallbackReason = llmError.message;
    intentResult = localIntentFallback(text);
  }

  const result = {
    intent: intentResult.intent,
    confidence: intentResult.confidence ?? 0.9,
    ttsSummary: intentResult.ttsSummary,
    videoQuery: intentResult.videoQuery ?? null,
    knowledgeQuery: intentResult.knowledgeQuery ?? null,
    query: text,
    suggestions: {
      knowledge: intentResult.intent === 'knowledge' ? {
        action: 'dispatchRealtimeReply',
        mode: 'knowledge',
        ttsSummary: intentResult.ttsSummary
      } : null,
      video: intentResult.intent === 'video' ? {
        action: 'dispatchRealtimeReply',
        mode: 'video',
        ttsSummary: intentResult.ttsSummary
      } : null,
      tts: intentResult.intent === 'tts' ? {
        action: 'directTts',
        ttsSummary: intentResult.ttsSummary
      } : null
    }
  };

  appendAgentTrace({
    sessionId: body.sessionId || body.session_id || body.userId || body.user_id || 'default',
    source: body.source || 'legacy_intent_api',
    userQuery: text,
    intent: result.intent,
    status: 'done',
    routeReason: fallbackReason ? `Ark Chat 失败后使用本地兜底: ${fallbackReason}` : 'legacy intent recognized',
    timeline: [
      { stage: 'input_received', at: new Date(startedAt).toISOString() },
      {
        stage: fallbackReason ? 'local_fallback_done' : 'intent_model_done',
        latency_ms: Date.now() - startedAt,
      },
    ],
    output: {
      ttsSummary: result.ttsSummary,
      knowledgeQuery: result.knowledgeQuery,
      videoQuery: result.videoQuery,
    },
  });

  return result;
}

function localIntentFallback(text) {
  const normalizedText = text.toLowerCase();
  const knowledgeKeywords = ['怎么', '如何', '什么', '哪个', '攻略', '教学', '技能', '出装', '铭文', '连招', '玩法', '规则', '教我', '告诉', '介绍', '是什么', '为什么', '哪里'];
  const videoKeywords = ['视频', '精彩视频', '看视频', '给我看', '精彩集锦', '操作', '秀', '打法', '实战'];
  const hasExcludedVideo = videoKeywords.some(kw => normalizedText.includes(kw)) && knowledgeKeywords.some(k => normalizedText.includes(k));

  let intent = 'tts';
  for (const kw of knowledgeKeywords) {
    if (normalizedText.includes(kw) && !(hasExcludedVideo && normalizedText.includes('视频'))) {
      intent = 'knowledge';
      break;
    }
  }
  if (intent === 'tts') {
    for (const kw of videoKeywords) {
      if (normalizedText.includes(kw)) {
        intent = 'video';
        break;
      }
    }
  }

  const defaultSummaries = {
    knowledge: '好的，我来为你查询相关的知识',
    video: '好的，我来为你搜索相关的精彩视频',
    tts: text.length > 50 ? text.slice(0, 50) + '...' : text
  };

  return {
    intent,
    confidence: 0.5,
    ttsSummary: defaultSummaries[intent],
    videoQuery: intent === 'video' ? text : null,
    knowledgeQuery: intent === 'knowledge' ? text : null
  };
}

async function handleDouyinVideoResolve(body) {
  return resolveDouyinVideo(body);
}

async function handleTtsGenerate(body) {
  return synthesizeVolcTts(body);
}

async function handleTtsAudio(body) {
  const result = await synthesizeVolcTts(body);
  return {
    ...result,
    audioBuffer: Buffer.from(result.audioBase64, 'base64'),
  };
}

async function handleMemorySearch(body) {
  const provider = body.provider || config.memory.mode || 'mock';
  const allowFallback = body.allowFallback !== false;

  if (provider !== 'volc' || config.memory.mode !== 'cloud') {
    return {
      provider: 'mock',
      fallback: false,
      result: searchMockMemory(body),
    };
  }

  try {
    return {
      provider: 'volc',
      fallback: false,
      result: await searchVolcMemory(body),
    };
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    return {
      provider: 'mock',
      fallback: true,
      fallbackReason: error.message,
      result: searchMockMemory(body),
    };
  }
}

async function handleMemorySave(body) {
  const provider = body.provider || config.memory.mode || 'mock';
  const allowFallback = body.allowFallback !== false;

  if (provider !== 'volc' || config.memory.mode !== 'cloud') {
    return {
      provider: 'mock',
      fallback: false,
      result: saveMockMemory(body),
    };
  }

  try {
    return {
      provider: 'volc',
      fallback: false,
      result: await saveVolcMemory(body),
    };
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }

    return {
      provider: 'mock',
      fallback: true,
      fallbackReason: error.message,
      result: saveMockMemory(body),
    };
  }
}

async function handleMemoryList(input = {}) {
  const provider = input.provider || config.memory.mode || 'mock';

  if (provider !== 'volc' || config.memory.mode !== 'cloud') {
    return {
      provider: 'mock',
      fallback: false,
      result: listMockMemory(input),
    };
  }

  return {
    provider: 'volc',
    fallback: false,
    result: await listVolcMemory(input),
  };
}

async function handleMemoryGet(memoryId, input = {}) {
  const provider = input.provider || config.memory.mode || 'mock';
  if (provider !== 'volc' || config.memory.mode !== 'cloud') {
    return {
      provider: 'mock',
      fallback: false,
      result: getMockMemory(memoryId),
    };
  }

  return {
    provider: 'volc',
    fallback: false,
    result: await getVolcMemory(memoryId),
  };
}

async function handleMemoryHistory(memoryId, input = {}) {
  const provider = input.provider || config.memory.mode || 'mock';
  if (provider !== 'volc' || config.memory.mode !== 'cloud') {
    return {
      provider: 'mock',
      fallback: false,
      result: getMockMemoryHistory(memoryId),
    };
  }

  return {
    provider: 'volc',
    fallback: false,
    result: await getVolcMemoryHistory(memoryId),
  };
}

async function handleMemoryUpdate(memoryId, body) {
  const provider = body.provider || config.memory.mode || 'mock';
  if (provider !== 'volc' || config.memory.mode !== 'cloud') {
    return {
      provider: 'mock',
      fallback: false,
      result: updateMockMemory(memoryId, body.value || ''),
    };
  }

  return {
    provider: 'volc',
    fallback: false,
    result: await updateVolcMemory(memoryId, body.value || ''),
  };
}

async function handleMemoryDelete(memoryId, body) {
  const provider = body.provider || config.memory.mode || 'mock';
  if (provider !== 'volc' || config.memory.mode !== 'cloud') {
    return {
      provider: 'mock',
      fallback: false,
      result: deleteMockMemory(memoryId),
    };
  }

  return {
    provider: 'volc',
    fallback: false,
    result: await deleteVolcMemory(memoryId),
  };
}

async function handleMemoryDeleteAll(body) {
  const provider = body.provider || config.memory.mode || 'mock';
  if (provider !== 'volc' || config.memory.mode !== 'cloud') {
    return {
      provider: 'mock',
      fallback: false,
      result: deleteAllMockMemory(body),
    };
  }

  return {
    provider: 'volc',
    fallback: false,
    result: await deleteAllVolcMemory(body),
  };
}

async function handleMemoryJob(url) {
  const provider = url.searchParams.get('provider') || config.memory.mode || 'mock';
  const eventId = url.searchParams.get('eventId') || '';
  if (provider !== 'volc' || config.memory.mode !== 'cloud') {
    return {
      provider: 'mock',
      fallback: false,
      result: getMockJobStatus(eventId),
    };
  }

  return {
    provider: 'volc',
    fallback: false,
    result: await getVolcMemoryJobStatus(eventId),
  };
}

async function handleKnowledgeHealth(url) {
  const probe = url.searchParams.get('probe') !== '0';
  const query = url.searchParams.get('query') || '你好';
  const configSummary = {
    mode: config.knowledge.mode,
    apiStyle: config.knowledge.apiStyle,
    host: config.knowledge.host,
    endpointPath: config.knowledge.endpointPath,
    resourceId: maskSecret(config.knowledge.resourceId),
    collectionName: config.knowledge.collectionName || '',
    serviceResourceId: config.knowledge.serviceResourceId || '',
    apiKeyConfigured: Boolean(config.knowledge.apiKey),
  };

  if (!probe) {
    return {
      ready: true,
      reachable: null,
      checkedAt: new Date().toISOString(),
      config: configSummary,
    };
  }

  try {
    const result = await searchVolcKnowledge({
      query,
      limit: 1,
      stream: false,
      messages: [
        {
          role: 'user',
          content: query,
        },
      ],
    });

    const resultList = result?.data?.result_list || [];

    return {
      ready: true,
      reachable: true,
      checkedAt: new Date().toISOString(),
      config: configSummary,
      probe: {
        query,
        hitCount: resultList.length,
        preview:
          resultList[0]?.content ||
          resultList[0]?.chunk_title ||
          '知识库接口已返回结果',
      },
    };
  } catch (error) {
    return {
      ready: false,
      reachable: false,
      checkedAt: new Date().toISOString(),
      config: configSummary,
      error: {
        message: error.message,
        code: error.code,
        requestId: error.requestId,
      },
    };
  }
}

async function handleMemoryHealth(url) {
  const mode = config.memory.mode || 'mock';

  if (mode === 'viking') {
    const vikingHealth = await checkVikingMemoryHealth();
    return {
      ...vikingHealth,
      config: getMemoryConfigSummary(),
    };
  }

  if (mode !== 'volc') {
    return {
      ...getMockMemoryHealth(),
      config: getMemoryConfigSummary(),
    };
  }

  const runtime = await checkVolcMemoryHealth({
    userId: url.searchParams.get('userId') || 'healthcheck_probe',
  });
  const management = await checkVolcMemoryManagementHealth();
  const managementRequired = management.configured;
  const runtimeReady = Boolean(runtime.ready);
  const managementReady = managementRequired ? Boolean(management.ready) : true;

  return {
    ...runtime,
    ready: runtimeReady && managementReady,
    config: getMemoryConfigSummary(),
    runtime,
    management,
  };
}

async function handleMemoryProjectList() {
  const result = await describeVolcMemoryProjects();
  return {
    provider: 'volc',
    fallback: false,
    result,
  };
}

async function handleMemoryProjectDetail(memoryProjectId = '') {
  const result = await describeVolcMemoryProjectDetail(memoryProjectId || config.memory.projectId);
  return {
    provider: 'volc',
    fallback: false,
    result,
  };
}

function extractFunctionToolCalls(payload = {}) {
  const candidates = [
    payload.tool_calls,
    payload.toolCalls,
    payload.ToolCalls,
    payload.data?.tool_calls,
    payload.data?.toolCalls,
    payload.message?.tool_calls,
    payload.message?.toolCalls,
  ].find(Array.isArray);

  return Array.isArray(candidates) ? candidates : [];
}

function parseToolArguments(argumentsValue) {
  if (!argumentsValue) {
    return {};
  }

  if (typeof argumentsValue === 'object') {
    return argumentsValue;
  }

  try {
    return JSON.parse(argumentsValue);
  } catch (error) {
    return {};
  }
}

function extractKnowledgeResultItems(result = {}) {
  const list = result?.data?.result_list;
  return Array.isArray(list) ? list : [];
}

function summarizeKnowledgeSearchResult(result = {}) {
  const items = extractKnowledgeResultItems(result).slice(0, 3);
  if (items.length === 0) {
    return '未检索到可用知识';
  }

  return items
    .map((item, index) => {
      const title = String(item?.chunk_title || item?.doc_info?.title || item?.doc_info?.doc_name || `知识${index + 1}`).trim();
      const content = String(item?.content || '').replace(/\s+/g, ' ').trim();
      return `- ${title}: ${content}`;
    })
    .join('\n');
}

function normalizeCoachPlanArgs(args = {}) {
  return {
    trigger: String(args.trigger || '').trim(),
    objective: String(args.objective || '').trim(),
    timing: String(args.timing || '').trim(),
    plan: Array.isArray(args.plan)
      ? args.plan.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    risks: Array.isArray(args.risks)
      ? args.risks.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };
}

async function handleRtcFunctionCallingCallback(body = {}) {
  const toolCalls = extractFunctionToolCalls(body);
  const taskId = String(body.taskId || body.TaskId || body.data?.taskId || body.data?.TaskId || '').trim();
  const roomId = String(body.roomId || body.RoomId || body.data?.roomId || body.data?.RoomId || '').trim();
  const session = taskId ? getRtcSessionState(taskId) : null;
  const playerUserId = String(
    body.userId || body.UserId || body.data?.userId || body.data?.UserId || session?.userId || ''
  ).trim();
  const results = [];

  for (const item of toolCalls) {
    const functionName =
      item?.function?.name || item?.Function?.Name || item?.name || item?.Name || '';
    const toolCallId =
      item?.id || item?.tool_call_id || item?.toolCallId || item?.ToolCallID || item?.ToolCallId || '';
    const args = parseToolArguments(
      item?.function?.arguments ||
        item?.function?.Arguments ||
        item?.Function?.Arguments ||
        item?.arguments ||
        item?.Arguments
    );
    let functionContent = '';
    let resultPayload = {
      ok: false,
      functionName,
      toolCallId,
    };

    if (functionName === 'update_user_profile') {
      const key = String(args.key || '').trim();
      const value = String(args.value || '').trim();

      if (!playerUserId || !key || !value) {
        results.push({
          ...resultPayload,
          reason: '缺少 userId、key 或 value，已跳过画像更新',
        });
        continue;
      }

      const profile = updateRtcPersonaProfile(playerUserId, key, value, {
        source: 'rtc_function_call',
        taskId,
        roomId,
      });
      functionContent = `已更新玩家画像：${key}=${value}`;
      resultPayload = {
        ok: true,
        functionName,
        toolCallId,
        userId: playerUserId,
        key,
        value,
        profile,
      };
    } else if (functionName === 'query_game_knowledge') {
      const query = String(args.query || '').trim();
      const topK = Math.max(1, Math.min(5, Number(args.top_k || args.topK || 3) || 3));
      if (!query) {
        results.push({
          ...resultPayload,
          reason: '缺少 query，已跳过知识检索',
        });
        continue;
      }

      const knowledgeResult = await handleKnowledgeSearch({
        query,
        limit: topK,
        provider: config.knowledge.mode,
        allowFallback: true,
      });
      const summary = summarizeKnowledgeSearchResult(knowledgeResult.result);
      if (session) {
        upsertRtcSessionState({
          ...session,
          metadata: {
            ...(session.metadata || {}),
            retrievedKnowledge: summary,
            retrievedKnowledgeUpdatedAt: new Date().toISOString(),
          },
        });
      }
      functionContent = `已检索知识：\n${summary}`;
      resultPayload = {
        ok: true,
        functionName,
        toolCallId,
        query,
        knowledgeProvider: knowledgeResult.provider,
        fallback: knowledgeResult.fallback === true,
        knowledgeSummary: summary,
      };
    } else if (functionName === 'submit_coach_plan') {
      const normalizedPlan = normalizeCoachPlanArgs(args);
      if (
        !normalizedPlan.trigger ||
        !normalizedPlan.objective ||
        !normalizedPlan.timing ||
        normalizedPlan.plan.length === 0
      ) {
        results.push({
          ...resultPayload,
          reason: '缺少 trigger、objective、timing 或 plan，已跳过战术计划提交',
        });
        continue;
      }

      if (session) {
        upsertRtcSessionState({
          ...session,
          metadata: {
            ...(session.metadata || {}),
            latestCoachPlan: normalizedPlan,
            latestCoachPlanUpdatedAt: new Date().toISOString(),
          },
        });
      }
      functionContent = `已记录战术计划：${JSON.stringify(normalizedPlan)}`;
      resultPayload = {
        ok: true,
        functionName,
        toolCallId,
        coachPlan: normalizedPlan,
      };
    } else {
      continue;
    }

    let updateResult = null;
    let updateError = null;
    if (toolCallId && taskId && roomId) {
      try {
        // Wrap tool results in brackets so even if an upstream TTS/subtitle pipeline accidentally
        // treats this message as speakable content, it is less likely to be read aloud.
        // (The voice-chat config uses IgnoreBracketText, and our system prompt also places
        // non-speakable content into brackets.)
        const safeFunctionContent = `(工具调用结果: ${functionName || 'unknown'})\n${functionContent}`;
        updateResult = await callRtcOpenApi('UpdateVoiceChat', {
          AppId: config.rtcAppId,
          RoomId: roomId,
          TaskId: taskId,
          Command: 'function',
          Message: JSON.stringify({
            ToolCallID: toolCallId,
            Content: safeFunctionContent,
          }),
        });
      } catch (error) {
        updateError = {
          message: error.message,
          code: error.code,
          requestId: error.requestId,
        };
      }
    }

    results.push({
      ...resultPayload,
      rtcUpdateResult: sanitizeResponse(updateResult),
      rtcUpdateError: updateError,
    });
  }

  return {
    received: true,
    processed: results.length,
    results,
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const staticFilePath = resolveStaticFilePath(url.pathname);
    if (staticFilePath && sendStaticFile(response, staticFilePath)) {
      return;
    }
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'volc-aigc-rtc-server',
      knowledgeMode: config.knowledge.mode,
      time: new Date().toISOString(),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/readme') {
    const readmeCandidates = [
      path.resolve(frontendRoot, 'README.github.md'),
      path.resolve(frontendRoot, 'README.md'),
    ];
    try {
      const readmePath = readmeCandidates.find((candidate) => fs.existsSync(candidate));
      if (!readmePath) {
        throw new Error('README_NOT_FOUND');
      }
      const content = fs.readFileSync(readmePath, 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      response.end(content);
    } catch (error) {
      sendJson(response, 404, {
        ok: false,
        message: 'README 不存在',
        path: readmeCandidates[0],
      });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/session/list') {
    sendJson(response, 200, {
      ok: true,
      data: listSessionRecords(url.searchParams.get('limit')),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/users/list') {
    try {
      const list = listUserProfiles();
      sendJson(response, 200, { ok: true, data: { list } });
    } catch (error) {
      sendJson(response, 500, { ok: false, message: error?.message || '用户列表加载失败' });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/data/users/create') {
    try {
      const body = await readJsonBody(request);
      const profile = createUserProfile({
        userId: String(body?.userId || body?.user_id || '').trim(),
        displayName: String(body?.displayName || body?.display_name || '').trim(),
      });
      sendJson(response, 200, { ok: true, data: profile });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: error?.message || '创建用户失败' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/users/overlay-status') {
    const userId = String(url.searchParams.get('userId') || '').trim();
    if (!userId) {
      sendJson(response, 400, { ok: false, message: 'userId 必填' });
      return;
    }
    sendJson(response, 200, { ok: true, data: getOverlayStatus(userId) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/data/users/reset-overlay') {
    try {
      const body = await readJsonBody(request);
      const userId = String(body?.userId || body?.user_id || '').trim();
      if (!userId) {
        sendJson(response, 400, { ok: false, message: 'userId 必填' });
        return;
      }
      resetUserOverlay(userId);
      sendJson(response, 200, { ok: true, data: getOverlayStatus(userId) });
    } catch (error) {
      sendJson(response, 400, { ok: false, message: error?.message || '重置失败' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/rtc/profile') {
    const userId = url.searchParams.get('userId') || '';
    sendJson(response, 200, {
      ok: true,
      data: getRtcPersonaProfile(userId),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/rtc/voice-chat/features') {
    sendJson(response, 200, {
      ok: true,
      data: {
        configPath: config.defaults.startVoiceChatConfigPath,
        features: getRtcVoiceFeatureState(),
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/memory/list') {
    const result = await handleMemoryList({
      provider: url.searchParams.get('provider') || '',
      userId: url.searchParams.get('userId') || '',
      agentId: url.searchParams.get('agentId') || '',
      limit: url.searchParams.get('limit') || 20,
    });
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/memory/item') {
    const result = await handleMemoryGet(url.searchParams.get('memoryId') || '', {
      provider: url.searchParams.get('provider') || '',
    });
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/memory/history') {
    const result = await handleMemoryHistory(url.searchParams.get('memoryId') || '', {
      provider: url.searchParams.get('provider') || '',
    });
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/memory/job') {
    const result = await handleMemoryJob(url);
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/memory/project/list') {
    const result = await handleMemoryProjectList();
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/memory/project/detail') {
    const result = await handleMemoryProjectDetail(url.searchParams.get('memoryProjectId') || '');
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/knowledge/health') {
    const result = await handleKnowledgeHealth(url);
    sendJson(response, result.ready ? 200 : 503, {
      ok: result.ready,
      data: result,
      message: result.ready ? '知识库服务可用' : result.error?.message || '知识库服务不可用',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/memory/health') {
    const result = await handleMemoryHealth(url);
    sendJson(response, result.ready ? 200 : 503, {
      ok: result.ready,
      data: result,
      message: result.ready ? '记忆库服务可用' : result.error?.message || '记忆库服务不可用',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent/orchestrate/events') {
    const sessionId = url.searchParams.get('sessionId') || 'default';
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const heartbeat = setInterval(() => {
      response.write(':heartbeat\n\n');
    }, 15000);
    const unsubscribe = subscribeToEventBus(sessionId, (event, data) => {
      writeSseEvent(response, event, data);
    });
    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent/traces') {
    // #region debug-point A:server-agent-traces
    try { fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'agent-ui-errors', runId: 'pre-fix', hypothesisId: 'A', location: 'server.js:1588', msg: '[DEBUG] server route hit /api/agent/traces', data: { method: request.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams.entries()) }, ts: Date.now() }) }).catch(() => {}); } catch (_) {}
    // #endregion
    const result = listAgentTraces(Object.fromEntries(url.searchParams.entries()));
    sendJson(response, 200, {
      ok: true,
      data: result,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/agent/traces/')) {
    const turnId = decodeURIComponent(url.pathname.replace('/api/agent/traces/', ''));
    const result = getAgentTrace(turnId);
    sendJson(response, result ? 200 : 404, {
      ok: Boolean(result),
      data: result,
      message: result ? undefined : '未找到对应的编排日志',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/agent/reflections/list') {
    try {
      const params = Object.fromEntries(url.searchParams.entries());
      // 兼容前端用 userId 查询：项目内 sessionId 通常 = userId
      const sessionId = params.sessionId || params.session_id || params.userId || params.user_id || '';
      const keyword = String(params.keyword || params.q || '').trim().toLowerCase();
      const intent = String(params.intent || '').trim();
      const limit = Math.max(1, Math.min(200, Number(params.limit || 50) || 50));
      const offset = Math.max(0, Number(params.offset || 0) || 0);

      // 先按 sessionId / intent 过滤再做关键词二次过滤
      const raw = listReflectionLogs({ sessionId: sessionId === 'all' ? '' : sessionId, intent, limit: 500, offset: 0 });
      let rows = raw.list;
      if (keyword) {
        rows = rows.filter((r) => {
          const hay = [
            r.user_query, r.main_summary, r.intent,
            r.reflection?.this_turn?.improvements,
            r.reflection?.memory_promotion?.content,
            r.reflection?.proactive?.bridge_question,
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(keyword);
        });
      }
      const total = rows.length;
      const list = rows.slice(offset, offset + limit);
      const summary = summarizeReflectionLogs({ intent });
      sendJson(response, 200, { ok: true, data: { total, limit, offset, list, summary, sessionId } });
    } catch (error) {
      sendJson(response, 500, { ok: false, message: error?.message || 'reflection 列表加载失败' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/agent/session/')) {
    const sessionId = decodeURIComponent(url.pathname.replace('/api/agent/session/', '').replace(/\/state$/, ''));
    sendJson(response, 200, {
      ok: true,
      data: getAgentSessionState(sessionId || 'default'),
    });
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 404, { ok: false, message: '接口不存在' });
    return;
  }

  const body = await readJsonBody(request);

  if (url.pathname === '/api/agent/orchestrate/trigger') {
    const sessionId = body.sessionId || body.session_id || 'default';
    // source 兜底：调用方未传时显式打成 orchestrate_trigger，避免 trace 显示 'unknown'
    if (!body.source) body.source = 'orchestrate_trigger';
    runAgentOrchestration(body, (event, data) => {
      appendSessionEvent(sessionId, { event, data });
      publishToEventBus(sessionId, event, data);
    }).catch((err) => {
      console.error('[OrchestrateTrigger] background error:', err.message);
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/agent/orchestrate/stream') {
    const sessionId = body.sessionId || body.session_id || body.taskId || 'default';

    if (hasSessionBuffer(sessionId) || isOrchestrationRunning(sessionId)) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const existingEvents = getSessionEvents(sessionId);
      for (const evt of existingEvents) {
        writeSseEvent(response, evt.event, evt.data);
      }

      if (isOrchestrationDone(sessionId)) {
        response.end();
        return;
      }

      let lastIndex = existingEvents.length > 0 ? existingEvents[existingEvents.length - 1]._index : -1;
      const unsubscribe = subscribeSessionEvents(sessionId, (evt) => {
        if (evt._index > lastIndex) {
          writeSseEvent(response, evt.event, evt.data);
          lastIndex = evt._index;
        }
      });

      const checkDone = setInterval(() => {
        if (isOrchestrationDone(sessionId)) {
          clearInterval(checkDone);
          unsubscribe();
          response.end();
        }
      }, 200);

      response.on('close', () => {
        clearInterval(checkDone);
        unsubscribe();
      });
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    await runAgentOrchestration(
      Object.assign({}, body, { source: body.source || 'orchestrate_stream' }),
      (event, data) => writeSseEvent(response, event, data),
    );
    response.end();
    return;
  }

  if (url.pathname === '/api/agent/rtc-llm-stream') {
    const sessionId = body.sessionId || url.searchParams.get('sessionId') || 'default';
    await handleRtcLlmStream(body, response, sessionId);
    return;
  }

  if (url.pathname === '/api/agent/rtc-push-tts') {
    const result = await handleRtcPushTts(body);
    sendJson(response, result.ok ? 200 : 400, result);
    return;
  }

  if (url.pathname === '/api/agent/orchestrate/start') {
    const events = [];
    const state = await runAgentOrchestration(
      Object.assign({}, body, { source: body.source || 'orchestrate_start' }),
      (event, data) => {
        events.push({ event, data });
      },
    );
    sendJson(response, 200, {
      ok: state.status !== 'failed',
      data: {
        state,
        events,
      },
      message: state.error || undefined,
    });
    return;
  }

  if (url.pathname === '/api/agent/context/frame') {
    const sessionId = body.sessionId || body.session_id || 'default';
    const result = upsertAgentDynamicContext(sessionId, {
      [body.source || 'frameContext']: {
        summary: body.summary || '',
        objects: body.objects || [],
        confidence: body.confidence ?? null,
        expiresInMs: body.expiresInMs || null,
      },
    });
    sendJson(response, 200, { ok: true, data: result });
    return;
  }

  if (url.pathname === '/api/agent/screen/event') {
    const sessionId = body.sessionId || body.session_id || 'default';
    try {
      const { processFrame } = await import('./services/screenEventService.js');
      const out = processFrame({ rawFrame: body.frame || body, sessionId });
      if (out.allowed && out.picked) {
        // 屏幕观察走"静默感知"路径：只写审计日志，不向 SSE / TTS 播报。
        // 主动播报由 Reflector 的 proactive_cue 通道统一负责。
        const eventPayload = {
          session_id: sessionId,
          event_type: out.picked.type,
          priority: out.picked.priority,
          confidence: out.picked.confidence,
          game: out.frame.game,
          scene: out.frame.scene,
          frame_id: out.frame.frame_id,
          ts: out.frame.ts,
        };
        appendSessionEvent(sessionId, { event: 'screen_observation_logged', data: eventPayload });
      }
      sendJson(response, 200, {
        ok: true,
        data: {
          frame_id: out.frame.frame_id,
          picked: out.picked,
          allowed: out.allowed,
          allowed_reason: out.allowed_reason,
          cooldown_left_ms: out.cooldown_left_ms,
        },
      });
    } catch (err) {
      sendJson(response, 500, { ok: false, message: err.message || 'screen event failed' });
    }
    return;
  }

  if (url.pathname === '/api/agent/screen/frame') {
    const sessionId = body.sessionId || body.session_id || 'default';
    try {
      const { recognizeFrame } = await import('./services/visionFrameService.js');
      const { processFrame } = await import('./services/screenEventService.js');
      const recog = await recognizeFrame({
        base64Image: body.base64Image || body.image || '',
        mimeType: body.mimeType || 'image/jpeg',
        frameId: body.frameId || `frame_${Date.now()}`,
        mockHints: body.mockHints || null,
      });
      const out = processFrame({ rawFrame: recog.frame, sessionId });
      if (out.allowed && out.picked) {
        // 静默感知：仅审计入库，不广播到 SSE。
        const eventPayload = {
          session_id: sessionId,
          event_type: out.picked.type,
          priority: out.picked.priority,
          confidence: out.picked.confidence,
          game: out.frame.game,
          scene: out.frame.scene,
          frame_id: out.frame.frame_id,
          ts: out.frame.ts,
        };
        appendSessionEvent(sessionId, { event: 'screen_observation_logged', data: eventPayload });
      }
      sendJson(response, 200, {
        ok: true,
        data: {
          frame_id: out.frame.frame_id,
          recognition: {
            degraded: recog.degraded,
            reason: recog.reason,
            latency_ms: recog.latency_ms,
          },
          picked: out.picked,
          allowed: out.allowed,
          allowed_reason: out.allowed_reason,
        },
      });
    } catch (err) {
      sendJson(response, 500, { ok: false, message: err.message || 'frame recognition failed' });
    }
    return;
  }

  if (url.pathname === '/api/agent/session/clear') {
    const result = clearAgentSessionState(body.sessionId || body.session_id || 'default');
    sendJson(response, 200, { ok: true, data: result });
    return;
  }

  if (url.pathname === '/api/rtc/profile/update') {
    requireFields(body, ['userId', 'key', 'value']);
    const result = updateRtcPersonaProfile(body.userId, body.key, body.value, {
      source: body.source || 'manual',
    });
    sendJson(response, 200, {
      ok: true,
      data: result,
    });
    return;
  }

  if (url.pathname === '/api/rtc/session/message') {
    requireFields(body, ['taskId', 'role', 'content']);
    const result = appendRtcSessionMessage(body.taskId, {
      role: body.role,
      content: body.content,
      source: body.source || 'manual',
    });
    sendJson(response, 200, {
      ok: true,
      data: result,
    });
    return;
  }

  if (url.pathname === '/api/rtc/callbacks/function-calling') {
    const result = await handleRtcFunctionCallingCallback(body);
    sendJson(response, 200, {
      ok: true,
      data: result,
    });
    return;
  }

  if (url.pathname === '/api/rtc/token') {
    const result = await generateRtcToken(pickTokenRequest(body));
    sendJson(response, 200, { ok: true, data: result });
    return;
  }

  if (url.pathname === '/api/rtc/voice-chat/features') {
    sendJson(response, 200, {
      ok: true,
      data: updateRtcVoiceFeatureState(body),
    });
    return;
  }

  if (url.pathname === '/api/data/knowledge/search') {
    const result = await handleKnowledgeSearch(body);
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      fallbackReason: result.fallbackReason,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (url.pathname === '/api/data/knowledge/search-multi') {
    const query = String(body.query || body.text || '').trim();
    if (!query) {
      sendJson(response, 400, { ok: false, error: 'query 不能为空' });
      return;
    }
    const incomingSources = Array.isArray(body.sources) ? body.sources : [];
    const sanitizedSources = incomingSources
      .filter((s) => s && typeof s === 'object' && typeof s.type === 'string')
      .map((s) => ({
        type: s.type,
        domain: s.domain || null,
        label: s.label || '',
        enabled: s.enabled !== false,
        topK: Number(s.topK) > 0 ? Number(s.topK) : 5,
        items: Array.isArray(s.items) ? s.items : undefined,
        apiKey: s.apiKey || undefined,
        serviceResourceId: s.serviceResourceId || undefined,
      }))
      .filter((s) => s.enabled);

    const effectiveSources = sanitizedSources.length > 0 ? sanitizedSources : [
      { type: 'default_local', domain: 'lol', label: '内置·英雄联盟示例库', enabled: true, topK: 5 },
      { type: 'default_local', domain: 'wzry', label: '内置·王者荣耀示例库', enabled: true, topK: 5 },
      { type: 'house_volc', label: '官方云端库', enabled: true, topK: 5 },
    ];

    try {
      const multi = await multiSourceSearch({
        query,
        sources: effectiveSources,
        topK: Number(body.topK || body.limit || config.knowledge.limit || 5),
        rerankStrategy: body.rerankStrategy || body.rerank_strategy || 'embedding',
      });
      sendJson(response, 200, {
        ok: true,
        provider: 'multi_source',
        data: {
          query,
          detectedDomains: multi.detectedDomains,
          items: multi.items,
          summary: multi.summary,
          skipped: multi.skipped,
          skippedSources: multi.skippedSources || [],
          rerankSource: multi.rerankSource,
          poolSize: multi.poolSize,
          cacheHit: Boolean(multi.cacheHit),
          sources: effectiveSources.map((s) => ({ type: s.type, domain: s.domain, label: s.label })),
        },
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error.message || '多源知识库检索失败',
      });
    }
    return;
  }

  if (url.pathname === '/api/data/knowledge/predict-domain') {
    const filename = String(body.filename || body.name || '').trim();
    const text = String(body.text || body.snippet || body.content || '').trim();
    if (!filename && !text) {
      sendJson(response, 400, { ok: false, error: 'filename 与 text 至少提供一个' });
      return;
    }
    try {
      const result = await predictDocumentDomain({ filename, text });
      sendJson(response, 200, { ok: true, data: result });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error.message || 'domain 预判失败' });
    }
    return;
  }

  if (url.pathname === '/api/data/knowledge/embedding') {
    const inputs = Array.isArray(body.texts)
      ? body.texts
      : (body.text ? [body.text] : []);
    const cleaned = inputs.map((t) => String(t || '')).filter((t) => t.trim());
    if (cleaned.length === 0) {
      sendJson(response, 400, { ok: false, error: 'texts 不能为空' });
      return;
    }
    if (cleaned.length > 256) {
      sendJson(response, 400, { ok: false, error: '单次最多 256 条' });
      return;
    }
    try {
      const { vectors, dim, model } = await callArkEmbedding({ texts: cleaned, model: body.model });
      sendJson(response, 200, { ok: true, data: { vectors, dim, model, count: vectors.length } });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error.message || 'embedding 失败' });
    }
    return;
  }

  if (url.pathname === '/api/data/memory/search') {
    const result = await handleMemorySearch(body);
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      fallbackReason: result.fallbackReason,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (url.pathname === '/api/data/memory/save') {
    const result = await handleMemorySave(body);
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      fallbackReason: result.fallbackReason,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (url.pathname === '/api/data/memory/update') {
    const result = await handleMemoryUpdate(body.memoryId || '', body);
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (url.pathname === '/api/data/memory/delete') {
    const result = await handleMemoryDelete(body.memoryId || '', body);
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (url.pathname === '/api/data/memory/delete-all') {
    const result = await handleMemoryDeleteAll(body);
    sendJson(response, 200, {
      ok: true,
      provider: result.provider,
      fallback: result.fallback,
      data: sanitizeResponse(result.result),
    });
    return;
  }

  if (url.pathname === '/api/data/viking/event/add') {
    try {
      const result = await vikingAddEvent(body);
      sendJson(response, 200, {
        ok: true,
        provider: 'viking',
        data: result,
      });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        provider: 'viking',
        error: { message: error.message, code: error.code },
      });
    }
    return;
  }

  if (url.pathname === '/api/data/viking/profile/search') {
    try {
      const result = await vikingSearchProfile(body);
      sendJson(response, 200, {
        ok: true,
        provider: 'viking',
        data: result,
      });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        provider: 'viking',
        error: { message: error.message, code: error.code },
      });
    }
    return;
  }

  if (url.pathname === '/api/data/viking/event/search') {
    try {
      const result = await vikingSearchEvent(body);
      sendJson(response, 200, {
        ok: true,
        provider: 'viking',
        data: result,
      });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        provider: 'viking',
        error: { message: error.message, code: error.code },
      });
    }
    return;
  }

  if (url.pathname === '/api/data/viking/memory/search') {
    try {
      const result = await vikingSearchMemory(body);
      sendJson(response, 200, {
        ok: true,
        provider: 'viking',
        data: result,
      });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        provider: 'viking',
        error: { message: error.message, code: error.code },
      });
    }
    return;
  }

  if (url.pathname === '/api/data/viking/context') {
    try {
      const result = await vikingGetContext(body);
      sendJson(response, 200, {
        ok: true,
        provider: 'viking',
        data: result,
      });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        provider: 'viking',
        error: { message: error.message, code: error.code },
      });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/data/viking/collection/info') {
    try {
      const result = await vikingCollectionInfo();
      sendJson(response, 200, {
        ok: true,
        provider: 'viking',
        data: result,
      });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        provider: 'viking',
        error: { message: error.message, code: error.code },
      });
    }
    return;
  }

  if (url.pathname === '/api/data/session/save') {
    const payload = body.record && typeof body.record === 'object' ? body.record : body;
    const result = saveSessionRecord(payload);
    sendJson(response, 200, {
      ok: true,
      data: result,
    });
    return;
  }

  if (url.pathname === '/api/media/image/generate') {
    const result = await handleImageGenerate(body);
    sendJson(response, 200, {
      ok: true,
      data: sanitizeResponse(result),
    });
    return;
  }

  // 兼容旧入口：当 Agent 编排完成后，正式链路应迁移到 /api/agent/orchestrate/*
  // 该接口仅保留给旧 IntentModule、调试工具和渐进式回滚使用。
  if (url.pathname === '/api/agent/intent') {
    const result = await handleIntentRecognition(body);
    sendJson(response, 200, {
      ok: true,
      data: sanitizeResponse(result),
    });
    return;
  }

  if (url.pathname === '/api/media/douyin/video-search') {
    const result = await handleDouyinVideoSearch(body);
    sendJson(response, 200, {
      ok: true,
      data: sanitizeResponse(result),
    });
    return;
  }

  if (url.pathname === '/api/media/douyin/video-resolve') {
    const result = await handleDouyinVideoResolve(body);
    sendJson(response, 200, {
      ok: true,
      data: sanitizeResponse(result),
    });
    return;
  }

  if (url.pathname === '/api/media/tts/generate') {
    const result = await handleTtsGenerate(body);
    sendJson(response, 200, {
      ok: true,
      data: sanitizeResponse(result),
    });
    return;
  }

  if (url.pathname === '/api/media/tts/audio') {
    const result = await handleTtsAudio(body);
    response.writeHead(200, {
      'Content-Type': result.mimeType || 'audio/mpeg',
      'Content-Length': result.audioBuffer.length,
      'Cache-Control': 'no-store',
    });
    response.end(result.audioBuffer);
    return;
  }

  if (url.pathname === '/api/rtc/voice-chat/start') {
    const { payload, context } = await buildStartVoiceChatRequest(body);
    upsertRtcSessionState({
      taskId: payload.TaskId,
      roomId: payload.RoomId,
      userId: context.playerUserId,
      agentUserId: context.agentUserId,
      dynamicGameState: context.dynamicGameState,
      historyLength: context.historyLength,
      metadata: {
        businessId: payload.BusinessId || '',
        sessionId: body.sessionId || body.session_id || context.playerUserId || '',
        rtcProjection: context.rtcProjection || {},
      },
    });
    const result = await callRtcOpenApi('StartVoiceChat', payload);
    sendJson(response, 200, {
      ok: true,
      action: 'StartVoiceChat',
      requestBody: payload,
      memoryContext: {
        userId: context.playerUserId,
        dynamicGameState: context.dynamicGameState,
        historyLength: context.historyLength,
        shortPromptMessageLimit: context.shortPromptMessageLimit,
        profile: context.profile,
        rtcProjection: context.rtcProjection || {},
        customLlmMode: context.customLlmMode === true,
      },
      data: sanitizeResponse(result),
    });
    return;
  }

  if (url.pathname === '/api/rtc/voice-chat/update') {
    const payload = buildUpdateVoiceChatBody(body);
    if (body.command === 'ExternalTextToLLM' && body.message && body.skipSessionMessageSync !== true) {
      appendRtcSessionMessage(body.taskId, {
        role: 'user',
        content: body.message,
        source: 'external_text_to_llm',
      });
    }
    if (body.command === 'ExternalPromptsForLLM' && body.message) {
      appendRtcSessionMessage(body.taskId, {
        role: 'system',
        content: body.message,
        source: 'external_prompts_for_llm',
      });
    }
    const session = getRtcSessionState(body.taskId);
    const nextRetrievedKnowledge = resolveRetrievedKnowledge(body, session);
    if (session && (body.parameters?.dynamicGameState || body.dynamicGameState || nextRetrievedKnowledge)) {
      upsertRtcSessionState({
        ...session,
        dynamicGameState: body.parameters?.dynamicGameState || body.dynamicGameState || session.dynamicGameState,
        metadata: {
          ...(session.metadata || {}),
          retrievedKnowledge: nextRetrievedKnowledge || session.metadata?.retrievedKnowledge || '',
        },
      });
    }
    const result = await callRtcOpenApi('UpdateVoiceChat', payload);
    sendJson(response, 200, {
      ok: true,
      action: 'UpdateVoiceChat',
      requestBody: payload,
      data: sanitizeResponse(result),
    });
    return;
  }

  if (url.pathname === '/api/rtc/voice-chat/stop') {
    const payload = buildStopVoiceChatBody(body);
    const result = await callRtcOpenApi('StopVoiceChat', payload);
    sendJson(response, 200, {
      ok: true,
      action: 'StopVoiceChat',
      requestBody: payload,
      data: sanitizeResponse(result),
    });
    return;
  }

  if (url.pathname === '/api/eval/generate') {
    const question = String(body.question || '').trim();
    const userId = String(body.user_id || body.userId || 'default').trim();
    // mode=proactive_check：评测 AI 在"无显式提问"场景下是否克制（silence 评测专用）
    // 此模式允许 question 为空，由屏幕画面 / 上下文驱动 AI 判断"该不该说话"
    // 内部用 sentinel 文本作为 query，避免下游 userQuery='' 引发的容错分支
    const mode = String(body.mode || 'qa').trim();
    const isProactiveCheck = mode === 'proactive_check';
    if (!question && !isProactiveCheck) {
      sendJson(response, 400, { ok: false, message: '缺少 question 参数' });
      return;
    }
    try {
      // 评测专用：允许 case 注入最近 1-2 轮历史，真实写入 session 黑板，
      // 用于验证话题延续、代词恢复、脱轨控制等多轮上下文能力。
      if (Array.isArray(body.prior_turns) && body.prior_turns.length) {
        clearAgentSessionState(userId);
        body.prior_turns.slice(-3).forEach((turn, index) => {
          appendAgentSessionTurn(userId, {
            turn_id: turn.turn_id || `${body.case_id || 'eval'}-prior-${index + 1}`,
            user_query: String(turn.user_query || turn.question || '').trim(),
            intent: String(turn.intent || 'unknown').trim(),
            summary: String(turn.summary || turn.main_summary || '').trim(),
            main_summary: String(turn.main_summary || turn.summary || '').trim(),
            rag_summary: String(turn.rag_summary || '').trim(),
            timestamp: turn.timestamp || new Date(Date.now() - (body.prior_turns.length - index) * 1000).toISOString(),
          });
        });
      }
      const events = [];
      const effectiveQuery = question || '(玩家未发言，仅有屏幕画面信号)';
      const state = await runAgentOrchestration(
        {
          ...body,
          userId,
          taskId: `eval-${Date.now()}`,
          query: effectiveQuery,
          mode,
          // proactive_check 标记，便于下游 mainAgentService 识别并采取克制策略
          proactive_check: isProactiveCheck,
          // source 兜底：silence 评测打成 eval_silence，常规问答打成 eval_qa；调用方显式传值优先
          source: body.source || (isProactiveCheck ? 'eval_silence' : 'eval_qa'),
        },
        (event, data) => {
          events.push({ event, data });
        },
      );
      const mainOutput = state || {};
      const tacticData = mainOutput.tactic_data || null;
      const videoData = mainOutput.video_data || null;
      const videoQueries = mainOutput.video_queries || null;
      const taskPlanEvent = events.find((e) => e.event === 'task_plan');
      const taskPlan = taskPlanEvent?.data || null;
      // 评测旁路：强制再跑一次 TaskPlanner，绕开 main_intent==='smalltalk' 的短路逻辑。
      // 这样即便主脑把"情绪+战术"复合句误判为 smalltalk 导致主链路 task_plan 为空，
      // compound 评测仍能拿到 LLM 拆解的真实结果，便于把"路由识别失败"和"拆解能力失败"两类问题分开归因。
      let taskPlanForced = null;
      if (mode !== 'proactive_check') {
        try {
          taskPlanForced = await planTasksDirect({
            user_query: effectiveQuery,
            // 强制按 strategy 触发拆解（绕开 smalltalk 短路）
            main_intent: mainOutput.intent && mainOutput.intent !== 'smalltalk' ? mainOutput.intent : 'strategy',
            main_reply: mainOutput,
          });
        } catch (forceErr) {
          taskPlanForced = { task_plan: [], mode: 'single', reason: `forced_failed:${forceErr.message}` };
        }
      }
      const tacticBlock = tacticData
        ? [
            tacticData.title ? `【战术标题】${tacticData.title}` : '',
            Array.isArray(tacticData.details) && tacticData.details.length
              ? `【要点】\n- ${tacticData.details.join('\n- ')}`
              : '',
            Array.isArray(tacticData.voice_chunks) && tacticData.voice_chunks.length
              ? `【口播】${tacticData.voice_chunks.join(' ')}`
              : '',
          ].filter(Boolean).join('\n')
        : '';
      const videoBlock = videoData
        ? [
            videoData.title ? `【视频标题】${videoData.title}` : '',
            videoData.summary ? `【视频摘要】${videoData.summary}` : '',
            videoData.query ? `【搜索关键词】${videoData.query}` : '',
            videoData.linkUrl ? `【链接】${videoData.linkUrl}` : '',
          ].filter(Boolean).join('\n')
        : '';
      // 从 events 中提取并行子任务结果（compound 场景：secondary_strategy_ready / secondary_video_ready）
      const secondaryStrategyEvents = events.filter((e) => e.event === 'secondary_strategy_ready');
      const secondaryVideoEvents = events.filter((e) => e.event === 'secondary_video_ready');
      const secondaryStrategyData = secondaryStrategyEvents.map((e) => e.data || {});
      const secondaryVideoData = secondaryVideoEvents.map((e) => e.data || {});
      const secondaryStrategyBlock = secondaryStrategyData
        .map((d, i) => [
          `【副战术#${i + 1}】query=${d.query || ''}`,
          d.title ? `【副战术标题】${d.title}` : '',
          Array.isArray(d.details) && d.details.length
            ? `【副战术要点】\n- ${d.details.join('\n- ')}`
            : '',
        ].filter(Boolean).join('\n'))
        .filter(Boolean)
        .join('\n');
      const secondaryVideoBlock = secondaryVideoData
        .map((d, i) => [
          `【副视频#${i + 1}】query=${d.query || ''}`,
          d.title ? `【副视频标题】${d.title}` : '',
          d.summary ? `【副视频摘要】${d.summary}` : '',
          d.linkUrl ? `【副视频链接】${d.linkUrl}` : '',
        ].filter(Boolean).join('\n'))
        .filter(Boolean)
        .join('\n');
      const fastPathReply = [
        mainOutput.emotional_reply || '',
        mainOutput.understanding_reply || '',
        mainOutput.main_summary || '',
        mainOutput.branch_wait_reply || '',
      ].filter(Boolean).join('\n');
      const visibleAnswer = [
        fastPathReply,
        tacticBlock,
        videoBlock,
        secondaryStrategyBlock,
        secondaryVideoBlock,
      ].filter(Boolean).join('\n');
      sendJson(response, 200, {
        ok: (mainOutput.status !== 'failed') && (Object.keys(mainOutput).length > 5),
        data: {
          id: body.case_id || `eval-${Date.now()}`,
          answer: {
            intent: mainOutput.intent,
            emotional_reply: mainOutput.emotional_reply,
            understanding_reply: mainOutput.understanding_reply,
            main_summary: mainOutput.main_summary,
            branch_wait_reply: mainOutput.branch_wait_reply,
            route_reason: mainOutput.route_reason,
            tactic_data: tacticData,
            video_data: videoData,
            video_query: mainOutput.video_query || null,
            video_queries: videoQueries,
            task_plan: taskPlan,
            task_plan_forced: taskPlanForced,
          },
          actual_intent: mainOutput.intent || null,
          fast_path_reply: fastPathReply,
          visible_answer: visibleAnswer,
          tactic_data: tacticData,
          video_data: videoData,
          // compound 场景：TaskPlanner 拆出的并行子任务实际执行结果
          secondary_strategy_data: secondaryStrategyData,
          secondary_video_data: secondaryVideoData,
          video_query: mainOutput.video_query || null,
          video_queries: videoQueries,
          task_plan: taskPlan,
          task_plan_forced: taskPlanForced,
          raw_state: mainOutput,
          events,
        },
        message: mainOutput.error || undefined,
      });
    } catch (evalError) {
      sendJson(response, 500, {
        ok: false,
        message: evalError.message,
      });
    }
    return;
  }

  sendJson(response, 404, { ok: false, message: '接口不存在' });
}

const server = http.createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    const statusCode = /缺少|不能为空|需要/.test(error.message) ? 400 : 500;

    console.error('[server] request failed:', error);
    sendJson(response, statusCode, {
      ok: false,
      message: error.message,
      code: error.code,
      requestId: error.requestId,
      response: error.response,
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[volc-aigc-rtc-server] listening on http://${config.host}:${config.port}`);
});
