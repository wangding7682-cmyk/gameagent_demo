/**
 * 【任务编排 / 单复合分流】taskPlannerService
 *
 * 通俗职责：看用户这一句话该走单分支（只查战术 / 只搜视频）还是复合分支
 * （战术+视频一起来），把要做的活拆成一份"待办清单"交给主控编排器执行。
 *
 * 设计原则：
 *   - 不改 Main Prompt，避免回归 P0 字数约束
 *   - 输入：main_reply(含 intent) + user_query
 *   - 输出：task_plan[] = 一组并行可执行任务
 *   - 单 intent 时退化为单元素数组（向前兼容）
 *   - 检测到"既要 X 也要 Y"等复合意图时拆成多任务
 *
 * Step 2 改造（LLM TaskPlanner）：
 *   - 启发式判断疑似复合句 → 调 LLM 拆解（属慢路径，可放缓延迟）
 *   - LLM 失败 / timeout(15s) → 回退到原 COMPOUND_PATTERNS 正则
 *   - 纯单意图（短句、无连接词）跳过 LLM，直接走单 task_plan，节省延迟
 *   - 注意：timeout 仅覆盖"拆任务清单"这一次 ARK 调用，不包含后续 strategy/video/生图
 *     等子 agent 真正执行的耗时（那些有各自的 timeout/limiter）
 *
 * 工具白名单：
 *   - strategy: 战术/出装/对线知识
 *   - video:    视频检索
 *   - knowledge_preload: 预热知识库（不直接对外，给 P3/P4 复用）
 */

import { callArkChat, extractJsonObject } from './arkChatService.js';

const TOOL_WHITELIST = new Set(['strategy', 'video', 'knowledge_preload']);

const COMPOUND_PATTERNS = [
  // 同时要战术 + 视频
  {
    name: 'strategy_plus_video',
    test: (q) => /[，,。.;；?？!！]|和|也|还|顺便|另外|再|外加|同时|帮我|给我|讲下|讲讲|推荐|来个/.test(q) &&
                /(怎么打|怎么对线|出装|连招|技巧|攻略|思路|技能|玩法|知识卡片|知识卡)/.test(q) &&
                /(视频|集锦|教学|示范|看看|演示|录像|链接|资料链接|教程链接)/.test(q),
    plan: ({ user_query, main_intent }) => [
      { tool: 'strategy', query: extractStrategyQuery(user_query), priority: main_intent === 'strategy' ? 'high' : 'normal' },
      { tool: 'video', query: extractVideoQuery(user_query), priority: main_intent === 'video' ? 'high' : 'normal' },
    ],
  },
];

// Step 2: 启发式判断"疑似复合句"——满足任一条件就让 LLM TaskPlanner 来拆
// 思路：句子里同时出现连接词 + 多个意图标志词 / 句子较长 / 含视频关键词且含战术关键词
const COMPOUND_HINT_REGEX = {
  // 连接词：标点（含问号/感叹号）+ 关联词（再/另外/顺便/还/也/和/外加/同时/帮我/给我/讲下/讲讲）
  connector: /[，,。.;；?？!！]|和|也|还|顺便|另外|再|外加|同时|帮我|给我|讲下|讲讲|推荐|来个/,
  // 战术：含动作意图（怎么打/上分/翻盘/对线/咋办/帮ADC 等）
  strategy_keyword: /(怎么打|怎么练|怎么帮|怎么对|怎么带|对线|出装|连招|技巧|攻略|思路|carry|入侵|反野|反入侵|开团|压塔|带线|带节奏|游走|支援|控龙|拿龙|推塔|翻盘|走A|上分|咋办|怎么办|被反|被针对|被压|被打爆|帮.{0,3}(ADC|adc|打野|上单|中单|辅助|队友))/,
  // 视频/链接：扩展"链接"，覆盖"有没有什么链接也给我一下"这类检索型请求
  video_keyword: /(视频|集锦|高光|教学|示范|看看|演示|录像|教程|指导|示例|链接|资料链接|教程链接|看个|来个.{0,5}(视频|教学|集锦|示范|链接))/,
  // 情绪：扩展"心态崩/烦死/夸夸/鼓励/紧张/没意思/虐了"
  emotion_keyword: /(夸夸|夸我|安慰|烦死|烦|心态|心情|加油|鼓励|没意思|好烦|别那么紧张|紧张|崩了|虐了|针对|吐槽)/,
};

// 新话题连接词：暗示引入独立新话题（而非同一话题的递进描述）
const NEW_TOPIC_CONNECTORS = /另外|还有|顺便|再说|并且|而且|同时|此外|除此外|除了这个|除了那|顺便一提|话说回来|对了|哦对了|对了顺便|再/;

function isLikelyCompound(query) {
  const q = String(query || '');
  if (q.length < 8) return false;
  const hasConnector = COMPOUND_HINT_REGEX.connector.test(q);
  const hasStrategy = COMPOUND_HINT_REGEX.strategy_keyword.test(q);
  const hasVideo = COMPOUND_HINT_REGEX.video_keyword.test(q);
  const hasEmotion = COMPOUND_HINT_REGEX.emotion_keyword.test(q);
  const hasNewTopicConnector = NEW_TOPIC_CONNECTORS.test(q);
  const intentHits = [hasStrategy, hasVideo, hasEmotion].filter(Boolean).length;
  // 主路径：含新话题连接词 + ≥2 类意图（新话题引入才拆）
  if (hasNewTopicConnector && intentHits >= 2) return true;
  // 递进连接词（如"，"）+ 战术/视频同主题的递进描述 → 不拆（单意图）
  // 例如"连招怎么按键，给我看个示范"是同一主题的递进，不是复合意图
  if (!hasNewTopicConnector && hasStrategy && hasVideo) {
    // 只有当连接词后有明确的、新引入的视频请求时才拆
    // 例如"怎么打劫？另外给我个视频"需要拆
    // 但"连招怎么按，给我看个示范"不拆（同一主题的示范请求）
    const commaIdx = q.indexOf(',') !== -1 ? q.indexOf(',') : q.indexOf('，');
    const afterConnector = commaIdx !== -1 ? q.slice(commaIdx) : '';
    const hasExplicitNewTopic = /(另外|还有|顺便|再说|并且|而且)/.test(afterConnector);
    if (!hasExplicitNewTopic) {
      return false; // 同一主题递进，不拆
    }
  }
  // 旧逻辑兼容：含连接词 + ≥2 类意图（但排除纯递进场景）
  if (hasConnector && intentHits >= 2 && !hasNewTopicConnector) {
    // 进一步检查：是否真的需要复合？只有明确的"X 和/也 Y"模式才拆
    const explicitAndPattern = /(和|也|还).{0,5}(视频|集锦|教学|示范|演示)/.test(q) ||
                               /(视频|集锦|教学|示范|演示).{0,5}(和|也|还)/.test(q);
    if (!explicitAndPattern) return false; // 不是明确的"X 和 Y"并列需求，不拆
  }
  if (hasConnector && intentHits >= 2) return true;
  // 兜底 1：长句且同时含战术 + 视频，即使 connector 没显式命中也算疑似（短问号句兜底）
  if (q.length >= 12 && hasStrategy && hasVideo) return true;
  // 兜底 2：长句且同时含情绪 + 战术，覆盖"情绪+教学求助"复合
  if (q.length >= 16 && hasEmotion && hasStrategy) return true;
  return false;
}

function extractStrategyQuery(text) {
  return String(text || '')
    .replace(/(顺便|另外|还有|再|然后另外一个)[^，,。.;；]{0,30}(看|视频|集锦|教学|示范|演示|链接)[^，,。.;；]*[，,。.;；]?/g, '')
    .replace(/(给我|帮我|想)?(看|搜|找|有没有)[^，,。.;；]{0,30}(视频|集锦|教学|示范|演示|链接)[^，,。.;；]*[，,。.;；]?/g, '')
    .replace(/^[，,。.;；\s]+|[，,。.;；\s]+$/g, '')
    .trim()
    .slice(0, 60);
}

/**
 * 方案 A：从 prior_turns 提取用户痛点片段，拼到 strategy task 的 query 末尾
 * 让 strategy 子 Agent 在多轮场景下能感知到上下文中的具体痛点。
 *
 * 抽取优先级：
 *   1. 最近 1-2 轮的 summary（已经是浓缩后的摘要）
 *   2. 用户原句中的疼点关键词：手跟不上 / 老是 / 一直 / 总是 / 跟不上 / 点不到 / 站桩 / 被压 / 被抓 / 崩了 / 输了 / 瓶颈 / 上不去 / 连败
 *   3. 拼接结果限制 ≤ 30 字，避免 query 过长
 */
const PAIN_KEYWORD_REGEX = /(手跟不上|跟不上|点不到|站桩|被压|被抓|被打爆|被针对|崩了|输了|连败|瓶颈|上不去|老是|一直|总是)[^，,。.;；！!？?]{0,15}/g;

function extractPainHint(recentTurns = []) {
  if (!Array.isArray(recentTurns) || recentTurns.length === 0) return '';
  const turns = recentTurns.slice(-2);
  const phrases = [];

  for (const turn of turns) {
    const userQuery = String(turn?.user_query || '').trim();
    if (userQuery) {
      const matches = userQuery.match(PAIN_KEYWORD_REGEX);
      if (matches && matches.length) {
        phrases.push(...matches);
      }
    }
    const summary = String(turn?.summary || '').trim();
    if (summary && phrases.length === 0) {
      // summary 兜底：截取 ≤ 22 字核心
      phrases.push(summary.slice(0, 22));
    }
  }

  if (phrases.length === 0) return '';
  // 去重 + 拼接
  const seen = new Set();
  const dedup = [];
  for (const p of phrases) {
    const key = p.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      dedup.push(key);
    }
  }
  return dedup.join('、').slice(0, 30);
}

function injectPainIntoStrategyQuery(query, painHint) {
  if (!painHint) return query;
  const base = String(query || '').trim();
  if (!base) return base;
  // 已经包含痛点关键词就不重复拼接
  if (base.includes(painHint)) return base;
  // 整体长度上限 90 字（query 主体 60 + ' | 用户痛点：' + 痛点 30）
  return `${base} | 用户痛点：${painHint}`.slice(0, 90);
}

function extractVideoQuery(text) {
  const t = String(text || '');
  if (/链接|资料链接|教程链接/.test(t)) {
    const heroMatch = t.match(/(?:想玩|关于|搜一下|查一下|那个)?([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:这个英雄|英雄)/);
    const hero = heroMatch?.[1]
      ?.replace(/^(呃|额|我想玩|想玩|关于|那个|这个|一下|，|,)+/, '')
      .replace(/这个$/, '')
      .trim();
    if (hero) {
      const topic = [
        /技能/.test(t) ? '技能' : '',
        /玩法|主要玩法|打法/.test(t) ? '玩法' : '',
        /教学|教程/.test(t) ? '教学' : '',
      ].filter(Boolean).join(' ');
      return `${hero} ${topic || '教学'} 链接`.trim().slice(0, 60);
    }
  }
  // 间接/愿望句式：优先提取 "英雄名 + 主题词 + 视频"
  const heroTopicMatch = t.match(/([\u4e00-\u9fa5A-Za-z]{2,10})(?:这个英雄|英雄)?.{0,25}(连招|技巧|玩法|教学|攻略|出装|对线)/);
  if (heroTopicMatch && /视频|集锦|教学|示范|演示|链接/.test(t)) {
    return `${heroTopicMatch[1]} ${heroTopicMatch[2]} 视频`.trim().slice(0, 60);
  }
  const compoundParts = t.split(/另外|还有|顺便|再|同时/);
  if (compoundParts.length >= 2 && /(视频|集锦|教学|示范|演示|教程|链接)/.test(compoundParts.slice(1).join(''))) {
    const headTopic = extractStrategyQuery(compoundParts[0])
      .replace(/怎么|如何|应该|给我|帮我|讲下|讲讲/g, '')
      .replace(/[？?，,。.;；!！]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const tail = compoundParts.slice(1).join(' ')
      .replace(/给我|帮我|想|看|搜|找|推荐|来个|一个|个|相关的|相关/g, ' ')
      .replace(/[？?，,。.;；!！]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const tailCore = tail.replace(/(视频|集锦|教学|示范|演示|教程|链接)/g, '').trim();
    if (tailCore.length >= 2) {
      return tail.slice(0, 60);
    }
    if (headTopic) {
      const videoType = /集锦/.test(tail) ? '集锦' : /高光/.test(tail) ? '高光' : /示范|演示/.test(tail) ? '示范' : '教学';
      return `${headTopic} ${videoType}`.trim().slice(0, 60);
    }
  }
  const m = t.match(/(.{2,30})(视频|集锦|教学|示范|演示|链接|资料链接|教程链接)/);
  if (m) {
    return `${m[1].replace(/^(顺便|另外|还有|再|给我|帮我|想|看|搜|找)/g, '').trim()} ${m[2]}`.trim().slice(0, 60);
  }
  return t.slice(0, 60);
}

const LLM_TASK_PLANNER_SYSTEM_PROMPT = `你是任务编排器（Task Planner），负责把用户原句拆解成 1-3 个并行子任务。

工具白名单（只能用这两个）：
- strategy: 战术 / 出装 / 对线 / 连招思路 / 翻盘策略 等知识查询
- video: 视频教学 / 集锦 / 高光 / 操作演示 等视频检索

拆解规则：
1. 单意图（如"怎么打亚索"）→ 1 个 task。
2. 复合句（如"亚索打盲僧怎么对线？另外给个连招视频"）→ 拆成 2 个 task（一个 strategy + 一个 video）。
3. **间接请求识别（重要）**：用户用"如果...就好了""要是...就好了""有...可以看看""想看看"等愿望/假设语气表达视频需求时，只要句中明确提到视频/集锦/教学/链接，必须拆出 video 任务。例如：
   - "如果亚索连招有视频可以看看就好了" → 拆 strategy + video
   - "要是能有盲僧打野的教学视频就好了" → 拆 strategy + video
4. **情绪豁免规则（重要）**：用户句中如果出现情绪表达（"心态崩了""烦死了""夸夸我""被针对""加油下一把"），**不要**单独拆出 smalltalk 子任务。情绪已由 Main_Agent 的 emotional_reply 字段承接，TaskPlanner 只关心实质性的"知识查询"和"视频检索"工具调用。例如：
   - "心态崩了，怎么对线劫？" → 单意图 strategy（不拆 smalltalk）
   - "打野老被反，咋办？再夸我两句" → 单意图 strategy（不拆 smalltalk）
   - "烦死了，给我讲下打劫，再来个反杀视频" → 拆 strategy + video（不拆 smalltalk）
5. 子任务的 query 必须保留**核心实体**（英雄名/位置/版本词），但**剔除情绪化和连接词**（如"烦死了""夸夸我""另外给个""如果""就好了"）。
6. 子任务的 query 各自专一，不能"串味"（strategy task 不能含"视频"，video task 不能含"对线方法"）。

返回严格 JSON（不要 markdown / 解释）：
{
  "mode": "single" | "compound",
  "task_plan": [
    {"tool": "strategy", "query": "亚索打盲僧 对线"},
    {"tool": "video", "query": "亚索 连招 教学"}
  ],
  "reason": "简短拆解依据"
}`;

function buildLlmTaskPlannerUserPrompt({ user_query, main_intent }) {
  return JSON.stringify({
    user_query,
    main_intent_hint: main_intent || 'unknown',
    constraint: '仅在确定是复合意图时输出 mode=compound；否则保持 single',
  });
}

function enrichCompoundVideoQueries(tasks = []) {
  const strategyTask = tasks.find((t) => t.tool === 'strategy');
  if (!strategyTask) return tasks;
  const strategyQuery = String(strategyTask.query || '').trim();
  const strategyTopic = strategyQuery
    .replace(/\s+/g, ' ')
    .replace(/\| 用户痛点：.*$/g, '')
    .trim();
  if (!strategyTopic) return tasks;

  return tasks.map((task) => {
    if (task.tool !== 'video') return task;
    const query = String(task.query || '').trim();
    const hasSpecificVideoTopic = /(连招|反杀|入侵|游走|gank|Gank|站位|抗压|团战|反蹲|高光|集锦|示范|演示)/.test(query);
    if (hasSpecificVideoTopic) return task;
    const isGenericTeaching = /(教学视频|教学|教程|视频)$/.test(query) && !/(对线|入侵|游走|带节奏|反蹲|站位|抗压|gank|Gank|连招|团战)/.test(query);
    const missesStrategyTopic = /(对线|入侵|游走|带节奏|反蹲|站位|抗压|gank|Gank|团战)/.test(strategyTopic)
      && !strategyTopic.split(/\s+/).some((part) => part.length >= 2 && query.includes(part));
    if (isGenericTeaching || missesStrategyTopic) {
      const videoType = /集锦/.test(query) ? '集锦' : /高光/.test(query) ? '高光' : /示范|演示/.test(query) ? '示范' : '教学';
      return { ...task, query: `${strategyTopic} ${videoType}`.trim().slice(0, 60) };
    }
    return task;
  });
}


async function runLlmTaskPlanner({ user_query, main_intent, recent_turns = [], timeout_ms = 25000 } = {}) {
  const callPromise = callArkChat({
    systemPrompt: LLM_TASK_PLANNER_SYSTEM_PROMPT,
    userPrompt: buildLlmTaskPlannerUserPrompt({ user_query, main_intent }),
    temperature: 0.1,
    maxTokens: 320,
  });
  const timeoutPromise = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`llm_task_planner_timeout_${timeout_ms}ms`)), timeout_ms);
  });
  const result = await Promise.race([callPromise, timeoutPromise]);
  const parsed = extractJsonObject(result.content);
  const planArr = Array.isArray(parsed?.task_plan) ? parsed.task_plan : [];
  // 方案 A：先抽痛点，再注入到 strategy 类 task 的 query 末尾
  const painHint = extractPainHint(recent_turns);
  const cleaned = enrichCompoundVideoQueries(planArr
    .map((t) => {
      const tool = String(t.tool || '').trim();
      let query = String(t.query || '').trim().slice(0, 60);
      if (tool === 'strategy' && painHint) {
        query = injectPainIntoStrategyQuery(query, painHint);
      }
      return { tool, query, priority: t.priority || 'normal' };
    })
    .filter((t) => TOOL_WHITELIST.has(t.tool) && t.query)
    .slice(0, 3));
  if (cleaned.length === 0) {
    throw new Error('llm_task_planner_empty_plan');
  }
  const reason = parsed?.reason ? `llm:${String(parsed.reason).slice(0, 60)}` : 'llm_planner';
  return {
    task_plan: cleaned,
    mode: cleaned.length >= 2 ? 'compound' : 'single',
    reason: painHint ? `${reason}+pain_inject` : reason,
    pain_hint: painHint || '',
  };
}

function regexFallbackPlan({ user_query, main_intent, main_reply, recent_turns = [], allowCompound = true }) {
  // 方案 A：抽取痛点，待 strategy task 生成后注入
  const painHint = extractPainHint(recent_turns);

  // allowCompound=false 时跳过 COMPOUND_PATTERNS（已由 isLikelyCompound 判定为单意图）
  if (allowCompound) {
    for (const pattern of COMPOUND_PATTERNS) {
      if (pattern.test(user_query)) {
        try {
          const tasks = enrichCompoundVideoQueries(pattern.plan({ user_query, main_intent, main_reply })
            .map((t) => {
              if (t.tool === 'strategy' && painHint) {
                return { ...t, query: injectPainIntoStrategyQuery(t.query, painHint) };
              }
              return t;
            })
            .filter((t) => TOOL_WHITELIST.has(t.tool) && t.query)
            .slice(0, 3));
          if (tasks.length >= 2) {
            return {
              task_plan: tasks,
              mode: 'compound',
              reason: painHint ? `pattern:${pattern.name}+pain_inject` : `pattern:${pattern.name}`,
              pain_hint: painHint || '',
            };
          }
        } catch (_) {
          // pattern 失败 → 退回单任务
        }
      }
    }
  }
  const fallbackQuery = main_reply?.strategy_query
    || main_reply?.video_query_seed
    || user_query;
  let singleQuery = String(fallbackQuery).slice(0, 60);
  if (main_intent === 'strategy' && painHint) {
    singleQuery = injectPainIntoStrategyQuery(singleQuery, painHint);
  }
  return {
    task_plan: [{ tool: main_intent, query: singleQuery, priority: 'high' }],
    mode: 'single',
    reason: painHint && main_intent === 'strategy' ? 'single_intent_fallback+pain_inject' : 'single_intent_fallback',
    pain_hint: painHint || '',
  };
}

/**
 * 推断 task_plan
 *
 * @param {object} params
 * @param {string} params.user_query - 用户原句
 * @param {string} params.main_intent - 主脑识别的 intent (smalltalk|strategy|video)
 * @param {object} [params.main_reply] - 主脑完整回复（含 strategy_query / video_query_seed 等）
 * @param {Array<object>} [params.recent_turns] - 多轮历史（来自 sessionState.recent_turns），用于方案 A 痛点注入
 * @returns {Promise<object>} { task_plan, mode, reason, pain_hint }
 *   mode: 'single' | 'compound'
 */
export async function planTasks({ user_query = '', main_intent = '', main_reply = {}, recent_turns = [] } = {}) {
  const intent = String(main_intent || '').trim();
  const query = String(user_query || '').trim();

  if (!intent || intent === 'unknown' || intent === 'smalltalk') {
    return {
      task_plan: [],
      mode: 'single',
      reason: 'no_branch_for_smalltalk_or_unknown',
      pain_hint: '',
    };
  }

  // 启发式：纯单意图短句直接走快路径，跳过 LLM TaskPlanner（节省 3-5s）
  if (!isLikelyCompound(query)) {
    return regexFallbackPlan({ user_query: query, main_intent: intent, main_reply, recent_turns, allowCompound: false });
  }

  // 疑似复合 → 调 LLM TaskPlanner，失败回退正则
  try {
    const llmResult = await runLlmTaskPlanner({ user_query: query, main_intent: intent, recent_turns });
    return llmResult;
  } catch (err) {
    const fallback = regexFallbackPlan({ user_query: query, main_intent: intent, main_reply, recent_turns });
    return {
      ...fallback,
      reason: `llm_failed_fallback:${err.message}`,
    };
  }
}

export const __INTERNAL = {
  COMPOUND_PATTERNS,
  TOOL_WHITELIST,
  extractStrategyQuery,
  extractVideoQuery,
  isLikelyCompound,
  runLlmTaskPlanner,
  regexFallbackPlan,
  extractPainHint,
  injectPainIntoStrategyQuery,
};
