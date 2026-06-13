/**
 * 测试：间接/愿望句式视频请求识别
 * 用户："如果亚索这个英雄他玩他那个什么连招的话，有一些这个视频可以看就好了"
 */

const COMPOUND_HINT_REGEX = {
  connector: /[，,。.;；?？!！]|和|也|还|顺便|另外|再|外加|同时|帮我|给我|讲下|讲讲|推荐|来个/,
  strategy_keyword: /(怎么打|怎么练|怎么帮|怎么对|对线|出装|连招|技巧|攻略|思路|carry|入侵|反野|反入侵|开团|压塔|带线|翻盘|走A|上分|咋办|怎么办|被反|被针对|被压|被打爆|帮.{0,3}(ADC|adc|打野|上单|中单|辅助|队友))/,
  video_keyword: /(视频|集锦|高光|教学|示范|看看|演示|录像|教程|指导|示例|链接|资料链接|教程链接|看个|来个.{0,5}(视频|教学|集锦|示范|链接))/,
  emotion_keyword: /(夸夸|夸我|安慰|烦死|烦|心态|心情|加油|鼓励|没意思|好烦|别那么紧张|紧张|崩了|虐了|针对|吐槽)/,
};

function isLikelyCompound(query) {
  const q = String(query || '');
  if (q.length < 8) return false;
  const hasConnector = COMPOUND_HINT_REGEX.connector.test(q);
  const hasStrategy = COMPOUND_HINT_REGEX.strategy_keyword.test(q);
  const hasVideo = COMPOUND_HINT_REGEX.video_keyword.test(q);
  const hasEmotion = COMPOUND_HINT_REGEX.emotion_keyword.test(q);
  const intentHits = [hasStrategy, hasVideo, hasEmotion].filter(Boolean).length;
  if (hasConnector && intentHits >= 2) return true;
  if (q.length >= 12 && hasStrategy && hasVideo) return true;
  if (q.length >= 16 && hasEmotion && hasStrategy) return true;
  return false;
}

// 测试用例
const testQueries = [
  {
    name: '用户现场案例（间接请求）',
    query: '如果亚索这个英雄他玩他那个什么连招的话，有一些这个视频可以看就好了。',
  },
  {
    name: '直接复合句（对照组）',
    query: '亚索连招怎么打？再给个视频看看。',
  },
  {
    name: '纯视频请求（对照组）',
    query: '给我找个亚索连招视频。',
  },
  {
    name: '愿望句式变体1',
    query: '要是能有亚索连招的视频看看就好了。',
  },
  {
    name: '愿望句式变体2',
    query: '我想看看亚索连招的视频。',
  },
];

console.log('=== isLikelyCompound 测试结果 ===\n');
for (const tc of testQueries) {
  const result = isLikelyCompound(tc.query);
  console.log(`${result ? '✅' : '❌'} ${tc.name}`);
  console.log(`   查询: ${tc.query}`);
  console.log(`   结果: ${result ? '疑似复合句 → 调 LLM TaskPlanner' : '单意图 → 跳过快路径'}`);
  console.log();
}
