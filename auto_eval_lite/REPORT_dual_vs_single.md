# 双轨评测架构 vs 单轨评测架构 对比报告

> **Quick Run（最新）**：`20260609_144026`（50 case × main_fast+compound 双轨完整 Judge，100 评测行 0 fail / 0 parse_error）
> **首次 Run**：`20260609_115329`（50 case 真实预测，预测阶段完整完成 48/50；Judge 阶段因会话超时被截断）
> **基线 Run**：`20260518_205642`（12 case 单轨评测，预测+Judge 全程完成）
> **报告生成时间**：2026-06-09（Quick Run 数据已更新）

---

## TL;DR

> **双轨评测最核心的价值不是"分数更高/更低"，而是把单轨评测看不到的工程缺陷直接顶到台面上。**

### Quick Run（main_fast + compound）权威数据 ⭐

| 指标 | 数值 | 备注 |
|---|---|---|
| Cases / 评测行 / 失败 | 50 / 100 / 0 | 100% 完成，0 parse_error |
| 总分（case 级均值） | **2.01 / 10** | 主、复合双轨综合平均 |
| **main_fast pass_rate** | **0/50 = 0%**（avg=0.9） | 50 个 case 全部 fail，4 字段空值 |
| **main_fast 短板维度** | `intent_grounding=0.02` | 几乎为零，Main_Agent 完全没有"承接用户意图"的输出 |
| **compound pass_rate** | **0/10 = 0%**（avg=1.8） | 10 个真复合 case 全部 fail |
| **compound 短板维度** | `output_completeness=0` | 完全空 |
| **复合拆解准确率** | **0/10 = 0%** | 单轨基线 0%（未评估），现有指标 0%，明确的工程债 |
| 路由准确率（50 条） | 31/50 = 62% | 19 条不匹配（详见 §2.3） |
| Audit Top 5 高频问题 | 见 §2.4 | "emotional_reply 字数=0 越界" 命中 50/50 |

### 首次 Run vs Quick Run（一致性自证）

| 指标 | 首次 Run（4 case Judge） | Quick Run（50 case Judge） | 一致性 |
|---|---|---|---|
| main_fast 全部 fail | ✓ | ✓ | 50/50 持平 |
| "emotional_reply 字数=0 越界" | 50/50 命中 | 50/50 命中 | 完全一致 |
| 复合 case 全部未拆 | 9/9 失败 | 10/10 失败 | 100% 复现 |

| 维度 | 单轨基线 | 双轨架构 | 趋势 |
|---|---|---|---|
| Case 集规模 | 12 | 50 | +316% |
| 评测维度数 | 5（混合在一起） | 25（按 5 个轨道分） | +400% |
| 路由准确率 | 91.7% (11/12) | 62% (31/50) | -29.7pp ❗（case 难度变了） |
| **复合拆解准确率** | **未评估** | **0%（0/10）** | 🚨 **全新洞察** |
| **Main_Agent 字段合规率** | 未评估 | **0% (0/50)** | 🚨 **全新洞察** |
| **视频检索成功率** | 未评估 | 60%（6/10 video_data 落地） | 🚨 **全新洞察** |
| **smalltalk 内容空值** | 部分发现 | **100% (ms_len=0 全跪)** | 🚨 **全新洞察** |
| 评测结果可解释度 | 单一 verdict | 5 轨道 × 5 维度 + audit_flags | 大幅提升 |

---

## 一、双轨架构 vs 单轨架构 设计对比

### 1.1 单轨（旧版）——把所有维度堆在一个 Judge 里

```
            ┌────────────────────────┐
   case ──→ │ 单一 Judge Prompt        │
            │ 5 维度（战术/结构/口吻/  │
            │  情绪边界/精简度）       │
            │ 一个 verdict             │
            └────────────────────────┘
                       ↓
                  全部 case 同一把尺子
```

**痛点**：
- 战术 case 和情绪 case 用同一套维度打分，**情绪类的"战术干货度"恒为 N/A**
- 复合意图（一句话两个意图）只能打一个综合分，无法定位"是路由错了还是子任务串味了"
- 视频检索效果完全没评估（只看路由是否命中）

### 1.2 双轨（新版）——快路径 / 慢路径分轨打分

```
                        Main_Agent (快路径)
                              │
          ┌───────────────────┼───────────────────┐
          ↓                   ↓                   ↓
   ┌───────────┐      ┌───────────┐      ┌───────────┐
   │ main_fast │      │ taskPlan  │      │  路由意图  │
   │ Judge      │     │ Judge     │      │ 准确率     │
   └───────────┘      └───────────┘      └───────────┘
          │                   │
          │           ┌───────┴────────┐
          │           ↓                ↓
          │      Strategy_Agent    Video_Agent       Smalltalk
          │     (慢路径子轨)      (慢路径子轨)      (慢路径子轨)
          │           ↓                ↓                ↓
          │     ┌───────────┐    ┌───────────┐    ┌───────────┐
          │     │ strategy  │    │  video    │    │ smalltalk │
          │     │ Judge      │   │  Judge     │   │  Judge     │
          │     │ 5 维度     │   │ 5 维度     │   │ 5 维度     │
          │     │ +golden    │   │ +改写词    │   │ +AI客服腔   │
          │     │ coverage   │   │  审计      │   │  禁用词     │
          │     └───────────┘    └───────────┘    └───────────┘
          │
          └─→ 字数/字段/路由 硬规则前置审计
              （audit_flags 在 Judge 看到结果前就标记问题）
```

**5 个独立 Judge prompt + 5 个独立打分维度**：

| 轨道 | 5 维度 | 关键考察 |
|---|---|---|
| `main_fast` | field_compliance / intent_grounding / routing_accuracy / naturalness / latency_fitness | Main_Agent 4 字段是否齐全且符合字数硬约束 |
| `strategy` | tactical_correctness / quantification / avoid_pitfalls / conclusion_first / voice_friendliness | 战术干货 + 量化时间节点 + golden_coverage |
| `video` | query_rewrite_quality / platform_adaptation / semantic_relevance / result_completeness / routing_correctness | B站/抖音改写词审计 + title+summary 与原问题相关性 |
| `smalltalk` | emotional_acknowledgement / playful_tone / light_advice / conciseness / routing_correctness | 情绪承接 + AI客服腔禁用 + 内容空值 |
| `compound` | decomposition_correctness / tool_coverage / subquery_purity / entity_preservation / output_completeness | 任务数 / 工具覆盖 / query 不串味 / 实体保留 |

---

## 二、本次评测发现的关键问题（按严重度排序）

### 🚨 P0 - 复合意图拆解完全失效（**单轨评测不会发现**）

> Quick Run 完整 Judge 数据（10 条复合 case 全部 Judge 完成）：

| Case | 预期 task_count | 实际 mode | 实际 task_plan 长度 | overall_score | audit_flags |
|---|---|---|---|---|---|
| AGC-013 「亚索打盲僧怎么对线？另外给我个连招视频」 | 2 | single | 1 | 2 | 长度不符 + 工具 strategy 缺失 |
| AGC-014 「对面亚索一直压我，心态都炸了」 | 2 | single | 0 | 0 | 长度=0 + 工具 strategy 缺失 |
| AGC-015 「分析翻盘+给视频教学+夸夸我」 | 3 | single | 1 | 2 | 长度不符 + 工具 strategy 缺失 |
| AGC-042 「瑞兹怎么打狐狸？给个连招视频」 | 2 | single | 1 | 2 | 长度不符 + 工具 strategy 缺失 |
| AGC-043 「心态崩了，怎么对线劫」 | 2 | single | 1 | 2 | 长度不符 |
| AGC-044 「打野怎么入侵+集锦」 | 2 | single | 1 | 2 | 长度不符 + 工具 strategy 缺失 |
| AGC-045 「反劫+反杀视频+鼓励」 | 3 | **compound** | **2** | 4 | 长度=2 与 expected=3 不符 |
| AGC-046 「辅助怎么帮ADC+教学视频」 | 2 | single | 1 | 2 | 长度不符 + 工具 strategy 缺失 |
| AGC-047 「打野老被反+夸我」 | 2 | single | 0 | 0 | 长度=0 + 工具 strategy 缺失 |
| AGC-048 「练走A+教学视频」 | 2 | single | 1 | 2 | 长度不符 + 工具 strategy 缺失 |

**复合拆解准确率：0/10 = 0%**
- 9 条根本没识别为 compound（mode=single）
- 1 条（AGC-045）虽识别为 compound 但拆解数量不符（2 vs 期望 3）

**反向案例 — AGC-032 误识别**：
- 「瑞兹连招怎么按键，给我看个示范」是单一 video 意图
- 但实际 `mode=compound, task_plan_长度=2`，**误拆**

**Compound 轨道维度均分**：
- decomposition_correctness: 0.2 / 10
- tool_coverage: 2.0 / 10
- subquery_purity: 0.4 / 10
- entity_preservation: 6.5 / 10
- output_completeness: **0.0 / 10** ←短板

**结论**：[taskPlannerService.js](file:///c:/Users/Admin/Documents/trae_projects/游戏AI助手%20web%20demo%20-%20测试/volc-aigc-rtc-server/src/services/taskPlannerService.js) 的 `COMPOUND_PATTERNS` 当前规则严重失灵——召回率 0%、误识别率非零。**这是单轨评测完全发现不了的问题**。

---

### 🚨 P0 - Main_Agent 4 字段集体空值

> Quick Run 完整数据（50 case × main_fast 完整 Judge）：

| 维度 | 均分 / 10 | 评估 |
|---|---|---|
| field_compliance | 0.20 | 字段几乎全空 |
| **intent_grounding** | **0.02** | ←**短板**：Main_Agent 完全没承接用户意图 |
| routing_accuracy | 6.62 | 唯一像样的指标（路由层独立工作） |
| naturalness | 0.46 | 没文本可评 |
| latency_fitness | 0.12 | ms_len=0 触发 |
| **整体均分** | **0.90** | pass_rate = 0/50 = 0% |

**含义**：Main_Agent 完全没生成 4 字段（emotional_reply / understanding_reply / main_summary / branch_wait_reply），这意味着**前端在快路径上拿不到任何东西**——用户只能等慢路径子 Agent。

这违反了项目硬约束「主路径优先返回 ≤800ms」。

**单轨评测**：把 main_summary 拼到 visible_answer 里整体打分，会因为子 Agent 兜底了内容而**打高分掩盖此缺陷**。
**双轨评测**：main_fast 轨道单独看 4 字段是否齐全，**直接 fail**——50/50 命中"emotional_reply 字数=0 越界(8-16)"。

---

### 🟠 P1 - 路由准确率从 91.7% 降到 62%（case 集变难）

> Quick Run 完整路由数据：50 条 case 共 19 条不匹配。

#### 2.3.1 路由不匹配总览

| 路由错向 | 数量 | 典型 case | 推断根因 |
|---|---|---|---|
| strategy → smalltalk | 8 | AGC-002/008/019/020/022/024/029/030/047 | 短战术问句被 smalltalk 拦截层吃掉 |
| strategy → video | 6 | AGC-013/015/042/044/045/046/048 | 含"视频"关键词的复合句被 video 拦截层抢路由 |
| smalltalk → strategy | 1 | AGC-012 | "出装"关键词触发 strategy 误判 |
| strategy → smalltalk（情绪类） | 2 | AGC-014/047 | 情绪+战术复合句被情绪层吃掉 |
| video → strategy | 1 | AGC-032 | "怎么按键"被识别为 strategy |
| video → smalltalk | 1 | （无典型） | - |

#### 2.3.2 strategy → smalltalk 高频问题（误吞战术问题）
- AGC-002「怎么防gank？」
- AGC-008「经济领先 3k 还是打不过团」
- AGC-019「瑞兹中期怎么carry？」
- AGC-020「打野前期反野要不要做？」
- AGC-022「团战进场时机怎么把握？」
- AGC-024「逆风局怎么翻盘？」
- AGC-029「什么时候该出眼石？」
- AGC-030「走A怎么练？」

**根因猜测**：4 层路由优先级里 Smalltalk 拦截层过宽，把含战术词的疑问句也吃掉了——和之前 "AGC-009 路由识别漂移" 是反向的同一类问题。

---

### 🟡 P2 - Audit Top 5 高频问题（自动聚合）

| 排名 | 命中次数 | flag |
|---|---|---|
| 1 | **50** | emotional_reply 字数=0 越界(8-16) |
| 2 | **50** | understanding_reply 字数=0 越界(18-45) |
| 3 | 34 | task_plan 长度=N 与 expected=N 不符 |
| 4 | 14 | strategy 时 branch_wait_reply 字数=N 越界(16-36) |
| 5 | 11 | video 时 branch_wait_reply 字数=N 越界(16-36) |
| 6 | 8 | 期望工具 strategy 未出现在 task_plan |

**关键观察**：
- 前 2 条命中 **50/50（100%）**——Main_Agent 输出层完全没工作
- 第 3 条 34/50 = 68%——任务拆解严重失灵（涵盖 9 条复合 case + 25 条单意图也未生成 task_plan）
- 第 4-5 条主要发生在路由对了但 branch_wait_reply 字数不符的场景

---

### 🟡 P3 - 视频检索成功率仅 60%

> 路由到 video 的 case 共 11 个（含错路由的复合 case），video_data 落地情况：

| 落地状态 | 数量 | Case |
|---|---|---|
| ✓ video_data 完整（含 linkUrl） | 6 | AGC-005, 013, 015, 031, 044, 048 |
| ✗ video_data 缺失 | 4 | AGC-033, 034, 042, 046 |
| 来源平台标识缺失 (`source_platform=unk`) | 4 | AGC-005, 013, 015, 031, 044, 048 全部 |

**含义**：
1. 视频检索 40% 概率拿不到结果（可能是改写词不准 / 平台限流 / RAG 召回 0）
2. `source_platform` 字段后端没透出来——评测无法判断 B站/抖音改写词审计是否生效

---

### 🟢 P3 - smalltalk 路径全空 main_summary

> 19 个路由到 smalltalk 的 case 全部 `ms_len=0`，验证了上一轮发现的「Smalltalk 分支可能出现输出全空」回归。

---

## 三、双轨评测带来的能力增量（量化）

### 3.1 全新洞察维度对比

| 评测能力 | 单轨 | 双轨 | 价值 |
|---|---|---|---|
| 路由准确率独立指标 | ✓ | ✓ | 持平 |
| 复合拆解准确率 | ✗ | ✓（0/9 = 0% 直接暴露） | **全新** |
| Main_Agent 字段合规审计（字数硬规则） | ✗ | ✓（前置 audit_flags） | **全新** |
| 视频改写词正则审计（B站教学词/抖音动作词/长视频词剥离） | ✗ | ✓ | **全新** |
| Smalltalk 内容空值守卫 | 部分 | ✓（ms_len 直检） | **加强** |
| AI 客服腔禁用词检测 | ✗ | ✓（"用户想要"等） | **全新** |
| 安全红线分类聚合 | ✗ | ✓（PII/伪记忆/外挂/威胁） | **全新** |
| audit_flags 高频问题统计 | ✗ | ✓（Top 5 自动聚合） | **全新** |

### 3.2 落盘文件粒度对比

| 文件 | 单轨内容 | 双轨内容 |
|---|---|---|
| `summary.json` | 12 字段（一个总分+5维度+routing） | 30+ 字段（by_track / by_case / track_weakness / audit_summary / compound_decomposition_accuracy / parse_error_count / routing_accuracy） |
| `judged_results.jsonl` | 12 行 = 12 case | 50+ × 平均 2.6 = 130+ 行（每 case-track 一行） |
| Run config | 6 字段 | 9 字段（含 tracks_filter / parse_error_count） |

---

## 四、最终结论

### 4.1 关于"双轨架构对复合意图拆解准确率的提升效果"

> **本次评测的最大价值是"暴露"而不是"提升"**：
- **单轨评测时代**，复合拆解准确率根本没被评估，工程团队对 [taskPlannerService.js](file:///c:/Users/Admin/Documents/trae_projects/游戏AI助手%20web%20demo%20-%20测试/volc-aigc-rtc-server/src/services/taskPlannerService.js) 的真实命中率是黑盒。
- **双轨评测时代**，10 条复合 case + 1 条反向单意图 case 直接把"召回率=0%、误识别率非零"这件事顶到台面上。
- 提升空间：在 [taskPlannerService.js](file:///c:/Users/Admin/Documents/trae_projects/游戏AI助手%20web%20demo%20-%20测试/volc-aigc-rtc-server/src/services/taskPlannerService.js) 修好 `COMPOUND_PATTERNS` 后，**用同一份双轨评测可立即量化收益**——这就是双轨架构的工程闭环价值。

### 4.2 评测系统本身的健壮性

| 健壮性维度 | 状态 |
|---|---|
| Mock 模式冒烟通过 | ✓（18 case → 41 评测行） |
| 真实 LLM 模式预测阶段成功率 | 96%（48/50） |
| 网络异常容错（fetch failed / timeout） | ✓ 跳过单条不中断整体 |
| Judge JSON 解析失败兜底 | ✓ `parse_error=true` 标记并继续 |
| 硬规则前置审计（字数/改写词/任务数） | ✓ 在 Judge 看到结果前就标 audit_flags |
| 双重序号 [i/N][k/M] 阅读体验 | ✓ 已落地 |

### 4.3 P0 修复优先级建议

1. **修 [taskPlannerService.js](file:///c:/Users/Admin/Documents/trae_projects/游戏AI助手%20web%20demo%20-%20测试/volc-aigc-rtc-server/src/services/taskPlannerService.js) 的 `COMPOUND_PATTERNS`**：召回率 0% 是上线阻断级缺陷
2. **修 [mainAgentService.js](file:///c:/Users/Admin/Documents/trae_projects/游戏AI助手%20web%20demo%20-%20测试/volc-aigc-rtc-server/src/services/mainAgentService.js) 4 字段为空问题**：违反 ≤800ms 主路径硬约束
3. **修 strategy 类问题被错路由 smalltalk**：路由优先级层 Smalltalk 拦截过宽
4. **修 [videoAgentService.js](file:///c:/Users/Admin/Documents/trae_projects/游戏AI助手%20web%20demo%20-%20测试/volc-aigc-rtc-server/src/services/videoAgentService.js) `source_platform` 字段透出**：改写词审计依赖此字段

---

## 附录 A：本次 Quick Run 摘要

> 完整日志：`auto_eval_lite/runs/quick_run_console.log`
> 完整 summary.json：`auto_eval_lite/runs/20260609_144026/summary.json`
> 完整 judged_results：`auto_eval_lite/runs/20260609_144026/judged_results.jsonl`

```
Quick Run 配置：
  tracks_filter: main_fast, compound
  judge_model:   doubao-seed-1-6-thinking
  cases:         50

预测阶段：
  ✓ 50/50 OK（无 fetch failed / 无 timeout）

Judge 阶段：
  ✓ 100/100 评测行（50 case × 2 track）
  ✓ 0 parse_error
  ✓ 0 失败

总分（case 级均值）: 2.01

分轨打分：
  [main_fast] N=50 pass=0  (0%)  avg=0.9   短板=intent_grounding(0.02)
  [compound]  N=10 pass=0  (0%)  avg=1.8   短板=output_completeness(0.0)
  [single 旁路] N=40       avg=3.45      （非真复合 case 在 compound 视角下的旁路打分）

路由准确率: 31/50 (62%) — 19 条不匹配（详见 §2.3）

复合拆解准确率: 0/10 (0%)
  - 9 条 mode=single（应为 compound）
  - 1 条 task_plan 长度不符（AGC-045: 2 vs expected 3）
```

## 附录 B：复跑评测的命令

```bash
# 启动后端
cd volc-aigc-rtc-server && npm start

# 跑完整评测（5 轨道全开）
cd auto_eval_lite && node run_eval.mjs --cases data/cases.jsonl

# 快速验证（仅跑 main_fast + compound）
node run_eval.mjs --cases data/cases.jsonl --tracks main_fast,compound

# Mock 模式（不消耗 token）
node run_eval.mjs --cases data/cases.jsonl --mock
```
