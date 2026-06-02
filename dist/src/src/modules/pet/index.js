import { globalEventBus } from '../../core/eventBus.js';

/**
 * 桌宠模块（3种回复能力）
 */
export class PetModule {
    constructor() {
        // 只使用全局 eventBus 进行通信
        this.eventBus = globalEventBus;
        
        // 内部状态
        this.isActive = false;
        
        // DOM与资源引用
        this.audioElement = null;
        this.knowledgeCard = null;
        this.videoContainer = null;
        this.player = null;
        this.audioContext = null;
        this.analyserNode = null;
        this.audioSourceNode = null;
        this.lipSyncRafId = null;
        this.audioUnlocked = false;
        this.currentObjectAudioUrl = '';

        // this.init(); 交由 main.js 统一调用
    }

    init() {
        console.log('Pet module initialized');
        // 1. 注册所有事件监听
        this.eventBus.on('ENTER_PET_MODE', this.handleEnterMode.bind(this));
        this.eventBus.on('EXIT_PET_MODE', this.handleExitMode.bind(this));
        this.eventBus.on('PREPARE_TTS_PLAYBACK', this.prepareTtsPlayback.bind(this));
        this.eventBus.on('TRIGGER_TTS', this.handleTTS.bind(this));
        this.eventBus.on('TRIGGER_KNOWLEDGE', this.handleKnowledge.bind(this));
        this.eventBus.on('TRIGGER_video', this.handleVideo.bind(this));
        this.eventBus.on('PET_STOP_SPEAKING', this._stopLipSync.bind(this));
    }
    
    // ================= 处理进入/离开模式 =================
    
    handleEnterMode() {
        if (this.isActive) return;
        this.isActive = true;
        console.log('[PetModule] 进入媒体调度模式');
    }

    handleExitMode() {
        if (!this.isActive) return;
        this.isActive = false;
        console.log('[PetModule] 离开媒体调度模式');
        
        // 清理资源
        this.cleanup();
    }

    // ================= 处理TTS与动效 =================

    async prepareTtsPlayback() {
        if (this.audioUnlocked) {
            return;
        }

        try {
            if (!this.audioElement) {
                this.audioElement = new Audio();
            }

            this.audioElement.src = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAAAAAAAAAAAAAAAAAAAA';
            this.audioElement.muted = true;
            await this.audioElement.play();
            this.audioElement.pause();
            this.audioElement.currentTime = 0;
            this.audioElement.removeAttribute('src');
            this.audioElement.load();
            this.audioElement.muted = false;
            this.audioUnlocked = true;
        } catch (error) {
            console.warn('[PetModule] 预解锁 TTS 播放失败', error);
        }
    }

    async resolvePlayableAudioUrl(audioUrl = '') {
        if (!audioUrl || !String(audioUrl).startsWith('data:audio/')) {
            return audioUrl;
        }

        const matched = String(audioUrl).match(/^data:(audio\/[^;]+);base64,(.+)$/);
        if (!matched) {
            throw new Error('无法解析 TTS data URL');
        }

        const mimeType = matched[1];
        const base64Data = matched[2];
        const binaryText = window.atob(base64Data);
        const byteArray = new Uint8Array(binaryText.length);
        for (let index = 0; index < binaryText.length; index += 1) {
            byteArray[index] = binaryText.charCodeAt(index);
        }
        const audioBlob = new Blob([byteArray], { type: mimeType });

        if (this.currentObjectAudioUrl) {
            URL.revokeObjectURL(this.currentObjectAudioUrl);
            this.currentObjectAudioUrl = '';
        }

        this.currentObjectAudioUrl = URL.createObjectURL(audioBlob);
        return this.currentObjectAudioUrl;
    }

    async handleTTS(data) {
        const isPetTapPreview = data?.source === 'pet_tap';
        const forcePreview = data?.forcePreview === true;
        if (!this.isActive && !isPetTapPreview && !forcePreview) return;
        console.log('[PetModule] 触发TTS', data);

        const { text, audioUrl } = data || {};

        // 先停止上一段音频/动画，防止并发
        this._stopCurrentPlayback();

        if (audioUrl) {
            if (!this.audioElement) {
                this.audioElement = new Audio();
            }

            let playableAudioUrl = audioUrl;
            try {
                playableAudioUrl = await this.resolvePlayableAudioUrl(audioUrl);
            } catch (error) {
                this.eventBus.emit('PET_STOP_SPEAKING');
                return;
            }
            if (String(playableAudioUrl).startsWith('blob:')) {
                if (this.currentObjectAudioUrl && this.currentObjectAudioUrl !== playableAudioUrl) {
                    URL.revokeObjectURL(this.currentObjectAudioUrl);
                }
                this.currentObjectAudioUrl = playableAudioUrl;
            }
            this.audioElement.muted = false;
            this.audioElement.onplay = null;
            this.audioElement.onended = null;
            this.audioElement.onerror = null;
            this.audioElement.src = playableAudioUrl;

            this.audioElement.onplay = () => {
                console.log('[PetModule] 音频播放开始，触发 PET_START_SPEAKING');
                this._setupAudioPipeline();
                this._startLipSync();
                this.eventBus.emit('PET_START_SPEAKING', { text });
            };

            this.audioElement.onended = () => {
                console.log('[PetModule] 音频播放结束，触发 PET_STOP_SPEAKING');
                this._stopLipSync();
                this.eventBus.emit('PET_STOP_SPEAKING');
            };

            this.audioElement.onerror = (err) => {
                console.warn('[PetModule] 音频加载失败，不触发说话动画', err);
                this._stopLipSync();
                this.eventBus.emit('PET_STOP_SPEAKING');
            };

            this.audioElement.play().catch(err => {
                console.warn('[PetModule] 音频播放调用失败', err);
                this._stopLipSync();
                this.eventBus.emit('PET_STOP_SPEAKING');
            });
        } else {
            this.eventBus.emit('PET_START_SPEAKING', { text });
            if (this.resetBubbleTimer) {
                clearTimeout(this.resetBubbleTimer);
            }
            this.resetBubbleTimer = setTimeout(() => {
                this.eventBus.emit('PET_STOP_SPEAKING');
            }, 3000);
        }
    }

    _stopCurrentPlayback() {
        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.src = '';
            this.audioElement.onplay = null;
            this.audioElement.onended = null;
            this.audioElement.onerror = null;
        }
        if (this.currentObjectAudioUrl) {
            URL.revokeObjectURL(this.currentObjectAudioUrl);
            this.currentObjectAudioUrl = '';
        }
        if (this.resetBubbleTimer) {
            clearTimeout(this.resetBubbleTimer);
            this.resetBubbleTimer = null;
        }
        this._stopLipSync();
    }

    _setupAudioPipeline() {
        if (this.audioContext) {
            try { this.audioContext.close(); } catch (_) {}
            this.audioContext = null;
        }
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = 256;
        this.analyserNode.smoothingTimeConstant = 0.7;
        try {
            this.audioSourceNode = this.audioContext.createMediaElementSource(this.audioElement);
            this.audioSourceNode.connect(this.analyserNode);
            this.analyserNode.connect(this.audioContext.destination);
        } catch (err) {
            console.warn('[PetModule] 音频管线连接失败，使用备用分析', err);
        }
    }

    _startLipSync() {
        this._stopLipSync();
        const dataArray = new Uint8Array(this.analyserNode?.frequencyBinCount || 128);
        const tick = () => {
            if (!this.analyserNode || !this.audioElement || this.audioElement.paused || this.audioElement.ended) {
                return;
            }
            this.analyserNode.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const average = sum / dataArray.length;
            const normalizedVolume = Math.min(average / 128, 1);
            const mouthOpenY = normalizedVolume * 0.8;
            this.eventBus.emit('LIP_SYNC_VOLUME', { volume: mouthOpenY });
            this.lipSyncRafId = requestAnimationFrame(tick);
        };
        this.lipSyncRafId = requestAnimationFrame(tick);
    }

    _stopLipSync() {
        if (this.lipSyncRafId) {
            cancelAnimationFrame(this.lipSyncRafId);
            this.lipSyncRafId = null;
        }
        if (this.audioContext) {
            try { this.audioContext.close(); } catch (_) {}
            this.audioContext = null;
        }
        this.analyserNode = null;
        this.audioSourceNode = null;
        this.eventBus.emit('LIP_SYNC_VOLUME', { volume: 0 });
    }

    // ================= 处理知识库图文卡片 =================

    handleKnowledge(data) {
        if (!this.isActive && data?.forcePreview !== true) return;
        console.log('[PetModule] 触发知识库渲染', data);
        
        const { title, content, imgUrl, loading } = data || {};
        
        // 渲染图文卡片
        if (!this.knowledgeCard) {
            this.knowledgeCard = document.createElement('div');
            this.knowledgeCard.className = 'knowledge-card';
            this.knowledgeCard.style.zIndex = '1001';
            document.body.appendChild(this.knowledgeCard);
        }
        
        this.knowledgeCard.innerHTML = loading
            ? `
                <div class="knowledge-loading">
                    <div class="knowledge-loading-spinner"></div>
                    <p>知识卡片生成中</p>
                </div>
            `
            : `
                <h3>${title || '知识库'}</h3>
                ${imgUrl ? `<img src="${imgUrl}" alt="knowledge" style="max-width: 320px; border-radius: 8px;" />` : ''}
                <p>${content || '暂无内容'}</p>
                <button class="close-btn" style="margin-top: 10px; cursor: pointer;">关闭</button>
            `;
        this.knowledgeCard.style.display = 'block';
        
        // 绑定关闭事件
        const closeBtn = this.knowledgeCard.querySelector('.close-btn');
        if (closeBtn) {
            closeBtn.onclick = () => {
                this.knowledgeCard.style.display = 'none';
            };
        }
    }

    // ================= 处理视频播放 =================

    getApiBaseUrl() {
        const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
        const rtcRuntime = runtime.rtc || {};
        return String(runtime.apiBaseUrl || rtcRuntime.apiBaseUrl || 'http://127.0.0.1:8788').replace(/\/$/, '');
    }

    async resolveVideoUrl(linkUrl = '') {
        const cleanLinkUrl = String(linkUrl || '').trim();
        if (!cleanLinkUrl) {
            return null;
        }

        try {
            const response = await fetch(`${this.getApiBaseUrl()}/api/media/douyin/video-resolve`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    url: cleanLinkUrl
                })
            });
            const json = await response.json().catch(() => null);
            if (!response.ok || !json?.ok) {
                throw new Error(json?.message || `解析抖音视频失败: HTTP ${response.status}`);
            }
            return json.data || null;
        } catch (error) {
            console.warn('[PetModule] 解析抖音站内播放地址失败', error);
            return null;
        }
    }

    async handleVideoLinkClick(event, data = {}) {
        event.preventDefault();

        const trigger = event.currentTarget;
        const originalText = trigger?.textContent || '打开抖音视频';
        if (trigger) {
            trigger.textContent = '正在尝试站内播放...';
            trigger.style.pointerEvents = 'none';
            trigger.style.opacity = '0.72';
        }

        try {
            const resolved = await this.resolveVideoUrl(data.linkUrl);
            const resolvedVideoUrl = String(resolved?.videoUrl || '').trim();
            if (resolvedVideoUrl) {
                this.handleVideo({
                    ...data,
                    title: resolved?.title || data.title,
                    summary: resolved?.description || data.summary,
                    coverUrl: resolved?.coverUrl || data.coverUrl,
                    linkUrl: resolved?.url || data.linkUrl,
                    videoUrl: resolvedVideoUrl
                });
                return;
            }
        } finally {
            if (trigger) {
                trigger.textContent = originalText;
                trigger.style.pointerEvents = '';
                trigger.style.opacity = '';
            }
        }

        if (data.linkUrl) {
            window.open(data.linkUrl, '_blank', 'noopener,noreferrer');
        }
    }

    handleVideo(data) {
        if (!this.isActive && data?.forcePreview !== true) return;
        console.log('[PetModule] 触发视频播放', data);
        
        const { videoUrl, title, linkUrl, summary, coverUrl } = data || {};
        if (!videoUrl && !linkUrl) return;

        // 渲染视频容器
        if (!this.videoContainer) {
            this.videoContainer = document.createElement('div');
            this.videoContainer.className = 'video-card';
            this.videoContainer.style.padding = '10px';
            this.videoContainer.style.zIndex = '1002';
            
            // 内部 DOM 结构
            this.videoContainer.innerHTML = `
                <div style="display: flex; justify-content: space-between; color: #fff; margin-bottom: 10px;">
                    <span class="video-title"></span>
                    <button class="close-video-btn" style="cursor: pointer; background: transparent; border: none; color: #fff;">✖</button>
                </div>
                <div class="video-body"></div>
            `;
            document.body.appendChild(this.videoContainer);

            // 绑定关闭事件
            const closeBtn = this.videoContainer.querySelector('.close-video-btn');
            closeBtn.onclick = () => {
                this.closeVideo();
            };
        }
        
        this.videoContainer.style.display = 'block';
        const titleEl = this.videoContainer.querySelector('.video-title');
        const bodyEl = this.videoContainer.querySelector('.video-body');
        if (titleEl) titleEl.innerText = title || '视频播放';
        if (!bodyEl) return;

        if (linkUrl && !videoUrl) {
            if (this.player) {
                this.player.destroy();
                this.player = null;
            }

            bodyEl.innerHTML = `
                <p style="color: #fff; line-height: 1.7; margin: 0 0 12px;">${summary || '已根据知识内容生成相关抖音检索。'}</p>
                <a href="${linkUrl}" target="_blank" rel="noreferrer" data-video-link style="display: inline-block; padding: 10px 14px; border-radius: 999px; background: #7c5cff; color: #fff; text-decoration: none;">打开抖音视频</a>
            `;
            const videoLinkNode = bodyEl.querySelector('[data-video-link]');
            if (videoLinkNode) {
                videoLinkNode.addEventListener('click', (event) => {
                    this.handleVideoLinkClick(event, data);
                });
            }
            return;
        }

        bodyEl.innerHTML = '<div id="xgplayer-container"></div>';

        // 初始化或更新播放器
        if (!this.player) {
            // 确保 window.Player 存在 (来自 xgplayer CDN)
            if (window.Player) {
                this.player = new window.Player({
                    id: 'xgplayer-container',
                    url: videoUrl,
                    width: 600,
                    height: 337.5,
                    autoplay: true,
                    videoInit: true
                });
            } else {
                console.error('xgplayer 未加载');
            }
        } else {
            this.player.src = videoUrl;
            this.player.play();
        }
    }

    closeVideo() {
        if (this.player) {
            this.player.pause();
        }
        if (this.videoContainer) {
            this.videoContainer.style.display = 'none';
        }
    }

    // ================= 资源清理 =================

    cleanup() {
        this._stopCurrentPlayback();

        if (this.player) {
            this.player.destroy();
            this.player = null;
        }
    }
}
