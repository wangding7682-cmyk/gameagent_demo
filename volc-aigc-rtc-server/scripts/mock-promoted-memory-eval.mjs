// Mock 验证：orchestrator 中 maybeWritePromotedMemory 的门控逻辑
// 跑：node scripts/mock-promoted-memory-eval.mjs
//
// 我们不真正引 orchestrator（那会拉起整个服务）。
// 直接复刻同样的判定逻辑，作为单元测试守住关键不变量。

import { encodeLayerSummary } from '../src/services/memoryLayerService.js';
import { normalizeReflection } from '../src/services/reflectorAgentService.js';

let pass = 0;
let fail = 0;
const log = [];
function assert(name, cond, detail) {
  if (cond) { pass++; log.push(`  PASS  ${name}`); }
  else { fail++; log.push(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

// 复刻 orchestrator 中 maybeWritePromotedMemory 的门控决策（不调 viking）
function decidePromotedMemoryWrite({ reflection, degraded, memoryMode = 'viking' }) {
  if (degraded) return { write: false, reason: 'degraded' };
  const promo = reflection?.memory_promotion;
  if (!promo?.should_promote) return { write: false, reason: 'should_promote_false' };
  if (!['semantic', 'procedural'].includes(promo.target_layer)) return { write: false, reason: 'invalid_layer' };
  if (!promo.content || promo.content.trim().length === 0) return { write: false, reason: 'empty_content' };
  if (memoryMode !== 'viking') return { write: false, reason: 'memory_mode_off' };
  return {
    write: true,
    layer: promo.target_layer,
    summary: encodeLayerSummary(promo.target_layer, promo.content.trim()),
  };
}

console.log('========== orchestrator: maybeWritePromotedMemory 门控 ==========');

// 1. 合规升级 → 应当写
{
  const r = normalizeReflection({
    memory_promotion: { should_promote: true, target_layer: 'semantic', content: '用户主玩 ADC 位', confidence: 0.85 },
  });
  const d = decidePromotedMemoryWrite({ reflection: r, degraded: false });
  assert('合规 semantic → 写入', d.write === true);
  assert('layer=semantic', d.layer === 'semantic');
  assert('summary 含 [L:semantic|', d.summary && d.summary.includes('[L:semantic|'));
  assert('summary 含 W:1（semantic 权重）', d.summary && /W:1(\.0)?\b/.test(d.summary));
  assert('summary 含原文', d.summary && d.summary.includes('用户主玩 ADC 位'));
}

// 2. 合规 procedural → 应当写
{
  const r = normalizeReflection({
    memory_promotion: { should_promote: true, target_layer: 'procedural', content: '讲解时先比喻后规则', confidence: 0.7 },
  });
  const d = decidePromotedMemoryWrite({ reflection: r, degraded: false });
  assert('合规 procedural → 写入', d.write === true);
  assert('layer=procedural', d.layer === 'procedural');
  assert('summary 含 W:0.6', d.summary && d.summary.includes('W:0.6'));
}

// 3. confidence 不足（normalize 已强制 should_promote=false）
{
  const r = normalizeReflection({
    memory_promotion: { should_promote: true, target_layer: 'semantic', content: '弱信号', confidence: 0.4 },
  });
  const d = decidePromotedMemoryWrite({ reflection: r, degraded: false });
  assert('confidence<0.6 → 不写', d.write === false);
  assert('reason=should_promote_false', d.reason === 'should_promote_false');
}

// 4. degraded 时不写
{
  const r = normalizeReflection({
    memory_promotion: { should_promote: true, target_layer: 'semantic', content: '降级仍尝试写', confidence: 0.9 },
  });
  const d = decidePromotedMemoryWrite({ reflection: r, degraded: true });
  assert('degraded → 不写', d.write === false);
  assert('reason=degraded', d.reason === 'degraded');
}

// 5. 非 viking 模式不写（避免 mock 模式时污染）
{
  const r = normalizeReflection({
    memory_promotion: { should_promote: true, target_layer: 'procedural', content: '不应写入', confidence: 0.8 },
  });
  const d = decidePromotedMemoryWrite({ reflection: r, degraded: false, memoryMode: 'mock' });
  assert('memoryMode=mock → 不写', d.write === false);
  assert('reason=memory_mode_off', d.reason === 'memory_mode_off');
}

// 6. target_layer=none 不写
{
  const r = normalizeReflection({
    memory_promotion: { should_promote: false, target_layer: 'none', content: '', confidence: 0 },
  });
  const d = decidePromotedMemoryWrite({ reflection: r, degraded: false });
  assert('target_layer=none → 不写', d.write === false);
}

// 7. 边界：promo 字段缺失（旧 reflection schema）
{
  const r = normalizeReflection({});
  const d = decidePromotedMemoryWrite({ reflection: r, degraded: false });
  assert('空 reflection → 不写', d.write === false);
  assert('不抛错', d.reason);
}

// 8. 与 episodic 解耦：should_followup=true 但 should_promote=false 时仍不写 promoted（episodic 由另一函数管）
{
  const r = normalizeReflection({
    this_turn: { should_followup: true },
    memory_promotion: { should_promote: false, target_layer: 'none', content: '', confidence: 0 },
  });
  const d = decidePromotedMemoryWrite({ reflection: r, degraded: false });
  assert('episodic 触发但 promotion 没触发 → 不写 promoted', d.write === false);
}

console.log(log.join('\n'));
console.log(`\n========== 总结 ==========`);
console.log(`Total: ${pass + fail}, Pass: ${pass}, Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
