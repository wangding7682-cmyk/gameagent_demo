#!/usr/bin/env node
/**
 * P4 Task Planner mock 评测
 *
 * 不调 LLM，纯算法验证：
 *   1. smalltalk → 空 plan
 *   2. 单 intent (strategy/video) → 单元素 plan，priority=high
 *   3. 复合意图 "战术+视频" → 拆 2 个 task
 *   4. 边界：unknown / 空 query
 */

import { planTasks, __INTERNAL } from '../src/services/taskPlannerService.js';

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

console.log('\n[1] smalltalk / unknown → 空 plan');
expect('smalltalk_empty_plan',
  planTasks({ user_query: '今天好烦', main_intent: 'smalltalk' }).task_plan.length, 0);
expect('unknown_empty_plan',
  planTasks({ user_query: '随便聊聊', main_intent: 'unknown' }).task_plan.length, 0);
expect('empty_intent_empty_plan',
  planTasks({ user_query: 'xxx', main_intent: '' }).task_plan.length, 0);

console.log('\n[2] 单意图 strategy → 1 个高优 strategy task');
const r1 = planTasks({
  user_query: '盲僧前期反野怎么打',
  main_intent: 'strategy',
  main_reply: { strategy_query: '盲僧 前期 反野' },
});
expect('single_strategy_count', r1.task_plan.length, 1);
expect('single_strategy_tool', r1.task_plan[0].tool, 'strategy');
expect('single_strategy_priority', r1.task_plan[0].priority, 'high');
expect('single_strategy_query_uses_main_reply', r1.task_plan[0].query, '盲僧 前期 反野');
expect('single_strategy_mode', r1.mode, 'single');

console.log('\n[3] 单意图 video → 1 个高优 video task');
const r2 = planTasks({
  user_query: '看看亚索极限操作',
  main_intent: 'video',
  main_reply: { video_query_seed: '亚索 极限操作 集锦' },
});
expect('single_video_count', r2.task_plan.length, 1);
expect('single_video_tool', r2.task_plan[0].tool, 'video');
expect('single_video_query', r2.task_plan[0].query, '亚索 极限操作 集锦');

console.log('\n[4] 复合意图 战术+视频 → 拆 2 个 task');
const r3 = planTasks({
  user_query: '盲僧打豹女怎么打，顺便看个集锦',
  main_intent: 'strategy',
});
console.log(`  实际 plan:`, JSON.stringify(r3.task_plan));
expect('compound_count', r3.task_plan.length, 2);
expect('compound_tools',
  r3.task_plan.map((t) => t.tool).sort(), ['strategy', 'video']);
expect('compound_mode', r3.mode, 'compound');
expect('compound_reason_starts_with_pattern', r3.reason.startsWith('pattern:'), true);

const stratTask = r3.task_plan.find((t) => t.tool === 'strategy');
const videoTask = r3.task_plan.find((t) => t.tool === 'video');
expect('compound_strategy_priority_high', stratTask.priority, 'high');
expect('compound_video_priority_normal', videoTask.priority, 'normal');
expect('compound_strategy_query_no_video_terms',
  /(视频|集锦|教学)/.test(stratTask.query), false);
expect('compound_video_query_has_topic',
  videoTask.query.includes('盲僧') || videoTask.query.includes('豹女') || videoTask.query.includes('集锦'),
  true);

console.log('\n[5] 复合意图 主意图为 video');
const r4 = planTasks({
  user_query: '想看亚索集锦，顺便讲讲怎么对线',
  main_intent: 'video',
});
console.log(`  实际 plan:`, JSON.stringify(r4.task_plan));
expect('compound_video_first_count', r4.task_plan.length, 2);
const vt = r4.task_plan.find((t) => t.tool === 'video');
const st = r4.task_plan.find((t) => t.tool === 'strategy');
expect('main_video_video_priority_high', vt.priority, 'high');
expect('main_video_strategy_priority_normal', st.priority, 'normal');

console.log('\n[6] 边界：复合 pattern 不匹配 → 退回单任务');
const r5 = planTasks({
  user_query: '想了解盲僧出装',
  main_intent: 'strategy',
});
expect('non_compound_falls_back_single', r5.task_plan.length, 1);
expect('non_compound_mode_single', r5.mode, 'single');

console.log('\n========== 总结 ==========');
console.log(`PASS ${pass}  FAIL ${fail}`);
if (fail > 0) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  - ${f.name}`));
  process.exit(1);
}
