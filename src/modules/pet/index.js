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
        this._pendingAssetCards = [];
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
        this.eventBus.on('TRIGGER_PENDING_ASSET', this.handlePendingAsset.bind(this));
        this.eventBus.on('CLEAR_PENDING_ASSET', (payload) => {
            const cardId = String(payload?.cardId || '');
            if (cardId) {
                this._removePendingAssetCard(cardId);
            }
        });
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

    _escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    _buildRagTop1BannerHtml(ragMeta) {
        if (!ragMeta || typeof ragMeta !== 'object') return '';
        const top1 = ragMeta.top1 || null;
        const items = Array.isArray(ragMeta.top_items) ? ragMeta.top_items : [];
        const isWeak = ragMeta.weak_hit === true;

        // 无 top1 + 无候选 → 彻底空，显示精简提示
        if (!top1 && items.length === 0) {
            return `<div class="rag-top1-banner is-weak" title="知识库未召回相关文档">
                <span class="rag-top1-icon">⚠️</span>
                <span class="rag-top1-text">知识库未命中，已切换通用思路</span>
            </div>`;
        }
        const src = top1 || items[0] || {};
        const sourceTypeLabel = {
            user_local: '本地库',
            user_cloud: '云端库',
            house_volc: '官方库',
            default_local: '内置库',
        };
        const docName = this._escapeHtml(src.doc_name || src.docName || src.title || '');
        const sourceLabel = this._escapeHtml(src.source_label || src.sourceLabel || sourceTypeLabel[src.sourceType] || '知识库');
        const rel = typeof src.relevance === 'number' ? src.relevance : (typeof src.score === 'number' ? src.score : 0);
        const relPct = Math.round(rel * 100);
        const cls = isWeak ? 'is-weak' : 'is-strong';
        return `<div class="rag-top1-banner ${cls}" title="${docName}">
            <span class="rag-top1-icon">${isWeak ? '⚠️' : '📌'}</span>
            <span class="rag-top1-text">${sourceLabel} · ${relPct}%</span>
        </div>`;
    }

    _buildRagSourceTagsHtml(ragMeta) {
        if (!ragMeta || typeof ragMeta !== 'object') return '';
        const items = Array.isArray(ragMeta.top_items) ? ragMeta.top_items : [];
        if (items.length === 0) return '';
        const sourceTypeClass = {
            user_local: '',
            user_cloud: 'is-cloud',
            house_volc: 'is-house',
            default_local: 'is-default',
        };
        const tags = items.slice(0, 2).map((it) => {
            const typeKey = it.sourceType || 'default_local';
            const cls = sourceTypeClass[typeKey] || '';
            const docName = this._escapeHtml(it.docName || it.title || '');
            return `<span class="rag-source-tag ${cls}" title="${this._escapeHtml(it.title || '')}">${docName}</span>`;
        }).join('');
        return `<div class="rag-source-tags">${tags}</div>`;
    }

    _isRtcConnected() {
        const primaryText = String(document.getElementById('rtc-status-text')?.textContent || '').trim();
        const workspaceText = String(document.getElementById('status-rtc')?.textContent || '').trim();
        return primaryText.includes('已连接') || workspaceText.includes('已连接');
    }

    _createPendingAssetCard(data) {
        const incomingCardId = data?.cardId ?? ++this._cardCounter;
        const cardId = String(incomingCardId);
        const existingCard = this._pendingAssetCards[cardId];
        if (existingCard) {
            existingCard.dataset.cardId = cardId;
            existingCard.style.zIndex = '2350';
            return { card: existingCard, cardId, isNew: false };
        }

        const card = document.createElement('div');
        card.className = 'knowledge-card pending-asset-card';
        card.dataset.cardId = cardId;
        card.style.zIndex = '2350';
        document.body.appendChild(card);
        this._pendingAssetCards[cardId] = card;
        return { card, cardId, isNew: true };
    }

    _removePendingAssetCard(cardId) {
        const key = String(cardId || '');
        if (!key) return;
        const card = this._pendingAssetCards[key];
        if (card && card.parentElement) {
            card.parentElement.removeChild(card);
        }
        delete this._pendingAssetCards[key];
    }

    _initPendingAssetCardEvents(card, cardId) {
        const header = card.querySelector('.knowledge-card-header');
        if (header) header.style.cursor = 'move';

        card.addEventListener('click', (e) => {
            const target = e.target.closest('.close-btn');
            if (target) {
                this._removePendingAssetCard(cardId);
            }
        });

        let isDragging = false;
        let startX = 0, startY = 0, initialX = 0, initialY = 0;

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            card.style.position = 'fixed';
            card.style.left = `${initialX + dx}px`;
            card.style.top = `${initialY + dy}px`;
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
            if (target.tagName === 'BUTTON' || target.closest('button') || target.closest('a')) return;
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

    handlePendingAsset(data) {
        const isPreview = data?.forcePreview === true;
        const rtcConnected = this._isRtcConnected();
        if (!this.isActive && !isPreview && !rtcConnected) {
            console.warn('[PetModule] 通用占位卡被守卫拦截', { isActive: this.isActive, isPreview, rtcConnected });
            return;
        }
        const { card, cardId, isNew } = this._createPendingAssetCard(data);
        const title = this._escapeHtml(data?.title || '任务处理中');
        const summary = this._escapeHtml(data?.summary || '正在确认意图并准备对应卡片...');
        const typeLabel = data?.assetType === 'video' ? '视频检索' : (data?.assetType === 'strategy' ? '策略分析' : '任务处理');
        card.innerHTML = `
            <div class="knowledge-card-header" data-action="drag" data-card-id="${cardId}" title="可拖拽移动">
                <span class="knowledge-card-title">${title}</span>
                <button class="close-btn" data-card-id="${cardId}" title="关闭">×</button>
            </div>
            <div class="pending-card-body">
                <div class="pending-card-type">${typeLabel}</div>
                <div class="knowledge-loading-spinner"></div>
                <p class="pending-card-summary">${summary}</p>
            </div>
        `;
        if (isNew) {
            this._initPendingAssetCardEvents(card, cardId);
        }
        card.style.display = 'block';
    }

    handleKnowledge(data) {
        const isPreview = data?.forcePreview === true;
        const rtcConnected = this._isRtcConnected();
        if (!this.isActive && !isPreview && !rtcConnected) {
            console.warn('[PetModule] 知识卡片被守卫拦截', { isActive: this.isActive, isPreview, rtcConnected, loading: data?.loading });
            return;
        }
        console.log('[PetModule] 触发知识库渲染', { loading: data?.loading, imageLoading: data?.imageLoading, isPreview, isActive: this.isActive });

        if (data?.cardId) {
            this._removePendingAssetCard(data.cardId);
        }

        const { title, content, summary, list, imgUrl, loading, imageLoading, posterLoading, canExportPoster, timeout, imageFailed, ragMeta } = data || {};
        const detailList = Array.isArray(list) ? list.filter(Boolean) : [];
        const summaryText = String(summary || '').trim();
        const posterStyleLabel = this._escapeHtml(data?.posterStyleLabel || '');
        const ragTagsHtml = this._buildRagSourceTagsHtml(ragMeta);
        const ragTop1BannerHtml = this._buildRagTop1BannerHtml(ragMeta);
        if (data?.cardId) {
            this._removePendingAssetCard(data.cardId);
        }
        const posterActionHtml = canExportPoster ? `
                    <div class="knowledge-card-actions">
                        <button class="knowledge-export-poster-btn" data-action="switch-poster-style" data-card-id="${data?.cardId || ''}" ${posterLoading ? 'disabled' : ''}>
                            ${posterLoading ? '风格生成中...' : `换一种风格${posterStyleLabel ? ` · ${posterStyleLabel}` : ''}`}
                        </button>
                    </div>
        ` : '';
        const contentHtml = `
                <div class="knowledge-card-body">
                    ${ragTop1BannerHtml}
                    ${summaryText ? `<p class="knowledge-card-summary">${summaryText}</p>` : ''}
                    ${detailList.length > 0 ? `
                    <ul class="knowledge-card-list">
                        ${detailList.map((item) => `<li>${item}</li>`).join('')}
                    </ul>
                    ` : `<p class="knowledge-card-content">${content || '暂无内容'}</p>`}
                    ${posterActionHtml}
                    ${ragTagsHtml}
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
                ? '海报导出超时，已保留文字卡片。'
                : '海报导出失败，已保留文字卡片。';
            card.innerHTML = `
                <div class="knowledge-card-header" data-action="drag" data-card-id="${cardId}" title="可拖拽移动">
                    <span class="knowledge-card-title">${title || '知识库'}${hasImageWarning ? ' <span class="timeout-tag">海报未就绪</span>' : ''}</span>
                    <button class="knowledge-minimize-btn" data-action="minimize" data-card-id="${cardId}" title="最小化">─</button>
                    <button class="close-btn" data-action="close" data-card-id="${cardId}" title="关闭">×</button>
                </div>
                ${imageLoading ? `
                <div class="knowledge-image-loading">
                    <div class="knowledge-loading-spinner"></div>
                    <span>图片生成中...</span>
                </div>
                ` : ''}
                ${posterLoading ? `
                <div class="knowledge-image-loading">
                    <div class="knowledge-loading-spinner"></div>
                    <span>正在导出海报...</span>
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
            } else if ((action === 'switch-poster-style' || action === 'export-poster') && actionCardId === String(cardId)) {
                this.eventBus.emit('SWITCH_KNOWLEDGE_POSTER_STYLE', { cardId });
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
        const incomingCardId = data?.cardId ?? ++this._cardCounter;
        const cardId = String(incomingCardId);
        const existingCard = this._videoContainers[cardId];
        if (existingCard) {
            existingCard.dataset.cardId = cardId;
            existingCard.style.zIndex = '2500';
            return { card: existingCard, cardId, isNew: false };
        }

        const card = document.createElement('div');
        card.className = 'video-card';
        card.dataset.cardId = cardId;
        card.style.zIndex = '2500';
        document.body.appendChild(this._videoContainers[cardId] = card);
        return { card, cardId, isNew: true };
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
        const isSecondary = data?.isSecondary === true;
        const rtcConnected = this._isRtcConnected();
        if (!this.isActive && !isPreview && !rtcConnected && !isSecondary) {
            console.warn('[PetModule] 视频卡片被守卫拦截', { isActive: this.isActive, isPreview, rtcConnected, loading: data?.loading, isSecondary });
            return;
        }
        console.log('[PetModule] 触发视频渲染', { loading: data?.loading, isPreview, isActive: this.isActive, isSecondary });

        const { videoUrl, title, linkUrl, summary, coverUrl, loading, bilibili_linkUrl, douyin_linkUrl } = data || {};
        if (data?.cardId) {
            this._removePendingAssetCard(data.cardId);
        }

        const { card, cardId } = this._createVideoCard(data);
        card.innerHTML = `
            <div class="video-card-header" data-card-id="${cardId}">
                <span class="video-title">${this._escapeHtml(title || '视频检索')}</span>
                <button class="close-video-btn knowledge-minimize-btn" data-card-id="${cardId}" title="关闭">×</button>
            </div>
            <div class="video-body"></div>
        `;
        this._initVideoCardEvents(card, cardId);
        card.style.display = 'block';

        const bodyEl = card.querySelector('.video-body');

        if (loading) {
            if (bodyEl) {
                bodyEl.innerHTML = `
                    <div class="video-loading">
                        <div class="knowledge-loading-spinner"></div>
                        <p>${this._escapeHtml(summary || '正在检索相关视频链接...')}</p>
                    </div>
                `;
            }
            return;
        }
        if (!videoUrl && !linkUrl && !bilibili_linkUrl && !douyin_linkUrl) {
            if (bodyEl) {
                bodyEl.innerHTML = `
                    <div class="video-empty">
                        <p>未找到相关视频</p>
                    </div>
                `;
            }
            return;
        }

        const finalLinkUrl = linkUrl || videoUrl;
        const fallbackUrl = this._buildVideoFallbackUrl(title, summary);
        const isUnreliable = this._isUnreliableVideoDomain(finalLinkUrl);
        if (bodyEl) {
            const summaryHtml = summary ? `<p class="video-summary">${summary}</p>` : '';
            const coverHtml = coverUrl ? `
                <a href="${finalLinkUrl || bilibili_linkUrl || douyin_linkUrl || fallbackUrl || ''}" target="_blank" rel="noopener noreferrer" class="video-cover">
                    <img src="${coverUrl}" alt="${this._escapeHtml(title || '视频封面')}" onerror="this.parentElement.style.display='none'">
                    <div class="video-play-overlay">
                        <div class="video-play-icon">
                            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                    </div>
                </a>
            ` : '';
            // 优先使用双链渲染；若平台链接不可用则降级到单链接展示
            const hasBothPlatforms = bilibili_linkUrl && douyin_linkUrl;
            if (hasBothPlatforms) {
                const biliLink = bilibili_linkUrl || fallbackUrl;
                const douyinLink = douyin_linkUrl || `https://www.douyin.com/search?keyword=${encodeURIComponent(title || '')}`;
                bodyEl.innerHTML = `
                    ${coverHtml}
                    ${summaryHtml}
                    <div class="video-link-row">
                        <a href="${biliLink}" target="_blank" rel="noopener noreferrer" data-video-link class="video-link-bilibili">
                            <svg viewBox="0 0 24 24"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373z"/></svg>
                            B站
                        </a>
                        <a href="${douyinLink}" target="_blank" rel="noopener noreferrer" data-video-link class="video-link-douyin">
                            <svg viewBox="0 0 24 24"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>
                            抖音
                        </a>
                    </div>
                `;
            } else if (isUnreliable && fallbackUrl) {
                bodyEl.innerHTML = `
                    ${coverHtml}
                    ${summaryHtml}
                    <div class="video-link-row">
                        <a href="${fallbackUrl}" target="_blank" rel="noopener noreferrer" data-video-link class="video-link-primary">B站搜索视频</a>
                        <a href="${finalLinkUrl}" target="_blank" rel="noopener noreferrer" data-video-original class="video-link-secondary">原始链接</a>
                    </div>
                    <p class="video-fallback-tip">原视频链接在桌面端可能无法播放，已为你提供 B 站搜索</p>
                `;
            } else if (finalLinkUrl) {
                bodyEl.innerHTML = `
                    ${coverHtml}
                    ${summaryHtml}
                    <a href="${finalLinkUrl}" target="_blank" rel="noopener noreferrer" data-video-link class="video-link-primary">
                        <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M8 5v14l11-7z"/></svg>
                        点击查看视频
                    </a>
                `;
            } else if (bilibili_linkUrl) {
                bodyEl.innerHTML = `
                    ${coverHtml}
                    ${summaryHtml}
                    <a href="${bilibili_linkUrl}" target="_blank" rel="noopener noreferrer" data-video-link class="video-link-bilibili">
                        <svg viewBox="0 0 24 24"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373z"/></svg>
                        B站
                    </a>
                `;
            } else if (douyin_linkUrl) {
                bodyEl.innerHTML = `
                    ${coverHtml}
                    ${summaryHtml}
                    <a href="${douyin_linkUrl}" target="_blank" rel="noopener noreferrer" data-video-link class="video-link-douyin">
                        <svg viewBox="0 0 24 24"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>
                        抖音
                    </a>
                `;
            }
        }
    }

    cleanup() {
        this._stopCurrentPlayback();
    }
}
