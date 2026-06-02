/**
 * 数据配置模块（角色配置、知识库、记忆库、会话记录）
 */
import { globalEventBus } from '../../core/eventBus.js';

const DEMO_MOCK_KNOWLEDGE_ITEMS = [
    {
        id: 'kb_lol_001',
        title: '【英雄联盟】亚索逆风对线要点',
        content: '逆风局先稳补刀和经验，风墙优先挡关键控制与远程消耗，等打野联动或敌方失误后再找 E 穿兵接 Q 的反打窗口。',
        keywords: ['英雄联盟', 'lol', 'league of legends', '亚索', '逆风', '对线', '基础教学'],
        score: 0.99,
        docName: 'lol-yasuo-laning.md',
        ttsText: '亚索逆风先稳线，再找机会反打。',
        videoQuery: '英雄联盟 亚索 基础教学',
        videoTitle: '《亚索最全面的基础教学》',
        videoSummary: '文档重点：亚索逆风先稳兵线，风墙要留给关键技能，等打野到位后再用 E 穿兵接 Q 找反打窗口。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7455994520128343336',
        imagePrompt: '英雄联盟亚索，逆风对线教学，召唤师峡谷，技能轨迹清晰，电竞教学海报，二次元写实插画'
    },
    {
        id: 'kb_hok_001',
        title: '【王者荣耀】突进爆发型打野攻略',
        content: '核心定位：突进爆发型打野，适合前中期带节奏，后期负责切后排和残局收割。铭文推荐常规流 10 无双 + 10 鹰眼 + 10 夺萃，爆发流 10 无双 + 10 鹰眼 + 10 狩猎。出装顺序建议追击刀锋、抵抗之靴、无尽战刃、宗师之力、碎星锤、名刀或贤者的庇护。常规 gank 连招可用 2 技能起手接普攻，再接 1 技能与大招衔接控制。实战中先用野怪叠满被动，再绕后切 C 位，避免正面硬冲。',
        keywords: ['王者荣耀', '打野', '突进', '爆发', '连招', '铭文', '出装'],
        score: 0.98,
        docName: 'hok-jungle-burst-guide.md',
        ttsText: '王者打野先叠被动，再绕后切 C。',
        videoQuery: '王者荣耀 打野 绕后切C 教学',
        videoTitle: '《王者打野绕后切 C 实战细节》',
        videoSummary: '文档重点：先刷野叠满被动再进场，优先绕后切 C 位，避免从正面硬冲被集火。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7462270287917141275',
        imagePrompt: '王者荣耀打野英雄，突进爆发流，野区切入团战，技能连招信息图，国风电竞海报，高清插画'
    },
    {
        id: 'kb_lol_002',
        title: '【英雄联盟】中单强袭收割节奏',
        content: '中单刺客或战士在逆风局不要急着先手，先清中路线权，再利用河道视野和侧翼绕后切入。团战里优先锁定无位移 C 位，利用闪现或位移技能强开后排。',
        keywords: ['英雄联盟', '中单', '强袭', '收割', '团战', '切后排'],
        score: 0.95,
        docName: 'lol-mid-assassin-teamfight.md',
        videoQuery: '英雄联盟 逆风局 强袭 实战表现',
        videoTitle: '《中单刺客侧翼切后排节奏课》',
        videoSummary: '文档重点：先清中路线权，再借河道视野绕侧翼切入，团战锁定无位移后排完成收割。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7423982256009645339',
        imagePrompt: '英雄联盟中单强袭收割，团战切后排，峡谷夜战，高对比电竞插画'
    },
    {
        id: 'kb_lol_003',
        title: '【英雄联盟】盲僧前期控图抓边指南',
        content: '盲僧前期要靠河道视野和野区入侵抢节奏，3 级后优先照顾有先手能力的边线，回旋踢不要急着交，先逼位再找角度。',
        keywords: ['英雄联盟', '盲僧', '打野', '控图', '抓边', '前期节奏'],
        score: 0.96,
        docName: 'lol-lee-jungle-pathing.md',
        ttsText: '盲僧前期先控河道，再抓有线权的路。',
        videoQuery: '英雄联盟 盲僧 前期 节奏 教学',
        videoTitle: '《盲僧 3 级抓边与控图思路》',
        videoSummary: '文档重点：前期通过河道视野和入侵建立优势，优先抓有线权的边路，回旋踢留给关键团战。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7440047238518263049',
        imagePrompt: '英雄联盟盲僧打野教学，野区入侵与回旋踢，电竞战术海报'
    },
    {
        id: 'kb_lol_004',
        title: '【英雄联盟】阿狸游走支援节奏',
        content: '阿狸拿到推线权后要尽快联动河道资源，魅惑不要盲交，优先在草丛或视野盲区先手，形成中野联动。',
        keywords: ['英雄联盟', '阿狸', '中单', '游走', '魅惑', '支援'],
        score: 0.94,
        docName: 'lol-ahri-roam-guide.md',
        ttsText: '阿狸先推线，再找河道和边路节奏。',
        videoQuery: '英雄联盟 阿狸 游走 支援 教学',
        videoTitle: '《阿狸推线游走节奏教学》',
        videoSummary: '文档重点：先抢中路线权，再利用草丛盲区魅惑先手，快速把优势带到边路。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7453701544425409819',
        imagePrompt: '英雄联盟阿狸中单游走，魅惑先手，九尾法术效果，电竞插画'
    },
    {
        id: 'kb_lol_005',
        title: '【英雄联盟】金克丝后期团战站位',
        content: '金克丝团战最重要的是站位和切枪时机，先用火箭炮安全输出，等前排交完关键控制后再切机枪追击收割。',
        keywords: ['英雄联盟', '金克丝', 'ADC', '团战', '站位', '收割'],
        score: 0.93,
        docName: 'lol-jinx-teamfight-guide.md',
        ttsText: '金克丝先安全输出，再找收割窗口。',
        videoQuery: '英雄联盟 金克丝 团战 站位 教学',
        videoTitle: '《金克丝团战站位与切枪细节》',
        videoSummary: '文档重点：火箭炮保证安全距离，等敌方关键技能交完后再切机枪追击扩大收益。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7426455797418233125',
        imagePrompt: '英雄联盟金克丝团战站位，火箭炮与机枪切换，后排输出教学海报'
    },
    {
        id: 'kb_hok_002',
        title: '【王者荣耀】镜连招爆发与进场时机',
        content: '镜要先利用 1 技能和被动拉扯视野，确认敌方控制交过后再开大打满镜像伤害，切忌第一时间正面进场。',
        keywords: ['王者荣耀', '镜', '打野', '连招', '进场', '爆发'],
        score: 0.97,
        docName: 'hok-jing-combo-guide.md',
        ttsText: '镜先拉扯骗技能，再进场打满爆发。',
        videoQuery: '王者荣耀 镜 连招 进场 教学',
        videoTitle: '《镜的镜像爆发连招教学》',
        videoSummary: '文档重点：先拉扯骗控制，再开大打满镜像伤害，避免第一时间正面冲阵。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7469243954509139226',
        imagePrompt: '王者荣耀镜，镜像分身爆发连招，野区切入，国风电竞海报'
    },
    {
        id: 'kb_hok_003',
        title: '【王者荣耀】李白刷野控龙节奏',
        content: '李白前期要稳定控双野区和中立资源，利用 1 技能位移找角度，团战前先借野怪刷出大招层数再切后排。',
        keywords: ['王者荣耀', '李白', '打野', '控龙', '刷野', '后排'],
        score: 0.95,
        docName: 'hok-libai-jungle-guide.md',
        ttsText: '李白先控资源，再借位移切后排。',
        videoQuery: '王者荣耀 李白 打野 控龙 教学',
        videoTitle: '《李白刷野控龙与团战切入》',
        videoSummary: '文档重点：先稳控野区和龙坑资源，再借野怪刷层数，通过位移切后排收割。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7483370993159834939',
        imagePrompt: '王者荣耀李白打野，龙坑资源争夺，剑气残影，国风插画'
    },
    {
        id: 'kb_hok_004',
        title: '【王者荣耀】貂蝉拉扯团战细节',
        content: '貂蝉进团前要先找好二技能位移落点，保证自己能在大招范围内持续拉扯，优先消耗近前排再转火后排。',
        keywords: ['王者荣耀', '貂蝉', '法师', '团战', '拉扯', '二技能'],
        score: 0.94,
        docName: 'hok-diaochan-teamfight-guide.md',
        ttsText: '貂蝉先找位移落点，再开大拉扯。',
        videoQuery: '王者荣耀 貂蝉 团战 拉扯 教学',
        videoTitle: '《貂蝉团战拉扯与开大时机》',
        videoSummary: '文档重点：提前规划二技能落点，在大招范围内持续拉扯输出，避免被一套秒掉。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7500116277589036348',
        imagePrompt: '王者荣耀貂蝉团战拉扯，法阵与花瓣特效，国风电竞教学海报'
    },
    {
        id: 'kb_hok_005',
        title: '【王者荣耀】凯边路单带与开团选择',
        content: '凯边路要先稳住兵线和经济差，单带时观察敌方露头信息，团战优先后手进场，不要把大招浪费在无效开团上。',
        keywords: ['王者荣耀', '凯', '边路', '单带', '开团', '后手'],
        score: 0.93,
        docName: 'hok-kai-side-lane-guide.md',
        ttsText: '凯先单带拉边，再后手开团更稳。',
        videoQuery: '王者荣耀 凯 边路 单带 教学',
        videoTitle: '《凯边路单带与后手开团思路》',
        videoSummary: '文档重点：利用单带逼对面回防，团战后手开大切后排，避免先手吃满控制。',
        videoLinkUrl: 'https://jingxuan.douyin.com/m/video/7501923042017168677',
        imagePrompt: '王者荣耀凯边路单带，蓝色铠甲与大剑，团战后手切入，国风海报'
    }
];

export function searchDemoKnowledgeExamples(query = '', limit = 5) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const keywords = normalizedQuery.split(/\s+/).filter(Boolean);

    const matchedItems = DEMO_MOCK_KNOWLEDGE_ITEMS
        .map(item => {
            const haystack = `${item.title} ${item.content} ${item.keywords.join(' ')}`.toLowerCase();
            const hitCount = keywords.filter(keyword => haystack.includes(keyword)).length;
            const matchScore = normalizedQuery && haystack.includes(normalizedQuery) ? Math.max(hitCount, 1) : hitCount;

            return {
                ...item,
                _matchScore: matchScore
            };
        })
        .filter(item => item._matchScore > 0);

    return (matchedItems.length > 0 ? matchedItems : DEMO_MOCK_KNOWLEDGE_ITEMS)
        .sort((left, right) => right._matchScore - left._matchScore || right.score - left.score)
        .slice(0, Math.max(1, Number(limit || 5)))
        .map(({ _matchScore, ...item }) => ({ ...item }));
}

export function getRandomVideoDemoExample() {
    const candidates = DEMO_MOCK_KNOWLEDGE_ITEMS.filter(item => item.videoLinkUrl);
    const pool = candidates.length > 0 ? candidates : DEMO_MOCK_KNOWLEDGE_ITEMS;
    const picked = pool[Math.floor(Math.random() * pool.length)] || {};
    return { ...picked };
}

export class DataModule {
    constructor(eventBus) {
        this.eventBus = eventBus || globalEventBus;
        this.isInitialized = false;
        this.runtime = this.getRuntimeConfig();

        this.mockAgents = [
            {
                id: 'agent_ys_001',
                name: '派蒙',
                game: '原神',
                avatar: 'https://upload-bbs.mihoyo.com/upload/2021/08/30/74921946/928c037e9d73d2a7c4918e7e3907eb19_5201170321285252033.jpg',
                role: '提瓦特最佳向导',
                greeting: '旅行者，前面的区域以后再来探索吧！'
            },
            {
                id: 'agent_sr_001',
                name: '三月七',
                game: '星穹铁道',
                avatar: 'https://act-webstatic.mihoyo.com/upload/2023/04/24/09c3132e67f0f63e9f454d4f711283d5_3985790895393273397.png',
                role: '星穹列车护卫',
                greeting: '开拓者，要一起拍张照吗？'
            }
        ];

        this.mockKnowledgeItems = DEMO_MOCK_KNOWLEDGE_ITEMS.map(item => ({ ...item }));

        this.mockMemoryProfiles = [
            {
                userId: 'demo_user_001',
                agentId: 'agent_ys_001',
                nickname: '旅行者',
                persona: '偏好探索和剧情向玩法的新手玩家',
                preferences: ['原神', '开荒攻略', '角色培养', '跑图探索'],
                recentTopics: ['蒙德探索', '风神瞳收集', '前期阵容'],
                updatedAt: '2026-04-30T12:00:00.000Z'
            },
            {
                userId: 'demo_user_002',
                agentId: 'agent_sr_001',
                nickname: '开拓者',
                persona: '喜欢回合制和角色养成的轻度玩家',
                preferences: ['星穹铁道', '阵容搭配', '日常养成'],
                recentTopics: ['三月七培养', '前期开荒', '抽卡规划'],
                updatedAt: '2026-04-30T12:10:00.000Z'
            }
        ];

        this.mockMemoryRecords = [
            {
                id: 'mem_demo_001',
                userId: 'demo_user_001',
                agentId: 'agent_ys_001',
                type: 'preference',
                category: 'game_preference',
                summary: '用户偏好原神相关的新手开荒和角色培养内容。',
                content: '旅行者最近持续咨询原神开荒、角色培养和蒙德探索路线，适合优先推荐新手攻略。',
                tags: ['原神', '开荒', '角色培养'],
                importance: 'high',
                score: 0.96,
                source: 'mock',
                createdAt: '2026-04-29T10:20:00.000Z',
                lastUsedAt: '2026-04-30T09:30:00.000Z'
            },
            {
                id: 'mem_demo_002',
                userId: 'demo_user_001',
                agentId: 'agent_ys_001',
                type: 'session_fact',
                category: 'habit',
                summary: '用户更喜欢直接给结论，不喜欢太长的说明。',
                content: '回复风格应简洁直接，优先给结果，再补充 1 到 2 条关键建议。',
                tags: ['沟通偏好', '简洁回答'],
                importance: 'medium',
                score: 0.89,
                source: 'mock',
                createdAt: '2026-04-28T16:00:00.000Z',
                lastUsedAt: '2026-04-30T09:40:00.000Z'
            },
            {
                id: 'mem_demo_003',
                userId: 'demo_user_002',
                agentId: 'agent_sr_001',
                type: 'preference',
                category: 'game_preference',
                summary: '用户对星穹铁道的开荒和抽卡建议更感兴趣。',
                content: '开拓者关注前期开荒阵容、抽卡资源规划和三月七的实战定位。',
                tags: ['星穹铁道', '抽卡', '三月七'],
                importance: 'high',
                score: 0.94,
                source: 'mock',
                createdAt: '2026-04-29T13:20:00.000Z',
                lastUsedAt: '2026-04-30T10:00:00.000Z'
            }
        ];

        this.sessionStorageKey = 'aigc_helper_sessions';
    }

    init() {
        if (this.isInitialized) {
            return;
        }

        console.log('【数据模块】Data module initialized. (AI角色配置、知识库检索、会话记录存储)');
        this._bindEvents();
        this.isInitialized = true;
    }

    /**
     * 绑定事件总线监听
     */
    _bindEvents() {
        this.eventBus.on('QUERY_KNOWLEDGE', async (payload) => {
            console.log('【数据模块】收到知识库查询请求:', payload);
            await this.handleQueryKnowledge(payload);
        });

        this.eventBus.on('SAVE_SESSION_RECORD', async (payload) => {
            console.log('【数据模块】收到保存会话记录请求:', payload);
            await this.saveSessionRecord(payload);
        });

        this.eventBus.on('CHECK_KNOWLEDGE_HEALTH', async (payload) => {
            console.log('【数据模块】收到知识库健康检查请求:', payload);
            await this.checkKnowledgeHealth(payload);
        });

        this.eventBus.on('QUERY_MEMORY', async (payload) => {
            console.log('【数据模块】收到记忆库查询请求:', payload);
            await this.handleQueryMemory(payload);
        });

        this.eventBus.on('SAVE_MEMORY', async (payload) => {
            console.log('【数据模块】收到记忆库保存请求:', payload);
            await this.saveMemory(payload);
        });

        this.eventBus.on('CHECK_MEMORY_HEALTH', async (payload) => {
            console.log('【数据模块】收到记忆库健康检查请求:', payload);
            await this.checkMemoryHealth(payload);
        });
    }

    getRuntimeConfig() {
        const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
        const apiBaseUrl = String(runtime.apiBaseUrl || 'http://127.0.0.1:8788').replace(/\/$/, '');

        return {
            dataMode: runtime.dataMode || 'mock',
            knowledgeProvider: runtime.knowledgeProvider || 'volc',
            memoryMode: runtime.memoryMode || 'mock',
            memoryProvider: runtime.memoryProvider || 'mock',
            apiBaseUrl,
            allowKnowledgeFallback: runtime.allowKnowledgeFallback !== false,
            allowMemoryFallback: runtime.allowMemoryFallback !== false,
            sessionSyncToServer: Boolean(runtime.sessionSyncToServer)
        };
    }

    shouldUseCloudKnowledge() {
        return this.runtime.dataMode === 'cloud';
    }

    shouldSyncSessionToServer() {
        return this.runtime.dataMode === 'cloud' || this.runtime.sessionSyncToServer;
    }

    shouldUseCloudMemory() {
        return this.runtime.memoryMode === 'cloud';
    }

    async handleQueryKnowledge(payload = {}) {
        const query = String(payload.query || '').trim();

        if (!query) {
            this.eventBus.emit('KNOWLEDGE_RESULT', {
                query: '',
                list: ['请输入要查询的内容后再试。'],
                items: [],
                source: 'local'
            });
            return;
        }

        try {
            const result = this.shouldUseCloudKnowledge()
                ? await this.searchKnowledgeFromServer(payload)
                : this.searchKnowledgeFromMock(payload);

            this.eventBus.emit('KNOWLEDGE_RESULT', result);
        } catch (error) {
            console.error('【数据模块】知识库查询失败，回退到本地 mock:', error);
            const fallbackResult = this.searchKnowledgeFromMock(payload, error.message);
            this.eventBus.emit('KNOWLEDGE_RESULT', fallbackResult);
        }
    }

    searchKnowledgeFromMock(payload = {}, fallbackReason = '') {
        const query = String(payload.query || '').trim().toLowerCase();
        const limit = Math.max(1, Number(payload.limit || 5));
        const keywords = query.split(/\s+/).filter(Boolean);

        const matchedItems = this.mockKnowledgeItems
            .map(item => {
                const haystack = `${item.title} ${item.content} ${item.keywords.join(' ')}`.toLowerCase();
                const hitCount = keywords.filter(keyword => haystack.includes(keyword)).length;
                const matchScore = query && haystack.includes(query) ? Math.max(hitCount, 1) : hitCount;

                return {
                    ...item,
                    _matchScore: matchScore
                };
            })
            .filter(item => item._matchScore > 0);

        const resultItems = (matchedItems.length > 0 ? matchedItems : this.mockKnowledgeItems)
            .sort((left, right) => right._matchScore - left._matchScore || right.score - left.score)
            .slice(0, limit)
            .map(item => ({
                id: item.id,
                pointId: item.id,
                title: item.title,
                content: item.content,
                score: item.score,
                docName: item.docName,
                source: 'mock'
            }));

        return {
            query: payload.query || '',
            source: 'mock',
            provider: 'mock',
            fallbackReason,
            items: resultItems,
            list: this.buildKnowledgeList(resultItems)
        };
    }

    async searchKnowledgeFromServer(payload = {}) {
        const response = await fetch(`${this.runtime.apiBaseUrl}/api/data/knowledge/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                provider: this.runtime.knowledgeProvider,
                allowFallback: this.runtime.allowKnowledgeFallback,
                query: payload.query || '',
                limit: payload.limit || 5,
                messages: payload.messages,
                rewrite: payload.rewrite,
                denseWeight: payload.denseWeight,
                resourceId: payload.resourceId,
                name: payload.name,
                project: payload.project
            })
        });

        const json = await response.json();
        if (!response.ok || !json.ok) {
            throw new Error(json.message || `知识库接口请求失败: HTTP ${response.status}`);
        }

        const rawResult = json.data?.data?.result_list || [];
        const items = rawResult.map(item => ({
            id: item.id || item.point_id,
            pointId: item.point_id || item.id,
            title: item.chunk_title || item.doc_info?.title || '知识片段',
            content: item.content || item.description || '',
            score: item.rerank_score || item.score || 0,
            docName: item.doc_info?.doc_name || '',
            source: json.provider || 'volc'
        }));

        return {
            query: payload.query || '',
            source: json.fallback ? 'mock' : 'cloud',
            provider: json.provider || 'volc',
            fallbackReason: json.fallbackReason || '',
            items,
            list: this.buildKnowledgeList(items)
        };
    }

    async checkKnowledgeHealth(payload = {}) {
        try {
            const query = new URLSearchParams({
                probe: payload.probe === false ? '0' : '1',
                query: String(payload.query || '你好').trim()
            });
            const response = await fetch(`${this.runtime.apiBaseUrl}/api/data/knowledge/health?${query.toString()}`);
            const json = await response.json();

            if (!response.ok || !json.ok) {
                throw new Error(json.message || `知识库健康检查失败: HTTP ${response.status}`);
            }

            this.eventBus.emit('KNOWLEDGE_HEALTH_RESULT', json.data);
        } catch (error) {
            console.error('【数据模块】知识库健康检查失败:', error);
            this.eventBus.emit('KNOWLEDGE_HEALTH_FAILED', {
                message: error?.message || '知识库健康检查失败'
            });
        }
    }

    async handleQueryMemory(payload = {}) {
        try {
            const result = this.shouldUseCloudMemory()
                ? await this.searchMemoryFromServer(payload)
                : this.searchMemoryFromMock(payload);

            this.eventBus.emit('MEMORY_RESULT', result);
        } catch (error) {
            console.error('【数据模块】记忆库查询失败，回退到本地 mock:', error);
            const fallbackResult = this.searchMemoryFromMock(payload, error.message);
            this.eventBus.emit('MEMORY_RESULT', fallbackResult);
        }
    }

    searchMemoryFromMock(payload = {}, fallbackReason = '') {
        const query = String(payload.query || '').trim().toLowerCase();
        const limit = Math.max(1, Number(payload.limit || 10));
        const keywords = query.split(/\s+/).filter(Boolean);
        const scopedRecords = this.getMemoryList({
            userId: payload.userId,
            agentId: payload.agentId
        });

        const items = scopedRecords
            .map(record => {
                const haystack = [
                    record.summary,
                    record.content,
                    record.category,
                    ...(record.tags || [])
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();

                const hitCount = keywords.filter(keyword => haystack.includes(keyword)).length;
                const matchScore = query && haystack.includes(query) ? Math.max(hitCount, 1) : hitCount;

                return {
                    ...record,
                    _matchScore: matchScore
                };
            })
            .filter(record => (query ? record._matchScore > 0 : true))
            .sort((left, right) => right._matchScore - left._matchScore || right.score - left.score)
            .slice(0, limit)
            .map(({ _matchScore, ...record }) => record);

        const profile = this.getMemoryProfile(payload.userId, payload.agentId);

        return {
            query: payload.query || '',
            userId: payload.userId || '',
            agentId: payload.agentId || '',
            source: 'mock',
            provider: 'mock',
            fallbackReason,
            profile,
            items,
            list: this.buildMemoryList(items)
        };
    }

    async searchMemoryFromServer(payload = {}) {
        const response = await fetch(`${this.runtime.apiBaseUrl}/api/data/memory/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                provider: this.runtime.memoryProvider,
                allowFallback: this.runtime.allowMemoryFallback,
                userId: payload.userId || '',
                agentId: payload.agentId || '',
                query: payload.query || '',
                limit: payload.limit || 10,
                tags: payload.tags || [],
                category: payload.category || ''
            })
        });

        const json = await response.json();
        if (!response.ok || !json.ok) {
            throw new Error(json.message || `记忆库接口请求失败: HTTP ${response.status}`);
        }

        const data = json.data || {};
        const items = Array.isArray(data.items) ? data.items : [];

        return {
            query: payload.query || '',
            userId: payload.userId || '',
            agentId: payload.agentId || '',
            source: json.fallback ? 'mock' : 'cloud',
            provider: json.provider || this.runtime.memoryProvider,
            fallbackReason: json.fallbackReason || '',
            profile: data.profile || null,
            items,
            list: this.buildMemoryList(items)
        };
    }

    async saveMemory(payload = {}) {
        try {
            const result = this.shouldUseCloudMemory()
                ? await this.saveMemoryToServer(payload)
                : this.saveMemoryToMock(payload);

            this.eventBus.emit('MEMORY_SAVED', result);
        } catch (error) {
            console.error('【数据模块】记忆库保存失败:', error);
            this.eventBus.emit('MEMORY_SAVE_FAILED', {
                message: error?.message || '记忆库保存失败'
            });
        }
    }

    saveMemoryToMock(payload = {}) {
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        const latestMessage = [...messages].reverse().find(item => item?.content);
        const normalizedContent = payload.content || latestMessage?.content || '';
        const record = {
            id: payload.id || `mem_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            userId: payload.userId || 'demo_user_001',
            agentId: payload.agentId || 'agent_ys_001',
            type: payload.type || 'session_fact',
            category: payload.category || 'general',
            summary: payload.summary || String(normalizedContent || '').slice(0, 50),
            content: normalizedContent,
            tags: Array.isArray(payload.tags) ? payload.tags : [],
            importance: payload.importance || 'medium',
            score: 1,
            source: 'mock',
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
            metadata: {
                ...(payload.metadata || {}),
                asyncMode: Boolean(payload.asyncMode)
            }
        };

        this.mockMemoryRecords.unshift(record);

        return {
            provider: 'mock',
            source: 'mock',
            count: this.mockMemoryRecords.length,
            record,
            results: [
                {
                    event_id: `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                    memory_id: record.id,
                    status: 'SUCCEEDED'
                }
            ]
        };
    }

    async saveMemoryToServer(payload = {}) {
        const response = await fetch(`${this.runtime.apiBaseUrl}/api/data/memory/save`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                provider: this.runtime.memoryProvider,
                allowFallback: this.runtime.allowMemoryFallback,
                userId: payload.userId || '',
                agentId: payload.agentId || '',
                type: payload.type || 'session_fact',
                category: payload.category || 'general',
                summary: payload.summary || '',
                content: payload.content || '',
                tags: payload.tags || [],
                importance: payload.importance || 'medium',
                metadata: payload.metadata || {},
                asyncMode: payload.asyncMode !== false,
                messages: Array.isArray(payload.messages) ? payload.messages : undefined
            })
        });

        const json = await response.json();
        if (!response.ok || !json.ok) {
            throw new Error(json.message || `记忆库服务端保存失败: HTTP ${response.status}`);
        }

        return {
            provider: json.provider || this.runtime.memoryProvider,
            source: json.fallback ? 'mock' : 'cloud',
            fallbackReason: json.fallbackReason || '',
            count: json.data?.count || 0,
            record: json.data?.record || null,
            results: json.data?.results || []
        };
    }

    async checkMemoryHealth(payload = {}) {
        try {
            const query = new URLSearchParams({
                provider: this.runtime.memoryProvider,
                query: String(payload.query || '你好').trim()
            });
            const response = await fetch(`${this.runtime.apiBaseUrl}/api/data/memory/health?${query.toString()}`);
            const json = await response.json();

            if (!response.ok || !json.ok) {
                throw new Error(json.message || `记忆库健康检查失败: HTTP ${response.status}`);
            }

            this.eventBus.emit('MEMORY_HEALTH_RESULT', json.data);
        } catch (error) {
            console.error('【数据模块】记忆库健康检查失败:', error);
            this.eventBus.emit('MEMORY_HEALTH_FAILED', {
                message: error?.message || '记忆库健康检查失败'
            });
        }
    }

    buildMemoryList(items = []) {
        if (!Array.isArray(items) || items.length === 0) {
            return ['当前没有命中的记忆记录，可先保存一些用户偏好、事实或会话摘要。'];
        }

        return items.map(item => `${item.summary}：${item.content}`);
    }

    buildKnowledgeList(items = []) {
        if (!Array.isArray(items) || items.length === 0) {
            return ['抱歉，在知识库中暂未找到与您提问相关的记录，您可以尝试换个关键词再查询。'];
        }

        return items.map(item => `${item.title}：${item.content}`);
    }

    async saveSessionRecord(payload = {}) {
        try {
            const recordsStr = this.getLocalStorage().getItem(this.sessionStorageKey);
            let records = recordsStr ? JSON.parse(recordsStr) : [];

            const recordToSave = {
                id: `session_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                timestamp: Date.now(),
                datetime: new Date().toLocaleString(),
                data: payload
            };

            records.push(recordToSave);
            if (records.length > 200) {
                records = records.slice(records.length - 200);
            }

            this.getLocalStorage().setItem(this.sessionStorageKey, JSON.stringify(records));
            console.log('【数据模块】会话记录已自动保存到 localStorage (条数:', records.length, ')');

            let serverSync = null;
            if (this.shouldSyncSessionToServer()) {
                serverSync = await this.saveSessionRecordToServer(recordToSave);
            }

            this.eventBus.emit('SESSION_RECORD_SAVED', {
                count: records.length,
                record: recordToSave,
                syncState: serverSync ? 'local+server' : 'local',
                server: serverSync
            });
        } catch (error) {
            console.error('【数据模块】保存会话记录失败:', error);
            this.eventBus.emit('SESSION_RECORD_SAVE_FAILED', {
                message: error?.message || '保存会话记录失败'
            });
        }
    }

    async saveSessionRecordToServer(record) {
        const response = await fetch(`${this.runtime.apiBaseUrl}/api/data/session/save`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                record
            })
        });

        const json = await response.json();
        if (!response.ok || !json.ok) {
            throw new Error(json.message || `会话记录服务端保存失败: HTTP ${response.status}`);
        }

        return json.data;
    }

    getLocalStorage() {
        if (typeof window === 'undefined' || !window.localStorage) {
            throw new Error('当前环境不支持 localStorage');
        }

        return window.localStorage;
    }

    getAgentConfig(agentId) {
        return this.mockAgents.find(agent => agent.id === agentId) || null;
    }

    getAgentList() {
        return this.mockAgents.slice();
    }

    getMemoryProfile(userId = '', agentId = '') {
        return this.mockMemoryProfiles.find(profile => {
            const userMatched = !userId || profile.userId === userId;
            const agentMatched = !agentId || profile.agentId === agentId;
            return userMatched && agentMatched;
        }) || null;
    }

    getMemoryList(filters = {}) {
        return this.mockMemoryRecords.filter(record => {
            if (filters.userId && record.userId !== filters.userId) {
                return false;
            }
            if (filters.agentId && record.agentId !== filters.agentId) {
                return false;
            }
            return true;
        });
    }

    getMemoryRecord(memoryId) {
        return this.mockMemoryRecords.find(record => record.id === memoryId) || null;
    }
}
