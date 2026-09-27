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
