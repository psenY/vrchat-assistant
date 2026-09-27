/**
 * core/image-kind.js —— "这张图是用户图标还是模型图"的解析器（2026-09-27）
 *
 * 判据（用户用 VRCX-Luo 纠正后定案，并在生产上正反样本各 4 例实测 ✓）：
 *   取该图的 fileId → GET /file/{id} → **tags 含 icon ⇒ 用户图标**；否则按模型图。
 * 权威实现：yixijun/VRCX-Luo src/coordinators/avatarCoordinator.js:255 getAvatarName()
 *   （getFile({fileId}) → args.json?.tags?.includes('icon') ⇒ 返回空、不记 Avatar；否则按模型图）
 * ⚠️ 不要用文件名当判据（命名约定、且要额外请求），也不要用 bannerType（只覆盖 avatarBanner 一档）。
 *
 * 本模块只做「查一次 + 内存缓存 + planet_cache 落盘 + 失败负缓存」，可在 event-pipeline 的分类路径里 await：
 * 命中缓存零成本；未命中时过一次限流器（与其它外部调用同源留痕）。
 */
import { fileKindFromData, avatarNameFromFileData } from './img-util.js';

export function createImageKindResolver({ storage, api, rateLimiter, positiveTtlMs = 30 * 24 * 3600e3, unknownTtlMs = 6 * 3600e3 } = {}) {
  // ⚠️2（审查 nixi-agent 指出）：负缓存命中 / 判不出 / 请求失败都是【降级路径】，此前完全无留痕 ✗。
  //   本仓约定「禁静默降级」——但逐条打日志会被热路径刷屏，故按「条数 or 时间窗」聚合一行 ✓。
  const stat = { negHit: 0, unknown: 0, fail: 0 };
  let lastFlush = Date.now();
  const flushStat = (force) => {
    const n = stat.negHit + stat.unknown + stat.fail;
    if (!n) return;
    if (!force && n < 50 && Date.now() - lastFlush < 10 * 60e3) return;
    try { console.log(`[image-kind] 降级聚合：负缓存命中 ${stat.negHit} · 判不出 ${stat.unknown} · 请求失败 ${stat.fail}（窗口 ${Math.round((Date.now() - lastFlush) / 1000)}s）`); } catch { /* 日志失败忽略 */ }
    stat.negHit = 0; stat.unknown = 0; stat.fail = 0; lastFlush = Date.now();
  };
  const mem = new Map();   // fileId -> { kind, name, until }
  let loaded = false;

  const loadOnce = () => {
    if (loaded) return;
    loaded = true;
    try {
      for (const row of storage.query("SELECT key, payload FROM planet_cache WHERE key LIKE 'file_kind:%'")) {
        const fid = String(row.key).slice('file_kind:'.length);
        try {
          const v = JSON.parse(row.payload);
          if (v && v.kind && (!v.until || v.until > Date.now())) mem.set(fid, v);
        } catch { /* 单条坏数据忽略 */ }
      }
    } catch { /* 无表/查询失败则仅用内存缓存 */ }
  };

  const save = (fileId, rec) => {
    mem.set(fileId, rec);
    try { storage.setPlanetCache('file_kind:' + fileId, rec); } catch { /* 落盘失败不影响判定 */ }
  };

  return async function resolveImageKind(fileId) {
    if (!fileId) return { kind: 'unknown', name: '' };
    loadOnce();
    const hit = mem.get(fileId);
    // 💡1（审查 nixi-agent 指出）：内存缓存此前不看 until ⇒ 6h 负缓存在进程生命周期内永不过期
    //   （注释里的「到期自动重试」只在重启后成立）。这里补上到期判断，并计入降级统计。
    flushStat(false);
    if (hit) {
      if (!hit.until || hit.until > Date.now()) { if (hit.miss || hit.kind === 'unknown') stat.negHit++; return hit; }
      mem.delete(fileId);   // 过期 ⇒ 落回后端重查 ✓
    }
    try {
      const r = await rateLimiter.execute(() => api._request('GET', '/file/' + fileId));
      const data = (r && r.data) || null;
      const kind = fileKindFromData(data);
      const name = kind === 'model' ? avatarNameFromFileData(data) : '';
      // 💡2（审查指出）：HTTP 200 但判不出种类（unknown）不该吃 30 天正缓存 ⇒ 与失败路径同款 6h ✓
      const ttl = kind === 'unknown' ? unknownTtlMs : positiveTtlMs;
      const rec = { kind, name, at: Date.now(), until: Date.now() + ttl };
      if (kind === 'unknown') stat.unknown++;
      save(fileId, rec);
      return rec;
    } catch {
      // 404/网络失败 ⇒ 负缓存（6h）：期间按 unknown 处理（回落旧判据），到期自动重试
      stat.fail++;
      const rec = { kind: 'unknown', name: '', miss: true, at: Date.now(), until: Date.now() + unknownTtlMs };
      save(fileId, rec);
      return rec;
    }
  };
}
