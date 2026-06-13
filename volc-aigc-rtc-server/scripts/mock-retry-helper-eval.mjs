/**
 * P2 mock 评测：retryHelperService
 *
 * 验证：
 *   - withRetry 在可重试错误上重试，不可重试上立即抛出
 *   - rewriteFailedQuery 去除冗余词、简化为关键词
 *   - isRetryableError 对 timeout/5xx/code=TIMEOUT 都识别
 */

import { withRetry, rewriteFailedQuery, isRetryableError } from '../src/services/retryHelperService.js';

let pass = 0;
let fail = 0;
function assert(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

console.log('\n[1] isRetryableError');
{
  assert('timeout_msg', isRetryableError(new Error('请求超时')) === true);
  assert('code_TIMEOUT', isRetryableError(Object.assign(new Error('x'), { code: 'TIMEOUT' })) === true);
  assert('fetch_failed', isRetryableError(new Error('fetch failed')) === true);
  assert('status_503', isRetryableError(Object.assign(new Error('x'), { status: 503 })) === true);
  assert('status_400_no_retry', isRetryableError(Object.assign(new Error('x'), { status: 400 })) === false);
  assert('null_error', isRetryableError(null) === false);
}

console.log('\n[2] withRetry：第一次失败可重试 → 第二次成功');
{
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('请求超时'), { code: 'TIMEOUT' });
    return 'ok';
  }, { maxAttempts: 2, delayMs: 0 });
  assert('retried_to_success', result === 'ok' && calls === 2);
}

console.log('\n[3] withRetry：不可重试错误立即抛出');
{
  let calls = 0;
  let caught = null;
  try {
    await withRetry(async () => {
      calls++;
      throw Object.assign(new Error('bad request'), { status: 400 });
    }, { maxAttempts: 3, delayMs: 0 });
  } catch (e) {
    caught = e;
  }
  assert('non_retryable_no_retry', calls === 1 && caught?.status === 400);
}

console.log('\n[4] withRetry：达到最大次数后抛出最后错误');
{
  let calls = 0;
  let caught = null;
  try {
    await withRetry(async () => {
      calls++;
      throw Object.assign(new Error('5xx'), { status: 500 });
    }, { maxAttempts: 3, delayMs: 0 });
  } catch (e) {
    caught = e;
  }
  assert('exhausted_retries', calls === 3);
  assert('exhausted_throws_last', caught?.status === 500);
}

console.log('\n[5] withRetry：onAttempt 被回调');
{
  const events = [];
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    return 'ok';
  }, {
    maxAttempts: 2,
    delayMs: 0,
    onAttempt: (attempt, err) => events.push({ attempt, has_err: Boolean(err) }),
  });
  assert('on_attempt_called_2x', events.length >= 2);
  assert('on_attempt_attempt1_pre', events[0].attempt === 1 && events[0].has_err === false);
  assert('on_attempt_attempt1_err', events[1].attempt === 1 && events[1].has_err === true);
}

console.log('\n[6] rewriteFailedQuery：去除冗余 + 简化');
{
  const r1 = rewriteFailedQuery('能不能帮我看看亚索的连招视频啊？');
  assert('filler_removed', !r1.includes('能不能') && !r1.includes('帮我') && !r1.includes('看看'));
  assert('keywords_kept', r1.includes('亚索') && r1.includes('连招') && r1.includes('视频'));

  const r2 = rewriteFailedQuery('我想要那种盲僧打野的实战教学视频，最好是高分段的，谢谢啦');
  assert('filler_removed_2', !r2.includes('我想要') && !r2.includes('谢谢'));
  assert('length_capped', r2.length <= 30, `actual: ${r2}`);

  const r3 = rewriteFailedQuery('');
  assert('empty_returns_empty', r3 === '');
}

console.log('\n========== 总结 ==========');
console.log(`PASS ${pass}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
