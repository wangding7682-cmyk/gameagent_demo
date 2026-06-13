/**
 * P3 mock 评测：sessionGoalTrackerService.mergeSessionGoal
 *
 * 验证：
 *   - primary_goal 频次胜出（多轮投票）
 *   - covered/uncovered 集合去重 + 双向移动
 *   - turn_count 累积
 *   - 输入异常时不崩溃
 */

import { mergeSessionGoal } from '../src/services/sessionGoalTrackerService.js';

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

console.log('\n[1] 单轮 merge：空 prev + 完整 inference');
{
  const r = mergeSessionGoal({}, {
    primary_goal: '上分到铂金',
    covered: ['学盲僧打野'],
    uncovered: ['学辅助', '团战站位'],
  });
  assert('primary_goal_set', r.primary_goal === '上分到铂金');
  assert('covered_set', JSON.stringify(r.covered) === JSON.stringify(['学盲僧打野']));
  assert('uncovered_set', JSON.stringify(r.uncovered) === JSON.stringify(['学辅助', '团战站位']));
  assert('turn_count_1', r.turn_count === 1);
  assert('vote_recorded', r.primary_goal_votes['上分到铂金'] === 1);
}

console.log('\n[2] 多轮 primary_goal 投票胜出（避免单次抖动）');
{
  let goal = {};
  goal = mergeSessionGoal(goal, { primary_goal: '上分' });
  goal = mergeSessionGoal(goal, { primary_goal: '上分' });
  goal = mergeSessionGoal(goal, { primary_goal: '娱乐' });
  assert('vote_winner_kept', goal.primary_goal === '上分', `actual: ${goal.primary_goal}`);
  assert('vote_count_correct', goal.primary_goal_votes['上分'] === 2);
  assert('vote_loser_kept', goal.primary_goal_votes['娱乐'] === 1);
  assert('turn_count_3', goal.turn_count === 3);
}

console.log('\n[3] uncovered → covered 移动');
{
  let goal = mergeSessionGoal({}, {
    primary_goal: '学打野',
    uncovered: ['学盲僧', '学豹女'],
  });
  goal = mergeSessionGoal(goal, {
    primary_goal: '学打野',
    covered: ['学盲僧'],
  });
  assert('covered_added', goal.covered.includes('学盲僧'));
  assert('uncovered_removed', !goal.uncovered.includes('学盲僧'), `uncovered: ${JSON.stringify(goal.uncovered)}`);
  assert('uncovered_keep_other', goal.uncovered.includes('学豹女'));
}

console.log('\n[4] covered/uncovered 去重');
{
  let goal = mergeSessionGoal({}, { covered: ['A', 'A', 'B'] });
  goal = mergeSessionGoal(goal, { covered: ['B', 'C'] });
  assert('covered_dedup', JSON.stringify([...new Set(goal.covered)].sort()) === JSON.stringify(['A', 'B', 'C']));
}

console.log('\n[5] 异常输入：null / 非对象 / 空字段');
{
  const r1 = mergeSessionGoal(null, null);
  assert('null_input_no_crash', typeof r1 === 'object' && r1.turn_count === 1);
  const r2 = mergeSessionGoal({}, { primary_goal: '', covered: 'not_array', uncovered: null });
  assert('invalid_arrays_handled', Array.isArray(r2.covered) && r2.covered.length === 0);
  assert('empty_primary_goal', r2.primary_goal === '');
}

console.log('\n[6] long input 截断');
{
  const longStr = 'x'.repeat(100);
  const r = mergeSessionGoal({}, { primary_goal: longStr, covered: [longStr] });
  assert('primary_goal_truncated', r.primary_goal.length === 30);
  assert('covered_item_truncated', r.covered[0].length === 30);
}

console.log('\n========== 总结 ==========');
console.log(`PASS ${pass}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
