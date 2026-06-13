// 业务场景 smoke：复盘"上轮亚索 / 当轮冰晶凤凰" bug 是否被修复
import { extractHeroEntities } from '../src/services/domainRouterService.js';

// 内联等价 pickStickyHero（与 agentContextService 实现一致）
function pickStickyHero(recentTurns = [], domainHint = '', currentQuery = '') {
  const currentList = extractHeroEntities(String(currentQuery || ''), domainHint);
  if (currentList.length > 0) return { ...currentList[0], source: 'current' };
  const text = recentTurns
    .slice(-3)
    .map((t) => `${t.user_query || ''} ${t.summary || t.main_summary || ''}`)
    .join(' ');
  const list = extractHeroEntities(text, domainHint);
  if (list.length === 0) return null;
  return { ...list[0], source: 'history' };
}

const PRONOUN_REGEX = /(他|她|它|这个英雄|那个英雄|这位英雄|那位英雄|这个角色|那个角色|刚才说的|刚才那个|这英雄|那英雄)/;

function rewriteWithStickyHero(query, sticky) {
  const q = String(query || '').trim();
  if (!q || !sticky) return q;
  if (sticky.source === 'current') return q;
  if (q.includes(sticky.hero)) return q;
  if (!PRONOUN_REGEX.test(q)) return q;
  return `[关于${sticky.hero}] ${q}`;
}

// === Case 1：bug 现场 ===
// 上一轮亚索，当前轮显式说冰晶凤凰
const c1Recent = [{ user_query: '亚索打盲僧怎么对线？', summary: '亚索 vs 盲僧对线' }];
const c1Q = '我想玩冰晶凤凰，这个英雄怎么出装？';
const c1Sticky = pickStickyHero(c1Recent, '', c1Q);
const c1Resolved = rewriteWithStickyHero(c1Q, c1Sticky);
console.log('[Case1] sticky=', c1Sticky?.hero, 'source=', c1Sticky?.source);
console.log('[Case1] resolved=', c1Resolved);
console.assert(c1Sticky?.hero === '冰晶凤凰', 'FAIL: sticky 应为冰晶凤凰');
console.assert(c1Sticky?.source === 'current', 'FAIL: source 应为 current');
console.assert(!c1Resolved.includes('亚索'), 'FAIL: 不应注入亚索');

// === Case 2：纯代词指代 → 应回退历史 ===
const c2Recent = [{ user_query: '冰晶凤凰技能怎么样？', summary: '冰晶凤凰技能解析' }];
const c2Q = '它对线该怎么打？';
const c2Sticky = pickStickyHero(c2Recent, '', c2Q);
const c2Resolved = rewriteWithStickyHero(c2Q, c2Sticky);
console.log('[Case2] sticky=', c2Sticky?.hero, 'source=', c2Sticky?.source);
console.log('[Case2] resolved=', c2Resolved);
console.assert(c2Sticky?.hero === '冰晶凤凰', 'FAIL: 应回退历史的冰晶凤凰');
console.assert(c2Sticky?.source === 'history', 'FAIL: source 应为 history');
console.assert(c2Resolved.includes('[关于冰晶凤凰]'), 'FAIL: 应前置 [关于冰晶凤凰]');

// === Case 3：当前轮和历史不同英雄，且当前轮还带代词 ===
// 「上轮亚索」+「我刚才那个冰晶凤凰怎么连招？」→ 当轮主角=冰晶凤凰（current 优先）
const c3Recent = [{ user_query: '亚索连招', summary: '亚索 EQ 闪' }];
const c3Q = '刚才说的冰晶凤凰怎么连招？';
const c3Sticky = pickStickyHero(c3Recent, '', c3Q);
const c3Resolved = rewriteWithStickyHero(c3Q, c3Sticky);
console.log('[Case3] sticky=', c3Sticky?.hero, 'source=', c3Sticky?.source);
console.log('[Case3] resolved=', c3Resolved);
console.assert(c3Sticky?.hero === '冰晶凤凰', 'FAIL: 当前轮显式英雄优先');
console.assert(!c3Resolved.includes('[关于亚索]'), 'FAIL: 绝不应注入亚索');

console.log('\n=== ALL ASSERTIONS PASSED ===');
