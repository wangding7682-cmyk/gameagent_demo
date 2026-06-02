# RTC Token 适配说明

当前目录已经内置了一个可直接使用的 `rtc-token-generator.js`，它是基于你提供的官方 `AccessToken.js` 逻辑改造而来的 ESM 版本。

## 当前状态

- 文件名：`rtc-token-generator.js`
- 模块格式：ESM
- 已导出：`default`、`generateRtcToken`、`AccessToken`、`Parse`、`privileges`

## 期望函数签名

```js
export default async function generateRtcToken({
  appId,
  appKey,
  roomId,
  userId,
  expireInSeconds,
  expireAt,
}) {
  return { token: 'xxx' };
}
```

也可以直接返回字符串：

```js
export default function generateRtcToken(input) {
  return 'your-token';
}
```

## 默认行为

- 默认会为指定 `roomId` / `userId` 生成正式 RTC Token。
- 默认添加 `PrivSubscribeStream` 权限。
- 默认添加 `PrivPublishStream` 权限，同时自动补齐音频、视频、数据流发布权限。
- 默认将 Token 总过期时间设置为 `expireInSeconds` 对应的 Unix 时间戳。

## 替换方式

如果你后续想替换为你自己解压出来的官方原文件，也可以直接覆盖本文件，只要继续保持：

- 导出 `default` 或 `generateRtcToken`
- 入参与返回值签名保持不变
