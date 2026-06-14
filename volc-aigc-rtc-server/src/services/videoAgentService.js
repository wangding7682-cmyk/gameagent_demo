import { searchUniversalVideo, searchBilibili, searchDouyin } from './universalVideoSearchService.js';
import { callArkChat, extractJsonObject } from './arkChatService.js';
import { trimVideoData } from './outputTrimmerService.js';
import { extractHeroEntities } from './domainRouterService.js';

const VIDEO_TIMEOUT_MS = 15000;
const BILIBILI_STYLE_TERMS = ['教学', '教程', '详解', '思路', '攻略', '进阶'];
const DOUYIN_DROP_TERMS = new Set(['详解', '系统', '体系', '进阶', '版本', '版本解析']);
const DOUYIN_HIGHLIGHT_TERMS = ['高光', '集锦', '速看'];
const VIDEO_SPECIFIC_TOPIC_REGEX = /连招|打法|技巧|对线|出装|教学|教程|示范|演示|操作|gank|Gank|团战|运营|站位|高光|集锦|入侵|反蹲|游走|带节奏|刷野|开野|视野|插眼|抗压/;
const VIDEO_QUERY_FILLER_PATTERNS = [
  /哎呀|哎哟|哎|欸|呃|额|嗯嗯|嗯/g,
  /我让你|让我|你给我|帮我|给我|你/g,
  /那个|这个|之前的|刚才的|上次的|上一个|那条|这条/g,
  /生成的|整理的|发的|找的|说的/g,
  /有没有|有吗|在哪|在哪儿|呢|吧|好吧|可以|看看|看一下|看下/g,
];

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
  // 当 LLM 失败时的兜底 query：优先 main 给的 seed，否则用经代词消解的 userQuery
  // hero 优先级：当前 query 自带 hero > stickyHero 回退注入
  const currentQuery = context.userQueryResolved || context.userQuery || '';
  const currentHero = (() => {
    const heroes = extractHeroEntities(currentQuery, '');
    return heroes[0]?.hero || null;
  })();
  const seed = sanitizeVideoQueryText(mainOutput.video_query_seed || currentQuery, {
    stickyHero: context.stickyHero?.hero || '',
  });
  const withGamePrefix = (value = '') => ensureGamePrefix(value, context);
  // 当前 query 已有 hero → 不再用 stickyHero 注入
  if (currentHero && seed.includes(currentHero)) {
    return withGamePrefix(seed);
  }
  // 无当前 hero，有 stickyHero → 只有泛化 query 才注入（与 ensureHero 逻辑一致）
  const stickyHero = context.stickyHero?.hero;
  if (stickyHero && !seed.includes(stickyHero)) {
    const prefix8 = seed.slice(0, 8);
    const hasSpecificTopic = VIDEO_SPECIFIC_TOPIC_REGEX.test(seed) || VIDEO_SPECIFIC_TOPIC_REGEX.test(prefix8);
    if (!hasSpecificTopic && seed.length < 15) {
      return withGamePrefix(`${stickyHero} ${seed}`.trim());
    }
  }
  return withGamePrefix(seed);
}

function inferGameLabel(context = {}, query = '') {
  const text = `${query || ''} ${context.userQueryResolved || ''} ${context.userQuery || ''}`;
  if (/(英雄联盟|LOL|lol|召唤师峡谷)/.test(text)) return '英雄联盟';
  if (/(王者荣耀|王者|KPL|kpl)/.test(text)) return '王者荣耀';
  const hero = extractHeroEntities(text, '')[0];
  if (hero?.domain === 'lol') return '英雄联盟';
  if (hero?.domain === 'wzry') return '王者荣耀';
  const domains = context.rag?.detectedDomains || context.rag?.detected_domains || [];
  if (Array.isArray(domains) && domains.includes('lol')) return '英雄联盟';
  if (Array.isArray(domains) && domains.includes('wzry')) return '王者荣耀';
  return '';
}

function ensureGamePrefix(query = '', context = {}) {
  const text = String(query || '').trim();
  if (!text || /(英雄联盟|LOL|lol|王者荣耀|王者|原神|星穹铁道)/.test(text)) return text;
  const game = inferGameLabel(context, text);
  return game ? `${game} ${text}`.trim() : text;
}

function shouldUseFastVideoQuery(context = {}, mainOutput = {}) {
  const text = `${mainOutput.video_query_seed || ''} ${context.userQueryResolved || ''} ${context.userQuery || ''}`;
  return /(视频示例|视频|链接|集锦|高光|精彩操作|操作集锦|操作秀|教学录像|实战录像|B站|b站|抖音|示范|演示)/.test(text);
}

function normalizeQueryText(text = '') {
  return sanitizeVideoQueryText(text)
    .replace(/[?？。！!，,；;：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeVideoQueryText(text = '', options = {}) {
  let normalized = String(text || '')
    .replace(/[?？。！!，,；;：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const pattern of VIDEO_QUERY_FILLER_PATTERNS) {
    normalized = normalized.replace(pattern, ' ');
  }
  normalized = normalized
    .replace(/的视频|教学视频|视频链接|资料链接|教程链接|视频|链接/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized && options.stickyHero) {
    return `${options.stickyHero} 教学视频`.trim();
  }
  return normalized;
}

function buildVideoSummaryText(query = '', stickyHero = '') {
  const cleanQuery = sanitizeVideoQueryText(query, { stickyHero }).trim();
  const hero = stickyHero && cleanQuery.includes(stickyHero) ? stickyHero : '';
  if (/集锦|高光|操作/.test(cleanQuery)) {
    return hero ? `已找到 ${hero} 相关精彩操作视频，点击查看` : '已找到相关精彩操作视频，点击查看';
  }
  if (/教学|教程|连招|打法|技巧|思路|出装|对线/.test(cleanQuery)) {
    return hero ? `已找到 ${hero} 相关教学视频，点击查看` : '已找到相关教学视频，点击查看';
  }
  return hero ? `已找到 ${hero} 相关视频，点击查看` : '已找到相关视频，点击查看';
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
  const douyinActionTerms = /连招|操作|反杀/.test(safeBaseQuery) ? ['实战', '连招'] : ['实战'];
  if (!hasAnyTerm(douyinTerms.join(' '), douyinActionTerms)) {
    douyinTerms = mergeTerms(douyinTerms.length ? douyinTerms : genericTerms, douyinActionTerms);
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

function buildRecentDialogueSnippet(recentTurns = [], maxRounds = 5) {
  const turns = (recentTurns || []).slice(-maxRounds);
  return turns.map((t) => {
    const role = t.role === 'bot' || t.role === 'assistant' ? 'bot' : 'user';
    const text = String(t.text || t.content || '').trim();
    return `${role}: ${text}`;
  }).join('\n');
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
- 【主角粘性约束】：若上下文给出 sticky_hero 字段（来自最近 3 轮主角），三类 query 必须均包含 sticky_hero.hero；禁止脱离主角输出"对线技巧/实战教学"等无主语关键词
- 严禁脑补 sticky_hero 之外的英雄名（如上下文是冰晶凤凰，不允许输出盲僧/亚索）

画面观察使用规则（screen_observation 字段）：
- 如果 screen_observation.isFresh=true 且包含具体游戏（last_game）或近期事件（如 ganked / death），优先把这个游戏名作为搜索词首词，并把事件转化为搜索意图（如"被gank"→"反gank 应对"，"阵亡"→"走位 失误 复盘"）。
- 如果 screen_observation.isFresh=false 或为空，按用户文本意图原样改写，不要编造游戏名。
- 不要把"血量""大招就绪"这类即时状态写进搜索词，搜索词应是可被检索的长期话题。

输出示例（严格参照格式和风格）：

用户问：想系统学会打野视野布置，有没有一套进阶视频？
输出：{"video_query_generic":"英雄联盟 打野 视野 布置 进阶 教学","video_query_bilibili":"英雄联盟 打野 视野 布置 进阶 教学详解","video_query_douyin":"英雄联盟 打野 视野 布置 实战 高光"}

用户问：亚索有什么骚操作集锦吗？
输出：{"video_query_generic":"英雄联盟 亚索 极限操作 集锦 高光","video_query_bilibili":"英雄联盟 亚索 极限操作 集锦 教学思路","video_query_douyin":"英雄联盟 亚索 极限操作 高光 集锦"}

用户问：盲僧怎么玩？
输出：{"video_query_generic":"英雄联盟 盲僧 打野 教学 连招 实战","video_query_bilibili":"英雄联盟 盲僧 打野 教学 详解 连招","video_query_douyin":"英雄联盟 盲僧 打野 实战 连招 高光"}

严格只返回 JSON：{"video_query_generic":"...","video_query_bilibili":"...","video_query_douyin":"..."}`;
  const screenObs = context.screenObservation || null;
  const userPrompt = JSON.stringify({
    user_query: context.userQueryResolved || context.userQuery,
    main_summary: mainOutput.main_summary,
    rag_summary: context.rag?.summary || '',
    dynamic_context: context.dynamicSummary || '',
    recent_dialogue_snippet: buildRecentDialogueSnippet(context.shortMemory?.recent_turns),
    sticky_hero: context.stickyHero || null,
    screen_observation: screenObs ? {
      summary: screenObs.summary,
      isFresh: screenObs.isFresh,
      recentEvents: screenObs.recentEvents || [],
    } : null,
  });

  const fallbackQuery = fallbackVideoQuery(context, mainOutput);
  let platformQueries = buildPlatformVideoQueries({ baseQuery: fallbackQuery, genericQuery: fallbackQuery });
  let raw = null;
  const useFastQuery = shouldUseFastVideoQuery(context, mainOutput);
  try {
    if (useFastQuery) {
      throw new Error('fast_video_query_path');
    }
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

  // 主角兜底注入：只对泛化 query 才注入 stickyHero，防止hero名冲突
  // 冲突场景：stickyHero="亚索"，query="亚索 瑞兹连招" → 应移除前缀"亚索"
  const stickyHero = context.stickyHero?.hero;
  // 优先从当前 query 自身提取 hero（不受 stickyHero 历史污染）
  const currentQueryHero = (() => {
    const q = context.userQueryResolved || context.userQuery || '';
    const heroes = extractHeroEntities(q, '');
    return heroes[0]?.hero || null;
  })();
  const KNOWN_OTHER_HEROES_REGEX = /(瑞兹|狐狸|劫|亚索|盲僧|VN|卡莎|德莱文|锤石|机器人|女坦|泰坦|蕾欧娜|娜美|璐璐|风女|琴女|扇子妈|卡尔玛|发条|冰女|吸血鬼|马尔扎哈|蛇女|瑞雯|刀妹|剑姬|青钢影|武器|剑圣|螳螂|狮子狗|男枪|豹女|蜘蛛|挖掘机|猪妹|酒桶|皇子|潘森|梦魇|皎月|阿卡丽|小鱼人|卡特|男刀|泰隆|奇亚娜|永恩|塞拉斯|阿狸|辛德拉|发条|奥莉安娜|黑默丁格|泽拉斯|维克托|冰晶凤凰|艾尼维亚|布兰德|瑞兹|凤凰|吉格斯|炸弹人|泽丽|金克丝|卢锡安|厄斐琉斯|凯莎|希维尔|崔丝塔娜|艾希|女枪|寒冰|韦鲁斯|烬|德莱文|派克)/;
  if (stickyHero || currentQueryHero) {
    const ensureHero = (q) => {
      const text = String(q || '').trim();
      if (!text) return text;
      // 【核心修复】若当前 query 自带 hero，直接用；不受 stickyHero 历史污染
      if (currentQueryHero && text.includes(currentQueryHero)) {
        // 当前 query hero 已在文本中，且之后无其他英雄名 → 保留
        const afterHero = text.slice(text.indexOf(currentQueryHero) + currentQueryHero.length);
        if (!afterHero || !KNOWN_OTHER_HEROES_REGEX.test(afterHero)) {
          return text;
        }
        // 当前 query hero 之后出现其他英雄 → 用新的
        return afterHero.trim();
      }
      // 当前 query 无 hero，但 stickyHero 在文本中 → 处理冲突
      if (text.includes(stickyHero)) {
        const afterSticky = text.slice(text.indexOf(stickyHero) + stickyHero.length);
        // 检查 stickyHero 之后是否出现其他英雄名（说明 query 是关于别的英雄）
        if (afterSticky && KNOWN_OTHER_HEROES_REGEX.test(afterSticky)) {
          return afterSticky.trim();
        }
        // stickyHero 不在末尾且之后无其他英雄 → 保留（可能是正确的）
        return text;
      }
      // 文本不含任何 hero 时：只有当 stickyHero 存在、且是泛化 query（前8字无话题词 + 长度<15）才注入
      // 注意：若当前 query 已有 hero 但未命中到文本（LLM 改写掉了），也走此分支
      const prefix8 = text.slice(0, 8);
      const hasSpecificTopic = VIDEO_SPECIFIC_TOPIC_REGEX.test(text) || VIDEO_SPECIFIC_TOPIC_REGEX.test(prefix8);
      if (!hasSpecificTopic && text.length < 15) {
        return `${stickyHero || currentQueryHero || ''} ${text}`.trim();
      }
      return text;
    };
    platformQueries = {
      genericQuery: ensureHero(platformQueries.genericQuery),
      bilibiliQuery: ensureHero(platformQueries.bilibiliQuery),
      douyinQuery: ensureHero(platformQueries.douyinQuery),
    };
  }

  const videoResult = await withTimeout(
    searchUniversalVideo({
      query: platformQueries.genericQuery,
      genericQuery: platformQueries.genericQuery,
      bilibiliQuery: platformQueries.bilibiliQuery,
      douyinQuery: platformQueries.douyinQuery,
      fastMode: true,
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
    : buildVideoSummaryText(platformQueries.genericQuery, stickyHero);

  // 并行查双平台：无论主结果来自哪个平台，都补查另一个平台链接
  const primaryPlatform = videoResult.sourcePlatform || 'unknown';
  const [secondaryBilibili, secondaryDouyin] = await Promise.all([
    primaryPlatform !== 'bilibili'
      ? withTimeout(searchBilibili(platformQueries.bilibiliQuery), 10000, '补查B站').catch(() => null)
      : Promise.resolve(null),
    primaryPlatform !== 'douyin'
      ? withTimeout(searchDouyin(platformQueries.douyinQuery), 10000, '补查抖音').catch(() => null)
      : Promise.resolve(null),
  ]);

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
      // 双链：无论主结果来自哪个平台，都补上另一个平台的搜索链接
      bilibili_linkUrl: primaryPlatform === 'bilibili'
        ? (videoResult.pageUrl || '')
        : (secondaryBilibili?.pageUrl || secondaryBilibili?.searchUrl || ''),
      douyin_linkUrl: primaryPlatform === 'douyin'
        ? (videoResult.pageUrl || videoResult.searchUrl || '')
        : (secondaryDouyin?.pageUrl || secondaryDouyin?.searchUrl || ''),
    }),
    raw,
  };
}
