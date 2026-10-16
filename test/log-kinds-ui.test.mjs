// 护栏：服务日志页的 kind 标签必须覆盖 core/ops-log.js 定义的全部 kind。
// 为什么需要：这份集合在两处各自维护，后端加一类而前端没跟会「静默回落成英文裸标签」——
// 不报错、门禁也不会红（2026-10-16 补齐 api/ext 时正是这个缺口）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPS_LOG = readFileSync(path.join(REPO, 'core/ops-log.js'), 'utf8');
const UI_CONST = readFileSync(path.join(REPO, 'plugins/official/web-dashboard/ui/src/constants/log-kinds.js'), 'utf8');

/** 后端声明：@param {...} kind 的联合取值（首处即权威清单） */
function backendKinds(src) {
  const m = src.match(/@param \{([^}]+)\} kind/);
  assert.ok(m, 'core/ops-log.js 的 JSDoc 里应有 kind 取值清单（锚点变了请同步本护栏）');
  // 花括号内是 'auth'|'ws'|... 形态：直接 split('|') 会把引号带进取值名（首版就是这么红的）
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** 前端标签的键集合（对象字面量里的键名） */
function uiLabelKeys(src) {
  const m = src.match(/LOG_KIND_LABEL\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(m, "log-kinds.js 里应有 LOG_KIND_LABEL = Object.freeze({...})");
  return [...m[1].matchAll(/([A-Za-z_][\w]*)\s*:/g)].map((x) => x[1]);
}

test('UI 的日志类别标签覆盖 core/ops-log.js 的全部 kind', () => {
  const labels = uiLabelKeys(UI_CONST);
  const missing = backendKinds(OPS_LOG).filter((k) => !labels.includes(k));
  assert.deepEqual(missing, [], `以下 kind 在日志页缺少中文标签/筛选项：${missing.join(', ')}`);
});

test('该覆盖率断言不是恒真（受控变异：删掉一个标签必须报缺）', () => {
  const mutated = UI_CONST.replace(/,\s*ext:\s*'[^']*'/, '');
  assert.notEqual(mutated, UI_CONST, '变异未生效（锚点不匹配），请修本用例');
  const labels = uiLabelKeys(mutated);
  const missing = backendKinds(OPS_LOG).filter((k) => !labels.includes(k));
  assert.deepEqual(missing, ['ext'], '删掉 ext 标签后必须只报缺 ext（否则护栏无效）');
});