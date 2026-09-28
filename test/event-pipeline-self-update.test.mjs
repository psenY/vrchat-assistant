/**
 * test/event-pipeline-self-update.test.mjs —— 【自己的】资料/模型变更也必须出事件
 *
 * 用户 2026-09-28 报障：「自己换模型也没提示」。根因：`process()` 的 switch 里**没有 `user-update` 分支**
 * ⇒ 自己的资料变更只被原样存库、从不做 diff ⇒ 永远不产出「模型变动」事件（DB 实证：自己的 avatar 事件停在 08-30）。
 * 修法：`user-update` 走同一条 `_handleUpdate` 逻辑；**基线不在 friends 表**（自己不是好友）⇒ 取上一条
 * `user-update` 事件的 `user` 快照当 prev；事件类型写 `user-update`（不是 friend-update）；不回写 friends 表。
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

const MODEL_A = 'https://api.vrchat.cloud/api/1/image/file_aaaaaaaa-0000-0000-0000-000000000001/1/256';
const MODEL_B = 'https://api.vrchat.cloud/api/1/image/file_bbbbbbbb-0000-0000-0000-000000000002/1/256';
const ICON_A = 'https://api.vrchat.cloud/api/1/image/file_cccccccc-0000-0000-0000-000000000003/1/256';

const tmpDb = path.join(__dirname, 'test-self-update.sqlite3');
const logRoot = path.join(__dirname, 'self-update-rundir');
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

const UID = 'usr_self-0000-0000-0000-000000000001';
const selfEvent = (icon, bannerType, at) => ({
  type: 'user-update',
  userId: UID,
  displayName: 'psenY7',
  receivedAt: at,
  content: { userId: UID, user: { id: UID, displayName: 'psenY7', iconUrl: icon, bannerType } },
});
const countOf = (sub) => storage.query(
  "SELECT COUNT(*) n FROM events WHERE user_id = $u AND type = 'user-update' AND json_extract(content_json,'$.type') = $t",
  { $u: UID, $t: sub })[0].n;

test('首次 user-update 只建基线、不产事件（无前值不记变更）', async () => {
  await pipeline.process(selfEvent(MODEL_A, 'avatarBanner', '2026-09-28T18:00:00.000Z'));
  assert.equal(countOf('avatar'), 0, '首次没有基线 ⇒ 不产事件');
});

test('🔴 自己换模型 ⇒ 产出 user-update/avatar 事件（修复前恒为 0）', async () => {
  await pipeline.process(selfEvent(MODEL_B, 'avatarBanner', '2026-09-28T18:10:00.000Z'));
  assert.equal(countOf('avatar'), 1, '自己的模型变动必须被记录');
  const n = storage.query('SELECT COUNT(*) n FROM friends WHERE user_id = $u', { $u: UID })[0].n;
  assert.equal(n, 0, '自己不得被写进 friends 表');
});

test('自己的事件类型必须是 user-update（不是 friend-update）', async () => {
  const n = storage.query("SELECT COUNT(*) n FROM events WHERE user_id = $u AND type = 'friend-update' AND json_extract(content_json,'$.type') = 'avatar'", { $u: UID })[0].n;
  assert.equal(n, 0, '不得把自己的变更写成 friend-update');
});

test('自己只换用户图标（非模型图文件 + 非 avatarBanner 档）⇒ 产 user_icon 事件', async () => {
  await pipeline.process(selfEvent(ICON_A, 'color', '2026-09-28T18:20:00.000Z'));
  assert.equal(countOf('user_icon'), 1, '只换图标时要记 user_icon');
});
