import { callArkChat, extractJsonObject } from './arkChatService.js';
import { trimTacticData } from './outputTrimmerService.js';

function fallbackStrategy(context, mainOutput, rag) {
  const safeSummary = String(mainOutput.main_summary || context.userQuery || '战术建议').replace(/[\x00-\x1F\x7F]/g, '').slice(0, 80);
  const needsImage = mainOutput.needs_image === true;
  return {
    title: '战术处理建议',
    details: ['先稳住关键资源', '避免无视野硬拼', '等敌方露头再反打'],
    strategy_output_mode: needsImage ? 'card_with_image' : 'text_only',
    needs_image: needsImage,
    image_prompt_text: needsImage
      ? `英雄联盟召唤师峡谷游戏场景，游戏角色在野区布置战术，氛围紧张专注。画面强调视野布置、节奏控制和反制路线，风格贴合游戏原画，战术主题：${safeSummary}。`
      : null,
    voice_chunks: [mainOutput.main_summary ? mainOutput.main_summary.slice(0, 28) : '先稳住节奏，再找反打机会。'],
  };
}

function normalizeStrategyData(parsed = {}, context, mainOutput, rag) {
  const fallback = fallbackStrategy(context, mainOutput, rag);
  const details = Array.isArray(parsed.details) ? parsed.details : fallback.details;
  return trimTacticData({
    title: String(parsed.title || fallback.title).slice(0, 24),
    details: details.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5).map((item) => item.slice(0, 24)),
    strategy_output_mode: mainOutput.strategy_output_mode || fallback.strategy_output_mode,
    needs_image: mainOutput.needs_image === true,
    image_prompt_text: mainOutput.needs_image === true
      ? String(parsed.image_prompt_text || fallback.image_prompt_text || mainOutput.image_query || '').slice(0, 260)
      : null,
    voice_chunks: (Array.isArray(parsed.voice_chunks) ? parsed.voice_chunks : fallback.voice_chunks)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((item) => item.slice(0, 36)),
  });
}

export async function runStrategyAgent(context, mainOutput) {
  if (context.forceMock && context.source === 'demo_button') {
    return {
      tactic_data: {
        title: '防盲僧前期入侵',
        details: ['河道及时补眼', '前两组野别硬拼', '被入侵就换半区资源'],
        strategy_output_mode: mainOutput.strategy_output_mode || 'text_only',
        needs_image: mainOutput.needs_image === true,
        image_prompt_text: mainOutput.needs_image === true
          ? '画面表现一名打野玩家在野区入口布置视野，强调防入侵路线、河道眼位和换资源思路。'
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

  const systemPrompt = `你是 Strategy_Agent 战术子脑。
你必须基于真实 RAG 内容和上下文生成可执行战术策略。

内容质量要求：
- title 必须是具体的战术命题，不能是泛泛的"战术建议"。
- details 每条必须是可立即执行的步骤，包含时机或条件，格式为"条件/时机+动作"，禁止纯原则性描述。
- voice_chunks 遵循叙事节奏：开场判断→核心动作→补充注意→收尾确认，每段独立可播报。
- 如果 RAG 内容与用户问题不匹配，基于游戏常识给出最合理的战术建议，不要说"暂无数据"。

输出限制：
- title 不超过 12 个中文词。
- details 只输出 3-5 条，每条 8-18 字，不能无限延长。
- voice_chunks 最多 4 段，每段 12-28 字，用于流式播报。
- 如果 strategy_output_mode 是 text_only，只输出文字策略，image_prompt_text 必须为 null。
- 如果 strategy_output_mode 是 card_with_image，才输出 120-220 字 image_prompt_text 用于图像生成。

输出示例（严格参照格式和风格）：

示例1 - text_only：
用户问：大龙和先锋怎么选？
输出：
{"title":"大龙先锋选择节奏","details":["20分钟前有线权速打先锋拆外塔","20分钟后算好视野和TP再开大龙","人不够时优先拿先锋换资源"],"strategy_output_mode":"text_only","needs_image":false,"image_prompt_text":null,"voice_chunks":["先看时间线，20分钟是分界点。","前期有线权就速打先锋推塔。","后期人够再开大龙，别硬开。"]}

示例2 - text_only：
用户问：中路被对面刺客6级前后一直游走，怎么处理兵线？
输出：
{"title":"中路抗游走兵线处理","details":["3级后把兵控在塔前两格","他一走就ping信号推线","顺手插眼配合打野拿镀层小龙"],"strategy_output_mode":"text_only","needs_image":false,"image_prompt_text":null,"voice_chunks":["先把兵线控在塔前。","他游走就推线拿镀层。","记得插眼配合打野。"]}

示例3 - card_with_image：
用户问：帮我画一张经济领先3k打不过团的战术卡片
输出：
{"title":"优势打团诊断","details":["确认核心20分钟有无2件主装","没出就别急强开让辅助先占草","团后看经济面板确保优势在关键位"],"strategy_output_mode":"card_with_image","needs_image":true,"image_prompt_text":"英雄联盟召唤师峡谷团战场景，蓝色方经济领先但站位分散，红色方抱团反打。画面突出经济面板对比、核心装备完成度和草丛视野控制点，风格贴合游戏原画，战术主题：优势局打团站位与资源分配。","voice_chunks":["经济领先还输团，先查核心装备。","装备没出就别强开。","让辅助先占草再打。"]}

严格只返回 JSON，禁止任何字段包含括号内容。`;

  const userPrompt = JSON.stringify({
    user_query: context.userQuery,
    main_summary: mainOutput.main_summary,
    strategy_output_mode: mainOutput.strategy_output_mode || 'text_only',
    needs_image: mainOutput.needs_image === true,
    image_query: mainOutput.image_query || null,
    rag_summary: rag.summary,
    short_memory: context.shortMemory?.summary || '',
    dynamic_context: context.dynamicSummary || '',
    required_json: {
      title: '战术策略标题',
      details: ['步骤1', '步骤2', '步骤3'],
      strategy_output_mode: 'text_only|card_with_image',
      needs_image: false,
      image_prompt_text: 'needs_image=true时用于图像生成，否则null',
      voice_chunks: ['短播报1', '短播报2'],
    },
  });

  try {
    const result = await callArkChat({ systemPrompt, userPrompt, temperature: 0.2, maxTokens: 900 });
    return {
      tactic_data: normalizeStrategyData(extractJsonObject(result.content), context, mainOutput, rag),
      rag,
      raw: result.content,
    };
  } catch (error) {
    return {
      tactic_data: fallbackStrategy(context, mainOutput, rag),
      rag,
      raw: null,
      fallback_reason: error.message,
    };
  }
}
