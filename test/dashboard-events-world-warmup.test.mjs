/**
 * test/dashboard-events-world-warmup.test.mjs —— 动态流「缺地图名」预热护栏
 *
 * 2026-10-17 用户报「有些获取不到地图名」（截图里自己的位置行只剩「好友＋ · JP · 12345」）：
 * 事件列 e.world_name 是**写入那一刻**的快照，而自己的位置事件写入时那个世界往往还没进
 * world_cache（只有「好友列表」「最近游玩」两条路会预热）⇒ 这些行永远没有名字 ✗。
 *
 * 修法＝dashboard.events 的出口对**本次窗口里缺名字**的世界按同一「限流 + 失败冷却」回填一次；
 * 回填后历史行也能显示（DTO 是 COALESCE(world_cache.name, e.world_name)）。
 *
 * 自证（变异会红）：把 dashboard-services.js 里那段「世界名预热」删掉 ⇒
 *   ① calls 为空（断言 1 红）；② 第二次请求里该行 worldName 仍是空（断言 2 红）。
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

const tmpDb = path.join(__dirname, 'test-events-world-warmup.sqlite3');
for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} }

const services = new Map();
const serviceOwners = new Map();
const loader = { services, serviceOwners };
ctx.storage = new Storage();
await ctx.storage.init(tmpDb);
ctx.serverState = { started: null, authUser: null, needsOtp: false, needsTotp: false };
ctx.rateLimiter = { execute: async (fn) => fn() };
ctx.api = null; ctx.friendState = null; ctx.wsManager = null; ctx.pluginLoader = null; ctx.eventPipeline = null;
registerDashboardServices(loader, ctx);
after(() => { for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { rmSync(f, { force: true }); } catch {} } });

const MISSING = 'wrld_missing-0000-0000-0000-000000000001';
const CACHED = 'wrld_cached-0000-0000-0000-000000000002';
const NAMELESS_NO_WORLD = '';

// world_cache 里只预置 CACHED 一个世界（模拟「好友列表那条路早就预热过」）
ctx.storage.upsertWorld({ worldId: CACHED, name: '已有世界' });

// 用可控的假 dashboard.world 覆盖真实实现：不发网络请求，只记录被请求过哪些世界
const calls = [];
services.set('dashboard.world', async ({ worldId }) => {
  calls.push(worldId);
  const name = worldId === MISSING ? '预热世界' : '';
  if (name) ctx.storage.upsertWorld({ worldId, name });
  return { worldId, name };
});

const t0 = Date.now();
const ins = (worldId, loc, dt) => ctx.storage.insertEvent({
  type: 'user-location', userId: 'usr_me', displayName: '我',
  contentJson: { location: loc }, worldId, worldName: '',   // ← 写入时没名字（生产实测就是这样）
  createdAt: new Date(t0 + dt).toISOString(), source: 'ws',
});
ins(MISSING, MISSING + ':12345~hidden(usr_me)', 0);
ins(CACHED, CACHED + ':22222~hidden(usr_me)', 1000);
ins(NAMELESS_NO_WORLD, 'traveling:traveling', 2000);

const waitFor = async (pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return pred();
};

test('缺名世界会被后台预热一次；已有缓存/无世界 id 的行不重复请求', async () => {
  await services.get('dashboard.events')({ limit: 10 });
  assert.ok(await waitFor(() => calls.includes(MISSING)), '缺名的世界应被回源一次（变异：删掉预热块 ⇒ 这里红）');
  assert.deepEqual(calls, [MISSING], '只请求真正缺名的世界：有缓存的不请求、traveling 行（无 world id）不请求');
});

test('预热落缓存后，同一历史行下一次请求即可显示世界名（COALESCE 口径）', async () => {
  await waitFor(() => (ctx.storage.getWorldName(MISSING) || {}).name === '预热世界');
  const out = await services.get('dashboard.events')({ limit: 10 });
  const row = out.events.find((e) => e.worldId === MISSING);
  assert.ok(row, '缺名行本身要照常返回（预热是旁路，不能吞行）');
  assert.equal(row.worldName, '预热世界', '历史行的世界名应从 world_cache 取到（变异：删掉预热块 ⇒ 这里仍是空串）');
  const cachedRow = out.events.find((e) => e.worldId === CACHED);
  assert.equal(cachedRow.worldName, '已有世界');
});
