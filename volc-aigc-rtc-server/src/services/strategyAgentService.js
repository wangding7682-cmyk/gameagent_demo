import { callArkChat, extractJsonObject } from './arkChatService.js';
import { config } from '../config.js';
import { trimTacticData } from './outputTrimmerService.js';
import { sanitizeKnowledgeCardImagePrompt } from './knowledgeCardStyleService.js';
import { extractHeroEntities } from './domainRouterService.js';

/**
 * 【子 Agent / 战术战术卡 + 知识卡片生成】strategyAgentService
 *
 * 通俗职责：基于 main 的意图、RAG 召回内容、屏幕白板，输出可直接渲染成
 * 知识卡片的结构化数据（title + details + voice_chunks），并按需生成
 * 一段【极简信息图风】的 image_prompt_text 用于文生图。
 *
 * 关于知识卡片图像（重要约束）：
 *   - 不再生成"游戏原画/召唤师峡谷场景"类复杂画面
 *   - 强制走"极简信息图 / Apple-style typography poster" 路线
 *   - 服务端二次过滤：sanitizeKnowledgeCardImagePrompt 强制剥词 + 加前缀
 */

const RAG_WEAK_HIT_THRESHOLD = 0.45; // 与 agentOrchestratorService.js 保持一致

function summarizeRagItems(rag = {}, limit = 3) {
  const items = Array.isArray(rag?.items) ? rag.items : [];
  return items.slice(0, limit).map((item) => ({
    title: String(item?.title || '').slice(0, 40),
    content: String(item?.content || '').slice(0, 120),
    source: String(item?.sourceLabel || item?.docName || ''),
    relevance: Number(item?.relevance ?? item?.score ?? 0) || 0,
  })).filter((item) => item.title || item.content);
}

function isTopicCentricQuery(query = '', stickyHero = null) {
  const text = String(query || '').toLowerCase();
  const hero = stickyHero?.hero || '';
  const topicKeywords = ['阵容', '团战', '配合', '节奏', '思路', '决策', '优先级', '选择', '什么时候', '该不该', '要不要', '先做', '后做', '打野', '刷野', '开野', '抓人', '控龙', '河蟹', '辅助', '中单', '上单', '下路', '游走', '带节奏'];
  const hasTopicKeyword = topicKeywords.some((kw) => text.includes(kw));
  if (!hasTopicKeyword) return false;
  if (hero && text.includes(hero.toLowerCase())) return false;
  return true;
}

function buildWeakHitHint(context, mainOutput) {
  const text = String(context?.userQueryResolved || context?.userQuery || mainOutput?.strategy_query || '').trim();
  const hero = isTopicCentricQuery(text, context?.stickyHero) ? '' : String(context?.stickyHero?.hero || '').trim();
  if (/(对线|对位|克制|被谁打|怎么打|怎么对)/.test(text)) {
    return {
      detail: '未命中具体对位资料，先给通用对线思路',
      voice: '没命中具体对位资料，我先给你通用对线思路。',
    };
  }
  if (/(打野|刷野|开野|抓人|控龙|河蟹|反野)/.test(text)) {
    return {
      detail: hero ? `未命中${hero}专属打野资料，先给通用打野框架` : '未命中专属打野资料，先给通用打野框架',
      voice: hero ? `没命中${hero}专属资料，我先给你通用打野框架。` : '没命中专属资料，我先给你通用打野框架。',
    };
  }
  if (/(辅助|adc|ADC|下路|射手|保ad)/.test(text)) {
    return {
      detail: '未命中下路协同资料，先给通用配合思路',
      voice: '没命中下路协同资料，我先给你通用配合思路。',
    };
  }
  return {
    detail: hero ? `未命中${hero}专属资料，先给通用玩法框架` : '未命中专属资料，先给通用玩法框架',
    voice: hero ? `没命中${hero}专属资料，我先给你通用玩法框架。` : '没命中专属资料，我先给你通用玩法框架。',
  };
}

function inferFallbackTemplate(context, mainOutput) {
  const text = String(context?.userQueryResolved || context?.userQuery || mainOutput?.strategy_query || '').trim();
  const hero = isTopicCentricQuery(text, context?.stickyHero) ? '' : String(context?.stickyHero?.hero || '').trim();
  if (/(刷野|开野路线|清野|速刷)/.test(text) && /(打野|野区|前期|最快|效率)/.test(text)) {
    return {
      title: '打野前期速刷路线',
      details: [
        '红蓝buff按线权优先',
        '1分30秒前完成首轮野区',
        '2分20秒前靠近gank位',
        '3级按红F4蓝河蟹走',
        '龙前45秒清半区回补',
      ],
      avoid_pitfalls: [
        '别漏惩戒，应留给核心野',
        '别硬抢河蟹，先看线权',
        '别为蹭线，断掉刷野路',
      ],
      voice_chunks: ['前期刷野先固定路线。', '1分30秒前规划红蓝开。', '2分20秒前靠近gank位。', '别断节奏硬蹭线。'],
    };
  }
  if (/(中单|中路)/.test(text) && /(对线|换血|压线|抢线)/.test(text)) {
    return {
      title: '中单对线抢线节奏',
      details: [
        '1级先看对面技能范围',
        '抢2级先清近战兵',
        '3级后控线在河道前',
        '抢6级留大招反打',
      ],
      avoid_pitfalls: [
        '别无视打野，先补河道眼',
        '别盲目换血，先看兵线',
        '别抢线过深，留技能撤退',
      ],
      voice_chunks: ['中单对线先抢关键等级。', '抢2级先清近战兵。', '3级后控线靠近安全侧。', '抢6级留大招反打。'],
    };
  }
  if (/(打野|刷野|开野|抓人|控龙|河蟹|反野)/.test(text)) {
    return {
      title: `${hero || '打野'}前期节奏`.slice(0, 24),
      details: [
        '1分30秒先刷强势半区',
        '3分河蟹前先做河道眼',
        '6级前少硬抓先保发育',
        '有线权再开龙或进野区',
      ],
      avoid_pitfalls: [
        '别在对面打野消失时继续刷野',
        '六级前别硬抓有控制的线',
        '开局别贪buff直接被反',
      ],
      voice_chunks: hero
        ? [`${hero}先把前两轮野刷顺。`, '首个河蟹前先把河道视野站住。', '六级前别频繁硬抓，先稳发育。', '等线上有线权，再开龙或反野。']
        : ['先把前两轮野刷顺。', '首个河蟹前先把河道视野站住。', '六级前别频繁硬抓，先稳发育。', '等线上有线权，再开龙或反野。'],
    };
  }
  if (/(对线|对位|克制|换血|被压|被消耗|兵线)/.test(text)) {
    return {
      title: `${hero || '对线'}处理思路`.slice(0, 24),
      details: [
        '3级前控线在塔前两格',
        '关键技能交后3秒再换血',
        '没河道眼时别越线硬拼',
        '被压先吃线等4级打野帮',
      ],
      avoid_pitfalls: [
        '别在对面有3层以上兵时换血',
        '没视野别追进草丛',
        '别为了补刀漏走位',
      ],
      voice_chunks: hero
        ? [`${hero}先把兵线控在安全位置。`, '对面关键技能没交前别急着换血。', '没视野就别越线硬拼。', '被压就先稳吃线等打野。']
        : ['先把兵线控在安全位置。', '对面关键技能没交前别急着换血。', '没视野就别越线硬拼。', '被压就先稳吃线等打野。'],
    };
  }
  if (/(辅助|adc|ADC|下路|射手|保ad)/.test(text)) {
    return {
      title: '下路协同节奏',
      details: [
        '2级前统一推线或控线',
        '河道草视野提前30秒占住',
        'ADC补炮车时别乱开团',
        '对面交保命技能再压血线',
      ],
      avoid_pitfalls: [
        '别在ADC补炮车时突然开团',
        '别同时交两个保命技能',
        '别在对面打野消失时压线',
      ],
      voice_chunks: ['下路先统一这波要推还是要控。', '关键草丛视野要提前占住。', 'ADC补刀时别突然乱开团。', '对面保命技能交了再压血线。'],
    };
  }
  return {
    title: `${hero || '英雄'}玩法框架`.slice(0, 24),
    details: [
      '先明确3级或6级强势期',
      '关键技能差10秒别接团',
      '每波回城先补核心小件',
      '围绕有线权的一侧做事',
    ],
    avoid_pitfalls: [
      '别在强势期前去硬拼',
      '别裸出输出装被秒',
      '别无视队友位置单独开团',
    ],
    voice_chunks: hero
      ? [`${hero}先确认自己这局的强势期。`, '关键技能没好前别急着接团。', '每波回城先补核心小件。', '优先围绕有线权的一侧做事。']
      : ['先确认自己这局的强势期。', '关键技能没好前别急着接团。', '每波回城先补核心小件。', '优先围绕有线权的一侧做事。'],
  };
}

function shouldUseGenericJungleTemplate(context = {}, mainOutput = {}, ragStrength = {}) {
  const text = String(context?.userQueryResolved || context?.userQuery || mainOutput?.strategy_query || '').trim();
  return ragStrength.weakHit === true
    && /(刷野|开野路线|清野|速刷)/.test(text)
    && /(打野|野区|前期|最快|效率)/.test(text);
}

function shouldUseGenericMidLaneTemplate(context = {}, mainOutput = {}, ragStrength = {}) {
  const text = String(context?.userQueryResolved || context?.userQuery || mainOutput?.strategy_query || '').trim();
  return ragStrength.weakHit === true
    && /(中单|中路)/.test(text)
    && /(对线|换血|压线|抢线)/.test(text);
}

function buildGenericTemplateStrategy(context, mainOutput, ragStrength, weakHitBannerText) {
  const template = inferFallbackTemplate(context, mainOutput);
  const tacticData = trimTacticData({
    title: template.title,
    details: template.details,
    avoid_pitfalls: template.avoid_pitfalls,
    strategy_output_mode: mainOutput.strategy_output_mode || 'text_only',
    needs_image: false,
    image_prompt_text: null,
    voice_chunks: template.voice_chunks,
  });
  return {
    ...tacticData,
    weak_hit: true,
    weak_hit_banner_text: weakHitBannerText,
    weak_hit_reason: ragStrength.reason,
    top1_relevance: Number((ragStrength.top1 || 0).toFixed(3)),
  };
}

function buildFallbackImagePrompt(title, details, safeSummary) {
  const detailText = details.slice(0, 4).join(' / ');
  return sanitizeKnowledgeCardImagePrompt(
    `极简知识卡片信息图，纯白背景，顶部加粗中文标题"${title}"，下方四行要点列表（${detailText}），每行前置橙色圆形数字图标。Apple-style 衬线大标题，flat design，居中对称排版，无人物无场景。主题：${safeSummary}。`
  );
}

/**
 * 评估 RAG 命中强度：取 items[0] 的 relevance/score 作为 top1
 *  - top1 < 0.7 视为"弱命中"，需要在战术输出中明确"无具体对位资料、先给通用思路"
 *  - 无 items 视为 'no_hit'
 */
export function evaluateRagStrength(rag) {
  const items = Array.isArray(rag?.items) ? rag.items : [];
  if (items.length === 0) {
    return { weakHit: true, top1: 0, reason: 'no_hit', topSource: '', topTitle: '' };
  }
  const top = items[0] || {};
  const top1 = Number(top.relevance ?? top.score ?? 0) || 0;
  return {
    weakHit: top1 < RAG_WEAK_HIT_THRESHOLD,
    top1,
    reason: top1 < RAG_WEAK_HIT_THRESHOLD ? 'low_relevance' : 'ok',
    topSource: String(top.sourceLabel || top.docName || ''),
    topTitle: String(top.title || ''),
  };
}

/**
 * 弱命中保护：在 tactic_data 上注入"未找到具体对位资料"提示
 *  - details 首行插一条提示
 *  - voice_chunks 首段插一句口播提示
 *  - 暴露 weak_hit/weak_hit_reason/top1_relevance 给上层（用于 UI/main_summary 透出）
 */
export function applyWeakHitGuard(tacticData, ragStrength, context = {}, mainOutput = {}) {
  if (!ragStrength.weakHit) {
    return { ...tacticData, weak_hit: false, top1_relevance: ragStrength.top1 };
  }
  const hintBundle = buildWeakHitHint(context, mainOutput);
  const hint = hintBundle.detail;
  const voiceHint = hintBundle.voice;

  const details = Array.isArray(tacticData.details) ? tacticData.details.slice() : [];
  if (!details[0] || !details[0].startsWith('未找到')) {
    details.unshift(hint);
  }

  const voiceChunks = Array.isArray(tacticData.voice_chunks) ? tacticData.voice_chunks.slice() : [];
  if (!voiceChunks[0] || !voiceChunks[0].includes('没命中')) {
    voiceChunks.unshift(voiceHint);
  }

  return {
    ...tacticData,
    details: details.slice(0, 5).map((s) => String(s).slice(0, 36)),
    voice_chunks: voiceChunks.slice(0, 4).map((s) => String(s).slice(0, 36)),
    weak_hit: true,
    weak_hit_banner_text: hint,
    weak_hit_reason: ragStrength.reason,
    top1_relevance: Number(ragStrength.top1.toFixed(3)),
  };
}

/**
 * 主角幻觉守卫：检查 LLM 输出 title 是否引入了 sticky_hero 之外的英雄名
 *  - 有 stickyHero：title 中除 stickyHero 外其它已知英雄实体一律视为幻觉
 *    → title 被改写成 `${stickyHero}战术分析` 兜底；并标记 hero_hallucination
 *  - 无 stickyHero：单轮直接询问场景，不做钳制
 */
export function applyHeroHallucinationGuard(tacticData, stickyHero) {
  const title = String(tacticData.title || '');
  if (!title) return { ...tacticData, hero_hallucination: false };
  const heroes = extractHeroEntities(title);
  const stickyName = stickyHero?.hero || '';
  const hallucinated = heroes.filter((h) => h.hero !== stickyName);
  if (hallucinated.length === 0) {
    return { ...tacticData, hero_hallucination: false };
  }
  if (stickyName) {
    // 强制改写：保留通用结构，把幻觉英雄替换成主角
    const rewrittenTitle = `${stickyName}战术分析`.slice(0, 24);
    return {
      ...tacticData,
      title: rewrittenTitle,
      hero_hallucination: true,
      hallucinated_heroes: hallucinated.map((h) => h.hero),
    };
  }
  return {
    ...tacticData,
    hero_hallucination: true,
    hallucinated_heroes: hallucinated.map((h) => h.hero),
  };
}

function fallbackStrategy(context, mainOutput, rag) {
  const safeSummary = String(mainOutput.main_summary || context.userQuery || '战术建议')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .slice(0, 60);
  const needsImage = mainOutput.needs_image === true;
  const template = inferFallbackTemplate(context, mainOutput);
  return {
    title: template.title,
    details: template.details,
    strategy_output_mode: needsImage ? 'card_with_image' : 'text_only',
    needs_image: needsImage,
    image_prompt_text: needsImage
      ? buildFallbackImagePrompt(template.title, template.details, safeSummary)
      : null,
    voice_chunks: template.voice_chunks,
  };
}

function normalizeStrategyData(parsed = {}, context, mainOutput, rag) {
  const fallback = fallbackStrategy(context, mainOutput, rag);
  const details = Array.isArray(parsed.details) ? parsed.details : fallback.details;
  const avoidPitfalls = Array.isArray(parsed.avoid_pitfalls) ? parsed.avoid_pitfalls : (fallback.avoid_pitfalls || []);
  const needsImage = mainOutput.needs_image === true;
  const rawPrompt = needsImage
    ? String(parsed.image_prompt_text || fallback.image_prompt_text || mainOutput.image_query || '')
    : '';
  return trimTacticData({
    title: String(parsed.title || fallback.title).slice(0, 24),
    details: details.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5).map((item) => item.slice(0, 24)),
    avoid_pitfalls: avoidPitfalls.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 3).map((item) => item.slice(0, 24)),
    strategy_output_mode: mainOutput.strategy_output_mode || fallback.strategy_output_mode,
    needs_image: needsImage,
    image_prompt_text: needsImage ? sanitizeKnowledgeCardImagePrompt(rawPrompt) : null,
    voice_chunks: (Array.isArray(parsed.voice_chunks) ? parsed.voice_chunks : fallback.voice_chunks)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((item) => item.slice(0, 36)),
  });
}

export async function runStrategyAgent(context, mainOutput) {
  if (context.forceMock && context.source === 'demo_button') {
    const demoNeedsImage = mainOutput.needs_image === true;
    return {
      tactic_data: {
        title: '防盲僧前期入侵',
        details: ['河道及时补眼', '前两组野别硬拼', '被入侵就换半区资源'],
        strategy_output_mode: mainOutput.strategy_output_mode || 'text_only',
        needs_image: demoNeedsImage,
        image_prompt_text: demoNeedsImage
          ? sanitizeKnowledgeCardImagePrompt(
              '极简知识卡片信息图，纯白背景，顶部加粗中文大标题"防盲僧前期入侵"，下方三行要点列表，每行前置橙色圆形数字图标，依次：河道及时补眼 / 前两组野别硬拼 / 被入侵就换半区资源。Apple-style 衬线大标题，flat design，居中对称排版，无人物无场景。'
            )
          : null,
        voice_chunks: ['先稳住野区入口。', '盲僧前期强，别和他硬拼。', '看到他露头后再换资源。'],
      },
      rag: {
        provider: 'mock',
        fallback: false,
        query: mainOutput.strategy_query || context.userQuery,
        items: [],
        summary: 'demo_button 使用固定战术示例卡片。',
        error: null,
      },
      raw: null,
    };
  }

  const rag = context.rag || { provider: 'context', query: mainOutput.strategy_query || context.userQuery, items: [], summary: '', error: 'no_rag_context' };
  const earlyRagStrength = evaluateRagStrength(rag);
  if (shouldUseGenericJungleTemplate(context, mainOutput, earlyRagStrength)) {
    return {
      tactic_data: buildGenericTemplateStrategy(context, mainOutput, earlyRagStrength, '未命中专属刷野资料，先给通用速刷路线'),
      rag,
      rag_strength: earlyRagStrength,
      raw: null,
      fallback_reason: 'generic_jungle_weak_hit_template',
    };
  }
  if (shouldUseGenericMidLaneTemplate(context, mainOutput, earlyRagStrength)) {
    return {
      tactic_data: buildGenericTemplateStrategy(context, mainOutput, earlyRagStrength, '未命中具体对位资料，先给通用中单对线框架'),
      rag,
      rag_strength: earlyRagStrength,
      raw: null,
      fallback_reason: 'generic_mid_lane_weak_hit_template',
    };
  }

  const systemPrompt = `你是 Strategy_Agent 战术子脑。
你必须基于真实 RAG 内容和上下文生成可执行战术策略。

内容质量要求：
- title 必须是具体的战术命题，不能是泛泛的"战术建议"。
- details 每条必须是可立即执行的步骤，包含时机或条件，格式为"条件/时机+动作"，禁止纯原则性描述。
- details 至少 3 条必须带量化锚点之一：时间点（1分30秒/20分钟前）、等级点（3级/6级）、距离/位置（塔前两格/河道草）、资源窗口（龙刷新前45秒）、装备/人数（2件套/多1人）。
- avoid_pitfalls 每条必须是常见的执行错误或认知误区，格式为"反面教材+正确做法"，如"别在XX情况做YY，应该先ZZ"。
- voice_chunks 遵循叙事节奏：开场判断→核心动作→补充注意→收尾确认，每段独立可播报。
- 如果 RAG 内容与用户问题不匹配，基于游戏常识给出最合理的战术建议，不要说"暂无数据"。
- 优先使用 rag_top_items 里的资料作为事实锚点；如果 rag_summary 过短但 rag_top_items 不为空，仍要从 rag_top_items 中抽关键动作。
- 如果 current RAG 很弱，但 recent_rag_context 提供了同主角/同主题的近几轮资料，可以把 recent_rag_context 当补充参考；禁止把不同英雄的历史资料混进当前回答。
- 【主角粘性约束】：若上下文给出 sticky_hero（最近 3 轮主角），title 必须包含 sticky_hero.hero；details/voice_chunks 必须围绕该主角展开。
- 严禁脑补 sticky_hero 之外的英雄名（如上下文是冰晶凤凰，禁止写"盲僧/亚索"）；若上下文无明确主角且当前 query 含代词，main_summary 应当反问澄清，title 退化为通用主题，禁止伪造英雄名。
- 【搭档查询】：当用户问"最佳搭档/跟我搭配/配谁"时，从 user_query 中识别"像我玩X"的X作为用户英雄，从 rag_top_items 的标题/内容中匹配该英雄的队友/搭档信息，title 格式为"X最佳搭档Y/Z"。示例：用户问"像我玩冰晶凤凰的话搭配的比较好的是哪些？"+RAG命中"锤石钩人配合"→title="冰晶凤凰最佳搭档锤石/阿狸"

输出限制：
- title 不超过 12 个中文词。
- details 只输出 3-5 条，每条 8-18 字，不能无限延长。
- 如果问题涉及打野/对线/团战/资源，details 不允许全部是泛原则；必须出现至少 2 个数字或明确地形词。
- avoid_pitfalls 输出 2-3 条，每条 8-20 字。
- voice_chunks 最多 4 段，每段 12-28 字，用于流式播报。
- 如果 strategy_output_mode 是 text_only，只输出文字策略，image_prompt_text 必须为 null。
- 如果 strategy_output_mode 是 card_with_image，才输出 80-160 字 image_prompt_text 用于图像生成。

【知识卡片图像生成 — 严格约束】
本系统的图像不是"游戏画面/插画"，而是【信息卡片】，目标是把文字与逻辑结构清晰展示。
image_prompt_text 必须严格满足：
1. 风格关键词必须包含：极简知识卡片信息图、纯白背景、flat design、Apple-style typography、居中对称排版。
2. 必须明确写出"无人物 / 无场景 / 无写实画面 / 无游戏原画"。
3. 内容只描述：标题文字 + 要点列表（来自 details）+ 简单装饰元素（圆形数字图标 / 细分隔线 / 橙色高亮 / 箭头）。
4. 配色固定：纯白背景 (#FFFFFF) + 深灰主标题 (#1A1A1A) + 橙色强调色 (#FF8A2D)。
5. 禁止使用：英雄联盟 / 王者荣耀 / 召唤师峡谷 / 团战场景 / 游戏原画 / 写实 / 3D / 渲染 / cinematic / illustration / 角色 / 技能特效 / 氛围紧张 / 等任何"画游戏画面"的词。
6. 不要描述具体英雄、技能、地图地形——这些是文字内容的事，不是图像的事。

画面观察使用规则（screen_observation 字段）：
- 如果 screen_observation.isFresh=true，details 必须至少有 1 条结合当前画面情况（血量/大招/近期事件）给出针对性建议。
- 如果 screen_observation.isFresh=false 或为空，禁止编造画面状态，按通用建议处理。
- 不要在 voice_chunks 中复述画面数据本身（用户能看到自己屏幕），只输出基于画面推导出的动作。

输出示例（严格参照格式和风格）：

示例1 - text_only：
用户问：大龙和先锋怎么选？
输出：
{"title":"大龙先锋选择节奏","details":["20分钟前有线权速打先锋拆外塔","20分钟后算好视野和TP再开大龙","人不够时优先拿先锋换资源"],"avoid_pitfalls":["人不够别硬开大龙容易猝死","别在对面有2人以上消失时开龙","先锋不要在已经拿了小龙时重复拿"],"strategy_output_mode":"text_only","needs_image":false,"image_prompt_text":null,"voice_chunks":["先看时间线，20分钟是分界点。","前期有线权就速打先锋推塔。","后期人够再开大龙，别硬开。"]}

示例2 - text_only：
用户问：中路被对面刺客6级前后一直游走，怎么处理兵线？
输出：
{"title":"中路抗游走兵线处理","details":["3级后把兵控在塔前两格","他一走就ping信号推线","顺手插眼配合打野拿镀层小龙"],"strategy_output_mode":"text_only","needs_image":false,"image_prompt_text":null,"voice_chunks":["先把兵线控在塔前。","他游走就推线拿镀层。","记得插眼配合打野。"]}

示例3 - card_with_image（注意：image_prompt_text 是"信息卡片"风格，不是游戏画面）：
用户问：帮我画一张经济领先3k打不过团的战术卡片
输出：
{"title":"优势打团诊断","details":["确认核心20分钟有无2件主装","没出就别急强开让辅助先占草","团后看经济面板确保优势在关键位"],"strategy_output_mode":"card_with_image","needs_image":true,"image_prompt_text":"极简知识卡片信息图，纯白背景 #FFFFFF，顶部居中加粗深灰中文大标题"优势打团诊断"，标题下方一条细橙色分隔线 #FF8A2D。下方三行要点列表，每行前置橙色圆形数字图标 1/2/3，依次写：核心20分钟有无2件主装 / 没出装别急强开 / 团后看经济面板。Apple-style 衬线 typography poster，flat design，居中对称排版，无人物无场景无写实画面。","voice_chunks":["经济领先还输团，先查核心装备。","装备没出就别强开。","让辅助先占草再打。"]}

严格只返回 JSON，禁止任何字段包含括号内容。`;

  const screenObs = context.screenObservation || null;
  const effectiveStickyHero = isTopicCentricQuery(context.userQueryResolved || context.userQuery, context.stickyHero) ? null : (context.stickyHero || null);
  const userPrompt = JSON.stringify({
    user_query: context.userQueryResolved || context.userQuery,
    main_summary: mainOutput.main_summary,
    strategy_output_mode: mainOutput.strategy_output_mode || 'text_only',
    needs_image: mainOutput.needs_image === true,
    image_query: mainOutput.image_query || null,
    rag_summary: rag.summary,
    rag_top_items: summarizeRagItems(rag),
    rag_error: rag.error || null,
    recent_rag_context: context.historicalRagContext || '',
    short_memory: context.shortMemory?.summary || '',
    dynamic_context: context.dynamicSummary || '',
    // 泛话题（阵容/团战/配合等）时清除 hero 上下文，防止 hero 特化标题
    sticky_hero: effectiveStickyHero,
    screen_observation: screenObs ? {
      summary: screenObs.summary,
      isFresh: screenObs.isFresh,
      recentEvents: screenObs.recentEvents || [],
    } : null,
    required_json: {
      title: '战术策略标题',
      details: ['步骤1', '步骤2', '步骤3'],
      avoid_pitfalls: ['避坑1', '避坑2'],
      strategy_output_mode: 'text_only|card_with_image',
      needs_image: false,
      image_prompt_text: 'needs_image=true时输出极简信息卡片风格描述（无人物无场景），否则null',
      voice_chunks: ['短播报1', '短播报2'],
    },
  });

  try {
    const result = await callArkChat({ systemPrompt, userPrompt, temperature: 0.2, maxTokens: 900, timeoutMs: 30000, model: config.ark.chatModelLite });
    const ragStrength = evaluateRagStrength(rag);
    // 三层加固：normalize → 弱命中保护 → 主角幻觉守卫
    const tacticData = applyHeroHallucinationGuard(
      applyWeakHitGuard(
        normalizeStrategyData(extractJsonObject(result.content), context, mainOutput, rag),
        ragStrength,
        context,
        mainOutput
      ),
      effectiveStickyHero
    );
    return {
      tactic_data: tacticData,
      rag,
      rag_strength: ragStrength,
      raw: result.content,
    };
  } catch (error) {
    const ragStrength = evaluateRagStrength(rag);
    return {
      tactic_data: applyHeroHallucinationGuard(
        applyWeakHitGuard(fallbackStrategy(context, mainOutput, rag), ragStrength, context, mainOutput),
        effectiveStickyHero
      ),
      rag,
      rag_strength: ragStrength,
      raw: null,
      fallback_reason: error.message,
    };
  }
}
