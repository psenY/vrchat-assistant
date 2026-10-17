/**
 * store-auth-entry.test.js —— 「数据面何时打开」的入口链路永久用例
 *
 * 立此用例的原因（2026-10-16 审查实测）：真实入口顺序是
 *   main.js: startDashboard() → app.mount('#app')
 * 而 startDashboard() 里 authed 若只看 getToken()，有旧令牌时会在 verifyToken 之前就打开数据面
 * （实测白打 13 个请求）。
 *
 * ⚠️ 本文件**不使用 happy-dom**（2026-10-16 审查 🔴1）：happy-dom 只是 vitest 的**可选 peer**，
 * ui/package.json 没声明它 ⇒ CI 的 npm ci --prefix ui 不会安装 ⇒ 任何声明「用 happy-dom 作测试环境」
 * 的文件在 CI 里**起不了 worker**（护栏静默失效 + CI 变红）。注意：**连注释里都别写那条指令字面量**——
 * vitest 会在文件头注释里正则匹配环境指令，写了就照样触发。
 * ⇒ 自带最小 DOM/存储桩，在 import 被测模块之前装好（api.js 在模块期读 location/sessionStorage）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const listeners = {};
globalThis.sessionStorage = mkStorage();
globalThis.localStorage = mkStorage();
globalThis.location = { search: '', hash: '', pathname: '/', href: 'http://localhost/' };
globalThis.window = Object.assign(globalThis, {
  addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener: () => {},
  dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  innerWidth: 1280,
  innerHeight: 800,
});
globalThis.document = {
  title: '',
  body: { appendChild: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, select: () => {}, focus: () => {} }),
  querySelector: () => null,
  addEventListener: () => {},
  execCommand: () => true,
};

const TOKEN_KEY = 'vrc_dashboard_token';
let dashboardCalls = 0;

const mk = (body = {}, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  dashboardCalls = 0;
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (!u.includes('/api/dashboard')) return mk({});
    dashboardCalls += 1;
    if (u.includes('overview')) return mk({ auth: { authenticated: true }, ws: { status: 'connected' } });
    if (u.includes('bootstrap')) return mk({ events: [], total: 0 });
    if (u.includes('friends')) return mk({ friends: [] });
    return mk({});
  });
});

const loadStore = async () => { vi.resetModules(); return await import('./store.js'); };
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('数据面打开的入口链路（main.js 先调 startDashboard 再 mount）', () => {
  it('① 无令牌 + main.js 首次调用 ⇒ 零数据请求（双门语义）', async () => {
    const m = await loadStore();
    m.startDashboard();
    await tick();
    expect(dashboardCalls, '无令牌时不得发任何 /api/dashboard 请求').toBe(0);
  });

  it('② 带旧令牌 + main.js 首次调用（verifyToken 尚未执行）⇒ 仍为零请求（🔴 的核心断言）', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'stale-token');
    const m = await loadStore();
    m.startDashboard();
    await tick();
    expect(dashboardCalls, '旧令牌在校验之前不得打开数据面').toBe(0);
  });

  it('③ 校验通过后（App 置 authVerified）再调 startDashboard ⇒ 数据面打开', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'good-token');
    const m = await loadStore();
    m.startDashboard();
    await tick();
    expect(dashboardCalls).toBe(0);
    m.store.authVerified = true;
    m.startDashboard();
    await tick();
    expect(dashboardCalls, '校验通过后必须能起数据面（别修成永远不动）').toBeGreaterThan(0);
  });

  it('④ 已启动后重复调用 ⇒ 幂等（不重复发请求）', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'good-token');
    const m = await loadStore();
    m.store.authVerified = true;
    m.startDashboard();
    await tick();
    const n = dashboardCalls;
    m.startDashboard();
    await tick();
    expect(dashboardCalls, '第二次调用不得再发请求').toBe(n);
  });

  it('⑤ 无令牌但探针判定「未启用鉴权」（authRequired=false）⇒ 仍要放行数据面', async () => {
    const m = await loadStore();
    m.startDashboard();
    await tick();
    expect(dashboardCalls).toBe(0);
    m.store.authRequired = false;
    m.startDashboard();
    await tick();
    expect(dashboardCalls, '未启用令牌的部署必须放行（上游原语义，不能丢）').toBeGreaterThan(0);
  });
});
