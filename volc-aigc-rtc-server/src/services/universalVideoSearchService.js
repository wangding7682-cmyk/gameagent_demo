import { config } from '../config.js';
import { searchDouyinVideo } from './douyinVideoSearchService.js';

const SEARCH_TIMEOUT_MS = 12000;
const META_FETCH_TIMEOUT_MS = 8000;

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function nowIso() {
  return new Date().toISOString();
}

function logUniversal(message, data = {}) {
  console.log(`[UniversalVideo] ${message}`, { at: nowIso(), ...data });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const err = new Error(`${label} 超时 (${ms}ms)`);
        err.code = 'TIMEOUT';
        reject(err);
      }, ms)
    ),
  ]);
}

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

function normalizeUrl(raw) {
  if (!raw) return '';
  let url = decodeEscapedText(decodeHtmlEntities(String(raw).trim()));
  if (url.startsWith('//')) url = 'https:' + url;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

function isPlayableDirectUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (/\.(mp4|m3u8|webm)(\?|$)/i.test(s)) return true;
  if (/\/playurl\b/i.test(s)) return true;
  if (/\/video\/play\b/i.test(s)) return true;
  if (/\/playAddr\b/i.test(s)) return true;
  if (/\/stream\b/i.test(s) && /\.(mp4|m3u8)/i.test(s)) return true;
  return false;
}

function detectPlatformFromUrl(url) {
  const host = (url || '').toLowerCase();
  if (/bilibili\.com|b23\.tv/i.test(host)) return 'bilibili';
  if (/douyin\.com|jingxuan\.douyin\.com/i.test(host)) return 'douyin';
  if (/youtube\.com|youtu\.be/i.test(host)) return 'youtube';
  if (/v\.qq\.com/i.test(host)) return 'qq';
  if (/ixigua\.com/i.test(host)) return 'ixigua';
  if (/kuaishou\.com/i.test(host)) return 'kuaishou';
  return 'unknown';
}

function buildBilibiliEmbedUrl(pageUrl) {
  const match = String(pageUrl || '').match(/\/video\/(BV[a-zA-Z0-9]+)/i);
  if (match) {
    return `https://player.bilibili.com/player.html?bvid=${match[1]}&autoplay=1&high_quality=1`;
  }
  return '';
}

async function fetchPageMeta(pageUrl) {
  const resp = await fetch(pageUrl, {
    headers: DEFAULT_HEADERS,
    redirect: 'follow',
  });
  const html = await resp.text();
  const finalUrl = resp.url || pageUrl;

  function extractMeta(key) {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) return decodeHtmlEntities(m[1]);
    }
    return '';
  }

  function extractTitle() {
    const m = html.match(/<title>([\s\S]*?)<\/title>/i);
    return decodeHtmlEntities(m?.[1] || '').trim();
  }

  function extractPlayableUrl() {
    const metaKeys = ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'];
    for (const key of metaKeys) {
      const u = normalizeUrl(extractMeta(key));
      if (u && isPlayableDirectUrl(u)) return u;
    }

    const patterns = [
      /"playAddr"\s*:\s*"([^"]+)"/i,
      /"playApi"\s*:\s*"([^"]+)"/i,
      /"src"\s*:\s*"((?:https?:)?\\?\/\\?\/[^"]+\.(?:mp4|m3u8)[^"]*)"/i,
      /<video[^>]+src="([^"]+)"/i,
      /"url_list"\s*:\s*\[\s*"([^"]*(?:mp4|m3u8)[^"]*)"/i,
      /"base_url"\s*:\s*"([^"]*(?:mp4|m3u8)[^"]*)"/i,
      /"video_url"\s*:\s*"([^"]+)"/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      const u = normalizeUrl(m?.[1] || '');
      if (u) return u;
    }
    return '';
  }

  return {
    finalUrl,
    title: extractMeta('og:title') || extractMeta('twitter:title') || extractTitle(),
    coverUrl: extractMeta('og:image') || extractMeta('twitter:image'),
    description: extractMeta('og:description') || extractMeta('description'),
    playableUrl: extractPlayableUrl(),
  };
}

async function searchBilibili(query) {
  logUniversal('search_bilibili_start', { query });
  try {
    const keyword = encodeURIComponent(query);
    const searchUrl = `https://search.bilibili.com/all?keyword=${keyword}&order=click`;
    const resp = await withTimeout(
      fetch(searchUrl, { headers: DEFAULT_HEADERS, redirect: 'follow' }),
      SEARCH_TIMEOUT_MS,
      'B站搜索'
    );
    const html = await resp.text();

    const videoLinks = [];
    const linkRegex = /href="\/\/(www\.bilibili\.com\/video\/BV[^"]+)"/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      videoLinks.push('https://' + match[1]);
    }

    logUniversal('search_bilibili_candidates', { query, count: videoLinks.length });

    if (videoLinks.length === 0) {
      return {
        playableUrl: '',
        pageUrl: searchUrl,
        title: `B站搜索：${query}`,
        description: `已跳转至B站搜索页，可直接浏览相关视频。`,
        coverUrl: '',
        sourcePlatform: 'bilibili',
      };
    }

    const firstLink = videoLinks[0];
    let title = `B站视频：${query}`;
    let description = '';
    let coverUrl = '';
    try {
      const meta = await withTimeout(fetchPageMeta(firstLink), META_FETCH_TIMEOUT_MS, 'B站视频元数据');
      title = meta.title || title;
      description = meta.description || description;
      coverUrl = meta.coverUrl || coverUrl;
      if (meta.playableUrl) {
        logUniversal('search_bilibili_found_playable', {
          query,
          title: meta.title,
          playableUrl: meta.playableUrl.slice(0, 80),
        });
        return {
          playableUrl: meta.playableUrl,
          pageUrl: meta.finalUrl || firstLink,
          title,
          description,
          coverUrl,
          sourcePlatform: 'bilibili',
        };
      }
    } catch (_) {}

    logUniversal('search_bilibili_fallback_page', { query, pageUrl: firstLink });
    return {
      playableUrl: '',
      pageUrl: firstLink,
      title,
      description: description || `已找到B站相关视频，点击即可观看。`,
      coverUrl,
      sourcePlatform: 'bilibili',
    };
  } catch (error) {
    logUniversal('search_bilibili_error', { query, message: error.message });
    return null;
  }
}

async function searchDouyin(query) {
  logUniversal('search_douyin_start', { query });
  try {
    const result = await withTimeout(searchDouyinVideo({ query, allowFallback: true }), SEARCH_TIMEOUT_MS, '抖音搜索');

    if (result.videoUrl && isPlayableDirectUrl(result.videoUrl)) {
      logUniversal('search_douyin_found_playable', {
        query,
        title: result.title,
        playableUrl: result.videoUrl.slice(0, 80),
      });
      return {
        playableUrl: result.videoUrl,
        pageUrl: result.url || '',
        title: result.title,
        description: result.description || '',
        coverUrl: result.coverUrl || '',
        sourcePlatform: 'douyin',
      };
    }

    if (result.url) {
      logUniversal('search_douyin_no_direct_link', {
        query,
        title: result.title,
        pageUrl: result.url,
      });

      try {
        const meta = await withTimeout(fetchPageMeta(result.url), META_FETCH_TIMEOUT_MS, '抖音页面二次解析');
        if (meta.playableUrl) {
          return {
            playableUrl: meta.playableUrl,
            pageUrl: meta.finalUrl,
            title: meta.title || result.title,
            description: meta.description || result.description,
            coverUrl: meta.coverUrl || result.coverUrl,
            sourcePlatform: 'douyin',
          };
        }
      } catch (_) {}

      return {
        playableUrl: '',
        pageUrl: result.url,
        title: result.title,
        description: result.description,
        coverUrl: result.coverUrl,
        sourcePlatform: 'douyin',
      };
    }

    if (result.searchUrl) {
      return {
        playableUrl: '',
        pageUrl: result.searchUrl,
        title: result.title || `抖音搜索：${query}`,
        description: result.description || `暂未检索到"${query}"的抖音视频，可点击前往搜索页查找。`,
        coverUrl: '',
        sourcePlatform: 'douyin',
      };
    }

    return null;
  } catch (error) {
    logUniversal('search_douyin_error', { query, message: error.message });
    return null;
  }
}

async function searchGeneric(query) {
  logUniversal('search_generic_start', { query });
  try {
    const keyword = `${query} 视频 教学集锦`.trim();
    const encodedKeyword = encodeURIComponent(keyword);
    const searchPath = `${config.videoSearch.path}?q=${encodedKeyword}&setlang=zh-CN`;
    const searchUrl = `https://${config.videoSearch.host}${searchPath}`;

    const resp = await withTimeout(
      fetch(searchUrl, { headers: DEFAULT_HEADERS, redirect: 'follow' }),
      SEARCH_TIMEOUT_MS,
      '通用搜索'
    );

    const html = await resp.text();
    const urlPattern = /href="(https?:\/\/[^"]+)"/gi;
    const candidates = [];
    let m;

    while ((m = urlPattern.exec(html)) !== null) {
      const rawUrl = m[1];
      if (/bing\.com\/ck\/a/i.test(rawUrl)) continue;
      if (/^\/\//.test(rawUrl)) continue;
      const platform = detectPlatformFromUrl(rawUrl);
      if (platform === 'unknown' && !isPlayableDirectUrl(rawUrl)) continue;
      candidates.push(normalizeUrl(rawUrl));
    }

    const uniqueCandidates = [...new Set(candidates)].filter(Boolean);

    logUniversal('search_generic_candidates', { query, count: uniqueCandidates.length });

    for (const url of uniqueCandidates.slice(0, 6)) {
      if (isPlayableDirectUrl(url)) {
        logUniversal('search_generic_found_direct_url', { query, url: url.slice(0, 80), platform: detectPlatformFromUrl(url) });
        return {
          playableUrl: url,
          pageUrl: url,
          title: `视频：${query}`,
          description: `通过通用搜索找到可播放直链。`,
          coverUrl: '',
          sourcePlatform: detectPlatformFromUrl(url),
        };
      }

      try {
        const meta = await withTimeout(fetchPageMeta(url), META_FETCH_TIMEOUT_MS, '通用视频元数据');
        if (meta.playableUrl) {
          logUniversal('search_generic_found_via_meta', {
            query,
            title: meta.title,
            platform: detectPlatformFromUrl(meta.finalUrl),
          });
          return {
            playableUrl: meta.playableUrl,
            pageUrl: meta.finalUrl,
            title: meta.title,
            description: meta.description,
            coverUrl: meta.coverUrl,
            sourcePlatform: detectPlatformFromUrl(meta.finalUrl),
          };
        }
      } catch (_) {}
    }

    return null;
  } catch (error) {
    logUniversal('search_generic_error', { query, message: error.message });
    return null;
  }
}

export async function searchUniversalVideo(body = {}) {
  const query = String(body.query || '').trim();
  if (!query) throw new Error('通用视频检索需要 query');
  const bilibiliQuery = String(body.bilibiliQuery || query).trim();
  const douyinQuery = String(body.douyinQuery || query).trim();
  const genericQuery = String(body.genericQuery || query).trim();

  logUniversal('search_start', { query, bilibiliQuery, douyinQuery, genericQuery });

  const sources = [
    { name: 'bilibili', fn: () => searchBilibili(bilibiliQuery) },
    { name: 'douyin', fn: () => searchDouyin(douyinQuery) },
    { name: 'generic', fn: () => searchGeneric(genericQuery) },
  ];

  let lastError = null;
  let bestPartialResult = null;

  const isBilibiliPageUrl = (url = '') => /bilibili\.com\/video\/BV/i.test(url);

  for (const source of sources) {
    try {
      const result = await source.fn();

      if (result && result.playableUrl) {
        logUniversal('search_success_with_playable', {
          query,
          source: source.name,
          title: result.title,
          platform: result.sourcePlatform,
        });
        return result;
      }

      if (result && result.pageUrl) {
        if (isBilibiliPageUrl(result.pageUrl)) {
          logUniversal('search_bilibili_page_url_preferred', {
            query,
            source: source.name,
            title: result.title,
            pageUrl: result.pageUrl,
          });
          return result;
        }
        if (!bestPartialResult) {
          bestPartialResult = result;
          logUniversal('search_partial_result', {
            query,
            source: source.name,
            title: result.title,
            has_page_url: Boolean(result.pageUrl),
          });
        }
      }
    } catch (error) {
      lastError = error;
      logUniversal('search_source_failed', { query, source: source.name, message: error.message });
    }
  }

  if (bestPartialResult) {
    logUniversal('search_fallback_to_partial', {
      query,
      title: bestPartialResult.title,
      platform: bestPartialResult.sourcePlatform,
    });
    return bestPartialResult;
  }

  const errorMessage = lastError ? lastError.message : '所有视频源均未返回有效结果';
  logUniversal('search_all_failed', { query, error: errorMessage });

  throw new Error(`通用视频搜索失败：${errorMessage}`);
}
