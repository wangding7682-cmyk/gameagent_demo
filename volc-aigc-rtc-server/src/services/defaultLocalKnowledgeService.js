const LOL_DOMAIN = 'lol';
const LOL_ALIASES = ['英雄联盟', 'lol', 'LOL', 'League of Legends', '召唤师峡谷', 'lol端游'];

const baseItems = [
  {
    id: 'lol-hero-yasuo-001',
    chunk_title: '亚索中单玩法详解',
    content:
      '亚索是英雄联盟中极具操作性的战士英雄，核心玩法是通过Q技能积攒旋风配合大招。被动浪客之道提供护盾和暴击加成，对线期主要利用Q斩钢闪消耗，E踏前斩穿兵追击或撤退。团战需等待队友先手击飞再进场收割，不建议先手开团。出装优先电刀和无尽提升爆发，鞋子按对面阵容选护甲鞋或水银鞋。',
    score: 0.98,
    doc: { doc_name: 'lol-yasuo-guide.md', title: '英雄联盟亚索攻略' },
  },
  {
    id: 'lol-hero-leesin-001',
    chunk_title: '盲僧打野前期入侵战术',
    content:
      '盲僧是英雄联盟中机动性最强的打野之一，前期入侵需观察对方打野起始位置。对方红开时可从石甲虫方向绕后入侵，过程中保留W不交以保留逃生手段。成功入侵后快速击杀BUFF怪并利用W眼位逃生。入侵失败被抓优先交闪逃命，不要试图反打导致送双杀。',
    score: 0.97,
    doc: { doc_name: 'lol-leesin-jungle.md', title: '盲僧打野指南' },
  },
  {
    id: 'lol-role-adc-001',
    chunk_title: 'ADC对线技巧与站位',
    content:
      '英雄联盟中 ADC 是对线和团战的核心输出位。对线注意保持安全站位避免被对方辅助技能命中；合理利用草丛视野防GANK；关注兵线状态适时推线或控线；配合辅助节奏消耗。团战站位最为关键，保持在辅助和坦克身后输出。遇到刺客突脸优先交闪现拉开距离，不要贪输出。',
    score: 0.95,
    doc: { doc_name: 'lol-adc-positioning.md', title: 'ADC对线与团战' },
  },
  {
    id: 'lol-hero-maokai-001',
    chunk_title: '上单大树对线与团战技巧',
    content:
      '英雄联盟大树是上手简单效果显著的坦克英雄。Q彗尾击清线兼消耗，W缠绕配合打野GANK效果好。E种草丛提供视野与控制。大招自然之握是团控技能，需配合队友进攻节奏使用。打团作前排吸收伤害，保护后排输出。出装以日炎和反甲为主提升坦度。',
    score: 0.94,
    doc: { doc_name: 'lol-maokai-top.md', title: '大树上单攻略' },
  },
  {
    id: 'lol-hero-ahri-001',
    chunk_title: '中单狐狸对线与游走',
    content:
      '英雄联盟狐狸是机动性极高的法师英雄。Q欺诈宝珠远程消耗，W偶像魅力提供控制，E锥刺陷阱限制走位，大招灵魄突袭具备极强追击逃生能力。对线不要过于激进保持蓝量健康。6级后可积极游走边路，大招位移配合E控制成功率高。团战找好输出位用技能消耗对方后排。',
    score: 0.93,
    doc: { doc_name: 'lol-ahri-mid.md', title: '狐狸中单攻略' },
  },
  {
    id: 'lol-hero-thresh-001',
    chunk_title: '辅助锤石对线技巧',
    content:
      '英雄联盟锤石是功能性最强的辅助之一。Q死亡判决是主要控制手段，注意把握出钩时机不要随意空钩被反打。W魂引之灯可救人或助攻追击。E厄运钟摆能打断对方突进。大招幽魂监牢提供范围控制与减速。钩子命中率需要练习，建议先从近距离开钩练起。',
    score: 0.92,
    doc: { doc_name: 'lol-thresh-support.md', title: '锤石辅助攻略' },
  },
  {
    id: 'lol-hero-vi-001',
    chunk_title: '打野蔚团战定位与连招',
    content:
      '英雄联盟蔚是爆发力极强的打野，大招皮警官锁定是核心技能。团战找准时机锁定对方后排，R击飞接Q震拳爆发。完整连招顺序：R起手→A→Q→A→E，伤害最高。注意R可被控制技能打断，需等对方交完控制再进场。',
    score: 0.91,
    doc: { doc_name: 'lol-vi-jungle.md', title: '蔚打野连招' },
  },
  {
    id: 'lol-hero-kassadin-001',
    chunk_title: '中单卡萨丁后期收割',
    content:
      '英雄联盟卡萨丁是后期能力最强的英雄之一。前期对线以补刀和抗压为主，不主动换血。6级后利用R虚空跃迁快速支援边路。团战等对方交完关键技能后进场，R踩到对方后排脸上接Q盾和E减速进行追击。出装优先大天使和时光杖叠AP后期。',
    score: 0.9,
    doc: { doc_name: 'lol-kassadin-mid.md', title: '卡萨丁中单攻略' },
  },
  {
    id: 'lol-tactic-baron-herald-001',
    chunk_title: '大龙与峡谷先锋选择节奏',
    content:
      '英雄联盟召唤师峡谷中 20 分钟是节奏分界点。20分钟前有线权优先打先锋撞掉对方一塔获取经济。20分钟后团队经济领先且视野良好可考虑大龙获取强化回城。经济落后或视野被压制时优先小龙资源而非大龙。大龙BUFF持续较短，需注意推进节奏分配。',
    score: 0.96,
    doc: { doc_name: 'lol-baron-herald.md', title: '大龙先锋节奏' },
  },
  {
    id: 'lol-tactic-mid-roam-001',
    chunk_title: '中路被游走时的兵线处理',
    content:
      '英雄联盟中路被刺客游走时，对方游走成功造成击杀或助攻，我方中单应快速推线到对方塔下抢镀层经济。对方游走失败可继续推线压制对方中路发育，并ping信号提醒队友。被游走时保持冷静，不要盲目跟游导致更大损失。',
    score: 0.94,
    doc: { doc_name: 'lol-mid-roam-wave.md', title: '中路抗游走兵线处理' },
  },
  {
    id: 'lol-tactic-teamfight-001',
    chunk_title: '团战站位与分工',
    content:
      '英雄联盟团战明确分工：坦克吸收伤害控制对方前排；辅助保护己方后排控制对方刺客；中单和ADC输出对方前排和后排；打野负责切后排或保护己方后排。站位保持阵型紧密但不过于拥挤方便辅助保护覆盖全队。开团前确保关键技能CD就绪，不在技能真空期开团。',
    score: 0.93,
    doc: { doc_name: 'lol-teamfight-formation.md', title: '团战站位与分工' },
  },
  {
    id: 'lol-tactic-dragon-vision-001',
    chunk_title: '小龙控制与视野争夺',
    content:
      '英雄联盟前中期小龙是重要资源。第四条小龙刷新前双方通常爆发团战。争夺前做好视野布置防被反开。团战ADC优先输出打龙最快目标避免被消耗血量。劣势局可考虑放龙换对方外塔或野区资源。',
    score: 0.92,
    doc: { doc_name: 'lol-dragon-vision.md', title: '小龙与视野争夺' },
  },
  {
    id: 'lol-tactic-comeback-001',
    chunk_title: '劣势局翻盘策略',
    content:
      '英雄联盟劣势局保持冷静寻找对方失误。先做好防守视野不主动开团。利用对方推进站位分散寻找落单目标击杀。通过抓单获取人数优势后快速大龙或小龙。核心思路是拖延时间等对方犯错，不要急于开团。',
    score: 0.9,
    doc: { doc_name: 'lol-comeback.md', title: '劣势局翻盘策略' },
  },
  {
    id: 'lol-tactic-laning-vision-001',
    chunk_title: '对线期视野布置',
    content:
      '英雄联盟对线视野分进攻视野与防守视野。防守视野布置河道草丛和己方BUFF入口防GANK。进攻视野布置对方野区入口和BUFF附近获取打野信息。辅助回家后第一时间补充视野道具。AD也可购买控制守卫放河道草丛。',
    score: 0.89,
    doc: { doc_name: 'lol-laning-vision.md', title: '对线期视野布置' },
  },
];

const defaultLocalKnowledgeItems = baseItems.map((item) => ({
  id: item.id,
  point_id: item.id,
  chunk_title: item.chunk_title,
  domain: LOL_DOMAIN,
  game_aliases: LOL_ALIASES,
  content: item.content,
  score: item.score,
  chunk_type: 'text',
  doc_info: {
    doc_id: `doc-${item.id}`,
    doc_name: item.doc.doc_name,
    title: item.doc.title,
    doc_type: 'md',
  },
}));

export function getDefaultLocalKnowledgeItems() {
  return defaultLocalKnowledgeItems;
}

export function getDefaultLocalKnowledgeDomain() {
  return LOL_DOMAIN;
}

export function searchDefaultLocalKnowledge(query, limit = 5) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) {
    return emptyResult();
  }

  const keywords = normalizedQuery.split(/\s+/).filter(Boolean);
  const matched = defaultLocalKnowledgeItems
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

      return { ...item, _matchScore: fallbackHits };
    })
    .filter((item) => item._matchScore > 0);

  if (matched.length === 0) {
    return emptyResult();
  }

  const resultList = matched
    .sort((left, right) => right._matchScore - left._matchScore || right.score - left.score)
    .slice(0, limit)
    .map(({ _matchScore, ...item }) => item);

  return {
    code: 0,
    message: 'success',
    request_id: `default-local-${Date.now()}`,
    data: {
      collection_name: 'default-local-lol-knowledge',
      count: resultList.length,
      result_list: resultList,
    },
  };
}

function emptyResult() {
  return {
    code: 0,
    message: 'success',
    request_id: `default-local-${Date.now()}`,
    data: {
      collection_name: 'default-local-lol-knowledge',
      count: 0,
      result_list: [],
    },
  };
}
