import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

function ensureProfileDirectory() {
  if (!fs.existsSync(config.rtcMemory.profileDirPath)) {
    fs.mkdirSync(config.rtcMemory.profileDirPath, { recursive: true });
  }
}

function sanitizeUserId(userId = '') {
  return String(userId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.@-]/g, '_');
}

function getProfileFilePath(userId = '') {
  ensureProfileDirectory();
  const safeUserId = sanitizeUserId(userId) || 'anonymous_user';
  return path.join(config.rtcMemory.profileDirPath, `${safeUserId}.json`);
}

function readProfileFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    return null;
  }

  return JSON.parse(raw);
}

function writeProfileFile(filePath, payload) {
  ensureProfileDirectory();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

export function getRtcPersonaProfile(userId = '') {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return null;
  }

  const filePath = getProfileFilePath(normalizedUserId);
  const existing = readProfileFile(filePath);

  if (existing) {
    return {
      ...existing,
      filePath,
    };
  }

  return {
    userId: normalizedUserId,
    attributes: {},
    history: [],
    updatedAt: '',
    filePath,
  };
}

export function updateRtcPersonaProfile(userId = '', key = '', value = '', metadata = {}) {
  const profile = getRtcPersonaProfile(userId);
  if (!profile) {
    throw new Error('更新玩家画像需要 userId');
  }

  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('更新玩家画像需要 key');
  }

  const normalizedValue = String(value || '').trim();
  const now = new Date().toISOString();
  const nextProfile = {
    userId: profile.userId,
    attributes: {
      ...(profile.attributes || {}),
      [normalizedKey]: normalizedValue,
    },
    history: [
      ...(Array.isArray(profile.history) ? profile.history : []),
      {
        action: profile.attributes?.[normalizedKey] ? 'updated' : 'created',
        key: normalizedKey,
        value: normalizedValue,
        createdAt: now,
        metadata,
      },
    ].slice(-100),
    updatedAt: now,
  };

  writeProfileFile(profile.filePath, nextProfile);

  return {
    ...nextProfile,
    filePath: profile.filePath,
  };
}

export function formatRtcPersonaProfileForPrompt(profile) {
  if (!profile || !profile.attributes || Object.keys(profile.attributes).length === 0) {
    return '暂无长期画像。';
  }

  return Object.entries(profile.attributes)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');
}
