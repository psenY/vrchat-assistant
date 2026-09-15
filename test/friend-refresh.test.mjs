/**
 * test/friend-refresh.test.mjs — 好友列表周期刷新回归（trust_level 自愈 + 变化事件）
 *
 * 背景（2026-09-15 用户报障）：服务纯 WS 驱动、无好友列表拉取 → trust_level 陈旧无自愈
 * （XIAOFANG小芳已升 Trusted User、库内仍停 Known User）。事件驱动修复只在她下一次
 * WS 更新时生效；本模块周期拉取 /auth/user/friends 回写基线 + 记录等级变化事件。
 *
 * 断言：①分页拉全（2 页 150 位）；②等级变化 → 插入 friend-update trust_level 事件 +
 *   回写新等级（基线更新 → 第二次刷新不再重复报）；③未变化不报；④仅非空字段回写
 *   （空值不清空已有）；⑤失败仅记 WARN 不抛。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshFriendList } from '../core/friend-refresh.js';

function makeUsers(n, trust = 'Known User') {
  return Array.from({ length: n }, (_, i) => ({
    id: `usr_${i}`, displayName: `好友${i}`, trust_level: trust,
    status: 'active', statusDescription: '', currentAvatarImageUrl: '', bio: '', userIcon: '', pronouns: '',
  }));
}

function makeCtx({ pages, getFriend }) {
  const events = [];
  const upserts = [];
  let call = 0;
  const storage = {
    getFriend: (id) => (getFriend ? getFriend(id) : null),
    upsertFriend(f) { upserts.push(f); },
    insertEvent(e) { events.push(e); },
  };
  const api = { _request: async (m, url) => {
    const pageIdx = call++;
    const data = pages[pageIdx] || [];
    return { status: 200, data };
  } };
  const rateLimiter = { execute: async (fn) => fn() };
  const logs = [];
  return { ctx: { api, rateLimiter, storage }, events, upserts, logs: (m) => logs.push(m), logsArr: logs };
}

test('分页拉全 + 等级变化记录事件与回写基线', async () => {
  const { ctx, events, upserts } = makeCtx({
    pages: [makeUsers(100), makeUsers(50, 'Trusted User')],
    getFriend: (id) => {
      const n = Number(id.split('_')[1]);
      // 前 100 位基线 Known User；后 50 位基线 Trusted User（第 2 页无变化）
      return { user_id: id, display_name: `好友${n}`, trust_level: n < 100 ? 'Known User' : 'Trusted User' };
    },
  });
  await refreshFriendList(ctx, () => {});
  const tl = events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'trust_level');
  assert.equal(tl.length, 50, '第 2 页 50 位应从 Known User → Trusted User 各记一条');
  assert.equal(tl[0].contentJson.previousTrustLevel, 'Known User');
  assert.equal(tl[0].contentJson.trustLevel, 'Trusted User');
  assert.equal(upserts.length, 150, '应回写全部 150 位');
  assert.ok(upserts.every((u) => u.trustLevel === 'Known User' || u.trustLevel === 'Trusted User'));
});

test('第二次刷新（基线已更新）不再重复报等级变化', async () => {
  const state = new Map();
  const { ctx, events } = makeCtx({
    pages: [makeUsers(10, 'Trusted User')],
    getFriend: (id) => (state.get(id) || { user_id: id, display_name: id, trust_level: 'Known User' }),
  });
  await refreshFriendList(ctx, () => {});            // 第一次：10 条变化
  for (const u of makeUsers(10, 'Trusted User')) state.set(u.id, { user_id: u.id, display_name: u.displayName, trust_level: 'Trusted User' });
  await refreshFriendList(ctx, () => {});            // 第二次：基线已新，0 条
  const tl = events.filter((e) => e.type === 'friend-update' && e.contentJson && e.contentJson.type === 'trust_level');
  assert.equal(tl.length, 10, '仅第一次产生 10 条');
});

test('空字段不回写（不清空已有值）', async () => {
  const { ctx, upserts } = makeCtx({
    pages: [[{ id: 'usr_a', displayName: 'A', trust_level: 'Trusted User', status: '', statusDescription: '', currentAvatarImageUrl: '', bio: '', userIcon: '', pronouns: '' }]],
    getFriend: () => null,
  });
  await refreshFriendList(ctx, () => {});
  const u = upserts[0];
  assert.equal(u.trustLevel, 'Trusted User');
  assert.equal('status' in u, false, '空 status 不应写入');
  assert.equal('bio' in u, false, '空 bio 不应写入');
});

test('API 失败：记警告、不抛', async () => {
  const { ctx, logsArr } = makeCtx({ pages: [] });
  ctx.api._request = async () => ({ status: 500, data: null });
  await refreshFriendList(ctx, (m) => logsArr.push(m));
  assert.ok(logsArr.some((l) => l.includes('[警告]') && l.includes('HTTP 500')));
});
