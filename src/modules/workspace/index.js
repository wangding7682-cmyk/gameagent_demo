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

        // 新增：视频工作区模式切换和屏幕共享
        this.stageModeSwitchButtons = Array.from(document.querySelectorAll('.stage-mode-switch .mode-btn'));
        this.pushLocalVideoButton = document.getElementById('btn-push-local-video');
        this.screenShareShell = document.getElementById('screen-share-shell');
        this.screenShareEmpty = document.getElementById('screen-share-empty');
        this.screenShareActive = document.getElementById('screen-share-active');
        this.screenSharePreview = document.getElementById('screen-share-preview');
        this.screenShareStatus = document.getElementById('screen-share-status');
        this.startScreenShareButton = document.getElementById('btn-start-screen-share');
        this.stopScreenShareButton = document.getElementById('btn-stop-screen-share');

        this.currentVideoUrl = '';
        this.currentStageMode = 'local'; // 'local' | 'screen'
        this.currentScreenStream = null;
        this.modeDescriptions = {
            pet: '开启语音聊天后，会拉起通话窗口，你可以直接对小G说话或输入文字。',
            text_chat: '打开文本聊天窗口，适合攻略问答、闲聊与知识查询。',
            rtc: '开启屏幕共享后，小G可以结合游戏视频画面理解你的问题。'
        };

        this.rtcTextInput = document.getElementById('rtc-text-input');
        this.rtcSendTextBtn = document.getElementById('rtc-send-text');
        this.rtcInterruptBtn = document.getElementById('rtc-interrupt');
        this.rtcShareScreenBtn = document.getElementById('rtc-share-screen');

        this.isScreenSharing = false;
        this.isScreenSharePending = false;
        this.screenSharePendingReason = '';
        this.isRtcConnected = false;
        this.currentMode = 'pet';
        this.rtcFeatureState = null;
        this.isRtcFeatureSyncing = false;
        this.rtcFeaturePollTimer = null;
    }

    init() {
        this.bindModeButtons();
        this.bindRtcFeatureControls();
        this.bindAbilityButtons();
        this.bindVideoWorkspace();
        this.bindStageModeSwitch();
        this.bindEventBus();
        this.updateModeUI('pet');
        this.updateVideoStatus('未选择');
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


    getCurrentReplyMode() {
        const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
        const rtcRuntime = runtime.rtc || {};
        const mode = runtime.replyMode || rtcRuntime.replyMode || 'tts';
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

    stripBracketDescriptions(text = '') {
        return String(text)
            .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    getRtcApiBaseUrl() {
        const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
        const rtcRuntime = runtime.rtc || {};
        return String(runtime.apiBaseUrl || rtcRuntime.apiBaseUrl || 'http://127.0.0.1:8788').replace(/\/$/, '');
    }

    getBackendConnectivityState() {
        if (typeof window === 'undefined') {
            return { available: true, pausedUntil: 0 };
        }
        return window.__GAME_AI_BACKEND_STATUS__ || { available: true, pausedUntil: 0 };
    }

    isBackendRequestPaused() {
        const state = this.getBackendConnectivityState();
        return state.available === false && Number(state.pausedUntil || 0) > Date.now();
    }

    getBackendRetryText() {
        const state = this.getBackendConnectivityState();
        const remainingMs = Math.max(0, Number(state.pausedUntil || 0) - Date.now());
        return `${Math.max(1, Math.ceil(remainingMs / 1000))} 秒后重试`;
    }

    async loadRtcFeatureState(options = {}) {
        const silent = options.silent === true;
        if (this.isBackendRequestPaused()) {
            if (!silent) {
                this.updateRtcFeatureStatus(`后端暂不可用，音频输入算法设置已暂停同步，${this.getBackendRetryText()}`, true);
            }
            return;
        }
        if (!silent) {
            this.updateRtcFeatureStatus('正在读取音频输入算法设置...');
        }

        try {
            const response = await fetch(`${this.getRtcApiBaseUrl()}/api/rtc/voice-chat/features`);
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.ok) {
                throw new Error(data?.message || `读取 RTC 功能配置失败: ${response.status}`);
            }

            this.applyRtcFeatureState(data.data?.features || null, {
                source: 'remote',
                statusText: `已同步音频输入算法设置：智能语义判停 ${data.data?.features?.aiVad?.enabled ? '开' : '关'} / 声纹降噪 ${data.data?.features?.voicePrintRealtime?.enabled ? '开' : '关'} / AI 降噪 ${data.data?.features?.aiDenoise?.enabled ? '开' : '关'}`
            });
        } catch (err) {
            if (!silent) {
                this.updateRtcFeatureStatus('无法读取音频输入算法设置（后端可能未启动）', true);
            }
        }
    }

    async saveRtcFeatureState(payload) {
        this.isRtcFeatureSyncing = true;
        this.updateRtcFeatureControlsDisabled(true);
        this.updateRtcFeatureStatus('正在保存开启智能体对话配置...');

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
            statusText: '已保存开启智能体对话配置，下一次建立语音连接时生效。'
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
            if (this.isRtcFeatureSyncing || this.isBackendRequestPaused()) {
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
        const isDemo = options.isDemo === true;

        if (!cleanQuery) {
            return this.normalizeKnowledgeItem({});
        }

        if (isDemo) {
            const localItem = searchDemoKnowledgeExamples(cleanQuery, 1)[0];
            if (localItem) {
                return this.normalizeKnowledgeItem(localItem);
            }
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

    buildVideoQuery(item = {}, query = '') {
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
        const videoQuery = this.buildVideoQuery(item, query);

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
                throw new Error(json.message || `视频检索失败: HTTP ${response.status}`);
            }

            return json.data || null;
        } catch (error) {
            console.warn('[WorkspaceModule] 视频检索失败:', error);
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
                    allowFallback: options.isDemo === true
                })
            });
            const json = await response.json();

            if (!response.ok || !json.ok) {
                throw new Error(json.message || `视频检索失败: HTTP ${response.status}`);
            }

            return json.data || null;
        } catch (error) {
            console.warn('[WorkspaceModule] 视频检索失败:', error);
            return null;
        }
    }

    buildVideoSearchUrl(item = {}, query = '') {
        const keyword = [this.cleanKnowledgeTitle(item.title), query, '攻略']
            .filter(Boolean)
            .join(' ')
            .trim();

        return `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`;
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
            const knowledgeQuery = options.knowledgeQuery || baseQuery;
            const item = await this.fetchReplyKnowledgeItem(knowledgeQuery, { isDemo: source === 'demo' });
            const title = item.title || `知识卡片：${this.normalizeReplyText(baseQuery, 16) || '游戏知识'}`;
            const content = assistantText || item.content || baseQuery || '暂无知识内容';
            const displayContent = this.stripBracketDescriptions(content);
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
                content: displayContent,
                imgUrl: generatedImageUrl,
                forcePreview
            });
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source,
                ability: REPLY_MODE_OPTIONS[mode],
                text: displayContent
            });
            return {
                mode,
                displayText: displayContent
            };
        }

        if (mode === 'video') {
            const item = await this.fetchReplyKnowledgeItem(baseQuery, { isDemo: source === 'demo' });
            const videoQuery = this.buildRealtimeVideoQuery(inputText, assistantText, item) || baseQuery;
            const videoResult = await this.searchDouyinVideoByQuery(videoQuery, {
                isDemo: source === 'demo'
            });
            const topicLabel = this.cleanKnowledgeTitle(item.title) || this.normalizeReplyText(assistantText, 20) || this.normalizeReplyText(inputText, 20) || '游戏内容';
            const resolvedLinkUrl = videoResult?.url || videoResult?.searchUrl || this.buildVideoSearchUrl(item, videoQuery);
            const fallbackSummary = videoResult ? `已根据"${topicLabel}"检索到相关视频。` : `暂未检索到"${videoQuery}"的具体视频链接，已回退到搜索页。`;
            const payload = {
                title: videoResult?.title || `相关视频：${topicLabel}`,
                summary: videoResult?.description || fallbackSummary,
                linkUrl: resolvedLinkUrl,
                coverUrl: videoResult?.coverUrl || '',
                forcePreview
            };
            this.eventBus.emit('TRIGGER_video', payload);
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source,
                ability: REPLY_MODE_OPTIONS[mode],
                text: `${payload.title}，点击可查看相关视频。`
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
            const linkUrl = item.videoLinkUrl || videoResult?.url || this.buildVideoSearchUrl(item, query);
            const payload = {
                title: item.videoTitle || videoResult?.title || `精彩视频：${this.cleanKnowledgeTitle(item.title)}`,
                summary: item.videoSummary || videoResult?.description || item.content || '已根据知识内容检索到相关视频。',
                videoUrl: videoResult?.videoUrl || '',
                linkUrl,
                coverUrl: '',
                forcePreview: true
            };
            this.eventBus.emit('TRIGGER_video', payload);
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'ui',
                ability: abilityNameMap[abilityKey],
                text: `${payload.title}，点击可查看相关视频。`
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
                this.eventBus.emit('USER_SEND_QUERY', {
                    text: '知识卡片示例：给我一个打野前期防入侵战术卡片',
                    source: 'demo_button',
                    forceMock: true
                });
            });
        }

        if (btnVideo) {
            btnVideo.addEventListener('click', async () => {
                this.eventBus.emit('USER_SEND_QUERY', {
                    text: '视频示例：给我看看亚索精彩操作集锦',
                    source: 'demo_button',
                    forceMock: true
                });
            });
        }
    }

    bindStageModeSwitch() {
        const switchStageMode = (mode) => {
            this.currentStageMode = mode;
            this.stageModeSwitchButtons.forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.stageMode === mode);
            });

            if (mode === 'local') {
                this.dropzone?.classList.remove('is-hidden');
                this.screenShareShell?.classList.add('is-hidden');
            } else {
                this.dropzone?.classList.add('is-hidden');
                this.screenShareShell?.classList.remove('is-hidden');
            }
        };

        this.stageModeSwitchButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const targetMode = btn.dataset.stageMode;
                if (!targetMode || targetMode === this.currentStageMode) return;

                // 切换模式时，如果当前有 RTC 推流在运行，根据互斥逻辑停止它
                if (this.isScreenSharing) {
                    if (targetMode === 'local') {
                        // 从屏幕共享切回本地视频：停止屏幕共享
                        this.eventBus.emit('rtc_stop_game_screen_share');
                    } else {
                        // 从本地视频切到屏幕共享：停止本地视频推流
                        this.eventBus.emit('rtc_stop_screen_share');
                    }
                }

                switchStageMode(targetMode);
            });
        });

        // 本地视频推送给智能体
        // 等效于：点击 rtc-share-screen（共享屏幕） + 直接开始智能体音视频交互任务
        this.pushLocalVideoButton?.addEventListener('click', () => {
            if (this.isScreenSharing) {
                this.eventBus.emit('rtc_stop_screen_share');
            } else {
                if (this.currentMode !== 'rtc') {
                    this.app.switchMode('rtc');
                }
                this.eventBus.emit('rtc_start_screen_share');
            }
        });

        // 屏幕共享按钮
        // 等效于：在智能体侧打开《屏幕共享》选项 + 点击 rtc-share-game（共享游戏画面）
        this.startScreenShareButton?.addEventListener('click', () => {
            if (this.currentMode !== 'rtc') {
                this.app.switchMode('rtc');
            }
            if (this.isRtcConnected) {
                this.eventBus.emit('rtc_start_game_screen_share');
            } else {
                const onConnected = () => {
                    this.eventBus.off('RTC_CONNECTED', onConnected);
                    this.eventBus.emit('rtc_start_game_screen_share');
                };
                this.eventBus.on('RTC_CONNECTED', onConnected);
            }
        });

        this.stopScreenShareButton?.addEventListener('click', () => {
            this.eventBus.emit('rtc_stop_game_screen_share');
        });
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
                this.rtcShareScreenBtn.title = '语音聊天尚未就绪，开启智能体对话成功后会自动开始共享';
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
            this.isRtcConnected = true;
            this.statusRtc.textContent = '语音连接：已连接';
        });

        this.eventBus.on('RTC_DISCONNECTED', () => {
            this.isRtcConnected = false;
            this.statusRtc.textContent = '语音连接：未连接';
        });

        // 将用户与智能体的字幕/文本合并为一条对话记录展示
        this.eventBus.on('SESSION_MESSAGE', (payload) => {
            this.appendConversationLogFromSessionMessage(payload);
        });

        this.eventBus.on('ABILITY_FEEDBACK', (payload) => {
            this.appendAbilityLog(payload);
        });

        this.eventBus.on('AGENT_TASK_CREATED', (data) => {
            const orchestrationId = data?.orchestrationId;
            if (orchestrationId) {
                this._activeOrchestrationId = orchestrationId;
                this._flushPendingAbilityLogs(orchestrationId);
            }
            const intent = String(data?.intent || '').trim();
            if (intent) {
                this._tagLastConversationWithOrchestration(intent);
            }
        });

        this.eventBus.on('AGENT_STAGE_CHANGE', (data) => {
            const orchestrationId = data?.orchestrationId;
            if (orchestrationId) {
                this._activeOrchestrationId = orchestrationId;
            }
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

        this.eventBus.on('BACKEND_CONNECTIVITY_CHANGED', (payload = {}) => {
            if (payload.available) {
                if (!this.isRtcFeatureSyncing) {
                    this.loadRtcFeatureState({ silent: true }).catch(() => {});
                }
                return;
            }
            this.updateRtcFeatureStatus(`后端连接已断开，音频输入算法设置轮询已暂停，${this.getBackendRetryText()}`, true);
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

            if (payload?.sourceType === 'captureStream' || payload?.sourceType === 'srcObject') {
                if (this.pushLocalVideoButton) {
                    this.pushLocalVideoButton.textContent = '停止推送';
                    this.pushLocalVideoButton.classList.add('danger');
                    this.pushLocalVideoButton.classList.remove('primary');
                    this.pushLocalVideoButton.disabled = false;
                }
                this.updateVideoStatus('本地视频推送中');
            } else if (payload?.sourceType === 'display') {
                if (this.pushLocalVideoButton) {
                    this.pushLocalVideoButton.textContent = '推送给智能体';
                    this.pushLocalVideoButton.classList.remove('danger');
                    this.pushLocalVideoButton.classList.add('primary');
                    this.pushLocalVideoButton.disabled = false;
                }
                this.screenShareEmpty?.classList.add('is-hidden');
                this.screenShareActive?.classList.remove('is-hidden');
                if (this.screenSharePreview && payload?.stream) {
                    this.screenSharePreview.srcObject = payload.stream;
                }
                this.updateVideoStatus('屏幕共享中');
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
            if (this.pushLocalVideoButton) {
                this.pushLocalVideoButton.textContent = '推送给智能体';
                this.pushLocalVideoButton.classList.remove('danger');
                this.pushLocalVideoButton.classList.add('primary');
                this.pushLocalVideoButton.disabled = false;
            }
            this.screenShareEmpty?.classList.remove('is-hidden');
            this.screenShareActive?.classList.add('is-hidden');
            if (this.screenSharePreview) {
                this.screenSharePreview.srcObject = null;
            }
            this.updateVideoStatus('未选择');
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
            if (this.pushLocalVideoButton) {
                this.pushLocalVideoButton.textContent = '推送给智能体';
                this.pushLocalVideoButton.classList.remove('danger');
                this.pushLocalVideoButton.classList.add('primary');
                this.pushLocalVideoButton.disabled = false;
            }
            this.screenShareEmpty?.classList.remove('is-hidden');
            this.screenShareActive?.classList.add('is-hidden');
            if (this.screenSharePreview) {
                this.screenSharePreview.srcObject = null;
            }
            this.updateVideoStatus('未选择');
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
            pet: '语音聊天',
            text_chat: '文本聊天',
            rtc: '屏幕共享'
        };

        this.modeButtons.forEach((button) => {
            button.classList.toggle('is-active', button.dataset.mode === mode);
        });

        if (this.statusMode) {
            this.statusMode.textContent = `当前模式：${modeTextMap[mode] || mode}`;
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
                return '音频记录 · 语音';
            }
            if (source.includes('text')) {
                return '音频记录 · 文本';
            }
            return '音频记录';
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
            // 允许 chat_reply、interaction_reply、agent_main 等所有助手回复进入对话日志
            return ['chat_reply', 'interaction_reply', 'agent_main', 'agent'].includes(source);
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
            element: null,
            orchestrationIntent: ''
        };
    }

    renderConversationEntry(entry) {
        if (!entry?.element) {
            return;
        }

        entry.element.textContent = '';

        const head = document.createElement('div');
        head.className = 'ability-log-head';

        const title = document.createElement('strong');
        title.textContent = entry.isTaskBox ? '多Agent任务日志' : '对话';

        const badge = document.createElement('span');
        badge.className = 'ability-source';
        badge.textContent = entry.label || '对话';

        head.appendChild(title);
        head.appendChild(badge);

        if (!entry.isTaskBox && entry.orchestrationIntent) {
            const intentTag = document.createElement('span');
            intentTag.className = 'ability-orchestration-tag';
            intentTag.textContent = entry.orchestrationIntent;
            head.appendChild(intentTag);
        }

        if (entry.isTaskBox && entry.orchestrationId) {
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'ability-log-clear';
            clearBtn.textContent = '清除';
            clearBtn.title = '清除本轮多Agent任务日志，并停止保存后续事件';
            clearBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.clearOrchestrationTaskBox(entry.orchestrationId);
            });
            head.appendChild(clearBtn);
        }

        entry.element.appendChild(head);

        if (entry.isTaskBox) {
            const events = Array.isArray(entry.systemEvents) ? entry.systemEvents : [];
            events.forEach((ev) => {
                const p = document.createElement('p');
                const eventText = String(ev?.text || '');
                const eventAbility = String(ev?.ability || '');
                const lowerText = eventText.toLowerCase();
                const lowerAbility = eventAbility.toLowerCase();
                const isCancelled = lowerText.includes('已被后续语音打断') || lowerText.includes('已取消') || lowerText.includes('cancelled');
                const isFailed = lowerText.includes('失败') || lowerAbility.includes('失败') || lowerText.includes('failed');
                p.className = `ability-log-system${isCancelled ? ' ability-log-system--cancelled' : ''}${!isCancelled && isFailed ? ' ability-log-system--failed' : ''}`;
                p.textContent = `[${ev.ability}] ${ev.text}`;
                entry.element.appendChild(p);
            });
            return;
        }

        if (Array.isArray(entry.transcript) && entry.transcript.length > 0) {
            let currentAssistantText = '';
            entry.transcript.forEach((item) => {
                if (item.role === 'user') {
                    if (currentAssistantText) {
                        const line = document.createElement('p');
                        line.textContent = `小G：${currentAssistantText}`;
                        entry.element.appendChild(line);
                        currentAssistantText = '';
                    }
                    const line = document.createElement('p');
                    line.textContent = `用户：${item.text}`;
                    entry.element.appendChild(line);
                } else {
                    currentAssistantText = currentAssistantText
                        ? `${currentAssistantText} ${item.text}`
                        : item.text;
                }
            });
            if (currentAssistantText) {
                const line = document.createElement('p');
                line.textContent = `小G：${currentAssistantText}`;
                entry.element.appendChild(line);
            }
            return;
        }

        const userLine = document.createElement('p');
        userLine.textContent = entry.userText ? `用户：${entry.userText}` : '用户：';

        const assistantLine = document.createElement('p');
        assistantLine.textContent = entry.assistantText ? `小G：${entry.assistantText}` : '小G：';

        entry.element.appendChild(userLine);
        entry.element.appendChild(assistantLine);
    }

    _tagLastConversationWithOrchestration(intent) {
        const intentLabel = {
            strategy: '战术策略',
            video: '精彩视频',
            knowledge: '知识卡片',
            smalltalk: '闲聊'
        }[intent];
        if (!intentLabel) {
            return;
        }

        for (const channel of Object.keys(this.lastConversationByChannel)) {
            const entry = this.lastConversationByChannel[channel];
            if (entry && entry.element && !entry.orchestrationIntent) {
                entry.orchestrationIntent = intentLabel;
                this.renderConversationEntry(entry);
                break;
            }
        }
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
            // RTC channel 所有消息积累到同一个 entry 的 transcript 数组中，
            // 但不再拼接同 role 消息——每条消息独立成行，保证 user/bot 交替出现。
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
            // 不再拼接同 role 消息，每条独立追加，保持交替结构
            transcript.push({
                role,
                text: normalizedText
            });

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

    _getOrCreateTaskBox(orchestrationId) {
        if (!this._taskBoxByOrchestration) {
            this._taskBoxByOrchestration = new Map();
        }
        if (this._clearedOrchestrationIds && this._clearedOrchestrationIds.has(orchestrationId)) {
            return null;
        }
        if (this._taskBoxByOrchestration.has(orchestrationId)) {
            return this._taskBoxByOrchestration.get(orchestrationId);
        }
        if (!this.abilityFeed) {
            return null;
        }
        const entry = this.createConversationEntry({ channel: 'orchestration', label: '多Agent任务日志' });
        entry.orchestrationId = orchestrationId;
        entry.isTaskBox = true;
        entry.systemEvents = [];
        const item = document.createElement('div');
        item.className = 'ability-log-item ability-log-item--conversation';
        entry.element = item;
        this.abilityFeed.prepend(item);
        this._taskBoxByOrchestration.set(orchestrationId, entry);
        return entry;
    }

    _flushPendingAbilityLogs(orchestrationId) {
        if (!this._pendingAbilityLogs || this._pendingAbilityLogs.length === 0) {
            return;
        }
        if (this._clearedOrchestrationIds && this._clearedOrchestrationIds.has(orchestrationId)) {
            this._pendingAbilityLogs = [];
            return;
        }
        const box = this._getOrCreateTaskBox(orchestrationId);
        if (!box) return;
        this._pendingAbilityLogs.forEach((payload) => {
            box.systemEvents.push({ ability: payload.ability, text: payload.text });
        });
        this._pendingAbilityLogs = [];
        this.renderConversationEntry(box);
    }

    appendAbilityLog(payload = {}) {
        if (!this.abilityFeed) {
            return;
        }

        const orchestrationId = payload.orchestrationId || this._activeOrchestrationId;
        if (orchestrationId && this._clearedOrchestrationIds && this._clearedOrchestrationIds.has(orchestrationId)) {
            return;
        }

        this.ensureAbilityFeedNotEmpty();

        if (orchestrationId) {
            const box = this._getOrCreateTaskBox(orchestrationId);
            if (box) {
                box.systemEvents.push({ ability: payload.ability, text: payload.text });
                this.renderConversationEntry(box);
                return;
            }
        }
        if (!orchestrationId) {
            if (!this._pendingAbilityLogs) {
                this._pendingAbilityLogs = [];
            }
            this._pendingAbilityLogs.push(payload);
        }
    }

    clearOrchestrationTaskBox(orchestrationId) {
        if (!orchestrationId) {
            return;
        }
        if (!this._clearedOrchestrationIds) {
            this._clearedOrchestrationIds = new Set();
        }
        this._clearedOrchestrationIds.add(orchestrationId);

        const entry = this._taskBoxByOrchestration && this._taskBoxByOrchestration.get(orchestrationId);
        if (entry) {
            if (entry.element && entry.element.parentNode) {
                entry.element.parentNode.removeChild(entry.element);
            }
            entry.systemEvents = [];
            this._taskBoxByOrchestration.delete(orchestrationId);
        }

        if (Array.isArray(this._pendingAbilityLogs) && this._pendingAbilityLogs.length > 0) {
            this._pendingAbilityLogs = this._pendingAbilityLogs.filter(
                (item) => (item.orchestrationId || this._activeOrchestrationId) !== orchestrationId
            );
        }

        if (this.abilityFeed && this.abilityFeed.children.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ability-empty';
            empty.textContent = '交互动作记录的日志展示';
            this.abilityFeed.appendChild(empty);
        }
    }

    updateVideoStatus(statusText) {
        this.statusVideo.textContent = `视频源：${statusText}`;
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
