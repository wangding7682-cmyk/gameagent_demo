# Agent 系统接口与主数据流

## 1. 架构总览

当前系统已经切换为统一 Agent 编排架构：

- 前端统一入口：文本聊天、桌宠点击、RTC 文字、RTC ASR
- 后端主控：`Main_Agent -> Strategy_Agent / Video_Agent`
- 上下文来源：短期记忆 + 真实 RAG + 动态上下文槽
- 输出目标：TTS、知识卡片、视频卡片、编排日志

## 2. 主数据流

### 2.1 文本聊天 / 桌宠点击

1. 前端触发 `USER_SEND_QUERY`
2. `AgentModule.handleUserQuery()` 调用 `/api/agent/orchestrate/stream`
3. 后端 `agentContextService` 聚合：
   - 会话短期记忆
   - 动态上下文
   - 真实 RAG 检索
4. 后端 `Main_Agent` 输出：
   - `intent`
   - `emotional_reply`
   - `main_summary`
5. 根据 `intent` 路由：
   - `smalltalk` -> 直接结束
   - `strategy` -> `Strategy_Agent`
   - `video` -> `Video_Agent`
6. 前端按 SSE 事件映射：
   - `main_reply` -> `TRIGGER_TTS` + `CHAT_REPLY`
   - `voice_delta` -> `TRIGGER_TTS`
   - `card_ready` -> `TRIGGER_KNOWLEDGE`
   - `video_ready` -> `TRIGGER_video`
   - `video_failed` -> `ABILITY_FEEDBACK` + `CHAT_REPLY`

### 2.2 RTC 语音

1. RTC 侧产生 ASR 稳定文本
2. 前端触发 `RTC_USER_ASR`
3. `main.js` 将其统一转发到 `AgentModule.handleUserQuery(..., { source: 'rtc_asr' })`
4. 后端进入同一套编排链路
5. SSE 结果返回前端后，继续映射为 TTS / 卡片 / 视频

### 2.3 Demo 按钮

1. 点击 `知识卡片示例`
2. 前端发出 `USER_SEND_QUERY`
3. 额外附带：
   - `source = demo_button`
   - `forceMock = true`
4. `Strategy_Agent` 的 RAG 进入 Mock 分支

## 3. 当前接口清单

### 3.1 Agent 编排接口

#### `POST /api/agent/orchestrate/stream`

- 用途：正式流式编排入口
- 入参：

```json
{
  "text": "对面选了盲僧，我该怎么打？",
  "sessionId": "web_123",
  "source": "text_chat|pet_tap|rtc_asr|rtc_text|demo_button",
  "forceMock": false,
  "context": {
    "frameContext": {
      "summary": "识别到敌方打野在河道",
      "objects": ["盲僧", "河道"]
    }
  }
}
```

- SSE 事件：
  - `agent_state`
  - `main_reply`
  - `voice_delta`
  - `card_ready`
  - `video_ready`
  - `video_failed`
  - `done`
  - `error`

#### `POST /api/agent/orchestrate/start`

- 用途：非流式 fallback / 调试
- 返回完整 `state + events`

### 3.2 Agent 上下文与状态接口

#### `POST /api/agent/context/frame`

- 用途：写入动态图文/视频帧上下文槽

#### `GET /api/agent/session/:sessionId/state`

- 用途：查看短期记忆和动态上下文

#### `POST /api/agent/session/clear`

- 用途：清空会话级短期记忆

### 3.3 Agent 日志接口

#### `GET /api/agent/traces`

- 用途：查看最近编排日志
- 支持参数：`sessionId`、`intent`、`status`、`keyword`、`limit`、`offset`

#### `GET /api/agent/traces/:turnId`

- 用途：查看单轮详情

### 3.4 兼容旧接口

#### `POST /api/agent/intent`

- 状态：兼容保留，不再作为正式前端入口
- 用途：旧 `IntentModule` 回滚或临时调试

### 3.5 媒体能力接口

#### `POST /api/media/image/generate`

- 用途：知识卡片图像生成

#### `POST /api/media/douyin/video-search`

- 用途：抖音视频搜索

#### `POST /api/media/douyin/video-resolve`

- 用途：视频直链解析

#### `POST /api/media/tts/generate`

- 用途：生成 TTS 音频

#### `GET /api/media/tts/audio`

- 用途：拉取 TTS 音频

### 3.6 RTC 相关接口

- `GET /api/rtc/profile`
- `POST /api/rtc/profile/update`
- `GET /api/rtc/voice-chat/features`
- `POST /api/rtc/voice-chat/features`
- `POST /api/rtc/token`
- `POST /api/rtc/voice-chat/start`
- `POST /api/rtc/voice-chat/update`
- `POST /api/rtc/voice-chat/stop`
- `POST /api/rtc/session/message`
- `POST /api/rtc/callbacks/function-calling`

### 3.7 数据层接口

- `GET /api/data/session/list`
- `POST /api/data/session/save`
- `GET /api/data/knowledge/health`
- `POST /api/data/knowledge/search`
- `GET /api/data/memory/list`
- `GET /api/data/memory/item`
- `GET /api/data/memory/history`
- `GET /api/data/memory/job`
- `GET /api/data/memory/project/list`
- `GET /api/data/memory/project/detail`
- `GET /api/data/memory/health`
- `POST /api/data/memory/search`
- `POST /api/data/memory/save`
- `POST /api/data/memory/update`
- `POST /api/data/memory/delete`
- `POST /api/data/memory/delete-all`

## 4. Agent 内部服务职责

### `agentContextService`

- 读取会话短期记忆
- 合并动态上下文
- 进行主脑前置 RAG 检索
- 当前已支持超时/异常降级：
  - RAG 超时不会打断整轮编排
  - 会返回 `fallback = true`
  - 错误信息写入 `state.degraded_reason` 和编排日志

### `mainAgentService`

- 负责三选一路由
- 输出：
  - `intent`
  - `emotional_reply`
  - `main_summary`
  - `route_reason`

### `strategyAgentService`

- 正式链路：二次真实 RAG + 战术卡片生成
- Demo 按钮：Mock 检索
- 输出：
  - `title`
  - `details[]`
  - `image_prompt_text`
  - `voice_chunks[]`

### `videoAgentService`

- 改写高价值抖音搜索词
- 检索视频并校验可播放直链
- 当前已支持超时/异常捕获：
  - 视频搜索超时
  - 视频 URL 缺失
  - 视频 URL 明显不是可播放直链

### `agentOrchestratorService`

- 负责整轮编排
- 负责把异常转成：
  - `error`
  - `video_failed`
  - `degraded`
  - `degraded_reason`
- 负责写：
  - 会话短期记忆
  - 编排日志

## 5. 降级与异常策略

### 5.1 RAG 超时 / 失败

- 当前行为：
  - 不直接中断整轮
  - 返回空知识结果
  - `fallback = true`
  - 主脑继续根据短期记忆和原问题完成路由
  - 最终 trace 中记录错误原因

### 5.2 视频直链失效 / 解析失败

- 当前行为：
  - 不再让整轮失败
  - 返回 `video_failed` 事件
  - 前端展示“已识别找视频意图，但当前未拿到稳定可播放直链”
  - trace 记录 `degraded_reason`

### 5.3 主脑/子脑 LLM 异常

- `Main_Agent`：已有本地关键词兜底路由
- `Strategy_Agent`：已有固定结构卡片兜底
- `Video_Agent`：已有查询词兜底，但视频仍要求可播放直链

## 6. 正式链路与调试链路

### 正式链路

- 文本聊天
- 桌宠点击
- RTC 文本
- RTC ASR

全部统一进入 `/api/agent/orchestrate/stream`

### 调试链路

- 右侧 `replyMode` 现在仅表示“调试覆盖模式”
- `知识卡片示例` 按钮保留 Demo Mock
- `/api/agent/intent` 保留兼容调试价值，但已不在主流向内

## 7. 当前仍建议的下一步

- 把“调试覆盖模式”真正接成后端可识别的 `debugOverrideMode`
- 给 `video_failed` 加一个候选链接弹窗，而不是只在聊天区提示
- 给 `degraded` 状态增加前端可见标识，便于现场演示排查
