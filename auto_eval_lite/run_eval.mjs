#!/usr/bin/env node

/**
 * Auto-Eval Lite for Game AI Assistant - 双轨评测版
 *
 * 双轨：
 *   - 快路径（main_fast）：Main_Agent 4 字段
 *   - 慢路径（strategy / video / smalltalk / compound）：子 Agent 输出
 *
 * 用法:
 *   node run_eval.mjs --cases data/cases.jsonl [--mock] [--predictions data/predictions.jsonl]
 *   node run_eval.mjs --cases data/cases.jsonl --tracks main_fast,strategy
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

const DEFAULT_ARK_CHAT_MODEL = config.ark?.chatModel || process.env.ARK_CHAT_MODEL || 'ep-20260430103756-7wgz4';
const EVAL_AGENT_URL = process.env.EVAL_AGENT_URL || 'http://127.0.0.1:8788/api/eval/generate';
const JUDGE_TEMPERATURE = 0.1;
const JUDGE_MAX_TOKENS = 2048;

const TRACK_DIM_KEYS = {
  main_fast: ['field_compliance', 'intent_grounding', 'routing_accuracy', 'naturalness', 'latency_fitness'],
  strategy: ['tactical_correctness', 'quantification', 'avoid_pitfalls', 'conclusion_first', 'voice_friendliness'],
  video: ['query_rewrite_quality', 'platform_adaptation', 'semantic_relevance', 'result_completeness', 'routing_correctness'],
  smalltalk: ['emotional_acknowledgement', 'playful_tone', 'light_advice', 'conciseness', 'routing_correctness'],
  compound: ['decomposition_correctness', 'tool_coverage', 'subquery_purity', 'entity_preservation', 'output_completeness'],
  silence: ['restraint_score', 'context_appropriateness', 'length_compliance', 'no_hallucination', 'tone_softness'],
  conversation: ['topic_continuity', 'drift_control', 'topic_recovery', 'context_grounding', 'soulfulness'],
};

const TRACK_PROMPT_FILE = {
  main_fast: 'judge_main_fast.txt',
  strategy: 'judge_strategy.txt',
  video: 'judge_video.txt',
  smalltalk: 'judge_smalltalk.txt',
  compound: 'judge_compound.txt',
  silence: 'judge_silence.txt',
  conversation: 'judge_conversation.txt',
};

const _promptCache = {};
function loadJudgePrompt(track) {
  if (_promptCache[track]) return _promptCache[track];
  const file = TRACK_PROMPT_FILE[track];
  if (!file) throw new Error(`Unknown track: ${track}`);
  const text = fs.readFileSync(path.join(PROJECT_ROOT, 'prompts', file), 'utf-8');
  _promptCache[track] = text;
  return text;
}

function parseArgs() {
  const args = process.argv.slice(2);
  // profile: 评测样本分层
  //   - daily（默认）：日常回归小集，仅跑 _eval_only.profile === 'daily' 的 case（约 15 条），用于每日 PR 自检
  //   - full：全量评测集，跑全部 case（50+ 条），仅在重大版本 / 架构升级时使用
  //   - 注：通过 _eval_only.profile 字段在 cases.jsonl 内联标注，单文件维护避免 source-of-truth 分裂
  const opts = { cases: null, predictions: null, mock: false, tracks: null, profile: 'daily', model: null, resume: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cases' && args[i + 1]) opts.cases = args[++i];
    else if (args[i] === '--predictions' && args[i + 1]) opts.predictions = args[++i];
    else if (args[i] === '--mock') opts.mock = true;
    else if (args[i] === '--tracks' && args[i + 1]) opts.tracks = args[++i].split(',').map(s => s.trim());
    else if (args[i] === '--profile' && args[i + 1]) opts.profile = String(args[++i]).trim().toLowerCase();
    else if (args[i] === '--model' && args[i + 1]) opts.model = String(args[++i]).trim();
    else if (args[i] === '--resume' && args[i + 1]) opts.resume = String(args[++i]).trim();
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: node run_eval.mjs --cases <cases.jsonl> [--predictions <preds.jsonl>] [--mock] [--tracks main_fast,strategy,video,smalltalk,compound,silence,conversation] [--profile daily|full] [--model <model-endpoint-id>] [--resume <runId>]`);
      console.log(`  --profile daily（默认）：仅跑 _eval_only.profile==='daily' 的小集（约 15 条，PR 自检用）`);
      console.log(`  --profile full：跑全部 case（50+ 条，重大版本评测用）`);
      console.log(`  --model <endpoint-id>：覆盖 Judge LLM 模型（默认读取 config.json 或 env ARK_CHAT_MODEL）`);
      console.log(`  --resume <runId>：从指定 run 的 checkpoint 恢复（如 --resume 20260612_000436）`);
      process.exit(0);
    }
  }
  if (!opts.cases) {
    console.error('[ERROR] 必须指定 --cases 参数');
    process.exit(1);
  }
  if (!['daily', 'full'].includes(opts.profile)) {
    console.error(`[ERROR] --profile 只支持 daily | full，实际=${opts.profile}`);
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
      // proactive_check 模式（silence 评测）允许 question 为空
      const allowEmptyQuestion = caseObj.mode === 'proactive_check';
      if (!caseObj.id || (!caseObj.question && !allowEmptyQuestion)) {
        throw new Error(`missing id/question at line ${lineNum}`);
      }
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

function cnLen(s) {
  return (s ?? '').toString().length;
}

// ============== 子轨 audit 前置（P1：把客观硬规则用代码先判，传给 Judge 钳制主观分） ==============

// video 改写词正则审计（与 videoAgentService 设计约束对齐）
const VIDEO_AUDIT_REGEX = {
  TEACH: /(教学|详解|思路|攻略|进阶|教程)/,
  ACTION: /(实战|连招)/,
  HIGHLIGHT: /(高光|集锦|速看)/,
  LONG_TERMS: /(详解|系统|体系|进阶|版本)/,
};

function getEffectiveVideoBundle(pred = {}) {
  const secVideoArr = Array.isArray(pred.secondary_video_data) ? pred.secondary_video_data : [];
  const secVideo = secVideoArr[0] || null;
  const vd = pred.video_data || secVideo || {};
  const secQueries = secVideo?.video_queries || {};
  const inferredQuery = secVideo?.video_query || secVideo?.query || '';
  const vq = pred.video_queries || (secVideo ? {
    generic: secQueries.generic || inferredQuery,
    bilibili: secQueries.bilibili || inferredQuery,
    douyin: secQueries.douyin || inferredQuery,
  } : {});
  const videoQuery = pred.video_query || inferredQuery || '';
  const source = pred.video_data ? 'main' : (secVideo ? 'secondary' : 'none');
  return { vd, vq, videoQuery, source, secVideo };
}

function buildVideoAuditFlags(caseObj, pred) {
  const flags = [];
  // compound 场景：主路由=strategy 时 video 走 secondary，需回退读取
  const { vd, vq, source } = getEffectiveVideoBundle(pred);
  const isCompound = caseObj.expected_compound === true || (pred.task_plan?.mode === 'compound');
  // B站改写词必须含教学风格词
  if (vq.bilibili && !VIDEO_AUDIT_REGEX.TEACH.test(vq.bilibili)) {
    flags.push(`bilibili 改写词缺教学风格词(教学/详解/思路/攻略/进阶/教程): "${vq.bilibili}"`);
  }
  // 抖音改写词必须含动作词
  if (vq.douyin && !VIDEO_AUDIT_REGEX.ACTION.test(vq.douyin)) {
    flags.push(`douyin 改写词缺动作词(实战/连招): "${vq.douyin}"`);
  }
  // 抖音改写词必须含高光词
  if (vq.douyin && !VIDEO_AUDIT_REGEX.HIGHLIGHT.test(vq.douyin)) {
    flags.push(`douyin 改写词缺高光词(高光/集锦/速看): "${vq.douyin}"`);
  }
  // 抖音必须剥离长视频词
  if (vq.douyin && VIDEO_AUDIT_REGEX.LONG_TERMS.test(vq.douyin)) {
    flags.push(`douyin 改写词未剥离长视频词(详解/系统/体系/进阶/版本): "${vq.douyin}"`);
  }
  // linkUrl 非空（检索是否成功）
  if (!vd.linkUrl) {
    flags.push(`video_data.linkUrl 为空（检索结果未落地）`);
  }
  // 字段完整性
  if (!vd.title) flags.push('video_data.title 为空');
  if (!vd.summary) flags.push('video_data.summary 为空');
  // 路由正确性
  if (!isCompound && caseObj.expected_intent === 'video' && pred.actual_intent !== 'video') {
    flags.push(`actual_intent=${pred.actual_intent} 与 expected=video 不符`);
  }
  if (isCompound && source === 'none') {
    flags.push('compound 场景未找到 main 或 secondary video 输出');
  }
  return flags;
}

// strategy 字数硬规则 + golden_points 命中率（与 strategyAgentService 设计约束对齐）
function buildStrategyAuditFlags(caseObj, pred) {
  const flags = [];
  // compound 场景：主路由=video 时 strategy 走 secondary，需回退读取
  const secStrategyArr = Array.isArray(pred.secondary_strategy_data) ? pred.secondary_strategy_data : [];
  const td = pred.tactic_data || secStrategyArr[0] || {};
  // title 字数 ≤ 24
  if (td.title && cnLen(td.title) > 24) {
    flags.push(`tactic_data.title 字数=${cnLen(td.title)} 超 24`);
  }
  if (!td.title) flags.push('tactic_data.title 为空');
  // details 条数 3-5
  if (Array.isArray(td.details)) {
    if (td.details.length === 0) {
      flags.push('tactic_data.details 为空');
    } else if (td.details.length > 5) {
      flags.push(`tactic_data.details 条数=${td.details.length} 超 5`);
    } else if (td.details.length < 3) {
      flags.push(`tactic_data.details 条数=${td.details.length} 不足 3`);
    }
    td.details.forEach((d, i) => {
      if (cnLen(d) > 24) flags.push(`details[${i}] 字数=${cnLen(d)} 超 24`);
    });
  } else {
    flags.push('tactic_data.details 缺失或非数组');
  }
  // avoid_pitfalls 条数 2-3（新增字段）
  if (Array.isArray(td.avoid_pitfalls)) {
    if (td.avoid_pitfalls.length > 3) {
      flags.push(`tactic_data.avoid_pitfalls 条数=${td.avoid_pitfalls.length} 超 3`);
    } else if (td.avoid_pitfalls.length < 2) {
      flags.push(`tactic_data.avoid_pitfalls 条数=${td.avoid_pitfalls.length} 不足 2`);
    }
  }
  // voice_chunks 每条 ≤ 36
  if (Array.isArray(td.voice_chunks)) {
    td.voice_chunks.forEach((v, i) => {
      if (cnLen(v) > 36) flags.push(`voice_chunks[${i}] 字数=${cnLen(v)} 超 36`);
    });
  }
  // golden_points 命中率（增强版：多级模糊匹配 + 数值归一化 + 语义片匹配）
  // 过滤掉评测元信息（"路由 X"、"B站改写词..."、"抖音改写词..."、"核心实体..."）
  const gps = Array.isArray(caseObj.golden_points) ? caseObj.golden_points.filter(p => {
    const s = String(p);
    // 排除评测元信息关键词
    if (/^(路由|B站改写词|抖音改写词|核心实体|golden)/i.test(s)) return false;
    // 排除含"改写词"、"golden"、"命中"等评测指令的条目
    if (/改写词|golden|命中/.test(s)) return false;
    return true;
  }) : [];
  if (gps.length) {
    const corpus = [
      td.title || '',
      ...(Array.isArray(td.details) ? td.details : []),
      ...(Array.isArray(td.voice_chunks) ? td.voice_chunks : []),
      ...(Array.isArray(td.avoid_pitfalls) ? td.avoid_pitfalls : []),
    ].join(' ');

    // 数值归一化：将中文数字转为阿拉伯数字，便于模糊匹配
    // 例如 "六"→"6", "二十"→"20", "三级"→"3级"
    const normalizeNumbers = (text) => String(text)
      .replace(/一二三四五六七八九零/g, (m) => '零一二三四五六七八九'.indexOf(m))
      .replace(/十/g, '0')  // 特殊处理 "十" 在数字前后的场景
      .replace(/零/g, '0');

    // 战术意图关键词：核心动作 + 时间/数量修饰语
    // 扩展匹配范围：加入"优先"/"尽量"/"尽量不"/"不要"/"别"/"不要"等
    const TACTICAL_INTENT_REGEX = /[\u4e00-\u9fa5]{1,4}(分钟|级|秒|时|之前|之后|前|后|优先|尽量|别|不要|别去|先|等|推|控|开|打|拿|守|站|蹲|插|换|清|刷|收|拉|聚|交|等)/g;

    // 关键战术片：3-6字的战术核心词（去掉括号和修饰）
    const CORE_TACTICAL_PATTERNS = [
      /(?:优先|尽量|别|不要|先|再|就|才|还)/,  // 修饰词开头
      /(?:有线权|无视野|有控制|有技能|没技能|弱势期|强势期|六级前|六级后|三分钟前|三分钟后)/,
      /(?:硬抓|软抓|速推|慢推|控线|推线|清线|补刀|发育|反野|入侵|换线|换资源)/,
    ];

    const hits = gps.filter(p => {
      const s = String(p);
      // 1. 前4字匹配（放宽到4字，比之前3字更鲁棒）
      const key4 = s.slice(0, 4);
      if (key4.length >= 4 && corpus.includes(key4)) return true;

      // 2. 前6字匹配（处理长关键词）
      const key6 = s.slice(0, 6);
      if (key6.length >= 6 && corpus.includes(key6)) return true;

      // 3. 数值归一化后匹配（"六"匹配"6"，"二十"匹配"20"）
      const normS = normalizeNumbers(s);
      const normCorpus = normalizeNumbers(corpus);
      if (normS.length >= 4) {
        // 归一化后检查前4字
        const normKey4 = normS.slice(0, 4);
        if (normKey4 && normCorpus.includes(normKey4)) return true;
        // 归一化后检查前6字
        const normKey6 = normS.slice(0, 6);
        if (normKey6 && normKey6.length >= 6 && normCorpus.includes(normKey6)) return true;
      }

      // 4. 战术关键词片匹配（核心动作词出现即命中）
      // 例如：golden="有线权再开龙"，output="有优势就拿龙" → 都有"权"+"龙"隐含战术意图
      const tacticalKeywords = s.match(TACTICAL_INTENT_REGEX);
      if (tacticalKeywords) {
        // 至少匹配2个战术词，或1个时间词+1个动作词
        const timeWords = ['分钟', '级', '秒', '时', '之前', '之后', '前', '后'];
        let matchedTime = 0;
        let matchedAction = 0;
        for (const kw of tacticalKeywords) {
          if (timeWords.some(t => kw.includes(t))) matchedTime++;
          else matchedAction++;
        }
        // 匹配条件：至少2个战术词，或1时间词+1动作词
        if (matchedTime + matchedAction >= 2 || (matchedTime >= 1 && matchedAction >= 1)) {
          // 但要求 corpus 中至少有对应的战术词出现
          const corpusHasTime = timeWords.some(t => corpus.includes(t));
          const corpusHasAction = ['推', '控', '开', '打', '拿', '守', '站', '蹲', '插', '换', '清', '刷', '收', '拉', '聚'].some(a => corpus.includes(a));
          if ((matchedTime > 0 && corpusHasTime) || (matchedAction > 0 && corpusHasAction)) return true;
        }
      }

      // 5. 核心战术片断匹配：检查 corpus 是否包含 golden 的关键子串（≥4字的连续片段）
      // 提取 golden 中的连续4字以上片段，看 corpus 是否有匹配
      const coreSubstrs = [];
      for (let i = 0; i <= s.length - 4; i++) {
        coreSubstrs.push(s.slice(i, i + 4));
      }
      // 取最长的连续片段优先匹配
      coreSubstrs.sort((a, b) => b.length - a.length);
      for (const substr of coreSubstrs.slice(0, 5)) { // 最多检查前5个片段
        if (substr.length >= 4 && corpus.includes(substr)) return true;
      }

      return false;
    });
    const rate = `${hits.length}/${gps.length}`;
    flags.push(`golden_coverage_hit_rate=${rate}（增强模糊匹配：前4字+前6字+数值归一化+战术片断+意图片匹配）`);
    if (gps.length >= 2 && hits.length === 0) {
      flags.push(`golden_coverage 完全未命中（${gps.length} 个 golden_points 全 miss）`);
    }
  }
  return flags;
}

function formatAuditBlock(flags) {
  if (!flags || !flags.length) return '【audit_flags】\n(无硬规则违规)';
  return `【audit_flags】\n${flags.map(f => `- ${f}`).join('\n')}`;
}

// ============== 双轨数据装配 ==============

function pickTracksForCase(caseObj) {
  // 显式指定优先
  if (Array.isArray(caseObj.tracks) && caseObj.tracks.length) {
    // silence 场景：通过 _eval_only.track_override 或 dimension 自动追加 silence 轨
    const tracks = [...caseObj.tracks];
    const isSilence = caseObj._eval_only?.track_override === 'silence'
      || caseObj.dimension === 'silence_appropriateness';
    if (isSilence && !tracks.includes('silence')) tracks.push('silence');
    return tracks;
  }
  // 根据 expected_intent / dimension 推断
  const intent = caseObj.expected_intent;
  const tracks = ['main_fast'];
  if (caseObj.expected_compound) tracks.push('compound');
  if (intent === 'strategy') tracks.push('strategy');
  else if (intent === 'video') tracks.push('video');
  else if (intent === 'smalltalk') tracks.push('smalltalk');
  if (caseObj._eval_only?.track_override === 'silence'
      || caseObj.dimension === 'silence_appropriateness') {
    if (!tracks.includes('silence')) tracks.push('silence');
  }
  return tracks;
}

function buildJudgeInputMainFast(caseObj, pred) {
  const ans = pred.answer || {};
  const er = ans.emotional_reply || '';
  const ur = ans.understanding_reply || '';
  const ms = ans.main_summary || '';
  const bw = ans.branch_wait_reply || '';
  const isSilence = caseObj._eval_only?.track_override === 'silence'
    || caseObj.dimension === 'silence_appropriateness';
  const evalOnly = caseObj._eval_only || {};
  return [
    `【Case ID】\n${caseObj.id}`,
    isSilence ? `【特殊评测口径】\nsilence 场景的 main_fast 以克制不打扰为优先，不适用普通 smalltalk 的 8-16 字 emotional_reply 与 10-120 字 main_summary 下限；总字数不超过 ${evalOnly.max_total_chars ?? 8} 更优。` : '',
    `【用户问题】\n${caseObj.question}`,
    `【期望路由意图】\n${caseObj.expected_intent || 'unspecified'}`,
    `【实际路由意图】\n${pred.actual_intent || 'unknown'}`,
    `【emotional_reply】(${cnLen(er)} 字)\n${er}`,
    `【understanding_reply】(${cnLen(ur)} 字)\n${ur}`,
    `【main_summary】(${cnLen(ms)} 字)\n${ms}`,
    `【branch_wait_reply】(${cnLen(bw)} 字)\n${bw}`,
  ].filter(Boolean).join('\n\n');
}

function buildJudgeInputStrategy(caseObj, pred) {
  // compound 场景：主路由=video 时 strategy 走 secondary，需回退读取
  const secStrategyArr = Array.isArray(pred.secondary_strategy_data) ? pred.secondary_strategy_data : [];
  const td = pred.tactic_data || secStrategyArr[0] || {};
  const tdSource = pred.tactic_data ? 'main' : (secStrategyArr[0] ? 'secondary' : 'none');
  const isCompound = caseObj.expected_compound === true || (pred.task_plan?.mode === 'compound');
  const strategyGoldenPoints = (caseObj.golden_points || []).filter((point) => {
    const text = String(point || '');
    if (/^\[策略\]/.test(text)) return true;
    if (/^\[(编排|视频|静默|场景|语气)\]/.test(text)) return false;
    return !isCompound;
  }).map((point) => String(point).replace(/^\[策略\]\s*/, ''));
  const golden = strategyGoldenPoints.map(p => `- ${p}`).join('\n') || '无';
  const auditFlags = buildStrategyAuditFlags(caseObj, pred);
  const avoidPitfalls = Array.isArray(td.avoid_pitfalls) ? td.avoid_pitfalls : [];
  return [
    `【Case ID】\n${caseObj.id}`,
    `【用户问题】\n${caseObj.question}`,
    isCompound ? '【特殊评测口径】\n这是 compound case 的 strategy 子轨，只评 tactic_data 是否解决策略子任务；task_plan 拆解、video 子任务与视频改写词已由 compound/video 轨评测，不能在本轨重复扣分。' : '',
    `【参考要点 golden_points】\n${golden}`,
    `【tactic_data 来源】${tdSource}${isCompound ? '（compound 场景下 secondary_strategy_data 即为策略子任务输出，主路由可为 strategy 或 video）' : ''}`,
    `【tactic_data.title】(${cnLen(td.title)} 字)\n${td.title || '(空)'}`,
    `【tactic_data.details】(${Array.isArray(td.details) ? td.details.length : 0} 条)\n${Array.isArray(td.details) ? td.details.map(d => `- ${d}（${cnLen(d)}字）`).join('\n') : '(空)'}`,
    `【tactic_data.avoid_pitfalls】(${avoidPitfalls.length} 条)\n${avoidPitfalls.length ? avoidPitfalls.map(p => `- ${p}（${cnLen(p)}字）`).join('\n') : '(无避坑指南)'}`,
    `【tactic_data.voice_chunks】(${Array.isArray(td.voice_chunks) ? td.voice_chunks.length : 0} 条)\n${Array.isArray(td.voice_chunks) ? td.voice_chunks.map(v => `- ${v}（${cnLen(v)}字）`).join('\n') : '(空)'}`,
    formatAuditBlock(auditFlags),
  ].filter(Boolean).join('\n\n');
}

function buildJudgeInputVideo(caseObj, pred) {
  // compound 场景：主路由=strategy 时 video 走 secondary，需回退读取
  const { vd, vq, videoQuery, source: vdSource } = getEffectiveVideoBundle(pred);
  const isCompound = caseObj.expected_compound === true || (pred.task_plan?.mode === 'compound');
  const auditFlags = buildVideoAuditFlags(caseObj, pred);
  return [
    `【Case ID】\n${caseObj.id}`,
    `【用户问题】\n${caseObj.question}`,
    `【实际路由意图】\n${pred.actual_intent || 'unknown'}${isCompound ? '（compound 场景：video 子任务在 secondary 旁路执行，实际路由可为 strategy 或 video）' : ''}`,
    `【video_query】\n${videoQuery || '(空)'}`,
    `【video_queries.generic】\n${vq.generic || '(空)'}`,
    `【video_queries.bilibili】\n${vq.bilibili || '(空)'}`,
    `【video_queries.douyin】\n${vq.douyin || '(空)'}`,
    `【video_data 来源】${vdSource}${isCompound ? '（compound 场景下 secondary_video_data 即为视频子任务输出）' : ''}`,
    `【video_data.title】\n${vd.title || '(空)'}`,
    `【video_data.summary】\n${vd.summary || '(空)'}`,
    `【video_data.linkUrl】\n${vd.linkUrl || '(空)'}`,
    `【video_data.source_platform】\n${vd.source_platform || '(空)'}`,
    formatAuditBlock(auditFlags),
  ].join('\n\n');
}

function buildJudgeInputSmalltalk(caseObj, pred) {
  const ans = pred.answer || {};
  const golden = (caseObj.golden_points || []).map(p => `- ${p}`).join('\n') || '无';
  return [
    `【Case ID】\n${caseObj.id}`,
    `【用户问题】\n${caseObj.question}`,
    `【参考要点 golden_points】\n${golden}`,
    `【期望路由意图】\n${caseObj.expected_intent || 'unspecified'}`,
    `【实际路由意图】\n${pred.actual_intent || 'unknown'}`,
    `【emotional_reply】(${cnLen(ans.emotional_reply)} 字)\n${ans.emotional_reply || '(空)'}`,
    `【main_summary】(${cnLen(ans.main_summary)} 字)\n${ans.main_summary || '(空)'}`,
  ].join('\n\n');
}

function buildJudgeInputSilence(caseObj, pred) {
  const ans = pred.answer || {};
  const er = ans.emotional_reply || '';
  const ur = ans.understanding_reply || '';
  const ms = ans.main_summary || '';
  const bw = ans.branch_wait_reply || '';
  const totalChars = cnLen(er) + cnLen(ur) + cnLen(ms) + cnLen(bw);
  const ses = caseObj.context?.screen_event_state || {};
  const screenLine = `last_game=${ses.last_game || '?'} | last_scene=${ses.last_scene || '?'} | hp=${ses.last_hp_pct ?? '?'} | events=${(ses.recent_events || []).map(e => e.type).join(',') || '(空)'}`;
  const golden = (caseObj.golden_points || []).map(p => `- ${p}`).join('\n') || '无';
  const evalOnly = caseObj._eval_only || {};
  return [
    `【Case ID】\n${caseObj.id}`,
    `【场景说明】\n这是 silence 评测：玩家在高强度操作或大厅场景下只是发了语气词/无效问题，AI 应当克制不打扰。`,
    `【用户问题】\n${caseObj.question || '(空)'}`,
    `【屏幕画面快照】\n${screenLine}`,
    `【参考要点 golden_points】\n${golden}`,
    `【期望最大字数 max_total_chars】\n${evalOnly.max_total_chars ?? 8}`,
    `【实际路由意图】\n${pred.actual_intent || 'unknown'}`,
    `【输出总字数】\n${totalChars}`,
    `【emotional_reply】(${cnLen(er)} 字)\n${er || '(空)'}`,
    `【understanding_reply】(${cnLen(ur)} 字)\n${ur || '(空)'}`,
    `【main_summary】(${cnLen(ms)} 字)\n${ms || '(空)'}`,
    `【branch_wait_reply】(${cnLen(bw)} 字)\n${bw || '(空)'}`,
  ].join('\n\n');
}

function buildJudgeInputConversation(caseObj, pred) {
  const priorTurns = Array.isArray(caseObj.prior_turns) ? caseObj.prior_turns : [];
  const priorLines = priorTurns.length
    ? priorTurns.map((turn, i) => [
        `  [${i + 1}] user_query=${turn.user_query || turn.question || ''}`,
        `      intent=${turn.intent || 'unknown'}`,
        `      summary=${turn.summary || turn.main_summary || ''}`,
        turn.rag_summary ? `      rag_summary=${turn.rag_summary}` : '',
      ].filter(Boolean).join('\n')).join('\n')
    : '(无)';
  const expectation = caseObj.conversation_expectation || {};
  const ans = pred.answer || {};
  const td = pred.tactic_data || {};
  const visible = pred.visible_answer || pred.fast_path_reply || '';
  const golden = (caseObj.golden_points || []).map(p => `- ${p}`).join('\n') || '无';
  return [
    `【Case ID】\n${caseObj.id}`,
    `【多轮场景类型】\n${expectation.scenario || 'unspecified'}`,
    `【历史轮次 prior_turns】\n${priorLines}`,
    `【当前用户问题】\n${caseObj.question}`,
    `【期望延续话题】\n${expectation.expected_topic || '(未标注)'}`,
    `【禁止脱轨方向】\n${(expectation.forbidden_topics || []).join(' / ') || '(无)'}`,
    `【参考要点 golden_points】\n${golden}`,
    `【实际路由意图】\n${pred.actual_intent || 'unknown'}`,
    `【emotional_reply】\n${ans.emotional_reply || '(空)'}`,
    `【understanding_reply】\n${ans.understanding_reply || '(空)'}`,
    `【main_summary】\n${ans.main_summary || '(空)'}`,
    `【branch_wait_reply】\n${ans.branch_wait_reply || '(空)'}`,
    `【tactic_data.title】\n${td.title || '(空)'}`,
    `【tactic_data.details】\n${Array.isArray(td.details) ? td.details.map(d => `- ${d}`).join('\n') : '(空)'}`,
    `【可见答案 visible_answer】\n${visible || '(空)'}`,
  ].join('\n\n');
}

function buildJudgeInputCompound(caseObj, pred) {
  // 双口径：主链路 task_plan（贴近线上行为）+ 评测旁路 task_plan_forced（绕开 smalltalk 短路）
  // 优先用主链路；为空时降级用 forced，judge_input 中明确标注以便归因
  const mainTp = pred.task_plan || {};
  const mainPlanArr = Array.isArray(mainTp.task_plan) ? mainTp.task_plan : [];
  const forcedTp = pred.task_plan_forced || {};
  const forcedPlanArr = Array.isArray(forcedTp.task_plan) ? forcedTp.task_plan : [];
  // 选择评测口径：主链路非空 → 主链路；否则取 forced
  const usingForced = mainPlanArr.length === 0 && forcedPlanArr.length > 0;
  const tp = usingForced ? forcedTp : mainTp;
  const planArr = usingForced ? forcedPlanArr : mainPlanArr;

  const expectedTools = caseObj.expected_tools || [];
  const expectedCount = caseObj.expected_task_count || expectedTools.length || 1;
  const actualTools = planArr.map(t => t.tool || t.intent || 'unknown');
  const planLines = planArr.map((t, i) => `  [${i + 1}] tool=${t.tool || t.intent} | query="${t.query || ''}"`).join('\n') || '(空)';
  // 主路径数据缺失时，回退用 secondary 子任务数据（compound 场景：主路由=strategy 时 video 走旁路）
  const secStrategyArr = Array.isArray(pred.secondary_strategy_data) ? pred.secondary_strategy_data : [];
  const secVideoArr = Array.isArray(pred.secondary_video_data) ? pred.secondary_video_data : [];
  const td = pred.tactic_data || secStrategyArr[0] || {};
  const vd = pred.video_data || secVideoArr[0] || {};
  const tdSource = pred.tactic_data ? 'main' : (secStrategyArr[0] ? 'secondary' : 'none');
  const vdSource = pred.video_data ? 'main' : (secVideoArr[0] ? 'secondary' : 'none');
  return [
    `【Case ID】\n${caseObj.id}`,
    `【用户问题】\n${caseObj.question}`,
    `【expected_task_count】\n${expectedCount}`,
    `【expected_tools】\n${JSON.stringify(expectedTools)}`,
    `【评测口径】\n${usingForced ? 'forced（主链路 task_plan 为空，已降级取强制旁路结果，评测仅评 TaskPlanner 拆解能力）' : 'main（主链路 task_plan，贴近线上真实路由后行为）'}`,
    `【主链路 task_plan.mode】\n${mainTp.mode || 'unknown'} | reason=${mainTp.reason || '(空)'} | len=${mainPlanArr.length}`,
    `【强制旁路 task_plan_forced.mode】\n${forcedTp.mode || 'unknown'} | reason=${forcedTp.reason || '(空)'} | len=${forcedPlanArr.length}`,
    `【生效 task_plan[]】\n${planLines}`,
    `【actual_tools】\n${JSON.stringify(actualTools)}`,
    `【tactic_data 摘要】(来源=${tdSource})\n${td.title ? `title=${td.title}; details_count=${(td.details || []).length}` : '(无)'}`,
    `【video_data 摘要】(来源=${vdSource})\n${vd.title ? `title=${vd.title}; linkUrl=${vd.linkUrl || ''}` : '(无)'}`,
    `【副任务统计】secondary_strategy=${secStrategyArr.length} 条, secondary_video=${secVideoArr.length} 条`,
  ].join('\n\n');
}

const TRACK_BUILDERS = {
  main_fast: buildJudgeInputMainFast,
  strategy: buildJudgeInputStrategy,
  video: buildJudgeInputVideo,
  smalltalk: buildJudgeInputSmalltalk,
  compound: buildJudgeInputCompound,
  silence: buildJudgeInputSilence,
  conversation: buildJudgeInputConversation,
};

// ============== 硬规则前置审计（在 LLM 之前打补丁） ==============

function preAuditMainFast(caseObj, pred) {
  const flags = [];
  const ans = pred.answer || {};
  const emotionalReply = String(ans.emotional_reply || '').trim();
  const understandingReply = String(ans.understanding_reply || '').trim();
  const mainSummary = String(ans.main_summary || '').trim();
  const branchWaitReply = String(ans.branch_wait_reply || '').trim();
  const combinedText = [emotionalReply, understandingReply, mainSummary, branchWaitReply].filter(Boolean).join(' ');
  const er = cnLen(ans.emotional_reply);
  const ur = cnLen(ans.understanding_reply);
  const ms = cnLen(ans.main_summary);
  const bw = cnLen(ans.branch_wait_reply);
  const intent = String(pred.actual_intent || '').toLowerCase();
  const userQuestion = String(caseObj.question || '').trim();
  const totalChars = cnLen(combinedText);
  const firstSentence = String(
    combinedText.split(/[。！？!?；;\n]/)[0] || combinedText
  ).trim();
  const lowerCombined = combinedText.toLowerCase();
  const hasStrategyAsset = Boolean(pred.tactic_data && pred.tactic_data.title);
  const hasVideoAsset = Boolean(pred.video_data && (pred.video_data.linkUrl || pred.video_data.videoUrl || pred.video_data.title));
  const isSilenceCase = caseObj._eval_only?.track_override === 'silence'
    || caseObj.dimension === 'silence_appropriateness';

  if (isSilenceCase) {
    const limit = caseObj._eval_only?.max_total_chars ?? 8;
    if (totalChars > limit) {
      flags.push(`main_fast_silence_length_error: silence 总字数=${totalChars} 超 ${limit}`);
    }
    if (ur > 0 || bw > 0 || ms > 0) {
      flags.push('main_fast_silence_leak: silence 场景不应填充 understanding/branch/main_summary');
    }
    return flags;
  }

  const strategyTerms = ['怎么打', '克制', '出装', '连招', '对线', '入侵', '阵容', '战术', '节奏', '思路', '打法', '卡片', '知识卡', '战术卡'];
  const videoTerms = ['视频', '集锦', '高光', '抖音', 'b站', 'bilibili', '教学视频', '操作演示'];
  const promiseTerms = ['整理后弹出', '找到后弹出', '稍后弹出', '给你弹', '继续筛', '筛视频', '找视频', '出卡片', '整理成卡片', '帮你整理'];
  const fakeCompletionTerms = ['已经帮你找到', '已经找到', '已经给你整理好', '已经整理好了', '链接在这', '视频发你', '卡片给你', '结果给你'];
  const slowContentPatterns = [
    /(第一|第二|第三|第四)[，、,:：]/,
    /(^|[。！？!?；;\n])\s*[1-3][\.、]/,
    /(一是|二是|三是|首先|其次|最后)/,
  ];
  const assetReadoutPatterns = [
    /要点[:：]/,
    /建议[:：]/,
    /如下[:：]/,
    /1[\.、].*2[\.、]/,
    /- .*\n- /,
  ];
  const explicitSlowRequest = strategyTerms.some((t) => userQuestion.includes(t)) || videoTerms.some((t) => userQuestion.toLowerCase().includes(t));
  const promiseTriggered = promiseTerms.some((t) => combinedText.includes(t));
  const fakeCompletionTriggered = fakeCompletionTerms.some((t) => combinedText.includes(t));
  const slowContentLeak = slowContentPatterns.some((re) => re.test(combinedText));
  const assetReadout = assetReadoutPatterns.some((re) => re.test(combinedText));

  if (er < 8 || er > 16) flags.push(`main_fast_field_length_error: emotional_reply 字数=${er} 越界(8-16)`);
  // 意图分流：smalltalk 时 understanding_reply / branch_wait_reply 应为空（情绪由 emotional_reply + main_summary 承接）
  if (intent === 'smalltalk') {
    if (ur > 0) flags.push(`main_fast_field_length_error: smalltalk 时 understanding_reply 应为空，实=${ur} 字`);
    if (bw > 0) flags.push(`main_fast_field_length_error: smalltalk 时 branch_wait_reply 应为空，实=${bw} 字`);
    if (ms < 10 || ms > 120) flags.push(`main_fast_field_length_error: smalltalk 时 main_summary 字数=${ms} 越界(10-120)`);
  } else if (['strategy', 'video'].includes(intent)) {
    if (ur < 18 || ur > 45) flags.push(`main_fast_field_length_error: ${intent} 时 understanding_reply 字数=${ur} 越界(18-45)`);
    if (bw < 16 || bw > 36) flags.push(`main_fast_field_length_error: ${intent} 时 branch_wait_reply 字数=${bw} 越界(16-36)`);
  }
  if (understandingReply.includes('用户想要')) flags.push('main_fast_customer_service_tone: understanding_reply 含禁用词"用户想要"');
  // 机械起手：纯确认词（无后续动作），如"好的""收到""明白"
  if (/^(收到|好的|好嘞|明白|哈哈|这就为你|安排上了)[，,。.;；!！]?$/.test(firstSentence)) {
    flags.push(`main_fast_mechanical_opener: 首句纯确认词起手="${firstSentence.slice(0, 12)}"`);
  }
  if (/根据您的描述|我来为你|请稍等|这就为你/.test(combinedText)) {
    flags.push('main_fast_customer_service_tone: 出现客服腔或机械服务表达');
  }
  if (slowContentLeak) {
    flags.push('main_fast_slow_content_leak: 首响提前展开子Agent慢内容，越过快路径职责边界');
  }
  if (assetReadout) {
    flags.push('main_fast_asset_body_readout: 首响出现卡片正文/列表条目/完整资产朗读痕迹');
  }
  if (fakeCompletionTriggered) {
    if (intent === 'video' && !hasVideoAsset) {
      flags.push('main_fast_fake_asset_completion: 首响声称视频结果已就绪，但系统尚无 video_data');
    } else if (intent === 'strategy' && !hasStrategyAsset) {
      flags.push('main_fast_fake_asset_completion: 首响声称策略/卡片已整理完成，但系统尚无 tactic_data');
    } else if (!['strategy', 'video'].includes(intent)) {
      flags.push('main_fast_fake_asset_completion: 非 strategy/video 场景却声称资产已完成');
    }
  }
  if (promiseTriggered && !explicitSlowRequest) {
    flags.push('main_fast_overcommit_branch_action: 用户未明确提出 strategy/video/card 诉求，却承诺后台整理/检索');
  }
  if (intent === 'smalltalk' && promiseTriggered) {
    flags.push('main_fast_overcommit_branch_action: smalltalk 场景不应承诺整理战术/筛视频/弹资产');
  }
  if ((intent === 'strategy' || intent === 'video') && totalChars > 90) {
    flags.push(`main_fast_excessive_detail_density: 首响总字数=${totalChars}，信息密度过高，不像快路径`);
  }
  if (lowerCombined.includes('http://') || lowerCombined.includes('https://') || lowerCombined.includes('www.')) {
    flags.push('main_fast_fake_asset_completion: 首响直接播报链接，疑似越权替代 video 子Agent交付');
  }
  return flags;
}

function preAuditVideo(caseObj, pred) {
  const flags = [];
  const { vd, vq } = getEffectiveVideoBundle(pred);
  const bili = vq.bilibili || '';
  const dy = vq.douyin || '';
  const teachTerms = ['教学', '详解', '思路', '攻略', '进阶', '教程'];
  const actionTerms = ['实战', '连招'];
  const longTerms = ['详解', '系统', '体系', '进阶', '版本'];
  if (bili && !teachTerms.some(t => bili.includes(t))) flags.push(`B站改写词缺教学风格词: ${bili}`);
  if (dy && !actionTerms.some(t => dy.includes(t))) flags.push(`抖音改写词缺动作词: ${dy}`);
  if (dy && longTerms.some(t => dy.includes(t))) flags.push(`抖音改写词残留长视频词: ${dy}`);
  if (!vd.linkUrl) flags.push('video_data.linkUrl 为空');
  return flags;
}

function preAuditSmalltalk(caseObj, pred) {
  const flags = [];
  const ans = pred.answer || {};
  const ms = ans.main_summary || '';
  if (cnLen(ms) === 0) flags.push('smalltalk 但 main_summary 为空（内容空值回归）');
  if (cnLen(ms) > 80) flags.push(`main_summary 超长 ${cnLen(ms)} 字（>80）`);
  if (/(用户想要|根据您的描述|作为您的 ?AI 助手)/.test(ms + (ans.emotional_reply || ''))) flags.push('出现 AI 客服腔禁用词');
  return flags;
}

function preAuditCompound(caseObj, pred) {
  const flags = [];
  // 双口径：优先看主链路 task_plan；为空降级看强制旁路 task_plan_forced
  const mainTp = pred.task_plan || {};
  const mainPlanArr = Array.isArray(mainTp.task_plan) ? mainTp.task_plan : [];
  const forcedTp = pred.task_plan_forced || {};
  const forcedPlanArr = Array.isArray(forcedTp.task_plan) ? forcedTp.task_plan : [];
  const usingForced = mainPlanArr.length === 0 && forcedPlanArr.length > 0;
  const planArr = usingForced ? forcedPlanArr : mainPlanArr;
  const expectedTools = caseObj.expected_tools || [];
  const expectedCount = caseObj.expected_task_count || expectedTools.length || 1;

  // 主链路完全空 → 标记为"路由失败导致 task_plan 缺失"，与"拆解能力失败"区分开
  if (mainPlanArr.length === 0) {
    flags.push(`主链路 task_plan 为空（路由短路：main_intent=${pred.actual_intent || 'unknown'}）`);
  }
  if (planArr.length !== expectedCount) flags.push(`task_plan 长度=${planArr.length} 与 expected=${expectedCount} 不符（口径=${usingForced ? 'forced' : 'main'}）`);
  const actualTools = planArr.map(t => t.tool || t.intent);
  for (const t of expectedTools) {
    if (!actualTools.includes(t)) flags.push(`期望工具 ${t} 未出现在 task_plan（口径=${usingForced ? 'forced' : 'main'}）`);
  }
  return flags;
}

function preAuditSilence(caseObj, pred) {
  const flags = [];
  const ans = pred.answer || {};
  const er = cnLen(ans.emotional_reply);
  const ur = cnLen(ans.understanding_reply);
  const ms = cnLen(ans.main_summary);
  const bw = cnLen(ans.branch_wait_reply);
  const total = er + ur + ms + bw;
  const limit = caseObj._eval_only?.max_total_chars ?? 8;
  if (total > limit) flags.push(`silence 输出总字数=${total} 超过期望上限 ${limit}（应当克制）`);
  if (bw > 0) flags.push(`silence 场景下 branch_wait_reply 应为空，实=${bw} 字（不应承诺子任务）`);
  // 防幻觉：高强度/大厅场景禁止编造战术词
  const fullText = `${ans.emotional_reply || ''}${ans.understanding_reply || ''}${ans.main_summary || ''}${ans.branch_wait_reply || ''}`;
  const tacticTerms = ['建议你', '首先', '其次', '应该先', '战术', '出装', '铭文'];
  const hit = tacticTerms.filter(t => fullText.includes(t));
  if (hit.length) flags.push(`silence 场景出现战术/说教词: ${hit.join(',')}`);
  return flags;
}

const PRE_AUDITORS = {
  main_fast: preAuditMainFast,
  strategy: () => [],
  video: preAuditVideo,
  smalltalk: preAuditSmalltalk,
  compound: preAuditCompound,
  silence: preAuditSilence,
  conversation: () => [],
};

// ============== 并发控制器（基于 RPM=30000/TPM=5000000） ==============
// Judge 调用滑动窗口：限制最大并发数，避免服务端过载
class SlidingWindowSemaphore {
  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
    this.totalDelay = 0; // 记录累计等待时间
  }

  async acquire() {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return true;
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.running--;
    if (this.queue.length > 0) {
      this.running++;
      const next = this.queue.shift();
      next();
    }
  }

  async withLock(asyncFn) {
    await this.acquire();
    try {
      return await asyncFn();
    } finally {
      this.release();
    }
  }
}

// Judge 并发限制器：RPM 30000 -> 保守按 1/10 设定并发上限，避免打满
const judgeSemaphore = new SlidingWindowSemaphore(3);

// ============== 调用 Judge LLM ==============

async function callJudgeLlm(track, userPrompt) {
  return judgeSemaphore.withLock(async () => {
    // 指数退避重试（最多 4 次：base + 3 retries，间隔 5s/10s/20s）
    // ark 接口默认 25s 超时（已调整），瞬时网络抖动需要重试保护评测完整性
    const maxAttempts = 4;
    const baseDelay = 5000;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await callArkChat({
          systemPrompt: loadJudgePrompt(track),
          userPrompt,
          temperature: JUDGE_TEMPERATURE,
          maxTokens: JUDGE_MAX_TOKENS,
        });
        try {
          return extractJsonObject(result.content);
        } catch (e) {
          return { raw: result.content, parse_error: true, track };
        }
      } catch (e) {
        lastErr = e;
        const msg = e.message || '';
        const causeMsg = e.cause?.message || '';
        // 检测瞬时错误或 429（服务器忙/限流）
        const isRetryable = /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR|请求超时|429|429 Too ManyRequests/i.test(msg)
          || /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(causeMsg);
        if (!isRetryable || attempt === maxAttempts) break;
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`    [WARN] Judge<${track}> 瞬时失败(${msg.slice(0, 50)})，${delay / 1000}s 后第 ${attempt + 1}/${maxAttempts} 次尝试...`);
        await sleep(delay);
      }
    }
    throw lastErr;
  });
}

function mockJudge(track) {
  const dims = TRACK_DIM_KEYS[track] || [];
  return {
    track,
    dimension_scores: Object.fromEntries(dims.map(d => [d, 7])),
    overall_score: 7,
    verdict: 'pass',
    reason: `[MOCK] ${track} 模拟评分`,
    improvement_suggestions: ['mock 建议'],
    risk_tags: ['mock'],
  };
}

async function generatePredictionViaAgent(caseObj) {
  // 带 screen_event_state 的 case 使用独立 user_id（case_id 后缀）天然隔离会话黑板，
  // 避免上一条 case 的画面状态残留到下一条
  const baseUserId = caseObj.user_id || 'default';
  const hasPriorTurns = Array.isArray(caseObj.prior_turns) && caseObj.prior_turns.length > 0;
  const userId = caseObj.context?.screen_event_state || hasPriorTurns
    ? `${baseUserId}__${caseObj.id}`
    : baseUserId;
  const payload = {
    case_id: caseObj.id,
    question: caseObj.question,
    user_id: userId,
  };
  // 注入屏幕感知 / 动态画面上下文（对齐线上 buildAgentContext 的 incomingContext 路径）
  // case.context.screen_event_state 会被 upsertAgentDynamicContext 写入会话黑板，
  // 然后通过 buildScreenContextSummary 生成 [当前画面] 摘要拼接到 dynamicSummary
  if (caseObj.context && typeof caseObj.context === 'object') {
    payload.context = caseObj.context;
  }
  if (hasPriorTurns) {
    payload.prior_turns = caseObj.prior_turns;
  }
  // silence 评测：透传 mode='proactive_check'，server 端会启用极短输出守卫
  if (caseObj.mode || caseObj._eval_only?.track_override === 'silence' || caseObj.dimension === 'silence_appropriateness') {
    payload.mode = caseObj.mode || 'proactive_check';
  }
  // 单次发起 + 指数退避重试（最多 4 次：base + 3 retries，间隔 5s/10s/20s）
  const maxAttempts = 4;
  const baseDelay = 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(EVAL_AGENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180_000),
      });
      if (!resp.ok) {
        console.log(`  [FAIL] Agent HTTP ${resp.status}`);
        return null;
      }
      const data = await resp.json();
      if (!data.ok) {
        console.log(`  [FAIL] Agent 错误: ${data.message}`);
        return null;
      }
      return data.data || null;
    } catch (e) {
      const msg = e.message || '';
      const causeMsg = e.cause?.message || '';
      const isTransient = /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(msg) || /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(causeMsg);
      if (!isTransient || attempt === maxAttempts) {
        console.log(`  [FAIL] Agent 调用异常(尝试${attempt}/${maxAttempts}): ${msg} | cause=${causeMsg}`);
        return null;
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`  [WARN] Agent 瞬时失败(${msg})，${delay / 1000}s 后第 ${attempt + 1}/${maxAttempts} 次尝试...`);
      await sleep(delay);
    }
  }
  return null;
}

function mockPrediction(caseObj) {
  return {
    id: caseObj.id,
    answer: {
      intent: caseObj.expected_intent || 'strategy',
      emotional_reply: '这问题问得真不错',
      understanding_reply: '你想知道某个英雄的具体打法和时机',
      main_summary: caseObj.expected_intent === 'smalltalk' ? '别急，先去战绩里翻翻看看' : '',
      branch_wait_reply: caseObj.expected_intent === 'smalltalk' ? '' : '稍等我帮你查一下相关攻略',
    },
    actual_intent: caseObj.expected_intent || 'strategy',
    visible_answer: '[MOCK]',
    tactic_data: caseObj.expected_intent === 'strategy' ? { title: 'mock战术', details: ['1分钟做X', '3分钟做Y'], voice_chunks: ['一分钟做X'] } : null,
    video_data: caseObj.expected_intent === 'video' ? { title: 'mock视频', summary: '教学', linkUrl: 'https://x', source_platform: 'bilibili' } : null,
    video_queries: caseObj.expected_intent === 'video' ? { generic: '亚索教学', bilibili: '亚索教学详解', douyin: '亚索实战高光' } : null,
    task_plan: caseObj.expected_compound ? { mode: 'compound', task_plan: [{ tool: 'strategy', query: 'mock' }, { tool: 'video', query: 'mock' }] } : { mode: 'single', task_plan: [{ tool: caseObj.expected_intent || 'strategy', query: caseObj.question }] },
  };
}

// ============== 聚合 ==============

function aggregateByTrack(allRows) {
  const byTrack = {};
  for (const row of allRows) {
    const t = row.track;
    if (!byTrack[t]) byTrack[t] = [];
    byTrack[t].push(row);
  }
  const out = {};
  for (const [t, rows] of Object.entries(byTrack)) {
    const dims = TRACK_DIM_KEYS[t] || [];
    const dimAvgs = {};
    for (const d of dims) {
      const scores = rows.map(r => r.dimension_scores?.[d] ?? 0);
      dimAvgs[d] = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 100) / 100 : 0;
    }
    const overalls = rows.map(r => r.overall_score ?? 0);
    const passCount = rows.filter(r => r.verdict === 'pass').length;
    out[t] = {
      total: rows.length,
      pass: passCount,
      fail: rows.length - passCount,
      pass_rate: rows.length ? Math.round(passCount / rows.length * 1000) / 10 : 0,
      avg_overall_score: overalls.length ? Math.round(overalls.reduce((a, b) => a + b, 0) / overalls.length * 100) / 100 : 0,
      dimension_averages: dimAvgs,
      low_score_cases: rows.filter(r => (r.overall_score ?? 10) <= 5).slice(0, 10).map(r => ({
        case_id: r.case_id,
        overall_score: r.overall_score,
        verdict: r.verdict,
        reason: r.reason,
      })),
    };
  }
  return out;
}

function computeRoutingAccuracy(rowsByCaseId, caseMap = new Map()) {
  const items = Object.values(rowsByCaseId);
  const routed = items.filter(it => it.expected_intent);
  const matched = routed.filter(it => {
    // compound case 放宽：expected_compound=true 时，actual 为 strategy 或 video 都算匹配
    const caseObj = caseMap.get(it.case_id);
    if (caseObj?.expected_compound && ['strategy', 'video'].includes(it.actual_intent)) {
      return true;
    }
    return it.expected_intent === it.actual_intent;
  });
  const mismatches = routed.filter(it => {
    const caseObj = caseMap.get(it.case_id);
    if (caseObj?.expected_compound && ['strategy', 'video'].includes(it.actual_intent)) {
      return false;
    }
    return it.expected_intent !== it.actual_intent;
  }).map(it => ({
    case_id: it.case_id,
    expected: it.expected_intent,
    actual: it.actual_intent,
    question: it.question,
  }));
  return {
    total_routed: routed.length,
    matched: matched.length,
    mismatched: mismatches.length,
    rate: routed.length ? Math.round(matched.length / routed.length * 1000) / 10 : null,
    mismatches,
  };
}

function ensureRunDir(runId) {
  const dir = path.join(PROJECT_ROOT, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ============== 断点续跑与增量保存 ==============
const CHECKPOINT_PHASE1 = 'predictions_checkpoint.jsonl';
const CHECKPOINT_PHASE2 = 'judge_results_checkpoint.jsonl';
const CHECKPOINT_META = 'checkpoint_meta.json';

function savePhase1Checkpoint(runDir, predictionsMap) {
  const filePath = path.join(runDir, CHECKPOINT_PHASE1);
  const lines = Object.entries(predictionsMap).map(([id, pred]) => JSON.stringify({ id, pred }));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

function loadPhase1Checkpoint(runDir) {
  const filePath = path.join(runDir, CHECKPOINT_PHASE1);
  if (!fs.existsSync(filePath)) return {};
  const map = {};
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const { id, pred } = JSON.parse(line);
      map[id] = pred;
    } catch (e) { /* skip malformed lines */ }
  }
  return map;
}

function savePhase2Checkpoint(runDir, rows) {
  const filePath = path.join(runDir, CHECKPOINT_PHASE2);
  const lines = rows.map(r => JSON.stringify(r));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

function loadPhase2Checkpoint(runDir) {
  const filePath = path.join(runDir, CHECKPOINT_PHASE2);
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) { /* skip malformed lines */ }
  }
  return rows;
}

function saveCheckpointMeta(runDir, data) {
  const filePath = path.join(runDir, CHECKPOINT_META);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function loadCheckpointMeta(runDir) {
  const filePath = path.join(runDir, CHECKPOINT_META);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) { return null; }
}

function findLatestCheckpoint() {
  const runsDir = path.join(PROJECT_ROOT, 'runs');
  if (!fs.existsSync(runsDir)) return null;
  const dirs = fs.readdirSync(runsDir).filter(d => {
    return fs.statSync(path.join(runsDir, d)).isDirectory();
  }).sort().reverse(); // 最新排在前面
  for (const dir of dirs) {
    const meta = loadCheckpointMeta(path.join(runsDir, dir));
    if (meta) return { runId: dir, runDir: path.join(runsDir, dir), meta };
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============== 主流程 ==============

async function main() {
  const opts = parseArgs();
  // --model 可覆盖 Judge 模型，便于多模型 A/B 对比
  const ARK_CHAT_MODEL = opts.model || DEFAULT_ARK_CHAT_MODEL;
  const now = new Date();
  const runId = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const runDir = ensureRunDir(runId);

  // 检查是否有可恢复的 checkpoint
  let resumeFrom = null;
  if (!opts.mock && !opts.resume) {
    const latest = findLatestCheckpoint();
    if (latest && latest.meta) {
      if (latest.meta.phase === 'phase2') {
        console.log(`[Checkpoint] 检测到未完成的评测 run: ${latest.runId}`);
        console.log(`[Checkpoint] 阶段1已完成，阶段2进度: ${latest.meta.phase2_completed}/${latest.meta.phase2_total} 条`);
        console.log(`[Checkpoint] 可用 --resume ${latest.runId} 恢复，或启动新评测`);
      } else if (latest.meta.phase === 'phase1') {
        console.log(`[Checkpoint] 检测到未完成的评测 run: ${latest.runId}`);
        console.log(`[Checkpoint] 阶段1进度: ${latest.meta.phase1_completed}/${latest.meta.phase1_total} 条`);
        console.log(`[Checkpoint] 可用 --resume ${latest.runId} 恢复，或启动新评测`);
      }
    }
  }

  // --resume <runId> 从指定 checkpoint 恢复
  if (opts.resume) {
    const resumeDir = path.join(PROJECT_ROOT, 'runs', opts.resume);
    if (!fs.existsSync(resumeDir)) {
      console.error(`[ERROR] 指定恢复的 run 不存在: ${opts.resume}`);
      process.exit(1);
    }
    resumeFrom = { runId: opts.resume, runDir: resumeDir };
    console.log(`[Auto-Eval] 从 checkpoint 恢复: ${opts.resume}`);
  }

  console.log(`[Auto-Eval 双轨版] Run ID: ${runId}`);
  console.log(`[Auto-Eval] 输出目录: ${runDir}`);
  console.log(`[Auto-Eval] 模式: ${opts.mock ? 'MOCK' : 'LLM'} | Judge 模型: ${ARK_CHAT_MODEL}`);
  console.log(`[Auto-Eval] tracks_filter: ${opts.tracks ? opts.tracks.join(',') : '(按 case 自动)'}`);
  console.log(`[Auto-Eval] profile: ${opts.profile}（${opts.profile === 'daily' ? '日常回归小集 / PR 自检' : '全量评测集 / 重大版本'}）`);
  console.log(`[Auto-Eval] Agent URL: ${EVAL_AGENT_URL}`);

  const allCases = loadCases(opts.cases);
  // —— 样本分层过滤 ——
  // daily：仅保留 _eval_only.profile === 'daily' 标注的小集（约 15 条），用于每日 / 每次提交回归
  // full：放行全部样本（含未标注的），仅在重大版本 / 架构升级时跑
  let cases;
  if (opts.profile === 'full') {
    cases = allCases;
  } else {
    cases = allCases.filter(c => c?._eval_only?.profile === 'daily');
    if (cases.length === 0) {
      console.error(`[ERROR] profile=daily 命中 0 条样本，请确认 cases.jsonl 中是否有 _eval_only.profile="daily" 标注，或改用 --profile full`);
      process.exit(1);
    }
  }
  console.log(`[Auto-Eval] 样本：全量=${allCases.length} → profile=${opts.profile} 命中=${cases.length} 条`);

  const predictionsMap = {};
  let phase1StartIdx = 0;
  if (opts.predictions) {
    Object.assign(predictionsMap, loadPredictions(opts.predictions));
    console.log(`[Auto-Eval] 加载 ${Object.keys(predictionsMap).length} 条已有预测`);
  } else if (resumeFrom) {
    // 从 checkpoint 恢复阶段1预测
    const cp1 = loadPhase1Checkpoint(resumeFrom.runDir);
    Object.assign(predictionsMap, cp1);
    if (Object.keys(predictionsMap).length > 0) {
      console.log(`[Checkpoint] 恢复阶段1预测 ${Object.keys(predictionsMap).length} 条`);
    }
    // 检查 phase1 是否已完成
    const meta = loadCheckpointMeta(resumeFrom.runDir);
    if (meta?.phase === 'phase2' || meta?.phase === 'phase1_done') {
      phase1StartIdx = cases.length; // phase1 已完成，跳过
      console.log(`[Checkpoint] 阶段1已完成（${meta.phase1_completed}/${meta.phase1_total} 条），跳过阶段1`);
    } else if (meta?.phase === 'phase1') {
      // phase1 进行中，找到断点位置
      phase1StartIdx = meta.phase1_completed || 0;
      console.log(`[Checkpoint] 阶段1进行中，从第 ${phase1StartIdx + 1} 条继续`);
    }
  }

  let phase2StartIdx = 0;
  let allRows = [];
  let failures = [];
  let rowsByCaseId = {};
  let parseErrorCount = 0;
  if (resumeFrom) {
    // 从 checkpoint 恢复阶段2结果
    allRows = loadPhase2Checkpoint(resumeFrom.runDir);
    if (allRows.length > 0) {
      console.log(`[Checkpoint] 恢复阶段2结果 ${allRows.length} 条`);
      // 重建 rowsByCaseId
      for (const row of allRows) {
        if (!rowsByCaseId[row.case_id]) {
          rowsByCaseId[row.case_id] = { case_id: row.case_id, question: row.question, expected_intent: row.expected_intent, actual_intent: row.actual_intent };
        }
      }
      // 计算起始索引
      const completedCases = [...new Set(allRows.map(r => r.case_id))];
      phase2StartIdx = cases.findIndex(c => !completedCases.includes(c.id));
      if (phase2StartIdx === -1) phase2StartIdx = cases.length;
    }
  }

  // 阶段1：Agent 预测生成
  if (!opts.mock && !opts.predictions) {
    console.log(`\n[Auto-Eval] === 阶段 1：调用 Agent 生成预测 ===`);
    for (let i = phase1StartIdx; i < cases.length; i++) {
      const c = cases[i];
      process.stdout.write(`  [${i + 1}/${cases.length}] ${c.id} ...`);
      const pred = await generatePredictionViaAgent(c);
      if (pred) {
        predictionsMap[c.id] = pred;
        // 透出慢路径落地状况——快速发现空值回归 / 后端没透字段
        const td = pred.tactic_data;
        const vd = pred.video_data;
        const tp = pred.task_plan;
        const tpf = pred.task_plan_forced;
        const ans = pred.answer || {};
        const tdMark = td && Array.isArray(td.details) ? `√(${td.details.length})` : '-';
        const vdMark = vd && vd.linkUrl ? `√(${vd.source_platform || 'unk'})` : '-';
        const planLen = Array.isArray(tp?.task_plan) ? tp.task_plan.length : 0;
        const planMode = tp?.mode || (tp ? 'unknown' : 'missing');
        const forcedLen = Array.isArray(tpf?.task_plan) ? tpf.task_plan.length : 0;
        const forcedMode = tpf?.mode || '-';
        const msLen = cnLen(ans.main_summary);
        // task_plan 显示格式：主链路len(模式) | forced=len(模式)，便于一眼看出是路由短路还是拆解失败
        console.log(` OK | intent=${pred.actual_intent} mode=${planMode} | 慢路径: tactic=${tdMark} video=${vdMark} task_plan=${planLen}(${planMode})/forced=${forcedLen}(${forcedMode}) ms_len=${msLen}`);
      } else {
        console.log(' FAIL');
      }
      // 每个 case 完成后增量保存 checkpoint
      savePhase1Checkpoint(runDir, predictionsMap);
      saveCheckpointMeta(runDir, { runId, phase: 'phase1', phase1_completed: i + 1, phase1_total: cases.length });
      if (i < cases.length - 1) await sleep(150);
    }
    // 阶段1全部完成，更新 meta 标记
    saveCheckpointMeta(runDir, { runId, phase: 'phase2', phase1_completed: cases.length, phase1_total: cases.length });
  }

  // 阶段2：Judge 评分（带断点续跑）
  console.log(`\n[Auto-Eval] === 阶段 2：双轨打分（${opts.mock ? 'MOCK' : 'LLM'}模式） ===`);
  // 跳过已完成的 case（断点续跑）
  const skipCases = new Set();
  if (phase2StartIdx > 0) {
    for (let i = 0; i < phase2StartIdx; i++) {
      skipCases.add(cases[i].id);
    }
    console.log(`[Checkpoint] 跳过已完成 case ${skipCases.size} 个，从 ${cases[phase2StartIdx]?.id} 继续`);
  }
  for (let i = phase2StartIdx; i < cases.length; i++) {
    const c = cases[i];
    const pred = opts.mock ? mockPrediction(c) : predictionsMap[c.id];
    if (!pred) {
      failures.push({ case_id: c.id, question: c.question, error: '无预测答案' });
      console.log(`  [${i + 1}/${cases.length}] ${c.id}: SKIP (无预测)`);
      continue;
    }

    const caseTracks = pickTracksForCase(c).filter(t => TRACK_DIM_KEYS[t]);
    // 命令行 --tracks 作为过滤器，而不是强制所有 case 都跑该轨道；
    // 这样 conversation/silence/compound 只会在显式标注的 case 上执行。
    const requestedTracks = opts.tracks ? opts.tracks.filter(t => TRACK_DIM_KEYS[t]) : caseTracks;
    const effectiveTracks = requestedTracks.filter(t => caseTracks.includes(t));
    rowsByCaseId[c.id] = {
      case_id: c.id,
      question: c.question,
      expected_intent: c.expected_intent,
      actual_intent: pred.actual_intent,
    };

    const caseTrackScores = []; // 用于本 case 综合行

    for (let k = 0; k < effectiveTracks.length; k++) {
      const track = effectiveTracks[k];
      const builder = TRACK_BUILDERS[track];
      const auditor = PRE_AUDITORS[track] || (() => []);
      const auditFlags = auditor(c, pred);
      const judgeInput = builder(c, pred);
      const inputWithAudit = auditFlags.length
        ? `${judgeInput}\n\n【硬规则前置审计】\n${auditFlags.map(f => `- ${f}`).join('\n')}`
        : judgeInput;

      const trackPad = track.padEnd(10);
      process.stdout.write(`  [${i + 1}/${cases.length}][${k + 1}/${effectiveTracks.length}] ${c.id} <${trackPad}> ...`);
      try {
        const score = opts.mock ? mockJudge(track) : await callJudgeLlm(track, inputWithAudit);
        const isParseErr = score?.parse_error === true;
        if (isParseErr) parseErrorCount++;
        const row = {
          case_id: c.id,
          dimension: c.dimension,
          question: c.question,
          expected_intent: c.expected_intent || null,
          actual_intent: pred.actual_intent || null,
          audit_flags: auditFlags,
          ...score,
          track, // 显式覆盖：防止 Judge 返回的 track 字段（如 compound prompt 输出 single）覆盖原始 track
        };
        allRows.push(row);
        caseTrackScores.push({ track, overall: score.overall_score ?? null, verdict: score.verdict, parseErr: isParseErr });
        const verdictTag = isParseErr ? 'PARSE_ERR' : (score.verdict || '?');
        const auditTail = auditFlags.length
          ? ` audit=${auditFlags.length} → "${auditFlags[0]}"`
          : '';
        console.log(` ${verdictTag} overall=${score.overall_score ?? '?'}${auditTail}`);
        // 每个 track 完成后增量保存 checkpoint
        if (!opts.mock) {
          savePhase2Checkpoint(runDir, allRows);
          saveCheckpointMeta(runDir, { runId, phase: 'phase2', phase2_completed: allRows.length, phase2_total: cases.length * effectiveTracks.length });
        }
      } catch (e) {
        failures.push({ case_id: c.id, track, question: c.question, error: String(e) });
        console.log(` FAIL (${e.message})`);
      }
      if (!opts.mock) await sleep(200);
    }

    // case 级汇总行
    if (caseTrackScores.length) {
      const overalls = caseTrackScores.map(s => s.overall ?? 0);
      const avg = Math.round(overalls.reduce((a, b) => a + b, 0) / overalls.length * 100) / 100;
      const breakdown = caseTrackScores.map(s => `${s.track}=${s.overall ?? '?'}`).join(' | ');
      // 主要短板：本 case 所有 track 中分数最低的维度
      const lowestRow = allRows.filter(r => r.case_id === c.id && r.dimension_scores)
        .map(r => {
          const dims = Object.entries(r.dimension_scores);
          if (!dims.length) return null;
          dims.sort((a, b) => a[1] - b[1]);
          return { track: r.track, dim: dims[0][0], v: dims[0][1] };
        }).filter(Boolean).sort((a, b) => a.v - b.v)[0];
      const weakness = lowestRow ? ` | 短板=${lowestRow.track}.${lowestRow.dim}=${lowestRow.v}` : '';
      console.log(`    → ${c.id} 综合: ${breakdown} | 平均=${avg}${weakness}`);
    }
    // case 间加 500ms 间隔，防止 judge 并发打爆服务端
    if (!opts.mock) await sleep(500);
  }

  const trackSummary = aggregateByTrack(allRows);
  const caseMap = new Map(cases.map(c => [c.id, c]));
  const routingAccuracy = computeRoutingAccuracy(rowsByCaseId, caseMap);

  // 总分（按 case 取该 case 涉及轨道的均值）
  const caseOveralls = {};
  for (const row of allRows) {
    if (!caseOveralls[row.case_id]) caseOveralls[row.case_id] = [];
    caseOveralls[row.case_id].push(row.overall_score ?? 0);
  }
  const caseLevelAvg = Object.values(caseOveralls).map(arr => arr.reduce((a, b) => a + b, 0) / arr.length);
  const grandAvg = caseLevelAvg.length ? Math.round(caseLevelAvg.reduce((a, b) => a + b, 0) / caseLevelAvg.length * 100) / 100 : 0;

  // by_case 剖面
  const byCase = {};
  for (const row of allRows) {
    if (!byCase[row.case_id]) {
      byCase[row.case_id] = {
        case_id: row.case_id,
        question: row.question,
        expected_intent: row.expected_intent,
        actual_intent: row.actual_intent,
        tracks: {},
      };
    }
    byCase[row.case_id].tracks[row.track] = {
      overall_score: row.overall_score ?? null,
      verdict: row.verdict || null,
      audit_count: (row.audit_flags || []).length,
      parse_error: row.parse_error === true,
    };
  }
  for (const cid of Object.keys(byCase)) {
    const arr = Object.values(byCase[cid].tracks).map(t => t.overall_score ?? 0);
    byCase[cid].avg_overall = arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100 : 0;
  }

  // audit_summary
  const auditCounts = {};
  for (const row of allRows) {
    for (const f of (row.audit_flags || [])) {
      // 把"详细数=X 越界(Y)"中的 X 抽掉以聚合
      const norm = f.replace(/=\d+/g, '=N').replace(/\s+\d+\s*字/g, ' N 字');
      auditCounts[norm] = (auditCounts[norm] || 0) + 1;
    }
  }
  const auditSummary = Object.entries(auditCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([flag, count]) => ({ flag, count }));

  // compound 拆解准确率（独立于路由准确率）
  // 双口径产物：
  //   - main_pipeline_correct：主链路 task_plan 直接命中（路由+拆解全对）
  //   - forced_pipeline_correct：强制旁路 task_plan_forced 命中（仅评 TaskPlanner 拆解能力，绕开路由）
  // 二者差值 = 路由短路造成的损失（路由识别失败 → smalltalk 把 TaskPlanner 短路）
  const compoundCases = cases.filter(c => c.expected_compound);
  let compoundAccuracy = null;
  if (compoundCases.length > 0) {
    const compoundRows = allRows.filter(r => r.track === 'compound');
    const correctlyDecomposed = compoundRows.filter(r =>
      (r.audit_flags || []).length === 0 && (r.overall_score ?? 0) >= 7
    );
    // 单独评估 TaskPlanner 拆解能力：忽略"主链路 task_plan 为空"那条 flag，看其它 flag 是否全部干净
    const ROUTE_SHORT_CIRCUIT_FLAG = /主链路 task_plan 为空/;
    const taskplannerCapable = compoundRows.filter(r => {
      const flags = r.audit_flags || [];
      const filtered = flags.filter(f => !ROUTE_SHORT_CIRCUIT_FLAG.test(f));
      return filtered.length === 0 && (r.overall_score ?? 0) >= 7;
    });
    // 路由短路损失 = TaskPlanner 拆得对、但被路由短路拦下的 case 数
    const routeShortCircuitLoss = compoundRows.filter(r => {
      const flags = r.audit_flags || [];
      const hasShortCircuit = flags.some(f => ROUTE_SHORT_CIRCUIT_FLAG.test(f));
      const otherFlags = flags.filter(f => !ROUTE_SHORT_CIRCUIT_FLAG.test(f));
      return hasShortCircuit && otherFlags.length === 0;
    });
    compoundAccuracy = {
      total_compound_cases: compoundCases.length,
      compound_judged: compoundRows.length,
      correctly_decomposed: correctlyDecomposed.length,
      rate: compoundRows.length ? Math.round(correctlyDecomposed.length / compoundRows.length * 1000) / 10 : null,
      // 新增：TaskPlanner 自身拆解能力（绕开路由短路看）
      taskplanner_capable: taskplannerCapable.length,
      taskplanner_capable_rate: compoundRows.length ? Math.round(taskplannerCapable.length / compoundRows.length * 1000) / 10 : null,
      // 新增：被路由短路损耗掉的 case 数（拆解能力 OK，但主链路没用上）
      route_short_circuit_loss: routeShortCircuitLoss.length,
      misdecomposed: compoundRows
        .filter(r => (r.audit_flags || []).length > 0 || (r.overall_score ?? 0) < 7)
        .map(r => ({
          case_id: r.case_id,
          overall_score: r.overall_score,
          audit_flags: r.audit_flags,
          reason: r.reason,
        })),
    };
  }

  // 分轨主要短板（最低均分的维度）
  const trackWeakness = {};
  for (const [t, s] of Object.entries(trackSummary)) {
    const dims = Object.entries(s.dimension_averages || {});
    if (dims.length === 0) continue;
    dims.sort((a, b) => a[1] - b[1]);
    trackWeakness[t] = { dim: dims[0][0], avg: dims[0][1] };
  }

  const summary = {
    total_cases: cases.length,
    judged_rows: allRows.length,
    grand_avg_overall: grandAvg,
    parse_error_count: parseErrorCount,
    by_track: trackSummary,
    track_weakness: trackWeakness,
    by_case: byCase,
    audit_summary: auditSummary,
    routing_accuracy: routingAccuracy,
    compound_decomposition_accuracy: compoundAccuracy,
  };

  fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify({
    run_id: runId,
    timestamp: new Date().toISOString(),
    cases_path: opts.cases,
    mode: opts.mock ? 'mock' : 'llm',
    judge_model: ARK_CHAT_MODEL,
    tracks_filter: opts.tracks,
    profile: opts.profile,
    total_loaded_cases: allCases.length,
    total_cases: cases.length,
    judged_rows: allRows.length,
    failure_count: failures.length,
    parse_error_count: parseErrorCount,
  }, null, 2), 'utf-8');

  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  fs.writeFileSync(path.join(runDir, 'judged_results.jsonl'),
    allRows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  if (failures.length) {
    fs.writeFileSync(path.join(runDir, 'judge_failures.jsonl'),
      failures.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  }

  console.log('\n' + '='.repeat(60));
  console.log('[Auto-Eval 双轨版] 完成！');
  console.log(`  Cases: ${cases.length} | 评测行: ${allRows.length} | 失败: ${failures.length} | parse_error: ${parseErrorCount}`);
  console.log(`  总分（case 级均值）: ${grandAvg}`);
  console.log('  分轨摘要:');
  for (const [t, s] of Object.entries(trackSummary)) {
    const w = trackWeakness[t];
    console.log(`    [${t}] N=${s.total} pass=${s.pass}/${s.total} (${s.pass_rate}%) avg=${s.avg_overall_score}`);
    for (const [d, v] of Object.entries(s.dimension_averages)) {
      const tag = (w && w.dim === d) ? ' ←短板' : '';
      console.log(`        ${d}: ${v}${tag}`);
    }
    if (s.low_score_cases.length) {
      console.log(`        低分: ${s.low_score_cases.map(c => `${c.case_id}=${c.overall_score}`).join(', ')}`);
    }
  }
  if (routingAccuracy.total_routed > 0) {
    console.log(`  路由准确率: ${routingAccuracy.matched}/${routingAccuracy.total_routed} (${routingAccuracy.rate}%)`);
    if (routingAccuracy.mismatches.length) {
      console.log('  路由不匹配:');
      for (const m of routingAccuracy.mismatches) {
        console.log(`    ${m.case_id}: 期望=${m.expected} 实际=${m.actual} | ${m.question}`);
      }
    }
  }
  if (compoundAccuracy) {
    console.log(`  复合拆解准确率（端到端）: ${compoundAccuracy.correctly_decomposed}/${compoundAccuracy.compound_judged} (${compoundAccuracy.rate}%)`);
    console.log(`    └ TaskPlanner 拆解能力（绕开路由短路）: ${compoundAccuracy.taskplanner_capable}/${compoundAccuracy.compound_judged} (${compoundAccuracy.taskplanner_capable_rate}%)`);
    console.log(`    └ 被路由短路损耗: ${compoundAccuracy.route_short_circuit_loss} case（拆解能力 OK，但主链路 task_plan 为空）`);
    if (compoundAccuracy.misdecomposed.length) {
      console.log('  误拆解:');
      for (const m of compoundAccuracy.misdecomposed) {
        console.log(`    ${m.case_id}: overall=${m.overall_score} | ${m.audit_flags.slice(0, 2).join('; ')}`);
      }
    }
  }
  if (auditSummary.length) {
    console.log('  Audit Top 5:');
    for (const a of auditSummary.slice(0, 5)) {
      console.log(`    ×${a.count}  ${a.flag}`);
    }
  }
  console.log('='.repeat(60));
  console.log(`结果目录: ${runDir}`);
}

main().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
