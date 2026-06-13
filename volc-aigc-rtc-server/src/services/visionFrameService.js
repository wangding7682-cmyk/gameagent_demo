/**
 * 【屏幕感知 / 画面识别】visionFrameService
 *
 * 通俗职责：把前端 5 秒抽到的一张游戏截图送给 Ark Vision，识别成标准化事件
 * （血量百分比、大招就绪、被 gank 等），交给 screenEventService 写黑板。
 *
 * 设计要点：
 *   - 没有视觉 API key 时（VISION_MODEL 未配置）走 mock，便于本地开发/CI
 *   - 严格 JSON 输出 + 失败兜底，永不抛错
 *   - 5s 抽帧节奏下，单帧 vision 调用控制在 < 2s 即可不阻塞下一帧
 */

import { config } from '../config.js';
import { extractJsonObject } from './arkChatService.js';
import { safeFetchJson } from '../utils/http.js';

const VISION_TIMEOUT_MS = 8000;

const VISION_SYSTEM_PROMPT = `你是「游戏画面分析器」，负责把一张游戏截图识别成结构化 JSON。
适配游戏：英雄联盟（lol）、王者荣耀（hok）。

输出严格 JSON：
{
  "game": "lol" | "hok" | "unknown",
  "scene": "in_game" | "in_lobby" | "in_loading" | "not_in_game",
  "hp_pct": 0-1 浮点 或 null（看不到血条时 null）,
  "mana_pct": 0-1 浮点 或 null,
  "ult_ready": true/false（大招是否冷却好）,
  "events": [
    { "type": 事件类型, "confidence": 0-1, "target": "self|ally|enemy", "detail": "<30 字描述" }
  ]
}

事件类型白名单（必须用这些 key）：
  low_hp_warning  — 自己血量 < 25%
  ult_ready       — 大招冷却完成
  ganked          — 自己被对方打野/多人围攻
  enemy_missing   — 对线敌人消失
  objective_spawn — 大龙/小龙/暴君刷新或即将刷新
  team_fight      — 多人在打团
  recall          — 自己/队友在回城
  death           — 自己刚阵亡
  level_up        — 自己刚升级
  in_lane         — 正常对线无特殊事件

只输出 JSON，不要任何解释。`;

function buildArkUrl() {
  const proto = config.ark?.useHttps === false ? 'http' : 'https';
  return `${proto}://${config.ark.host}/api/v3/chat/completions`;
}

async function callArkVision({ base64Image, mimeType = 'image/jpeg' }) {
  const apiKey = config.ark?.apiKey;
  const model = config.ark?.visionModel || config.ark?.chatModel;
  if (!apiKey || !model) {
    throw new Error('vision_not_configured');
  }
  const url = buildArkUrl();
  const dataUrl = base64Image.startsWith('data:')
    ? base64Image
    : `data:${mimeType};base64,${base64Image}`;

  const body = {
    model,
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请识别这张游戏截图，输出 JSON。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  const json = await safeFetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    timeoutMs: VISION_TIMEOUT_MS,
  });

  const content = json?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((c) => c.text || '').filter(Boolean).join('\n')
    : (content || '');
  return text;
}

/**
 * Mock 降级：基于一些 hint 字段（前端可附带）模拟事件，便于本地联调。
 * 入参 hints 形如 { force_event: 'low_hp_warning', hp_pct: 0.18 }
 */
function buildMockFrameSchema(hints = {}) {
  const events = [];
  if (hints.force_event) {
    events.push({ type: hints.force_event, confidence: 0.9, target: 'self', detail: 'mock' });
  }
  return {
    game: hints.game || 'lol',
    scene: hints.scene || 'in_game',
    hp_pct: typeof hints.hp_pct === 'number' ? hints.hp_pct : null,
    mana_pct: typeof hints.mana_pct === 'number' ? hints.mana_pct : null,
    ult_ready: hints.ult_ready === true,
    events,
  };
}

/**
 * 主入口：识别一帧。
 * @param {object} input
 *   - base64Image: string  — base64 编码（可带或不带 data:image/... 前缀）
 *   - mimeType: 'image/jpeg' | 'image/png'
 *   - mockHints: object    — 当 vision 不可用时使用
 *   - frameId: string
 * 返回 schema 与 screenEventService.normalizeFrameSnapshot 入参一致。
 */
export async function recognizeFrame(input = {}) {
  const startedAt = Date.now();
  const frameId = String(input.frameId || `frame_${startedAt}`);

  const apiKey = config.ark?.apiKey;
  const model = config.ark?.visionModel || config.ark?.chatModel;
  const hasVision = Boolean(apiKey && model && input.base64Image);

  if (!hasVision) {
    const mock = buildMockFrameSchema(input.mockHints || {});
    return {
      ok: true,
      degraded: true,
      reason: !input.base64Image ? 'no_image' : 'vision_not_configured',
      frame: { ...mock, frame_id: frameId, ts: startedAt },
      latency_ms: Date.now() - startedAt,
    };
  }

  try {
    const text = await callArkVision({
      base64Image: input.base64Image,
      mimeType: input.mimeType || 'image/jpeg',
    });
    const parsed = extractJsonObject(text);
    return {
      ok: true,
      degraded: false,
      reason: null,
      frame: { ...parsed, frame_id: frameId, ts: startedAt },
      latency_ms: Date.now() - startedAt,
      raw_text: typeof text === 'string' ? text.slice(0, 500) : '',
    };
  } catch (err) {
    const mock = buildMockFrameSchema(input.mockHints || {});
    return {
      ok: false,
      degraded: true,
      reason: err?.message || 'vision_failed',
      frame: { ...mock, frame_id: frameId, ts: startedAt },
      latency_ms: Date.now() - startedAt,
    };
  }
}

export const __INTERNAL = { VISION_SYSTEM_PROMPT, buildMockFrameSchema };
