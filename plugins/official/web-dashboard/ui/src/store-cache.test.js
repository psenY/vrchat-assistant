
/**
 * store-cache.test.js —— 首屏缓存 hydrate / 回写 的永久回归用例
 *
 * 为什么立它（2026-10-16 审查 EMeowAGENT 点「新增持久化层零单测」）：此前只有「跑完即删」的临时探针，
 * 仓库里没有任何用例锁住这些行为；其中 ④⑤ 正是二审 🔴 的两个复现场景
 * （失败轮次把旧数据盖新戳 / token 失效的清空被同轮回写撤销）。
 *
 * 形态照审查方探针：**驱动真实 store.js**（不 mock 被测模块），只桩外围 IO（localStorage 由 happy-dom 提供 + fetch 桩）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 2026-10-16 审查 nixi-agent（#291 的红色阻断）：不要引用未声明的 happy-dom —— 它只是 vitest 的可选 peer，
//   CI 的 npm ci 不装它，带那条环境指令的文件在干净检出上会加载失败、用例一条都不跑（本 PR 正文的 53/53 就是失真读数）。
//   改为自带最小桩，在 import 被测模块之前装好；验证＝把 node_modules/happy-dom 临时移走后再跑本文件（模拟 CI）。
const mkStorage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
};
globalThis.localStorage = mkStorage();
globalThis.sessionStorage = mkStorage();
globalThis.location = { search: '', hash: '', pathname: '/', href: 'http://localhost/' };
// ⚠️ window 必须是**真 EventTarget**：store.js 的「401 ⇒ 清缓存」靠事件（addEventListener + dispatchEvent）驱动，
//   用空实现会把这条链路静默掐断（首版就是这样，用例 ⑤ 随即变红）。
const win = new EventTarget();
Object.assign(win, {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  innerWidth: 1280, innerHeight: 800,
  localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, location: globalThis.location,
});
globalThis.window = win;
globalThis.addEventListener = win.addEventListener.bind(win);
globalThis.dispatchEvent = win.dispatchEvent.bind(win);
globalThis.document = {
  title: '', body: { appendChild: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, select: () => {}, focus: () => {} }),
  querySelector: () => null, addEventListener: () => {}, execCommand: () => true,
};

const KEY = 'vrc.dash.cache';
let mode = 'ok';
const seed = (o) => localStorage.setItem(KEY, JSON.stringify(o));
const read = () => { const v = localStorage.getItem(KEY); return v ? JSON.parse(v) : null; };

const loadStore = async () => { vi.resetModules(); return await import('./store.js'); };

beforeEach(() => {
  localStorage.clear();
  mode = 'ok';
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    const mk = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (!u.includes('/api/dashboard')) return mk({});
    if (mode === 'bootstrap401') {
      // 2026-10-16（审查 💡1）：**判别形态** —— bootstrap 401 + 其余 500。
      // 原先用「全部 401」时尾部请求的 401 会把缓存再清一遍（回写点之后）⇒ 变异下仍 PASS、咬不住。
      if (u.includes('bootstrap')) { try { window.dispatchEvent(new Event('vrc-auth-401')); } catch {} return mk({}, 401); }
      return mk({}, 500);
    }
    if (mode === 'auth401') {
      // 真实 api.js 在 401 时会派发 vrc-auth-401 ⇒ 这里照实派发（store.js 的监听器据此清缓存）
      try { window.dispatchEvent(new Event('vrc-auth-401')); } catch { /* 事件构造失败则忽略 */ }
      return mk({}, 401);
    }
    if (mode === 'fail500') return mk({}, 500);
    if (u.includes('overview')) return mk({ auth: { authenticated: true }, ws: { status: 'connected' } });
    if (u.includes('bootstrap')) return mk({ events: [], total: 0 });
    if (u.includes('friends')) return mk({ friends: [{ userId: 'u1', displayName: 'A', isOnline: true }] });
    return mk({});
  });
});

describe('首屏缓存（dashboard）', () => {
  it('① 新鲜缓存 ⇒ hydrate 好友/概览/区间，且 clearDashCache 能清空', async () => {
    seed({ friends: [{ userId: 'u1' }], feedEvents: [], feedTotal: 3, overview: { a: 1 }, eventsRange: { min: '2026-10-01' }, at: Date.now() });
    const m = await loadStore();
    expect(m.store.friends.length).toBe(1);
    expect(m.store.overview).toBeTruthy();
    expect(m.store.eventsRange.min).toBe('2026-10-01');
    m.clearDashCache();
    expect(read()).toBeNull();
  });

  it('② 过期缓存仍可用（stale-while-revalidate）', async () => {
    seed({ friends: [{ userId: 'u1' }], at: Date.now() - 10 * 60_000 });
    const m = await loadStore();
    expect(m.store.friends.length, '过期也要先渲染，否则等于没优化').toBe(1);
  });

  it('③ 坏缓存不抛错、不污染 store', async () => {
    localStorage.setItem(KEY, '{ not json ');
    let m = await loadStore();
    expect(m.store.friends.length).toBe(0);
    seed({ feedEvents: 'not-an-array', friends: 123 });
    m = await loadStore();
    expect(m.store.friends.length, '形状不对的缓存不得写进 store').toBe(0);
  });

  it('④ 失败轮次不得把旧数据重新盖成「新鲜」（审查 🔴 复现场景 C）', async () => {
    seed({ friends: [{ userId: 'u1' }], at: Date.now() - 60 * 60_000 });
    const before = read().at;
    const m = await loadStore();
    mode = 'fail500';
    await m.load();
    const after = read();
    expect(after, '缓存本身不应被删').toBeTruthy();
    expect(after.at, '失败轮次不得改写 at（否则 TTL 永不老化、日志恒「新鲜」）').toBe(before);
  });

  it('⑤ 本轮 401 后不得回写（清空是终态；审查 🔴 复现场景 D）', async () => {
    seed({ friends: [{ userId: 'u1' }], at: Date.now() - 60 * 60_000 });
    const m = await loadStore();
    mode = 'bootstrap401';   // 🔴 复现场景 D2 的判别形态（见审查 💡1）
    await m.load();
    expect(read(), 'token 失效后本轮回写必须被压住 ⇒ 缓存为空（清空是终态）').toBeNull();
  });

  it('⑥ 成功轮次仍会正常回写（别把功能改死）', async () => {
    seed({ friends: [{ userId: 'u1' }], at: Date.now() - 60 * 60_000 });
    const m = await loadStore();
    mode = 'ok';
    await m.load();
    const c = read();
    expect(c, '成功轮次应回写缓存').toBeTruthy();
    expect(c.at).toBeGreaterThan(Date.now() - 5000);
  });
});
