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
        api._request('GET', `/auth/user/friends?offset=${offset}&n=${PAGE}`)
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
        // ① trust_level 变化记录（有基线才报，与 _handleUpdate 同规则）
        if (prev && prev.user_id && prev.trust_level && u.trust_level && prev.trust_level !== u.trust_level) {
          try {
            storage.insertEvent({
              type: 'friend-update',
              userId: u.id,
              displayName: u.displayName || prev.display_name || '',
              contentJson: {
                userId: u.id,
                displayName: u.displayName || prev.display_name || '',
                type: 'trust_level',
                trustLevel: u.trust_level,
                previousTrustLevel: prev.trust_level,
              },
              worldId: '',
              worldName: '',
              createdAt: new Date().toISOString(),
              source: 'poll',
            });
            log(`[追踪] 好友等级变化: ${u.displayName || u.id}: ${prev.trust_level} → ${u.trust_level}`);
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
          ...(u.trust_level ? { trustLevel: u.trust_level } : {}),
        });
      }
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    log(`[追踪] 好友列表刷新完成: ${total} 位, 等级变化 ${trustChanged} 条`);
  } catch (e) {
    log(`[警告] 好友列表刷新失败: ${e.message}`);
  }
}
