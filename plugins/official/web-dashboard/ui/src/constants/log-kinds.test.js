import { describe, it, expect } from 'vitest';
import { LOG_KINDS, LOG_KIND_LABEL } from './log-kinds.js';

describe('log-kinds 常量', () => {
  it('每个可选类别都有非空中文标签（all 不是 kind，跳过）', () => {
    const missing = LOG_KINDS.filter((k) => k.v !== 'all').filter((k) => !LOG_KIND_LABEL[k.v]);
    expect(missing).toEqual([]);
  });

  it('取值唯一、标签非空', () => {
    const values = LOG_KINDS.map((k) => k.v);
    expect(new Set(values).size).toBe(values.length);
    for (const k of LOG_KINDS) expect(String(k.l || '').trim().length).toBeGreaterThan(0);
  });
});
