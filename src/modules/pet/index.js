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
        this.knowledgeImageOverlay = null;
        this._knowledgeCards = [];
        this._videoContainers = [];
        this._isVideoLoading = false;
        this._cardCounter = 0;
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
        this.eventBus.on('PET_STOP_SPEAKING', this._handlePetStopSpeaking.bind(this));
        this.eventBus.on('BEFORE_RTC_MODE_EXIT', this._preserveCardPositionBeforeRtcExit.bind(this));
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

    stripBracketDescriptions(text = '') {
        return String(text)
            .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    async handleTTS(data) {
        const isPetTapPreview = data?.source === 'pet_tap';
        const forcePreview = data?.forcePreview === true;
        if (!this.isActive && !isPetTapPreview && !forcePreview) return;
        console.log('[PetModule] 触发TTS', data);

        const rawText = data?.text || '';
        const text = this.stripBracketDescriptions(String(rawText));
        const rawSpeech = data?.speech || '';
        const speech = this.stripBracketDescriptions(String(rawSpeech));
        const { audioUrl } = data || {};

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
                this.eventBus.emit('PET_START_SPEAKING', { text, source: data?.source });
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
            this.eventBus.emit('PET_START_SPEAKING', { text, source: data?.source });
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

    /**
     * 响应 PET_STOP_SPEAKING 事件：
     * - 默认仅停 LipSync（兼容音频自然结束/失败回流）。
     * - 当 payload.interrupt === true 时，强制中止当前音频播放（用于"打断"语义）。
     */
    _handlePetStopSpeaking(payload = {}) {
        if (payload && payload.interrupt === true) {
            this._stopCurrentPlayback();
            return;
        }
        this._stopLipSync();
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

    _createKnowledgeCard(data) {
        const incomingCardId = data?.cardId ?? ++this._cardCounter;
        const cardId = String(incomingCardId);
        const existingCard = this._knowledgeCards[cardId];
        if (existingCard) {
            existingCard.dataset.cardId = cardId;
            existingCard.style.zIndex = '2400';
            return { card: existingCard, cardId, isNew: false };
        }

        const card = document.createElement('div');
        card.className = 'knowledge-card';
        card.dataset.cardId = cardId;
        card.style.zIndex = '2400';
        document.body.appendChild(card);
        this._knowledgeCards[cardId] = card;
        return { card, cardId, isNew: true };
    }

    _removeKnowledgeCard(cardId) {
        const card = this._knowledgeCards[cardId];
        if (card && card.parentElement) {
            card.parentElement.removeChild(card);
        }
        delete this._knowledgeCards[cardId];
    }

    handleKnowledge(data) {
        const isPreview = data?.forcePreview === true;
        const rtcConnected = document.getElementById('rtc-status-text')?.textContent === '已连接';
        if (!this.isActive && !isPreview && !rtcConnected) {
            console.warn('[PetModule] 知识卡片被守卫拦截', { isActive: this.isActive, isPreview, rtcConnected, loading: data?.loading });
            return;
        }
        console.log('[PetModule] 触发知识库渲染', { loading: data?.loading, imageLoading: data?.imageLoading, isPreview, isActive: this.isActive });

        const { title, content, summary, list, imgUrl, loading, imageLoading, timeout, imageFailed } = data || {};
        const detailList = Array.isArray(list) ? list.filter(Boolean) : [];
        const summaryText = String(summary || '').trim();
        const contentHtml = `
                <div class="knowledge-card-body">
                    ${summaryText ? `<p class="knowledge-card-summary">${summaryText}</p>` : ''}
                    ${detailList.length > 0 ? `
                    <ul class="knowledge-card-list">
                        ${detailList.map((item) => `<li>${item}</li>`).join('')}
                    </ul>
                    ` : `<p class="knowledge-card-content">${content || '暂无内容'}</p>`}
                </div>
            `;

        const { card, cardId, isNew } = this._createKnowledgeCard(data);

        if (loading) {
            card.innerHTML = `
                <div class="knowledge-card-header" data-action="drag" data-card-id="${cardId}" title="可拖拽移动">
                    <span class="knowledge-card-title">${title || '知识库'}</span>
                    <button class="knowledge-minimize-btn" data-action="minimize" data-card-id="${cardId}" title="最小化">─</button>
                    <button class="close-btn" data-action="close" data-card-id="${cardId}" title="关闭">×</button>
                </div>
                <div class="knowledge-loading">
                    <div class="knowledge-loading-spinner"></div>
                    <p>知识卡片生成中</p>
                </div>
            `;
        } else {
            const isTimeout = timeout === true;
            const hasImageWarning = isTimeout || imageFailed === true;
            const warningText = isTimeout
                ? '图片生成超过 45 秒，已先展示文字卡片；图片返回后会自动补上。'
                : '图片生成失败，已保留文字卡片。';
            card.innerHTML = `
                <div class="knowledge-card-header" data-action="drag" data-card-id="${cardId}" title="可拖拽移动">
                    <span class="knowledge-card-title">${title || '知识库'}${hasImageWarning ? ' <span class="timeout-tag">图片未就绪</span>' : ''}</span>
                    <button class="knowledge-minimize-btn" data-action="minimize" data-card-id="${cardId}" title="最小化">─</button>
                    <button class="close-btn" data-action="close" data-card-id="${cardId}" title="关闭">×</button>
                </div>
                ${imageLoading ? `
                <div class="knowledge-image-loading">
                    <div class="knowledge-loading-spinner"></div>
                    <span>图片生成中...</span>
                </div>
                ` : ''}
                ${imgUrl ? `<button class="knowledge-card-img-btn" data-action="preview-image" data-card-id="${cardId}" title="点击放大图片"><img src="${imgUrl}" alt="knowledge" class="knowledge-card-img" /></button>` : ''}
                ${hasImageWarning ? `<p class="knowledge-card-warning">${warningText}</p>` : ''}
                ${contentHtml}
            `;
        }

        if (isNew) {
            this._initKnowledgeCardEvents(card, cardId);
        }
        card.style.display = 'block';
    }

    _initKnowledgeCardEvents(card, cardId) {
        const header = card.querySelector('.knowledge-card-header');
        if (header) header.style.cursor = 'move';

        card.addEventListener('click', (e) => {
            const target = e.target.closest('button');
            if (!target) return;
            const action = target.dataset.action;
            const actionCardId = String(target.dataset.cardId || '');

            if (action === 'close' && actionCardId === String(cardId)) {
                this._removeKnowledgeCard(cardId);
            } else if (action === 'minimize' && actionCardId === String(cardId)) {
                const contentEl = card.querySelector('.knowledge-loading') ||
                    card.querySelector('.knowledge-card-body');
                const imageLoadingEl = card.querySelector('.knowledge-image-loading');
                const imgEl = card.querySelector('.knowledge-card-img');
                const warningEl = card.querySelector('.knowledge-card-warning');
                if (target.textContent === '─') {
                    if (contentEl) contentEl.style.display = 'none';
                    if (imageLoadingEl) imageLoadingEl.style.display = 'none';
                    if (imgEl) imgEl.style.display = 'none';
                    if (warningEl) warningEl.style.display = 'none';
                    target.textContent = '□';
                } else {
                    if (contentEl) contentEl.style.display = '';
                    if (imageLoadingEl) imageLoadingEl.style.display = '';
                    if (imgEl) imgEl.style.display = '';
                    if (warningEl) warningEl.style.display = '';
                    target.textContent = '─';
                }
            } else if (action === 'preview-image' && actionCardId === String(cardId)) {
                const imgUrl = card.querySelector('.knowledge-card-img')?.src;
                if (imgUrl) this.openKnowledgeImagePreview(imgUrl, card.querySelector('.knowledge-card-title')?.textContent || '知识卡片图片');
            }
        });

        let isDragging = false;
        let startX = 0, startY = 0, initialX = 0, initialY = 0;

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            card.style.position = 'fixed';
            card.style.left = (initialX + dx) + 'px';
            card.style.top = (initialY + dy) + 'px';
            card.style.right = 'auto';
            card.style.bottom = 'auto';
            card.style.transform = 'none';
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            card.style.transition = '';
        };

        card.addEventListener('mousedown', (e) => {
            const target = e.target;
            if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.tagName === 'IMG') return;
            if (target.closest('button') || target.closest('a')) return;

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = card.getBoundingClientRect();
            initialX = rect.left;
            initialY = rect.top;
            card.style.transition = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    openKnowledgeImagePreview(imgUrl = '', title = '知识卡片图片') {
        if (!imgUrl) return;

        if (!this.knowledgeImageOverlay) {
            this.knowledgeImageOverlay = document.createElement('div');
            this.knowledgeImageOverlay.className = 'knowledge-image-overlay';
            document.body.appendChild(this.knowledgeImageOverlay);
        }

        this.knowledgeImageOverlay.innerHTML = `
            <div class="knowledge-image-preview">
                <div class="knowledge-image-preview-header">
                    <span>${title}</span>
                    <button class="knowledge-image-preview-close" data-action="close-preview" title="关闭">×</button>
                </div>
                <img src="${imgUrl}" alt="${title}" />
            </div>
        `;
        this.knowledgeImageOverlay.style.display = 'flex';
        this.knowledgeImageOverlay.onclick = (event) => {
            if (event.target === this.knowledgeImageOverlay || event.target?.dataset?.action === 'close-preview') {
                this.knowledgeImageOverlay.style.display = 'none';
            }
        };
    }

    _preserveCardPositionBeforeRtcExit() {
        const preservePosition = (el) => {
            if (!el || el.style.display === 'none' || !el.offsetParent) return;
            const rect = el.getBoundingClientRect();
            el.style.left = rect.left + 'px';
            el.style.top = rect.top + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.transform = 'none';
            el.style.transition = 'none';
        };
        Object.values(this._knowledgeCards).forEach(card => preservePosition(card));
        Object.values(this._videoContainers).forEach(card => preservePosition(card));
    }

    // ================= 处理视频链接 =================

    _buildVideoFallbackUrl(title = '', summary = '') {
        const keyword = [title, summary]
            .filter(Boolean)
            .join(' ')
            .replace(/[（(][^）)]*[）)]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60);
        if (!keyword) return '';
        return `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword + ' 游戏 教学')}`;
    }

    _isUnreliableVideoDomain(url = '') {
        const host = String(url || '').toLowerCase();
        return /jingxuan\.douyin\.com|m\.douyin\.com\/shipin/i.test(host);
    }

    _createVideoCard(data) {
        const cardId = ++this._cardCounter;
        const card = document.createElement('div');
        card.className = 'video-card';
        card.dataset.cardId = cardId;
        card.style.zIndex = '2500';
        document.body.appendChild(this._videoContainers[cardId] = card);
        return { card, cardId };
    }

    _removeVideoCard(cardId) {
        const card = this._videoContainers[cardId];
        if (card && card.parentElement) {
            card.parentElement.removeChild(card);
        }
        delete this._videoContainers[cardId];
    }

    _initVideoCardEvents(card, cardId) {
        card.addEventListener('click', (e) => {
            const target = e.target.closest('.close-video-btn');
            if (target) {
                this._removeVideoCard(cardId);
            }
        });
    }

    handleVideo(data) {
        const isPreview = data?.forcePreview === true;
        const rtcConnected = document.getElementById('rtc-status-text')?.textContent === '已连接';
        if (!this.isActive && !isPreview && !rtcConnected) {
            console.warn('[PetModule] 视频卡片被守卫拦截', { isActive: this.isActive, isPreview, rtcConnected, loading: data?.loading });
            return;
        }
        console.log('[PetModule] 触发视频渲染', { loading: data?.loading, isPreview, isActive: this.isActive });

        const { videoUrl, title, linkUrl, summary, coverUrl, loading } = data || {};

        if (loading) {
            return;
        }

        const { card, cardId } = this._createVideoCard(data);

        card.innerHTML = `
            <div class="video-card-header" data-card-id="${cardId}">
                <span class="video-title">${title || '视频播放'}</span>
                <button class="close-video-btn knowledge-minimize-btn" data-card-id="${cardId}" title="关闭">×</button>
            </div>
            <div class="video-body"></div>
        `;

        this._initVideoCardEvents(card, cardId);
        card.style.display = 'block';

        const bodyEl = card.querySelector('.video-body');
        if (!videoUrl && !linkUrl) {
            if (bodyEl) {
                bodyEl.innerHTML = `
                    <div style="text-align: center; padding: 20px;">
                        <p style="color: rgba(255,255,255,0.6); margin: 0 0 12px; font-size: 13px;">未找到相关视频</p>
                    </div>
                `;
            }
            return;
        }

        const finalLinkUrl = linkUrl || videoUrl;
        const fallbackUrl = this._buildVideoFallbackUrl(title, summary);
        const isUnreliable = this._isUnreliableVideoDomain(finalLinkUrl);
        if (bodyEl) {
            const summaryHtml = summary ? `<p style="color: rgba(255,255,255,0.85); line-height: 1.6; margin: 0 0 14px; font-size: 13px;">${summary}</p>` : '';
            if (isUnreliable && fallbackUrl) {
                bodyEl.innerHTML = `
                    ${summaryHtml}
                    <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                        <a href="${fallbackUrl}" target="_blank" rel="noopener noreferrer" data-video-link style="display: inline-block; padding: 10px 14px; border-radius: 999px; background: #7c5cff; color: #fff; text-decoration: none; font-size: 13px;">B站搜索视频</a>
                        <a href="${finalLinkUrl}" target="_blank" rel="noopener noreferrer" data-video-original style="display: inline-block; padding: 8px 12px; border-radius: 999px; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.5); text-decoration: none; font-size: 11px; border: 1px solid rgba(255,255,255,0.15);">原始链接</a>
                    </div>
                    <p style="color: rgba(255,255,255,0.35); margin: 6px 0 0; font-size: 11px;">原视频链接在桌面端可能无法播放，已为你提供 B 站搜索</p>
                `;
            } else {
                bodyEl.innerHTML = `
                    ${summaryHtml}
                    <a href="${finalLinkUrl}" target="_blank" rel="noopener noreferrer" data-video-link style="display: inline-block; padding: 10px 14px; border-radius: 999px; background: #7c5cff; color: #fff; text-decoration: none; font-size: 13px;">点击查看视频</a>
                `;
            }
        }
    }

    cleanup() {
        this._stopCurrentPlayback();
    }
}
