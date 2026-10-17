#!/usr/bin/env node
// 2026-09-22 新增：视图巡回回归脚本（今晚「进过某页后所有页面全空白」的护栏）
// 背景：那个 bug 的特征是「不报错、请求也正常，但 .main-viewport 子节点数变 0」✗
// ⇒ 纯函数测试/构建全都拦不住，只有真浏览器里**逐个视图切过去看**才能抓到 ✓
//
// 用法（需要先有一个开着调试端口的 Chrome/Edge，默认 9222）：
//   node scripts/ui-view-tour.mjs                      # 用默认地址与视图清单
//   DASH_URL=https://<你的面板域名>/dashboard node scripts/ui-view-tour.mjs
//   CDP_PORT=9222 node scripts/ui-view-tour.mjs
// 判据：任一视图出现「子节点 0 / 文本为空 / .render-err / 失败横幅」⇒ 退出码 1 ✓
//
// 无依赖：只用 Node 内置 fetch 与 WebSocket（Node >= 22）✓
const PORT = process.env.CDP_PORT || '9222';
const BASE = process.env.DASH_URL || 'http://127.0.0.1:8799/dashboard';
const VIEWS = (process.env.VIEWS || 'feed,friends,tracked,favorites,worlds,avatars,groups').split(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let targets;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json`);
    targets = await r.json();
  } catch (e) {
    console.error('无法连接调试端口', PORT, '-', e.message);
    console.error('提示：先启动带 --remote-debugging-port 的 Chromium（Chrome/Edge），并保持已有登录态');
    process.exit(2);
  }
  const page = (targets || []).find((t) => t.type === 'page');
  if (!page) { console.error('没有可用页面'); process.exit(2); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result && r.result.result ? r.result.result.value : undefined;
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m); }
  };
  await send('Page.enable'); await send('Runtime.enable');

  // 2026-10-16（审查方 🔴 修正）：原判据用的是私有部署的状态栏文案 "AUTH OK" ✗ —— 该字面量在
  // 本仓库的产物 dist/index.html 里 0 命中 ⇒ 已登录页面也判 unknown ⇒ 恒 exit(2)、巡回从不执行。
  // 改用**仓库真实可判定**的标志：登录页才有「访问令牌」文案；已登录时主视图容器 .main-viewport 存在。
  // 另提供 TOUR_SKIP_AUTH_CHECK=1 显式跳过（未提供时保持 fail-fast，避免"什么都没验到却报全绿"）✓
  const auth = await evalJs(`(() => {
    const t = document.body.innerText || "";
    if (t.includes("访问令牌")) return "login";
    if (document.querySelector(".main-viewport")) return "ok";
    return "unknown";
  })()`);
  if (auth !== "ok") {
    if (process.env.TOUR_SKIP_AUTH_CHECK === "1") {
      console.warn("⚠ 登录态判定为 " + auth + "，但 TOUR_SKIP_AUTH_CHECK=1 ⇒ 跳过前置检查继续巡回（结果需自行甄别）");
    } else {
      console.error("✗ 页面不是已登录状态（判定: " + auth + "）—— 巡回结果不可信，请先在浏览器里登录后再跑；确要强跑可设 TOUR_SKIP_AUTH_CHECK=1 ✓");
      process.exit(2);
    }
  }

  const rows = [];
  let bad = 0;
  for (const v of VIEWS) {
    await send('Page.navigate', { url: `${BASE}#view=${v}` });
    await sleep(5000);   // 视图切换 + 数据加载（慢链路下宁可等久一点 ✓）
    const st = await evalJs(`(() => {
      const m = document.querySelector('.main-viewport') || document.body;
      return { kids: m.children.length, len: (m.innerText || '').length,
        err: !!document.querySelector('.render-err'), banner: !!document.querySelector('.load-error-banner') };
    })()`);
    const ok = st && st.kids > 0 && st.len > 0 && !st.err && !st.banner;
    if (!ok) bad++;
    rows.push({ view: v, ...(st || {}), ok });
    console.log((ok ? '  ✓ ' : '  ✗ ') + v.padEnd(12) + ' kids=' + (st ? st.kids : '?') + ' len=' + (st ? st.len : '?') + (st && st.err ? ' [渲染错误面板]' : '') + (st && st.banner ? ' [失败横幅]' : ''));
  }
  try { ws.close(); } catch { /* ignore */ }
  console.log(bad ? `\n✗ ${bad}/${rows.length} 个视图不通过（空白/报错）` : `\n✓ ${rows.length} 个视图全部正常`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error('巡回失败:', e.message); process.exit(2); });
