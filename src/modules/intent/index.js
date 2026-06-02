import { globalEventBus } from '../../core/eventBus.js';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8788';

// 兼容旧模块：完整 Agent 编排已迁移到 src/modules/agent/index.js。
// 正式链路不再初始化本模块，仅保留给回滚和旧调试入口。

function getRuntimeConfig() {
    const runtime = typeof window !== 'undefined' ? window.__GAME_AI_RUNTIME__ || {} : {};
    const rtcRuntime = runtime.rtc || {};
    return {
        apiBaseUrl: String(runtime.apiBaseUrl || rtcRuntime.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, ''),
    };
}

export class IntentModule {
    constructor(eventBus) {
        this.eventBus = eventBus || globalEventBus;
        this.pendingIntent = null;
        this.isProcessingIntent = false;
        this.intentDebounceTimer = null;
    }

    init() {
        this.bindEventBus();
        console.log('[IntentModule] Intent module initialized');
    }

    getApiBaseUrl() {
        return getRuntimeConfig().apiBaseUrl;
    }

    bindEventBus() {
        this.eventBus.on('RTC_USER_ASR', (payload) => {
            const text = String(payload.text || '').trim();
            if (!text) return;
            console.log('[IntentModule] 收到 RTC USER ASR:', text);
            this.handleUserAsr(text, payload);
        });

        this.eventBus.on('RTC_SUBTITLE', (payload) => {
        });

        this.eventBus.on('USER_SEND_QUERY', (payload) => {
            const text = String(payload.text || '').trim();
            if (!text || payload.source === 'pet_tap') return;
            console.log('[IntentModule] 收到 USER_SEND_QUERY:', text);
            this.handleUserAsr(text, payload);
        });
    }

    async handleUserAsr(text, payload = {}) {
        if (this.isProcessingIntent) {
            console.log('[IntentModule] 正在处理上一个意图，跳过');
            return;
        }

        this.isProcessingIntent = true;

        try {
            const intentResult = await this.callIntentAPI(text, payload);

            this.pendingIntent = {
                text,
                ...intentResult,
                timestamp: Date.now()
            };

            console.log('[IntentModule] 意图识别结果:', intentResult);

            if (intentResult.intent === 'tts') {
                this.eventBus.emit('INTENT_DETECTED', {
                    ...this.pendingIntent,
                    source: payload.source || 'asr'
                });
            } else {
                this.eventBus.emit('INTENT_DETECTED', {
                    ...this.pendingIntent,
                    source: payload.source || 'asr'
                });
            }

        } catch (error) {
            console.error('[IntentModule] 意图识别失败:', error);
            this.eventBus.emit('INTENT_DETECTION_FAILED', {
                text,
                error: error.message,
                source: payload.source || 'asr'
            });
        } finally {
            this.isProcessingIntent = false;
        }
    }

    async callIntentAPI(text, payload = {}) {
        const apiBaseUrl = this.getApiBaseUrl();

        try {
            const response = await fetch(`${apiBaseUrl}/api/agent/intent`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text,
                    source: payload.source || 'unknown',
                    sessionId: payload.sessionId || payload.userId || 'default'
                })
            });

            const json = await response.json();
            console.log('[IntentModule] 意图识别响应:', json);

            if (!response.ok || !json.ok) {
                throw new Error(json.message || `意图识别请求失败: HTTP ${response.status}`);
            }

            return json.data || {};
        } catch (error) {
            console.warn('[IntentModule] 意图识别接口调用失败，使用本地兜底:', error);
            console.log('[IntentModule] 本地兜底意图识别结果:', this.localIntentFallback(text));
            return this.localIntentFallback(text);
        }
    }

    localIntentFallback(text) {
        const normalizedText = text.toLowerCase();
        const knowledgeKeywords = [
            '怎么', '如何', '怎样', '啥', '什么', '哪个', '哪些', '谁', '为何', '为什么', '为啥',
            '攻略', '教学', '教程', '技巧', '技术', '操作', '连招', 'combo', 'combos',
            '出装', '装备', '神装', '装备推荐', '必出', '核心装备',
            '铭文', '符文', '天赋', '加点', '加点方案',
            '玩法', '打法', '思路', '套路', '技巧', '对策', '克制', '克制关系',
            '规则', '机制', '效果', '属性', '数值', 'cd', '冷却',
            '教我', '告诉我', '介绍', '说明', '解释', '讲讲', '讲一讲', '说说',
            '是什么', '什么叫', '啥意思', '啥是',
            '会不会', '能不能', '要不要', '算不算', '能不能够',
            '知识卡片', '生成知识', '卡片', '给我生成', '生成一个', '生成', '生成一下',
            '给我查', '查询', '查一下', '检索', '搜一下知识',
            '英雄', '角色', '人物', '角色推荐', '英雄推荐', '玩哪个', '选哪个',
            '对线', '开局', '开局思路', '前期', '中期', '后期', '团战', '单挑',
            '刷野', '清线', '补刀', '控龙', '拿龙', '节奏', '发育',
            '蹲人', '埋伏', '偷袭', '拉扯', '走位', '站位',
            '什么时候', '几时', '多久', '多长', '多少', '几级', '几分钟'
        ];
        const videoKeywords = [
            '视频', '精彩视频', '看视频', '给我看', '给我搜', '搜索视频', '搜一下视频',
            '精彩集锦', '操作秀', '秀', '打法视频', '实战视频',
            '实战', '操作', '集锦', '高光', '名场面', '名场面视频',
            '搜搜', '搜一下相关', '帮我找视频', '想看视频', '想看看',
            '怎么打', '怎么玩', '怎么出装', '怎么连招'
        ];
        const hasExcludedVideo = videoKeywords.some(kw => normalizedText.includes(kw)) && knowledgeKeywords.some(k => normalizedText.includes(k));

        let intent = 'tts';
        for (const kw of knowledgeKeywords) {
            if (normalizedText.includes(kw) && !(hasExcludedVideo && normalizedText.includes('视频'))) {
                intent = 'knowledge';
                break;
            }
        }
        if (intent === 'tts') {
            for (const kw of videoKeywords) {
                if (normalizedText.includes(kw)) {
                    intent = 'video';
                    break;
                }
            }
        }

        const defaultSummaries = {
            knowledge: '好的，我来为你查询相关的知识。',
            video: '好的，我来为你搜索相关的精彩视频。',
            tts: text.length > 50 ? text.slice(0, 50) + '...' : text
        };

        return {
            intent,
            confidence: 0.5,
            ttsSummary: defaultSummaries[intent],
            videoQuery: intent === 'video' ? text : null,
            knowledgeQuery: intent === 'knowledge' ? text : null,
            query: text,
            suggestions: {
                knowledge: intent === 'knowledge' ? {
                    action: 'dispatchRealtimeReply',
                    mode: 'knowledge',
                    ttsSummary: defaultSummaries.knowledge
                } : null,
                video: intent === 'video' ? {
                    action: 'dispatchRealtimeReply',
                    mode: 'video',
                    ttsSummary: defaultSummaries.video
                } : null,
                tts: intent === 'tts' ? {
                    action: 'directTts',
                    ttsSummary: defaultSummaries.tts
                } : null
            }
        };
    }

    clearPendingIntent() {
        this.pendingIntent = null;
    }
}

export const intentModule = new IntentModule();
