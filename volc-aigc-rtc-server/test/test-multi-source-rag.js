// 多源 RAG 测试脚本：多游戏覆盖 + rerank 前后对比
// 用法：
//   1. 启动后端：cd volc-aigc-rtc-server && npm run dev
//   2. 在另一终端：node test/test-multi-source-rag.js
//
// 环境变量 RAG_DEBUG_LOG=1 可在服务端控制台看到完整对比表
import { multiSourceSearch } from '../src/services/multiSourceKnowledgeService.js';

// 模拟用户私有库：原神 + 崩坏星穹铁道（这些 domain 是当前内置库没有的，用来测试用户外挂）
const MOCK_USER_GENSHIN = {
  type: 'user_local',
  domain: 'genshin',
  label: '我的本地库·原神',
  enabled: true,
  topK: 5,
  items: [
    {
      id: 'gs-1',
      title: '雷电将军元素爆发循环',
      content: '雷电将军核心循环是 E 技能（梦想一心）持续 7 秒，期间普攻和重击转化为雷元素伤害。前置班配置最佳元素电池为九条裟罗或菲谢尔提供电粒子。武器选择「薙草之稻光」最佳，圣遗物推荐绝缘之旗印 4 件套，强化元素爆发伤害。',
    },
    {
      id: 'gs-2',
      title: '胡桃血梅香国家队配队',
      content: '胡桃国家队由胡桃 + 行秋 + 班尼特 + 钟离组成，主打蒸发反应。班尼特 Q 提供攻击力加成，行秋 Q 挂水，胡桃重击触发蒸发。钟离玉璋提供减抗+护盾，是当前胡桃最强配队之一。',
    },
    {
      id: 'gs-3',
      title: '原神元素反应优先级',
      content: '元素反应基础倍率：超载 2.0、感电 1.2、超导 1.0、扩散 0.6、结晶 0.0；增幅反应：蒸发（火→水）2.0、融化（火→冰）2.0。蒸发和融化是最强的双倍增伤反应，胡桃、宵宫等火主 C 都依赖蒸发输出。',
    },
    {
      id: 'gs-4',
      title: '深境螺旋 12 层配队思路',
      content: '深渊 12 层一般需要双队配置，推荐主队蒸发或融化高输出，副队感电或冻结控制。常见组合：胡桃国家队 + 雷神九命；甘雨永冻 + 宵宫散兵。圣遗物词条优先暴击率/暴击伤害和精通。',
    },
  ],
};

const MOCK_USER_HONKAI = {
  type: 'user_local',
  domain: 'honkai',
  label: '我的本地库·崩坏星穹铁道',
  enabled: true,
  topK: 5,
  items: [
    {
      id: 'hk-1',
      title: '银狼破盾队配队',
      content: '银狼是星铁中唯一能给敌人植入弱点的虚数角色，搭配卡芙卡或希露瓦能形成稳定破盾输出。光锥推荐「在蓝天下」，遗器选择「翔鹰的猎物」+「太空封印站」，主词条速度+量子伤害+暴击。',
    },
    {
      id: 'hk-2',
      title: '混沌回忆 12 层攻略要点',
      content: '混沌回忆 12 层需要双队配置，速度阈值建议 134+ 抢一动。推荐输出位：希儿/卡芙卡/景元；辅助位：银狼/佩拉破韧+罗刹奶妈或符玄保命。光锥共鸣链条要叠满。',
    },
    {
      id: 'hk-3',
      title: '崩坏星穹铁道遗器主词条',
      content: '主 C 遗器：手部固定攻击力，脚部速度或攻击力%，位面之球元素伤害%，位面之绳元素伤害%或攻击力%。副词条优先暴击率、暴击伤害、速度、攻击力%。',
    },
  ],
};

const TEST_QUERIES = [
  // 跨域准确性测试
  { query: '雷电将军怎么配队', expectDomain: 'genshin', desc: '原神角色配队，应该命中 user_local genshin' },
  { query: '胡桃蒸发反应怎么打', expectDomain: 'genshin', desc: '原神蒸发反应' },
  { query: '银狼破盾要怎么搭配', expectDomain: 'honkai', desc: '星铁角色，应该命中 user_local honkai' },
  { query: '混沌回忆 12 层怎么过', expectDomain: 'honkai', desc: '星铁副本' },
  // 内置库测试
  { query: '亚索连招', expectDomain: 'lol', desc: 'LOL 英雄，命中 default_local lol' },
  { query: '貂蝉怎么出装', expectDomain: 'wzry', desc: '王者英雄，命中 default_local wzry' },
  // 跨域抗污染测试
  { query: '亚索怎么打雷电将军', expectDomain: 'mixed', desc: '跨域混合，应优先 LOL' },
  { query: '游戏 AI 助手有什么用', expectDomain: 'ambiguous', desc: '完全无关，应低分或 skip' },
];

async function runOne({ query, expectDomain, desc }) {
  console.log('\n' + '='.repeat(80));
  console.log(`🔍 Query: ${query}`);
  console.log(`📝 ${desc} | 期望: ${expectDomain}`);

  const sources = [
    MOCK_USER_GENSHIN,
    MOCK_USER_HONKAI,
    { type: 'default_local', domain: 'lol', label: '内置·英雄联盟示例库', enabled: true, topK: 5 },
    { type: 'default_local', domain: 'wzry', label: '内置·王者荣耀示例库', enabled: true, topK: 5 },
  ];

  // 跑两次：第一次 native（不 rerank），第二次 embedding rerank，看排序差异
  const t0 = Date.now();
  const native = await multiSourceSearch({
    query, sources, topK: 5, rerankStrategy: 'none', bypassCache: true,
  });
  const t1 = Date.now();
  const reranked = await multiSourceSearch({
    query, sources, topK: 5, rerankStrategy: 'embedding', bypassCache: true,
  });
  const t2 = Date.now();

  console.log(`⏱  native ${t1 - t0}ms | rerank ${t2 - t1}ms`);
  console.log(`📌 detected domains: [${native.detectedDomains.join(', ') || '(none)'}]`);
  console.log(`🧪 rerank source: ${reranked.rerankSource}`);

  console.log('\n--- BEFORE rerank (来源加权后排序) ---');
  console.table(native.items.map((it, i) => ({
    rank: i + 1,
    title: (it.title || '').slice(0, 30),
    src: it.sourceType,
    domain: it.sourceDomain || '-',
    native: typeof it.nativeScore === 'number' ? it.nativeScore.toFixed(3) : '-',
    final: typeof it.finalScore === 'number' ? it.finalScore.toFixed(3) : '-',
  })));

  console.log('\n--- AFTER rerank (embedding 统一量纲后) ---');
  console.table(reranked.items.map((it, i) => {
    const beforeIdx = native.items.findIndex((x) => x.id === it.id);
    return {
      rank: i + 1,
      delta: beforeIdx >= 0 ? (beforeIdx + 1) - (i + 1) : 'NEW',
      title: (it.title || '').slice(0, 30),
      src: it.sourceType,
      domain: it.sourceDomain || '-',
      native: typeof it.nativeScore === 'number' ? it.nativeScore.toFixed(3) : '-',
      rerank: typeof it.rerankScore === 'number' ? it.rerankScore.toFixed(3) : '-',
      final: typeof it.finalScore === 'number' ? it.finalScore.toFixed(3) : '-',
    };
  }));
}

async function main() {
  for (const t of TEST_QUERIES) {
    try {
      await runOne(t);
    } catch (e) {
      console.error(`❌ 失败: ${t.query}`, e.message);
    }
  }
  console.log('\n✅ 所有测试完成');
}

main().catch((e) => { console.error(e); process.exit(1); });
