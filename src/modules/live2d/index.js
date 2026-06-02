const MODEL_PRESETS = [
    {
        id: 'shizuku',
        label: '长发',
        path: 'https://cdn.jsdelivr.net/npm/live2d-widget-model-shizuku@1.0.5/assets/shizuku.model.json',
        previewText: '长发',
        previewClass: 'look-theme-shizuku'
    },
    {
        id: 'hijiki',
        label: '双马尾',
        path: 'https://cdn.jsdelivr.net/npm/live2d-widget-model-hijiki@1.0.5/assets/hijiki.model.json',
        previewText: '双马尾',
        previewClass: 'look-theme-hijiki'
    },
    {
        id: 'koharu',
        label: '短发',
        path: 'https://cdn.jsdelivr.net/npm/live2d-widget-model-koharu@1.0.5/assets/koharu.model.json',
        previewText: '短发',
        previewClass: 'look-theme-koharu'
    },
    {
        id: 'tororo',
        label: '卷发',
        path: 'https://cdn.jsdelivr.net/npm/live2d-widget-model-tororo@1.0.5/assets/tororo.model.json',
        previewText: '卷发',
        previewClass: 'look-theme-tororo'
    }
];

const INTERACTION_EXPRESSIONS = [
    {
        id: 'happy',
        label: '开心',
        keywords: ['smile', 'happy', 'f01', 'exp_01'],
        zones: ['center', 'lower']
    },
    {
        id: 'shy',
        label: '害羞',
        keywords: ['shy', 'blush', 'f02', 'exp_02'],
        zones: ['head', 'left', 'right']
    },
    {
        id: 'surprised',
        label: '惊讶',
        keywords: ['surprised', 'surprise', 'f03', 'exp_03'],
        zones: ['head', 'upper']
    },
    {
        id: 'playful',
        label: '调皮',
        keywords: ['playful', 'tease', 'f04', 'exp_04'],
        zones: ['right', 'center', 'lower']
    },
    {
        id: 'wink',
        label: '眨眼',
        keywords: ['wink', 'eye', 'f05', 'exp_05'],
        zones: ['head', 'left', 'right']
    },
    {
        id: 'curious',
        label: '疑惑',
        keywords: ['curious', 'question', 'f06', 'exp_06'],
        zones: ['upper', 'center']
    },
    {
        id: 'pout',
        label: '委屈',
        keywords: ['pout', 'angry', 'sad', 'f07', 'exp_07'],
        zones: ['lower', 'left']
    }
];

export class Live2dModule {
    constructor(eventBus, app) {
        this.eventBus = eventBus;
        this.app = app;
        this.container = document.getElementById('live2d-container');
        this.canvas = document.getElementById('live2d-canvas');
        this.appPixi = null;
        this.model = null;
        this.modelBounds = null;
        this.currentLookIndex = 0;
        this.currentExpressionIndex = 0;
        this.loadVersion = 0;

        this.menuPet = document.getElementById('menu-pet');
        this.menuChat = document.getElementById('menu-chat');
        this.menuVideo = document.getElementById('menu-video');
        this.speechBubble = document.getElementById('live2d-speech');
        this.rtcVoiceSubtitle = document.getElementById('rtc-voice-subtitle');
        this.changeLookButton = document.getElementById('btn-change-look');
        this.toggleButton = document.getElementById('live2d-toggle');
        this.stage = document.getElementById('live2d-stage');
        this.lookThumb = document.getElementById('live2d-look-thumb');
        this.lookThumbText = document.getElementById('live2d-look-thumb-text');
        this.lookName = document.getElementById('live2d-look-name');
        this.expressionName = document.getElementById('live2d-expression-name');
        this.lookOptions = document.getElementById('look-options');
        this.actionLayer = this.container.querySelector('.live2d-action-layer');

        this.chatWindow = document.getElementById('chat-window');
        this.videoWindow = document.getElementById('video-window');
        this.minimizeChatButton = document.getElementById('minimize-chat');
        this.minimizeVideoButton = document.getElementById('minimize-video');
        this.videoWindowTitle = this.videoWindow?.querySelector('.modal-title') || null;
        this.rtcPlaceholderText = document.querySelector('#rtc-video-placeholder p');
        this.rtcVoiceTitle = document.getElementById('rtc-voice-title');
        this.rtcStatusDot = document.getElementById('rtc-status-dot');
        this.rtcStatusText = document.getElementById('rtc-status-text');
        this.rtcCallDuration = document.getElementById('rtc-call-duration');
        this.rtcScreenCallTime = document.getElementById('rtc-screen-call-time');
        this.rtcShareScreenButton = document.getElementById('rtc-share-screen');

        this.isDragging = false;
        this.isExpanded = false;
        this.dragOffset = { x: 0, y: 0 };
        this.pointerStart = null;
        this.dragThreshold = 8;
        this.fallbackTimer = null;
        this.lookMenuOpen = false;
        this.lastInteractionExpressionId = null;
        this.currentRtcVariant = 'voice';
        this.rtcCallTimer = null;
        this.rtcCallStartedAt = null;
        this.modalDragState = null;
        this.modalZIndexSeed = 1002;
        this.isSpeaking = false;
        this._activeRtcSubtitleItem = null;
        this._activeRtcSubtitleText = '';
        this._activeRtcSubtitleType = '';
        this._activeRtcSubtitleTimer = null;
        this.modalWindowStates = {
            chat: {
                initialized: false,
                minimized: false,
                left: null,
                top: null,
                restoreLeft: null,
                restoreTop: null
            },
            video: {
                initialized: false,
                minimized: false,
                left: null,
                top: null,
                restoreLeft: null,
                restoreTop: null
            }
        };

        this.addVisualDecoration();
        this.hitArea = this.container.querySelector('.live2d-hit-area');
        if (this.speechBubble && this.speechBubble.parentElement !== this.container) {
            this.container.appendChild(this.speechBubble);
        }
        if (this.toggleButton && this.toggleButton.parentElement !== this.container) {
            this.container.appendChild(this.toggleButton);
        }
    }

    async init() {
        this.bindEvents();
        this.initPixiApp();
        this.setExpanded(false);
        this._syncMenuActiveState();
        await this.loadCurrentModel();
    }

    initPixiApp() {
        if (!window.PIXI || !window.PIXI.live2d?.Live2DModel) {
            console.warn('Live2D runtime unavailable, falling back to static character.');
            this.showFallbackCharacter();
            return;
        }

        this.canvas.style.display = 'block';
        this.appPixi = new window.PIXI.Application({
            view: this.canvas,
            autoStart: true,
            transparent: true,
            backgroundAlpha: 0,
            width: 260,
            height: 320,
            resolution: window.devicePixelRatio || 1
        });
    }

    async loadCurrentModel() {
        const preset = MODEL_PRESETS[this.currentLookIndex];
        if (!preset || !this.appPixi || !window.PIXI?.live2d?.Live2DModel) {
            this.showFallbackCharacter();
            this.refreshLookButton();
            this.renderLookOptions();
            return;
        }

        const currentVersion = ++this.loadVersion;

        try {
            this.changeLookButton.disabled = true;

            if (this.model) {
                this.appPixi.stage.removeChild(this.model);
                this.model.destroy?.();
                this.model = null;
            }

            this.canvas.style.display = 'block';
            const fallback = this.container.querySelector('.fallback-character');
            if (fallback) {
                fallback.style.display = 'none';
            }

            const Live2DModel = window.PIXI.live2d.Live2DModel;
            const model = await Live2DModel.from(preset.path);

            if (currentVersion !== this.loadVersion) {
                model.destroy?.();
                return;
            }

            this.model = model;
            this.currentExpressionIndex = 0;
            this.mountModel(model);
            this.playIdleMotion();
        } catch (error) {
            console.warn(`Live2D model load failed for ${preset.id}`, error);
            this.showFallbackCharacter();
        } finally {
            this.refreshLookButton();
            this.refreshExpressionButton();
            this.renderLookOptions();
            this.changeLookButton.disabled = false;
        }
    }

    mountModel(model) {
        this.appPixi.stage.addChild(model);
        this.modelBounds = model.getLocalBounds();
        model.interactive = true;
        this.applyModelLayout();

        model.on('pointertap', (event) => {
            this.handleModelTap(event?.data?.global || null);
        });
    }

    applyModelLayout() {
        if (!this.model) {
            return;
        }

        const stageWidth = 260;
        const stageHeight = 320;
        const bounds = this.modelBounds || this.model.getLocalBounds();
        const rawWidth = bounds.width || this.model.width;
        const rawHeight = bounds.height || this.model.height;

        const layout = this.isExpanded
            ? {
                targetWidth: 186,
                targetHeight: 258,
                focusCenterX: 0.5,
                focusCenterY: 0.22,
                centerX: 134,
                centerY: 132
            }
            : {
                targetWidth: 138,
                targetHeight: 188,
                focusCenterX: 0.5,
                focusCenterY: 0.16,
                centerX: 130,
                centerY: 118
            };

        const scale = Math.max(layout.targetWidth / rawWidth, layout.targetHeight / rawHeight);
        const focusX = bounds.x + rawWidth * layout.focusCenterX;
        const focusY = bounds.y + rawHeight * layout.focusCenterY;
        const x = layout.centerX - focusX * scale;
        const y = layout.centerY - focusY * scale;

        this.model.scale.set(scale);
        this.model.x = x;
        this.model.y = y;
    }

    addVisualDecoration() {
        if (!this.container.querySelector('.live2d-base')) {
            const base = document.createElement('div');
            base.className = 'live2d-base';
            this.container.appendChild(base);
        }

        if (!this.container.querySelector('.live2d-glow')) {
            const glow = document.createElement('div');
            glow.className = 'live2d-glow';
            this.container.appendChild(glow);
        }

        if (!this.container.querySelector('.live2d-hit-area')) {
            const hitArea = document.createElement('button');
            hitArea.type = 'button';
            hitArea.className = 'live2d-hit-area';
            hitArea.setAttribute('aria-label', '展开桌宠');
            this.container.appendChild(hitArea);
        }
    }

    showFallbackCharacter() {
        this.canvas.style.display = 'none';
        const existingFallback = this.container.querySelector('.fallback-character');
        if (existingFallback) {
            existingFallback.style.display = 'flex';
            this.refreshLookButton();
            this.refreshExpressionButton();
            this.renderLookOptions();
            return;
        }

        const fallbackDiv = document.createElement('div');
        fallbackDiv.className = 'fallback-character';
        fallbackDiv.innerHTML = `
            <div class="character-body">
                <div class="character-head">
                    <div class="face"></div>
                    <div class="eye left-eye"></div>
                    <div class="eye right-eye"></div>
                    <div class="mouth"></div>
                </div>
                <div class="character-hair"></div>
                <div class="character-bow"></div>
                <div class="character-cheek left-cheek"></div>
                <div class="character-cheek right-cheek"></div>
            </div>
        `;
        this.container.appendChild(fallbackDiv);

        if (!this.fallbackTimer) {
            let scale = 1;
            let up = true;
            let blinkTimer = 0;

            this.fallbackTimer = window.setInterval(() => {
                const fallback = this.container.querySelector('.fallback-character');
                if (!fallback || fallback.style.display === 'none') {
                    return;
                }

                if (up) {
                    scale += 0.0025;
                    if (scale > 1.025) up = false;
                } else {
                    scale -= 0.0025;
                    if (scale < 0.975) up = true;
                }
                fallback.style.transform = `scale(${scale})`;

                blinkTimer++;
                const eyes = fallback.querySelectorAll('.eye');
                if (blinkTimer > 150 && blinkTimer < 160) {
                    eyes.forEach((eye) => {
                        eye.style.height = '4px';
                    });
                } else {
                    eyes.forEach((eye) => {
                        eye.style.height = '26px';
                    });
                }
                if (blinkTimer > 200) blinkTimer = 0;
            }, 50);
        }

        fallbackDiv.addEventListener('click', (event) => {
            this.handleModelTap({
                x: event.clientX,
                y: event.clientY
            });
        });

        this.refreshLookButton();
        this.refreshExpressionButton();
        this.renderLookOptions();
    }

    bindEvents() {
        this.bindModalWindowInteractions();

        const expandFromMini = (event) => {
            if (this.isExpanded || this.isDragging) {
                return;
            }
            if (event?.target?.closest('.live2d-action-layer')) {
                return;
            }
            this.setExpanded(true);
        };

        this.container.addEventListener('mousedown', (event) => {
            if (event.target.closest('.live2d-action-layer') || event.target.closest('.live2d-toggle')) {
                return;
            }
            this.isDragging = false;
            this.pointerStart = {
                x: event.clientX,
                y: event.clientY
            };
            const rect = this.container.getBoundingClientRect();
            this.dragOffset.x = event.clientX - rect.left;
            this.dragOffset.y = event.clientY - rect.top;
        });

        document.addEventListener('mousemove', (event) => {
            if (!this.pointerStart) return;
            const distance = Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y);
            if (!this.isDragging && distance >= this.dragThreshold) {
                this.isDragging = true;
            }
            if (!this.isDragging) return;
            const x = event.clientX - this.dragOffset.x;
            const y = event.clientY - this.dragOffset.y;
            this.container.style.left = `${x}px`;
            this.container.style.top = `${y}px`;
            this.container.style.right = 'auto';
            this.container.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (this.pointerStart && !this.isDragging && !this.isExpanded) {
                this.setExpanded(true);
            }
            this.isDragging = false;
            this.pointerStart = null;
        });

        this.hitArea?.addEventListener('click', (event) => {
            event.stopPropagation();
            expandFromMini(event);
        });

        document.addEventListener('mousedown', (event) => {
            if (!this.lookMenuOpen) {
                return;
            }
            if (event.target.closest('#btn-change-look') || event.target.closest('#look-options')) {
                return;
            }
            this.setLookMenuOpen(false);
        });

        this.menuPet.addEventListener('click', () => {
            console.log('[Live2dModule] menuPet 被点击，切换到 pet 模式');
            this.activateMode('pet');
        });

        this.menuChat.addEventListener('click', () => {
            console.log('[Live2dModule] menuChat 被点击，切换到 text_chat 模式');
            this.activateMode('text_chat');
        });

        this.menuVideo.addEventListener('click', () => {
            console.log('[Live2dModule] menuVideo 被点击，切换到 rtc 模式');
            this.setExpanded(false);
            this.activateMode('rtc');
        });

        [this.menuPet, this.menuChat, this.menuVideo, this.changeLookButton, this.lookOptions].forEach((node) => {
            node?.addEventListener('mousedown', (event) => {
                event.stopPropagation();
            });
        });

        this.toggleButton?.addEventListener('click', () => {
            this.setExpanded(!this.isExpanded);
        });

        this.changeLookButton?.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!this.isExpanded) {
                this.setExpanded(true);
            }
            this.setLookMenuOpen(!this.lookMenuOpen);
        });

        document.getElementById('close-chat').addEventListener('click', () => {
            this.closeRtcSessionAndReturnToPet('close-chat');
        });

        this.minimizeChatButton?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.setModalMinimized('chat', this.chatWindow, !this.modalWindowStates.chat.minimized);
        });

        document.getElementById('close-video').addEventListener('click', () => {
            this.closeRtcSessionAndReturnToPet('close-video');
        });

        this.minimizeVideoButton?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.setModalMinimized('video', this.videoWindow, !this.modalWindowStates.video.minimized);
        });

        document.getElementById('video-hangup').addEventListener('click', () => {
            this.closeRtcSessionAndReturnToPet('video-hangup');
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') {
                return;
            }
            if (!this.isRtcModalVisible()) {
                return;
            }
            event.preventDefault();
            this.closeRtcSessionAndReturnToPet('escape-key');
        });

        const chatInput = document.getElementById('chat-input');
        const chatSend = document.getElementById('chat-send');
        const chatMessages = document.getElementById('chat-messages');
        const rtcTextInput = document.getElementById('rtc-text-input');
        const rtcSendButton = document.getElementById('rtc-send-text');
        const rtcInterruptButton = document.getElementById('rtc-interrupt');

        const appendMessage = (text, type) => {
            const msgEl = document.createElement('div');
            msgEl.className = `chat-message ${type}`;
            msgEl.textContent = text;
            chatMessages.appendChild(msgEl);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        };

        const appendSessionMessage = (payload = {}) => {
            const text = String(payload.text || '').trim();
            if (!text) return;

            const targets = Array.isArray(payload.targets) && payload.targets.length > 0
                ? payload.targets
                : ['chat'];
            const role = payload.role || 'assistant';

            if (targets.includes('chat')) {
                appendMessage(text, role === 'user' ? 'user' : 'system');
            }
        };

        const sendMessage = () => {
            const text = chatInput.value.trim();
            if (!text) return;
            chatInput.value = '';
            this.eventBus.emit('SESSION_MESSAGE', {
                role: 'user',
                text,
                source: 'chat_input',
                targets: ['chat']
            });
            this.eventBus.emit('USER_SEND_QUERY', {
                text,
                source: 'chat_input'
            });
        };

        chatSend.addEventListener('click', sendMessage);
        chatInput.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') sendMessage();
        });

        const sendRtcText = () => {
            const text = rtcTextInput?.value.trim();
            if (!text) {
                return;
            }

            rtcTextInput.value = '';
            if (this.rtcVoiceSubtitle && this.currentRtcVariant === 'voice') {
                this._appendVoiceSubtitle(text, 'user');
            }
            this.eventBus.emit('SESSION_MESSAGE', {
                role: 'user',
                text,
                source: 'rtc_text_input',
                targets: ['chat', 'rtc']
            });
            this.eventBus.emit('RTC_SEND_TEXT_MESSAGE', {
                message: text
            });
        };

        rtcSendButton?.addEventListener('click', sendRtcText);
        rtcTextInput?.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                sendRtcText();
            }
        });
        rtcInterruptButton?.addEventListener('click', () => {
            this.eventBus.emit('RTC_INTERRUPT_AGENT');
        });

        this.eventBus.on('OPEN_CHAT_MODAL', () => {
            this.openModalWindow('chat', this.chatWindow);
        });

        this.eventBus.on('CLOSE_CHAT_MODAL', () => {
            this.closeChatWindow();
        });

        this.eventBus.on('OPEN_RTC_MODAL', (payload) => {
            const variant = payload?.variant === 'screen' ? 'screen' : 'voice';
            this.configureRtcWindow(variant);
            this.openModalWindow('video', this.videoWindow);
        });

        this.eventBus.on('CLOSE_RTC_MODAL', () => {
            this.hideModalWindow('video', this.videoWindow);
        });

        this.eventBus.on('PET_START_SPEAKING', (payload) => {
            this.isSpeaking = true;
            if (payload?.text) {
                this.showSpeechBubble(payload.text);
                if (this.rtcVoiceSubtitle && this.currentRtcVariant === 'voice') {
                    const skipSources = ['fixed_ack', 'branch_wait_reply', 'strategy_retry', 'strategy_degraded', 'video_ready', 'video_degraded', 'video_failed', 'agent_error', 'rtc_subtitle_local', 'agent_main', 'agent_branch'];
                    if (!skipSources.includes(payload?.source)) {
                        this._appendVoiceSubtitle(payload.text, 'system');
                    }
                }
            }
            if (payload?.source === 'pet_tap') {
                this.playTapMotion();
            }
            this.cycleExpression();
        });

        this.eventBus.on('RTC_SUBTITLE', (payload) => {
            const text = String(payload?.text || '').trim();
            if (!text) return;
            const isFinal = this._isFinalRtcSubtitlePayload(payload);
            if (!isFinal) return;
            if (this.rtcVoiceSubtitle && this.currentRtcVariant === 'voice') {
                this._upsertRtcVoiceSubtitle(text, 'system', payload);
            }
        });

        this.eventBus.on('RTC_USER_ASR', (payload) => {
            const text = String(payload?.text || '').trim();
            if (!text) return;
            if (this._lastUserAsrText === text) return;
            this._lastUserAsrText = text;
            if (this.rtcVoiceSubtitle && this.currentRtcVariant === 'voice') {
                this._appendVoiceSubtitle(text, 'user');
            }
        });

        this.eventBus.on('MODE_CHANGED', (mode) => {
            this._syncMenuActiveState();
        });

        this.eventBus.on('PET_STOP_SPEAKING', () => {
            this.isSpeaking = false;
            this.hideSpeechBubble();
            this.playIdleMotion();
        });

        this.eventBus.on('LIP_SYNC_VOLUME', (payload) => {
            const vol = Number(payload?.volume) || 0;
            this._setMouthOpenY(vol);
        });

        this.eventBus.on('SESSION_MESSAGE', (payload) => {
            appendSessionMessage(payload);
        });

        this.eventBus.on('RTC_AGENT_READY', (payload) => {
            console.log(`[Live2dModule] 智能体已加入房间 ${payload.roomId}，任务 ${payload.taskId}`);
        });

        this.eventBus.on('RTC_CONNECTED', () => {
            console.log('[Live2dModule] 收到 RTC_CONNECTED 事件，当前 variant:', this.currentRtcVariant);
            this._resetRtcVoiceSubtitleState();
            this.updateRtcVoiceStatus('connected');
            console.log('[Live2dModule] 准备启动通话计时器...');
            this.startRtcCallTimer();
        });

        this.eventBus.on('RTC_COMMAND_SENT', (payload) => {
            console.log('[Live2dModule] RTC指令发送成功:', payload?.action);
        });

        this.eventBus.on('RTC_COMMAND_FAILED', (payload) => {
            const actionLabel = payload?.action || 'RTC 指令';
            if (actionLabel === 'join') {
                this.updateRtcVoiceStatus('error');
                this.stopRtcCallTimer();
            }
            console.warn(`[Live2dModule] ${actionLabel} 失败:`, payload?.error || payload?.message);
        });

        this.eventBus.on('RTC_DISCONNECTED', () => {
            this._resetRtcVoiceSubtitleState();
            if (rtcTextInput) {
                rtcTextInput.value = '';
            }
            this.stopRtcCallTimer();
            this.updateRtcVoiceStatus('disconnected');
        });
    }

    bindModalWindowInteractions() {
        this.setupModalWindow('chat', this.chatWindow);
        this.setupModalWindow('video', this.videoWindow);

        document.addEventListener('mousemove', (event) => {
            if (!this.modalDragState) {
                return;
            }

            const { key, element, offsetX, offsetY } = this.modalDragState;
            const nextLeft = event.clientX - offsetX;
            const nextTop = event.clientY - offsetY;
            this.updateModalPosition(key, element, nextLeft, nextTop);
        });

        document.addEventListener('mouseup', () => {
            if (!this.modalDragState) {
                return;
            }
            this.modalDragState.element.classList.remove('is-dragging');
            this.modalDragState = null;
        });
    }

    setupModalWindow(key, element) {
        if (!element) {
            return;
        }

        const header = element.querySelector('.modal-header');
        const body = element.querySelector('.modal-body');
        header?.addEventListener('mousedown', (event) => {
            if (event.button !== 0 || event.target.closest('button, input, textarea')) {
                return;
            }
            event.preventDefault();
            this.bringModalToFront(element);
            this.startModalDrag(key, element, event);
        });

        body?.addEventListener('mousedown', (event) => {
            if (
                key !== 'video' ||
                element.dataset.rtcVariant !== 'voice' ||
                event.button !== 0 ||
                event.target.closest('button, input, textarea')
            ) {
                return;
            }
            event.preventDefault();
            this.bringModalToFront(element);
            this.startModalDrag(key, element, event);
        });

        element.addEventListener('mousedown', () => {
            this.bringModalToFront(element);
        });
    }

    configureRtcWindow(variant = 'voice') {
        const rtcVariant = variant === 'screen' ? 'screen' : 'voice';
        this.currentRtcVariant = rtcVariant;

        if (!this.videoWindow) {
            return;
        }

        const fullTitle = rtcVariant === 'screen' ? '🖥️ 屏幕共享' : '语音聊天';
        const compactTitle = rtcVariant === 'screen' ? '屏幕共享' : '语音聊天';
        const placeholderText = rtcVariant === 'screen'
            ? '正在与游戏AI助手通话中，并可共享屏幕...'
            : '对话字幕将在这里显示';

        this.videoWindow.dataset.rtcVariant = rtcVariant;
        this.videoWindow.dataset.fullTitle = fullTitle;
        this.videoWindow.dataset.compactTitle = compactTitle;

        if (this.videoWindowTitle) {
            this.videoWindowTitle.textContent = this.modalWindowStates.video.minimized ? compactTitle : fullTitle;
        }

        if (this.rtcPlaceholderText) {
            this.rtcPlaceholderText.textContent = placeholderText;
        }

        this._clearRtcVoiceSubtitleLog();
        this.stopRtcCallTimer();
        this.updateRtcVoiceStatus('connecting');

        if (this.rtcShareScreenButton) {
            // 不再根据 rtcVariant 隐藏共享按钮，保持按钮始终可见
        }
    }

    updateRtcVoiceStatus(status = 'connecting') {
        if (!this.videoWindow) {
            return;
        }

        this.videoWindow.dataset.rtcConnectionState = status;
        if (status === 'connected') {
            document.body.classList.add('is-rtc-mode');
        } else {
            this.eventBus.emit('BEFORE_RTC_MODE_EXIT');
            document.body.classList.remove('is-rtc-mode');
        }
        const isScreenVariant = this.currentRtcVariant === 'screen';
        const titleText = isScreenVariant ? '屏幕共享中' : '语音聊天中';
        const placeholderText = isScreenVariant ? '正在连接并准备共享视频工作区...' : '对话字幕将在这里显示';
        const subtitlePlaceholderMap = {
            connecting: '正在建立语音连接',
            connected: '对话字幕将在这里显示',
            disconnected: '等待你说话或输入消息',
            error: '语音连接失败，请稍后重试'
        };

        if (this.rtcVoiceTitle) {
            this.rtcVoiceTitle.textContent = titleText;
        }

        if (this.rtcPlaceholderText) {
            this.rtcPlaceholderText.textContent = placeholderText;
        }

        this._setRtcSubtitlePlaceholder(subtitlePlaceholderMap[status] || '等待你说话或输入消息');

        if (this.rtcStatusText) {
            const statusMap = {
                connecting: '连接中',
                connected: '已连接',
                disconnected: '未连接',
                error: '建会失败'
            };
            this.rtcStatusText.textContent = statusMap[status] || '连接中';
        }

        if (status !== 'connected' && this.rtcCallDuration) {
            this.rtcCallDuration.textContent = '00:00';
        }
        if (status !== 'connected' && this.rtcScreenCallTime) {
            this.rtcScreenCallTime.textContent = '通话时间 00:00';
        }
        if (status !== 'connected' && this.rtcVoiceTitle) {
            const baseTitle = this.currentRtcVariant === 'screen' ? '屏幕共享中' : '语音聊天中';
            this.rtcVoiceTitle.textContent = baseTitle;
        }
    }

    startRtcCallTimer() {
        console.log('[Live2dModule] startRtcCallTimer() 被调用');
        this.stopRtcCallTimer(false);
        this.rtcCallStartedAt = Date.now();
        if (this.rtcCallDuration) {
            this.rtcCallDuration.textContent = '00:00';
            console.log('[Live2dModule] 通话时长 DOM 已找到，已重置为 00:00');
        } else {
            console.warn('[Live2dModule] 通话时长 DOM 元素未找到 (#rtc-call-duration)');
        }
        if (this.rtcScreenCallTime) {
            this.rtcScreenCallTime.textContent = '通话时间 00:00';
        }
        if (this.rtcCallTimer) {
            console.log('[Live2dModule] 已有定时器在运行，先清除');
            window.clearInterval(this.rtcCallTimer);
        }
        this.rtcCallTimer = window.setInterval(() => {
            if (!this.rtcCallStartedAt || !this.rtcCallDuration) {
                return;
            }
            const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.rtcCallStartedAt) / 1000));
            const formattedDuration = this.formatRtcDuration(elapsedSeconds);
            this.rtcCallDuration.textContent = formattedDuration;
            if (this.rtcScreenCallTime) {
                this.rtcScreenCallTime.textContent = `通话时间 ${formattedDuration}`;
            }
            if (this.rtcVoiceTitle) {
                const baseTitle = this.currentRtcVariant === 'screen' ? '屏幕共享中' : '语音聊天中';
                this.rtcVoiceTitle.textContent = `${baseTitle} ${formattedDuration}`;
            }
            // 每10秒打一次日志，避免刷屏
            if (elapsedSeconds % 10 === 0) {
                console.log(`[Live2dModule] 通话计时中: ${formattedDuration}`);
            }
        }, 1000);
        console.log('[Live2dModule] 通话计时器已启动，定时器ID:', this.rtcCallTimer);
    }

    stopRtcCallTimer(resetDuration = true) {
        if (this.rtcCallTimer) {
            window.clearInterval(this.rtcCallTimer);
            this.rtcCallTimer = null;
        }
        this.rtcCallStartedAt = null;
        if (resetDuration && this.rtcCallDuration) {
            this.rtcCallDuration.textContent = '00:00';
        }
        if (resetDuration && this.rtcScreenCallTime) {
            this.rtcScreenCallTime.textContent = '通话时间 00:00';
        }
        if (resetDuration && this.rtcVoiceTitle) {
            const baseTitle = this.currentRtcVariant === 'screen' ? '屏幕共享中' : '语音聊天中';
            this.rtcVoiceTitle.textContent = baseTitle;
        }
    }

    formatRtcDuration(totalSeconds) {
        const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
    }

    bringModalToFront(element) {
        if (!element) {
            return;
        }
        this.modalZIndexSeed += 1;
        element.style.zIndex = String(this.modalZIndexSeed);
    }

    openModalWindow(key, element) {
        if (!element) {
            return;
        }

        element.classList.remove('hidden');
        this.bringModalToFront(element);

        const state = this.modalWindowStates[key];
        if (!state.initialized) {
            this.centerModalWindow(key, element);
            state.initialized = true;
        } else {
            this.applyStoredModalPosition(key, element);
        }

        this.setModalMinimized(key, element, false);
    }

    hideModalWindow(key, element) {
        if (!element) {
            return;
        }

        const state = this.modalWindowStates[key];
        state.minimized = false;
        element.classList.remove('is-minimized');
        element.classList.add('hidden');
        this.syncMinimizeButtonLabel(key);
        if (key === 'video') {
            this.stopRtcCallTimer();
            this.updateRtcVoiceStatus('disconnected');
        }
    }

    centerModalWindow(key, element) {
        const rect = element.getBoundingClientRect();
        const left = (window.innerWidth - rect.width) / 2;
        const top = (window.innerHeight - rect.height) / 2;
        this.updateModalPosition(key, element, left, top);
    }

    applyStoredModalPosition(key, element) {
        const state = this.modalWindowStates[key];
        if (typeof state.left !== 'number' || typeof state.top !== 'number') {
            this.centerModalWindow(key, element);
            return;
        }
        this.updateModalPosition(key, element, state.left, state.top);
    }

    getMinimizedModalAnchor(key, element) {
        const live2dRect = this.container?.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        const minimizedKeys = ['chat', 'video'].filter((itemKey) => this.modalWindowStates[itemKey]?.minimized);
        const orderIndex = Math.max(0, minimizedKeys.indexOf(key));
        const gap = 10;

        if (!live2dRect) {
            return {
                left: window.innerWidth - rect.width - 24,
                top: 24 + orderIndex * (rect.height + gap)
            };
        }

        const left = live2dRect.left + (live2dRect.width - rect.width) / 2;
        const top = live2dRect.top - rect.height - 18 - orderIndex * (rect.height + gap);
        return { left, top };
    }

    syncMinimizedModalAnchors() {
        const elementMap = {
            chat: this.chatWindow,
            video: this.videoWindow
        };

        ['chat', 'video'].forEach((key) => {
            if (!this.modalWindowStates[key]?.minimized) {
                return;
            }
            const element = elementMap[key];
            if (!element) {
                return;
            }
            const anchor = this.getMinimizedModalAnchor(key, element);
            this.updateModalPosition(key, element, anchor.left, anchor.top);
        });
    }

    updateModalPosition(key, element, left, top) {
        const rect = element.getBoundingClientRect();
        const maxLeft = Math.max(12, window.innerWidth - rect.width - 12);
        const maxTop = Math.max(12, window.innerHeight - rect.height - 12);
        const clampedLeft = Math.min(Math.max(left, 12), maxLeft);
        const clampedTop = Math.min(Math.max(top, 12), maxTop);

        this.modalWindowStates[key].left = clampedLeft;
        this.modalWindowStates[key].top = clampedTop;

        element.classList.add('is-floating');
        element.style.left = `${clampedLeft}px`;
        element.style.top = `${clampedTop}px`;
        element.style.transform = 'none';
    }

    startModalDrag(key, element, event) {
        const rect = element.getBoundingClientRect();
        this.modalDragState = {
            key,
            element,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top
        };
        element.classList.add('is-dragging');
    }

    setModalMinimized(key, element, minimized) {
        if (!element) {
            return;
        }

        const state = this.modalWindowStates[key];
        state.minimized = Boolean(minimized);
        element.classList.toggle('is-minimized', state.minimized);
        this.syncMinimizeButtonLabel(key);
        this.syncModalTitle(key, element);

        if (state.minimized) {
            if (typeof state.left === 'number' && typeof state.top === 'number') {
                state.restoreLeft = state.left;
                state.restoreTop = state.top;
            }
            this.syncMinimizedModalAnchors();
            return;
        }

        if (typeof state.restoreLeft === 'number' && typeof state.restoreTop === 'number') {
            this.updateModalPosition(key, element, state.restoreLeft, state.restoreTop);
            this.syncMinimizedModalAnchors();
            return;
        }

        this.applyStoredModalPosition(key, element);
        this.syncMinimizedModalAnchors();
    }

    syncModalTitle(key, element) {
        if (key !== 'video' || !element || !this.videoWindowTitle) {
            return;
        }

        const fullTitle = element.dataset.fullTitle || '语音聊天';
        const compactTitle = element.dataset.compactTitle || '语音聊天';
        this.videoWindowTitle.textContent = this.modalWindowStates.video.minimized ? compactTitle : fullTitle;
    }

    syncMinimizeButtonLabel(key) {
        const buttonMap = {
            chat: this.minimizeChatButton,
            video: this.minimizeVideoButton
        };
        const button = buttonMap[key];
        const isMinimized = this.modalWindowStates[key]?.minimized;
        if (!button) {
            return;
        }
        button.textContent = isMinimized ? '□' : '-';
        button.setAttribute('aria-label', isMinimized ? '恢复窗口' : '最小化窗口');
    }

    handleModelTap(globalPoint = null) {
        if (this.isSpeaking) {
            return;
        }

        if (!this.isExpanded) {
            this.setExpanded(true);
            return;
        }

        this.setExpanded(true);
        this.setLookMenuOpen(false);
        this.playTapMotion();
        this.triggerInteractiveExpression(globalPoint);
        // 抛出 pet_tap 交互事件，让底层调度触发 TTS 和聊天记录
        this.eventBus.emit('USER_SEND_QUERY', {
            text: '（用户戳了戳 Live2D）',
            source: 'pet_tap',
            interaction: 'model_tap'
        });
    }

    closeAllWindows() {
        this.hideModalWindow('chat', this.chatWindow);
        this.hideModalWindow('video', this.videoWindow);
    }

    activateMode(mode) {
        if (this.app.state.currentMode === mode) {
            console.log('[Live2dModule] 当前已在目标模式，触发同模式重入', { mode });
            this.eventBus.emit('MODE_CHANGED', mode);
            this.eventBus.emit('modeChanged', mode);
            return;
        }
        this.app.switchMode(mode);
    }

    isRtcModalVisible() {
        const chatVisible = !!this.chatWindow && !this.chatWindow.classList.contains('hidden');
        const videoVisible = !!this.videoWindow && !this.videoWindow.classList.contains('hidden');
        return chatVisible || videoVisible;
    }

    closeRtcSessionAndReturnToPet(source = 'unknown') {
        console.log('[Live2dModule] 统一执行 RTC 退房并返回桌宠模式', {
            source,
            currentMode: this.app.state.currentMode
        });
        this.eventBus.emit('LEAVE_RTC_MODE');
        this.eventBus.emit('CLOSE_CHAT_MODAL');
        this.eventBus.emit('CLOSE_RTC_MODAL');

        if (this.app.state.currentMode !== 'pet') {
            this.eventBus.emit('SUPPRESS_NEXT_PET_RTC_OPEN');
            this.app.switchMode('pet');
        }
    }

    closeChatWindow(backToPet = false) {
        this.hideModalWindow('chat', this.chatWindow);
        if (backToPet) {
            this.closeRtcSessionAndReturnToPet('close-chat-window');
        }
    }

    closeRtcWindow(backToPet = false) {
        this.hideModalWindow('video', this.videoWindow);
        if (backToPet) {
            this.closeRtcSessionAndReturnToPet('close-rtc-window');
            return;
        }
        this.eventBus.emit('LEAVE_RTC_MODE');
        this.eventBus.emit('CLOSE_RTC_MODAL');
    }

    showSpeechBubble(text) {
        if (!this.speechBubble) return;
        this.speechBubble.textContent = text;
        this.speechBubble.classList.remove('is-hidden');
    }

    hideSpeechBubble() {
        if (!this.speechBubble) return;
        this.speechBubble.classList.add('is-hidden');
        this.speechBubble.textContent = '';
    }

    _isControlMessage(text) {
        if (/\bEventTime\b|\bRoundID\b|\bTaskId\b|\bStage\b|\bUserID\b|\bCode\b/.test(text)) return true;
        if (/\banswerFinish\b|\banswerStart\b|\basrFinish\b|\basrStart\b/.test(text)) return true;
        if (/^\s*conv\b/.test(text)) return true;
        if (/[\[{].*"[A-Za-z_]+"\s*:.*[\]}]/.test(text)) return true;
        if (/^\s*[\[{]/.test(text) && /[\]}]\s*$/.test(text)) return true;
        if (/^[\s　]*[（(].*[）)][\s　]*$/.test(text)) {
            if (/[\u4e00-\u9fa5]|submit_|update_|query_/i.test(text)) return true;
        }
        if (/^[（(][\u4e00-\u9fa5]|submit_|update_|query_/i.test(text)) return true;
        if (/[（(]\s*[\u4e00-\u9fa5_a-z]+\s*[，,]/.test(text)) return true;
        return false;
    }

    _appendVoiceSubtitle(text, type = 'system') {
        if (!this.rtcVoiceSubtitle) return;
        const clean = String(text || '').trim();
        if (!clean) return;
        if (this._isControlMessage(clean)) return;

        if (type === 'user') {
            if (this._lastUserAsrText === clean) return;
            this._lastUserAsrText = clean;
        }

        const item = document.createElement('div');
        item.className = `rtc-voice-subtitle-item ${type}`;
        item.textContent = clean;
        this.rtcVoiceSubtitle.appendChild(item);
        this.rtcVoiceSubtitle.scrollTop = this.rtcVoiceSubtitle.scrollHeight;
    }

    _setRtcSubtitlePlaceholder(text = '等待你说话或输入消息') {
        if (!this.rtcVoiceSubtitle) return;
        this.rtcVoiceSubtitle.dataset.placeholder = text;
    }

    _clearRtcVoiceSubtitleLog() {
        if (!this.rtcVoiceSubtitle) return;
        this.rtcVoiceSubtitle.textContent = '';
        this._resetRtcVoiceSubtitleState();
        this._lastUserAsrText = '';
    }

    _resetRtcVoiceSubtitleState() {
        if (this._activeRtcSubtitleTimer) {
            clearTimeout(this._activeRtcSubtitleTimer);
            this._activeRtcSubtitleTimer = null;
        }
        this._activeRtcSubtitleItem = null;
        this._activeRtcSubtitleText = '';
        this._activeRtcSubtitleType = '';
    }

    _isFinalRtcSubtitlePayload(payload = {}) {
        const raw = payload?.raw || {};
        if (raw.partial === true) return false;
        if (raw.isFinal === false) return false;
        if (Array.isArray(raw?.data) && raw.data.length > 0) {
            if (raw.data.some((item) => item?.definite === false)) return false;
        }
        if (payload?.definite === false) return false;
        if (payload?.paragraph === false) return false;
        if (typeof raw.sentenceFinish === 'boolean') return raw.sentenceFinish;
        if (typeof raw.finish === 'boolean') return raw.finish;
        if (raw.isFinal === true || raw.definite === true) return true;
        return true;
    }

    _mergeRtcSubtitleText(previousText = '', nextText = '') {
        const prev = String(previousText || '').trim();
        const next = String(nextText || '').trim();
        if (!prev) return next;
        if (!next) return prev;
        if (next === prev) return prev;
        if (next.startsWith(prev)) return next;
        if (prev.startsWith(next)) return prev;

        const maxOverlap = Math.min(prev.length, next.length);
        for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
            if (prev.slice(-overlap) === next.slice(0, overlap)) {
                return `${prev}${next.slice(overlap)}`;
            }
        }

        const spacer = /[，。！？、；：,!?;:]$/.test(prev) || /^[，。！？、；：,!?;:]/.test(next) ? '' : ' ';
        return `${prev}${spacer}${next}`;
    }

    _finalizeRtcVoiceSubtitleSoon(delay = 900) {
        if (this._activeRtcSubtitleTimer) {
            clearTimeout(this._activeRtcSubtitleTimer);
        }
        this._activeRtcSubtitleTimer = setTimeout(() => {
            this._activeRtcSubtitleTimer = null;
            this._activeRtcSubtitleItem = null;
            this._activeRtcSubtitleText = '';
            this._activeRtcSubtitleType = '';
        }, delay);
    }

    _upsertRtcVoiceSubtitle(text, type = 'system', payload = {}) {
        if (!this.rtcVoiceSubtitle) return;
        const clean = String(text || '').trim();
        if (!clean) return;
        if (this._isControlMessage(clean)) return;

        if (type === 'user') {
            if (this._lastUserAsrText === clean) return;
            this._lastUserAsrText = clean;
        }

        const canMergeIntoActive =
            type === 'system' &&
            this._activeRtcSubtitleItem &&
            this._activeRtcSubtitleType === type &&
            this.rtcVoiceSubtitle.contains(this._activeRtcSubtitleItem);

        if (!canMergeIntoActive) {
            const item = document.createElement('div');
            item.className = `rtc-voice-subtitle-item ${type}`;
            item.textContent = clean;
            this.rtcVoiceSubtitle.appendChild(item);
            this._activeRtcSubtitleItem = type === 'system' ? item : null;
            this._activeRtcSubtitleText = type === 'system' ? clean : '';
            this._activeRtcSubtitleType = type === 'system' ? type : '';
        } else {
            const merged = this._mergeRtcSubtitleText(this._activeRtcSubtitleText, clean);
            this._activeRtcSubtitleItem.textContent = merged;
            this._activeRtcSubtitleText = merged;
        }

        this.rtcVoiceSubtitle.scrollTop = this.rtcVoiceSubtitle.scrollHeight;

        if (type === 'system') {
            this._finalizeRtcVoiceSubtitleSoon(300);
        }
    }

    renderLookOptions() {
        if (!this.lookOptions) {
            return;
        }

        this.lookOptions.innerHTML = '';
        MODEL_PRESETS.forEach((preset, index) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'look-option';
            if (index === this.currentLookIndex) {
                option.classList.add('is-active');
            }
            option.innerHTML = `
                <span class="look-option-thumb ${preset.previewClass || ''}">${preset.previewText || preset.label}</span>
                <span class="look-option-label">${preset.label}</span>
            `;
            option.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (this.currentLookIndex === index) {
                    this.setLookMenuOpen(false);
                    return;
                }
                this.currentLookIndex = index;
                this.setLookMenuOpen(false);
                await this.loadCurrentModel();
            });
            this.lookOptions.appendChild(option);
        });
    }

    setLookMenuOpen(open) {
        this.lookMenuOpen = Boolean(open) && this.isExpanded;
        this.lookOptions?.classList.toggle('is-open', this.lookMenuOpen);
        this.lookOptions?.setAttribute('aria-hidden', this.lookMenuOpen ? 'false' : 'true');
        this.changeLookButton?.classList.toggle('is-active', this.lookMenuOpen);
    }

    getExpressionNames() {
        const definitions =
            this.model?.internalModel?.settings?.expressions ||
            this.model?.internalModel?.settings?.json?.expressions ||
            [];

        return definitions
            .map((item) => item.name || item.Name || '')
            .filter(Boolean);
    }

    cycleExpression() {
        const expressions = this.getExpressionNames();

        if (expressions.length > 0 && this.model?.expression) {
            const expressionName = expressions[this.currentExpressionIndex % expressions.length];
            this.currentExpressionIndex += 1;
            try {
                this.model.expression(expressionName);
            } catch (error) {
                console.warn('Expression change failed', error);
            }
        } else {
            const fallback = this.container.querySelector('.fallback-character');
            if (fallback) {
                const cheeks = fallback.querySelectorAll('.character-cheek');
                cheeks.forEach((cheek) => {
                    cheek.style.background = 'rgba(255, 96, 140, 0.92)';
                });
                window.setTimeout(() => {
                    cheeks.forEach((cheek) => {
                        cheek.style.background = 'rgba(255, 140, 160, 0.55)';
                    });
                }, 700);
            }
        }

        this.refreshExpressionButton();
    }

    getInteractionZone(globalPoint = null) {
        if (!globalPoint || !this.stage) {
            return 'center';
        }

        const rect = this.stage.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return 'center';
        }

        const normalizedX = Math.min(Math.max((globalPoint.x - rect.left) / rect.width, 0), 1);
        const normalizedY = Math.min(Math.max((globalPoint.y - rect.top) / rect.height, 0), 1);

        if (normalizedY < 0.26) {
            return 'head';
        }
        if (normalizedY < 0.5) {
            return normalizedX < 0.34 ? 'left' : normalizedX > 0.66 ? 'right' : 'upper';
        }
        if (normalizedY > 0.76) {
            return 'lower';
        }
        return normalizedX < 0.34 ? 'left' : normalizedX > 0.66 ? 'right' : 'center';
    }

    pickInteractiveExpression(globalPoint = null) {
        const zone = this.getInteractionZone(globalPoint);
        let candidates = INTERACTION_EXPRESSIONS.filter((item) => item.zones.includes(zone));

        if (candidates.length < 3) {
            const supplemental = INTERACTION_EXPRESSIONS.filter((item) => item.zones.includes('center'));
            candidates = [...candidates, ...supplemental];
        }

        const uniqueCandidates = candidates.filter((item, index, array) => {
            return array.findIndex((entry) => entry.id === item.id) === index;
        });

        const pool = uniqueCandidates.filter((item) => item.id !== this.lastInteractionExpressionId);
        const finalPool = pool.length > 0 ? pool : uniqueCandidates;
        const picked = finalPool[Math.floor(Math.random() * finalPool.length)] || INTERACTION_EXPRESSIONS[0];

        this.lastInteractionExpressionId = picked.id;
        return picked;
    }

    applyExpressionProfile(profile) {
        const expressions = this.getExpressionNames();
        if (expressions.length > 0 && this.model?.expression) {
            const matched = expressions.filter((name) => {
                const lowerName = name.toLowerCase();
                return profile.keywords.some((keyword) => lowerName.includes(keyword));
            });

            const targetPool = matched.length > 0 ? matched : expressions;
            const targetName = targetPool[Math.floor(Math.random() * targetPool.length)];
            try {
                this.model.expression(targetName);
            } catch (error) {
                console.warn('Interactive expression change failed', error);
            }
        } else {
            const fallback = this.container.querySelector('.fallback-character');
            if (fallback) {
                const body = fallback.querySelector('.character-body');
                const mouth = fallback.querySelector('.mouth');
                const cheeks = fallback.querySelectorAll('.character-cheek');

                body.style.transition = 'transform 0.2s ease';
                body.style.transform = profile.id === 'playful' ? 'translateX(8px) rotate(2deg)' : 'translateX(0) rotate(0deg)';
                mouth.style.width = profile.id === 'pout' ? '22px' : profile.id === 'surprised' ? '12px' : '16px';
                mouth.style.height = profile.id === 'surprised' ? '12px' : '8px';
                mouth.style.borderRadius = profile.id === 'surprised' ? '50%' : '0 0 50% 50%';
                cheeks.forEach((cheek) => {
                    cheek.style.background = profile.id === 'shy'
                        ? 'rgba(255, 96, 140, 0.92)'
                        : 'rgba(255, 140, 160, 0.55)';
                });
                window.setTimeout(() => {
                    body.style.transform = 'translateX(0) rotate(0deg)';
                    mouth.style.width = '16px';
                    mouth.style.height = '8px';
                    mouth.style.borderRadius = '0 0 50% 50%';
                }, 850);
            }
        }
    }

    triggerInteractiveExpression(globalPoint = null) {
        const profile = this.pickInteractiveExpression(globalPoint);
        this.applyExpressionProfile(profile);
        this.expressionName.textContent = `互动表情: ${profile.label}`;
    }

    _setMouthOpenY(value) {
        if (!this.model) return;
        const targetValue = Math.max(0, Math.min(value, 0.8));
        try {
            this.model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', targetValue);
        } catch (err) {
            try {
                this.model.internalModel.coreModel.setParamValue('ParamMouthOpenY', targetValue);
            } catch (_) {}
        }
    }

    playTapMotion() {
        const groups = this.model?.internalModel?.motionManager?.motionGroups;
        if (groups) {
            const candidateGroups = ['tap_body', 'flick_head', 'pinch_in', 'pinch_out', 'shake'];
            const availableGroup = candidateGroups.find((name) => groups[name]);
            if (availableGroup) {
                this.model.motion(availableGroup);
                return;
            }
        }

        const fallback = this.container.querySelector('.fallback-character');
        if (fallback) {
            fallback.style.transition = 'transform 0.18s ease';
            fallback.style.transform = 'translateY(-10px)';
            window.setTimeout(() => {
                fallback.style.transform = 'translateY(0)';
            }, 180);
        }
    }

    playIdleMotion() {
        const groups = this.model?.internalModel?.motionManager?.motionGroups;
        if (groups?.idle) {
            this.model.motion('idle');
        }
    }

    setExpanded(expanded) {
        const previousRect = this.container.getBoundingClientRect();
        const centerX = previousRect.left + previousRect.width / 2;
        const centerY = previousRect.top + previousRect.height / 2;

        this.isExpanded = expanded;
        this.container.classList.toggle('is-expanded', expanded);
        this.container.classList.toggle('is-mini', !expanded);
        if (!expanded) {
            this.setLookMenuOpen(false);
        }
        this.container.dataset.panelState = expanded ? 'expanded' : 'mini';
        if (this.toggleButton) {
            this.toggleButton.textContent = expanded ? '收起' : '';
            this.toggleButton.setAttribute('aria-label', expanded ? '收起桌宠' : '展开桌宠');
        }

        if (this.model) {
            this.applyModelLayout();
        }

        const fallback = this.container.querySelector('.fallback-character .character-body');
        if (fallback) {
            fallback.style.transform = expanded ? 'translateX(18px)' : 'translateX(0)';
        }

        const nextWidth = this.container.offsetWidth;
        const nextHeight = this.container.offsetHeight;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const clampedLeft = Math.min(
            Math.max(centerX - nextWidth / 2, 12),
            Math.max(12, viewportWidth - nextWidth - 12)
        );
        const clampedTop = Math.min(
            Math.max(centerY - nextHeight / 2, 12),
            Math.max(12, viewportHeight - nextHeight - 12)
        );

        this.container.style.left = `${clampedLeft}px`;
        this.container.style.top = `${clampedTop}px`;
        this.container.style.right = 'auto';
        this.container.style.bottom = 'auto';

        if (expanded) {
            this._syncMenuActiveState();
        }
    }

    _syncMenuActiveState() {
        const currentMode = this.app.state.currentMode;
        const menuMap = {
            pet: this.menuPet,
            text_chat: this.menuChat,
            rtc: this.menuVideo
        };
        Object.entries(menuMap).forEach(([mode, btn]) => {
            if (btn) {
                btn.classList.toggle('is-active', mode === currentMode);
            }
        });
    }

    refreshLookButton() {
        const preset = MODEL_PRESETS[this.currentLookIndex];
        if (this.changeLookButton && preset) {
            this.changeLookButton.textContent = '造型';
        }

        if (this.lookName && preset) {
            this.lookName.textContent = preset.label;
            this.container.dataset.lookLabel = preset.label;
        }

        if (this.lookThumbText && preset) {
            this.lookThumbText.textContent = preset.previewText || preset.label;
        }

        if (this.lookThumb) {
            const themeClasses = MODEL_PRESETS.map((item) => item.previewClass).filter(Boolean);
            this.lookThumb.classList.remove(...themeClasses);
            if (preset?.previewClass) {
                this.lookThumb.classList.add(preset.previewClass);
            }
        }
    }

    refreshExpressionButton() {
        const expressions = this.getExpressionNames();
        if (this.expressionName) {
            if (expressions.length > 0) {
                const currentIndex = expressions.length === 0 ? 0 : (this.currentExpressionIndex + expressions.length - 1) % expressions.length;
                this.expressionName.textContent = `当前表情: ${expressions[currentIndex]}`;
            } else {
                this.expressionName.textContent = '当前表情: 待机';
            }
        }
    }
}
