import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const RUNS_DIR = path.join(ROOT, 'runs');
const REPORTS_DIR = path.join(ROOT, 'reports');

const BASE_50_RUN = '20260613_005936';
const TARGETED_21_RUN = '20260613_224944';
const AGC044_RETEST_RUN = '20260613_232639';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadRun(runId) {
  const dir = path.join(RUNS_DIR, runId);
  return {
    runId,
    config: readJson(path.join(dir, 'config.json')),
    summary: readJson(path.join(dir, 'summary.json')),
    judged: readJsonl(path.join(dir, 'judged_results.jsonl')),
  };
}

function rowKey(row) {
  return `${row.case_id}::${row.track}`;
}

function mergeRows(baseRows, overrideRows) {
  const map = new Map();
  for (const row of baseRows) map.set(rowKey(row), { ...row, source_run: BASE_50_RUN });
  for (const row of overrideRows) map.set(rowKey(row), { ...row, source_run: TARGETED_21_RUN });
  return [...map.values()].sort((a, b) => {
    const id = String(a.case_id).localeCompare(String(b.case_id));
    if (id !== 0) return id;
    return String(a.track).localeCompare(String(b.track));
  });
}

function applyRetest(rows, retestRows) {
  const map = new Map(rows.map((row) => [rowKey(row), row]));
  for (const row of retestRows) {
    const key = rowKey({ ...row, case_id: 'AGC-044' });
    map.set(key, {
      ...row,
      case_id: 'AGC-044',
      source_run: AGC044_RETEST_RUN,
      note: 'AGC-044 single-case current-version retest applied',
    });
  }
  return [...map.values()].sort((a, b) => {
    const id = String(a.case_id).localeCompare(String(b.case_id));
    if (id !== 0) return id;
    return String(a.track).localeCompare(String(b.track));
  });
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function aggregate(rows) {
  const byTrack = {};
  const byCaseMap = new Map();
  const auditSummary = new Map();

  for (const row of rows) {
    const track = row.track || 'unknown';
    if (!byTrack[track]) {
      byTrack[track] = {
        total: 0,
        pass: 0,
        fail: 0,
        scores: [],
        dimSums: {},
        dimCounts: {},
        low_score_cases: [],
      };
    }
    const stat = byTrack[track];
    stat.total += 1;
    if (row.verdict === 'pass') stat.pass += 1;
    else stat.fail += 1;
    stat.scores.push(Number(row.overall_score) || 0);
    for (const [dim, score] of Object.entries(row.dimension_scores || {})) {
      stat.dimSums[dim] = (stat.dimSums[dim] || 0) + (Number(score) || 0);
      stat.dimCounts[dim] = (stat.dimCounts[dim] || 0) + 1;
    }
    if (row.verdict !== 'pass' || Number(row.overall_score) < 7) {
      stat.low_score_cases.push({
        case_id: row.case_id,
        overall_score: row.overall_score,
        verdict: row.verdict,
        reason: row.reason || '',
      });
    }
    for (const flag of row.audit_flags || []) {
      auditSummary.set(flag, (auditSummary.get(flag) || 0) + 1);
    }

    if (!byCaseMap.has(row.case_id)) {
      byCaseMap.set(row.case_id, {
        case_id: row.case_id,
        question: row.question,
        expected_intent: row.expected_intent,
        actual_intent: row.actual_intent,
        tracks: {},
        source_runs: new Set(),
      });
    }
    const caseItem = byCaseMap.get(row.case_id);
    caseItem.tracks[row.track] = {
      overall_score: row.overall_score,
      verdict: row.verdict,
      audit_count: Array.isArray(row.audit_flags) ? row.audit_flags.length : 0,
      parse_error: Boolean(row.parse_error),
      source_run: row.source_run,
    };
    caseItem.source_runs.add(row.source_run);
  }

  const finalByTrack = {};
  for (const [track, stat] of Object.entries(byTrack)) {
    const dimensionAverages = {};
    for (const [dim, sum] of Object.entries(stat.dimSums)) {
      dimensionAverages[dim] = round(sum / stat.dimCounts[dim]);
    }
    finalByTrack[track] = {
      total: stat.total,
      pass: stat.pass,
      fail: stat.fail,
      pass_rate: round((stat.pass / stat.total) * 100, 1),
      avg_overall_score: round(average(stat.scores)),
      dimension_averages: dimensionAverages,
      low_score_cases: stat.low_score_cases,
    };
  }

  const byCase = {};
  for (const [caseId, caseItem] of byCaseMap.entries()) {
    const scores = Object.values(caseItem.tracks).map((track) => Number(track.overall_score) || 0);
    byCase[caseId] = {
      ...caseItem,
      source_runs: [...caseItem.source_runs].filter(Boolean),
      avg_overall: round(average(scores)),
    };
  }

  const rowsWithScore = rows.map((row) => Number(row.overall_score) || 0);
  const routingRows = [...byCaseMap.values()].filter((item) => item.expected_intent);
  const routingMatched = routingRows.filter((item) => item.expected_intent === item.actual_intent).length;
  const compoundRows = rows.filter((row) => row.track === 'compound');
  const compoundPass = compoundRows.filter((row) => row.verdict === 'pass').length;

  return {
    total_cases: byCaseMap.size,
    judged_rows: rows.length,
    grand_avg_overall: round(average(rowsWithScore)),
    parse_error_count: rows.filter((row) => row.parse_error).length,
    by_track: finalByTrack,
    by_case: byCase,
    audit_summary: [...auditSummary.entries()].map(([flag, count]) => ({ flag, count })),
    routing_accuracy: {
      total_routed: routingRows.length,
      matched: routingMatched,
      mismatched: routingRows.length - routingMatched,
      rate: routingRows.length ? round((routingMatched / routingRows.length) * 100, 1) : 0,
    },
    compound_decomposition_accuracy: {
      compound_judged: compoundRows.length,
      correctly_decomposed: compoundPass,
      rate: compoundRows.length ? round((compoundPass / compoundRows.length) * 100, 1) : 0,
    },
  };
}

function caseIds(rows) {
  return new Set(rows.map((row) => row.case_id));
}

function formatTrackTable(byTrack) {
  const order = ['main_fast', 'strategy', 'video', 'compound', 'smalltalk', 'silence', 'conversation'];
  const tracks = Object.keys(byTrack).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return [
    '| Track | Total | Pass | Fail | Pass Rate | Avg |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...tracks.map((track) => {
      const item = byTrack[track];
      return `| ${track} | ${item.total} | ${item.pass} | ${item.fail} | ${item.pass_rate}% | ${item.avg_overall_score} |`;
    }),
  ].join('\n');
}

function formatLowScoreCases(summary, maxItems = 20) {
  const rows = [];
  for (const [track, stat] of Object.entries(summary.by_track)) {
    for (const item of stat.low_score_cases || []) {
      rows.push({ track, ...item });
    }
  }
  rows.sort((a, b) => (Number(a.overall_score) || 0) - (Number(b.overall_score) || 0));
  if (!rows.length) return '无';
  return [
    '| Case | Track | Score | Verdict | Reason |',
    '| --- | --- | ---: | --- | --- |',
    ...rows.slice(0, maxItems).map((row) => `| ${row.case_id} | ${row.track} | ${row.overall_score} | ${row.verdict} | ${String(row.reason || '').replace(/\|/g, '/')} |`),
  ].join('\n');
}

function markdownReport({ baseRun, targetedRun, retestRun, strictSummary, currentSummary, overlapIds }) {
  return `# Auto-Eval 合并评测报告

## 口径说明
- 基准 50 条：run \`${baseRun.runId}\`，文件 \`${baseRun.config.cases_path}\`。
- 覆盖 21 条：run \`${targetedRun.runId}\`，文件 \`${targetedRun.config.cases_path}\`。
- 覆盖规则：先以 50 条为底表，再按 \`case_id + track\` 用 21 条结果覆盖重叠项；重叠 case 数：${overlapIds.length}。
- 当前版本补充：\`AGC-044\` 在 21 条后有单条 video 复测 run \`${retestRun.runId}\`，用于反映 stickyHero / 抖音“连招”污染修复后的当前结果。

## 严格合并结果
- 总 Case：${strictSummary.total_cases}
- Judged Rows：${strictSummary.judged_rows}
- Grand Avg Overall：${strictSummary.grand_avg_overall}
- Routing Accuracy：${strictSummary.routing_accuracy.matched}/${strictSummary.routing_accuracy.total_routed}，${strictSummary.routing_accuracy.rate}%
- Compound Accuracy：${strictSummary.compound_decomposition_accuracy.correctly_decomposed}/${strictSummary.compound_decomposition_accuracy.compound_judged}，${strictSummary.compound_decomposition_accuracy.rate}%

${formatTrackTable(strictSummary.by_track)}

## 当前版本补充后
- 总 Case：${currentSummary.total_cases}
- Judged Rows：${currentSummary.judged_rows}
- Grand Avg Overall：${currentSummary.grand_avg_overall}
- Routing Accuracy：${currentSummary.routing_accuracy.matched}/${currentSummary.routing_accuracy.total_routed}，${currentSummary.routing_accuracy.rate}%
- Compound Accuracy：${currentSummary.compound_decomposition_accuracy.correctly_decomposed}/${currentSummary.compound_decomposition_accuracy.compound_judged}，${currentSummary.compound_decomposition_accuracy.rate}%

${formatTrackTable(currentSummary.by_track)}

## 低分与失败项
${formatLowScoreCases(currentSummary)}

## 关键结论
- 21 条 targeted 覆盖后，近期重点链路 \`main_fast / compound / strategy / silence\` 已明显高于原 50 条基准。
- \`AGC-013 / AGC-059 / AGC-063\` 在最新 targeted smoke 和 21 条覆盖中均已回升，compound secondary 与 strategy 弱命中模板稳定。
- \`AGC-044\` 在严格 21 条合并口径中仍保留旧 run 的 \`video=6\`，但当前版本单条复测已修正为 \`video=9\`，且副视频 query / 抖音改写词不再含 \`亚索\` 或 \`连招\`。
- 剩余主要风险仍集中在未被 21 条覆盖的旧 50 条 case：通用 strategy 量化不足、早期 main_fast 信息密度/字段边界问题、少量旧 smalltalk 风格问题。

## 产物
- JSON 汇总：\`reports/merged_eval_report_20260613_current.json\`
- Markdown 报告：\`reports/merged_eval_report_20260613_current.md\`
`;
}

const baseRun = loadRun(BASE_50_RUN);
const targetedRun = loadRun(TARGETED_21_RUN);
const retestRun = loadRun(AGC044_RETEST_RUN);

const baseIds = caseIds(baseRun.judged);
const targetedIds = caseIds(targetedRun.judged);
const overlapIds = [...targetedIds].filter((id) => baseIds.has(id)).sort();

const strictRows = mergeRows(baseRun.judged, targetedRun.judged);
const currentRows = applyRetest(strictRows, retestRun.judged);
const strictSummary = aggregate(strictRows);
const currentSummary = aggregate(currentRows);

fs.mkdirSync(REPORTS_DIR, { recursive: true });
const payload = {
  generated_at: new Date().toISOString(),
  merge_policy: {
    base_50_run: BASE_50_RUN,
    targeted_21_run: TARGETED_21_RUN,
    overlap_case_count: overlapIds.length,
    overlap_case_ids: overlapIds,
    current_version_supplement_run: AGC044_RETEST_RUN,
    note: 'strict_merged uses 50 base + 21 override; current_version additionally applies AGC-044 single-case video retest.',
  },
  strict_merged: strictSummary,
  current_version: currentSummary,
};

fs.writeFileSync(
  path.join(REPORTS_DIR, 'merged_eval_report_20260613_current.json'),
  JSON.stringify(payload, null, 2),
  'utf8',
);

fs.writeFileSync(
  path.join(REPORTS_DIR, 'merged_eval_report_20260613_current.md'),
  markdownReport({ baseRun, targetedRun, retestRun, strictSummary, currentSummary, overlapIds }),
  'utf8',
);

console.log(JSON.stringify({
  report_json: path.join(REPORTS_DIR, 'merged_eval_report_20260613_current.json'),
  report_md: path.join(REPORTS_DIR, 'merged_eval_report_20260613_current.md'),
  strict: {
    total_cases: strictSummary.total_cases,
    judged_rows: strictSummary.judged_rows,
    grand_avg_overall: strictSummary.grand_avg_overall,
    routing_accuracy: strictSummary.routing_accuracy,
    compound_decomposition_accuracy: strictSummary.compound_decomposition_accuracy,
  },
  current_version: {
    total_cases: currentSummary.total_cases,
    judged_rows: currentSummary.judged_rows,
    grand_avg_overall: currentSummary.grand_avg_overall,
    routing_accuracy: currentSummary.routing_accuracy,
    compound_decomposition_accuracy: currentSummary.compound_decomposition_accuracy,
  },
}, null, 2));
