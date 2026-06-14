import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

loadDotEnv(path.join(projectRoot, '.env'));

function loadJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`读取 JSON 配置失败: ${filePath}, ${error.message}`);
  }
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function requiredEnv(name) {
  return process.env[name] || '';
}

const defaultStartVoiceChatConfigPath = path.resolve(
  projectRoot,
  process.env.DEFAULT_START_VOICE_CHAT_CONFIG_PATH || './data/default-start-voice-chat.json'
);

const defaultStartVoiceChatConfig = loadJsonConfig(defaultStartVoiceChatConfigPath);

export const config = {
  projectRoot,
  port: Number(process.env.PORT || 8788),
  host: process.env.HOST || '0.0.0.0',
  openApi: {
    host: process.env.VOLC_RTC_OPENAPI_HOST || 'rtc.volcengineapi.com',
    region: process.env.VOLC_RTC_OPENAPI_REGION || 'cn-north-1',
    version: process.env.VOLC_RTC_OPENAPI_VERSION || '2025-06-01',
    service: 'rtc',
    accessKeyId: requiredEnv('VOLCENGINE_ACCESS_KEY'),
    secretAccessKey: requiredEnv('VOLCENGINE_SECRET_KEY'),
    sessionToken: process.env.VOLCENGINE_SESSION_TOKEN || '',
  },
  rtcAppId: requiredEnv('VOLC_RTC_APP_ID'),
  rtc: {
    appId: requiredEnv('VOLC_RTC_APP_ID'),
    appKey: requiredEnv('VOLC_RTC_APP_KEY'),
  },
  defaults: {
    agentUserId: process.env.DEFAULT_AGENT_USER_ID || 'ai_bot_001',
    welcomeMessage: process.env.DEFAULT_WELCOME_MESSAGE || '你好，我是你的游戏 AI 助手。',
    rtsCallbackUrl: process.env.DEFAULT_RTS_CALLBACK_URL || '',
    rtsCallbackSignature: process.env.DEFAULT_RTS_CALLBACK_SIGNATURE || '',
    startVoiceChatConfigPath: defaultStartVoiceChatConfigPath,
    startVoiceChat: defaultStartVoiceChatConfig,
  },
  knowledge: {
    mode: process.env.KNOWLEDGE_BACKEND_MODE || 'mock',
    apiStyle: process.env.VOLC_KNOWLEDGE_API_STYLE || 'search_knowledge',
    host:
      process.env.VOLC_KNOWLEDGE_HOST || 'api-knowledgebase.mlp.cn-beijing.volces.com',
    endpointPath:
      process.env.VOLC_KNOWLEDGE_SEARCH_PATH ||
      '/api/knowledge/collection/search_knowledge',
    project: process.env.VOLC_KNOWLEDGE_PROJECT || 'default',
    resourceId: process.env.VOLC_KNOWLEDGE_RESOURCE_ID || '',
    collectionName: process.env.VOLC_KNOWLEDGE_NAME || '',
    serviceResourceId: process.env.VOLC_KNOWLEDGE_SERVICE_RESOURCE_ID || '',
    apiKey: process.env.VOLC_KNOWLEDGE_API_KEY || '',
    limit: Number(process.env.VOLC_KNOWLEDGE_LIMIT || 5),
  },
  ark: {
    host: process.env.ARK_HOST || 'ark.cn-beijing.volces.com',
    imageGenerationPath:
      process.env.ARK_IMAGE_GENERATION_PATH || '/api/v3/images/generations',
    chatPath: process.env.ARK_CHAT_PATH || '/api/v3/chat/completions',
    apiKey: process.env.ARK_API_KEY || '',
    imageModel: process.env.ARK_IMAGE_MODEL || 'ep-20260505234424-d7khd',
    chatModel: process.env.ARK_CHAT_MODEL || 'ep-20260430103756-7wgz4',
    chatModelLite: process.env.ARK_CHAT_MODEL_LITE || process.env.ARK_CHAT_MODEL || 'ep-20260430103756-7wgz4',
    imageSize: process.env.ARK_IMAGE_SIZE || '2K',
    imageTimeoutMs: Number(process.env.ARK_IMAGE_TIMEOUT_MS || 50000),
    sequentialImageGeneration:
      process.env.ARK_IMAGE_SEQUENTIAL_GENERATION || 'disabled',
    responseFormat: process.env.ARK_IMAGE_RESPONSE_FORMAT || 'url',
    watermark: process.env.ARK_IMAGE_WATERMARK !== '0',
  },
  knowledgeCard: {
    // 知识卡片风格档位：infographic_minimal | freestyle
    // infographic_minimal = 强制信息图风（默认，推荐）
    // freestyle           = 跳过 sanitize（仅供历史回归 / 调试）
    styleHint: process.env.KNOWLEDGE_CARD_STYLE || 'infographic_minimal',
    palette: {
      bg: process.env.KNOWLEDGE_CARD_BG || '#FFFFFF',
      title: process.env.KNOWLEDGE_CARD_TITLE_COLOR || '#1A1A1A',
      accent: process.env.KNOWLEDGE_CARD_ACCENT || '#FF8A2D',
    },
  },
  tts: {
    host: process.env.VOLC_TTS_HOST || 'openspeech.bytedance.com',
    path: process.env.VOLC_TTS_PATH || '/api/v3/tts/unidirectional',
    appId: process.env.VOLC_TTS_APP_ID || '',
    accessToken: process.env.VOLC_TTS_ACCESS_TOKEN || '',
    resourceId: process.env.VOLC_TTS_RESOURCE_ID || 'seed-tts-2.0',
    speaker: process.env.VOLC_TTS_SPEAKER || 'zh_female_qingxinnvsheng_uranus_bigtts',
    sampleRate: Number(process.env.VOLC_TTS_SAMPLE_RATE || 24000),
    bitRate: Number(process.env.VOLC_TTS_BIT_RATE || 64000),
  },
  videoSearch: {
    host: process.env.DOUYIN_VIDEO_SEARCH_HOST || 'cn.bing.com',
    path: process.env.DOUYIN_VIDEO_SEARCH_PATH || '/search',
  },
  memory: {
    mode: process.env.MEMORY_BACKEND_MODE || 'viking',
    limit: Number(process.env.VOLC_MEMORY_LIMIT || 10),
  },
  vikingMemory: {
    apiKey: process.env.VIKING_MEMORY_API_KEY || '',
    resourceId: process.env.VIKING_MEMORY_RESOURCE_ID || '',
    collectionName: process.env.VIKING_MEMORY_COLLECTION_NAME || '',
    host: process.env.VIKING_MEMORY_HOST || 'api-knowledgebase.mlp.cn-beijing.volces.com',
    eventType: process.env.VIKING_MEMORY_EVENT_TYPE || 'event_v1',
    profileType: process.env.VIKING_MEMORY_PROFILE_TYPE || 'profile_v1',
    addEventPath: '/api/memory/event/add',
    searchProfilePath: '/api/memory/profile/search',
    searchEventPath: '/api/memory/event/search',
    searchMemoryPath: '/api/memory/search',
    getContextPath: '/api/memory/get_context',
    collectionInfoPath: '/api/memory/collection/info',
  },
  sessionStore: {
    filePath: path.resolve(
      projectRoot,
      process.env.SESSION_RECORD_FILE || './data/session-records.json'
    ),
  },
  rtcMemory: {
    profileDirPath: path.resolve(
      projectRoot,
      process.env.RTC_PERSONA_PROFILE_DIR || './data/rtc-persona-profiles'
    ),
    sessionStateFilePath: path.resolve(
      projectRoot,
      process.env.RTC_SESSION_STATE_FILE || './data/rtc-session-state.json'
    ),
    shortHistoryLength: Number(process.env.RTC_SHORT_HISTORY_LENGTH || 5),
    shortPromptMessageLimit: Number(process.env.RTC_SHORT_PROMPT_MESSAGE_LIMIT || 10),
    functionCallbackUrl:
      process.env.RTC_FUNCTION_CALLBACK_URL || process.env.DEFAULT_RTS_CALLBACK_URL || '',
    functionCallbackSignature:
      process.env.RTC_FUNCTION_CALLBACK_SIGNATURE ||
      process.env.DEFAULT_RTS_CALLBACK_SIGNATURE ||
      '',
    enablePersonaFunctionTool: process.env.RTC_ENABLE_PERSONA_FUNCTION_TOOL !== '0',
  },
  rtcLlmBridge: {
    customLlmBaseUrl: process.env.CUSTOM_LLM_BASE_URL || '',
    customLlmApiKey: process.env.CUSTOM_LLM_API_KEY || '',
  },
  rtcTokenGeneratorPath: path.resolve(
    projectRoot,
    process.env.RTC_TOKEN_GENERATOR_PATH || './vendor/rtc-token-generator.js'
  ),
};

export function loadEnv() {
  return config;
}

export function assertOpenApiConfig() {
  const missing = [];

  if (!config.openApi.accessKeyId) missing.push('VOLCENGINE_ACCESS_KEY');
  if (!config.openApi.secretAccessKey) missing.push('VOLCENGINE_SECRET_KEY');
  if (!config.rtcAppId) missing.push('VOLC_RTC_APP_ID');

  if (missing.length > 0) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }
}

export function assertRtcTokenConfig() {
  const missing = [];

  if (!config.rtc.appId) missing.push('VOLC_RTC_APP_ID');
  if (!config.rtc.appKey) missing.push('VOLC_RTC_APP_KEY');

  if (missing.length > 0) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }
}

export function assertKnowledgeConfig() {
  const missing = [];

  if (!config.knowledge.host) missing.push('VOLC_KNOWLEDGE_HOST');

  if (config.knowledge.apiStyle === 'service_chat') {
    if (!config.knowledge.apiKey) missing.push('VOLC_KNOWLEDGE_API_KEY');
    if (!config.knowledge.serviceResourceId) {
      missing.push('VOLC_KNOWLEDGE_SERVICE_RESOURCE_ID');
    }
  } else {
    if (!config.knowledge.apiKey) missing.push('VOLC_KNOWLEDGE_API_KEY');
    if (!config.knowledge.resourceId && !config.knowledge.collectionName) {
      missing.push('VOLC_KNOWLEDGE_RESOURCE_ID 或 VOLC_KNOWLEDGE_NAME');
    }
  }

  if (missing.length > 0) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }
}

export function assertArkImageConfig() {
  const missing = [];

  if (!config.ark.host) missing.push('ARK_HOST');
  if (!config.ark.imageGenerationPath) {
    missing.push('ARK_IMAGE_GENERATION_PATH');
  }
  if (!config.ark.apiKey) missing.push('ARK_API_KEY');
  if (!config.ark.imageModel) missing.push('ARK_IMAGE_MODEL');

  if (missing.length > 0) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }
}

export function assertTtsConfig() {
  const missing = [];

  if (!config.tts.host) missing.push('VOLC_TTS_HOST');
  if (!config.tts.path) missing.push('VOLC_TTS_PATH');
  if (!config.tts.appId) missing.push('VOLC_TTS_APP_ID');
  if (!config.tts.accessToken) missing.push('VOLC_TTS_ACCESS_TOKEN');
  if (!config.tts.resourceId) missing.push('VOLC_TTS_RESOURCE_ID');
  if (!config.tts.speaker) missing.push('VOLC_TTS_SPEAKER');

  if (missing.length > 0) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }
}

export function getMemoryConfigSummary() {
  return {
    mode: config.memory.mode,
    vikingHost: config.vikingMemory.host,
    vikingResourceIdConfigured: Boolean(config.vikingMemory.resourceId),
    vikingCollectionName: config.vikingMemory.collectionName,
    vikingApiKeyConfigured: Boolean(config.vikingMemory.apiKey),
  };
}
