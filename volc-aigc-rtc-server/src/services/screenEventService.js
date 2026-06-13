/**
 * 【屏幕感知 / 事件标准化 + 黑板写入】screenEventService
 *
 * 通俗职责：把 vision 识别出来的游戏事件按白名单卡死格式（type/priority/confidence）、
 * 用 per-type 冷却抑制刷屏，然后写到会话黑板的 screen_event_state 字段。
 * 静默感知：只写黑板不主动播报，主动话术权统一交给 Reflector 的 proactive_cue。
 *
 * 兼容 LoL（英雄联盟）与 HoK（王者荣耀）：用统一事件 type，不绑定具体游戏术语。
 *
 * 这里提供：
 *   - GAME_EVENT_TYPES：事件白名单 + 优先级 + 默认冷却时间
 *   - normalizeGameEvent / normalizeFrameSnapshot：把任意输入约束到 schema
 *   - shouldEmitProactive：基于 per-type 冷却 + 优先级判断本帧是否计入"流水"
 *   - buildProactiveCue：保留为可选展示文案，当前不上播报通道
 *   - buildScreenContextSummary：把黑板状态拼成给 LLM 看的注入摘要
 */

import { upsertAgentDynamicContext, getAgentSessionState } from './agentSessionStateService.js';

export const GAME_EVENT_TYPES = Object.freeze({
  low_hp_warning: { priority: 'high', cooldown_ms: 8000, label: '血量危险' },
  ult_ready: { priority: 'normal', cooldown_ms: 15000, label: '大招就绪' },
  ganked: { priority: 'high', cooldown_ms: 10000, label: '被 gank' },
  enemy_missing: { priority: 'normal', cooldown_ms: 12000, label: '敌方消失' },
  objective_spawn: { priority: 'normal', cooldown_ms: 30000, label: '关键资源刷新' },
  team_fight: { priority: 'high', cooldown_ms: 10000, label: '团战开始' },
  recall: { priority: 'low', cooldown_ms: 30000, label: '撤退/回城' },
  death: { priority: 'high', cooldown_ms: 6000, label: '阵亡' },
  level_up: { priority: 'low', cooldown_ms: 30000, label: '升级' },
  in_lane: { priority: 'low', cooldown_ms: 60000, label: '正常对线' },
  not_in_game: { priority: 'low', cooldown_ms: 60000, label: '非对局画面' },
});

export const GAMES = Object.freeze({
  lol: 'lol',
  hok: 'hok',
  unknown: 'unknown',
});

const DEFAULT_FRAME_INTERVAL_MS = 5000;

function clamp01(n, fallback = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(1, Math.max(0, x));
}

function safeStringField(s, max) {
  return String(s || '').trim().slice(0, max);
}

/**
 * 标准化单个事件。无效字段会被丢弃。
 */
export function normalizeGameEvent(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim();
  if (!GAME_EVENT_TYPES[type]) return null;
  return {
    type,
    priority: GAME_EVENT_TYPES[type].priority,
    confidence: clamp01(raw.confidence, 0.5),
    target: safeStringField(raw.target, 30),
    detail: safeStringField(raw.detail, 80),
    detected_at: typeof raw.detected_at === 'number' ? raw.detected_at : Date.now(),
  };
}

/**
 * 标准化整帧识别结果。
 * 输入示例（来自 Vision LLM）：
 *   { game: 'lol', scene: 'in_game', hp_pct: 0.18, ult_ready: true, ... }
 * 输出：
 *   { game, scene, hp_pct, events: [...], frame_id, ts }
 */
export function normalizeFrameSnapshot(raw = {}) {
  const game = GAMES[String(raw.game || '').toLowerCase()] || GAMES.unknown;
  const sceneRaw = String(raw.scene || '').toLowerCase();
  const scene = ['in_game', 'in_lobby', 'in_loading', 'not_in_game'].includes(sceneRaw)
    ? sceneRaw
    : 'unknown';
  const events = Array.isArray(raw.events)
    ? raw.events.map(normalizeGameEvent).filter(Boolean).slice(0, 5)
    : [];
  return {
    game,
    scene,
    hp_pct: raw.hp_pct == null ? null : clamp01(raw.hp_pct, null),
    mana_pct: raw.mana_pct == null ? null : clamp01(raw.mana_pct, null),
    ult_ready: raw.ult_ready === true,
    events,
    frame_id: safeStringField(raw.frame_id, 32) || `frame_${Date.now()}`,
    ts: typeof raw.ts === 'number' ? raw.ts : Date.now(),
    interval_ms: Number(raw.interval_ms) > 0 ? Number(raw.interval_ms) : DEFAULT_FRAME_INTERVAL_MS,
  };
}

/**
 * 计算事件是否应该主动播报：基于 per-session 冷却。
 * 返回 { allow, reason, cooldown_left_ms }
 */
export function shouldEmitProactive({ event, lastEmittedMap = {}, now = Date.now() }) {
  if (!event || !GAME_EVENT_TYPES[event.type]) {
    return { allow: false, reason: 'invalid_event', cooldown_left_ms: 0 };
  }
  if (event.confidence < 0.5) {
    return { allow: false, reason: 'low_confidence', cooldown_left_ms: 0 };
  }
  const cfg = GAME_EVENT_TYPES[event.type];
  const lastTs = Number(lastEmittedMap[event.type]) || 0;
  const elapsed = now - lastTs;
  if (lastTs > 0 && elapsed < cfg.cooldown_ms) {
    return { allow: false, reason: 'cooldown', cooldown_left_ms: cfg.cooldown_ms - elapsed };
  }
  return { allow: true, reason: 'ok', cooldown_left_ms: 0 };
}

const CUE_TEMPLATES = {
  low_hp_warning: ['血线很危险，要不要先撤？', '快退后回血，被点死就亏了？'],
  ult_ready: ['大招好了，找机会切人？', '大招满了，要不要开团？'],
  ganked: ['打野来了，先撤回塔下？', '小心，敌方打野在你身后？'],
  enemy_missing: ['对面消失了，要不要插眼？', '对面 mia，先稳一手？'],
  objective_spawn: ['资源刷了，要不要打？', '关键资源出来了，组织一下？'],
  team_fight: ['团战开了，跟上去？', '要不要绕后切后排？'],
  death: ['节奏先慢一点，等队友？', '复活后稳着打，别再送？'],
  recall: ['顺便买装备调整一下？', '回去补一下视野？'],
  level_up: ['升级了，技能加点确认下？', '等级到了，要不要找机会？'],
};

export function buildProactiveCue(event) {
  if (!event || !CUE_TEMPLATES[event.type]) return '';
  const pool = CUE_TEMPLATES[event.type];
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] || pool[0];
}

/**
 * 处理一帧：标准化 + 选出最高优先级事件 + 冷却判断 + 更新 lastEmittedMap。
 * 返回：{ frame, picked, cue, allowed, screen_state }
 */
export function processFrame({ rawFrame, sessionId = 'default', now = Date.now() }) {
  const frame = normalizeFrameSnapshot(rawFrame);
  const session = getAgentSessionState(sessionId);
  const prevState = session?.dynamic_context?.screen_event_state || {
    last_emitted: {},
    last_frame_id: '',
    last_scene: '',
    recent_events: [],
  };
  const lastEmittedMap = prevState.last_emitted || {};
  const prevRecentEvents = Array.isArray(prevState.recent_events) ? prevState.recent_events : [];

  let picked = null;
  if (frame.scene === 'in_game' && frame.events.length > 0) {
    const sorted = [...frame.events].sort((a, b) => {
      const pa = a.priority === 'high' ? 2 : a.priority === 'normal' ? 1 : 0;
      const pb = b.priority === 'high' ? 2 : b.priority === 'normal' ? 1 : 0;
      if (pb !== pa) return pb - pa;
      return (b.confidence || 0) - (a.confidence || 0);
    });
    picked = sorted[0];
  }

  let allowedResult = { allow: false, reason: 'no_event', cooldown_left_ms: 0 };
  let cue = '';
  if (picked) {
    allowedResult = shouldEmitProactive({ event: picked, lastEmittedMap, now });
    if (allowedResult.allow) {
      cue = buildProactiveCue(picked);
      lastEmittedMap[picked.type] = now;
    }
  }

  // 维护最近事件环形流水（最多 5 条，按时间倒序）。
  // 仅当本帧有 picked 且通过冷却判定时才入流水，避免噪声 / 重复刷屏。
  const RECENT_EVENTS_LIMIT = 5;
  let nextRecentEvents = prevRecentEvents;
  if (picked && allowedResult.allow) {
    const entry = {
      type: picked.type,
      label: GAME_EVENT_TYPES[picked.type]?.label || picked.type,
      priority: picked.priority,
      confidence: typeof picked.confidence === 'number' ? picked.confidence : 0,
      ts: now,
    };
    nextRecentEvents = [entry, ...prevRecentEvents].slice(0, RECENT_EVENTS_LIMIT);
  }

  const nextState = {
    last_emitted: lastEmittedMap,
    last_frame_id: frame.frame_id,
    last_scene: frame.scene,
    last_game: frame.game,
    last_hp_pct: frame.hp_pct,
    last_ult_ready: frame.ult_ready,
    recent_events: nextRecentEvents,
    updated_at: new Date(now).toISOString(),
    updated_at_ms: now,
  };
  upsertAgentDynamicContext(sessionId, { screen_event_state: nextState });

  return {
    frame,
    picked,
    cue,
    allowed: allowedResult.allow,
    allowed_reason: allowedResult.reason,
    cooldown_left_ms: allowedResult.cooldown_left_ms,
    screen_state: nextState,
  };
}

export const __INTERNAL = { CUE_TEMPLATES, DEFAULT_FRAME_INTERVAL_MS };

/**
 * 把 screen_event_state 拼成一句给 LLM 看的「当前画面」摘要。
 * - freshnessMs：超过该阈值就不暴露 hp/ult/scene（避免 LLM 当作"现在"）。
 * - 输出 summary 字符串硬限 80 字以内；recentEvents 最多返回 3 条。
 * 返回 null 表示无可注入信息。
 */
export function buildScreenContextSummary(screenEventState, options = {}) {
  if (!screenEventState || typeof screenEventState !== 'object') return null;
  const now = options.now || Date.now();
  const freshnessMs = options.freshnessMs || 10000;
  const updatedAt = Number(screenEventState.updated_at_ms) || 0;
  const ageMs = updatedAt ? now - updatedAt : Infinity;
  const isFresh = ageMs <= freshnessMs;

  const game = screenEventState.last_game || '';
  const scene = screenEventState.last_scene || '';
  const hpPct = typeof screenEventState.last_hp_pct === 'number' ? screenEventState.last_hp_pct : null;
  const ultReady = screenEventState.last_ult_ready === true;

  const gameLabel = game === 'lol' ? '英雄联盟' : (game === 'hok' ? '王者荣耀' : '');
  const sceneLabel = scene === 'in_game' ? '对局中' : (scene === 'lobby' ? '大厅' : (scene === 'loading' ? '载入中' : (scene || '')));

  const parts = [];
  if (isFresh) {
    if (gameLabel) parts.push(`游戏:${gameLabel}`);
    if (sceneLabel) parts.push(`场景:${sceneLabel}`);
    if (hpPct !== null) parts.push(`血量:${Math.round(hpPct * 100)}%`);
    if (ultReady) parts.push('大招就绪');
  }

  const recentEventsRaw = Array.isArray(screenEventState.recent_events) ? screenEventState.recent_events : [];
  const recentEvents = recentEventsRaw.slice(0, 3).map((e) => {
    const ageSec = e.ts ? Math.max(1, Math.round((now - e.ts) / 1000)) : null;
    return {
      type: e.type,
      label: e.label || e.type,
      priority: e.priority,
      confidence: e.confidence,
      ageSec,
    };
  });

  if (parts.length === 0 && recentEvents.length === 0) return null;

  let summary = parts.join(' | ');
  if (recentEvents.length > 0) {
    const evtLine = recentEvents
      .map((e) => `${e.ageSec ? e.ageSec + '秒前' : '刚刚'}:${e.label}`)
      .join('；');
    summary = summary ? `${summary}；近期${evtLine}` : `近期${evtLine}`;
  }
  if (summary.length > 80) summary = summary.slice(0, 78) + '…';

  return {
    summary,
    isFresh,
    ageMs,
    recentEvents,
  };
}
