/**
 * test-group-posts-write.test.mjs — 群组「帖子 posts」四工具离线单测（假 api，无网络）
 *
 * 背景：`POST /groups/{gid}/announcement` 是 legacy **单槽**，发新公告会顶掉旧公告
 * （实测事故：VRCLT 群 10-03 的 v0.8.0 公告被 10-04 的 v0.8.1 覆盖）。
 * 官方追加式接口是 `/groups/{gid}/posts`（GET 列表 / POST 追加 / PUT+DELETE 改删单条）。
 *
 * 本套件钉住"发新帖不再顶掉旧帖"这件事，覆盖 get_group_posts / create_group_post /
 * update_group_post / delete_group_post：
 *   1. 必填参数与 visibility 校验（非法值抛错、缺省 'group'）
 *   2. confirm 缺省 → 返回 confirmRequired，且**一次 fetch 都不发**
 *   3. 权限不足 → permitted:false 且**没有写请求**（沿用 group-announcement-manage 自查）
 *   4. create 打到追加式 /groups/{gid}/posts（断言不是 /announcement）、body 是对象、
 *      sendNotification 默认 false、visibility / imageId / roleIds 透传
 *   5. 400 → 服务端原因带进错误文案；非 400 原样抛（不被改写）
 *   6. update PUT / delete DELETE 到 /posts/{postId}（delete 不带 body）
 *   7. get 的返回结构、403/404 空态不抛、query 参数只在有值时出现
 *   8. 工具定义：delete/update_group_post destructive:true，create/get 不为 true
 *   9. 作者补名上限 10（超出 authorName=null 且留 INFO 日志）；roleIds 空数组不进 body；
 *      安全模式（filterTools）剔除 update/delete、保留 create/get
 *
 * 用法：node --test test-group-posts-write.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const GROUP_ID = 'grp_test-0000-0000-0000-000000000001';
const PERM = 'group-announcement-manage';
const POSTS_ENDPOINT = `/groups/${GROUP_ID}/posts`;
const POST_ID = 'not_test-0000-0001';

const httpErr = (status, message) => {
  const e = new Error(`VRChat API 请求失败: ${status} /groups/x`);
  e.status = status;
  e.response = { error: { message } };
  return e;
};

/** 构造假 api：收集 registerTool 的 def，并记录每一次 fetch 调用 */
function makeApi({
  permissions = [PERM],
  postsResult = { posts: [], total: 0 },
  writeResult = {},
  writeError = null,
  getError = null,
  userResult = { displayName: '测试作者' },
} = {}) {
  const tools = new Map();
  const calls = [];
  const logs = [];
  const api = {
    vrchat: {
      async fetch(p, opts = {}) {
        calls.push({ path: p, opts });
        if (opts && opts.method && opts.method !== 'GET') {
          if (writeError) throw writeError;
          return writeResult;
        }
        if (p.startsWith(POSTS_ENDPOINT)) {
          if (getError) throw getError;
          return postsResult;
        }
        if (p === `/groups/${GROUP_ID}`) return { id: GROUP_ID, myMember: { permissions } };
        if (p.startsWith('/users/')) return userResult;
        return {};
      },
    },
    registerTool(def) { tools.set(def.name, def); },
    log(message) { logs.push(String(message)); },
    consume() { throw new Error('unexpected api.consume call'); },
  };
  return { api, tools, calls, logs };
}

async function setup(opts) {
  const { api, tools, calls, logs } = makeApi(opts);
  const register = (await import(
    pathToFileURL(path.join(REPO, 'plugins', 'official', 'groups', 'index.js')).href
  )).default;
  register(api);
  const get = tools.get('get_group_posts');
  const create = tools.get('create_group_post');
  const update = tools.get('update_group_post');
  const del = tools.get('delete_group_post');
  for (const [name, def] of [['get_group_posts', get], ['create_group_post', create],
    ['update_group_post', update], ['delete_group_post', del]]) {
    assert.ok(def, `${name} should be registered`);
  }
  return { get, create, update, del, calls, tools, logs };
}

const writes = (calls) => calls.filter((c) => c.opts && ['POST', 'PUT', 'DELETE'].includes(c.opts.method));

// ─────────────────────────── create ───────────────────────────

test('create: 缺 groupId / title / text 时抛错', async () => {
  const { create } = await setup({});
  await assert.rejects(() => create.handler({ title: 'T', text: 'B' }), /groupId is required/);
  await assert.rejects(() => create.handler({ groupId: GROUP_ID, text: 'B' }), /title is required/);
  await assert.rejects(() => create.handler({ groupId: GROUP_ID, title: 'T' }), /text is required/);
});

test('create: visibility 非法值抛错（且不发任何请求）', async () => {
  const { create, calls } = await setup({});
  await assert.rejects(
    () => create.handler({ groupId: GROUP_ID, title: 'T', text: 'B', visibility: 'everyone', confirm: true }),
    /visibility must be "group" or "public"/,
  );
  assert.equal(calls.length, 0, '参数非法时不允许发出任何请求');
});

test('create: confirm 不为 true → 返回预览，且一次请求都不发', async () => {
  const { create, calls } = await setup({});
  const r = await create.handler({ groupId: GROUP_ID, title: 'T', text: 'B' });
  assert.equal(r.confirmRequired, true);
  assert.equal(r.posted, undefined);
  assert.match(r.message, /ADDS a post/);
  assert.equal(calls.length, 0, 'confirm 缺失时不允许发出任何请求');
});

test('create: 有 confirm 但无 group-announcement-manage → permitted:false 且不发写请求', async () => {
  const { create, calls } = await setup({ permissions: ['group-members-viewall', 'group-instance-join'] });
  const r = await create.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true });
  assert.equal(r.permitted, false);
  assert.equal(r.posted, false);
  assert.equal(writes(calls).length, 0, '权限不足时不允许发 POST');
  assert.deepEqual(calls.map((c) => c.path), [`/groups/${GROUP_ID}`]);
});

test('create: 权限 OK + confirm → POST 到 /posts（不是 /announcement），body 为对象、默认值正确', async () => {
  const { create, calls } = await setup({
    writeResult: { id: POST_ID, title: 'T', text: 'B', visibility: 'group', authorId: 'usr_1', createdAt: 'c', updatedAt: 'u' },
  });
  const r = await create.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true });
  assert.equal(r.posted, true);
  assert.equal(r.post.id, POST_ID);
  assert.equal(r.post.authorName, '测试作者');

  const post = calls.find((c) => c.opts && c.opts.method === 'POST');
  assert.ok(post, '应当发出 POST');
  // 核心断言：必须打追加式的 /posts，而不是 legacy 单槽 /announcement（后者顶掉旧帖 = 本次事故根因）
  assert.equal(post.path, POSTS_ENDPOINT);
  assert.equal(post.path.includes('/announcement'), false, 'create_group_post 绝不能打 /announcement');
  assert.equal(calls.some((c) => c.path.includes('/announcement')), false, '整条链路都不应碰 /announcement');
  // body 必须是**对象**：api.vrchat.fetch → _requestRaw 内部已 JSON.stringify，
  // 这里再串化一次 = 双重编码（服务端收到字符串字面量）—— 公告侧实测踩过。
  assert.equal(typeof post.opts.body, 'object', 'body 必须是对象，不能是已序列化的字符串');
  assert.equal(Array.isArray(post.opts.body), false, 'body 不应是数组');
  const body = post.opts.body;
  assert.equal(body.title, 'T');
  assert.equal(body.text, 'B');
  // 默认口径：visibility='group'（不外泄给非成员）、sendNotification=false（不打扰全员）
  assert.equal(body.visibility, 'group', 'visibility 缺省必须是 group');
  assert.equal(body.sendNotification, false);
  assert.equal('imageId' in body, false, '未提供 imageId 时不应带该字段');
  assert.equal('roleIds' in body, false, '未提供 roleIds 时不应带该字段');
});

test('create: visibility / sendNotification / imageId / roleIds 透传', async () => {
  const { create, calls } = await setup({ writeResult: { id: POST_ID } });
  await create.handler({
    groupId: GROUP_ID, title: 'T', text: 'B',
    visibility: 'public', sendNotification: true,
    imageId: 'file_abc', roleIds: ['grol_1', 'grol_2'], confirm: true,
  });
  const body = calls.find((c) => c.opts && c.opts.method === 'POST').opts.body;
  assert.equal(body.visibility, 'public');
  assert.equal(body.sendNotification, true);
  assert.equal(body.imageId, 'file_abc');
  assert.deepEqual(body.roleIds, ['grol_1', 'grol_2']);
});

test('create: 服务端 400 时把服务端原因带进错误文案', async () => {
  const { create } = await setup({ writeError: httpErr(400, 'Text is too long') });
  await assert.rejects(
    () => create.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true }),
    /Text is too long/,
  );
});

test('create: 非 400（500）原样抛出，不被改写', async () => {
  const err = httpErr(500, 'Internal Server Error');
  const { create } = await setup({ writeError: err });
  await assert.rejects(
    () => create.handler({ groupId: GROUP_ID, title: 'T', text: 'B', confirm: true }),
    (e) => e === err,
  );
});

// ─────────────────────────── update ───────────────────────────

test('update: 缺 groupId / postId / 无改动字段 / visibility 非法时抛错', async () => {
  const { update, calls } = await setup({});
  await assert.rejects(() => update.handler({ postId: POST_ID, text: 'N' }), /groupId is required/);
  await assert.rejects(() => update.handler({ groupId: GROUP_ID, text: 'N' }), /postId is required/);
  await assert.rejects(() => update.handler({ groupId: GROUP_ID, postId: POST_ID }), /at least one of/);
  await assert.rejects(
    () => update.handler({ groupId: GROUP_ID, postId: POST_ID, visibility: 'everyone', confirm: true }),
    /visibility must be "group" or "public"/,
  );
  assert.equal(calls.length, 0, '参数非法时不允许发出任何请求');
});

test('update: confirm 不为 true → 返回预览，且一次请求都不发', async () => {
  const { update, calls } = await setup({});
  const r = await update.handler({ groupId: GROUP_ID, postId: POST_ID, text: 'N' });
  assert.equal(r.confirmRequired, true);
  assert.equal(r.updated, undefined);
  assert.equal(calls.length, 0, 'confirm 缺失时不允许发出任何请求');
});

test('update: 有 confirm 但无权限 → permitted:false 且不发写请求', async () => {
  const { update, calls } = await setup({ permissions: [] });
  const r = await update.handler({ groupId: GROUP_ID, postId: POST_ID, text: 'N', confirm: true });
  assert.equal(r.permitted, false);
  assert.equal(r.updated, false);
  assert.equal(writes(calls).length, 0, '权限不足时不允许发 PUT');
});

test('update: PUT 到 /posts/{postId}，body 只带给出的字段且是对象', async () => {
  const { update, calls } = await setup({ writeResult: { id: POST_ID, text: 'N', visibility: 'public' } });
  const r = await update.handler({ groupId: GROUP_ID, postId: POST_ID, text: 'N', visibility: 'public', confirm: true });
  assert.equal(r.updated, true);
  assert.equal(r.post.id, POST_ID);
  const put = calls.find((c) => c.opts && c.opts.method === 'PUT');
  assert.ok(put, '应当发出 PUT');
  assert.equal(put.path, `${POSTS_ENDPOINT}/${POST_ID}`);
  assert.equal(typeof put.opts.body, 'object', 'body 必须是对象');
  assert.deepEqual(put.opts.body, { text: 'N', visibility: 'public' });
});

test('update: 非 400 错误原样抛出', async () => {
  const err = httpErr(404, 'Not found');
  const { update } = await setup({ writeError: err });
  await assert.rejects(
    () => update.handler({ groupId: GROUP_ID, postId: POST_ID, text: 'N', confirm: true }),
    (e) => e === err,
  );
});

// ─────────────────────────── delete ───────────────────────────

test('delete: 缺 groupId / postId 时抛错', async () => {
  const { del } = await setup({});
  await assert.rejects(() => del.handler({ postId: POST_ID }), /groupId is required/);
  await assert.rejects(() => del.handler({ groupId: GROUP_ID }), /postId is required/);
});

test('delete: confirm 不为 true → 返回预览（一句话说明不可恢复），且一次请求都不发', async () => {
  const { del, calls } = await setup({});
  const r = await del.handler({ groupId: GROUP_ID, postId: POST_ID });
  assert.equal(r.confirmRequired, true);
  assert.equal(r.deleted, undefined);
  assert.match(r.message, /NOT recoverable/);
  assert.doesNotMatch(r.message, /audit log/, '预览文案已简化，不再夹带审计日志那串绕口表述');
  assert.equal(calls.length, 0, 'confirm 缺失时不允许发出任何请求');
});

test('delete: 有 confirm 但无权限 → permitted:false 且不发 DELETE', async () => {
  const { del, calls } = await setup({ permissions: ['group-members-viewall'] });
  const r = await del.handler({ groupId: GROUP_ID, postId: POST_ID, confirm: true });
  assert.equal(r.permitted, false);
  assert.equal(r.deleted, false);
  assert.equal(writes(calls).length, 0, '权限不足时不允许发 DELETE');
  assert.deepEqual(calls.map((c) => c.path), [`/groups/${GROUP_ID}`]);
});

test('delete: 权限 OK + confirm → DELETE 到 /posts/{postId} 且不带 body', async () => {
  const { del, calls } = await setup({});
  const r = await del.handler({ groupId: GROUP_ID, postId: POST_ID, confirm: true });
  assert.equal(r.deleted, true);
  const d = calls.find((c) => c.opts && c.opts.method === 'DELETE');
  assert.ok(d, '应当发出 DELETE');
  assert.equal(d.path, `${POSTS_ENDPOINT}/${POST_ID}`);
  assert.equal(d.opts.body, undefined, 'DELETE 不应带 body');
});

// ─────────────────────────── get ───────────────────────────

const SAMPLE_POSTS = {
  posts: [
    {
      id: 'not_a', title: 'v0.8.0', text: '旧公告正文', visibility: 'group',
      authorId: 'usr_1', createdAt: '2026-10-03T10:00:00.000Z', updatedAt: '2026-10-03T10:00:00.000Z',
      imageUrl: null, roleIds: [],
    },
    {
      id: 'not_b', title: 'v0.8.1', text: '新公告正文', visibility: 'public',
      authorId: 'usr_1', createdAt: '2026-10-04T10:00:00.000Z', updatedAt: '2026-10-04T10:00:00.000Z',
      imageUrl: 'file_x', roleIds: ['grol_1'],
    },
  ],
  total: 2,
};

test('get: 返回结构完整（total/count + 每条帖子的字段）', async () => {
  const { get } = await setup({ postsResult: SAMPLE_POSTS });
  const r = await get.handler({ groupId: GROUP_ID });
  assert.equal(r.groupId, GROUP_ID);
  assert.equal(r.total, 2);
  assert.equal(r.count, 2);
  assert.equal(r.posts[0].id, 'not_a');
  assert.equal(r.posts[0].title, 'v0.8.0');
  assert.equal(r.posts[0].text, '旧公告正文');
  assert.equal(r.posts[0].visibility, 'group');
  assert.equal(r.posts[0].createdAt, '2026-10-03T10:00:00.000Z');
  assert.equal(r.posts[1].imageUrl, 'file_x');
  assert.deepEqual(r.posts[1].roleIds, ['grol_1']);
  assert.equal(r.posts[0].authorName, '测试作者');
});

test('get: 缺 groupId 抛错', async () => {
  const { get } = await setup({});
  await assert.rejects(() => get.handler({}), /groupId is required/);
});

test('get: 403 / 404 返回空态不抛错（与 get_group_announcement 同口径）', async () => {
  for (const status of [403, 404]) {
    const { get } = await setup({ postsResult: SAMPLE_POSTS, getError: httpErr(status, 'Nope') });
    const r = await get.handler({ groupId: GROUP_ID });
    assert.deepEqual(r, { groupId: GROUP_ID, total: 0, count: 0, posts: [] });
  }
});

test('get: 其它状态码（500）原样抛', async () => {
  const err = httpErr(500, 'Boom');
  const { get } = await setup({ postsResult: SAMPLE_POSTS, getError: err });
  await assert.rejects(() => get.handler({ groupId: GROUP_ID }), (e) => e === err);
});

test('get: n / offset / publicOnly 只在有值时进 query', async () => {
  const { get, calls } = await setup({ postsResult: SAMPLE_POSTS });
  // 只看打向 /posts 的 GET（作者名回查走 /users/，不是本用例关心的请求）
  const lastPostsGet = () => [...calls].reverse()
    .find((c) => c.path.startsWith(POSTS_ENDPOINT) && (!c.opts || !c.opts.method)).path;

  await get.handler({ groupId: GROUP_ID });
  assert.equal(calls[0].path, POSTS_ENDPOINT, '三个参数都省略时不应带 query');

  await get.handler({ groupId: GROUP_ID, n: 5, offset: 10, publicOnly: true });
  assert.equal(lastPostsGet(), `${POSTS_ENDPOINT}?n=5&offset=10&publicOnly=true`);

  await get.handler({ groupId: GROUP_ID, n: 20 });
  assert.equal(lastPostsGet(), `${POSTS_ENDPOINT}?n=20`);

  await get.handler({ groupId: GROUP_ID, offset: 0 });
  assert.equal(lastPostsGet(), `${POSTS_ENDPOINT}?offset=0`, 'offset=0 是有效值，应保留');

  await get.handler({ groupId: GROUP_ID, publicOnly: false });
  assert.equal(lastPostsGet(), `${POSTS_ENDPOINT}?publicOnly=false`);

  await get.handler({ groupId: GROUP_ID, n: undefined, offset: null, publicOnly: undefined });
  assert.equal(lastPostsGet(), POSTS_ENDPOINT, 'undefined / null 视为未提供');
});

test('get: 作者名按去重后的 authorId 查（每页不重复烧配额）', async () => {
  const { get, calls } = await setup({ postsResult: SAMPLE_POSTS });
  await get.handler({ groupId: GROUP_ID });
  const userCalls = calls.filter((c) => c.path.startsWith('/users/'));
  assert.equal(userCalls.length, 1, '两条帖子同一作者，只应查一次');
});

// ───────────────────── 工具定义 ─────────────────────

test('工具定义：delete/update_group_post 带 destructive:true，create/get 不为 true', async () => {
  const { get, create, update, del } = await setup({});
  assert.equal(del.destructive, true, 'delete_ 前缀工具不声明 destructive 会被 loader 拒绝加载');
  assert.equal(update.destructive, true, 'update 是 PUT 原地覆盖正文（无版本、不可恢复），与 set_group_announcement 同口径属破坏性');
  assert.notEqual(create.destructive, true, 'create_group_post 是追加式、可由 delete_group_post 撤销，不该被安全模式误拦');
  assert.notEqual(get.destructive, true);

  assert.deepEqual(create.inputSchema.required, ['groupId', 'title', 'text']);
  assert.deepEqual(update.inputSchema.required, ['groupId', 'postId']);
  assert.deepEqual(del.inputSchema.required, ['groupId', 'postId']);
  assert.deepEqual(get.inputSchema.required, ['groupId']);
  for (const t of [get, create, update, del]) {
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.startsWith('[group]'), `description 应带 [group] 前缀: ${t.name}`);
    assert.equal(typeof t.handler, 'function');
  }
});

test('四个新工具已登记进 core/tool-order.json', () => {
  const order = JSON.parse(readFileSync(path.join(REPO, 'core', 'tool-order.json'), 'utf-8')).tool_order;
  for (const name of ['get_group_posts', 'create_group_post', 'update_group_post', 'delete_group_post']) {
    assert.ok(order.includes(name), `${name} 未登记进 core/tool-order.json`);
  }
});

test('set_group_announcement 描述里指向追加式 posts 接口（行为不变）', async () => {
  const { tools } = await setup({});
  const set = tools.get('set_group_announcement');
  assert.ok(set);
  assert.match(set.description, /Legacy single-slot endpoint/);
  assert.match(set.description, /use create_group_post/);
  assert.equal(set.destructive, true, 'legacy 单槽仍是破坏性工具');
});

// ───────────────────── 限流保护 / 安全模式口径 ─────────────────────

test('get: 作者补名上限 10 个（超出 authorName=null 且留一行 INFO）', async () => {
  const postsResult = {
    total: 12,
    posts: Array.from({ length: 12 }, (_, i) => ({ id: `not_${i}`, title: `t${i}`, authorId: `usr_${i}` })),
  };
  const { get, calls, logs } = await setup({ postsResult });
  const r = await get.handler({ groupId: GROUP_ID });
  const userCalls = calls.filter((c) => c.path.startsWith('/users/'));
  assert.equal(userCalls.length, 10, '补名请求不应超过上限 10（全局限流器共享额度保护）');
  assert.equal(r.count, 12, '截断只影响补名，不影响帖子本身');
  assert.equal(r.posts[0].authorName, '测试作者');
  assert.equal(r.posts[11].authorName, null, '超出上限的作者名应为 null');
  assert.equal(logs.length, 1, '截断必须留一行日志（本仓禁静默截断）');
  assert.match(logs[0], /作者补名截断 10\/12/);
});

test('get: 作者数不超上限时不截断、不记日志', async () => {
  const postsResult = { total: 2, posts: [{ id: 'not_a', authorId: 'usr_a' }, { id: 'not_b', authorId: 'usr_b' }] };
  const { get, logs } = await setup({ postsResult });
  const r = await get.handler({ groupId: GROUP_ID });
  assert.equal(r.posts[1].authorName, '测试作者');
  assert.equal(logs.length, 0);
});

test('create: roleIds 空数组不进 body（非空数组照常透传）', async () => {
  const empty = await setup({});
  await empty.create.handler({ groupId: GROUP_ID, title: 'T', text: 'B', roleIds: [], confirm: true });
  const b1 = empty.calls.find((c) => c.opts && c.opts.method === 'POST').opts.body;
  assert.equal(Object.prototype.hasOwnProperty.call(b1, 'roleIds'), false, '空数组语义=不定向，不应写进 body');

  const filled = await setup({});
  await filled.create.handler({ groupId: GROUP_ID, title: 'T', text: 'B', roleIds: ['grol_x'], confirm: true });
  const b2 = filled.calls.find((c) => c.opts && c.opts.method === 'POST').opts.body;
  assert.deepEqual(b2.roleIds, ['grol_x']);
});

test('安全模式：filterTools 剔除 update/delete_group_post，保留 create/get', async () => {
  const { get, create, update, del } = await setup({});
  const { filterTools } = await import(pathToFileURL(path.join(REPO, 'core', 'safe-mode.js')).href);
  const prev = process.env.VRC_MONITOR_SAFE_MODE;
  process.env.VRC_MONITOR_SAFE_MODE = 'true';
  try {
    const visible = filterTools([get, create, update, del]).map((t) => t.name).sort();
    assert.deepEqual(visible, ['create_group_post', 'get_group_posts']);
  } finally {
    if (prev === undefined) delete process.env.VRC_MONITOR_SAFE_MODE;
    else process.env.VRC_MONITOR_SAFE_MODE = prev;
  }
});
