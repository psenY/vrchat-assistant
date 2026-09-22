import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/** 内容 ETag（sha1 前 16 位）——用户 2026-09-22 反馈「无痕打开登录页也要 15 秒」：
 *  页面 1.5MB（gzip 后 ~480KB）且只有 no-cache、无 ETag ⇒ 每次打开都整包重下 ✗；
 *  加 ETag 后浏览器可带 If-None-Match 复验，未变更直接 304 = 零正文 ✓✓。 */
function etagOf(body) {
  return '"' + createHash('sha1').update(body).digest('hex').slice(0, 16) + '"';
}

// 客户端接受 gzip 且 body 足够大时压缩——动态流 JSON ~80KB→~12KB，单文件页面 1.27MB→~300KB（家宽上行显著提速）
function acceptsGzip(res) {
  const enc = (res && res.req && res.req.headers && res.req.headers['accept-encoding']) || '';
  return enc.toLowerCase().split(',').some((t) => t.trim() === 'gzip');
}

export function sendJson(res, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  if (acceptsGzip(res) && body.length > 1024) {
    const gz = gzipSync(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Encoding': 'gzip',
      'Content-Length': gz.length,
    });
    return res.end(gz);
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

export function sendHtml(res, html) {
  const body = Buffer.from(html);
  const tag = etagOf(body);
  const inm = String((res.req && res.req.headers && res.req.headers['if-none-match']) || '');
  if (inm.split(',').map((s) => s.trim()).includes(tag)) {
    res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  if (acceptsGzip(res) && body.length > 1024) {
    const gz = gzipSync(body);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'ETag': tag,
      'Content-Encoding': 'gzip',
      'Content-Length': gz.length,
    });
    return res.end(gz);
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'ETag': tag,
    'Content-Length': body.length,
  });
  res.end(body);
}

export function parseLimit(value, fallback, maximum) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), maximum);
}

export function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { tooLarge = true; body = ''; req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) { reject(new Error('请求体超过上限')); return; }
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('请求体不是有效 JSON')); }
    });
    req.on('error', reject);
  });
}
