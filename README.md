﻿# 游戏 AI 助手 —— 面向游戏场景的多 Agent 交互工作台

这是一个面向游戏场景的 AI 助手工程 Demo，也是一套可以用于展示 Agent 架构能力的 showcase。它不是简单的“问一句答一句”聊天机器人，而是尝试把玩家在游戏中的语音、文字、屏幕画面、历史偏好和知识库内容整合起来，让 AI 像一个实时游戏搭子/教练一样，能听懂玩家问题、看见当前局势、查到可靠资料、记住用户习惯，并在合适的时候给出建议。

从用户视角看，它可以帮玩家做这些事：

- **边玩边问**：通过 RTC 语音或文本聊天，询问英雄打法、出装思路、团战决策、资源取舍等问题
- **看画面给建议**：共享游戏画面后，系统会把屏幕信息转成上下文，辅助判断当前局势，而不是只靠用户描述
- **查攻略和资料**：从本地知识库、云端知识库和内置游戏知识中检索内容，再整理成更容易理解的回答
- **找教学视频**：根据用户问题自动生成更适合 B 站、抖音等平台的检索词，返回可打开的视频或搜索结果
- **记住用户偏好**：沉淀用户常玩的英雄、表达偏好、历史问题和画像信息，让后续对话更连续
- **低打扰陪伴**：在高压战斗或不适合长篇解释的场景中，优先短句、轻提示或保持沉默，避免打断玩家

从工程视角看，这个项目围绕标准 Agent 能力做了完整拆解：**感知（Perception）→ 自主规划（Planning）→ 执行（Execution）→ 执行反馈（Feedback）→ 反思（Reflection）→ 记忆沉淀（Memory）**。主链路优先保证实时响应，复杂的 RAG 检索、记忆写入、任务拆解、质量评估和下一轮建议放在异步链路中处理，从而兼顾游戏交互的低延迟和 Agent 系统的长期演进能力。

项目复杂度主要体现在三套“底层能力”：

- **知识库机制**：不是简单关键词搜索，而是多源召回、domain 判断、rerank、缓存、弱命中保护和结果降级，尽量让回答有依据、不硬编
- **记忆库机制**：同时维护用户画像、长期记忆、分层记忆和 overlay，既能展示“AI 记得住”，又能避免 Demo 环境被测试数据污染
- **自动化评测机制**：通过 Auto-Eval Lite、LLM-as-a-Judge、分轨数据集和 mock 脚本，持续验证主回复、策略、视频、复合任务、静默策略等能力是否退化

## 项目定位

这个项目重点解决四类问题：

- 游戏场景下，如何把**文本、语音、屏幕共享**统一成一个可用的交互入口
- 标准 Agent 系统里，如何把**感知、自主规划、执行反馈、反思和记忆**落到真实产品链路中
- 多 Agent 系统里，如何让**主链路低延迟**，同时把知识检索、记忆写入、规划、反思等重逻辑放到异步后台
- 工程演进过程中，如何让架构变化具备**可观测、可评测、可回归**的能力

## 工程亮点

### 1. 闭环式 Agent 架构

项目已经不再是简单的“问一句答一句”，而是围绕完整闭环组织能力：

- **Perception**：RTC 字幕、语音输入、屏幕抽帧、视觉事件统一进入上下文系统
- **Memory**：支持长期记忆、分层记忆、用户画像、覆盖层 overlay、多用户隔离
- **Planning**：支持会话目标追踪、复合任务编排、策略/视频次任务补偿执行
- **Execution**：主链路负责实时响应，Strategy / Video / RTC 桥接等模块承担执行
- **Reflection**：Reflector 在后台异步进行质量评分、下一轮预测、主动话术建议与记忆升级建议

这套设计的核心优势是：**实时链路不被重逻辑拖慢，但系统依然能持续学习和自我修正。**

### 2. 延迟优先的异步反思机制

项目把反思、规划、目标追踪等耗时逻辑明确放到异步侧，而不是阻塞主回复。

- 主回复优先返回，确保语音/文本交互的实时体验
- Reflector 在后台完成质量打分、下一轮桥接问题建议、主动 cue 与记忆升级建议
- 分层记忆与目标追踪在下一轮生效，形成真正的“回看上一轮，优化下一轮”

这是一种非常适合游戏陪玩 / 游戏教练场景的工程折中：**先响应，再思考；先陪伴，再优化。**

### 3. 多源 RAG + 成本控制

知识检索部分已经从单源查询升级为多源融合流程：

- 本地用户库支持 BM25 + Embedding 混合召回
- 云端库支持 `user_cloud` / `house_volc` 等来源并行粗排
- 统一经过 rerank 消除不同来源分数的量纲差异
- 再基于来源权重、域预测、动态阈值做最终排序
- 引入三层缓存（结果缓存 / query embedding / chunk embedding）降低时延与成本
- 当 `user_local` 强命中时，直接跳过云端库，减少不必要的调用费用

这部分是当前工程中非常有代表性的亮点：它不只是“能查到”，而是已经开始认真处理**召回质量、打分统一、成本约束与时延控制**。

### 4. 屏幕观察的“静默感知”设计

项目已打通从前端抽帧到后端视觉理解再到上下文注入的完整链路，但并没有简单地把视觉结果直接变成播报。

当前策略是：

- 前端 `RtcModule` 在共享画面时每 5 秒抽帧一次
- 后端将截图识别为标准化游戏事件 schema
- `screenEventService` 对事件做冷却、去抖、摘要和最近流水维护
- 视觉结果只作为“白板信息”注入 Agent 上下文
- 是否主动说话，最终由 Reflector 统一决定

这让系统具备“看见画面”的能力，同时避免屏幕检测噪声直接变成打扰用户的主动播报。

### 5. 多用户记忆演示机制

为了适配 Demo 与产品验证场景，项目引入了“基线 + 覆盖层”的记忆保护思路：

- 支持多用户切换、新建用户、长期记忆隔离
- 支持 overlay 覆盖层写入，避免污染基线人设
- 支持自动回退与手动 reset，便于演示环境快速恢复

这让系统既能展示“AI 真的记住了用户”，又不会因为连续测试把整套记忆环境弄乱。

### 6. 工程化评测与 Mock 验证体系

项目不只依赖人工主观判断结果，而是已经具备较完整的工程化验证手段：

- `auto_eval_lite`：基于 LLM-as-a-Judge 的轻量评测框架
- 多组 mock 脚本：覆盖分层记忆、会话目标、屏幕事件、上下文注入、失败重试、端到端闭环等关键模块
- 可归档运行结果：支持做回归对比和 Prompt 迭代验证

这意味着本项目不只是功能 Demo，也逐步具备“**可以稳定迭代**”的基础设施。

### 7. RTC CustomLLM 与低打扰对话策略

RTC 通话链路已从“云端固定 Bot”升级为可接入本服务编排的 CustomLLM 模式：

- `/api/agent/rtc-llm-stream` 将 RTC 语音输入接入自研 Agent 编排，而不是只依赖静态 Prompt
- `/api/agent/rtc-push-tts` 负责把编排结果推回 RTC 语音通道
- `body.context` 与 `ExternalPromptsForLLM` 两条路径并行：前者进入 Agent 编排，后者把摘要和反思结果实时投影给 RTC
- 交互层引入 silence guard，在高压战斗、低血量、被动发育等场景下优先短句、轻互动或保持克制，避免“AI 过度打扰”

## 当前能力概览

### 用户可见能力

- 文本聊天、语音聊天、屏幕共享三种主交互模式
- Live2D 桌宠 + 语音气泡 + 交互反馈
- 多 Agent 编排结果展示：文本回复、知识卡片、视频结果、任务日志
- 本地视频工作区 + 实时屏幕共享双工作流
- 用户知识库导入与多用户身份切换
- 反思日志查看入口，方便观察 Reflector 的质量评分、主动提示和记忆升级建议
- 前端内嵌 README 查看能力，部署后可通过 `/api/readme` 稳定访问

### 系统能力

- 基于 FSM 的任务状态流转与意图并发控制
- 主路径 + 次任务补偿的 compound 编排能力
- TaskPlanner 支持启发式 + LLM 拆解 + fallback 的复合任务规划
- 分层记忆写入与加权召回
- 多源 RAG、统一 rerank 与缓存加速
- RAG 弱命中保护：低相关时避免硬编具体事实，并保留 `weak_hit` 诊断信息
- 屏幕观察白板注入与视觉事件治理
- Reflector 异步反思与会话目标追踪
- RTC CustomLLM / TTS / 字幕 / 远端音频控制全链路桥接

## 技术栈

| 层级 | 技术选型 |
| --- | --- |
| 前端 | Vanilla JS (ES Modules)、Live2D、PixiJS |
| 后端 | Node.js、原生 HTTP 服务 |
| 大模型 | Seed 2.0、Seed 1.8 |
| 语音 | 火山引擎 RTC、TTS V3 |
| 记忆 | Viking、Overlay 本地记忆、分层记忆编码 |
| 检索 | 本地混合检索 + 云端知识库 + 统一 Rerank |
| 视觉 | 屏幕抽帧 + 视觉事件标准化 + 白板摘要 |
| 评测 | Auto Eval Lite + 多组 Mock Eval 脚本 |

## 架构总览

### 1. 前端工作台层

前端不是简单的页面拼接，而是一个事件驱动的多模块工作台：

- `App`：全局模式切换（桌宠 / 文本 / RTC）
- `AgentModule`：统一负责用户请求进入编排主链路
- `RtcModule`：负责 RTC、字幕、屏幕共享、抽帧采样
- `WorkspaceModule`：本地视频与共享工作区
- `Live2dModule` / `PetModule`：桌宠渲染、语音反馈、互动展示
- `UserKnowledgeModule`：本地文档知识源管理
- `UserSwitcherModule`：多用户切换、覆盖层提醒、身份演示
- `EventBus`：前端模块之间的统一通信总线

### 2. 后端统一业务网关

后端已经从单纯的 RTC 服务端扩展为统一业务网关，主要包括：

- `/api/agent/*`：Agent 编排、上下文、屏幕输入、SSE 事件流
- `/api/rtc/*`：RTC token、语音通话、功能开关、会话更新
- `/api/data/*`：知识、记忆、用户、会话数据接口
- `/api/media/*`：图片生成、TTS、视频搜索相关接口
- `/api/eval/*`：自动评测生成、真实编排回归验证接口
- `/api/readme`：部署环境下的 README 读取接口

### 3. 核心闭环链路

系统主链路可以概括为：

1. 用户输入通过文本、RTC ASR 或屏幕共享进入前端
2. `AgentModule` 去重、排队、透传到后端编排入口
3. `agentContextService` 组装多源上下文
4. `interactionAgentService` / `mainAgentService` 完成意图识别与主回复生成
5. TaskPlanner 按需拆解 strategy / video / smalltalk / compound / silence 等任务形态
6. Strategy / Video / RTC 等分支按优先级与资源限制执行
7. 主结果通过 SSE 持续回传前端
8. `memoryWriterService`、`reflectorAgentService`、`sessionGoalTrackerService` 等后台链路异步运行
9. 下一轮对话读取新的记忆、目标、屏幕白板与反思结果，形成闭环

## 核心模块说明

### 前端模块

#### `src/modules/agent`

前端与后端编排系统的统一桥接层：

- 统一接收文本、语音、示例按钮、桌宠点击等所有用户输入
- 对 RTC ASR 做时间窗口去重与忙碌保护
- 维护持久 SSE 连接并做页面恢复重连
- 将后端事件映射为前端事件总线消息
- 管理知识卡片、视频结果、任务状态、README 弹窗等展示能力

#### `src/modules/rtc`

RTC 与屏幕能力的核心模块：

- 负责 RTC 进房、退房、远端音频控制、字幕解码
- 支持本地视频共享与实时屏幕共享
- 共享时按周期抽帧并上报视觉识别接口
- 与 Agent 编排状态联动，避免本地 TTS 与云端推流冲突

#### `src/modules/workspace`

多模态工作区：

- 提供本地视频上传、播放、拖拽与控制能力
- 承担屏幕共享与本地视频两条使用路径的承接
- 承担 RTC 功能配置入口与部分演示入口

#### `src/modules/live2d` + `src/modules/pet`

桌宠与反馈层：

- 支持多角色切换、动作表情、气泡字幕
- 支持 TTS 联动、交互点击与角色态展示
- 让 Agent 的交互结果具备更强的产品形态

#### `src/modules/user-knowledge`

用户外挂知识库能力：

- 支持本地知识源管理
- 支持按 domain 组织知识内容
- 为“用户自带知识库 + 云端知识库”混合检索提供前端入口

#### `src/modules/user-switcher`

多用户演示能力：

- 支持多身份切换、新建用户、记忆隔离
- 支持 overlay 状态提示与回退说明
- 支持反思日志查看，便于调试主动提示、会话目标和记忆升级链路
- 方便演示不同用户画像、不同知识与不同记忆环境

### 后端服务

#### `agentOrchestratorService`

整套 Agent 编排主控中心：

- 管理主链路生命周期
- 驱动状态机流转
- 串联上下文构建、主 Agent、Strategy Agent、Video Agent、异步记忆与反思
- 支持主分支先返回、次任务后补偿的复合编排

#### `taskFsmService`

任务状态与并发治理底座：

- 定义任务状态机
- 管理 `strategy` / `video` 等资源池并发
- 支持优先级排队与执行节奏控制

#### `agentContextService`

统一上下文装配器：

- 聚合短期会话、长期记忆、用户画像、分层记忆、会话目标、屏幕白板、多源 RAG
- 控制上下文注入粒度与信息新鲜度
- 为 main / strategy / video 等多类 Agent 提供一致上下文

#### `reflectorAgentService`

异步反思代理：

- 负责质量评分、失败诊断、下一轮桥接问题建议
- 负责主动 cue、目标推断、记忆升级建议
- 不阻塞主回复，是“后台教练”角色

#### `memoryLayerService` + `memoryWriterService`

记忆链路：

- 支持 `working / episodic / semantic / procedural` 分层语义
- 支持层级权重、TTL、时间衰减召回
- 支持 Overlay、本地文件、Viking 协同写入

#### `multiSourceKnowledgeService` + `ragCacheService` + `rerankService`

检索链路：

- 多源并行粗排
- 动态阈值过滤
- 统一 rerank 消除量纲差异
- 结果缓存、embedding 缓存、chunk 缓存
- 本地强命中时跳过部分云端库调用

#### `screenEventService` + `visionFrameService`

屏幕观察链路：

- 负责截图理解、事件标准化、去抖、冷却和摘要构建
- 维护最近视觉事件白板
- 将视觉证据以“静默感知”的形式注入上下文

#### `sessionGoalTrackerService` + `taskPlannerService` + `retryHelperService`

规划与自纠模块：

- 会话目标追踪用于维持长期对话主线
- 任务规划服务支持启发式、LLM 拆解和正则 fallback，覆盖 strategy / video / compound / silence 等任务形态
- 失败重试模块用于异常情况的最小自纠闭环
- `rtcTaskEngagementService` 支持任务暂停、取消、轻互动和可恢复分支，避免旧任务异步回写打断用户新意图

## 工程目录

```text
.
├── index.html
├── main.js
├── src/
│   ├── core/
│   │   ├── app.js
│   │   └── eventBus.js
│   ├── modules/
│   │   ├── agent/
│   │   ├── rtc/
│   │   ├── workspace/
│   │   ├── live2d/
│   │   ├── pet/
│   │   ├── data/
│   │   ├── user-knowledge/
│   │   ├── user-switcher/
│   │   └── intent/
│   └── style.css
├── vendor/
├── static-server.js
├── docs/
├── mock-server/
├── auto_eval_lite/
└── volc-aigc-rtc-server/
    ├── src/
    │   ├── server.js
    │   ├── config.js
    │   ├── utils/
    │   └── services/
    ├── scripts/
    ├── data/
    └── vendor/
```

## 快速开始

### 1. 环境准备

- Node.js 18+
- 火山引擎账号与相关服务开通权限
- 可选：RTC、Ark、TTS、知识库、Viking 记忆库配置

### 2. 配置后端环境变量

```bash
cd volc-aigc-rtc-server
cp .env.example .env
```

至少需要补齐以下配置：

```env
VOLCENGINE_ACCESS_KEY=你的AK
VOLCENGINE_SECRET_KEY=你的SK
VOLC_RTC_APP_ID=你的RTC_APP_ID
VOLC_RTC_APP_KEY=你的RTC_APP_KEY
ARK_API_KEY=你的ARK_API_KEY
VOLC_TTS_APP_ID=你的TTS_APP_ID
VOLC_TTS_ACCESS_TOKEN=你的TTS_ACCESS_TOKEN
```

### 3. 启动后端

在项目根目录执行：

```bash
npm run start
```

默认监听 `http://localhost:8788`。

### 4. 启动前端

本地静态预览：

```bash
node static-server.js
```

默认访问地址：`http://localhost:8081`。

### 5. 使用方式

- 打开页面后，体验文本聊天或 RTC 语音聊天
- 上传本地视频，或进入屏幕共享模式
- 观察编排日志、知识卡片、视频结果与桌宠反馈
- 切换不同用户，查看记忆与知识隔离效果
- 点击右上角 README 按钮，查看内嵌项目文档

## 评测与验证体系

### Auto Eval Lite

项目内置 `auto_eval_lite`，用于快速回归以下问题：

- `main_fast`：主回复是否快速、克制、没有偷跑慢任务内容
- `strategy`：策略内容是否结构化、可信、贴近游戏场景
- `video`：视频链接、平台 query 和结果摘要是否符合预期
- `compound`：复合任务是否能主结果先返回、次任务继续补偿
- `silence`：高压或不适合打扰的场景是否能保持低打扰
- `conversation`：多轮上下文、用户目标和记忆召回是否稳定

典型运行方式：

```bash
cd auto_eval_lite
node run_eval.mjs --cases data/cases.jsonl --profile daily --tracks main_fast,strategy,video,compound,silence
```

长跑评测支持 `--resume <runId>` 断点续跑，并会增量写入 checkpoint，避免一次中断导致整轮结果丢失。评测中还引入了 audit flags，对视频链接缺失、query 风格不符、主回复偷跑慢内容等硬性问题做前置标记，再交给 Judge 打分。

### Mock Eval 脚本

`volc-aigc-rtc-server/scripts/` 下沉淀了多组专项验证脚本，覆盖：

- 分层记忆
- 反思器
- 会话目标追踪
- 屏幕事件与上下文注入
- 失败重试与端到端链路

这部分脚本是当前工程非常重要的基础设施，能够在“模型能力变化、Prompt 变化、架构变化”之后，快速判断系统是否被破坏。

## 部署说明

### 本地静态模式

- README 展示优先尝试 `/api/readme`，如果只启动静态服务器，则回退到 `/README.github.md` 和 `/README.md`
- 适合只验证前端展示能力

### 后端统一服务模式

- README 由 `/api/readme` 提供，当前优先返回 `README.github.md`，不存在时再回退到 `README.md`
- 适合 Render 等公网部署场景
- 不依赖根目录静态白名单，部署稳定性更高

## 适合重点关注的设计取舍

### 1. 为什么反思不放在主链路

因为游戏对话场景更在意“当下有没有回应”，而不是“这一轮有没有想得足够久”。所以项目选择：

- 主链路先低延迟回复
- 反思、规划、目标追踪在后台跑
- 下一轮再利用这些结果提升质量

### 2. 为什么屏幕观察不直接主动播报

因为视觉识别容易有误差，且游戏场景本身噪声高。项目当前采用“白板注入”而不是“看到就说”：

- 保留画面理解能力
- 避免误触发、刷屏和错播
- 让 Reflector 统一决定是否值得主动开口

### 3. 为什么要做多层记忆和 overlay

因为 Demo 场景与真实用户场景不同：

- Demo 需要稳定、可恢复
- 用户又需要“真的被记住”的体验
- overlay 让两者兼得：既能写入，又能随时回退

## 当前待完善方向

- 前端对 `proactive_cue` 的主动播报消费仍可继续强化
- 多源知识库的多模态内容仍可继续扩展到图片/视频级别
- 评测系统仍需要进一步引入线上真实 badcase 做校准
- 复合任务的子查询 purity、strategy 战术正确性、main_fast 自然度仍需持续打磨
- 失败重试、自纠、任务暂停恢复与 RTC 轻互动链路仍有继续收敛和工程化的空间
- README 在线查看器当前是轻量 Markdown 渲染器，后续可升级为更完整的渲染方案

## 相关文档

- `docs/agent-system-interfaces.md`：系统接口与事件流说明
- `auto_eval_lite/README.md`：自动评测体系说明
- `技术复盘报告.md`：项目演进复盘
- `mock-server/README.md`：本地 mock 联调说明

## 说明

本项目当前更适合作为：

- 游戏 AI 助手的产品原型
- 多模态 Agent 系统的工程实验场
- 异步反思、分层记忆、多源 RAG、屏幕感知闭环的参考实现

如果你想快速了解这个项目，建议优先看这四个地方：

1. `main.js`：前端总调度与交互闭环
2. `volc-aigc-rtc-server/src/server.js`：统一服务入口
3. `volc-aigc-rtc-server/src/services/agentOrchestratorService.js`：编排核心
4. `volc-aigc-rtc-server/src/services/agentContextService.js`：上下文系统核心
