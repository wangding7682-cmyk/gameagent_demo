# 火山引擎 AIGC-RTC 业务服务端

一个纯 Node.js 的业务服务端示例，提供以下接口：

- `POST /api/data/knowledge/search`
- `POST /api/data/session/save`
- `GET /api/data/session/list`
- `POST /api/rtc/token`
- `POST /api/rtc/voice-chat/start`
- `POST /api/rtc/voice-chat/update`
- `POST /api/rtc/voice-chat/stop`
- `POST /api/media/douyin/video-search`
- `POST /api/media/douyin/video-resolve`
- `GET /health`

## 目录结构

```text
volc-aigc-rtc-server/
  src/
    config.js
    server.js
    services/
      tokenService.js
      volcRtcOpenApi.js
    utils/
      http.js
      volcSigner.js
  vendor/
    README.md
    rtc-token-generator.example.js
  .env.example
  package.json
```

## 1. 配置环境变量

复制一份配置文件：

```bash
cp .env.example .env
```

Windows PowerShell 也可以直接手动复制改名。

至少要填这几项：

```env
VOLCENGINE_ACCESS_KEY=你的火山引擎 AK
VOLCENGINE_SECRET_KEY=你的火山引擎 SK
VOLC_RTC_APP_ID=AI音视频互动方案 AppId
VOLC_RTC_APP_KEY=RTC AppKey
```

注意：

- `VOLC_RTC_APP_ID` 必须使用 AI 音视频互动方案的 AppId。
- `StartVoiceChat` 使用的 `AppId`，必须与生成 RTC 鉴权 Token 时使用的 `AppId` 一致。
- 旧变量 `VOLC_RTC_AIGC_APP_ID` 目前仅保留为兼容别名，不建议继续使用。
- 知识库检索和 RTC Token 是两套不同鉴权：
  - `知识库检索` 走 AK/SK + HMAC 签名
  - `RTC 进房` 走 `AccessToken.js` 生成的房间 Token

如果你要启用火山知识库检索，再补这些配置：

```env
KNOWLEDGE_BACKEND_MODE=volc
VOLC_KNOWLEDGE_API_STYLE=search_knowledge
VOLC_KNOWLEDGE_HOST=api-knowledgebase.mlp.cn-beijing.volces.com
VOLC_KNOWLEDGE_REGION=cn-north-1
VOLC_KNOWLEDGE_SERVICE=air
VOLC_KNOWLEDGE_SEARCH_PATH=/api/knowledge/collection/search_knowledge
VOLC_KNOWLEDGE_ACCOUNT_ID=你的火山账号 ID
VOLC_KNOWLEDGE_PROJECT=default
VOLC_KNOWLEDGE_RESOURCE_ID=你的知识库 resource_id
```

说明：

- `VOLC_KNOWLEDGE_RESOURCE_ID` 与 `VOLC_KNOWLEDGE_NAME` 二选一即可，优先推荐填 `resource_id`。
- 如果不想单独维护知识库的 AK/SK，可直接复用 `VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY`。
- 默认 `KNOWLEDGE_BACKEND_MODE=mock`，这样前端在不配云端时也能直接演示。

如果你接的是你刚提供的 `service/chat` 方案，则改成：

```env
KNOWLEDGE_BACKEND_MODE=volc
VOLC_KNOWLEDGE_API_STYLE=service_chat
VOLC_KNOWLEDGE_HOST=api-knowledgebase.mlp.cn-beijing.volces.com
VOLC_KNOWLEDGE_SEARCH_PATH=/api/knowledge/service/chat
VOLC_KNOWLEDGE_SERVICE_RESOURCE_ID=kb-service-xxxxxxxx
VOLC_KNOWLEDGE_API_KEY=你的知识库 API Key
```

说明：

- `service_chat` 走 `Authorization: Bearer <API_KEY>`。
- `search_knowledge` 走 `AK/SK + HMAC-SHA256`。
- 两套方式都已兼容在同一个后端服务里，按 `VOLC_KNOWLEDGE_API_STYLE` 切换。

## 2. 接入 RTC Token 生成器

当前仓库已经内置了 RTC Token JS 生成器，文件在：

```text
vendor/rtc-token-generator.js
```

它基于官方 `AccessToken.js` 逻辑适配而来。说明见 `vendor/README.md`。

## 3. 启动

```bash
node ./src/server.js
```

如果你本机安装了 npm，也可以用：

```bash
npm run start
```

默认端口为 `8788`。

## 4. 接口说明

### 4.1 知识库检索

`POST /api/data/knowledge/search`

请求：

```json
{
  "provider": "volc",
  "allowFallback": true,
  "query": "原神新手开荒怎么玩",
  "limit": 5
}
```

返回：

```json
{
  "ok": true,
  "provider": "volc",
  "fallback": false,
  "data": {
    "code": 0,
    "message": "success",
    "request_id": "xxx",
    "data": {
      "collection_name": "example",
      "count": 2,
      "result_list": [
        {
          "point_id": "point-1",
          "chunk_title": "原神新手开荒指南",
          "content": "推荐优先探索蒙德区域...",
          "score": 0.98
        }
      ]
    }
  }
}
```

说明：

- 当 `provider=volc` 时，服务端会按火山知识库 `search_knowledge` 接口发起签名请求。
- 当 `VOLC_KNOWLEDGE_API_STYLE=service_chat` 时，服务端会改为请求 `/api/knowledge/service/chat`。
- 若云端请求失败且 `allowFallback=true`，服务端会自动回退到本地 mock 数据，方便前端继续演示。

### 4.2 视频检索

当前视频检索链路已更新为“平台专属 query + 多源回退”模式：

- `Video_Agent` 会同时生成三路检索词：`generic / bilibili / douyin`
- `B站` 检索词偏教程、详解、思路类长尾表达
- `抖音` 检索词偏实战、连招、高光类短平快表达
- 搜索执行层会分别把对应 query 发给各平台，而不是复用同一串关键词
- 返回结果时优先选择桌面端可直接打开的 B 站视频页，其次才回退到抖音页或搜索页

对前端暴露的直连接口：

- `POST /api/media/douyin/video-search`
- `POST /api/media/douyin/video-resolve`

说明：

- `video-search` 用于前端快速检索抖音候选视频或搜索页链接
- Agent 编排内部实际走 `videoAgentService -> searchUniversalVideo`，会综合 B站、抖音、通用搜索三路结果
- 若站点无法解析出直链，服务端会返回可跳转页面链接，由前端决定如何展示和兜底

### 4.3 保存会话记录

`POST /api/data/session/save`

请求：

```json
{
  "record": {
    "scene": "demo_button",
    "query": "原神新手开荒怎么玩",
    "reply": "推荐优先探索蒙德区域。"
  }
}
```

返回：

```json
{
  "ok": true,
  "data": {
    "count": 3,
    "record": {
      "id": "session_xxx"
    },
    "filePath": "..."
  }
}
```

### 4.4 查询最近会话记录

`GET /api/data/session/list?limit=20`

### 4.5 获取 RTC Token

`POST /api/rtc/token`

请求：

```json
{
  "roomId": "room-demo-001",
  "userId": "user-1001",
  "expireInSeconds": 7200
}
```

返回：

```json
{
  "ok": true,
  "data": {
    "appId": "your_rtc_app_id",
    "roomId": "room-demo-001",
    "userId": "user-1001",
    "token": "xxx",
    "expireInSeconds": 7200,
    "expireAt": "2026-04-29T12:00:00.000Z",
    "extra": {}
  }
}
```

### 4.4 获取 RTC Token

`POST /api/rtc/voice-chat/start`

请求：

```json
{
  "roomId": "room-demo-001",
  "taskId": "task-demo-001",
  "targetUserId": "user-1001",
  "config": {
    "ASRConfig": {
      "Provider": "volcano",
      "ProviderParams": {
        "Mode": "bigmodel",
        "StreamMode": 2
      }
    },
    "LLMConfig": {
      "Mode": "ArkV3",
      "ModelName": "doubao-seed-1-6-251015",
      "SystemMessages": [
        "你是一个游戏 AI 助手，回答尽量简洁。"
      ]
    },
    "TTSConfig": {
      "Provider": "volcano_bidirection",
      "ProviderParams": {
        "Credential": {
          "ResourceId": "seed-tts-1.0"
        },
        "VolcanoTTSParameters": "{\"req_params\":{\"speaker\":\"ICL_zh_female_wuxi_tob\",\"audio_params\":{\"speech_rate":0}}}"
      }
    }
  }
}
```

说明：

- 服务端会自动补 `AppId`。
- 如果未传 `agentConfig.UserId`，默认使用 `.env` 里的 `DEFAULT_AGENT_USER_ID`。
- 如果未传 `agentConfig.WelcomeMessage`，默认使用 `.env` 里的 `DEFAULT_WELCOME_MESSAGE`。

### 4.5 启动智能体

`POST /api/rtc/voice-chat/update`

请求：

```json
{
  "roomId": "room-demo-001",
  "taskId": "task-demo-001",
  "command": "interrupt"
}
```

也支持透传：

- `message`
- `interruptMode`
- `imageConfig`
- `parameters`

例如主动播报：

```json
{
  "roomId": "room-demo-001",
  "taskId": "task-demo-001",
  "command": "ExternalTextToSpeech",
  "message": "欢迎来到游戏大厅。",
  "interruptMode": 1
}
```

### 4.6 更新智能体

### 4.7 停止智能体

`POST /api/rtc/voice-chat/stop`

请求：

```json
{
  "roomId": "room-demo-001",
  "taskId": "task-demo-001"
}
```

## 5. 前端对接建议

你现在前端 `src/modules/rtc/index.js` 里是 mock 服务，后续可以替换成：

- 先调 `/api/rtc/token` 获取 `appId/token/roomId/userId`
- 前端 RTC SDK 用返回的 token 进房
- 成功进房后调 `/api/rtc/voice-chat/start`
- 过程中按需调 `/api/rtc/voice-chat/update`
- 挂断时调 `/api/rtc/voice-chat/stop`

数据模块前端 `src/modules/data/index.js` 已支持两种运行模式：

- `mock`：只用前端本地 mock 数据和 `localStorage`
- `cloud`：优先调用 `http://127.0.0.1:8788/api/data/knowledge/search`，并可将会话记录同步到服务端

前端运行时配置在页面里通过 `window.__GAME_AI_RUNTIME__` 注入，例如：

```html
<script>
  window.__GAME_AI_RUNTIME__ = {
    dataMode: 'cloud',
    knowledgeProvider: 'volc',
    apiBaseUrl: 'http://127.0.0.1:8788',
    allowKnowledgeFallback: true,
    sessionSyncToServer: true
  };
</script>
```

## 6. 当前限制

- `StartVoiceChat/UpdateVoiceChat/StopVoiceChat` 已按官方 OpenAPI 签名方式实现。
- 默认 OpenAPI 版本已对齐为 `2025-06-01`，也可通过环境变量覆盖。
- `RTC Token` 已内置 JS 实现，可直接通过 `/api/rtc/token` 下发。
- 当前服务仅做业务服务端示例，没有接数据库、鉴权中间件、日志平台和回调落库。
