// main.js 项目总入口，集成所有模块
import { globalEventBus as EventBus } from './src/core/eventBus.js';
import { App as BaseModuleClass } from './src/core/app.js';
import { PetModule as PetModuleClass } from './src/modules/pet/index.js';
import { rtcModule as RTCModule } from './src/modules/rtc/index.js';
import { DataModule as DataModuleClass } from './src/modules/data/index.js';
import { Live2dModule } from './src/modules/live2d/index.js';
import { WorkspaceModule } from './src/modules/workspace/index.js';
import { AgentModule as AgentModuleClass } from './src/modules/agent/index.js';
import { UserKnowledgeModule as UserKnowledgeModuleClass } from './src/modules/user-knowledge/index.js';
import { UserSwitcherModule as UserSwitcherModuleClass } from './src/modules/user-switcher/index.js';

const BaseModule = new BaseModuleClass(EventBus);
const PetModule = new PetModuleClass();
const DataModule = new DataModuleClass(EventBus);
const Live2D = new Live2dModule(EventBus, BaseModule);
const Workspace = new WorkspaceModule(EventBus, BaseModule);
const AgentModule = new AgentModuleClass(EventBus);
const UserKnowledge = new UserKnowledgeModuleClass(EventBus);
const UserSwitcher = new UserSwitcherModuleClass(EventBus);
let suppressNextPetRtcOpen = false;
let lastHandledMode = null;
let pendingRtcVariant = null;
let currentRtcSession = null;
const pendingRtcSessionMessages = [];
const recentRtcSessionSyncMap = new Map();
let rtcSessionSyncChain = Promise.resolve();
let lastRtcTextQuery = '';
let lastHandledRtcSubtitleText = '';
let lastHandledRtcSubtitleAt = 0;
let lastHandledRtcSubtitleTtsText = '';
let lastHandledRtcSubtitleTtsAt = 0;
let lastHandledRtcAsrText = '';
let lastHandledRtcAsrAt = 0;
let pendingRtcSubtitleTtsTexts = [];
let pendingRtcSubtitleTtsTimer = null;
let activeRtcOrchestrationIntent = '';
let rtcRemoteAudioGuardActive = false;
let lastRtcPreconfirmText = '';
let lastRtcPreconfirmQuery = '';
let lastRtcPreconfirmKind = '';
let lastRtcPreconfirmAt = 0;
let lastRtcTtsPushedAt = 0;
let lastRtcTtsPushedText = '';
let lastRtcTtsPushedSource = '';
let rtcTtsPushChain = Promise.resolve();
let activeRtcInteractionTurnId = '';
let rtcTtsTurnGeneration = 0;
let backendAvailabilityState = {
    available: true,
    failureCount: 0,
    pausedUntil: 0,
    lastError: '',
    bannerReason: '',
    bannerSource: ''
};
let backendStatusBanner = null;

const RTC_ORCHESTRATION_SOURCES = new Set(['rtc_asr', 'rtc_text', 'rtc_subtitle', 'rtc_user_asr']);
const RTC_ASR_AFTER_TTS_GUARD_MS = 500;
const RTC_ASR_SHORT_TEXT_LIMIT = 4;

function getRtcApiBaseUrl() {
    const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
    const rtcRuntime = runtime.rtc || {};
    return String(runtime.apiBaseUrl || rtcRuntime.apiBaseUrl || 'http://127.0.0.1:8788').replace(/\/$/, '');
}

function ensureBackendStatusBanner() {
    if (typeof document === 'undefined') return null;
    if (backendStatusBanner?.isConnected) return backendStatusBanner;
    const banner = document.createElement('div');
    banner.id = 'backend-status-banner';
    banner.className = 'backend-status-banner is-hidden';
    document.body.appendChild(banner);
    backendStatusBanner = banner;
    return banner;
}

function isBackendConnectionError(error) {
    const message = String(error?.message || error || '');
    return /failed to fetch|network|connection|refused|reset|abort/i.test(message);
}

function getBackendRetryDelayMs() {
    if (backendAvailabilityState.available) return 0;
    return Math.max(0, Number(backendAvailabilityState.pausedUntil || 0) - Date.now());
}

function isBackendRequestPaused() {
    return getBackendRetryDelayMs() > 0;
}

function syncBackendAvailabilityWindowState() {
    if (typeof window === 'undefined') return;
    window.__GAME_AI_BACKEND_STATUS__ = {
        available: backendAvailabilityState.available,
        pausedUntil: backendAvailabilityState.pausedUntil,
        lastError: backendAvailabilityState.lastError,
        bannerReason: backendAvailabilityState.bannerReason,
        bannerSource: backendAvailabilityState.bannerSource
    };
}

function renderBackendStatusBanner() {
    const banner = ensureBackendStatusBanner();
    if (!banner) return;
    if (backendAvailabilityState.available) {
        banner.textContent = '';
        banner.classList.add('is-hidden');
        return;
    }
    const retryMs = getBackendRetryDelayMs();
    const retryText = retryMs > 0 ? `约 ${Math.max(1, Math.ceil(retryMs / 1000))} 秒后再试。` : '正在等待服务恢复。';
    const reasonText = backendAvailabilityState.bannerReason || '本地编排后端连接已断开。';
    banner.textContent = `${reasonText} 当前仅保留 RTC 云端对话；卡片、日志与本地会话同步已暂停，${retryText}`;
    banner.classList.remove('is-hidden');
}

function setBackendAvailability(available, payload = {}) {
    const nextAvailable = available !== false;
    const source = payload.source || '';
    const errorMessage = String(payload.error || '');
    const previousAvailable = backendAvailabilityState.available;
    if (nextAvailable) {
        backendAvailabilityState = {
            available: true,
            failureCount: 0,
            pausedUntil: 0,
            lastError: '',
            bannerReason: '',
            bannerSource: source
        };
    } else {
        const failureCount = Math.min((backendAvailabilityState.failureCount || 0) + 1, 6);
        const delayMs = Math.min(30000, 3000 * (2 ** Math.max(0, failureCount - 1)));
        backendAvailabilityState = {
            available: false,
            failureCount,
            pausedUntil: Date.now() + delayMs,
            lastError: errorMessage,
            bannerReason: payload.reason || '本地编排后端连接已断开。',
            bannerSource: source
        };
    }
    syncBackendAvailabilityWindowState();
    renderBackendStatusBanner();
    if (previousAvailable !== backendAvailabilityState.available) {
        EventBus.emit('BACKEND_CONNECTIVITY_CHANGED', {
            available: backendAvailabilityState.available,
            source,
            error: errorMessage,
            pausedUntil: backendAvailabilityState.pausedUntil,
            reason: backendAvailabilityState.bannerReason
        });
    }
}

function isRtcOriginOrchestrationActive() {
    const processingSource = String(AgentModule?._processingSource || '').toLowerCase();
    return AgentModule?.isProcessing === true && RTC_ORCHESTRATION_SOURCES.has(processingSource);
}

function shouldSuppressRtcSubtitleLocalTtsDuringOrchestration() {
    if (currentRtcSession) {
        return true;
    }

    if (!isRtcOriginOrchestrationActive()) {
        return false;
    }

    const currentIntent = String(activeRtcOrchestrationIntent || '').toLowerCase();
    if (!currentIntent) {
        return true;
    }

    return currentIntent === 'strategy' || currentIntent === 'video';
}

function shouldMuteRtcRemoteAudioDuringOrchestration() {
    if (!currentRtcSession) {
        return false;
    }

    if (rtcRemoteAudioGuardActive) {
        return true;
    }

    if (!isRtcOriginOrchestrationActive()) {
        return false;
    }

    const currentIntent = String(activeRtcOrchestrationIntent || '').toLowerCase();
    return !currentIntent || currentIntent === 'strategy' || currentIntent === 'video';
}

function invalidateRtcInteractionTurn(reason = '') {
    activeRtcInteractionTurnId = '';
    rtcTtsTurnGeneration += 1;
    rtcTtsPushChain = Promise.resolve();
    console.log('[RTC_TTS_TURN] 当前 Interaction 语音轮次失效', {
        reason,
        generation: rtcTtsTurnGeneration
    });
}

function syncRtcRemoteAudioPolicy(reason = '') {
    EventBus.emit('RTC_SET_REMOTE_AUDIO_MUTED', {
        muted: shouldMuteRtcRemoteAudioDuringOrchestration(),
        reason
    });
}

async function pushTtsToRtc(text = '', options = {}) {
    if (!currentRtcSession || !text) return;
    const apiBaseUrl = getRtcApiBaseUrl();
    try {
        const resp = await fetch(`${apiBaseUrl}/api/agent/rtc-push-tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                taskId: currentRtcSession.taskId,
                roomId: currentRtcSession.roomId || '',
                message: text,
                interruptMode: options.interruptMode ?? 1,
                command: options.command || 'ExternalTextToSpeech',
            })
        });
        const data = await resp.json().catch(() => null);
        if (!data?.ok) {
            console.warn('[RTC_PUSH_TTS] push failed:', data?.error || resp.status);
        } else {
            lastRtcTtsPushedAt = Date.now();
            lastRtcTtsPushedText = normalizeTtsCompareText(text);
            lastRtcTtsPushedSource = options.source || '';
            console.log(`[RTC_PUSH_TTS] push OK (${data.chunksSent}/${data.totalChunks} chunks) | ${text.slice(0, 60)}`);
        }
    } catch (e) {
        console.warn('[RTC_PUSH_TTS] push error:', e.message);
    }
}

function countRtcAsrMeaningfulChars(text = '') {
    return Array.from(String(text || '').replace(/[，。！？、,.!?~～\s]/g, '')).length;
}

function shouldDropRtcAsrAfterRecentTts(text = '') {
    if (!lastRtcTtsPushedAt) {
        return false;
    }
    const elapsed = Date.now() - lastRtcTtsPushedAt;
    if (elapsed > RTC_ASR_AFTER_TTS_GUARD_MS) {
        return false;
    }
    const length = countRtcAsrMeaningfulChars(text);
    if (length >= RTC_ASR_SHORT_TEXT_LIMIT) {
        return false;
    }
    console.log('[RTC_USER_ASR] TTS 后短输入丢弃，疑似回声/误触发', { text, length, elapsedMs: elapsed });
    return true;
}

function normalizeTtsCompareText(text = '') {
    return String(text || '')
        .replace(/[，。！？、,.!?~～\s]/g, '')
        .trim();
}

function inferRtcPreconfirmKind(query = '') {
    const text = String(query || '');
    if (/视频|集锦|高光|找.*视频|搜.*视频|检索.*视频|抖音|B站|b站|精彩操作|名场面|神仙操作/.test(text)) {
        return 'video';
    }
    if (/卡片|知识卡|图文|图片|生成.*卡|出图|配图/.test(text)) {
        return 'strategy_card';
    }
    return 'generic';
}

function buildRtcPreconfirmText(query = '') {
    const kind = inferRtcPreconfirmKind(query);
    if (kind === 'video') {
        return { kind, text: '收到，正在处理你的视频请求～' };
    }
    if (kind === 'strategy_card') {
        return { kind, text: '收到，正在处理你的卡片请求～' };
    }
    return { kind, text: '收到，我来帮你看看～' };
}

function markRtcPreconfirm(query = '', text = '', kind = '') {
    lastRtcPreconfirmQuery = normalizeTtsCompareText(query);
    lastRtcPreconfirmText = normalizeTtsCompareText(text);
    lastRtcPreconfirmKind = kind;
    lastRtcPreconfirmAt = Date.now();
}

function stripRtcMainReplyDuplicate(text = '') {
    const original = String(text || '').trim();
    if (!original || !lastRtcPreconfirmAt || Date.now() - lastRtcPreconfirmAt > 20000) {
        return original;
    }

    let next = original
        .replace(/^(小G[:：]\s*)?/i, '')
        .replace(/^(收到|好的|嗯嗯|明白|了解)[！!，,。.\s]*/i, '')
        .replace(/^(这就安排知识卡片|这就安排|马上整知识卡片|正在帮你生成知识卡片)[～~！!，,。.\s]*/i, '');

    if (lastRtcPreconfirmKind === 'strategy_card') {
        next = next
            .replace(/正在生成(专属)?知识卡片[，,]?(请)?稍等(片刻)?[～~。.!！\s]*/g, '')
            .replace(/知识卡片(正在)?生成中[，,]?(请)?稍等(片刻)?[～~。.!！\s]*/g, '');
    } else if (lastRtcPreconfirmKind === 'video') {
        next = next
            .replace(/正在(帮你)?(搜索|查找|检索)(相关|精彩)?视频[，,]?(请)?稍等(片刻)?[～~。.!！\s]*/g, '');
    } else if (lastRtcPreconfirmKind === 'strategy_text') {
        next = next
            .replace(/正在(帮你)?整理(策略|战术)?建议[，,]?(请)?稍等(片刻)?[～~。.!！\s]*/g, '');
    }

    next = next.replace(/\s+/g, ' ').trim();
    const normalizedNext = normalizeTtsCompareText(next);
    if (!normalizedNext || normalizedNext === lastRtcPreconfirmText) {
        console.log('[RTC_PRECONFIRM] main_reply 被预确认完全覆盖，跳过播报');
        return '';
    }
    if (normalizeTtsCompareText(original) !== normalizedNext) {
        console.log('[RTC_PRECONFIRM] main_reply 去重后播报', { before: original, after: next });
    }
    return next;
}

function isRtcAckOnlyText(text = '') {
    return /^(小G[:：]\s*)?(收到|好的|嗯嗯|明白|了解|好)[！!，,。.\s～~]*$/i.test(String(text || '').trim());
}

function hasRecentRtcPreconfirm(maxAgeMs = 20000) {
    return Boolean(lastRtcPreconfirmAt && Date.now() - lastRtcPreconfirmAt <= maxAgeMs);
}

function stripRtcRepeatedOpening(text = '') {
    return String(text || '')
        .trim()
        .replace(/^(小G[:：]\s*)?/i, '')
        .replace(/^(收到|好的|嗯嗯|明白|了解|好)[！!，,。.\s～~]*/i, '')
        .trim();
}

function dedupeRtcTtsText(text = '', source = '') {
    const original = String(text || '').trim();
    if (!original) {
        return '';
    }

    const normalized = normalizeTtsCompareText(original);
    const recentPushed = lastRtcTtsPushedAt && Date.now() - lastRtcTtsPushedAt <= 8000;
    if (recentPushed && normalized && normalized === lastRtcTtsPushedText) {
        console.log('[RTC_TTS_DEDUPE] 跳过重复 TTS', { source, text: original });
        return '';
    }

    if (source !== 'asr_preconfirm' && hasRecentRtcPreconfirm()) {
        if (isRtcAckOnlyText(original)) {
            console.log('[RTC_TTS_DEDUPE] 跳过预确认后的纯确认语', { source, text: original });
            return '';
        }

        const stripped = stripRtcRepeatedOpening(original);
        if (stripped && normalizeTtsCompareText(stripped) !== normalized) {
            console.log('[RTC_TTS_DEDUPE] 去除重复开场确认词', { source, before: original, after: stripped });
            return stripped;
        }
    }

    return original;
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTraceTime(value = '') {
    if (!value) {
        return '未知时间';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleString('zh-CN', { hour12: false });
}

let agentLogRefreshTimer = null;
let agentLogIsLoading = false;
let agentLogLastTracesKey = '';
let agentLogLastStatusKey = '';

function formatAgentTraceIntent(intent = '') {
    const intentMap = {
        strategy: '战术建议',
        video: '精彩视频',
        knowledge: '知识卡片',
        smalltalk: '闲聊',
        unknown: '待识别'
    };
    const key = String(intent || 'unknown').toLowerCase();
    return intentMap[key] || intent || '待识别';
}

// source 中文字典：把 trace.source 这种英文短码翻译成人能直接看懂的入口标签
// 覆盖三类来源：① 前端入口（rtc/chat/pet 等）② 后端入口兜底（orchestrate_*/eval_*/direct_invoke）
// ③ 后端内部子流程（orchestrator/memory_writer/reflector 等）
function formatAgentTraceSource(source = '') {
    const sourceMap = {
        // —— 前端入口（用户在哪个 UI 触发）——
        rtc_asr: '语音输入',
        rtc_text: 'RTC文本',
        chat_input: '聊天框',
        pet_tap: '戳一戳',
        agent: 'Agent面板',
        agent_main: 'Agent主流程',
        agent_video_failed: 'Agent视频失败',
        interaction_reply: '互动回复',
        demo_button: '演示按钮',
        // —— 后端入口（HTTP 进来时的兜底标签，本轮新加）——
        orchestrate_trigger: '编排-触发',
        orchestrate_stream: '编排-流式',
        orchestrate_start: '编排-同步',
        eval_silence: '评测-沉默',
        eval_qa: '评测-问答',
        direct_invoke: '未声明入口',
        // —— 后端内部子流程（哪一段代码写下的 trace）——
        orchestrator: '编排器',
        memory_writer: '记忆写入',
        reflector: '反思器',
        fixed_ack: '固定回应',
        smalltalk_summary: '闲聊摘要',
        branch_wait_reply: '等待分支',
        strategy_retry: '战术重试',
        strategy_chunk: '战术分片',
        strategy_degraded: '战术降级',
        video_ready: '视频就绪',
        video_degraded: '视频降级',
        video_failed: '视频失败',
        local_route_quick: '本地快路由',
        llm_main_agent: 'LLM主脑',
        legacy_intent_api: '旧意图接口',
        // —— 兜底 ——
        unknown: '未识别',
        unspecified: '未标注调用'  // bug 信号：开发者调 appendAgentTrace 时漏传 source
    };
    const key = String(source || 'unknown');
    return sourceMap[key] || source || '未识别';
}

function formatAgentTraceAbility(trace = {}) {
    const intent = String(trace.intent || '').toLowerCase();
    const secondaryTasks = Array.isArray(trace.output?.secondary_tasks) ? trace.output.secondary_tasks : [];
    const abilityMap = {
        strategy: '生成战术建议',
        video: '查找精彩视频',
        knowledge: '生成知识卡片',
        smalltalk: '直接对话回复'
    };
    if (abilityMap[intent]) {
        const secondaryText = secondaryTasks.length
            ? `；Secondary：${secondaryTasks.map((task) => task.tool === 'video' ? '链接/视频检索' : task.tool === 'strategy' ? '战术/卡片补充' : task.tool).join('、')}`
            : '';
        return `${abilityMap[intent]}${secondaryText}`;
    }

    const agentName = trace.agent || trace.agent_name || trace.current_agent || '';
    return agentName ? `触发 ${agentName}` : '按意图自动调度';
}

function formatAgentTraceResult(trace = {}) {
    const status = String(trace.status || '').toLowerCase();
    if (status === 'failed' || status === 'error') {
        return trace.error || trace.message || '处理失败，请查看开发详情';
    }
    if (trace.final_reply) {
        return trace.final_reply;
    }
    if (trace.result_summary) {
        return trace.result_summary;
    }
    if (trace.video_data?.query || trace.video_query) {
        return `已处理视频需求：${trace.video_data?.query || trace.video_query}`;
    }
    if (trace.knowledge_data?.title || trace.knowledge_title) {
        return `已生成知识卡片：${trace.knowledge_data?.title || trace.knowledge_title}`;
    }
    // strategy: 优先展示 tactic_data.title，其次展示 main_summary
    const intent = String(trace.intent || '').toLowerCase();
    if (intent === 'strategy') {
        const tacticTitle = trace.output?.tactic_data?.title;
        if (tacticTitle) return `战术已完成：${tacticTitle}`;
        const summary = trace.output?.main_summary;
        if (summary && summary !== '我会结合当前上下文给你一个简洁建议。') return summary;
        return '战术策略已生成';
    }
    if (status === 'done' || status === 'success' || status === 'completed') {
        return '任务已完成';
    }
    if (status === 'running' || status === 'processing') {
        return '任务处理中';
    }
    return trace.status || '等待结果';
}

function renderAgentTrace(trace = {}) {
    const timeline = Array.isArray(trace.timeline) ? trace.timeline : [];
    // 倒序查找最后一项有效的 latency_ms，代表端到端完成的总耗时
    const lastLatencyItem = [...timeline].reverse().find((item) => Number.isFinite(Number(item.latency_ms)));
    const latencyText = lastLatencyItem?.latency_ms === undefined ? '耗时未知' : `${(lastLatencyItem.latency_ms / 1000).toFixed(1)}s`;
    const orchestrationInput = String(trace.orchestration_input || trace.user_query || '').trim();
    const rawAsrText = String(trace.raw_asr_text || '').trim();
    const intentText = formatAgentTraceIntent(trace.intent);
    const abilityText = formatAgentTraceAbility(trace);
    const resultText = formatAgentTraceResult(trace);
    const detailJson = escapeHtml(JSON.stringify(trace, null, 2));
    const hasSecondary = Array.isArray(trace.output?.secondary_tasks) && trace.output.secondary_tasks.length > 0;
    const rawStatus = trace.status || 'unknown';
    const statusLabel = (hasSecondary && rawStatus === 'done')
      ? 'compound'
      : (hasSecondary && rawStatus === 'degraded')
        ? 'partial'
        : rawStatus;
    const statusTitle = (hasSecondary && rawStatus === 'done')
      ? '复合任务已完成'
      : (hasSecondary && rawStatus === 'degraded')
        ? '复合任务部分完成（主任务降级）'
        : `状态: ${rawStatus}`;
    return `
        <details class="agent-log-card">
            <summary>
                <div class="agent-log-row">
                    <span class="agent-log-chip" title="意图: ${escapeHtml(trace.intent || 'unknown')}">${escapeHtml(intentText)}</span>
                    <span class="agent-log-chip" title="${escapeHtml(statusTitle)}">${escapeHtml(statusLabel)}</span>
                    <span class="agent-log-chip" title="入口source: ${escapeHtml(trace.source || 'unknown')}">${escapeHtml(formatAgentTraceSource(trace.source))}</span>
                    <span class="agent-log-chip">${escapeHtml(latencyText)}</span>
                </div>
                <div class="agent-log-user-view">
                    <div class="agent-log-step">
                        <span class="agent-log-step-label">用户问题</span>
                        <span class="agent-log-step-value">${escapeHtml(orchestrationInput || rawAsrText || '无用户输入')}</span>
                    </div>
                    <div class="agent-log-step">
                        <span class="agent-log-step-label">识别意图</span>
                        <span class="agent-log-step-value">${escapeHtml(intentText)}</span>
                    </div>
                    <div class="agent-log-step">
                        <span class="agent-log-step-label">触发能力</span>
                        <span class="agent-log-step-value">${escapeHtml(abilityText)}</span>
                    </div>
                    <div class="agent-log-step">
                        <span class="agent-log-step-label">处理结果</span>
                        <span class="agent-log-step-value">${escapeHtml(resultText)}</span>
                    </div>
                </div>
                ${rawAsrText && rawAsrText !== orchestrationInput ? `<p class="agent-log-meta">原始 ASR：${escapeHtml(rawAsrText)}</p>` : ''}
                <p class="agent-log-meta">${escapeHtml(formatTraceTime(trace.created_at))} · ${escapeHtml(trace.turn_id || '')}</p>
            </summary>
            <details class="agent-log-dev-details">
                <summary>开发详情</summary>
                <pre class="agent-log-json">${detailJson}</pre>
            </details>
        </details>
    `;
}

function isAgentLogModalOpen() {
    const modal = document.getElementById('agent-log-modal');
    return Boolean(modal && !modal.classList.contains('is-hidden'));
}

async function loadAgentTraces(options = {}) {
    const modal = document.getElementById('agent-log-modal');
    const status = document.getElementById('agent-log-status');
    const list = document.getElementById('agent-log-list');
    const keywordInput = document.getElementById('agent-log-keyword');
    const refreshButton = document.getElementById('btn-agent-logs-refresh');
    if (!modal || !status || !list) {
        return;
    }
    if (agentLogIsLoading && !options.force) {
        return;
    }
    const silent = options.silent === true;
    const retryDelayMs = getBackendRetryDelayMs();
    if (backendAvailabilityState.available === false && retryDelayMs > 0) {
        if (!silent) {
            status.classList.add('is-error');
            status.textContent = `本地后端已断开，日志轮询已暂停，约 ${Math.max(1, Math.ceil(retryDelayMs / 1000))} 秒后再试。`;
            if (refreshButton) {
                refreshButton.disabled = false;
                refreshButton.textContent = '刷新';
            }
        }
        return;
    }

    agentLogIsLoading = true;
    if (!silent) {
        status.classList.remove('is-error');
        status.textContent = '正在加载多Agent任务日志...';
        if (options.clear !== false) {
            list.innerHTML = '';
            agentLogLastTracesKey = '';
        }
        if (refreshButton) {
            refreshButton.disabled = true;
            refreshButton.textContent = '刷新中...';
        }
    }

    try {
        const params = new URLSearchParams({
            limit: '80',
            userOnly: '1',
            groupByTurn: '1',
            _: String(Date.now())
        });
        const keyword = String(keywordInput?.value || '').trim();
        if (keyword) {
            params.set('keyword', keyword);
        }
        const response = await fetch(`${getRtcApiBaseUrl()}/api/agent/traces?${params.toString()}`, {
            cache: 'no-store'
        });
        const json = await response.json();
        if (!response.ok || !json.ok) {
            throw new Error(json.message || `日志查询失败: HTTP ${response.status}`);
        }
        setBackendAvailability(true, {
            source: 'agent_traces'
        });
        const traces = json.data?.list || [];
        const totalCount = Number(json.data?.total || traces.length);
        traces.sort((a, b) => {
            const timeA = new Date(a.created_at || a.updated_at || 0).getTime();
            const timeB = new Date(b.created_at || b.updated_at || 0).getTime();
            return timeB - timeA;
        });
        const totalText = totalCount > 0
            ? `共 ${totalCount} 条用户编排任务${totalCount > traces.length ? `，当前显示最近 ${traces.length} 条` : ''}，点击卡片可查看开发详情。`
            : '暂无多Agent任务日志。请先通过语音、文本或示例卡片触发一次能力。';
        const refreshedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const statusKey = `${traces.length}|${traces.map((t) => t.trace_id || t.turn_id).join(',')}`;
        if (!silent || statusKey !== agentLogLastStatusKey) {
            status.classList.remove('is-error');
            status.textContent = totalCount > 0
                ? `${totalText} 最近刷新：${refreshedAt}`
                : totalText;
            agentLogLastStatusKey = statusKey;
        }
        const tracesKey = traces.map((t) => `${t.trace_id || t.turn_id}:${t.updated_at || t.created_at}`).join('|');
        if (tracesKey !== agentLogLastTracesKey) {
            list.innerHTML = traces.map(renderAgentTrace).join('');
            agentLogLastTracesKey = tracesKey;
        }
    } catch (error) {
        const isNetworkError = /failed to fetch|fetch|network|connection| refused/i.test(String(error.message || error));
        if (isNetworkError) {
            setBackendAvailability(false, {
                source: 'agent_traces',
                error: error.message || String(error),
                reason: '本地编排后端连接失败。'
            });
        }
        if (!silent) {
            status.classList.add('is-error');
            status.textContent = isNetworkError
                ? `服务连接失败，日志轮询已暂停。请确认后端已启动（端口 8788），约 ${Math.max(1, Math.ceil(getBackendRetryDelayMs() / 1000))} 秒后再试。`
                : (error.message || '日志查询失败');
        }
    } finally {
        agentLogIsLoading = false;
        if (!silent && refreshButton) {
            refreshButton.disabled = false;
            refreshButton.textContent = '刷新';
        }
    }
}

function startAgentLogAutoRefresh() {
    if (agentLogRefreshTimer) {
        return;
    }
    agentLogRefreshTimer = window.setInterval(() => {
        if (!isAgentLogModalOpen()) {
            stopAgentLogAutoRefresh();
            return;
        }
        if (isBackendRequestPaused()) {
            return;
        }
        loadAgentTraces({ clear: false, silent: true }).catch(() => {});
    }, 500);
}

function stopAgentLogAutoRefresh() {
    if (agentLogRefreshTimer) {
        window.clearInterval(agentLogRefreshTimer);
        agentLogRefreshTimer = null;
    }
}

function initAgentLogViewer() {
    const openButton = document.getElementById('btn-agent-logs');
    const closeButton = document.getElementById('btn-agent-logs-close');
    const refreshButton = document.getElementById('btn-agent-logs-refresh');
    const modal = document.getElementById('agent-log-modal');
    const keywordInput = document.getElementById('agent-log-keyword');
    if (!openButton || !modal) {
        return;
    }

    openButton.addEventListener('click', async () => {
        modal.classList.remove('is-hidden');
        await loadAgentTraces({ force: true });
        startAgentLogAutoRefresh();
    });
    closeButton?.addEventListener('click', () => {
        modal.classList.add('is-hidden');
        stopAgentLogAutoRefresh();
    });
    refreshButton?.addEventListener('click', async (event) => {
        event.preventDefault();
        await loadAgentTraces({ force: true });
    });
    keywordInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            loadAgentTraces({ force: true });
        }
    });
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            modal.classList.add('is-hidden');
            stopAgentLogAutoRefresh();
        }
    });
}

function isRtcSessionMessage(payload = {}) {
    const text = String(payload.text || '').trim();
    if (!text) {
        return false;
    }

    const role = payload.role || 'assistant';
    if (!['user', 'assistant'].includes(role)) {
        return false;
    }

    const targets = Array.isArray(payload.targets) && payload.targets.length > 0
        ? payload.targets
        : ['chat'];
    return targets.includes('rtc');
}

function shouldSkipRtcSessionSync(payload = {}) {
    const sessionTaskId = currentRtcSession?.taskId || 'pending';
    const role = payload.role || 'assistant';
    const text = String(payload.text || '').trim();
    const dedupeKey = `${sessionTaskId}:${role}:${text}`;
    const now = Date.now();
    const lastSyncedAt = recentRtcSessionSyncMap.get(dedupeKey) || 0;

    if (now - lastSyncedAt < 1500) {
        return true;
    }

    recentRtcSessionSyncMap.set(dedupeKey, now);
    if (recentRtcSessionSyncMap.size > 100) {
        const expiredBefore = now - 10_000;
        for (const [key, timestamp] of recentRtcSessionSyncMap.entries()) {
            if (timestamp < expiredBefore) {
                recentRtcSessionSyncMap.delete(key);
            }
        }
    }

    return false;
}

function enqueueRtcSessionMessageSync(payload = {}) {
    if (!isRtcSessionMessage(payload)) {
        return;
    }

    if (!currentRtcSession?.taskId) {
        pendingRtcSessionMessages.push(payload);
        if (pendingRtcSessionMessages.length > 50) {
            pendingRtcSessionMessages.splice(0, pendingRtcSessionMessages.length - 50);
        }
        return;
    }

    if (shouldSkipRtcSessionSync(payload)) {
        return;
    }

    if (isBackendRequestPaused()) {
        pendingRtcSessionMessages.push(payload);
        if (pendingRtcSessionMessages.length > 50) {
            pendingRtcSessionMessages.splice(0, pendingRtcSessionMessages.length - 50);
        }
        return;
    }

    const requestBody = {
        taskId: currentRtcSession.taskId,
        role: payload.role,
        content: String(payload.text || '').trim(),
        source: payload.source || 'session_message'
    };

    rtcSessionSyncChain = rtcSessionSyncChain
        .then(async () => {
            const response = await fetch(`${getRtcApiBaseUrl()}/api/rtc/session/message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.ok) {
                throw new Error(data?.message || `同步 RTC 会话消息失败: ${response.status}`);
            }
            setBackendAvailability(true, {
                source: 'rtc_session_sync'
            });
        })
        .catch((error) => {
            const isNetworkError = isBackendConnectionError(error);
            if (isNetworkError) {
                pendingRtcSessionMessages.push(payload);
                if (pendingRtcSessionMessages.length > 50) {
                    pendingRtcSessionMessages.splice(0, pendingRtcSessionMessages.length - 50);
                }
                setBackendAvailability(false, {
                    source: 'rtc_session_sync',
                    error: error.message || String(error),
                    reason: '本地后端断线，RTC 会话同步已暂停。'
                });
                return;
            }
            console.error('[RTC Session Sync] 同步失败', {
                error,
                requestBody
            });
            EventBus.emit('RTC_SESSION_MESSAGE_SYNC_FAILED', {
                ...requestBody,
                error: error.message
            });
        });
}

function flushPendingRtcSessionMessages() {
    if (!currentRtcSession?.taskId || pendingRtcSessionMessages.length === 0 || isBackendRequestPaused()) {
        return;
    }

    const pending = pendingRtcSessionMessages.splice(0, pendingRtcSessionMessages.length);
    pending.forEach((item) => enqueueRtcSessionMessageSync(item));
}

EventBus.on('BACKEND_CONNECTIVITY_CHANGED', (payload = {}) => {
    if (payload.available) {
        flushPendingRtcSessionMessages();
        if (isAgentLogModalOpen()) {
            loadAgentTraces({ clear: false, force: true }).catch(() => {});
        }
    }
});

function emitSessionMessage(payload = {}) {
    const text = String(payload.text || '').trim();
    if (!text) {
        return;
    }

    EventBus.emit('SESSION_MESSAGE', {
        role: payload.role || 'assistant',
        text,
        source: payload.source || 'system',
        targets: Array.isArray(payload.targets) && payload.targets.length > 0
            ? payload.targets
            : ['chat']
    });
}

function stripRtcConversationStateArtifacts(text = '') {
    let input = String(text || '');
    if (!input) {
        return '';
    }

    // Remove embedded conversation state JSON blocks, commonly prefixed with "conv".
    // These contain EventTime/RoundID/Stage/TaskId/UserID and are not meant for UI or persistence.
    const looksLikeStateObject = (segment) => {
        const lower = segment.toLowerCase();
        return (
            lower.includes('"eventtime"') &&
            lower.includes('"stage"') &&
            (lower.includes('"roundid"') || lower.includes('"round_id"') || lower.includes('"roundid"')) &&
            (lower.includes('"taskid"') || lower.includes('"userid"'))
        );
    };

    const removeRanges = [];
    for (let i = 0; i < input.length; i += 1) {
        if (input[i] !== '{') {
            continue;
        }
        let depth = 0;
        let end = -1;
        for (let j = i; j < input.length; j += 1) {
            const ch = input[j];
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    end = j;
                    break;
                }
            }
        }
        if (end === -1) {
            break;
        }

        const segment = input.slice(i, end + 1);
        if (looksLikeStateObject(segment)) {
            const prefixWindowStart = Math.max(0, i - 12);
            const prefixWindow = input.slice(prefixWindowStart, i).toLowerCase();
            const convIndex = prefixWindow.lastIndexOf('conv');
            const start = convIndex >= 0 ? prefixWindowStart + convIndex : i;
            removeRanges.push([start, end + 1]);
            i = end;
        } else {
            i = end;
        }
    }

    if (removeRanges.length === 0) {
        return input.replace(/\s+/g, ' ').trim();
    }

    // Merge overlapping ranges
    removeRanges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of removeRanges) {
        if (merged.length === 0) {
            merged.push(range);
            continue;
        }
        const last = merged[merged.length - 1];
        if (range[0] <= last[1]) {
            last[1] = Math.max(last[1], range[1]);
        } else {
            merged.push(range);
        }
    }

    let output = '';
    let cursor = 0;
    for (const [start, end] of merged) {
        output += input.slice(cursor, start);
        cursor = end;
    }
    output += input.slice(cursor);

    return output
        .replace(/[\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\bconv\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripRtcStatusAndErrorArtifacts(text = '') {
    let input = String(text || '');
    if (!input) {
        return '';
    }

    const lower = input.toLowerCase();
    // Drop pure error payloads entirely.
    if (
        lower.includes('"errorinfo"') ||
        lower.includes('preparamcheck') ||
        lower.includes('unknown fields') ||
        lower.includes('errorcode') && lower.includes('reason')
    ) {
        return '';
    }

    const looksLikeVoicePrintStatus = (segmentLower) => {
        return segmentLower.includes('voiceprintstatus') || segmentLower.includes('"event"') && segmentLower.includes('voiceprint');
    };

    // Remove status JSON blocks (often prefixed by "stat" binary frame), keep the following real speech.
    // Example: "stat\\0\\0\\0<{...VoicePrintStatus...} 你好，我是小G。"
    const removeRanges = [];
    for (let i = 0; i < input.length; i += 1) {
        if (input[i] !== '{') {
            continue;
        }
        let depth = 0;
        let end = -1;
        for (let j = i; j < input.length; j += 1) {
            const ch = input[j];
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    end = j;
                    break;
                }
            }
        }
        if (end === -1) {
            break;
        }

        const segment = input.slice(i, end + 1);
        const segLower = segment.toLowerCase();
        if (looksLikeVoicePrintStatus(segLower)) {
            const prefixWindowStart = Math.max(0, i - 16);
            const prefixWindow = input.slice(prefixWindowStart, i).toLowerCase();
            const statIndex = prefixWindow.lastIndexOf('stat');
            const start = statIndex >= 0 ? prefixWindowStart + statIndex : i;
            removeRanges.push([start, end + 1]);
            i = end;
        } else {
            i = end;
        }
    }

    if (removeRanges.length === 0) {
        return input;
    }

    removeRanges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of removeRanges) {
        if (merged.length === 0) {
            merged.push(range);
            continue;
        }
        const last = merged[merged.length - 1];
        if (range[0] <= last[1]) {
            last[1] = Math.max(last[1], range[1]);
        } else {
            merged.push(range);
        }
    }

    let output = '';
    let cursor = 0;
    for (const [start, end] of merged) {
        output += input.slice(cursor, start);
        cursor = end;
    }
    output += input.slice(cursor);

    return output;
}

function stripRtcToolCallArtifacts(text = '') {
    const input = String(text || '');
    if (!input) {
        return '';
    }

    const looksLikeToolCallPrefix = (segment = '') => {
        const normalized = String(segment || '')
            .replace(/[\u0000-\u001f]+/g, ' ')
            .trim()
            .toLowerCase();
        if (/^(submit_|query_|update_|tool_|function_call|toolcall|call_[a-z_]+)/i.test(normalized)) {
            return true;
        }
        const chineseToolVerbPattern = /^(调用|正在调用|执行|正在执行|使用|通过|借助)\s*(submit_|query_|update_|tool_|function_call|toolcall|call_[a-z_]+)/i;
        if (chineseToolVerbPattern.test(normalized)) {
            return true;
        }
        const looseToolMention = /(?:调用|执行|使用|通过|借助)\s*[\w_]+|(?:submit_|query_|update_|tool_|function_call|toolcall|call_[a-z_]+)[\w_]*/i;
        return looseToolMention.test(normalized) && normalized.length < 120;
    };

    const removeRanges = [];
    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (ch !== '(' && ch !== '（') {
            continue;
        }

        const preview = input.slice(i + 1, Math.min(input.length, i + 72));
        if (!looksLikeToolCallPrefix(preview)) {
            continue;
        }

        let depth = 0;
        let end = -1;
        for (let j = i; j < input.length; j += 1) {
            const current = input[j];
            if (current === '(' || current === '（') {
                depth += 1;
            } else if (current === ')' || current === '）') {
                depth -= 1;
                if (depth === 0) {
                    end = j;
                    break;
                }
            }
        }

        if (end === -1) {
            break;
        }
        removeRanges.push([i, end + 1]);
        i = end;
    }

    if (removeRanges.length === 0) {
        return input;
    }

    let output = '';
    let cursor = 0;
    for (const [start, end] of removeRanges) {
        output += input.slice(cursor, start);
        cursor = end;
    }
    output += input.slice(cursor);

    return output
        .replace(/\s+/g, ' ')
        .replace(/^[，,;；:：\s]+/, '')
        .trim();
}

function stripRtcReasoningArtifacts(input = '') {
    if (!input) return '';
    let out = String(input);

    // 1) 去掉 <think>...</think> 整段（贪婪匹配，跨行）
    out = out.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, ' ');
    // 残留的孤立 think 起止标签也清掉
    out = out.replace(/<\/?think\b[^>]*>/gi, ' ');

    // 2) 去掉带随机后缀的 RTC 占位符（防 reasoning 泄漏）
    //    形如 <[SILENT_never_used_abcdef0123]> / [SILENT_never_used_xxx] / </think_never_used_xxx> / <think_never_used_xxx>
    out = out.replace(/<\s*\[?\s*SILENT_never_used_[0-9a-f]+\s*\]?\s*>/gi, ' ');
    out = out.replace(/\[\s*SILENT_never_used_[0-9a-f]+\s*\]/gi, ' ');
    out = out.replace(/<\s*\/?\s*think_never_used_[0-9a-f]+\s*>/gi, ' ');

    // 3) 通用兜底：任意 *_never_used_<hex> 占位符
    out = out.replace(/<\s*\/?\s*\[?\s*[A-Za-z]+_never_used_[0-9a-f]+\s*\]?\s*>/gi, ' ');

    return out;
}

function dedupRtcRepeatedSegments(input = '') {
    const text = String(input || '').trim();
    if (text.length < 16) return text;

    // 尝试整段对半重复 (A == A)
    const half = Math.floor(text.length / 2);
    for (let cut = half; cut >= Math.floor(text.length / 2) - 2 && cut > 8; cut -= 1) {
        const a = text.slice(0, cut).trim();
        const b = text.slice(cut).trim();
        if (a && a === b) return a;
    }

    // 尝试以中文标点切分后检测尾段重复
    const segs = text.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
    if (segs.length >= 2) {
        const seen = new Set();
        const kept = [];
        for (const s of segs) {
            const key = s.replace(/\s+/g, '');
            if (key.length >= 6 && seen.has(key)) continue;
            seen.add(key);
            kept.push(s);
        }
        const dedup = kept.join('');
        if (dedup && dedup.length < text.length) return dedup;
    }

    return text;
}

function normalizeRtcSessionText(text = '') {
    const noReasoning = stripRtcReasoningArtifacts(text);
    const noConv = stripRtcConversationStateArtifacts(noReasoning);
    const noStatus = stripRtcStatusAndErrorArtifacts(noConv);
    const noToolCalls = stripRtcToolCallArtifacts(noStatus);
    const flat = String(noToolCalls || '')
        .replace(/[\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return dedupRtcRepeatedSegments(flat);
}

function emitRtcSessionMessage({ role, text, source, targets }) {
    const cleaned = normalizeRtcSessionText(text);
    if (!cleaned) {
        return;
    }
    emitSessionMessage({
        role,
        text: cleaned,
        source,
        targets
    });
}

function getCurrentReplyMode() {
    if (Workspace && typeof Workspace.getCurrentReplyMode === 'function') {
        return Workspace.getCurrentReplyMode();
    }

    const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
    const rtcRuntime = runtime.rtc || {};
    const replyMode = runtime.replyMode || rtcRuntime.replyMode || 'tts';
    return ['tts', 'knowledge', 'video'].includes(replyMode) ? replyMode : 'tts';
}

function isStableRtcSubtitle(payload = {}) {
    const raw = payload?.raw || {};
    const normalized = payload || {};

    if (raw.partial === true) {
        return false;
    }
    if (raw.isFinal === false) {
        return false;
    }
    // When RTC subtitle is delivered as data[] items (BytePlus/Volc "subv" payload),
    // prefer the "definite" flag to decide whether it is final.
    if (Array.isArray(raw?.data) && raw.data.length > 0) {
        if (raw.data.some((item) => item?.definite === true)) {
            return true;
        }
        if (raw.data.some((item) => item?.definite === false)) {
            return false;
        }
    }
    if (normalized.definite === false) {
        return false;
    }
    if (normalized.paragraph === false) {
        return false;
    }
    if (typeof raw.sentenceFinish === 'boolean') {
        return raw.sentenceFinish;
    }
    if (typeof raw.finish === 'boolean') {
        return raw.finish;
    }

    return true;
}

function shouldSkipRealtimeRtcReply(payload = {}) {
    const text = String(payload?.text || '').trim();
    if (!text) {
        return true;
    }

    const now = Date.now();
    if (text === lastHandledRtcSubtitleText && now - lastHandledRtcSubtitleAt < 1500) {
        return true;
    }

    lastHandledRtcSubtitleText = text;
    lastHandledRtcSubtitleAt = now;
    return false;
}

function shouldSkipRtcSubtitleLocalTts(text = '') {
    const normalizedText = normalizeRtcSessionText(text);
    if (!normalizedText) {
        return true;
    }

    const now = Date.now();
    if (normalizedText === lastHandledRtcSubtitleTtsText && now - lastHandledRtcSubtitleTtsAt < 4000) {
        return true;
    }

    lastHandledRtcSubtitleTtsText = normalizedText;
    lastHandledRtcSubtitleTtsAt = now;
    return false;
}

function isShortRtcSubtitleForLocalTts(text = '') {
    const normalizedText = normalizeRtcSessionText(text);
    if (!normalizedText) {
        return false;
    }
    return normalizedText.length <= 18;
}

function joinRtcSubtitleTtsTexts(texts = []) {
    const normalizedTexts = texts
        .map((item) => normalizeRtcSessionText(item))
        .filter(Boolean);
    if (normalizedTexts.length === 0) {
        return '';
    }
    if (normalizedTexts.length === 1) {
        return normalizedTexts[0];
    }

    return normalizedTexts.reduce((combined, current) => {
        if (!combined) {
            return current;
        }
        if (/[。！？!?…]$/.test(combined)) {
            return `${combined}${current}`;
        }
        return `${combined}，${current}`;
    }, '');
}

async function fetchRtcSubtitleTtsAudio(text = '') {
    const cleanText = normalizeRtcSessionText(text);
    if (!cleanText) {
        return '';
    }

    try {
        const response = await fetch(`${getRtcApiBaseUrl()}/api/media/tts/audio`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: cleanText
            })
        });

        if (!response.ok) {
            return '';
        }

        const audioBlob = await response.blob();
        return URL.createObjectURL(audioBlob);
    } catch (error) {
        console.warn('[RTC_SUBTITLE] 本地 TTS 音频生成失败:', error);
        return '';
    }
}

function clearPendingRtcSubtitleLocalTts() {
    pendingRtcSubtitleTtsTexts = [];
    if (pendingRtcSubtitleTtsTimer) {
        window.clearTimeout(pendingRtcSubtitleTtsTimer);
        pendingRtcSubtitleTtsTimer = null;
    }
}

function emitRtcSubtitleLocalTts(text = '') {
    const cleanText = normalizeRtcSessionText(text);
    if (!cleanText || shouldSkipRtcSubtitleLocalTts(cleanText)) {
        return;
    }

    fetchRtcSubtitleTtsAudio(cleanText).then((audioUrl) => {
        EventBus.emit('TRIGGER_TTS', {
            text: cleanText,
            source: 'rtc_subtitle_local',
            audioUrl: audioUrl || undefined,
            forcePreview: true
        });
    }).catch(() => {
        EventBus.emit('TRIGGER_TTS', {
            text: cleanText,
            source: 'rtc_subtitle_local',
            forcePreview: true
        });
    });
}

function flushPendingRtcSubtitleLocalTts() {
    if (pendingRtcSubtitleTtsTimer) {
        window.clearTimeout(pendingRtcSubtitleTtsTimer);
        pendingRtcSubtitleTtsTimer = null;
    }
    const combinedText = joinRtcSubtitleTtsTexts(pendingRtcSubtitleTtsTexts);
    pendingRtcSubtitleTtsTexts = [];
    if (!combinedText) {
        return;
    }
    emitRtcSubtitleLocalTts(combinedText);
}

function scheduleRtcSubtitleLocalTts(text = '') {
    const cleanText = normalizeRtcSessionText(text);
    if (!cleanText) {
        return;
    }

    const MERGE_WINDOW_MS = 650;
    if (!isShortRtcSubtitleForLocalTts(cleanText)) {
        flushPendingRtcSubtitleLocalTts();
        emitRtcSubtitleLocalTts(cleanText);
        return;
    }

    if (pendingRtcSubtitleTtsTexts.length === 0) {
        pendingRtcSubtitleTtsTexts = [cleanText];
        pendingRtcSubtitleTtsTimer = window.setTimeout(() => {
            flushPendingRtcSubtitleLocalTts();
        }, MERGE_WINDOW_MS);
        return;
    }

    pendingRtcSubtitleTtsTexts.push(cleanText);
    if (pendingRtcSubtitleTtsTexts.length >= 2) {
        flushPendingRtcSubtitleLocalTts();
        return;
    }

    if (pendingRtcSubtitleTtsTimer) {
        window.clearTimeout(pendingRtcSubtitleTtsTimer);
    }
    pendingRtcSubtitleTtsTimer = window.setTimeout(() => {
        flushPendingRtcSubtitleLocalTts();
    }, MERGE_WINDOW_MS);
}

function shouldSkipDuplicateRtcAsr(text = '') {
    const normalizedText = normalizeRtcSessionText(text);
    if (!normalizedText) {
        return true;
    }

    const now = Date.now();
    if (normalizedText === lastHandledRtcAsrText && now - lastHandledRtcAsrAt < 4000) {
        console.log('[RTC_USER_ASR] 跳过重复 ASR 编排', { text: normalizedText });
        return true;
    }

    lastHandledRtcAsrText = normalizedText;
    lastHandledRtcAsrAt = now;
    return false;
}

// === RTC ASR 句聚合（合并窗口） ===
// 在前端再做一层滑动窗口，把 VAD 切碎的多段 final 句拼成一次 query。
const RTC_ASR_MERGE_WINDOW_MS = 1000;
let pendingRtcAsrSegments = [];
let pendingRtcAsrRawSegments = [];
let pendingRtcAsrTimer = null;
let pendingRtcAsrLastPayload = null;

function joinRtcAsrSegments(segments = []) {
    return segments
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .join('');
}

function clearPendingRtcAsrMerge() {
    if (pendingRtcAsrTimer) {
        clearTimeout(pendingRtcAsrTimer);
        pendingRtcAsrTimer = null;
    }
    pendingRtcAsrSegments = [];
    pendingRtcAsrRawSegments = [];
    pendingRtcAsrLastPayload = null;
}

function flushPendingRtcAsrMerge() {
    if (pendingRtcAsrTimer) {
        clearTimeout(pendingRtcAsrTimer);
        pendingRtcAsrTimer = null;
    }
    if (!pendingRtcAsrSegments.length) {
        pendingRtcAsrLastPayload = null;
        return;
    }

    const mergedText = joinRtcAsrSegments(pendingRtcAsrSegments);
    const mergedRawAsrText = joinRtcAsrSegments(pendingRtcAsrRawSegments);
    const payload = pendingRtcAsrLastPayload || {};
    pendingRtcAsrSegments = [];
    pendingRtcAsrRawSegments = [];
    pendingRtcAsrLastPayload = null;

    if (!mergedText) {
        return;
    }

    console.log('[RTC_USER_ASR] 合并窗口落地', { mergedText, windowMs: RTC_ASR_MERGE_WINDOW_MS });

    emitRtcSessionMessage({
        role: 'user',
        text: mergedRawAsrText || mergedText,
        source: payload?.source || 'rtc_user_asr',
        targets: ['chat', 'rtc']
    });

    lastRtcTextQuery = mergedText;
    if (currentRtcSession) {
        invalidateRtcInteractionTurn('new_rtc_asr');
        console.log('[RTC_PRECONFIRM] 已由 Interaction_Agent 接管首句语音，跳过本地预确认', {
            query: mergedText
        });
    }
    AgentModule.handleUserQuery(mergedText, {
        ...payload,
        text: mergedText,
        source: 'rtc_asr',
        rawAsrText: mergedRawAsrText || mergedText,
        orchestrationInput: mergedText
    });
}

function enqueueRtcUserAsrForMerge(text, payload) {
    pendingRtcAsrSegments.push(text);
    const rawText = String(payload?.rawAsrText || payload?.rawText || payload?.text || '').trim();
    pendingRtcAsrRawSegments.push(rawText || text);
    pendingRtcAsrLastPayload = payload;

    if (pendingRtcAsrTimer) {
        clearTimeout(pendingRtcAsrTimer);
    }
    pendingRtcAsrTimer = setTimeout(() => {
        flushPendingRtcAsrMerge();
    }, RTC_ASR_MERGE_WINDOW_MS);
}

function isRtcToolCallLikeSubtitle(payload = {}) {
    const raw = payload?.raw || {};
    if (Array.isArray(raw?.tool_calls) || Array.isArray(raw?.toolCalls) || Array.isArray(raw?.ToolCalls)) {
        return true;
    }

    const typeText = String(
        raw?.type || raw?.event || raw?.messageType || payload?.type || payload?.event || payload?.messageType || ''
    ).toLowerCase();
    if (/(^|[^a-z])(function|tool)(_call|calls)?([^a-z]|$)/.test(typeText)) {
        return true;
    }

    const text = String(payload?.text || '').trim();
    if (!text) {
        return false;
    }

    const chineseToolCallPattern = /（[^）]*?(?:调用|执行|使用|通过|借助)\s*(?:submit_|query_|update_|tool_|function_call|toolcall|call_[a-z_]+)[^）]*?）/i;
    if (chineseToolCallPattern.test(text)) {
        return true;
    }

    const looksJson =
        (text.startsWith('{') && text.endsWith('}')) ||
        (text.startsWith('[') && text.endsWith(']'));
    if (!looksJson) {
        return false;
    }

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.tool_calls) || Array.isArray(parsed?.toolCalls) || Array.isArray(parsed?.ToolCalls)) {
            return true;
        }
        if (parsed?.function_call || parsed?.functionCall || parsed?.functionCalling || parsed?.functionCallingConfig) {
            return true;
        }
    } catch (error) {
        if (/tool_calls|toolCalls|function_call|functionCalling/i.test(text)) {
            return true;
        }
    }

    return false;
}

function registerRtcReplyDebugTools() {
    if (typeof window === 'undefined') {
        return;
    }

    const runtime = window.__GAME_AI_RUNTIME__ || (window.__GAME_AI_RUNTIME__ = {});
    const rtcRuntime = runtime.rtc || (runtime.rtc = {});
    const debugTools = runtime.debugTools || (runtime.debugTools = {});

    debugTools.simulateRtcTextVideoQuery = (text = '给我找一个亚索逆风对线教学视频') => {
        runtime.replyMode = 'video';
        rtcRuntime.replyMode = 'video';
        EventBus.emit('RTC_SEND_TEXT_MESSAGE', {
            message: String(text || '').trim()
        });
    };

    debugTools.simulateRtcVoiceAsrVideoQuery = (text = '帮我找一个李白打野控龙教学视频') => {
        runtime.replyMode = 'video';
        rtcRuntime.replyMode = 'video';
        EventBus.emit('RTC_USER_ASR', {
            text: String(text || '').trim(),
            raw: {
                isFinal: true,
                sentenceFinish: true
            },
            source: 'debug_mock'
        });
    };

    debugTools.simulateRtcAssistantSubtitle = (text = '我已经帮你找到相关抖音视频，点击卡片即可查看。') => {
        EventBus.emit('RTC_SUBTITLE', {
            text: String(text || '').trim(),
            raw: {
                isFinal: true,
                sentenceFinish: true
            }
        });
    };
}

PetModule.init();
RTCModule.init();
DataModule.init();
BaseModule.init();
Live2D.init();
Workspace.init();
AgentModule.init();
UserKnowledge.init();
UserSwitcher.init();
registerRtcReplyDebugTools();
initAgentLogViewer();
console.log('所有模块初始化完成，事件总线已打通');

EventBus.on('AGENT_STAGE_CHANGE', (payload = {}) => {
    if (payload?.intent) {
        activeRtcOrchestrationIntent = String(payload.intent || '').toLowerCase();
    }

    const fsmState = String(payload?.fsm_state || '').toUpperCase();
    if (['DONE', 'FAILED', 'CANCELLED'].includes(fsmState)) {
        activeRtcOrchestrationIntent = '';
    }
    syncRtcRemoteAudioPolicy(`agent_stage:${fsmState || 'unknown'}`);
});

EventBus.on('AGENT_ORCHESTRATION_STARTED', (payload = {}) => {
    const source = String(payload?.source || '').toLowerCase();
    if (RTC_ORCHESTRATION_SOURCES.has(source)) {
        rtcRemoteAudioGuardActive = true;
        clearPendingRtcSubtitleLocalTts();
        syncRtcRemoteAudioPolicy(`agent_started:${source}`);
    }
});

EventBus.on('AGENT_ORCHESTRATION_FINISHED', (payload = {}) => {
    const source = String(payload?.source || '').toLowerCase();
    if (isAgentLogModalOpen()) {
        window.setTimeout(() => {
            loadAgentTraces({ clear: false, force: true }).catch(() => {});
        }, 300);
    }
    if (!RTC_ORCHESTRATION_SOURCES.has(source)) {
        return;
    }
    if (payload?.willContinue) {
        syncRtcRemoteAudioPolicy(`agent_finished_continue:${source}`);
        return;
    }
    rtcRemoteAudioGuardActive = false;
    syncRtcRemoteAudioPolicy(`agent_finished:${source}`);
});

EventBus.on('AGENT_MAIN_REPLY', (payload = {}) => {
    if (payload?.intent) {
        activeRtcOrchestrationIntent = String(payload.intent || '').toLowerCase();
    }
    syncRtcRemoteAudioPolicy(`agent_main_reply:${payload?.intent || 'unknown'}`);
});

EventBus.on('AGENT_FAILED', () => {
    activeRtcOrchestrationIntent = '';
    syncRtcRemoteAudioPolicy('agent_failed');
});

// RTC 字幕 -> 自动让桌宠播报，同时在右侧能力区标记为"信令返回"
EventBus.on('RTC_SUBTITLE', async (payload) => {
    if (isRtcToolCallLikeSubtitle(payload)) {
        console.log('[RTC_SUBTITLE] 忽略工具调用/结构化字幕内容', payload);
        return;
    }

    const cleanedAssistantText = normalizeRtcSessionText(payload?.text || '');
    const stableSubtitle = isStableRtcSubtitle(payload);

    // Do NOT display streaming subtitles as conversation logs.
    // Only commit a session log when the subtitle is final/stable.
    if (stableSubtitle) {
        emitRtcSessionMessage({
            role: 'assistant',
            text: cleanedAssistantText,
            source: 'rtc_subtitle',
            targets: ['chat', 'rtc']
        });
    }

    if (shouldSkipRealtimeRtcReply(payload)) {
        return;
    }

    const replyMode = getCurrentReplyMode();
    if (replyMode === 'video') {
        lastRtcTextQuery = '';
        return;
    }
    if (replyMode === 'knowledge') {
        lastRtcTextQuery = '';
        return;
    }
    if (payload?.source === 'rtc_subtitle') {
        // RTC subtitles are already shown in the conversation box.
        // Avoid generating extra "语音播报" ability cards for the same content.
        return;
    }
    // Agent 编排后，RTC 助手字幕只负责展示和存档，不再反向触发知识卡片/视频能力。
    lastRtcTextQuery = '';
});

EventBus.on('CHAT_REPLY', (payload) => {
    emitSessionMessage({
        role: payload?.role || 'assistant',
        text: payload?.text,
        source: payload?.source || 'chat_reply',
        targets: payload?.targets || ['chat']
    });
});

EventBus.on('SESSION_MESSAGE', (payload) => {
    enqueueRtcSessionMessageSync(payload);
});

EventBus.on('RTC_AGENT_READY', (payload) => {
    currentRtcSession = {
        roomId: payload?.roomId || '',
        taskId: payload?.taskId || '',
        userId: payload?.userId || ''
    };
    AgentModule?.setRtcCustomLlmMode?.(true);
    flushPendingRtcSessionMessages();
    syncRtcRemoteAudioPolicy('rtc_agent_ready');
});

EventBus.on('RTC_DISCONNECTED', () => {
    currentRtcSession = null;
    pendingRtcSessionMessages.length = 0;
    recentRtcSessionSyncMap.clear();
    lastRtcTextQuery = '';
    activeRtcOrchestrationIntent = '';
    clearPendingRtcSubtitleLocalTts();
    clearPendingRtcAsrMerge();
    lastHandledRtcSubtitleTtsText = '';
    lastHandledRtcSubtitleTtsAt = 0;
    lastHandledRtcAsrText = '';
    lastHandledRtcAsrAt = 0;
    lastRtcTtsPushedAt = 0;
    lastRtcTtsPushedText = '';
    lastRtcTtsPushedSource = '';
    activeRtcInteractionTurnId = '';
    rtcTtsTurnGeneration += 1;
    rtcTtsPushChain = Promise.resolve();
    rtcRemoteAudioGuardActive = false;
    AgentModule?.setRtcCustomLlmMode?.(false);
    syncRtcRemoteAudioPolicy('rtc_disconnected');
});

EventBus.on('RTC_INTERACTION_TURN_INVALIDATE', (payload = {}) => {
    invalidateRtcInteractionTurn(payload?.reason || 'turn_invalidate');
});

EventBus.on('RTC_INTERACTION_TURN_STARTED', (payload = {}) => {
    const turnId = String(payload?.turnId || payload?.turn_id || '');
    if (!turnId) return;
    if (turnId !== activeRtcInteractionTurnId) {
        activeRtcInteractionTurnId = turnId;
        rtcTtsTurnGeneration += 1;
        rtcTtsPushChain = Promise.resolve();
        console.log('[RTC_TTS_TURN] 新 Interaction 语音轮次开始', {
            turnId,
            generation: rtcTtsTurnGeneration,
            taskId: payload?.taskId || ''
        });
    }
});

EventBus.on('RTC_PUSH_TTS', async (payload) => {
    console.log('[RTC_PUSH_TTS] 云端 Bot 已接管 TTS，本地推送已禁用', {
        source: payload?.source || '',
        text: String(payload?.text || '').slice(0, 40)
    });
});

// 知识库结果 -> 自动让桌宠渲染图文，同时记录为"模型返回"
EventBus.on('KNOWLEDGE_RESULT', (payload) => {
    const content = payload.list ? payload.list.join('\n') : '';
    EventBus.emit('TRIGGER_KNOWLEDGE', {
        title: '知识库查询结果',
        content,
        list: payload.list
    });
    EventBus.emit('CHAT_REPLY', {
        text: content || '我已经返回了一条新的知识结果。'
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        source: 'model',
        ability: '知识卡片',
        text: content || '模型返回了新的知识结果。'
    });
});

EventBus.on('MEMORY_RESULT', (payload) => {
    const content = payload.list ? payload.list.join('\n') : '';
    EventBus.emit('CHAT_REPLY', {
        text: content || '我已经返回了一组新的记忆结果。'
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        source: 'model',
        ability: '记忆库检索',
        text: content || '模型返回了新的记忆结果。'
    });
});

EventBus.on('RTC_SEND_TEXT_MESSAGE', (payload) => {
    lastRtcTextQuery = String(payload?.message || payload?.text || '').trim();
});

EventBus.on('RTC_SEND_TEXT_MESSAGE', async (payload) => {
    const message = String(payload?.message || payload?.text || '').trim();
    if (!message) {
        return;
    }

    AgentModule.handleUserQuery(message, { ...payload, source: 'rtc_text' });
});

EventBus.on('RTC_USER_ASR', async (payload) => {
    const stableAsr = isStableRtcSubtitle(payload);
    if (!stableAsr) {
        return;
    }

    const rawAsrText = String(payload?.text || '').trim();
    const text = normalizeRtcSessionText(rawAsrText);
    if (!text) {
        return;
    }
    if (shouldSkipDuplicateRtcAsr(text)) {
        return;
    }

    console.log('[RTC_USER_ASR] 捕获到用户语音识别文本', payload);
    if (shouldDropRtcAsrAfterRecentTts(text)) {
        return;
    }

    // 合并窗口：火山 ASR 会按 VAD 切句（end_window_size=500ms），
    // 用户一句话中间停顿一下就会被切成多段。
    // 这里在前端再叠加一个 1000ms 的滑动窗口，
    // 把短间隔的连续句拼接成一次 query 再交给 AgentModule 编排，
    // 避免编排日志被切碎、避免 LLM 多次重复回答同一意图。
    enqueueRtcUserAsrForMerge(text, {
        ...payload,
        rawAsrText,
        rawText: rawAsrText
    });
});
// 用户问题 -> 统一进入 Agent 编排，只有 Main_Agent 识别到直接意图才触发卡片/视频。
EventBus.on('USER_SEND_QUERY', async (payload) => {
    EventBus.emit('ABILITY_FEEDBACK', {
        source: 'ui',
        ability: payload?.source === 'pet_tap' ? '纸片人互动' : '聊天提问',
        text: payload.text
    });
    const text = payload?.source === 'pet_tap'
        ? '用户轻触了纸片人，请结合上下文给一句简短自然的互动回应。'
        : payload?.text;
    AgentModule.handleUserQuery(text, payload);
});

EventBus.on('SESSION_RECORD_SAVED', (payload) => {
    EventBus.emit('CHAT_REPLY', {
        text: `会话记录已保存到本地，共 ${payload.count} 条。`
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        ability: '会话记录保存',
        text: `本地保存成功，当前累计 ${payload.count} 条记录。`
    });
});

EventBus.on('SESSION_RECORD_SAVE_FAILED', (payload) => {
    EventBus.emit('CHAT_REPLY', {
        text: payload.message || '会话记录保存失败。'
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        ability: '会话记录保存',
        text: payload.message || '会话记录保存失败。'
    });
});

EventBus.on('MEMORY_SAVED', (payload) => {
    EventBus.emit('CHAT_REPLY', {
        text: `记忆已保存，当前来源为 ${payload.source || 'mock'}。`
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        ability: '记忆库保存',
        text: payload.record?.summary || '已保存一条新的记忆记录。'
    });
});

EventBus.on('MEMORY_SAVE_FAILED', (payload) => {
    EventBus.emit('CHAT_REPLY', {
        text: payload.message || '记忆保存失败。'
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        ability: '记忆库保存',
        text: payload.message || '记忆保存失败。'
    });
});

EventBus.on('KNOWLEDGE_HEALTH_RESULT', (payload) => {
    const probeText = payload.probe?.preview ? `，示例返回：${payload.probe.preview}` : '';
    EventBus.emit('CHAT_REPLY', {
        text: `知识库服务检测成功，当前模式为 ${payload.config?.apiStyle || 'unknown'}，连通状态正常${probeText}`
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        source: 'model',
        ability: '知识库健康检查',
        text: `检测成功，接口 ${payload.config?.endpointPath || ''} 可用，命中 ${payload.probe?.hitCount ?? 0} 条结果。`
    });
});

EventBus.on('KNOWLEDGE_HEALTH_FAILED', (payload) => {
    EventBus.emit('CHAT_REPLY', {
        text: payload.message || '知识库服务检测失败。'
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        ability: '知识库健康检查',
        text: payload.message || '知识库服务检测失败。'
    });
});

EventBus.on('MEMORY_HEALTH_RESULT', (payload) => {
    EventBus.emit('CHAT_REPLY', {
        text: `记忆库状态正常，当前模式为 ${payload.config?.apiStyle || payload.provider || 'mock'}。`
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        source: 'model',
        ability: '记忆库健康检查',
        text: `检测成功，可用状态：${payload.reachable === false ? '不可达' : '正常'}。`
    });
});

EventBus.on('MEMORY_HEALTH_FAILED', (payload) => {
    EventBus.emit('CHAT_REPLY', {
        text: payload.message || '记忆库检测失败。'
    });
    EventBus.emit('ABILITY_FEEDBACK', {
        ability: '记忆库健康检查',
        text: payload.message || '记忆库检测失败。'
    });
});

// 旧 INTENT_DETECTED 分支已下线：正式入口统一走 AgentModule -> /api/agent/orchestrate/stream。

// 统一模式桥接
EventBus.on('SUPPRESS_NEXT_PET_RTC_OPEN', () => {
    suppressNextPetRtcOpen = true;
});

function hasActiveRtcSession() {
    return Boolean(
        RTCModule &&
        (RTCModule.rtcEngine || RTCModule.isJoined || RTCModule.isJoinInFlight || RTCModule.isLeaving)
    );
}

function openRtcVariant(variant) {
    if (variant === 'screen') {
        EventBus.emit('ENTER_PET_MODE');
        EventBus.emit('ENTER_RTC_MODE', { variant: 'screen' });
        EventBus.emit('OPEN_RTC_MODAL', { variant: 'screen' });
        EventBus.emit('CLOSE_CHAT_MODAL');
        return;
    }

    EventBus.emit('ENTER_RTC_MODE', { variant: 'voice' });
    EventBus.emit('OPEN_RTC_MODAL', { variant: 'voice' });
    EventBus.emit('CLOSE_CHAT_MODAL');
}

function queueRtcVariantSwitch(variant) {
    pendingRtcVariant = variant;
    if (!RTCModule?.isLeaving) {
        EventBus.emit('LEAVE_RTC_MODE');
    }
    EventBus.emit('CLOSE_RTC_MODAL');
    EventBus.emit('CLOSE_CHAT_MODAL');
}

EventBus.on('MODE_CHANGED', (mode) => {
    const previousMode = lastHandledMode;
    lastHandledMode = mode;
    if (mode === 'pet') {
        EventBus.emit('ENTER_PET_MODE');
        if (suppressNextPetRtcOpen) {
            suppressNextPetRtcOpen = false;
            EventBus.emit('CLOSE_CHAT_MODAL');
            EventBus.emit('CLOSE_RTC_MODAL');
            return;
        }
        if (previousMode === 'rtc' && hasActiveRtcSession()) {
            queueRtcVariantSwitch('voice');
            return;
        }
        openRtcVariant('voice');
        return;
    }

    if (mode === 'text_chat') {
        pendingRtcVariant = null;
        EventBus.emit('EXIT_PET_MODE');
        EventBus.emit('LEAVE_RTC_MODE');
        EventBus.emit('OPEN_CHAT_MODAL');
        EventBus.emit('CLOSE_RTC_MODAL');
        return;
    }

    if (mode === 'rtc') {
        if (previousMode === 'pet' && hasActiveRtcSession()) {
            queueRtcVariantSwitch('screen');
            return;
        }
        openRtcVariant('screen');
    }
});

EventBus.on('RTC_DISCONNECTED', () => {
    if (!pendingRtcVariant) {
        return;
    }

    const nextVariant = pendingRtcVariant;
    pendingRtcVariant = null;
    openRtcVariant(nextVariant);
});

// --- 新增：屏幕共享指令桥接 ---
EventBus.on('rtc_start_screen_share', () => {
    if (RTCModule) {
        RTCModule.startShareScreen();
    }
});

EventBus.on('rtc_stop_screen_share', () => {
    if (RTCModule) {
        RTCModule.stopShareScreen();
    }
});

// --- 新增：游戏画面共享（getDisplayMedia + RTC publishScreen） ---
EventBus.on('rtc_start_game_screen_share', () => {
    if (RTCModule) {
        RTCModule.startShareGameScreen();
    }
});

EventBus.on('rtc_stop_game_screen_share', () => {
    if (RTCModule) {
        RTCModule.stopShareGameScreen();
    }
});

(function bindGameShareButton() {
    const bind = () => {
        const btn = document.getElementById('rtc-share-game');
        if (!btn) return;
        btn.addEventListener('click', () => {
            if (!RTCModule) {
                console.warn('[main] RTCModule 未初始化');
                return;
            }
            if (RTCModule.isScreenSharing) {
                EventBus.emit('rtc_stop_game_screen_share');
            } else {
                EventBus.emit('rtc_start_game_screen_share');
            }
        });
        EventBus.on('rtc_screen_share_started', (payload) => {
            if (payload?.sourceType === 'display') {
                btn.textContent = '停止共享游戏画面';
                btn.classList.add('danger');
                btn.classList.remove('primary');
            }
        });
        EventBus.on('rtc_screen_share_stopped', () => {
            btn.textContent = '共享游戏画面';
            btn.classList.remove('danger');
            btn.classList.add('primary');
        });
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();

function initReadmeViewer() {
    const openBtn = document.getElementById('btn-readme');
    const closeBtn = document.getElementById('btn-readme-close');
    const modal = document.getElementById('readme-modal');
    const body = document.getElementById('readme-body');
    if (!openBtn || !modal || !body) return;

    let loaded = false;

    function escapeHtml(text) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return String(text).replace(/[&<>"']/g, (c) => map[c]);
    }

    function renderInline(text) {
        var t = escapeHtml(text);
        t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
        t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
        t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        return t;
    }

    function renderMarkdown(md) {
        md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var lines = md.split('\n');
        var out = [];
        var i = 0;
        var buf = [];
        var tableRows = [];
        var inTable = false;
        var inCodeBlock = false;
        var codeLang = '';
        var codeLines = [];
        var listStack = [];

        function fail(msg) {
            throw new Error(msg + ' (行 ' + (i + 1) + ': ' + JSON.stringify(lines[i].substring(0, 60)) + ')');
        }

        function flushBuf() {
            if (buf.length === 0) return;
            try {
                out.push('<p>' + buf.map(renderInline).join('<br>') + '</p>');
            } catch (e) {
                fail('flushBuf 渲染失败: ' + e.message);
            }
            buf = [];
        }

        function flushTable() {
            if (tableRows.length === 0) return;
            try {
                var headerRow = tableRows[0];
                var bodyRows = tableRows.length > 1 && /^[-: |]+$/.test(tableRows[1].trim()) ? tableRows.slice(2) : tableRows.slice(1);
                var html = '<table><thead><tr>';
                var cells = headerRow.split('|').filter(function(_, j, arr) { return j > 0 && j < arr.length - 1; });
                for (var ci = 0; ci < cells.length; ci++) {
                    html += '<th>' + renderInline(cells[ci].trim()) + '</th>';
                }
                html += '</tr></thead><tbody>';
                for (var ri = 0; ri < bodyRows.length; ri++) {
                    html += '<tr>';
                    var bCells = bodyRows[ri].split('|').filter(function(_, j, arr) { return j > 0 && j < arr.length - 1; });
                    for (var cj = 0; cj < bCells.length; cj++) {
                        html += '<td>' + renderInline(bCells[cj].trim()) + '</td>';
                    }
                    html += '</tr>';
                }
                html += '</tbody></table>';
                out.push(html);
            } catch (e) {
                fail('flushTable 渲染失败: ' + e.message);
            }
            tableRows = [];
            inTable = false;
        }

        function closeLists(depth) {
            depth = Math.max(0, depth);
            while (listStack.length > depth) {
                var tag = listStack.pop();
                out.push(tag === 'ol' ? '</ol>' : '</ul>');
            }
        }

        function openList(tag, depth) {
            if (listStack.length < depth) {
                for (var d = listStack.length; d < depth; d++) {
                    listStack.push(tag);
                    out.push(tag === 'ol' ? '<ol>' : '<ul>');
                }
            } else if (listStack.length === depth && listStack[listStack.length - 1] !== tag) {
                closeLists(depth - 1);
                listStack.push(tag);
                out.push(tag === 'ol' ? '<ol>' : '<ul>');
            }
        }

        while (i < lines.length) {
            try {
            var raw = lines[i];
            var trimmed = raw.trim();

            if (inCodeBlock) {
                if (/^```/.test(trimmed)) {
                    out.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
                    codeLines = [];
                    inCodeBlock = false;
                } else {
                    codeLines.push(raw);
                }
                i++;
                continue;
            }

            if (/^```/.test(trimmed)) {
                flushBuf();
                flushTable();
                closeLists(0);
                inCodeBlock = true;
                codeLang = trimmed.replace(/^```\s*/, '');
                codeLines = [];
                i++;
                continue;
            }

            if (/^\|.+\|$/.test(trimmed)) {
                flushBuf();
                closeLists(0);
                if (!inTable) {
                    inTable = true;
                    tableRows = [];
                }
                tableRows.push(trimmed);
                i++;
                continue;
            } else if (inTable) {
                flushTable();
            }

            if (trimmed === '') {
                flushBuf();
                i++;
                continue;
            }

            if (/^(---|\*\*\*|___)\s*$/.test(trimmed)) {
                flushBuf();
                flushTable();
                closeLists(0);
                out.push('<hr>');
                i++;
                continue;
            }

            if (/^#{1,3} /.test(trimmed)) {
                flushBuf();
                flushTable();
                closeLists(0);
                var hMatch = trimmed.match(/^(#{1,3}) (.+)$/);
                var level = hMatch[1].length;
                out.push('<h' + level + '>' + renderInline(hMatch[2]) + '</h' + level + '>');
                i++;
                continue;
            }

            if (/^> /.test(trimmed)) {
                flushBuf();
                flushTable();
                closeLists(0);
                var bqLines = [];
                while (i < lines.length && /^> /.test(lines[i].trim())) {
                    bqLines.push(lines[i].trim().replace(/^> /, ''));
                    i++;
                }
                out.push('<blockquote>' + bqLines.map(renderInline).join('<br>') + '</blockquote>');
                continue;
            }

            var olMatch = trimmed.match(/^(\d+)\. (.+)$/);
            var ulMatch = trimmed.match(/^[-*] (.+)$/);
            if (olMatch || ulMatch) {
                flushBuf();
                flushTable();
                var indent = raw.match(/^(\s*)/)[1].length;
                var depth = Math.floor(indent / 2) + 1;
                var tag = olMatch ? 'ol' : 'ul';
                var content = olMatch ? olMatch[2] : ulMatch[1];
                openList(tag, depth);
                out.push('<li>' + renderInline(content) + '</li>');
                i++;
                continue;
            }

            if (listStack.length > 0 && !/^\s/.test(raw)) {
                closeLists(0);
            }

            buf.push(trimmed);
            i++;
            } catch (e) {
                fail('主循环渲染失败: ' + e.message);
            }
        }

        flushBuf();
        flushTable();
        closeLists(0);

        return out.join('\n');
    }

    async function loadReadme() {
        body.innerHTML = '<div class="readme-loading">加载中...</div>';
        try {
            var endpoints = ['/api/readme', '/README.github.md', '/README.md'];
            var md = '';
            var lastError = null;

            for (var ei = 0; ei < endpoints.length; ei++) {
                try {
                    const resp = await fetch(endpoints[ei], { cache: 'no-store' });
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    md = await resp.text();
                    break;
                } catch (error) {
                    lastError = error;
                }
            }

            if (!md) {
                throw lastError || new Error('README 加载失败');
            }

            body.innerHTML = renderMarkdown(md);
            loaded = true;
        } catch (e) {
            console.error('[README] 渲染失败:', e.stack || e.message);
            body.innerHTML = '<div class="readme-error">加载 README 失败：' + escapeHtml(e.message) + '</div>';
        }
    }

    openBtn.addEventListener('click', () => {
        modal.classList.remove('is-hidden');
        if (!loaded) loadReadme();
    });

    closeBtn.addEventListener('click', () => {
        modal.classList.add('is-hidden');
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('is-hidden');
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('is-hidden')) {
            modal.classList.add('is-hidden');
        }
    });
}

initReadmeViewer();

export { BaseModule as app, EventBus as eventBus };
