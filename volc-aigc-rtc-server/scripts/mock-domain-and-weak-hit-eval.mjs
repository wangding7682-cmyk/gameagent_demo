/**
 * Domain 过滤 + RAG 弱命中保护 mock 评测
 *
 * 验证（覆盖用户口头确认的 A、D 改造）：
 *   A. multiSourceSearch sticky domain：本轮 query 无域信号、domainContext 含 lol → 域回退到 lol
 *   A. multiSourceSearch strict cross-domain：strict 模式下，跨域文档（wzry）被硬 reject
 *   D. evaluateRagStrength：top1.relevance >= 0.7 → 强命中；< 0.7 / 无 items → 弱命中
 *   D. applyWeakHitGuard：弱命中时在 details/voice_chunks 首位注入"未找到具体对位资料"提示
 *   D. applyWeakHitGuard：强命中时不动原文，weak_hit=false
 */

import { multiSourceSearch } from '../src/services/multiSourceKnowledgeService.js';
import {
  evaluateRagStrength,
  applyWeakHitGuard,
} from '../src/services/strategyAgentService.js';

let pass = 0;
let fail = 0;
function assert(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

// 构造一个最小可用的 user_local 私有库，含 lol 与 wzry 两条文档
function buildMixedSource(domain, items) {
  return {
    type: 'user_local',
    domain,
    label: `用户库-${domain}`,
    enabled: true,
    topK: 5,
    items,
  };
}

console.log('\n[1] sticky domain 回退：本轮 query 是指代/无域，依赖 domainContext');
{
  const sources = [
    buildMixedSource('lol', [
      { id: 'lol-yasuo-1', title: '亚索对线思路', content: '亚索面对盲僧时利用风墙挡Q摸眼，2级前避免硬拼。' },
    ]),
    buildMixedSource('wzry', [
      { id: 'wzry-luban-1', title: '鲁班七号下路', content: '王者荣耀鲁班七号下路对线奕星玩法，注意走位躲技能。' },
    ]),
  ];
  // 本轮 query 是指代式："他们的技能怎么应对" → query 自身 detectDomains=[]
  // domainContext 含上轮亚索 → sticky 回退到 lol → wzry 文档应被 strict reject
  const result = await multiSourceSearch({
    query: '他们的技能怎么应对',
    sources,
    topK: 5,
    rerankStrategy: 'none',
    domainContext: '上一轮：亚索对线盲僧的技能取舍',
    strictDomain: true,
    bypassCache: true,
  });
  assert(
    'sticky 回退命中 lol（domainSource=sticky_context）',
    result.domainSource === 'sticky_context' && result.detectedDomains.includes('lol'),
    `domainSource=${result.domainSource} domains=${JSON.stringify(result.detectedDomains)}`
  );
  assert(
    'strictMode=true（域唯一收敛）',
    result.strictMode === true,
    `strictMode=${result.strictMode}`
  );
  const wzrySkipped = (result.skipped || []).find((s) => s.id === 'wzry-luban-1');
  assert(
    '王者荣耀鲁班文档被 cross_domain_strict 硬 reject',
    wzrySkipped && wzrySkipped.reason === 'cross_domain_strict',
    `wzrySkipped=${JSON.stringify(wzrySkipped)}`
  );
  const hasLol = result.items.some((it) => it.id === 'lol-yasuo-1');
  assert('lol 文档进入 items', hasLol, `items=${result.items.map((i) => i.id).join(',')}`);
}

console.log('\n[2] strictDomain=false 时不硬过滤跨域（保留旧行为兜底）');
{
  const sources = [
    buildMixedSource('lol', [
      { id: 'lol-1', title: '亚索风墙挡Q', content: '亚索通过风墙抵御技能，配合电刀输出。' },
    ]),
    buildMixedSource('wzry', [
      { id: 'wzry-1', title: '王者鲁班', content: '王者荣耀鲁班七号下路玩法注意走位。' },
    ]),
  ];
  const result = await multiSourceSearch({
    query: '亚索 风墙 挡Q',
    sources,
    topK: 5,
    rerankStrategy: 'none',
    strictDomain: false,
    bypassCache: true,
  });
  const strictRejected = (result.skipped || []).filter((s) => s.reason === 'cross_domain_strict');
  assert(
    'strictDomain=false 不产生 cross_domain_strict reject',
    strictRejected.length === 0,
    `strict_rejected=${strictRejected.length}`
  );
}

console.log('\n[3] evaluateRagStrength：分级判定');
{
  const strong = evaluateRagStrength({ items: [{ relevance: 0.85, sourceLabel: '我的本地库', title: 'A' }] });
  assert('relevance=0.85 → 强命中 weakHit=false', strong.weakHit === false && strong.reason === 'ok', JSON.stringify(strong));

  const weak = evaluateRagStrength({ items: [{ relevance: 0.42, sourceLabel: '内置库', title: 'B' }] });
  assert('relevance=0.42 → 弱命中 weakHit=true reason=low_relevance', weak.weakHit === true && weak.reason === 'low_relevance', JSON.stringify(weak));

  const empty = evaluateRagStrength({ items: [] });
  assert('items 空 → 弱命中 reason=no_hit', empty.weakHit === true && empty.reason === 'no_hit', JSON.stringify(empty));

  const boundary = evaluateRagStrength({ items: [{ relevance: 0.7 }] });
  assert('boundary 0.7 视为强命中（>=）', boundary.weakHit === false, JSON.stringify(boundary));
}

console.log('\n[4] applyWeakHitGuard：弱命中注入提示，不污染强命中');
{
  const baseTactic = {
    title: '亚索对线思路',
    details: ['对线避免硬拼', '风墙挡关键技能', '6级后找gank'],
    voice_chunks: ['先稳住兵线。', '风墙挡技能。', '配合打野。'],
    strategy_output_mode: 'text_only',
    needs_image: false,
    image_prompt_text: null,
  };

  const guarded = applyWeakHitGuard(baseTactic, { weakHit: true, top1: 0.3, reason: 'low_relevance' });
  assert('弱命中：details 首行注入"未找到具体对位资料"', String(guarded.details[0]).startsWith('未找到具体对位资料'), JSON.stringify(guarded.details));
  assert('弱命中：voice_chunks 首段含"没找到具体对位"', guarded.voice_chunks[0].includes('没找到具体对位'), JSON.stringify(guarded.voice_chunks));
  assert('弱命中：weak_hit=true / weak_hit_reason=low_relevance', guarded.weak_hit === true && guarded.weak_hit_reason === 'low_relevance', JSON.stringify(guarded));
  assert('弱命中：top1_relevance=0.3 透出', guarded.top1_relevance === 0.3, String(guarded.top1_relevance));

  const strong = applyWeakHitGuard(baseTactic, { weakHit: false, top1: 0.88, reason: 'ok' });
  assert('强命中：details 不被改动（仍以"对线避免硬拼"开头）', strong.details[0] === '对线避免硬拼', JSON.stringify(strong.details));
  assert('强命中：weak_hit=false', strong.weak_hit === false, JSON.stringify(strong));
  assert('强命中：top1_relevance=0.88 透出', strong.top1_relevance === 0.88, String(strong.top1_relevance));
}

console.log('\n[5] applyWeakHitGuard：幂等性 — 二次调用不重复注入提示');
{
  const baseTactic = {
    title: 'X', details: ['原始要点1', '原始要点2'], voice_chunks: ['首段口播。', '次段口播。'],
    strategy_output_mode: 'text_only', needs_image: false, image_prompt_text: null,
  };
  const once = applyWeakHitGuard(baseTactic, { weakHit: true, top1: 0.2, reason: 'low_relevance' });
  const twice = applyWeakHitGuard(once, { weakHit: true, top1: 0.2, reason: 'low_relevance' });
  const dupCount = twice.details.filter((d) => String(d).startsWith('未找到')).length;
  assert('details 中"未找到..."只出现一次（幂等）', dupCount === 1, `dupCount=${dupCount} details=${JSON.stringify(twice.details)}`);
  const dupVoice = twice.voice_chunks.filter((v) => v.includes('没找到具体对位')).length;
  assert('voice_chunks 中提示只出现一次（幂等）', dupVoice === 1, `dupVoice=${dupVoice} voice_chunks=${JSON.stringify(twice.voice_chunks)}`);
}

console.log('\n========================================');
console.log(`总计：PASS=${pass}  FAIL=${fail}`);
console.log('========================================');

process.exit(fail === 0 ? 0 : 1);
