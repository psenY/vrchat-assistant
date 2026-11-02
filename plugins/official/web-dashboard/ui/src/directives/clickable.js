/**
 * v-clickable —— 让非 <button> 元素（span/div/img）具备完整的键盘可达性。
 *
 * 背景（2026-11-02 实测）：
 *  全仓 51 处手写 `role="button" tabindex="0" @keydown.enter="fn"` 三件套。
 *  其中 48 处的 @click 与 @keydown.enter 是**同一表达式**，属于纯重复；
 *  更要紧的是**它们全部只支持 Enter，不支持空格** —— 在真实浏览器里
 *  Tab 到元素后按空格毫无反应（实测：Enter 触发，Space 不触发）。
 *  原生 <button> 的行为是「Enter 立即触发、空格在 keyup 触发」，键盘用户对此有肌肉记忆。
 *
 * 用法：
 *   <span class="world-link" v-clickable="openWorld(x.worldId)">名字</span>
 *   <div class="ev-row" v-clickable="() => toggleRow(x)">…</div>
 *
 * 行为（与原生 button 对齐）：
 *   - click      → 调用 handler
 *   - keydown Enter / Space → preventDefault（避免页面滚动）并调用 handler
 *   - 同时补 role="button" 与 tabindex="0"（已存在则不覆盖，便于渐进迁移）
 *   - handler 不是函数时静默忽略（模板里偶尔会传 undefined）
 *
 * 为什么不用 @click + @keydown.enter 继续手写：48 处 × 每个属性都容易出现
 * 「改了一处漏了另一处」（本仓已有先例：函数写了但没接线）。集中一次，
 * 后续新增可点元素照抄一个属性即可，不会再漏掉键盘路径。
 */

const HANDLER = Symbol('clickableHandler');

function normalize(binding) {
  const v = binding && binding.value;
  if (typeof v === 'function') return v;
  return null;
}

function onKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  // 空格默认会滚动页面；Enter 在 role=button 上默认什么都不做，都拦掉
  e.preventDefault();
  const fn = this[HANDLER];
  if (fn) fn(e);
}

const installed = new WeakSet();

export const clickable = {
  mounted(el, binding) {
    const fn = normalize(binding);
    if (!fn) return;
    el[HANDLER] = fn;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    // 同一个元素可能被 v-if 复用后又重新 mounted —— WeakSet 防重复绑监听
    if (installed.has(el)) return;
    installed.add(el);
    el.addEventListener('click', (e) => {
      const cur = el[HANDLER];
      if (cur) cur(e);
    });
    el.addEventListener('keydown', onKeydown);
  },
  updated(el, binding) {
    const fn = normalize(binding);
    if (fn) el[HANDLER] = fn;
  },
  unmounted(el) {
    if (!el) return;
    el.removeEventListener('keydown', onKeydown);
    delete el[HANDLER];
    installed.delete(el);
  },
};

export default clickable;
