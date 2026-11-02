// @vitest-environment happy-dom
/**
 * clickable.test.js —— v-clickable 指令的键盘可达性回归（2026-11-02）
 *
 * 立这条用例的原因：全仓原有 51 处手写 `role="button" tabindex="0" @keydown.enter` 三件套，
 * **它们全部只支持 Enter，按空格毫无反应**（真实浏览器实测：Enter +100，Space +0）。
 * 原生 <button> 的行为是 Enter 立即触发、空格在 keyup 触发，键盘用户对此有肌肉记忆。
 *
 * 本用例直接驱动真实指令模块（不 mock 被测代码），钉住：
 *  ① mounted 时自动补 role="button" 与 tabindex="0"；
 *  ② Enter 触发 handler；
 *  ③ **Space 也触发 handler**（这是本次修复的核心，改回去就必须红）；
 *  ④ 两者都 preventDefault（否则空格会滚动页面）；
 *  ⑤ unmounted 后不再触发（避免组件销毁后仍响应键盘）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clickable } from './clickable.js';

const mkEl = () => {
  const el = document.createElement('span');
  el.className = 'world-link';
  document.body.appendChild(el);
  return el;
};

const fire = (el, type, key) => {
  const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

describe('v-clickable', () => {
  let el;
  let hits;

  beforeEach(() => {
    hits = 0;
    el = mkEl();
  });

  afterEach(() => {
    clickable.unmounted(el);
    el.remove();
  });

  it('mounted 自动补 role 与 tabindex', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('click 触发 handler', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hits).toBe(1);
  });

  it('Enter 触发 handler 且 preventDefault', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    const e = fire(el, 'keydown', 'Enter');
    expect(hits).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Space 也触发 handler 且 preventDefault（本次修复的核心）', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    const e = fire(el, 'keydown', ' ');
    expect(hits).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('其它键不触发也不 preventDefault', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    const e = fire(el, 'keydown', 'a');
    expect(hits).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it('updated 换 handler 后触发新的', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    clickable.updated(el, { value: () => { hits += 100; } });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hits).toBe(100);
  });

  it('unmounted 后键盘不再触发', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    clickable.unmounted(el);
    fire(el, 'keydown', 'Enter');
    expect(hits).toBe(0);
  });

  it('handler 不是函数时静默忽略（模板里可能传 undefined）', () => {
    clickable.mounted(el, { value: undefined });
    fire(el, 'keydown', 'Enter');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hits).toBe(0);
  });

  it('已存在的 role / tabindex 不被覆盖', () => {
    el.setAttribute('role', 'option');
    el.setAttribute('tabindex', '3');
    clickable.mounted(el, { value: () => { hits += 1; } });
    expect(el.getAttribute('role')).toBe('option');
    expect(el.getAttribute('tabindex')).toBe('3');
  });
});
