// @vitest-environment happy-dom
// 2026-09-22：挂载测试需要 DOM ⇒ 用文件级指令开 happy-dom（不改全局 vite.config，改动面最小 ✓）
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';

// 2026-09-22 新增：**挂载级**回归护栏
// 起因：今晚连续出现「模板里用了不存在的函数」✗（openDetail / startSse / getToken）与
// 「某视图挂载即抛错 ⇒ 整块空白」✗ —— 而当时 44 个纯函数测试 + 构建全绿，什么都没拦住 ✗。
// 这里把关键视图**真的挂起来**并断言渲染出关键文案：构建通过 ≠ 能渲染 ✓。
// ⚠️ vi.mock 会被提升到文件顶部，工厂里不能引用外部变量 ⇒ stub 写在工厂内部 ✓。
vi.mock('./store.js', () => ({
  store: {
    friends: [], feedEvents: [], feedHasMore: false, feedMoreError: '', loadError: '',
    userModal: null, previewUrl: '', tracked: [], worlds: [], loading: false, authed: true,
    trackedList: [], overview: null,
    // FeedView 读这些筛选态（我第一版桩少写了 feedFilter ⇒ 报错 ✗ —— 那是桩的问题，不是组件 bug ✓）
    // 字段名照 store.js 的真实初值写（feedSearch 不是 feedQuery —— 上次写错名 ⇒ trim of undefined ✗）
    feedFilter: [], feedSearch: '', feedDateFrom: '', feedDateTo: '', feedOnlyFav: false,
    feedLoading: false, feedLoadingMore: false, feedOwner: '', feedKind: 'all', feedDays: 0,
    stats: null, total: 0, eventsRange: [], watchlist: [], favorites: [], nicknames: {},
  },
  closeUser: () => {}, openWorld: () => {}, openGroup: () => {}, copyText: () => {},
  openPreview: () => {}, toggleWatch: () => {}, startDashboard: () => {}, consume: () => {},
  loadMore: () => {}, load: () => {},
}));
vi.mock('./api.js', () => ({
  get: async () => [], post: async () => ({ ok: true }), getToken: () => 'test-token',
  openSse: () => {}, consume: async () => ({}),
}));

import TrackedView from './views/TrackedView.vue';
import FriendsView from './views/FriendsView.vue';
import UserDialog from './components/UserDialog.vue';

const mountOpts = { global: { stubs: { Teleport: true, Transition: true, TransitionGroup: true } } };

describe('视图挂载护栏（挂载即渲染，不允许静默空白）', () => {
  const cases = [
    ['TrackedView', TrackedView, ['非好友追踪']],
    ['FriendsView', FriendsView, ['好友']],
    // FeedView 的模板依赖较多 store 字段（本轮桩不够）；先不覆盖，避免'为了让它绿'把桩写成假实现 ✓
    // ['FeedView', FeedView, ['动态']],
  ];
  for (const [name, Comp, expects] of cases) {
    it(name + ' 挂载后能看到关键文案（不是空白）', async () => {
      const w = mount(Comp, mountOpts);
      await new Promise((r) => setTimeout(r, 40));
      const text = w.text();
      expect(text.length, name + ' 渲染为空 —— 这正是今晚的故障形态').toBeGreaterThan(0);
      for (const e of expects) expect(text, name + ' 缺少关键文案: ' + e).toContain(e);
      w.unmount();
    });
  }
  it('UserDialog 可挂载且不抛错', async () => {
    const w = mount(UserDialog, { global: { stubs: { Teleport: true } } });
    await new Promise((r) => setTimeout(r, 30));
    expect(typeof w.text()).toBe('string');
    w.unmount();
  });
});
