const mockKnowledgeItems = [
  {
    id: 'mock-ys-001',
    point_id: 'mock-ys-001',
    chunk_title: '原神新手开荒指南',
    content: '推荐优先探索蒙德区域，收集风神瞳提升体力上限，这对前期开图和跑图非常有帮助。',
    score: 0.98,
    chunk_type: 'text',
    doc_info: {
      doc_id: 'mock-doc-ys-001',
      doc_name: 'genshin-guide.pdf',
      title: '原神开荒指北',
      doc_type: 'pdf',
    },
  },
  {
    id: 'mock-ys-002',
    point_id: 'mock-ys-002',
    chunk_title: '原神角色培养建议',
    content: '前期可以优先培养主角、安柏、凯亚和丽莎，这套阵容能覆盖大部分解谜和基础战斗场景。',
    score: 0.92,
    chunk_type: 'text',
    doc_info: {
      doc_id: 'mock-doc-ys-002',
      doc_name: 'genshin-build.md',
      title: '原神前期角色培养',
      doc_type: 'md',
    },
  },
  {
    id: 'mock-sr-001',
    point_id: 'mock-sr-001',
    chunk_title: '星穹铁道开荒指南',
    content: '前期推荐培养开拓者和三月七，他们在主线任务中兼顾输出和生存，适合稳定推进。',
    score: 0.96,
    chunk_type: 'text',
    doc_info: {
      doc_id: 'mock-doc-sr-001',
      doc_name: 'hsr-guide.pdf',
      title: '星穹铁道入门指南',
      doc_type: 'pdf',
    },
  },
  {
    id: 'mock-zzz-001',
    point_id: 'mock-zzz-001',
    chunk_title: '绝区零战斗技巧',
    content: '熟练掌握极限支援和连携技，能显著提升输出效率，前期不要一味站场贪刀。',
    score: 0.9,
    chunk_type: 'text',
    doc_info: {
      doc_id: 'mock-doc-zzz-001',
      doc_name: 'zzz-battle.txt',
      title: '绝区零战斗基础',
      doc_type: 'txt',
    },
  },
];

export function searchMockKnowledge(query, limit = 5) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const keywords = normalizedQuery.split(/\s+/).filter(Boolean);

  const matched = mockKnowledgeItems
    .map((item) => {
      const haystack = [
        item.chunk_title,
        item.content,
        item.doc_info?.title,
        item.doc_info?.doc_name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      const keywordHits = keywords.filter((keyword) => haystack.includes(keyword)).length;
      const fallbackHits =
        normalizedQuery && haystack.includes(normalizedQuery) ? Math.max(keywordHits, 1) : keywordHits;

      return {
        ...item,
        _matchScore: fallbackHits,
      };
    })
    .filter((item) => item._matchScore > 0);

  const resultList = (matched.length > 0 ? matched : mockKnowledgeItems)
    .sort((left, right) => right._matchScore - left._matchScore || right.score - left.score)
    .slice(0, limit)
    .map(({ _matchScore, ...item }) => item);

  return {
    code: 0,
    message: 'success',
    request_id: `mock-${Date.now()}`,
    data: {
      collection_name: 'mock-game-knowledge-base',
      count: resultList.length,
      result_list: resultList,
    },
  };
}
