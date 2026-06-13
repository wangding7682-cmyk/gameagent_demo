#!/usr/bin/env node
/**
 * 聚合 RTC startVoiceChat 端到端时延日志。
 *
 * 输入：
 *   --frontend <path>   前端 console 日志（DevTools Console → 右键 Save as.. 或全选复制到文件）
 *   --backend  <path>   后端 stdout 日志（建议运行：npm start > backend.log 2>&1）
 *   --out      <path>   输出 markdown 报告（默认 ./rtc-timing-report.md）
 *
 * 关联键：userQuery（前端 ASR final=true 的文本 与 后端 CustomLLM 的 userQuery 文本匹配）
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------- 命令行参数 ----------------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      out[k.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const frontendPath = args.frontend;
const backendPath = args.backend;
const outPath = args.out || './rtc-timing-report.md';

if (!frontendPath || !backendPath) {
  console.error('用法: node aggregate-rtc-timing.mjs --frontend <fe.log> --backend <be.log> [--out report.md]');
  process.exit(1);
}

const feText = fs.readFileSync(frontendPath, 'utf8');
const beText = fs.readFileSync(backendPath, 'utf8');

// ---------------- 正则提取 ----------------
const RE_ASR = /\[RtcTiming:ASR\]\s+arrivedAt=(\d+)\s+deltaMs=(\d+)\s+final=(true|false)\s+text="([^"]*)"/g;
const RE_TTS_PUB = /\[RtcTiming:TTS\]\s+publishedAt=(\d+)\s+userId=(\S+)\s+mediaType=(\d+)/g;
const RE_TTS_EAR = /\[RtcTiming:TTS\]\s+firstAudible\s+userId=(\S+)\s+tag=(\S+)\s+ttsToEarMs=(\d+)\s+\(publishedAt=(\d+)\s+audibleAt=(\d+)\)/g;
const RE_BE_IN = /\[RtcTiming:CustomLLM\]\s+arrivedAt=(\d+)\s+sessionId=(\S+)\s+userQuery="([^"]*)"/g;
const RE_BE_FIRST = /\[RtcLlmBridge:TTS\]\s+chunk#1\s+\(main_reply\)\s+latency=(\d+)ms\s+sinceArrivedMs=(\d+)ms\s+\|\s+speech="([^"]*)"/g;
const RE_BE_DONE = /\[RtcLlmBridge\]\s+===\s+orchestration done\s+===\s+totalLatency=(\d+)ms\s+sinceArrivedMs=(\d+)ms\s+ttsChunks=(\d+)/g;

function collectAll(re, text, mapper) {
  const arr = [];
  let m;
  while ((m = re.exec(text)) !== null) arr.push(mapper(m));
  return arr;
}

// 前端事件
const feAsr = collectAll(RE_ASR, feText, (m) => ({
  ts: Number(m[1]), deltaMs: Number(m[2]), isFinal: m[3] === 'true', text: m[4],
}));
const fePub = collectAll(RE_TTS_PUB, feText, (m) => ({
  ts: Number(m[1]), userId: m[2], mediaType: Number(m[3]),
}));
const feEar = collectAll(RE_TTS_EAR, feText, (m) => ({
  userId: m[1], tag: m[2], ttsToEarMs: Number(m[3]),
  publishedAt: Number(m[4]), audibleAt: Number(m[5]),
}));

// 后端事件
const beIn = collectAll(RE_BE_IN, beText, (m) => ({
  ts: Number(m[1]), sessionId: m[2], userQuery: m[3],
}));
const beFirst = collectAll(RE_BE_FIRST, beText, (m) => ({
  agentLatency: Number(m[1]), sinceArrivedMs: Number(m[2]), speech: m[3],
}));
const beDone = collectAll(RE_BE_DONE, beText, (m) => ({
  totalLatency: Number(m[1]), sinceArrivedMs: Number(m[2]), ttsChunks: Number(m[3]),
}));

// ---------------- 轮次聚合 ----------------
// 按后端 CustomLLM 入口为锚点：每个 beIn 对应一轮
// 关联策略：
//   - 前端 ASR：取最近一个 isFinal=true 且 text == userQuery 的，否则 fallback 取该 userQuery 文本最近匹配
//   - 后端 first chunk / done：按 beIn 顺序对齐
//   - 前端 publishedAt / firstAudible：取 beIn 之后的第一个

const rounds = beIn.map((entry, idx) => {
  // 前端 ASR：文本完全匹配优先；否则取时间最接近且 final=true
  const exact = feAsr.filter((a) => a.isFinal && a.text === entry.userQuery);
  let asr = exact[exact.length - 1];
  if (!asr) {
    const finals = feAsr.filter((a) => a.isFinal && a.ts <= entry.ts);
    asr = finals[finals.length - 1];
  }

  const first = beFirst[idx];
  const done = beDone[idx];

  const pub = fePub.find((p) => p.ts >= entry.ts);
  const ear = feEar.find((e) => e.publishedAt >= entry.ts);

  // 端到端拆解（时间为正才算可信）
  const T0 = asr?.ts ?? null;             // 用户说完
  const T1 = entry.ts;                    // 火山把请求送到后端
  const T2 = first ? T1 + first.sinceArrivedMs : null; // Agent 首句吐出（后端时钟）
  const T3 = pub?.ts ?? null;             // 前端拿到对端流
  const T4 = ear?.audibleAt ?? null;      // 耳朵首音

  return {
    idx: idx + 1,
    sessionId: entry.sessionId,
    userQuery: entry.userQuery,
    speech: first?.speech ?? '',
    seg: {
      asrAndForward: T0 != null ? T1 - T0 : null,         // ASR + 火山转发后端
      agentInfer: first?.sinceArrivedMs ?? null,           // Agent 推理首句（后端内部）
      ttsAndPushBack: T2 != null && T3 != null ? T3 - T2 : null, // TTS 合成 + 火山推回浏览器
      pullToEar: ear?.ttsToEarMs ?? null,                  // 拉流到耳朵首音
      endToEnd: T0 != null && T4 != null ? T4 - T0 : null, // 端到端
    },
    raw: { T0, T1, T2, T3, T4, totalAgent: done?.totalLatency ?? null },
  };
});

// ---------------- 渲染 markdown ----------------
function fmt(v) { return v == null ? 'N/A' : `${v}ms`; }

const lines = [];
lines.push(`# RTC startVoiceChat 端到端时延报告`);
lines.push('');
lines.push(`- 前端日志: \`${path.resolve(frontendPath)}\``);
lines.push(`- 后端日志: \`${path.resolve(backendPath)}\``);
lines.push(`- 轮次数: **${rounds.length}**`);
lines.push('');
lines.push('## 分轮明细');
lines.push('');
lines.push('| # | userQuery | ASR+转发 | Agent推理 | TTS+回流 | 拉流到耳朵 | **端到端** |');
lines.push('|---|---|---|---|---|---|---|');
for (const r of rounds) {
  lines.push(`| ${r.idx} | ${r.userQuery} | ${fmt(r.seg.asrAndForward)} | ${fmt(r.seg.agentInfer)} | ${fmt(r.seg.ttsAndPushBack)} | ${fmt(r.seg.pullToEar)} | **${fmt(r.seg.endToEnd)}** |`);
}
lines.push('');

// 简单聚合
function avg(arr) {
  const xs = arr.filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}
const segs = ['asrAndForward', 'agentInfer', 'ttsAndPushBack', 'pullToEar', 'endToEnd'];
const avgs = Object.fromEntries(segs.map((k) => [k, avg(rounds.map((r) => r.seg[k]))]));

lines.push('## 平均值');
lines.push('');
lines.push('| 分段 | 均值 | SLA 参照 |');
lines.push('|---|---|---|');
lines.push(`| ASR + 火山转发 | ${fmt(avgs.asrAndForward)} | 估算 300-600ms |`);
lines.push(`| **Agent 推理首句** | ${fmt(avgs.agentInfer)} | **硬约束 ≤1000ms** |`);
lines.push(`| TTS 合成 + 火山推回浏览器 | ${fmt(avgs.ttsAndPushBack)} | 估算 200-400ms |`);
lines.push(`| 拉流到耳朵首音 | ${fmt(avgs.pullToEar)} | 估算 100-300ms |`);
lines.push(`| **端到端（说完→听到首字）** | **${fmt(avgs.endToEnd)}** | 期望 1.4-2.0s |`);
lines.push('');

// SLA 违反告警
const breaches = rounds.filter((r) => Number.isFinite(r.seg.agentInfer) && r.seg.agentInfer > 1000);
if (breaches.length) {
  lines.push('## ⚠️ SLA 违反（Agent 推理 >1000ms）');
  lines.push('');
  for (const r of breaches) {
    lines.push(`- 第 ${r.idx} 轮 \`${r.userQuery}\` → ${r.seg.agentInfer}ms`);
  }
  lines.push('');
}

fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`✓ 已生成报告: ${path.resolve(outPath)}`);
console.log(`  共解析 ${rounds.length} 轮 / 端到端均值 ${fmt(avgs.endToEnd)} / Agent 推理均值 ${fmt(avgs.agentInfer)}`);
