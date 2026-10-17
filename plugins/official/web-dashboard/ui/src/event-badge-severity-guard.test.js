/**
 * event-badge-severity-guard.test.js —— 事件徽章 severity 的**定点防打字漂移**护栏
 *
 * 立此用例的原因（2026-10-16 审查 EMeowAGENT ⚠️1/💡2）：某事件类型曾写成 `status: 'warning'`，
 * 而 PrimeVue 的 Tag severity 只认 `warn`（构建产物里 `p-tag-warning` 0 命中、`p-tag-warn` 2 命中）
 * ⇒ 该徽章静默走**默认色**而非预期的橙色告警色。
 *
 * 说明：这是**定点**护栏（防已知的拼写漂移），不是「全表白名单」—— 后者需要 severity 映射有独立导出，
 * 而当前 `constants/event-types.js` 把 label / icon / severity 混在同一批对象里，无法安全地按形状区分。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.join(import.meta.dirname, 'constants', 'event-types.js'), 'utf8');

describe('事件徽章 severity 护栏（定点）', () => {
  it('不得出现非法 severity 字样（PrimeVue 只认 secondary/success/info/warn/danger/contrast）', () => {
    for (const bad of ["'warning'", '"warning"', "'err'", "'error'", "'ok'"]) {
      expect(SRC.includes(bad), '出现非法 severity 字样 ' + bad + '（会静默走默认色）').toBe(false);
    }
  });

  it('「状态变更」用的合法 warn 仍在（别把修复改回去）', () => {
    expect(SRC).toMatch(/status:\s*'warn'/);
  });
});

// 2026-10-16 审查 nixi-agent 💡1：同一错值在【视图层】还有 7 处 Button 曾写 warning（已改 warn），
// 而上面那条护栏只扫 constants/event-types.js ⇒ 按他的意见把护栏扩到视图层。
describe('视图层 severity 取值护栏（2026-10-16 审查 nixi-agent 💡1）', () => {
  it('src/views 与 src/components 下的 .vue 不得出现非法 severity 值', () => {
    // 2026-10-16 审查 nixi-agent（issue #295）：contrast 虽是 PrimeVue 合法值，但本面板**默认深色**，contrast 语义是
    // 「与背景最大对比」⇒ 深色下渲染成**白底**，与相邻徽章不一致（issue #295 的正是这一类）⇒ 从允许表里剔除，
    // 需要「高对比」时用 secondary/info 等同族色；确有必要用 contrast 的场合应显式加白名单并写明理由。
    const OK = new Set(['secondary', 'success', 'info', 'warn', 'danger']);
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.vue')) files.push(p);
      }
    };
    for (const d of ['views', 'components']) walk(path.join(import.meta.dirname, d));
    // 2026-10-16 审查 EMeowAGENT 💡2：root 级 .vue（如 App.vue）也要覆盖
    for (const e of readdirSync(import.meta.dirname, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.vue')) files.push(path.join(import.meta.dirname, e.name));
    }
    expect(files.length, '前置断言：必须真的扫到文件（否则是假绿）').toBeGreaterThan(0);
    const bad = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/severity="([A-Za-z]+)"/g)) {
        if (!OK.has(m[1])) bad.push(path.basename(f) + ': severity=' + m[1]);
      }
      for (const m of src.matchAll(/severity="[^"]*\?\s*'([A-Za-z]+)'/g)) {
        if (!OK.has(m[1])) bad.push(path.basename(f) + ': 三元 severity=' + m[1]);
      }
    }
    expect(bad, '非法 severity：' + bad.join(' / ')).toEqual([]);
  });
});
