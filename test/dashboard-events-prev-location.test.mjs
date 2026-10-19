/**
 * test/dashboard-events-prev-location.test.mjs —— 位置行左端「从哪来」只取**紧邻的上一个位置**
 *
 * 使用者 2026-10-17 定：
 *   ① 左端只显示紧邻的上一个位置，**不得为了凑名字回退到更早的世界**；
 *   ② 上一刻是离线 ⇒ 这一行**没有**「从哪」；
 *   ③ 上一刻是仅邀请/私人房间 ⇒ 显示「私人房间」（前端文案，见 utils.prevLocationLabel 的纯函数用例）。
 *
 * 旧行为是 `continue` 跳过 offline 行继续往前找 ⇒ 上一次下线前所在的世界被当成「从哪」，
 * 界面上就等于「上次下线的世界 → 现在」，与「刚从一个房间过来」是两回事（②就是这条）。
 * traveling 行仍然跳过（它本身没有地点，跳过它不改变「紧邻」的含义）—— 用例 2 钉住这一点，
 * 防止有人为了修 ② 顺手把 traveling 的跳过也删掉（那会让「换房」这条路整段丢失）。
 *
 * 变异自证（实测，勿想当然）：
 *   - 把 offline 那行改回 `continue`            ⇒ 用例 1、3 红，用例 2 绿 ✓
 *   - 删掉 traveling 那行的显式跳过               ⇒ **三条全绿**（实测）——
 *     因为紧随其后还有「名字与 worldId 都取不到就 continue」的兜底判据，traveling 行本来也会被它跳过。
 *     所以用例 2 钉的是**结果**（换房前所在的世界仍是「从哪」），不是「必须有那行 skip」；
 *     两处判据互为冗余，删任何一处都不会让行为变坏（若将来有人把兜底也改了，用例 2 会红）。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { ctx } = await import(pathToFileURL(path.join(REPO, 'core', 'server-context.js')).href);
const { Storage } = await import(pathToFileURL(path.join(REPO, 'core', 'storage.js')).href);
const { registerDashboardServices } = await import(pathToFileURL(path.join(REPO, 'core', 'dashboard-services.js')).href);

const tmpDb = path.join(__dirname, 'test-events-prev-location.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const services = new Map();
const loader = { services, serviceOwners: new Map() };
ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.api = null; ctx.friendState = null; ctx.wsManager = null; ctx.pluginLoader = null; ctx.eventPipeline = null;
registerDashboardServices(loader, ctx);
after(() => { for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} } });

// 世界名预热是异步的、且会去问 dashboard.world —— 本文件只关心 prev 判定，回源一律返回空名字。
services.set('dashboard.world', async ({ worldId }) => ({ worldId, name: '' }));

const A = 'wrld_aaaa0000-0000-0000-0000-00000000aaaa';
const B = 'wrld_bbbb0000-0000-0000-0000-00000000bbbb';
const C = 'wrld_cccc0000-0000-0000-0000-00000000cccc';
ctx.storage.upsertWorld({ worldId: A, name: '世界A' });
ctx.storage.upsertWorld({ worldId: C, name: '世界C' });

const t0 = Date.now();
const insLoc = (userId, loc, dt) => ctx.storage.insertEvent({
  type: 'user-location', userId, displayName: '我',
  contentJson: { location: loc },
  worldId: loc.startsWith('wrld_') ? loc.split(':')[0] : '',
  worldName: '',
  createdAt: new Date(t0 + dt).toISOString(), source: 'ws',
});

// 用例 1：A（公开）→ traveling → offline → B，B 行不得把 A 当成「从哪」
const U1 = 'usr_prev_offline';
insLoc(U1, A + ':11111~region(jp)', 0);
insLoc(U1, 'traveling:traveling', 1000);
insLoc(U1, 'offline', 2000);
insLoc(U1, B + ':22222~region(jp)', 3000);

// 用例 2（对照）：A → traveling → C，C 行仍应拿到 A（traveling 只是没有地点，跳过它不算「回退」）
const U2 = 'usr_prev_traveling';
insLoc(U2, A + ':11111~region(jp)', 0);
insLoc(U2, 'traveling:traveling', 1000);
insLoc(U2, C + ':33333~region(jp)', 2000);

// 用例 3：网页在线形态 offline:offline 与 offline 同语义
const U3 = 'usr_prev_webonline';
insLoc(U3, A + ':11111~region(jp)', 0);
insLoc(U3, 'offline:offline', 1000);
insLoc(U3, B + ':22222~region(jp)', 2000);

const fetchRow = async (userId, worldId) => {
  const out = await services.get('dashboard.events')({ limit: 50 });
  return out.events.find((e) => e.userId === userId && e.worldId === worldId);
};

test('上一刻是离线 ⇒ 该行没有「从哪」（不得回退到更早的世界）', async () => {
  const row = await fetchRow(U1, B);
  assert.ok(row, 'B 行本身要照常返回');
  assert.equal(row.previousLocation, '', '上一刻离线 ⇒ 没有上一个位置');
  assert.equal(row.previousWorldId, '', '不得把上一次下线前所在的世界当「从哪」');
  assert.equal(row.previousWorldName, '', '同名判据：世界名也不得回退填出');
});

test('traveling 行仍然跳过（它是「换房途中」，跳过不改变「紧邻」的含义）', async () => {
  const row = await fetchRow(U2, C);
  assert.ok(row, 'C 行要照常返回');
  assert.equal(row.previousWorldId, A, '换房前所在的世界仍是「从哪」');
  assert.equal(row.previousWorldName, '世界A', '缓存优先，名字照常取到');
  assert.match(row.previousLocation, /^wrld_/, 'previousLocation 是那条世界位置而不是 traveling');
});

test('offline:offline（网页在线）与 offline 同语义 ⇒ 也没有「从哪」', async () => {
  const row = await fetchRow(U3, B);
  assert.ok(row, 'B 行要照常返回');
  assert.equal(row.previousLocation, '', 'offline:offline 同样不产生「从哪」');
  assert.equal(row.previousWorldId, '');
});

// 2026-10-18 复审 nixi ⚠️1 / 💡2：**纯值特殊位置**（private / local / friends / group）也是「紧邻的上一个位置」，
// 只是没有世界信息 —— 旧实现把它和「取不到名字的畸形行」一起 continue 掉，于是回退到更早的世界名，
// 与「左端只认紧邻的上一个位置」直接冲突；生产里私人房正是主导形态（报障原文「左端同理」指的就是它）。
const U4 = 'usr_prev_private';
const U5 = 'usr_prev_local';
insLoc(U4, A + ':11111~region(jp)', 6000);
insLoc(U4, 'private', 7000);
insLoc(U4, B + ':22222~region(jp)', 8000);
insLoc(U5, A + ':11111~region(jp)', 6000);
insLoc(U5, 'local', 7000);
insLoc(U5, B + ':22222~region(jp)', 8000);

test('上一刻是纯值 private ⇒ 「从哪」就是 private（不得回退到更早的世界）', async () => {
  const row = await fetchRow(U4, B);
  assert.ok(row, 'B 行要照常返回');
  assert.equal(row.previousLocation, 'private', '私人房本身才是「紧邻的上一个位置」');
  assert.equal(row.previousWorldName, '');
  assert.equal(row.previousWorldId, '', '纯值没有 worldId，前端因此渲染「私人房间」');
});

test('上一刻是纯值 local ⇒ 同理得「本地房间」（同一判据，不是给 private 打的补丁）', async () => {
  const row = await fetchRow(U5, B);
  assert.ok(row, 'B 行要照常返回');
  assert.equal(row.previousLocation, 'local');
});

// 2026-10-18 复审 nixi 💡2：未知纯值形态的取舍要有用例钉住，否则将来改判据或 prevLocationLabel 会无声漂移。
// 契约：判据是「任何取不到世界信息的非 traveling/offline 位置」⇒ previousLocation 原样透传；
// 前端 prevLocationLabel 对它返回空 ⇒ 左端整块隐藏（与「宁可空也不编造更早的世界名」一致）。
const U6 = 'usr_prev_unknown';
insLoc(U6, A + ':11111~region(jp)', 6000);
insLoc(U6, 'mystery:weird', 7000);
insLoc(U6, B + ':22222~region(jp)', 8000);

test('未知纯值形态（mystery:weird）⇒ 原样透传、不回退；前端无标签则左端整块隐藏', async () => {
  const row = await fetchRow(U6, B);
  assert.ok(row, 'B 行要照常返回');
  assert.equal(row.previousLocation, 'mystery:weird', '未知形态同样算「紧邻的上一个位置」，不能回退到更早的世界');
  assert.equal(row.previousWorldName, '');
  assert.equal(row.previousWorldId, '');
});
