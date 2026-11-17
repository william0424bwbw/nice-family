// NICE 家族看板 API（Cloudflare Worker + D1）
// 讀取（GET /api/board）公開；所有寫入都要老師密碼（Authorization: Bearer <ADMIN_TOKEN>）

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  LOGIN_LIMIT?: RateLimit;
}

type Kind = 'daily' | 'exam';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const DAY = 24 * 60 * 60 * 1000;
const TRASH_DAYS = 120;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function isAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(env.ADMIN_TOKEN) && safeEqual(token, env.ADMIN_TOKEN as string);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // 下面統一回錯誤
  }
  throw new HttpError(400, '資料格式不正確');
}

function text(v: unknown, field: string, max: number, required = true): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `請填寫${field}`);
  if (s.length > max) throw new HttpError(400, `${field}最多 ${max} 個字`);
  return s;
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field}不正確`);
  return n;
}

function idParam(s: string): number {
  return int(s, '編號', 1, Number.MAX_SAFE_INTEGER);
}

function httpUrl(v: unknown): string {
  const s = text(v, '相簿連結', 500);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, '相簿連結不是正確的網址');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, '相簿連結必須是 http 或 https 開頭');
  return u.toString();
}

/** 台灣時間的「月/日」 */
function todayLabel(now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(now));
  const m = parts.find(p => p.type === 'month')?.value;
  const d = parts.find(p => p.type === 'day')?.value;
  return `${m}/${d}`;
}

async function studentCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'student_count'").first<{ value: string }>();
  return Number(row?.value) || 25;
}

function audit(db: D1Database, now: number, action: string, detail: unknown): D1PreparedStatement {
  return db.prepare('INSERT INTO audit_log (at, action, detail) VALUES (?, ?, ?)').bind(now, action, JSON.stringify(detail));
}

interface CardRow {
  id: number;
  kind: Kind;
  name: string;
  base_name: string;
  priority: number;
  locked: number;
  created_at: number;
}

async function getBoard(db: D1Database) {
  const [settings, cards, statuses, albums] = await db.batch([
    db.prepare("SELECT value FROM settings WHERE key = 'student_count'"),
    db.prepare(`SELECT id, kind, name, base_name, priority, locked, created_at FROM cards
                WHERE deleted_at IS NULL ORDER BY priority, created_at, id`),
    db.prepare(`SELECT s.card_id, s.seat, s.status FROM card_status s
                JOIN cards c ON c.id = s.card_id WHERE c.deleted_at IS NULL`),
    db.prepare(`SELECT id, icon, name, description, url, created_at FROM albums
                WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC`),
  ]);
  const n = Number((settings.results[0] as { value?: string } | undefined)?.value) || 25;
  const byCard = new Map<number, number[]>();
  for (const c of cards.results as unknown as CardRow[]) byCard.set(c.id, Array(n).fill(0));
  for (const s of statuses.results as { card_id: number; seat: number; status: number }[]) {
    const arr = byCard.get(s.card_id);
    if (arr && s.seat <= n) arr[s.seat - 1] = s.status;
  }
  const out = (kind: Kind) => (cards.results as unknown as CardRow[])
    .filter(c => c.kind === kind)
    .map(c => ({
      id: c.id,
      name: c.name,
      baseName: c.base_name,
      priority: c.priority,
      locked: c.locked === 1,
      createdAt: c.created_at,
      statuses: byCard.get(c.id) as number[],
    }));
  return { studentCount: n, daily: out('daily'), exam: out('exam'), albums: albums.results };
}

async function createCard(db: D1Database, body: Record<string, unknown>, now: number) {
  const kind = body.kind === 'exam' ? 'exam' : body.kind === 'daily' ? 'daily' : null;
  if (!kind) throw new HttpError(400, '卡片種類不正確');
  const priority = body.priority === undefined ? 5 : int(body.priority, '優先順序', 1, 5);
  const defaultDebt = body.defaultDebt === true;
  let name: string;
  let baseName: string;
  if (kind === 'daily') {
    baseName = text(body.baseName, '作業名稱', 30);
    name = `${baseName} ${todayLabel(now)}`;
  } else {
    const subject = text(body.subject, '科目', 10);
    const unit = text(body.unit, '單元', 30);
    baseName = name = `${subject}-${unit}`;
  }

  const dup = await db.prepare(`SELECT id FROM cards WHERE deleted_at IS NULL AND kind = ? AND name = ? AND priority = ?`)
    .bind(kind, name, priority).first();
  if (dup) throw new HttpError(409, `已經有「${name}」而且優先順序相同的卡片`);

  const n = await studentCount(db);
  const statuses: number[] = Array(n).fill(defaultDebt ? 1 : 0);

  // 日常作業：再開同名作業時，上一張沒交的人自動升級（1 → 2，2/3 → 3），上一張卡收起來
  let previous: { id: number; name: string } | null = null;
  if (kind === 'daily') {
    previous = await db.prepare(`SELECT id, name FROM cards WHERE deleted_at IS NULL AND kind = 'daily' AND base_name = ?
                                 ORDER BY created_at DESC, id DESC LIMIT 1`).bind(baseName).first();
    if (previous) {
      const old = await db.prepare('SELECT seat, status FROM card_status WHERE card_id = ?').bind(previous.id)
        .all<{ seat: number; status: number }>();
      for (const r of old.results) {
        if (r.seat > n) continue;
        statuses[r.seat - 1] = r.status === 1 ? 2 : 3;
      }
    }
  }

  // 同一個交易：新增卡片 → 寫入狀態 → 收起上一張 → 紀錄
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO cards (kind, name, base_name, priority, locked, created_at, updated_at)
                VALUES (?, ?, ?, ?, 0, ?, ?)`).bind(kind, name, baseName, priority, now, now),
  ];
  statuses.forEach((s, i) => {
    if (s > 0) {
      stmts.push(db.prepare(`INSERT INTO card_status (card_id, seat, status, updated_at)
                             SELECT MAX(id), ?, ?, ? FROM cards`).bind(i + 1, s, now));
    }
  });
  if (previous) {
    stmts.push(db.prepare(`UPDATE cards SET deleted_at = ?, deleted_reason = 'escalated', updated_at = ?
                           WHERE id = ? AND deleted_at IS NULL`).bind(now, now, previous.id));
  }
  stmts.push(audit(db, now, 'card.create', { kind, name, priority, defaultDebt, previous: previous?.id ?? null }));
  const results = await db.batch(stmts);
  const id = results[0].meta.last_row_id;
  return { id, name, escalatedFrom: previous?.name ?? null };
}

async function setSeat(db: D1Database, cardId: number, seat: number, body: Record<string, unknown>, now: number) {
  const status = int(body.status, '狀態', 0, 3);
  const n = await studentCount(db);
  if (seat < 1 || seat > n) throw new HttpError(400, '座號不正確');
  const card = await db.prepare('SELECT id FROM cards WHERE id = ? AND deleted_at IS NULL').bind(cardId).first();
  if (!card) throw new HttpError(404, '這張卡片已經不在看板上（可能被其他裝置取下了），請重新整理');

  let changed: number;
  if (status === 0) {
    const r = await db.prepare('DELETE FROM card_status WHERE card_id = ? AND seat = ?').bind(cardId, seat).run();
    changed = r.meta.changes;
  } else {
    const r = await db.prepare(`INSERT INTO card_status (card_id, seat, status, updated_at) VALUES (?, ?, ?, ?)
                                ON CONFLICT (card_id, seat) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
                                WHERE card_status.status <> excluded.status`).bind(cardId, seat, status, now).run();
    changed = r.meta.changes;
  }

  // 有人從未完成變成完成，而且全班都完成了 → 卡片自動收起（可以從「復原」找回）
  let removed = false;
  const stmts = [audit(db, now, 'seat.set', { cardId, seat, status })];
  if (status === 0 && changed > 0) {
    stmts.unshift(db.prepare(`UPDATE cards SET deleted_at = ?, deleted_reason = 'completed', updated_at = ?
                              WHERE id = ? AND deleted_at IS NULL
                                AND NOT EXISTS (SELECT 1 FROM card_status WHERE card_id = ?)`)
      .bind(now, now, cardId, cardId));
  }
  if (changed > 0) {
    const results = await db.batch(stmts);
    removed = status === 0 && results[0].meta.changes > 0;
  }
  return { ok: true, status, removed };
}

async function updateCard(db: D1Database, cardId: number, body: Record<string, unknown>, now: number) {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.locked !== undefined) {
    if (typeof body.locked !== 'boolean') throw new HttpError(400, '鎖定狀態不正確');
    sets.push('locked = ?');
    binds.push(body.locked ? 1 : 0);
  }
  if (body.priority !== undefined) {
    sets.push('priority = ?');
    binds.push(int(body.priority, '優先順序', 1, 5));
  }
  if (!sets.length) throw new HttpError(400, '沒有要修改的內容');
  const [r] = await db.batch([
    db.prepare(`UPDATE cards SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .bind(...binds, now, cardId),
    audit(db, now, 'card.update', { cardId, ...body }),
  ]);
  if (!r.meta.changes) throw new HttpError(404, '找不到這張卡片，請重新整理');
  return { ok: true };
}

async function removeCard(db: D1Database, cardId: number, now: number) {
  const [r] = await db.batch([
    db.prepare(`UPDATE cards SET deleted_at = ?, deleted_reason = 'manual', updated_at = ?
                WHERE id = ? AND deleted_at IS NULL`).bind(now, now, cardId),
    audit(db, now, 'card.remove', { cardId }),
  ]);
  if (!r.meta.changes) throw new HttpError(404, '找不到這張卡片，請重新整理');
  return { ok: true };
}

async function clearCards(db: D1Database, body: Record<string, unknown>, now: number) {
  const kind = body.kind === 'exam' ? 'exam' : body.kind === 'daily' ? 'daily' : null;
  if (!kind) throw new HttpError(400, '卡片種類不正確');
  const [r] = await db.batch([
    db.prepare(`UPDATE cards SET deleted_at = ?, deleted_reason = 'clear', updated_at = ?
                WHERE kind = ? AND deleted_at IS NULL`).bind(now, now, kind),
    audit(db, now, 'card.clear', { kind }),
  ]);
  return { ok: true, cleared: r.meta.changes };
}

async function restoreCard(db: D1Database, cardId: number, now: number) {
  const [r] = await db.batch([
    db.prepare(`UPDATE cards SET deleted_at = NULL, deleted_reason = NULL, updated_at = ?
                WHERE id = ? AND deleted_at IS NOT NULL`).bind(now, cardId),
    audit(db, now, 'card.restore', { cardId }),
  ]);
  if (!r.meta.changes) throw new HttpError(404, '找不到可以復原的卡片');
  return { ok: true };
}

async function createAlbum(db: D1Database, body: Record<string, unknown>, now: number) {
  const icon = text(body.icon, '圖示', 8, false) || '📸';
  const name = text(body.name, '相簿標題', 40);
  const description = text(body.description, '相簿簡介', 100, false);
  const url = httpUrl(body.url);
  const [r] = await db.batch([
    db.prepare('INSERT INTO albums (icon, name, description, url, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(icon, name, description, url, now),
    audit(db, now, 'album.create', { name, url }),
  ]);
  return { id: r.meta.last_row_id };
}

async function setAlbumDeleted(db: D1Database, albumId: number, deleted: boolean, now: number) {
  const [r] = await db.batch([
    deleted
      ? db.prepare('UPDATE albums SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now, albumId)
      : db.prepare('UPDATE albums SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').bind(albumId),
    audit(db, now, deleted ? 'album.remove' : 'album.restore', { albumId }),
  ]);
  if (!r.meta.changes) throw new HttpError(404, '找不到這本相簿，請重新整理');
  return { ok: true };
}

async function getTrash(db: D1Database, now: number) {
  const since = now - TRASH_DAYS * DAY;
  const [cards, albums] = await db.batch([
    db.prepare(`SELECT c.id, c.kind, c.name, c.priority, c.deleted_at AS deletedAt, c.deleted_reason AS reason,
                       (SELECT COUNT(*) FROM card_status s WHERE s.card_id = c.id) AS pending
                FROM cards c WHERE c.deleted_at IS NOT NULL AND c.deleted_at > ?
                ORDER BY c.deleted_at DESC, c.id DESC LIMIT 200`).bind(since),
    db.prepare(`SELECT id, icon, name, deleted_at AS deletedAt FROM albums
                WHERE deleted_at IS NOT NULL AND deleted_at > ? ORDER BY deleted_at DESC LIMIT 100`).bind(since),
  ]);
  return { cards: cards.results, albums: albums.results };
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const db = env.DB;
  const now = Date.now();

  if (method === 'GET' && path === '/api/health') return json({ ok: true });
  if (method === 'GET' && path === '/api/board') return json(await getBoard(db));

  // 以下都需要老師密碼
  if (!isAdmin(request, env)) {
    // 有帶密碼但錯誤：計入次數限制，避免被程式猜出密碼
    if (request.headers.has('Authorization') && env.LOGIN_LIMIT) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LOGIN_LIMIT.limit({ key: ip });
      if (!success) throw new HttpError(429, '密碼錯誤太多次，請 1 分鐘後再試');
    }
    throw new HttpError(401, '老師密碼不正確，請重新登入');
  }

  if (method === 'POST' && path === '/api/auth') return json({ ok: true });
  if (method === 'GET' && path === '/api/trash') return json(await getTrash(db, now));
  if (method === 'POST' && path === '/api/cards') return json(await createCard(db, await readBody(request), now), 201);
  if (method === 'POST' && path === '/api/cards/clear') return json(await clearCards(db, await readBody(request), now));

  let m = path.match(/^\/api\/cards\/(\d+)\/seats\/(\d+)$/);
  if (m && method === 'PUT') return json(await setSeat(db, idParam(m[1]), Number(m[2]), await readBody(request), now));

  m = path.match(/^\/api\/cards\/(\d+)\/restore$/);
  if (m && method === 'POST') return json(await restoreCard(db, idParam(m[1]), now));

  m = path.match(/^\/api\/cards\/(\d+)$/);
  if (m && method === 'PATCH') return json(await updateCard(db, idParam(m[1]), await readBody(request), now));
  if (m && method === 'DELETE') return json(await removeCard(db, idParam(m[1]), now));

  if (method === 'POST' && path === '/api/albums') return json(await createAlbum(db, await readBody(request), now), 201);

  m = path.match(/^\/api\/albums\/(\d+)\/restore$/);
  if (m && method === 'POST') return json(await setAlbumDeleted(db, idParam(m[1]), false, now));

  m = path.match(/^\/api\/albums\/(\d+)$/);
  if (m && method === 'DELETE') return json(await setAlbumDeleted(db, idParam(m[1]), true, now));

  throw new HttpError(404, '找不到這個功能');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: '伺服器發生錯誤，請稍後再試' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
