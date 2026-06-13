// 用户身份切换模块
// 在「我的知识库」按钮旁注入「切换用户」按钮，弹窗列出 data/users/*.json 的所有身份。
// 选中后写入 localStorage('game_ai_rtc_user_id') 并刷新页面，让 RTC / Agent 重新读取 userId 与对应长期记忆。

const STORAGE_KEY = 'game_ai_rtc_user_id';

const FALLBACK_USERS = [
    { user_id: 'default', display_name: '游客', primary_game: '', rank_tier: '' },
    { user_id: 'jason', display_name: 'Jason', primary_game: '英雄联盟', rank_tier: '黄金' },
    { user_id: 'jackson', display_name: 'Jackson', primary_game: '', rank_tier: '' },
    { user_id: 'jay', display_name: 'Jay', primary_game: '', rank_tier: '' },
];

function getApiBaseUrl() {
    const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
    const rtcRuntime = runtime.rtc || {};
    const candidate = String(runtime.apiBaseUrl || rtcRuntime.apiBaseUrl || '').replace(/\/$/, '');
    // /api/data/users/* 路由只在后端 8788 上提供。如果 runtime apiBaseUrl 与当前页面同源
    // （比如本地用 npx serve 8080 + 后端 8788 两个进程），需要硬切到 127.0.0.1:8788。
    if (candidate && typeof window !== 'undefined' && window.location && window.location.origin) {
        try {
            const candidateOrigin = new URL(candidate, window.location.href).origin;
            if (candidateOrigin === window.location.origin) {
                return 'http://127.0.0.1:8788';
            }
        } catch (_) { /* ignore */ }
    }
    return candidate || 'http://127.0.0.1:8788';
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatRemain(ms = 0) {
    const value = Math.max(0, Number(ms) || 0);
    if (value < 60_000) return `${Math.ceil(value / 1000)}秒`;
    if (value < 3_600_000) return `${Math.ceil(value / 60_000)}分`;
    const h = Math.floor(value / 3_600_000);
    const m = Math.round((value % 3_600_000) / 60_000);
    return m > 0 ? `${h}小时${m}分` : `${h}小时`;
}

class UserSwitcherModule {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this._inited = false;
        this._modal = null;
        this._users = [];
        this._currentUserId = '';
    }

    async init() {
        if (this._inited) return;
        this._inited = true;

        try {
            this._currentUserId = window.localStorage.getItem(STORAGE_KEY) || '';
        } catch (e) {
            this._currentUserId = '';
        }

        this._injectButton();
        this._buildModalDom();
    }

    _injectButton() {
        const anchor = document.getElementById('btn-user-knowledge') || document.getElementById('btn-readme');
        if (!anchor) return;
        if (document.getElementById('btn-user-switcher')) return;

        const btn = document.createElement('button');
        btn.id = 'btn-user-switcher';
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-readme';
        btn.style.marginLeft = '8px';
        btn.textContent = this._formatButtonText();
        anchor.parentNode.insertBefore(btn, anchor.nextSibling);

        btn.addEventListener('click', () => this.openModal());
        this._buttonEl = btn;
    }

    _formatButtonText() {
        const id = this._currentUserId || 'default';
        return `用户：${id}`;
    }

    _refreshButtonText() {
        if (this._buttonEl) {
            this._buttonEl.textContent = this._formatButtonText();
        }
    }

    _buildModalDom() {
        if (document.getElementById('user-switcher-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'user-switcher-modal';
        modal.className = 'uk-modal is-hidden';
        modal.innerHTML = `
            <div class="uk-dialog user-switcher-dialog" style="max-width: 1180px; width: 96vw;">
                <div class="uk-header">
                    <h2>👤 选择用户身份 · 反思日志</h2>
                    <button class="btn" data-action="close">关闭</button>
                </div>
                <div class="uk-body" style="display: flex; gap: 16px; align-items: stretch;">
                    <div class="user-switcher-left" style="flex: 0 0 460px; min-width: 360px; display: flex; flex-direction: column;">
                        <p class="uk-tip">不同用户身份对应独立基线（<code>data/users/{id}.baseline.json</code> + <code>data/memory/{id}.baseline.longterm.json</code>），任何修改只写入 <code>*.overlay.*</code>，<strong>3 小时</strong>未更新自动回退基线，方便公开演示。</p>
                        <div id="user-switcher-status" class="uk-tip" style="display: none;"></div>
                        <div id="user-switcher-list" class="uk-doc-list"></div>
                        <section class="uk-section">
                            <h3>新建用户</h3>
                            <p class="uk-tip">仅支持 a-z / 0-9 / 下划线，长度 2~24。新建后会同步生成空白长期记忆文件。</p>
                            <div class="uk-upload-row">
                                <input type="text" id="user-switcher-new-id" placeholder="user_id（如 alice）" maxlength="24" />
                                <input type="text" id="user-switcher-new-name" placeholder="显示名（可选）" maxlength="24" />
                                <button class="btn btn-primary" data-action="create">新建并切换</button>
                            </div>
                        </section>
                    </div>
                    <div class="user-switcher-right" style="flex: 1 1 auto; min-width: 360px; display: flex; flex-direction: column; border-left: 1px solid rgba(0,0,0,0.08); padding-left: 16px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                            <h3 style="margin: 0;">🪞 反思日志</h3>
                            <span id="reflection-summary" class="uk-tip" style="font-size: 12px; color: #666;"></span>
                        </div>
                        <div class="reflection-toolbar" style="display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">
                            <input type="text" id="reflection-search" placeholder="关键词（用户问题 / 主结论 / 升级内容）" style="flex: 1 1 200px; min-width: 180px;" />
                            <select id="reflection-intent-filter" style="flex: 0 0 130px;">
                                <option value="">全部 intent</option>
                                <option value="strategy">strategy</option>
                                <option value="video">video</option>
                                <option value="smalltalk">smalltalk</option>
                                <option value="compound">compound</option>
                            </select>
                            <button class="btn" data-action="reflection-refresh">刷新</button>
                        </div>
                        <div id="reflection-target-tip" class="uk-tip" style="font-size: 12px; color: #888; margin-bottom: 6px;"></div>
                        <div id="reflection-list" class="reflection-list" style="flex: 1 1 auto; overflow-y: auto; max-height: 540px; min-height: 320px; border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 8px; background: #fafafa;"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this._modal = modal;

        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.dataset?.action === 'close') {
                modal.classList.add('is-hidden');
                return;
            }
            if (e.target.dataset?.action === 'create') {
                this._handleCreateUser();
                return;
            }
            if (e.target.dataset?.action === 'reflection-refresh') {
                this._loadReflections();
                return;
            }
            const expandTrigger = e.target.closest?.('[data-reflection-expand]');
            if (expandTrigger) {
                e.preventDefault();
                e.stopPropagation();
                const card = expandTrigger.closest('[data-reflection-card]');
                if (card) {
                    card.classList.toggle('is-expanded');
                    const pre = card.querySelector('.reflection-raw');
                    if (pre) pre.style.display = card.classList.contains('is-expanded') ? 'block' : 'none';
                }
            }
        });

        // 反思日志：搜索框（输入防抖）+ intent 过滤
        const searchInput = modal.querySelector('#reflection-search');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                window.clearTimeout(this._reflectionDebounce);
                this._reflectionDebounce = window.setTimeout(() => this._loadReflections(), 280);
            });
        }
        const intentSelect = modal.querySelector('#reflection-intent-filter');
        if (intentSelect) {
            intentSelect.addEventListener('change', () => this._loadReflections());
        }
    }

    async openModal() {
        if (!this._modal) return;
        this._modal.classList.remove('is-hidden');
        this._setStatus('正在加载用户列表...');
        try {
            this._users = await this._fetchUsers();
        } catch (e) {
            console.warn('[UserSwitcher] 拉取用户失败，使用本地兜底列表', e);
            this._users = FALLBACK_USERS.slice();
        }
        this._setStatus('');
        this._renderList();
        // 默认按当前身份加载反思日志
        this._activeReflectionUserId = this._currentUserId || 'default';
        this._loadReflections();
    }

    async _fetchUsers() {
        try {
            const resp = await fetch(`${getApiBaseUrl()}/api/data/users/list`, { cache: 'no-store' });
            const json = await resp.json();
            const list = Array.isArray(json?.data?.list) ? json.data.list : [];
            if (list.length === 0) {
                return FALLBACK_USERS.slice();
            }
            const merged = [...list];
            const existing = new Set(list.map((u) => u.user_id));
            for (const fb of FALLBACK_USERS) {
                if (!existing.has(fb.user_id)) merged.push(fb);
            }
            return merged;
        } catch (e) {
            return FALLBACK_USERS.slice();
        }
    }

    _renderList() {
        if (!this._modal) return;
        const list = this._modal.querySelector('#user-switcher-list');
        if (!list) return;
        if (!this._users.length) {
            list.innerHTML = '<div class="uk-empty">暂无用户档案。</div>';
            return;
        }
        const current = this._currentUserId || '';
        const activeReflectionId = this._activeReflectionUserId || current || 'default';
        list.innerHTML = this._users.map((u) => {
            const isActive = u.user_id === current;
            const isReflectionTarget = u.user_id === activeReflectionId;
            const game = u.primary_game ? `<span class="uk-chip">${escapeHtml(u.primary_game)}</span>` : '';
            const tier = u.rank_tier ? `<span class="uk-chip">${escapeHtml(u.rank_tier)}</span>` : '';
            const ltm = u.has_long_term_memory ? '<span class="uk-chip uk-chip-ok">长期记忆 ✓</span>' : '<span class="uk-chip uk-chip-warn">无长期记忆</span>';
            const overlay = u.overlay || {};
            const overlayActive = !!(overlay.user_profile_active || overlay.long_term_memory_active);
            const overlayChip = overlayActive
                ? `<span class="uk-chip uk-chip-warn">覆盖中 · 剩 ${formatRemain(overlay.expires_in_ms)}</span>`
                : '<span class="uk-chip">基线</span>';
            const isPendingReset = this._pendingResetUserId === u.user_id;
            const resetBtn = overlayActive
                ? `<button type="button" class="btn ${isPendingReset ? 'btn-primary' : ''}" data-reset-user="${escapeHtml(u.user_id)}">${isPendingReset ? '再点一次确认' : '立即回退'}</button>`
                : '';
            const reflectionBtn = `<button type="button" class="btn ${isReflectionTarget ? 'btn-primary' : ''}" data-view-reflection="${escapeHtml(u.user_id)}" title="查看 ${escapeHtml(u.user_id)} 的反思日志">${isReflectionTarget ? '反思中 ✓' : '看反思'}</button>`;
            return `
                <div class="uk-doc-item${isActive ? ' is-active' : ''}${isReflectionTarget ? ' is-reflection-target' : ''}" data-user-id="${escapeHtml(u.user_id)}">
                    <div class="uk-doc-meta">
                        <strong>${escapeHtml(u.display_name || u.user_id)}</strong>
                        <span class="uk-chip">${escapeHtml(u.user_id)}</span>
                        ${game}
                        ${tier}
                        ${ltm}
                        ${overlayChip}
                    </div>
                    <div class="uk-doc-actions">
                        ${reflectionBtn}
                        ${resetBtn}
                        <button type="button" class="btn ${isActive ? '' : 'btn-primary'}" data-switch-user="${escapeHtml(u.user_id)}" ${isActive ? 'disabled' : ''}>${isActive ? '当前身份' : '切换'}</button>
                    </div>
                </div>
            `;
        }).join('');

        list.querySelectorAll('[data-switch-user]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = e.currentTarget.dataset.switchUser;
                if (!id) return;
                this._applyUserAndReload(id);
            });
        });
        list.querySelectorAll('[data-reset-user]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = e.currentTarget.dataset.resetUser;
                if (!id) return;
                this._handleResetOverlay(id);
            });
        });
        list.querySelectorAll('[data-view-reflection]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = e.currentTarget.dataset.viewReflection;
                if (!id) return;
                this._activeReflectionUserId = id;
                this._renderList();
                this._loadReflections();
            });
        });
    }

    _applyUserAndReload(userId) {
        if (!userId) return;
        try {
            window.localStorage.setItem(STORAGE_KEY, userId);
        } catch (e) {
            console.warn('[UserSwitcher] 写入 localStorage 失败', e);
        }
        this._currentUserId = userId;
        this._refreshButtonText();
        this._setStatus(`已切换到 ${userId}，正在刷新页面...`);
        window.setTimeout(() => {
            window.location.reload();
        }, 280);
    }

    async _handleResetOverlay(userId) {
        if (!userId) return;
        // 不用原生 window.confirm（部分 webview 会拦截 / 阻塞主线程，导致页面看上去"消失"），
        // 改用列表里行内确认按钮：第一次点击进入"再点一次确认"状态，3 秒后自动取消。
        if (this._pendingResetUserId !== userId) {
            this._pendingResetUserId = userId;
            this._setStatus(`再次点击「立即回退」即可丢弃 ${userId} 在 3 小时窗口内的全部修改（3 秒内有效）`, false);
            this._renderList();
            window.clearTimeout(this._pendingResetTimer);
            this._pendingResetTimer = window.setTimeout(() => {
                if (this._pendingResetUserId === userId) {
                    this._pendingResetUserId = '';
                    this._setStatus('');
                    this._renderList();
                }
            }, 3000);
            return;
        }
        // 已在确认状态，真正发起回退
        this._pendingResetUserId = '';
        window.clearTimeout(this._pendingResetTimer);
        this._setStatus(`正在回退 ${userId} ...`);
        try {
            const resp = await fetch(`${getApiBaseUrl()}/api/data/users/reset-overlay`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            const json = await resp.json();
            if (!resp.ok || !json?.ok) {
                throw new Error(json?.message || `回退失败 HTTP ${resp.status}`);
            }
            this._setStatus(`已回退 ${userId} 到基线`);
            this._users = await this._fetchUsers();
            this._renderList();
        } catch (e) {
            this._setStatus(e?.message || '回退失败', true);
        }
    }

    async _handleCreateUser() {
        if (!this._modal) return;
        const idInput = this._modal.querySelector('#user-switcher-new-id');
        const nameInput = this._modal.querySelector('#user-switcher-new-name');
        const rawId = String(idInput?.value || '').trim().toLowerCase();
        const displayName = String(nameInput?.value || '').trim();
        if (!/^[a-z0-9_]{2,24}$/.test(rawId)) {
            this._setStatus('user_id 仅支持 a-z / 0-9 / 下划线，长度 2~24', true);
            return;
        }
        if (rawId === 'default') {
            this._setStatus('default 是保留用户，无法创建', true);
            return;
        }
        this._setStatus('正在创建用户...');
        try {
            const resp = await fetch(`${getApiBaseUrl()}/api/data/users/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: rawId, displayName }),
            });
            const json = await resp.json();
            if (!resp.ok || !json?.ok) {
                throw new Error(json?.message || `创建失败 HTTP ${resp.status}`);
            }
            this._setStatus(`已创建 ${rawId}，正在切换...`);
            this._applyUserAndReload(rawId);
        } catch (e) {
            this._setStatus(e?.message || '创建用户失败', true);
        }
    }

    _setStatus(text, isError = false) {
        if (!this._modal) return;
        const status = this._modal.querySelector('#user-switcher-status');
        if (!status) return;
        status.textContent = text || '';
        status.style.color = isError ? '#d4183d' : '';
        status.style.display = text ? 'block' : 'none';
    }

    async _loadReflections() {
        if (!this._modal) return;
        const targetUserId = this._activeReflectionUserId || this._currentUserId || 'default';
        const listEl = this._modal.querySelector('#reflection-list');
        const tipEl = this._modal.querySelector('#reflection-target-tip');
        const summaryEl = this._modal.querySelector('#reflection-summary');
        const searchInput = this._modal.querySelector('#reflection-search');
        const intentSelect = this._modal.querySelector('#reflection-intent-filter');
        if (!listEl) return;
        if (tipEl) tipEl.textContent = `查看用户：${targetUserId === 'all' ? '全部用户' : targetUserId}（按 sessionId=userId 关联）`;
        listEl.innerHTML = '<div class="uk-tip" style="padding: 12px; text-align: center; color: #888;">加载中...</div>';

        const keyword = searchInput?.value?.trim() || '';
        const intent = intentSelect?.value || '';
        const params = new URLSearchParams({
            limit: '50',
        });
        // 允许通过下拉框选择或保留默认(全部)
        if (targetUserId && targetUserId !== 'all') {
             params.set('sessionId', targetUserId);
        }
        if (keyword) params.set('keyword', keyword);
        if (intent) params.set('intent', intent);

        try {
            const resp = await fetch(`${getApiBaseUrl()}/api/agent/reflections/list?${params.toString()}`, { cache: 'no-store' });
            const json = await resp.json();
            if (!resp.ok || !json?.ok) throw new Error(json?.message || `HTTP ${resp.status}`);
            const data = json.data || {};
            this._renderReflections(data);
            if (summaryEl) {
                const s = data.summary || {};
                const q = s.quality || null;
                summaryEl.textContent = `共 ${data.total || 0} 条 · 全局均分 ${q ? q.avg : '-'} · 降级率 ${(s.degraded_rate || 0) * 100}%`;
            }
        } catch (err) {
            listEl.innerHTML = `<div class="uk-tip" style="padding: 12px; color: #d4183d;">加载失败：${escapeHtml(err?.message || '未知错误')}</div>`;
            if (summaryEl) summaryEl.textContent = '';
        }
    }

    _renderReflections(data) {
        if (!this._modal) return;
        const listEl = this._modal.querySelector('#reflection-list');
        if (!listEl) return;
        const rows = Array.isArray(data?.list) ? data.list : [];
        if (!rows.length) {
            listEl.innerHTML = '<div class="uk-empty" style="padding: 24px; text-align: center; color: #888;">该用户暂无反思日志，先去对话几轮再来看。</div>';
            return;
        }
        listEl.innerHTML = rows.map((r) => this._renderOneReflection(r)).join('');
    }

    _renderOneReflection(r) {
        const ts = r.logged_at ? new Date(r.logged_at).toLocaleString() : '-';
        const reflection = r.reflection || {};
        const thisTurn = reflection.this_turn || {};
        const proactive = reflection.proactive || {};
        const promo = reflection.memory_promotion || {};
        const goal = reflection.session_goal_inference || {};
        const nextHint = reflection.next_turn_hint || {};
        const q = Number.isFinite(thisTurn.quality_score) ? thisTurn.quality_score : null;
        const qColor = q == null ? '#999' : (q >= 0.8 ? '#22a06b' : (q >= 0.5 ? '#cf8b00' : '#d4183d'));
        const intentBadge = `<span class="uk-chip">${escapeHtml(r.intent || 'unknown')}</span>`;
        const degradedBadge = r.degraded ? '<span class="uk-chip uk-chip-warn">degraded</span>' : '';
        const promoBadge = promo.should_promote
            ? `<span class="uk-chip uk-chip-ok">升级 → ${escapeHtml(promo.target_layer || 'none')}</span>`
            : '';
        const proactiveBadge = proactive.should_initiate
            ? `<span class="uk-chip uk-chip-ok">主动话术 ✓</span>`
            : '';
        const gaps = Array.isArray(thisTurn.gaps) ? thisTurn.gaps.filter(Boolean) : [];
        const improvements = Array.isArray(thisTurn.improvements) ? thisTurn.improvements.filter(Boolean) : [];
        const predictedIntents = Array.isArray(nextHint.predicted_intents) ? nextHint.predicted_intents.filter(Boolean) : [];

        const expandableRaw = escapeHtml(JSON.stringify(reflection, null, 2));

        return `
            <div class="reflection-card" data-reflection-card style="border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: #fff;">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;">
                    <span style="font-size: 12px; color: #888;">${escapeHtml(ts)}</span>
                    ${intentBadge}
                    ${q != null ? `<span class="uk-chip" style="color: ${qColor}; border-color: ${qColor};">质量 ${q.toFixed(2)}</span>` : ''}
                    ${promoBadge}
                    ${proactiveBadge}
                    ${degradedBadge}
                    <span style="font-size: 12px; color: #aaa; margin-left: auto;">${escapeHtml(r.turn_id || '')}</span>
                </div>
                <div style="font-size: 13px; line-height: 1.5; color: #333; margin-bottom: 4px;">
                    <strong>用户：</strong>${escapeHtml((r.user_query || '').slice(0, 200))}
                </div>
                <div style="font-size: 13px; line-height: 1.5; color: #555; margin-bottom: 4px;">
                    <strong>主结论：</strong>${escapeHtml((r.main_summary || '').slice(0, 200))}
                </div>
                ${promo.should_promote && promo.content ? `
                    <div style="font-size: 12px; color: #22a06b; margin-bottom: 4px;">
                        <strong>记忆升级（${escapeHtml(promo.target_layer || '')}, conf=${(promo.confidence || 0).toFixed(2)}）：</strong>${escapeHtml(promo.content)}
                    </div>` : ''}
                ${proactive.should_initiate && proactive.bridge_question ? `
                    <div style="font-size: 12px; color: #1f6feb; margin-bottom: 4px;">
                        <strong>主动话术（${(proactive.confidence || 0).toFixed(2)}, ${proactive.trigger_after_idle_ms || 0}ms 后）：</strong>${escapeHtml(proactive.bridge_question)}
                    </div>` : ''}
                ${gaps.length ? `<div style="font-size: 12px; color: #666;"><strong>不足：</strong>${gaps.map(escapeHtml).join(' / ')}</div>` : ''}
                ${improvements.length ? `<div style="font-size: 12px; color: #666;"><strong>改进：</strong>${improvements.map(escapeHtml).join(' / ')}</div>` : ''}
                ${goal.primary_goal ? `<div style="font-size: 12px; color: #666;"><strong>会话目标：</strong>${escapeHtml(goal.primary_goal)}</div>` : ''}
                ${predictedIntents.length ? `<div style="font-size: 12px; color: #666;"><strong>下一轮预测：</strong>${predictedIntents.map(escapeHtml).join(' / ')}${nextHint.predicted_query ? `（${escapeHtml(nextHint.predicted_query)}）` : ''}</div>` : ''}
                <div style="margin-top: 6px;">
                    <a href="javascript:void(0)" data-reflection-expand style="font-size: 12px; color: #1f6feb; text-decoration: none;">展开 / 收起完整 JSON</a>
                </div>
                <pre class="reflection-raw" style="display: none; margin-top: 6px; padding: 8px; background: #f5f5f5; border-radius: 4px; font-size: 11px; line-height: 1.4; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-all;">${expandableRaw}</pre>
            </div>
        `;
    }
}

export { UserSwitcherModule };
