#!/usr/bin/env node
/**
 * 分层 System Prompt 注入预览脚本
 *
 * 用法：
 *   cd volc-aigc-rtc-server
 *   node scripts/preview-system-prompt.mjs
 *   node scripts/preview-system-prompt.mjs --user=jay --persona=main-agent
 *   node scripts/preview-system-prompt.mjs --combo=all
 *
 * 作用：
 *   - 通过 agentProfileLoaderService 真实加载 persona / userProfile / longTermMemory / preferences
 *   - 调用 buildLayeredSystemPrompt 拼出最终 systemPrompt
 *   - 顺带打印一份 buildMainUserPrompt 的 user 消息样本，便于核对分层注入是否正确
 */

import {
  buildLayeredSystemPrompt,
  buildMainUserPrompt,
} from '../src/services/mainAgentService.js';
import { getAgentProfileBundle } from '../src/services/agentProfileLoaderService.js';

const ALL_USERS = ['jay', 'jackson', 'jason'];
const ALL_PERSONAS = ['main-agent', 'main-agent-coach', 'main-agent-buddy'];

function parseArgs(argv) {
  const result = { user: null, persona: null, combo: null };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key in result) result[key] = value;
  }
  return result;
}

function buildCombos({ user, persona, combo }) {
  if (combo === 'all') {
    const list = [];
    for (const u of ALL_USERS) {
      for (const p of ALL_PERSONAS) {
        list.push({ userId: u, personaId: p });
      }
    }
    return list;
  }
  if (user && persona) {
    return [{ userId: user, personaId: persona }];
  }
  // 默认：3 个用户配 3 套人设的对角组合，已经能体现分层差异
  return [
    { userId: 'jay', personaId: 'main-agent' },
    { userId: 'jackson', personaId: 'main-agent-coach' },
    { userId: 'jason', personaId: 'main-agent-buddy' },
  ];
}

function divider(title) {
  const line = '='.repeat(80);
  return `\n${line}\n${title}\n${line}`;
}

function previewOne({ userId, personaId }) {
  const bundle = getAgentProfileBundle({ userId, personaId });
  const systemPrompt = buildLayeredSystemPrompt({
    persona: bundle.persona,
    userProfile: bundle.userProfile,
    longTermMemory: bundle.longTermMemory,
    preferences: bundle.preferences,
  });
  const userPrompt = buildMainUserPrompt({
    taskId: `preview_${userId}_${personaId}`,
    userId,
    userQuery: '盲僧前期入侵反野，对面是豹女，怎么打？',
    source: 'preview_script',
    rag: { summary: '盲僧前期 2/3 级入侵节奏强；豹女 1 级 W 减速反制能力强。' },
    shortMemory: { summary: '上一回合用户提到中路劣势。' },
    longTermMemory: bundle.longTermMemory,
    userProfile: bundle.userProfile,
    dynamicSummary: '当前观察：对面打野去蓝buff方向。',
  });

  console.log(divider(`组合: user=${userId} persona=${personaId}`));
  console.log('\n--- 已加载的层级数据摘要 ---');
  console.log(JSON.stringify({
    persona: { id: bundle.persona.id, name: bundle.persona.name, role: bundle.persona.role },
    userProfile: {
      user_id: bundle.userProfile.user_id,
      rank: `${bundle.userProfile.game_profile?.rank_tier}${bundle.userProfile.game_profile?.rank_division || ''}`,
      preferred_roles: bundle.userProfile.game_profile?.preferred_roles,
      detail_level: bundle.userProfile.communication_preferences?.detail_level,
    },
    longTermMemory: {
      facts: bundle.longTermMemory.facts,
      preferences: bundle.longTermMemory.preferences,
      avoidances: bundle.longTermMemory.avoidances,
    },
    preferences_llm_main: bundle.preferences.llm?.main_agent,
  }, null, 2));

  console.log('\n--- 最终 System Prompt ---');
  console.log(systemPrompt);

  console.log('\n--- 配套 User Prompt（首条 user 消息）---');
  console.log(userPrompt);
}

function main() {
  const args = parseArgs(process.argv);
  const combos = buildCombos(args);
  console.log(`即将预览 ${combos.length} 个 (user × persona) 组合\n`);
  for (const combo of combos) {
    previewOne(combo);
  }
  console.log(divider('预览结束'));
}

main();
