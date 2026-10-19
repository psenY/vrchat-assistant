/**
 * presence-status.test.mjs — presence-status 插件回归（按自我在场「捕获 + 恢复」自定义状态文字）
 *
 * 覆盖：纯函数（动作判定 / 轮询间隔钳制 / 文案校验 / 冷却）+ register() 行为
 *      （工具注册、默认关闭不动作、转换点动作、捕获逻辑、恢复逻辑、unknown 不翻转、
 *        写前核对、参数校验、跨重启持久化）。
 * 自包含：手写最小 fake api（db / vrchat.fetch / consume 全为可断言的替身），
 * 不触网、不写生产库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import register, {
  decideAction,
  clampPollSeconds,
  isValidTemplate,
  isWithinCooldown,
} from '../plugins/official/presence-status/index.js';

const SELF = 'usr_me_test';

function makeDb(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const handle = {
    all: () => [...rows.entries()].map(([cfg_key, cfg_val]) => ({ cfg_key, cfg_val })),
    // 真仓库用命名参数（$k/$v）；fake 只断言"键与值被写入"
    run: (_sql, params = {}) => { rows.set(params.$k, params.$v); },
  };
  return { table: () => handle, __rows: rows };
}

function makeApi({ presence = { state: 'not_in_game', location: 'offline:offline' }, user = { id: SELF, status: 'join me', statusDescription: '' }, serviceAvailable = true, initial = {} } = {}) {
  const tools = new Map();
  const fetchCalls = [];
  const logs = [];
  const api = {
    db: makeDb(initial),
    registerTool: (def) => tools.set(def.name, def),
    log: (m) => logs.push(String(m)),
    hasService: () => serviceAvailable,
    consume: async () => presence,
    vrchat: {
      fetch: async (path, opts) => {
        fetchCalls.push({ path, opts });
        if (path === '/auth/user') return { ...user };
        return { ok: true };
      },
    },
  };
  return { api, tools, fetchCalls, logs };
}

const puts = (fetchCalls) => fetchCalls.filter(c => c.opts && c.opts.method === 'PUT');

// ── 纯函数：动作判定 ───────────────────────────────────────────────────────
test('decideAction：unknown 不翻转', () => {
  assert.deepEqual(decideAction('unknown', 'in_game', { idleTemplate: 'B', savedText: 'X' }), { action: 'skip', reason: 'state-unknown' });
  assert.deepEqual(decideAction('unknown', '', { idleTemplate: 'B', savedText: '' }), { action: 'skip', reason: 'state-unknown' });
});

test('decideAction：无转换不动作（进/出游戏各只在转换点触发一次）', () => {
  assert.deepEqual(decideAction('in_game', 'in_game', { idleTemplate: 'B', savedText: 'X' }), { action: 'skip', reason: 'no-transition' });
  assert.deepEqual(decideAction('not_in_game', 'not_in_game', { idleTemplate: 'B', savedText: 'X' }), { action: 'skip', reason: 'no-transition' });
});

test('decideAction：离开游戏 → 写入挂机文案', () => {
  assert.deepEqual(decideAction('not_in_game', 'in_game', { idleTemplate: 'Bot挂机', savedText: '' }), { action: 'idle', text: 'Bot挂机' });
  assert.deepEqual(decideAction('not_in_game', '', { idleTemplate: 'Bot挂机', savedText: '' }), { action: 'idle', text: 'Bot挂机' });
});

test('decideAction：回到游戏 → 恢复捕获文字；无捕获值/捕获值是挂机文案时清空', () => {
  assert.deepEqual(decideAction('in_game', 'not_in_game', { idleTemplate: 'Bot挂机', savedText: '看番中' }), { action: 'restore', text: '看番中' });
  // 没有捕获值 → 清空（绝不把挂机文案留在游戏内状态上）
  assert.deepEqual(decideAction('in_game', 'not_in_game', { idleTemplate: 'Bot挂机', savedText: '' }), { action: 'restore', text: '' });
  assert.deepEqual(decideAction('in_game', '', { idleTemplate: 'Bot挂机', savedText: 'Bot挂机' }), { action: 'restore', text: '' });
});

// ── 纯函数：其它 ─────────────────────────────────────────────────────────
test('clampPollSeconds：默认兜底 + 上下限钳制', () => {
  assert.equal(clampPollSeconds(undefined), 60);
  assert.equal(clampPollSeconds('abc'), 60);
  assert.equal(clampPollSeconds(0), 60);
  assert.equal(clampPollSeconds(5), 20);
  assert.equal(clampPollSeconds(99999), 3600);
  assert.equal(clampPollSeconds(120), 120);
});

test('isValidTemplate：非空字符串且 ≤64 字符', () => {
  assert.equal(isValidTemplate('Bot挂机'), true);
  assert.equal(isValidTemplate(''), false);
  assert.equal(isValidTemplate('   '), false);
  assert.equal(isValidTemplate(123), false);
  assert.equal(isValidTemplate('x'.repeat(64)), true);
  assert.equal(isValidTemplate('x'.repeat(65)), false);
});

test('isWithinCooldown：manual 直通，未写过不算冷却，间隔内算冷却', () => {
  const now = 1_000_000;
  assert.equal(isWithinCooldown({ lastApplyAt: now - 1000, now }), true);
  assert.equal(isWithinCooldown({ lastApplyAt: now - 1000, now, manual: true }), false);
  assert.equal(isWithinCooldown({ lastApplyAt: 0, now }), false);
  assert.equal(isWithinCooldown({ lastApplyAt: now - 70_000, now }), false);
});

// ── register 行为 ─────────────────────────────────────────────────────────
test('register：注册两个工具并返回 dispose', () => {
  const { api, tools } = makeApi();
  const dispose = register(api);
  assert.deepEqual([...tools.keys()].sort(), ['get_presence_status', 'set_presence_status']);
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('默认关闭：不触发任何 VRChat 调用', async () => {
  const { api, tools, fetchCalls } = makeApi();
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({});
  assert.equal(res.config.enabled, false);
  assert.equal(res.syncResult.reason, 'disabled');
  assert.equal(fetchCalls.length, 0);
  dispose();
});

test('首次运行且不在游戏内 → 写入挂机文案（并捕获当前文案作为 savedText）', async () => {
  const { api, tools, fetchCalls } = makeApi({ user: { id: SELF, status: 'ask me', statusDescription: '看番中' } });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ enabled: true, idleTemplate: 'Bot挂机' });
  assert.equal(res.syncResult.action, 'applied');
  assert.equal(puts(fetchCalls)[0].opts.body.statusDescription, 'Bot挂机');
  // 捕获：当前文案（看番中）被存为 savedText
  assert.equal(res.savedText, '看番中');
  // 只改 statusDescription，status 种类原样保留
  assert.equal(puts(fetchCalls)[0].opts.body.status, 'ask me');
  dispose();
});

test('捕获保护：当前文案已是挂机文案时不写入 savedText（避免把挂机文案当成"上次状态"）', async () => {
  const { api, tools } = makeApi({ user: { id: SELF, status: 'active', statusDescription: '' } });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ enabled: true, idleTemplate: 'Bot挂机' });
  assert.equal(res.savedText, '');
  dispose();
});

test('捕获保护：当前文案等于我们自己上次写入的文案时不捕获（跨重启也生效）', async () => {
  // lastText 是"我们上次写的"，当前文案仍是它 → 不能当成使用者的状态
  const { api, tools } = makeApi({
    user: { id: SELF, status: 'active', statusDescription: '挂机中（服务在线）' },
    initial: { enabled: 'true', idleTemplate: 'Bot挂机', lastText: '挂机中（服务在线）', lastState: 'in_game' },
  });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ syncNow: true });
  assert.equal(res.syncResult.action, 'applied');
  assert.equal(res.savedText, '');
  dispose();
});

test('回到游戏内 → 恢复 savedText（不是固定文案）', async () => {
  const { api, tools, fetchCalls } = makeApi({
    presence: { state: 'in_game', location: 'wrld_abc:1' },
    user: { id: SELF, status: 'join me', statusDescription: 'Bot挂机' },
    initial: { enabled: 'true', savedText: '看番中', lastState: 'not_in_game' },
  });
  const dispose = register(api);
  const res = await tools.get('get_presence_status').handler(); // 只读一次，确认配置已载入
  assert.equal(res.savedText, '看番中');
  const sync = await tools.get('set_presence_status').handler({ syncNow: true });
  assert.equal(sync.syncResult.action, 'restored');
  assert.equal(puts(fetchCalls)[0].opts.body.statusDescription, '看番中');
  dispose();
});

test('回到游戏内但没有捕获值：当前是挂机文案 → 清空；已为空 → 不重复提交', async () => {
  const { api, tools, fetchCalls } = makeApi({
    presence: { state: 'in_game', location: 'wrld_abc:1' },
    user: { id: SELF, status: 'ask me', statusDescription: 'Bot挂机' },
    initial: { enabled: 'true', savedText: '', idleTemplate: 'Bot挂机', lastState: 'not_in_game' },
  });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ syncNow: true });
  assert.equal(res.syncResult.action, 'restored');
  assert.equal(puts(fetchCalls)[0].opts.body.statusDescription, '');
  assert.equal(puts(fetchCalls)[0].opts.body.status, 'ask me');
  dispose();

  // 已为空 → 目标文案与现状一致，不重复 PUT
  const second = makeApi({
    presence: { state: 'in_game', location: 'wrld_abc:1' },
    user: { id: SELF, status: 'ask me', statusDescription: '' },
    initial: { enabled: 'true', savedText: '', lastState: 'not_in_game' },
  });
  const d2 = register(second.api);
  const r2 = await second.tools.get('set_presence_status').handler({ syncNow: true });
  assert.equal(r2.syncResult.reason, 'already-set');
  assert.equal(puts(second.fetchCalls).length, 0);
  d2();
});

test('unknown（无法判定）→ 不动现状，不发 PUT', async () => {
  const { api, tools, fetchCalls } = makeApi({ presence: { state: 'unknown' } });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ enabled: true });
  assert.equal(res.syncResult.reason, 'state-unknown');
  assert.equal(puts(fetchCalls).length, 0);
  dispose();
});

// ── 首轮启用误删使用者文案（REQUEST_CHANGES 阻断项回归）────────────────────
test('回到游戏内但无捕获值、现状是使用者自己的文案 → 不清空，采纳为基线', async () => {
  const { api, tools, fetchCalls } = makeApi({
    presence: { state: 'in_game', location: 'wrld_abc:1~hidden(usr_me_test)~region(jp)' },
    user: { id: SELF, status: 'join me', statusDescription: '我在游戏里的原有状态文字' },
    initial: { enabled: 'true', idleTemplate: 'Bot挂机', savedText: '', lastState: 'not_in_game' },
  });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ syncNow: true });
  assert.equal(res.syncResult.action, 'skipped');
  assert.equal(res.syncResult.reason, 'keep-current-text');
  assert.equal(puts(fetchCalls).length, 0);                     // 绝不 PUT 空串
  assert.equal(res.savedText, '我在游戏里的原有状态文字');         // 采纳为基线，供后续恢复
  dispose();
});

test('基线采纳后闭环：出游戏写挂机文案 → 回游戏恢复使用者原文案', async () => {
  // 第一段：首轮启用，人已在游戏内，现状是使用者文案 → 不清空，采纳为基线
  const first = makeApi({
    presence: { state: 'in_game', location: 'wrld_abc:1' },
    user: { id: SELF, status: 'join me', statusDescription: '看番中' },
    initial: { enabled: 'true', idleTemplate: 'Bot挂机', savedText: '', lastState: 'not_in_game' },
  });
  const d1 = register(first.api);
  const r1 = await first.tools.get('set_presence_status').handler({ syncNow: true });
  assert.equal(r1.syncResult.reason, 'keep-current-text');
  assert.equal(r1.savedText, '看番中');
  assert.equal(puts(first.fetchCalls).length, 0);
  const persisted1 = Object.fromEntries(first.api.db.__rows);
  d1();

  // 第二段：人离开游戏 → 写挂机文案，savedText 仍是使用者的文案
  const second = makeApi({
    presence: { state: 'not_in_game', location: 'offline:offline' },
    user: { id: SELF, status: 'join me', statusDescription: '看番中' },
    initial: persisted1,
  });
  const d2 = register(second.api);
  const r2 = await second.tools.get('set_presence_status').handler({ syncNow: true });
  assert.equal(r2.syncResult.action, 'applied');
  assert.equal(puts(second.fetchCalls)[0].opts.body.statusDescription, 'Bot挂机');
  assert.equal(r2.savedText, '看番中');
  const persisted2 = Object.fromEntries(second.api.db.__rows);
  d2();

  // 第三段：回到游戏 → 恢复使用者的原文案（不因为首轮「无捕获值」而丢失）
  const third = makeApi({
    presence: { state: 'in_game', location: 'wrld_abc:1' },
    user: { id: SELF, status: 'join me', statusDescription: 'Bot挂机' },
    initial: persisted2,
  });
  const d3 = register(third.api);
  const r3 = await third.tools.get('set_presence_status').handler({ syncNow: true });
  assert.equal(r3.syncResult.action, 'restored');
  assert.equal(puts(third.fetchCalls)[0].opts.body.statusDescription, '看番中');
  d3();
});

test('写前核对：目标文案已在位 → 只记基线，不重复 PUT', async () => {
  const { api, tools, fetchCalls } = makeApi({ user: { id: SELF, status: 'active', statusDescription: 'Bot挂机' } });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ enabled: true, idleTemplate: 'Bot挂机' });
  assert.equal(res.syncResult.reason, 'already-set');
  assert.equal(puts(fetchCalls).length, 0);
  dispose();
});

test('缺少核心 selfPresence 服务 → 明确跳过（不静默、不误改）', async () => {
  const { api, tools, fetchCalls } = makeApi({ serviceAvailable: false });
  const dispose = register(api);
  const res = await tools.get('set_presence_status').handler({ enabled: true });
  assert.equal(res.syncResult.reason, 'no-self-presence-service');
  assert.equal(fetchCalls.length, 0);
  dispose();
});

test('参数校验：类型/长度/数字非法时拒绝且不写入', async () => {
  const { api, tools } = makeApi();
  const dispose = register(api);
  const set = tools.get('set_presence_status');
  assert.equal((await set.handler({ enabled: 'yes' })).ok, false);
  assert.equal((await set.handler({ idleTemplate: '' })).ok, false);
  assert.equal((await set.handler({ idleTemplate: 'x'.repeat(65) })).ok, false);
  assert.equal((await set.handler({ pollSeconds: 'abc' })).ok, false);
  assert.equal((await set.handler({ savedText: 123 })).ok, false);
  assert.equal((await set.handler({ savedText: 'x'.repeat(65) })).ok, false);
  const cfg = (await tools.get('get_presence_status').handler()).config;
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.pollSeconds, 60);
  dispose();
});

test('get_presence_status：返回配置、在场判定、已捕获文字与最近应用信息', async () => {
  const { api, tools } = makeApi({ presence: { state: 'not_in_game', location: 'offline:offline' } });
  const dispose = register(api);
  const res = await tools.get('get_presence_status').handler();
  assert.equal(res.serviceAvailable, true);
  assert.equal(res.config.idleTemplate.length > 0, true);
  assert.equal(res.presence.state, 'not_in_game');
  assert.equal(typeof res.savedText, 'string');
  assert.equal(typeof res.minApplyIntervalMs, 'number');
  dispose();
});

test('跨重启持久化：enabled / lastState / savedText / lastText 从插件表恢复', async () => {
  const { api, tools } = makeApi({ user: { id: SELF, status: 'active', statusDescription: '看番中' } });
  const d1 = register(api);
  await tools.get('set_presence_status').handler({ enabled: true, idleTemplate: 'Bot挂机' });
  d1();
  const tools2 = new Map();
  const api2 = { ...api, registerTool: (def) => tools2.set(def.name, def) };
  const d2 = register(api2);
  const res = await tools2.get('get_presence_status').handler();
  assert.equal(res.config.enabled, true);
  assert.equal(res.savedText, '看番中');
  assert.equal(res.lastState, 'not_in_game');
  assert.equal(res.lastText, 'Bot挂机');
  d2();
});
