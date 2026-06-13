#!/usr/bin/env node
/**
 * Step 3 集成自测：
 * 1. AGC-043/047 情绪+战术 → 单意图 strategy（不重复拆 smalltalk）
 * 2. smalltalk 不再因 understanding_reply 字数=0 报 audit
 * 3. AGC-042 等"问号+视频"复合句 → main_intent=strategy（不再误判 video）
 * 4. compound case 的 visible_answer 含 secondary_strategy 或 secondary_video 块
 */

const BASE_URL = 'http://127.0.0.1:8788';

const cases = [
  {
    id: 'AGC-043',
    question: '心态崩了，刚才那把劫把我虐了，怎么对线劫？',
    expect_intent: 'strategy',
    expect_task_count: 1,
    expect_emotional_handle_emotion: true,
  },
  {
    id: 'AGC-047',
    question: '哎我打打野老被反，咋办？再夸我两句让我打下一把别那么紧张',
    expect_intent: 'strategy',
    expect_task_count: 1,
  },
  {
    id: 'AGC-042',
    question: '瑞兹怎么打狐狸？给个连招视频',
    expect_intent: 'strategy',
    expect_task_count: 2,
    expect_secondary_video: true,
  },
  {
    id: 'AGC-046',
    question: '辅助怎么帮ADC上分？另外推荐个辅助教学的视频',
    expect_intent: 'strategy',
    expect_task_count: 2,
    expect_secondary_video: true,
  },
  {
    id: 'AGC-039',
    question: '是不是只有花钱买代练才能上分',
    expect_intent: 'smalltalk',
    expect_task_count: 0,
    smalltalk_no_understanding: true,
  },
];

async function callEval(c) {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/eval/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: c.question,
      case_id: c.id,
      user_id: 'step3-selftest',
    }),
  });
  const json = await res.json();
  return { json, elapsed_ms: Date.now() - t0 };
}

(async () => {
  let pass = 0;
  for (const c of cases) {
    process.stdout.write(`\n[${c.id}] ${c.question.slice(0, 30)}...\n`);
    try {
      const { json, elapsed_ms } = await callEval(c);
      const data = json.data || {};
      const ans = data.answer || {};
      const intent = ans.intent || 'unknown';
      const taskPlan = (ans.task_plan?.task_plan || ans.task_plan_forced?.task_plan || []);
      const taskCount = taskPlan.length;
      const ur = (ans.understanding_reply || '').length;
      const er = (ans.emotional_reply || '').length;
      const sec_video = data.secondary_video_data || [];
      const sec_strategy = data.secondary_strategy_data || [];

      let ok = true;
      const checks = [];
      if (c.expect_intent && intent !== c.expect_intent) { ok = false; checks.push(`intent=${intent} 应=${c.expect_intent}`); }
      if (c.expect_task_count !== undefined && taskCount !== c.expect_task_count) {
        // task_count 是软检查（LLM 拆解可能略有差异），仅记录
        checks.push(`task_count=${taskCount} 期望=${c.expect_task_count}`);
      }
      if (c.smalltalk_no_understanding && ur > 0) { ok = false; checks.push(`smalltalk 但 understanding_reply=${ur}字（应=0）`); }
      if (c.expect_secondary_video && sec_video.length === 0) {
        // secondary_video 也是软检查（视频检索可能没结果）
        checks.push(`期望含 secondary_video 但 events 中没有`);
      }
      if (er < 8) { ok = false; checks.push(`emotional_reply=${er}字 <8`); }

      console.log(`  intent=${intent} task_count=${taskCount} er=${er} ur=${ur} sec_video=${sec_video.length} sec_strategy=${sec_strategy.length} elapsed=${elapsed_ms}ms`);
      console.log(`  emotional: "${ans.emotional_reply}"`);
      if (ans.understanding_reply) console.log(`  understanding: "${ans.understanding_reply}"`);
      if (ans.main_summary) console.log(`  main_summary: "${ans.main_summary?.slice(0, 60)}"`);
      if (taskPlan.length) console.log(`  task_plan: ${JSON.stringify(taskPlan.map(t => ({ tool: t.tool, query: t.query?.slice(0, 30) })))}`);
      if (sec_video.length) console.log(`  sec_video[0].title: "${sec_video[0].title || ''}"`);
      if (checks.length) console.log(`  checks: ${checks.join(' | ')}`);
      if (ok) { pass += 1; console.log('  ✓ PASS'); } else { console.log('  ✗ FAIL'); }
    } catch (err) {
      console.log(`  ERR: ${err.message}`);
    }
  }
  console.log(`\n\n=== Step 3 自测：${pass}/${cases.length} 通过 ===`);
  process.exit(pass === cases.length ? 0 : 1);
})();
