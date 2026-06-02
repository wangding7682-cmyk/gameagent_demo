#!/usr/bin/env node
/**
 * variation-hint 效果验证脚本
 *
 * 用法：
 *   cd volc-aigc-rtc-server
 *   node ../test-variation-hint.mjs
 *
 * 作用：
 *   同一 strategy query 发 3 次请求，观察 emotional_reply 句首词是否出现变化。
 *   若 variation_hint 生效，3 次的句首词应该至少出现 2 种不同词（允许随机波动）。
 *   不依赖 8788 后端，直接调 Ark LLM + buildLayeredSystemPrompt。
 */

import { callArkChat, extractJsonObject } from './src/services/arkChatService.js';
import { buildLayeredSystemPrompt, buildMainUserPrompt } from './src/services/mainAgentService.js';
import { getAgentProfileBundle } from './src/services/agentProfileLoaderService.js';

const QUERIES = [
  '盲僧前期入侵反野，对面豹女怎么打？',
  '中路被对面刺客 6 级前后一直游走，怎么处理兵线？',
  '经济领先 3k 还是打不过团，说明问题出在哪？',
];

const SAMPLE_ANSWERS = {
  '盲僧前期入侵反野，对面豹女怎么打？': '盲僧前期入侵豹女野区，需要判断对方开野路线。如果豹女从蓝 buff 开局，你 2 级可以直接入侵红 buff，配合线上队友大概率能拿到击杀或逼出闪现。',
  '中路被对面刺客 6 级前后一直游走，怎么处理兵线？': '对面刺客游走时，兵线控制在塔前，3 级后把兵控在塔前两格，他一走就 ping 信号推线，顺手插眼，还能和打野拿镀层小龙。',
  '经济领先 3k 还是打不过团，问题出在哪？': '经济领先 3k 还打不过团，大概率是站位和资源分配没做好。确认核心 20 分钟有无 2 件主装，没出就别急强开。',
};

const EMOTIONAL_STARTERS = ['好', '收到', '懂', '稳住', '没问题'];

function extractStarter(text = '') {
  const trimmed = String(text).trim();
  for (const w of EMOTIONAL_STARTERS) {
    if (trimmed.startsWith(w)) return w;
  }
  const m = trimmed.match(/^([^\s，。！？、,!?]{1,4})/);
  return m ? m[1] : '(其他)';
}

function countStarterVariety(responses) {
  const starters = responses.map(r => extractStarter(r));
  const uniq = [...new Set(starters)];
  return { starters, uniq, variety: uniq.length };
}

async function callAgentOnce(query) {
  const bundle = getAgentProfileBundle({ userId: 'jay', personaId: 'main-agent' });
  const systemPrompt = buildLayeredSystemPrompt({
    persona: bundle.persona,
    userProfile: bundle.userProfile,
    longTermMemory: bundle.longTermMemory,
    preferences: bundle.preferences,
  });
  const userPrompt = buildMainUserPrompt({
    taskId: `variation-test-${Date.now()}`,
    userId: 'jay',
    userQuery: query,
    source: 'variation_hint_test',
    rag: { summary: SAMPLE_ANSWERS[query] || '暂无相关知识库结果' },
    shortMemory: { summary: '暂无短期记忆' },
    longTermMemory: bundle.longTermMemory,
    userProfile: bundle.userProfile,
    dynamicSummary: '暂无图文/视频帧上下文',
  });
  const result = await callArkChat({
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 600,
  });
  const parsed = extractJsonObject(result.content);
  return parsed;
}

async function testQuery(query) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Query: ${query}`);
  console.log('='.repeat(60));
  const emotionals = [];
  for (let i = 1; i <= 3; i++) {
    try {
      process.stdout.write(`  Round ${i}/3 调用中... `);
      const resp = await callAgentOnce(query);
      const emotional = resp.emotional_reply || '(空)';
      emotionals.push(emotional);
      console.log(`\n    emotional_reply: "${emotional}"`);
      console.log(`    main_summary:  "${String(resp.main_summary || '').slice(0, 60)}..."`);
      if (i < 3) await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.log(`失败: ${e.message}`);
    }
  }
  const { starters, uniq, variety } = countStarterVariety(emotionals);
  const verdict = variety >= 2 ? '✅ 多样' : '⚠️ 单一';
  console.log(`\n  [${verdict}] 句首词: ${starters.join(' / ')} → ${uniq.join(', ')} (${variety}种)`);
  return { query, emotionals, starters, variety, verdict };
}

async function main() {
  console.log('【 variation_hint 效果验证 】');
  console.log(`期望：emotional_reply 句首在 "${EMOTIONAL_STARTERS.join(' / ')}" 之间切换`);
  console.log(`说明：3 次同 query 调用，若 variation_hint 生效，句首应出现 ≥2 种不同词`);
  const results = [];
  for (const q of QUERIES) {
    results.push(await testQuery(q));
  }
  console.log('\n' + '='.repeat(60));
  console.log('【汇总】');
  const pass = results.filter(r => r.variety >= 2).length;
  console.log(`  通过: ${pass}/${results.length} 条 query 句首词出现多样化`);
  if (pass === results.length) {
    console.log('  结论: variation_hint 生效 ✅');
  } else {
    console.log('  结论: variation_hint 效果不稳定，建议检查 prompt 注入或 few-shot 示例');
  }
  console.log('='.repeat(60));
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
