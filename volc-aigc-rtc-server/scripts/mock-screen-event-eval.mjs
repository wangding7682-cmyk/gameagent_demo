/**
 * P5 mock 评测：screenEventService
 *
 * 验证：
 *   - normalizeFrameSnapshot：scene/events/hp_pct 等字段约束
 *   - normalizeGameEvent：丢弃未知 type
 *   - shouldEmitProactive：冷却 + confidence 门槛
 *   - processFrame：高优先级胜出 + 冷却生效 + 状态写入
 *
 * 不依赖真实 LLM，只验证算法层。
 */

import {
  GAME_EVENT_TYPES,
  normalizeFrameSnapshot,
  normalizeGameEvent,
  shouldEmitProactive,
  processFrame,
} from '../src/services/screenEventService.js';
import { clearAgentSessionState, getAgentSessionState } from '../src/services/agentSessionStateService.js';

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

console.log('\n[1] normalizeGameEvent：白名单过滤 + clamp confidence');
{
  const ok = normalizeGameEvent({ type: 'low_hp_warning', confidence: 0.92, target: 'self' });
  assert('valid_event_kept', ok && ok.type === 'low_hp_warning');
  assert('priority_set', ok.priority === 'high');
  assert('confidence_kept', ok.confidence === 0.92);

  const bad = normalizeGameEvent({ type: 'unknown_type', confidence: 0.9 });
  assert('unknown_type_dropped', bad === null);

  const overflow = normalizeGameEvent({ type: 'ult_ready', confidence: 1.5 });
  assert('confidence_clamped_to_1', overflow.confidence === 1);

  const negative = normalizeGameEvent({ type: 'ult_ready', confidence: -0.3 });
  assert('confidence_clamped_to_0', negative.confidence === 0);
}

console.log('\n[2] normalizeFrameSnapshot：scene/hp_pct/events');
{
  const f = normalizeFrameSnapshot({
    game: 'LoL',
    scene: 'in_game',
    hp_pct: 0.18,
    ult_ready: true,
    events: [
      { type: 'low_hp_warning', confidence: 0.95 },
      { type: 'ult_ready', confidence: 0.88 },
      { type: 'unknown_type' },
    ],
  });
  assert('game_normalized', f.game === 'lol');
  assert('scene_kept', f.scene === 'in_game');
  assert('hp_pct_kept', f.hp_pct === 0.18);
  assert('ult_ready_bool', f.ult_ready === true);
  assert('events_count_2', f.events.length === 2);

  const empty = normalizeFrameSnapshot({});
  assert('empty_game_unknown', empty.game === 'unknown');
  assert('empty_scene_unknown', empty.scene === 'unknown');
  assert('empty_events_array', Array.isArray(empty.events) && empty.events.length === 0);
}

console.log('\n[3] shouldEmitProactive：冷却 + confidence 门槛');
{
  const ev = { type: 'low_hp_warning', confidence: 0.9 };
  const now = 1000000;
  const r1 = shouldEmitProactive({ event: ev, lastEmittedMap: {}, now });
  assert('first_time_allow', r1.allow === true);

  const r2 = shouldEmitProactive({
    event: ev,
    lastEmittedMap: { low_hp_warning: now - 2000 },
    now,
  });
  assert('within_cooldown_blocked', r2.allow === false && r2.reason === 'cooldown');
  assert('cooldown_left_calculated', r2.cooldown_left_ms === GAME_EVENT_TYPES.low_hp_warning.cooldown_ms - 2000);

  const r3 = shouldEmitProactive({
    event: ev,
    lastEmittedMap: { low_hp_warning: now - 30000 },
    now,
  });
  assert('cooldown_expired_allow', r3.allow === true);

  const r4 = shouldEmitProactive({
    event: { type: 'low_hp_warning', confidence: 0.3 },
    lastEmittedMap: {},
    now,
  });
  assert('low_confidence_blocked', r4.allow === false && r4.reason === 'low_confidence');
}

console.log('\n[4] processFrame：高优先级胜出 + 状态写入');
{
  const sid = 'test_session_p5_a';
  clearAgentSessionState(sid);
  const r = processFrame({
    rawFrame: {
      game: 'lol',
      scene: 'in_game',
      hp_pct: 0.15,
      events: [
        { type: 'ult_ready', confidence: 0.9 },
        { type: 'low_hp_warning', confidence: 0.85 },
      ],
    },
    sessionId: sid,
  });
  assert('high_priority_picked', r.picked?.type === 'low_hp_warning');
  assert('cue_generated', typeof r.cue === 'string' && r.cue.length > 0);
  assert('emit_allowed', r.allowed === true);
  const state = getAgentSessionState(sid);
  assert('state_written', state?.dynamic_context?.screen_event_state?.last_emitted?.low_hp_warning > 0);
  clearAgentSessionState(sid);
}

console.log('\n[5] processFrame：连续两帧 → 第二帧被冷却');
{
  const sid = 'test_session_p5_b';
  clearAgentSessionState(sid);
  const baseFrame = {
    game: 'lol',
    scene: 'in_game',
    events: [{ type: 'low_hp_warning', confidence: 0.9 }],
  };
  const t0 = Date.now();
  const r1 = processFrame({ rawFrame: baseFrame, sessionId: sid, now: t0 });
  const r2 = processFrame({ rawFrame: baseFrame, sessionId: sid, now: t0 + 1000 });
  assert('first_emit_allowed', r1.allowed === true);
  assert('second_emit_blocked_by_cooldown', r2.allowed === false && r2.allowed_reason === 'cooldown');
  clearAgentSessionState(sid);
}

console.log('\n[6] processFrame：scene !== in_game → 不发事件');
{
  const sid = 'test_session_p5_c';
  clearAgentSessionState(sid);
  const r = processFrame({
    rawFrame: {
      game: 'lol',
      scene: 'in_lobby',
      events: [{ type: 'low_hp_warning', confidence: 0.95 }],
    },
    sessionId: sid,
  });
  assert('out_of_game_no_pick', r.picked === null);
  assert('out_of_game_not_allowed', r.allowed === false);
  clearAgentSessionState(sid);
}

console.log('\n[7] processFrame：HoK 兼容（统一 type 命名）');
{
  const sid = 'test_session_p5_d';
  clearAgentSessionState(sid);
  const r = processFrame({
    rawFrame: {
      game: 'hok',
      scene: 'in_game',
      hp_pct: 0.12,
      events: [{ type: 'ganked', confidence: 0.92, target: 'self' }],
    },
    sessionId: sid,
  });
  assert('hok_game_kept', r.frame.game === 'hok');
  assert('ganked_picked', r.picked?.type === 'ganked');
  assert('ganked_cue_emitted', r.cue.length > 0);
  clearAgentSessionState(sid);
}

console.log('\n========== 总结 ==========');
console.log(`PASS ${pass}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
