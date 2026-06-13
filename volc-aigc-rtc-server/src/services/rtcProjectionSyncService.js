import { config } from '../config.js';
import { callRtcOpenApi } from './volcRtcOpenApi.js';
import { getAgentSessionState } from './agentSessionStateService.js';
import { findRecentRtcSession, getRtcSessionState, upsertRtcSessionState } from './rtcSessionStateService.js';
import { buildRtcProjection, buildRtcProjectionMessage } from './rtcProjectionService.js';

function stableProjectionText(projection = {}) {
  return JSON.stringify(projection || {});
}

function resolveRtcSession(sessionId = '', body = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const explicitTaskId = String(body.taskId || body.task_id || '').trim();
  const explicitUserId = String(body.userId || body.user_id || '').trim();
  const explicitRoomId = String(body.roomId || body.room_id || '').trim();

  return (
    findRecentRtcSession({
      taskId: explicitTaskId,
      sessionId: normalizedSessionId,
      userId: explicitUserId || normalizedSessionId,
      roomId: explicitRoomId,
    }) ||
    getRtcSessionState(normalizedSessionId)
  );
}

export async function syncRtcProjectionForSession({
  sessionId = '',
  body = {},
  retrievedKnowledge = '',
  dynamicGameState = '',
  projectionOverrides = {},
} = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    return { skipped: true, reason: 'empty_session_id' };
  }

  const rtcSession = resolveRtcSession(normalizedSessionId, body);
  if (!rtcSession?.taskId || !rtcSession?.roomId) {
    return { skipped: true, reason: 'rtc_session_not_found' };
  }

  const agentSessionState = getAgentSessionState(normalizedSessionId);
  const nextProjection = buildRtcProjection({
    body,
    agentSessionState,
    retrievedKnowledge: retrievedKnowledge || rtcSession?.metadata?.retrievedKnowledge || '',
    dynamicGameState: dynamicGameState || rtcSession?.dynamicGameState || '',
    projectionOverrides,
  });
  const prevProjection = rtcSession?.metadata?.rtcProjection || {};
  if (stableProjectionText(prevProjection) === stableProjectionText(nextProjection)) {
    return { skipped: true, reason: 'projection_unchanged', projection: nextProjection };
  }

  const projectionMessage = buildRtcProjectionMessage(nextProjection);
  if (!projectionMessage) {
    return { skipped: true, reason: 'empty_projection_message', projection: nextProjection };
  }

  const result = await callRtcOpenApi('UpdateVoiceChat', {
    AppId: config.rtcAppId,
    RoomId: rtcSession.roomId,
    TaskId: rtcSession.taskId,
    Command: 'ExternalPromptsForLLM',
    Message: projectionMessage,
  });

  upsertRtcSessionState({
    ...rtcSession,
    dynamicGameState: dynamicGameState || rtcSession.dynamicGameState || '',
    metadata: {
      ...(rtcSession.metadata || {}),
      rtcProjection: nextProjection,
      rtcProjectionUpdatedAt: new Date().toISOString(),
      rtcProjectionSource: body.source || 'server_sync',
      retrievedKnowledge: retrievedKnowledge || rtcSession?.metadata?.retrievedKnowledge || '',
    },
  });

  return {
    ok: true,
    projection: nextProjection,
    projectionMessage,
    rtcUpdateResult: result,
  };
}
