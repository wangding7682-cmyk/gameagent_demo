import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

function ensureSessionStateFile() {
  const directory = path.dirname(config.rtcMemory.sessionStateFilePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(config.rtcMemory.sessionStateFilePath)) {
    fs.writeFileSync(config.rtcMemory.sessionStateFilePath, '[]', 'utf8');
  }
}

function readSessions() {
  ensureSessionStateFile();
  const raw = fs.readFileSync(config.rtcMemory.sessionStateFilePath, 'utf8').trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function writeSessions(sessions) {
  ensureSessionStateFile();
  fs.writeFileSync(
    config.rtcMemory.sessionStateFilePath,
    JSON.stringify(sessions.slice(-100), null, 2),
    'utf8'
  );
}

function sortSessionsByUpdatedAtDesc(sessions = []) {
  return [...sessions].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function normalizePromptMessages(messages = []) {
  const filtered = messages
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .map((item) => ({
      role: item.role,
      content: String(item.content || '').trim(),
      createdAt: item.createdAt || '',
    }))
    .filter((item) => item.content);

  while (filtered.length > 0 && filtered[0].role !== 'user') {
    filtered.shift();
  }

  if (filtered.length % 2 === 1) {
    filtered.pop();
  }

  const paired = [];
  for (let index = 0; index < filtered.length; index += 2) {
    const userMessage = filtered[index];
    const assistantMessage = filtered[index + 1];
    if (!userMessage || !assistantMessage) {
      continue;
    }
    if (userMessage.role !== 'user' || assistantMessage.role !== 'assistant') {
      continue;
    }
    paired.push(userMessage, assistantMessage);
  }

  return paired;
}

export function upsertRtcSessionState(input = {}) {
  const taskId = String(input.taskId || '').trim();
  if (!taskId) {
    throw new Error('保存 RTC 会话状态需要 taskId');
  }

  const sessions = readSessions();
  const now = new Date().toISOString();
  const index = sessions.findIndex((item) => item.taskId === taskId);
  const nextSession = {
    ...(index >= 0 ? sessions[index] : {}),
    taskId,
    roomId: input.roomId || sessions[index]?.roomId || '',
    userId: input.userId || sessions[index]?.userId || '',
    agentUserId: input.agentUserId || sessions[index]?.agentUserId || '',
    dynamicGameState:
      input.dynamicGameState !== undefined
        ? input.dynamicGameState
        : sessions[index]?.dynamicGameState || '',
    historyLength:
      input.historyLength !== undefined
        ? Number(input.historyLength || 0)
        : sessions[index]?.historyLength || config.rtcMemory.shortHistoryLength,
    messages: Array.isArray(sessions[index]?.messages) ? sessions[index].messages : [],
    metadata: {
      ...(sessions[index]?.metadata || {}),
      ...(input.metadata || {}),
    },
    createdAt: sessions[index]?.createdAt || now,
    updatedAt: now,
  };

  if (index >= 0) {
    sessions[index] = nextSession;
  } else {
    sessions.push(nextSession);
  }

  writeSessions(sessions);
  return nextSession;
}

export function appendRtcSessionMessage(taskId = '', message = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) {
    return null;
  }

  const sessions = readSessions();
  const index = sessions.findIndex((item) => item.taskId === normalizedTaskId);
  if (index < 0) {
    return null;
  }

  const content = String(message.content || '').trim();
  if (!content) {
    return sessions[index];
  }

  const nextMessage = {
    role: message.role || 'user',
    content,
    source: message.source || 'rtc',
    createdAt: new Date().toISOString(),
  };
  const nextSession = {
    ...sessions[index],
    messages: [...(sessions[index].messages || []), nextMessage].slice(-50),
    updatedAt: new Date().toISOString(),
  };
  sessions[index] = nextSession;
  writeSessions(sessions);
  return nextSession;
}

export function getRtcSessionState(taskId = '') {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) {
    return null;
  }

  return readSessions().find((item) => item.taskId === normalizedTaskId) || null;
}

export function getRtcSessionByRoomId(roomId = '') {
  const normalizedRoomId = String(roomId || '').trim();
  if (!normalizedRoomId) {
    return null;
  }

  const sessions = readSessions();
  const matched = sortSessionsByUpdatedAtDesc(
    sessions.filter((item) => item.roomId === normalizedRoomId)
  );
  return matched[0] || null;
}

export function findRecentRtcSession({
  taskId = '',
  sessionId = '',
  userId = '',
  roomId = '',
} = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedUserId = String(userId || '').trim();
  const normalizedRoomId = String(roomId || '').trim();

  const sessions = readSessions();
  if (normalizedTaskId) {
    return sessions.find((item) => item.taskId === normalizedTaskId) || null;
  }

  const matched = sortSessionsByUpdatedAtDesc(
    sessions.filter((item) => {
      if (normalizedRoomId && item.roomId !== normalizedRoomId) {
        return false;
      }
      if (normalizedUserId && item.userId !== normalizedUserId) {
        return false;
      }
      if (
        normalizedSessionId &&
        item.userId !== normalizedSessionId &&
        String(item?.metadata?.sessionId || '').trim() !== normalizedSessionId
      ) {
        return false;
      }
      return Boolean(item?.taskId && item?.roomId);
    })
  );

  return matched[0] || null;
}

export function getRecentRtcUserPrompts(userId = '', maxMessages = config.rtcMemory.shortPromptMessageLimit) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return [];
  }

  const messages = readSessions()
    .filter((session) => session.userId === normalizedUserId)
    .flatMap((session) => session.messages || [])
    .filter((item) => item && item.content)
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
    .slice(-Math.max(0, Number(maxMessages || 0)));

  return normalizePromptMessages(messages).map((item) => ({
    Role: item.role,
    Content: item.content,
  }));
}
