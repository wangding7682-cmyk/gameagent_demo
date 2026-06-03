# 游戏 AI 助手 —— 多 Agent 智能体交互工作台  
体验链接：https://gameagent-demo.onrender.com/
一个基于**火山引擎生态**的游戏 AI 助手，核心形态为"纸片人智能体"，通过实现实时对话、知识检索与视频推荐来解决玩家问询，搜索诉求。系统采用 **FSM 驱动的分层异步并发多 Agent 架构**，支持语音/文本/屏幕共享三种交互模态。

## 项目预览

前端工作台集成了 Live2D 桌宠、语音通话、视频工作区、知识卡片和 Agent 编排日志等完整交互能力。

## 技术栈

| 层级   | 技术选型                                             |
| ---- | ------------------------------------------------ |
| 前端   | Vanilla JS (ES6 Modules)、Live2D、PixiJS           |
| 后端   | Node.js (≥18.0.0)、原生 http 模块                     |
| AI   | 火山引擎 Ark (LLM)、TTS V3 (语音合成)                     |
| RTC  | 火山引擎 RTC Web SDK（实时通话、ASR 语音识别）                  |
| 知识库  | 火山引擎 RAG 知识库 (search\_knowledge / service\_chat) |
| 记忆库  | 火山引擎 Viking 记忆库 (event\_v1 + profile\_v1)        |
| 视频搜索 | 多源视频搜索（B站/抖音/Bing），平台专属检索词改写，优先返回桌面端可用链接 |
| 评测   | LLM-as-a-Judge 自动评测框架                            |

## 核心特性

- **多模态交互**：语音聊天、文本聊天、屏幕共享三种模式一键切换
- **Live2D 桌宠**：可切换造型的纸片人智能体，支持语音播报气泡、互动点击
- **多 Agent 编排**：Main\_Agent 意图路由 + Strategy\_Agent 战术卡片 + Video\_Agent 视频搜索
- **FSM 状态机驱动**：严谨的任务状态流转（CREATED → CONTEXT\_LOADING → ROUTING → MAIN\_REPLIED → BRANCH\_EXEC → DONE）
- **并发池控制**：strategy / video 各限 2 并发，支持 high/normal/low 优先级插队
- **长期记忆沉淀**：MemoryWriter 异步提取高价值事实/偏好/禁忌，写入本地文件 + Viking 云端
- **自动评测**：LLM-as-a-Judge 5 维度评测体系，支持路由准确率验证与 Prompt 迭代
- **分级输出裁剪**：L0(语音) → L3(调试) 四级内容裁剪，确保不同模态输出合适粒度的内容
- **完整的降级策略**：RAG 超时降级、视频搜索自动回退到 B 站可用页 / 搜索页、Strategy\_Agent 自动重试（2次）

***

## 架构总览

```
┌────────────────────────────────────────────────────────────────┐
│                         用户交互层                               │
│     语音输入 (RTC ASR)  │  文本聊天  │  桌宠点击  │  示例按钮    │
└───────────────────────────┬────────────────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │  前端事件总线 (EventBus)    │
              │  main.js — 总调度中心      │
              └─────────────┬─────────────┘
                            │
    ┌───────────────────────┼───────────────────────┐
    │                       │                       │
┌───▼───┐  ┌───▼───┐  ┌───▼───┐  ┌───▼───┐  ┌───▼───┐
│ Agent │  │  RTC  │  │Live2D │  │  Pet  │  │Workspc│
│Module │  │Module │  │Module │  │Module │  │Module │
└───┬───┘  └───┬───┘  └───────┘  └───────┘  └───────┘
    │          │
    │   ┌──────┴──────┐
    │   │ RTC 字幕/ASR │
    │   │ 消息通道      │
    │   └─────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│                  后端 API 服务 (Node.js :8788)                    │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐ │
│  │  Agent 编排层     │  │  RTC 智能体桥接层  │  │  数据/媒体层    │ │
│  │                  │  │                   │  │                │ │
│  │ Orchestrator     │  │ LLM Stream        │  │ Knowledge API  │ │
│  │ TaskFSM          │  │ Push TTS          │  │ Viking Memory  │ │
│  │ ConcurrencyPool  │  │ Interaction Agent │  │ TTS Service    │ │
│  │ PriorityDetector │  │ RTC Session State │  │ Video Search   │ │
│  │ OutputTrimmer    │  │ Persona Profile   │  │ Image Gen      │ │
│  │ TraceLogger      │  │ Function Calling  │  │ Session Store  │ │
│  └─────────────────┘  └──────────────────┘  └────────────────┘ │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Context / Memory / Profile                                │  │
│  │  AgentContextService → AgentProfileLoader → MemoryWriter   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

***

## 模块详解

### 前端模块 (`src/modules/`)

前端采用**事件总线 (EventBus)** 单例模式解耦各模块，`main.js` 作为总调度中心注册所有跨模块事件。

#### AgentModule — Agent 编排前端桥接

- **职责**：作为前端与后端 Agent 编排系统的唯一通信入口
- **核心能力**：
  - `handleUserQuery()` 统一接收所有来源（文本聊天、RTC ASR、桌宠点击、示例按钮）的用户查询
  - 请求去重：基于文本相似度 (bigram Jaccard + 长度比) 和 4s 时间窗口，防止 RTC ASR 并发触发
  - 请求排队：当 Agent 正在处理时，RTC 信号自动入队（最多 10 条），非 RTC 信号支持排队
  - 持久 SSE 连接：`/api/agent/orchestrate/events` 建立长连接，自动重连（3s 间隔），支持 `visibilitychange` 页面恢复检测
  - SSE 事件分发：将后端 SSE 事件（`task_created`、`main_reply`、`card_ready`、`video_ready` 等）映射为 EventBus 事件
  - 知识卡片生命周期管理：图片生成异步 fetch + 45s 超时降级、loading 态、图文卡片渲染
  - RTC CustomLLM 模式切换：RTC 通话时抑制本地 TTS，避免与云端推流冲突

#### RtcModule — 火山 RTC 实时通信

- **职责**：封装火山引擎 RTC Web SDK，管理实时音视频通话
- **核心能力**：
  - Token 生成：内置前端 HMAC-SHA256 Token 生成器（仅供 Demo，生产需服务端下发）
  - 进房/退房：管理 RTC 引擎生命周期（createEngine → joinRoom → startVoiceChat → leaveRoom）
  - 字幕解码：解析火山 RTC 的 `subv` 二进制字幕消息，区分 ASR（用户语音）与 Assistant 字幕
  - 屏幕共享：从本地 `<video>` 元素 `captureStream()` 捕获画面，通过外部视频轨道发布到 RTC 房间
  - 远端音频控制：支持按 Agent 编排状态自动静音/恢复远端 AI 助手原声音频
  - Token 自动续期：监听 `onTokenWillExpire` 事件自动续签

#### Live2dModule — 纸片人桌宠

- **职责**：Live2D 模型渲染、动画控制、语音播报气泡
- 支持多造型切换（长发/短发等）、表情切换
- 接收 `TRIGGER_TTS` 事件触发语音气泡，播报完成后自动隐藏
- 响应点击事件 `pet_tap` 触发 Agent 互动

#### WorkspaceModule — 视频工作区

- **职责**：管理游戏视频的上传、播放、进度控制
- 支持本地视频文件拖拽上传
- 视频播放器控制（播放/暂停/静音/全屏/进度条）
- 视频源变化通知 RTC 模块自动同步屏幕共享

#### PetModule / DataModule

- **PetModule**：管理纸片人 UI 面板（模式切换按钮、造型选项等）
- **DataModule**：管理本地数据存储（localStorage 会话记录）

***

### 后端服务 (`volc-aigc-rtc-server/src/services/`)

#### agentOrchestratorService — Agent 编排器（核心调度引擎）

- **职责**：整轮 Agent 编排的生命周期管理
- **核心流程**：
  1. 创建任务（`taskStore.createTask`）→ FSM 状态: `CREATED`
  2. 加载上下文（`buildAgentContext`）→ `CONTEXT_LOADING`，包含 RAG 检索 + 短期记忆 + 动态上下文
  3. 意图路由（`localRouteIntent`）→ `ROUTING` → `MAIN_REPLIED`，基于关键词的分层路由
  4. 分支执行：strategy → `IntentConcurrencyPool.acquire('strategy')` → `runStrategyAgent`
  5. 分支执行：video → `IntentConcurrencyPool.acquire('video')` → `runVideoAgent`
  6. 任务完成：写编排日志 + 会话记录 + 异步触发 MemoryWriter

#### taskFsmService — 任务状态机 + 并发池

- **TaskStateStore**：管理任务生命周期，严格校验状态转换合法性
  - 状态定义：`CREATED → CONTEXT_LOADING → ROUTING → MAIN_REPLIED → BRANCH_QUEUED → BRANCH_EXEC → ASSET_READY → DONE/DEGRADED/FAILED/CANCELLED`
- **IntentConcurrencyPool**：意图级别的并发控制
  - strategy 上限 2、video 上限 2
  - 优先级队列：high > normal > low，同优先级 FIFO
  - 支持动态排队位置回调

#### agentContextService — 上下文聚合

- 聚合多源上下文：会话短期记忆 + 动态帧上下文（来自 `POST /api/agent/context/frame`）+ RAG 知识检索
- RAG 超时/异常时返回 `fallback=true`，不阻塞编排主流程
- 结果缓存在 context.rag 中，Main\_Agent 和子 Agent 共享，**严禁重复检索**

#### interactionAgentService — 交互路由 Agent（轻量级）

- 基于关键词正则的本地意图路由（非 LLM 调用，延迟极低）
- 三层优先级：smalltalk 拦截 → strategy → video → 兜底 smalltalk
- 4 层 smalltalk 拦截规则：观点确认类、自我怀疑类、玩法哲学类、纯闲聊类
- 即使包含战术关键词（如"出装"），只要核心意图是情绪确认，也会正确路由到 smalltalk

#### strategyAgentService — 战术 Agent

- 对接 RAG 知识库进行二次检索，生成结构化战术卡片
- 输出：`title`、`details[]`（要点列表）、`image_prompt_text`（可选生图提示）、`voice_chunks[]`（语音播报分句）
- 支持 Demo Mock 模式（`forceMock=true`）用于前端演示

#### videoAgentService — 视频 Agent

- 多源视频搜索：B站、抖音、Bing，按平台分别使用专属检索词
- 平台专属改写：统一生成 `generic / bilibili / douyin` 三路 query，B站偏教程详解，抖音偏实战高光
- 链接选择策略：优先返回 B 站视频页等桌面端可直接打开的页面链接，其次再回退到抖音页或搜索页
- 直链解析保留：若站点能直接解析出 `.mp4` / `.m3u8` 等可播放直链，仍优先返回直链
- 超时/异常降级：搜索失败时返回候选链接 + `video_failed` 事件

#### rtcLlmBridgeService / rtcLlmStreamService / rtcPushTtsService — RTC 智能体桥接

- **rtcLlmBridgeService**：管理 RTC 会话的编排状态，提供 SSE 事件缓冲与订阅
- **rtcLlmStreamService**：处理 CustomLLM 模式下的流式 LLM 响应
- **rtcPushTtsService**：接收前端 TTS 推送请求，通过 `UpdateVoiceChat(ExternalTextToSpeech)` 下发播报

#### memoryWriterService — 记忆沉淀器（异步）

- **阶段 A**：编排完成后异步触发，调用 LLM 从单轮对话中提取高价值长期记忆候选
- 三分类：facts（事实）、preferences（偏好）、avoidances（禁忌）
- 去重：基于规范化文本 canonicalization，避免与已有记忆重复
- 本地存储：JSON Patch 增量更新 `data/memory/<userId>.longterm.json`
- 云端同步：同时写入 Viking 记忆库（`event_v1` 类型，对话消息数组模式）

#### volcVikingMemoryService — Viking 云端记忆

- 提供 `vikingAddEvent` / `vikingSearchProfile` / `vikingSearchEvent` / `vikingSearchMemory` / `vikingGetContext` 完整 API
- 使用 `Bearer` token 认证，区别于旧版 Mem0 的 `Token` 格式

#### 其他关键服务

- **outputTrimmerService**：L0(语音) \~ L3(调试) 四级内容裁剪规则
- **priorityDetectorService**：基于正则匹配"赶紧""马上"等关键词自动设定优先级
- **agentTraceLoggerService**：JSONL 格式编排日志，支持按 sessionId/intent/status/keyword 筛选
- **agentProfileLoaderService**：加载本地长期记忆 + 用户画像 + Agent 偏好配置
- **rtcPersonaProfileService**：管理 RTC 实时画像（Function Calling 回调触发更新）
- **arkChatService / arkImageService**：火山 Ark LLM 调用 + 知识卡片图像生成
- **volcKnowledgeApi**：火山知识库检索（支持 search\_knowledge 和 service\_chat 两种模式）

***

## 目录结构

```
├── index.html                     # 前端主页面
├── main.js                        # 前端总调度中心（事件注册 + 跨模块逻辑）
├── src/
│   ├── core/
│   │   ├── app.js                 # 全局模式管理 (default/pet/rtc/text_chat)
│   │   └── eventBus.js            # 全局事件总线（单例模式）
│   ├── modules/
│   │   ├── agent/index.js         # Agent 编排前端桥接
│   │   ├── rtc/index.js           # RTC 实时通信模块
│   │   ├── live2d/index.js        # Live2D 桌宠模块
│   │   ├── pet/index.js           # 纸片人 UI 面板
│   │   ├── workspace/index.js     # 视频工作区
│   │   └── data/index.js          # 本地数据存储
│   └── style.css                  # 全局样式
├── vendor/                        # 第三方库
│   ├── live2d/                    # Live2D SDK + 模型
│   └── volcengine-rtc.min.js      # 火山 RTC Web SDK
├── volc-aigc-rtc-server/          # 后端 API 服务
│   ├── src/
│   │   ├── server.js              # 服务入口 + 全部 API 路由
│   │   ├── config.js              # 环境变量配置加载
│   │   ├── services/              # 30+ 业务服务
│   │   └── utils/                 # 工具函数 (HTTP/签名)
│   ├── data/
│   │   ├── personas/              # Agent 人设配置
│   │   └── default-start-voice-chat.json  # RTC 默认配置
│   └── vendor/                    # RTC Token 生成器
├── auto_eval_lite/                # 自动评测系统
│   ├── run_eval.mjs               # 主评测程序
│   ├── prompts/judge_prompt.txt   # Judge Prompt 模板
│   ├── data/cases.jsonl           # 12 条评测用例
│   └── runs/                      # 评测结果存档
├── docs/                          # 架构文档
├── mock-server/                   # 前端 Mock API 服务
└── 技术复盘报告.md                 # 项目技术复盘（8 个里程碑）
```

***

## 快速开始

### 1. 环境准备

- Node.js ≥ 18.0.0
- 火山引擎账号（需开通 RTC、Ark、TTS、知识库等服务）

### 2. 配置环境变量

```bash
cd volc-aigc-rtc-server
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
VOLCENGINE_ACCESS_KEY=你的火山引擎 AK
VOLCENGINE_SECRET_KEY=你的火山引擎 SK
VOLC_RTC_APP_ID=AI音视频互动方案 AppId
VOLC_RTC_APP_KEY=RTC AppKey
ARK_API_KEY=Ark API Key
VOLC_TTS_APP_ID=TTS AppId
VOLC_TTS_ACCESS_TOKEN=TTS Token
```

### 3. 启动后端

```bash
npm run start
# 或
node ./volc-aigc-rtc-server/src/server.js
```

后端默认运行在 `http://localhost:8788`。

### 4. 启动前端

```bash
node static-server.js
```

前端默认运行在 `http://localhost:8081`。

或者直接双击打开 `index.html`（部分功能需要 HTTP 服务环境）。

### 5. 使用

1. 打开浏览器访问前端页面
2. 点击纸片人下方的 **"语音聊天"** 按钮开始 RTC 通话
3. 或点击 **"文本聊天"** 按钮进入文字交互
4. 上传一段游戏视频，切换到 **"屏幕共享"** 模式实现边玩边问
5. 点击右上角 **"多Agent编排任务日志"** 查看后台编排详情

***

## 评测系统 (auto\_eval\_lite)

项目内置了基于 **LLM-as-a-Judge** 的轻量级自动评测框架，用于评估 Main\_Agent 路由准确性与回复质量。

### 评测维度（5 维 × 0-10 分）

| 维度                     | 考察重点                        |
| ---------------------- | --------------------------- |
| tactical\_quality      | 战术逻辑正确性、操作指令精确度、量化程度        |
| structural\_compliance | strategy 是否遵循"结论→操作→避坑"三层结构 |
| tone\_authenticity     | 游戏黑话使用、避免 AI 播音腔            |
| emotional\_boundary    | 安全底线 + 情绪价值                 |
| conciseness            | 无冗余寒暄、直接响应需求                |

### 运行评测

```bash
cd auto_eval_lite
node run_eval.mjs --cases data/cases.jsonl
```

详细评测设计见 [auto\_eval\_lite/README.md](auto_eval_lite/README.md)。

***

## 降级与容错

| 场景                 | 策略                                            |
| ------------------ | --------------------------------------------- |
| RAG 知识检索超时/失败      | 不中断编排，返回空知识结果 + `fallback=true`               |
| 视频直链解析失败           | 返回候选链接 + `video_failed` 事件，不阻塞主流程             |
| Strategy\_Agent 失败 | 自动重试 2 次（间隔 1.5s），耗尽则输出降级卡片                   |
| 知识卡片图片生成超时         | 45s 超时后仅显示文字卡片，不丢失已加载内容                       |
| SSE 连接断开           | 前端 3s 自动重连 + `visibilitychange` 页面恢复检测        |
| 火山服务凭证缺失           | 静默降级到 Mock 模式，确保 Demo 可运行                     |
| ASR 并发触发           | 前端 4s 去重窗口 + AgentModule 忙碌保护 + 1000ms 滑动窗口合并 |

***

## 待优化方向

### 架构演进

- 反思闭环：执行后自我评估与多轮修正机制
- LLM 自主规划：从关键词路由向 LLM 自主任务路径规划演进
- 工具注册中心：统一工具注册、版本管理与异步处理
- 分布式状态：会话状态的分布式同步、并发锁及超时回收
- 子任务中断与中间态保持：当前 FSM 的 CANCELLED 为终态，取消后已加载的上下文、RAG 结果、部分策略内容直接丢弃，无法复用。需支持：(1) 静默任务模式——允许 Agent 后台持续执行长任务不阻塞用户新请求；(2) 可恢复中断——用户发起新需求时保留中间态快照，基于已有上下文仅重做受影响环节，避免重复计算

### 记忆系统

- 摘要压缩：长期对话的自动摘要压缩，降低上下文膨胀
- 画像分层：区分短期会话画像与长期用户画像，精细化上下文注入
- 云端同步可靠性：Viking 写入的幂等性与重试机制
- 记忆分类精细化与冲突治理：当前三分类（facts / preferences / avoidances）中 facts 内部混杂客观事实与主观感受，缺乏情感维度独立建模。同时缺失语义级冲突检测（两条矛盾记忆仅做文本去重不做语义仲裁）、记忆可信度衰减（低 confidence 或长期未复现的记忆应自动降权/淘汰以防止 LLM 幻觉污染长期记忆库）、以及记忆完整性校验（对意外篡改或覆盖的防护）

### Prompt 质量

- Main\_Agent 量化要求强化：补充"1分20秒插眼""2分钟看小地图"等量化时间节点
- 避坑提醒系统性注入：每个 strategy 回复强制包含"人不够别开大龙"类避坑提示
- Smalltalk 话术增强：强化"俏皮+撒娇+轻量建议"风格
- 路由规则微调：修复"出装真的好吗"类情绪问题被误路由到 strategy

### 知识库

- 多模态内容注入：当前仅注入文本内容（API 层已预留 image\_query 等参数但未实际使用），缺乏图片、视频等素材覆盖
- 检索质量评测体系：当前无检索准确率/召回率的量化评测，需建立独立的知识库检索质量 benchmark
- 大规模内容下的检索参数调优：在大规模内容场景下验证 dense\_weight、rerank、chunk\_diffusion 等参数的最优配置

### RTC 体验

- ASR 回声消除：优化 TTS 播报后的短 ASR 误触发过滤
- 字幕流式显示：增加 streaming 字幕的 UI 展示（当前仅展示 final 句）
- 打断体验：优化"停止小G说话"按钮的打断响应延迟

### 前端工程

- 构建工具链：引入 Vite/Webpack 进行模块打包与 Tree Shaking
- 响应式适配：移动端布局支持
- 单元测试 + E2E 测试覆盖

### 评测体系

- 扩充 Case 集：补充 safety\_boundary（辱骂/越权/注入）和 adversarial（对抗样本）
- Judge 模型独立性：当前 Judge 与 Main\_Agent 共用同一模型，存在评分偏差风险。需引入线上真实对话的 badcase 回归机制，持续校准各维度评分阈值，避免评测标准脱离实际业务场景
- 评测自动化 CI：接入 GitHub Actions 自动跑评测

### 可观测性

- 结构化日志平台：从 console.log 迁移到统一日志系统
- 编排链路追踪：可视化 Agent 调用链与耗时分析
- 实时监控告警：RTC 建会成功率、RAG 检索延迟等核心指标

***

## 许可证

Private — 仅供内部 Demo 与学习参考使用。
