/**
 * test-group-announcement-write.test.mjs — 群公告**写侧**两工具离线单测（假 api，无网络）
 *
 * 覆盖 set_group_announcement / delete_group_announcement：
 *   1. 缺 groupId / title / text → 抛错
 *   2. confirm 不为 true → 返回 confirmRequired，且**一次 fetch 都没发**
 *   3. confirm: true 但 myMember.permissions 不含 group-announcement-manage
 *      → permitted:false 且**没有写请求**（POST / DELETE）
 *   4. set：POST 到 /groups/{gid}/announcement，**body 是对象**、sendNotification 默认 false
 *   5. set：sendNotification:true + imageId 透传
 *   6. delete：DELETE 到 /groups/{gid}/announcement 且不带 body
 *   7. 两个工具定义都带 destructive:true（安全模式可拦）
 *
 * 用法：node --test test-group-announcement-write.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const GROUP_ID = 'grp_test-0000-0000-0000-000000000001';
const PERM = 'group-announcement-manage';
const ENDPOINT = `/groups/${GROUP_ID}/announcement`;

/** 构造假 api：收集 registerTool 的 def，并记录每一次 fetch 调用 */
function makeApi({ permissions = [PERM], postResult = {}, postError = null } = {}) {
  const tools = new Map();
  const calls = [];
  const api = {
    vrchat: {
      async fetch(p, opts = {}) {
        calls.push({ path: p, opts });
        if (opts && opts.method === 'POST') {
          if (postError) throw postError;
          return postResult;
        }
        if (p === `/groups/${GROUP_ID}`) return { id: GROUP_ID, myMember: { permissions } };
        return {};
      },
    },
    registerTool(def) { tools.set(def.name, def); },
    consume() { throw new Error('unexpected api.consume call'); },
  };
  return { api, tools, calls };
}

async function setup(opts) {
  const { api, tools, calls } = makeApi(opts);
  const register = (await import(
    pathToFileURL(path.join(REPO, 'plugins', 'official', 'groups', 'index.js')).href
  )).default;
  register(api);
  const set = tools.get('set_group_announcement');
  const del = tools.get('delete_group_announcement');
  assert.ok(set, 'set_group_announcement should be registered');
  assert.ok(del, 'delete_group_announcement should be registered');
  return { set, del, calls };
}

const writes = (calls) => calls.filter((c) => c.opts && ['POST', 'DELETE'].includes(c.opts.method));

// ─────────────────────────── set ───────────────────────────

test('set: 缺 groupId / title / text 时抛错', async () => {
  const { set } = await setup({});
  await assert.rejects(() => set.handler({ title: 'T', text: 'B' }), /groupId is required/);
  await assert.rejects(() => set.handler({ groupId: GROUP_ID, text: 'B' }), /title is required/);
  await assert.rejects(() => set.handler({ groupId: GROUP_ID, title: 'T' }), /text is required/);
});

test('set: confirm 不为 true → 返回预览，且一次请求都不发', async () => {
  const { set, calls } = await setup({});
  const r = await set.handler({ groupId: GROUP_ID, title: 'T', text: 'B' });
  assert.equal(r.confirmRequired, true);
  assert.equal(r.posted, undefined);
  assert.equal(calls.length, 0, 'confirm 缺失时不允许发出任何请求');
});

test('set: 有 confirm 但无 group-announcement-manage → permitted:false 且不发写请求', async () => {
  const { set, calls } = await setup({ permissions: ['group-members-viewall', 'group-instance-join'] });
  const r = await set.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true });
  assert.equal(r.permitted, false);
  assert.equal(r.posted, false);
  assert.equal(writes(calls).length, 0, '权限不足时不允许发 POST');
  // 自查权限这一步是只读的 GET
  assert.deepEqual(calls.map((c) => c.path), [`/groups/${GROUP_ID}`]);
});

test('set: 权限 OK + confirm → POST 到 announcement，body 为对象、sendNotification 默认 false', async () => {
  const { set, calls } = await setup({
    postResult: { id: 'not_1', title: 'T', text: 'B', authorId: 'usr_x', createdAt: 'c', updatedAt: 'u' },
  });
  const r = await set.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true });
  assert.equal(r.posted, true);
  assert.equal(r.announcement.id, 'not_1');
  assert.equal(r.announcement.title, 'T');

  const post = calls.find((c) => c.opts && c.opts.method === 'POST');
  assert.ok(post, '应当发出 POST');
  assert.equal(post.path, ENDPOINT);
  // body 必须是**对象**：api.vrchat.fetch → _requestRaw 内部已 JSON.stringify，
  // 这里再串化一次 = 双重编码（服务端收到字符串字面量）—— 实测踩过。
  assert.equal(typeof post.opts.body, 'object', 'body 必须是对象，不能是已序列化的字符串');
  assert.equal(Array.isArray(post.opts.body), false, 'body 不应是数组');
  const body = post.opts.body;
  assert.equal(body.title, 'T');
  assert.equal(body.text, 'B');
  assert.equal(body.sendNotification, false);
  assert.equal('imageId' in body, false, '未提供 imageId 时不应带该字段');
});

test('set: sendNotification:true 与 imageId 透传', async () => {
  const { set, calls } = await setup({ postResult: { id: 'not_2' } });
  await set.handler({
    groupId: GROUP_ID, title: 'T', text: 'B',
    imageId: 'file_abc', sendNotification: true, confirm: true,
  });
  const body = calls.find((c) => c.opts && c.opts.method === 'POST').opts.body;
  assert.equal(body.sendNotification, true);
  assert.equal(body.imageId, 'file_abc');
});

test('set: 服务端 400 时把服务端原因带进错误文案', async () => {
  const err = new Error('VRChat API 请求失败: 400 /groups/x/announcement');
  err.status = 400;
  err.response = { error: { message: 'Text is too long' } };
  const { set } = await setup({ postError: err });
  await assert.rejects(
    () => set.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true }),
    /Text is too long/,
  );
});

test('set: 非 400 错误原样抛出，不被改写', async () => {
  const err = new Error('VRChat API 请求失败: 403 /groups/x/announcement');
  err.status = 403;
  err.response = { error: { message: 'Forbidden' } };
  const { set } = await setup({ postError: err });
  await assert.rejects(
    () => set.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true }),
    (e) => e === err,
  );
});

// ────────────────────────── delete ──────────────────────────

test('delete: 缺 groupId 时抛错', async () => {
  const { del } = await setup({});
  await assert.rejects(() => del.handler({}), /groupId is required/);
});

test('delete: confirm 不为 true → 返回预览，且一次请求都不发', async () => {
  const { del, calls } = await setup({});
  const r = await del.handler({ groupId: GROUP_ID });
  assert.equal(r.confirmRequired, true);
  assert.equal(r.deleted, undefined);
  assert.equal(calls.length, 0, 'confirm 缺失时不允许发出任何请求');
});

test('delete: 有 confirm 但无权限 → permitted:false 且不发 DELETE', async () => {
  const { del, calls } = await setup({ permissions: ['group-members-viewall'] });
  const r = await del.handler({ groupId: GROUP_ID, confirm: true });
  assert.equal(r.permitted, false);
  assert.equal(r.deleted, false);
  assert.equal(writes(calls).length, 0, '权限不足时不允许发 DELETE');
  assert.deepEqual(calls.map((c) => c.path), [`/groups/${GROUP_ID}`]);
});

test('delete: 权限 OK + confirm → DELETE 到 announcement 且不带 body', async () => {
  const { del, calls } = await setup({});
  const r = await del.handler({ groupId: GROUP_ID, confirm: true });
  assert.equal(r.deleted, true);
  const d = calls.find((c) => c.opts && c.opts.method === 'DELETE');
  assert.ok(d, '应当发出 DELETE');
  assert.equal(d.path, ENDPOINT);
  assert.equal(d.opts.body, undefined, 'DELETE 不应带 body');
});

// ───────────────────── 工具定义（两个都查）─────────────────────

test('两个写侧工具定义合法且都带 destructive:true', async () => {
  const { set, del } = await setup({});
  assert.equal(set.destructive, true);
  assert.deepEqual(set.inputSchema.required, ['groupId', 'title', 'text']);
  assert.equal(typeof set.description, 'string');
  assert.equal(typeof set.handler, 'function');

  assert.equal(del.destructive, true, 'delete_ 前缀工具不声明 destructive 会被 loader 拒绝加载');
  assert.deepEqual(del.inputSchema.required, ['groupId']);
  assert.equal(typeof del.description, 'string');
  assert.equal(typeof del.handler, 'function');
});
