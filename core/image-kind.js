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
    if (hit) return hit;
    try {
      const r = await rateLimiter.execute(() => api._request('GET', '/file/' + fileId));
      const data = (r && r.data) || null;
      const kind = fileKindFromData(data);
      const name = kind === 'model' ? avatarNameFromFileData(data) : '';
      const rec = { kind, name, at: Date.now(), until: Date.now() + positiveTtlMs };
      save(fileId, rec);
      return rec;
    } catch {
      // 404/网络失败 ⇒ 负缓存（6h）：期间按 unknown 处理（回落旧判据），到期自动重试
      const rec = { kind: 'unknown', name: '', miss: true, at: Date.now(), until: Date.now() + unknownTtlMs };
      save(fileId, rec);
      return rec;
    }
  };
}
