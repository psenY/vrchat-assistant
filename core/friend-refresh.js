/**
 * core/friend-refresh.js — 好友列表周期刷新（2026-09-15 用户报障根治）
 *
 * 背景：服务纯 WS 驱动、此前无任何好友列表 API 拉取。好友资料字段（含 trust_level）
 * 只在 WS friend-update 事件到达时更新——等级陈旧后**无自愈**（实测 XIAOFANG小芳已升
 * Trusted User、库内仍停 Known User；事件驱动修复只对她下一次 WS 更新生效）。
 *
 * 本模块周期拉取 GET /auth/user/friends（分页 n=100），做两件事：
 *  ① 回写资料字段（trustLevel/displayName/status/statusDescription/avatarImageUrl/bio/
 *     userIcon/pronouns，**仅非空才写**，partial upsert 永不清空已有值）；
 *  ② 记录 trust_level 变化事件（与 event-pipeline._handleUpdate 同规则：有基线才报，
 *     source='poll'），让「监控不到等级变化」在无 WS 事件时也能闭环。
 * 失败仅 WARN 一行、不抛；限流走 ctx.rateLimiter。
 */
// 信任等级：VRChat 官方展示以 tags 为准（system_trust_*），/auth/user/friends 的
// trust_level 字段可能滞后（2026-09-15 实测：小芳 tags 已含 system_trust_trusted，
// 列表字段仍报 Known User）。故以 tags 推导优先、字段兜底。层级：New < Known < Trusted < Veteran。
const TRUST_FROM_TAG = {
  system_trust_basic: 'New User',
  system_trust_known: 'Known User',
  system_trust_trusted: 'Trusted User',
  system_trust_veteran: 'Veteran User',
};
const TRUST_ORDER = ['New User', 'Known User', 'Trusted User', 'Veteran User'];
export function trustFromTags(tags) {
  if (!Array.isArray(tags)) return '';
  let best = '';
  for (const tag of tags) {
    const v = TRUST_FROM_TAG[tag];
    if (v && (!best || TRUST_ORDER.indexOf(v) > TRUST_ORDER.indexOf(best))) best = v;
  }
  return best;
}

export async function refreshFriendList(ctx, log) {
  const { api, rateLimiter, storage } = ctx;
  if (!api || !rateLimiter || !storage) return;
  const PAGE = 100;
  let offset = 0;
  let total = 0;
  let trustChanged = 0;
  try {
    for (;;) {
      const r = await rateLimiter.execute(() =>
        // offline=true 必须：VRChat 的 /auth/user/friends 默认只返回**在线**好友，
        // 不带该参数会漏掉全部离线好友（首轮实测只拉到 3 位=当前在线数）。
        api._request('GET', `/auth/user/friends?offset=${offset}&n=${PAGE}&offline=true`)
      );
      if (r.status !== 200 || !Array.isArray(r.data)) {
        log(`[警告] 好友列表刷新失败: HTTP ${r.status}`);
        return;
      }
      const page = r.data;
      if (page.length === 0) break;
      for (const u of page) {
        total += 1;
        const prev = storage.getFriend(u.id);
        const trust = trustFromTags(u.tags) || u.trust_level || '';   // tags 优先（见文件头注释）
        // ① trust_level 变化记录（有基线才报，与 _handleUpdate 同规则）
        if (prev && prev.user_id && prev.trust_level && trust && prev.trust_level !== trust) {
          try {
            storage.insertEvent({
              type: 'friend-update',
              userId: u.id,
              displayName: u.displayName || prev.display_name || '',
              contentJson: {
                userId: u.id,
                displayName: u.displayName || prev.display_name || '',
                type: 'trust_level',
                trustLevel: trust,
                previousTrustLevel: prev.trust_level,
              },
              worldId: '',
              worldName: '',
              createdAt: new Date().toISOString(),
              source: 'poll',
            });
            log(`[追踪] 好友等级变化: ${u.displayName || u.id}: ${prev.trust_level} → ${trust}`);
            trustChanged += 1;
          } catch { /* 记录失败不影响刷新 */ }
        }
        // ② 回写资料字段（仅非空，partial upsert 不清空）
        storage.upsertFriend({
          userId: u.id,
          ...(u.displayName ? { displayName: u.displayName } : {}),
          ...(u.status ? { status: u.status } : {}),
          ...(u.statusDescription ? { statusDescription: u.statusDescription } : {}),
          ...(u.currentAvatarImageUrl ? { avatarImageUrl: u.currentAvatarImageUrl } : {}),
          ...(u.bio ? { bio: u.bio } : {}),
          ...(u.userIcon ? { userIcon: u.userIcon } : {}),
          ...(u.pronouns ? { pronouns: u.pronouns } : {}),
          ...(trust ? { trustLevel: trust } : {}),
        });
      }
      // 分页步进：实测该端点**忽略 n=100、每页固定返回 20 个**（页满才继续下一页；
      // 曾用 `page.length < PAGE(100)` 作 break 条件 → 第一页 20 个就停了，漏掉后面好友）。
      // 按实际返回数步进、空页才停：无论端点单页上限是多少都正确。
      offset += page.length;
    }
    log(`[追踪] 好友列表刷新完成: ${total} 位, 等级变化 ${trustChanged} 条`);
  } catch (e) {
    log(`[警告] 好友列表刷新失败: ${e.message}`);
  }
}
