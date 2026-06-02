import { config, getMemoryConfigSummary } from '../config.js';
import { requestJson } from '../utils/http.js';
import { buildQueryString, getUtcXDate, signVolcOpenApiRequest } from '../utils/volcSigner.js';

function buildConfigError(missing) {
  const error = new Error(`缺少环境变量: ${missing.join(', ')}`);
  error.code = 'VOLC_MEMORY_OPENAPI_CONFIG_MISSING';
  return error;
}

function assertMemoryOpenApiConfig({ requireProjectId = false } = {}) {
  const missing = [];

  if (!config.memory.openApiHost) missing.push('VOLC_MEMORY_OPENAPI_HOST');
  if (!config.memory.openApiRegion) missing.push('VOLC_MEMORY_OPENAPI_REGION');
  if (!config.memory.accessKeyId) missing.push('VOLC_MEMORY_ACCESS_KEY');
  if (!config.memory.secretAccessKey) missing.push('VOLC_MEMORY_SECRET_KEY');
  if (requireProjectId && !config.memory.projectId) {
    missing.push('VOLC_MEMORY_PROJECT_ID');
  }

  if (missing.length > 0) {
    throw buildConfigError(missing);
  }
}

function normalizeOpenApiError(responseData) {
  const meta = responseData?.ResponseMetadata;
  const error = meta?.Error;
  if (!error) {
    return null;
  }

  const detail = new Error(error.Message || error.Code || '火山引擎 Mem0 OpenAPI 调用失败');
  detail.code = error.Code;
  detail.codeN = error.CodeN;
  detail.requestId = meta?.RequestId;
  detail.response = responseData;
  return detail;
}

function maskValue(value) {
  if (!value) {
    return '';
  }

  const text = String(value);
  if (text.length <= 8) {
    return `${text.slice(0, 2)}***`;
  }

  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function normalizeProjectInfo(item = {}) {
  return {
    id: item.MemoryProjectId || '',
    name: item.MemProjectName || item.MemoryProjectName || '',
    status: item.Status || '',
    description: item.Description || '',
    type: item.MemoryProjectType || '',
    accountId: item.AccountId ? maskValue(item.AccountId) : '',
    projectName: item.ProjectName || '',
    createTime: item.CreateTime || '',
    tags: Array.isArray(item.Tags) ? item.Tags : [],
    raw: item,
  };
}

function normalizeProjectDetail(detail = {}) {
  const apiKeyInfos = Array.isArray(detail.APIKeyInfos) ? detail.APIKeyInfos : [];
  const visitAddrs = Array.isArray(detail.VisitAddrs) ? detail.VisitAddrs : [];
  const strategies = Array.isArray(detail.LongTermMemoryStrategies)
    ? detail.LongTermMemoryStrategies
    : [];

  return {
    id: detail.MemoryProjectId || '',
    name: detail.MemoryProjectName || '',
    status: detail.Status || '',
    type: detail.MemoryProjectType || '',
    createTime: detail.CreateTime || '',
    accountId: detail.AccountId ? maskValue(detail.AccountId) : '',
    tags: Array.isArray(detail.Tags) ? detail.Tags : [],
    apiKeyCount: apiKeyInfos.length,
    apiKeys: apiKeyInfos.map((item) => ({
      id: item.APIKeyId || '',
      name: item.APIKeyName || '',
      description: item.Description || '',
      status: item.Status || '',
    })),
    visitAddrs: visitAddrs.map((item) => ({
      address: item.Address || '',
      port: item.Port || '',
      addrType: item.AddrType || '',
      vpcId: item.VpcId || '',
      subnetId: item.SubnetId || '',
      vip: item.VIP ? maskValue(item.VIP) : '',
    })),
    strategies: strategies.map((item) => ({
      source: item.Source || '',
      strategyType: item.StrategyType || '',
      strategyName: item.StrategyName || '',
      description: item.Description || '',
      promptConfigured: Boolean(item.Prompt),
    })),
    raw: detail,
  };
}

async function callMemoryOpenApi(action, body = {}) {
  assertMemoryOpenApiConfig();

  const query = {
    Action: action,
    Version: config.memory.openApiVersion,
  };

  const bodyText = JSON.stringify(body);
  const xDate = getUtcXDate();
  const headers = {
    Host: config.memory.openApiHost,
    'Content-Type': 'application/json; charset=utf-8',
    'X-Date': xDate,
  };

  if (config.memory.sessionToken) {
    headers['X-Security-Token'] = config.memory.sessionToken;
  }

  const signed = signVolcOpenApiRequest({
    method: 'POST',
    pathname: '/',
    query,
    headers,
    body: bodyText,
    accessKeyId: config.memory.accessKeyId,
    secretAccessKey: config.memory.secretAccessKey,
    region: config.memory.openApiRegion,
    service: config.memory.openApiService,
    requestDate: xDate,
  });

  headers.Authorization = signed.authorization;

  const response = await requestJson({
    protocol: 'https:',
    hostname: config.memory.openApiHost,
    method: 'POST',
    path: `/${buildQueryString(query)}`,
    headers,
    body: bodyText,
  });

  const apiError = normalizeOpenApiError(response.data);
  if (apiError) {
    throw apiError;
  }

  if (response.statusCode >= 400) {
    const unknownError = new Error(`火山引擎 Mem0 OpenAPI 返回 HTTP ${response.statusCode}`);
    unknownError.response = response.data;
    throw unknownError;
  }

  return response.data;
}

export async function describeVolcMemoryProjects(payload = {}) {
  const response = await callMemoryOpenApi('DescribeMemoryProjects', {
    RegionId: payload.regionId || config.memory.openApiRegion,
  });
  const items = Array.isArray(response?.Result?.MemProjectInfos)
    ? response.Result.MemProjectInfos
    : [];

  return {
    total: Number(response?.Result?.TotalMemProjectsNum || items.length || 0),
    items: items.map(normalizeProjectInfo),
    raw: response,
  };
}

export async function describeVolcMemoryProjectDetail(memoryProjectId = config.memory.projectId) {
  assertMemoryOpenApiConfig({ requireProjectId: true });

  const response = await callMemoryOpenApi('DescribeMemoryProjectDetail', {
    MemoryProjectId: memoryProjectId,
  });

  return {
    detail: normalizeProjectDetail(response?.Result || {}),
    raw: response,
  };
}

export async function checkVolcMemoryManagementHealth() {
  const summary = getMemoryConfigSummary();
  const baseResult = {
    configured: Boolean(
      config.memory.openApiHost &&
        config.memory.openApiRegion &&
        config.memory.accessKeyId &&
        config.memory.secretAccessKey
    ),
    ready: null,
    reachable: null,
    checkedAt: new Date().toISOString(),
    config: summary,
  };

  if (!baseResult.configured) {
    return {
      ...baseResult,
      message: '未配置 Mem0 项目管理 OpenAPI，已跳过项目层检查。',
    };
  }

  try {
    const projectList = await describeVolcMemoryProjects();
    const result = {
      ...baseResult,
      ready: true,
      reachable: true,
      projectList: {
        total: projectList.total,
        items: projectList.items,
      },
    };

    if (config.memory.projectId) {
      const projectDetail = await describeVolcMemoryProjectDetail();
      result.projectDetail = projectDetail.detail;
    }

    return result;
  } catch (error) {
    return {
      ...baseResult,
      ready: false,
      reachable: false,
      error: {
        message: error.message,
        code: error.code,
        requestId: error.requestId,
      },
    };
  }
}
