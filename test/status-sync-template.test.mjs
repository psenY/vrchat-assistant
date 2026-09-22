/**
 * status-sync-template.test.mjs — 动态状态模板占位符（2026-09-22 用户要求拆分在线数）
 *
 * 覆盖：{online}（沿用 ONLINE_INCLUDE_WEB 口径）/ {total}|{总在线} / {webOnline}|{web在线} / {gameOnline}|{非web在线}
 * 与 64 码点截断（emoji 不被切半）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStatusSync } from '../core/status-sync.js';

function makeSync() {
  const ctx = { storage: { getConfig: () => null, setConfig: () => {}, query: () => [] }, friendState: { getOnlineCount: () => 3 }, api: {} };
  return new DynamicStatusSync(ctx, () => {});
}

test('三计数占位符各自替换（含中文别名）', () => {
  const s = makeSync();
  const counts = { total: 7, web: 2, game: 5 };
  assert.equal(s.render('总{online}人', 3, counts), '总3人', '{online} 沿用开关口径');
  assert.equal(s.render('总{total}/Web{webOnline}/游戏{gameOnline}', 3, counts), '总7/Web2/游戏5');
  assert.equal(s.render('{总在线}|{web在线}|{非web在线}', 3, counts), '7|2|5');
  assert.equal(s.render('{Web在线}-{非Web在线}', 3, counts), '2-5');
});

test('没有 counts 时回退：total=online、web=0、game=total', () => {
  const s = makeSync();
  assert.equal(s.render('{total}/{webOnline}/{gameOnline}', 4), '4/0/4');
});

test('截断按码点（emoji 不切半）', () => {
  const s = makeSync();
  const out = s.render('🎉'.repeat(40), 1, { total: 1, web: 0, game: 1 });
  assert.ok(Array.from(out).length <= 64);
  assert.ok(!out.includes('\uFFFD'));
});
