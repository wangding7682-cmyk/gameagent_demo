import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { config, getMemoryConfigSummary } from './config.js';
import { searchMockKnowledge } from './services/mockKnowledgeService.js';
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
} from './services/agentProfileLoaderService.js';
import {
  formatRtcPersonaProfileForPrompt,
  getRtcPersonaProfile,
  updateRtcPersonaProfile,
} from './services/rtcPersonaProfileService.js';
import {
  appendRtcSessionMessage,
  getRecentRtcUserPrompts,
  getRtcSessionState,
  upsertRtcSessionState,
} from './services/rtcSessionStateService.js';
import { searchVolcKnowledge } from './services/volcKnowledgeApi.js';
import { callRtcOpenApi } from './services/volcRtcOpenApi.js';
import { generateRtcToken } from './services/tokenService.js';
import { appendAgentTrace, getAgentTrace, listAgentTraces } from './services/agentTraceLoggerService.js';
import { clearAgentSessionState, getAgentSessionState, upsertAgentDynamicContext } from './services/agentSessionStateService.js';
import { runAgentOrchestration } from './services/agentOrchestratorService.js';
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

function buildRtcDynamicContextMessage({ profilePrompt, retrievedKnowledge, dynamicGameState }) {
  return [
    '# Dynamic Context (由系统状态机动态注入)',
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

async function applyRtcMemoryContext(startVoiceChatConfig, body, agentConfig) {
  const nextConfig = cloneJson(startVoiceChatConfig) || {};
  const nextLlmConfig = cloneJson(nextConfig.LLMConfig) || {};
  const playerUserId = resolvePlayerUserId(body, agentConfig);
  const currentSession = String(body.taskId || '').trim() ? getRtcSessionState(body.taskId) : null;
  const dynamicGameState = resolveDynamicGameState(body);
  const retrievedKnowledge = resolveRetrievedKnowledge(body, currentSession);
  const profile = getRtcPersonaProfile(playerUserId);
  const rtcProfilePrompt = formatRtcPersonaProfileForPrompt(profile);
  const longTermMemory = loadLongTermMemory(playerUserId);
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
      });
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
  const historyLength = 0;
  const shortPromptMessageLimit = 0;

  const interactionAgentPrompt = [
    '你是游戏语音助手"小G"，负责实时语音交互与轻量意图识别。',
    '你不是 Strategy_Agent 或 Video_Agent，不生成完整攻略、卡片内容、视频链接。',
    '',
    '核心目标：',
    '1. 用极短时间输出可播回复，避免用户等待完整后台 Agent。',
    '2. 判断用户意图并自然路由：',
    '   - smalltalk：聊天/情绪/观点/心态/玩法哲学 → 直接给轻量观点或安慰，1-2句',
    '   - strategy：打法/战术/出装/克制/对线/知识卡片 → 简短确认 + 等候语，后台会出卡片',
    '   - video：找视频/集锦/高光/抖音/B站 → 简短确认 + 等候语，后台会弹视频',
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
    '输出规则：',
    '- 直接输出可播文本，不要输出JSON、标记、括号内容',
    '- 禁止工具调用描述、系统说明、内部Agent名称',
    '- strategy/video时自然带出等候语（如"我帮你整理下"、"我去找找"）',
    '- 禁止承诺后台任务已完成，只能说"整理后弹出/找到后弹出"',
    '- 不要展开完整攻略，那是后台的事',
    '- 只把真正需要播报给用户的内容放在回复里',
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
  ].join('\n');

  nextLlmConfig.SystemMessages = [
    buildRtcDynamicContextMessage({ profilePrompt, retrievedKnowledge, dynamicGameState }),
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

  const memoryContext = await applyRtcMemoryContext(startVoiceChatConfig, body, agentConfig);

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
      provider: 'mock',
      fallback: false,
      result: searchMockKnowledge(body.query, Number(body.limit || config.knowledge.limit || 5)),
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
      provider: 'mock',
      fallback: true,
      fallbackReason: error.message,
      result: searchMockKnowledge(body.query, Number(body.limit || config.knowledge.limit || 5)),
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
    region: config.knowledge.region,
    service: config.knowledge.service,
    accountId: maskSecret(config.knowledge.accountId),
    resourceId: maskSecret(config.knowledge.resourceId),
    collectionName: config.knowledge.collectionName || '',
    serviceResourceId: config.knowledge.serviceResourceId || '',
    apiKeyConfigured: Boolean(config.knowledge.apiKey),
    accessKeyConfigured: Boolean(config.knowledge.accessKeyId),
    secretKeyConfigured: Boolean(config.knowledge.secretAccessKey),
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
    const readmePath = path.resolve(frontendRoot, 'README.md');
    try {
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
        path: readmePath,
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
    await runAgentOrchestration(body, (event, data) => writeSseEvent(response, event, data));
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
    const state = await runAgentOrchestration(body, (event, data) => {
      events.push({ event, data });
    });
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
    if (!question) {
      sendJson(response, 400, { ok: false, message: '缺少 question 参数' });
      return;
    }
    try {
      const events = [];
      const state = await runAgentOrchestration(
        {
          ...body,
          userId,
          taskId: `eval-${Date.now()}`,
          query: question,
        },
        (event, data) => {
          events.push({ event, data });
        },
      );
      const mainOutput = state || {};
      const visibleAnswer = [
        mainOutput.emotional_reply || '',
        mainOutput.understanding_reply || '',
        mainOutput.main_summary || '',
        mainOutput.branch_wait_reply || '',
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
          },
          actual_intent: mainOutput.intent || null,
          visible_answer: visibleAnswer,
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
