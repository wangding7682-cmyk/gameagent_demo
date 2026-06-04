import { buildAgentContext } from './agentContextService.js';
import { localRouteIntent, shouldGenerateStrategyImage, buildVideoSearchSeed, extractKeywordSnippet } from './interactionAgentService.js';
import { runStrategyAgent } from './strategyAgentService.js';
import { runVideoAgent } from './videoAgentService.js';
import { appendAgentSessionTurn } from './agentSessionStateService.js';
import { appendAgentTrace } from './agentTraceLoggerService.js';
import { triggerMemoryWriterForTurn } from './memoryWriterService.js';
import { intentPool, taskStore } from './taskFsmService.js';
import { trimVideoData } from './outputTrimmerService.js';
import { detectRequestPriority, resolvePoolPriority } from './priorityDetectorService.js';

function createTurnId() {
  return `turn_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
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
  });
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
  };
}

export async function runAgentOrchestration(body = {}, emit = () => {}) {
  const startedAt = Date.now();
  const timeline = [{ stage: 'input_received', at: nowIso() }];
  const turnId = createTurnId();
  let context = null;
  let state = null;
  const task = taskStore.createTask({
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
    });
    taskStore.transition(task.task_id, 'CONTEXT_LOADING');
    emitFsmState(taskStore.get(task.task_id), { message: '正在理解问题' });
    emitEvent('voice_delta', { task_id: task.task_id, turn_id: turnId, text: '收到！', source: 'fixed_ack', priority: 'high', speakable: false });

    context = await buildAgentContext(body, turnId);
    context.taskId = task.task_id;
    timeline.push({ stage: 'context_ready', latency_ms: Date.now() - startedAt });
    logOrchestrator('context_ready', {
      task_id: task.task_id,
      latency_ms: Date.now() - startedAt,
      rag_provider: context.rag?.provider,
      rag_fallback: Boolean(context.rag?.fallback),
      rag_hit_count: context.rag?.items?.length || 0,
    });
    taskStore.transition(task.task_id, 'ROUTING');
    emitFsmState(taskStore.get(task.task_id), { message: '正在分析意图' });
    state = buildBaseState(turnId, context, taskStore.get(task.task_id));
    if (context.rag?.fallback) {
      state.degraded = true;
      state.degraded_reason = context.rag?.error?.message || '主脑前置 RAG 已降级';
    }
    emitEvent('agent_state', state);

    const userQuery = context.userQuery || '';
    const intent = localRouteIntent(userQuery);
    const needsImage = intent === 'strategy' && shouldGenerateStrategyImage(userQuery);
    const videoSeed = intent === 'video' ? buildVideoSearchSeed(userQuery) : '';
    const mainOutput = {
      task_id: task.task_id,
      turn_id: turnId,
      fsm_state: 'MAIN_REPLIED',
      intent,
      popup_mode: intent === 'video' ? 'video_search' : intent === 'strategy' ? (needsImage ? 'strategy_card' : 'strategy_text') : 'chat_reply',
      strategy_output_mode: intent === 'strategy' ? (needsImage ? 'card_with_image' : 'text_only') : 'none',
      needs_image: needsImage,
      speakable: false,
      emotional_reply: '',
      understanding_reply: '',
      branch_wait_reply: intent === 'strategy' ? '我帮你整理下' : intent === 'video' ? '我去找找' : '',
      main_summary: '',
      speech_delta: [],
      speech_streamed: false,
      route_reason: `local_route:${intent}`,
      queue_hint: '',
      tts_priority: 'silent',
      video_query_seed: videoSeed,
    };
    timeline.push({ stage: 'interaction_agent_done', latency_ms: Date.now() - startedAt });
    logOrchestrator('interaction_agent_done', {
      task_id: task.task_id,
      latency_ms: Date.now() - startedAt,
      intent: mainOutput.intent,
      popup_mode: mainOutput.popup_mode,
      strategy_output_mode: mainOutput.strategy_output_mode,
      needs_image: mainOutput.needs_image === true,
      route_reason: mainOutput.route_reason,
      source: 'local_route',
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
      speech_delta: [],
      speech_streamed: false,
      route_reason: mainOutput.route_reason,
      queue_hint: mainOutput.queue_hint || '',
      tts_priority: 'silent',
    });
    timeline.push({ stage: 'interaction_reply_emitted', latency_ms: Date.now() - startedAt, intent: mainOutput.intent });
    logOrchestrator('interaction_reply_emitted', {
      task_id: task.task_id,
      intent: mainOutput.intent,
      speech_delta_count: mainOutput.speech_delta?.length || 0,
      speech_streamed: mainOutput.speech_streamed === true,
      latency_ms: Date.now() - startedAt,
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
        rag: {
          query: context.rag?.query,
          provider: context.rag?.provider,
          hit_count: context.rag?.items?.length || 0,
          fallback: Boolean(context.rag?.fallback),
          error: context.rag?.error || null,
        },
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
            });
            const strategy = await runStrategyAgent(context, mainOutput);
            state.tactic_data = strategy.tactic_data;
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
          ...state.tactic_data,
        });
        taskStore.transition(task.task_id, 'DONE');
        emitFsmState(taskStore.get(task.task_id), { message: '完成' });
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
          rag: {
            query: context.rag?.query,
            provider: context.rag?.provider,
            hit_count: context.rag?.items?.length || 0,
            fallback: Boolean(context.rag?.fallback),
            error: context.rag?.error || null,
          },
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
        emitEvent('done', state);
        return state;
      } finally {
        slot?.release?.();
        logOrchestrator('strategy_pool_released', {
          task_id: task.task_id,
          pool: intentPool.snapshot(),
        });
        emitEvent('pool_changed', intentPool.snapshot());
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
        const video = await runVideoAgent(context, mainOutput);
        state.video_query = video.video_query;
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
        slot?.release?.();
        logOrchestrator('video_pool_released', {
          task_id: task.task_id,
          pool: intentPool.snapshot(),
        });
        emitEvent('pool_changed', intentPool.snapshot());
      }
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
        rag: {
          query: context.rag?.query,
          provider: context.rag?.provider,
          hit_count: context.rag?.items?.length || 0,
          fallback: Boolean(context.rag?.fallback),
          error: context.rag?.error || null,
        },
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
        },
      });
      triggerAsyncMemoryWrite(context, state, {
        emotional_reply: state.emotional_reply,
        video_query: state.video_query,
        video_title: state.video_data?.title || '',
        degraded: Boolean(state.degraded),
        degraded_reason: state.degraded_reason,
      }, turnId);
      if (taskStore.get(task.task_id)?.fsm_state === 'ASSET_READY') {
        taskStore.transition(task.task_id, 'DONE');
        emitFsmState(taskStore.get(task.task_id), { message: '完成' });
      }
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
