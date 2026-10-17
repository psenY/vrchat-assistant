// 2026-10-16（审查 💡2）：缺陷「面板『保存并立即同步』拿不到 syncResult」的**回归测试**（service 级）。
// 该缺陷的根因是 await_handle_sync 是 async，而 dashboard.dynamicStatusSet 曾经漏 await ⇒
// Promise 被直接塞进响应 ⇒ JSON 序列化成 {}（面板什么都读不到）。
// 判据设计：漏 await 时 syncResult 会是一个 **thenable**，且 JSON 序列化后变 {} ⇒ 两条断言都会红 ✓
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { registerDashboardServices } = await import(pathToFileURL(path.join(REPO, 'core', 'dashboard-services.js')).href);

function makeLoader() {
  const services = new Map();
  return {
    services: { set: (name, fn) => services.set(name, fn) },
    serviceOwners: { set: () => {} },
    get: (name) => services.get(name),
  };
}

test('dashboard.dynamicStatusSet 必须 await 引擎（漏 await ⇒ syncResult 变 {}）', async () => {
  const loader = makeLoader();
  const syncCalls = [];
  const ctx = {
    storage: { getConfig: () => null, query: () => [] },
    statusSync: {
      setConfig: (p) => ({ enabled: true, mode: 'suffix', template: '在线 {total} 人', separator: ' · ', ...p }),
      sync: async (enabled) => {
        syncCalls.push(enabled);
        return { action: 'updated', statusDescription: '打机中 · 在线 5 人' };
      },
    },
  };
  registerDashboardServices(loader, ctx);
  const fn = loader.get('dashboard.dynamicStatusSet');
  assert.ok(fn, 'dashboard.dynamicStatusSet 必须已注册');
  const out = await fn({ mode: 'suffix', template: '在线 {total} 人', syncNow: true });
  assert.equal(out.ok, true);
  assert.equal(typeof out.syncResult.then, 'undefined', 'syncResult 不得是 Promise（漏 await 就会被 JSON 成 {}）');
  assert.equal(out.syncResult.action, 'updated');
  const wire = JSON.parse(JSON.stringify(out));   // 面板实际拿到的东西（JSON 过网络）
  assert.equal(wire.syncResult.statusDescription, '打机中 · 在线 5 人', '面板必须能读到目标文本');
  assert.deepEqual(syncCalls, [true]);
});

test('syncNow=false ⇒ 不调用引擎、返回 skipped（且不因漏 await 而变 Promise）', async () => {
  const loader = makeLoader();
  let called = 0;
  const ctx = {
    storage: { getConfig: () => null, query: () => [] },
    statusSync: { setConfig: (p) => p, sync: async () => { called++; return {}; } },
  };
  registerDashboardServices(loader, ctx);
  const out = await loader.get('dashboard.dynamicStatusSet')({ enabled: true, syncNow: false });
  assert.equal(out.syncResult.action, 'skipped');
  assert.equal(called, 0);
});

test('非法入参被挡在 setConfig 之前（mode / separator）', async () => {
  const loader = makeLoader();
  let setCalls = 0;
  const ctx = {
    storage: { getConfig: () => null, query: () => [] },
    statusSync: { setConfig: () => { setCalls++; return {}; }, sync: async () => ({}) },
  };
  registerDashboardServices(loader, ctx);
  const fn = loader.get('dashboard.dynamicStatusSet');
  assert.equal((await fn({ mode: 'nope' })).ok, false);
  assert.equal((await fn({ separator: 42 })).ok, false);
  assert.equal(setCalls, 0, '校验不通过时不得改配置');
});