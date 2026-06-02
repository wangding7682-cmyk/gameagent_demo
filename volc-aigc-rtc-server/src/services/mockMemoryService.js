const mockMemoryProfiles = [
  {
    userId: 'demo_user_001',
    agentId: 'agent_ys_001',
    nickname: '旅行者',
    persona: '偏好探索和剧情向玩法的新手玩家',
    preferences: ['原神', '开荒攻略', '角色培养', '跑图探索'],
    recentTopics: ['蒙德探索', '风神瞳收集', '前期阵容'],
    updatedAt: '2026-04-30T12:00:00.000Z',
  },
  {
    userId: 'demo_user_002',
    agentId: 'agent_sr_001',
    nickname: '开拓者',
    persona: '喜欢回合制和角色养成的轻度玩家',
    preferences: ['星穹铁道', '阵容搭配', '日常养成'],
    recentTopics: ['三月七培养', '前期开荒', '抽卡规划'],
    updatedAt: '2026-04-30T12:10:00.000Z',
  },
];

const mockMemoryRecords = [
  {
    id: 'mem_demo_001',
    userId: 'demo_user_001',
    agentId: 'agent_ys_001',
    type: 'preference',
    category: 'game_preference',
    summary: '用户偏好原神相关的新手开荒和角色培养内容。',
    content: '旅行者最近持续咨询原神开荒、角色培养和蒙德探索路线，适合优先推荐新手攻略。',
    tags: ['原神', '开荒', '角色培养'],
    importance: 'high',
    score: 0.96,
    source: 'mock',
    createdAt: '2026-04-29T10:20:00.000Z',
    lastUsedAt: '2026-04-30T09:30:00.000Z',
    history: [
      {
        action: 'created',
        value: '旅行者最近持续咨询原神开荒、角色培养和蒙德探索路线，适合优先推荐新手攻略。',
        createdAt: '2026-04-29T10:20:00.000Z',
      },
    ],
  },
  {
    id: 'mem_demo_002',
    userId: 'demo_user_001',
    agentId: 'agent_ys_001',
    type: 'session_fact',
    category: 'habit',
    summary: '用户更喜欢直接给结论，不喜欢太长的说明。',
    content: '回复风格应简洁直接，优先给结果，再补充 1 到 2 条关键建议。',
    tags: ['沟通偏好', '简洁回答'],
    importance: 'medium',
    score: 0.89,
    source: 'mock',
    createdAt: '2026-04-28T16:00:00.000Z',
    lastUsedAt: '2026-04-30T09:40:00.000Z',
    history: [
      {
        action: 'created',
        value: '回复风格应简洁直接，优先给结果，再补充 1 到 2 条关键建议。',
        createdAt: '2026-04-28T16:00:00.000Z',
      },
    ],
  },
  {
    id: 'mem_demo_003',
    userId: 'demo_user_002',
    agentId: 'agent_sr_001',
    type: 'preference',
    category: 'game_preference',
    summary: '用户对星穹铁道的开荒和抽卡建议更感兴趣。',
    content: '开拓者关注前期开荒阵容、抽卡资源规划和三月七的实战定位。',
    tags: ['星穹铁道', '抽卡', '三月七'],
    importance: 'high',
    score: 0.94,
    source: 'mock',
    createdAt: '2026-04-29T13:20:00.000Z',
    lastUsedAt: '2026-04-30T10:00:00.000Z',
    history: [
      {
        action: 'created',
        value: '开拓者关注前期开荒阵容、抽卡资源规划和三月七的实战定位。',
        createdAt: '2026-04-29T13:20:00.000Z',
      },
    ],
  },
];

const mockJobs = new Map();

function filterByIdentity(records, filters = {}) {
  return records.filter((record) => {
    if (filters.userId && record.userId !== filters.userId) {
      return false;
    }
    if (filters.agentId && record.agentId !== filters.agentId) {
      return false;
    }
    return true;
  });
}

export function searchMockMemory(payload = {}) {
  const query = String(payload.query || '').trim().toLowerCase();
  const limit = Math.max(1, Number(payload.limit || 10));
  const keywordList = query.split(/\s+/).filter(Boolean);
  const scopedRecords = filterByIdentity(mockMemoryRecords, payload);

  const matched = scopedRecords
    .map((record) => {
      const haystack = [
        record.summary,
        record.content,
        record.category,
        ...(record.tags || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      const hitCount = keywordList.filter((keyword) => haystack.includes(keyword)).length;
      const matchScore = query && haystack.includes(query) ? Math.max(hitCount, 1) : hitCount;

      return {
        ...record,
        _matchScore: matchScore,
      };
    })
    .filter((record) => (query ? record._matchScore > 0 : true));

  const items = matched
    .sort(
      (left, right) =>
        right._matchScore - left._matchScore ||
        (right.score || 0) - (left.score || 0) ||
        String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || ''))
    )
    .slice(0, limit)
    .map(({ _matchScore, ...record }) => record);

  const profile =
    mockMemoryProfiles.find(
      (item) =>
        (!payload.userId || item.userId === payload.userId) &&
        (!payload.agentId || item.agentId === payload.agentId)
    ) || null;

  return {
    profile,
    count: items.length,
    items,
  };
}

export function saveMockMemory(payload = {}) {
  const now = new Date().toISOString();
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const latestMessage = [...messages].reverse().find((item) => item?.content);
  const normalizedContent =
    payload.content ||
    latestMessage?.content ||
    '';
  const summary =
    payload.summary ||
    String(normalizedContent).slice(0, 50) ||
    '新记忆记录';
  const record = {
    id: payload.id || `mem_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    userId: payload.userId || 'demo_user_001',
    agentId: payload.agentId || 'agent_ys_001',
    type: payload.type || 'session_fact',
    category: payload.category || 'general',
    summary,
    content: normalizedContent,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    importance: payload.importance || 'medium',
    score: 1,
    source: payload.source || 'mock',
    createdAt: now,
    lastUsedAt: now,
    metadata: {
      ...(payload.metadata || {}),
      asyncMode: Boolean(payload.asyncMode),
    },
    history: [
      {
        action: 'created',
        value: normalizedContent,
        createdAt: now,
      },
    ],
  };

  mockMemoryRecords.unshift(record);

  const eventId = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  mockJobs.set(eventId, {
    eventId,
    status: 'SUCCEEDED',
    memoryId: record.id,
    userId: record.userId,
    createdAt: now,
  });

  return {
    count: mockMemoryRecords.length,
    record,
    results: [
      {
        event_id: eventId,
        memory_id: record.id,
        status: 'SUCCEEDED',
      },
    ],
  };
}

export function listMockMemory(payload = {}) {
  const limit = Math.max(1, Number(payload.limit || 20));
  const items = filterByIdentity(mockMemoryRecords, payload).slice(0, limit);
  const profile =
    mockMemoryProfiles.find(
      (item) =>
        (!payload.userId || item.userId === payload.userId) &&
        (!payload.agentId || item.agentId === payload.agentId)
    ) || null;

  return {
    count: items.length,
    items,
    profile,
  };
}

export function getMockMemory(memoryId) {
  const item = mockMemoryRecords.find((record) => record.id === memoryId) || null;
  return {
    item,
  };
}

export function getMockMemoryHistory(memoryId) {
  const item = mockMemoryRecords.find((record) => record.id === memoryId) || null;
  return {
    item,
    history: item?.history || [],
  };
}

export function updateMockMemory(memoryId, value) {
  const item = mockMemoryRecords.find((record) => record.id === memoryId) || null;
  if (!item) {
    return {
      item: null,
    };
  }

  const now = new Date().toISOString();
  item.content = value;
  item.summary = String(value || '').slice(0, 50) || item.summary;
  item.lastUsedAt = now;
  item.history = item.history || [];
  item.history.push({
    action: 'updated',
    value,
    createdAt: now,
  });

  return {
    item,
  };
}

export function deleteMockMemory(memoryId) {
  const index = mockMemoryRecords.findIndex((record) => record.id === memoryId);
  if (index < 0) {
    return {
      deleted: false,
      memoryId,
    };
  }

  const [deletedRecord] = mockMemoryRecords.splice(index, 1);
  return {
    deleted: true,
    memoryId,
    record: deletedRecord,
  };
}

export function deleteAllMockMemory(payload = {}) {
  const matchedIds = filterByIdentity(mockMemoryRecords, payload).map((item) => item.id);
  for (let index = mockMemoryRecords.length - 1; index >= 0; index -= 1) {
    const item = mockMemoryRecords[index];
    const userMatched = !payload.userId || item.userId === payload.userId;
    const agentMatched = !payload.agentId || item.agentId === payload.agentId;
    if (userMatched && agentMatched) {
      mockMemoryRecords.splice(index, 1);
    }
  }

  return {
    deleted: matchedIds.length,
    ids: matchedIds,
  };
}

export function getMockJobStatus(eventId) {
  return mockJobs.get(eventId) || {
    eventId,
    status: 'NOT_FOUND',
  };
}

export function getMockMemoryHealth() {
  return {
    ready: true,
    reachable: true,
    provider: 'mock',
    checkedAt: new Date().toISOString(),
    profileCount: mockMemoryProfiles.length,
    memoryCount: mockMemoryRecords.length,
  };
}
