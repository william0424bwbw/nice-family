// NICE 家族看板 API（Cloudflare Worker + D1）
// 讀取（GET /api/board）公開；寫入要密碼（Authorization: Bearer <密碼>）
//   老師（ADMIN_TOKEN）：所有功能
//   小秘書（accounts 資料表）：新增卡片、把狀態往上調（登記沒交）、取消自己 5 分鐘內的登記
//   協同老師（accounts.role = 'teacher'，例如導師二）：老師權限，但不能管理帳號

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
}

type Kind = 'daily' | 'exam';
type Role = 'teacher' | 'helper';
interface Actor {
  role: Role;
  name: string;
  short: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const TRASH_DAYS = 120;
const UNDO_MS = 5 * MINUTE;            // 小秘書可以取消自己幾分鐘內的登記
const TEACHER: Actor = { role: 'teacher', name: '老師', short: '師' };
// 密碼錯誤限制：同一個 IP 10 分鐘內錯 10 次，或全部加起來錯 100 次，就先擋下所有登入（連正確密碼也擋）
const FAIL_WINDOW = 10 * MINUTE;
const FAIL_PER_IP = 10;
const FAIL_TOTAL = 100;

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

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomDigits(n: number): string {
  const a = crypto.getRandomValues(new Uint32Array(n));
  return [...a].map(x => String(x % 10)).join('');
}

function randomSalt(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 依 Authorization 判斷身分。沒帶密碼 → null；密碼錯誤 → 記錄失敗並丟出 401／429。
 */
async function authenticate(request: Request, env: Env, now: number): Promise<Actor | null> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth) return null;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const db = env.DB;
  const ip = request.headers.get('CF-Connecting-IP') || 'local';

  // 先檢查是否已經錯太多次（在比對密碼之前，猜對也一樣擋下）
  const since = now - FAIL_WINDOW;
  const fails = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM auth_failures WHERE ip = ? AND at > ?) AS mine,
      (SELECT COUNT(*) FROM auth_failures WHERE at > ?) AS total`).bind(ip, since, since)
    .first<{ mine: number; total: number }>();
  if (fails && (fails.mine >= FAIL_PER_IP || fails.total >= FAIL_TOTAL)) {
    throw new HttpError(429, '密碼錯誤太多次，請 10 分鐘後再試');
  }

  if (token && env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) return TEACHER;
  if (token) {
    const accounts = await db.prepare('SELECT name, short, role, salt, password_hash FROM accounts WHERE active = 1')
      .all<{ name: string; short: string; role: string; salt: string; password_hash: string }>();
    for (const a of accounts.results) {
      if (safeEqual(await sha256(a.salt + token), a.password_hash)) return { role: a.role === 'teacher' ? 'teacher' : 'helper', name: a.name, short: a.short };
    }
  }

  await db.batch([
    db.prepare('INSERT INTO auth_failures (ip, at) VALUES (?, ?)').bind(ip, now),
    db.prepare('DELETE FROM auth_failures WHERE at < ?').bind(now - DAY),
  ]);
  throw new HttpError(401, '密碼不正確，請重新登入');
}

function requireActor(actor: Actor | null): Actor {
  if (!actor) throw new HttpError(401, '請先登入');
  return actor;
}

function requireTeacher(actor: Actor | null): Actor {
  const a = requireActor(actor);
  if (a.role !== 'teacher') throw new HttpError(403, '這個功能只有老師可以使用');
  return a;
}

// 帳號管理只有大熊老師（ADMIN_TOKEN）可以，協同老師不行
function requireOwner(actor: Actor | null): Actor {
  const a = requireTeacher(actor);
  if (a !== TEACHER) throw new HttpError(403, '帳號管理只有大熊老師可以使用');
  return a;
}

function roleParam(v: unknown): 'helper' | 'teacher' {
  if (v === undefined || v === 'helper') return 'helper';
  if (v === 'teacher') return 'teacher';
  throw new HttpError(400, '權限不正確');
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
  if ([...s].length > max) throw new HttpError(400, `${field}最多 ${max} 個字`);
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

function audit(db: D1Database, now: number, actor: Actor, action: string, detail: Record<string, unknown>): D1PreparedStatement {
  return db.prepare('INSERT INTO audit_log (at, action, detail) VALUES (?, ?, ?)')
    .bind(now, action, JSON.stringify({ by: actor.name, ...detail }));
}

interface CardRow {
  id: number;
  kind: Kind;
  name: string;
  base_name: string;
  priority: number;
  locked: number;
  created_at: number;
  created_by: string | null;
  track: Track | null;
}

type Track = 'chinese' | 'math';
function trackParam(v: unknown): Track | null {
  if (v === undefined || v === null || v === '' || v === 'auto') return null;
  if (v === 'chinese' || v === 'math') return v;
  throw new HttpError(400, '分類不正確');
}

async function getBoard(db: D1Database, actor: Actor | null) {
  const [settings, cards, statuses, albums, accounts] = await db.batch([
    db.prepare("SELECT value FROM settings WHERE key = 'student_count'"),
    db.prepare(`SELECT id, kind, name, base_name, priority, locked, created_at, created_by, track FROM cards
                WHERE deleted_at IS NULL ORDER BY sort_order IS NULL, sort_order, priority, created_at, id`),
    db.prepare(`SELECT s.card_id, s.seat, s.status, s.updated_by, s.updated_at, s.carried FROM card_status s
                JOIN cards c ON c.id = s.card_id WHERE c.deleted_at IS NULL`),
    db.prepare(`SELECT id, icon, name, description, url, created_at FROM albums
                WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC`),
    db.prepare('SELECT name, short FROM accounts'),
  ]);
  const n = Number((settings.results[0] as { value?: string } | undefined)?.value) || 25;
  const shortOf = new Map<string, string>([[TEACHER.name, TEACHER.short]]);
  for (const a of accounts.results as { name: string; short: string }[]) shortOf.set(a.name, a.short);

  const byCard = new Map<number, { statuses: number[]; carried: Record<string, number>; marks: Record<string, { by: string; short: string; at: number }> }>();
  for (const c of cards.results as unknown as CardRow[]) byCard.set(c.id, { statuses: Array(n).fill(0), carried: {}, marks: {} });
  for (const s of statuses.results as { card_id: number; seat: number; status: number; updated_by: string | null; updated_at: number; carried: number }[]) {
    const entry = byCard.get(s.card_id);
    if (!entry || s.seat > n) continue;
    entry.statuses[s.seat - 1] = s.status;
    if (s.carried > 0) entry.carried[String(s.seat)] = s.carried;
    if (s.updated_by) entry.marks[String(s.seat)] = { by: s.updated_by, short: shortOf.get(s.updated_by) || s.updated_by.slice(-1), at: s.updated_at };
  }
  const out = (kind: Kind) => (cards.results as unknown as CardRow[])
    .filter(c => c.kind === kind)
    .map(c => {
      const e = byCard.get(c.id)!;
      const card: Record<string, unknown> = {
        id: c.id,
        name: c.name,
        baseName: c.base_name,
        priority: c.priority,
        locked: c.locked === 1,
        createdAt: c.created_at,
        statuses: e.statuses,
      };
      // 沒設定分類的卡片不帶這個欄位（由前端依名稱自動判斷）
      if (c.track) card.track = c.track;
      // 併進來的舊欠交（骷髏標記用），沒有就不帶
      if (Object.keys(e.carried).length) card.carried = e.carried;
      // 誰登記的：只給登入的人看（家長畫面不顯示秘書名字）
      if (actor) {
        card.createdBy = c.created_by;
        card.marks = e.marks;
      }
      return card;
    });
  return {
    studentCount: n,
    undoMs: UNDO_MS,
    me: actor,
    daily: out('daily'),
    exam: out('exam'),
    albums: albums.results,
  };
}

async function createCard(db: D1Database, actor: Actor, body: Record<string, unknown>, now: number) {
  const kind = body.kind === 'exam' ? 'exam' : body.kind === 'daily' ? 'daily' : null;
  if (!kind) throw new HttpError(400, '卡片種類不正確');
  const priority = body.priority === undefined ? 5 : int(body.priority, '優先順序', 1, 5);
  const defaultDebt = body.defaultDebt === true;
  let track = trackParam(body.track);
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

const n = await studentCount(db);
  const statuses: number[] = Array(n).fill(defaultDebt ? 1 : 0);
  const carried: number[] = Array(n).fill(0);

  // 看板上同名的舊卡
  const siblings = (await db.prepare(`SELECT id, name, sort_order FROM cards
      WHERE deleted_at IS NULL AND kind = ? AND base_name = ? ORDER BY created_at DESC, id DESC`).bind(kind, baseName)
    .all<{ id: number; name: string; sort_order: number | null }>()).results;
  if (kind === 'exam' && siblings.some(c => c.name === name)) throw new HttpError(409, `已經有「${name}」了`);

  // 同一天再開同名作業：名稱加上 ②、③…（包含今天已經被併掉的卡片名稱）
  const recent = await db.prepare('SELECT name FROM cards WHERE kind = ? AND base_name = ? AND created_at > ?')
    .bind(kind, baseName, now - 2 * DAY).all<{ name: string }>();
  const used = new Set(recent.results.map(c => c.name));
  if (used.has(name)) {
    let k = 2;
    while (k <= 20 && used.has(`${name} ${String.fromCharCode(0x245f + k)}`)) k++;
    if (k > 20) throw new HttpError(409, `「${name}」開太多張了`);
    name = `${name} ${String.fromCharCode(0x245f + k)}`;
  }

  // 日常作業：舊卡沒交的人併進新卡（1 → 2，2/3 → 3），併進來幾份記在 carried，舊卡收起來
  let merged = 0;
  if (kind === 'daily' && siblings.length) {
    const ids = siblings.map(c => c.id);
    const old = await db.prepare(`SELECT seat, status, carried FROM card_status
        WHERE card_id IN (${ids.map(() => '?').join(',')}) AND status > 0`).bind(...ids)
      .all<{ seat: number; status: number; carried: number }>();
    for (const r of old.results) {
      if (r.seat > n) continue;
      const i = r.seat - 1;
      statuses[i] = Math.max(statuses[i], r.status === 1 ? 2 : 3);
      carried[i] += 1 + (r.carried || 0);
    }
    merged = carried.filter(c => c > 0).length;
  }

  // 沒指定分類：沿用最近一張同名卡片的分類（包含已收起的）
  if (!track) {
    const last = await db.prepare(`SELECT track FROM cards WHERE kind = ? AND base_name = ? AND track IS NOT NULL
                                   ORDER BY created_at DESC, id DESC LIMIT 1`).bind(kind, baseName).first<{ track: Track }>();
    track = last?.track ?? null;
  }
  // 新卡片放在上一張的位置
  const sortOrder = siblings[0]?.sort_order ?? null;

  // 同一個交易：新增卡片 → 寫入狀態 → 收起舊卡 → 紀錄
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO cards (kind, name, base_name, priority, locked, created_at, updated_at, created_by, track, sort_order)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).bind(kind, name, baseName, priority, now, now, actor.name, track, sortOrder),
  ];
  statuses.forEach((st, i) => {
    if (st > 0) {
      // 併進來的欠交：prev_status 設成目前狀態，秘書「取消」時不會把舊的欠交一起取消
      const prev = carried[i] > 0 ? st : 0;
      stmts.push(db.prepare(`INSERT INTO card_status (card_id, seat, status, updated_at, updated_by, prev_status, carried)
                             SELECT MAX(id), ?, ?, ?, ?, ?, ? FROM cards`).bind(i + 1, st, now, actor.name, prev, carried[i]));
    }
  });
  if (kind === 'daily') {
    for (const c of siblings) {
      stmts.push(db.prepare(`UPDATE cards SET deleted_at = ?, deleted_reason = 'escalated', updated_at = ?
                             WHERE id = ? AND deleted_at IS NULL`).bind(now, now, c.id));
    }
  }
  const previous = kind === 'daily' ? siblings.map(c => c.id) : [];
  stmts.push(audit(db, now, actor, 'card.create', { kind, name, priority, track, defaultDebt, previous, merged }));
  const results = await db.batch(stmts);
  const id = results[0].meta.last_row_id;
  return { id, name, escalatedFrom: previous.length ? siblings[0].name : null, merged };
}

interface StatusRow {
  status: number;
  updated_by: string | null;
  updated_at: number;
  prev_status: number;
}

async function seatContext(db: D1Database, cardId: number, seat: number) {
  const n = await studentCount(db);
  if (!Number.isInteger(seat) || seat < 1 || seat > n) throw new HttpError(400, '座號不正確');
  const card = await db.prepare('SELECT id FROM cards WHERE id = ? AND deleted_at IS NULL').bind(cardId).first();
  if (!card) throw new HttpError(404, '這張卡片已經不在看板上（可能被其他裝置取下了），請重新整理');
  return db.prepare('SELECT status, updated_by, updated_at, prev_status FROM card_status WHERE card_id = ? AND seat = ?')
    .bind(cardId, seat).first<StatusRow>();
}

async function setSeat(db: D1Database, actor: Actor, cardId: number, seat: number, body: Record<string, unknown>, now: number) {
  const status = int(body.status, '狀態', 0, 3);
  const cur = await seatContext(db, cardId, seat);
  const curStatus = cur?.status ?? 0;
  if (status === curStatus) return { ok: true, status, removed: false };
  if (actor.role === 'helper' && status < curStatus) {
    throw new HttpError(403, '只有老師可以銷帳；自己 5 分鐘內登記的可以長按取消');
  }

  // 同一個人 5 分鐘內連續點：保留他開始點之前的狀態，取消時一次還原
  const recentMine = cur && cur.updated_by === actor.name && cur.updated_at > now - UNDO_MS;
  const prev = recentMine ? cur.prev_status : curStatus;

  // 只在狀態和讀到的一樣時才寫入，避免兩台裝置同時改同一格時蓋掉對方
  let r: D1Result;
  if (status === 0) {
    r = await db.prepare('DELETE FROM card_status WHERE card_id = ? AND seat = ? AND status = ?')
      .bind(cardId, seat, curStatus).run();
  } else if (cur) {
    r = await db.prepare(`UPDATE card_status SET status = ?, updated_at = ?, updated_by = ?, prev_status = ?
                          WHERE card_id = ? AND seat = ? AND status = ?`)
      .bind(status, now, actor.name, prev, cardId, seat, curStatus).run();
  } else {
    r = await db.prepare(`INSERT INTO card_status (card_id, seat, status, updated_at, updated_by, prev_status)
                          VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (card_id, seat) DO NOTHING`)
      .bind(cardId, seat, status, now, actor.name).run();
  }
  if (!r.meta.changes) throw new HttpError(409, `${seat} 號剛剛被其他裝置改過，已重新讀取，請再確認一次`);

  // 老師銷帳後全班都完成了 → 卡片自動收起（可以從「復原」找回）
  const stmts = [audit(db, now, actor, 'seat.set', { cardId, seat, from: curStatus, status })];
  if (status === 0 && actor.role === 'teacher') {
    stmts.unshift(db.prepare(`UPDATE cards SET deleted_at = ?, deleted_reason = 'completed', updated_at = ?
                              WHERE id = ? AND deleted_at IS NULL
                                AND NOT EXISTS (SELECT 1 FROM card_status WHERE card_id = ?)`)
      .bind(now, now, cardId, cardId));
  }
  const results = await db.batch(stmts);
  const removed = status === 0 && actor.role === 'teacher' && results[0].meta.changes > 0;
  return { ok: true, status, removed };
}

async function undoSeat(db: D1Database, actor: Actor, cardId: number, seat: number, now: number) {
  const cur = await seatContext(db, cardId, seat);
  if (!cur || cur.updated_by !== actor.name || cur.updated_at <= now - UNDO_MS) {
    throw new HttpError(403, '只能取消自己 5 分鐘內的登記；其他的請老師處理');
  }
  const target = cur.prev_status;
  const r = target === 0
    ? await db.prepare('DELETE FROM card_status WHERE card_id = ? AND seat = ? AND status = ? AND updated_at = ?')
      .bind(cardId, seat, cur.status, cur.updated_at).run()
    : await db.prepare(`UPDATE card_status SET status = ?, prev_status = ?, updated_by = NULL, updated_at = ?
                        WHERE card_id = ? AND seat = ? AND status = ? AND updated_at = ?`)
      .bind(target, target, now, cardId, seat, cur.status, cur.updated_at).run();
  if (!r.meta.changes) throw new HttpError(409, `${seat} 號剛剛被其他裝置改過，已重新讀取`);
  await audit(db, now, actor, 'seat.undo', { cardId, seat, from: cur.status, status: target }).run();
  return { ok: true, status: target };
}

async function updateCard(db: D1Database, actor: Actor, cardId: number, body: Record<string, unknown>, now: number) {
  // 小秘書只能收合／展開（locked 只影響畫面顯示，不動登記資料）
  if (actor.role !== 'teacher' && Object.keys(body).some(k => k !== 'locked')) {
    throw new HttpError(403, '這個功能只有老師可以使用');
  }
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
    audit(db, now, actor, 'card.update', { cardId, locked: body.locked, priority: body.priority }),
  ]);
  if (!r.meta.changes) throw new HttpError(404, '找不到這張卡片，請重新整理');
  return { ok: true };
}

// 拖曳排列：把一欄的卡片依照 ids 的順序重新編號，同時設定這一欄的分類
async function orderCards(db: D1Database, actor: Actor, body: Record<string, unknown>, now: number) {
  const kind = body.kind === 'exam' ? 'exam' : body.kind === 'daily' ? 'daily' : null;
  if (!kind) throw new HttpError(400, '卡片種類不正確');
  const track = trackParam(body.track);
  if (!track) throw new HttpError(400, '分類不正確');
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every(x => Number.isInteger(x) && x > 0) || new Set(ids).size !== ids.length) {
    throw new HttpError(400, '卡片清單不正確');
  }
  const stmts = (ids as number[]).map((id, i) =>
    db.prepare(`UPDATE cards SET track = ?, sort_order = ?, updated_at = ? WHERE id = ? AND kind = ? AND deleted_at IS NULL`)
      .bind(track, i, now, id, kind));
  stmts.push(audit(db, now, actor, 'card.order', { kind, track, ids }));
  await db.batch(stmts);
  return { ok: true };
}

async function removeCard(db: D1Database, actor: Actor, cardId: number, now: number) {
  const card = await db.prepare('SELECT created_by, created_at FROM cards WHERE id = ? AND deleted_at IS NULL')
    .bind(cardId).first<{ created_by: string | null; created_at: number }>();
  if (!card) throw new HttpError(404, '找不到這張卡片，請重新整理');
  if (actor.role === 'helper' && (card.created_by !== actor.name || card.created_at <= now - UNDO_MS)) {
    throw new HttpError(403, '只能取下自己 5 分鐘內新增的卡片；其他的請老師處理');
  }
  const [r] = await db.batch([
    db.prepare(`UPDATE cards SET deleted_at = ?, deleted_reason = 'manual', updated_at = ?
                WHERE id = ? AND deleted_at IS NULL`).bind(now, now, cardId),
    audit(db, now, actor, 'card.remove', { cardId }),
  ]);
  if (!r.meta.changes) throw new HttpError(404, '找不到這張卡片，請重新整理');
  return { ok: true };
}

/** 清空：只收起全班都完成的卡片；還有人欠交的保留（欠交會一直記著，直到老師銷帳） */
async function clearCards(db: D1Database, actor: Actor, body: Record<string, unknown>, now: number) {
  const kind = body.kind === 'exam' ? 'exam' : body.kind === 'daily' ? 'daily' : null;
  if (!kind) throw new HttpError(400, '卡片種類不正確');
  const [r, kept] = await db.batch([
    db.prepare(`UPDATE cards SET deleted_at = ?, deleted_reason = 'clear', updated_at = ?
                WHERE kind = ? AND deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM card_status s WHERE s.card_id = cards.id)`).bind(now, now, kind),
    db.prepare('SELECT COUNT(*) AS n FROM cards WHERE kind = ? AND deleted_at IS NULL').bind(kind),
    audit(db, now, actor, 'card.clear', { kind }),
  ]);
  return { ok: true, cleared: r.meta.changes, kept: (kept.results[0] as { n: number }).n };
}

async function restoreCard(db: D1Database, actor: Actor, cardId: number, now: number) {
  const [r] = await db.batch([
    db.prepare(`UPDATE cards SET deleted_at = NULL, deleted_reason = NULL, updated_at = ?
                WHERE id = ? AND deleted_at IS NOT NULL`).bind(now, cardId),
    audit(db, now, actor, 'card.restore', { cardId }),
  ]);
  if (!r.meta.changes) throw new HttpError(404, '找不到可以復原的卡片');
  return { ok: true };
}

async function createAlbum(db: D1Database, actor: Actor, body: Record<string, unknown>, now: number) {
  const icon = text(body.icon, '圖示', 8, false) || '📸';
  const name = text(body.name, '相簿標題', 40);
  const description = text(body.description, '相簿簡介', 100, false);
  const url = httpUrl(body.url);
  const [r] = await db.batch([
    db.prepare('INSERT INTO albums (icon, name, description, url, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(icon, name, description, url, now),
    audit(db, now, actor, 'album.create', { name, url }),
  ]);
  return { id: r.meta.last_row_id };
}

async function setAlbumDeleted(db: D1Database, actor: Actor, albumId: number, deleted: boolean, now: number) {
  const [r] = await db.batch([
    deleted
      ? db.prepare('UPDATE albums SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now, albumId)
      : db.prepare('UPDATE albums SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').bind(albumId),
    audit(db, now, actor, deleted ? 'album.remove' : 'album.restore', { albumId }),
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

// ---------- 小秘書帳號（只有老師） ----------

async function checkPassword(db: D1Database, env: Env, password: string, exceptId: number | null) {
  if (!/^\S{4,32}$/.test(password)) throw new HttpError(400, '密碼要 4～32 個字，不能有空白');
  if (env.ADMIN_TOKEN && password === env.ADMIN_TOKEN) throw new HttpError(400, '不能和老師密碼相同');
  const accounts = await db.prepare('SELECT id, salt, password_hash FROM accounts')
    .all<{ id: number; salt: string; password_hash: string }>();
  for (const a of accounts.results) {
    if (a.id !== exceptId && (await sha256(a.salt + password)) === a.password_hash) {
      throw new HttpError(400, '這組密碼已經有人使用，請換一組');
    }
  }
}

async function newPassword(db: D1Database, env: Env, exceptId: number | null, given: unknown) {
  if (typeof given === 'string' && given !== 'random' && given !== '') {
    await checkPassword(db, env, given, exceptId);
    return given;
  }
  for (let i = 0; i < 20; i++) {
    const p = randomDigits(6);
    try {
      await checkPassword(db, env, p, exceptId);
      return p;
    } catch {
      // 重複就再產生一次
    }
  }
  throw new HttpError(500, '無法產生密碼，請再試一次');
}

// 小秘書改自己的密碼：要先輸入舊密碼（避免別人拿她登入中的平板改掉）
async function changeMyPassword(request: Request, db: D1Database, env: Env, actor: Actor, body: Record<string, unknown>, now: number) {
  if (actor === TEACHER) throw new HttpError(400, '老師密碼請用部署設定修改');
  const acc = await db.prepare('SELECT id, salt, password_hash FROM accounts WHERE name = ? AND active = 1').bind(actor.name)
    .first<{ id: number; salt: string; password_hash: string }>();
  if (!acc) throw new HttpError(404, '找不到這個帳號');
  const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
  if (!safeEqual(await sha256(acc.salt + oldPassword), acc.password_hash)) {
    // 舊密碼打錯也算一次密碼錯誤（一直猜一樣會被擋）
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    await db.prepare('INSERT INTO auth_failures (ip, at) VALUES (?, ?)').bind(ip, now).run();
    throw new HttpError(400, '舊密碼不正確');
  }
  const password = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!/^\S{6,32}$/.test(password)) throw new HttpError(400, '新密碼要 6～32 個字，不能有空白');
  if (password === oldPassword) throw new HttpError(400, '新密碼和舊密碼一樣');
  await checkPassword(db, env, password, acc.id);
  const salt = randomSalt();
  await db.batch([
    db.prepare('UPDATE accounts SET salt = ?, password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(salt, await sha256(salt + password), now, acc.id),
    audit(db, now, actor, 'account.password.self', { id: acc.id }),
  ]);
  return { ok: true };
}

async function listAccounts(db: D1Database) {
  const r = await db.prepare('SELECT id, name, short, role, active, created_at AS createdAt FROM accounts ORDER BY id').all();
  return { accounts: r.results.map(a => ({ ...a, active: a.active === 1 })) };
}

async function createAccount(db: D1Database, env: Env, actor: Actor, body: Record<string, unknown>, now: number) {
  const name = text(body.name, '名稱', 12);
  if (name === TEACHER.name) throw new HttpError(400, '名稱不能是「老師」');
  const short = text(body.short, '徽章字', 2, false) || [...name].slice(-1).join('');
  const role = roleParam(body.role);
  const password = await newPassword(db, env, null, body.password);
  const salt = randomSalt();
  const exists = await db.prepare('SELECT id FROM accounts WHERE name = ?').bind(name).first();
  if (exists) throw new HttpError(409, `已經有「${name}」了`);
  const [r] = await db.batch([
    db.prepare(`INSERT INTO accounts (name, short, role, salt, password_hash, active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).bind(name, short, role, salt, await sha256(salt + password), now, now),
    audit(db, now, actor, 'account.create', { name, role }),
  ]);
  return { id: r.meta.last_row_id, password };
}

async function updateAccount(db: D1Database, env: Env, actor: Actor, id: number, body: Record<string, unknown>, now: number) {
  const acc = await db.prepare('SELECT id, name FROM accounts WHERE id = ?').bind(id).first<{ id: number; name: string }>();
  if (!acc) throw new HttpError(404, '找不到這個帳號');
  const sets: string[] = [];
  const binds: unknown[] = [];
  const stmts: D1PreparedStatement[] = [];
  let password: string | undefined;
  if (body.role !== undefined) {
    sets.push('role = ?');
    binds.push(roleParam(body.role));
  }
  if (body.name !== undefined) {
    const name = text(body.name, '名稱', 12);
    if (name === TEACHER.name) throw new HttpError(400, '名稱不能是「老師」');
    const dup = await db.prepare('SELECT id FROM accounts WHERE name = ? AND id <> ?').bind(name, id).first();
    if (dup) throw new HttpError(409, `已經有「${name}」了`);
    sets.push('name = ?');
    binds.push(name);
    // 已登記的紀錄跟著改名，才找得到「誰登記的」和 5 分鐘內取消
    if (name !== acc.name) {
      stmts.push(db.prepare('UPDATE card_status SET updated_by = ? WHERE updated_by = ?').bind(name, acc.name));
      stmts.push(db.prepare('UPDATE cards SET created_by = ? WHERE created_by = ?').bind(name, acc.name));
    }
  }
  if (body.short !== undefined) {
    sets.push('short = ?');
    binds.push(text(body.short, '徽章字', 2));
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, '啟用狀態不正確');
    sets.push('active = ?');
    binds.push(body.active ? 1 : 0);
  }
  if (body.password !== undefined) {
    password = await newPassword(db, env, id, body.password);
    const salt = randomSalt();
    sets.push('salt = ?', 'password_hash = ?');
    binds.push(salt, await sha256(salt + password));
  }
  if (!sets.length) throw new HttpError(400, '沒有要修改的內容');
  await db.batch([
    db.prepare(`UPDATE accounts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...binds, now, id),
    ...stmts,
    audit(db, now, actor, 'account.update', { id, name: body.name, short: body.short, active: body.active, password: password ? 'changed' : undefined }),
  ]);
  return password ? { ok: true, password } : { ok: true };
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const db = env.DB;
  const now = Date.now();

  if (method === 'GET' && path === '/api/health') return json({ ok: true });

  if (method === 'GET' && path === '/api/board') {
    // 家長不帶密碼；登入的人帶密碼時多回傳「誰登記的」。密碼錯了就當成家長，不讓輪詢失敗
    let actor: Actor | null = null;
    try {
      actor = await authenticate(request, env, now);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
    return json(await getBoard(db, actor));
  }

  const actor = await authenticate(request, env, now);

  if (method === 'POST' && path === '/api/auth') return json(requireActor(actor));
  if (method === 'POST' && path === '/api/me/password') return json(await changeMyPassword(request, db, env, requireActor(actor), await readBody(request), now));
  if (method === 'POST' && path === '/api/cards') return json(await createCard(db, requireActor(actor), await readBody(request), now), 201);

  let m = path.match(/^\/api\/cards\/(\d+)\/seats\/(\d+)$/);
  if (m && method === 'PUT') return json(await setSeat(db, requireActor(actor), idParam(m[1]), Number(m[2]), await readBody(request), now));

  m = path.match(/^\/api\/cards\/(\d+)\/seats\/(\d+)\/undo$/);
  if (m && method === 'POST') return json(await undoSeat(db, requireActor(actor), idParam(m[1]), Number(m[2]), now));

  m = path.match(/^\/api\/cards\/(\d+)$/);
  if (m && method === 'DELETE') return json(await removeCard(db, requireActor(actor), idParam(m[1]), now));
  if (m && method === 'PATCH') return json(await updateCard(db, requireActor(actor), idParam(m[1]), await readBody(request), now));

  // 以下只有老師
  const teacher = requireTeacher(actor);

  if (method === 'GET' && path === '/api/trash') return json(await getTrash(db, now));
  if (method === 'POST' && path === '/api/cards/order') return json(await orderCards(db, teacher, await readBody(request), now));
  if (method === 'POST' && path === '/api/cards/clear') return json(await clearCards(db, teacher, await readBody(request), now));

  m = path.match(/^\/api\/cards\/(\d+)\/restore$/);
  if (m && method === 'POST') return json(await restoreCard(db, teacher, idParam(m[1]), now));

  if (method === 'POST' && path === '/api/albums') return json(await createAlbum(db, teacher, await readBody(request), now), 201);

  m = path.match(/^\/api\/albums\/(\d+)\/restore$/);
  if (m && method === 'POST') return json(await setAlbumDeleted(db, teacher, idParam(m[1]), false, now));

  m = path.match(/^\/api\/albums\/(\d+)$/);
  if (m && method === 'DELETE') return json(await setAlbumDeleted(db, teacher, idParam(m[1]), true, now));

  if (path.startsWith('/api/accounts')) {
    const owner = requireOwner(actor);
    if (method === 'GET' && path === '/api/accounts') return json(await listAccounts(db));
    if (method === 'POST' && path === '/api/accounts') return json(await createAccount(db, env, owner, await readBody(request), now), 201);
    m = path.match(/^\/api\/accounts\/(\d+)$/);
    if (m && method === 'PATCH') return json(await updateAccount(db, env, owner, idParam(m[1]), await readBody(request), now));
  }

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
