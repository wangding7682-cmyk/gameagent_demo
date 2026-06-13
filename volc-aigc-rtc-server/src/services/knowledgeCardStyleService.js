/**
 * 【知识卡片风格守门员】knowledgeCardStyleService
 *
 * 通俗职责：
 *   - LLM 生成的 image_prompt_text 可能"游戏画面派"复发，这里强制剥词 + 加风格前缀
 *   - 给 arkImageService 提供统一的"信息图风"包装函数 buildKnowledgeCardImagePayload
 *   - 单点维护配色 / 字体 / 排版风格，未来要改风格只动这一个文件
 *
 * 设计原则：
 *   - 纯字符串处理，零成本，零副作用
 *   - 即使 LLM 偷懒输出"团战场景"也能兜底过滤
 *   - 通过 config.knowledgeCard.styleHint 切换：
 *       infographic_minimal（默认）= 严格剥词 + 强制前缀
 *       freestyle                  = 跳过过滤（调试 / 回归用）
 */

import { config } from '../config.js';

// 禁用词：任何会引导文生图模型画"复杂画面"的词
const FORBIDDEN_WORDS = [
  '英雄联盟', '王者荣耀', '召唤师峡谷', '王者峡谷',
  '团战场景', '游戏场景', '游戏画面', '游戏原画',
  '原画', '写实', '3D', '渲染', 'render', 'realistic',
  'cinematic', 'illustration', '插画',
  '角色', '英雄人物', '技能特效', '魔法效果',
  '氛围紧张', '紧张氛围', '激烈对抗', '战斗场面',
  '蓝色方', '红色方', '河道', '野区入口', '草丛',
];

// 必须出现的风格关键词（缺失则强制加前缀）
const STYLE_SIGNALS = ['极简', '信息图', 'infographic', 'flat design', 'typography'];

// 强制前缀：当 LLM 输出完全跑题时兜底
const FORCED_PREFIX =
  '极简知识卡片信息图，纯白背景 #FFFFFF，深灰主标题 #1A1A1A，橙色强调色 #FF8A2D，' +
  'Apple-style 衬线 typography poster，flat design，居中对称排版，无人物无场景无写实画面。';

const MAX_PROMPT_LEN = 320;
const MIN_PROMPT_LEN = 20;

/**
 * 把 LLM 生成的 image_prompt_text 过滤成"信息卡片风"
 * 规则：
 *   1) 剥掉所有禁用词
 *   2) 如果剥后残骸太短或缺关键风格词，前置 FORCED_PREFIX
 *   3) 长度截到 MAX_PROMPT_LEN
 */
export function sanitizeKnowledgeCardImagePrompt(rawPrompt) {
  let p = String(rawPrompt || '').trim();
  if (!p) return null;

  // freestyle 档位：跳过过滤直接返回（仅做长度兜底）
  if (config?.knowledgeCard?.styleHint === 'freestyle') {
    return p.length > MAX_PROMPT_LEN ? p.slice(0, MAX_PROMPT_LEN) : p;
  }

  // 1) 剥词
  for (const w of FORBIDDEN_WORDS) {
    if (!w) continue;
    p = p.split(w).join('');
  }
  // 多余的逗号/空白整理
  p = p.replace(/[,，]\s*[,，]+/g, '，').replace(/\s{2,}/g, ' ').trim();

  // 2) 风格守卫
  const hasStyleSignal = STYLE_SIGNALS.some((sig) => p.toLowerCase().includes(sig.toLowerCase()));
  if (!hasStyleSignal || p.length < MIN_PROMPT_LEN) {
    p = `${FORCED_PREFIX}${p ? '内容主题：' + p : ''}`;
  }

  // 3) 长度兜底
  if (p.length > MAX_PROMPT_LEN) {
    p = p.slice(0, MAX_PROMPT_LEN);
  }
  return p;
}

/**
 * 把 sanitize 后的 prompt 进一步包装成 arkImageService 调用 payload
 * （供 server.js 在调图前统一做最终兜底）
 */
export function buildKnowledgeCardImagePayload({ prompt, size }) {
  return {
    prompt: sanitizeKnowledgeCardImagePrompt(prompt),
    size: size || '2K',
  };
}

// 暴露给单元测试 / 调试
export const __internals = {
  FORBIDDEN_WORDS,
  STYLE_SIGNALS,
  FORCED_PREFIX,
  MAX_PROMPT_LEN,
};
