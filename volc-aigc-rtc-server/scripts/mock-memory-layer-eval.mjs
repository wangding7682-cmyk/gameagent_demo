#!/usr/bin/env node
/**
 * P1 分层记忆 mock 评测
 *
 * 不真调 Viking，用 mock data 验证：
 *   1. encodeLayerSummary / decodeLayerSummary 闭环
 *   2. inferMemoryLayer 分桶逻辑
 *   3. computeTimeDecay 时间衰减
 *   4. searchLayered 排序、过滤、加权
 *
 * 运行：node scripts/mock-memory-layer-eval.mjs
 */

import {
  encodeLayerSummary,
  decodeLayerSummary,
  inferMemoryLayer,
  computeTimeDecay,
  LAYER_CONFIG,
  VALID_LAYERS,
} from '../src/services/memoryLayerService.js';

let pass = 0;
let fail = 0;
const failures = [];

function expect(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    failures.push({ name, expected: e, actual: a });
    console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
  }
}

function expectClose(name, actual, expected, tol = 1e-6) {
  if (Math.abs(actual - expected) <= tol) {
    pass += 1;
    console.log(`  PASS ${name} (≈${actual.toFixed(4)})`);
  } else {
    fail += 1;
    failures.push({ name, expected, actual });
    console.log(`  FAIL ${name}\n    expected ${expected}\n    actual   ${actual}`);
  }
}

console.log('\n[1] encode/decode 闭环');
for (const layer of VALID_LAYERS) {
  const encoded = encodeLayerSummary(layer, '盲僧打豹女反野');
  const decoded = decodeLayerSummary(encoded);
  expect(`${layer}_encode_then_decode`, {
    layer: decoded.layer,
    weight: decoded.weight,
    ttl: decoded.ttl_days,
    has_prefix: decoded.has_prefix,
    content: decoded.content,
  }, {
    layer,
    weight: LAYER_CONFIG[layer].weight,
    ttl: LAYER_CONFIG[layer].ttl_days,
    has_prefix: true,
    content: '盲僧打豹女反野',
  });
}

console.log('\n[2] decode 旧数据无前缀降级到 semantic');
const legacy = decodeLayerSummary('用户偏好玩盲僧');
expect('legacy_no_prefix', {
  layer: legacy.layer,
  weight: legacy.weight,
  ttl: legacy.ttl_days,
  has_prefix: legacy.has_prefix,
  content: legacy.content,
}, {
  layer: 'semantic',
  weight: 1.0,
  ttl: null,
  has_prefix: false,
  content: '用户偏好玩盲僧',
});

console.log('\n[3] inferMemoryLayer 分桶');
expect('reflector_event_to_episodic',
  inferMemoryLayer({ source: 'reflector', isEvent: true }), 'episodic');
expect('reflector_no_event_to_procedural',
  inferMemoryLayer({ source: 'reflector', isEvent: false }), 'procedural');
expect('high_conf_facts_to_semantic',
  inferMemoryLayer({ source: 'memory_writer', bucket: 'facts', confidence: 0.9 }), 'semantic');
expect('low_conf_facts_to_working',
  inferMemoryLayer({ source: 'memory_writer', bucket: 'facts', confidence: 0.4 }), 'working');
expect('high_conf_pref_to_semantic',
  inferMemoryLayer({ source: 'memory_writer', bucket: 'preferences', confidence: 0.85 }), 'semantic');
expect('default_to_working',
  inferMemoryLayer({}), 'working');

console.log('\n[4] computeTimeDecay 时间衰减');
expectClose('永久（ttl=null）',
  computeTimeDecay({ ttl_days: null, age_days: 100 }), 1.0);
expectClose('刚写入',
  computeTimeDecay({ ttl_days: 7, age_days: 0 }), 1.0);
expectClose('半衰期（=ttl/2）',
  computeTimeDecay({ ttl_days: 7, age_days: 3.5 }), 0.5);
expectClose('过期',
  computeTimeDecay({ ttl_days: 7, age_days: 7 }), 0);
expectClose('working 1天后过期',
  computeTimeDecay({ ttl_days: 1, age_days: 1 }), 0);

console.log('\n[5] searchLayered 排序合并（mock vikingSearchMemory）');
// 我们直接 mock 一个 raw vikingSearchMemory 风格的结果，用 decode + 排序逻辑模拟 searchLayered 的核心算法。
// 这一步不引入实际 fetch，纯算法验证。
const NOW = Date.now();
const oneDayMs = 24 * 60 * 60 * 1000;
const mockItems = [
  { time: new Date(NOW - 0.1 * oneDayMs).toISOString(), score: 0.9, memory_info: { summary: encodeLayerSummary('working', '刚才问过反野') } },
  { time: new Date(NOW - 3 * oneDayMs).toISOString(), score: 0.8, memory_info: { summary: encodeLayerSummary('episodic', '被反野丢了 buff') } },
  { time: new Date(NOW - 30 * oneDayMs).toISOString(), score: 0.7, memory_info: { summary: encodeLayerSummary('semantic', '用户主玩打野') } },
  { time: new Date(NOW - 8 * oneDayMs).toISOString(), score: 0.85, memory_info: { summary: encodeLayerSummary('episodic', '过期事件') } }, // 8天>7天，应被过滤
  { time: new Date(NOW - 100 * oneDayMs).toISOString(), score: 0.95, memory_info: { summary: '老数据无前缀' } }, // 老数据当 semantic
];

// 复制 searchLayered 内的核心算法（避免真调网络）
function localSearchLayered(rawItems, { layers = VALID_LAYERS, limit = 10 } = {}) {
  const allowed = new Set(layers.filter((l) => VALID_LAYERS.includes(l)));
  const items = [];
  for (const item of rawItems) {
    const decoded = decodeLayerSummary(item.memory_info?.summary || '');
    if (!allowed.has(decoded.layer)) continue;
    const ageMs = NOW - Date.parse(item.time);
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const decay = computeTimeDecay({ ttl_days: decoded.ttl_days, age_days: ageDays });
    if (decay === 0) continue;
    const baseScore = item.score;
    const finalScore = baseScore * decoded.weight * decay;
    items.push({ layer: decoded.layer, content: decoded.content, base_score: baseScore, weight: decoded.weight, decay, final_score: finalScore });
  }
  items.sort((a, b) => b.final_score - a.final_score);
  return items.slice(0, limit);
}

const allLayers = localSearchLayered(mockItems);
console.log(`  返回 ${allLayers.length} 条（应过滤掉 1 条过期 episodic）`);
allLayers.forEach((it, i) => {
  console.log(`    [#${i}] layer=${it.layer} final=${it.final_score.toFixed(3)} (base=${it.base_score} × w=${it.weight} × decay=${it.decay.toFixed(3)}) | ${it.content}`);
});
expect('过滤过期事件后剩 4 条', allLayers.length, 4);
expect('working 排第一（权重 1.5 × 高分 × 几乎无衰减）', allLayers[0].layer, 'working');

const onlyEpisodic = localSearchLayered(mockItems, { layers: ['episodic'] });
expect('only_episodic 过滤后剩 1 条', onlyEpisodic.length, 1);
expect('only_episodic 内容正确', onlyEpisodic[0].content, '被反野丢了 buff');

const onlySemantic = localSearchLayered(mockItems, { layers: ['semantic'] });
expect('only_semantic 含 2 条（含老数据）', onlySemantic.length, 2);

console.log('\n========== 总结 ==========');
console.log(`PASS ${pass}  FAIL ${fail}`);
if (fail > 0) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  - ${f.name}: expected=${JSON.stringify(f.expected)} actual=${JSON.stringify(f.actual)}`));
  process.exit(1);
}
