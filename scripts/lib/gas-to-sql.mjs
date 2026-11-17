// 把舊版 Google Apps Script 的資料（GET 網址抓下來的 JSON）轉成 SQL
// 用法：node scripts/lib/gas-to-sql.mjs <gas.json>  → SQL 印到 stdout
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/lib/gas-to-sql.mjs <gas.json>');
  process.exit(1);
}
const data = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(data.daily) || !Array.isArray(data.exam) || !Array.isArray(data.photos)) {
  throw new Error('JSON 格式不是舊版看板的資料（需要 daily、exam、photos）');
}

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const now = Date.now();
const lines = [];
const summary = { daily: 0, exam: 0, seats: 0, photos: 0 };

// 舊版名稱後面的「::O3」是優先順序
function splitPriority(raw) {
  const [name, order] = String(raw).split('::O');
  const p = parseInt(order, 10);
  return { name: name.trim(), priority: p >= 1 && p <= 5 ? p : 5 };
}

function addCard(kind, rawName, baseName, statusArray, locked, t) {
  const { name, priority } = splitPriority(rawName);
  lines.push(`INSERT INTO cards (kind, name, base_name, priority, locked, created_at, updated_at) VALUES (` +
    `${q(kind)}, ${q(name)}, ${q(baseName || name)}, ${priority}, ${locked ? 1 : 0}, ${t}, ${t});`);
  const arr = Array.isArray(statusArray) ? statusArray : [];
  // 舊版 statusArray[0] 不使用，statusArray[座號] 是狀態
  for (let seat = 1; seat < arr.length; seat++) {
    const s = Number(arr[seat]) || 0;
    if (s >= 1 && s <= 3) {
      lines.push(`INSERT INTO card_status (card_id, seat, status, updated_at) SELECT MAX(id), ${seat}, ${s}, ${t} FROM cards;`);
      summary.seats++;
    }
  }
  summary[kind]++;
}

let t = now - 100000;
for (const c of data.daily) {
  addCard('daily', c.fullTitle, c.pureName, c.statusArray, c.isLocked === true || c.isLocked === 'true', t++);
}
for (const e of data.exam) {
  addCard('exam', e.examName, splitPriority(e.examName).name, e.statusArray, e.isLocked === true || e.isLocked === 'true', t++);
}
// 舊版相簿越後面越新（畫面倒序顯示），新版用建立時間排序，所以照原順序遞增
for (const p of data.photos) {
  lines.push(`INSERT INTO albums (icon, name, description, url, created_at) VALUES (` +
    `${q(p.icon || '📸')}, ${q(p.name)}, ${q(p.desc === '無簡介' ? '' : p.desc || '')}, ${q(p.url)}, ${t++});`);
  summary.photos++;
}
lines.push(`INSERT INTO audit_log (at, action, detail) VALUES (${now}, 'import.gas', ${q(JSON.stringify(summary))});`);

console.log(lines.join('\n'));
console.error(`  日常作業 ${summary.daily} 張、考試 ${summary.exam} 張、未完成 ${summary.seats} 格、相簿 ${summary.photos} 本`);
