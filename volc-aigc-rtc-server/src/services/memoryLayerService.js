import { vikingSearchMemory } from './volcVikingMemoryService.js';

/**
 * 【分层记忆 / 长期记忆四抽屉】memoryLayerService
 *
 * 通俗职责：把每条记忆按"保鲜期 + 重要度"分到四个抽屉里，
 * 召回时按权重 × 时间衰减打分，老的记忆自动淡出，重要的长期保留。
 *
 * 设计原则：
 *   - Viking 单 collection 不变，layer 信息编码进 summary 前缀
 *   - 写入：[L:layer|TTL:days|W:weight] 实际内容
 *   - 召回：vikingSearchMemory 拿原始结果 → 解析 layer → 过滤/加权/时间衰减
 *   - 不破坏现有 Viking schema，可随时回滚到 P0 行为
 *
 * 四层定义（人话版）：
 *   working    - 短期便签：刚刚说过的话，TTL 1 天
 *   episodic   - 情景记忆：最近发生的事（被 gank 过、聊过亚索），TTL 7 天，由 Reflector 触发
 *   semantic   - 事实档案：关于这个用户的稳定信息（玩什么位/偏好/回避），永不过期
 *   procedural - 经验手册：跟这个用户互动的有效套路（讲解风格/节奏），TTL 30 天
 */

export const LAYER_CONFIG = Object.freeze({
  working: { weight: 1.5, ttl_days: 1 },
  episodic: { weight: 1.2, ttl_days: 7 },
  semantic: { weight: 1.0, ttl_days: null },
  procedural: { weight: 0.6, ttl_days: 30 },
});

export const VALID_LAYERS = Object.freeze(Object.keys(LAYER_CONFIG));

const PREFIX_RE = /^\[L:(working|episodic|semantic|procedural)\|TTL:(\d+|null)\|W:([\d.]+)\]\s*/;

export function encodeLayerSummary(layer, content) {
  const cfg = LAYER_CONFIG[layer];
  if (!cfg) {
    return String(content || '');
  }
  const ttl = cfg.ttl_days === null ? 'null' : String(cfg.ttl_days);
  return `[L:${layer}|TTL:${ttl}|W:${cfg.weight}] ${String(content || '').trim()}`;
}

export function decodeLayerSummary(summary = '') {
  const text = String(summary || '');
  const match = text.match(PREFIX_RE);
  if (!match) {
    return { layer: 'semantic', ttl_days: null, weight: 1.0, content: text, has_prefix: false };
  }
  const [, layer, ttlRaw, weightRaw] = match;
  return {
    layer,
    ttl_days: ttlRaw === 'null' ? null : Number(ttlRaw),
    weight: Number(weightRaw),
    content: text.slice(match[0].length).trim(),
    has_prefix: true,
  };
}

/**
 * 基于上下文推断该候选应该写到哪一层
 *
 * - 来自 Reflector 的 episodic 候选 → episodic
 * - facts/preferences/avoidances → semantic
 * - 高频出现且统计型 → procedural
 * - 默认 → working（短期）
 */
export function inferMemoryLayer({ source = '', bucket = '', confidence = 0, isEvent = false } = {}) {
  if (source === 'reflector') {
    return isEvent ? 'episodic' : 'procedural';
  }
  if (['facts', 'preferences', 'avoidances'].includes(bucket)) {
    return confidence >= 0.7 ? 'semantic' : 'working';
  }
  return 'working';
}

/**
 * 时间衰减因子
 *   - 过期返回 0（应在召回端被过滤）
 *   - 半衰期 = ttl_days/2，用 0.5^(age/half_life) 计算
 */
export function computeTimeDecay({ ttl_days, age_days }) {
  if (ttl_days === null || ttl_days === undefined) return 1.0;
  if (age_days >= ttl_days) return 0;
  const halfLife = ttl_days / 2;
  return Math.pow(0.5, age_days / halfLife);
}

function ageDaysFromTime(timeIso) {
  if (!timeIso) return 0;
  const t = Date.parse(timeIso);
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

/**
 * 分层召回
 *   layers: 允许的 layer 数组，默认全部
 *   返回 { items: [{layer, content, score, weight, decay, time_iso}], counts_per_layer }
 */
export async function searchLayered({
  query = '',
  userId = '',
  layers = VALID_LAYERS,
  limit = 10,
  turnId = '',
} = {}) {
  const allowedLayers = new Set(layers.filter((l) => VALID_LAYERS.includes(l)));
  if (allowedLayers.size === 0) {
    return { items: [], counts_per_layer: {}, raw_count: 0 };
  }

  let raw;
  try {
    raw = await vikingSearchMemory({ query, user_id: userId, limit }, turnId);
  } catch (error) {
    return { items: [], counts_per_layer: {}, raw_count: 0, error: error.message };
  }

  const list = raw?.data?.result_list || [];
  const counts = { working: 0, episodic: 0, semantic: 0, procedural: 0 };
  const items = [];

  for (const item of list) {
    const summaryText = item?.memory_info?.summary || '';
    const decoded = decodeLayerSummary(summaryText);
    if (!allowedLayers.has(decoded.layer)) continue;

    const ageDays = ageDaysFromTime(item?.time);
    const decay = computeTimeDecay({ ttl_days: decoded.ttl_days, age_days: ageDays });
    if (decay === 0) continue;

    const baseScore = typeof item.score === 'number' ? item.score : 0;
    const finalScore = baseScore * decoded.weight * decay;
    counts[decoded.layer] += 1;
    items.push({
      layer: decoded.layer,
      content: decoded.content,
      base_score: baseScore,
      weight: decoded.weight,
      decay,
      final_score: finalScore,
      time_iso: item?.time || null,
      event_id: item?.event_id || null,
    });
  }

  items.sort((a, b) => b.final_score - a.final_score);
  return {
    items: items.slice(0, limit),
    counts_per_layer: counts,
    raw_count: list.length,
  };
}

export const __INTERNAL = {
  PREFIX_RE,
  ageDaysFromTime,
};
