import { getRandomVideoDemoExample, searchDemoKnowledgeExamples } from '../data/index.js';

function serializeMediaTrack(track) {
    if (!track) {
        return null;
    }

    return {
        id: track.id,
        kind: track.kind,
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState
    };
}

function serializeMediaStream(stream) {
    if (!stream) {
        return null;
    }

    return {
        id: stream.id,
        active: stream.active,
        videoTracks: stream.getVideoTracks().map(serializeMediaTrack),
        audioTracks: stream.getAudioTracks().map(serializeMediaTrack)
    };
}

function serializeVideoElement(videoElement) {
    if (!videoElement) {
        return null;
    }

    return {
        id: videoElement.id || '',
        tagName: videoElement.tagName,
        readyState: videoElement.readyState,
        networkState: videoElement.networkState,
        paused: videoElement.paused,
        ended: videoElement.ended,
        muted: videoElement.muted,
        currentTime: Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : null,
        duration: Number.isFinite(videoElement.duration) ? videoElement.duration : null,
        currentSrc: videoElement.currentSrc || '',
        src: videoElement.getAttribute('src') || videoElement.src || '',
        videoWidth: videoElement.videoWidth || 0,
        videoHeight: videoElement.videoHeight || 0,
        srcObject: serializeMediaStream(videoElement.srcObject || null)
    };
}

function writeWorkspaceDebugLog(event, payload = {}) {
    if (typeof window === 'undefined') {
        return;
    }

    const root = window.__GAME_AI_DEBUG__ || (window.__GAME_AI_DEBUG__ = {});
    const logs = root.logs || (root.logs = []);
    const entry = {
        module: 'workspace',
        event,
        payload,
        timestamp: new Date().toISOString()
    };

    logs.push(entry);
    if (logs.length > 500) {
        logs.splice(0, logs.length - 500);
    }

    console.log(`[WorkspaceDebug] ${event}`, payload);
}

const ABILITY_DEMO_QUERY_MAP = {
    tts: '英雄联盟 亚索 逆风',
    knowledge: '王者荣耀 打野 连招',
    video: '英雄联盟 亚索 基础教学'
};

const ABILITY_TTS_TEXT_OPTIONS = {
    lol: [
        '亚索这波先稳线。等风墙转好再反打。',
        '中路先抢线权。抓到机会就游走支援。',
        '逆风别急着换血。等打野到位再开。',
        '团战先看后排位置。找到机会再进场。'
    ],
    hok: [
        '这波先刷完野区。等被动叠满再抓人。',
        '团战别急着进场。绕后切 C 位更稳。',
        '打野先控龙区视野。再找机会开团。',
        '顺风就压节奏。逆风先保发育。'
    ]
};

const REPLY_MODE_OPTIONS = {
    tts: '语音播报',
    knowledge: '知识卡片',
    video: '精彩视频'
};

export class WorkspaceModule {
    constructor(eventBus, app) {
        this.eventBus = eventBus;
        this.app = app;
        this.abilityTtsAudio = null;
        this.abilityTtsAudioUrl = '';
        this.abilityTtsPreparing = false;
        this.conversationEntrySeed = 1;
        this.lastConversationByChannel = {
            chat: null,
            rtc: null
        };

        this.btnTts = document.getElementById('btn-tts');
        this.replyModeToggle = document.getElementById('reply-mode-toggle');
        this.replyModeMenu = document.getElementById('reply-mode-menu');
        this.replyModeInputs = Array.from(document.querySelectorAll('input[name="reply-mode"]'));
        this.selectedReplyMode = 'tts';
        this.modeButtons = Array.from(document.querySelectorAll('.mode-button'));
        this.modeDescription = document.getElementById('mode-description');
        this.statusMode = document.getElementById('status-mode');
        this.statusRtc = document.getElementById('status-rtc');
        this.statusVideo = document.getElementById('status-video');
        this.rtcFeatureStatus = document.getElementById('rtc-feature-status');
        this.rtcFeatureToggleButtons = Array.from(document.querySelectorAll('[data-feature-toggle]'));

        this.fileInput = document.getElementById('video-file-input');
        this.selectVideoButton = document.getElementById('btn-select-video');
        this.selectVideoInlineButton = document.getElementById('btn-select-video-inline');
        this.reselectVideoButton = document.getElementById('btn-reselect-video');
        this.dropzone = document.getElementById('upload-dropzone');
        this.emptyState = document.getElementById('empty-state');
        this.videoShell = document.getElementById('video-player-shell');
        this.videoElement = document.getElementById('local-video');
        this.videoFileName = document.getElementById('video-file-name');
        this.videoFileTip = document.getElementById('video-file-tip');
        this.playToggleButton = document.getElementById('btn-play-toggle');
        this.progressInput = document.getElementById('video-progress');
        this.currentTimeLabel = document.getElementById('video-current-time');
        this.durationLabel = document.getElementById('video-duration');
        this.volumeInput = document.getElementById('video-volume');
        this.muteToggleButton = document.getElementById('btn-mute-toggle');
        this.fullscreenButton = document.getElementById('btn-fullscreen');
        this.abilityFeed = document.getElementById('ability-feed');

        this.currentVideoUrl = '';
        this.modeDescriptions = {
            pet: '进入桌宠语音模式后，会拉起 RTC 语音通话窗口，并继续保留纸片人互动。',
            text_chat: '打开文本聊天窗口，适合攻略问答、闲聊与知识查询。',
            rtc: '进入桌宠屏幕共享模式，RTC 通话窗口会支持共享屏幕与文字指令联动。'
        };

        this.rtcTextInput = document.getElementById('rtc-text-input');
        this.rtcSendTextBtn = document.getElementById('rtc-send-text');
        this.rtcInterruptBtn = document.getElementById('rtc-interrupt');
        this.rtcShareScreenBtn = document.getElementById('rtc-share-screen');

        this.isScreenSharing = false;
        this.isScreenSharePending = false;
        this.screenSharePendingReason = '';
        this.currentMode = 'pet';
        this.rtcFeatureState = null;
        this.isRtcFeatureSyncing = false;
        this.rtcFeaturePollTimer = null;
    }

    init() {
        this.initReplyModeState();
        this.bindModeButtons();
        this.bindRtcFeatureControls();
        this.bindReplyModePicker();
        this.bindAbilityButtons();
        this.bindVideoWorkspace();
        this.bindEventBus();
        this.updateModeUI('pet');
        this.updateVideoStatus('未上传');
        this.loadRtcFeatureState().catch((error) => {
            this.updateRtcFeatureStatus(error.message || '读取 RTC 功能配置失败', true);
        });
        this.startRtcFeaturePolling();
    }

    bindModeButtons() {
        this.modeButtons.forEach((button) => {
            button.addEventListener('click', () => {
                const targetMode = button.dataset.mode;
                console.log('[WorkspaceModule] 点击了模式按钮，目标模式:', targetMode, '按钮文本:', button.textContent.trim());
                this.app.switchMode(targetMode);
            });
        });
    }

    bindRtcFeatureControls() {
        this.rtcFeatureToggleButtons.forEach((button) => {
            button.addEventListener('click', async () => {
                const featureKey = button.dataset.featureToggle;
                if (!featureKey || this.isRtcFeatureSyncing || !this.rtcFeatureState) {
                    return;
                }

                const nextState = {
                    aiVadEnabled: this.rtcFeatureState.aiVad?.enabled ?? false,
                    voicePrintRealtimeEnabled: this.rtcFeatureState.voicePrintRealtime?.enabled ?? false,
                    aiDenoiseEnabled: this.rtcFeatureState.aiDenoise?.enabled ?? false,
                    lastChangedFeatureKey: featureKey
                };

                if (featureKey === 'aiVad') {
                    nextState.aiVadEnabled = !nextState.aiVadEnabled;
                }
                if (featureKey === 'voicePrintRealtime') {
                    nextState.voicePrintRealtimeEnabled = !nextState.voicePrintRealtimeEnabled;
                    if (nextState.voicePrintRealtimeEnabled) {
                        nextState.aiDenoiseEnabled = false;
                    }
                }
                if (featureKey === 'aiDenoise') {
                    nextState.aiDenoiseEnabled = !nextState.aiDenoiseEnabled;
                    if (nextState.aiDenoiseEnabled) {
                        nextState.voicePrintRealtimeEnabled = false;
                    }
                }

                try {
                    await this.saveRtcFeatureState(nextState);
                } catch (error) {
                    this.updateRtcFeatureStatus(error.message || 'RTC 功能配置同步失败', true);
                }
            });
        });
    }

    initReplyModeState() {
        const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
        let localSavedMode = '';
        try {
            localSavedMode = window.localStorage.getItem('game-ai-reply-mode') || '';
        } catch (error) {
            console.warn('[WorkspaceModule] 读取回复模式缓存失败:', error);
        }
        const savedMode = runtime.replyMode || localSavedMode || 'tts';
        this.applyReplyMode(REPLY_MODE_OPTIONS[savedMode] ? savedMode : 'tts');
    }

    bindReplyModePicker() {
        if (this.replyModeToggle) {
            this.replyModeToggle.addEventListener('click', (event) => {
                event.stopPropagation();
                const willExpand = this.replyModeMenu?.classList.contains('is-hidden');
                this.setReplyModeMenuExpanded(Boolean(willExpand));
            });
        }

        this.replyModeInputs.forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) {
                    return;
                }
                this.applyReplyMode(input.value);
                this.setReplyModeMenuExpanded(false);
            });
        });

        document.addEventListener('click', (event) => {
            if (!this.replyModeMenu || !this.replyModeToggle) {
                return;
            }
            if (this.replyModeMenu.contains(event.target) || this.replyModeToggle.contains(event.target)) {
                return;
            }
            this.setReplyModeMenuExpanded(false);
        });
    }

    setReplyModeMenuExpanded(expanded) {
        if (!this.replyModeMenu || !this.replyModeToggle) {
            return;
        }

        this.replyModeMenu.classList.toggle('is-hidden', !expanded);
        this.replyModeToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    applyReplyMode(mode) {
        const safeMode = REPLY_MODE_OPTIONS[mode] ? mode : 'tts';
        this.selectedReplyMode = safeMode;

        if (this.replyModeToggle) {
            this.replyModeToggle.textContent = `回复模式：${REPLY_MODE_OPTIONS[safeMode]}`;
        }

        this.replyModeInputs.forEach((input) => {
            input.checked = input.value === safeMode;
        });

        if (typeof window !== 'undefined') {
            const runtime = window.__GAME_AI_RUNTIME__ || (window.__GAME_AI_RUNTIME__ = {});
            const rtcRuntime = runtime.rtc || (runtime.rtc = {});
            runtime.replyMode = safeMode;
            rtcRuntime.replyMode = safeMode;
            try {
                window.localStorage.setItem('game-ai-reply-mode', safeMode);
            } catch (error) {
                console.warn('[WorkspaceModule] 持久化回复模式失败:', error);
            }
        }

        this.eventBus.emit('REPLY_MODE_CHANGED', {
            mode: safeMode,
            label: REPLY_MODE_OPTIONS[safeMode]
        });
    }

    getCurrentReplyMode() {
        const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
        const rtcRuntime = runtime.rtc || {};
        const mode = runtime.replyMode || rtcRuntime.replyMode || this.selectedReplyMode || 'tts';
        return REPLY_MODE_OPTIONS[mode] ? mode : 'tts';
    }

    normalizeReplyText(text = '', maxLength = 120) {
        const normalizedText = String(text || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!normalizedText) {
            return '';
        }

        return normalizedText.slice(0, Math.max(1, Number(maxLength || 120)));
    }

    getRtcApiBaseUrl() {
        const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
        const rtcRuntime = runtime.rtc || {};
        return String(runtime.apiBaseUrl || rtcRuntime.apiBaseUrl || 'http://127.0.0.1:8788').replace(/\/$/, '');
    }

    async loadRtcFeatureState(options = {}) {
        const silent = options.silent === true;
        if (!silent) {
            this.updateRtcFeatureStatus('正在读取服务端 RTC 功能配置...');
        }

        const response = await fetch(`${this.getRtcApiBaseUrl()}/api/rtc/voice-chat/features`);
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok) {
            throw new Error(data?.message || `读取 RTC 功能配置失败: ${response.status}`);
        }

        this.applyRtcFeatureState(data.data?.features || null, {
            source: 'remote',
            statusText: `已同步服务端配置: AI VAD ${data.data?.features?.aiVad?.enabled ? '开' : '关'} / 声纹降噪 ${data.data?.features?.voicePrintRealtime?.enabled ? '开' : '关'} / AI 降噪 ${data.data?.features?.aiDenoise?.enabled ? '开' : '关'}`
        });
    }

    async saveRtcFeatureState(payload) {
        this.isRtcFeatureSyncing = true;
        this.updateRtcFeatureControlsDisabled(true);
        this.updateRtcFeatureStatus('正在写回服务端 StartVoiceChat 配置...');

        let response;
        let data;
        try {
            response = await fetch(`${this.getRtcApiBaseUrl()}/api/rtc/voice-chat/features`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            data = await response.json().catch(() => null);
        } finally {
            this.isRtcFeatureSyncing = false;
            this.updateRtcFeatureControlsDisabled(false);
        }

        if (!response.ok || !data?.ok) {
            throw new Error(data?.message || `保存 RTC 功能配置失败: ${response.status}`);
        }

        this.applyRtcFeatureState(data.data?.features || null, {
            source: 'remote',
            statusText: '已写回服务端默认 StartVoiceChat 配置，下一次建会立即生效。'
        });
    }

    applyRtcFeatureState(featureState, options = {}) {
        if (!featureState) {
            return;
        }

        this.rtcFeatureState = featureState;
        this.rtcFeatureToggleButtons.forEach((button) => {
            const featureKey = button.dataset.featureToggle;
            const enabled = featureKey === 'aiVad'
                ? featureState.aiVad?.enabled
                : featureKey === 'voicePrintRealtime'
                    ? featureState.voicePrintRealtime?.enabled
                    : featureState.aiDenoise?.enabled;

            button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
            const labelNode = button.querySelector('.feature-toggle-label');
            if (labelNode) {
                labelNode.textContent = enabled ? '开启' : '关闭';
            }
        });

        if (typeof window !== 'undefined') {
            const runtime = window.__GAME_AI_RUNTIME__ || (window.__GAME_AI_RUNTIME__ = {});
            const rtcRuntime = runtime.rtc || (runtime.rtc = {});
            rtcRuntime.featureToggles = featureState;
        }

        this.eventBus.emit('RTC_VOICE_FEATURES_UPDATED', {
            source: options.source || 'remote',
            features: featureState
        });

        const voicePrintEnabled = featureState.voicePrintRealtime?.enabled;
        const aiDenoiseEnabled = featureState.aiDenoise?.enabled;
        const defaultStatusText = voicePrintEnabled && aiDenoiseEnabled
            ? '当前配置异常：声纹降噪与 AI 降噪不应同时开启。'
            : voicePrintEnabled
                ? '当前已开启实时注册声纹降噪，AI 降噪已自动关闭。'
                : aiDenoiseEnabled
                    ? '当前已开启 AI 降噪，声纹降噪已自动关闭。'
                    : '当前未开启声纹降噪和 AI 降噪，可按需直接调试。';

        this.updateRtcFeatureStatus(options.statusText || defaultStatusText, voicePrintEnabled && aiDenoiseEnabled);
    }

    updateRtcFeatureControlsDisabled(disabled) {
        this.rtcFeatureToggleButtons.forEach((button) => {
            button.disabled = disabled;
        });
    }

    updateRtcFeatureStatus(text, isError = false) {
        if (!this.rtcFeatureStatus) {
            return;
        }

        this.rtcFeatureStatus.textContent = text;
        this.rtcFeatureStatus.classList.toggle('is-error', isError);
    }

    startRtcFeaturePolling() {
        if (this.rtcFeaturePollTimer) {
            window.clearInterval(this.rtcFeaturePollTimer);
        }

        this.rtcFeaturePollTimer = window.setInterval(() => {
            if (this.isRtcFeatureSyncing) {
                return;
            }
            this.loadRtcFeatureState({ silent: true }).catch(() => {});
        }, 10000);
    }

    getAbilityDemoRuntimeConfig() {
        const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};

        return {
            apiBaseUrl: String(runtime.apiBaseUrl || 'http://127.0.0.1:8788').replace(/\/$/, ''),
            knowledgeProvider: runtime.knowledgeProvider || 'volc',
            allowKnowledgeFallback: runtime.allowKnowledgeFallback !== false
        };
    }

    normalizeKnowledgeItem(item = {}) {
        return {
            id: item.id || item.point_id || `knowledge_${Date.now()}`,
            title: item.chunk_title || item.title || item.doc_info?.title || '知识片段',
            content: item.content || item.description || '',
            docName: item.doc_info?.doc_name || item.docName || '',
            score: item.rerank_score || item.score || 0,
            ttsText: item.ttsText || '',
            videoQuery: item.videoQuery || '',
            videoTitle: item.videoTitle || '',
            videoSummary: item.videoSummary || '',
            videoLinkUrl: item.videoLinkUrl || '',
            imagePrompt: item.imagePrompt || ''
        };
    }

    getAbilityDemoQuery(abilityKey) {
        return ABILITY_DEMO_QUERY_MAP[abilityKey] || '游戏 攻略';
    }

    async fetchAbilityKnowledgeExample(abilityKey) {
        if (abilityKey === 'video') {
            const presetVideoItem = getRandomVideoDemoExample();
            if (presetVideoItem?.title || presetVideoItem?.content) {
                return this.normalizeKnowledgeItem(presetVideoItem);
            }
        }

        const query = this.getAbilityDemoQuery(abilityKey);
        const localDemoItem = searchDemoKnowledgeExamples(query, 1)[0];
        if (localDemoItem) {
            return this.normalizeKnowledgeItem(localDemoItem);
        }

        const runtime = this.getAbilityDemoRuntimeConfig();

        try {
            const response = await fetch(`${runtime.apiBaseUrl}/api/data/knowledge/search`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    provider: runtime.knowledgeProvider,
                    allowFallback: runtime.allowKnowledgeFallback,
                    query,
                    limit: 1
                })
            });
            const json = await response.json();

            if (!response.ok || !json.ok) {
                throw new Error(json.message || `知识检索失败: HTTP ${response.status}`);
            }

            const rawItems = json.data?.data?.result_list || [];
            const item = rawItems.map(rawItem => this.normalizeKnowledgeItem(rawItem)).find(candidate => candidate.content);
            if (item) {
                return item;
            }
        } catch (error) {
            console.warn('[WorkspaceModule] 能力动作知识检索失败，改用本地示例:', error);
        }

        return this.normalizeKnowledgeItem({});
    }

    async fetchReplyKnowledgeItem(query = '', options = {}) {
        const cleanQuery = this.normalizeReplyText(query, 120);
        const limit = Math.max(1, Number(options.limit || 1));

        if (!cleanQuery) {
            return this.normalizeKnowledgeItem({});
        }

        const localItem = searchDemoKnowledgeExamples(cleanQuery, 1)[0];
        if (localItem) {
            return this.normalizeKnowledgeItem(localItem);
        }

        const runtime = this.getAbilityDemoRuntimeConfig();

        try {
            const response = await fetch(`${runtime.apiBaseUrl}/api/data/knowledge/search`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    provider: runtime.knowledgeProvider,
                    allowFallback: runtime.allowKnowledgeFallback,
                    query: cleanQuery,
                    limit
                })
            });
            const json = await response.json();

            if (!response.ok || !json.ok) {
                throw new Error(json.message || `知识检索失败: HTTP ${response.status}`);
            }

            const rawItems = json.data?.data?.result_list || [];
            const item = rawItems
                .map(rawItem => this.normalizeKnowledgeItem(rawItem))
                .find(candidate => candidate.content || candidate.title);
            if (item) {
                return item;
            }
        } catch (error) {
            console.warn('[WorkspaceModule] 真实回复知识检索失败，改用空结果兜底:', error);
        }

        return this.normalizeKnowledgeItem({
            title: this.normalizeReplyText(cleanQuery, 24) || '游戏知识',
            content: cleanQuery
        });
    }

    cleanKnowledgeTitle(title) {
        return String(title || '游戏知识')
            .replace(/[【】]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    buildTtsPreviewText(item = {}) {
        const topicText = `${item.title || ''} ${item.content || ''}`.toLowerCase();
        const pool = topicText.includes('王者') ? ABILITY_TTS_TEXT_OPTIONS.hok : ABILITY_TTS_TEXT_OPTIONS.lol;
        if (pool.length > 0) {
            return pool[Math.floor(Math.random() * pool.length)];
        }

        const rawText = String(item.ttsText || item.content || item.title || '我找到一条新的攻略提示。').trim();
        if (rawText.length <= 30) {
            return rawText;
        }

        return `${rawText.slice(0, 27).trim()}...`;
    }

    buildAbilityImagePrompt(item = {}) {
        return String(item.imagePrompt || '') || [
            this.cleanKnowledgeTitle(item.title),
            item.content,
            '游戏攻略插画',
            '二次元风格',
            '信息图构图'
        ]
            .filter(Boolean)
            .join('，');
    }

    async generateAbilityImage(item = {}) {
        const runtime = this.getAbilityDemoRuntimeConfig();
        const prompt = this.buildAbilityImagePrompt(item);

        if (!prompt) {
            return '';
        }

        try {
            const response = await fetch(`${runtime.apiBaseUrl}/api/media/image/generate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    prompt
                })
            });
            const json = await response.json();

            if (!response.ok || !json.ok) {
                throw new Error(json.message || `图片生成失败: HTTP ${response.status}`);
            }

            return json.data?.url || '';
        } catch (error) {
            console.warn('[WorkspaceModule] 图片生成失败:', error);
            return '';
        }
    }

    async generateAbilityTtsAudio(text = '') {
        const runtime = this.getAbilityDemoRuntimeConfig();
        const cleanText = String(text || '').trim();

        if (!cleanText) {
            return '';
        }

        try {
            const response = await fetch(`${runtime.apiBaseUrl}/api/media/tts/audio`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: cleanText
                })
            });

            if (!response.ok) {
                throw new Error(`TTS 音频生成失败: HTTP ${response.status}`);
            }

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            return audioUrl;
        } catch (error) {
            console.warn('[WorkspaceModule] TTS 生成失败:', error);
            return '';
        }
    }

    playAbilityTtsAudio(audioUrl = '') {
        if (!audioUrl) {
            return;
        }

        if (!this.abilityTtsAudio) {
            this.abilityTtsAudio = new Audio();
        }

        if (this.abilityTtsAudioUrl && this.abilityTtsAudioUrl !== audioUrl) {
            URL.revokeObjectURL(this.abilityTtsAudioUrl);
        }

        this.abilityTtsAudio.pause();
        this.abilityTtsAudio.currentTime = 0;
        this.abilityTtsAudio.src = audioUrl;
        this.abilityTtsAudioUrl = audioUrl;
        this.abilityTtsAudio.play().catch(error => {
            console.warn('[WorkspaceModule] 能力 TTS 音频播放失败:', error);
        });
    }

    setAbilityTtsButtonLoading(isLoading) {
        if (!this.btnTts) {
            return;
        }

        this.btnTts.disabled = Boolean(isLoading);
        this.btnTts.classList.toggle('is-loading', Boolean(isLoading));
        this.btnTts.textContent = isLoading ? '语音播报示例生成中...' : '语音播报示例';
    }

    async prepareAbilityTtsPlayback() {
        if (this.abilityTtsPreparing) {
            return;
        }

        this.abilityTtsPreparing = true;

        try {
            if (!this.abilityTtsAudio) {
                this.abilityTtsAudio = new Audio();
            }

            this.abilityTtsAudio.src = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAAAAAAAAAAAAAAAAAAAA';
            this.abilityTtsAudio.muted = true;
            await this.abilityTtsAudio.play();
            this.abilityTtsAudio.pause();
            this.abilityTtsAudio.currentTime = 0;
            this.abilityTtsAudio.removeAttribute('src');
            this.abilityTtsAudio.load();
            this.abilityTtsAudio.muted = false;
        } catch (error) {
            console.warn('[WorkspaceModule] 语音播报预解锁失败:', error);
        } finally {
            this.abilityTtsPreparing = false;
        }
    }

    buildDouyinVideoQuery(item = {}, query = '') {
        return [
            item.videoQuery,
            this.cleanKnowledgeTitle(item.title),
            query,
            String(item.content || '').slice(0, 24)
        ]
            .filter(Boolean)
            .join(' ')
            .trim();
    }

    buildRealtimeVideoQuery(inputText = '', assistantText = '', item = {}) {
        return [
            this.normalizeReplyText(inputText, 40),
            item.videoQuery,
            this.cleanKnowledgeTitle(item.title),
            this.normalizeReplyText(assistantText, 28)
        ]
            .filter(Boolean)
            .join(' ')
            .trim();
    }

    async searchDouyinVideo(item = {}, query = '') {
        const runtime = this.getAbilityDemoRuntimeConfig();
        const videoQuery = this.buildDouyinVideoQuery(item, query);

        try {
            const response = await fetch(`${runtime.apiBaseUrl}/api/media/douyin/video-search`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    query: videoQuery
                })
            });
            const json = await response.json();

            if (!response.ok || !json.ok) {
                throw new Error(json.message || `抖音视频检索失败: HTTP ${response.status}`);
            }

            return json.data || null;
        } catch (error) {
            console.warn('[WorkspaceModule] 抖音视频检索失败:', error);
            return null;
        }
    }

    async searchDouyinVideoByQuery(query = '', options = {}) {
        const runtime = this.getAbilityDemoRuntimeConfig();
        const cleanQuery = this.normalizeReplyText(query, 80);

        if (!cleanQuery) {
            return null;
        }

        try {
            const response = await fetch(`${runtime.apiBaseUrl}/api/media/douyin/video-search`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    query: cleanQuery,
                    allowFallback: options.allowFallback !== false
                })
            });
            const json = await response.json();

            if (!response.ok || !json.ok) {
                throw new Error(json.message || `抖音视频检索失败: HTTP ${response.status}`);
            }

            return json.data || null;
        } catch (error) {
            console.warn('[WorkspaceModule] 真实回复抖音视频检索失败:', error);
            return null;
        }
    }

    buildDouyinSearchUrl(item = {}, query = '') {
        const keyword = [this.cleanKnowledgeTitle(item.title), query, '攻略']
            .filter(Boolean)
            .join(' ')
            .trim();

        return `https://www.douyin.com/search/${encodeURIComponent(keyword)}`;
    }

    async presentRealtimeReply(options = {}) {
        const mode = REPLY_MODE_OPTIONS[options.mode] ? options.mode : this.getCurrentReplyMode();
        const inputText = this.normalizeReplyText(options.inputText, 80);
        const assistantText = this.normalizeReplyText(options.assistantText, 160);
        const baseQuery = inputText || assistantText;
        const source = options.source || 'model';
        const forcePreview = options.forcePreview === true;

        if (!baseQuery && !assistantText) {
            return null;
        }

        if (mode === 'tts') {
            const item = await this.fetchReplyKnowledgeItem(baseQuery);
            const speechText = assistantText || this.buildTtsPreviewText(item);
            this.eventBus.emit('TRIGGER_TTS', {
                text: speechText,
                forcePreview
            });
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source,
                ability: REPLY_MODE_OPTIONS[mode],
                text: speechText
            });
            return {
                mode,
                displayText: speechText
            };
        }

        if (mode === 'knowledge') {
            const item = await this.fetchReplyKnowledgeItem(baseQuery);
            const title = item.title || `知识卡片：${this.normalizeReplyText(baseQuery, 16) || '游戏知识'}`;
            const content = assistantText || item.content || baseQuery || '暂无知识内容';
            this.eventBus.emit('TRIGGER_KNOWLEDGE', {
                title: '知识卡片生成中',
                content: '知识卡片生成中',
                loading: true,
                forcePreview
            });
            const generatedImageUrl = await this.generateAbilityImage({
                ...item,
                title,
                content
            });
            this.eventBus.emit('TRIGGER_KNOWLEDGE', {
                title,
                content,
                imgUrl: generatedImageUrl,
                forcePreview
            });
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source,
                ability: REPLY_MODE_OPTIONS[mode],
                text: content
            });
            return {
                mode,
                displayText: content
            };
        }

        if (mode === 'video') {
            const item = await this.fetchReplyKnowledgeItem(baseQuery);
            const videoQuery = this.buildRealtimeVideoQuery(inputText, assistantText, item) || baseQuery;
            const videoResult = await this.searchDouyinVideoByQuery(videoQuery, {
                allowFallback: false
            });
            const topicLabel = this.normalizeReplyText(inputText || this.cleanKnowledgeTitle(item.title) || assistantText, 20) || '游戏内容';
            const resolvedLinkUrl = videoResult?.url || videoResult?.searchUrl || this.buildDouyinSearchUrl(item, videoQuery);
            const payload = {
                title: videoResult?.title || `抖音相关视频：${topicLabel}`,
                summary: videoResult?.description || assistantText || `已根据“${topicLabel}”检索到相关抖音视频。`,
                videoUrl: videoResult?.videoUrl || '',
                linkUrl: resolvedLinkUrl,
                coverUrl: videoResult?.coverUrl || '',
                forcePreview
            };
            this.eventBus.emit('TRIGGER_video', payload);
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source,
                ability: REPLY_MODE_OPTIONS[mode],
                text: `${payload.title}，点击可查看具体抖音视频。`
            });
            return {
                mode,
                displayText: payload.summary,
                payload
            };
        }

        return null;
    }

    async triggerAbilityDemo(abilityKey) {
        const abilityNameMap = {
            tts: '语音播报',
            knowledge: '知识卡片',
            video: '精彩视频'
        };
        const item = await this.fetchAbilityKnowledgeExample(abilityKey);
        const query = this.getAbilityDemoQuery(abilityKey);

        if (abilityKey === 'tts') {
            const previewText = this.buildTtsPreviewText(item);
            this.setAbilityTtsButtonLoading(true);

            try {
                const generatedAudioUrl = await this.generateAbilityTtsAudio(previewText);
                this.playAbilityTtsAudio(generatedAudioUrl);
                this.eventBus.emit('ABILITY_FEEDBACK', {
                    source: 'ui',
                    ability: abilityNameMap[abilityKey],
                    text: previewText
                });
            } finally {
                this.setAbilityTtsButtonLoading(false);
            }
            return;
        }

        if (abilityKey === 'knowledge') {
            this.eventBus.emit('TRIGGER_KNOWLEDGE', {
                title: '知识卡片生成中',
                content: '知识卡片生成中',
                loading: true,
                forcePreview: true
            });
            const generatedImageUrl = await this.generateAbilityImage(item);
            const payload = {
                title: item.title || '知识卡片示例',
                content: item.content || '暂无知识内容',
                imgUrl: generatedImageUrl,
                forcePreview: true
            };
            this.eventBus.emit('TRIGGER_KNOWLEDGE', payload);
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'ui',
                ability: abilityNameMap[abilityKey],
                text: payload.content
            });
            return;
        }

        if (abilityKey === 'video') {
            const videoResult = item.videoLinkUrl ? null : await this.searchDouyinVideo(item, query);
            const linkUrl = item.videoLinkUrl || videoResult?.url || this.buildDouyinSearchUrl(item, query);
            const payload = {
                title: item.videoTitle || videoResult?.title || `抖音热视频：${this.cleanKnowledgeTitle(item.title)}`,
                summary: item.videoSummary || videoResult?.description || item.content || '已根据知识内容检索到相关抖音视频。',
                videoUrl: videoResult?.videoUrl || '',
                linkUrl,
                coverUrl: '',
                forcePreview: true
            };
            this.eventBus.emit('TRIGGER_video', payload);
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'ui',
                ability: abilityNameMap[abilityKey],
                text: `${payload.title}，点击可查看具体抖音视频。`
            });
        }
    }

    bindAbilityButtons() {
        const btnKnowledge = document.getElementById('btn-knowledge');
        const btnVideo = document.getElementById('btn-video');

        if (this.btnTts) {
            this.btnTts.addEventListener('click', async () => {
                await this.prepareAbilityTtsPlayback();
                await this.triggerAbilityDemo('tts');
            });
        }

        if (btnKnowledge) {
            btnKnowledge.addEventListener('click', async () => {
                await this.triggerAbilityDemo('knowledge');
            });
        }

        if (btnVideo) {
            btnVideo.addEventListener('click', async () => {
                await this.triggerAbilityDemo('video');
            });
        }
    }

    bindVideoWorkspace() {
        const openPicker = () => {
            if (this.fileInput) {
                this.fileInput.click();
            }
        };

        this.selectVideoButton?.addEventListener('click', openPicker);
        this.selectVideoInlineButton?.addEventListener('click', openPicker);
        this.reselectVideoButton?.addEventListener('click', openPicker);

        this.fileInput?.addEventListener('change', (event) => {
            const file = event.target.files && event.target.files[0];
            if (file) {
                this.loadLocalVideo(file);
            }
        });

        this.dropzone?.addEventListener('dragover', (event) => {
            event.preventDefault();
            this.dropzone.classList.add('is-dragging');
        });

        this.dropzone?.addEventListener('dragleave', () => {
            this.dropzone.classList.remove('is-dragging');
        });

        this.dropzone?.addEventListener('drop', (event) => {
            event.preventDefault();
            this.dropzone.classList.remove('is-dragging');
            const file = event.dataTransfer?.files && event.dataTransfer.files[0];
            if (file && file.type.startsWith('video/')) {
                this.loadLocalVideo(file);
            }
        });

        this.playToggleButton?.addEventListener('click', () => {
            if (!this.videoElement?.src) {
                return;
            }
            if (this.videoElement.paused) {
                this.videoElement.play();
            } else {
                this.videoElement.pause();
            }
        });

        this.videoElement?.addEventListener('loadedmetadata', () => {
            this.durationLabel.textContent = this.formatTime(this.videoElement.duration);
            this.progressInput.value = '0';
            this.currentTimeLabel.textContent = '00:00';
            this.updateVideoStatus('已加载');
            this.updateShareButtonState();
            writeWorkspaceDebugLog('video.loadedmetadata', {
                video: serializeVideoElement(this.videoElement),
                currentVideoUrl: this.currentVideoUrl || ''
            });
            this.notifyRtcVideoSource('loadedmetadata');
        });

        this.videoElement?.addEventListener('loadeddata', () => {
            this.updateShareButtonState();
            writeWorkspaceDebugLog('video.loadeddata', {
                video: serializeVideoElement(this.videoElement),
                currentVideoUrl: this.currentVideoUrl || ''
            });
            this.notifyRtcVideoSource('loadeddata');
        });

        this.videoElement?.addEventListener('timeupdate', () => {
            if (!this.videoElement.duration) {
                return;
            }
            const progress = (this.videoElement.currentTime / this.videoElement.duration) * 100;
            this.progressInput.value = String(progress);
            this.currentTimeLabel.textContent = this.formatTime(this.videoElement.currentTime);
        });

        this.videoElement?.addEventListener('play', () => {
            this.playToggleButton.textContent = '暂停';
            this.updateVideoStatus('播放中');
            this.updateShareButtonState();
            writeWorkspaceDebugLog('video.play', {
                video: serializeVideoElement(this.videoElement),
                currentVideoUrl: this.currentVideoUrl || ''
            });
            this.notifyRtcVideoSource('play');
        });

        this.videoElement?.addEventListener('pause', () => {
            this.playToggleButton.textContent = '播放';
            if (this.videoElement.currentTime > 0 && !this.videoElement.ended) {
                this.updateVideoStatus('已暂停');
            }
            this.updateShareButtonState();
            writeWorkspaceDebugLog('video.pause', {
                video: serializeVideoElement(this.videoElement),
                currentVideoUrl: this.currentVideoUrl || ''
            });
        });

        this.videoElement?.addEventListener('ended', () => {
            this.playToggleButton.textContent = '重播';
            this.updateVideoStatus('播放完成');
            writeWorkspaceDebugLog('video.ended', {
                video: serializeVideoElement(this.videoElement),
                currentVideoUrl: this.currentVideoUrl || ''
            });
        });

        this.progressInput?.addEventListener('input', () => {
            if (!this.videoElement.duration) {
                return;
            }
            const nextTime = (Number(this.progressInput.value) / 100) * this.videoElement.duration;
            this.videoElement.currentTime = nextTime;
        });

        this.volumeInput?.addEventListener('input', () => {
            const volume = Number(this.volumeInput.value);
            this.videoElement.volume = volume;
            this.videoElement.muted = volume === 0;
            this.updateMuteText();
        });

        this.muteToggleButton?.addEventListener('click', () => {
            this.videoElement.muted = !this.videoElement.muted;
            if (!this.videoElement.muted && Number(this.volumeInput.value) === 0) {
                this.volumeInput.value = '1';
                this.videoElement.volume = 1;
            }
            this.updateMuteText();
        });

        this.fullscreenButton?.addEventListener('click', async () => {
            if (!this.videoElement) {
                return;
            }
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                return;
            }
            await this.videoElement.requestFullscreen?.();
        });

        if (this.rtcShareScreenBtn) {
            this.rtcShareScreenBtn.addEventListener('click', () => {
                const hasVideo = !!(this.videoElement?.srcObject || this.videoElement?.src || this.currentVideoUrl);
                const payload = {
                    currentMode: this.currentMode,
                    hasVideo,
                    isScreenSharing: this.isScreenSharing,
                    isScreenSharePending: this.isScreenSharePending,
                    video: serializeVideoElement(this.videoElement)
                };
                console.log('[WorkspaceModule] 点击共享屏幕按钮', payload);
                writeWorkspaceDebugLog('share_button.click', payload);

                if (this.isScreenSharing) {
                    this.eventBus.emit('rtc_stop_screen_share');
                } else {
                    this.eventBus.emit('rtc_start_screen_share');
                }
            });
        }

        this.updateShareButtonState();
    }

    /**
     * 更新共享按钮的状态（根据是否有视频在播放）
     */
    updateShareButtonState() {
        if (!this.rtcShareScreenBtn) {
            return;
        }

        const hasVideo = !!(this.videoElement?.srcObject || this.videoElement?.src || this.currentVideoUrl);

        this.rtcShareScreenBtn.disabled = false;
        if (this.isScreenSharing) {
            this.rtcShareScreenBtn.title = '当前正在共享视频工作区，可点击停止';
            return;
        }

        if (this.isScreenSharePending) {
            if (this.screenSharePendingReason === 'voice') {
                this.rtcShareScreenBtn.title = '语音聊天尚未就绪，StartVoiceChat 成功后会自动开始共享';
                return;
            }
            if (this.screenSharePendingReason === 'rtc') {
                this.rtcShareScreenBtn.title = 'RTC 连接尚未完成，入房后会自动开始共享';
                return;
            }
            this.rtcShareScreenBtn.title = hasVideo
                ? '检测到视频后会自动接管并开始共享'
                : '已进入待共享状态，后续上传或播放视频会自动开始共享';
            return;
        }

        this.rtcShareScreenBtn.title = hasVideo
            ? '点击后将共享视频工作区中的当前视频'
            : '点击后进入待共享状态，后续上传或播放视频会自动共享';
    }

    bindEventBus() {
        this.eventBus.on('MODE_CHANGED', (mode) => {
            this.currentMode = mode;
            this.updateModeUI(mode);
            this.updateShareButtonState();
        });

        this.eventBus.on('RTC_CONNECTED', () => {
            this.statusRtc.textContent = 'RTC 状态: 已连接';
        });

        this.eventBus.on('RTC_DISCONNECTED', () => {
            this.statusRtc.textContent = 'RTC 状态: 未连接';
        });

        // 将用户与智能体的字幕/文本合并为一条对话记录展示
        this.eventBus.on('SESSION_MESSAGE', (payload) => {
            this.appendConversationLogFromSessionMessage(payload);
        });

        this.eventBus.on('ABILITY_FEEDBACK', (payload) => {
            this.appendAbilityLog(payload);
        });

        this.eventBus.on('RTC_SESSION_MESSAGE_SYNC_FAILED', (payload) => {
            this.appendAbilityLog({
                source: 'signal',
                ability: 'RTC 对话存档',
                text: payload?.error
                    ? `会话记录同步失败：${payload.error}`
                    : '会话记录同步失败。'
            });
        });

        // 屏幕共享状态监听
        this.eventBus.on('rtc_screen_share_pending', (payload) => {
            this.isScreenSharing = false;
            this.isScreenSharePending = true;
            this.screenSharePendingReason = payload?.waitingForVoiceChat
                ? 'voice'
                : payload?.waitingForRtc
                    ? 'rtc'
                    : 'video';
            if (this.rtcShareScreenBtn) {
                this.rtcShareScreenBtn.textContent = this.screenSharePendingReason === 'voice'
                    ? '等待会话就绪'
                    : this.screenSharePendingReason === 'rtc'
                        ? '等待RTC连接'
                        : '等待视频接入';
                this.rtcShareScreenBtn.classList.remove('danger');
            }
            console.log('[WorkspaceModule] 屏幕共享进入待绑定状态', payload || {});
            writeWorkspaceDebugLog('share.pending', {
                state: {
                    currentMode: this.currentMode,
                    isScreenSharing: this.isScreenSharing,
                    isScreenSharePending: this.isScreenSharePending
                },
                video: serializeVideoElement(this.videoElement),
                rtcPayload: payload || {}
            });
            this.updateShareButtonState();
        });

        this.eventBus.on('rtc_screen_share_started', (payload) => {
            this.isScreenSharing = true;
            this.isScreenSharePending = false;
            this.screenSharePendingReason = '';
            if (this.rtcShareScreenBtn) {
                this.rtcShareScreenBtn.textContent = '停止共享';
                this.rtcShareScreenBtn.classList.add('danger');
            }
            writeWorkspaceDebugLog('share.started', {
                state: {
                    currentMode: this.currentMode,
                    isScreenSharing: this.isScreenSharing,
                    isScreenSharePending: this.isScreenSharePending
                },
                video: serializeVideoElement(this.videoElement),
                rtcPayload: payload || {}
            });
            this.updateShareButtonState();
        });

        this.eventBus.on('rtc_screen_share_stopped', () => {
            this.isScreenSharing = false;
            this.isScreenSharePending = false;
            this.screenSharePendingReason = '';
            if (this.rtcShareScreenBtn) {
                this.rtcShareScreenBtn.textContent = '共享屏幕';
                this.rtcShareScreenBtn.classList.remove('danger');
            }
            writeWorkspaceDebugLog('share.stopped', {
                state: {
                    currentMode: this.currentMode,
                    isScreenSharing: this.isScreenSharing,
                    isScreenSharePending: this.isScreenSharePending
                },
                video: serializeVideoElement(this.videoElement)
            });
            this.updateShareButtonState();
        });

        this.eventBus.on('rtc_screen_share_failed', (error) => {
            console.error(`屏幕共享失败: ${error?.message || error?.name || '未知错误'}`);
            this.isScreenSharing = false;
            this.isScreenSharePending = false;
            this.screenSharePendingReason = '';
            if (this.rtcShareScreenBtn) {
                this.rtcShareScreenBtn.textContent = '共享屏幕';
                this.rtcShareScreenBtn.classList.remove('danger');
            }
            writeWorkspaceDebugLog('share.failed', {
                state: {
                    currentMode: this.currentMode,
                    isScreenSharing: this.isScreenSharing,
                    isScreenSharePending: this.isScreenSharePending
                },
                video: serializeVideoElement(this.videoElement),
                error: {
                    name: error?.name || '',
                    message: error?.message || '未知错误'
                }
            });
            this.updateShareButtonState();
        });
    }

    /**
     * 加载测试视频，方便验证推流
     */
    loadTestVideo() {
        // 先用 Canvas 生成一个动态模拟流，替代真实视频文件
        this._setupSimulatedVideoStream();

        const testVideoUrl = 'https://media.w3.org/2010/05/sintel/trailer.mp4';
        this.currentVideoUrl = testVideoUrl;
        this.videoElement.src = testVideoUrl;
        this.videoElement.crossOrigin = 'anonymous';
        this.videoElement.load();
        this.videoElement.muted = true;

        this.emptyState.classList.add('is-hidden');
        this.videoShell.classList.remove('is-hidden');
        this.videoFileName.textContent = '测试视频_Sintel.mp4';
        this.videoFileTip.textContent = '测试视频已自动加载';
        this.updateVideoStatus('准备就绪');

        this.videoElement.play().catch(err => {
            console.log('自动播放被拦截，请手动点击播放按钮:', err);
        });

        this.videoElement.onloadeddata = () => {
            this.updateShareButtonState();
            this.notifyRtcVideoSource('test-video-loaded');
        };
    }

    /**
     * 使用 Canvas 生成一个动态模拟视频流，注入到 videoElement 中
     * 这样不需要真实视频文件也能测试 captureStream 推流
     */
    _setupSimulatedVideoStream() {
        console.log('[WorkspaceModule] 正在初始化 Canvas 模拟视频流...');

        // 创建一个隐藏的 canvas 用于生成动态画面
        this._simCanvas = document.createElement('canvas');
        this._simCanvas.width = 1280;
        this._simCanvas.height = 720;
        this._simCanvas.style.display = 'none';
        document.body.appendChild(this._simCanvas);

        const ctx = this._simCanvas.getContext('2d');
        let frameCount = 0;

        const drawFrame = () => {
            frameCount++;
            const w = this._simCanvas.width;
            const h = this._simCanvas.height;

            // 动态背景：颜色随时间渐变
            const hue = (frameCount * 2) % 360;
            ctx.fillStyle = `hsl(${hue}, 60%, 15%)`;
            ctx.fillRect(0, 0, w, h);

            // 绘制一个移动的圆形，模拟视频中的主体
            const cx = (w / 2) + Math.sin(frameCount * 0.02) * 300;
            const cy = (h / 2) + Math.cos(frameCount * 0.015) * 200;
            const radius = 80 + Math.sin(frameCount * 0.05) * 20;

            const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            gradient.addColorStop(0, `hsl(${(hue + 120) % 360}, 90%, 60%)`);
            gradient.addColorStop(1, `hsl(${(hue + 240) % 360}, 80%, 40%)`);
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fill();

            // 绘制帧数和文字信息
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 36px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(`模拟视频流 - 帧: ${frameCount}`, w / 2, 60);
            ctx.font = '24px Arial';
            ctx.fillText(`分辨率: ${w}x${h}`, w / 2, h - 40);
            ctx.fillText(`时间: ${Date.now()}`, w / 2, h - 80);

            // 如果视频元素已就绪，把 canvas 流赋值给它
            if (this.videoElement && !this.videoElement.src) {
                try {
                    const stream = this._simCanvas.captureStream(10); // 10 fps
                    this.videoElement.srcObject = stream;
                    console.log('[WorkspaceModule] Canvas 模拟流已注入到 videoElement');
                    this.updateShareButtonState();
                    this.notifyRtcVideoSource('simulated-stream-ready');
                } catch (e) {
                    console.error('[WorkspaceModule] 注入模拟流失败:', e);
                }
            }

            this._simAnimFrame = requestAnimationFrame(drawFrame);
        };

        drawFrame();

        // 标记模拟流已激活
        this._isSimulatedStream = true;
        console.log('[WorkspaceModule] Canvas 模拟视频流已启动，10fps 720P');
    }

    /**
     * 清理模拟流资源
     */
    _cleanupSimulatedStream() {
        if (this._simAnimFrame) {
            cancelAnimationFrame(this._simAnimFrame);
            this._simAnimFrame = null;
        }
        if (this._simCanvas) {
            document.body.removeChild(this._simCanvas);
            this._simCanvas = null;
        }
        this._isSimulatedStream = false;
    }

    isVideoReadyForRtc(videoElement = this.videoElement) {
        if (!videoElement) {
            return false;
        }

        const hasSrcObjectTrack =
            !!videoElement.srcObject &&
            typeof videoElement.srcObject.getVideoTracks === 'function' &&
            videoElement.srcObject.getVideoTracks().length > 0;

        if (hasSrcObjectTrack) {
            return true;
        }

        const hasDecodedFrame =
            (videoElement.readyState ?? 0) >= 2 &&
            !!(videoElement.currentSrc || videoElement.src) &&
            ((videoElement.videoWidth || 0) > 0 || (videoElement.videoHeight || 0) > 0);

        return hasDecodedFrame;
    }

    loadLocalVideo(file) {
        if (this.currentVideoUrl) {
            URL.revokeObjectURL(this.currentVideoUrl);
        }
        if (this.videoElement?.srcObject) {
            this.videoElement.srcObject = null;
        }
        if (this._isSimulatedStream) {
            this._cleanupSimulatedStream();
        }
        if (this.videoElement) {
            this.videoElement.onloadeddata = null;
        }
        this.currentVideoUrl = URL.createObjectURL(file);
        this.videoElement.src = this.currentVideoUrl;
        this.videoElement.load();
        this.emptyState.classList.add('is-hidden');
        this.videoShell.classList.remove('is-hidden');
        this.videoFileName.textContent = file.name;
        this.videoFileTip.textContent = '本地视频已加载';
        this.updateVideoStatus('本地视频已加载');
        this.updateShareButtonState();
        writeWorkspaceDebugLog('video.local_selected', {
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            objectUrl: this.currentVideoUrl,
            video: serializeVideoElement(this.videoElement)
        });

        const shouldAutoPlay =
            this.currentMode === 'rtc' || this.isScreenSharePending || this.isScreenSharing;
        const notifyWhenReady = () => {
            this.notifyRtcVideoSource('local-video-ready');
        };

        if (this.isVideoReadyForRtc(this.videoElement)) {
            notifyWhenReady();
        } else {
            this.videoElement?.addEventListener('loadeddata', notifyWhenReady, { once: true });
        }

        if (shouldAutoPlay) {
            const tryAutoPlay = () => {
                this.videoElement?.play().catch((error) => {
                    console.warn('[WorkspaceModule] 本地视频自动播放失败，等待用户手动播放', error);
                    writeWorkspaceDebugLog('video.autoplay_failed', {
                        reason: 'local-video-selected',
                        currentMode: this.currentMode,
                        isScreenSharing: this.isScreenSharing,
                        isScreenSharePending: this.isScreenSharePending,
                        error: error?.message || String(error)
                    });
                });
            };

            if (this.videoElement?.readyState >= 2) {
                tryAutoPlay();
            } else {
                this.videoElement?.addEventListener('loadeddata', tryAutoPlay, { once: true });
            }
        }
    }

    notifyRtcVideoSource(reason = 'unknown') {
        const videoSnapshot = serializeVideoElement(this.videoElement);
        const hasVideo = this.isVideoReadyForRtc(this.videoElement);
        const payload = {
            reason,
            hasVideo,
            isPlaying: !!(this.videoElement && !this.videoElement.paused && !this.videoElement.ended),
            readyState: this.videoElement?.readyState ?? 0,
            currentSrc: this.videoElement?.currentSrc || this.videoElement?.src || '',
            hasSrcObject: !!this.videoElement?.srcObject,
            videoElementId: this.videoElement?.id || '',
            videoSnapshot,
            videoElement: this.videoElement
        };
        console.log('[WorkspaceModule] 通知 RTC 视频源变化', payload);
        writeWorkspaceDebugLog('video_source.updated', {
            reason,
            hasVideo,
            isPlaying: payload.isPlaying,
            videoElementId: payload.videoElementId,
            video: videoSnapshot
        });
        this.eventBus.emit('RTC_VIDEO_SOURCE_UPDATED', payload);
    }

    updateModeUI(mode) {
        const modeTextMap = {
            pet: '桌宠语音模式',
            text_chat: '文本聊天',
            rtc: '桌宠屏幕共享模式'
        };

        this.modeButtons.forEach((button) => {
            button.classList.toggle('is-active', button.dataset.mode === mode);
        });

        if (this.statusMode) {
            this.statusMode.textContent = `当前模式: ${modeTextMap[mode] || mode}`;
        }
        if (this.modeDescription) {
            this.modeDescription.textContent = this.modeDescriptions[mode] || '已进入新的交互模式。';
        }

        const menuMap = {
            pet: document.getElementById('menu-pet'),
            text_chat: document.getElementById('menu-chat'),
            rtc: document.getElementById('menu-video')
        };
        Object.values(menuMap).forEach((menu) => menu?.classList.remove('is-active'));
        menuMap[mode]?.classList.add('is-active');
    }

    ensureAbilityFeedNotEmpty() {
        if (!this.abilityFeed) {
            return;
        }

        const emptyNode = this.abilityFeed.querySelector('.ability-empty');
        if (emptyNode) {
            emptyNode.remove();
        }
    }

    getConversationChannelFromSessionMessage(payload = {}) {
        const targets = Array.isArray(payload.targets) ? payload.targets : [];
        if (targets.includes('rtc')) {
            return 'rtc';
        }
        if (targets.includes('chat')) {
            return 'chat';
        }
        return '';
    }

    getConversationLabel(payload = {}, channel) {
        if (channel === 'rtc') {
            const source = String(payload.source || '').toLowerCase();
            if (source.includes('asr')) {
                return 'RTC 语音';
            }
            if (source.includes('text')) {
                return 'RTC 文本';
            }
            return 'RTC';
        }
        if (channel === 'chat') {
            return '文本聊天';
        }
        return '对话';
    }

    shouldIncludeConversationSessionMessage(payload = {}, channel = '') {
        const source = String(payload.source || '').toLowerCase();
        const role = payload.role || 'assistant';

        if (source === 'pet_tap') {
            return false;
        }

        if (channel === 'rtc') {
            return [
                'rtc_user_asr',
                'rtc_subtitle',
                'rtc_text_input'
            ].includes(source);
        }

        if (channel === 'chat') {
            if (role === 'user') {
                return source === 'chat_input';
            }
            return source === 'chat_reply';
        }

        return false;
    }

    createConversationEntry({ channel, label }) {
        const id = `conv_${Date.now()}_${this.conversationEntrySeed++}`;
        return {
            id,
            channel,
            label,
            userText: '',
            assistantText: '',
            transcript: [],
            createdAt: Date.now(),
            lastUpdatedAt: Date.now(),
            element: null
        };
    }

    renderConversationEntry(entry) {
        if (!entry?.element) {
            return;
        }

        // 清空并使用 textContent 防止注入
        entry.element.textContent = '';

        const head = document.createElement('div');
        head.className = 'ability-log-head';

        const title = document.createElement('strong');
        title.textContent = '对话';

        const badge = document.createElement('span');
        badge.className = 'ability-source';
        badge.textContent = entry.label || '对话';

        head.appendChild(title);
        head.appendChild(badge);

        entry.element.appendChild(head);
        if (Array.isArray(entry.transcript) && entry.transcript.length > 0) {
            entry.transcript.forEach((item) => {
                const line = document.createElement('p');
                line.textContent = `${item.role === 'user' ? '用户' : '智能体'}：${item.text}`;
                entry.element.appendChild(line);
            });
            return;
        }

        const userLine = document.createElement('p');
        userLine.textContent = entry.userText ? `用户：${entry.userText}` : '用户：';

        const assistantLine = document.createElement('p');
        assistantLine.textContent = entry.assistantText ? `智能体：${entry.assistantText}` : '智能体：';

        entry.element.appendChild(userLine);
        entry.element.appendChild(assistantLine);
    }

    getRtcAssistantFallbackUserText(payload = {}) {
        const source = String(payload.source || '').toLowerCase();
        if (source === 'rtc_subtitle') {
            return '语音输入（未拿到本地字幕）';
        }
        return '';
    }

    appendConversationLogFromSessionMessage(payload = {}) {
        if (!this.abilityFeed) {
            return;
        }

        const text = String(payload.text || '').trim();
        if (!text) {
            return;
        }

        const role = payload.role || 'assistant';
        if (!['user', 'assistant'].includes(role)) {
            return;
        }

        const channel = this.getConversationChannelFromSessionMessage(payload);
        if (!channel) {
            return;
        }

        if (!this.shouldIncludeConversationSessionMessage(payload, channel)) {
            return;
        }

        // ability-feed 只展示一次，优先把同时含 chat/rtc 的消息归到 rtc
        this.ensureAbilityFeedNotEmpty();

        const now = Date.now();
        const label = this.getConversationLabel(payload, channel);
        const lastEntry = this.lastConversationByChannel[channel];

        if (channel === 'rtc') {
            let entry = lastEntry;
            if (!entry || entry.channel !== 'rtc' || !entry.element) {
                entry = this.createConversationEntry({ channel, label });
                const item = document.createElement('div');
                item.className = 'ability-log-item ability-log-item--conversation';
                entry.element = item;
                this.abilityFeed.prepend(item);
            }

            const transcript = Array.isArray(entry.transcript) ? entry.transcript : [];
            const normalizedText = text.trim();
            const previous = transcript.length > 0 ? transcript[transcript.length - 1] : null;

            if (previous && previous.role === role) {
                if (normalizedText && !previous.text.endsWith(normalizedText)) {
                    previous.text = `${previous.text} ${normalizedText}`.trim();
                }
            } else {
                transcript.push({
                    role,
                    text: normalizedText
                });
            }

            entry.transcript = transcript;
            entry.userText = '';
            entry.assistantText = '';
            entry.label = label;
            entry.lastUpdatedAt = now;
            this.renderConversationEntry(entry);
            this.lastConversationByChannel[channel] = entry;
            writeWorkspaceDebugLog('conversation.update', {
                channel,
                role,
                text,
                mode: 'single_session_box'
            });

            while (this.abilityFeed.children.length > 100) {
                this.abilityFeed.removeChild(this.abilityFeed.lastElementChild);
            }
            return;
        }

        if (role === 'user') {
            const entry = this.createConversationEntry({ channel, label });
            entry.userText = text;

            const item = document.createElement('div');
            item.className = 'ability-log-item ability-log-item--conversation';
            entry.element = item;
            this.renderConversationEntry(entry);
            this.abilityFeed.prepend(item);
            this.lastConversationByChannel[channel] = entry;
            writeWorkspaceDebugLog('conversation.append', {
                channel,
                role: 'user',
                text
            });
        } else {
            const canAttachToLast =
                lastEntry &&
                lastEntry.channel === channel &&
                (now - (lastEntry.lastUpdatedAt || lastEntry.createdAt || 0)) < 120000;

            if (canAttachToLast) {
                // 优先补全“用户已说但智能体还没回”的一轮
                if (!lastEntry.assistantText) {
                    lastEntry.assistantText = text;
                } else if ((now - (lastEntry.lastUpdatedAt || 0)) < 8000) {
                    // RTC 字幕可能分段到达，短时间内追加到同一条里
                    lastEntry.assistantText = `${lastEntry.assistantText} ${text}`.trim();
                } else {
                    const entry = this.createConversationEntry({ channel, label });
                    entry.assistantText = text;
                    const item = document.createElement('div');
                    item.className = 'ability-log-item ability-log-item--conversation';
                    entry.element = item;
                    this.renderConversationEntry(entry);
                    this.abilityFeed.prepend(item);
                    this.lastConversationByChannel[channel] = entry;
                    writeWorkspaceDebugLog('conversation.append', {
                        channel,
                        role: 'assistant',
                        text,
                        reason: 'new_turn'
                    });
                    // 继续后续的清理逻辑
                    while (this.abilityFeed.children.length > 100) {
                        this.abilityFeed.removeChild(this.abilityFeed.lastElementChild);
                    }
                    return;
                }

                lastEntry.lastUpdatedAt = now;
                this.renderConversationEntry(lastEntry);
                this.lastConversationByChannel[channel] = lastEntry;
                writeWorkspaceDebugLog('conversation.update', {
                    channel,
                    role: 'assistant',
                    text
                });
            } else {
                const fallbackUserText = channel === 'rtc'
                    ? this.getRtcAssistantFallbackUserText(payload)
                    : '';

                if (!fallbackUserText) {
                    // 非 RTC 语音场景仍然要求从明确的用户输入开始
                    writeWorkspaceDebugLog('conversation.skip', {
                        channel,
                        role: 'assistant',
                        text,
                        reason: 'no_user_turn'
                    });
                } else {
                    const entry = this.createConversationEntry({ channel, label });
                    entry.userText = fallbackUserText;
                    entry.assistantText = text;
                    const item = document.createElement('div');
                    item.className = 'ability-log-item ability-log-item--conversation';
                    entry.element = item;
                    this.renderConversationEntry(entry);
                    this.abilityFeed.prepend(item);
                    this.lastConversationByChannel[channel] = entry;
                    writeWorkspaceDebugLog('conversation.append', {
                        channel,
                        role: 'assistant',
                        text,
                        reason: 'rtc_assistant_fallback'
                    });
                }
            }
        }

        // 放宽限制以支持滚动，最多保留 100 条记录
        while (this.abilityFeed.children.length > 100) {
            this.abilityFeed.removeChild(this.abilityFeed.lastElementChild);
        }
    }

    appendAbilityLog(payload = {}) {
        if (!this.abilityFeed) {
            return;
        }

        this.ensureAbilityFeedNotEmpty();

        const item = document.createElement('div');
        item.className = 'ability-log-item';

        const sourceMap = {
            ui: 'UI 点击',
            model: '模型返回',
            signal: '信令返回'
        };

        item.innerHTML = `
            <div class="ability-log-head">
                <strong>${payload.ability || '能力动作'}</strong>
                <span class="ability-source">${sourceMap[payload.source] || '系统事件'}</span>
            </div>
            <p>${payload.text || '已触发一次能力动作。'}</p>
        `;

        this.abilityFeed.prepend(item);
        // 放宽限制以支持滚动，最多保留 100 条记录
        while (this.abilityFeed.children.length > 100) {
            this.abilityFeed.removeChild(this.abilityFeed.lastElementChild);
        }
    }

    updateVideoStatus(statusText) {
        this.statusVideo.textContent = `视频状态: ${statusText}`;
    }

    updateMuteText() {
        this.muteToggleButton.textContent = this.videoElement.muted ? '取消静音' : '静音';
    }

    formatTime(seconds) {
        if (!Number.isFinite(seconds)) {
            return '00:00';
        }

        const totalSeconds = Math.floor(seconds);
        const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
        const remainSeconds = String(totalSeconds % 60).padStart(2, '0');
        return `${minutes}:${remainSeconds}`;
    }
}
