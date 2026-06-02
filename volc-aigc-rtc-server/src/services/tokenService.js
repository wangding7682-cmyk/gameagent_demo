import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertRtcTokenConfig, config } from '../config.js';

let cachedGenerator = null;

async function loadGeneratorModule() {
  if (cachedGenerator) {
    return cachedGenerator;
  }

  const generatorPath = config.rtcTokenGeneratorPath;
  if (!fs.existsSync(generatorPath)) {
    throw new Error(
      `未找到 RTC Token 生成器文件: ${generatorPath}。请把官方 JS SDK 或 AccessToken 实现放到该路径。`
    );
  }

  const mod = await import(pathToFileURL(generatorPath).href);
  const generator =
    mod.generateRtcToken ||
    mod.default ||
    mod.createRtcToken;

  if (typeof generator !== 'function') {
    throw new Error(
      `RTC Token 生成器文件 ${path.basename(generatorPath)} 未导出可调用函数。请导出 default 或 generateRtcToken。`
    );
  }

  cachedGenerator = generator;
  return generator;
}

export async function generateRtcToken({
  roomId,
  userId,
  expireInSeconds = 7200,
  appId = config.rtc.appId,
  appKey = config.rtc.appKey,
}) {
  assertRtcTokenConfig();

  if (!roomId) {
    throw new Error('roomId 不能为空');
  }

  if (!userId) {
    throw new Error('userId 不能为空');
  }

  const generator = await loadGeneratorModule();
  const expireAt = new Date(Date.now() + expireInSeconds * 1000).toISOString();

  const result = await generator({
    appId,
    appKey,
    roomId,
    userId,
    expireInSeconds,
    expireAt,
  });

  const token = typeof result === 'string' ? result : result?.token;
  if (!token) {
    throw new Error('RTC Token 生成器没有返回 token');
  }

  return {
    appId,
    roomId,
    userId,
    token,
    expireInSeconds,
    expireAt,
    extra: typeof result === 'string' ? {} : result,
  };
}
