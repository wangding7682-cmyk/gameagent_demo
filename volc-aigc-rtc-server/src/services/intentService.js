import { config } from '../config.js';
import { safeFetchJson } from '../utils/http.js';

function assertArkChatConfig() {
  const missing = [];
  if (!config.ark?.chatModel) missing.push('ARK_CHAT_MODEL (ep-20260430103756-7wgz4)');
  if (!config.ark?.apiKey) missing.push('ARK_API_KEY');
  if (missing.length > 0) {
    throw new Error(`缺少配置: ${missing.join(', ')}`);
  }
}

function buildChatSystemPrompt() {
  return `你是一个游戏AI助手，需要对用户的查询进行意图识别，并生成回复。

【任务】
分析用户输入，判断其意图，并按照指定JSON格式回复。

【意图类型】
1. knowledge - 用户询问游戏攻略、技巧、出装、铭文、连招、玩法、规则等知识性问题
2. video - 用户想要看精彩视频、精彩集锦、操作秀、实战打法
3. tts - 用户想要语音播报（以上都不是时默认）

【输出格式】严格返回以下JSON结构（不要添加任何额外内容）：
{
  "intent": "knowledge|video|tts",
  "ttsSummary": "给用户的口语化回复（15-40字），用于立即语音播报",
  "videoQuery": "用于抖音搜索的关键词（仅intent为video时填写，否则填null）",
  "knowledgeQuery": "用于知识库检索的关键词（仅intent为knowledge时填写，否则填null）
}

【示例】
用户: 亚索怎么玩
输出: {"intent":"knowledge","ttsSummary":"亚索是个操作性很强的英雄，我来给你详细讲解一下。","videoQuery":null,"knowledgeQuery":"亚索玩法攻略"}

用户: 给我看看亚索的精彩操作
输出: {"intent":"video","ttsSummary":"好的，来看看亚索的精彩操作集锦！","videoQuery":"亚索精彩操作集锦","knowledgeQuery":null}

用户: 亚索
输出: {"intent":"tts","ttsSummary":"亚索是英雄联盟里的战士英雄，具有极高的操作性。","videoQuery":null,"knowledgeQuery":null}

【注意】
- ttsSummary必须是完整的口语化句子，能直接用于TTS播报
- videoQuery要适合抖音搜索，长度控制在20字以内
- knowledgeQuery要适合知识库检索，控制在30字以内
- 只返回JSON，不要有任何前缀或后缀文字`;
}

function buildChatPayload(text) {
  return {
    model: config.ark.chatModel,
    messages: [
      { role: 'system', content: buildChatSystemPrompt() },
      { role: 'user', content: `用户输入: ${text}` }
    ],
    stream: false,
  };
}

function parseChatResponse(rawData) {
  let parsed;
  try {
    parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  } catch (error) {
    throw new Error(`Ark Chat 响应 JSON 解析失败: ${error.message}`);
  }

  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`Ark Chat 响应格式异常: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  return content;
}

function classifyIntent(parsedResponse) {
  const intent = String(parsedResponse.intent || 'tts').toLowerCase().trim();
  if (intent === 'knowledge' || intent === 'video' || intent === 'tts') {
    return intent;
  }
  return 'tts';
}

export async function recognizeIntent(text) {
  assertArkChatConfig();

  const cleanText = String(text || '').trim();
  if (!cleanText) {
    throw new Error('意图识别需要 text 参数');
  }

  const chatPath = config.ark.chatPath || '/api/v3/chat/Completions';
  const payload = buildChatPayload(cleanText);

  const rawData = await safeFetchJson(`https://${config.ark.host}${chatPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ark.apiKey}`,
    },
    body: JSON.stringify(payload),
    timeoutMs: 8000,
  });

  const content = parseChatResponse(rawData);

  const jsonMatch = content.trim().match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`无法从响应中解析JSON: ${content.slice(0, 200)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (error) {
    throw new Error(`JSON解析失败: ${error.message}, 原始内容: ${jsonMatch[0].slice(0, 200)}`);
  }

  const intent = classifyIntent(parsed);

  function validateField(value, maxLen) {
    if (typeof value === 'string' && value.length > 0 && value.length <= maxLen) {
      return value.trim();
    }
    return null;
  }

  const ttsSummary = validateField(parsed.ttsSummary, 200);
  const videoQuery = intent === 'video' ? validateField(parsed.videoQuery, 50) : null;
  const knowledgeQuery = intent === 'knowledge' ? validateField(parsed.knowledgeQuery, 100) : null;

  return {
    intent,
    ttsSummary,
    videoQuery,
    knowledgeQuery,
    raw: parsed,
  };
}
