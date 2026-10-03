// 浏览器抓取配置解析的行为断言（审查 W1 回归）
// 旧写法 `parseInt(env.X, 10) || 45000` 只兜住 0/NaN：**负值会穿透** ⇒ perPageMs 为负 ⇒
// 整批预算坍缩成 `URL 数×3s`、单页几百 ms 就返回 deadline_exceeded（一页未抓）。
// 直接 import 生产代码；把实现改回旧写法这条一定变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrowserFetchConfig } from '../core/browser-fetch.js';

const withEnv = (env) => resolveBrowserFetchConfig(env);

test('默认（无 env）：开启、通道 auto、单页预算 45000', () => {
  const c = withEnv({});
  assert.equal(c.enabled, true);
  assert.equal(c.channel, 'auto');
  assert.equal(c.timeoutMs, 45000);
});

test('非正数/空/非数字一律回落 45000（审查 W1：负值不得穿透）', () => {
  for (const v of ['-5', '-1', '0', '', '   ', 'abc', 'NaN', undefined, null]) {
    assert.equal(withEnv({ VRC_MONITOR_BROWSER_FETCH_TIMEOUT_MS: v }).timeoutMs, 45000, `值 ${JSON.stringify(v)} 应回落默认`);
  }
});

test('正数按原值生效（可上调，也可下调）', () => {
  assert.equal(withEnv({ VRC_MONITOR_BROWSER_FETCH_TIMEOUT_MS: '90000' }).timeoutMs, 90000);
  assert.equal(withEnv({ VRC_MONITOR_BROWSER_FETCH_TIMEOUT_MS: '8000' }).timeoutMs, 8000);
  assert.equal(withEnv({ VRC_MONITOR_BROWSER_FETCH_TIMEOUT_MS: '45000abc' }).timeoutMs, 45000, 'parseInt 语义：前缀数字仍生效');
});

test('VRC_MONITOR_BROWSER_FETCH=0 关闭整条通道（只有显式 0 才关）', () => {
  assert.equal(withEnv({ VRC_MONITOR_BROWSER_FETCH: '0' }).enabled, false);
  assert.equal(withEnv({ VRC_MONITOR_BROWSER_FETCH: '1' }).enabled, true);
  assert.equal(withEnv({ VRC_MONITOR_BROWSER_FETCH: '' }).enabled, true);
});

test('显式指定通道时不被 auto 覆盖', () => {
  assert.equal(withEnv({ VRC_MONITOR_BROWSER_FETCH_CHANNEL: 'chrome' }).channel, 'chrome');
  assert.equal(withEnv({ VRC_MONITOR_BROWSER_FETCH_CHANNEL: '' }).channel, 'auto');
});
