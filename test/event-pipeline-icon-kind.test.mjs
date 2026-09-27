/**
 * test/event-pipeline-icon-kind.test.mjs —— 按【file 的 tags】判定「换模型」还是「只换头像」（2026-09-27）
 *
 * 判据来源：用户用 VRCX-Luo 纠正后定案 ——
 *   yixijun/VRCX-Luo src/coordinators/avatarCoordinator.js:255 getAvatarName()
 *     getFile({fileId}) → tags.includes('icon') ⇒ 用户图标；否则按模型图。
 * 生产实测（正反样本各 4 例）：真图标 好友A/好友B/好友C/好友D ⇒ tags 含 icon；
 *   模型图 某位好友/好友E/好友F/好友G ⇒ tags 为空、名字为 Avatar - … - Image - …。
 * 本测试用**注入的桩解析器**驱动真实 EventPipeline（不打网络）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const { EventPipeline } = await import(pathToFileURL(path.join(REPO, 'core', 'event-pipeline.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { initLogger } = await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);
const { fileKindFromData, isUserIconFile, avatarNameFromFileData } = await import(pathToFileURL(path.join(REPO, 'core', 'img-util.js')).href);

const MODEL_A = 'https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-0000-0000-0000-000000000001/1/256';
const MODEL_B = 'https://api.vrchat.cloud/api/1/image/file_bbbbbbbb-0000-0000-0000-000000000002/1/256';
const ICON_A = 'https://api.vrchat.cloud/api/1/image/file_cccccccc-0000-0000-0000-000000000003/1/256';
const ICON_B = 'https://api.vrchat.cloud/api/1/image/file_dddddddd-0000-0000-0000-000000000004/1/256';

const tmpDb = path.join(__dirname, 'test-icon-kind.sqlite3');
const logRoot = path.join(__dirname, 'icon-kind-rundir');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
rmSync(logRoot, { recursive: true, force: true });

const storage = new Storage();
await storage.init(tmpDb);
const pipeline = new EventPipeline(storage, { get: () => null });
initLogger({ dir: logRoot, format: 'text', level: 'silent' });
after(() => {
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
  rmSync(logRoot, { recursive: true, force: true });
});

const UID = 'usr_iconkind-0000-0000-0000-000000000001';
const clear = () => storage.run('DELETE FROM events WHERE user_id = $u', { $u: UID });
const types = () => ({
  avatar: storage.getFriendProfileChanges(UID, { types: 'avatar' }).length,
  icon: storage.getFriendProfileChanges(UID, { types: 'user_icon' }).length,
});
const push = (user, at) => pipeline.process({
  type: 'friend-update', userId: UID, displayName: '判据测试', receivedAt: at,
  content: { user: { bannerType: 'color', bio: '', status: 'active', ...user } },
});

test('纯函数：tags 含 icon ⇒ 用户图标；tags 为空 + Avatar 命名 ⇒ 模型图', () => {
  assert.equal(isUserIconFile({ tags: ['cameraIcon', 'icon'] }), true);
  assert.equal(fileKindFromData({ tags: ['icon'], name: 'whatever' }), 'icon');
  assert.equal(fileKindFromData({ tags: [], name: 'Avatar - 浅蓝小鲨鱼 - Image - 2022.3.22f1_1_x' }), 'model');
  assert.equal(avatarNameFromFileData({ name: 'Avatar - 浅蓝小鲨鱼 - Image - x' }), '浅蓝小鲨鱼');
  assert.equal(fileKindFromData(null), 'unknown');
  assert.equal(avatarNameFromFileData({ name: 'image.png' }), '');
});

test('tags 说【用户图标】⇒ 记「更新了头像图标」（即使它与模型图基线同文件 —— 反向纠偏）', async () => {
  clear();
  pipeline.setImageKindResolver(async () => ({ kind: 'icon', name: '' }));
  // 基线里存的是模型图；本次 iconUrl 恰好＝该模型图（旧判据会误判为模型图）
  storage.upsertFriend({ userId: UID, displayName: '判据测试', userIcon: ICON_A, avatarImageUrl: MODEL_A, bio: '', status: 'active' });
  await push({ iconUrl: MODEL_A }, '2026-09-27T06:20:00.000Z');
  const n = types();
  assert.equal(n.icon, 1, 'tags 含 icon ⇒ 必须记 user_icon（标签「更新了头像图标」）');
  assert.equal(n.avatar, 0, '不得记成模型变动');
});

test('tags 说【模型图】⇒ 记「模型变动」，不得记「更新了头像图标」', async () => {
  clear();
  pipeline.setImageKindResolver(async () => ({ kind: 'model', name: 'タフィー バニー' }));
  storage.upsertFriend({ userId: UID, displayName: '判据测试', userIcon: ICON_A, avatarImageUrl: '', bio: '', status: 'active' });
  await push({ iconUrl: MODEL_B }, '2026-09-27T06:25:00.000Z');
  const n = types();
  assert.equal(n.icon, 0, '模型图不得记成 user_icon');
  assert.equal(n.avatar, 1, '必须记 1 条 avatar（标签「模型变动」）');
  assert.equal(storage.getFriend(UID).avatar_image_url, MODEL_B, '基线要写回，避免后续重复判定');
});

test('同上再推一次（同文件不同 URL 形态）⇒ 不重复产事件（幂等）', async () => {
  pipeline.setImageKindResolver(async () => ({ kind: 'model', name: 'タフィー バニー' }));
  await push({ iconUrl: MODEL_B.replace('/1/256', '/1/512') }, '2026-09-27T06:26:00.000Z');
  const n = types();
  assert.equal(n.avatar, 1, '同一文件不得重复补 avatar 事件');
  assert.equal(n.icon, 0);
});

test('模型图已由 avatarChanged 报过（bannerType=avatarBanner 同文件）⇒ 只 1 条 avatar，不双记', async () => {
  clear();
  pipeline.setImageKindResolver(async () => ({ kind: 'model', name: 'kaguya' }));
  storage.upsertFriend({ userId: UID, displayName: '判据测试', userIcon: ICON_A, avatarImageUrl: MODEL_A, bio: '', status: 'active' });
  await push({ iconUrl: MODEL_B, currentAvatarImageUrl: MODEL_B, bannerType: 'avatarBanner' }, '2026-09-27T06:30:00.000Z');
  const n = types();
  assert.equal(n.avatar, 1, '同一文件只允许一条 avatar 事件');
  assert.equal(n.icon, 0);
});

test('拿不到 file 元数据（unknown）⇒ 沿用旧判据：非模型图则记 user_icon', async () => {
  clear();
  pipeline.setImageKindResolver(async () => ({ kind: 'unknown', name: '' }));
  storage.upsertFriend({ userId: UID, displayName: '判据测试', userIcon: ICON_A, avatarImageUrl: '', bio: '', status: 'active' });
  await push({ iconUrl: ICON_B }, '2026-09-27T06:35:00.000Z');
  const n = types();
  assert.equal(n.icon, 1, 'unknown 时必须保持旧行为（不能因为查不到就吞事件）');
});

test('未注入解析器 ⇒ 行为与改动前一致（向后兼容）', async () => {
  clear();
  pipeline.setImageKindResolver(null);
  storage.upsertFriend({ userId: UID, displayName: '判据测试', userIcon: ICON_A, avatarImageUrl: '', bio: '', status: 'active' });
  await push({ iconUrl: ICON_B }, '2026-09-27T06:40:00.000Z');
  const n = types();
  assert.equal(n.icon, 1);
  assert.equal(n.avatar, 0);
});


// ── 2026-09-27 审查（nixi-agent）复核后补的回归用例 ──

test('🔴 并发同一推送：按 userId 串行化后只产 1 条「模型变动」（审查实测的回归项）', async () => {
  clear();
  pipeline.setImageKindResolver(async () => { await new Promise((r) => setTimeout(r, 60)); return { kind: 'model', name: '并发模型' }; });
  storage.upsertFriend({ userId: UID, displayName: '判据测试', userIcon: ICON_A, status: 'active' });
  const mk = () => ({
    type: 'friend-update', userId: UID, displayName: '判据测试', receivedAt: new Date().toISOString(),
    content: { user: { bannerType: 'color', bio: '', status: 'active', iconUrl: MODEL_A } },
  });
  await Promise.all([pipeline.process(mk()), pipeline.process(mk())]);
  const t2 = types();
  assert.equal(t2.avatar, 1, '并发两路必须只产 1 条模型变动（旧实现会各推一条）');
  assert.equal(t2.icon, 0);
});

test('⚠️1 首次记录（基线图标为空）：解析器照样被调用，且只补模型基线、不产事件', async () => {
  clear();
  let calls = 0;
  pipeline.setImageKindResolver(async () => { calls++; return { kind: 'model', name: '首次模型' }; });
  storage.upsertFriend({ userId: UID, displayName: '判据测试', userIcon: '', status: 'active' });
  await push({ iconUrl: MODEL_A }, new Date(Date.now() + 1000).toISOString());
  assert.equal(calls, 1, '基线为空时也必须解析（旧门禁下解析器调用 0 次 ⇒ 漏记）');
  const t3 = types();
  assert.equal(t3.avatar, 0, '缺前值不得记变更（不产「(空) → 某模型」噪音行）');
  assert.equal(t3.icon, 0);
  const fr = storage.query('SELECT avatar_image_url AS a FROM friends WHERE user_id = $u', { $u: UID })[0] || {};
  assert.ok(String(fr.a || '').includes('file_aaaaaaaa'), '静默补上模型图基线，下一次变化才判得准');
});

test('💡1 内存缓存到期后重新解析（不被负缓存锁死到进程结束）', async () => {
  const { createImageKindResolver } = await import(pathToFileURL(path.join(REPO, 'core', 'image-kind.js')).href);
  let calls = 0;
  const api = { _request: async () => { calls++; throw new Error('404'); } };
  const resolve = createImageKindResolver({ storage, api, rateLimiter: { execute: async (fn) => fn() }, unknownTtlMs: 30 });
  const id = 'file_eeeeeeee-0000-0000-0000-00000000000e';
  await resolve(id);
  await resolve(id);
  assert.equal(calls, 1, '负缓存有效期内不再请求');
  await new Promise((r) => setTimeout(r, 70));
  await resolve(id);
  assert.equal(calls, 2, '到期后必须重试（旧实现内存缓存不看 until ⇒ 永不过期）');
});

test('💡2 HTTP 200 但判不出种类（unknown）⇒ 走 unknown TTL，不吃 30 天正缓存', async () => {
  const { createImageKindResolver } = await import(pathToFileURL(path.join(REPO, 'core', 'image-kind.js')).href);
  let calls = 0;
  const api = { _request: async () => { calls++; return { status: 200, data: { tags: [], name: 'image.png' } }; } };
  const resolve = createImageKindResolver({ storage, api, rateLimiter: { execute: async (fn) => fn() }, positiveTtlMs: 30 * 24 * 3600e3, unknownTtlMs: 30 });
  const id = 'file_ffffffff-0000-0000-0000-00000000000f';
  const rec = await resolve(id);
  assert.equal(rec.kind, 'unknown');
  assert.ok(rec.until - rec.at <= 2000, 'unknown 必须用短 TTL（实测旧实现会锁 30 天）');
  await new Promise((r) => setTimeout(r, 70));
  await resolve(id);
  assert.equal(calls, 2, '短 TTL 到期后应重试');
});


test('💡（审查 nixi-agent）聚合留痕可在退出前 flush（不再依赖条数/窗口）', async () => {
  const { createImageKindResolver } = await import(pathToFileURL(path.join(REPO, 'core', 'image-kind.js')).href);
  const api = { _request: async () => { throw new Error('404'); } };
  const resolve = createImageKindResolver({ storage, api, rateLimiter: { execute: async (fn) => fn() }, unknownTtlMs: 5000 });
  assert.equal(typeof resolve.flush, 'function', '解析器必须暴露 flush（供 start-monitor 接优雅退出）');
  await resolve('file_12345678-0000-0000-0000-00000000000a');
  resolve.flush();   // 不抛即通过（真实接线在 start-monitor 的 shutdown/beforeExit）
});
