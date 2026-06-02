import { config } from '../config.js';

const FALLBACK_VIDEOS = [
  {
    keywords: ['绝区零', 'zzz'],
    url: 'https://jingxuan.douyin.com/m/video/7488702134351957263',
    title: '『绝区零』0+1扳机＆安比，防卫战+危局强袭 实战表现！',
    description: '抖音精选实战视频，内容与绝区零战斗表现相关。',
  },
  {
    keywords: ['原神', 'genshin'],
    url: 'https://jingxuan.douyin.com/m/video/7126360388001664263',
    title: '【原神】无相之风新手攻略，打法教学，成就，无相之风怎么打？',
    description: '抖音精选攻略视频，内容与原神新手开荒相关。',
  },
  {
    keywords: ['星穹铁道', '星铁', '崩铁', 'hsr'],
    url: 'https://jingxuan.douyin.com/m/video/7506849991974079784',
    title: '风堇值得抽吗？星穹铁道攻略思路解析',
    description: '抖音精选攻略视频，内容与星穹铁道角色分析和养成思路相关。',
  },
  {
    keywords: ['王者荣耀', '王者', '打野'],
    url: 'https://jingxuan.douyin.com/m/video/7455740422007082290',
    title: '国服澜常用的6个技巧！最新刷双野，操作设置，常用连招等！',
    description: '抖音精选实战视频，内容与王者荣耀打野思路、连招和节奏相关。',
  },
  {
    keywords: ['英雄联盟', '联盟', 'lol', '云顶', '召唤师'],
    url: 'https://jingxuan.douyin.com/m/video/7385872215876226871',
    title: '【英雄联盟】高分段实战教学合集，对线、节奏与团战思路全解析',
    description: '抖音精选实战视频，内容与英雄联盟对线、节奏与团战决策相关。',
  },
  {
    keywords: ['亚索', 'yasuo', '快乐风男', '风男'],
    url: 'https://jingxuan.douyin.com/m/video/7367413112089595187',
    title: '【亚索】10级核心出装与连招教学，逆风局也能Carry！',
    description: '抖音精选实战视频，内容与亚索10级出装、连招与团战切入相关。',
  },
];

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function decodeEscapedText(text) {
  return String(text || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\u003C/g, '<')
    .replace(/\\u003E/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

function buildSearchKeyword(query) {
  return `${String(query || '').trim()} 抖音 视频`;
}

function findFallbackVideo(query) {
  const normalizedQuery = String(query || '').toLowerCase();

  const exactMatches = FALLBACK_VIDEOS.filter((item) =>
    item.keywords.some((keyword) => {
      if (keyword.length < 2) return false;
      return normalizedQuery.includes(keyword);
    })
  );

  if (exactMatches.length === 0) return null;

  const gameKeywords = ['绝区零', 'zzz', '原神', 'genshin', '星穹铁道', '星铁', '崩铁', 'hsr', '王者荣耀', '王者', '英雄联盟', '联盟', 'lol', '云顶', '召唤师'];
  const queryHasGame = gameKeywords.some((gk) => normalizedQuery.includes(gk));

  if (queryHasGame) {
    const gameMatched = exactMatches.filter((item) =>
      item.keywords.some((keyword) => gameKeywords.includes(keyword) && normalizedQuery.includes(keyword))
    );
    if (gameMatched.length > 0) return gameMatched[0];
  }

  const specificMatches = exactMatches.filter((item) =>
    item.keywords.some((keyword) => keyword.length >= 3 && normalizedQuery.includes(keyword))
  );
  if (specificMatches.length > 0) return specificMatches[0];

  return exactMatches[0];
}

function normalizeDouyinVideoUrl(rawUrl) {
  if (!rawUrl) {
    return '';
  }

  const decodedUrl = decodeHtmlEntities(rawUrl);

  try {
    const url = new URL(decodedUrl);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname;

    let match = pathname.match(/^\/video\/(\d+)/);
    if ((host === 'www.douyin.com' || host === 'douyin.com') && match) {
      return `https://www.douyin.com/video/${match[1]}`;
    }

    match = pathname.match(/^\/m\/video\/(\d+)/);
    if (host === 'jingxuan.douyin.com' && match) {
      return `https://jingxuan.douyin.com/m/video/${match[1]}`;
    }

    match = pathname.match(/^\/shipin\/(\d+)/);
    if (host === 'm.douyin.com' && match) {
      return `https://m.douyin.com/shipin/${match[1]}`;
    }

    match = pathname.match(/^\/share\/video\/(\d+)/);
    if (host === 'm.douyin.com' && match) {
      return `https://www.douyin.com/video/${match[1]}`;
    }
  } catch (_) {
    return '';
  }

  return '';
}

function extractCandidateUrls(html) {
  const urls = new Set();

  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = decodeHtmlEntities(match[1]);

    if (href.includes('bing.com/ck/a') || href.startsWith('/')) {
      continue;
    }

    const candidate =
      normalizeDouyinVideoUrl(href) ||
      normalizeDouyinVideoUrl(
        href.replace(/^https?:\/\/[^/]+\/.*?[?&]u=([^&]+).*$/i, (_, encoded) => {
          try {
            return decodeURIComponent(encoded);
          } catch (_) {
            return encoded;
          }
        })
      );

    if (candidate) {
      urls.add(candidate);
    }
  }

  for (const match of html.matchAll(
    /https?:\/\/(?:www\.douyin\.com\/video\/\d+|jingxuan\.douyin\.com\/m\/video\/\d+|m\.douyin\.com\/(?:shipin|share\/video)\/\d+)/g
  )) {
    const candidate = normalizeDouyinVideoUrl(match[0]);
    if (candidate) {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function extractMetaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${key}["']`, 'i'),
  ];

  for (const pattern of patterns) {
    const matched = html.match(pattern);
    if (matched?.[1]) {
      return decodeHtmlEntities(matched[1]);
    }
  }

  return '';
}

function extractTitle(html) {
  const matched = html.match(/<title>([\s\S]*?)<\/title>/i);
  return decodeHtmlEntities(matched?.[1] || '').trim();
}

function normalizePlayableVideoUrl(rawUrl) {
  if (!rawUrl) {
    return '';
  }

  let decodedUrl = decodeEscapedText(decodeHtmlEntities(rawUrl)).trim();
  if (decodedUrl.startsWith('//')) {
    decodedUrl = `https:${decodedUrl}`;
  }

  try {
    const url = new URL(decodedUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }
    return url.toString();
  } catch (_) {
    return '';
  }
}

function extractPlayableVideoUrl(html) {
  const metaKeys = [
    'og:video',
    'og:video:url',
    'og:video:secure_url',
    'twitter:player:stream',
  ];

  for (const key of metaKeys) {
    const metaUrl = normalizePlayableVideoUrl(extractMetaContent(html, key));
    if (metaUrl) {
      return metaUrl;
    }
  }

  const patterns = [
    /"playAddr"\s*:\s*"([^"]+)"/i,
    /"playApi"\s*:\s*"([^"]+)"/i,
    /"src"\s*:\s*"((?:https?:)?\\?\/\\?\/[^"]+\.(?:mp4|m3u8)[^"]*)"/i,
    /<video[^>]+src="([^"]+)"/i,
    /"url_list"\s*:\s*\[\s*"([^"]*(?:mp4|m3u8)[^"]*)"/i,
  ];

  for (const pattern of patterns) {
    const matched = html.match(pattern);
    const candidate = normalizePlayableVideoUrl(matched?.[1] || '');
    if (candidate) {
      return candidate;
    }
  }

  return '';
}

async function fetchVideoMeta(videoUrl) {
  const response = await fetch(videoUrl, {
    headers: DEFAULT_HEADERS,
    redirect: 'follow',
  });

  const html = await response.text();

  return {
    finalUrl: response.url || videoUrl,
    title:
      extractMetaContent(html, 'og:title') ||
      extractMetaContent(html, 'twitter:title') ||
      extractTitle(html),
    videoUrl: extractPlayableVideoUrl(html),
    coverUrl:
      extractMetaContent(html, 'og:image') ||
      extractMetaContent(html, 'twitter:image'),
    description:
      extractMetaContent(html, 'og:description') ||
      extractMetaContent(html, 'description'),
  };
}

export async function searchDouyinVideo(body = {}) {
  const query = String(body.query || '').trim();
  const allowFallback = body.allowFallback !== false;
  if (!query) {
    throw new Error('抖音视频检索需要 query');
  }

  const keyword = buildSearchKeyword(query);
  const searchPath =
    `${config.videoSearch.path}?q=${encodeURIComponent(keyword)}&setlang=zh-CN`;
  const response = await fetch(`https://${config.videoSearch.host}${searchPath}`, {
    headers: DEFAULT_HEADERS,
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`视频检索接口返回 HTTP ${response.status}`);
  }

  const html = await response.text();
  const candidates = extractCandidateUrls(html);
  if (candidates.length === 0) {
    const fallbackVideo = allowFallback ? findFallbackVideo(query) : null;
    if (fallbackVideo) {
      return {
        query,
        keyword,
        url: fallbackVideo.url,
        title: fallbackVideo.title,
        coverUrl: '',
        description: fallbackVideo.description,
        searchUrl: `https://${config.videoSearch.host}${searchPath}`,
        source: 'fallback',
      };
    }
    return {
      query,
      keyword,
      url: '',
      videoUrl: '',
      title: `抖音相关视频：${query}`,
      coverUrl: '',
      description: `暂未检索到“${query}”的具体抖音视频链接，已回退到搜索页。`,
      searchUrl: `https://${config.videoSearch.host}${searchPath}`,
      source: 'search_url_only',
    };
  }

  let lastError = null;
  for (const candidate of candidates.slice(0, 5)) {
    try {
      const meta = await fetchVideoMeta(candidate);
      return {
        query,
        keyword,
        url: meta.finalUrl || candidate,
        videoUrl: meta.videoUrl || '',
        title: meta.title || `抖音视频：${query}`,
        coverUrl: meta.coverUrl || '',
        description: meta.description || '',
        searchUrl: `https://${config.videoSearch.host}${searchPath}`,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    query,
    keyword,
    url: candidates[0],
    videoUrl: '',
    title: `抖音视频：${query}`,
    coverUrl: '',
    description:
      lastError?.message || '已检索到相关抖音视频链接，但暂未提取到完整元信息。',
    searchUrl: `https://${config.videoSearch.host}${searchPath}`,
    source: 'search',
  };
}

export async function resolveDouyinVideo(body = {}) {
  const inputUrl = String(body.url || body.linkUrl || '').trim();
  if (!inputUrl) {
    throw new Error('解析抖音视频需要 url');
  }

  const meta = await fetchVideoMeta(inputUrl);
  return {
    url: meta.finalUrl || inputUrl,
    videoUrl: meta.videoUrl || '',
    title: meta.title || '',
    coverUrl: meta.coverUrl || '',
    description: meta.description || '',
  };
}
