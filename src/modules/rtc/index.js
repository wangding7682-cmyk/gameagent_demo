import { globalEventBus } from '../../core/eventBus.js';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8788';
const DEFAULT_ROOM_ID = 'game-ai-room-demo';
const DEFAULT_USER_ID_PREFIX = 'web_user';
const DEFAULT_TOKEN_EXPIRE_SECONDS = 24 * 3600;

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

function hasFinalSubtitleMarker(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const directKeys = [
        'isFinal',
        'is_final',
        'final',
        'sentenceFinish',
        'sentence_finish',
        'definite',
        'speechEnd',
        'speech_end',
        'utteranceEnd',
        'utterance_end',
        'end'
    ];
    if (directKeys.some((key) => value[key] === true || value[key] === 1 || value[key] === 'true')) {
        return true;
    }

    return ['raw', 'payload', 'data', 'result', 'message'].some((key) => hasFinalSubtitleMarker(value[key]));
}

function shouldSkipRtcDebugLog(event, payload = {}) {
    if (event !== 'subtitle.received') {
        return false;
    }

    const messageType = String(payload?.messageType || '').toLowerCase();
    if (messageType === 'tool_call') {
        return false;
    }

    // RTC ASR/subtitle packets arrive as many interim chunks. Keep only final/stable packets in
    // debug logs, otherwise the console and in-memory debug log become too noisy.
    return !hasFinalSubtitleMarker(payload);
}

function writeRtcDebugLog(event, payload = {}) {
    if (typeof window === 'undefined') {
        return;
    }
    if (shouldSkipRtcDebugLog(event, payload)) {
        return;
    }

    const root = window.__GAME_AI_DEBUG__ || (window.__GAME_AI_DEBUG__ = {});
    const logs = root.logs || (root.logs = []);
    const entry = {
        module: 'rtc',
        event,
        payload,
        timestamp: new Date().toISOString()
    };

    logs.push(entry);
    if (logs.length > 500) {
        logs.splice(0, logs.length - 500);
    }

    console.log(`[RtcDebug] ${event}`, payload);
}

function createRtcError(message, detail) {
    const error = new Error(message);
    error.detail = detail;
    return error;
}

function generateSessionTaskId(roomId, userId) {
    const safeRoomId = String(roomId).replace(/[^a-zA-Z0-9_.@-]/g, '-');
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_.@-]/g, '-');
    return `task-${safeRoomId}-${safeUserId}-${Date.now()}`;
}

function getStableUserId(prefix) {
    const storageKey = 'game_ai_rtc_user_id';
    const safePrefix = prefix || DEFAULT_USER_ID_PREFIX;

    try {
        const cached = window.localStorage.getItem(storageKey);
        if (cached) {
            return cached;
        }

        const generated = `${safePrefix}_${Math.floor(Math.random() * 1000000)}`;
        window.localStorage.setItem(storageKey, generated);
        return generated;
    } catch (error) {
        return `${safePrefix}_${Math.floor(Math.random() * 1000000)}`;
    }
}

function getRuntimeConfig() {
    const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
    const rtcRuntime = runtime.rtc || {};

    return {
        apiBaseUrl: String(runtime.apiBaseUrl || rtcRuntime.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, ''),
        roomId: rtcRuntime.roomId || runtime.rtcRoomId || DEFAULT_ROOM_ID,
        userId: rtcRuntime.userId || runtime.rtcUserId || getStableUserId(rtcRuntime.userIdPrefix || runtime.rtcUserIdPrefix),
        userIdPrefix: rtcRuntime.userIdPrefix || runtime.rtcUserIdPrefix || DEFAULT_USER_ID_PREFIX,
        tokenExpireInSeconds: Number(
            rtcRuntime.tokenExpireInSeconds || runtime.rtcTokenExpireInSeconds || DEFAULT_TOKEN_EXPIRE_SECONDS
        ),
        businessId: rtcRuntime.businessId || runtime.rtcBusinessId || '',
        agentUserId: rtcRuntime.agentUserId || runtime.rtcAgentUserId || '',
        welcomeMessage: rtcRuntime.welcomeMessage || runtime.rtcWelcomeMessage || '',
        voiceChatConfig: rtcRuntime.voiceChatConfig || runtime.rtcVoiceChatConfig || null,
        defaultInterruptMode: Number(
            rtcRuntime.defaultInterruptMode ?? runtime.rtcDefaultInterruptMode ?? 1
        ),
        replyMode: rtcRuntime.replyMode || runtime.replyMode || 'tts',
        joinOptions: {
            isAutoPublish: true,
            isAutoSubscribeAudio: true,
            isAutoSubscribeVideo: false,
            roomProfileType: 0,
            ...(rtcRuntime.joinOptions || runtime.rtcJoinOptions || {})
        }
    };
}

async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
        throw createRtcError(
            data?.message || `请求失败: ${response.status}`,
            data
        );
    }

    return data.data;
}

const apiService = {
    async getRtcAuthInfo(runtimeConfig, overrides = {}) {
        const roomId = overrides.roomId || runtimeConfig.roomId || 'ChatRoom01';
        const userId = overrides.userId || runtimeConfig.userId || ('user_' + Math.floor(Math.random() * 10000));
        console.log('[RTC API] 正在通过服务端获取 RTC 鉴权数据...', {
            roomId,
            userId
        });

        return postJson(`${runtimeConfig.apiBaseUrl}/api/rtc/token`, {
            roomId,
            userId,
            expireInSeconds: Number(
                overrides.expireInSeconds || runtimeConfig.tokenExpireInSeconds || DEFAULT_TOKEN_EXPIRE_SECONDS
            )
        });
    },

    async startVoiceChat(runtimeConfig, session, overrides = {}) {
        const voiceChatConfig = overrides.voiceChatConfig || runtimeConfig.voiceChatConfig;

        const url = `${runtimeConfig.apiBaseUrl}/api/rtc/voice-chat/start`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                roomId: session.roomId,
                taskId: session.taskId,
                targetUserId: session.userId,
                businessId: overrides.businessId || runtimeConfig.businessId || undefined,
                agentUserId: overrides.agentUserId || runtimeConfig.agentUserId || undefined,
                welcomeMessage: overrides.welcomeMessage || runtimeConfig.welcomeMessage || undefined,
                config: voiceChatConfig || undefined,
                agentConfig: overrides.agentConfig
            })
        });

        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok) {
            throw createRtcError(
                data?.message || `请求失败: ${response.status}`,
                data
            );
        }

        return { data: data.data, memoryContext: data.memoryContext || {} };
    },

    async updateVoiceChat(runtimeConfig, session, command, extra = {}) {
        return postJson(`${runtimeConfig.apiBaseUrl}/api/rtc/voice-chat/update`, {
            roomId: session.roomId,
            taskId: session.taskId,
            command,
            ...extra
        });
    },

    async stopVoiceChat(runtimeConfig, session) {
        return postJson(`${runtimeConfig.apiBaseUrl}/api/rtc/voice-chat/stop`, {
            roomId: session.roomId,
            taskId: session.taskId
        });
        });
    }
        });
    }
};

export class RtcModule {
    constructor() {
        this.eventBus = globalEventBus;
        this.rtcEngine = null;
        this.isJoined = false;
        this.currentRoomInfo = null;
        this.isScreenSharing = false;
        this.screenShareIntentActive = false;
        this.pendingVoiceChatStart = null;
        this.isStartingVoiceChat = false;
        this.isVoiceChatReady = false;
        this.isJoinInFlight = false;
        this.isLeaving = false;
        this.customScreenTrack = null;
        this.currentCapturedStream = null;
        this.currentCaptureFingerprint = '';
        this.currentPublishedTrackKey = '';
        this.lastScreenShareStatsLogAt = 0;
        this.runtime = getRuntimeConfig();
        this.isRemoteAssistantAudioMuted = false;
        this.remotePlayerObservers = new Map();
    }

    init() {
        console.log('[RtcModule] RTC module initialized');

        const enterRtcMode = (config) => {
            console.log('[RtcModule] 收到 ENTER_RTC_MODE 事件，config:', config);
            const variant = config?.variant === 'screen' ? 'screen' : 'voice';
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'ui',
                ability: variant === 'screen' ? '屏幕共享' : '语音聊天',
                text: variant === 'screen'
                    ? '开始建立屏幕共享会话，等待语音连接并接入视频工作区。'
                    : '开始建立语音聊天会话，等待语音连接和智能体响应。'
            });
            this.screenShareIntentActive = config?.variant === 'screen';
            if (this.screenShareIntentActive) {
                this.emitScreenSharePending('RTC 连接中，入房后会自动开始共享视频工作区', {
                    reason: 'enter-screen-mode',
                    waitingForRtc: true
                });
            }
            this.joinChannel(config);
        };
        const leaveRtcMode = () => {
            console.log('[RtcModule] 收到 LEAVE_RTC_MODE 事件');
            this.leaveChannel();
        };

        this.eventBus.on('ENTER_RTC_MODE', enterRtcMode);
        this.eventBus.on('enter_rtc_mode', enterRtcMode);
        this.eventBus.on('LEAVE_RTC_MODE', leaveRtcMode);
        this.eventBus.on('leave_rtc_mode', leaveRtcMode);
        this.eventBus.on('RTC_SEND_TEXT_MESSAGE', (payload) => {
            this.handleSendTextMessage(payload);
        });
        this.eventBus.on('RTC_INTERRUPT_AGENT', () => {
            this.handleInterruptAgent();
        });
        const syncScreenShareSource = (payload) => {
            this.handleVideoSourceUpdated(payload);
        };
        this.eventBus.on('RTC_VIDEO_SOURCE_UPDATED', syncScreenShareSource);
        this.eventBus.on('rtc_video_source_updated', syncScreenShareSource);
        this.eventBus.on('RTC_SET_REMOTE_AUDIO_MUTED', (payload = {}) => {
            this.setRemoteAssistantAudioMuted(payload?.muted === true, payload?.reason || '');
        });
    }

    refreshRuntimeConfig() {
        this.runtime = getRuntimeConfig();
        return this.runtime;
    }

    ensureRtcSdkReady() {
        if (!window.VERTC || typeof window.VERTC.createEngine !== 'function') {
            throw createRtcError('未检测到火山引擎 Web RTC SDK。请确认 index.html 已正确引入 vendor/volcengine-rtc.min.js。');
        }
    }

    buildSession(overrides = {}) {
        const runtime = this.refreshRuntimeConfig();
        const roomId = overrides.roomId || runtime.roomId;
        const userId = overrides.userId || runtime.userId;

        return {
            roomId,
            userId,
            taskId: overrides.taskId || generateSessionTaskId(roomId, userId)
        };
    }

    emitRtcEvent(nameUpper, payload) {
        this.eventBus.emit(nameUpper, payload);
        this.eventBus.emit(nameUpper.toLowerCase(), payload);
    }

    setRemoteAssistantAudioMuted(muted, reason = '') {
        const nextMuted = Boolean(muted);
        if (this.isRemoteAssistantAudioMuted === nextMuted) {
            this.syncAllRemotePlayerAudio();
            return;
        }
        this.isRemoteAssistantAudioMuted = nextMuted;
        console.log(`[RtcModule] 远端 RTC 原声${nextMuted ? '已静音' : '已恢复'}`, { reason });
        this.syncAllRemotePlayerAudio();
    }

    syncAllRemotePlayerAudio() {
        const players = document.querySelectorAll('[id^="rtc-player-"]');
        players.forEach((container) => {
            this.observeRemotePlayerContainer(container);
            this.syncRemotePlayerContainerAudio(container);
        });
    }

    observeRemotePlayerContainer(container) {
        if (!container || this.remotePlayerObservers.has(container)) {
            return;
        }

        const observer = new MutationObserver(() => {
            this.syncRemotePlayerContainerAudio(container);
        });
        observer.observe(container, {
            childList: true,
            subtree: true
        });
        this.remotePlayerObservers.set(container, observer);
    }

    disconnectRemotePlayerObservers() {
        this.remotePlayerObservers.forEach((observer) => observer.disconnect());
        this.remotePlayerObservers.clear();
    }

    syncRemotePlayerContainerAudio(container) {
        if (!container) {
            return;
        }

        const mediaElements = container.querySelectorAll('audio, video');
        mediaElements.forEach((mediaEl) => {
            if (!mediaEl.dataset.traeOriginalMuted) {
                mediaEl.dataset.traeOriginalMuted = mediaEl.muted ? '1' : '0';
            }
            if (!mediaEl.dataset.traeOriginalVolume) {
                mediaEl.dataset.traeOriginalVolume = String(typeof mediaEl.volume === 'number' ? mediaEl.volume : 1);
            }

            if (this.isRemoteAssistantAudioMuted) {
                mediaEl.muted = true;
                if (typeof mediaEl.volume === 'number') {
                    mediaEl.volume = 0;
                }
            } else {
                mediaEl.muted = mediaEl.dataset.traeOriginalMuted === '1';
                if (typeof mediaEl.volume === 'number') {
                    const originalVolume = Number(mediaEl.dataset.traeOriginalVolume);
                    mediaEl.volume = Number.isFinite(originalVolume) ? originalVolume : 1;
                }
            }
        });
    }

    async finalizeRtcJoinSuccess(source, info = {}) {
        if (this.isJoined) {
            return;
        }

        this.isJoinInFlight = false;
        this.isLeaving = false;
        this.isJoined = true;
        this.emitRtcEvent('RTC_CONNECTED', { status: 'success', info, source });
        if (this.pendingVoiceChatStart?.variant === 'screen') {
            this.screenShareIntentActive = true;
        }
        await this.startVoiceChatAfterRtcConnected();
    }

    finalizeRtcLeaveSuccess(source, info = {}) {
        if (!this.isLeaving && !this.rtcEngine && !this.isJoined) {
            return;
        }

        console.log('[RtcModule] 退房完成，准备清理 RTC 状态', {
            source,
            info
        });
        this._cleanup();
        this.emitRtcEvent('RTC_DISCONNECTED', { status: 'success', info, source });
    }

    getMessageBytes(message) {
        if (message instanceof Uint8Array) {
            return message;
        }
        if (message instanceof ArrayBuffer) {
            return new Uint8Array(message);
        }
        if (ArrayBuffer.isView(message)) {
            return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
        }
        return null;
    }

    normalizeRoomBinaryMessageEvent(uidOrEvent, maybeMessage) {
        const looksLikeEventObject =
            uidOrEvent &&
            typeof uidOrEvent === 'object' &&
            !Array.isArray(uidOrEvent) &&
            !(uidOrEvent instanceof Uint8Array) &&
            !(uidOrEvent instanceof ArrayBuffer) &&
            !ArrayBuffer.isView(uidOrEvent);

        if (looksLikeEventObject) {
            return {
                uid: String(uidOrEvent.userId || uidOrEvent.uid || '').trim(),
                message: uidOrEvent.message ?? maybeMessage,
                rawEvent: uidOrEvent
            };
        }

        return {
            uid: typeof uidOrEvent === 'string' ? uidOrEvent : '',
            message: maybeMessage,
            rawEvent: null
        };
    }

    unpackSubtitleBinaryMessage(message) {
        const bytes = this.getMessageBytes(message);
        if (!bytes || bytes.length < 8) {
            return null;
        }

        const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        if (magic !== 'subv') {
            return null;
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const payloadLength = view.getUint32(4, false);
        const payloadEnd = 8 + payloadLength;
        if (payloadLength <= 0 || bytes.length < payloadEnd) {
            return null;
        }

        const payloadBytes = bytes.slice(8, payloadEnd);
        return {
            magic,
            payloadLength,
            payloadText: new TextDecoder().decode(payloadBytes)
        };
    }

    decodeSubtitleMessage(message) {
        let rawMessage = message;
        const unpackedSubtitleMessage = this.unpackSubtitleBinaryMessage(message);
        if (unpackedSubtitleMessage?.payloadText) {
            rawMessage = unpackedSubtitleMessage.payloadText;
        } else if (message instanceof Uint8Array) {
            rawMessage = new TextDecoder().decode(message);
        } else if (message instanceof ArrayBuffer) {
            rawMessage = new TextDecoder().decode(new Uint8Array(message));
        } else if (ArrayBuffer.isView(message)) {
            rawMessage = new TextDecoder().decode(
                new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
            );
        }

        if (typeof rawMessage !== 'string') {
            return { text: String(rawMessage || '') };
        }

        try {
            const parsed = JSON.parse(rawMessage);
            if (Array.isArray(parsed)) {
                return { data: parsed };
            }
            return typeof parsed === 'object' && parsed ? parsed : { text: rawMessage };
        } catch (error) {
            return { text: rawMessage };
        }
    }

    extractSubtitleItems(payload = {}) {
        const collections = [
            payload?.data,
            payload?.payload?.data,
            payload?.result?.data,
            payload?.payload?.result?.data
        ];

        for (const collection of collections) {
            if (Array.isArray(collection) && collection.length > 0) {
                return collection;
            }
        }

        return [];
    }

    extractSubtitleSpeakerId(payload = {}) {
        const directCandidates = [
            payload?.userId,
            payload?.uid,
            payload?.data?.userId,
            payload?.payload?.userId,
            payload?.payload?.data?.userId,
            payload?.result?.userId,
            payload?.payload?.result?.userId
        ];

        for (const candidate of directCandidates) {
            const normalized = String(candidate || '').trim();
            if (normalized) {
                return normalized;
            }
        }

        const items = this.extractSubtitleItems(payload);
        for (const item of items) {
            const normalized = String(
                item?.userId || item?.uid || item?.speakerId || item?.speaker_id || ''
            ).trim();
            if (normalized) {
                return normalized;
            }
        }

        return '';
    }

    extractSubtitleText(payload = {}) {
        const normalizeText = (value) => String(value || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const directCandidates = [
            payload?.text,
            payload?.Text,
            payload?.message,
            payload?.Message,
            payload?.content,
            payload?.Content,
            payload?.data?.text,
            payload?.data?.Text,
            payload?.data?.message,
            payload?.data?.Message,
            payload?.payload?.text,
            payload?.payload?.Text,
            payload?.payload?.message,
            payload?.payload?.Message,
            payload?.payload?.content,
            payload?.payload?.Content,
            payload?.payload?.data?.text,
            payload?.payload?.data?.Text,
            payload?.payload?.data?.message,
            payload?.payload?.data?.Message,
            payload?.result?.text,
            payload?.result?.Text,
            payload?.result?.message,
            payload?.result?.Message,
            payload?.payload?.result?.text,
            payload?.payload?.result?.Text,
            payload?.payload?.result?.message
        ];

        for (const candidate of directCandidates) {
            const normalized = normalizeText(candidate);
            if (normalized) {
                return normalized;
            }
        }

        const subtitleItems = this.extractSubtitleItems(payload);
        if (subtitleItems.length > 0) {
            const merged = subtitleItems
                .map((item) => normalizeText(item?.text || item?.Text || item?.message || item?.Message || item?.content || item?.Content || item?.utterance || item?.Utterance))
                .filter(Boolean)
                .join(' ');
            if (merged) {
                return merged;
            }
        }

        const utteranceCollections = [
            payload?.data?.utterances,
            payload?.payload?.data?.utterances,
            payload?.result?.utterances,
            payload?.payload?.result?.utterances
        ];

        for (const collection of utteranceCollections) {
            if (!Array.isArray(collection) || collection.length === 0) {
                continue;
            }
            const merged = collection
                .map((item) => normalizeText(item?.text || item?.Text || item?.message || item?.Message || item?.content || item?.Content))
                .filter(Boolean)
                .join(' ');
            if (merged) {
                return merged;
            }
        }

        return '';
    }

    extractRtcMessageType(payload = {}) {
        const normalizedType = String(
            payload?.type ||
            payload?.messageType ||
            payload?.event ||
            payload?.header?.event ||
            payload?.header?.messageType ||
            payload?.data?.type ||
            payload?.payload?.type ||
            payload?.payload?.messageType ||
            payload?.payload?.event ||
            payload?.payload?.header?.event ||
            payload?.payload?.header?.messageType ||
            payload?.payload?.data?.type ||
            ''
        ).toLowerCase();

        // Some upstream function-calling / tool-calling messages may be forwarded through the same
        // stream message channel. These should never be treated as subtitles (otherwise they may
        // be displayed / spoken as raw JSON).
        if (/(^|[^a-z])(function|tool)(_call|calls)?([^a-z]|$)/.test(normalizedType)) {
            return 'tool_call';
        }

        if (/asr|speech|transcript|user_text|user_asr|user_speech/.test(normalizedType)) {
            return 'user_asr';
        }

        const subtitleSpeakerId = this.extractSubtitleSpeakerId(payload);
        const localUserId = String(this.currentRoomInfo?.userId || '').trim();
        if (subtitleSpeakerId && localUserId && subtitleSpeakerId === localUserId) {
            return 'user_asr';
        }

        return 'subtitle';
    }

    handleRtcSubtitleSignal(uid, streamId, message, source = 'stream-message') {
        const subtitle = this.decodeSubtitleMessage(message);
        const messageType = this.extractRtcMessageType(subtitle);
        const text = this.extractSubtitleText(subtitle);
        const speakerId = this.extractSubtitleSpeakerId(subtitle);
        const payload = {
            uid,
            streamId,
            text,
            userId: speakerId,
            raw: subtitle
        };

        writeRtcDebugLog('subtitle.received', {
            source,
            uid,
            streamId,
            messageType,
            text,
            userId: speakerId,
            raw: subtitle
        });

        if (messageType === 'tool_call') {
            console.log('[RtcModule] 忽略工具调用流消息', {
                uid,
                streamId,
                raw: subtitle
            });
            return;
        }

        if (!text) {
            console.debug('[RtcModule] 收到无文本字幕/控制信令，已忽略', {
                uid,
                streamId,
                source,
                messageType,
                userId: speakerId,
                raw: subtitle
            });
            return;
        }

        if (messageType === 'user_asr') {
            this.emitRtcEvent('RTC_USER_ASR', payload);
            return;
        }

        this.emitRtcEvent('RTC_SUBTITLE', payload);
    }

    getWorkspaceVideoElement(payload = {}) {
        return payload?.videoElement || document.getElementById('local-video');
    }

    getVideoSourceFingerprint(videoElement) {
        if (!videoElement) {
            return '';
        }
        if (videoElement.srcObject) {
            const trackIds = videoElement.srcObject
                .getVideoTracks()
                .map((track) => track.id)
                .join(',');
            return `srcObject:${trackIds}`;
        }
        return `src:${videoElement.currentSrc || videoElement.src || ''}`;
    }

    emitScreenSharePending(message, extra = {}) {
        writeRtcDebugLog('share.pending', {
            message,
            state: {
                isJoined: this.isJoined,
                isScreenSharing: this.isScreenSharing,
                screenShareIntentActive: this.screenShareIntentActive,
                isVoiceChatReady: this.isVoiceChatReady,
                isStartingVoiceChat: this.isStartingVoiceChat
            },
            ...extra
        });
        this.eventBus.emit('rtc_screen_share_pending', {
            message,
            ...extra
        });
    }

    releaseCustomScreenTrack() {
        if (this.customScreenTrack) {
            this.customScreenTrack = null;
        }
        this.currentPublishedTrackKey = '';
    }

    clearScreenShareSourceCache() {
        this.currentCapturedStream = null;
        this.currentCaptureFingerprint = '';
    }

    async captureWorkspaceVideoTrack(videoElement) {
        if (!videoElement) {
            writeRtcDebugLog('capture.missing_video_element', {});
            return null;
        }

        writeRtcDebugLog('capture.inspect_video_element', {
            video: serializeVideoElement(videoElement),
            fingerprint: this.getVideoSourceFingerprint(videoElement)
        });

        const hasSrcObjectTrack =
            videoElement.srcObject &&
            typeof videoElement.srcObject.getVideoTracks === 'function' &&
            videoElement.srcObject.getVideoTracks().length > 0;

        if (hasSrcObjectTrack) {
            const stream = videoElement.srcObject;
            const track = stream.getVideoTracks()[0];
            writeRtcDebugLog('capture.use_src_object', {
                video: serializeVideoElement(videoElement),
                stream: serializeMediaStream(stream),
                track: serializeMediaTrack(track)
            });
            return {
                stream,
                track,
                sourceType: 'srcObject',
                fingerprint: this.getVideoSourceFingerprint(videoElement)
            };
        }

        const hasVideoSource = !!(videoElement.currentSrc || videoElement.src);
        if (!hasVideoSource) {
            writeRtcDebugLog('capture.no_video_source', {
                video: serializeVideoElement(videoElement)
            });
            return null;
        }

        const fingerprint = this.getVideoSourceFingerprint(videoElement);
        let stream = this.currentCaptureFingerprint === fingerprint
            ? this.currentCapturedStream
            : null;

        if (!stream) {
            if (typeof videoElement.captureStream === 'function') {
                stream = videoElement.captureStream(10);
                console.log('[RtcModule] 使用 captureStream() 捕获视频工作区画面');
            } else if (typeof videoElement.mozCaptureStream === 'function') {
                stream = videoElement.mozCaptureStream(10);
                console.log('[RtcModule] 使用 mozCaptureStream() 捕获视频工作区画面');
            } else {
                throw new Error('当前浏览器不支持从 video 元素捕获视频流 (captureStream)');
            }
            this.currentCapturedStream = stream;
            this.currentCaptureFingerprint = fingerprint;
            writeRtcDebugLog('capture.create_stream', {
                captureMethod: typeof videoElement.captureStream === 'function' ? 'captureStream' : 'mozCaptureStream',
                video: serializeVideoElement(videoElement),
                stream: serializeMediaStream(stream),
                fingerprint
            });
        }

        const [track] = stream.getVideoTracks();
        if (!track) {
            writeRtcDebugLog('capture.no_video_track', {
                video: serializeVideoElement(videoElement),
                stream: serializeMediaStream(stream),
                fingerprint
            });
            return null;
        }

        writeRtcDebugLog('capture.track_ready', {
            video: serializeVideoElement(videoElement),
            stream: serializeMediaStream(stream),
            track: serializeMediaTrack(track),
            fingerprint
        });

        return {
            stream,
            track,
            sourceType: 'captureStream',
            fingerprint
        };
    }

    async attachWorkspaceVideoToScreenShare(reason = 'unknown', payload = {}) {
        if (!this.screenShareIntentActive) {
            return false;
        }
        if (!this.rtcEngine || !this.isJoined) {
            this.emitScreenSharePending('RTC 连接尚未完成，入房后会自动开始共享', {
                reason,
                waitingForRtc: true
            });
            return false;
        }
        if (!this.isVoiceChatReady) {
            this.emitScreenSharePending('语音聊天尚未就绪，开启智能体对话成功后会自动开始共享', {
                reason,
                waitingForVoiceChat: true,
                isStartingVoiceChat: this.isStartingVoiceChat
            });
            return false;
        }

        const videoElement = this.getWorkspaceVideoElement(payload);
        if (!videoElement) {
            this.emitScreenSharePending('未找到视频工作区播放器，稍后会继续重试', {
                reason,
                waitingForVideo: true
            });
            return false;
        }

        const captureResult = await this.captureWorkspaceVideoTrack(videoElement);
        if (!captureResult?.track) {
            this.emitScreenSharePending('已进入待共享状态，检测到视频可用后会自动开始共享', {
                reason,
                waitingForVideo: true,
                readyState: videoElement.readyState ?? 0
            });
            return false;
        }

        const publishKey = `${captureResult.fingerprint}:${captureResult.track.id}`;
        if (this.currentPublishedTrackKey === publishKey && this.isScreenSharing) {
            console.log('[RtcModule] 屏幕共享轨道未变化，跳过重复绑定', {
                reason,
                publishKey
            });
            writeRtcDebugLog('share.skip_rebind_same_track', {
                reason,
                publishKey,
                video: serializeVideoElement(videoElement),
                track: serializeMediaTrack(captureResult.track)
            });
            return true;
        }

        console.log('[RtcModule] 绑定视频工作区到屏幕共享轨道', {
            reason,
            sourceType: captureResult.sourceType,
            readyState: videoElement.readyState ?? 0,
            paused: videoElement.paused,
            publishKey
        });
        writeRtcDebugLog('share.bind_track', {
            reason,
            publishKey,
            sourceType: captureResult.sourceType,
            state: {
                isJoined: this.isJoined,
                isScreenSharing: this.isScreenSharing,
                screenShareIntentActive: this.screenShareIntentActive
            },
            video: serializeVideoElement(videoElement),
            stream: serializeMediaStream(captureResult.stream),
            track: serializeMediaTrack(captureResult.track)
        });

        const screenStreamIndex = window.VERTC.StreamIndex.STREAM_INDEX_SCREEN;
        const externalVideoSourceType = window.VERTC.VideoSourceType?.VIDEO_SOURCE_TYPE_EXTERNAL;
        const screenVideoMediaType = window.VERTC.MediaType?.VIDEO;

        if (externalVideoSourceType === undefined) {
            throw new Error('当前 RTC SDK 不支持 VideoSourceType.VIDEO_SOURCE_TYPE_EXTERNAL');
        }
        if (screenVideoMediaType === undefined) {
            throw new Error('当前 RTC SDK 不支持 MediaType.VIDEO');
        }

        await this.rtcEngine.setVideoSourceType(
            screenStreamIndex,
            externalVideoSourceType
        );

        await this.rtcEngine.setExternalVideoTrack(
            screenStreamIndex,
            captureResult.track
        );

        await this.rtcEngine.setScreenEncoderConfig({
            width: 1280,
            height: 720,
            frameRate: 10,
            maxBitrate: 1500
        });

        if (!this.isScreenSharing) {
            await this.rtcEngine.publishScreen(screenVideoMediaType);
        }

        this.releaseCustomScreenTrack();
        this.customScreenTrack = captureResult.track;
        this.currentPublishedTrackKey = publishKey;
        this.isScreenSharing = true;
        this.eventBus.emit('rtc_screen_share_started', {
            reason,
            sourceType: captureResult.sourceType
        });
        writeRtcDebugLog('share.published', {
            reason,
            publishKey,
            sourceType: captureResult.sourceType,
            video: serializeVideoElement(videoElement),
            stream: serializeMediaStream(captureResult.stream),
            track: serializeMediaTrack(captureResult.track)
        });
        console.log('[RtcModule] 视频工作区画面已发布到屏幕共享轨道');
        return true;
    }

    async handleVideoSourceUpdated(payload = {}) {
        console.log('[RtcModule] 收到视频源变化事件', {
            reason: payload?.reason,
            hasVideo: payload?.hasVideo,
            isPlaying: payload?.isPlaying,
            readyState: payload?.readyState,
            shareIntent: this.screenShareIntentActive,
            isScreenSharing: this.isScreenSharing
        });
        writeRtcDebugLog('video_source.updated', {
            reason: payload?.reason || '',
            hasVideo: !!payload?.hasVideo,
            isPlaying: !!payload?.isPlaying,
            readyState: payload?.readyState ?? 0,
            currentSrc: payload?.currentSrc || '',
            videoElementId: payload?.videoElementId || '',
            state: {
                isJoined: this.isJoined,
                isScreenSharing: this.isScreenSharing,
                screenShareIntentActive: this.screenShareIntentActive,
                isVoiceChatReady: this.isVoiceChatReady
            },
            video: serializeVideoElement(this.getWorkspaceVideoElement(payload))
        });

        if (!this.screenShareIntentActive) {
            return;
        }

        try {
            await this.attachWorkspaceVideoToScreenShare(payload.reason || 'video-source-updated', payload);
        } catch (error) {
            console.error('[RtcModule] 自动绑定视频共享源失败', error);
            this.eventBus.emit('rtc_screen_share_failed', error);
        }
    }

    async startVoiceChatAfterRtcConnected() {
        if (!this.currentRoomInfo || !this.pendingVoiceChatStart || this.isStartingVoiceChat) {
            return;
        }

        this.isStartingVoiceChat = true;
        const startOptions = this.pendingVoiceChatStart;
        const session = this.currentRoomInfo;

        try {
            const runtime = this.refreshRuntimeConfig();
            const startResult = await apiService.startVoiceChat(runtime, session, startOptions);
            this.isVoiceChatReady = true;
            this.pendingVoiceChatStart = null;
            if (!this.currentRoomInfo || this.currentRoomInfo.taskId !== session.taskId) {
                return;
            }
            const customLlmMode = Boolean(startResult?.memoryContext?.customLlmMode);
            this.emitRtcEvent('RTC_AGENT_READY', {
                roomId: session.roomId,
                taskId: session.taskId,
                userId: session.userId,
                customLlmMode
            });
            if (this.screenShareIntentActive) {
                try {
                    await this.attachWorkspaceVideoToScreenShare('voice-chat-ready');
                } catch (shareError) {
                    console.error('RTC module: 语音聊天已启动，但自动共享视频工作区失败', shareError);
                    this.eventBus.emit('rtc_screen_share_failed', shareError);
                }
            }
        } catch (error) {
            this.isVoiceChatReady = false;
            console.error('RTC module: 智能体建会失败', error);
            this.emitRtcEvent('RTC_COMMAND_FAILED', {
                action: 'join',
                message: error.message,
                detail: error.detail || null
            });
        } finally {
            this.isStartingVoiceChat = false;
        }
    }

    _bindRtcEvents() {
        if (!this.rtcEngine) {
            return;
        }

        // 开启音量回调监听，检测麦克风是否真的工作
        this.rtcEngine.enableAudioPropertiesReport({ interval: 300 });

        this.rtcEngine.on('onLocalAudioPropertiesReport', (reports) => {
            if (reports && reports.length > 0) {
                const vol = reports[0].audioPropertiesInfo.linearVolume;
                // 只有当音量大于10时才认为有明显说话声音，避免控制台被刷屏
                if (vol > 10) {
                    console.log('🎤 麦克风采集中，当前音量:', vol);
                }
            }
        });

        // 监听本地视频推流统计，用于验证“游戏画面共享”是否真的在发送数据
        this.rtcEngine.on('onLocalVideoStats', (statsArray) => {
            if (!this.isScreenSharing) return;
            
            statsArray.forEach(stats => {
                // 判断是否是屏幕共享的流索引
                if (stats.streamIndex === window.VERTC.StreamIndex.STREAM_INDEX_SCREEN) {
                    const now = Date.now();
                    if (now - this.lastScreenShareStatsLogAt >= 1500) {
                        this.lastScreenShareStatsLogAt = now;
                        const workspaceVideo = this.getWorkspaceVideoElement();
                        writeRtcDebugLog('share.local_video_stats', {
                            stats: {
                                sentBitrate: stats.sentBitrate,
                                sentFrameRate: stats.sentFrameRate,
                                encodedFrameWidth: stats.encodedFrameWidth,
                                encodedFrameHeight: stats.encodedFrameHeight,
                                streamIndex: stats.streamIndex
                            },
                            publishedTrackKey: this.currentPublishedTrackKey,
                            captureFingerprint: this.currentCaptureFingerprint,
                            currentCapturedStream: serializeMediaStream(this.currentCapturedStream),
                            workspaceVideo: serializeVideoElement(workspaceVideo)
                        });
                    }
                    // 只在有发送码率时打印，且为了避免刷屏，可以做个简单的节流
                    // 这里为了让你能明显看到，我们直接打印
                    if (stats.sentBitrate > 0) {
                        console.log(`📤 [视频流推送中] 码率: ${stats.sentBitrate} kbps, 帧率: ${stats.sentFrameRate} fps, 分辨率: ${stats.encodedFrameWidth}x${stats.encodedFrameHeight}`);
                    }
                }
            });
        });

        this.rtcEngine.on('onJoinRoomResult', async (res) => {
            console.log('[RtcModule] onJoinRoomResult 收到:', JSON.stringify(res));
            if (res.errorCode === 0) {
                console.log('[RtcModule] 进房成功，准备 finalizeRtcJoinSuccess');
                await this.finalizeRtcJoinSuccess('onJoinRoomResult', res);
            } else {
                this.isJoinInFlight = false;
                this.isLeaving = false;
                console.error('[RtcModule] 进房失败，errorCode:', res.errorCode);
                this.pendingVoiceChatStart = null;
                this.emitRtcEvent('RTC_DISCONNECTED', { status: 'error', reason: `进房失败: ${res.errorCode}` });
            }
        });

        this.rtcEngine.on('onUserPublishStream', async (event) => {
            console.log('RTC module: 收到远端流', event);
            const mediaType = event?.mediaType;
            const userId = event?.userId;
            if (!userId) {
                return;
            }

            if (mediaType === 1 || mediaType === 2 || mediaType === 3) {
                let container = document.getElementById(`rtc-player-${userId}`);
                if (!container) {
                    container = document.createElement('div');
                    container.id = `rtc-player-${userId}`;
                    container.style.display = 'none';
                    document.body.appendChild(container);
                }
                this.observeRemotePlayerContainer(container);

                await this.rtcEngine.setRemoteVideoPlayer(0, {
                    userId,
                    renderDom: container
                });
                this.syncRemotePlayerContainerAudio(container);
                window.setTimeout(() => this.syncRemotePlayerContainerAudio(container), 120);
                window.setTimeout(() => this.syncRemotePlayerContainerAudio(container), 600);
            }
        });

        this.rtcEngine.on('onStreamMessageReceived', (uid, streamId, message) => {
            this.handleRtcSubtitleSignal(uid, streamId, message, 'onStreamMessageReceived');
        });

        this.rtcEngine.on('onRoomBinaryMessageReceived', (uidOrEvent, maybeMessage) => {
            const normalized = this.normalizeRoomBinaryMessageEvent(uidOrEvent, maybeMessage);
            this.handleRtcSubtitleSignal(
                normalized.uid,
                '',
                normalized.message,
                'onRoomBinaryMessageReceived'
            );
        });

        this.rtcEngine.on('onTokenWillExpire', async () => {
            console.warn('RTC module: Token 即将在 30 秒内过期，开始自动续期...');
            try {
                if (!this.currentRoomInfo) {
                    return;
                }

                const runtime = this.refreshRuntimeConfig();
                const renewed = await apiService.getRtcAuthInfo(runtime, {
                    roomId: this.currentRoomInfo.roomId,
                    userId: this.currentRoomInfo.userId,
                    expireInSeconds: runtime.tokenExpireInSeconds
                });

                this.currentRoomInfo.token = renewed.token;
                await this.rtcEngine.updateToken(renewed.token);
                console.log('RTC module: Token 自动续期成功');
            } catch (error) {
                console.error('RTC module: Token 自动续期失败', error);
            }
        });

        this.rtcEngine.on('onConnectionStateChanged', (state) => {
            const nextState = state?.state ?? state;
            console.log(`RTC module: 连接状态改变 -> ${nextState}`);
            if (nextState === 4) {
                this.emitRtcEvent('RTC_RECONNECTING', {});
            } else if (nextState === 5) {
                this.emitRtcEvent('RTC_DISCONNECTED', {
                    status: 'error',
                    reason: 'connection_failed'
                });
            }
        });

        this.rtcEngine.on('onLeaveRoomResult', (res) => {
            console.log('RTC module: 离开房间成功');
            this.finalizeRtcLeaveSuccess('onLeaveRoomResult', res || {});
        });
    }

    /**
     * 开启游戏画面共享并发布 (捕获视频工作区的播放器画面)
     */
    async startShareScreen() {
        console.log('[RtcModule] startShareScreen 被调用');
        console.log('[RtcModule] 当前状态:', {
            hasEngine: !!this.rtcEngine,
            isJoined: this.isJoined,
            isScreenSharing: this.isScreenSharing,
            screenShareIntentActive: this.screenShareIntentActive
        });
        writeRtcDebugLog('share.start_requested', {
            state: {
                hasEngine: !!this.rtcEngine,
                isJoined: this.isJoined,
                isScreenSharing: this.isScreenSharing,
                screenShareIntentActive: this.screenShareIntentActive,
                isVoiceChatReady: this.isVoiceChatReady,
                isStartingVoiceChat: this.isStartingVoiceChat
            },
            video: serializeVideoElement(this.getWorkspaceVideoElement())
        });
        this.screenShareIntentActive = true;

        try {
            const attached = await this.attachWorkspaceVideoToScreenShare('manual-start');
            if (!attached) {
                console.log('[RtcModule] 已记录共享意图，等待 RTC 就绪或视频源就绪后自动开始');
            }
        } catch (error) {
            console.error('RTC module: 开启游戏画面共享失败', error);
            this.screenShareIntentActive = false;
            this.eventBus.emit('rtc_screen_share_failed', error);
        }
    }

    /**
     * 停止游戏画面共享
     */
    async stopShareScreen() {
        console.log('[RtcModule] stopShareScreen 被调用');
        writeRtcDebugLog('share.stop_requested', {
            state: {
                hasEngine: !!this.rtcEngine,
                isJoined: this.isJoined,
                isScreenSharing: this.isScreenSharing,
                screenShareIntentActive: this.screenShareIntentActive,
                isVoiceChatReady: this.isVoiceChatReady
            },
            publishedTrackKey: this.currentPublishedTrackKey,
            captureFingerprint: this.currentCaptureFingerprint,
            currentCapturedStream: serializeMediaStream(this.currentCapturedStream),
            video: serializeVideoElement(this.getWorkspaceVideoElement())
        });
        this.screenShareIntentActive = false;

        if (!this.rtcEngine || !this.isScreenSharing) {
            console.warn('[RtcModule] stopShareScreen 结束待共享状态或当前没有正在发布的屏幕流');
            this.releaseCustomScreenTrack();
            this.clearScreenShareSourceCache();
            this.isScreenSharing = false;
            this.eventBus.emit('rtc_screen_share_stopped');
            writeRtcDebugLog('share.stopped_without_active_publish', {});
            return;
        }

        console.log('[RtcModule] 正在停止游戏视频画面共享...');
        try {
            const screenVideoMediaType = window.VERTC.MediaType?.VIDEO;
            if (screenVideoMediaType === undefined) {
                throw new Error('当前 RTC SDK 不支持 MediaType.VIDEO');
            }

            // 1. 停止发布屏幕流
            await this.rtcEngine.unpublishScreen(screenVideoMediaType);

            // 2. 清理本地引用，后续重新共享时会重新绑定外部视频轨
            this.releaseCustomScreenTrack();
            this.clearScreenShareSourceCache();

            this.isScreenSharing = false;
            this.eventBus.emit('rtc_screen_share_stopped');
            writeRtcDebugLog('share.stopped', {});
            console.log('RTC module: 游戏视频画面共享已停止');

        } catch (error) {
            console.error('RTC module: 停止共享异常', error);
        }
    }

    _cleanup() {
        this.isJoined = false;
        this.currentRoomInfo = null;
        this.pendingVoiceChatStart = null;
        this.isStartingVoiceChat = false;
        this.isVoiceChatReady = false;
        this.isJoinInFlight = false;
        this.isLeaving = false;
        this.screenShareIntentActive = false;
        this.releaseCustomScreenTrack();
        this.clearScreenShareSourceCache();

        if (this.rtcEngine) {
            window.VERTC.destroyEngine(this.rtcEngine);
            this.rtcEngine = null;
        }

        const players = document.querySelectorAll('[id^="rtc-player-"]');
        this.disconnectRemotePlayerObservers();
        players.forEach((element) => element.remove());

        // 重置屏幕共享相关状态
        this.isScreenSharing = false;
        this.eventBus.emit('rtc_screen_share_stopped');
    }

    async joinChannel(config) {
        if (this.isJoined || this.isJoinInFlight || this.isLeaving) {
            console.warn('RTC module: 当前已经在房间中，请勿重复加入');
            return;
        }
        
        console.log('RTC module: 开始执行 AIGC 通话链路...', config);
        this.isJoinInFlight = true;
        
        try {
            this.ensureRtcSdkReady();
            const runtime = this.refreshRuntimeConfig();
            const session = this.buildSession(config);
            this.currentRoomInfo = await apiService.getRtcAuthInfo(runtime, session);
            this.currentRoomInfo.taskId = session.taskId;
            this.pendingVoiceChatStart = config || {};
            this.isStartingVoiceChat = false;
            this.isVoiceChatReady = false;
            this.isLeaving = false;
            this.setRemoteAssistantAudioMuted(false, 'join_channel_reset');
            
            // 1. 实例化火山 RTC 引擎
            this.rtcEngine = window.VERTC.createEngine(this.currentRoomInfo.appId);
            this._bindRtcEvents();
            
            // 2. 开启麦克风采集
            const audioCaptureProbeTaskId = this.currentRoomInfo?.taskId || null;
            window.setTimeout(() => {
                if (!this.isJoinInFlight || !this.currentRoomInfo || this.currentRoomInfo.taskId !== audioCaptureProbeTaskId) {
                    return;
                }
                console.warn('RTC module: startAudioCapture 超过 3000ms 仍未完成', {
                    roomId: this.currentRoomInfo?.roomId || null,
                    userId: this.currentRoomInfo?.userId || null,
                    taskId: this.currentRoomInfo?.taskId || null,
                    isJoinInFlight: this.isJoinInFlight,
                    isJoined: this.isJoined
                });
            }, 3000);
            await this.rtcEngine.startAudioCapture();
            
            // 3. 加入 RTC 房间 (对齐火山官方传参规范)
            await this.rtcEngine.joinRoom(
                this.currentRoomInfo.token, 
                this.currentRoomInfo.roomId, 
                { userId: this.currentRoomInfo.userId }, // userInfo 对象
                runtime.joinOptions
            );
            await this.finalizeRtcJoinSuccess('joinRoomPromise', {
                roomId: this.currentRoomInfo.roomId,
                userId: this.currentRoomInfo.userId,
                taskId: this.currentRoomInfo.taskId
            });
        } catch (error) {
            console.error('RTC module: 通话链路建立失败', error);
            this.isJoined = false;
            this.isJoinInFlight = false;
            this.isLeaving = false;
            this.pendingVoiceChatStart = null;
            this.isStartingVoiceChat = false;
            this.emitRtcEvent('RTC_COMMAND_FAILED', {
                action: 'join',
                message: error.message,
                detail: error.detail || null
            });
        }
    }

    async updateVoiceChat(command, extra = {}) {
        if (!this.currentRoomInfo) {
            throw createRtcError('当前没有进行中的 RTC 会话，无法调用 UpdateVoiceChat');
        }

        const runtime = this.refreshRuntimeConfig();
        return apiService.updateVoiceChat(runtime, this.currentRoomInfo, command, extra);
    }

    async handleSendTextMessage(payload = {}) {
        const message = String(payload.message || payload.text || '').trim();
        if (!message) {
            return;
        }

        try {
            const runtime = this.refreshRuntimeConfig();
            const parameters = payload.parameters && typeof payload.parameters === 'object'
                ? { ...payload.parameters }
                : null;
            const result = await this.updateVoiceChat('ExternalTextToLLM', {
                message,
                skipSessionMessageSync: true,
                ...(parameters ? { parameters } : {}),
                interruptMode:
                    payload.interruptMode ?? runtime.defaultInterruptMode
            });

            this.emitRtcEvent('RTC_COMMAND_SENT', {
                action: 'ExternalTextToLLM',
                message,
                result
            });
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'ui',
                ability: 'RTC 文本提问',
                text: message
            });
        } catch (error) {
            console.error('RTC module: 文本提问失败', error);
            this.emitRtcEvent('RTC_COMMAND_FAILED', {
                action: 'ExternalTextToLLM',
                message,
                detail: error.detail || null,
                error: error.message
            });
        }
    }

    async handleInterruptAgent() {
        // 链路联动：先停掉本地正在播放的 TTS（覆盖桌宠/字幕本地 TTS 残留），
        // 再向服务端发送打断指令，确保用户听感"按下即静音"。
        this.eventBus.emit('PET_STOP_SPEAKING', { interrupt: true });
        try {
            const result = await this.updateVoiceChat('interrupt');
            this.emitRtcEvent('RTC_COMMAND_SENT', {
                action: 'interrupt',
                result
            });
            this.eventBus.emit('ABILITY_FEEDBACK', {
                source: 'ui',
                ability: 'RTC 打断',
                text: '已发送打断指令'
            });
        } catch (error) {
            console.error('RTC module: 打断失败', error);
            this.emitRtcEvent('RTC_COMMAND_FAILED', {
                action: 'interrupt',
                detail: error.detail || null,
                error: error.message
            });
        }
    }

    /**
     * 挂断通话链路
     */
    async leaveChannel() {
        if (!this.rtcEngine || this.isLeaving) return;
        console.log('RTC module: 开始执行挂断通话链路...');
        this.isLeaving = true;
        this.isJoinInFlight = false;

        try {
            const runtime = this.refreshRuntimeConfig();
            await apiService.stopVoiceChat(runtime, this.currentRoomInfo);
            
            // 2. 停止麦克风采集
            await this.rtcEngine.stopAudioCapture();
            
            // 3. 离开房间 (内部回调中会执行 destroy)
            await this.rtcEngine.leaveRoom();
            this.finalizeRtcLeaveSuccess('leaveRoomResolve');
            
        } catch (error) {
            this.isLeaving = false;
            console.error('RTC module: 挂断通话链路失败', error);
            this.emitRtcEvent('RTC_COMMAND_FAILED', {
                action: 'leave',
                message: error.message,
                detail: error.detail || null
            });
        }
    }
}

export const rtcModule = new RtcModule();
