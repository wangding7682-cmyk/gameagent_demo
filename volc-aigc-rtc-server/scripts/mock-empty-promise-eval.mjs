/**
 * 空头支票治理 mock 评测：subagentActivityService + reflector normalizeReflection
 *
 * 验证：
 *   1. detectPromises 能识别"整理...弹出""画一张""找视频"等承诺词
 *   2. recordTurnActivity 在「承诺 strategy/video 但未启动子 agent」时标记 is_empty_promise
 *   3. recordTurnActivity 在「承诺并启动了对应子 agent」时不标记
 *   4. recordTurnActivity 在「闲聊含糊承诺('帮你看看')但任何子 agent 未启动」时标记 vague
 *   5. normalizeReflection 在 ctx.subagent_activity.is_empty_promise=true 时强制：
 *      - quality_score 上限 0.5（即使模型给 0.9）
 *      - promise_keeping = 0
 *      - gaps 包含"空头支票"标签
 *   6. normalizeReflection 在 is_empty_promise=false 且模型未给 promise_keeping 时默认 1
 *   7. buildEmptyPromiseWarning 在最近无空头支票时返回空，存在时返回带类型的警示
 */

import {
  recordTurnActivity,
  getRecentActivity,
  buildEmptyPromiseWarning,
  __resetForTest,
  __INTERNAL,
} from '../src/services/subagentActivityService.js';
import { normalizeReflection } from '../src/services/reflectorAgentService.js';

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

console.log('\n[1] detectPromises：承诺词识别');
{
  const { detectPromises } = __INTERNAL;
  const r1 = detectPromises('我帮你整理亚索应对盲僧+辛德拉的知识卡，整理后弹出给你');
  assert('整理后弹出 → card', r1.card === true, JSON.stringify(r1));

  const r2 = detectPromises('我去帮你找个集锦视频');
  assert('找集锦/视频 → video', r2.video === true, JSON.stringify(r2));

  const r3 = detectPromises('我去帮你看看');
  assert('我去帮你看看 → vague', r3.vague === true, JSON.stringify(r3));

  const r4 = detectPromises('那你慢慢玩');
  assert('普通闲聊不应命中', r4.hits.length === 0, JSON.stringify(r4));

  const r5 = detectPromises('画一张防御塔位置图');
  assert('画一张 → card', r5.card === true, JSON.stringify(r5));
}

console.log('\n[2] 空头支票判定：strategy 承诺但子 agent 未启动');
{
  __resetForTest();
  const entry = recordTurnActivity({
    sessionId: 's1',
    turnId: 'turn_1',
    intent: 'smalltalk',
    mainSummary: '我帮你整理亚索应对盲僧的知识卡，整理后弹出给你',
    activatedSubagents: [],
    degraded: false,
  });
  assert('is_empty_promise=true', entry.is_empty_promise === true, JSON.stringify(entry));
  assert('empty_promises 含 card', entry.empty_promises.includes('card'), JSON.stringify(entry));
  assert('promises_detected 含 card', entry.promises_detected.includes('card'));
}

console.log('\n[3] 兑现：strategy 承诺且 strategy_agent 已启动');
{
  __resetForTest();
  const entry = recordTurnActivity({
    sessionId: 's2',
    turnId: 'turn_2',
    intent: 'strategy',
    mainSummary: '我帮你整理亚索应对盲僧的知识卡，整理后弹出给你',
    activatedSubagents: ['strategy_agent'],
    degraded: false,
  });
  assert('is_empty_promise=false', entry.is_empty_promise === false, JSON.stringify(entry));
  assert('empty_promises 为空', entry.empty_promises.length === 0);
}

console.log('\n[4] 闲聊含糊承诺 + 无子 agent → vague 标记');
{
  __resetForTest();
  const entry = recordTurnActivity({
    sessionId: 's3',
    turnId: 'turn_3',
    intent: 'smalltalk',
    mainSummary: '好嘞，我去帮你看看',
    activatedSubagents: [],
    degraded: false,
  });
  assert('vague 触发空头支票', entry.is_empty_promise === true && entry.empty_promises.includes('vague'), JSON.stringify(entry));
}

console.log('\n[5] 普通闲聊回复不应触发');
{
  __resetForTest();
  const entry = recordTurnActivity({
    sessionId: 's4',
    turnId: 'turn_4',
    intent: 'smalltalk',
    mainSummary: '哈哈那你尽管玩，开心最重要',
    activatedSubagents: [],
    degraded: false,
  });
  assert('无承诺词 → 不标记', entry.is_empty_promise === false, JSON.stringify(entry));
}

console.log('\n[6] normalizeReflection 在空头支票场景下强制扣分');
{
  const ctx = {
    subagent_activity: {
      this_turn: {
        is_empty_promise: true,
        empty_promises: ['card', 'strategy'],
      },
    },
  };
  const raw = {
    this_turn: {
      quality_score: 0.9, // 模型自信地给 0.9
      intent_match: true,
      completeness: 0.9,
      promise_keeping: 0.9, // 模型不老实
      gaps: [],
      should_followup: false,
    },
  };
  const out = normalizeReflection(raw, ctx);
  assert('quality_score 被夹到 ≤0.5', out.this_turn.quality_score <= 0.5, `got=${out.this_turn.quality_score}`);
  assert('promise_keeping 被强制 0', out.this_turn.promise_keeping === 0, `got=${out.this_turn.promise_keeping}`);
  assert('gaps 包含空头支票标签', out.this_turn.gaps.some((x) => x.includes('空头支票')), JSON.stringify(out.this_turn.gaps));
}

console.log('\n[7] normalizeReflection 正常场景 promise_keeping 默认 1');
{
  const ctx = { subagent_activity: { this_turn: { is_empty_promise: false } } };
  const raw = { this_turn: { quality_score: 0.8 } };
  const out = normalizeReflection(raw, ctx);
  assert('promise_keeping 默认 1', out.this_turn.promise_keeping === 1, `got=${out.this_turn.promise_keeping}`);
  assert('quality_score 不被夹', out.this_turn.quality_score === 0.8);
}

console.log('\n[8] buildEmptyPromiseWarning：空与非空');
{
  __resetForTest();
  assert('空账本 → 空字符串', buildEmptyPromiseWarning('s5') === '');
  recordTurnActivity({
    sessionId: 's5',
    turnId: 'turn_5',
    intent: 'smalltalk',
    mainSummary: '我帮你整理亚索的知识卡，整理后弹出',
    activatedSubagents: [],
  });
  const w = buildEmptyPromiseWarning('s5');
  assert('warning 非空且含 card', w.includes('card'), w);
  assert('warning 含上轮空头支票字眼', w.includes('上轮空头支票'), w);
}

console.log('\n[9] getRecentActivity：保留近 N 轮且按时间正序');
{
  __resetForTest();
  for (let i = 0; i < 5; i++) {
    recordTurnActivity({
      sessionId: 's6',
      turnId: `turn_${i}`,
      intent: 'smalltalk',
      mainSummary: 'hi',
      activatedSubagents: [],
    });
  }
  const recent = getRecentActivity('s6', 3);
  assert('返回 3 条', recent.length === 3);
  assert('时间正序末尾是 turn_4', recent[recent.length - 1].turn_id === 'turn_4', JSON.stringify(recent.map(x=>x.turn_id)));
}

console.log(`\n=== Total: pass=${pass} fail=${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
