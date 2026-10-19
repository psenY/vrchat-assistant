/**
 * test/api-transient-retry.test.mjs —— 「链路瞬时卡顿」的容错护栏（2026-10-19 事故 → PR #311）
 *
 * 背景：10-19 早上 06:55–08:14 连续 79 分钟无法完成认证 —— 每次请求都撞在链路卡顿上直接判失败。
 * 修法：① socket 空闲超时 15s→30s；② 幂等 GET 对瞬时失败做有限重试（写操作不重试）。
 *
 * 复审（nixi-agent ⚠️1/💡4）补的两条必须锁死：
 *   - 预算判据要把【下一次尝试自身的超时】算进去，否则会出现「调用方已超时、重试仍在后台跑」的孤儿请求；
 *   - 限流器包裹是生产主路径，重试链必须在限流器任务预算内完成。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RateLimiter } from '../core/rate-limiter.js';

let server;
let base;
const hits = { stallOnce: 0, stallOnceRl: 0, alwaysStall: 0, postStall: 0, stallBudget: 0, ok: 0 };
let client;

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const ok200 = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };
    if (url === '/ok') { hits.ok++; return ok200(); }
    if (url === '/stall-once') { hits.stallOnce++; if (hits.stallOnce === 1) return; return ok200(); }
    if (url === '/stall-once-rl') { hits.stallOnceRl++; if (hits.stallOnceRl === 1) return; return ok200(); }
    if (url === '/stall-budget') { hits.stallBudget++; return; }   // 永不响应，供预算用例使用
    if (url === '/always-stall') { hits.alwaysStall++; return; }
    if (url === '/post-stall') { hits.postStall++; return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  process.env.VRC_MONITOR_API_BASE = base;
  process.env.VRC_MONITOR_API_TIMEOUT_MS = '300';   // 缩短超时，让用例秒级完成
  const mod = await import('../vrchat-api.js');
  client = new mod.VrchatApiClient('a@b.c', 'x');
});

after(async () => {
  if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  delete process.env.VRC_MONITOR_API_BASE;
  delete process.env.VRC_MONITOR_API_TIMEOUT_MS;
  delete process.env.VRC_MONITOR_API_RETRY_BUDGET_MS;
});

test('GET 瞬时卡顿一次 ⇒ 重试后成功（服务端被打 2 次）', async () => {
  const r = await client._request('GET', '/stall-once');
  assert.equal(r.status, 200);
  assert.equal(hits.stallOnce, 2, '应当恰好在第二次请求成功（1 次超时 + 1 次重试）');
});

test('GET 持续卡死 ⇒ 有限重试后失败（1 + 2 次）', async () => {
  await assert.rejects(() => client._request('GET', '/always-stall'), /超时|timeout/i);
  assert.equal(hits.alwaysStall, 3, '一次原始请求 + 两次重试，不应无限重试');
});

test('POST 卡死 ⇒ 绝不重试（写操作只打 1 次）', async () => {
  await assert.rejects(() => client._request('POST', '/post-stall', { a: 1 }), /超时|timeout/i);
  assert.equal(hits.postStall, 1, '写操作重试可能重复执行，必须只打一次');
});

test('预算覆盖不了下一次尝试 ⇒ 不重试（复审 ⚠️1：不产生孤儿请求）', async () => {
  // 单次超时 300ms；预算设 200ms ⇒ 300 + 300 > 200 ⇒ 第一次失败后不得再发
  process.env.VRC_MONITOR_API_RETRY_BUDGET_MS = '200';
  const beforeHits = hits.stallBudget;
  try {
    await assert.rejects(() => client._request('GET', '/stall-budget'), /超时|timeout/i);
    assert.equal(hits.stallBudget - beforeHits, 1, '预算不足时必须只发 1 次（否则调用方已超时、重试还在后台跑）');
  } finally {
    delete process.env.VRC_MONITOR_API_RETRY_BUDGET_MS;
  }
});

test('限流器包裹主路径：重试在任务预算内完成，不触发限流器超时（复审 💡4）', async () => {
  const limiter = new RateLimiter({ minInterval: 1, taskTimeoutMs: 45000 });
  const r = await limiter.execute(() => client._request('GET', '/stall-once-rl'));
  assert.equal(r.status, 200);
  assert.equal(hits.stallOnceRl, 2, '限流器包裹下重试仍生效');
  assert.equal(limiter.getStats().taskTimeouts, 0, '重试链不应撞上限流器任务超时');
});

test('瞬时错误判定：超时/连接重置算瞬时，HTTP 4xx 不算', async () => {
  const mod = await import('../vrchat-api.js');
  assert.equal(mod.isTransientApiError(new Error('VRChat API 请求超时 (30000ms): GET /auth/user')), true);
  assert.equal(mod.isTransientApiError(new Error('read ECONNRESET')), true);
  assert.equal(mod.isTransientApiError(new Error('GET /auth/user → HTTP 401')), false);
});