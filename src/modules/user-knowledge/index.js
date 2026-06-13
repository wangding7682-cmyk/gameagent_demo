// 用户外挂知识库模块（前端）
// 职责：
// 1. IndexedDB 持久化用户上传的本地知识库（5MB/文件）
// 2. 简单切片（按段落/字数）+ 关键词召回（前端 Bigram Jaccard）
// 3. 维护知识库源列表（开关、domain、云端 key），暴露统一 sources 数组
// 4. 渲染管理弹窗
// 5. 监听 KNOWLEDGE_SOURCES_REQUEST 事件，应答当前生效 sources 数组

const DB_NAME = 'gameai_user_knowledge';
const DB_VERSION = 1;
const STORE_DOCS = 'docs';
const STORE_CONFIG = 'config';
const FILE_LIMIT_BYTES = 5 * 1024 * 1024; // 5MB

const SUPPORTED_DOMAINS = [
    { value: 'lol', label: '英雄联盟' },
    { value: 'wzry', label: '王者荣耀' },
    { value: 'genshin', label: '原神' },
    { value: 'honkai', label: '崩坏：星穹铁道' },
    { value: 'zzz', label: '绝区零' },
    { value: 'other', label: '其他/通用' },
];

function getApiBaseUrl() {
    const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
    const rtcRuntime = runtime.rtc || {};
    return String(runtime.apiBaseUrl || rtcRuntime.apiBaseUrl || 'http://127.0.0.1:8788').replace(/\/$/, '');
}

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_DOCS)) {
                const store = db.createObjectStore(STORE_DOCS, { keyPath: 'id' });
                store.createIndex('domain', 'domain', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_CONFIG)) {
                db.createObjectStore(STORE_CONFIG, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbGetAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

async function dbPut(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

async function dbDelete(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

async function dbGetConfig(key, defaultValue) {
    const all = await dbGetAll(STORE_CONFIG);
    const item = all.find((it) => it.key === key);
    return item ? item.value : defaultValue;
}

async function dbSetConfig(key, value) {
    return dbPut(STORE_CONFIG, { key, value });
}

function naiveDomainPredict(text = '', filename = '') {
    const haystack = `${filename}\n${text.slice(0, 800)}`.toLowerCase();
    const rules = [
        { domain: 'lol', kws: ['英雄联盟', 'lol', '召唤师峡谷', '亚索', '盲僧', '锤石', '辅助', '上单', '中单', 'adc'] },
        { domain: 'wzry', kws: ['王者荣耀', '王者', 'wzry', 'kpl', '貂蝉', '后羿', '李白', '庄周', '钟馗', '鲁班'] },
        { domain: 'genshin', kws: ['原神', 'genshin', '璃月', '蒙德', '稻妻', '元素反应', '七神'] },
        { domain: 'honkai', kws: ['星穹铁道', '崩坏', 'honkai', '星铁', '空间站', '黑塔'] },
        { domain: 'zzz', kws: ['绝区零', 'zzz', '新艾利都', '空洞'] },
    ];
    let best = { domain: 'other', score: 0 };
    for (const rule of rules) {
        let score = 0;
        for (const kw of rule.kws) {
            if (haystack.includes(kw.toLowerCase())) score += 1;
        }
        if (score > best.score) best = { domain: rule.domain, score };
    }
    return best.domain;
}

function chunkText(text, maxLen = 400) {
    const cleaned = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!cleaned) return [];
    const paragraphs = cleaned.split(/\n{2,}|\n#+\s/).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    for (const para of paragraphs) {
        if (para.length <= maxLen) {
            chunks.push(para);
            continue;
        }
        for (let i = 0; i < para.length; i += maxLen) {
            chunks.push(para.slice(i, i + maxLen));
        }
    }
    return chunks;
}

function bigramSet(text) {
    const s = String(text || '').replace(/\s+/g, '');
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) {
        set.add(s.slice(i, i + 2));
    }
    return set;
}

function jaccardSimilarity(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) { if (b.has(t)) inter += 1; }
    return inter / (a.size + b.size - inter);
}

function localBm25LikeRank(query, items, topK = 5) {
    const qSet = bigramSet(query);
    return items
        .map((it) => {
            const sim = jaccardSimilarity(qSet, bigramSet(`${it.title || ''} ${it.content || ''}`));
            return { ...it, score: sim };
        })
        .filter((it) => it.score > 0.02)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

class UserKnowledgeModule {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.docs = [];
        this.config = {
            builtinLolEnabled: true,
            builtinWzryEnabled: true,
            houseVolcEnabled: true,
            cloudExtras: [],
        };
        this._modal = null;
        this._inited = false;
    }

    async init() {
        if (this._inited) return;
        this._inited = true;
        try {
            this.docs = await dbGetAll(STORE_DOCS);
            const savedConfig = await dbGetConfig('user_knowledge_config', null);
            if (savedConfig) {
                this.config = { ...this.config, ...savedConfig };
            }
        } catch (e) {
            console.warn('[UserKnowledge] IndexedDB 初始化失败，使用内存模式', e);
        }

        this._injectButton();
        this._buildModalDom();

        this.eventBus.on('KNOWLEDGE_SOURCES_REQUEST', (request = {}) => {
            const cb = typeof request.callback === 'function' ? request.callback : null;
            const sources = this.buildSources();
            if (cb) cb(sources);
            this.eventBus.emit('KNOWLEDGE_SOURCES_RESPONSE', { sources });
        });

        // 暴露 runtime API 方便其他模块同步读取
        if (typeof window !== 'undefined') {
            window.__GAME_AI_RUNTIME__ = window.__GAME_AI_RUNTIME__ || {};
            window.__GAME_AI_RUNTIME__.userKnowledge = {
                getSources: () => this.buildSources(),
                module: this,
            };
        }

        console.log('[UserKnowledge] 初始化完成', {
            docs: this.docs.length,
            config: this.config,
        });
    }

    buildSources() {
        const sources = [];
        // 用户本地库（按 domain 分组聚合 chunks）
        const docsByDomain = new Map();
        for (const doc of this.docs) {
            if (doc.disabled) continue;
            if (!docsByDomain.has(doc.domain)) docsByDomain.set(doc.domain, []);
            const items = docsByDomain.get(doc.domain);
            for (const chunk of doc.chunks || []) {
                items.push({
                    id: `${doc.id}-${chunk.index}`,
                    title: `${doc.name} #${chunk.index + 1}`,
                    content: chunk.text,
                    docName: doc.name,
                    embedding: Array.isArray(chunk.embedding) ? chunk.embedding : undefined,
                });
            }
        }
        for (const [domain, items] of docsByDomain) {
            if (items.length === 0) continue;
            sources.push({
                type: 'user_local',
                domain: domain === 'other' ? null : domain,
                label: `我的本地库·${SUPPORTED_DOMAINS.find((d) => d.value === domain)?.label || domain}`,
                enabled: true,
                topK: 5,
                items,
            });
        }
        // 用户云端外挂（多个）
        for (const cloud of this.config.cloudExtras || []) {
            if (!cloud || cloud.disabled) continue;
            if (!cloud.apiKey || !cloud.serviceResourceId) continue;
            sources.push({
                type: 'user_cloud',
                domain: cloud.domain || null,
                label: cloud.label || '我的云端库',
                enabled: true,
                topK: 5,
                apiKey: cloud.apiKey,
                serviceResourceId: cloud.serviceResourceId,
            });
        }
        // 内置示例库
        if (this.config.builtinLolEnabled) {
            sources.push({ type: 'default_local', domain: 'lol', label: '内置·英雄联盟示例库', enabled: true, topK: 5 });
        }
        if (this.config.builtinWzryEnabled) {
            sources.push({ type: 'default_local', domain: 'wzry', label: '内置·王者荣耀示例库', enabled: true, topK: 5 });
        }
        if (this.config.houseVolcEnabled) {
            sources.push({ type: 'house_volc', label: '官方云端库', enabled: true, topK: 5 });
        }
        return sources;
    }

    async saveConfig() {
        try { await dbSetConfig('user_knowledge_config', this.config); } catch (e) { console.warn(e); }
    }

    async addDocFromFile(file) {
        if (!file) throw new Error('未选择文件');
        if (file.size > FILE_LIMIT_BYTES) {
            throw new Error(`单文件大小不能超过 5MB（当前 ${(file.size / 1024 / 1024).toFixed(2)}MB）`);
        }
        const text = await file.text();
        const chunks = chunkText(text).map((t, i) => ({ index: i, text: t }));

        // 1. domain 预判 — 优先复用同名文件的旧 domain（已用户确认过的更优先）
        let predictRes;
        const reusable = this._findReusableDomain(file.name, file.size);
        if (reusable) {
            predictRes = {
                domain: reusable.domain,
                confidence: reusable.confidence ?? 0.95,
                reason: `复用上一次「${reusable.confirmed ? '用户确认' : '预判'}」结果（同名文件）`,
                source: 'reuse_cache',
            };
        } else {
            predictRes = await this._predictDomainViaLLM(text, file.name);
        }

        const doc = {
            id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            size: file.size,
            domain: predictRes.domain,
            domainPredicted: predictRes.domain,
            domainConfidence: predictRes.confidence,
            domainReason: predictRes.reason,
            domainSource: predictRes.source,
            domainConfirmed: false,
            chunks,
            createdAt: Date.now(),
            disabled: false,
            embeddingStatus: 'pending',
        };
        return doc;
    }

    // 同名文件复用：优先取用户已确认过的 domain；其次取最近一次的预判结果
    _findReusableDomain(filename, size) {
        if (!Array.isArray(this.docs) || this.docs.length === 0) return null;
        const sameName = this.docs
            .filter((d) => d.name === filename)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (sameName.length === 0) return null;
        const confirmed = sameName.find((d) => d.domainConfirmed);
        if (confirmed) {
            return { domain: confirmed.domain, confidence: confirmed.domainConfidence, confirmed: true };
        }
        const latest = sameName[0];
        return { domain: latest.domain, confidence: latest.domainConfidence, confirmed: false };
    }

    async _predictDomainViaLLM(text, filename) {
        try {
            const baseUrl = getApiBaseUrl();
            const snippet = String(text || '').slice(0, 1200);
            const resp = await fetch(`${baseUrl}/api/data/knowledge/predict-domain`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, text: snippet }),
            });
            const json = await resp.json();
            if (json?.ok && json.data) {
                return json.data;
            }
        } catch (e) {
            console.warn('[UserKnowledge] LLM 预判失败，降级到本地关键词', e);
        }
        return {
            domain: naiveDomainPredict(text, filename),
            confidence: 0.4,
            reason: '本地关键词命中',
            source: 'local_rule',
        };
    }

    async _embedDocChunks(doc) {
        if (!doc?.chunks?.length) return doc;
        try {
            const baseUrl = getApiBaseUrl();
            const texts = doc.chunks.map((c) => `${doc.name}\n${c.text}`);
            const resp = await fetch(`${baseUrl}/api/data/knowledge/embedding`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texts }),
            });
            const json = await resp.json();
            const vectors = json?.data?.vectors || [];
            if (Array.isArray(vectors) && vectors.length === doc.chunks.length) {
                doc.chunks = doc.chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));
                doc.embeddingStatus = 'ready';
                doc.embeddingDim = json.data.dim;
            } else {
                doc.embeddingStatus = 'partial';
            }
        } catch (e) {
            console.warn('[UserKnowledge] embedding 计算失败，文档将仅以 BM25 召回', e);
            doc.embeddingStatus = 'failed';
        }
        return doc;
    }

    async commitDoc(doc) {
        await dbPut(STORE_DOCS, doc);
        this.docs = await dbGetAll(STORE_DOCS);
        this._renderDocList();
    }

    async removeDoc(id) {
        await dbDelete(STORE_DOCS, id);
        this.docs = await dbGetAll(STORE_DOCS);
        this._renderDocList();
    }

    async toggleDoc(id, disabled) {
        const target = this.docs.find((d) => d.id === id);
        if (!target) return;
        target.disabled = disabled;
        await dbPut(STORE_DOCS, target);
        this._renderDocList();
    }

    _injectButton() {
        const readmeBtn = document.getElementById('btn-readme');
        if (!readmeBtn) return;
        if (document.getElementById('btn-user-knowledge')) return;
        const btn = document.createElement('button');
        btn.id = 'btn-user-knowledge';
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-readme';
        btn.textContent = '我的知识库';
        btn.style.marginLeft = '8px';
        readmeBtn.parentNode.insertBefore(btn, readmeBtn.nextSibling);
        btn.addEventListener('click', () => this.openModal());
    }

    _buildModalDom() {
        if (document.getElementById('user-knowledge-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'user-knowledge-modal';
        modal.className = 'uk-modal is-hidden';
        modal.innerHTML = `
            <div class="uk-dialog">
                <div class="uk-header">
                    <h2>📚 我的知识库</h2>
                    <button class="btn" data-action="close">关闭</button>
                </div>
                <div class="uk-body">
                    <section class="uk-section">
                        <h3>内置示例库</h3>
                        <p class="uk-tip">默认开启，让你直接体验 RAG 多源召回。可以多选，也可以全部关闭。</p>
                        <label class="uk-toggle"><input type="checkbox" data-builtin="lol"> 英雄联盟示例库（14 篇）</label>
                        <label class="uk-toggle"><input type="checkbox" data-builtin="wzry"> 王者荣耀示例库（12 篇）</label>
                        <label class="uk-toggle"><input type="checkbox" data-builtin="house"> 官方云端库（火山）</label>
                    </section>
                    <section class="uk-section">
                        <h3>本地外挂（IndexedDB · 单文件 ≤ 5MB）</h3>
                        <p class="uk-tip">上传 .txt / .md 文件。系统会自动预测它属于哪个游戏，再让你确认。</p>
                        <div class="uk-upload-row">
                            <input type="file" id="uk-file-input" accept=".txt,.md,.markdown" />
                        </div>
                        <div id="uk-doc-list" class="uk-doc-list"></div>
                    </section>
                    <section class="uk-section">
                        <h3>云端外挂（火山引擎知识库）</h3>
                        <p class="uk-tip">如果你已经在火山自建了知识库，可以填入 apiKey 与 serviceResourceId 让小G优先访问它。</p>
                        <div id="uk-cloud-list" class="uk-cloud-list"></div>
                        <button class="btn" data-action="add-cloud">+ 新增云端外挂</button>
                    </section>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this._modal = modal;

        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.dataset?.action === 'close') {
                modal.classList.add('is-hidden');
            }
            if (e.target.dataset?.action === 'add-cloud') {
                this._addCloudEntry();
            }
        });

        modal.querySelector('[data-builtin="lol"]').addEventListener('change', (e) => {
            this.config.builtinLolEnabled = e.target.checked;
            this.saveConfig();
        });
        modal.querySelector('[data-builtin="wzry"]').addEventListener('change', (e) => {
            this.config.builtinWzryEnabled = e.target.checked;
            this.saveConfig();
        });
        modal.querySelector('[data-builtin="house"]').addEventListener('change', (e) => {
            this.config.houseVolcEnabled = e.target.checked;
            this.saveConfig();
        });

        const fileInput = modal.querySelector('#uk-file-input');
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            this._setUploadingHint('正在解析文件并请 LLM 判定 domain...');
            try {
                const doc = await this.addDocFromFile(file);
                const confirmedDomain = await this._promptDomainConfirm(doc);
                if (!confirmedDomain) {
                    fileInput.value = '';
                    this._setUploadingHint('');
                    return;
                }
                doc.domain = confirmedDomain;
                doc.domainConfirmed = true;
                this._setUploadingHint('正在为文档计算向量索引（embedding）...');
                await this._embedDocChunks(doc);
                await this.commitDoc(doc);
                fileInput.value = '';
                this._setUploadingHint('');
            } catch (err) {
                alert(err.message || '上传失败');
                fileInput.value = '';
                this._setUploadingHint('');
            }
        });
    }

    _setUploadingHint(text) {
        if (!this._modal) return;
        let hint = this._modal.querySelector('#uk-upload-hint');
        if (!hint) {
            hint = document.createElement('div');
            hint.id = 'uk-upload-hint';
            hint.className = 'uk-upload-hint';
            const row = this._modal.querySelector('.uk-upload-row');
            if (row) row.parentNode.insertBefore(hint, row.nextSibling);
        }
        hint.textContent = text || '';
        hint.style.display = text ? 'block' : 'none';
    }

    async _promptDomainConfirm(doc) {
        // 真正的弹窗 UI（替换原 window.prompt），展示 LLM 预判结果 + 置信度 + 理由 + 手动覆盖。
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'uk-confirm-overlay';
            const labelMap = SUPPORTED_DOMAINS.reduce((m, d) => { m[d.value] = d.label; return m; }, {});
            const predLabel = labelMap[doc.domainPredicted] || doc.domainPredicted;
            const confidencePct = Math.round((doc.domainConfidence || 0) * 100);
            const sourceLabel = doc.domainSource === 'llm'
                ? '🤖 LLM 预判'
                : doc.domainSource === 'rule_fallback'
                    ? '🔁 LLM 不可用，降级关键词'
                    : doc.domainSource === 'reuse_cache'
                        ? '♻️ 复用历史结果（省一次 LLM）'
                        : '🔍 本地关键词';
            overlay.innerHTML = `
                <div class="uk-confirm-dialog">
                    <h3>📚 确认知识库领域</h3>
                    <p class="uk-confirm-meta">文件：<strong>${escapeHtml(doc.name)}</strong>（${doc.chunks.length} 个分片）</p>
                    <div class="uk-confirm-card">
                        <div class="uk-confirm-pred-row">
                            <span class="uk-confirm-tag">${escapeHtml(sourceLabel)}</span>
                            <strong class="uk-confirm-domain">${escapeHtml(predLabel)}</strong>
                            <span class="uk-confirm-confidence">置信度 ${confidencePct}%</span>
                        </div>
                        <p class="uk-confirm-reason">${escapeHtml(doc.domainReason || '（无理由说明）')}</p>
                    </div>
                    <label class="uk-confirm-label">如不准确，请手动选择：</label>
                    <select class="uk-confirm-select">
                        ${SUPPORTED_DOMAINS.map((d) => `<option value="${d.value}" ${d.value === doc.domainPredicted ? 'selected' : ''}>${d.label}</option>`).join('')}
                    </select>
                    <div class="uk-confirm-actions">
                        <button class="btn" data-act="cancel">取消</button>
                        <button class="btn btn-primary" data-act="ok">确认并上传</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            const cleanup = (val) => { overlay.remove(); resolve(val); };
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay || e.target.dataset?.act === 'cancel') cleanup(null);
                if (e.target.dataset?.act === 'ok') {
                    const sel = overlay.querySelector('.uk-confirm-select');
                    cleanup(sel.value || doc.domainPredicted);
                }
            });
        });
    }

    _renderDocList() {
        if (!this._modal) return;
        const list = this._modal.querySelector('#uk-doc-list');
        if (!list) return;
        if (this.docs.length === 0) {
            list.innerHTML = '<div class="uk-empty">还没有上传任何文档。</div>';
            return;
        }
        const labelMap = SUPPORTED_DOMAINS.reduce((m, d) => { m[d.value] = d.label; return m; }, {});
        list.innerHTML = this.docs.map((doc) => {
            const embStatus = doc.embeddingStatus || 'pending';
            const embTag = {
                ready: '<span class="uk-chip uk-chip-ok">向量索引 ✓</span>',
                pending: '<span class="uk-chip uk-chip-warn">仅 BM25</span>',
                partial: '<span class="uk-chip uk-chip-warn">向量部分</span>',
                failed: '<span class="uk-chip uk-chip-warn">向量失败</span>',
            }[embStatus] || '';
            return `
            <div class="uk-doc-item${doc.disabled ? ' is-disabled' : ''}" data-id="${doc.id}">
                <div class="uk-doc-meta">
                    <strong>${escapeHtml(doc.name)}</strong>
                    <span class="uk-chip">${escapeHtml(labelMap[doc.domain] || doc.domain)}</span>
                    <span class="uk-chip">${doc.chunks.length} chunks</span>
                    <span class="uk-chip">${(doc.size / 1024).toFixed(1)} KB</span>
                    ${embTag}
                </div>
                <div class="uk-doc-actions">
                    <label class="uk-toggle uk-toggle-inline">
                        <input type="checkbox" data-doc-toggle="${doc.id}" ${doc.disabled ? '' : 'checked'}> 启用
                    </label>
                    <button class="btn btn-mini" data-doc-remove="${doc.id}">删除</button>
                </div>
            </div>
        `;
        }).join('');
        list.querySelectorAll('[data-doc-toggle]').forEach((el) => {
            el.addEventListener('change', (e) => {
                this.toggleDoc(e.target.dataset.docToggle, !e.target.checked);
            });
        });
        list.querySelectorAll('[data-doc-remove]').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (confirm('确认删除该文档吗？')) {
                    this.removeDoc(e.target.dataset.docRemove);
                }
            });
        });
    }

    _renderCloudList() {
        if (!this._modal) return;
        const list = this._modal.querySelector('#uk-cloud-list');
        if (!list) return;
        const cloudList = this.config.cloudExtras || [];
        if (cloudList.length === 0) {
            list.innerHTML = '<div class="uk-empty">还没有云端外挂。</div>';
            return;
        }
        list.innerHTML = cloudList.map((c, i) => `
            <div class="uk-cloud-item" data-cloud-index="${i}">
                <div class="uk-cloud-row">
                    <input type="text" data-cloud-field="label" placeholder="备注名称" value="${escapeHtml(c.label || '')}" />
                    <select data-cloud-field="domain">
                        ${SUPPORTED_DOMAINS.map((d) => `<option value="${d.value}" ${c.domain === d.value ? 'selected' : ''}>${d.label}</option>`).join('')}
                    </select>
                </div>
                <div class="uk-cloud-row">
                    <input type="password" data-cloud-field="apiKey" placeholder="火山 apiKey" value="${escapeHtml(c.apiKey || '')}" />
                    <input type="text" data-cloud-field="serviceResourceId" placeholder="serviceResourceId" value="${escapeHtml(c.serviceResourceId || '')}" />
                </div>
                <div class="uk-cloud-row">
                    <label class="uk-toggle uk-toggle-inline"><input type="checkbox" data-cloud-field="enabled" ${c.disabled ? '' : 'checked'}> 启用</label>
                    <button class="btn btn-mini" data-cloud-remove="${i}">删除</button>
                </div>
            </div>
        `).join('');

        list.querySelectorAll('[data-cloud-field]').forEach((el) => {
            el.addEventListener('change', (e) => {
                const wrap = e.target.closest('[data-cloud-index]');
                const idx = Number(wrap.dataset.cloudIndex);
                const field = e.target.dataset.cloudField;
                const cloud = this.config.cloudExtras[idx];
                if (!cloud) return;
                if (field === 'enabled') cloud.disabled = !e.target.checked;
                else cloud[field] = e.target.value;
                this.saveConfig();
            });
        });
        list.querySelectorAll('[data-cloud-remove]').forEach((el) => {
            el.addEventListener('click', (e) => {
                const idx = Number(e.target.dataset.cloudRemove);
                this.config.cloudExtras.splice(idx, 1);
                this.saveConfig();
                this._renderCloudList();
            });
        });
    }

    _addCloudEntry() {
        this.config.cloudExtras = this.config.cloudExtras || [];
        this.config.cloudExtras.push({
            label: '我的云端库',
            domain: 'other',
            apiKey: '',
            serviceResourceId: '',
            disabled: false,
        });
        this.saveConfig();
        this._renderCloudList();
    }

    openModal() {
        if (!this._modal) return;
        this._modal.classList.remove('is-hidden');
        this._modal.querySelector('[data-builtin="lol"]').checked = !!this.config.builtinLolEnabled;
        this._modal.querySelector('[data-builtin="wzry"]').checked = !!this.config.builtinWzryEnabled;
        this._modal.querySelector('[data-builtin="house"]').checked = !!this.config.houseVolcEnabled;
        this._renderDocList();
        this._renderCloudList();
    }
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export { UserKnowledgeModule, localBm25LikeRank };
