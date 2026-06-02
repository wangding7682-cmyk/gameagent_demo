#!/usr/bin/env node

/**
 * Auto-Eval Lite for Game AI Assistant (MVP) - Node.js Edition
 *
 * Usage:
 *   node run_eval.mjs --cases data/cases.jsonl [--mock] [--predictions data/predictions.jsonl]
 *   node run_eval.mjs --cases data/cases.jsonl --mock
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const SERVER_ROOT = path.resolve(__dirname, '..');

const { config } = await import(
  'file:///' + path.resolve(SERVER_ROOT, 'volc-aigc-rtc-server/src/config.js').replace(/\\/g, '/')
);
const { callArkChat, extractJsonObject } = await import(
  'file:///' + path.resolve(SERVER_ROOT, 'volc-aigc-rtc-server/src/services/arkChatService.js').replace(/\\/g, '/')
);

const ARK_HOST = config.ark?.host || process.env.ARK_HOST || 'ark.cn-beijing.volces.com';
const ARK_API_KEY = config.ark?.apiKey || process.env.ARK_API_KEY || '';
const ARK_CHAT_MODEL = config.ark?.chatModel || process.env.ARK_CHAT_MODEL || 'ep-20260430103756-7wgz4';
const EVAL_AGENT_URL = process.env.EVAL_AGENT_URL || 'http://127.0.0.1:8788/api/eval/generate';
const JUDGE_TEMPERATURE = 0.1;
const JUDGE_MAX_TOKENS = 2048;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { cases: null, predictions: null, mock: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cases' && args[i + 1]) opts.cases = args[++i];
    else if (args[i] === '--predictions' && args[i + 1]) opts.predictions = args[++i];
    else if (args[i] === '--mock') opts.mock = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: node run_eval.mjs --cases <cases.jsonl> [--predictions <preds.jsonl>] [--mock]`);
      process.exit(0);
    }
  }
  if (!opts.cases) {
    console.error('[ERROR] 必须指定 --cases 参数');
    console.log('Usage: node run_eval.mjs --cases <cases.jsonl> [--predictions <preds.jsonl>] [--mock]');
    process.exit(1);
  }
  return opts;
}

function loadCases(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
  const raw = fs.readFileSync(resolved, 'utf-8');
  const cases = [];
  let lineNum = 0;
  for (const line of raw.split('\n')) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const caseObj = JSON.parse(trimmed);
      if (!caseObj.id) throw new Error(`missing 'id' at line ${lineNum}`);
      if (!caseObj.question) throw new Error(`missing 'question' at line ${lineNum}`);
      cases.push(caseObj);
    } catch (e) {
      console.warn(`[WARN] 跳过无效行 ${lineNum}: ${e.message}`);
    }
  }
  return cases;
}

function loadPredictions(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
  const raw = fs.readFileSync(resolved, 'utf-8');
  const preds = {};
  let lineNum = 0;
  for (const line of raw.split('\n')) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      if (item.id) preds[item.id] = item;
    } catch (e) {
      console.warn(`[WARN] 跳过无效 prediction 行 ${lineNum}: ${e.message}`);
    }
  }
  return preds;
}

function loadJudgePrompt() {
  return fs.readFileSync(path.join(PROJECT_ROOT, 'prompts', 'judge_prompt.txt'), 'utf-8');
}

async function callJudgeLlm(userPrompt) {
  const result = await callArkChat({
    systemPrompt: loadJudgePrompt(),
    userPrompt,
    temperature: JUDGE_TEMPERATURE,
    maxTokens: JUDGE_MAX_TOKENS,
  });
  try {
    return extractJsonObject(result.content);
  } catch (e) {
    return { raw: result.content, parse_error: true };
  }
}

function buildJudgeInput(caseObj, prediction) {
  const answerObj = prediction.answer || {};
  const visibleAnswer = prediction.visible_answer || '';
  const actualIntent = prediction.actual_intent || 'unknown';
  const expectedIntent = caseObj.expected_intent || 'unspecified';
  const goldenPoints = caseObj.golden_points || [];
  const goldenStr = goldenPoints.length > 0
    ? goldenPoints.map(p => `- ${p}`).join('\n')
    : '无';

  return [
    `【Case ID】\n${caseObj.id}`,
    `【主维度】\n${caseObj.dimension || 'unknown'}`,
    `【用户问题】\n${caseObj.question}`,
    `【参考要点】\n${goldenStr}`,
    `【是否必须拒绝不当部分】\n${String(caseObj.must_refuse ?? false).toLowerCase()}`,
    `【实际路由意图】\n${actualIntent}`,
    `【期望路由意图】\n${expectedIntent}`,
    `【候选回答】\n${visibleAnswer || JSON.stringify(answerObj, null, 2)}`,
  ].join('\n\n');
}

async function generatePredictionViaAgent(caseObj) {
  const payload = {
    case_id: caseObj.id,
    question: caseObj.question,
    user_id: caseObj.user_id || 'default',
  };
  try {
    const resp = await fetch(EVAL_AGENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      console.log(`  [FAIL] Agent HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    if (!data.ok) {
      console.log(`  [FAIL] Agent 返回错误: ${data.message}`);
      return null;
    }
    return data.data || null;
  } catch (e) {
    if (e.name === 'TimeoutError') {
      console.log(`  [FAIL] Agent 调用超时 (${EVAL_AGENT_URL})`);
    } else if (e.code === 'ECONNREFUSED') {
      console.log(`  [FAIL] 无法连接 Agent 服务 (${EVAL_AGENT_URL})，请确认服务已启动`);
    } else {
      console.log(`  [FAIL] Agent 调用异常: ${e.message}`);
    }
    return null;
  }
}

function mockJudge() {
  const dims = [
    'tactical_quality', 'structural_compliance', 'tone_authenticity',
    'emotional_boundary', 'conciseness',
  ];
  return {
    dimension_scores: Object.fromEntries(dims.map(d => [d, 7])),
    overall_score: 7,
    verdict: 'pass',
    reason: '[MOCK] 模拟评分结果',
    improvement_suggestions: ['建议1：补充量化数据', '建议2：优化结构'],
    risk_tags: ['mock'],
  };
}

function mockPrediction(caseObj) {
  return {
    id: caseObj.id,
    answer: {
      intent: 'strategy',
      emotional_reply: '这问题问得好',
      understanding_reply: '你在问战术打法',
      main_summary: '[MOCK] 模拟回答内容',
      branch_wait_reply: '',
    },
    actual_intent: 'strategy',
    visible_answer: '[MOCK] 模拟回答内容',
  };
}

function computeSummary(results) {
  if (!results.length) return { total: 0 };

  const dimKeys = [
    'tactical_quality', 'structural_compliance', 'tone_authenticity',
    'emotional_boundary', 'conciseness',
  ];
  const total = results.length;
  const passCount = results.filter(r => r.verdict === 'pass').length;
  const failCount = total - passCount;

  const dimAvgs = {};
  for (const d of dimKeys) {
    const scores = results
      .filter(r => r.dimension_scores)
      .map(r => r.dimension_scores[d] ?? 0);
    dimAvgs[d] = scores.length > 0
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
      : 0;
  }

  const overallScores = results.map(r => r.overall_score ?? 0);
  const avgOverall = overallScores.length > 0
    ? Math.round((overallScores.reduce((a, b) => a + b, 0) / overallScores.length) * 100) / 100
    : 0;

  const lowScoreCases = results
    .filter(r => (r.overall_score ?? 10) <= 5)
    .slice(0, 10)
    .map(r => ({
      case_id: r.case_id,
      overall_score: r.overall_score,
      verdict: r.verdict,
      reason: r.reason || '',
    }));

  const riskTagCounts = {};
  for (const r of results) {
    for (const tag of (r.risk_tags || [])) {
      riskTagCounts[tag] = (riskTagCounts[tag] || 0) + 1;
    }
  }

  const routeResults = results.filter(r => r.expected_intent);
  const routeMatchCount = routeResults.filter(r => r.route_match).length;
  const routeMismatches = routeResults
    .filter(r => !r.route_match)
    .map(r => ({
      case_id: r.case_id,
      expected: r.expected_intent,
      actual: r.actual_intent,
      question: r.question,
    }));

  return {
    total,
    pass: passCount,
    fail: failCount,
    pass_rate: total > 0 ? Math.round(passCount / total * 1000) / 10 : 0,
    avg_overall_score: avgOverall,
    dimension_averages: dimAvgs,
    low_score_cases: lowScoreCases,
    risk_tag_summary: riskTagCounts,
    routing_accuracy: {
      total_routed: routeResults.length,
      matched: routeMatchCount,
      mismatched: routeMismatches.length,
      rate: routeResults.length > 0
        ? Math.round(routeMatchCount / routeResults.length * 1000) / 10
        : null,
      mismatches: routeMismatches,
    },
  };
}

function ensureRunDir(runId) {
  const dir = path.join(PROJECT_ROOT, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs();
  const now = new Date();
  const runId = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const runDir = ensureRunDir(runId);

  console.log(`[Auto-Eval] Run ID: ${runId}`);
  console.log(`[Auto-Eval] 输出目录: ${runDir}`);

  const cases = loadCases(opts.cases);
  console.log(`[Auto-Eval] 加载 ${cases.length} 条评测样本`);

  const predictionsMap = {};
  if (opts.predictions) {
    Object.assign(predictionsMap, loadPredictions(opts.predictions));
    console.log(`[Auto-Eval] 加载 ${Object.keys(predictionsMap).length} 条已有预测答案`);
  }

  if (!opts.mock && !opts.predictions) {
    console.log(`[Auto-Eval] 正在调用 Agent 生成预测答案...`);
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      process.stdout.write(`  [${i + 1}/${cases.length}] 生成 ${c.id} ...`);
      const pred = await generatePredictionViaAgent(c);
      if (pred) {
        predictionsMap[c.id] = pred;
        console.log(` OK (intent=${pred.actual_intent})`);
      } else {
        console.log(' FAIL');
      }
      if (i < cases.length - 1) await sleep(300);
    }
  }

  const judgeFn = opts.mock ? mockJudge : async (_case, _pred, input) => callJudgeLlm(input);
  const getPred = opts.mock
    ? (c) => mockPrediction(c)
    : (c) => predictionsMap[c.id] || null;

  const results = [];
  const failures = [];

  console.log(`\n[Auto-Eval] 开始 Judge 打分（${opts.mock ? 'MOCK' : 'LLM'}模式）...`);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const pred = getPred(c);

    if (!pred && !opts.mock) {
      failures.push({ case_id: c.id, question: c.question, error: '无预测答案' });
      console.log(`  [${i + 1}/${cases.length}] ${c.id}: SKIP (无预测)`);
      continue;
    }

    const judgeInput = buildJudgeInput(c, pred);
    process.stdout.write(`  [${i + 1}/${cases.length}] ${c.id} ...`);

    try {
      const scoreResult = await judgeFn(c, pred, judgeInput);
      const actualIntent = pred?.actual_intent || null;
      const expectedIntent = c.expected_intent || null;
      const routeMatch = !expectedIntent || !actualIntent || expectedIntent === actualIntent;
      const entry = {
        case_id: c.id,
        dimension: c.dimension,
        question: c.question,
        must_refuse: c.must_refuse ?? false,
        expected_intent: expectedIntent,
        actual_intent: actualIntent,
        route_match: routeMatch,
        ...scoreResult,
      };
      results.push(entry);
      console.log(` ${scoreResult.verdict} (overall=${scoreResult.overall_score})`);
    } catch (e) {
      failures.push({ case_id: c.id, question: c.question, error: String(e) });
      console.log(` FAIL (${e.message})`);
    }

    if (i < cases.length - 1 && !opts.mock) await sleep(500);
  }

  const summary = computeSummary(results);

  fs.writeFileSync(
    path.join(runDir, 'config.json'),
    JSON.stringify({
      run_id: runId,
      timestamp: new Date().toISOString(),
      cases_path: opts.cases,
      predictions_path: opts.predictions || '(auto-generated)',
      mode: opts.mock ? 'mock' : 'llm',
      judge_model: ARK_CHAT_MODEL,
      total_cases: cases.length,
      judged_count: results.length,
      failure_count: failures.length,
    }, null, 2),
    'utf-8'
  );

  fs.writeFileSync(
    path.join(runDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
    'utf-8'
  );

  fs.writeFileSync(
    path.join(runDir, 'judged_results.jsonl'),
    results.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utf-8'
  );

  if (failures.length > 0) {
    fs.writeFileSync(
      path.join(runDir, 'judge_failures.jsonl'),
      failures.map(f => JSON.stringify(f)).join('\n') + '\n',
      'utf-8'
    );
  }

  console.log('\n' + '='.repeat(50));
  console.log('[Auto-Eval] 完成！结果摘要:');
  console.log(`  总数: ${summary.total} | 通过: ${summary.pass} | 失败: ${summary.fail}`);
  console.log(`  通过率: ${summary.pass_rate}% | 均分: ${summary.avg_overall_score}`);
  console.log('  维度均分:');
  for (const [dim, avg] of Object.entries(summary.dimension_averages || {})) {
    console.log(`    ${dim}: ${avg}`);
  }
  if (summary.low_score_cases?.length) {
    console.log('  低分案例 (≤5分):');
    for (const c of summary.low_score_cases) {
      console.log(`    ${c.case_id}: overall=${c.overall_score} [${c.verdict}] ${c.reason}`);
    }
  }

  const ra = summary.routing_accuracy;
  if (ra && ra.total_routed > 0) {
    console.log(`  路由准确性: ${ra.matched}/${ra.total_routed} (${ra.rate}%)`);
    if (ra.mismatches?.length) {
      console.log('  路由不匹配案例:');
      for (const m of ra.mismatches) {
        console.log(`    ${m.case_id}: 期望=${m.expected} 实际=${m.actual} | ${m.question}`);
      }
    }
  }
  console.log('='.repeat(50));
  console.log(`结果目录: ${runDir}`);
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
