/**
 * test/api-transient-retry.test.mjs —— 「链路瞬时卡顿」的容错护栏（2026-10-19 事故）
 *
 * 背景：10-19 早上 06:55–08:14 连续 79 分钟无法完成认证 —— 每次请求都撞在链路卡顿上直接判失败。
 * 修法两层：① socket 空闲超时 15s→30s；② 幂等 GET 对瞬时失败做有限重试（写操作不重试）。
 *
 * 判据：
 *   - GET 第一次卡死、第二次正常 ⇒ 应当成功，且服务端被打了 2 次；
 *   - GET 一直卡死 ⇒ 应当失败，服务端被打了 1 + 2（重试上限）次；
 *   - POST 卡死 ⇒ 只打 1 次（绝不重试写操作）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let server;
let base;
const hits = { stallOnce: 0, alwaysStall: 0, postStall: 0, ok: 0 };
let client;

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/ok') { hits.ok++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (url === '/stall-once') {
      hits.stallOnce++;
      if (hits.stallOnce === 1) return;           // 第一次不响应 ⇒ 触发 socket 超时
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return;
    }
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
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  delete process.env.VRC_MONITOR_API_BASE;
  delete process.env.VRC_MONITOR_API_TIMEOUT_MS;
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

test('瞬时错误判定：超时/连接重置算瞬时，HTTP 4xx 不算', async () => {
  const mod = await import('../vrchat-api.js');
  assert.equal(mod.isTransientApiError(new Error('VRChat API 请求超时 (30000ms): GET /auth/user')), true);
  assert.equal(mod.isTransientApiError(Object.assign(new Error('read ECONNRESET'), {})), true);
  assert.equal(mod.isTransientApiError(new Error('GET /auth/user → HTTP 401')), false);
});