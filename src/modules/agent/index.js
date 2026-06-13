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

function cleanPromptText(text = '', maxLen = 28) {
    return stripBracketDescriptions(text)
        .replace(/[，。！？；：,.!?;:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}

function escapeSvgText(text = '') {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function wrapTextByChars(text = '', maxChars = 12, maxLines = 2) {
    const clean = String(text || '').trim();
    if (!clean) return [];
    const lines = [];
    for (let i = 0; i < clean.length && lines.length < maxLines; i += maxChars) {
        lines.push(clean.slice(i, i + maxChars));
    }
    return lines;
}

function renderSvgTextLines(lines = [], x = 0, y = 0, lineHeight = 36, className = '') {
    return lines.map((line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" class="${className}">${escapeSvgText(line)}</text>`
    ).join('');
}

const STRATEGY_POSTER_STYLES = [
    {
        key: 'sunrise',
        name: '暖橙极简',
        label: 'TACTIC CARD',
        bg: '#FFFFFF',
        panel: '#FFFFFF',
        card: '#F8F9FA',
        text: '#1A1A1A',
        muted: '#71717A',
        line: '#FF8A2D',
        accent: '#FF8A2D',
        accentDark: '#C2410C',
        accentSoft: '#FFF7ED',
        accentMid: '#FED7AA',
        footer: '#A1A1AA'
    },
    {
        key: 'violet',
        name: '紫蓝专注',
        label: 'FOCUS PLAN',
        bg: '#FBFCFF',
        panel: '#FFFFFF',
        card: '#F8FAFF',
        text: '#18181B',
        muted: '#6366F1',
        line: '#6366F1',
        accent: '#6366F1',
        accentDark: '#4338CA',
        accentSoft: '#EEF2FF',
        accentMid: '#C7D2FE',
        footer: '#A1A1AA'
    },
    {
        key: 'mint',
        name: '青绿节奏',
        label: 'TEAM RHYTHM',
        bg: '#FFFFFF',
        panel: '#FFFFFF',
        card: '#F7FEFB',
        text: '#17211D',
        muted: '#047857',
        line: '#10B981',
        accent: '#10B981',
        accentDark: '#047857',
        accentSoft: '#ECFDF5',
        accentMid: '#A7F3D0',
        footer: '#94A3B8'
    }
];

function getStrategyPosterStyle(styleIndex = 0) {
    const index = Number.isFinite(Number(styleIndex)) ? Number(styleIndex) : 0;
    const normalized = ((index % STRATEGY_POSTER_STYLES.length) + STRATEGY_POSTER_STYLES.length) % STRATEGY_POSTER_STYLES.length;
    return STRATEGY_POSTER_STYLES[normalized];
}

function buildStrategyPosterSvg(data = {}, styleIndex = 0) {
    const style = getStrategyPosterStyle(styleIndex);
    const title = cleanPromptText(data.title || '战术策略建议', 18) || '战术策略建议';
    const details = (Array.isArray(data.details) ? data.details : [])
        .map((item) => cleanPromptText(item, 24))
        .filter(Boolean)
        .slice(0, 3);
    const pitfalls = (Array.isArray(data.avoid_pitfalls) ? data.avoid_pitfalls : [])
        .map((item) => cleanPromptText(item, 24))
        .filter(Boolean)
        .slice(0, 2);

    const titleLines = wrapTextByChars(title, 10, 2);
    const cards = details.map((item, index) => {
        const y = 460 + index * 175;
        const itemLines = wrapTextByChars(item, 15, 2);
        return `
            <rect x="90" y="${y}" width="900" height="130" rx="28" class="card"/>
            <circle cx="152" cy="${y + 65}" r="28" class="badge"/>
            <text x="152" y="${y + 76}" text-anchor="middle" class="badgeText">${index + 1}</text>
            ${renderSvgTextLines(itemLines, 205, y + 56, 38, 'pointText')}
        `;
    }).join('');
    const warningLines = pitfalls.length > 0
        ? pitfalls.flatMap((item) => wrapTextByChars(item, 20, 1)).slice(0, 2)
        : ['先稳节奏，避免盲目开团'];

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <style>
    .bg{fill:${style.bg}}.panel{fill:${style.panel};stroke:#E5E7EB;stroke-width:2}.orb{fill:${style.accentSoft};opacity:.9}.orbLine{fill:none;stroke:${style.accentMid};stroke-width:3;opacity:.7}.label{font:500 28px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;fill:${style.accentDark};letter-spacing:4px}.title{font:600 64px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;fill:${style.text}}.sub{font:400 26px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;fill:${style.muted}}.line{stroke:${style.line};stroke-width:8;stroke-linecap:round}.card{fill:${style.card};stroke:#E5E7EB;stroke-width:2}.badge{fill:${style.accent}}.badgeText{font:600 30px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;fill:#FFFFFF}.pointText{font:600 38px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;fill:#27272A}.warnBox{fill:${style.accentSoft};stroke:${style.accentMid};stroke-width:2}.warnTitle{font:600 30px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;fill:${style.accentDark}}.warnText{font:400 28px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;fill:${style.accentDark}}.foot{font:400 22px -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;fill:${style.footer}}
  </style>
  <rect width="1080" height="1350" class="bg"/>
  <circle cx="918" cy="145" r="104" class="orb"/>
  <circle cx="928" cy="148" r="136" class="orbLine"/>
  <rect x="46" y="46" width="988" height="1258" rx="42" class="panel"/>
  <text x="90" y="142" class="label">${style.label}</text>
  ${renderSvgTextLines(titleLines, 90, 245, 76, 'title')}
  <text x="90" y="375" class="sub">三步行动建议 · 快速执行版</text>
  <line x1="90" y1="415" x2="330" y2="415" class="line"/>
  ${cards}
  <rect x="90" y="1015" width="900" height="190" rx="28" class="warnBox"/>
  <text x="130" y="1075" class="warnTitle">避坑提醒</text>
  ${renderSvgTextLines(warningLines, 130, 1130, 42, 'warnText')}
  <text x="90" y="1260" class="foot">Generated by 游戏AI助手 · ${style.name}</text>
</svg>`;
}

function svgToPngDataUrl(svgText = '', width = 1080, height = 1350) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL('image/png'));
            } catch (error) {
                URL.revokeObjectURL(url);
                reject(error);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('SVG 海报渲染失败'));
        };
        img.src = url;
    });
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
const RTC_AGENT_SOURCES = new Set(['rtc_asr', 'rtc_text', 'rtc_subtitle', 'rtc_user_asr']);

function isStrongVideoRequest(text = '') {
    const value = String(text || '');
    if (!value.trim()) return false;
    return /视频教学|视频示范|连招视频|操作视频|技巧视频|对线视频|教学视频|实战视频|教程视频|视频链接/.test(value)
        || /(找|搜|检索|推荐|给|给我|有没有|有无|发|看|想看).{0,20}(视频|示范|演示|教学|教程)/.test(value)
        || /(找|搜|检索|推荐|给|给我|有没有|有无|发|看|想看).{0,20}(链接|资料链接|教程链接)/.test(value)
        || /(视频|集锦|高光|操作秀|操作集锦|精彩操作|抖音|B站|b站|教学录像|实战录像|名场面|神仙操作)/.test(value);
}

const SSE_EVENT_TYPES = [
    'task_created', 'fsm_state', 'interaction_speech_delta',
    'interaction_reply_placeholder', 'main_reply_delta', 'interaction_reply', 'main_reply', 'main_reply_preview',
    'voice_delta', 'strategy_ready', 'card_ready', 'secondary_strategy_ready',
    'video_ready', 'secondary_video_ready', 'video_failed', 'task_plan', 'secondary_failed', 'error', 'done',
    'task_queued', 'pool_changed', 'agent_state', 'subagent_activity', 'proactive_cue',
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
        this._pendingAssetCardEmitted = false;
        this._knowledgePosterByCardId = new Map();
        this._parallelTaskIds = new Set();
        this._parallelVideoRequestKeys = new Set();
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
        this.eventBus.on('EXPORT_KNOWLEDGE_POSTER', this.exportKnowledgePoster.bind(this));
        this.eventBus.on('SWITCH_KNOWLEDGE_POSTER_STYLE', this.exportKnowledgePoster.bind(this));
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
                this.eventBus.emit('BACKEND_CONNECTIVITY_CHANGED', {
                    available: true,
                    source: 'agent_sse'
                });
            });

            es.addEventListener('error', () => {
                this.eventBus.emit('BACKEND_CONNECTIVITY_CHANGED', {
                    available: false,
                    source: 'agent_sse',
                    error: 'sse_connection_error',
                    pausedUntil: Date.now() + 3000,
                    reason: '本地编排 SSE 已断开。'
                });
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
                        if (typeof e.data !== 'string' || e.data.length === 0) {
                            return;
                        }
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
        if (data?.task_id) {
            this.eventBus.emit('CLEAR_PENDING_ASSET', {
                cardId: data.task_id
            });
        }
        if (data?.source === 'secondary_video_fastpath' || this._parallelTaskIds.has(String(data?.task_id || ''))) {
            this._parallelTaskIds.delete(String(data?.task_id || ''));
            const parallelKey = String(data?.user_query || data?.video_query || '').trim();
            if (parallelKey) {
                this._parallelVideoRequestKeys.delete(parallelKey);
            }
            this.eventBus.emit('AGENT_ORCHESTRATION_FINISHED', {
                orchestrationId: this._currentOrchestrationId,
                source: data.source || 'secondary_video_fastpath',
                text: data.user_query || '',
                pendingQueueCount: this._requestQueue.length,
                willContinue: false,
                parallel: true,
            });
            return;
        }
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

    _formatIntentLabel(intent = '') {
        const key = String(intent || '').toLowerCase();
        const map = {
            strategy: '战术策略',
            video: '视频/链接检索',
            knowledge: '知识卡片',
            smalltalk: '直接对话',
            unknown: '待识别'
        };
        return map[key] || intent || '待识别';
    }

    _formatTaskPlanSummary(tasks = [], primaryIntent = '') {
        const list = Array.isArray(tasks) ? tasks : [];
        const primaryKey = String(primaryIntent || '').toLowerCase();
        const primaryTasks = [];
        const secondaryTasks = [];
        for (const task of list) {
            const tool = String(task?.tool || '').toLowerCase();
            const query = String(task?.query || '').trim();
            const label = this._formatIntentLabel(tool);
            const detail = query ? `${label}（${query}）` : label;
            if (tool === primaryKey) {
                primaryTasks.push(detail);
            } else {
                secondaryTasks.push(detail);
            }
        }
        const parts = [];
        if (primaryKey) {
            parts.push(`主意图：${this._formatIntentLabel(primaryKey)}`);
        }
        if (primaryTasks.length > 0) {
            parts.push(`主任务：${primaryTasks.join('、')}`);
        }
        if (secondaryTasks.length > 0) {
            parts.push(`Secondary：${secondaryTasks.join('、')}`);
        }
        return parts.join('；') || '未拆解出可执行任务';
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

        if (this.isProcessing && this._processingQuery && RTC_AGENT_SOURCES.has(payload.source) && isStrongVideoRequest(cleanText) && this._currentIntent !== 'video') {
            console.log('[AgentModule] 长任务中检测到视频强信号，并发触发 secondary video', {
                source: payload.source,
                text: cleanText,
                processingQuery: this._processingQuery,
                currentIntent: this._currentIntent
            });
            this._triggerConcurrentVideo(cleanText, payload).catch((err) => {
                console.warn('[AgentModule] 并发 secondary video 触发失败:', err);
            });
            return;
        }

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
            if (RTC_AGENT_SOURCES.has(payload.source)) {
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
        this._pendingAssetCardEmitted = false;

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
            const knowledgeSources = (() => {
                try {
                    const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
                    const userKb = runtime.userKnowledge;
                    if (userKb && typeof userKb.getSources === 'function') {
                        return userKb.getSources();
                    }
                } catch (e) {
                    console.warn('[AgentModule] 读取用户知识库源失败', e);
                }
                return null;
            })();

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
                    context: payload.context || null,
                    knowledgeSources: knowledgeSources || undefined,
                    rerankStrategy: runtime.knowledge?.rerankStrategy || 'embedding',
                    knowledgeLimit: runtime.knowledge?.limit || undefined,
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

    async _triggerConcurrentVideo(cleanText, payload = {}) {
        const requestKey = String(cleanText || '').trim();
        if (!requestKey || this._parallelVideoRequestKeys.has(requestKey)) {
            console.log('[AgentModule] 跳过重复并发视频请求', { text: cleanText });
            return;
        }
        const runtime = getRuntimeConfig();
        const clientTaskId = `task_video_fast_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
        this._parallelVideoRequestKeys.add(requestKey);
        this._parallelTaskIds.add(clientTaskId);
        this.eventBus.emit('TRIGGER_video', {
            title: cleanText,
            summary: `正在并发检索：${cleanText}`,
            videoUrl: '',
            linkUrl: '',
            loading: true,
            forcePreview: true,
            source: 'secondary_video_fastpath',
            cardId: clientTaskId
        });
        this.eventBus.emit('ABILITY_FEEDBACK', {
            source: 'agent',
            ability: '并发视频检索',
            text: `长任务不中断，已并发检索：${cleanText}`,
            task_id: clientTaskId,
            orchestrationId: this._currentOrchestrationId
        });

        try {
            const response = await fetch(`${runtime.apiBaseUrl}/api/agent/orchestrate/trigger`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: cleanText,
                    orchestrationInput: payload.orchestrationInput || cleanText,
                    rawAsrText: payload.rawAsrText || payload.raw_asr_text || '',
                    source: 'secondary_video_fastpath',
                    sessionId: this.getSessionId(payload),
                    clientTaskId,
                    priority: 'high',
                    context: {
                        ...(payload.context || {}),
                        fastpath_intent: 'video',
                        parent_task_id: this._currentTaskId || '',
                        parent_query: this._processingQuery || ''
                    },
                }),
            });
            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(errorText || `并发视频编排触发失败: HTTP ${response.status}`);
            }
            const result = await response.json();
            console.log('[AgentModule] 并发视频编排已触发', { ok: result.ok, clientTaskId, text: cleanText });
        } catch (error) {
            this._parallelTaskIds.delete(clientTaskId);
            this._parallelVideoRequestKeys.delete(requestKey);
            this.eventBus.emit('TRIGGER_video', {
                title: cleanText,
                summary: '并发视频检索触发失败，请稍后重试。',
                videoUrl: '',
                linkUrl: '',
                loading: false,
                forcePreview: true,
                source: 'secondary_video_fastpath',
                cardId: clientTaskId,
                error: error.message
            });
            throw error;
        }
    }

    async handleAgentEvent(event, data = {}) {
        if (event === 'task_created') {
            if (data.source === 'secondary_video_fastpath') {
                if (data.task_id) {
                    this._parallelTaskIds.add(String(data.task_id));
                }
                this.eventBus.emit('AGENT_TASK_CREATED', data);
                this.eventBus.emit('ABILITY_FEEDBACK', {
                    source: 'agent',
                    ability: '并发视频任务已创建',
                    text: data.user_query ? `正在检索：${data.user_query}` : '正在检索视频',
                    task_id: data.task_id,
                    orchestrationId: this._currentOrchestrationId
                });
                return;
            }
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
                ability: '阶段进展',
                text: `${this._formatIntentLabel(data.intent)} · ${data.message || data.fsm_state || '处理中'}`,
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

        if (event === 'interaction_speech_delta' || event === 'main_reply_delta') {
            this.eventBus.emit('AGENT_REPLY_DELTA', {
                ...data,
                source: event,
                silent: true
            });
            return;
        }

        if (event === 'task_plan') {
            const tasks = Array.isArray(data.task_plan) ? data.task_plan : [];
            const shouldRenderTaskCards = data.ui_commit !== false;
            const isCompoundPlan = data.mode === 'compound' && tasks.length > 1;
            this.eventBus.emit('AGENT_TASK_PLAN', data);
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: data.mode === 'compound' ? '任务拆解' : '任务确认',
                text: this._formatTaskPlanSummary(tasks, this._currentIntent),
                task_id: data.task_id,
                orchestrationId: this._currentOrchestrationId
            });
            if (shouldRenderTaskCards && !this._strategyLoadingEmitted && tasks.some((task) => task?.tool === 'strategy')) {
                this._strategyLoadingEmitted = true;
                const pendingCardId = data.task_id || `${data.turn_id || Date.now()}_strategy_pending`;
                const strategyTask = tasks.find((task) => task?.tool === 'strategy');
                this.eventBus.emit('TRIGGER_KNOWLEDGE', {
                    title: isCompoundPlan ? '复合任务 · 战术策略' : '战术策略建议',
                    content: strategyTask?.query ? `正在整理：${strategyTask.query}` : '战术内容整理中',
                    list: isCompoundPlan ? tasks.map((task) => `${this._formatIntentLabel(task?.tool)}：${task?.query || '处理中'}`) : [],
                    loading: true,
                    forcePreview: this._forceAbilityPreview,
                    imgUrl: '',
                    imageLoading: false,
                    cardId: pendingCardId
                });
            }
            if (shouldRenderTaskCards && !this._videoLoadingEmitted && tasks.some((task) => task?.tool === 'video')) {
                this._videoLoadingEmitted = true;
                const videoCardId = data.task_id || `${data.turn_id || Date.now()}_video_pending`;
                const videoTask = tasks.find((task) => task?.tool === 'video');
                this.eventBus.emit('TRIGGER_video', {
                    title: isCompoundPlan ? '复合任务 · 相关视频' : '相关链接',
                    summary: videoTask?.query ? `正在检索：${videoTask.query}` : '正在检索相关链接...',
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

        if (event === 'interaction_reply_placeholder' || event === 'interaction_reply' || event === 'main_reply' || event === 'main_reply_preview') {
            const isPlaceholder = event === 'interaction_reply_placeholder';
            const isInteraction = event === 'interaction_reply';
            const isPreview = event === 'main_reply_preview' || data.preview === true;
            console.log('[AgentModule] reply 事件', {
                event,
                intent: data.intent,
                hint_confidence: data.hint_confidence,
                placeholder_type: data.placeholder_type,
                ui_commit: data.ui_commit,
                popup_mode: data.popup_mode,
                needs_image: data.needs_image,
                forceAbilityPreview: this._forceAbilityPreview
            });
            if ((isInteraction || isPlaceholder) && data.turn_id) {
                this._activeInteractionTurnId = String(data.turn_id);
            }
            if (isPlaceholder) {
                const shouldCommitPendingAsset = data.ui_commit === true && data.placeholder_type === 'asset';
                if (data.intent && data.intent !== 'smalltalk' && shouldCommitPendingAsset && !this._pendingAssetCardEmitted) {
                    this._pendingAssetCardEmitted = true;
                    this.eventBus.emit('TRIGGER_PENDING_ASSET', {
                        title: '任务处理中',
                        summary: '需求已确认，正在准备对应卡片...',
                        assetType: data.intent,
                        forcePreview: this._forceAbilityPreview,
                        cardId: data.task_id || `${data.turn_id || Date.now()}_pending`
                    });
                }
                this.eventBus.emit('ABILITY_FEEDBACK', {
                    source: 'agent',
                    ability: '意图识别中',
                    text: shouldCommitPendingAsset
                        ? '已确认任务类型，正在准备卡片'
                        : `正在理解语境${data.hint_confidence ? ` · 预判置信度 ${Math.round(Number(data.hint_confidence) * 100)}%` : ''}`,
                    task_id: data.task_id,
                    orchestrationId: this._currentOrchestrationId
                });
                return;
            }
            if (data.ui_commit === true && data.intent === 'strategy' && !this._strategyLoadingEmitted) {
                this._strategyLoadingEmitted = true;
                const pendingCardId = data.task_id || `${data.turn_id || Date.now()}_strategy_pending`;
                const isImageCard = data.popup_mode === 'strategy_card' || data.needs_image === true;
                console.log('[AgentModule] strategy 意图识别，弹出 loading 卡片', { event, isImageCard, forcePreview: this._forceAbilityPreview, cardId: pendingCardId });
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
            if (data.ui_commit === true && data.intent === 'video' && !this._videoLoadingEmitted) {
                this._videoLoadingEmitted = true;
                const videoCardId = data.task_id || `${data.turn_id || Date.now()}_video_pending`;
                console.log('[AgentModule] video 意图识别，弹出 loading 卡片', { event, forcePreview: this._forceAbilityPreview, cardId: videoCardId });
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
                this._currentIntent = data.intent || this._currentIntent;
                if (data.intent === 'smalltalk') {
                    this.eventBus.emit('CLEAR_PENDING_ASSET', {
                        cardId: data.task_id || ''
                    });
                }
                this.eventBus.emit('ABILITY_FEEDBACK', {
                    source: 'agent',
                    ability: '意图确认',
                    text: `主意图：${this._formatIntentLabel(data.intent)}${data.popup_mode ? `；输出形态：${data.popup_mode}` : ''}${data.branch_wait_reply ? `；当前进展：${data.branch_wait_reply}` : ''}`,
                    task_id: data.task_id,
                    orchestrationId: this._currentOrchestrationId
                });
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

        if (event === 'strategy_ready' || event === 'card_ready' || event === 'secondary_strategy_ready') {
            const isSecondary = event === 'secondary_strategy_ready';
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: isSecondary ? 'Secondary 完成' : '主任务完成',
                text: `${isSecondary ? '战术补充' : '战术策略'}已完成${data.query ? `：${data.query}` : ''}${data.title ? `；产物：${data.title}` : ''}`,
                task_id: data.task_id,
                orchestrationId: this._currentOrchestrationId
            });
            this.presentKnowledgeCard(data);
            return;
        }

        if (event === 'video_ready' || event === 'secondary_video_ready') {
            const isSecondary = event === 'secondary_video_ready';
            this.eventBus.emit('TRIGGER_video', {
                title: data.query || data.title || '精彩视频',
                summary: data.summary || '',
                videoUrl: data.videoUrl || '',
                linkUrl: data.linkUrl || '',
                coverUrl: data.coverUrl || '',
                bilibili_linkUrl: data.bilibili_linkUrl || '',
                douyin_linkUrl: data.douyin_linkUrl || '',
                forcePreview: this._forceAbilityPreview,
                isSecondary: isSecondary,
                cardId: data.task_id || data.cardId || ''
            });
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: isSecondary ? 'Secondary 完成' : '主任务完成',
                text: `${isSecondary ? '视频/链接补充' : '视频/链接检索'}已完成${data.query ? `：${data.query}` : ''}${(data.linkUrl || data.videoUrl) ? '；已返回结果' : ''}`,
                task_id: data.task_id
            });
            return;
        }

        if (event === 'secondary_failed') {
            const tool = String(data.tool || '').toLowerCase();
            const query = String(data.query || '').trim();
            if (tool === 'video' && query) {
                this.eventBus.emit('TRIGGER_video', {
                    title: query,
                    summary: '链接检索暂时失败，先提供搜索入口',
                    videoUrl: '',
                    linkUrl: `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`,
                    bilibili_linkUrl: `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`,
                    douyin_linkUrl: `https://www.douyin.com/search?keyword=${encodeURIComponent(query)}`,
                    coverUrl: '',
                    forcePreview: this._forceAbilityPreview,
                    cardId: data.task_id || ''
                });
            }
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'agent',
                ability: 'Secondary 失败',
                text: `${this._formatIntentLabel(tool)}${query ? `：${query}` : ''}；${data.error || '后台子任务执行失败'}`,
                task_id: data.task_id
            });
            return;
        }

        if (event === 'video_failed') {
            const query = data.query || '';
            const candidateLinkUrl = data.linkUrl || (query ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}` : '');
            if (candidateLinkUrl) {
                this.eventBus.emit('TRIGGER_video', {
                    title: query || '精彩视频',
                    summary: '已找到候选视频，点击查看',
                    videoUrl: '',
                    linkUrl: candidateLinkUrl,
                    bilibili_linkUrl: candidateLinkUrl,
                    douyin_linkUrl: query ? `https://www.douyin.com/search?keyword=${encodeURIComponent(query)}` : '',
                    coverUrl: data.coverUrl || '',
                    forcePreview: this._forceAbilityPreview,
                    cardId: data.task_id || data.cardId || ''
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

        if (event === 'subagent_activity') {
            this.eventBus.emit('AGENT_SUBAGENT_ACTIVITY', data);
            const activated = Array.isArray(data.activated_subagents) ? data.activated_subagents : [];
            if (activated.length > 0 || data.warning_text) {
                this.eventBus.emit('ABILITY_FEEDBACK', {
                    source: 'agent',
                    ability: '子任务进展',
                    text: activated.length > 0
                        ? `已激活：${activated.join('、')}${data.warning_text ? `；提示：${data.warning_text}` : ''}`
                        : data.warning_text,
                    task_id: data.task_id,
                    orchestrationId: this._currentOrchestrationId
                });
            }
            if (data.warning_text) {
                console.warn('[AgentModule] 子 Agent 活动告警:', data.warning_text);
            }
            return;
        }

        if (event === 'proactive_cue') {
            this.eventBus.emit('AGENT_PROACTIVE_CUE', {
                ...data,
                silent: true
            });
            return;
        }

        if (event === 'error') {
            if (data?.task_id) {
                this.eventBus.emit('CLEAR_PENDING_ASSET', {
                    cardId: data.task_id
                });
            }
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
        const forcePreview = this._forcePreviewNextCard || this._forceAbilityPreview;
        this._forcePreviewNextCard = false;
        const cardId = data.task_id || `${data.turn_id || Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
        const canExportPoster = data.needs_image === true && details.length > 0;
        const summary = data.task_id ? (this._strategySummaryByTaskId.get(data.task_id) || '') : '';
        if (data.task_id) {
            this._strategySummaryByTaskId.delete(data.task_id);
        }
        if (canExportPoster) {
            this._knowledgePosterByCardId.set(String(cardId), {
                title: data.title || '战术策略建议',
                details,
                avoid_pitfalls: data.avoid_pitfalls || data.avoidPitfalls || [],
                summary,
                forcePreview,
                ragMeta: data.rag_meta || null,
                taskId: data.task_id,
                styleIndex: 0,
                imgUrl: '',
                posterStyleName: getStrategyPosterStyle(0).name
            });
        }
        this.eventBus.emit('TRIGGER_KNOWLEDGE', {
            title: data.title || '战术策略建议',
            content: details.join(' / '),
            summary,
            list: details,
            loading: false,
            forcePreview,
            imgUrl: '',
            imageLoading: false,
            posterLoading: canExportPoster,
            canExportPoster,
            posterStyleLabel: canExportPoster ? getStrategyPosterStyle(0).name : '',
            cardId,
            ragMeta: data.rag_meta || null
        });

        if (canExportPoster) {
            setTimeout(() => {
                this.exportKnowledgePoster({ cardId, cycleStyle: false, source: 'auto' });
            }, 0);
        }

        this.eventBus.emit('ABILITY_FEEDBACK', {
            source: 'agent',
            ability: '战术策略',
            text: `${data.title || '战术策略建议'}：${details.join(' / ')}`,
            task_id: data.task_id
        });
    }

    async exportKnowledgePoster({ cardId, cycleStyle = true, source = 'manual' } = {}) {
        const key = String(cardId || '');
        const payload = this._knowledgePosterByCardId.get(key);
        if (!payload?.details?.length) return;
        let imgUrl = '';
        if (cycleStyle) {
            payload.styleIndex = ((Number(payload.styleIndex) || 0) + 1) % STRATEGY_POSTER_STYLES.length;
        }
        const posterStyle = getStrategyPosterStyle(payload.styleIndex);
        payload.posterStyleName = posterStyle.name;

        const emitCard = (finalImgUrl, state = {}) => {
            const hasError = state.timeout === true || state.imageFailed === true;
            if (hasError && !finalImgUrl) {
                console.warn('[AgentModule] 战术海报生成失败', { cardId: key, reason: state.timeout ? 'timeout' : 'imageFailed' });
            }
            this.eventBus.emit('TRIGGER_KNOWLEDGE', {
                title: payload.title,
                content: payload.details.join(' / '),
                summary: payload.summary,
                list: payload.details,
                loading: false,
                forcePreview: payload.forcePreview,
                imgUrl: finalImgUrl || payload.imgUrl || '',
                imageLoading: false,
                posterLoading: false,
                canExportPoster: true,
                posterStyleLabel: payload.posterStyleName,
                timeout: state.timeout === true,
                imageFailed: state.imageFailed === true,
                cardId: key,
                ragMeta: payload.ragMeta
            });
        };

        this.eventBus.emit('TRIGGER_KNOWLEDGE', {
            title: payload.title,
            content: payload.details.join(' / '),
            summary: payload.summary,
            list: payload.details,
            loading: false,
            forcePreview: payload.forcePreview,
            imgUrl: payload.imgUrl || '',
            imageLoading: false,
            posterLoading: true,
            canExportPoster: true,
            posterStyleLabel: payload.posterStyleName,
            cardId: key,
            ragMeta: payload.ragMeta
        });

        try {
            const svg = buildStrategyPosterSvg(payload, payload.styleIndex);
            imgUrl = await svgToPngDataUrl(svg);
        } catch (error) {
            console.warn('[AgentModule] 本地生成知识卡片海报失败:', error);
            emitCard('', { imageFailed: true });
            return;
        }

        payload.imgUrl = imgUrl;
        emitCard(imgUrl, { timeout: false });
        this.eventBus.emit('ABILITY_FEEDBACK', {
            source: 'agent',
            ability: source === 'auto' ? '生成战术海报' : '变换海报风格',
            text: `${payload.title}：${posterStyle.name}海报已生成`,
            task_id: payload.taskId
        });
    }
}

export const agentModule = new AgentModule();
