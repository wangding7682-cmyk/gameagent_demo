const WZRY_DOMAIN = 'wzry';
const WZRY_ALIASES = ['王者荣耀', 'wzry', 'WZRY', '王者', 'honor of kings', 'kpl'];

const baseItems = [
  {
    id: 'wzry-hero-luban-001',
    chunk_title: '鲁班七号下路对线与团战',
    content:
      '王者荣耀鲁班七号是经典的射手英雄，前期对线主要靠普攻消耗，留好二技能用于逃生或追击。大招诸葛连弩需要在团战中找好站位输出，避免被刺客切死。出装优先无尽战刃和泣血之刃，鞋子选影忍。',
    score: 0.95,
    doc: { doc_name: 'wzry-luban-adc.md', title: '鲁班七号攻略' },
  },
  {
    id: 'wzry-hero-diaochan-001',
    chunk_title: '貂蝉中路连招与团战时机',
    content:
      '王者荣耀貂蝉是高爆发法师，核心连招是 1 技能起手叠层，配合 2 技能眩晕和大招收割。对线期注意打满被动叠加输出，团战切后排时机要在对方关键技能交完后。出装回响之杖和痛苦面具叠 AP。',
    score: 0.94,
    doc: { doc_name: 'wzry-diaochan-mid.md', title: '貂蝉中路攻略' },
  },
  {
    id: 'wzry-hero-houyi-001',
    chunk_title: '后羿后期发育与团战站位',
    content:
      '王者荣耀后羿是后期发育型射手，前期对线偏弱需要稳健补刀。被动可以多次普攻提升输出，二技能减速保命，大招黄昏轮舞团战开团或反先手。需要辅助保护，团战站位最后避免切脸。',
    score: 0.92,
    doc: { doc_name: 'wzry-houyi-adc.md', title: '后羿射手攻略' },
  },
  {
    id: 'wzry-hero-libai-001',
    chunk_title: '李白打野连招与切后排技巧',
    content:
      '王者荣耀李白是打野刺客，核心连招是 2 起手 1A1A1A 标记接大招收割。打野前期红开稳定刷线，4级 GANK 配合中辅打开局面。出装宗师之力和暗影战斧提升爆发，鞋子根据对面阵容选。',
    score: 0.93,
    doc: { doc_name: 'wzry-libai-jungle.md', title: '李白打野连招' },
  },
  {
    id: 'wzry-hero-zhuangzhou-001',
    chunk_title: '庄周辅助保护与解控时机',
    content:
      '王者荣耀庄周是经典保护型辅助，被动免控对抗连控阵容效果好。大招逍遥游为队友解控并加移速，时机选在 ADC 被切或冲脸时。出装基础辅助装+冰心+魔女，提升团队增益效果。',
    score: 0.91,
    doc: { doc_name: 'wzry-zhuangzhou-support.md', title: '庄周辅助攻略' },
  },
  {
    id: 'wzry-hero-zhongkui-001',
    chunk_title: '钟馗钩人与团战开团',
    content:
      '王者荣耀钟馗是经典钩子型法坦，一技能勾人是核心控制。对线时利用草丛视野出钩成功率更高。团战钩到 C 位后接大招控制让队友秒杀。出装梦魇之牙和巨人之握兼顾输出与坦度。',
    score: 0.9,
    doc: { doc_name: 'wzry-zhongkui-support.md', title: '钟馗辅助开团' },
  },
  {
    id: 'wzry-hero-cao-001',
    chunk_title: '曹操对抗路对线与团战切入',
    content:
      '王者荣耀曹操是对抗路常见战士，前期靠 1 技能消耗和 2 技能位移交换。大招集结刀气可远程消耗或收割。团战利用突进切后排，注意先手时机避免被反控。出装暗影战斧和破军提升爆发。',
    score: 0.89,
    doc: { doc_name: 'wzry-cao-fighter.md', title: '曹操对抗路攻略' },
  },
  {
    id: 'wzry-hero-baili-001',
    chunk_title: '百里守约射手定位与切后排',
    content:
      '王者荣耀百里守约是远程射手/打野，狙击型 ADC。被动二段普攻提供爆发，大招远程狙击可点射残血。打野位需配合 GANK 节奏，团战站远距离消耗后排。出装末世和无尽战刃组合输出。',
    score: 0.88,
    doc: { doc_name: 'wzry-baili-shooter.md', title: '百里守约攻略' },
  },
  {
    id: 'wzry-tactic-canyon-001',
    chunk_title: '王者峡谷资源节奏：暴君主宰',
    content:
      '王者荣耀对局资源以暴君和主宰为核心。8 分钟前优先暴君获取 BUFF 推塔。10 分钟后视情况打主宰获取兵线压力。打野要打满经济，4 级先抓边路打开节奏，避免空耗时间。',
    score: 0.94,
    doc: { doc_name: 'wzry-canyon-resource.md', title: '王者峡谷资源节奏' },
  },
  {
    id: 'wzry-tactic-vision-001',
    chunk_title: '王者荣耀视野布置与扫描使用',
    content:
      '王者荣耀视野道具有限，主要靠扫描和草丛位移技能探眼。河道草丛和野区入口是关键视野点。打资源前先扫描确认对方位置，避免被反开。辅助应该携带扫描，AD 可酌情携带闪现+净化。',
    score: 0.91,
    doc: { doc_name: 'wzry-vision-scan.md', title: '王者视野布置' },
  },
  {
    id: 'wzry-tactic-team-001',
    chunk_title: '王者荣耀团战分工与开团时机',
    content:
      '王者荣耀团战分工：坦克前排开团，战士切后排，法师消耗，射手稳定输出，辅助保护或先手。开团时机选对方关键控制和位移技能交完。注意阵容是否有强保护或强切后排，调整开团策略。',
    score: 0.92,
    doc: { doc_name: 'wzry-teamfight.md', title: '王者团战分工' },
  },
  {
    id: 'wzry-tactic-laning-001',
    chunk_title: '王者荣耀对线兵线与塔下补刀',
    content:
      '王者荣耀对线兵线尽量控在己方塔前防 GANK。塔下补刀近战兵塔射两下后补一刀，远程兵塔射一下后补一刀。劣势局尽量推线放塔避免被压制。优势局可冻线压制对方发育。',
    score: 0.9,
    doc: { doc_name: 'wzry-laning.md', title: '王者对线兵线处理' },
  },
];

const defaultWzryKnowledgeItems = baseItems.map((item) => ({
  id: item.id,
  point_id: item.id,
  chunk_title: item.chunk_title,
  domain: WZRY_DOMAIN,
  game_aliases: WZRY_ALIASES,
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

export function getDefaultWzryKnowledgeItems() {
  return defaultWzryKnowledgeItems;
}

export function getDefaultWzryKnowledgeDomain() {
  return WZRY_DOMAIN;
}

export function searchDefaultWzryKnowledge(query, limit = 5) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) {
    return emptyResult();
  }

  const keywords = normalizedQuery.split(/\s+/).filter(Boolean);
  const matched = defaultWzryKnowledgeItems
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
    request_id: `default-wzry-${Date.now()}`,
    data: {
      collection_name: 'default-local-wzry-knowledge',
      count: resultList.length,
      result_list: resultList,
    },
  };
}

function emptyResult() {
  return {
    code: 0,
    message: 'success',
    request_id: `default-wzry-${Date.now()}`,
    data: {
      collection_name: 'default-local-wzry-knowledge',
      count: 0,
      result_list: [],
    },
  };
}
