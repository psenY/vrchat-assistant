// events 插件时区口径 + limit 截断的行为断言
// 直接 import 生产代码（plugins/official/events/lib.js），改回旧写法就一定变红：
//   1) RLVRC 的 naive 时间是**北京时间**（api.rlvrc.cn 不带时区标记，官方 iCal 为 TZID=Asia/Shanghai），
//      旧实现把 naive 一律当 UTC ⇒ start_bj/start_local 全部晚 8 小时；
//   2) VRC Search 的 naive 时间**确实是 UTC**（页面 JSON-LD 形如 2026-10-03T13:00:00+00:00），
//      这条口径不能被「按源区分」顺手改成 +8（下面有防回归断言）；
//   3) VRCEve 的 aware(+09:00) 路径完全不走 naive 分支，必须原样不动；
//   4) selectWithinLimit 超限时「未来优先」，不再把未来几天整段挤掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  naiveBaseOffsetH,
  eventTzInfo,
  eventStartMs,
  selectWithinLimit,
} from '../plugins/official/events/lib.js';

const rlvrc = (start) => ({ name: '猜歌交流夜', start, src: 'RLVRC', lang: 'zh', languages: ['中文'] });
const vrcSearch = (start, extra = {}) => ({
  name: 'Event', start, src: 'VRC Search', lang: 'multi', languages: ['中文', '日本語'], ...extra,
});
const vrceve = (start, extra = {}) => ({ name: 'イベント', start, src: 'VRCEve', lang: 'ja', languages: ['日本語'], ...extra });

// ── 1. naive 基准偏移按来源区分 ──────────────────────────────
test('naiveBaseOffsetH：RLVRC=+8（北京时间），VRC Search / 未知源=UTC(0)', () => {
  assert.equal(naiveBaseOffsetH('RLVRC'), 8);
  assert.equal(naiveBaseOffsetH('rlvrc'), 8, '大小写/来源写法差异不该影响判定');
  assert.equal(naiveBaseOffsetH('VRC Search'), 0);
  assert.equal(naiveBaseOffsetH('VRCEve'), 0);
  assert.equal(naiveBaseOffsetH(''), 0);
  assert.equal(naiveBaseOffsetH(undefined), 0, '缺源不得抛错，回落 UTC 口径');
});

// ── 2. RLVRC：北京时间必须原样落在北京列 ─────────────────────
test('RLVRC naive=北京时间：start_bj/start_local 等于原始时间，标签=北京时间/+8', () => {
  // 实测样本：原始 JSON week="星期六" + time="2026-10-03 21:00"（2026-10-03 确为周六）
  // 旧实现的错误输出是 start_bj='10-04 05:00'（晚 8 小时）
  const tz = eventTzInfo(rlvrc('2026-10-03T21:00:00'));
  assert.equal(tz.start_bj, '10-03 21:00');
  assert.equal(tz.start_local, '10-03 21:00');
  assert.equal(tz.tz_label, '北京时间');
  assert.equal(tz.tz_offset, 8);
});

test('RLVRC naive 跨日边界：北京 00:30 不能被推成前一天/后一天', () => {
  const tz = eventTzInfo(rlvrc('2026-10-04 00:30'));
  assert.equal(tz.start_bj, '10-04 00:30');
  assert.equal(tz.start_local, '10-04 00:30');
  assert.equal(tz.tz_label, '北京时间');
});

// ── 3. VRC Search：naive 仍是 UTC 基准（防回归：不能两个源一起改成 +8）──
test('VRC Search naive 仍按 UTC 基准（防回归）', () => {
  // 页面 JSON 里是 2026-10-03T13:00:00+00:00 ⇒ 剥成 naive 后 13:00 是 UTC ⇒ 北京 21:00
  const tz = eventTzInfo(vrcSearch('2026-10-03T13:00:00'));
  assert.equal(tz.start_bj, '10-03 21:00');
  assert.notEqual(tz.start_bj, '10-03 13:00', '把 VRC Search 也当北京时间就会是这个错值');
  // 同一串数字，两个源的口径必须差 8 小时（这条同时钉住「没把两个源一起改掉」）
  const same = '2026-10-03T21:00:00';
  assert.equal(eventTzInfo(vrcSearch(same)).start_bj, '10-04 05:00', 'VRC Search 的 21:00 是 UTC ⇒ 北京次日 05:00');
  assert.equal(eventTzInfo(rlvrc(same)).start_bj, '10-03 21:00', 'RLVRC 的 21:00 是北京 ⇒ 北京仍是 21:00');
});

test('VRC Search 的本地列按社团语言推断（naive=UTC 口径不变）', () => {
  const tz = eventTzInfo(vrcSearch('2026-10-03T13:00:00', { lang: 'ja', languages: ['日本語'] }));
  assert.equal(tz.start_local, '10-03 22:00', 'UTC 13:00 → JST 22:00');
  assert.equal(tz.tz_label, 'JST');
  assert.equal(tz.tz_offset, 9);
});

// ── 4. VRCEve aware(+09:00) 路径不受影响 ────────────────────
test('VRCEve aware +09:00：本地取原字段、北京按 UTC+8、标签 JST', () => {
  const tz = eventTzInfo(vrceve('2026-10-03T21:00:00+09:00'));
  assert.equal(tz.start_local, '10-03 21:00');
  assert.equal(tz.start_bj, '10-03 20:00', 'JST 21:00 = UTC 12:00 ⇒ 北京 20:00');
  assert.equal(tz.tz_label, 'JST');
  assert.equal(tz.tz_offset, 9);
});

test('VRCEve 的 Korea/Seoul 时区字段仍优先判 KST（未受 naive 改动波及）', () => {
  const tz = eventTzInfo(vrceve('2026-10-03T21:00:00+09:00', { time_zone: 'Asia/Seoul', lang: 'ko' }));
  assert.equal(tz.tz_label, 'KST');
  assert.equal(tz.start_bj, '10-03 20:00');
});

test('缺 start / 脏时间串返回空结构，不抛错', () => {
  assert.deepEqual(eventTzInfo({ src: 'RLVRC' }), { start_local: '', start_bj: '', tz_label: '', tz_offset: 0 });
  assert.deepEqual(eventTzInfo({ start: 'not-a-date', src: 'RLVRC' }), { start_local: '', start_bj: '', tz_label: '', tz_offset: 0 });
});

// ── 5. eventStartMs 与 eventTzInfo 同口径 ──────────────────
test('eventStartMs：naive 按源还原 UTC，aware 用自带偏移', () => {
  assert.equal(eventStartMs(rlvrc('2026-10-03T21:00:00')), Date.parse('2026-10-03T13:00:00Z'));
  assert.equal(eventStartMs(vrcSearch('2026-10-03T13:00:00')), Date.parse('2026-10-03T13:00:00Z'));
  assert.equal(eventStartMs(vrceve('2026-10-03T21:00:00+09:00')), Date.parse('2026-10-03T12:00:00Z'));
  assert.ok(Number.isNaN(eventStartMs({ src: 'RLVRC' })), '无 start ⇒ NaN（由调用方按「未开始」保留）');
});

// ── 6. selectWithinLimit 截断语义 ──────────────────────────
const NOW = Date.parse('2026-10-03T12:00:00Z');
const ev = (name, startIso, extra = {}) => ({ name, start: startIso, src: 'VRC Search', ...extra });

test('不超限：原样返回、顺序不变、truncated=false', () => {
  const list = [ev('a', '2026-10-09T10:00:00'), ev('b', '2026-10-01T10:00:00'), ev('c', '2026-10-05T10:00:00')];
  const r = selectWithinLimit(list, 3, NOW);
  assert.deepEqual(r.picked.map(e => e.name), ['a', 'b', 'c'], '顺序必须与入参一致（不重排）');
  assert.equal(r.truncated, false);
  assert.equal(r.dropped, 0);
});

test('超限：未来事件不被挤掉（旧 slice(0,limit) 会只留最早的一批）', () => {
  // 构造「按现有顺序（群组人数降序）里未来与过去交错」的最坏情况
  const list = [];
  for (let i = 0; i < 10; i++) list.push(ev(`past-${i}`, '2026-10-01T10:00:00'));
  list.push(ev('future-1', '2026-10-10T10:00:00'));
  list.push(ev('future-2', '2026-10-11T10:00:00'));
  const r = selectWithinLimit(list, 2, NOW);
  assert.deepEqual(r.picked.map(e => e.name), ['future-1', 'future-2'], '未来优先 ⇒ 两条未来都在');
  assert.equal(r.truncated, true);
  assert.equal(r.dropped, 10);
});

test('刚开始 30 分钟内算「进行中」，不当过去事件挤掉', () => {
  const justStarted = ev('live', '2026-10-03T11:40:00');   // UTC 11:40，NOW=12:00 ⇒ 开始 20 分钟
  const oldPast = ev('old', '2026-10-03T01:00:00');
  const r = selectWithinLimit([oldPast, justStarted], 1, NOW);
  assert.deepEqual(r.picked.map(e => e.name), ['live']);
});

test('全过去事件：按 start 降序取最近的补齐', () => {
  const list = [ev('d3', '2026-10-01T10:00:00'), ev('d1', '2026-09-28T10:00:00'), ev('d2', '2026-09-30T10:00:00')];
  const r = selectWithinLimit(list, 2, NOW);
  assert.deepEqual(r.picked.map(e => e.name), ['d3', 'd2'], '最近的过去事件排前面');
  assert.equal(r.dropped, 1);
});

test('未来不足额时用最近过去事件补齐到 limit', () => {
  const list = [
    ev('p-old', '2026-09-20T10:00:00'),
    ev('f', '2026-10-10T10:00:00'),
    ev('p-near', '2026-10-02T10:00:00'),
    ev('p-mid', '2026-10-01T10:00:00'),
  ];
  const r = selectWithinLimit(list, 3, NOW);
  assert.deepEqual(r.picked.map(e => e.name), ['f', 'p-near', 'p-mid'], '未来在前，过去按近→远补齐');
  assert.equal(r.truncated, true);
  assert.equal(r.dropped, 1);
});

test('边界：空数组 / limit=1 / 恰好等于 limit', () => {
  assert.deepEqual(selectWithinLimit([], 200, NOW), { picked: [], truncated: false, dropped: 0 });
  const two = [ev('a', '2026-10-10T10:00:00'), ev('b', '2026-10-01T10:00:00')];
  assert.deepEqual(selectWithinLimit(two, 1, NOW).picked.map(e => e.name), ['a'], 'limit=1 留未来那条');
  assert.deepEqual(selectWithinLimit(two, 2, NOW).picked.map(e => e.name), ['a', 'b'], '恰好等于 limit ⇒ 原样（顺序不变）');
  assert.equal(selectWithinLimit(two, 2, NOW).truncated, false);
});

test('无 start 的活动按「未开始」保留，不被静默丢弃', () => {
  const list = [ev('undated', ''), ev('past', '2026-10-01T10:00:00')];
  const r = selectWithinLimit(list, 1, NOW);
  assert.deepEqual(r.picked.map(e => e.name), ['undated']);
});

test('limit 非法值回落 1（不会因 NaN 把结果清空）', () => {
  const list = [ev('a', '2026-10-10T10:00:00'), ev('b', '2026-10-11T10:00:00')];
  assert.equal(selectWithinLimit(list, undefined, NOW).picked.length, 1);
  assert.equal(selectWithinLimit(list, 0, NOW).picked.length, 1);
  assert.equal(selectWithinLimit(list, 'abc', NOW).picked.length, 1);
});

// ── 7. 脏串 / aware 解析失败：不得静默丢时间列（审查 ⚠️1 回归）──────
// 旧写法 /[zZ]/ 未锚定：`2026-10-03 13:00 zzz` 被判成 aware ⇒ Date.parse 失败 ⇒ 三列全空。
test('含 z 的脏串不再被误判 aware：回落 naive，时间列不空（审查 ⚠️1）', () => {
  const tz = eventTzInfo(vrcSearch('2026-10-03 13:00 zzz'));
  assert.notEqual(tz.start_bj, '', '不得静默丢时间列');
  assert.notEqual(tz.start_local, '', '不得静默丢时间列');
  assert.notEqual(tz.tz_label, '', '不得静默丢时区标签');
  assert.equal(tz.start_bj, '10-03 21:00', 'VRC Search naive=UTC ⇒ 北京 21:00');
  // RLVRC 的脏串仍按北京时间基准
  assert.equal(eventTzInfo(rlvrc('2026-10-03 21:00 zzz')).start_bj, '10-03 21:00');
});

test('尾随 Z 仍按 aware(UTC) 解析（锚定 Z 不得误伤正常输入）', () => {
  const tz = eventTzInfo(vrcSearch('2026-10-03T13:00:00Z'));
  assert.equal(tz.start_bj, '10-03 21:00');
  assert.equal(tz.tz_label, 'UTC');
  assert.equal(tz.tz_offset, 0);
  // +09:00 的 aware（VRCEve）同样不受影响
  assert.equal(eventTzInfo(vrceve('2026-10-03T21:00:00+09:00')).start_bj, '10-03 20:00');
});

test('aware 形态但偏移非法（+99:99）⇒ 回落 naive，不丢列', () => {
  const tz = eventTzInfo(vrcSearch('2026-10-03T13:00:00+99:99'));
  assert.equal(tz.start_bj, '10-03 21:00');
  assert.notEqual(tz.start_local, '');
});

test('eventStartMs 同样容错（脏串/坏偏移不再 NaN）', () => {
  assert.equal(eventStartMs(vrcSearch('2026-10-03 13:00 zzz')), Date.parse('2026-10-03T13:00:00Z'));
  assert.equal(eventStartMs(rlvrc('2026-10-03 21:00 zzz')), Date.parse('2026-10-03T13:00:00Z'));
  assert.equal(eventStartMs(vrcSearch('2026-10-03T13:00:00+99:99')), Date.parse('2026-10-03T13:00:00Z'));
  assert.ok(Number.isNaN(eventStartMs(vrcSearch('乱码没时间'))), '取不到前导时间戳才 NaN');
});
