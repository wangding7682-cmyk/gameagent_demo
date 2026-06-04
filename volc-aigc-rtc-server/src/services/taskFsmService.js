const TERMINAL_STATES = new Set(['DONE', 'DEGRADED', 'FAILED', 'CANCELLED']);

const VALID_TRANSITIONS = {
  CREATED: ['CONTEXT_LOADING', 'CANCELLED', 'FAILED'],
  CONTEXT_LOADING: ['ROUTING', 'FAILED', 'CANCELLED'],
  ROUTING: ['MAIN_REPLIED', 'FAILED', 'CANCELLED'],
  MAIN_REPLIED: ['BRANCH_QUEUED', 'BRANCH_EXEC', 'DONE', 'FAILED', 'CANCELLED'],
  BRANCH_QUEUED: ['BRANCH_EXEC', 'CANCELLED', 'FAILED'],
  BRANCH_EXEC: ['PARTIAL_STREAMING', 'ASSET_READY', 'DEGRADED', 'FAILED', 'CANCELLED'],
  PARTIAL_STREAMING: ['ASSET_READY', 'DEGRADED', 'FAILED', 'CANCELLED'],
  ASSET_READY: ['DONE', 'DEGRADED', 'FAILED', 'CANCELLED'],
  DONE: [],
  DEGRADED: [],
  FAILED: [],
  CANCELLED: [],
};

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };
const VALID_PRIORITIES = new Set(['high', 'normal', 'low']);

function nowIso() {
  return new Date().toISOString();
}

function createTaskId(intent = 'unknown') {
  return `task_${intent}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function logTaskFsm(message, data = {}) {
  console.log(`[TaskFSM] ${message}`, {
    at: nowIso(),
    ...data,
  });
}

export class TaskStateStore {
  constructor() {
    this.tasks = new Map();
    // 单轮（turn）级别记忆缓存：同一轮对话内的记忆读取复用
    this.turnCaches = new Map();
  }

  getTurnCache(turnId, key) {
    if (!turnId) return undefined;
    const turnMap = this.turnCaches.get(turnId);
    if (!turnMap) return undefined;
    const entry = turnMap.get(key);
    if (!entry) return undefined;
    return entry.data;
  }

  setTurnCache(turnId, key, data) {
    if (!turnId) return;
    if (!this.turnCaches.has(turnId)) {
      this.turnCaches.set(turnId, new Map());
    }
    this.turnCaches.get(turnId).set(key, { data, at: nowIso() });
  }

  clearTurnCache(turnId) {
    if (!turnId) return;
    this.turnCaches.delete(turnId);
  }

  createTask({ turnId, sessionId, userQuery, source, intent = 'unknown' }) {
    const task = {
      task_id: createTaskId(intent),
      turn_id: turnId,
      session_id: sessionId,
      source,
      user_query: userQuery,
      intent,
      fsm_state: 'CREATED',
      popup_mode: 'loading',
      speakable: false,
      queue_position: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
      timeline: [{ state: 'CREATED', at: nowIso() }],
      result: null,
      error: null,
    };
    this.tasks.set(task.task_id, task);
    logTaskFsm('create_task', {
      task_id: task.task_id,
      turn_id: task.turn_id,
      session_id: task.session_id,
      source: task.source,
      intent: task.intent,
      state: task.fsm_state,
      user_query: task.user_query,
    });
    return task;
  }

  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  transition(taskId, nextState, patch = {}) {
    const task = this.get(taskId);
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    if (TERMINAL_STATES.has(task.fsm_state)) {
      logTaskFsm('transition_skipped_terminal', {
        task_id: taskId,
        current_state: task.fsm_state,
        requested_state: nextState,
      });
      return task;
    }
    const allowed = VALID_TRANSITIONS[task.fsm_state] || [];
    if (!allowed.includes(nextState)) {
      logTaskFsm('transition_rejected', {
        task_id: taskId,
        current_state: task.fsm_state,
        requested_state: nextState,
        allowed,
      });
      throw new Error(`非法任务状态转换: ${task.fsm_state} -> ${nextState}`);
    }
    const previousState = task.fsm_state;
    Object.assign(task, patch, {
      fsm_state: nextState,
      updated_at: nowIso(),
    });
    task.timeline.push({ state: nextState, at: task.updated_at });
    this.tasks.set(taskId, task);
    logTaskFsm('transition', {
      task_id: taskId,
      from: previousState,
      to: nextState,
      intent: task.intent,
      popup_mode: task.popup_mode,
      queue_position: task.queue_position || 0,
      patch_keys: Object.keys(patch),
    });
    return task;
  }

  fail(taskId, error) {
    const task = this.get(taskId);
    if (!task || TERMINAL_STATES.has(task.fsm_state)) {
      return task;
    }
    return this.transition(taskId, 'FAILED', {
      error: { message: error?.message || String(error || '任务失败') },
    });
  }
}

export class IntentConcurrencyPool {
  constructor(limits = {}) {
    this.limits = { strategy: 2, video: 2, ...limits };
    this.running = { strategy: new Set(), video: new Set() };
    this.queues = { strategy: [], video: [] };
  }

  isLimited(intent) {
    return Object.prototype.hasOwnProperty.call(this.limits, intent);
  }

  normalizePriority(priority) {
    const p = String(priority || 'normal').toLowerCase();
    return VALID_PRIORITIES.has(p) ? p : 'normal';
  }

  snapshot() {
    var queuedWithPriority = {};
    for (var key of Object.keys(this.queues)) {
      queuedWithPriority[key] = this.queues[key].map(function (entry) {
        return {
          task_id: entry.taskId,
          priority: entry.priority,
          enqueued_at: entry.enqueuedAt,
        };
      });
    }
    return {
      limits: { ...this.limits },
      running: {
        strategy: Array.from(this.running.strategy),
        video: Array.from(this.running.video),
      },
      queued_count: {
        strategy: this.queues.strategy.length,
        video: this.queues.video.length,
      },
      queued_with_priority: queuedWithPriority,
    };
  }

  acquire(intent, taskId, onQueued = () => {}, options = {}) {
    var priority = this.normalizePriority(options.priority);

    if (!this.isLimited(intent)) {
      logTaskFsm('pool_acquire_unlimited', { intent, task_id: taskId, priority });
      return Promise.resolve({
        release: () => {},
        queued: false,
        queue_position: 0,
        priority: priority,
      });
    }

    if (this.running[intent].size < this.limits[intent]) {
      this.running[intent].add(taskId);
      logTaskFsm('pool_acquire', {
        intent,
        task_id: taskId,
        priority,
        running_count: this.running[intent].size,
        limit: this.limits[intent],
        queued_count: this.queues[intent].length,
      });
      return Promise.resolve({
        release: () => this.release(intent, taskId),
        queued: false,
        queue_position: 0,
        priority: priority,
      });
    }

    var self = this;
    return new Promise(function (resolve) {
      var entry = {
        taskId: taskId,
        priority: priority,
        enqueuedAt: nowIso(),
        resolve: function () {
          self.running[intent].add(taskId);
          resolve({
            release: function () { self.release(intent, taskId); },
            queued: true,
            queue_position: 0,
            priority: priority,
          });
        },
      };

      self.queues[intent].push(entry);
      self._reorderQueue(intent);

      var position = self._getQueuePosition(intent, taskId);
      logTaskFsm('pool_queued', {
        intent,
        task_id: taskId,
        priority,
        queue_position: position,
        running_count: self.running[intent].size,
        limit: self.limits[intent],
        queue_ahead_high_priority: self._countHigherPriorityAhead(intent, entry),
      });
      onQueued(position, priority);
    });
  }

  _reorderQueue(intent) {
    var order = PRIORITY_ORDER;
    this.queues[intent].sort(function (a, b) {
      var pa = order[a.priority] !== undefined ? order[a.priority] : 99;
      var pb = order[b.priority] !== undefined ? order[b.priority] : 99;
      if (pa !== pb) return pa - pb;
      return (a.enqueuedAt || '').localeCompare(b.enqueuedAt || '');
    });

    for (var i = 0; i < this.queues[intent].length; i++) {
      this.queues[intent]._sortIndex = i;
    }
  }

  _getQueuePosition(intent, taskId) {
    for (var i = 0; i < this.queues[intent].length; i++) {
      if (this.queues[intent][i].taskId === taskId) return i + 1;
    }
    return -1;
  }

  _countHigherPriorityAhead(intent, entry) {
    var myOrder = PRIORITY_ORDER[entry.priority] !== undefined ? PRIORITY_ORDER[entry.priority] : 99;
    var count = 0;
    for (var i = 0; i < this.queues[intent].length; i++) {
      var e = this.queues[intent][i];
      if (e.taskId === entry.taskId) continue;
      var eOrder = PRIORITY_ORDER[e.priority] !== undefined ? PRIORITY_ORDER[e.priority] : 99;
      if (eOrder < myOrder) count++;
    }
    return count;
  }

  release(intent, taskId) {
    if (!this.isLimited(intent)) {
      return null;
    }
    this.running[intent].delete(taskId);
    logTaskFsm('pool_release', {
      intent,
      task_id: taskId,
      running_count: this.running[intent].size,
      queued_count: this.queues[intent].length,
    });

    var next = this.queues[intent].shift();
    if (next) {
      logTaskFsm('pool_dequeue_priority', {
        intent,
        task_id: next.taskId,
        priority: next.priority,
        remaining_queue_count: this.queues[intent].length,
        was_high_priority: next.priority === 'high',
      });
      next.resolve();
      return next.taskId;
    }
    return null;
  }
}

export const taskStore = new TaskStateStore();
export const intentPool = new IntentConcurrencyPool();
