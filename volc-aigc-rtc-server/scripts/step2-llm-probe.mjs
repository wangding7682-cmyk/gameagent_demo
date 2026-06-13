#!/usr/bin/env node
/**
 * Step 2 LLM 单次延迟探测：直接打 ARK 看一次复合句拆解的真实响应时间
 */
import { __INTERNAL } from '../src/services/taskPlannerService.js';
const t0 = Date.now();
try {
  const res = await __INTERNAL.runLlmTaskPlanner({
    user_query: '亚索打盲僧怎么对线？另外给我个连招视频看看',
    main_intent: 'strategy',
    timeout_ms: 20000,
  });
  console.log(`OK ${Date.now() - t0}ms`, JSON.stringify(res, null, 2));
} catch (e) {
  console.log(`FAIL ${Date.now() - t0}ms ${e.message}`);
}
