/**
 * 知识卡片风格守门员单元测试
 * 跑：node scripts/mock-knowledge-card-style-eval.mjs
 */
import { sanitizeKnowledgeCardImagePrompt, __internals } from '../src/services/knowledgeCardStyleService.js';

let pass = 0;
let fail = 0;
const log = [];
function assert(name, cond, detail) {
  if (cond) { pass++; log.push(`  PASS  ${name}`); }
  else { fail++; log.push(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

console.log('========== knowledgeCardStyleService 测试 ==========');

// 1. 历史"游戏画面派" prompt 应该被剥词 + 加前缀
{
  const evil = '英雄联盟召唤师峡谷团战场景，蓝色方经济领先但站位分散，红色方抱团反打，风格贴合游戏原画，写实3D渲染。';
  const out = sanitizeKnowledgeCardImagePrompt(evil);
  assert('剥掉"英雄联盟"', !out.includes('英雄联盟'), out);
  assert('剥掉"召唤师峡谷"', !out.includes('召唤师峡谷'), out);
  assert('剥掉"团战场景"', !out.includes('团战场景'), out);
  assert('剥掉"蓝色方"', !out.includes('蓝色方'), out);
  assert('剥掉"游戏原画"', !out.includes('游戏原画'), out);
  // "写实" 仅检查不在用户内容部分（FORCED_PREFIX 含"无写实画面"是反向声明，合规）
  const userContent = out.split('内容主题：')[1] || '';
  assert('用户内容部分不含"写实"', !userContent.includes('写实'), userContent);
  assert('剥掉"3D"', !out.includes('3D'), out);
  assert('剥掉"渲染"', !out.includes('渲染'), out);
  assert('补上"极简"前缀', out.includes('极简') || out.toLowerCase().includes('infographic'), out);
  assert('补上"flat design"', out.toLowerCase().includes('flat design'), out);
  assert('补上配色 #FFFFFF', out.includes('#FFFFFF'), out);
  assert('长度<=220', out.length <= 220, `len=${out.length}`);
}

// 2. 已经合规的 prompt 不应被破坏
{
  const good = '极简知识卡片信息图，纯白背景，顶部加粗标题"打野节奏"，下方三行要点。Apple-style typography，flat design，居中对称排版，无人物无场景。';
  const out = sanitizeKnowledgeCardImagePrompt(good);
  assert('合规 prompt 保留"极简"', out.includes('极简'));
  assert('合规 prompt 保留"打野节奏"', out.includes('打野节奏'));
  assert('合规 prompt 保留 typography', out.toLowerCase().includes('typography'));
  assert('合规 prompt 不重复加前缀（不出现两次极简知识卡片信息图）', out.split('极简知识卡片信息图').length <= 2);
}

// 3. 空 / null / undefined
{
  assert('null → null', sanitizeKnowledgeCardImagePrompt(null) === null);
  assert('"" → null', sanitizeKnowledgeCardImagePrompt('') === null);
  assert('undefined → null', sanitizeKnowledgeCardImagePrompt(undefined) === null);
  assert('纯空白 → null', sanitizeKnowledgeCardImagePrompt('   ') === null);
}

// 4. 太短的有效内容会被前缀补救
{
  const tiny = '打野节奏';
  const out = sanitizeKnowledgeCardImagePrompt(tiny);
  assert('短文本被前缀补救', out.includes('极简') && out.includes('打野节奏'));
}

// 5. 长度截断
{
  const longText = '极简信息图 ' + '打野节奏'.repeat(100);
  const out = sanitizeKnowledgeCardImagePrompt(longText);
  assert('长 prompt 被截到 <=220', out.length <= __internals.MAX_PROMPT_LEN);
}

// 6. 完全不合规且无关游戏的内容也能被强制套上风格
{
  const off = '画一只在草地上奔跑的小狗，阳光明媚。';
  const out = sanitizeKnowledgeCardImagePrompt(off);
  assert('无关内容也被加前缀', out.includes('极简') || out.toLowerCase().includes('infographic'));
}

// 7. 复发组合词：氛围紧张 / 紧张氛围 / 激烈对抗 / 战斗场面
{
  const evil = '极简信息图，氛围紧张，激烈对抗，战斗场面，主题是打团节奏。';
  const out = sanitizeKnowledgeCardImagePrompt(evil);
  assert('剥"氛围紧张"', !out.includes('氛围紧张'));
  assert('剥"激烈对抗"', !out.includes('激烈对抗'));
  assert('剥"战斗场面"', !out.includes('战斗场面'));
  assert('保留"打团节奏"主题', out.includes('打团节奏'));
}

// 8. 配色相关（合规 prompt 写了 #FF8A2D 应保留）
{
  const good = '极简知识卡片信息图，纯白背景 #FFFFFF，橙色高亮 #FF8A2D，标题 #1A1A1A，flat design，typography poster，居中。';
  const out = sanitizeKnowledgeCardImagePrompt(good);
  assert('保留 #FF8A2D 橙色', out.includes('#FF8A2D'));
  assert('保留 #1A1A1A 深灰', out.includes('#1A1A1A'));
}

console.log(log.join('\n'));
console.log(`\n========== 总结 ==========`);
console.log(`Total: ${pass + fail}, Pass: ${pass}, Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
