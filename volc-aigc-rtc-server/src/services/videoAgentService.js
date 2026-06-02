import { searchUniversalVideo } from './universalVideoSearchService.js';
import { callArkChat, extractJsonObject } from './arkChatService.js';
import { trimVideoData } from './outputTrimmerService.js';

const VIDEO_TIMEOUT_MS = 15000;
const BILIBILI_STYLE_TERMS = ['教学', '教程', '详解', '思路', '攻略', '进阶'];
const DOUYIN_DROP_TERMS = new Set(['详解', '系统', '体系', '进阶', '版本', '版本解析']);
const DOUYIN_ACTION_TERMS = ['实战', '连招'];
const DOUYIN_HIGHLIGHT_TERMS = ['高光', '集锦', '速看'];

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

function fallbackVideoQuery(context, mainOutput) {
  return String(mainOutput.video_query_seed || context.userQuery || '').replace(/[?？。！!]/g, ' ').trim();
}

function normalizeQueryText(text = '') {
  return String(text || '')
    .replace(/[?？。！!，,；;：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitQueryTerms(text = '') {
  return normalizeQueryText(text).split(' ').filter(Boolean);
}

function hasAnyTerm(text = '', terms = []) {
  return terms.some((term) => String(text || '').includes(term));
}

function mergeTerms(baseTerms = [], extraTerms = []) {
  const merged = [];
  const seen = new Set();
  for (const term of [...baseTerms, ...extraTerms]) {
    const cleanTerm = String(term || '').trim();
    if (!cleanTerm || seen.has(cleanTerm)) {
      continue;
    }
    seen.add(cleanTerm);
    merged.push(cleanTerm);
  }
  return merged;
}

export function buildPlatformVideoQueries({
  baseQuery = '',
  genericQuery = '',
  bilibiliQuery = '',
  douyinQuery = '',
} = {}) {
  const normalizedBase = normalizeQueryText(genericQuery || baseQuery);
  const genericTerms = splitQueryTerms(normalizedBase);
  const safeBaseQuery = normalizedBase || normalizeQueryText(baseQuery);

  let bilibiliTerms = splitQueryTerms(bilibiliQuery || safeBaseQuery);
  if (!hasAnyTerm(bilibiliTerms.join(' '), BILIBILI_STYLE_TERMS)) {
    bilibiliTerms = mergeTerms(genericTerms.length ? genericTerms : bilibiliTerms, ['教学', '详解']);
  } else {
    if (!hasAnyTerm(bilibiliTerms.join(' '), ['详解', '思路', '攻略'])) {
      bilibiliTerms = mergeTerms(bilibiliTerms, ['详解']);
    }
  }

  let douyinTerms = splitQueryTerms(douyinQuery || safeBaseQuery)
    .filter((term) => !DOUYIN_DROP_TERMS.has(term));
  douyinTerms = mergeTerms(douyinTerms, []);
  if (!hasAnyTerm(douyinTerms.join(' '), DOUYIN_ACTION_TERMS)) {
    douyinTerms = mergeTerms(douyinTerms.length ? douyinTerms : genericTerms, DOUYIN_ACTION_TERMS);
  }
  if (!hasAnyTerm(douyinTerms.join(' '), DOUYIN_HIGHLIGHT_TERMS)) {
    douyinTerms = mergeTerms(douyinTerms, ['高光']);
  }

  const genericFinal = normalizeQueryText(safeBaseQuery);
  const bilibiliFinal = normalizeQueryText(bilibiliTerms.join(' ')) || genericFinal;
  const douyinFinal = normalizeQueryText(douyinTerms.join(' ')) || genericFinal;

  return {
    genericQuery: genericFinal,
    bilibiliQuery: bilibiliFinal,
    douyinQuery: douyinFinal,
  };
}

export async function runVideoAgent(context, mainOutput) {
  const systemPrompt = `你是 Video_Agent 视频子脑。
你要把用户意图改写成适合视频搜索的高价值搜索词，并分别输出适合 B站、抖音、通用搜索的版本。

改写规则：
- 结构：游戏名 + 角色/英雄 + 动作/战术关键词 + 内容类型词（教学/实战/集锦/细节/进阶等）
- 不同平台风格适配：
  · B站：偏长尾、偏教程详解，如"英雄联盟 盲僧 打野 教学详解 2024"
  · 抖音：偏短平快、偏实战集锦，如"盲僧打野 实战集锦 连招"
  · 通用：核心关键词组合，如"英雄联盟 盲僧 打野 实战教学"
- 搜索词用空格分隔关键词，不要用标点，便于多平台检索
- 不要限定在某个平台，搜索词应能在B站、抖音、YouTube等平台找到相关内容
- 必须保留游戏名作为首词，避免跨游戏误匹配
- 如果用户提到具体英雄/角色，必须包含英雄名

输出示例（严格参照格式和风格）：

用户问：想系统学会打野视野布置，有没有一套进阶视频？
输出：{"video_query_generic":"英雄联盟 打野 视野 布置 进阶 教学","video_query_bilibili":"英雄联盟 打野 视野 布置 进阶 教学详解","video_query_douyin":"英雄联盟 打野 视野 布置 实战 高光"}

用户问：亚索有什么骚操作集锦吗？
输出：{"video_query_generic":"英雄联盟 亚索 极限操作 集锦 高光","video_query_bilibili":"英雄联盟 亚索 极限操作 集锦 教学思路","video_query_douyin":"英雄联盟 亚索 极限操作 高光 集锦"}

用户问：盲僧怎么玩？
输出：{"video_query_generic":"英雄联盟 盲僧 打野 教学 连招 实战","video_query_bilibili":"英雄联盟 盲僧 打野 教学 详解 连招","video_query_douyin":"英雄联盟 盲僧 打野 实战 连招 高光"}

严格只返回 JSON：{"video_query_generic":"...","video_query_bilibili":"...","video_query_douyin":"..."}`;
  const userPrompt = JSON.stringify({
    user_query: context.userQuery,
    main_summary: mainOutput.main_summary,
    rag_summary: context.rag?.summary || '',
    dynamic_context: context.dynamicSummary || '',
  });

  const fallbackQuery = fallbackVideoQuery(context, mainOutput);
  let platformQueries = buildPlatformVideoQueries({ baseQuery: fallbackQuery, genericQuery: fallbackQuery });
  let raw = null;
  try {
    const result = await callArkChat({ systemPrompt, userPrompt, temperature: 0.2, maxTokens: 300 });
    raw = result.content;
    const parsed = extractJsonObject(result.content);
    platformQueries = buildPlatformVideoQueries({
      baseQuery: fallbackQuery,
      genericQuery: parsed.video_query_generic || parsed.video_query || fallbackQuery,
      bilibiliQuery: parsed.video_query_bilibili || '',
      douyinQuery: parsed.video_query_douyin || '',
    });
  } catch (_) {
  }

  const videoResult = await withTimeout(
    searchUniversalVideo({
      query: platformQueries.genericQuery,
      genericQuery: platformQueries.genericQuery,
      bilibiliQuery: platformQueries.bilibiliQuery,
      douyinQuery: platformQueries.douyinQuery,
    }),
    VIDEO_TIMEOUT_MS,
    '通用视频检索'
  );

  if (!videoResult?.playableUrl && !videoResult?.pageUrl) {
    const error = new Error('未检索到任何候选视频');
    error.code = 'VIDEO_URL_INVALID';
    error.videoQuery = platformQueries.genericQuery;
    error.videoResult = videoResult;
    throw error;
  }

  const videoDescription = videoResult.description || '';
  const summary = videoDescription && videoResult.playableUrl
    ? videoDescription
    : `已找到「${platformQueries.genericQuery}」相关视频，点击查看`;

  return {
    video_query: platformQueries.genericQuery,
    video_queries: {
      generic: platformQueries.genericQuery,
      bilibili: platformQueries.bilibiliQuery,
      douyin: platformQueries.douyinQuery,
    },
    video_data: trimVideoData({
      query: platformQueries.genericQuery,
      title: videoResult.title || `视频：${platformQueries.genericQuery}`,
      summary,
      videoUrl: videoResult.playableUrl || '',
      linkUrl: videoResult.pageUrl || '',
      coverUrl: videoResult.coverUrl || '',
      source_platform: videoResult.sourcePlatform || 'unknown',
      is_embed: Boolean(videoResult.isEmbed),
    }),
    raw,
  };
}
