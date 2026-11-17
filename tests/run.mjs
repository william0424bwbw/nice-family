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
    const r = await call('POST', '/api/cards/clear', { kind: 'daily' });
    eq(r.data.cleared, before.daily.length);
    eq((await board()).daily.length, 0);
    const trash = (await call('GET', '/api/trash')).data;
    for (const c of trash.cards.filter(c => c.reason === 'clear')) {
      eq((await call('POST', `/api/cards/${c.id}/restore`)).status, 200);
    }
    const after = await board();
    eq(after.daily.map(c => [c.id, c.statuses]), before.daily.map(c => [c.id, c.statuses]));
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

  await test('密碼錯誤太多次會被暫時擋下，正確密碼不受影響', async () => {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await call('POST', '/api/auth', undefined, `guess${i}`)).status);
    if (!codes.includes(429)) throw new Error(`沒有被擋下：${codes.join(',')}`);
    eq((await call('POST', '/api/auth')).status, 200);
  });

  await test('網頁可以開啟', async () => {
    const res = await fetch(BASE + '/');
    eq(res.status, 200);
    const html = await res.text();
    if (!html.includes('NICE家族')) throw new Error('首頁內容不正確');
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
