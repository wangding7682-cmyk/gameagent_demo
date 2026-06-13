import { buildAgentContext } from './agentContextService.js';
import { buildLocalRouteHint, shouldGenerateStrategyImage, buildVideoSearchSeed, runInteractionAgent, fallbackForIntent } from './interactionAgentService.js';
import { runStrategyAgent } from './strategyAgentService.js';
import { runVideoAgent } from './videoAgentService.js';
import { appendAgentSessionTurn, getAgentSessionState, upsertAgentDynamicContext } from './agentSessionStateService.js';
import { appendAgentTrace } from './agentTraceLoggerService.js';
import { triggerMemoryWriterForTurn } from './memoryWriterService.js';
import { intentPool, taskStore } from './taskFsmService.js';
import { trimVideoData } from './outputTrimmerService.js';
import { detectRequestPriority, resolvePoolPriority } from './priorityDetectorService.js';
import { runReflector } from './reflectorAgentService.js';
import { appendReflectionLog } from './reflectionLoggerService.js';
import { encodeLayerSummary } from './memoryLayerService.js';
import { vikingAddEvent } from './volcVikingMemoryService.js';
import { config } from '../config.js';
import { planTasks } from './taskPlannerService.js';
import { updateSessionGoalFromReflection } from './sessionGoalTrackerService.js';
import { withRetry, rewriteFailedQuery, isRetryableError } from './retryHelperService.js';
import { recordTurnActivity, getRecentActivity, buildEmptyPromiseWarning } from './subagentActivityService.js';
import { syncRtcProjectionForSession } from './rtcProjectionSyncService.js';
import { buildReflectorBriefHint } from './reflectorProjectionAdapter.js';
import { buildActiveBranchContext } from './rtcTaskEngagementService.js';

/**
 * 【任务编排 / 总调度】agentOrchestratorService
 *
 * 通俗职责：每轮对话的"总指挥"。先装配 context（agentContextService），再让主脑
 * 出意图、TaskPlanner 拆任务，按 single/compound 模式串/并行调用 strategy / video
 * 子 agent，最后旁路触发 Reflector + 写记忆。所有路径上的 SSE 事件由这里发。
 */

function createTurnId() {
  return `turn_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function buildRtcTopicFromIntent(intent = '', stickyHero = '') {
  if (intent === 'video') {
    return `${stickyHero || '当前'}视频检索`.replace(/^当前/, '');
  }
  if (intent === 'strategy') {
    return `${stickyHero || '当前英雄'}玩法建议`;
  }
  if (intent === 'smalltalk') {
    return stickyHero ? `${stickyHero}话题延续` : '当前对话延续';
  }
  return stickyHero ? `${stickyHero}当前话题` : '当前话题';
}

function buildRtcNeedLabel(intent = '', stickyHero = '') {
  if (intent === 'video') {
    return `需要补充${stickyHero || '相关'}视频/链接`;
  }
  if (intent === 'strategy') {
    return `需要给${stickyHero || '当前英雄'}玩法建议`;
  }
  return '';
}

function trimBranchHint(value = '', maxLength = 32) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function buildBranchHint(intent = '', context = {}, state = {}, stickyHero = '') {
  if (intent === 'video') {
    return trimBranchHint(
      state?.video_query ||
      state?.video_data?.title ||
      `${stickyHero || ''}${context?.userQueryResolved || context?.userQuery || ''}`.trim()
    );
  }
  if (intent === 'strategy') {
    return trimBranchHint(
      state?.tactic_data?.title ||
      `${stickyHero || ''}${context?.userQueryResolved || context?.userQuery || ''}`.trim()
    );
  }
  return '';
}

function normalizeTaskEngagementState(value = '') {
  const state = String(value || '').trim().toLowerCase();
  if (['active', 'paused', 'cancelled', 'light_chat', 'resumable'].includes(state)) {
    return state;
  }
  return 'active';
}

function shouldSkipBranchPersistence(sessionState = null) {
  const dynamicContext = sessionState?.dynamic_context || {};
  const engagementState = normalizeTaskEngagementState(dynamicContext?.task_engagement_state);
  return engagementState === 'paused' || engagementState === 'cancelled' || engagementState === 'light_chat';
}

function shouldUseLocalVideoFastPath(userQuery = '', hintIntent = '') {
  if (hintIntent !== 'video') return false;
  const text = String(userQuery || '');
  if (/(弹窗|窗口|卡片|转圈|加载|不弹|不显示|页面已无|打不开|报错|错误|日志|任务)/.test(text)) {
    return false;
  }
  const hasStrategyAsk = /(怎么打|怎么练|怎么帮|怎么对|怎么入侵|怎么应对|对线|出装|克制|阵容|打法|攻略|技巧|战术|兵线处理)/.test(text);
  const hasNewTopicConnector = /(另外|还有|顺便|同时|此外|对了|哦对了|再)/.test(text);
  if (hasStrategyAsk || hasNewTopicConnector) {
    return false;
  }
  return /(视频示例|给我看|帮我找|找个|搜个|推荐).{0,20}(视频|集锦|高光|精彩操作|操作集锦|示范|演示)/.test(text)
    || /(视频|集锦|高光|精彩操作|操作集锦|B站|b站|抖音)/.test(text);
}

function withPlaceholderCommit(routeHint = {}, commit = false) {
  return {
    intent: routeHint.intent || 'smalltalk',
    hint_confidence: Number(routeHint.hint_confidence ?? 0) || 0,
    placeholder_type: commit ? 'asset' : (routeHint.placeholder_type || 'soft'),
    ui_commit: commit === true,
    reason: routeHint.reason || '',
  };
}

function persistActiveBranchState({ context = {}, state = {}, intent = '', stickyHero = '' } = {}) {
  if (!context?.sessionId || !intent || intent === 'smalltalk') {
    return null;
  }
  const branchHint = buildBranchHint(intent, context, state, stickyHero);
  if (!branchHint) {
    return null;
  }
  const sessionState = getAgentSessionState(context.sessionId);
  // A later RTC control turn may already have paused/cancelled the branch.
  // In that case, keep the resumable hint but do not revive the branch to active.
  if (shouldSkipBranchPersistence(sessionState)) {
    return upsertAgentDynamicContext(context.sessionId, {
      last_resumable_branch: branchHint,
      last_resumable_branch_type: intent,
    });
  }
  return upsertAgentDynamicContext(
    context.sessionId,
    buildActiveBranchContext({
      intent,
      stickyHero,
      branchHint,
      previousDynamicContext: sessionState?.dynamic_context || {},
    })
  );
}

function resolvePlaceholderRoute(context = {}) {
  const userQuery = String(context?.userQueryResolved || context?.userQuery || '').trim();
  const routeHint = buildLocalRouteHint(userQuery);
  if (routeHint.intent !== 'smalltalk') {
    return routeHint;
  }

  const recentTurns = Array.isArray(context?.shortMemory?.recent_turns) ? context.shortMemory.recent_turns : [];
  const latestTurn = [...recentTurns].reverse().find((turn) => String(turn?.intent || '').trim());
  const latestIntent = String(latestTurn?.intent || '').trim();
  const text = userQuery;
  const hasVideoCue = /(视频|链接|集锦|高光|录像|教程|教学)/.test(text);
  const hasVideoFollowupCue = /(那个|那条|这条|上次|刚才|之前|还没|怎么还没|没发|在哪|在哪儿|呢)/.test(text);
  const isFreshTopicQuestion = /(我想问|问一下|这个英雄|那个英雄|你熟悉|你了解|熟悉吗|了解吗)/.test(text);
  // 判断是否"请求战术建议"——必须有明确的请求动作（帮我/教我/怎么/如何），而不能只是术语出现
  const hasExplicitStrategyAsk = /(怎么打|怎么练|怎么帮|怎么对|怎么入侵|怎么应对|怎么反|帮我|教我|给我.*建议|推荐.*打法|指点)/.test(text);
  // 确认类语句（只是评价/确认，不触发 strategy）：包含"好不好/对不对/是不是/时机/打法"等，但前面没有请求动词
  const isConfirmingStatement = /^(.*?)(好不好|对不对|是不是|行不行|可以吧|是吧|不错|很好|厉害|牛|稳)/.test(text);

  if (latestIntent === 'video' && (hasVideoCue || (hasVideoFollowupCue && !isFreshTopicQuestion))) {
    return {
      intent: 'video',
      hint_confidence: 0.74,
      placeholder_type: 'soft',
      ui_commit: false,
      reason: 'recent_video_followup_hint',
    };
  }
  // 只有明确追问战术细节（包含请求动词）才 fallback 到 strategy
  // 单纯的术语出现或确认语句不应该触发 strategy
  if (latestIntent === 'strategy' && hasExplicitStrategyAsk && !isConfirmingStatement) {
    return {
      intent: 'strategy',
      hint_confidence: 0.72,
      placeholder_type: 'soft',
      ui_commit: false,
      reason: 'recent_strategy_followup_hint',
    };
  }

  return routeHint;
}

function logOrchestrator(message, data = {}) {
  console.log(`[AgentOrchestrator] ${message}`, {
    at: nowIso(),
    ...data,
  });
}

function sleep(ms = 0) {
  const delay = Math.max(0, Number(ms) || 0);
  return delay > 0 ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

function triggerAsyncMemoryWrite(context, state, traceOutput = {}, turnId = '') {
  if (!context?.userId || !turnId || !state?.intent || state.intent === 'unknown') {
    return;
  }
  triggerMemoryWriterForTurn({
    taskId: state.task_id,
    turnId,
    sessionId: context.sessionId,
    userId: context.userId,
    source: context.source,
    intent: state.intent,
    userQuery: context.userQuery,
    mainSummary: state.main_summary,
    routeReason: state.route_reason,
    traceOutput,
    ragSummary: context.rag?.summary || '',
    shortMemorySummary: context.shortMemory?.summary || '',
    stickyHero: context.stickyHero || null,
  });
}

/**
 * P1 分层记忆：Reflector 判定 should_followup=true 时，把本轮事件写入 episodic 层。
 * 失败仅打日志，不抛错。
 */
function maybeWriteEpisodicMemory({ context, state, turnId, sessionId, reflection, degraded }) {
  try {
    if (degraded) return;
    if (!reflection?.this_turn?.should_followup) return;
    if (config.memory.mode !== 'viking') return;
    const userId = context?.userId || 'default';
    const userQuery = context?.userQuery || '';
    const mainSummary = state?.main_summary || '';
    const intent = state?.intent || 'unknown';
    const gaps = Array.isArray(reflection.this_turn?.gaps) ? reflection.this_turn.gaps : [];
    const rawSummary = `[event] ${userQuery} | ${intent} | ${mainSummary}${gaps.length ? ` | gaps: ${gaps.join('；')}` : ''}`;
    const layeredSummary = encodeLayerSummary('episodic', rawSummary);
    const messages = [
      { role: 'user', content: userQuery },
      { role: 'assistant', content: mainSummary },
    ].filter((m) => m.content);

    setImmediate(() => {
      vikingAddEvent({
        messages,
        summary: layeredSummary,
        user_id: userId,
        assistant_id: 'game_ai_agent',
        conversation_id: sessionId,
        group_id: sessionId,
      })
        .then((res) => {
          logOrchestrator('episodic_memory_written', {
            turn_id: turnId,
            event_id: res?.data?.event_id || null,
            ok: res?.code === 0,
          });
        })
        .catch((err) => {
          logOrchestrator('episodic_memory_failed', { turn_id: turnId, error: err?.message });
        });
    });
  } catch (err) {
    logOrchestrator('episodic_memory_dispatch_failed', { turn_id: turnId, error: err?.message });
  }
}

/**
 * P1.6 记忆升级：Reflector 判定 memory_promotion.should_promote=true 时，
 * 把"用户长期偏好/事实"或"互动套路"写入 semantic / procedural 层。
 * 跟 episodic 写入互斥：semantic/procedural 写入用 memory_promotion.content（精炼后的句子），
 * 而 episodic 走原始 turn 摘要。
 * 失败仅打日志，不抛错。
 */
function maybeWritePromotedMemory({ context, turnId, sessionId, reflection, degraded }) {
  try {
    if (degraded) return;
    const promo = reflection?.memory_promotion;
    if (!promo?.should_promote) return;
    if (!['semantic', 'procedural'].includes(promo.target_layer)) return;
    if (!promo.content || promo.content.trim().length === 0) return;
    if (config.memory.mode !== 'viking') return;

    const userId = context?.userId || 'default';
    const userQuery = context?.userQuery || '';
    const layeredSummary = encodeLayerSummary(promo.target_layer, promo.content.trim());
    const messages = [
      { role: 'user', content: userQuery || promo.content.trim() },
    ];

    setImmediate(() => {
      vikingAddEvent({
        messages,
        summary: layeredSummary,
        user_id: userId,
        assistant_id: 'game_ai_agent',
        conversation_id: sessionId,
        group_id: sessionId,
      })
        .then((res) => {
          logOrchestrator('promoted_memory_written', {
            turn_id: turnId,
            target_layer: promo.target_layer,
            confidence: promo.confidence,
            content_preview: promo.content.slice(0, 30),
            event_id: res?.data?.event_id || null,
            ok: res?.code === 0,
          });
        })
        .catch((err) => {
          logOrchestrator('promoted_memory_failed', {
            turn_id: turnId,
            target_layer: promo.target_layer,
            error: err?.message,
          });
        });
    });
  } catch (err) {
    logOrchestrator('promoted_memory_dispatch_failed', { turn_id: turnId, error: err?.message });
  }
}

/**
 * P0 Reflector 旁路触发：fire-and-forget。
 * 严格不 await、不抛出、不影响主链路。
 * smalltalk 走精简模式（仅 memory_promotion），strategy/video 走完整反思。
 */
function triggerReflectorAsync({ context, state, branchOutput = {}, turnId, emitEvent = () => {} }) {
  if (!turnId || !state?.intent || state.intent === 'unknown') {
    if (turnId) {
      try {
        appendAgentTrace({
          session_id: context?.sessionId || 'default',
          turn_id: turnId,
          task_id: state?.task_id || null,
          stage: 'reflector_skipped',
          source: 'orchestrator',
          data: { reason: !state?.intent || state.intent === 'unknown' ? 'intent_unknown' : 'no_turn_id' },
        });
      } catch (_) {}
    }
    return;
  }
  const sessionId = context?.sessionId || 'default';
  let sessionHistory = [];
  try {
    const sessionState = getAgentSessionState(sessionId);
    sessionHistory = Array.isArray(sessionState?.recent_turns) ? sessionState.recent_turns : [];
  } catch (_) {
    sessionHistory = [];
  }

  const input = {
    user_query: context?.userQuery || '',
    intent: state.intent,
    main_summary: state.main_summary || '',
    branch_output: branchOutput,
    session_history: sessionHistory,
    lite_mode: state.intent === 'smalltalk',
    sticky_hero: context?.stickyHero || null,
  };

  // ===== 子 agent 活动账本（A）=====
  // 在 Reflector 入口前先记录"承诺 vs 启动"，并把结果挂到 input.subagent_activity
  // 给 Reflector 评 promise_keeping 用。同时通过 SSE 给前端一份审计快照。
  let activityEntry = null;
  try {
    const activated = Array.isArray(branchOutput?.activated_subagents)
      ? branchOutput.activated_subagents
      : [];
    activityEntry = recordTurnActivity({
      sessionId,
      turnId,
      intent: state.intent,
      mainSummary: state.main_summary || '',
      activatedSubagents: activated,
      degraded: Boolean(branchOutput?.degraded || state?.degraded),
    });
    input.subagent_activity = {
      this_turn: activityEntry,
      recent: getRecentActivity(sessionId, 3),
    };
    if (activityEntry?.is_empty_promise) {
      logOrchestrator('empty_promise_detected', {
        turn_id: turnId,
        empty_promises: activityEntry.empty_promises,
        promises_detected: activityEntry.promises_detected,
        activated_subagents: activityEntry.activated_subagents,
      });
      try {
        appendAgentTrace({
          session_id: sessionId,
          turn_id: turnId,
          task_id: state?.task_id || null,
          stage: 'empty_promise_detected',
          source: 'orchestrator',
          data: activityEntry,
        });
      } catch (_) {}
      try {
        emitEvent('subagent_activity', {
          ...activityEntry,
          warning_text: buildEmptyPromiseWarning(sessionId),
        });
      } catch (_) {}
    }
  } catch (activityErr) {
    logOrchestrator('subagent_activity_record_failed', {
      turn_id: turnId,
      error: activityErr?.message,
    });
  }

  // 在 trace 时间线上落一条派发摘要，方便用 turn_id 一眼看到 Reflector 是否启动
  try {
    appendAgentTrace({
      session_id: sessionId,
      turn_id: turnId,
      task_id: state?.task_id || null,
      stage: 'reflector_dispatched',
      source: 'orchestrator',
      data: {
        intent: input.intent,
        lite_mode: input.lite_mode,
        history_len: sessionHistory.length,
      },
    });
  } catch (_) {}

  setImmediate(() => {
    runReflector(input)
      .then((result) => {
        try {
          appendReflectionLog({
            turn_id: turnId,
            session_id: sessionId,
            source: context?.source || 'unknown',
            user_query: input.user_query,
            intent: input.intent,
            main_summary: input.main_summary,
            branch_output: branchOutput,
            reflection: result.reflection,
            latency_ms: result.latency_ms,
            degraded: result.degraded,
            error: result.error,
          });
          logOrchestrator('reflector_done', {
            turn_id: turnId,
            intent: input.intent,
            quality_score: result.reflection?.this_turn?.quality_score,
            should_followup: result.reflection?.this_turn?.should_followup,
            should_initiate: result.reflection?.proactive?.should_initiate,
            latency_ms: result.latency_ms,
            degraded: result.degraded,
          });
          // 同步把 Reflector 摘要写到 trace 时间线上，便于按 turn_id 串联
          try {
            const promo = result.reflection?.memory_promotion;
            appendAgentTrace({
              session_id: sessionId,
              turn_id: turnId,
              task_id: state?.task_id || null,
              stage: 'reflector_done',
              source: 'orchestrator',
              data: {
                intent: input.intent,
                quality_score: result.reflection?.this_turn?.quality_score,
                should_followup: result.reflection?.this_turn?.should_followup,
                should_initiate: result.reflection?.proactive?.should_initiate,
                memory_promotion: promo ? {
                  should_promote: promo.should_promote,
                  target_layer: promo.target_layer,
                  confidence: promo.confidence,
                } : null,
                latency_ms: result.latency_ms,
                degraded: result.degraded,
              },
            });
          } catch (_) {}
          maybeWriteEpisodicMemory({ context, state, turnId, sessionId, reflection: result.reflection, degraded: result.degraded });
          maybeWritePromotedMemory({ context, turnId, sessionId, reflection: result.reflection, degraded: result.degraded });
          try {
            const proactive = result.reflection?.proactive;
            if (!result.degraded && proactive?.should_initiate && proactive?.bridge_question && proactive.confidence >= 0.5) {
              emitEvent('proactive_cue', {
                turn_id: turnId,
                session_id: sessionId,
                source: 'reflector',
                bridge_question: proactive.bridge_question,
                trigger_after_idle_ms: proactive.trigger_after_idle_ms,
                confidence: proactive.confidence,
                predicted_intents: result.reflection?.next_turn_hint?.predicted_intents || [],
              });
              logOrchestrator('proactive_cue_emitted', {
                turn_id: turnId,
                bridge_question: proactive.bridge_question,
                trigger_after_idle_ms: proactive.trigger_after_idle_ms,
                confidence: proactive.confidence,
              });
            }
          } catch (cueErr) {
            logOrchestrator('proactive_cue_emit_failed', {
              turn_id: turnId,
              error: cueErr?.message,
            });
          }
          try {
            const merged = updateSessionGoalFromReflection({
              sessionId,
              reflection: result.reflection,
              degraded: result.degraded,
            });
            if (merged) {
              logOrchestrator('session_goal_updated', {
                turn_id: turnId,
                session_id: sessionId,
                primary_goal: merged.primary_goal,
                covered_count: merged.covered?.length || 0,
                uncovered_count: merged.uncovered?.length || 0,
                turn_count: merged.turn_count,
              });
            }
          } catch (goalErr) {
            logOrchestrator('session_goal_update_failed', {
              turn_id: turnId,
              error: goalErr?.message,
            });
          }
          try {
            const reflectorBriefHint = buildReflectorBriefHint(result.reflection, context, state);
            if (!result.degraded && reflectorBriefHint) {
              syncRtcProjectionForSession({
                sessionId,
                body: {
                  userQuery: context?.userQueryResolved || context?.userQuery || '',
                  text: context?.userQueryResolved || context?.userQuery || '',
                  source: 'reflector_projection',
                },
                retrievedKnowledge: context?.rag?.summary || '',
                dynamicGameState: context?.dynamicSummary || '',
                projectionOverrides: {
                  reflector_brief_hint: reflectorBriefHint,
                },
              }).then(() => {
                logOrchestrator('rtc_reflector_hint_synced', {
                  turn_id: turnId,
                  session_id: sessionId,
                  reflector_brief_hint: reflectorBriefHint,
                });
              }).catch((hintErr) => {
                logOrchestrator('rtc_reflector_hint_sync_failed', {
                  turn_id: turnId,
                  session_id: sessionId,
                  error: hintErr?.message,
                });
              });
            }
          } catch (hintBuildErr) {
            logOrchestrator('rtc_reflector_hint_build_failed', {
              turn_id: turnId,
              session_id: sessionId,
              error: hintBuildErr?.message,
            });
          }
        } catch (loggingError) {
          logOrchestrator('reflector_log_failed', {
            turn_id: turnId,
            error: loggingError?.message,
          });
        }
      })
      .catch((error) => {
        logOrchestrator('reflector_failed_unexpected', {
          turn_id: turnId,
          error: error?.message,
        });
      });
  });
}

/**
 * P4.2 次要工具执行：compound 模式下，主分支完成后串行执行 secondary tasks。
 * 独立事件名（secondary_*）避免与主分支事件冲突；失败仅 emit secondary_failed，不抛出。
 */
async function executeSecondaryTasks({ secondaryTasks, context, mainOutput, taskId, turnId, emitEvent }) {
  if (!Array.isArray(secondaryTasks) || secondaryTasks.length === 0) return;
  
  const results = await Promise.allSettled(secondaryTasks.map(async (sec) => {
    const secStart = Date.now();
    try {
      logOrchestrator('secondary_task_start', {
        task_id: taskId,
        turn_id: turnId,
        tool: sec.tool,
        query: sec.query,
      });
      if (sec.tool === 'strategy') {
        const overriddenContext = { ...context, userQuery: sec.query || context.userQuery };
        const overriddenMain = {
          ...mainOutput,
          intent: 'strategy',
          popup_mode: 'strategy_text',
          strategy_output_mode: 'text_only',
          needs_image: false,
          branch_wait_reply: '',
        };
        const strategy = await runStrategyAgent(overriddenContext, overriddenMain);
        emitEvent('secondary_strategy_ready', {
          task_id: taskId,
          turn_id: turnId,
          query: sec.query,
          ...strategy.tactic_data,
          latency_ms: Date.now() - secStart,
        });
        logOrchestrator('secondary_task_done', {
          task_id: taskId,
          tool: 'strategy',
          title: strategy.tactic_data?.title,
          latency_ms: Date.now() - secStart,
        });
        return { tool: 'strategy', status: 'fulfilled', data: strategy.tactic_data };
      } else if (sec.tool === 'video') {
        const overriddenContext = { ...context, userQuery: sec.query || context.userQuery };
        const overriddenMain = {
          ...mainOutput,
          intent: 'video',
          popup_mode: 'video_search',
          video_query_seed: sec.query || mainOutput.video_query_seed,
          branch_wait_reply: '',
        };
        const video = await runVideoAgent(overriddenContext, overriddenMain);
        emitEvent('secondary_video_ready', {
          task_id: taskId,
          turn_id: turnId,
          query: sec.query,
          video_query: video.video_query,
          video_queries: video.video_queries || null,
          ...video.video_data,
          latency_ms: Date.now() - secStart,
        });
        logOrchestrator('secondary_task_done', {
          task_id: taskId,
          tool: 'video',
          video_query: video.video_query,
          has_video_url: Boolean(video.video_data?.videoUrl),
          latency_ms: Date.now() - secStart,
        });
        return { tool: 'video', status: 'fulfilled', data: video };
      } else {
        logOrchestrator('secondary_task_skipped', {
          task_id: taskId,
          tool: sec.tool,
          reason: 'unsupported_tool',
        });
        return { tool: sec.tool, status: 'rejected', error: 'unsupported_tool' };
      }
    } catch (err) {
      logOrchestrator('secondary_task_failed', {
        task_id: taskId,
        tool: sec.tool,
        latency_ms: Date.now() - secStart,
        error: err?.message,
      });
      emitEvent('secondary_failed', {
        task_id: taskId,
        turn_id: turnId,
        tool: sec.tool,
        query: sec.query,
        error: err?.message || 'secondary task failed',
      });
      return { tool: sec.tool, status: 'rejected', error: err?.message };
    }
  }));

  appendAgentTrace({
    turn_id: turnId,
    session_id: context.sessionId,
    source: 'secondary_tasks',
    user_query: context.userQuery,
    orchestration_input: 'Secondary Background Execution',
    raw_asr_text: '',
    intent: 'secondary_compound',
    status: 'done',
    route_reason: 'executeSecondaryTasks',
    timeline: [],
    rag: null,
    output: {
      secondary_results: results.map((r, idx) => ({
        tool: secondaryTasks[idx].tool,
        query: secondaryTasks[idx].query,
        result_status: r.status,
        data: r.status === 'fulfilled' ? r.value?.data : null,
        error: r.status === 'rejected' ? r.reason || r.value?.error : null
      }))
    }
  });
}

function buildRagTrace(context = {}) {
  const rag = context.rag || {};
  const items = Array.isArray(rag.items) ? rag.items : [];
  const top0 = items[0] || null;
  const top1Relevance = top0 ? (typeof top0.relevance === 'number' ? top0.relevance : Number(top0.score) || 0) : 0;
  return {
    query: rag.query,
    provider: rag.provider,
    hit_count: items.length,
    fallback: Boolean(rag.fallback),
    error: rag.error || null,
    detected_domains: Array.isArray(rag.detectedDomains) ? rag.detectedDomains : [],
    domain_source: rag.domainSource || null,
    strict_mode: Boolean(rag.strictMode),
    sources: Array.isArray(rag.sources) ? rag.sources : [],
    rerank_source: rag.rerankSource || null,
    pool_size: rag.poolSize || 0,
    // C. 暴露 top1 来源/相关度，前端卡片直接消费
    top1: top0 ? {
      title: top0.title || '',
      source_label: top0.sourceLabel || '',
      source_domain: top0.sourceDomain || '',
      relevance: Number(top1Relevance.toFixed(3)),
      doc_name: top0.docName || '',
    } : null,
    weak_hit: top0 ? top1Relevance < 0.45 : true, // 弱命中阈值从 0.7 降到 0.45，减少误报
    top_items: items.slice(0, 5).map((it) => ({
      title: it.title,
      sourceType: it.sourceType,
      sourceLabel: it.sourceLabel,
      sourceDomain: it.sourceDomain,
      relevance: typeof it.relevance === 'number' ? it.relevance : it.score,
      nativeScore: typeof it.nativeScore === 'number' ? it.nativeScore : null,
      rerankScore: typeof it.rerankScore === 'number' ? it.rerankScore : null,
      docName: it.docName,
    })),
  };
}

function buildBaseState(turnId, context, task) {
  return {
    task_id: task.task_id,
    turn_id: turnId,
    session_id: context.sessionId,
    source: context.source,
    user_query: context.userQuery,
    intent: null,
    fsm_state: task.fsm_state,
    popup_mode: task.popup_mode,
    strategy_output_mode: 'none',
    needs_image: false,
    speakable: false,
    emotional_reply: '',
    understanding_reply: '',
    branch_wait_reply: '',
    main_summary: '',
    route_reason: '',
    tactic_data: null,
    video_query: null,
    video_data: null,
    degraded: false,
    degraded_reason: null,
    status: 'context_ready',
    error: null,
    rag_meta: buildRagTrace(context),
  };
}

export async function runAgentOrchestration(body = {}, emit = () => {}) {
  const startedAt = Date.now();
  const timeline = [{ stage: 'input_received', at: nowIso() }];
  const turnId = createTurnId();
  let context = null;
  let state = null;
  const clientTaskId = String(body.clientTaskId || body.client_task_id || '').trim();
  const task = taskStore.createTask({
    taskId: clientTaskId || undefined,
    turnId,
    sessionId: body.sessionId || body.session_id || body.userId || body.user_id || 'default',
    userQuery: body.text || body.query || body.user_query || '',
    source: body.source || 'unknown',
  });

  const emitEvent = (event, data) => emit(event, data);
  const emitFsmState = (currentTask = task, extra = {}) => {
    logOrchestrator('emit_fsm_state', {
      task_id: currentTask.task_id,
      turn_id: turnId,
      intent: currentTask.intent,
      fsm_state: currentTask.fsm_state,
      popup_mode: currentTask.popup_mode,
      queue_position: currentTask.queue_position || 0,
      message: extra.message || '',
    });
    emitEvent('fsm_state', {
      task_id: currentTask.task_id,
      turn_id: turnId,
      intent: currentTask.intent,
      fsm_state: currentTask.fsm_state,
      popup_mode: currentTask.popup_mode,
      queue_position: currentTask.queue_position || 0,
      ...extra,
    });
  };
  const rtcProjectionState = {
    stickyHero: '',
    activeNeeds: [],
  };
  const syncRtcProjection = async ({ retrievedKnowledge = '', sessionTopic, unresolvedNeed } = {}) => {
    if (!context?.sessionId) return null;
    try {
      const result = await syncRtcProjectionForSession({
        sessionId: context.sessionId,
        body: {
          userQuery: context.userQueryResolved || context.userQuery || body.text || body.query || '',
          text: context.userQueryResolved || context.userQuery || body.text || body.query || '',
          source: context.source || body.source || 'orchestrator',
        },
        retrievedKnowledge: retrievedKnowledge || context.rag?.summary || '',
        dynamicGameState: context.dynamicSummary || '',
        projectionOverrides: {
          session_topic: sessionTopic,
          unresolved_need: unresolvedNeed,
        },
      });
      if (!result?.skipped) {
        logOrchestrator('rtc_projection_synced', {
          task_id: task.task_id,
          turn_id: turnId,
          session_id: context.sessionId,
          session_topic: sessionTopic || '',
          unresolved_need: unresolvedNeed || '',
        });
      }
      return result;
    } catch (projectionError) {
      logOrchestrator('rtc_projection_sync_failed', {
        task_id: task.task_id,
        turn_id: turnId,
        session_id: context.sessionId,
        error: projectionError?.message,
      });
      return null;
    }
  };

  try {
    const priorityDetection = detectRequestPriority(task.user_query);
    let resolvedPoolPriority = resolvePoolPriority(priorityDetection, body.priority);

    logOrchestrator('start', {
      task_id: task.task_id,
      turn_id: turnId,
      session_id: task.session_id,
      source: task.source,
      user_query: task.user_query,
      priority_detected: priorityDetection.priority,
      priority_reason: priorityDetection.reason,
      priority_pattern: priorityDetection.matched_pattern,
      pool_priority: resolvedPoolPriority,
      explicit_priority: body.priority || null,
    });
    emitEvent('task_created', {
      task_id: task.task_id,
      turn_id: turnId,
      intent: task.intent,
      fsm_state: task.fsm_state,
      popup_mode: task.popup_mode,
      user_query: task.user_query,
      speakable: false,
      priority: resolvedPoolPriority,
      priority_reason: priorityDetection.reason,
      source: task.source,
      client_task_id: clientTaskId || '',
    });
    appendAgentTrace({
      turn_id: turnId,
      session_id: body.sessionId || body.session_id || 'default',
      source: body.source || 'orchestrate_trigger',
      user_query: task.user_query,
      orchestration_input: task.user_query,
      latest_stage: 'task_created',
      intent: task.intent,
      status: 'running',
    });
    taskStore.transition(task.task_id, 'CONTEXT_LOADING');
    emitFsmState(taskStore.get(task.task_id), { message: '正在理解问题' });
    emitEvent('voice_delta', { task_id: task.task_id, turn_id: turnId, text: '收到！', source: 'fixed_ack', priority: 'high', speakable: false });

    context = await buildAgentContext(body, turnId);
    context.taskId = task.task_id;
    rtcProjectionState.stickyHero = context.stickyHero?.hero || '';
    timeline.push({ stage: 'context_ready', latency_ms: Date.now() - startedAt });
    logOrchestrator('context_ready', {
      task_id: task.task_id,
      latency_ms: Date.now() - startedAt,
      rag_provider: context.rag?.provider,
      rag_fallback: Boolean(context.rag?.fallback),
      rag_hit_count: context.rag?.items?.length || 0,
    });
    appendAgentTrace({
      turn_id: turnId,
      session_id: context.sessionId,
      source: context.source,
      user_query: context.userQuery,
      orchestration_input: context.orchestrationInput || context.userQuery,
      latest_stage: 'context_ready',
      intent: state?.intent || 'unknown',
      rag: context.rag || null,
      status: 'running',
    });
    taskStore.transition(task.task_id, 'ROUTING');
    emitFsmState(taskStore.get(task.task_id), { message: '正在分析意图' });
    state = buildBaseState(turnId, context, taskStore.get(task.task_id));
    if (context.rag?.fallback) {
      state.degraded = true;
      state.degraded_reason = context.rag?.error?.message || '主脑前置 RAG 已降级';
    }
    emitEvent('agent_state', state);

    const userQuery = context.userQueryResolved || context.userQuery || '';
    const rawPlaceholderRoute = resolvePlaceholderRoute(context);
    const useLocalVideoFastPath = shouldUseLocalVideoFastPath(userQuery, rawPlaceholderRoute.intent);
    const placeholderRoute = withPlaceholderCommit(rawPlaceholderRoute, useLocalVideoFastPath);
    const hintIntent = placeholderRoute.intent;
    const placeholderEmotional = hintIntent === 'video' ? '好嘞，我先找。' : hintIntent === 'strategy' ? '稳住，我先看。' : '我懂你意思。';
    const placeholderBranchWait = hintIntent === 'video' ? '我去找找' : hintIntent === 'strategy' ? '我帮你整理下' : '';
    emitEvent('interaction_reply_placeholder', {
      task_id: task.task_id,
      turn_id: turnId,
      intent: hintIntent,
      hint_intent: hintIntent,
      hint_confidence: placeholderRoute.hint_confidence,
      placeholder_type: placeholderRoute.placeholder_type,
      ui_commit: placeholderRoute.ui_commit,
      emotional_reply: placeholderEmotional,
      branch_wait_reply: placeholderBranchWait,
      source: 'local_route_quick',
      route_reason: `local_route_hint:${hintIntent}:${placeholderRoute.reason || 'unknown'}`,
    });
    timeline.push({
      stage: 'interaction_placeholder_emitted',
      latency_ms: Date.now() - startedAt,
      intent: hintIntent,
      hint_confidence: placeholderRoute.hint_confidence,
      placeholder_type: placeholderRoute.placeholder_type,
      ui_commit: placeholderRoute.ui_commit,
    });
    appendAgentTrace({
      turn_id: turnId,
      session_id: context.sessionId,
      source: context.source,
      user_query: context.userQuery,
      orchestration_input: context.orchestrationInput || context.userQuery,
      latest_stage: 'interaction_placeholder_emitted',
      intent: hintIntent,
      rag: context.rag || null,
      output: {
        intent: hintIntent,
        hint_confidence: placeholderRoute.hint_confidence,
        placeholder_type: placeholderRoute.placeholder_type,
        ui_commit: placeholderRoute.ui_commit,
        emotional_reply: placeholderEmotional,
        branch_wait_reply: placeholderBranchWait,
      },
      status: 'running',
    });

    // ===== A: 预判并行化：hintIntent=strategy 时提前启动 strategy agent =====
    // 在 interaction agent 运行期间，strategy 已经在跑了，节省总耗时
    let preStrategyPromise = null;
    if (hintIntent === 'strategy') {
      const prelaunchSlot = intentPool.tryAcquire('strategy', task.task_id);
      if (prelaunchSlot) {
        logOrchestrator('strategy_prelaunch_start', {
          task_id: task.task_id,
          turn_id: turnId,
          hint_intent: hintIntent,
        });
        const prelaunchMainOutput = {
          task_id: task.task_id,
          turn_id: turnId,
          fsm_state: 'MAIN_REPLIED',
          intent: 'strategy',
          popup_mode: 'strategy_text',
          strategy_output_mode: 'text_only',
          needs_image: false,
          strategy_query: userQuery,
        };
        // 关键路径浅隔离：避免并行任务共享可变引用
        const prelaunchContext = {
          ...context,
          rag: context.rag ? { ...context.rag, items: context.rag.items?.slice() } : null,
          stickyHero: context.stickyHero ? { ...context.stickyHero } : null,
          shortMemory: context.shortMemory ? { ...context.shortMemory } : null,
          screenObservation: context.screenObservation ? { ...context.screenObservation } : null,
        };
        preStrategyPromise = runStrategyAgent(prelaunchContext, prelaunchMainOutput)
          .then(result => {
            logOrchestrator('strategy_prelaunch_done', {
              task_id: task.task_id,
              turn_id: turnId,
              title: result?.tactic_data?.title,
              has_data: Boolean(result?.tactic_data),
            });
            return result;
          })
          .catch(err => {
            logOrchestrator('strategy_prelaunch_failed', {
              task_id: task.task_id,
              turn_id: turnId,
              error: err?.message,
            });
            return null; // 预判失败不影响主流程，降级到重新运行
          })
          .finally(() => {
            prelaunchSlot.release();
          });
      } else {
        logOrchestrator('strategy_prelaunch_skipped', {
          task_id: task.task_id,
          turn_id: turnId,
          reason: 'pool_saturated',
        });
      }
    }

    let interactionResult;
    if (useLocalVideoFastPath) {
      interactionResult = fallbackForIntent(
        {
          ...context,
          taskId: task.task_id,
        },
        'local_video_fast_path'
      );
      logOrchestrator('interaction_agent_skipped', {
        task_id: task.task_id,
        reason: 'local_video_fast_path',
        hint_intent: hintIntent,
      });
    } else {
      try {
        interactionResult = await runInteractionAgent({
          ...context,
          taskId: task.task_id,
        }, {
          taskId: task.task_id,
          onSpeechDelta: async ({ index, text }) => {
            emitEvent('main_reply_delta', {
              task_id: task.task_id,
              turn_id: turnId,
              index,
              text,
            });
          },
        });
      } catch (interactionErr) {
        logOrchestrator('interaction_agent_error', {
          task_id: task.task_id,
          error: interactionErr?.message,
        });
        throw interactionErr;
      }
    }

    const llmIntent = interactionResult?.intent || hintIntent;
    const intent = llmIntent;
    const needsImage = interactionResult?.needs_image === true || (intent === 'strategy' && shouldGenerateStrategyImage(userQuery));
    const videoSeed = interactionResult?.video_query_seed || (intent === 'video' ? buildVideoSearchSeed(userQuery) : '');
    const mainOutput = {
      task_id: task.task_id,
      turn_id: turnId,
      fsm_state: 'MAIN_REPLIED',
      intent,
      popup_mode: interactionResult?.popup_mode || (intent === 'video' ? 'video_search' : intent === 'strategy' ? (needsImage ? 'strategy_card' : 'strategy_text') : 'chat_reply'),
      strategy_output_mode: interactionResult?.strategy_output_mode || (intent === 'strategy' ? (needsImage ? 'card_with_image' : 'text_only') : 'none'),
      needs_image: needsImage,
      speakable: false,
      emotional_reply: interactionResult?.emotional_reply || '',
      understanding_reply: interactionResult?.understanding_reply || '',
      branch_wait_reply: interactionResult?.branch_wait_reply || placeholderBranchWait,
      main_summary: interactionResult?.main_summary || '',
      speech_delta: interactionResult?.speech_delta || [],
      speech_streamed: interactionResult?.speech_streamed === true,
      route_reason: interactionResult?.degraded
        ? `interaction_agent_degraded:${intent}`
        : `interaction_agent:${intent}`,
      queue_hint: '',
      tts_priority: 'silent',
      strategy_query: interactionResult?.strategy_query || (intent === 'strategy' ? userQuery : null),
      video_query_seed: videoSeed,
    };
    timeline.push({ stage: 'interaction_agent_done', latency_ms: Date.now() - startedAt });
    logOrchestrator('interaction_agent_done', {
      task_id: task.task_id,
      latency_ms: Date.now() - startedAt,
      intent: mainOutput.intent,
      hint_intent: hintIntent,
      intent_corrected: hintIntent !== intent,
      popup_mode: mainOutput.popup_mode,
      strategy_output_mode: mainOutput.strategy_output_mode,
      needs_image: mainOutput.needs_image === true,
      route_reason: mainOutput.route_reason,
      degraded: interactionResult?.degraded === true,
      source: 'llm_main_agent',
    });
    emitEvent('interaction_reply', {
      task_id: task.task_id,
      turn_id: turnId,
      intent: mainOutput.intent,
      fsm_state: 'MAIN_REPLIED',
      popup_mode: mainOutput.popup_mode,
      strategy_output_mode: mainOutput.strategy_output_mode,
      needs_image: mainOutput.needs_image === true,
      speakable: false,
      emotional_reply: mainOutput.emotional_reply,
      understanding_reply: mainOutput.understanding_reply,
      branch_wait_reply: mainOutput.branch_wait_reply,
      main_summary: mainOutput.main_summary,
      speech_delta: mainOutput.speech_delta,
      speech_streamed: mainOutput.speech_streamed,
      route_reason: mainOutput.route_reason,
      queue_hint: mainOutput.queue_hint || '',
      tts_priority: 'silent',
    });
    rtcProjectionState.activeNeeds = [buildRtcNeedLabel(mainOutput.intent, rtcProjectionState.stickyHero)].filter(Boolean);
    await syncRtcProjection({
      retrievedKnowledge: context.rag?.summary || '',
      sessionTopic: buildRtcTopicFromIntent(mainOutput.intent, rtcProjectionState.stickyHero),
      unresolvedNeed: rtcProjectionState.activeNeeds[0] || '',
    });
    timeline.push({ stage: 'interaction_reply_emitted', latency_ms: Date.now() - startedAt, intent: mainOutput.intent });
    logOrchestrator('interaction_reply_emitted', {
      task_id: task.task_id,
      intent: mainOutput.intent,
      speech_delta_count: mainOutput.speech_delta?.length || 0,
      speech_streamed: mainOutput.speech_streamed === true,
      latency_ms: Date.now() - startedAt,
    });
    appendAgentTrace({
      turn_id: turnId,
      session_id: context.sessionId,
      source: context.source,
      user_query: context.userQuery,
      orchestration_input: context.orchestrationInput || context.userQuery,
      latest_stage: 'interaction_reply_emitted',
      intent: mainOutput.intent,
      status: 'branch_running',
      route_reason: mainOutput.route_reason,
      rag: context.rag || null,
      output: {
        intent: mainOutput.intent,
        emotional_reply: mainOutput.emotional_reply || '',
        understanding_reply: mainOutput.understanding_reply || '',
        branch_wait_reply: mainOutput.branch_wait_reply || '',
        main_summary: mainOutput.main_summary || '',
        popup_mode: mainOutput.popup_mode,
        strategy_output_mode: mainOutput.strategy_output_mode || 'none',
        needs_image: mainOutput.needs_image === true,
      },
    });
    Object.assign(state, {
      task_id: mainOutput.task_id || task.task_id,
      intent: mainOutput.intent,
      fsm_state: mainOutput.fsm_state || 'MAIN_REPLIED',
      popup_mode: mainOutput.popup_mode,
      strategy_output_mode: mainOutput.strategy_output_mode || 'none',
      needs_image: mainOutput.needs_image === true,
      speakable: false,
      emotional_reply: mainOutput.emotional_reply,
      understanding_reply: mainOutput.understanding_reply,
      branch_wait_reply: mainOutput.branch_wait_reply,
      main_summary: mainOutput.main_summary,
      route_reason: mainOutput.route_reason,
      status: mainOutput.intent === 'smalltalk' ? 'done' : 'branch_running',
    });
    taskStore.transition(task.task_id, 'MAIN_REPLIED', {
      intent: state.intent,
      popup_mode: state.popup_mode,
      speakable: false,
    });
    emitFsmState(taskStore.get(task.task_id), { message: '已理解问题' });
    emitEvent('main_reply', {
      task_id: task.task_id,
      turn_id: turnId,
      intent: state.intent,
      fsm_state: state.fsm_state,
      popup_mode: state.popup_mode,
      strategy_output_mode: state.strategy_output_mode,
      needs_image: state.needs_image,
      speakable: false,
      emotional_reply: state.emotional_reply,
      understanding_reply: state.understanding_reply,
      branch_wait_reply: state.branch_wait_reply,
      main_summary: state.main_summary,
      route_reason: state.route_reason,
      queue_hint: mainOutput.queue_hint || '',
      tts_priority: 'silent',
    });
    logOrchestrator('main_reply_emitted', {
      task_id: task.task_id,
      intent: state.intent,
      popup_mode: state.popup_mode,
      needs_image: state.needs_image,
      emotional_reply: state.emotional_reply,
      understanding_reply: state.understanding_reply,
      branch_wait_reply: state.branch_wait_reply,
      main_summary: state.main_summary,
      speakable: state.speakable,
      latency_ms: Date.now() - startedAt,
    });

    let taskPlan = { task_plan: [], mode: 'single', reason: 'pending' };
    let secondaryTasks = [];
    try {
      // 方案 A：把 sessionState.recent_turns 透传进 planTasks，让 strategy task 的 query 能注入用户痛点
      let plannerRecentTurns = [];
      try {
        const sessionStateForPlanner = getAgentSessionState(context?.sessionId || 'default');
        plannerRecentTurns = Array.isArray(sessionStateForPlanner?.recent_turns)
          ? sessionStateForPlanner.recent_turns
          : [];
      } catch (_) {
        plannerRecentTurns = [];
      }
      taskPlan = await planTasks({
        user_query: context.userQuery,
        main_intent: mainOutput.intent,
        main_reply: mainOutput,
        recent_turns: plannerRecentTurns,
      });
      if (taskPlan.mode === 'compound' && Array.isArray(taskPlan.task_plan)) {
        secondaryTasks = taskPlan.task_plan.filter((t) => t.tool !== mainOutput.intent);
      }
      logOrchestrator('task_plan_inferred', {
        task_id: task.task_id,
        mode: taskPlan.mode,
        reason: taskPlan.reason,
        task_count: taskPlan.task_plan.length,
        tools: taskPlan.task_plan.map((t) => t.tool),
        secondary_count: secondaryTasks.length,
        pain_hint: taskPlan.pain_hint || '',
      });
      emitEvent('task_plan', {
        task_id: task.task_id,
        turn_id: turnId,
        mode: taskPlan.mode,
        reason: taskPlan.reason,
        task_plan: taskPlan.task_plan,
      });
      const secondaryNeeds = secondaryTasks
        .map((item) => buildRtcNeedLabel(item.tool, rtcProjectionState.stickyHero))
        .filter(Boolean);
      rtcProjectionState.activeNeeds = [
        buildRtcNeedLabel(mainOutput.intent, rtcProjectionState.stickyHero),
        ...secondaryNeeds,
      ].filter(Boolean);
      await syncRtcProjection({
        retrievedKnowledge: context.rag?.summary || '',
        sessionTopic: buildRtcTopicFromIntent(mainOutput.intent, rtcProjectionState.stickyHero),
        unresolvedNeed: rtcProjectionState.activeNeeds[0] || '',
      });
    } catch (planErr) {
      logOrchestrator('task_plan_failed', {
        task_id: task.task_id,
        error: planErr?.message,
      });
    }

    if (mainOutput.intent === 'smalltalk') {
      logOrchestrator('smalltalk_done', {
        task_id: task.task_id,
        latency_ms: Date.now() - startedAt,
      });
      emitEvent('voice_delta', { task_id: task.task_id, turn_id: turnId, text: state.main_summary, source: 'smalltalk_summary', priority: 'normal', speakable: false });
      logOrchestrator('voice_delta_emitted', { task_id: task.task_id, source: 'smalltalk_summary', text: state.main_summary, speakable: false });
      taskStore.transition(task.task_id, 'DONE');
      emitFsmState(taskStore.get(task.task_id), { message: '完成' });
      appendAgentSessionTurn(context.sessionId, {
        turn_id: turnId,
        user_query: context.userQuery,
        intent: state.intent,
        summary: state.main_summary,
        created_at: nowIso(),
      });
      appendAgentTrace({
        turn_id: turnId,
        session_id: context.sessionId,
        source: context.source,
        user_query: context.userQuery,
        orchestration_input: context.orchestrationInput || context.userQuery,
        raw_asr_text: context.rawAsrText || '',
        intent: state.intent,
        status: 'done',
        route_reason: state.route_reason,
        timeline,
        rag: buildRagTrace(context),
        output: {
          intent: state.intent,
          emotional_reply: state.emotional_reply,
          understanding_reply: state.understanding_reply || '',
          branch_wait_reply: state.branch_wait_reply || '',
          main_summary: state.main_summary || '',
        },
      });
      triggerAsyncMemoryWrite(context, state, {
        emotional_reply: state.emotional_reply,
        main_summary: state.main_summary,
      }, turnId);
      triggerReflectorAsync({
        context,
        state,
        branchOutput: {
          main_summary: state.main_summary || '',
          degraded: Boolean(state.degraded),
          degraded_reason: state.degraded_reason,
          activated_subagents: [],
        },
        turnId,
        emitEvent,
      });
      rtcProjectionState.activeNeeds = [];
      await syncRtcProjection({
        retrievedKnowledge: context.rag?.summary || '',
        sessionTopic: buildRtcTopicFromIntent(state.intent, rtcProjectionState.stickyHero),
        unresolvedNeed: '',
      });
      emitEvent('done', state);
      return state;
    }

    if (mainOutput.intent === 'strategy') {
      let slot = null;
      const STRATEGY_MAX_RETRIES = 2;
      const STRATEGY_RETRY_DELAY_MS = 1500;
      let lastStrategyError = null;
      let strategyAttempt = 0;
      try {
        logOrchestrator('strategy_pool_acquire_start', {
          task_id: task.task_id,
          pool: intentPool.snapshot(),
        });
        slot = await intentPool.acquire('strategy', task.task_id, (queuePosition, queuePriority) => {
          taskStore.transition(task.task_id, 'BRANCH_QUEUED', { queue_position: queuePosition });
          emitFsmState(taskStore.get(task.task_id), { message: `排队中（${queuePriority || 'normal'}），第 ${queuePosition} 位` });
          emitEvent('task_queued', { task_id: task.task_id, turn_id: turnId, intent: 'strategy', queue_position: queuePosition, priority: queuePriority || 'normal' });
        }, { priority: resolvedPoolPriority });
        logOrchestrator('strategy_pool_acquired', {
          task_id: task.task_id,
          queued_before_acquire: slot?.queued === true,
          pool: intentPool.snapshot(),
          priority_used: resolvedPoolPriority,
        });
        const currentTask = taskStore.get(task.task_id);
        if (currentTask.fsm_state === 'MAIN_REPLIED') {
          taskStore.transition(task.task_id, 'BRANCH_EXEC', { queue_position: 0 });
        } else if (currentTask.fsm_state === 'BRANCH_QUEUED') {
          taskStore.transition(task.task_id, 'BRANCH_EXEC', { queue_position: 0 });
        }
        emitFsmState(taskStore.get(task.task_id), { message: state.needs_image ? '正在生成图文战术卡片' : '正在整理文字战术建议' });
        if (state.branch_wait_reply) {
          emitEvent('voice_delta', { task_id: task.task_id, turn_id: turnId, text: state.branch_wait_reply, source: 'branch_wait_reply', priority: 'normal', speakable: false });
          logOrchestrator('voice_delta_emitted', { task_id: task.task_id, source: 'branch_wait_reply(strategy)', text: state.branch_wait_reply, speakable: false });
        }
        if (body.debugBranchDelayMs) {
          logOrchestrator('strategy_debug_delay_start', {
            task_id: task.task_id,
            debugBranchDelayMs: Number(body.debugBranchDelayMs),
          });
          await sleep(body.debugBranchDelayMs);
          logOrchestrator('strategy_debug_delay_done', {
            task_id: task.task_id,
          });
        }
        for (strategyAttempt = 1; strategyAttempt <= STRATEGY_MAX_RETRIES; strategyAttempt++) {
          try {
            logOrchestrator('strategy_agent_start', {
              task_id: task.task_id,
              attempt: strategyAttempt,
              max_retries: STRATEGY_MAX_RETRIES,
              strategy_output_mode: state.strategy_output_mode,
              needs_image: state.needs_image,
              prelaunch_usable: Boolean(preStrategyPromise && !state.needs_image),
            });
            // ===== A: 复用预判结果 =====
            // 仅在不需要图片时复用（预判默认跑 text_only，若主流程需要图片则需重新跑）
            let strategy = null;
            if (strategyAttempt === 1 && preStrategyPromise && !state.needs_image) {
              strategy = await preStrategyPromise;
              if (strategy?.tactic_data) {
                logOrchestrator('strategy_prelaunch_reused', {
                  task_id: task.task_id,
                  turn_id: turnId,
                  title: strategy.tactic_data?.title,
                });
              } else {
                // 预判失败或无效，降级为正常调用
                strategy = null;
              }
            }
            if (!strategy) {
              strategy = await runStrategyAgent(context, mainOutput);
            }
            state.tactic_data = strategy.tactic_data;
            state.rag_strength = strategy.rag_strength || null;
            // 弱命中提示保留在 tactic_data 内，避免污染 main_fast 的 main_summary 边界。
            state.status = 'done';
            if (strategy.rag?.fallback) {
              state.degraded = true;
              state.degraded_reason = strategy.rag?.error?.message || 'Strategy_Agent 检索已降级';
            }
            timeline.push({ stage: 'strategy_agent_done', latency_ms: Date.now() - startedAt, attempt: strategyAttempt });
            logOrchestrator('strategy_agent_done', {
              task_id: task.task_id,
              latency_ms: Date.now() - startedAt,
              attempt: strategyAttempt,
              title: state.tactic_data?.title,
              details_count: state.tactic_data?.details?.length || 0,
              needs_image: state.tactic_data?.needs_image === true,
              voice_chunks_count: state.tactic_data?.voice_chunks?.length || 0,
            });
            lastStrategyError = null;
            break;
          } catch (strategyError) {
            lastStrategyError = strategyError;
            logOrchestrator('strategy_agent_error', {
              task_id: task.task_id,
              attempt: strategyAttempt,
              max_retries: STRATEGY_MAX_RETRIES,
              error_message: strategyError.message,
              error_code: strategyError.code || null,
              will_retry: strategyAttempt < STRATEGY_MAX_RETRIES,
            });
            if (strategyAttempt < STRATEGY_MAX_RETRIES) {
              logOrchestrator('strategy_agent_retry_wait', {
                task_id: task.task_id,
                attempt: strategyAttempt,
                retry_delay_ms: STRATEGY_RETRY_DELAY_MS,
              });
              emitEvent('voice_delta', {
                task_id: task.task_id,
                turn_id: turnId,
                text: '内容生成遇到问题，正在重试。',
                source: 'strategy_retry',
                priority: 'normal',
                speakable: false,
              });
              logOrchestrator('voice_delta_emitted', { task_id: task.task_id, source: 'strategy_retry', text: '内容生成遇到问题，正在重试。', speakable: false });
              await sleep(STRATEGY_RETRY_DELAY_MS);
            }
          }
        }
        if (lastStrategyError) {
          logOrchestrator('strategy_agent_exhausted_retries', {
            task_id: task.task_id,
            total_attempts: STRATEGY_MAX_RETRIES,
            final_error: lastStrategyError.message,
          });
          state.tactic_data = {
            title: '战术建议（降级）',
            details: ['内容生成暂时失败，请稍后再试。'],
            voice_chunks: ['战术内容生成遇到了问题，请稍后再试。'],
            strategy_output_mode: 'text_only',
            needs_image: false,
            image_prompt_text: null,
          };
          state.degraded = true;
          state.degraded_reason = lastStrategyError.message || 'Strategy_Agent 重试耗尽';
          state.status = 'done';
          taskStore.transition(task.task_id, 'DEGRADED', { error: { message: state.degraded_reason } });
          emitFsmState(taskStore.get(task.task_id), { message: '战术内容生成失败，已降级' });
          emitEvent('voice_delta', {
            task_id: task.task_id,
            turn_id: turnId,
            text: '战术内容生成遇到了问题，先给你一个简化建议。',
            source: 'strategy_degraded',
            priority: 'normal',
            speakable: false,
          });
          logOrchestrator('voice_delta_emitted', { task_id: task.task_id, source: 'strategy_degraded', text: '战术内容生成遇到了问题，先给你一个简化建议。', speakable: false });
        }

        for (const chunk of state.tactic_data.voice_chunks || []) {
          emitEvent('voice_delta', { task_id: task.task_id, turn_id: turnId, text: chunk, source: 'strategy_chunk', priority: 'normal', speakable: false });
        }
        taskStore.transition(task.task_id, 'ASSET_READY');
        emitFsmState(taskStore.get(task.task_id), { message: '战术内容已准备好' });
        emitEvent('strategy_ready', {
          task_id: task.task_id,
          turn_id: turnId,
          popup_mode: state.popup_mode,
          source: context.source,
          rag_meta: buildRagTrace(context),
          ...state.tactic_data,
        });
        rtcProjectionState.activeNeeds = rtcProjectionState.activeNeeds.filter((item) => item !== buildRtcNeedLabel('strategy', rtcProjectionState.stickyHero));
        await syncRtcProjection({
          retrievedKnowledge: context.rag?.summary || '',
          sessionTopic: buildRtcTopicFromIntent('strategy', rtcProjectionState.stickyHero),
          unresolvedNeed: rtcProjectionState.activeNeeds[0] || '',
        });

        // 核心资源生成完毕，提前释放并发槽位，避免后续日志和 secondary task 阻塞并发池
        if (slot) {
          slot.release?.();
          logOrchestrator('strategy_pool_released_early', {
            task_id: task.task_id,
            pool: intentPool.snapshot(),
          });
          emitEvent('pool_changed', intentPool.snapshot());
          slot = null;
        }

        taskStore.transition(task.task_id, 'DONE');
        emitFsmState(taskStore.get(task.task_id), { message: '完成' });
        persistActiveBranchState({
          context,
          state,
          intent: state.intent,
          stickyHero: rtcProjectionState.stickyHero,
        });
        appendAgentSessionTurn(context.sessionId, {
          turn_id: turnId,
          user_query: context.userQuery,
          intent: state.intent,
          summary: state.main_summary,
          tactic_title: state.tactic_data.title,
          created_at: nowIso(),
        });
        appendAgentTrace({
          turn_id: turnId,
          session_id: context.sessionId,
          source: context.source,
          user_query: context.userQuery,
          orchestration_input: context.orchestrationInput || context.userQuery,
          raw_asr_text: context.rawAsrText || '',
          intent: state.intent,
          status: state.degraded ? 'degraded' : 'done',
          route_reason: state.route_reason,
          timeline,
          rag: buildRagTrace(context),
          output: {
            intent: state.intent,
            emotional_reply: state.emotional_reply,
            understanding_reply: state.understanding_reply || '',
            branch_wait_reply: state.branch_wait_reply || '',
            main_summary: state.main_summary || '',
            tactic_title: state.tactic_data?.title || '',
            popup_mode: state.popup_mode,
            strategy_output_mode: state.strategy_output_mode,
            needs_image: state.needs_image,
            degraded: state.degraded,
            degraded_reason: state.degraded_reason,
            retries_used: strategyAttempt,
            secondary_tasks: secondaryTasks.map((task) => ({
              tool: task.tool,
              query: task.query,
              priority: task.priority || 'normal',
            })),
            tactic_data: state.tactic_data || null,
          },
        });
        triggerAsyncMemoryWrite(context, state, {
          emotional_reply: state.emotional_reply,
          tactic_title: state.tactic_data.title,
          popup_mode: state.popup_mode,
          degraded: state.degraded,
          degraded_reason: state.degraded_reason,
          retries_used: strategyAttempt,
        }, turnId);
        triggerReflectorAsync({
          context,
          state,
          branchOutput: {
            tactic_title: state.tactic_data?.title || '',
            details_count: state.tactic_data?.details?.length || 0,
            degraded: Boolean(state.degraded),
            degraded_reason: state.degraded_reason,
            activated_subagents: ['strategy_agent'],
          },
          turnId,
          emitEvent,
        });
        await executeSecondaryTasks({
          secondaryTasks,
          context,
          mainOutput,
          taskId: task.task_id,
          turnId,
          emitEvent,
        });
        rtcProjectionState.activeNeeds = [];
        await syncRtcProjection({
          retrievedKnowledge: context.rag?.summary || '',
          sessionTopic: buildRtcTopicFromIntent(state.intent, rtcProjectionState.stickyHero),
          unresolvedNeed: '',
        });
        emitEvent('done', state);
        return state;
      } finally {
        if (slot) {
          slot.release?.();
          logOrchestrator('strategy_pool_released', {
            task_id: task.task_id,
            pool: intentPool.snapshot(),
          });
          emitEvent('pool_changed', intentPool.snapshot());
        }
      }
    }

    if (mainOutput.intent === 'video') {
      let slot = null;
      try {
        logOrchestrator('video_pool_acquire_start', {
          task_id: task.task_id,
          pool: intentPool.snapshot(),
        });
        slot = await intentPool.acquire('video', task.task_id, (queuePosition, queuePriority) => {
          taskStore.transition(task.task_id, 'BRANCH_QUEUED', { queue_position: queuePosition });
          emitFsmState(taskStore.get(task.task_id), { message: `排队中（${queuePriority || 'normal'}），第 ${queuePosition} 位` });
          emitEvent('task_queued', { task_id: task.task_id, turn_id: turnId, intent: 'video', queue_position: queuePosition, priority: queuePriority || 'normal' });
        }, { priority: resolvedPoolPriority });
        logOrchestrator('video_pool_acquired', {
          task_id: task.task_id,
          queued_before_acquire: slot?.queued === true,
          pool: intentPool.snapshot(),
        });
        const currentTask = taskStore.get(task.task_id);
        if (currentTask.fsm_state === 'MAIN_REPLIED') {
          taskStore.transition(task.task_id, 'BRANCH_EXEC', { queue_position: 0 });
        } else if (currentTask.fsm_state === 'BRANCH_QUEUED') {
          taskStore.transition(task.task_id, 'BRANCH_EXEC', { queue_position: 0 });
        }
        emitFsmState(taskStore.get(task.task_id), { message: '正在找可播放视频' });
        if (state.branch_wait_reply) {
          emitEvent('voice_delta', { task_id: task.task_id, turn_id: turnId, text: state.branch_wait_reply, source: 'branch_wait_reply', priority: 'normal', speakable: false });
          logOrchestrator('voice_delta_emitted', { task_id: task.task_id, source: 'branch_wait_reply(video)', text: state.branch_wait_reply, speakable: false });
        }
        logOrchestrator('video_agent_start', {
          task_id: task.task_id,
          video_query_seed: mainOutput.video_query_seed,
        });
        if (body.debugBranchDelayMs) {
          logOrchestrator('video_debug_delay_start', {
            task_id: task.task_id,
            debugBranchDelayMs: Number(body.debugBranchDelayMs),
          });
          await sleep(body.debugBranchDelayMs);
          logOrchestrator('video_debug_delay_done', {
            task_id: task.task_id,
          });
        }
        const video = await withRetry(
          async (attempt) => {
            let attemptMain = mainOutput;
            if (attempt > 1) {
              const rewritten = rewriteFailedQuery(mainOutput.video_query_seed || context.userQuery);
              attemptMain = { ...mainOutput, video_query_seed: rewritten };
              logOrchestrator('video_query_rewritten', {
                task_id: task.task_id,
                attempt,
                original_seed: mainOutput.video_query_seed,
                rewritten_seed: rewritten,
              });
            }
            return runVideoAgent(context, attemptMain);
          },
          {
            maxAttempts: 2,
            delayMs: 800,
            shouldRetry: (err) => {
              if (err?.code === 'VIDEO_URL_INVALID') return true;
              return isRetryableError(err);
            },
            onAttempt: (attempt, err) => {
              if (err) {
                logOrchestrator('video_agent_attempt_failed', {
                  task_id: task.task_id,
                  attempt,
                  error: err.message,
                  code: err.code || null,
                  retryable: Boolean(err?.code === 'VIDEO_URL_INVALID' || isRetryableError(err)),
                });
              } else if (attempt > 1) {
                logOrchestrator('video_agent_retry_start', {
                  task_id: task.task_id,
                  attempt,
                });
              }
            },
          }
        );
        state.video_query = video.video_query;
        state.video_queries = video.video_queries || null;
        state.video_data = video.video_data;
        state.status = 'done';
        timeline.push({ stage: 'video_agent_done', latency_ms: Date.now() - startedAt });
        logOrchestrator('video_agent_done', {
          task_id: task.task_id,
          latency_ms: Date.now() - startedAt,
          video_query: state.video_query,
          has_video_url: Boolean(state.video_data?.videoUrl),
        });
        emitEvent('voice_delta', { task_id: task.task_id, turn_id: turnId, text: '找到可播放视频了，马上打开。', source: 'video_ready', priority: 'normal', speakable: false });
        logOrchestrator('voice_delta_emitted', { task_id: task.task_id, source: 'video_ready', text: '找到可播放视频了，马上打开。', speakable: false });
        taskStore.transition(task.task_id, 'ASSET_READY');
        emitFsmState(taskStore.get(task.task_id), { message: '视频已准备好' });
        emitEvent('video_ready', {
          task_id: task.task_id,
          turn_id: turnId,
          ...state.video_data,
        });
        rtcProjectionState.activeNeeds = rtcProjectionState.activeNeeds.filter((item) => item !== buildRtcNeedLabel('video', rtcProjectionState.stickyHero));
        await syncRtcProjection({
          retrievedKnowledge: state.video_query || context.rag?.summary || '',
          sessionTopic: buildRtcTopicFromIntent('video', rtcProjectionState.stickyHero),
          unresolvedNeed: rtcProjectionState.activeNeeds[0] || '',
        });
      } catch (videoError) {
        logOrchestrator('video_agent_degraded', {
          task_id: task.task_id,
          latency_ms: Date.now() - startedAt,
          message: videoError.message,
          video_query: videoError.videoQuery || mainOutput.video_query_seed || context.userQuery,
        });
        state.video_query = videoError.videoQuery || mainOutput.video_query_seed || context.userQuery;
        const fallbackLinkUrl = videoError.videoResult?.url || videoError.videoResult?.searchUrl || '';
        state.video_data = trimVideoData({
          query: state.video_query,
          title: videoError.videoResult?.title || `相关视频：${state.video_query}`,
          summary: fallbackLinkUrl
            ? `已找到 ${state.video_query} 的候选视频，点击查看。`
            : '已识别到找视频意图，但当前未检索到可用视频链接。',
          videoUrl: '',
          linkUrl: fallbackLinkUrl,
          coverUrl: videoError.videoResult?.coverUrl || '',
        });
        state.degraded = true;
        state.degraded_reason = videoError.message || '视频解析失败';
        state.status = 'done';
        taskStore.transition(task.task_id, 'DEGRADED', { error: { message: state.degraded_reason } });
        emitFsmState(taskStore.get(task.task_id), { message: state.degraded_reason });
        timeline.push({
          stage: 'video_agent_degraded',
          latency_ms: Date.now() - startedAt,
          message: videoError.message,
        });
        if (fallbackLinkUrl) {
          emitEvent('voice_delta', { task_id: task.task_id, turn_id: turnId, text: '我找到了候选视频，先给你弹出来。', source: 'video_degraded', priority: 'normal', speakable: false });
          logOrchestrator('voice_delta_emitted', { task_id: task.task_id, source: 'video_degraded', text: '我找到了候选视频，先给你弹出来。', speakable: false });
          emitEvent('video_ready', {
            task_id: task.task_id,
            turn_id: turnId,
            ...state.video_data,
          });
          rtcProjectionState.activeNeeds = rtcProjectionState.activeNeeds.filter((item) => item !== buildRtcNeedLabel('video', rtcProjectionState.stickyHero));
          await syncRtcProjection({
            retrievedKnowledge: state.video_query || context.rag?.summary || '',
            sessionTopic: buildRtcTopicFromIntent('video', rtcProjectionState.stickyHero),
            unresolvedNeed: rtcProjectionState.activeNeeds[0] || '',
          });
        } else {
          emitEvent('voice_delta', { task_id: task.task_id, turn_id: turnId, text: '我识别到你想找视频，但这次视频检索失败了。', source: 'video_failed', priority: 'normal', speakable: false });
          logOrchestrator('voice_delta_emitted', { task_id: task.task_id, source: 'video_failed', text: '我识别到你想找视频，但这次视频检索失败了。', speakable: false });
          emitEvent('video_failed', {
            task_id: task.task_id,
            turn_id: turnId,
            query: state.video_query,
            message: videoError.message || '视频解析失败',
            linkUrl: state.video_data.linkUrl,
          });
        }
      }
      finally {
        if (slot) {
          slot.release?.();
          logOrchestrator('video_pool_released', {
            task_id: task.task_id,
            pool: intentPool.snapshot(),
          });
          emitEvent('pool_changed', intentPool.snapshot());
          slot = null;
        }
      }
      persistActiveBranchState({
        context,
        state,
        intent: state.intent,
        stickyHero: rtcProjectionState.stickyHero,
      });
      appendAgentSessionTurn(context.sessionId, {
        turn_id: turnId,
        user_query: context.userQuery,
        intent: state.intent,
        summary: state.main_summary,
        video_query: state.video_query,
        created_at: nowIso(),
      });
      appendAgentTrace({
        turn_id: turnId,
        session_id: context.sessionId,
        source: context.source,
        user_query: context.userQuery,
        orchestration_input: context.orchestrationInput || context.userQuery,
        raw_asr_text: context.rawAsrText || '',
        intent: state.intent,
        status: 'done',
        route_reason: state.route_reason,
        timeline,
        rag: buildRagTrace(context),
        output: {
          intent: state.intent,
          emotional_reply: state.emotional_reply,
          understanding_reply: state.understanding_reply || '',
          branch_wait_reply: state.branch_wait_reply || '',
          main_summary: state.main_summary || '',
          video_query: state.video_query,
          videoUrl: state.video_data?.videoUrl,
          degraded: Boolean(state.degraded),
          degraded_reason: state.degraded_reason,
          secondary_tasks: secondaryTasks.map((task) => ({
            tool: task.tool,
            query: task.query,
            priority: task.priority || 'normal',
          })),
        },
      });
      triggerAsyncMemoryWrite(context, state, {
        emotional_reply: state.emotional_reply,
        video_query: state.video_query,
        video_title: state.video_data?.title || '',
        degraded: Boolean(state.degraded),
        degraded_reason: state.degraded_reason,
      }, turnId);
      triggerReflectorAsync({
        context,
        state,
        branchOutput: {
          video_query: state.video_query || '',
          video_title: state.video_data?.title || '',
          has_video_url: Boolean(state.video_data?.videoUrl),
          degraded: Boolean(state.degraded),
          degraded_reason: state.degraded_reason,
          activated_subagents: ['video_agent'],
        },
        turnId,
        emitEvent,
      });
      if (taskStore.get(task.task_id)?.fsm_state === 'ASSET_READY') {
        taskStore.transition(task.task_id, 'DONE');
        emitFsmState(taskStore.get(task.task_id), { message: '完成' });
      }
      await executeSecondaryTasks({
        secondaryTasks,
        context,
        mainOutput,
        taskId: task.task_id,
        turnId,
        emitEvent,
      });
      rtcProjectionState.activeNeeds = [];
      await syncRtcProjection({
        retrievedKnowledge: state.video_query || context.rag?.summary || '',
        sessionTopic: buildRtcTopicFromIntent(state.intent, rtcProjectionState.stickyHero),
        unresolvedNeed: '',
      });
      emitEvent('done', state);
      return state;
    }

    throw new Error(`未知 intent: ${mainOutput.intent}`);
  } catch (error) {
    logOrchestrator('failed', {
      task_id: task.task_id,
      turn_id: turnId,
      latency_ms: Date.now() - startedAt,
      message: error.message,
      stack: error.stack,
    });
    try {
      const failedTask = taskStore.fail(task.task_id, error);
      if (failedTask) {
        emitFsmState(failedTask, { message: error.message || '任务失败' });
      }
    } catch (_) {
      // Keep original error response path if the FSM is already terminal.
    }
    const failedState = {
      ...(state || {}),
      task_id: task.task_id,
      turn_id: turnId,
      session_id: context?.sessionId || body.sessionId || 'default',
      source: context?.source || body.source || 'unknown',
      user_query: context?.userQuery || body.text || body.query || '',
      orchestration_input: context?.orchestrationInput || body.orchestrationInput || body.text || body.query || '',
      raw_asr_text: context?.rawAsrText || body.rawAsrText || '',
      status: 'failed',
      error: error.message,
    };
    timeline.push({ stage: 'failed', latency_ms: Date.now() - startedAt, message: error.message });
    appendAgentTrace({
      turn_id: turnId,
      session_id: failedState.session_id,
      source: failedState.source,
      user_query: failedState.user_query,
      orchestration_input: failedState.orchestration_input,
      raw_asr_text: failedState.raw_asr_text,
      intent: failedState.intent || 'unknown',
      status: 'failed',
      route_reason: failedState.route_reason || '',
      timeline,
      rag: context?.rag ? { query: context.rag.query, provider: context.rag.provider, hit_count: context.rag.items?.length || 0 } : null,
      output: null,
      error: { message: error.message, videoQuery: error.videoQuery, videoResult: error.videoResult },
    });
    emitEvent('error', failedState);
    return failedState;
  }
}
