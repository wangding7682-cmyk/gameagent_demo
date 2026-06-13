const DOMAIN_REGISTRY = [
  {
    domain: 'lol',
    label: '英雄联盟',
    aliases: [
      '英雄联盟',
      'lol',
      'LOL',
      'league of legends',
      '召唤师峡谷',
      'lol端游',
    ],
    heroKeywords: [
      '亚索',
      '盲僧',
      '锐雯',
      '劫',
      '皇子',
      '大树',
      '狐狸',
      '锤石',
      '蔚',
      '卡萨丁',
      '德莱厄斯',
      '剑姬',
      '小法师',
      '牛头',
      '泽拉斯',
      '维克托',
      '卢锡安',
      // 别名/外号扩展（解决代词/外号召回）
      '艾尼维亚',
      '冰晶凤凰',
      '蔚',
      '艾克',
      '时光',
      '机器人',
      '布隆',
      '寒冰',
      '金克斯',
      '龙女',
      '龙血武姬',
      '希瓦娜',
      '蛮王',
      '剑魔',
      '诺手',
      '德玛西亚',
      '盖伦',
      '赵信',
      '猴子',
      '齐天大圣',
      '璐璐',
      '蕾欧娜',
      '墨菲特',
      '德莱文',
      '女警',
    ],
    termKeywords: ['召唤师峡谷', '大龙', '峡谷先锋', '镀层', '小龙', '河道', 'baron', 'herald'],
  },
  {
    domain: 'wzry',
    label: '王者荣耀',
    aliases: ['王者荣耀', 'wzry', 'WZRY', '王者', 'honor of kings', 'kpl'],
    heroKeywords: [
      '鲁班',
      '貂蝉',
      '后羿',
      '李白',
      '庄周',
      '钟馗',
      '曹操',
      '百里守约',
      '百里玄策',
      '诸葛亮',
      '王昭君',
      '安琪拉',
      '韩信',
      '赵云',
      '马可波罗',
      '孙尚香',
    ],
    termKeywords: ['王者峡谷', '暴君', '主宰', '红 buff', '蓝 buff', '抗压路', '发育路'],
  },
  {
    domain: 'genshin',
    label: '原神',
    aliases: ['原神', 'genshin', 'genshin impact', '提瓦特'],
    heroKeywords: [
      '草神',
      '雷神',
      '钟离',
      '胡桃',
      '神里绫华',
      '甘雨',
      '夜兰',
      '魈',
      '迪卢克',
      '七七',
      '可莉',
      '芙宁娜',
      '纳西妲',
      '雷电将军',
    ],
    termKeywords: ['圣遗物', '元素反应', '深境螺旋', '蒸发', '融化', '感电', '七圣召唤'],
  },
  {
    domain: 'honkai',
    label: '崩坏：星穹铁道',
    aliases: ['崩坏星穹铁道', '星穹铁道', '星铁', 'honkai star rail', 'hsr'],
    heroKeywords: [
      '开拓者',
      '三月七',
      '丹恒',
      '希儿',
      '银狼',
      '景元',
      '布洛妮娅',
      '镜流',
      '白露',
      '克拉拉',
    ],
    termKeywords: ['模拟宇宙', '混沌回忆', '光锥', '遗器'],
  },
  {
    domain: 'zzz',
    label: '绝区零',
    aliases: ['绝区零', 'zzz', 'zenless zone zero'],
    heroKeywords: ['艾莲', '比利', '安比', '猫又', '11号', '苍角'],
    termKeywords: ['连携技', '极限支援', '零号空洞'],
  },
];

const ALL_DOMAINS = DOMAIN_REGISTRY.map((d) => d.domain);

export function listDomains() {
  return DOMAIN_REGISTRY.map((d) => ({
    domain: d.domain,
    label: d.label,
    aliases: d.aliases,
  }));
}

export function detectDomains(query = '') {
  const text = String(query || '').toLowerCase();
  if (!text) {
    return [];
  }

  const hits = [];
  for (const entry of DOMAIN_REGISTRY) {
    const matched = [
      ...entry.aliases,
      ...entry.heroKeywords,
      ...entry.termKeywords,
    ].some((kw) => text.includes(String(kw).toLowerCase()));

    if (matched) {
      hits.push(entry.domain);
    }
  }

  return hits;
}

export function isAmbiguousDomain(detectedDomains) {
  return !detectedDomains || detectedDomains.length === 0;
}

export function isCrossDomain(detectedDomains, sourceDomain) {
  if (!sourceDomain || !detectedDomains || detectedDomains.length === 0) {
    return false;
  }
  return !detectedDomains.includes(sourceDomain);
}

export function getDomainLabel(domain) {
  return DOMAIN_REGISTRY.find((d) => d.domain === domain)?.label || domain;
}

export function isKnownDomain(domain) {
  return ALL_DOMAINS.includes(domain);
}

/**
 * 从文本里抽出"已知英雄实体"列表（精确匹配 heroKeywords 词表）
 * 用于实体粘性：把上下文主角名抽出来，下一轮代词指代时前置注入。
 *
 * @param {string} text 待扫描文本（可拼接多轮 user_query+summary）
 * @param {string} [domain]  可选；指定后只在该 domain 词表内匹配，避免跨域噪声
 * @returns {Array<{hero:string, domain:string, count:number}>}
 *          按出现次数倒序，已去重；count 为该实体在 text 中的命中次数
 */
export function extractHeroEntities(text = '', domain = '') {
  const raw = String(text || '');
  if (!raw) return [];
  const targets = domain
    ? DOMAIN_REGISTRY.filter((d) => d.domain === domain)
    : DOMAIN_REGISTRY;
  const counter = new Map(); // key: hero, value: { hero, domain, count }
  for (const entry of targets) {
    for (const hero of entry.heroKeywords || []) {
      const needle = String(hero || '').trim();
      if (!needle || needle.length < 2) continue; // 单字英雄（如"劫"）噪声大，先跳过
      let idx = 0;
      let count = 0;
      while ((idx = raw.indexOf(needle, idx)) !== -1) {
        count += 1;
        idx += needle.length;
      }
      if (count > 0) {
        // 同名跨 domain 取计数累加，domain 取首次命中域
        const exist = counter.get(needle);
        if (exist) {
          exist.count += count;
        } else {
          counter.set(needle, { hero: needle, domain: entry.domain, count });
        }
      }
    }
  }
  return Array.from(counter.values()).sort((a, b) => b.count - a.count);
}
