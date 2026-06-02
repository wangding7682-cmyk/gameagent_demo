# Monitor Mock Server

这个目录提供一个零依赖的 `monitor.v1` 联调包，方便给 `v2/index.html` 的线上房间监测模式做本地联调。

当前这台 Windows 机器推荐直接使用 PowerShell 版本。

## 启动

### PowerShell 版

```powershell
powershell -ExecutionPolicy Bypass -File .\server.ps1
```

### Python 版

```bash
python server.py
```

默认监听：

- `http://127.0.0.1:8765/health`
- `http://127.0.0.1:8765/api/monitor`

## 前端连接方式

在 `v2/` 页面切到 `线上房间监测模式` 后，填写：

- 接入方式：`HTTP 轮询`
- 接口地址：`http://127.0.0.1:8765/api/monitor`
- 轮询间隔：`5000`

然后点击 `连接监控` 即可。

## 请求协议

前端会发送 `POST /api/monitor`：

```json
{
  "type": "monitor.subscribe",
  "version": "monitor.v1",
  "transport": "http",
  "appId": "demo-app-id",
  "appKey": "demo-app-key",
  "roomId": "room-9527",
  "userId": "user-boss",
  "requestedAt": "2026-04-28T15:34:14.000Z"
}
```

## 响应协议

服务端返回：

```json
{
  "type": "monitor.snapshot",
  "version": "monitor.v1",
  "source": "python-mock-server",
  "generatedAt": "2026-04-28T15:40:00.000Z",
  "connected": true,
  "currentState": "sleep",
  "silenceElapsed": 118,
  "legacyCost": 221.36,
  "smartCost": 74.52,
  "elapsedSeconds": 1230,
  "latencySample": {
    "fromState": "sleep",
    "source": "python-mock-server",
    "roomJoinMs": 530,
    "aiPostProcessBootMs": 470,
    "firstResponseMs": 290
  },
  "logs": [
    {
      "side": "engine",
      "text": "[room-9527] 深度休眠态命中唤醒，智能体先入房再拉起 AI 后处理。"
    },
    {
      "side": "business",
      "text": "已向前端回传 monitor.v1 快照，第 10 次刷新。",
      "highlight": true
    }
  ]
}
```

## 可迁移文件

如果你要迁移到另一个工程，最小可复制这几个路径：

- `v2/`
- `mock-server/`
- `static_server.ps1`

如果你只想迁移页面，不带联调后端，则只复制：

- `v2/`

## 说明

- `runtime_state.json` 用来保存 mock 服务运行时状态，重启后会继续累加。
- `server.ps1` 适合当前 Windows + Trae 环境直接启动。
- `server.py` 适合迁移到带 Python 运行时的其他环境。
- 这是联调包，不是正式生产后端；正式接入时，把业务后端响应改成同样的 `monitor.v1` 结构即可。
