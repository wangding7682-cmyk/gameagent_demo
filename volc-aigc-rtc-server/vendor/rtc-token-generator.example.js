/**
 * 这是 RTC Token 生成器的接口示例，不是可用的官方算法实现。
 * 你提供官方 JS 生成器后，替换同目录下的 rtc-token-generator.js 即可。
 */
export default async function generateRtcToken({
  appId,
  appKey,
  roomId,
  userId,
  expireInSeconds,
  expireAt,
}) {
  return {
    token: `replace-me-with-official-generator:${appId}:${roomId}:${userId}:${expireInSeconds}`,
    expireAt,
    warning: '当前是示例文件，请替换为官方 RTC Token 生成逻辑。',
    meta: {
      appId,
      hasAppKey: Boolean(appKey),
      roomId,
      userId,
    },
  };
}
