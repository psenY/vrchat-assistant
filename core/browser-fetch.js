/**
 * 有头浏览器页面抓取服务（core 能力，供插件经 api.consume('web.browserFetchMany') 使用）
 * =====================================================================
 * 背景：部分第三方站点（如 VRC Search search.vrcwwt.com）被 Cloudflare JS 挑战保护，
 * 裸 HTTP 客户端（curl / node http，带不带浏览器 UA）一律 403；真实浏览器首次进入会
 * 显示「正在进行安全验证 / 请稍候」并在数秒后自动放行，此后同一浏览器上下文里的
 * cf_clearance + 配对 UA 可直接复用。逐 URL 发裸请求 = 全部失败且每个各等一次超时，
 * 因此这里一次性拉起一个 headful 浏览器 → 顺序访问全部 URL → 取每页 HTML → 关闭。
 *
 * 实现模式参照 core/fetch-x-worlds.js（懒加载 playwright / 通道探测缓存 / 挑战轮询 /
 * 显式代理 / 逐分支留痕），但本模块只负责「拿到渲染后的 HTML」，不含任何站点解析。
 *
 * 浏览器能力**只放 core**：插件是零依赖契约（docs/PLUGIN-API.md），不得自行 import
 * playwright 或拉起浏览器，只能通过 web.browserFetchMany consume（注册见 start-monitor.js）。
 */

import { getLogger } from './logger.js';

const logApp = getLogger('browser');

// 挑战门页特征：Cloudflare interstitial（中英）+ 其它常见反爬校验页
const CHALLENGE_RE = /正在进行安全验证|请稍候|just a moment|checking your browser|verify you are human|Ray ID/i;
const MIN_PAGE_TIMEOUT_MS = 3000; // 单页剩余预算低于此值就不再开新页（时间不够做事，直接标注跳过）

/**
 * 运行时读配置。start-monitor.js 先 import 核心模块、后加载 .env，
 * 故顶层 const 会取到空值 —— 一律调用时读 process.env。
 * 变量名刻意不含 KEY/SECRET/TOKEN/PASSWORD/COOKIE/AUTH 子串（与仓库既有规范一致）。
 *
 * 导出为纯函数以便单测（审查 W1）：`parseInt(...) || 默认` 只兜住 0/NaN，**负值会穿透**，
 * 一旦 perPageMs 为负，整批预算坍缩成 `URL 数×3s`、单页几百 ms 就 deadline_exceeded。
 * 故非正数/空/非数字**一律回落默认**。
 */
export function resolveBrowserFetchConfig(env = process.env) {
  const rawTimeout = parseInt(env.VRC_MONITOR_BROWSER_FETCH_TIMEOUT_MS, 10);
  return {
    enabled: env.VRC_MONITOR_BROWSER_FETCH !== '0',           // '0' 关闭，默认开
    channel: env.VRC_MONITOR_BROWSER_FETCH_CHANNEL || 'auto', // auto|msedge|chrome|chromium
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 45000,
  };
}

function getBrowserFetchConfig() {
  return resolveBrowserFetchConfig(process.env);
}

// ── 代理解析：与 core/fetch-x-worlds.js resolveProxy 同口径 —— 默认【直连】，仅显式配置才走代理 ──
// search.vrcwwt.com 国内直连可达；默认写死代理反而会让未开代理的部署全失败。
function resolveProxy() {
  const env = process.env;
  return env.VRC_MONITOR_HTTP_PROXY || env.HTTPS_PROXY || env.https_proxy
    || env.HTTP_PROXY || env.http_proxy || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let _pw = null, _pwErr = null;  // playwright 模块懒加载缓存（顶层静态 import 会带来加载期副作用）
let _detectedChannel = null;    // 探测成功的通道缓存，避免每次调用都 launch 一遍

async function getPlaywright() {
  if (_pw) return _pw;
  if (_pwErr) throw _pwErr;
  try { _pw = await import('playwright'); return _pw; }
  catch (e) { _pwErr = new Error(`playwright 未安装或不可用：${e.message}`); throw _pwErr; }
}

/**
 * 自动探测可用浏览器通道：显式指定优先，否则 msedge → chrome → chromium。
 * 探测本身要 launch+close 一次，故结果缓存到模块级变量（同进程内不重复探测）。
 */
async function detectChannel(pw, requestedChannel, launchArgs) {
  if (_detectedChannel) return _detectedChannel;
  const preferred = requestedChannel && requestedChannel !== 'auto' ? [requestedChannel] : [];
  const candidates = [...preferred, 'msedge', 'chrome', 'chromium'];
  const tried = new Set();
  for (const channel of candidates) {
    if (tried.has(channel)) continue;
    tried.add(channel);
    try {
      const browser = await pw.chromium.launch({ channel, headless: false, args: launchArgs });
      await browser.close();
      logApp.info(`Playwright 通道探测成功: ${channel}`);
      _detectedChannel = channel;
      return channel;
    } catch (e) {
      logApp.info(`Playwright 通道 ${channel} 不可用: ${String(e.message || '').slice(0, 80)}`);
    }
  }
  throw new Error('msedge/chrome/chromium 均不可启动');
}

/**
 * 单页抓取（同一 page 顺序复用：cf_clearance 落在浏览器上下文里，过挑战后后续页面直接生效）。
 * 返回 { url, status, body, error?, durationMs }；**任何失败都不 throw**（单页失败只影响该页）。
 */
async function fetchOnePage(page, url, pageBudgetMs) {
  const startedAt = Date.now();
  // 单页预算自**进入本函数**起算：否则实际耗时可达 goto + 轮询两段预算（约 2×）。
  const deadline = startedAt + pageBudgetMs;
  let mainStatus = 0;
  // 主文档状态：挑战放行后浏览器会重新导航到同一 URL，取最后一次匹配的主文档响应
  const onResponse = (res) => {
    try {
      if (res.frame() === page.mainFrame() && res.url() === url) mainStatus = res.status();
    } catch { /* 导航中 frame 已被销毁，忽略本次响应 */ }
  };
  page.on('response', onResponse);
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, deadline - Date.now()) });
    if (resp) mainStatus = resp.status();

    let challengeSince = 0;    // 本次连续处于挑战页的起始时刻（放行后归零）
    let lastWasChallenge = false;
    let settled = false;
    while (Date.now() < deadline) {
      let text = '';
      try { text = await page.evaluate(() => (document.body ? document.body.innerText : '')); }
      catch { /* 导航中执行上下文被销毁，下一轮再试 */ }
      if (CHALLENGE_RE.test(text)) {
        lastWasChallenge = true;
        if (!challengeSince) challengeSince = Date.now();
        // CF managed challenge 正常 5~8s 自行放行，**不打断它**；只有卡在同一条上超 20s 才 reload 重新触发
        if (Date.now() - challengeSince > 20000) {
          const rr = await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1000, deadline - Date.now()) }).catch(() => null);
          if (rr) mainStatus = rr.status();
          challengeSince = Date.now();
        } else {
          await sleep(1000);
        }
        continue;
      }
      // 非挑战页但正文为空 = 挑战放行后的中间跳转态，继续等
      if (!String(text).trim()) { await sleep(500); continue; }
      lastWasChallenge = false;
      challengeSince = 0;
      settled = true;
      break;
    }

    if (!settled) {
      return {
        url,
        status: mainStatus,
        body: '',
        error: lastWasChallenge ? 'challenge_unresolved' : 'content_timeout',
        durationMs: Date.now() - startedAt,
      };
    }
    const body = await page.content();
    // 偶发抓不到主文档响应对象（挑战期重定向）；此时 DOM 已是真实内容，按 200 记
    return { url, status: mainStatus || 200, body, durationMs: Date.now() - startedAt };
  } catch (e) {
    return { url, status: 0, body: '', error: String(e.message || e).slice(0, 200), durationMs: Date.now() - startedAt };
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * 批量页面抓取（web.browserFetchMany 服务实现）。
 *
 * @param {string[]} urls 待抓取页面（顺序访问）
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  单页预算（默认 VRC_MONITOR_BROWSER_FETCH_TIMEOUT_MS=45000 为上界）
 * @param {number} [opts.deadlineMs] 整批预算（默认 max(4×单页预算, URL 数×3s)）——防止逐页超时叠加成小时级挂死
 * @returns {Promise<{ok:boolean, reason?:string, results:Array<{url:string,status:number,body:string,error?:string}>, durationMs:number}>}
 *   整体不可用（关闭 / playwright 缺失 / 无通道 / 启动失败 / 挑战没过 / 预算用尽）时
 *   ok=false + reason，results 仍逐个 URL 给出 error 标注；**不 throw**，调用方据此结构化降级。
 *
 * 并发：**同一批 URL** 的并发调用复用进行中的那一次（single-flight）；**不同批次**串行执行
 *   （同一部署里的两次调用不会各自拉起一个 headful 浏览器）。
 */
// ── 并发控制 ──────────────────────────────────────────────────────────
//   同一批 URL 的并发调用复用「进行中的那一次」；不同批次**串行**执行——否则同一部署里两次
//   fetch_community_events 并发会各拉起一个 headful 浏览器（内存与挑战次数都翻倍）。
let _inFlight = null;              // { key, promise }：进行中的抓取（按 URL 列表去重）
let _queue = Promise.resolve();    // 批次串行链

export function browserFetchMany(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : []).map(u => String(u || '').trim()).filter(Boolean);
  const key = list.join('\n');
  if (list.length && _inFlight && _inFlight.key === key) {
    logApp.info(`同一批 ${list.length} 个 URL 的抓取已在进行中，复用该次结果（不重复拉起浏览器）`);
    return _inFlight.promise;
  }
  const run = () => browserFetchManyUnsafe(list, opts);
  const p = _queue.then(run, run);          // 前一批失败也要继续执行本批
  _queue = p.then(() => {}, () => {});      // 串行链吞掉结果/异常，避免未处理拒绝
  if (list.length) _inFlight = { key, promise: p };
  const clear = () => { if (_inFlight && _inFlight.promise === p) _inFlight = null; };
  p.then(clear, clear);
  return p;
}

async function browserFetchManyUnsafe(list, opts = {}) {
  const startedAt = Date.now();
  const cfg = getBrowserFetchConfig();
  const results = [];

  const finish = (reason) => ({
    ok: results.some(r => r.status >= 200 && r.status < 300 && r.body),
    ...(reason ? { reason } : {}),
    results,
    durationMs: Date.now() - startedAt,
  });
  // 整批不可用：给每个 URL 补一条同因失败，保证 results 与入参一一对应
  const unavailable = (reason) => {
    for (const u of list) results.push({ url: u, status: 0, body: '', error: reason });
    return finish(reason);
  };

  if (list.length === 0) {
    logApp.info('无 URL 可抓取，跳过');
    return { ok: false, reason: 'no_urls', results, durationMs: Date.now() - startedAt };
  }
  if (!cfg.enabled) {
    logApp.info(`浏览器抓取已关闭（VRC_MONITOR_BROWSER_FETCH=0），跳过 ${list.length} 个 URL`);
    return unavailable('disabled_by_env');
  }

  const perPageMs = Math.min(Math.max(parseInt(opts.timeoutMs, 10) || cfg.timeoutMs, MIN_PAGE_TIMEOUT_MS), cfg.timeoutMs);
  const budgetMs = Math.max(parseInt(opts.deadlineMs, 10) || 0, Math.max(perPageMs * 4, list.length * 3000));

  let pw;
  try { pw = await getPlaywright(); }
  catch (e) { logApp.warn(`playwright 不可用：${e.message}`); return unavailable('playwright_unavailable'); }

  const baseArgs = [
    '--no-sandbox',
    '--mute-audio',
    '--disable-infobars',
    // 不去掉 webdriver 标记时 Cloudflare managed challenge **永不自行放行**
    // （实测一直卡在「请稍候…」>88s）；带上这条后约 7s 过挑战并返回 200。
    '--disable-blink-features=AutomationControlled',
    '--window-position=-2400,-2400',
    '--window-size=1280,900',
  ];
  const proxy = resolveProxy();
  // 日志只报「是否走代理」，不回显地址（代理 URL 可能内嵌凭据）

  let channel;
  try { channel = await detectChannel(pw, cfg.channel, baseArgs); }
  catch (e) { logApp.warn(`无可用浏览器通道：${e.message}，跳过 ${list.length} 个 URL`); return unavailable('no_browser_channel'); }

  const launch = (withProxy) => pw.chromium.launch({
    channel,
    headless: false,
    args: withProxy ? [...baseArgs, `--proxy-server=${proxy}`] : baseArgs,
  });

  let browser = null;
  try {
    let useProxy = Boolean(proxy);
    try {
      browser = await launch(useProxy);
    } catch (e) {
      logApp.warn(`启动失败（channel=${channel}）：${String(e.message || e).slice(0, 120)}`);
      return unavailable('browser_launch_failed');
    }
    // 不覆盖 userAgent：伪造 UA 与真实浏览器指纹（client hints / cf_clearance 绑定 UA）不一致，
    // Cloudflare 会无限重发挑战；用浏览器原生 UA，只固定视口。
    const openPage = () => browser.newPage({ viewport: { width: 1280, height: 900 } });
    let page = await openPage();

    // 从第 i 页起整批放弃：逐个标注 + 一行留痕（预算用尽与「重建浏览器后仍无预算」共用）
    const exhaustDeadline = (i, skipReason) => {
      const skip = skipReason || 'deadline_exceeded';
      for (let j = i; j < list.length; j++) results.push({ url: list[j], status: 0, body: '', error: skip });
      logApp.warn(`整批预算 ${budgetMs}ms 用尽，剩余 ${list.length - i} 页未抓取（${skip}）`);
      return finish('deadline_exceeded');
    };

    const failFast = (r, i) => {
      // 单页预算内始终没过挑战 ⇒ 该上下文没拿到 cf_clearance，再访问其余页面只会重复撞墙（白等），
      // 故整批早退并逐个标注，由调用方按 reason 结构化降级。
      if (r.error !== 'challenge_unresolved') return null;
      for (let j = i + 1; j < list.length; j++) results.push({ url: list[j], status: 0, body: '', error: 'skipped_after_challenge' });
      logApp.warn(`Cloudflare 挑战未通过（${list[i]}，${r.durationMs}ms），剩余 ${list.length - i - 1} 页跳过`);
      return finish('cloudflare_challenge_unresolved');
    };

    for (let i = 0; i < list.length; i++) {
      let left = budgetMs - (Date.now() - startedAt);
      if (left < MIN_PAGE_TIMEOUT_MS) return exhaustDeadline(i);
      let r = await fetchOnePage(page, list[i], Math.min(left, perPageMs));

      // 代理不可达 → 回退直连重建浏览器（与核心 fetch-x-worlds「先代理后直连」同口径）：
      // 遗留的代理环境变量（进程环境里常有但服务没起）不该把整个源判死。
      const proxyDown = useProxy && /ERR_PROXY_|proxy/i.test(String(r.error || ''));
      if (proxyDown) {
        logApp.info(`代理不可达（${r.error}），剩余 ${list.length - i} 页回退直连`);
        await browser.close().catch(() => {});
        useProxy = false;
        browser = await launch(false);
        page = await openPage();
        left = budgetMs - (Date.now() - startedAt);
        if (left < MIN_PAGE_TIMEOUT_MS) return exhaustDeadline(i, 'deadline_exceeded_after_proxy_fallback');
        r = await fetchOnePage(page, list[i], Math.min(left, perPageMs));
      }

      results.push(r);
      const early = failFast(r, i);
      if (early) return early;
    }

    await browser.close().catch(() => {});
    browser = null;
    const okCount = results.filter(r2 => r2.status >= 200 && r2.status < 300 && r2.body).length;
    logApp.info(`${okCount}/${list.length} 页抓取成功，耗时 ${Date.now() - startedAt}ms（channel=${channel}${useProxy ? ', 经代理' : ', 直连'}）`);
    return okCount > 0 ? finish() : finish('all_pages_failed');
  } catch (e) {
    for (const u of list) if (!results.some(r => r.url === u)) results.push({ url: u, status: 0, body: '', error: 'browser_error' });
    logApp.warn(`抓取中断：${String(e.message || e).slice(0, 200)}`);
    return finish('browser_error');
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
