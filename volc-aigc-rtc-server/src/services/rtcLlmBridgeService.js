const sessionBuffers = new Map();

const BUFFER_TTL_MS = 120000;

function nowIso() {
  return new Date().toISOString();
}

function createSessionBuffer(sessionId) {
  const existing = sessionBuffers.get(sessionId);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }
  const buffer = {
    sessionId,
    events: [],
    subscribers: [],
    orchestrationRunning: false,
    orchestrationDone: false,
    ttsTextSent: '',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
  sessionBuffers.set(sessionId, buffer);
  return buffer;
}

export function markOrchestrationRunning(sessionId) {
  const buffer = createSessionBuffer(sessionId);
  buffer.orchestrationRunning = true;
  buffer.orchestrationDone = false;
  buffer.events = [];
  buffer.ttsTextSent = '';
}

export function markOrchestrationDone(sessionId) {
  const buffer = sessionBuffers.get(sessionId);
  if (buffer) {
    buffer.orchestrationRunning = false;
    buffer.orchestrationDone = true;
  }
}

export function appendSessionEvent(sessionId, event) {
  const buffer = createSessionBuffer(sessionId);
  const indexedEvent = { ...event, _index: buffer.events.length, _at: nowIso() };
  buffer.events.push(indexedEvent);
  buffer.lastAccessedAt = Date.now();
  for (const cb of buffer.subscribers) {
    try {
      cb(indexedEvent);
    } catch (_) {}
  }
}

export function getSessionEvents(sessionId, afterIndex = -1) {
  const buffer = sessionBuffers.get(sessionId);
  if (!buffer) return [];
  return buffer.events.filter((e) => e._index > afterIndex);
}

export function isOrchestrationRunning(sessionId) {
  const buffer = sessionBuffers.get(sessionId);
  return buffer?.orchestrationRunning === true;
}

export function isOrchestrationDone(sessionId) {
  const buffer = sessionBuffers.get(sessionId);
  return buffer?.orchestrationDone === true;
}

export function hasSessionBuffer(sessionId) {
  return sessionBuffers.has(sessionId);
}

export function appendTtsTextSent(sessionId, text) {
  const buffer = sessionBuffers.get(sessionId);
  if (buffer) {
    buffer.ttsTextSent += (buffer.ttsTextSent ? ' ' : '') + text;
  }
}

export function subscribeSessionEvents(sessionId, callback) {
  const buffer = createSessionBuffer(sessionId);
  buffer.subscribers.push(callback);
  return () => {
    buffer.subscribers = buffer.subscribers.filter((cb) => cb !== callback);
  };
}

export function waitForOrchestrationStart(sessionId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const buffer = sessionBuffers.get(sessionId);
    if (buffer?.orchestrationRunning || buffer?.orchestrationDone) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      const b = sessionBuffers.get(sessionId);
      if (b?.orchestrationRunning || b?.orchestrationDone) {
        clearInterval(interval);
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
}

export function cleanupSessionBuffer(sessionId) {
  sessionBuffers.delete(sessionId);
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, buffer] of sessionBuffers) {
    if (now - buffer.lastAccessedAt > BUFFER_TTL_MS) {
      sessionBuffers.delete(sessionId);
    }
  }
}, 30000).unref();
