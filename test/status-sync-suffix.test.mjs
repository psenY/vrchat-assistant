import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStatusSync, composeStatus, stripSuffix } from '../core/status-sync.js';

const TEMPLATE = '在线 {total} 人';
const SEP = ' · ';

function makeCtx({ desc = "", online = 5, cfg = null } = {}) {
  const state = { desc, cfg, puts: [] };
  const ctx = {
    storage: {
      getConfig: () => state.cfg,
      setConfig: (_k, v) => { state.cfg = v; },
      query: () => [{ total: online, web: 0, game: online }],
    },
    friendState: { getOnlineCount: () => online },
    api: {
      _request: async (m, _p, body) => {
        if (m === "GET") return { status: 200, data: { id: "usr_self", status: "active", statusDescription: state.desc } };
        if (m === "PUT") { state.puts.push(body.statusDescription); state.desc = body.statusDescription; return { status: 200, data: {} }; }
        return { status: 404, data: {} };
      },
    },
  };
  return { ctx, state };
}
const cfgOf = (o = {}) => JSON.stringify({ enabled: true, mode: 'suffix', template: TEMPLATE, separator: SEP, ...o });

test('纯函数：后缀可识别且幂等（连写不会累加）', () => {
  assert.equal(stripSuffix('打机中 · 在线 5 人', TEMPLATE), '打机中');
  assert.equal(stripSuffix('打机中 · 在线 5 人 · 在线 9 人', TEMPLATE), '打机中');
  assert.equal(stripSuffix('在线 7 人', TEMPLATE), '');
  assert.equal(stripSuffix('打机中', TEMPLATE), '打机中');
  const once = stripSuffix('A · 在线 3 人', TEMPLATE);
  assert.equal(stripSuffix(once + SEP + '在线 3 人', TEMPLATE), once);
});

test('纯函数：不吃使用者正文里凑巧同形的句子（无分隔符不剥）', () => {
  assert.equal(stripSuffix('今天在线 5 人一起玩', TEMPLATE), '今天在线 5 人一起玩');
  assert.equal(stripSuffix('我今天在线 5 人', TEMPLATE), '我今天在线 5 人');
});

test('纯函数：合成时优先保证后缀完整（长正文被截断）', () => {
  const long = '这是一段很长的自定义状态文字'.repeat(5);
  const out = composeStatus(long, '在线 12 人', { separator: SEP });
  assert.ok(out.endsWith(SEP + '在线 12 人'));
  assert.ok(Array.from(out).length <= 64);
  assert.equal(composeStatus('', '在线 3 人', { separator: SEP }), '在线 3 人');
});

test('suffix 模式：保留手输正文，只在结尾加后缀', async () => {
  const { ctx, state } = makeCtx({ desc: '打机中', cfg: cfgOf() });
  const s = new DynamicStatusSync(ctx, { now: () => 1_000_000 });
  const r = await s.sync();
  assert.equal(r.action, 'synced');
  assert.equal(state.puts.length, 1);
  assert.equal(state.puts[0], '打机中 · 在线 5 人');
});

test('防循环：写回引起的回声不会再 PUT（连调 5 次只有 1 次写）', async () => {
  let now = 1_000_000;
  const { ctx, state } = makeCtx({ desc: '打机中', cfg: cfgOf() });
  const s = new DynamicStatusSync(ctx, { now: () => now });
  await s.sync();
  for (let i = 0; i < 5; i++) { now += 70_000; await s.sync(); }
  assert.equal(state.puts.length, 1, '写回后内容一致 ⇒ 应走 unchanged 早退');
  assert.equal(state.desc, '打机中 · 在线 5 人');
});

test('防累加：历史被追加多次也能自愈回单后缀', async () => {
  let now = 1_000_000;
  const { ctx, state } = makeCtx({ desc: '打机中 · 在线 5 人 · 在线 5 人', cfg: cfgOf() });
  const s = new DynamicStatusSync(ctx, { now: () => now });
  await s.sync();
  assert.equal(state.desc, '打机中 · 在线 5 人');
  now += 70_000;
  await s.sync();
  assert.equal(state.puts.length, 1, '收敛后不应再写');
});

test('静默期：使用者刚手改过 ⇒ 先不写，过了静默期再补后缀', async () => {
  let now = 1_000_000;
  const { ctx, state } = makeCtx({ desc: 'A', cfg: cfgOf() });
  const s = new DynamicStatusSync(ctx, { now: () => now });
  await s.sync();                       // 写入 'A · 在线 5 人'
  state.desc = 'B';                     // 使用者手改
  now += 70_000;
  assert.equal((await s.sync()).reason, 'grace');
  assert.equal(state.puts.length, 1);
  now += 130_000;                       // 越过 GRACE_MS(120s)
  assert.equal((await s.sync()).action, 'synced');
  assert.equal(state.desc, 'B · 在线 5 人');
});

test('抢写自保：同一段文字被反复改写 ⇒ 退避且不再写', async () => {
  let now = 1_000_000;
  const { ctx, state } = makeCtx({ desc: 'A', cfg: cfgOf() });
  const s = new DynamicStatusSync(ctx, { now: () => now });
  await s.sync();
  const reasons = [];
  for (const t of ['B', 'C', 'D']) {
    state.desc = t;
    now += 200_000;
    reasons.push((await s.sync()).reason);
  }
  assert.ok(reasons.includes('writer-conflict'), '第 3 次应触发退避: ' + reasons.join(','));
  now += 200_000;
  assert.equal((await s.sync()).reason, 'writer-conflict-backoff');
});

test('fixed 模式：行为与历史一致（整段覆盖，不保留正文）', async () => {
  const now = 1_000_000;
  const { ctx, state } = makeCtx({ desc: '打机中', cfg: cfgOf({ mode: 'fixed' }) });
  const s = new DynamicStatusSync(ctx, { now: () => now });
  await s.sync();
  assert.equal(state.desc, '在线 5 人');
  assert.equal(state.puts.length, 1);
});

test('composeForOther：其它写入方（presence-status）与本引擎产出一致', () => {
  const { ctx } = makeCtx({ cfg: cfgOf() });
  const s = new DynamicStatusSync(ctx, { now: () => 0 });
  assert.equal(s.composeForOther('挂机中'), '挂机中 · 在线 5 人');
  const { ctx: c2 } = makeCtx({ cfg: cfgOf({ mode: 'fixed' }) });
  assert.equal(new DynamicStatusSync(c2, { now: () => 0 }).composeForOther('挂机中'), '挂机中');
  const { ctx: c3 } = makeCtx({ cfg: null });
  assert.equal(new DynamicStatusSync(c3, { now: () => 0 }).composeForOther('挂机中'), '挂机中');
});

test('默认关闭时 sync 不动手', async () => {
  const { ctx, state } = makeCtx({ desc: '打机中', cfg: null });
  const s = new DynamicStatusSync(ctx, { now: () => 0 });
  assert.equal((await s.sync()).reason, 'disabled');
  assert.equal(state.puts.length, 0);
});
