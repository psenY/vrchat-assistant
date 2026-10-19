// sendHtml 的 ETag / If-None-Match 304 行为（2026-09-22 用户反馈「无痕打开登录页也要 15 秒」）
//
// 页面是 ~1.5MB 的单文件（gzip 后 ~480KB），此前只有 Cache-Control: no-cache、没有 ETag
// ⇒ 每次打开都整包重下。加上 ETag 后浏览器带 If-None-Match 复验，未变更直接 304 = 零正文。
//
// 这里用最小 fake res/req 直接调生产函数：只断言「真的吐出 304 / 真的没有正文 / gzip 分支同样能 304」。
// 变异自证：删掉 sendHtml 里的 If-None-Match 判定 ⇒ 用例 2/3/5 红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendHtml } from '../plugins/official/web-dashboard/server/http.js';

const BIG = '<html><body>' + 'x'.repeat(4096) + '</body></html>';   // > 1024 ⇒ 走 gzip 分支
const SMALL = '<html><body>hi</body></html>';                        // 不压缩

function call(html, headers = {}) {
  const out = { status: null, headers: null, body: undefined };
  const res = {
    req: { headers },
    writeHead(code, h) { out.status = code; out.headers = h || {}; return res; },
    end(buf) { out.body = buf; return res; },
  };
  sendHtml(res, html);
  return out;
}

const tagOf = (r) => r.headers.ETag;

test('无 If-None-Match ⇒ 200 + ETag（**弱**校验器形态 W/"…"）', () => {
  const r = call(SMALL);
  assert.equal(r.status, 200);
  // 弱校验器：同一个 tag 同时描述 gzip 与 identity 两种字节不同的表示（RFC 9110 §8.8.1；
  // 按 2026-10-18 复审 nixi-agent 💡1 的建议改成 W/ 形态，配合 Vary: Accept-Encoding）。
  assert.match(tagOf(r), /^W\/"[0-9a-f]{16}"$/, 'ETag 必须是「W/ + 带引号串」的弱校验器');
  assert.equal(r.headers['Cache-Control'], 'no-cache', '仍要每次复验，不能改成缓存');
  assert.ok(r.body && r.body.length > 0, '首次必须返回正文');
});

test('带相同 If-None-Match ⇒ 304 且零正文', () => {
  const first = call(SMALL);
  const second = call(SMALL, { 'if-none-match': tagOf(first) });
  assert.equal(second.status, 304, '内容未变必须 304');
  assert.equal(second.body, undefined, '304 不得带正文（这是省流量的全部意义）');
  assert.equal(tagOf(second), tagOf(first), '304 也要回 ETag，便于下一次继续复验');
  assert.equal(second.headers['Content-Length'], undefined, '304 不得声明 Content-Length');
});

test('If-None-Match 是多值列表时也要命中（浏览器/WAP 会带多个）', () => {
  const first = call(SMALL);
  const second = call(SMALL, { 'if-none-match': '"deadbeefdeadbeef", ' + tagOf(first) });
  assert.equal(second.status, 304);
});

test('内容变了 ⇒ ETag 变、不得 304', () => {
  const a = call(SMALL);
  const b = call(SMALL.replace('hi', 'yo'), { 'if-none-match': tagOf(a) });
  assert.notEqual(tagOf(b), tagOf(a), '内容不同 ETag 必须不同');
  assert.equal(b.status, 200, '内容变了要给新正文');
});

test('gzip 分支（大页面）同样支持 304，且 304 不带 Content-Encoding', () => {
  const gz = { 'accept-encoding': 'gzip, deflate, br' };
  const first = call(BIG, gz);
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Encoding'], 'gzip', '前置：大页面走 gzip 分支');
  const second = call(BIG, { ...gz, 'if-none-match': tagOf(first) });
  assert.equal(second.status, 304, 'gzip 分支也必须能 304（用户场景就是带 Accept-Encoding 复验）');
  assert.equal(second.headers['Content-Encoding'], undefined, '304 没有正文，不得声明编码');
  assert.equal(second.body, undefined);
});

test('If-None-Match 为空串 / 不相关值 ⇒ 照常 200', () => {
  assert.equal(call(SMALL, { 'if-none-match': '' }).status, 200);
  assert.equal(call(SMALL, { 'if-none-match': '"0000000000000000"' }).status, 200);
});

// ── 2026-10-18 复审（EMeowAGENT @ #307）三条 ─────────────────────────────
test('Vary: Accept-Encoding 必须出现在 304 与两个 200 分支（⚠️1：同一 ETag 描述 gzip/identity 两种表示）', () => {
  const gz = { 'accept-encoding': 'gzip' };
  const first = call(BIG, gz);
  assert.equal(first.headers.Vary, 'Accept-Encoding', 'gzip 200 必须带 Vary（否则共享缓存可能把 gzip 表示回给不收 gzip 的客户端）');
  const ident = call(BIG, { 'accept-encoding': 'identity' });
  assert.equal(ident.headers.Vary, 'Accept-Encoding', 'identity 200 同样要带');
  const hit = call(BIG, { ...gz, 'if-none-match': tagOf(first) });
  assert.equal(hit.status, 304);
  assert.equal(hit.headers.Vary, 'Accept-Encoding', '304 也要带 Vary（缓存据此判定表示能否复用）');
});

test('If-None-Match 为 * ⇒ 304（RFC 9110 §13.1.2：GET 语义下「已有任何表示」）', () => {
  assert.equal(call(SMALL, { 'if-none-match': '*' }).status, 304);
  assert.equal(call(BIG, { 'if-none-match': '*', 'accept-encoding': 'gzip' }).status, 304);
});

test('弱比较：服务端下发 W/ 形态，客户端回传**不带** W/ 的同一不透明串也命中', () => {
  const first = call(SMALL);
  const opaque = tagOf(first).replace(/^W\//, '');   // 剥掉 W/ 后的不透明部分
  assert.equal(call(SMALL, { 'if-none-match': opaque }).status, 304, '强弱形态互通（If-None-Match 是弱比较语义）');
  assert.equal(call(SMALL, { 'if-none-match': '"deadbeefdeadbeef", ' + opaque }).status, 304, '多值列表里同样命中');
  assert.equal(call(SMALL, { 'if-none-match': tagOf(first) }).status, 304, '原样回传 W/ 形态当然也命中');
});
