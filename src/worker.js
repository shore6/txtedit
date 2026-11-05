import { isValidPath } from '../public/path.js';

const MAX_CONTENT_BYTES = 1_000_000; // D1 の行サイズ上限 (2MB) より十分小さく
const MAX_BODY_BYTES = 1_200_000;
const PAGE_ROWS = 200;
const PAGE_BYTES = 4_000_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NEXT_SEQ = '(SELECT COALESCE(MAX(seq), 0) + 1 FROM files)';
const COLS = 'id, path, content, version, seq, deleted, updated_at';
const META_COLS = 'id, path, version, seq, deleted, updated_at';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const denied = await checkAuth(req, env);
      if (denied) return denied;
      return await route(req, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error' }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function checkAuth(req, env) {
  if (!env.AUTH_TOKEN) return json({ error: 'not_configured' }, 500);
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return json({ error: 'unauthorized' }, 401);
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(m[1])),
    crypto.subtle.digest('SHA-256', enc.encode(env.AUTH_TOKEN)),
  ]);
  if (!crypto.subtle.timingSafeEqual(a, b)) return json({ error: 'unauthorized' }, 401);
  return null;
}

async function route(req, env, url) {
  const p = url.pathname;
  if (p === '/api/ping' && req.method === 'GET') return json({ ok: true });
  if (p === '/api/changes' && req.method === 'GET') return changes(env, url);

  const m = p.match(/^\/api\/files\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) return json({ error: 'bad_id' }, 400);
    if (req.method === 'PUT') return putFile(req, env, id);
    if (req.method === 'DELETE') return deleteFile(env, url, id);
  }
  return json({ error: 'not_found' }, 404);
}

// seq より新しい変更 (削除含む) を返す。クライアントは more=false になるまで繰り返す
async function changes(env, url) {
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM files WHERE seq > ? ORDER BY seq LIMIT ?`)
    .bind(since, PAGE_ROWS + 1)
    .all();
  const files = [];
  let bytes = 0;
  let more = results.length > PAGE_ROWS;
  for (const r of results.slice(0, PAGE_ROWS)) {
    bytes += r.content.length * 3;
    if (files.length > 0 && bytes > PAGE_BYTES) {
      more = true;
      break;
    }
    files.push(r);
  }
  const seq = files.length ? files[files.length - 1].seq : since;
  return json({ files, seq, more });
}

async function putFile(req, env, id) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  const { path, content, baseVersion } = body || {};
  if (!isValidPath(path)) return json({ error: 'bad_path' }, 400);
  if (typeof content !== 'string') return json({ error: 'bad_content' }, 400);
  if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) return json({ error: 'too_large' }, 413);
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return json({ error: 'bad_version' }, 400);

  const now = Date.now();
  let r;
  try {
    if (baseVersion === 0) {
      r = await env.DB.prepare(
        `INSERT INTO files (id, path, content, version, seq, deleted, updated_at)
         VALUES (?, ?, ?, 1, ${NEXT_SEQ}, 0, ?) ON CONFLICT(id) DO NOTHING`,
      )
        .bind(id, path, content, now)
        .run();
    } else {
      // version が一致したときだけ更新 (楽観ロック)。削除済みでも一致すれば復元
      r = await env.DB.prepare(
        `UPDATE files SET path = ?, content = ?, version = version + 1, seq = ${NEXT_SEQ},
           deleted = 0, updated_at = ? WHERE id = ? AND version = ?`,
      )
        .bind(path, content, now, id, baseVersion)
        .run();
    }
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return json({ error: 'path_taken' }, 409);
    throw e;
  }
  if (r.meta.changes === 0) return conflict(env, id);
  const file = await env.DB.prepare(`SELECT ${META_COLS} FROM files WHERE id = ?`).bind(id).first();
  return json({ file });
}

async function deleteFile(env, url, id) {
  const baseVersion = parseInt(url.searchParams.get('baseVersion') || '', 10);
  if (!Number.isInteger(baseVersion) || baseVersion < 1) return json({ error: 'bad_version' }, 400);
  const r = await env.DB.prepare(
    `UPDATE files SET deleted = 1, content = '', version = version + 1, seq = ${NEXT_SEQ}, updated_at = ?
     WHERE id = ? AND version = ? AND deleted = 0`,
  )
    .bind(Date.now(), id, baseVersion)
    .run();
  if (r.meta.changes === 0) {
    const cur = await env.DB.prepare(`SELECT ${COLS} FROM files WHERE id = ?`).bind(id).first();
    if (!cur || cur.deleted) return json({ file: cur }); // 既に消えている
    return json({ error: 'conflict', file: cur }, 409);
  }
  const file = await env.DB.prepare(`SELECT ${META_COLS} FROM files WHERE id = ?`).bind(id).first();
  return json({ file });
}

async function conflict(env, id) {
  const file = await env.DB.prepare(`SELECT ${COLS} FROM files WHERE id = ?`).bind(id).first();
  return json({ error: 'conflict', file: file || null }, 409);
}
