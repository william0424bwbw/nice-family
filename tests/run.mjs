// API 測試：建立獨立的本機 D1 → 套用 migrations → 啟動 wrangler dev → 測試 → 關閉
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-admin-token';
const PERSIST = join(root, '.wrangler', 'test-state');
const isWin = process.platform === 'win32';
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: process.env.CI || 'true' };
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function wrangler(argv) {
  const r = spawnSync(process.execPath, [wranglerBin, ...argv], { cwd: root, env, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`wrangler ${argv.join(' ')} 失敗`);
  }
  return r.stdout;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}

async function call(method, path, body, token = TOKEN) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* 空內容 */ }
  return { status: res.status, data };
}

let failed = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✘ ${name}\n      ${err.message}`);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || ''} 預期 ${e}，實際 ${a}`);
}
const board = async () => (await call('GET', '/api/board', undefined, null)).data;
const cardByName = async (name) => {
  const b = await board();
  return [...b.daily, ...b.exam].find(c => c.name.startsWith(name));
};

async function runTests() {
  await test('看板公開可讀，預設 25 位學生', async () => {
    const b = await board();
    eq(b.studentCount, 25);
    eq([b.daily.length, b.exam.length, b.albums.length], [0, 0, 0]);
  });

  await test('沒有密碼或密碼錯誤不能寫入', async () => {
    eq((await call('POST', '/api/cards', { kind: 'daily', baseName: '國習' }, null)).status, 401);
    eq((await call('POST', '/api/cards', { kind: 'daily', baseName: '國習' }, 'wrong')).status, 401);
    eq((await call('POST', '/api/auth', undefined, 'wrong')).status, 401);
    eq((await call('POST', '/api/auth')).status, 200);
    eq((await call('GET', '/api/trash', undefined, null)).status, 401);
  });

  await test('新增作業卡：名稱自動加上日期，預設全班已完成', async () => {
    const r = await call('POST', '/api/cards', { kind: 'daily', baseName: '國習', priority: 2 });
    eq(r.status, 201);
    if (!/^國習 \d{1,2}\/\d{1,2}$/.test(r.data.name)) throw new Error(`名稱是 ${r.data.name}`);
    const c = await cardByName('國習');
    eq(c.priority, 2);
    eq(c.statuses.every(s => s === 0), true);
  });

  await test('同名同優先順序不能重複', async () => {
    eq((await call('POST', '/api/cards', { kind: 'daily', baseName: '數習', priority: 3 })).status, 201);
    eq((await call('POST', '/api/cards', { kind: 'daily', baseName: '數習', priority: 3 })).status, 409);
  });

  await test('兩台裝置同時點不同座號，兩個都會存到', async () => {
    const c = await cardByName('國習');
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(seat =>
      call('PUT', `/api/cards/${c.id}/seats/${seat}`, { status: (seat % 3) + 1 })));
    eq(results.map(r => r.status), Array(8).fill(200));
    const after = await cardByName('國習');
    eq(after.statuses.slice(0, 8), [2, 3, 1, 2, 3, 1, 2, 3]);
  });

  await test('座號、狀態不正確會被拒絕', async () => {
    const c = await cardByName('國習');
    eq((await call('PUT', `/api/cards/${c.id}/seats/26`, { status: 1 })).status, 400);
    eq((await call('PUT', `/api/cards/${c.id}/seats/0`, { status: 1 })).status, 400);
    eq((await call('PUT', `/api/cards/${c.id}/seats/1`, { status: 4 })).status, 400);
    eq((await call('PUT', '/api/cards/99999/seats/1', { status: 1 })).status, 404);
  });

  await test('再開同名作業：沒交的人自動升級，上一張收起來', async () => {
    const old = await cardByName('數習');
    await call('PUT', `/api/cards/${old.id}/seats/1`, { status: 1 });
    await call('PUT', `/api/cards/${old.id}/seats/2`, { status: 2 });
    await call('PUT', `/api/cards/${old.id}/seats/3`, { status: 3 });
    const r = await call('POST', '/api/cards', { kind: 'daily', baseName: '數習', priority: 1 });
    eq(r.status, 201);
    eq(r.data.escalatedFrom, old.name);
    const b = await board();
    const list = b.daily.filter(c => c.name.startsWith('數習'));
    eq(list.length, 1, '只剩一張數習');
    eq(list[0].statuses.slice(0, 4), [2, 3, 3, 0]);
    const trash = (await call('GET', '/api/trash')).data;
    eq(trash.cards.find(c => c.id === old.id)?.reason, 'escalated');
  });

  await test('全班完成時卡片自動收起，可以復原', async () => {
    eq((await call('POST', '/api/cards', { kind: 'exam', subject: '國語', unit: '第一單元', defaultDebt: false })).status, 201);
    const c = await cardByName('國語-第一單元');
    // 新卡全綠：長按綠色的人不會讓卡片消失
    eq((await call('PUT', `/api/cards/${c.id}/seats/5`, { status: 0 })).data.removed, false);
    await call('PUT', `/api/cards/${c.id}/seats/5`, { status: 1 });
    const r = await call('PUT', `/api/cards/${c.id}/seats/5`, { status: 0 });
    eq(r.data.removed, true);
    eq(await cardByName('國語-第一單元'), undefined);
    eq((await call('POST', `/api/cards/${c.id}/restore`)).status, 200);
    eq((await cardByName('國語-第一單元'))?.id, c.id);
  });

  await test('鎖定與優先順序', async () => {
    const c = await cardByName('國習');
    eq((await call('PATCH', `/api/cards/${c.id}`, { locked: true })).status, 200);
    eq((await cardByName('國習')).locked, true);
    eq((await call('PATCH', `/api/cards/${c.id}`, { priority: 9 })).status, 400);
  });

  await test('清空後全部可以復原，狀態還在', async () => {
    const before = await board();
    // 加一張全班完成的卡
    eq((await call('POST', '/api/cards', { kind: 'daily', baseName: '乙本' })).status, 201);
    const done = await cardByName('乙本');
    const r = await call('POST', '/api/cards/clear', { kind: 'daily' });
    eq([r.data.cleared, r.data.kept], [1, before.daily.length], '只收起全班完成的');
    const after = await board();
    eq(after.daily.map(c => [c.id, c.statuses]), before.daily.map(c => [c.id, c.statuses]), '欠交的卡片保留');
    eq((await call('POST', `/api/cards/${done.id}/restore`)).status, 200);
    eq((await call('DELETE', `/api/cards/${done.id}`)).status, 200);
  });

  await test('相簿：新增、擋掉不安全網址、刪除後復原', async () => {
    eq((await call('POST', '/api/albums', { name: '壞的', url: 'javascript:alert(1)' })).status, 400);
    const r = await call('POST', '/api/albums', { icon: '👣', name: '露營', description: '隔宿露營', url: 'https://photos.app.goo.gl/abc' });
    eq(r.status, 201);
    eq((await board()).albums[0].name, '露營');
    eq((await call('DELETE', `/api/albums/${r.data.id}`)).status, 200);
    eq((await board()).albums.length, 0);
    eq((await call('POST', `/api/albums/${r.data.id}/restore`)).status, 200);
    eq((await board()).albums.length, 1);
  });

  await test('手動取下卡片可以復原', async () => {
    const c = await cardByName('國習');
    eq((await call('DELETE', `/api/cards/${c.id}`)).status, 200);
    eq((await call('DELETE', `/api/cards/${c.id}`)).status, 404);
    eq((await call('POST', `/api/cards/${c.id}/restore`)).status, 200);
  });

  await runHelperTests();

  await test('網頁可以開啟', async () => {
    const res = await fetch(BASE + '/');
    eq(res.status, 200);
    const html = await res.text();
    if (!html.includes('NICE家族')) throw new Error('首頁內容不正確');
  });
}

async function runHelperTests() {
  let fox; // 小狐狸的密碼
  let zhen;
  let foxId;
  const seat = async (cardId, s, status, token) => call('PUT', `/api/cards/${cardId}/seats/${s}`, { status }, token);
  const undo = async (cardId, s, token) => call('POST', `/api/cards/${cardId}/seats/${s}/undo`, undefined, token);
  const authed = async (token = TOKEN) => (await call('GET', '/api/board', undefined, token)).data;

  await test('老師新增小秘書，密碼自動產生 6 位數', async () => {
    const a = await call('POST', '/api/accounts', { name: '小狐狸', short: '狐' });
    eq(a.status, 201);
    if (!/^\d{6}$/.test(a.data.password)) throw new Error(`密碼是 ${a.data.password}`);
    fox = a.data.password; foxId = a.data.id;
    const b = await call('POST', '/api/accounts', { name: '棒棒蓁' });
    zhen = b.data.password;
    eq((await call('POST', '/api/accounts', { name: '小狐狸' })).status, 409);
    eq((await call('POST', '/api/accounts', { name: '重複密碼', password: fox })).status, 400);
    const list = (await call('GET', '/api/accounts')).data.accounts;
    eq(list.map(x => [x.name, x.short, x.active]), [['小狐狸', '狐', true], ['棒棒蓁', '蓁', true]]);
    eq((await call('POST', '/api/auth', undefined, fox)).data, { role: 'helper', name: '小狐狸', short: '狐' });
  });

  await test('秘書可以新增卡片、往上登記；不能銷帳或往下調', async () => {
    const r = await call('POST', '/api/cards', { kind: 'daily', baseName: '圈詞' }, fox);
    eq(r.status, 201);
    const c = await cardByName('圈詞');
    eq((await seat(c.id, 7, 1, fox)).status, 200);
    eq((await seat(c.id, 7, 2, fox)).status, 200);
    eq((await seat(c.id, 7, 1, fox)).status, 403);
    eq((await seat(c.id, 7, 0, fox)).status, 403);
    eq((await seat(c.id, 7, 3, zhen)).status, 200, '另一位秘書可以再往上');
    eq((await cardByName('圈詞')).statuses[6], 3);
  });

  await test('秘書只能取消自己的登記，一次還原到她開始點之前', async () => {
    const c = await cardByName('圈詞');
    eq((await undo(c.id, 7, fox)).status, 403, '最後是棒棒蓁點的');
    eq((await undo(c.id, 7, zhen)).data.status, 2, '還原成棒棒蓁點之前的 2');
    eq((await undo(c.id, 7, zhen)).status, 403, '已經不是她的了');
    // 小狐狸連點 0 → 1 → 2 → 3，取消一次回到 0
    await seat(c.id, 9, 1, fox); await seat(c.id, 9, 2, fox); await seat(c.id, 9, 3, fox);
    eq((await undo(c.id, 9, fox)).data.status, 0);
    eq((await cardByName('圈詞')).statuses[8], 0);
    eq((await cardByName('圈詞'))?.id, c.id, '秘書取消不會讓卡片自動收起');
  });

  await test('看得到誰登記的：只有登入的人', async () => {
    const c = await cardByName('圈詞');
    await seat(c.id, 3, 1, fox);
    await seat(c.id, 4, 1, fox);
    const pub = (await board()).daily.find(x => x.id === c.id);
    eq([pub.marks, pub.createdBy, (await board()).me], [undefined, undefined, null]);
    const b = await authed(fox);
    const mine = b.daily.find(x => x.id === c.id);
    eq([b.me.name, mine.createdBy, mine.marks['3'].by, mine.marks['3'].short], ['小狐狸', '小狐狸', '小狐狸', '狐']);
    eq(mine.marks['7'], undefined, '取消過的格子不再顯示登記人');
    eq(b.undoMs, 300000);
  });

  await test('老師銷帳秘書登記的格子後，秘書就不能取消了', async () => {
    const c = await cardByName('圈詞');
    eq((await seat(c.id, 3, 0)).data.removed, false, '還有 04 號沒交，卡片保留');
    eq((await undo(c.id, 3, fox)).status, 403);
  });

  await test('秘書只能取下自己 5 分鐘內新增的卡片', async () => {
    const teacherCard = await cardByName('國習');
    eq((await call('DELETE', `/api/cards/${teacherCard.id}`, undefined, fox)).status, 403);
    await call('POST', '/api/cards', { kind: 'exam', subject: '自然', unit: '點錯的', defaultDebt: true }, zhen);
    const mine = await cardByName('自然-點錯的');
    eq((await call('DELETE', `/api/cards/${mine.id}`, undefined, fox)).status, 403, '不是小狐狸建的');
    eq((await call('DELETE', `/api/cards/${mine.id}`, undefined, zhen)).status, 200);
  });

  await test('秘書不能用老師的功能', async () => {
    const c = await cardByName('國習');
    for (const [m, p, body] of [
      ['POST', '/api/cards/clear', { kind: 'daily' }], ['GET', '/api/trash'], ['PATCH', `/api/cards/${c.id}`, { locked: false }],
      ['POST', `/api/cards/${c.id}/restore`], ['POST', '/api/albums', { name: 'x', url: 'https://a' }], ['GET', '/api/accounts'],
      ['PATCH', `/api/accounts/${foxId}`, { password: 'random' }],
    ]) eq((await call(m, p, body, fox)).status, 403, `${m} ${p}`);
  });

  await test('老師改名、重設密碼、停用帳號', async () => {
    const r = await call('PATCH', `/api/accounts/${foxId}`, { name: '狐狸', password: 'random' });
    eq(r.status, 200);
    eq((await call('POST', '/api/auth', undefined, fox)).status, 401, '舊密碼不能用');
    const fox2 = r.data.password;
    eq((await call('POST', '/api/auth', undefined, fox2)).data.name, '狐狸');
    const c = await cardByName('圈詞');
    eq((await authed()).daily.find(x => x.id === c.id).createdBy, '狐狸', '登記紀錄跟著改名');
    eq((await call('PATCH', `/api/accounts/${foxId}`, { active: false })).status, 200);
    eq((await call('POST', '/api/auth', undefined, fox2)).status, 401, '停用後不能登入');
  });

  // 放最後：會讓這個 IP 被擋 10 分鐘
  await test('密碼錯誤太多次會被擋下，之後連正確密碼也先擋', async () => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await call('POST', '/api/auth', undefined, `guess${i}`)).status);
    if (!codes.includes(429)) throw new Error(`沒有被擋下：${codes.join(',')}`);
    eq((await call('POST', '/api/auth')).status, 429);
    eq((await board()).studentCount, 25, '家長看板不受影響');
  });
}

function testImport() {
  // 舊版格式轉換：優先順序、狀態、相簿
  const dir = mkdtempSync(join(tmpdir(), 'nice-family-'));
  const src = join(dir, 'gas.json');
  writeFileSync(src, JSON.stringify({
    daily: [{ fullTitle: '背 11/9::O3', pureName: '背', statusArray: [1, 1, 0, 2], isLocked: true }],
    exam: [{ examName: '數學-一::O5', statusArray: [0, 0, 3], isLocked: 'false' }],
    photos: [{ url: 'https://a', icon: '🎒', name: "A'B", desc: '無簡介' }],
  }));
  const r = spawnSync(process.execPath, [join(root, 'scripts/lib/gas-to-sql.mjs'), src], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  wrangler(['d1', 'execute', 'nice-family-db', '--local', '--persist-to', PERSIST, '--command', r.stdout]);
  rmSync(dir, { recursive: true, force: true });
}

let dev;
try {
  console.log('▶ 準備獨立的本機測試資料庫');
  rmSync(PERSIST, { recursive: true, force: true });
  wrangler(['d1', 'migrations', 'apply', 'nice-family-db', '--local', '--persist-to', PERSIST]);

  console.log('▶ 啟動 wrangler dev');
  dev = spawn(process.execPath, [wranglerBin, 'dev', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', PERSIST,
    '--var', `ADMIN_TOKEN:${TOKEN}`, '--show-interactive-dev-session=false'],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin });
  let log = '';
  dev.stdout.on('data', d => { log += d; });
  dev.stderr.on('data', d => { log += d; });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch { await sleep(500); }
  }
  if (!ready) {
    console.error(log);
    throw new Error('wrangler dev 沒有啟動');
  }
  console.log(`  ✔ ${BASE}\n`);

  await runTests();

  await test('舊版資料匯入格式正確', async () => {
    testImport();
    const b = await board();
    const d = b.daily.find(c => c.name === '背 11/9');
    eq([d.priority, d.locked, d.baseName, d.statuses.slice(0, 4)], [3, true, '背', [1, 0, 2, 0]]);
    const e = b.exam.find(c => c.name === '數學-一');
    eq([e.priority, e.locked, e.statuses.slice(0, 3)], [5, false, [0, 3, 0]]);
    const a = b.albums.find(x => x.name === "A'B");
    eq([a.icon, a.description], ['🎒', '']);
  });
} catch (err) {
  console.error('❌', err.message);
  failed++;
} finally {
  killTree(dev);
}

console.log(failed ? `\n❌ ${failed} 項失敗（${passed} 項通過）` : `\n🎉 ${passed} 項測試全部通過`);
process.exit(failed ? 1 : 0);
