import { callRtcOpenApi } from './volcRtcOpenApi.js';
import { getRtcSessionState, getRtcSessionByRoomId } from './rtcSessionStateService.js';
import { appendRtcSessionMessage } from './rtcSessionStateService.js';
import { config } from '../config.js';

const MAX_TTS_CHUNK_LEN = 200;

export async function handleRtcPushTts(body = {}) {
  const taskId = body.taskId || body.task_id;
  const roomId = body.roomId || body.room_id;

  let session = null;
  if (taskId) {
    session = getRtcSessionState(taskId);
  }
  if (!session && roomId) {
    session = getRtcSessionByRoomId(roomId);
    if (session) {
      console.log(`[RtcPushTts] taskId "${taskId}" not found, fell back to roomId "${roomId}" -> taskId "${session.taskId}"`);
    }
  }
  if (!session) {
    console.warn('[RtcPushTts] no RTC session found for taskId:', taskId, 'roomId:', roomId);
    return { ok: false, error: '未找到对应的 RTC 会话', code: 'NO_RTC_SESSION' };
  }

  const rawMessage = String(body.message || body.text || '').trim();
  if (!rawMessage) {
    return { ok: false, error: 'message 不能为空' };
  }

  const resolvedTaskId = session.taskId;
  const resolvedRoomId = session.roomId || roomId;

  const appId = body.appId || config.rtcAppId;

  if (!appId) {
    console.error('[RtcPushTts] missing AppId');
    return { ok: false, error: '缺少 AppId 配置' };
  }
  if (!resolvedRoomId) {
    console.error('[RtcPushTts] missing RoomId for taskId:', resolvedTaskId);
    return { ok: false, error: '未找到 RoomId' };
  }

  const command = body.command || 'ExternalTextToSpeech';
  const interruptMode = normalizeExternalInterruptMode(body.interruptMode);

  if (body.skipSessionMessageSync !== true) {
    appendRtcSessionMessage(resolvedTaskId, {
      role: 'user',
      content: rawMessage,
      source: 'agent_tts_push',
    });
  }

  const chunks = splitTtsMessage(rawMessage, MAX_TTS_CHUNK_LEN);
  console.log(`[RtcPushTts] pushing TTS to RTC | taskId=${resolvedTaskId} roomId=${resolvedRoomId} command=${command} interruptMode=${interruptMode} chunks=${chunks.length} totalLen=${rawMessage.length}`);

  let successCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isFirstChunk = i === 0;
    const isLastChunk = i === chunks.length - 1;

    const payload = {
      AppId: appId,
      RoomId: resolvedRoomId,
      TaskId: resolvedTaskId,
      Command: command,
      Message: chunk,
      InterruptMode: isFirstChunk ? interruptMode : 2,
    };

    if (body.imageConfig && isFirstChunk) {
      payload.ImageConfig = body.imageConfig;
    }
    if (body.parameters) {
      payload.Parameters = body.parameters;
    }

    try {
      const result = await callRtcOpenApi('UpdateVoiceChat', payload);
      successCount++;
      console.log(`[RtcPushTts] chunk ${i + 1}/${chunks.length} OK | "${chunk.slice(0, 60)}${chunk.length > 60 ? '...' : ''}"`);
      if (!isLastChunk && chunks.length > 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (error) {
      console.error(`[RtcPushTts] chunk ${i + 1}/${chunks.length} FAILED |`, error.message);
    }
  }

  const allOk = successCount === chunks.length;
  if (allOk) {
    console.log(`[RtcPushTts] all ${successCount} chunks pushed OK | taskId=${resolvedTaskId}`);
  } else {
    console.warn(`[RtcPushTts] partial failure: ${successCount}/${chunks.length} chunks OK | taskId=${resolvedTaskId}`);
  }

  return {
    ok: allOk,
    action: command,
    taskId: resolvedTaskId,
    message: rawMessage,
    chunksSent: successCount,
    totalChunks: chunks.length,
  };
}

function normalizeExternalInterruptMode(value) {
  const parsed = Number(value ?? 1);
  return [1, 2, 3].includes(parsed) ? parsed : 1;
}

function splitTtsMessage(text = '', maxLen = MAX_TTS_CHUNK_LEN) {
  if (text.length <= maxLen) {
    return [text];
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('。', maxLen);
    if (cutAt < maxLen * 0.5) {
      cutAt = remaining.lastIndexOf('，', maxLen);
    }
    if (cutAt < maxLen * 0.3) {
      cutAt = remaining.lastIndexOf('、', maxLen);
    }
    if (cutAt < maxLen * 0.2) {
      cutAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (cutAt < 10) {
      cutAt = maxLen;
    }
    chunks.push(remaining.slice(0, cutAt + 1));
    remaining = remaining.slice(cutAt + 1).trimStart();
  }
  return chunks;
}
