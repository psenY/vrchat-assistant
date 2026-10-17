/**
 * test/status-sync-sep-normalize.test.mjs —— 分隔符被 VRChat 规范化后的幂等性（2026-10-17 用户报障）
 *
 * 现象（用户截图）：自己的动态状态越长越多 —— 「afk ｜11在线好友 ｜9在线好友 ｜8在线好友 ｜7在线好友」，
 * 每轮同步都在尾巴上再追加一段，正是她当初担心的「无限累加」。
 *
 * 根因：config.separator 是半角「 |」，但 VRChat 会把状态文本里的半角竖线规范化成全角「｜」
 * （生产实测：我们 PUT「sleep |5在线好友」，WS 回推 / /auth/user 读回都是「sleep ｜5在线好友」）。
 * 于是 stripSuffix 按半角构造的分隔符正则匹配不到 ⇒ 认不出自己的后缀 ⇒ 整段被当成用户正文再追加，
 * 同时「未变化」判定也永远不等（target 半角 vs remote 全角）⇒ 每轮都重写。
 *
 * 变异自证：把 stripSuffix 的等价类正则退回 escapeRe(sep) ⇒ 用例 1/2 红；
 *          把未变化判定退回 target === remote ⇒ 用例 3 红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const { stripSuffix, composeStatus, normalizeStatusText, sameStatus } = await import(pathToFileURL(path.join(REPO, 'core', 'status-sync.js')).href);

const TEMPLATE = '{gameOnline}在线好友';
const SEP = ' |';                 // 用户配置（半角）
const FULLWIDTH = '\uFF5C';      // VRChat 回推时把 | 换成的全角竖线
const asRemote = (s) => String(s).split('|').join(FULLWIDTH);   // 模拟 VRChat 的规范化

test('半角分隔符写出的后缀，被 VRChat 规范化成全角后仍能被剥离', () => {
  const ours = composeStatus('afk', '5在线好友', { separator: SEP });
  assert.equal(ours, 'afk |5在线好友');
  const remote = asRemote(ours);
  assert.equal(stripSuffix(remote, TEMPLATE, SEP), 'afk', '剥离必须认得被规范化过的分隔符');
});

test('历史上已经累加多段的状态，一次剥离就收敛回正文（自愈）', () => {
  const remote = asRemote('afk |11在线好友 |9在线好友 |8在线好友 |7在线好友');
  assert.equal(stripSuffix(remote, TEMPLATE, SEP), 'afk', '多段旧后缀要一次剥干净，而不是只剥最后一段');
});

test('未变化判定按规范化比较：半角 target 与全角 remote 视为同一状态（不再每轮重写）', () => {
  const target = composeStatus('sleep', '5在线好友', { separator: SEP });
  const remote = asRemote(target);
  assert.notEqual(target, remote, '前提：两者字面确实不同');
  assert.ok(sameStatus(target, remote), 'sameStatus 应判为同一状态（sync 里就是用它决定跳过重写）');
  // 反例：内容真的不同时不得被规范化掩盖
  const other = asRemote(composeStatus('sleep', '6在线好友', { separator: SEP }));
  assert.ok(!sameStatus(target, other), '内容真的不同时不得被规范化掩盖');
});
