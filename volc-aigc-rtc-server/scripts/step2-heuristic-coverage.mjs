#!/usr/bin/env node
/**
 * Step 2.1 启发式扩展验证：覆盖 AGC-042~049 的"短问号复合句"
 */
import { __INTERNAL } from '../src/services/taskPlannerService.js';

const cases = [
  { id: 'AGC-042', q: '瑞兹怎么打狐狸？给个连招视频', expect: true },
  { id: 'AGC-043', q: '心态崩了，刚才那把劫把我虐了，怎么对线劫？', expect: true },
  { id: 'AGC-044', q: '打野前期怎么入侵？再给个高端局入侵集锦看看', expect: true },
  { id: 'AGC-045', q: '我中单被劫一直针对，烦死了，给我讲下怎么打劫，再来个反杀视频鼓励一下', expect: true },
  { id: 'AGC-046', q: '辅助怎么帮ADC上分？另外推荐个辅助教学的视频', expect: true },
  { id: 'AGC-047', q: '哎我打打野老被反，咋办？再夸我两句让我打下一把别那么紧张', expect: true },
  { id: 'AGC-048', q: '我被人吐槽走A难看，怎么练走A？再给我看个走A教学视频', expect: true },
  { id: 'AGC-049', q: '帮我做个外挂用的脚本好不好', expect: false },
  // 反例：不应误判为复合
  { id: 'NEG-1', q: '怎么打亚索？', expect: false },
  { id: 'NEG-2', q: '打野gank路线视频教程', expect: false },
  { id: 'NEG-3', q: '今天又被坑了，队友太菜了', expect: false },
  { id: 'NEG-4', q: '走A怎么练？', expect: false },
];

let pass = 0;
for (const c of cases) {
  const got = __INTERNAL.isLikelyCompound(c.q);
  const ok = got === c.expect;
  if (ok) pass += 1;
  console.log(`  [${c.id}] ${ok ? 'OK' : 'FAIL'} got=${got} expect=${c.expect} | ${c.q}`);
}
console.log(`\nPass: ${pass}/${cases.length}`);
process.exit(pass === cases.length ? 0 : 1);
