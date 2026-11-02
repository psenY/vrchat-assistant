/**
 * seq-guard.test.js —— 「只认最新一次异步结果」的回归（2026-11-02）
 *
 * 这条保护的场景：弹窗切换对象时，先发出的请求后返回会覆盖新对象的数据。
 * 本模块是那段逻辑的唯一实现，UserDialog 的 loadProfile / loadEvents 都用它。
 */
import { describe, it, expect } from 'vitest';
import { createSeqGuard } from './seq-guard.js';

describe('createSeqGuard', () => {
  it('同键连续两次请求：只有第二次算当前', () => {
    const g = createSeqGuard();
    const a = g.begin('usr_A');
    const b = g.begin('usr_A');
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });

  it('切换对象后：旧对象的请求不再算当前（即使它最后返回）', () => {
    const g = createSeqGuard();
    const forA = g.begin('usr_A');
    const forB = g.begin('usr_B');
    expect(g.isCurrent(forB)).toBe(true);
    // A 晚到 —— 必须被判过期，否则会覆盖 B
    expect(g.isCurrent(forA)).toBe(false);
  });

  it('业务键相同但序号过期时也不算当前（重试场景）', () => {
    const g = createSeqGuard();
    const first = g.begin('usr_X');
    g.begin('usr_X');
    expect(g.isCurrent(first)).toBe(false);
  });

  it('传 null/undefined 时安全返回 false', () => {
    const g = createSeqGuard();
    g.begin('k');
    expect(g.isCurrent(null)).toBe(false);
    expect(g.isCurrent(undefined)).toBe(false);
  });

  it('current() 暴露递增序号（便于日志/调试）', () => {
    const g = createSeqGuard();
    expect(g.current()).toBe(0);
    g.begin('a'); g.begin('b');
    expect(g.current()).toBe(2);
  });
});


// ── 接线护栏（2026-11-02）──
// 纯函数测试只能证明守卫本身对；不能证明 UserDialog 真的用了它。
// 这里读源码断言接线仍在：否则有人「重构」掉 isCurrent 判据，纯函数测试依然全绿。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dialogSrc = readFileSync(path.join(here, '..', 'components', 'UserDialog.vue'), 'utf8');

describe('UserDialog 接线（防「逻辑写了但没接上」）', () => {
  it('loadProfile 用 guard 丢弃过期响应', () => {
    expect(dialogSrc).toMatch(/profileGuard\.begin\(user\.value\.userId\)/);
    expect(dialogSrc).toMatch(/if \(!profileGuard\.isCurrent\(rec\)/);
  });
  it('loadEvents 同样有判据', () => {
    expect(dialogSrc).toMatch(/eventsGuard\.begin\(user\.value\.userId\)/);
    expect(dialogSrc).toMatch(/!eventsGuard\.isCurrent\(rec\)/);
  });
  it('loading 只由最新一次请求收尾', () => {
    expect(dialogSrc).toMatch(/if \(profileGuard\.isCurrent\(rec\)\) loading\.value = false/);
  });
});
