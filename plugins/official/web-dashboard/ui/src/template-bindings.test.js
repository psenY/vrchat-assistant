// @vitest-environment node
// 2026-10-16（审查方 ⚠️3 的补强）：**模板里调用的函数必须在 <script setup> 里有定义**。
// 为什么需要单独一层：挂载测试抓不到这类错 —— 事件处理器（@click="foo(...)"）只在**触发时**才解析，
// 挂载照常成功（本轮我自己用受控变异验证过：把 BoothView 的 openDetail 改成 openDetailXX，挂载用例仍全绿 ✗）。
// 本护栏是**源码级**的，只能证明「名字有定义」，不证明「跑得对」；真机渲染仍以 scripts/ui-view-tour.mjs 为准 ✓
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SFC_FILES = ['views', 'components'].flatMap((d) =>
  readdirSync(path.join(DIR, d)).filter((f) => f.endsWith('.vue')).map((f) => d + '/' + f));

// 模板里合法的「非本地定义」名字（JS 内建 / Vue 运行时 / 白名单）
const GLOBALS = new Set([
  'true', 'false', 'null', 'undefined', 'Math', 'Date', 'JSON', 'Object', 'Array', 'Number',
  'String', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', '$event', 'window', 'document',
  'console', 'RegExp', 'Set', 'Map', 'Promise', 'encodeURIComponent', 'decodeURIComponent',
]);

/** script 里声明过的名字：function/const/let/var + 解构 + import（含 as 重命名） */
function declaredNames(script) {
  const names = new Set();
  for (const m of script.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of script.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) { const n = part.split(':').pop().trim().replace(/\s*=.*$/, ''); if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); }
  }
  for (const m of script.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of m[1].split(',')) { const n = part.trim().replace(/\s*=.*$/, ''); if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); }
  }
  for (const m of script.matchAll(/import\s+([^;]+?)\s+from/g)) {
    for (const part of m[1].replace(/[{}]/g, ' ').split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  return names;
}

/** 模板里「被当函数调用」的名字：{{ foo(...) }} 与各指令表达式里的 foo(...) */
function templateCallNames(tpl) {
  const out = new Set();
  const exprs = [...tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1])
    .concat([...tpl.matchAll(/(?:@|:|v-)[\w:.-]*="([^"]*)"/g)].map((m) => m[1]));
  // 负向后行断言排除方法调用（x.min(...)）；再排除 JS 关键字与**字符串字面量里的假调用**
  // （如 :style="width: 'min(720px, 95vw)'" 里的 min 不是被调用的名字）✓
  const KEYWORDS = new Set(['in', 'of', 'typeof', 'instanceof', 'new', 'return', 'void', 'delete', 'await',
    'this', 'super', 'if', 'else', 'for', 'while', 'switch', 'case', 'do', 'try', 'catch', 'finally', 'throw',
    'break', 'continue', 'function', 'class', 'extends', 'yield', 'let', 'const', 'var', 'export', 'import', 'debugger']);
  for (const raw of exprs) {
    const e = raw
      .replace(/'[^']*'/g, '')
      .replace(/"[^"]*"/g, '')
      .replace(/`[^`]*`/g, '');
    for (const m of e.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (!KEYWORDS.has(m[1])) out.add(m[1]);
  }
  return out;
}

describe('模板调用名必须在 script 里有定义（能抓到「模板用了不存在的函数」这一类）', () => {
  for (const rel of SFC_FILES) {
    it(rel, () => {
      const src = readFileSync(path.join(DIR, rel), 'utf8');
      const tpl = (src.match(/<template>([\s\S]*)<\/template>/) || [])[1] || '';
      const script = (src.match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1] || '';
      const declared = declaredNames(script);
      const missing = [...templateCallNames(tpl)].filter((n) => !declared.has(n) && !GLOBALS.has(n));
      expect(missing, rel + ' 模板调用了未定义的名字 ⇒ 运行期 ReferenceError').toEqual([]);
    });
  }
});