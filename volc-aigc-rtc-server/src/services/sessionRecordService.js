import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

function ensureStoreFile() {
  const directory = path.dirname(config.sessionStore.filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(config.sessionStore.filePath)) {
    fs.writeFileSync(config.sessionStore.filePath, '[]', 'utf8');
  }
}

function readRecords() {
  ensureStoreFile();

  try {
    const raw = fs.readFileSync(config.sessionStore.filePath, 'utf8').trim();
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new Error(`读取会话记录失败: ${error.message}`);
  }
}

function writeRecords(records) {
  ensureStoreFile();

  try {
    fs.writeFileSync(config.sessionStore.filePath, JSON.stringify(records, null, 2), 'utf8');
  } catch (error) {
    throw new Error(`写入会话记录失败: ${error.message}`);
  }
}

export function saveSessionRecord(record = {}) {
  const records = readRecords();
  const nextRecord = {
    id: record.id || `session_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    createdAt: new Date().toISOString(),
    ...record,
  };

  records.push(nextRecord);
  const trimmed = records.slice(-200);
  writeRecords(trimmed);

  return {
    count: trimmed.length,
    record: nextRecord,
    filePath: config.sessionStore.filePath,
  };
}

export function listSessionRecords(limit = 20) {
  const records = readRecords();
  const normalizedLimit = Math.max(1, Number(limit || 20));

  return {
    count: records.length,
    records: records.slice(-normalizedLimit).reverse(),
    filePath: config.sessionStore.filePath,
  };
}
