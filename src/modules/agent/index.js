import { globalEventBus } from '../../core/eventBus.js';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8788';

function getRuntimeConfig() {
    const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
    const rtcRuntime = runtime.rtc || {};
    return {
        apiBaseUrl: String(runtime.apiBaseUrl || rtcRuntime.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, ''),
        sessionId: runtime.agentSessionId || rtcRuntime.userId || runtime.rtcUserId || 'default'
    };
}

function stripBracketDescriptions(text = '') {
    return String(text)
        .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function computeTextSimilarity(a = '', b = '') {
    const sa = String(a).replace(/\s+/g, '');
    const sb = String(b).replace(/\s+/g, '');
    if (!sa || !sb) return 0;
    if (sa === sb) return 1;
    const shortLen = Math.min(sa.length, sb.length);
    const longLen = Math.max(sa.length, sb.length);
    const bigramsA = new Set();
    const bigramsB = new Set();
    for (let i = 0; i < sa.length - 1; i++) { bigramsA.add(sa[i] + sa[i + 1]); }
    for (let i = 0; i < sb.length - 1; i++) { bigramsB.add(sb[i] + sb[i + 1]); }
    const intersection = [...bigramsA].filter((bg) => bigramsB.has(bg)).length;
    const union = bigramsA.size + bigramsB.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;
    const lenRatio = shortLen / longLen;
    const prefixMatch = sa.length > 3 && sb.length > 3 && (sa.startsWith(sb.substring(0, Math.min(4, sb.length))) || sb.startsWith(sa.substring(0, Math.min(4, sa.length)))) ? 0.15 : 0;
    return Math.min(jaccard * 0.8 + lenRatio * 0.2 + prefixMatch, 1);
}

const DEDUP_THRESHOLD = 0.60;
const DEDUP_WINDOW_MS = 15000;

const SSE_EVENT_TYPES = [
    'task_created', 'fsm_state', 'interaction_speech_delta',
    'interaction_reply', 'main_reply', 'main_reply_preview',
    'voice_delta', 'strategy_ready', 'card_ready',
    'video_ready', 'video_failed', 'error', 'done',
    'task_queued', 'pool_changed', 'agent_state',
];

export class AgentModule {
    constructor(eventBus) {
        this.eventBus = eventBus || globalEventBus;
        this.isProcessing = false;
        this._forcePreviewNextCard = false;
        this._forceAbilityPreview = false;
        this._strategyLoadingEmitted = false;
        this._videoLoadingEmitted = false;
        this._lastRequestKey = '';
        this._lastRequestAt = 0;
        this._processingQuery = '';
        this._processingStartedAt = 0;
        this._processingSource = '';
        this._requestQueue = [];
        this._strategySummaryByTaskId = new Map();
        this._rtcCustomLlmMode = false;
        this._activeInteractionTurnId = '';
        this._eventSource = null;
        this._eventSourceReconnectTimer = null;
        this._currentOrchestrationId = 0;
        this._currentIntent = '';
        this._currentTaskId = '';
    }

    setRtcCustomLlmMode(enabled) {
        this._rtcCustomLlmMode = Boolean(enabled);
        console.log('[AgentModule] RTC CustomLLM TTS 模式:', this._rtcCustomLlmMode ? 'ON (TTS 走 RTC 通道)' : 'OFF (TTS 走本地)');
    }

    isRtcCustomLlmMode() {
        return this._rtcCustomLlmMode;
    }

    init() {
        console.log('[AgentModule] Agent 编排模块已初始化');
        this._initPersistentSse();
        this._initVisibilityHandler();
    }

    _initVisibilityHandler() {
        if (typeof document === 'undefined') return;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && (!this._eventSource || this._eventSource.readyState === EventSource.CLOSED)) {
                console.log('[AgentModule] 页面恢复可见，重建 SSE 连接');
                this._initPersistentSse();
            }
        });
    }

    _initPersistentSse() {
        const runtime = getRuntimeConfig();
        const sessionId = this.getSessionId();
        const url = `${runtime.apiBaseUrl}/api/agent/orchestrate/events?sessionId=${encodeURIComponent(sessionId)}`;

        const connect = () => {
            if (this._eventSource) {
                try { this._eventSource.close(); } catch (_) {}
                this._eventSource = null;
            }
            console.log('[AgentModule] 正在建立持久 SSE 连接...');
            const es = new EventSource(url);
            this._eventSource = es;

            es.addEventListener('open', () => {
                console.log('[AgentModule] 持久 SSE 连接已建立');
            });

            es.addEventListener('error', () => {
                if (es.readyState === EventSource.CLOSED) {
                    console.warn('[AgentModule] SSE 连接已关闭，3s 后重连');
                    try { es.close(); } catch (_) {}
                    this._eventSource = null;
                    clearTimeout(this._eventSourceReconnectTimer);
                    this._eventSourceReconnectTimer = setTimeout(connect, 3000);
                }
            });

            for (const eventType of SSE_EVENT_TYPES) {
                es.addEventListener(eventType, (e) => {
                    try {
                        const data = JSON.parse(e.data);
                        if (eventType === 'done') {
                            this._onOrchestrationDone(data);
                        } else {
                            this.handleAgentEvent(eventType, data);
                        }
                    } catch (err) {
                        console.warn(`[AgentModule] SSE ${eventType} 解析失败:`, err);
                    }
                });
            }
        };

        connect();
    }

    _onOrchestrationDone(data = {}) {
        this.isProcessing = false;
        this._processingQuery = '';
        this._processingStartedAt = 0;
        this._processingSource = '';
        this.eventBus.emit('AGENT_ORCHESTRATION_FINISHED', {
            orchestrationId: this._currentOrchestrationId,
            source: this._processingSource || 'unknown',
            text: this._processingQuery,
            pendingQueueCount: this._requestQueue.length,
            willContinue: this._requestQueue.length > 0,
        });
        if (this._requestQueue.length > 0) {
            this._drainQueue().catch((err) => {
                console.warn('[AgentModule] 队列排出异常:', err);
            });
        }
    }

    getSessionId(payload = {}) {
        const runtime = getRuntimeConfig();
        let cached = '';
        try {
            cached = window.localStorage.getItem('game_ai_agent_session_id') || '';
            if (!cached) {
                cached = runtime.sessionId || `web_${Math.floor(Math.random() * 1000000)}`;
                window.localStorage.setItem('game_ai_agent_session_id', cached);
            }
        } catch (_) {
            cached = runtime.sessionId || 'default';
        }
        return payload.sessionId || payload.userId || cached;
    }

    async handleUserQuery(text, payload = {}) {
        const cleanText = String(text || '').trim();
        if (!cleanText) {
            return;
        }

        const requestKey = `${payload.source || 'unknown'}:${cleanText}`;
        const now = Date.now();
        if (requestKey === this._lastRequestKey && now - this._lastRequestAt < 4000) {
            console.log('[AgentModule] 跳过重复编排请求', { source: payload.source, text: cleanText });
            return;
        }
        this._lastRequestKey = requestKey;
        this._lastRequestAt = now;

        if (this.isProcessing && this._processingQuery) {
            const similarity = computeTextSimilarity(cleanText, this._processingQuery);
            if (similarity >= DEDUP_THRESHOLD) {
                console.log(`[AgentModule] 任务去重：与当前编排查询相似 (${(similarity * 100).toFixed(0)}%)`, {
                    newQuery: cleanText,
                    processingQuery: this._processingQuery,
                    source: payload.source
                });
                return;
            }
            const rtcSources = new Set(['rtc_asr', 'rtc_text', 'rtc_subtitle', 'rtc_user_asr']);
            if (rtcSources.has(payload.source)) {
                this._enqueueRequest(cleanText, payload, 'normal');
                console.log('[AgentModule] RTC 信号排队：当前编排进行中', { source: payload.source, text: cleanText, queueLength: this._requestQueue.length });
                return;
            }
            if (!payload.highPriority) {
                this._enqueueRequest(cleanText, payload, 'normal');
                console.log('[AgentModule] 请求排队：当前编排进行中，新请求入队等待', { text: cleanText, queueLength: this._requestQueue.length });
                return;
            }
        }

        this._triggerOrchestration(cleanText, payload);
    }

    _enqueueRequest(text, payload = {}, priority = 'normal') {
        this._requestQueue.push({ text, payload, priority, enqueuedAt: Date.now() });
        if (this._requestQueue.length > 10) {
            this._requestQueue.shift();
        }
    }

    async _drainQueue() {
        if (this._isDrainingQueue) {
            return;
        }
        this._isDrainingQueue = true;
        try {
            while (this._requestQueue.length > 0) {
                const next = this._requestQueue.shift();
                if (!next) break;
                const age = Date.now() - next.enqueuedAt;
                if (age > DEDUP_WINDOW_MS) {
                    console.log('[AgentModule] 排队请求已过期，跳过', { text: next.text, ageMs: age });
                    continue;
                }
                const similarity = this._processingQuery ? computeTextSimilarity(next.text, this._processingQuery) : 0;
                if (similarity >= DEDUP_THRESHOLD) {
                    console.log(`[AgentModule] 排队请求去重：与当前查询相似 (${(similarity * 100).toFixed(0)}%)`, { text: next.text });
                    continue;
                }
                await this._triggerOrchestration(next.text, next.payload);
            }
        } finally {
            this._isDrainingQueue = false;
        }
    }

    async _triggerOrchestration(cleanText, payload = {}) {
        const runtime = getRuntimeConfig();
        this.isProcessing = true;
        this._processingQuery = cleanText;
        this._processingStartedAt = Date.now();
        this._processingSource = payload.source || 'unknown';
        this._orchestrationId = (this._orchestrationId || 0) + 1;
        const orchestrationId = this._orchestrationId;
        this._currentOrchestrationId = orchestrationId;
        this._forcePreviewNextCard = payload.forceMock === true;
        this._forceAbilityPreview = payload.forcePreview === true ||
            payload.forceMock === true ||
            payload.source !== 'pet_tap';
        this._strategyLoadingEmitted = false;
        this._videoLoadingEmitted = false;

        this.eventBus.emit('ABILITY_FEEDBACK', {
            source: payload.source || 'agent',
            ability: 'Agent 编排',
            text: `开始处理：${cleanText}`,
            orchestrationId
        });
        this.eventBus.emit('AGENT_ORCHESTRATION_STARTED', {
            orchestrationId,
            source: payload.source || 'unknown',
            text: cleanText
        });
        this._activeInteractionTurnId = '';
        this.eventBus.emit('RTC_INTERACTION_TURN_INVALIDATE', {
            reason: 'orchestration_started',
            orchestrationId,
            source: payload.source || 'unknown'
        });

        try {
            const response = await fetch(`${runtime.apiBaseUrl}/api/agent/orchestrate/trigger`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: cleanText,
                    orchestrationInput: payload.orchestrationInput || cleanText,
                    rawAsrText: payload.rawAsrText || payload.raw_asr_text || '',
                    source: payload.source || 'unknown',
                    sessionId: this.getSessionId(payload),
                    forceMock: payload.forceMock === true,
                    context: payload.context || null
                }),
            });
            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(errorText || `Agent 编排触发失败: HTTP ${response.status}`);
            }
            const result = await response.json();
            console.log('[AgentModule] 编排已触发', { ok: result.ok, orchestrationId });
        } catch (error) {
            console.error('[AgentModule] 编排触发失败:', error);
            this.eventBus.emit('AGENT_FAILED', { error: error.message, text: cleanText });
            this.isProcessing = false;
            this._processingQuery = '';
            this._processingStartedAt = 0;
            this._processingSource = '';
        }
    }

    async handleAgentEvent(event, data = {}) {
        if (event === 'task_created') {
            this._currentTaskId = data.task_id || '';
            this._currentIntent = data.intent || '';
            this.eventBus.emit('AGENT_TASK_CREATED', data);
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: '任务已创建',
                text: '正在理解问题',
                task_id: data.task_id,
                orchestrationId: this._currentOrchestrationId
            });
            return;
        }

        if (event === 'fsm_state') {
            this.eventBus.emit('AGENT_STAGE_CHANGE', data);
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: 'Agent 状态',
                text: data.message || data.fsm_state || '处理中',
                task_id: data.task_id,
                orchestrationId: this._currentOrchestrationId
            });
            if (!this._strategyLoadingEmitted && (data.intent === 'strategy') && (data.fsm_state === 'BRANCH_EXEC' || String(data.message || '').includes('整理') || String(data.message || '').includes('生成'))) {
                this._strategyLoadingEmitted = true;
                const pendingCardId = data.task_id || `${data.turn_id || Date.now()}_strategy_pending`;
                const isImageCard = data.popup_mode === 'strategy_card' || data.needs_image === true;
                console.log('[AgentModule] fsm_state 检测到 strategy 分支执行，弹出 loading 卡片', { fsm_state: data.fsm_state, message: data.message, isImageCard });
                this.eventBus.emit('TRIGGER_KNOWLEDGE', {
                    title: isImageCard ? '战术图文卡片' : '战术策略建议',
                    content: '战术内容整理中',
                    list: [],
                    loading: true,
                    forcePreview: this._forceAbilityPreview,
                    imgUrl: '',
                    imageLoading: false,
                    cardId: pendingCardId
                });
            }
            if (!this._videoLoadingEmitted && (data.intent === 'video') && (data.fsm_state === 'BRANCH_EXEC' || String(data.message || '').includes('视频') || String(data.message || '').includes('找'))) {
                this._videoLoadingEmitted = true;
                const videoCardId = data.task_id || `${data.turn_id || Date.now()}_video_pending`;
                console.log('[AgentModule] fsm_state 检测到 video 分支执行，弹出 loading 卡片', { fsm_state: data.fsm_state, message: data.message });
                this.eventBus.emit('TRIGGER_video', {
                    title: '精彩视频',
                    summary: '正在检索视频链接...',
                    videoUrl: '',
                    linkUrl: '',
                    coverUrl: '',
                    forcePreview: this._forceAbilityPreview,
                    loading: true,
                    cardId: videoCardId
                });
            }
            return;
        }

        if (event === 'interaction_speech_delta') {
            return;
        }

        if (event === 'interaction_reply' || event === 'main_reply' || event === 'main_reply_preview') {
            const isInteraction = event === 'interaction_reply';
            const isPreview = event === 'main_reply_preview' || data.preview === true;
            console.log('[AgentModule] reply 事件', { event, intent: data.intent, popup_mode: data.popup_mode, needs_image: data.needs_image, forceAbilityPreview: this._forceAbilityPreview });
            if (isInteraction && data.turn_id) {
                this._activeInteractionTurnId = String(data.turn_id);
            }
            if (data.intent === 'strategy' && !this._strategyLoadingEmitted) {
                this._strategyLoadingEmitted = true;
                const pendingCardId = data.task_id || `${data.turn_id || Date.now()}_strategy_pending`;
                const isImageCard = data.popup_mode === 'strategy_card' || data.needs_image === true;
                console.log('[AgentModule] strategy 意图识别，弹出 loading 卡片', { event, isImageCard, forcePreview: this._forceAbilityPreview });
                this.eventBus.emit('TRIGGER_KNOWLEDGE', {
                    title: isImageCard ? '战术图文卡片' : '战术策略建议',
                    content: data.understanding_reply || '战术内容整理中',
                    list: [],
                    loading: true,
                    forcePreview: this._forceAbilityPreview,
                    imgUrl: '',
                    imageLoading: false,
                    cardId: pendingCardId
                });
            }
            if (data.intent === 'video' && !this._videoLoadingEmitted) {
                this._videoLoadingEmitted = true;
                const videoCardId = data.task_id || `${data.turn_id || Date.now()}_video_pending`;
                console.log('[AgentModule] video 意图识别，弹出 loading 卡片', { event, forcePreview: this._forceAbilityPreview });
                this.eventBus.emit('TRIGGER_video', {
                    title: '精彩视频',
                    summary: '正在检索视频链接...',
                    videoUrl: '',
                    linkUrl: '',
                    coverUrl: '',
                    forcePreview: this._forceAbilityPreview,
                    loading: true,
                    cardId: videoCardId
                });
            }
            if (isInteraction) {
                const completeText = stripBracketDescriptions(
                    data.intent === 'smalltalk'
                        ? (data.main_summary || '')
                        : [data.understanding_reply, data.branch_wait_reply].filter(Boolean).join(' ')
                );
                if (completeText) {
                    this.eventBus.emit('CHAT_REPLY', {
                        text: completeText,
                        source: 'interaction_reply',
                        targets: ['chat']
                    });
                }
            }
            if (!isInteraction && !isPreview && data.main_summary && data.tts_priority !== 'silent') {
                this.eventBus.emit('CHAT_REPLY', {
                    text: stripBracketDescriptions(data.main_summary),
                    source: 'agent_main',
                    targets: ['chat']
                });
            }
            if (!isInteraction && !isPreview) {
                this.eventBus.emit('AGENT_MAIN_REPLY', data);
            }
            return;
        }

        if (event === 'voice_delta') {
            return;
        }

        if (event === 'strategy_ready' || event === 'card_ready') {
            this.presentKnowledgeCard(data);
            return;
        }

        if (event === 'video_ready') {
            this.eventBus.emit('TRIGGER_video', {
                title: data.query || data.title || '精彩视频',
                summary: data.summary || '',
                videoUrl: data.videoUrl || '',
                linkUrl: data.linkUrl || '',
                coverUrl: data.coverUrl || '',
                forcePreview: this._forceAbilityPreview
            });
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: '精彩视频',
                text: data.query || data.title || '已找到可播放视频',
                task_id: data.task_id
            });
            return;
        }

        if (event === 'video_failed') {
            const candidateLinkUrl = data.linkUrl || (data.query ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(data.query)}` : '');
            if (candidateLinkUrl) {
                this.eventBus.emit('TRIGGER_video', {
                    title: data.query || '精彩视频',
                    summary: '已找到候选视频，点击查看',
                    videoUrl: '',
                    linkUrl: candidateLinkUrl,
                    coverUrl: data.coverUrl || '',
                    forcePreview: this._forceAbilityPreview
                });
            }
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: '精彩视频',
                text: '已找到候选视频，点击查看',
                task_id: data.task_id
            });
            this.eventBus.emit('CHAT_REPLY', {
                text: candidateLinkUrl ? '已找到候选视频，点击查看' : '暂未找到可跳转的候选视频。',
                source: 'agent_video_failed',
                targets: ['chat']
            });
            return;
        }

        if (event === 'error') {
            this.eventBus.emit('AGENT_FAILED', data);
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: 'Agent 编排失败',
                text: data.error || '未知错误',
                task_id: data.task_id,
                orchestrationId: this._currentOrchestrationId
            });
        }
    }

    async presentKnowledgeCard(data = {}) {
        const details = Array.isArray(data.details) ? data.details : [];
        let imgUrl = '';
        const prompt = String(data.image_prompt_text || '').trim();
        const forcePreview = this._forcePreviewNextCard || this._forceAbilityPreview;
        this._forcePreviewNextCard = false;
        const cardId = data.task_id || `${data.turn_id || Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
        const needsImage = data.needs_image === true && Boolean(prompt);
        const summary = data.task_id ? (this._strategySummaryByTaskId.get(data.task_id) || '') : '';
        if (data.task_id) {
            this._strategySummaryByTaskId.delete(data.task_id);
        }
        this.eventBus.emit('TRIGGER_KNOWLEDGE', {
            title: data.title || '战术策略建议',
            content: details.join(' / '),
            summary,
            list: details,
            loading: false,
            forcePreview,
            imgUrl: '',
            imageLoading: needsImage,
            cardId
        });

        if (!needsImage) {
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: '战术策略',
                text: `${data.title || '战术策略建议'}：${details.join(' / ')}`,
                task_id: data.task_id
            });
            return;
        }

        const IMG_TIMEOUT_MS = 45000;
        const FETCH_ABORT_MS = 50000;
        let timeoutId = null;
        let timeoutShown = false;

        const emitCard = (finalImgUrl, state = {}) => {
            clearTimeout(timeoutId);
            this.eventBus.emit('TRIGGER_KNOWLEDGE', {
                title: data.title || '战术策略建议',
                content: details.join(' / '),
                summary,
                list: details,
                loading: false,
                forcePreview,
                imgUrl: finalImgUrl || '',
                imageLoading: false,
                timeout: state.timeout === true,
                imageFailed: state.imageFailed === true,
                cardId
            });
        };

        timeoutId = setTimeout(() => {
            timeoutShown = true;
            emitCard('', { timeout: true });
        }, IMG_TIMEOUT_MS);

        try {
            const runtime = getRuntimeConfig();
            const imgController = new AbortController();
            const fetchTimeoutId = setTimeout(() => imgController.abort(), FETCH_ABORT_MS);
            const response = await fetch(`${runtime.apiBaseUrl}/api/media/image/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
                signal: imgController.signal
            });
            clearTimeout(fetchTimeoutId);
            const json = await response.json();
            imgUrl = json?.data?.url || '';
            if (!response.ok || !imgUrl) {
                throw new Error(json?.message || `图片生成失败: HTTP ${response.status}`);
            }
        } catch (error) {
            console.warn('[AgentModule] 知识卡片图片生成失败:', error);
            if (!timeoutShown) {
                emitCard('', { imageFailed: true });
            }
            return;
        }

        emitCard(imgUrl, { timeout: false });
        this.eventBus.emit('ABILITY_FEEDBACK', {
            source: 'agent',
            ability: '战术图文卡片',
            text: `${data.title || '战术策略建议'}：${details.join(' / ')}`,
            task_id: data.task_id
        });
    }
}

export const agentModule = new AgentModule();
