import { callArkChat, extractJsonObject } from './arkChatService.js';

const SUPPORTED_DOMAINS = [
  { value: 'lol', label: '英雄联盟' },
  { value: 'wzry', label: '王者荣耀' },
  { value: 'genshin', label: '原神' },
  { value: 'honkai', label: '崩坏：星穹铁道' },
  { value: 'zzz', label: '绝区零' },
  { value: 'other', label: '其他/通用' },
];

const SYSTEM_PROMPT = `你是一个游戏知识库分类助手。根据文档片段和文件名，判断它属于哪个游戏。
候选游戏：
- lol：英雄联盟（关键词：召唤师峡谷、亚索、盲僧、ADC、上单中单等）
- wzry：王者荣耀（关键词：KPL、貂蝉、后羿、李白、五排等）
- genshin：原神（关键词：璃月、蒙德、稻妻、元素反应、七神等）
- honkai：崩坏星穹铁道（关键词：星穹铁道、空间站、黑塔、巡海等）
- zzz：绝区零（关键词：新艾利都、空洞、邦布等）
- other：以上都不属于的通用/其他游戏内容

只返回 JSON：{"domain": "lol|wzry|genshin|honkai|zzz|other", "confidence": 0.0~1.0, "reason": "20字以内中文理由"}`;

export async function predictDocumentDomain({ filename = '', text = '' } = {}) {
  const safeName = String(filename || '').slice(0, 80);
  const safeText = String(text || '').replace(/\s+/g, ' ').slice(0, 1200);
  if (!safeText && !safeName) {
    return { domain: 'other', confidence: 0, reason: '空内容', source: 'rule' };
  }

  const userPrompt = `文件名：${safeName || '(无)'}\n\n文档片段：\n${safeText || '(无)'}\n\n请判定它属于哪个游戏，并给出 JSON 输出。`;

  try {
    const result = await callArkChat({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.1,
      maxTokens: 200,
    });
    const parsed = extractJsonObject(result.content);
    const domain = SUPPORTED_DOMAINS.find((d) => d.value === parsed?.domain)?.value || 'other';
    const confidence = typeof parsed?.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;
    const reason = String(parsed?.reason || '').slice(0, 60);
    return { domain, confidence, reason, source: 'llm' };
  } catch (error) {
    return ruleFallback(filename, text, error?.message);
  }
}

function ruleFallback(filename, text, errorMsg) {
  const haystack = `${filename}\n${String(text || '').slice(0, 800)}`.toLowerCase();
  const rules = [
    { domain: 'lol', kws: ['英雄联盟', 'lol', '召唤师峡谷', '亚索', '盲僧', '锤石'] },
    { domain: 'wzry', kws: ['王者荣耀', '王者', 'kpl', '貂蝉', '后羿', '李白'] },
    { domain: 'genshin', kws: ['原神', 'genshin', '璃月', '蒙德', '稻妻'] },
    { domain: 'honkai', kws: ['星穹铁道', '崩坏', '星铁'] },
    { domain: 'zzz', kws: ['绝区零', 'zzz', '新艾利都'] },
  ];
  let best = { domain: 'other', score: 0 };
  for (const rule of rules) {
    let score = 0;
    for (const kw of rule.kws) if (haystack.includes(kw.toLowerCase())) score += 1;
    if (score > best.score) best = { domain: rule.domain, score };
  }
  return {
    domain: best.domain,
    confidence: best.score === 0 ? 0.2 : Math.min(0.7, 0.3 + best.score * 0.1),
    reason: errorMsg ? `LLM 不可用，基于关键词：${best.score} 命中` : `关键词命中 ${best.score}`,
    source: 'rule_fallback',
  };
}
