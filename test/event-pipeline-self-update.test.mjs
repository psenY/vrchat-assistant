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
const MODEL_C = 'https://api.vrchat.cloud/api/1/image/file_dddddddd-0000-0000-0000-000000000004/1/256';
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

// ── 换模型时 VRChat 推的是【同实例 user-location + 新 iconUrl】（2026-09-28 生产实测 id 18819/18820）──
const locEvent = (icon, loc, at) => ({
  type: 'user-location',
  userId: UID,
  displayName: 'psenY7',
  location: loc,
  receivedAt: at,
  content: { userId: UID, location: loc, instance: {}, travelingToLocation: '', user: { id: UID, displayName: 'psenY7', iconUrl: icon, bannerType: 'avatarBanner' } },
});
// 去重窗口按【墙钟】判定 ⇒ 用例时间戳必须相对当前时间（写死过去时间会在几天后失效 ✗ 2026-10-01 实测）
const at = (i) => new Date(Date.now() - (30 - i) * 1000).toISOString();
const LOC_SAME = 'wrld_f2de4d2d-324b-485f-a8bf-ec93bed3382a:58446~private(usr_self)~region(jp)';
const LOC_OTHER = 'wrld_f2de4d2d-324b-485f-a8bf-ec93bed3382a:99999~private(usr_self)~region(jp)';
const locRows = (loc) => storage.query(
  "SELECT COUNT(*) n FROM events WHERE user_id = $u AND type = 'user-location' AND json_extract(content_json,'$.location') = $l",
  { $u: UID, $l: loc })[0].n;

test('🔴 换模型（同实例 user-location + 新 iconUrl）⇒ 记「模型变动」且不产重复位置行（用户 2026-09-28 报障「换模型被显示为换地图」）', async () => {
  // 2026-10-18 复审 ⚠️2 之后：内存基线只覆盖「载荷确实带了的字段」⇒ 前一条非 avatarBanner 推送**不再清空**模型图基线
  // （这是修 bug 的必然结果）。所以这里不能再假设「第一条 location 之前基线是空的」——改成以**第一条之后**为基准，
  // 断言真正要保的不变量：同实例重复推送时，模型图变化**恰好记一条**、且不落第二条位置行。
  await pipeline.process(locEvent(MODEL_A, LOC_SAME, at(0)));
  const before = countOf('avatar');
  await pipeline.process(locEvent(MODEL_B, LOC_SAME, at(1)));
  assert.equal(countOf('avatar') - before, 1, '同实例重发 + iconUrl 变 ⇒ 必须记 1 条模型变动');
  assert.equal(locRows(LOC_SAME), 1, '同实例重复不得落第二条位置行（否则动态流显示成「换地图」）');
});

test('同实例、iconUrl 也没变 ⇒ 不落新位置行（纯重发）', async () => {
  await pipeline.process(locEvent(MODEL_B, LOC_SAME, at(2)));
  assert.equal(locRows(LOC_SAME), 1, '仍是同一条');
});

test('换到别的实例 ⇒ 照常落位置行（去重不能把真位置变化吃掉）', async () => {
  await pipeline.process(locEvent(MODEL_B, LOC_OTHER, at(3)));
  assert.equal(locRows(LOC_OTHER), 1);
});


// ── 2026-10-16 审查 🔴1/⚠️1/⚠️3：self 的同实例去重必须与好友侧**同一套语义** ──
// 桩：直接插一条历史位置行（可指定 created_at），用于构造窗口内/外与 offline 回场
const seedLoc = (loc, atIso, icon) => storage.run(
  "INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source) VALUES ('user-location', $u, 'psenY7', $c, '', '', $t, 'test')",
  { $u: UID, $c: JSON.stringify({ location: loc, user: { id: UID, displayName: 'psenY7', iconUrl: icon, bannerType: 'avatarBanner' } }), $t: atIso });
const clearLocRows = () => storage.run("DELETE FROM events WHERE user_id = $u AND type = 'user-location'", { $u: UID });

test('窗口外的同实例重复仍落一条心跳（🔴1：窗口不能退化成「同一个 UTC 日」）', async () => {
  clearLocRows();
  seedLoc(LOC_SAME, new Date(Date.now() - 3 * 3600 * 1000).toISOString(), MODEL_A);   // 3 小时前 ⇒ 300s 窗口外
  assert.equal(locRows(LOC_SAME), 1);
  await pipeline.process(locEvent(MODEL_A, LOC_SAME, new Date().toISOString()));
  assert.equal(locRows(LOC_SAME), 2, '窗口外的重复必须落一条心跳（旧实现会吞掉 ✗）');
});

test('先 offline 再回到同一实例 ⇒ 回场那条必须落库（⚠️1：offline/traveling 不参与去重）', async () => {
  clearLocRows();
  seedLoc('offline', new Date(Date.now() - 30 * 1000).toISOString(), MODEL_A);   // 30s 前 ⇒ 窗口内
  await pipeline.process(locEvent(MODEL_A, LOC_SAME, new Date().toISOString()));
  assert.equal(locRows(LOC_SAME), 1, '离线之后回到同实例是真实变化，必须落库');
});

test('窗口配置非法 ⇒ 回落 300s 而不是静默关闭去重（⚠️3）', async () => {
  clearLocRows();
  const prev = process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_WINDOW_SECONDS;
  process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_WINDOW_SECONDS = 'abc';
  try {
    seedLoc(LOC_SAME, new Date(Date.now() - 30 * 1000).toISOString(), MODEL_A);
    await pipeline.process(locEvent(MODEL_A, LOC_SAME, new Date().toISOString()));
    assert.equal(locRows(LOC_SAME), 1, '非法值必须回落 300s（旧内联实现得 NaN ⇒ 去重被静默关闭 ✗）');
  } finally {
    if (prev === undefined) delete process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_WINDOW_SECONDS;
    else process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_WINDOW_SECONDS = prev;
  }
});

test('并发两条同值 self 事件 ⇒ 只出一条模型变动（⚠️2：self 也走 userId 串行链）', async () => {
  storage.run("DELETE FROM events WHERE user_id = $u", { $u: UID });
  await pipeline.process(selfEvent(MODEL_A, 'avatarBanner', new Date(Date.now() - 5000).toISOString()));   // 建基线
  const before = countOf('avatar');
  // 两条事件给**不同时刻**（生产中 VRChat 每条 receivedAt 本就不同毫秒）：
  // ⚠️ 已知边界：若两条恰好同毫秒，基线查询 created_at < ts 看不到兄弟行 ⇒ 可能各出一次（真实链路极罕见）
  const ts1 = new Date().toISOString();
  const ts2 = new Date(Date.now() + 5).toISOString();
  await Promise.all([
    pipeline.process(locEvent(MODEL_B, LOC_SAME, ts1)),
    pipeline.process(locEvent(MODEL_B, LOC_SAME, ts2)),
  ]);
  assert.equal(countOf('avatar') - before, 1, '并发时不得各读旧基线、重复出事件');
});

test('同一次换模型被两类载体各推一次 ⇒ 只记一条（用户 2026-10-17 报「为什么两条」）', async () => {
  const before = countOf('avatar');
  const loc = (icon, at) => ({ type: 'user-location', userId: UID, displayName: 'psenY7', receivedAt: at,
    content: { userId: UID, user: { id: UID, displayName: 'psenY7', iconUrl: icon, bannerType: 'avatarBanner' } } });
  const t0 = Date.now();
  // ⚠️（2026-10-18 复审 EMeowAGENT ⚠️1 纠正）：本条直接给两类载体都传 storeRawEvent:false 只是**构造**旧基线，
  //   生产上真正让「库里基线仍是旧的」的机制是**同实例重复 location 被去重、原始行不落库**
  //   （user-update 的原始行照落）。所以本条不算生产形态的覆盖 —— 生产形态由下面那条 process() 驱动的用例负责。
  await pipeline._handleUpdateInner(loc(MODEL_C, new Date(t0 + 1000).toISOString()), { storeRawEvent: false });
  assert.equal(countOf('avatar') - before, 1, '第一次应记 1 条');
  // 30 秒后另一条载体重发同一份新资料：必须用「刚处理过的那份」当基线，不得再记
  await pipeline._handleUpdateInner(loc(MODEL_C, new Date(t0 + 31000).toISOString()), { storeRawEvent: false });
  assert.equal(countOf('avatar') - before, 1, '同一份新资料不得再记一条（基线要用内存里最新的那份，而不是库里更早的旧快照）');
});

// ── 2026-10-18 复审（EMeowAGENT @ #304）⚠️1 / ⚠️2 的回归 ──────────────────
// 用独立 uid + process()（生产入口）构造，避免与上面的共享基线互相干扰。
const UID2 = 'usr_self-0000-0000-0000-000000000002';
const UID3 = 'usr_self-0000-0000-0000-000000000003';
const LOC2 = 'wrld_99999999-9999-9999-9999-999999999999:77777~private(usr_self)~region(jp)';
const now = (deltaSec) => new Date(Date.now() + deltaSec * 1000).toISOString();
const avatarOf = (uid) => storage.query(
  "SELECT COUNT(*) n FROM events WHERE user_id = $u AND json_extract(content_json,'$.type') = 'avatar'",
  { $u: uid })[0].n;
const locOf = (uid, icon, loc, atIso) => ({
  type: 'user-location', userId: uid, displayName: 'psenY7', location: loc, receivedAt: atIso,
  content: { userId: uid, location: loc, instance: {}, travelingToLocation: '',
    user: icon ? { id: uid, displayName: 'psenY7', iconUrl: icon, bannerType: 'avatarBanner' } : { id: uid, displayName: 'psenY7' } },
});
const updOf = (uid, icon, atIso) => ({
  type: 'user-update', userId: uid, displayName: 'psenY7', receivedAt: atIso,
  content: { userId: uid, user: { id: uid, displayName: 'psenY7', iconUrl: icon, bannerType: 'avatarBanner' } },
});

test('生产形态（process 入口）：同实例 location 被去重后，另一载体重发同一张图仍只记一条', async () => {
  await pipeline.process(locOf(UID2, MODEL_A, LOC2, now(-40)));          // 首次：只建基线
  await pipeline.process(locOf(UID2, MODEL_A, LOC2, now(-35)));          // 同实例重复 ⇒ 原始行被去重
  const rows = storage.query("SELECT COUNT(*) n FROM events WHERE user_id = $u AND type = 'user-location'", { $u: UID2 })[0].n;
  assert.equal(rows, 1, '前置：同实例重复不得落第二条原始行（这正是生产上基线仍旧的原因）');
  await pipeline.process(updOf(UID2, MODEL_A, now(-5)));                 // 另一载体重发同一张图
  assert.equal(avatarOf(UID2), 0, '同一张图被两类载体各推一次，不得记模型变动');
});

test('⚠️2 回归：载荷不带图标信息的 location 不得清空内存基线（否则下一次真实换模型被吞掉）', async () => {
  await pipeline.process(updOf(UID3, MODEL_A, now(-60)));                // 基线 = MODEL_A
  await pipeline.process(locOf(UID3, null, LOC2, now(-50)));             // 带 user 但不带 icon 信息（真实形态）
  await pipeline.process(locOf(UID3, null, LOC2, now(-45)));             // 再来一条，仍然没有图标信息
  await pipeline.process(updOf(UID3, MODEL_B, now(-10)));                // 真实换模型
  assert.equal(avatarOf(UID3), 1, '空基线会把这次真实换模型吞掉（复审实测 0 条）；修好后必须记 1 条');
});
