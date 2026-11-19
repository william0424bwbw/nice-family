// NICE 保衛戰：看板下方的操場動畫（只在平板、電腦播放；手機不播）
// 有座號的黑色火柴人在看板上跑跳；有作業逾期的人關在右下角的籠子，補交完就放出來。
// index.html 每次重畫看板時呼叫 NiceBattle.sync(人數, 逾期清單, 卡片)。
(() => {
  const ground = document.getElementById('playground');
  if (!ground) return;
  const cv = document.createElement('canvas');
  cv.id = 'battleCanvas';
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:5;display:none';
  document.body.appendChild(cv);
  const g = cv.getContext('2d');
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
  const INK = '#121218', BONE = '#f1efe6', SLIME = '#46d22e';
  const GRAV = 1500;

  let W = 0, H = 0, FLOOR = 0, BASE = 1.5, T = 0, running = false, uid = 0;
  let surfaces = new Map();   // id -> {id, x1, x2, top, floor?}
  let pit = null, cage = null, pile = null, towerX = 0;
  let agents = [], parts = [], balls = [];
  const S = { overdue: 0, defeated: false, caged: [], tower: 0, hunting: false, huntQueue: [] };
  // 看板資料（index.html 每次重畫看板時呼叫 NiceBattle.sync 更新）
  let DATA = null;          // { count, overdue: Map(座號 → 逾期份數) }
  let prevCards = null;     // 上一次每張卡片的狀態，用來判斷「全班交齊」
  let dataDay = '';

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- 量出看板上可以站的地方 ----------
  // 可以站上去的東西：標題、分頁按鈕、控制面板和裡面的按鈕、作業卡片、欄位標題
  const PLAT_SEL = '.title-area h1, .tab-btn, .control-panel, .control-panel button, .control-panel select, .homework-card, .track-header-title';
  const STANDING = ['idle', 'walk', 'run', 'flee', 'dance', 'wave', 'cheer', 'juggle', 'punch', 'freeze', 'skullHome', 'push', 'greet', 'taunt'];
  function platKey(el, i) {
    if (el.dataset.cardId) return 'card' + el.dataset.cardId;
    if (el.id) return '#' + el.id;
    return 'p' + i;
  }
  function measure() {
    const sx = window.scrollX, sy = window.scrollY;
    W = document.documentElement.clientWidth;
    const gr = ground.getBoundingClientRect();
    H = Math.round(gr.bottom + sy);
    const dpr = W * H > 3e6 ? 1 : Math.min(2, window.devicePixelRatio || 1);   // 整頁很長時降低解析度，省記憶體
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    BASE = W >= 1100 ? 1.55 : 1.3;
    FLOOR = H - 34;
    const m = new Map();
    document.querySelectorAll(PLAT_SEL).forEach((el, i) => {
      if (el.classList.contains('dragging') || el.closest('.overlay')) return;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10 || r.bottom + sy > FLOOR - 40) return;
      const key = platKey(el, i);
      m.set(key, { id: key, x1: r.left + sx + 6, x2: r.right + sx - 6, top: r.top + sy, el });
    });
    m.set('floor', { id: 'floor', x1: 6, x2: W - 6, top: FLOOR, floor: true });
    pit = { x1: W - Math.min(300, W * 0.2), x2: W - 4 };
    cage = { x1: pit.x1 - Math.min(230, W * 0.16), x2: pit.x1 - 16, top: FLOOR - 120 };
    pile = { x: 60 };
    towerX = Math.max(220, W * 0.3);
    if (S.tower > 0) m.set('tower', { id: 'tower', x1: towerX - 15, x2: towerX + 15, top: FLOOR - S.tower * 28 });
    surfaces = m;
    for (const a of agents) {
      // 站的卡片不見了（被取下、換欄）：掉下來
      if (a.surf !== 'floor' && !m.has(a.surf)) {
        a.surf = 'floor';
        if (!a.air && STANDING.includes(a.act.type)) { a.air = true; a.vx = 0; a.vy = 0; setAct(a, 'fall'); }
        continue;
      }
      // 版面變動時，只把「站著」的人對齊到平台上；爬到一半、被抓、墊腳中的人不要動
      const s = surfaces.get(a.surf); if (s && !a.air && STANDING.includes(a.act.type)) a.y = s.top;
    }
  }
  const surf = id => surfaces.get(id) || surfaces.get('floor');
  const kidMaxX = () => cage.x1 - 20;

  // ---------- 角色 ----------
  // 身高比例：大熊老師 176 公分；學生大多 126～148 公分，只有兩個男生 152～158 公分
  const CM = () => BASE * 0.36;              // 1 公分 = 幾個像素
  const TALL_BOYS = [7, 18];
  function kidHeight(num) {
    if (TALL_BOYS.includes(num)) return 152 + ((num * 13) % 7);
    return 126 + ((num * 37) % 23);
  }
  function makeAgent(kind, x, o = {}) {
    const a = { id: ++uid, kind, x, y: FLOOR, vx: 0, vy: 0, f: Math.random() < 0.5 ? 1 : -1, rot: 0, ph: Math.random() * 6, surf: 'floor', air: false,
      act: { type: 'idle', t: 0, dur: rand(0.3, 1.5) }, goal: null, say: null, p: null, carry: null, belly: 1 };
    if (kind === 'kid') { a.num = o.num; a.s = kidHeight(o.num) * CM() / 54; a.naruto = Math.random() < 0.5; }
    if (kind === 'bear') a.s = BASE * 1.45;
    if (kind === 'skull') { a.s = BASE * (o.tier === 'boss' ? 2.1 : o.tier === 'mid' ? 1.5 : 1); a.tier = o.tier || 'small'; a.parts = o.parts || 3; a.power = o.power || 0; a.home = true; }
    return a;
  }
  const kids = () => agents.filter(a => a.kind === 'kid' && !a.gone);
  const bear = () => agents.find(a => a.kind === 'bear' && !a.gone);
  const skulls = () => agents.filter(a => a.kind === 'skull' && !a.gone);
  function setAct(a, type, o = {}) {
    if (a.rope && type !== 'hook' && a.rope.retract == null) a.rope = null;   // 爬到一半被打斷，繩子收掉
    if (a.kind === 'bear' && a.act && a.act.type === 'skill' && a.act.k === 'stairs' && S.stairs && !a.act.ending) endStairs(a);
    if (a.kind === 'kid' && a.act && a.act.type === 'dance') a.rot = 0;
    a.act = Object.assign({ type, t: 0 }, o);
  }
  function say(a, text, sec = 1.6) { a.say = { text, until: T + sec }; }

  // ---------- 姿勢 ----------
  const D = { lean: 0, tilt: 0, ra1: 0.15, ra2: 0.1, la1: -0.15, la2: -0.1, rl1: 0.06, rl2: 0, ll1: -0.06, ll2: 0, hipH: 22 };
  const P = o => Object.assign({}, D, o);
  function poseWalk(ph, amp = 0.55, lean = 0.08) {
    const sw = Math.sin(ph);
    return P({ lean, ra1: -amp * sw, ra2: -amp * sw + 0.35, la1: amp * sw, la2: amp * sw + 0.35,
      rl1: amp * sw, rl2: amp * sw - 0.9 * Math.max(0, -sw), ll1: -amp * sw, ll2: -amp * sw - 0.9 * Math.max(0, sw), hipH: 21 });
  }
  function poseRun(ph, scared) {
    const sw = Math.sin(ph);
    const legs = { rl1: sw, rl2: sw - 1.3 * Math.max(0, -sw), ll1: -sw, ll2: -sw - 1.3 * Math.max(0, sw), hipH: 20 };
    if (scared) return P(Object.assign({ lean: -0.12, tilt: -0.3, ra1: 2.7 + 0.35 * Math.sin(ph * 2), ra2: 3.0, la1: -2.7 - 0.35 * Math.sin(ph * 2), la2: -3.0 }, legs));
    return P(Object.assign({ lean: 0.35, ra1: -0.9 * sw, ra2: -0.9 * sw + 1.5, la1: 0.9 * sw, la2: 0.9 * sw + 1.5 }, legs));
  }
  const poseAir = () => P({ lean: 0.1, ra1: 2.5, ra2: 2.9, la1: -2.5, la2: -2.9, rl1: 1.0, rl2: -0.2, ll1: 0.5, ll2: -0.7, hipH: 19 });
  const poseTuck = () => P({ lean: 0.5, ra1: 1.3, ra2: 0.3, la1: 1.1, la2: 0.2, rl1: 1.7, rl2: -0.1, ll1: 1.6, ll2: -0.3, hipH: 13 });
  const poseCheer = t => P({ ra1: 2.8 + 0.15 * Math.sin(t * 12), ra2: 3.0, la1: -2.8 - 0.15 * Math.sin(t * 12), la2: -3.0, hipH: 22 + 2 * Math.abs(Math.sin(t * 9)) });
  const poseWave = t => P({ ra1: 2.5, ra2: 2.7 + 0.6 * Math.sin(t * 12) });
  const poseDance = t => P({ lean: 0.15 * Math.sin(t * 4), ra1: 1.6 + 1.2 * Math.sin(t * 8), ra2: 2.4, la1: -1.6 + 1.2 * Math.sin(t * 8 + 3), la2: -2.4,
    rl1: 0.8 * Math.max(0, Math.sin(t * 8)), rl2: -0.5 * Math.max(0, Math.sin(t * 8)), ll1: -0.2, ll2: 0, hipH: 21 + 2 * Math.abs(Math.sin(t * 8)) });
  const poseSit = (t, sip) => P({ lean: -0.05, rl1: 1.5, rl2: 0.2 + 0.2 * Math.sin(t * 3), ll1: 1.45, ll2: 0.1 + 0.2 * Math.sin(t * 3 + 1.3),
    la1: -0.6, la2: -0.6, ra1: 0.7, ra2: sip ? 2.9 : 1.5, hipH: 0 });
  const poseClimb = ph => P({ tilt: -0.25, ra1: 2.9 + 0.3 * Math.sin(ph), ra2: 3.1, la1: 2.6 - 0.3 * Math.sin(ph), la2: 3.0,
    rl1: 0.9 + 0.5 * Math.sin(ph), rl2: -0.2, ll1: 0.9 - 0.5 * Math.sin(ph), ll2: -0.2 });
  const poseCarry = ph => { const p = poseWalk(ph, 0.45); p.ra1 = 2.9; p.ra2 = 3.1; p.la1 = -2.9; p.la2 = -3.1; return p; };
  const poseShake = t => P({ lean: -0.1, ra1: 1.2, ra2: 2.6, la1: 1.1, la2: 2.5, rl1: 0.15 + 0.08 * Math.sin(t * 40), ll1: -0.15 - 0.08 * Math.sin(t * 40), hipH: 21 });
  // 邊走邊滑手機：低頭、手機舉在面前
  const posePhone = ph => { const p = poseWalk(ph, 0.35, 0.02); p.tilt = 0.4; p.ra1 = 0.8; p.ra2 = 2.5; p.la1 = 0.5; p.la2 = 2.2; return p; };
  // 火影忍者跑：身體往前傾、兩手直直往後
  const poseNaruto = ph => { const p = poseRun(ph); p.lean = 0.7; p.tilt = 0.25; p.ra1 = -2.3; p.ra2 = -2.4; p.la1 = -2.0; p.la2 = -2.1; return p; };
  // 閃身步：身體快速左右滑、腳一伸一收
  const poseDodge = t => { const s = Math.sin(t * 9); return P({ lean: 0.35 * s, tilt: -0.15 * s, ra1: -1.2 * s, ra2: -1.2 * s + 1.2, la1: 1.2 * s, la2: 1.2 * s + 1.2,
    rl1: 0.7 * Math.max(0, s), rl2: 0, ll1: -0.7 * Math.max(0, -s), ll2: 0, hipH: 20 }); };
  // 狗熊哆嗦：半蹲、兩手縮在胸前、全身一直抖
  const poseShiver = t => P({ lean: 0.12 + 0.06 * Math.sin(t * 46), ra1: 0.9 + 0.2 * Math.sin(t * 40), ra2: 2.6, la1: 0.7 - 0.2 * Math.sin(t * 40), la2: 2.4,
    rl1: 0.55, rl2: -0.5, ll1: -0.45, ll2: -0.9, hipH: 16 + 1.5 * Math.sin(t * 46) });
  // K-pop：四拍一組，用全域時間，所以大家動作整齊
  function poseKpop(t) {
    const beat = Math.floor(t * 2.4) % 4, b = (t * 2.4) % 1, bounce = 1.5 * Math.abs(Math.sin(t * 2.4 * Math.PI));
    if (beat === 0) return P({ lean: -0.1, ra1: 2.5, ra2: 2.5, la1: -0.5, la2: -1.4, rl1: 0.35, ll1: -0.35, hipH: 21 + bounce });           // 右手指天
    if (beat === 1) return P({ lean: 0.15, ra1: 0.6, ra2: 0.4, la1: -2.2, la2: -2.3, rl1: -0.35, ll1: 0.35, hipH: 20 + bounce });            // 換邊
    if (beat === 2) return P({ lean: 0.25 * Math.sin(b * Math.PI * 2), ra1: 0.9, ra2: -0.6, la1: -0.9, la2: 0.6, rl1: 0.2, ll1: -0.2, hipH: 21 }); // 手插腰扭
    return P({ tilt: -0.4, ra1: 2.9, ra2: 3.6, la1: -1.4, la2: -1.2, rl1: 0.5, rl2: -0.6, ll1: -0.1, hipH: 21 + bounce });                    // 甩頭髮
  }
  // 敬禮：右手舉到額頭
  const poseSalute = () => P({ ra1: 2.2, ra2: 4.0, la1: -0.05, la2: -0.05, rl1: 0.03, ll1: -0.03, hipH: 22 });
  // 挑釁：兩手放耳朵旁邊揮、屁股扭
  const poseTaunt = t => P({ lean: -0.12 + 0.12 * Math.sin(t * 7), tilt: 0.2 * Math.sin(t * 7), ra1: 2.6, ra2: 3.5 + 0.5 * Math.sin(t * 16), la1: -2.6, la2: -3.5 - 0.5 * Math.sin(t * 16), rl1: 0.25, ll1: -0.25, hipH: 21 });
  // 吃餅乾：手拿到嘴邊
  const poseMunch = t => { const chew = Math.sin(t * 12) > 0; return P({ ra1: chew ? 1.9 : 1.5, ra2: chew ? 3.6 : 3.3, la1: 0.4, la2: 1.4 }); };
  // 被推了一下：往後踉蹌
  const poseStumble = t => P({ lean: -0.45, tilt: -0.3, ra1: 2.2 + 0.4 * Math.sin(t * 20), ra2: 2.6, la1: -2.4 - 0.4 * Math.sin(t * 20), la2: -2.9, rl1: -0.4, ll1: 0.4, hipH: 20 });
  const poseDangle = t => P({ ra1: 2.8, ra2: 3.0, la1: -2.8, la2: -3.0, rl1: 0.4 * Math.sin(t * 15), rl2: 0.4 * Math.sin(t * 15), ll1: -0.4 * Math.sin(t * 15), ll2: -0.2 });

  // ---------- 移動：走、跳、爬、掉 ----------
  const JUMP_MAX = 150;
  function jumpTo(a, s, x) {
    const x0 = a.x, y0 = a.y, y1 = s.top;
    const peak = Math.min(y0, y1) - 45;
    const vy = -Math.sqrt(2 * GRAV * (y0 - peak));
    const t1 = -vy / GRAV, t2 = Math.sqrt(2 * (y1 - peak) / GRAV);
    a.vx = (x - x0) / (t1 + t2); a.vy = vy; a.air = true;
    a.f = Math.sign(x - x0) || a.f;
    setAct(a, a.kind === 'kid' && Math.random() < 0.25 ? 'flipTo' : 'jumpTo', { target: s.id, tx: x, then: a.act.then });
  }
  // 想去某個平台：一步一步規劃
  function travel(a, sid, x, then) { a.goal = { sid, x, then }; planStep(a); }
  function planStep(a) {
    const goal = a.goal; if (!goal) return;
    const target = surfaces.get(goal.sid);
    if (!target) { a.goal = null; setAct(a, 'idle', { dur: 0.5 }); return; }
    const cur = surf(a.surf);
    const tx = clamp(goal.x, target.x1 + 8, target.x2 - 8);
    if (cur.id === target.id) { setAct(a, a.kind === 'skull' || goal.run ? 'run' : 'walk', { tx, arrive: true }); return; }
    const higher = cur.top - target.top;           // > 0 代表目標比較高
    let nearX = clamp(a.x, target.x1 + 10, target.x2 - 10);
    if (a.kind === 'kid' && target.floor) nearX = Math.min(nearX, kidMaxX());   // 小孩不敢跳進骷髏區
    const dist = Math.abs(nearX - a.x);
    if (higher <= JUMP_MAX && dist <= 320) {
      // 先走到起跳點（不要在平台邊緣以外）
      const from = clamp(a.x + Math.sign(nearX - a.x) * Math.max(0, dist - 200), cur.x1 + 4, cur.x2 - 4);
      if (Math.abs(from - a.x) > 6) { setAct(a, goal.run ? 'run' : 'walk', { tx: from, step: true }); return; }
      jumpTo(a, target, nearX); return;
    }
    // 中等高度、牆就在腳下這塊平台上：直接蹬牆跳上去
    if (a.kind === 'kid' && higher > JUMP_MAX && higher <= WALL_MAX) {
      const sides = [target.x1 - 6, target.x2 + 6].filter(x => x >= cur.x1 + 4 && x <= cur.x2 - 4 && x <= kidMaxX());
      if (sides.length) {
        const sd = sides.sort((p, q) => Math.abs(p - a.x) - Math.abs(q - a.x))[0];
        if (Math.abs(sd - a.x) > 4) { setAct(a, goal.run ? 'run' : 'walk', { tx: sd, step: true }); return; }
        startKidClimb(a, target, sd); return;
      }
    }
    if (!cur.floor) { jumpTo(a, surf('floor'), clamp(a.x + a.f * 40, 10, a.kind === 'kid' ? kidMaxX() : W - 10)); return; }
    // 在地上：走到平台側邊，爬上去（小孩不從骷髏區那一側爬）
    let side = Math.abs(a.x - target.x1) < Math.abs(a.x - target.x2) ? target.x1 - 6 : target.x2 + 6;
    if (a.kind === 'kid' && side > kidMaxX()) side = target.x1 - 6;
    if (Math.abs(side - a.x) > 4) { setAct(a, a.kind === 'skull' || goal.run ? 'run' : 'walk', { tx: side, step: true }); return; }
    a.f = side < target.x1 ? 1 : -1;
    if (a.kind === 'kid') { startKidClimb(a, target, side); return; }
    setAct(a, 'climb', { target: target.id });   // 骷髏貼牆爬（比較可怕）；熊用爪子爬
  }

  // ---------- 小孩怎麼上去：依高度換方法 ----------
  // 中等高度：蹬牆跳；很高：飛爪繩／同學墊腳／大熊老師丟上去
  const WALL_MAX = 270, BOOST_MAX = 700;
  function startKidClimb(a, s, side) {
    const H = a.y - s.top;
    const leftSide = side < s.x1;
    a.f = leftSide ? 1 : -1;
    const edgeIn = leftSide ? s.x1 + 10 : s.x2 - 10;
    const cx = leftSide ? s.x1 - 3 : s.x2 + 3;
    const force = a.forceClimb; a.forceClimb = null;
    const note = () => {};
    if ((H <= WALL_MAX && !force) || force === 'walljump') {
      note('walljump');
      a.air = true; a.vx = 0; a.vy = -Math.sqrt(2 * GRAV * Math.max(40, H * 0.55));
      setAct(a, 'walljump', { target: s.id, edgeIn, phase: 0 });
      return;
    }
    const r = Math.random();
    if ((force === 'bearThrow' || (!force && r < 0.18)) && a.surf === 'floor' && tryBearThrow(a, s, edgeIn, leftSide, force === 'bearThrow')) { note('bearThrow'); return; }
    if ((force === 'boost' || (!force && r < 0.5)) && a.surf === 'floor' && H <= BOOST_MAX && tryBoost(a, s, edgeIn, side, leftSide)) { note('boost'); return; }
    note('hook');
    setAct(a, 'hook', { target: s.id, edgeIn, cx });
  }
  // 撐上平台邊緣
  function mantle(a, s, edgeIn) {
    a.air = false; a.vx = 0; a.vy = 0; a.rot = 0; a.y = s.top; a.x = edgeIn; a.surf = s.id;
    setAct(a, 'mantle', { dur: 0.35 });
  }
  // 在地上、沒有在做特別的事，就可以被叫過來幫忙（原本要去哪裡就先不去了）
  const BUSY_ACTS = ['push', 'stairRide', 'greet', 'taunt', 'grabbed', 'sink', 'thrown', 'puppet', 'boost', 'bearThrow', 'hook', 'walljump', 'mantle', 'climb', 'freeze', 'skill', 'jumpTo', 'flipTo', 'fall', 'flipHop'];
  const freeForHelp = k => k.surf === 'floor' && !k.air && !k.cell && !k.fear && !k.forceClimb && !BUSY_ACTS.includes(k.act.type)
    && !(k.goal && ['pull', 'putBack', 'rescue', 'build', 'place', 'kick'].includes(k.goal.then));
  function tryBoost(a, s, edgeIn, side, leftSide) {
    const p = kids().filter(k => k !== a && freeForHelp(k)).sort((x, y) => Math.abs(x.x - a.x) - Math.abs(y.x - a.x))[0];
    if (!p) return false;
    p.goal = null; p.phone = false; setAct(p, 'puppet');
    setAct(a, 'boost', { target: s.id, edgeIn, partner: p, phase: 0, px: side - a.f * 24, leftSide });
    say(a, '幫我一下！', 1.4);
    return true;
  }
  function tryBearThrow(a, s, edgeIn, leftSide, force) {
    const b = bear();
    if (!b || S.hunting || b.air || b.surf !== 'floor' || (force ? ['grabbed', 'puppet'].includes(b.act.type) : !['idle', 'walk'].includes(b.act.type))) return false;
    b.goal = null; b.prop = null; b.hop = 0; b.belly = 1; setAct(b, 'puppet');
    setAct(a, 'bearThrow', { target: s.id, edgeIn, bear: b, phase: 0, leftSide });
    say(a, '大熊老師！把我丟上去！', 1.6);
    return true;
  }
  const poseCrouch = () => P({ lean: 1.15, ra1: 1.6, ra2: 1.2, la1: 1.5, la2: 1.1, rl1: 1.6, rl2: -0.7, ll1: 1.4, ll2: -0.9, hipH: 10 });
  // 拋物線：從目前位置飛到 (x, y)
  function launch(a, x, y) {
    const peak = Math.min(a.y, y) - 60;
    const vy = -Math.sqrt(2 * GRAV * (a.y - peak));
    const t = -vy / GRAV + Math.sqrt(2 * (y - peak) / GRAV);
    a.vx = (x - a.x) / t; a.vy = vy; a.air = true;
  }

  function landOn(a, s) {
    a.air = false; a.vx = 0; a.vy = 0; a.rot = 0; a.y = s.top; a.surf = s.id;
    if (a.act.type !== 'thrown') dust(a.x, a.y, a.kind === 'bear' ? 10 : 4);
    if (a.kind === 'kid' && s.floor && a.x > kidMaxX()) {
      if (a.x >= pit.x1) { sinkIntoPool(a); return true; }
      a.goal = null; say(a, '好險！差點掉進去！', 1.4);
      setAct(a, 'run', { tx: kidMaxX() - 40 }); return true;
    }
    return false;
  }
  // 掉進綠池：慢慢沉下去，然後在籠子裡重生
  function sinkIntoPool(a) {
    a.air = false; a.phone = false; a.goal = null; restoreCell(a, true);
    a.y = FLOOR; a.rot = 0;
    setAct(a, 'sink');
    say(a, '噗通！', 1);
    for (let k = 0; k < 16; k++) parts.push({ kind: 'drop', x: a.x, y: FLOOR - 4, vx: rand(-160, 160), vy: rand(-380, -120), life: 0.9, max: 0.9 });
  }
  function clumsy() {
    if (S.hunting) return false;
    const cands = kids().filter(k => k.surf === 'floor' && !k.air && !k.cell && !k.goal && ['idle', 'walk', 'dance', 'wave'].includes(k.act.type));
    if (!cands.length) return false;
    const k = pick(cands);
    k.phone = true;
    k.sinkMsg = '🙈 ' + tagOf(k.num) + '邊走邊滑手機，不小心掉進綠池了！';
    setAct(k, 'walk', { tx: pit.x1 + 30, clumsy: true });
    say(k, pick(['這遊戲好好玩…', '再一關就好…', '嘿嘿嘿…']), 2.4);
    return true;
  }
  function stepAir(a, dt, targetId) {
    const prevY = a.y;
    a.vy += GRAV * dt; a.x += a.vx * dt; a.y += a.vy * dt;
    a.x = clamp(a.x, 6, W - 6);
    if (a.vy <= 0) return null;
    if (targetId) {
      const s = surfaces.get(targetId);
      if (s && prevY <= s.top + 1 && a.y >= s.top && a.x >= s.x1 - 6 && a.x <= s.x2 + 6) { a.x = clamp(a.x, s.x1, s.x2); return s; }
      if (s && a.y < s.top + 30) return null;
    }
    let best = null;
    for (const s of surfaces.values()) {
      if (a.x < s.x1 || a.x > s.x2) continue;
      if (prevY <= s.top + 1 && a.y >= s.top && (!best || s.top < best.top)) best = s;
    }
    return best;
  }

  // ---------- 小孩自己決定做什麼 ----------
  function chooseKid(a) {
    if (S.hunting && a.fear) return;
    const cur = surf(a.surf);
    // 拿著自己的號碼格：玩一陣子就放回去
    if (a.cell) {
      if (T > a.cell.until) { goReturn(a); return; }
      if (Math.random() < 0.35) { setAct(a, 'juggle', { dur: rand(1.5, 2.5) }); return; }
    } else if (canPull() && Math.random() < 0.45 && tryPull(a)) return;
    // 在高處玩一陣子就下來，地上才會有人（墊腳、搭積木都需要）
    if (!cur.floor && Math.random() < 0.35) { travel(a, 'floor', rand(60, kidMaxX())); return; }
    const r = Math.random();
    const plats = [...surfaces.values()].filter(s => !s.floor && (s.id !== 'tower' || S.tower >= 5));   // 蓋高的積木塔也可以爬
    if (r < 0.28 && plats.length) {
      const s = pick(plats);
      travel(a, s.id, rand(s.x1 + 10, s.x2 - 10));
      return;
    }
    if (r < 0.38 && cur.floor && S.tower < 7) { travel(a, 'floor', pile.x + 20, 'build'); return; }
    if (r < 0.42 && cur.floor && S.tower >= 7) { travel(a, 'floor', towerX - 22, 'kick'); return; }
    if (r < 0.50 && !cur.floor) {
      setAct(a, 'sit', { dur: rand(3, 6) });
      const rightOk = cur.x2 < cage.x1 - 40;     // 右邊下面是骷髏區就坐左邊
      a.x = rightOk && Math.random() < 0.5 ? cur.x2 - 2 : cur.x1 + 2;
      a.f = a.x < (cur.x1 + cur.x2) / 2 ? -1 : 1; return;
    }
    if (r < 0.58) { setAct(a, 'flipHop'); a.vx = rand(-40, 40); a.vy = -520; a.air = true; return; }
    if (r < 0.65) { startDance(a); return; }
    if (r < 0.70) { setAct(a, 'wave', { dur: 1.4 }); return; }
    if (r < 0.74 && cur.floor) { setAct(a, 'sleep', { dur: rand(3, 5) }); return; }
    if (r < 0.79 && cur.floor && tryPush(a)) return;
    const hi = cur.floor ? kidMaxX() : cur.x2 - 6;
    const running = Math.random() < 0.25;
    if (!running && Math.random() < 0.3) a.phone = true;    // 邊走邊滑手機
    setAct(a, running ? 'run' : 'walk', { tx: rand(cur.x1 + 6, hi) });
  }
  function chooseBear(a) {
    const r = Math.random();
    if (r < 0.05 && a.surf === 'floor' && bearSalute(true)) return;
    if (r < 0.4) { startSkill(a, pick(['spike', 'stick', 'fire', 'hike', 'eat', 'shiver'])); return; }
    if (r < 0.6) { const plats = [...surfaces.values()].filter(s => !s.floor && s.x2 - s.x1 > 120); if (plats.length) { const s = pick(plats); travel(a, s.id, rand(s.x1 + 20, s.x2 - 20)); return; } }
    const cur = surf(a.surf);
    setAct(a, 'walk', { tx: rand(cur.x1 + 10, cur.floor ? kidMaxX() : cur.x2 - 10) });
  }

  function onArrive(a) {
    const then = a.goal && a.goal.then;
    a.goal = null;
    if (then === 'build') { a.carry = pick(['#e63946', '#f6c344', '#4cc9f0', '#46d22e', '#9b5de5']); travel(a, 'floor', towerX - 22, 'place'); return; }
    if (then === 'place') {
      a.f = 1;
      if (S.tower < 7) {
        S.tower++;
        S.towerColors = (S.towerColors || []).concat(a.carry);
        measure();
        sparkle(towerX, FLOOR - S.tower * 28);
        if (S.tower === 7) say(a, '蓋好了！', 1.4);
      }
      a.carry = null; setAct(a, 'cheer', { dur: 0.8 }); return;
    }
    if (then === 'kick') {
      a.f = 1;
      if (S.tower > 0) {
        setAct(a, 'punch', { dur: 0.4 });
        for (let i = 0; i < S.tower; i++) parts.push({ kind: 'block', color: (S.towerColors || [])[i] || '#f6c344', x: towerX, y: FLOOR - i * 28 - 14, vx: rand(60, 320), vy: rand(-420, -120), rot: 0, vr: rand(-8, 8), life: 2.2, max: 2.2 });
        S.tower = 0; S.towerColors = [];
        for (const k of agents) if (k.surf === 'tower' && !k.air) { k.surf = 'floor'; k.air = true; k.vy = -100; setAct(k, 'fall'); }
        measure();
        say(a, '倒囉～', 1.2);
      } else setAct(a, 'idle', { dur: 0.4 });
      return;
    }
    if (then === 'grab') return;   // 骷髏自己處理
    setAct(a, 'idle', { dur: rand(0.3, 1.2) });
  }

  // ---------- 更新 ----------
  function update(a, dt) {
    const act = a.act; act.t += dt; a.ph += dt * 7;
    if (a.rope && a.rope.retract != null) { a.rope.retract -= dt; if (a.rope.retract <= 0) a.rope = null; }
    const cur = surf(a.surf);
    switch (act.type) {
      case 'idle':
        a.p = P({ ra2: 0.1 + 0.05 * Math.sin(T * 2 + a.id) });
        if (act.t > (act.dur || 1)) {
          if (a.goal) planStep(a);
          else if (a.kind === 'kid') chooseKid(a);
          else if (a.kind === 'bear') chooseBear(a);
          else if (a.kind === 'skull') skullIdle(a);
        }
        break;
      case 'walk': case 'run': case 'flee': {
        const lo = cur.x1 + 2, hi = cur.x2 - 2;
        const tx = clamp(act.tx, lo, hi);
        const d = tx - a.x;
        a.f = d >= 0 ? 1 : -1;
        const sp = (act.type === 'walk' ? 40 : 140) * (a.kind === 'bear' ? (act.type === 'walk' ? 0.8 : 1.6) : 1) * (a.kind === 'skull' && S.hunting ? 1.1 : 1) * BASE / 1.5;
        if (Math.abs(d) < 3) {
          a.x = tx;
          if (act.clumsy) {
            // 一直看手機，沒發現前面就是綠池
            say(a, '咦？啊啊啊！', 1.2);
            a.air = true; a.vx = 140; a.vy = -240; setAct(a, 'fall');
            break;
          }
          if (a.phone) { a.phone = false; if (Math.random() < 0.5) say(a, '收起來～', 1); }
          if (act.arrive) onArrive(a);
          else if (a.goal) planStep(a);
          else setAct(a, 'idle', { dur: rand(0.3, 1.2) });
        } else { a.x += Math.sign(d) * Math.min(Math.abs(d), sp * dt); a.ph += dt * (act.type === 'walk' ? 2 : 8); }
        a.p = a.carry ? poseCarry(a.ph)
          : act.type === 'walk' ? (a.phone ? posePhone(a.ph) : poseWalk(a.ph, a.kind === 'bear' ? 0.4 : 0.55))
          : act.type === 'run' && a.naruto ? poseNaruto(a.ph)
          : poseRun(a.ph, act.type === 'flee');
        break;
      }
      case 'jumpTo': case 'flipTo': case 'fall': case 'flipHop': case 'thrown': {
        if (act.type === 'flipTo' || act.type === 'flipHop') { a.rot = -a.f * Math.min(1, act.t / 0.6) * Math.PI * 2; a.p = poseTuck(); }
        else if (act.type === 'thrown') { a.rot += dt * 10; a.p = poseDangle(T); }
        else a.p = poseAir();
        const landed = stepAir(a, dt, act.target);
        if (landed) {
          if (act.type === 'thrown') { if (a.x >= pit.x1 - 10) sinkIntoPool(a); else intoCage(a); break; }
          if (landOn(a, landed)) break;
          if (a.missed) { a.missed = false; say(a, '哎呦～丟歪了！', 1.4); }
          if (a.goal) { setAct(a, 'idle', { dur: 0.1 }); }
          else setAct(a, 'idle', { dur: rand(0.2, 0.8) });
        }
        break;
      }
      case 'climb': {
        const s = surfaces.get(act.target);
        if (!s) { setAct(a, 'idle', { dur: 0.3 }); break; }
        a.y -= (a.kind === 'skull' ? 85 : a.kind === 'bear' ? 45 : 70) * BASE / 1.5 * dt;
        a.ph += dt * 6;
        a.p = poseClimb(a.ph * 1.6);
        if (a.y <= s.top) {
          a.y = s.top; a.surf = s.id; a.x = clamp(a.x, s.x1 + 6, s.x2 - 6);
          setAct(a, 'idle', { dur: 0.15 });
        }
        break;
      }
      case 'mantle':
        a.p = P({ lean: 0.55, ra1: 1.3, ra2: 0.5, la1: 1.1, la2: 0.4, rl1: 1.3, rl2: -0.9, ll1: 0.9, ll2: -0.7, hipH: 12 + 10 * Math.min(1, act.t / act.dur) });
        if (act.t > act.dur) setAct(a, 'idle', { dur: 0.1 });
        break;
      case 'puppet':   // 被別人帶著做動作（墊腳的同學、丟人的大熊老師）
        if (act.t > 9) setAct(a, 'idle', { dur: 0.3 });
        break;
      case 'walljump': {
        // 跳起來 → 腳踩牆再蹬一次 → 手抓住邊緣撐上去
        const s = surfaces.get(act.target);
        if (!s) { a.air = true; setAct(a, 'fall'); break; }
        a.vy += GRAV * dt; a.y += a.vy * dt;
        if (act.phase === 0) {
          a.p = poseAir();
          if (a.vy >= 0) {
            act.phase = 1;
            a.vy = -Math.sqrt(2 * GRAV * Math.max(10, a.y - (s.top - 26)));
            dust(a.x + a.f * 8, a.y - 14, 5);
          }
        } else {
          a.p = P({ lean: -0.15, ra1: 2.8, ra2: 3.0, la1: 2.5, la2: 2.9, rl1: 1.35, rl2: 0.6, ll1: 0.3, ll2: -0.5, hipH: 20 });
          if (a.vy >= 0) mantle(a, s, act.edgeIn);
        }
        break;
      }
      case 'hook': {
        // 甩飛爪 → 勾住卡片邊緣 → 沿繩子爬上去 → 收繩
        const s = surfaces.get(act.target);
        if (!s) { a.rope = null; setAct(a, 'idle', { dur: 0.3 }); break; }
        const T1 = 0.8, T2 = 1.25;
        if (act.t < T1) {
          a.p = P({ ra1: 2.6 + Math.sin(act.t * 14) * 0.4, ra2: 2.9, la1: -0.3 });
          a.rope = { spin: act.t * 14 };
        } else if (act.t < T2) {
          a.p = P({ lean: -0.1, ra1: 2.3, ra2: 2.4, la1: -0.4 });
          a.rope = { fly: (act.t - T1) / (T2 - T1), cx: act.cx, top: s.top };
        } else {
          if (!act.attached) { act.attached = true; say(a, '喀！勾住了', 1); a.x = act.cx - a.f * 8; }
          a.rope = { cx: act.cx, top: s.top, bottom: FLOOR };
          a.y -= 100 * BASE / 1.5 * dt; a.ph += dt * 7;
          a.p = poseClimb(a.ph * 1.6);
          if (a.y <= s.top + 2) { a.rope = { cx: act.cx, top: s.top, bottom: FLOOR, retract: 0.35 }; mantle(a, s, act.edgeIn); }
        }
        break;
      }
      case 'boost': {
        // 同學墊腳：同學跑過來蹲下 → 踩背跳上去 → 伸手把同學拉上來
        const s = surfaces.get(act.target), pt = act.partner;
        if (!s || pt.gone || pt.act.type !== 'puppet') { if (!pt.gone && pt.act.type === 'puppet') setAct(pt, 'idle'); a.air = a.y < FLOOR - 1; setAct(a, a.air ? 'fall' : 'idle', { dur: 0.3 }); break; }
        if (act.phase === 0) {
          a.p = poseWave(act.t);
          const d = act.px - pt.x;
          if (Math.abs(d) > 4) { pt.f = Math.sign(d); pt.x += Math.sign(d) * Math.min(Math.abs(d), 170 * dt); pt.ph += dt * 12; pt.p = poseRun(pt.ph); }
          else { act.phase = 1; act.t0 = act.t; pt.f = a.f; pt.p = poseCrouch(); say(pt, '上來吧！', 1.2); }
        } else if (act.phase === 1) {
          pt.p = poseCrouch();
          const k = Math.min(1, (act.t - act.t0) / 0.35);
          a.x += (pt.x - a.x) * k * 0.5; a.y = FLOOR - Math.sin(k * Math.PI / 2) * 22 * pt.s; a.p = poseAir();
          if (k >= 1) {
            act.phase = 2; a.x = pt.x; a.air = true;
            a.vy = -Math.sqrt(2 * GRAV * (a.y - (s.top - 26)));
            a.vx = (act.edgeIn - a.x) / (-a.vy / GRAV);
            say(pt, '唉喲我的背！', 1.2);
          }
        } else if (act.phase === 2) {
          pt.p = poseCrouch();
          a.vy += GRAV * dt; a.y += a.vy * dt; a.x += a.vx * dt; a.p = poseTuck();
          if (a.vy >= 0) { a.air = false; a.vx = 0; a.vy = 0; a.y = s.top; a.x = act.edgeIn; a.surf = s.id; act.phase = 3; act.t0 = act.t; }
        } else {
          // 在上面伸手拉同學
          a.f = act.leftSide ? -1 : 1;
          a.p = P({ lean: 0.75, ra1: 0.35, ra2: 0.1, la1: -0.5, la2: -0.3, hipH: 14 });
          if (!act.pj && act.t - act.t0 > 0.4) {
            act.pj = true;
            const dest = act.edgeIn + (act.leftSide ? 26 : -26);
            pt.air = true; pt.vy = -Math.sqrt(2 * GRAV * (pt.y - (s.top - 26))); pt.vx = (dest - pt.x) / (-pt.vy / GRAV);
            say(a, '抓住我的手！', 1.2);
          }
          if (act.pj && pt.air) {
            pt.vy += GRAV * dt; pt.y += pt.vy * dt; pt.x += pt.vx * dt; pt.p = poseAir();
            if (pt.vy >= 0) {
              pt.air = false; pt.vx = 0; pt.vy = 0; pt.y = s.top; pt.surf = s.id;
              setAct(pt, 'cheer', { dur: 1 }); setAct(a, 'cheer', { dur: 0.8 });
              say(pt, '耶！上來了！', 1.2);
            }
          }
        }
        break;
      }
      case 'bearThrow': {
        // 跑到大熊老師旁邊 → 被舉起來 → 咻一聲丟上去（偶爾丟歪）
        const s = surfaces.get(act.target), b = act.bear;
        if (!s || b.gone || b.act.type !== 'puppet') { if (!b.gone && b.act.type === 'puppet') setAct(b, 'idle'); a.air = a.y < FLOOR - 1; setAct(a, a.air ? 'fall' : 'idle', { dur: 0.3 }); break; }
        if (act.phase === 0) {
          const tx = b.x + (a.x < b.x ? -34 : 34), d = tx - a.x;
          if (Math.abs(d) > 4) { a.f = Math.sign(d); a.x += Math.sign(d) * Math.min(Math.abs(d), 150 * dt); a.ph += dt * 12; a.p = a.naruto ? poseNaruto(a.ph) : poseRun(a.ph); b.p = P({ ra1: 0.4, la1: -0.3 }); }
          else { act.phase = 1; act.t0 = act.t; b.f = Math.sign(a.x - b.x) || 1; say(b, '抓穩了！', 1.2); }
        } else if (act.phase === 1) {
          b.p = P({ ra1: 2.7, ra2: 2.95, la1: 2.5, la2: 2.8, hipH: 21 });
          a.p = poseDangle(T);
          if (b.j) { a.x = b.j.rH[0]; a.y = b.j.rH[1] + 34 * a.s; }
          if (act.t - act.t0 > 0.7) {
            const miss = Math.random() < 0.25;
            const tx = miss ? act.edgeIn + (act.leftSide ? -70 : 70) : act.edgeIn;
            launch(a, tx, miss ? FLOOR : s.top);
            a.missed = miss;
            setAct(a, 'flipTo', { target: miss ? 'floor' : s.id });
            say(b, '飛高高～！', 1.2);
            setAct(b, 'cheer', { dur: 0.8 });
          }
        }
        break;
      }
      case 'sit': {
        a.p = poseSit(act.t, Math.sin(act.t * 1.6) > 0.4);
        a.item = '🧋';
        if (act.t > act.dur) { a.item = null; a.air = true; a.vx = a.f * 90; a.vy = -260; setAct(a, Math.random() < 0.5 ? 'flipHop' : 'fall'); }
        break;
      }
      case 'wave': a.p = poseWave(act.t); if (act.t > act.dur) setAct(a, 'idle', { dur: 0.4 }); break;
      case 'juggle': a.p = P({ ra1: 2.6 + 0.3 * Math.sin(act.t * 10), ra2: 2.9, la1: -2.6 - 0.3 * Math.sin(act.t * 10), la2: -2.9 }); a.toss = Math.abs(Math.sin(act.t * 5)) * 40; if (act.t > act.dur) { a.toss = 0; setAct(a, 'idle', { dur: 0.4 }); } break;
      case 'cheer': a.p = poseCheer(act.t); if (act.t > act.dur) setAct(a, 'idle', { dur: 0.4 }); break;
      case 'dance': {
        const st = act.style;
        if (st === 'dodge') {
          a.p = poseDodge(act.t);
          a.x += Math.cos(act.t * 9) * 90 * dt;            // 左右滑來滑去
          if (Math.random() < dt * 5) dust(a.x, a.y, 1);
        } else if (st === 'shiver') { a.p = poseShiver(act.t); a.rot = 0.05 * Math.sin(act.t * 50); }
        else if (st === 'kpop') { a.p = poseKpop(T); a.f = act.face || a.f; if (Math.random() < dt * 1.5) parts.push({ kind: 'note', x: a.x + rand(-14, 14), y: a.y - 70 * a.s / 1.5, vx: rand(-12, 12), vy: -40, life: 1.2, max: 1.2 }); }
        else a.p = poseDance(act.t);
        if (act.t > act.dur) { a.rot = 0; setAct(a, 'idle', { dur: 0.4 }); }
        break;
      }
      case 'push': {
        // 推一下同學 → 同學踉蹌「幹嘛啦～」→ 請他吃餅乾 → 兩個人一起吃
        const p = act.partner;
        if (p.gone || p.act.type !== 'puppet' || p.air) { a.item = null; setAct(a, 'idle', { dur: 0.3 }); break; }
        if (act.phase === 0) {
          const tx = p.x - act.side * 20 * a.s / 1.5, d = tx - a.x;
          if (Math.abs(d) > 3) { a.f = Math.sign(d); a.x += Math.sign(d) * Math.min(Math.abs(d), 60 * BASE / 1.5 * dt); a.ph += dt * 4; a.p = poseWalk(a.ph); p.p = P({}); p.f = -act.side; }
          else { act.phase = 1; act.t0 = act.t; a.f = act.side; }
        } else if (act.phase === 1) {
          const k = act.t - act.t0;
          a.p = k < 0.25 ? P({ lean: 0.3, ra1: 1.6, ra2: 1.55, la1: 1.4, la2: 1.5, rl1: 0.5, ll1: -0.5, hipH: 20 }) : P({});
          if (k > 0.15 && !act.pushed) { act.pushed = true; say(p, pick(['幹嘛啦～', '欸！幹嘛推我～', '喂～']), 1.4); }
          if (act.pushed && k < 0.7) { p.x = clamp(p.x + act.side * 70 * dt, 10, kidMaxX()); p.p = poseStumble(k); }
          else if (act.pushed) p.p = P({ ra1: 0.9, ra2: 2.4, la1: 0.9, la2: 2.4 });     // 雙手抱胸
          if (k > 1.3) { act.phase = 2; act.t0 = act.t; say(a, pick(['對不起啦，請你吃餅乾！', '好啦好啦，餅乾給你～', '別生氣，吃餅乾！']), 1.8); }
        } else if (act.phase === 2) {
          const k = act.t - act.t0, tx = p.x - act.side * 22 * a.s / 1.5, d = tx - a.x;
          if (Math.abs(d) > 3) { a.x += Math.sign(d) * Math.min(Math.abs(d), 60 * dt); a.p = poseWalk(a.ph += dt * 4); }
          else a.p = P({ ra1: 1.5, ra2: 1.5 });                                          // 把餅乾遞過去
          a.f = act.side; a.item = '🍪';
          if (k > 1.2) { act.phase = 3; act.t0 = act.t; p.item = '🍪'; say(p, pick(['哇！好啦原諒你', '那我就收下了～', '耶！餅乾！']), 1.5); }
        } else {
          const k = act.t - act.t0;
          a.p = poseMunch(k); p.p = poseMunch(k + 0.3);
          if (Math.random() < dt * 6) { const w = Math.random() < 0.5 ? a : p; if (w.j) parts.push({ kind: 'crumb', x: w.j.head[0] + w.f * 6, y: w.j.head[1] + 8, vx: rand(-30, 30), vy: rand(-40, 0), life: 0.7, max: 0.7 }); }
          if (k > 1.4 && !act.yum) { act.yum = true; say(p, '好好吃！', 1.2); }
          if (k > 2.8) { a.item = null; p.item = null; setAct(a, 'cheer', { dur: 0.7 }); setAct(p, 'cheer', { dur: 0.7 }); }
        }
        break;
      }
      case 'stairRide': {
        // 跳上大熊老師的樓梯，原地一直往上爬（樓梯一直往下降）
        const st = S.stairs;
        if (!st) { setAct(a, a.surf === 'floor' && a.y >= FLOOR - 1 ? 'idle' : 'fall', { dur: 0.3 }); a.air = a.y < FLOOR - 1; break; }
        const [sx, sy] = stairSpot(st, act.step);
        if (act.phase === 0) {
          const tx = st.x0 - st.f * 26, d = tx - a.x;
          if (Math.abs(d) > 4) { a.f = Math.sign(d); a.x += Math.sign(d) * Math.min(Math.abs(d), 150 * BASE / 1.5 * dt); a.ph += dt * 10; a.p = a.naruto ? poseNaruto(a.ph) : poseRun(a.ph); }
          else { act.phase = 1; act.t0 = act.t; act.from = [a.x, a.y]; say(a, pick(['我也要！', '衝啊～', '跳上去！']), 1.2); }
        } else if (act.phase === 1) {
          const k = Math.min(1, (act.t - act.t0) / 0.5);
          a.x = act.from[0] + (sx - act.from[0]) * k; a.y = act.from[1] + (sy - act.from[1]) * k - Math.sin(k * Math.PI) * 50;
          a.p = poseAir(); a.f = st.f;
          if (k >= 1) act.phase = 2;
        } else {
          a.x = sx; a.y = sy; a.f = st.f; a.ph += dt * 9;
          a.p = poseWalk(a.ph, 0.6, 0.15);
          if (Math.random() < dt * 0.5) say(a, pick(['好好玩！', '怎麼都爬不上去！', '跑步機樓梯！']), 1.2);
        }
        break;
      }
      case 'greet': {
        // 跑到大熊老師旁邊敬禮
        const b = act.bear;
        if (act.phase === 0) {
          const d = act.tx - a.x;
          if (Math.abs(d) > 4) { a.f = Math.sign(d); a.x += Math.sign(d) * Math.min(Math.abs(d), 140 * BASE / 1.5 * dt); a.ph += dt * 10; a.p = a.naruto ? poseNaruto(a.ph) : poseRun(a.ph); }
          else { act.phase = 1; act.t0 = act.t; }
        } else {
          a.f = Math.sign(b.x - a.x) || 1;
          a.p = act.t - act.t0 > act.delay ? poseSalute() : P({});
          if (!act.said && act.t - act.t0 > act.delay) { act.said = true; if (Math.random() < 0.5) say(a, pick(['老師好！', '大熊老師好！', '敬禮！']), 1.4); }
        }
        if (act.t > 9) setAct(a, 'idle', { dur: 0.3 });
        break;
      }
      case 'taunt': {
        // 裝勇敢：走到骷髏區前面挑釁，骷髏一靠近就嚇呆
        const h = S.hunting && S.hunting.hunter;
        if (act.phase === 0) {
          const d = act.tx - a.x;
          if (Math.abs(d) > 4) { a.f = Math.sign(d); a.x += Math.sign(d) * Math.min(Math.abs(d), 55 * BASE / 1.5 * dt); a.ph += dt * 3; a.p = poseWalk(a.ph, 0.7, -0.15); }
          else { act.phase = 1; act.t0 = act.t; a.f = 1; }
        } else {
          a.f = 1; a.p = poseTaunt(act.t);
          const k = act.t - act.t0;
          const lines = ['來啊！我才不怕你！', '略略略～', '你抓不到我啦！'];
          const i = Math.floor(k / 1.1);
          if (i < lines.length && i !== act.line) { act.line = i; say(a, lines[i], 1.1); }
        }
        if (h && Math.abs(h.x - a.x) < 110 && h.surf === a.surf) { say(a, '…媽、媽呀！', 1.4); setAct(a, 'freeze'); }
        break;
      }
      case 'punch': a.p = P({ lean: 0.25, ra1: 1.57, ra2: 1.57, la1: 0.9, la2: 2.3, rl1: 0.5, ll1: -0.4, hipH: 20 }); if (act.t > act.dur) setAct(a, 'idle', { dur: 0.5 }); break;
      case 'sleep':
        a.p = P({ ra1: 0.3, la1: -0.3 }); a.rot = -a.f * Math.PI / 2;
        if (Math.random() < dt * 1.2) parts.push({ kind: 'z', x: a.x - a.f * 20, y: a.y - 18, vx: -a.f * 6, vy: -20, life: 1.6, max: 1.6 });
        if (act.t > act.dur) { a.rot = 0; setAct(a, 'idle', { dur: 0.3 }); say(a, '嗯？', 1); }
        break;
      case 'freeze': a.p = poseShake(T); if (Math.random() < dt * 2) say(a, pick(['不要過來！', '嗚嗚…', '救命！']), 1); break;
      case 'grabbed': {
        const k = act.by;
        a.p = poseDangle(T);
        const hand = k.j ? k.j.rH : [k.x, k.y - 40];
        a.x = hand[0]; a.y = hand[1] + 26 * a.s;
        break;
      }
      case 'skill': skill(a, act, dt); break;
      case 'sink': {
        a.p = poseDangle(T);
        a.y += 50 * dt; a.rot += dt * 1.2;
        if (Math.random() < dt * 8) parts.push({ kind: 'drop', x: a.x + rand(-10, 10), y: FLOOR - 2, vx: rand(-40, 40), vy: rand(-120, -40), life: 0.5, max: 0.5 });
        if (act.t > 1.1) {
          const msg = a.sinkMsg || ('😱 ' + tagOf(a.num) + '掉進綠池，跑到籠子裡了！');
          intoCage(a);
          sparkle((cage.x1 + cage.x2) / 2, FLOOR - 60);
          banner(msg);
        }
        break;
      }
      case 'skullHome': {
        a.p = poseWalk(a.ph, 0.3);
        if (Math.random() < dt * 0.4) a.f = -a.f;
        a.x += a.f * 14 * dt;
        a.x = clamp(a.x, pit.x1 + 20, pit.x2 - 20);
        break;
      }
    }
    // 走出平台邊緣就掉下去
    if (!a.air && !['climb', 'grabbed', 'sit', 'skill'].includes(act.type) && a.surf !== 'floor') {
      const s = surfaces.get(a.surf);
      if (!s || a.x < s.x1 - 2 || a.x > s.x2 + 2) { a.air = true; a.vy = 0; a.vx = a.f * 40; setAct(a, 'fall'); }
    }
  }

  // ---------- 大熊老師的招式 ----------
  function startSkill(a, k, aim) { setAct(a, 'skill', { k, aim }); }
  function skill(a, act, dt) {
    const k = act.k;
    if (k === 'spike') {
      if (act.t < dt * 1.5) { act.ball = { x: a.x + a.f * 14, y: a.y - 110, vx: 0, vy: -520, r: 9, b: 0 }; balls.push(act.ball); say(a, '看我的殺球！', 1.4); }
      if (act.t > 0.42 && !act.jumped) { act.jumped = true; a.vy = -480; act.y0 = a.y; }
      if (act.jumped && !act.landed) { a.vy += GRAV * dt; a.y += a.vy * dt; if (a.y >= act.y0) { a.y = act.y0; act.landed = true; dust(a.x, a.y, 8); } }
      const hit = act.t > 0.8;
      a.p = !act.jumped ? P({ ra1: 2.6, ra2: 2.8, hipH: 20 }) : P({ lean: 0.2, ra1: hit ? 1.1 : 3.6, ra2: hit ? 1.0 : 3.9, la1: -2.2, la2: -2.4, rl1: 0.6, rl2: -0.4, ll1: -0.3, ll2: -0.6, hipH: 20 });
      if (hit && !act.hit) {
        act.hit = true;
        const b = act.ball, hand = a.j ? a.j.rH : [a.x, a.y - 100];
        b.x = hand[0]; b.y = hand[1] - 6;
        const tgt = act.aim && skulls().find(s => !s.dead);
        if (tgt) { aimBall(b, tgt); b.chain = true; } else { b.vx = a.f * 700; b.vy = 200; }
        sparkle(b.x, b.y);
      }
      if (act.t > 1.6 && act.landed) setAct(a, 'idle', { dur: 0.8 });
      return;
    }
    if (k === 'stick') { if (act.t < dt * 1.5) say(a, '轉轉轉～'); a.p = P({ ra1: 1.2, ra2: 1.6, la1: -0.3, la2: -0.2 }); a.prop = { kind: 'stick', ang: act.t * 18 }; if (act.t > 3) { a.prop = null; setAct(a, 'idle', { dur: 0.6 }); } return; }
    if (k === 'fire') {
      // 轉火繩：兩手往前伸，火球繞圈，越轉越快
      a.p = P({ lean: 0.05, ra1: 1.5 + 0.15 * Math.sin(act.t * 6), ra2: 1.6, la1: 1.2 - 0.15 * Math.sin(act.t * 6), la2: 1.3, rl1: 0.25, rl2: 0.05, ll1: -0.25, ll2: -0.05, hipH: 21 });
      a.prop = { kind: 'fire', ang: act.t * (8 + act.t * 3) };
      if (act.t < dt * 1.5) say(a, '火繩！看好了！', 1.6);
      if (act.t > 3.8) { a.prop = null; setAct(a, 'cheer', { dur: 0.8 }); say(a, '呼～', 1); }
      return;
    }
    if (k === 'hike' && a.surf === 'floor' && !act.old) { setAct(a, 'skill', { k: 'stairs' }); return; }
    if (k === 'stairs') { stairsSkill(a, act, dt); return; }
    if (k === 'shiver') {
      if (act.t < dt * 1.5) say(a, '狗熊哆嗦～', 1.4);
      a.p = poseShiver(act.t); a.hop = Math.abs(Math.sin(act.t * 23)) * 3;
      if (Math.random() < dt * 2) parts.push({ kind: 'note', x: a.x + rand(-30, 30), y: a.y - 120, vx: rand(-12, 12), vy: -40, life: 1.2, max: 1.2 });
      if (act.t > 3) { a.hop = 0; setAct(a, 'idle', { dur: 0.5 }); }
      return;
    }
    if (k === 'salute') {
      // 大家圍過來敬禮 → 老師挺肚子把大家彈開
      if (act.t < 2.6) a.p = poseWave(act.t);
      else if (act.t < 3.3) { a.p = P({ lean: -0.25, ra1: -0.9, ra2: -0.6, la1: -0.7, la2: -0.5, hipH: 22 }); a.belly = 1 + Math.min(0.9, (act.t - 2.6) * 1.6); }
      else a.p = P({ lean: 0.05, ra1: 0.4, la1: -0.4 });
      if (act.t > 2.6 && !act.warn) { act.warn = true; say(a, pick(['太擠了啦！', '肚子攻擊！', '大家退後～']), 1.4); }
      if (act.t > 3.3 && !act.boom) {
        act.boom = true; dust(a.x, a.y, 14);
        for (const k2 of kids()) if (k2.act.type === 'greet' && k2.act.bear === a) {
          const away = Math.sign(k2.x - a.x) || (Math.random() < 0.5 ? -1 : 1);
          const tx = clamp(k2.x + away * rand(110, 220), 30, kidMaxX() - 30);
          launch(k2, tx, FLOOR); k2.surf = 'floor';
          setAct(k2, 'flipHop');
          say(k2, pick(['哇～被彈飛了！', '啊啊啊～', '好有彈性！']), 1.3);
        }
      }
      if (act.t > 4.2) { a.belly = 1; setAct(a, 'idle', { dur: 0.6 }); }
      return;
    }
    if (k === 'hike') {
      const cur = surf(a.surf);
      if (act.t < dt * 1.5) { act.tx = clamp(a.x + a.f * 120, cur.x1 + 20, (cur.floor ? kidMaxX() : cur.x2 - 20)); say(a, '爬山囉…好重…', 2); }
      a.f = Math.sign(act.tx - a.x) || a.f; a.x += Math.sign(act.tx - a.x) * Math.min(Math.abs(act.tx - a.x), 18 * dt); a.ph += dt * 1.5;
      a.p = poseWalk(a.ph, 0.35, 0.45); a.prop = { kind: 'pack' };
      if (Math.random() < dt * 3) parts.push({ kind: 'sweat', x: a.x + a.f * 8, y: a.y - 120, vx: -a.f * 20, vy: -40, life: 0.8, max: 0.8 });
      if (act.t > 4.5) { a.prop = null; setAct(a, 'idle', { dur: 0.6 }); say(a, '呼～到山頂了', 1.4); }
      return;
    }
    if (k === 'eat') {
      const bite = Math.floor(act.t / 0.5);
      if (bite !== act.bite && act.t < 3) { act.bite = bite; parts.push({ kind: 'food', ch: pick(['🍙', '🍗', '🍜', '🍩', '🍔', '🍉']), x: a.x + a.f * rand(60, 100), y: a.y - rand(120, 160), to: a, life: 0.5, max: 0.5 }); }
      a.belly = 1 + Math.min(0.7, act.t * 0.22);
      const chew = Math.sin(act.t * 14) > 0;
      a.p = P({ ra1: chew ? 1.0 : 0.6, ra2: chew ? 2.7 : 1.6, la1: chew ? 0.6 : 1.0, la2: chew ? 1.6 : 2.7 });
      if (act.t < dt * 1.5) say(a, '肚子好餓！', 1.2);
      if (act.t > 3.4 && !act.burp) { act.burp = true; say(a, '嗝～～', 1.4); }
      if (act.t > 4.4) { a.belly = 1; setAct(a, 'idle', { dur: 0.6 }); }
      return;
    }
    setAct(a, 'idle', { dur: 0.5 });
  }
  // ---------- 大熊老師爬「一直往下降」的樓梯 ----------
  const STEP_N = 6;
  function stairSpot(st, k) {      // 第 k 階上面站的位置（跟著樓梯往下降，再往上踩一階）
    const u = k + 0.5 - st.off;
    return [st.x0 + st.f * u * st.w, FLOOR - (k + 1 - st.off) * st.rise];
  }
  function stairsSkill(a, act, dt) {
    if (act.t < dt * 1.5) {
      const w = 36 * BASE / 1.5, rise = 17 * BASE / 1.5, L = STEP_N * w;
      let f = a.f;
      if (a.x + f * (L + 20) > kidMaxX() || a.x + f * (L + 20) < 20) f = -f;
      if (a.x + f * (L + 20) > kidMaxX() || a.x + f * (L + 20) < 20) { setAct(a, 'skill', { k: 'hike', old: true }); return; }
      a.f = f; a.prop = { kind: 'pack' };
      S.stairs = { x0: a.x + f * 16, f, w, rise, off: 0, alpha: 0 };
      act.from = [a.x, a.y];
      say(a, '爬山囉…好重…', 1.8);
    }
    const st = S.stairs; if (!st) { setAct(a, 'idle', { dur: 0.5 }); return; }
    st.alpha = act.t > 8.6 ? Math.max(0, 1 - (act.t - 8.6) / 0.6) : Math.min(1, act.t / 0.5);
    if (act.t < 7) st.off = (st.off + dt * 0.9) % 1;
    const [sx, sy] = stairSpot(st, 2);
    if (act.t < 1.4) {
      // 走上樓梯
      const k = Math.min(1, act.t / 1.4);
      a.x = act.from[0] + (sx - act.from[0]) * k; a.y = act.from[1] + (sy - act.from[1]) * k;
      a.p = poseWalk(a.ph += dt * 2, 0.35, 0.45);
    } else if (act.t < 7) {
      a.x = sx; a.y = sy; a.p = poseWalk(a.ph += dt * 3, 0.4, 0.5);
      if (act.t > 2 && !act.complain) { act.complain = true; say(a, '這樓梯怎麼一直往下降啦！', 2); }
      if (act.t > 2.6 && !act.called) {
        act.called = true;
        const free = kids().filter(k => freeForHelp(k) && Math.abs(k.x - a.x) < 500 && !k.phone).sort((p, q) => Math.abs(p.x - a.x) - Math.abs(q.x - a.x)).slice(0, 3);
        const slots = [0, 4, 5, 1];
        free.forEach((k, i) => { k.goal = null; setAct(k, 'stairRide', { step: slots[i], phase: 0 }); });
      }
      if (Math.random() < dt * 3) parts.push({ kind: 'sweat', x: a.x + a.f * 8, y: a.y - 120, vx: -a.f * 20, vy: -40, life: 0.8, max: 0.8 });
    } else if (act.t < 8.4) {
      // 跌倒，順便把樓梯上的學生踢飛
      const k = Math.min(1, (act.t - 7) / 0.35);
      a.rot = a.f * k * 1.35; a.y = sy + (FLOOR - sy) * k;
      a.p = P({ ra1: 2.4, ra2: 2.6, la1: 2.2, la2: 2.5, rl1: -0.9, rl2: -0.4, ll1: 0.4 });
      if (!act.fell) { act.fell = true; say(a, '哇啊啊啊！', 1.2); }
      if (k >= 1 && !act.kicked) {
        act.kicked = true; dust(a.x, FLOOR, 16);
        for (const kd of kids()) if (kd.act.type === 'stairRide') {
          const tx = clamp(kd.x + rand(-260, 260), 30, kidMaxX() - 30);
          kd.y = Math.min(kd.y, FLOOR - 2); launch(kd, tx, FLOOR); kd.surf = 'floor';
          setAct(kd, 'flipHop'); say(kd, pick(['飛～～！', '哇啊～', '被踢飛了！']), 1.3);
        }
      }
    } else {
      // 爬起來
      const k = Math.min(1, (act.t - 8.4) / 0.6);
      a.rot = a.f * 1.35 * (1 - k); a.y = FLOOR;
      a.p = P({ lean: 0.4 * (1 - k), ra1: 1.2, ra2: 1.6 });
      if (k >= 1 && !act.up) { act.up = true; say(a, '我的背包…', 1.4); }
      if (act.t > 9.8) { act.ending = true; endStairs(a); a.prop = null; a.rot = 0; setAct(a, 'idle', { dur: 0.6 }); }
    }
  }
  function endStairs(b) {
    S.stairs = null;
    b.y = FLOOR; b.rot = 0; b.prop = null;
    for (const k of kids()) if (k.act.type === 'stairRide') { k.air = k.y < FLOOR - 1; k.vx = 0; k.vy = 0; k.surf = 'floor'; setAct(k, k.air ? 'fall' : 'idle', { dur: 0.3 }); }
  }
  function drawStairs() {
    const st = S.stairs; if (!st || st.alpha <= 0) return;
    const X = u => st.x0 + st.f * u * st.w, Y = u => FLOOR - u * st.rise;
    const xa = Math.min(X(0), X(STEP_N)), xb = Math.max(X(0), X(STEP_N));
    g.save(); g.globalAlpha = st.alpha;
    g.beginPath(); g.rect(xa, FLOOR - (STEP_N + 2) * st.rise, xb - xa, (STEP_N + 2) * st.rise + 2); g.clip();
    // 階梯（整排往下滑，看起來像往下的電扶梯）
    g.beginPath(); g.moveTo(X(-1 - st.off), FLOOR + 2);
    for (let i = -1; i <= STEP_N; i++) { const u0 = i - st.off, top = Y(Math.min(STEP_N, i + 1 - st.off)); g.lineTo(X(u0), top); g.lineTo(X(u0 + 1), top); }
    g.lineTo(X(STEP_N + 1 - st.off), FLOOR + 2); g.closePath();
    g.fillStyle = '#4a4860'; g.fill();
    g.strokeStyle = '#d8d6e6'; g.lineWidth = 2;
    for (let i = -1; i <= STEP_N; i++) { const u0 = i - st.off, top = Y(Math.min(STEP_N, i + 1 - st.off)); g.beginPath(); g.moveTo(X(u0), top); g.lineTo(X(u0 + 1), top); g.stroke(); }
    g.restore();
    // 往下的箭頭
    if (st.alpha > 0.5) {
      g.save(); g.globalAlpha = st.alpha * (0.5 + 0.5 * Math.sin(T * 6));
      g.font = '900 16px ' + FONT; g.fillStyle = '#f6c344'; g.textAlign = 'center';
      g.fillText(st.f > 0 ? '⬋' : '⬊', X(STEP_N - 0.5), Y(STEP_N) - 14);
      g.restore();
    }
  }

  // ---------- 小孩的新動作 ----------
  const DANCES = [['dodge', '閃身步！'], ['shiver', '狗熊哆嗦～'], ['kpop', 'K-pop 時間！']];
  function startDance(a, style) {
    const [st, line] = style ? DANCES.find(d => d[0] === style) : pick(DANCES);
    const dur = st === 'kpop' ? rand(3.5, 5) : rand(2.2, 3.2);
    setAct(a, 'dance', { style: st, dur, face: 1 });
    if (Math.random() < 0.7 || style) say(a, line, 1.3);
    if (st === 'kpop' && a.surf === 'floor') {
      // 旁邊的同學一起排成一排跳，動作整齊
      const crew = kids().filter(k => k !== a && freeForHelp(k) && !k.phone && Math.abs(k.x - a.x) < 420).slice(0, 3);
      crew.forEach(k => { k.goal = null; setAct(k, 'dance', { style: 'kpop', dur, face: 1 }); });
      if (crew.length) say(crew[0], '一起跳！', 1.2);
    }
  }
  function tryPush(a, force) {
    if (a.surf !== 'floor' || a.air) return false;
    const p = kids().filter(k => k !== a && freeForHelp(k) && !k.phone && Math.abs(k.x - a.x) < (force ? 2000 : 260)).sort((x, y) => Math.abs(x.x - a.x) - Math.abs(y.x - a.x))[0];
    if (!p) return false;
    let side = Math.sign(p.x - a.x) || 1;                 // 往遠離骷髏區的方向推
    if (p.x + side * 60 > kidMaxX()) side = -1;
    if (p.x + side * 60 < 20) side = 1;
    p.goal = null; setAct(p, 'puppet');
    setAct(a, 'push', { partner: p, side, phase: 0 });
    return true;
  }
  function bearSalute(auto) {
    const b = bear();
    if (!b || S.hunting || b.air || b.surf !== 'floor') return false;
    const crowd = kids().filter(k => freeForHelp(k) && !k.cell).sort((p, q) => Math.abs(p.x - b.x) - Math.abs(q.x - b.x)).slice(0, 8);
    if (crowd.length < 2) return false;
    b.goal = null; b.prop = null; b.hop = 0; b.belly = 1;
    startSkill(b, 'salute');
    say(b, '同學們好！', 1.6);
    const lo = 30, hi = kidMaxX() - 10;
    crowd.forEach((k, i) => {
      const side = i % 2 ? -1 : 1, ring = (i >> 1) + 1;
      let tx = b.x + side * (44 + ring * 26) * BASE / 1.5;
      if (tx > hi || tx < lo) tx = b.x - side * (44 + ring * 26) * BASE / 1.5;
      k.goal = null; k.phone = false;
      setAct(k, 'greet', { bear: b, tx: clamp(tx, lo, hi), phase: 0, delay: rand(0, 0.5) });
    });
    if (!auto) banner('🫡 大熊老師登場！大家圍過去敬禮…');
    return true;
  }
  function aimBall(b, s) {
    const tx = s.x, ty = s.y - 34 * s.s;
    const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy) || 1;
    b.vx = dx / d * 900; b.vy = dy / d * 900; b.target = s;
  }

  // ---------- 骷髏 ----------
  function rebuildSkulls(puff) {
    const O = S.overdue;
    const want = [];
    if (O >= 15) want.push({ tier: 'boss', parts: 3, power: 25 });
    else {
      let rest = O;
      if (O >= 9) { want.push({ tier: 'mid', parts: 3, power: 10 }); rest = O - 9; }
      for (let i = 0; i < Math.floor(rest / 3); i++) want.push({ tier: 'small', parts: 3, power: 3 });
      if (rest % 3) want.push({ tier: 'small', parts: rest % 3, power: 0 });
    }
    const old = skulls().filter(s => s.home);
    for (const s of old) s.gone = true;
    agents = agents.filter(a => !a.gone);
    if (S.defeated) return;
    want.forEach((w, i) => {
      const prev = old[i];
      const s = makeAgent('skull', prev ? prev.x : rand(pit.x1 + 30, pit.x2 - 30), w);
      s.y = FLOOR; s.surf = 'floor';
      setAct(s, 'skullHome');
      agents.push(s);
      if (puff && (!prev || prev.parts !== s.parts || prev.tier !== s.tier)) for (let k = 0; k < 10; k++) parts.push({ kind: 'puff', x: s.x + rand(-20, 20), y: FLOOR - rand(4, 50), vx: rand(-20, 20), vy: rand(-50, -10), life: 0.9, max: 0.9 });
    });
  }
  function skullIdle(a) { if (a.home) setAct(a, 'skullHome'); else setAct(a, 'idle', { dur: 0.2 }); }

  function startHunt(brave, victimNum) {
    if (S.hunting) return false;
    const hunter = skulls().filter(s => s.parts === 3).sort((x, y) => y.s - x.s)[0];
    const target = victimNum != null ? kids().find(k => k.num === victimNum && !k.air && !k.cell && !BUSY_ACTS.includes(k.act.type)) : null;
    if (victimNum != null && !target) return false;
    if (!hunter) {
      // 骷髏還沒拼好：直接被拖進綠池
      if (target) { target.sinkMsg = '💀 ' + tagOf(target.num) + '有作業逾期，被拖進綠池，關進籠子了！補交完就能出來'; target.goal = null; restoreCell(target, true); sinkIntoPool(target); return true; }
      return false;
    }
    const victims = target ? [target] : kids();
    if (!victims.length) return false;
    // 有時候（或按按鈕時）會有人裝勇敢跑去挑釁，結果被抓
    const braves = victims.filter(k => k.surf === 'floor' && !k.air && !k.cell && !BUSY_ACTS.includes(k.act.type));
    const isBrave = !target && braves.length && (brave || Math.random() < 0.4);
    const v = isBrave ? braves.sort((p, q) => q.x - p.x)[Math.floor(Math.random() * Math.min(3, braves.length))] : pick(victims);
    S.hunting = { hunter, v, t: 0 };
    hunter.home = false;
    v.goal = null; v.fear = true; v.carry = null; v.rot = 0; v.phone = false; v.item = null;
    if (isBrave) {
      banner('😤 ' + String(v.num).padStart(2, '0') + ' 號裝勇敢，跑去挑釁骷髏…');
      setAct(v, 'taunt', { tx: kidMaxX() - 8, phase: 0 });
    } else {
      banner(target ? '💀 ' + tagOf(v.num) + '有作業逾期，骷髏爬出來抓人了！' : '💀 骷髏爬出來了！它要抓 ' + tagOf(v.num) + '！');
      if (!v.air && v.act.type !== 'climb') setAct(v, 'freeze');
    }
    for (const k of kids()) if (k !== v && !k.air && !['stairRide', 'push', 'puppet', 'greet'].includes(k.act.type) && Math.random() < 0.7) { k.goal = null; k.carry = null; say(k, pick(['骷髏來了！', '快逃！', '哇啊！']), 1.2); const cs = surf(k.surf); setAct(k, 'flee', { tx: rand(cs.x1, cs.floor ? kidMaxX() : cs.x2) }); }
    say(hunter, '嘿嘿嘿…', 1.6);
    chase(hunter, v);
    return true;
  }
  // 新出現逾期的人排隊被抓
  // 那個人正在跳、在爬、在忙：等一下再抓
  let huntRetry = 0;
  function nextHunt() {
    clearTimeout(huntRetry);
    const waiting = [];
    while (S.huntQueue.length && !S.hunting) {
      const num = S.huntQueue.shift();
      if (!DATA || !DATA.overdue.has(num) || S.caged.includes(num)) continue;
      if (startHunt(false, num)) break;
      if (kids().some(k => k.num === num)) waiting.push(num);
    }
    S.huntQueue.push(...waiting);
    if (S.huntQueue.length && running) huntRetry = setTimeout(nextHunt, 1500);
  }
  function chase(h, v) {
    // 裝勇敢的人還在挑釁：骷髏先在原地等他講完
    if (v.act.type === 'taunt' && (v.act.phase === 0 || v.act.t - v.act.t0 < 3.4)) { setAct(h, 'idle', { dur: 0.3 }); return; }
    if (v.air || v.act.type === 'climb') { setAct(h, 'idle', { dur: 0.3 }); return; }
    if (!['freeze', 'grabbed', 'taunt'].includes(v.act.type)) setAct(v, 'freeze');
    travel(h, v.surf, v.x, 'grab');
    h.goal.run = true;
    h.act.tx = v.x;
  }
  function updateHunt(dt) {
    const H_ = S.hunting; H_.t += dt;
    const { hunter: h, v } = H_;
    if (!H_.caught) {
      if (h.act.type === 'idle' && !h.goal) chase(h, v);
      if (h.surf === v.surf && !h.air && !v.air && Math.abs(h.x - v.x) < 26 * h.s / 1.5) {
        H_.caught = true; h.goal = null; h.f = Math.sign(v.x - h.x) || 1;
        setAct(v, 'grabbed', { by: h });
        say(v, '救命～～', 1.6);
        say(h, '抓到了！', 1.2);
        travel(h, 'floor', pit.x1 + 24, 'home');
      } else if (h.act.type === 'idle' && h.act.t > 0.3) chase(h, v);
    } else if (!H_.thrown && h.surf === 'floor' && Math.abs(h.x - (pit.x1 + 24)) < 8 && !h.air) {
      // 丟進綠池，之後在籠子裡重生
      H_.thrown = true;
      const T0 = 0.8, cx = (pit.x1 + pit.x2) / 2 + 20;
      v.sinkMsg = '😱 ' + tagOf(v.num) + '被骷髏丟進綠池，關進籠子了！' + (DATA && DATA.overdue.has(v.num) ? '補交完就能出來' : '');
      v.air = true; v.vx = (cx - v.x) / T0; v.vy = (FLOOR - v.y - 0.5 * GRAV * T0 * T0) / T0;
      setAct(v, 'thrown');
      say(h, '下去吧！', 1.2);
    } else if (H_.thrown && v.gone) {
      h.home = true; travel(h, 'floor', rand(pit.x1 + 30, pit.x2 - 30), 'home');
      S.hunting = null;
      for (const k of kids()) { k.fear = false; if (k.act.type === 'flee' || k.act.type === 'freeze') setAct(k, 'idle', { dur: rand(0.2, 1) }); }
      setTimeout(nextHunt, 2000);
    }
    if (H_.t > 30 && !H_.caught) { S.hunting = null; v.fear = false; setAct(v, 'idle'); h.home = true; travel(h, 'floor', rand(pit.x1 + 30, pit.x2 - 30)); }
  }

  // ---------- 拔號碼格（只在電腦、滑鼠停 20 秒以上） ----------
  // 只是畫面效果：真正的格子按鈕留在原位、暫時隱藏；滑鼠一動立刻顯示回來
  const FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const IDLE_MS = 20000, MAX_PULLED = 3;
  let lastInput = performance.now(), ignoreUntil = 0;
  const pulledCount = () => kids().filter(k => k.cell || (k.goal && k.goal.then === 'pull')).length;
  function canPull() { return FINE && !S.hunting && performance.now() - lastInput > IDLE_MS && pulledCount() < MAX_PULLED; }
  function cellFor(num) {
    const opts = [];
    for (const card of document.querySelectorAll('.homework-card[data-card-id]')) {
      if (card.classList.contains('dragging')) continue;
      for (const c of card.querySelectorAll('.student-node[data-seat="' + num + '"]')) {
        if (c.style.visibility === 'hidden') continue;
        const r = c.getBoundingClientRect(); if (!r.width) continue;
        opts.push({ card, c, cardId: card.dataset.cardId, seat: num });
      }
    }
    return opts.length ? pick(opts) : null;
  }
  function cellBox(c) {
    const r = c.getBoundingClientRect();
    return { x: r.left + window.scrollX + r.width / 2, y: r.top + window.scrollY + r.height / 2, w: r.width, h: r.height };
  }
  // 看板重畫後（每 10 秒），格子按鈕會換成新的：重新找到同一格
  function findCell(cardId, seat) {
    const card = document.querySelector('.homework-card[data-card-id="' + cardId + '"]');
    const c = card && card.querySelector('.student-node[data-seat="' + seat + '"]');
    return c && c.getBoundingClientRect().width ? { card, c } : null;
  }
  function rebindCells() {
    for (const k of kids()) {
      if (k.cell) {
        const hit = findCell(k.cell.cardId, k.cell.seat);
        if (!hit) { k.cell = null; continue; }
        k.cell.el = hit.c; k.cell.card = hit.card;
        hit.c.style.visibility = 'hidden';
      }
      if (k.target) { const hit = findCell(k.target.cardId, k.target.seat); if (hit) Object.assign(k.target, hit); else { k.target = null; if (k.goal && k.goal.then === 'pull') k.goal = null; } }
    }
  }
  function tryPull(a) {
    const hit = cellFor(a.num); if (!hit) return false;
    const sEntry = surfaces.get('card' + hit.cardId); if (!sEntry) return false;
    const b = cellBox(hit.c);
    a.target = hit;
    travel(a, sEntry.id, b.x, 'pull');
    if (a.goal) { a.goal.run = true; if (a.act.type === 'walk') a.act.type = 'run'; }
    window.__nicePulls = (window.__nicePulls || 0) + 1;
    return true;
  }
  function doPull(a) {
    const hit = a.target; a.target = null;
    if (!hit || !canPullNow() || !hit.c.isConnected) { setAct(a, 'idle', { dur: 0.3 }); return; }
    const b = cellBox(hit.c);
    const owed = Number(hit.c.dataset.status) > 0;
    a.cell = { el: hit.c, card: hit.card, cardId: hit.cardId, seat: hit.seat, num: a.num, color: getComputedStyle(hit.c).backgroundColor, text: hit.c.textContent, owed, until: T + rand(9, 15) };
    hit.c.style.visibility = 'hidden';
    parts.push({ kind: 'cellfly', from: [b.x, b.y], to: a, color: a.cell.color, text: a.cell.text, life: 0.35, max: 0.35 });
    setAct(a, 'cheer', { dur: 0.8 });
    if (owed) {
      say(a, '嘘…藏起來…', 1.8);
      // 彩蛋：拔到自己欠交的格子，被大熊老師發現
      a.cell.until = T + 3.2;
      setTimeout(() => { const b2 = bear(); if (b2 && a.cell && !a.gone) { say(b2, String(a.num).padStart(2, '0') + ' 號！放回去！', 1.8); say(a, '好啦…', 1.4); goReturn(a, true); } }, 2600);
    } else say(a, pick(['我的號碼！', '拔下來囉～', '嘿嘿']), 1.4);
  }
  const canPullNow = () => FINE && !S.hunting && performance.now() - lastInput > IDLE_MS;
  function goReturn(a, hurry) {
    const c = a.cell; if (!c) return;
    const sEntry = surfaces.get('card' + c.cardId);
    if (!sEntry) { restoreCell(a, true); return; }
    travel(a, sEntry.id, cellBox(c.el).x, 'putBack');
    if (hurry && a.goal) a.goal.run = true;
  }
  function restoreCell(a, quick) {
    const c = a.cell; if (!c) return;
    c.el.style.visibility = '';
    const b = cellBox(c.el);
    if (!quick) parts.push({ kind: 'cellfly', from: a.j ? a.j.head : [a.x, a.y - 60], toXY: [b.x, b.y], color: c.color, text: c.text, life: 0.3, max: 0.3 });
    a.cell = null;
  }
  // 老師一動滑鼠：所有格子立刻歸位
  function recallAll() {
    let any = false;
    for (const k of kids()) {
      if (k.cell) { any = true; const c = k.cell; c.el.style.visibility = ''; const b = cellBox(c.el); parts.push({ kind: 'cellfly', from: k.j ? k.j.head : [k.x, k.y - 60], toXY: [b.x, b.y], color: c.color, text: c.text, life: 0.25, max: 0.25 }); k.cell = null; }
      if (k.goal && (k.goal.then === 'pull' || k.goal.then === 'putBack')) { k.goal = null; k.target = null; }
      if (any && k.act.type !== 'grabbed' && !k.air && Math.random() < 0.6) { say(k, pick(['老師來了！', '快放回去！', '沒事沒事～']), 1.2); const cs = surf(k.surf); setAct(k, 'flee', { tx: rand(cs.x1, cs.floor ? kidMaxX() : cs.x2) }); }
    }
    for (const c of document.querySelectorAll('.student-node')) if (c.style.visibility === 'hidden') c.style.visibility = '';
  }
  function onInput() {
    if (performance.now() < ignoreUntil) return;
    const wasIdle = performance.now() - lastInput > IDLE_MS;
    lastInput = performance.now();
    if (wasIdle) recallAll();
  }
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, onInput, { passive: true, capture: true });

  // ---------- 放人 ----------
  function fireworks(n) {
    for (let k = 0; k < n; k++) {
      const x = rand(W * 0.15, W * 0.85), y = rand(120, FLOOR - 300), col = pick(['#f6c344', '#4cc9f0', '#ff4d5e', '#46d22e', '#c77dff']);
      setTimeout(() => { for (let i = 0; i < 26; i++) { const an = i / 26 * Math.PI * 2, sp = rand(140, 260); parts.push({ kind: 'fw', x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp, color: col, life: 1.2, max: 1.2 }); } }, k * 260);
    }
  }
  const tagOf = num => String(num).padStart(2, '0') + ' 號';
  // 某個座號的逾期全部補交完：從籠子放出來；原本欠最多的人是英雄
  function releaseSeat(num, hero, n) {
    const i = S.caged.indexOf(num);
    if (i < 0) return;
    S.caged.splice(i, 1);
    const k = spawnFromCage(num);
    if (hero) {
      say(k, '我補交完了！', 2);
      banner('🦸 ' + tagOf(num) + '把欠的 ' + n + ' 份都補交完，自己衝出籠子！');
      fireworks(n >= 3 ? 6 : 3);
      for (const o of kids()) if (o !== k && !o.air && STANDING.includes(o.act.type) && Math.random() < 0.6) setAct(o, 'cheer', { dur: 1.6 });
      bearAttack();
    } else {
      say(k, '自由啦！', 1.6);
      banner('🎉 恭喜 ' + tagOf(num) + '補交完成，被放出來了！');
      fireworks(1);
    }
  }
  // 某張卡片全班交齊
  function celebrate(names) {
    banner('🎉「' + names[0] + '」全班交齊了！' + (names.length > 1 ? '（還有 ' + (names.length - 1) + ' 張）' : ''));
    fireworks(3);
    for (const o of kids()) if (!o.air && STANDING.includes(o.act.type) && Math.random() < 0.7) setAct(o, 'cheer', { dur: 1.6 });
    const b = bear(); if (b && !b.air && b.act.type !== 'skill') setAct(b, 'cheer', { dur: 1.2 });
  }
  // 大熊老師衝去骷髏區殺球
  function bearAttack() {
    const b = bear(); if (!b || S.hunting || !skulls().some(s => !s.dead)) return;
    b.goal = null; b.prop = null; b.hop = 0; b.belly = 1;
    say(b, '我來了！', 1.4);
    travel(b, 'floor', pit.x1 - 120, 'spike');
    if (b.goal) { b.goal.run = true; if (b.act.type === 'walk') b.act.type = 'run'; }
  }
  function spawnFromCage(num) {
    const k = makeAgent('kid', cage.x1 - 8, { num });
    k.y = FLOOR; k.air = true; k.vx = -rand(90, 160); k.vy = -560;
    setAct(k, 'flipHop');
    agents.push(k);
    sparkle(cage.x1, FLOOR - 60);
    chips();
    return k;
  }

  // ---------- 籠子 ----------
  function intoCage(a) {
    restoreCell(a, true);
    a.gone = true;
    agents = agents.filter(x => x !== a);
    if (a.kind === 'kid') {
      S.caged.push(a.num);
      if (!DATA || !DATA.overdue.has(a.num)) setTimeout(() => {
        const i = S.caged.indexOf(a.num); if (i < 0 || (DATA && DATA.overdue.has(a.num))) return;
        S.caged.splice(i, 1);
        const k = spawnFromCage(a.num); say(k, '呼～出來了', 1.4);
        banner('😮‍💨 ' + tagOf(a.num) + '沒有欠交，從籠子出來了～');
      }, 7000);
    }
    for (let k = 0; k < 8; k++) parts.push({ kind: 'puff', grey: true, x: rand(cage.x1 + 10, cage.x2 - 10), y: FLOOR - rand(10, 60), vx: rand(-20, 20), vy: rand(-40, -10), life: 0.8, max: 0.8 });
    chips();
  }
  // ---------- 特效 ----------
  function dust(x, y, n) { for (let k = 0; k < n; k++) parts.push({ kind: 'dust', x: x + rand(-10, 10), y, vx: rand(-60, 60), vy: rand(-50, -5), life: 0.6, max: 0.6 }); }
  function sparkle(x, y) { parts.push({ kind: 'spark', x, y, vx: 0, vy: 0, life: 0.6, max: 0.6 }); }
  function killSkull(s) {
    if (s.dead) return;
    s.dead = true; s.gone = true;
    for (let k = 0; k < 14; k++) parts.push({ kind: 'bone', x: s.x, y: s.y - 30 * s.s, vx: rand(-260, 260), vy: rand(-480, -150), rot: rand(0, 6), vr: rand(-12, 12), life: 2, max: 2, s: s.s });
    for (let k = 0; k < 12; k++) parts.push({ kind: 'puff', x: s.x + rand(-20, 20) * s.s, y: s.y - rand(5, 50) * s.s, vx: rand(-40, 40), vy: rand(-60, -10), life: 1, max: 1 });
    setTimeout(() => { if (!skulls().some(k => !k.dead)) banner('🎉 大熊老師一記殺球，骷髏被打散了！（逾期沒補完，明天還會拼回來）'); }, 0);
  }
  // 橫幅排隊：同時發生好幾件事（例如英雄補交＋全班交齊）時輪流顯示，每則至少 2.8 秒
  let bannerTimer = 0, bannerUntil = 0;
  const bannerQueue = [];
  function banner(text) {
    if (performance.now() < bannerUntil) { if (!bannerQueue.includes(text) && bannerQueue.length < 4) bannerQueue.push(text); return; }
    showBanner(text);
  }
  function showBanner(text) {
    bannerUntil = performance.now() + 2800;
    setTimeout(() => { if (bannerQueue.length) showBanner(bannerQueue.shift()); }, 2800);
    let el = document.getElementById('bannerEl');
    if (!el) {
      el = document.createElement('div'); el.id = 'bannerEl';
      el.style.cssText = 'position:fixed;left:50%;top:calc(12px + env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:20;background:rgba(21,20,27,.94);border:2px solid #f6c344;color:#f2f0f8;font-weight:900;padding:8px 16px;border-radius:12px;max-width:calc(100% - 32px);text-align:center;pointer-events:none;transition:opacity .25s';
      document.body.appendChild(el);
    }
    el.textContent = text; el.style.opacity = '1';
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { el.style.opacity = '0'; }, 3200);
  }

  // ---------- 繪圖 ----------
  function joints(p, s, f, isBear) {
    const dir = (a, l) => [Math.sin(a) * f * l, Math.cos(a) * l];
    const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
    const TL = isBear ? 15 : 16, HD = isBear ? 8 : 8.5, UA = isBear ? 8 : 9, UL = isBear ? 9 : 11;
    const hip = [0, 0];
    const neck = add(hip, dir(Math.PI - p.lean, TL * s));
    const head = add(neck, dir(Math.PI - p.lean - p.tilt, HD * s));
    const sh = isBear ? add(neck, dir(Math.PI - p.lean, -2 * s)) : neck;
    const rE = add(sh, dir(p.ra1, UA * s)), rH = add(rE, dir(p.ra2, UA * s));
    const lE = add(sh, dir(p.la1, UA * s)), lH = add(lE, dir(p.la2, UA * s));
    const rK = add(hip, dir(p.rl1, UL * s)), rF = add(rK, dir(p.rl2, UL * s));
    const lK = add(hip, dir(p.ll1, UL * s)), lF = add(lK, dir(p.ll2, UL * s));
    return { hip, neck, head, sh, rE, rH, lE, lH, rK, rF, lK, lF, legLen: UL * 2 };
  }
  function roundRect(x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function poly(pts) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.stroke(); }

  function drawAgent(a) {
    const p = a.p || P({});
    const isBear = a.kind === 'bear';
    const j = joints(p, a.s, a.f, isBear);
    const legScale = j.legLen / 22;
    let hy = a.y - p.hipH * a.s * legScale - (a.hop || 0);
    if (a.act.type === 'sleep') hy = a.y - 4 * a.s;
    const hx = a.x;
    const c = Math.cos(a.rot || 0), sn = Math.sin(a.rot || 0);
    const W2 = q => [hx + q[0] * c - q[1] * sn, hy + q[0] * sn + q[1] * c];
    g.save(); g.translate(hx, hy); g.rotate(a.rot || 0);
    g.lineCap = 'round'; g.lineJoin = 'round';
    const s = a.s;
    // 黑色角色在深色看板上加一圈白光邊，才看得清楚
    if (a.kind !== 'skull') { g.shadowColor = 'rgba(255,255,255,0.95)'; g.shadowBlur = 5; }
    if (a.kind === 'skull') drawSkullBody(a, j, s);
    else if (!isBear) drawKid(a, j, s);
    g.restore();
    a.j = isBear ? drawBearReal(a) : { rH: W2(j.rH), lH: W2(j.lH), head: W2(j.head) };
    if (a.phone && !isBear) {
      const [x, y] = a.j.rH;
      g.save(); g.shadowColor = 'rgba(143,211,255,0.9)'; g.shadowBlur = 8;
      g.fillStyle = '#121218'; roundRect(x - 4, y - 12, 8, 13, 2); g.fill();
      g.fillStyle = '#8fd3ff'; g.fillRect(x - 2.6, y - 10.5, 5.2, 9.5);
      g.restore();
    }
    if (a.prop && a.prop.kind === 'fire') drawFireRopes(a);
    if (a.rope) drawRope(a);
    // 道具
    if (a.prop && a.prop.kind === 'stick') {
      const [x, y] = a.j.rH, ang = a.prop.ang, L = 26 * s;
      g.strokeStyle = '#8a5a2b'; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x - Math.cos(ang) * L, y - Math.sin(ang) * L); g.lineTo(x + Math.cos(ang) * L, y + Math.sin(ang) * L); g.stroke();
    }
    if (a.prop && a.prop.kind === 'rope') {
      const [x1, y1] = a.j.lH, [x2, y2] = a.j.rH, ph = a.prop.ph;
      const cy = (a.y - 30 * s) + Math.cos(ph) * 50 * s;
      g.strokeStyle = '#e76f51'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo((x1 + x2) / 2 + Math.sin(ph) * 30 * s, cy + (Math.cos(ph) > 0 ? 20 : -20) * s, x2, y2); g.stroke();
    }
    if (a.carry) {
      const [x, y] = a.j.head;
      g.fillStyle = a.carry; g.strokeStyle = INK; g.lineWidth = 2;
      roundRect(x - 13, y - 13 * s - 30, 26, 26, 4); g.fill(); g.stroke();
    }
    if (a.cell) {
      const [x, y] = a.j.head;
      drawCell(x, y - 9 * s - 22 - (a.toss || 0), a.cell, 1);
    }
    if (a.item) { g.font = (16 * s / 1.5 + 4) + 'px ' + FONT; g.textAlign = 'center'; g.fillText(a.item, a.j.rH[0] + a.f * 4, a.j.rH[1] + 6); g.textAlign = 'left'; }
    if (isBear && a.act.type !== 'grabbed') { g.font = '900 13px ' + FONT; g.textAlign = 'center'; g.fillStyle = '#f6c344'; g.strokeStyle = INK; g.lineWidth = 3; g.strokeText('大熊老師', a.j.head[0], a.j.head[1] - 18 * s); g.fillText('大熊老師', a.j.head[0], a.j.head[1] - 18 * s); g.textAlign = 'left'; }
    if (a.say && a.say.until > T) bubble(a.j.head[0], a.j.head[1] - (isBear ? 34 : a.kind === 'skull' ? 22 : 14) * s, a.say.text);
  }

  function drawKid(a, j, s) {
    g.strokeStyle = INK; g.fillStyle = INK; g.lineWidth = 3.4 * s;
    poly([j.lH, j.lE, j.neck]); poly([j.lF, j.lK, j.hip]);
    poly([j.hip, j.neck]);
    poly([j.rF, j.rK, j.hip]); poly([j.rH, j.rE, j.neck]);
    const r = 7.5 * s;
    g.beginPath(); g.arc(j.head[0], j.head[1], r, 0, Math.PI * 2); g.fill();
    // 頭上的白色座號（翻跟斗時也跟著轉）
    g.fillStyle = '#ffffff';
    g.font = '900 ' + (a.num >= 10 ? 8.4 : 9.5) * s + 'px ' + FONT;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(a.num).padStart(2, '0'), j.head[0], j.head[1] + 0.6 * s);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }

  // ---------- 大熊老師：台灣黑熊剪影 ----------
  // 平常四隻腳走；出招、歡呼、爬東西時站起來（站高 176 公分）。胸口有台灣黑熊的白色 V 字。
  // 先用白色畫一層加粗的外框，再用黑色畫一次，剪影在深色看板上才看得清楚。
  const QUAD_ACTS = ['idle', 'walk', 'run', 'flee', 'fall', 'jumpTo', 'flipTo'];
  function drawBearReal(a) {
    const c = CM(), f = a.f, quad = QUAD_ACTS.includes(a.act.type) && !a.prop;
    const p = a.p || P({});
    const rot = a.rot || 0, hop = a.hop || 0;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const toWorld = (lx, ly) => { const x = lx * f * c, y = ly * c; return [a.x + x * cos - y * sin, a.y - hop + x * sin + y * cos]; };
    g.save();
    g.translate(a.x, a.y - hop); g.rotate(rot); g.scale(f * c, c);
    g.lineCap = 'round'; g.lineJoin = 'round';
    const ell = (x, y, rx, ry, r) => { g.beginPath(); g.ellipse(x, y, rx, ry, r || 0, 0, Math.PI * 2); g.fill(); };
    const limb = (x1, y1, x2, y2, w) => { g.lineWidth = w; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
    const dir = (ang, l) => [Math.sin(ang) * l, Math.cos(ang) * l];
    let local;
    const draw = (pass) => {
      const out = pass === 0 ? 5 / c : 0;          // 白色外框加粗
      const col = pass === 0 ? 'rgba(235,235,245,0.92)' : '#121218';
      g.fillStyle = col; g.strokeStyle = col;
      const E = (x, y, rx, ry, r) => ell(x, y, rx + out, ry + out, r);
      const Lm = (x1, y1, x2, y2, w) => limb(x1, y1, x2, y2, w + out * 2);
      if (quad) {
        const moving = ['walk', 'run', 'flee'].includes(a.act.type);
        const amp = a.act.type === 'walk' ? 0.32 : moving ? 0.6 : 0.03;
        const ph = a.ph * (a.act.type === 'walk' ? 1 : 1.4);
        const bob = moving ? Math.abs(Math.sin(ph)) * 2.5 : 0;
        const leg = (jx, off, w) => { const an = Math.sin(ph + off) * amp; Lm(jx, -50 - bob, jx + Math.sin(an) * 48, -50 - bob + Math.cos(an) * 48, w); E(jx + Math.sin(an) * 48 + 4, -2, 9, 4.5); };
        leg(26, Math.PI, 15); leg(-48, 0, 15);                        // 遠側的腳
        E(-38, -66 - bob, 30, 27); E(0, -64 - bob, 60, 31); E(28, -79 - bob, 28, 21);  // 屁股、身體、肩膀隆起
        E(-68, -70 - bob, 6, 6);                                        // 小尾巴
        E(58, -76 - bob, 20, 17, -0.3);                                 // 脖子
        E(78, -80 - bob, 19, 16);                                       // 頭
        E(95, -74 - bob, 13, 8, 0.15);                                  // 嘴巴
        E(70, -95 - bob, 6.5, 6.5); E(82, -96 - bob, 5.5, 5.5);         // 耳朵
        leg(36, 0, 16); leg(-40, Math.PI, 16);                          // 近側的腳
        local = { head: [80, -82 - bob], rH: [100, -72 - bob], lH: [96, -70 - bob], v: [[62, -66], [68, -57], [76, -67]], eye: [87, -84 - bob] };
      } else {
        const hipY = -62 * (p.hipH / 22);
        const up = (l) => [Math.sin(p.lean) * l, hipY - Math.cos(p.lean) * l];
        const b = a.belly || 1;
        // 腳
        const lk = [dir(p.ll1, 30)[0], hipY + dir(p.ll1, 30)[1]], lf = [lk[0] + dir(p.ll2, 30)[0], lk[1] + dir(p.ll2, 30)[1]];
        const rk = [dir(p.rl1, 30)[0], hipY + dir(p.rl1, 30)[1]], rf = [rk[0] + dir(p.rl2, 30)[0], rk[1] + dir(p.rl2, 30)[1]];
        Lm(0, hipY, lk[0], lk[1], 19); Lm(lk[0], lk[1], lf[0], lf[1], 17); E(lf[0] + 5, lf[1], 10, 5);
        // 遠側的手
        const sh = up(68); sh[0] += 6;
        const le = [sh[0] + dir(p.la1, 30)[0], sh[1] + dir(p.la1, 30)[1]], lh = [le[0] + dir(p.la2, 26)[0], le[1] + dir(p.la2, 26)[1]];
        Lm(sh[0], sh[1], le[0], le[1], 15); Lm(le[0], le[1], lh[0], lh[1], 13); E(lh[0], lh[1], 7, 7);
        // 身體和大肚子
        const tc = up(42);
        E(tc[0], tc[1], 30, 44, p.lean);
        E(tc[0] + 9 * b, tc[1] + 10, 25 * b, 31 * b, p.lean);
        // 近側的腳
        Lm(0, hipY, rk[0], rk[1], 20); Lm(rk[0], rk[1], rf[0], rf[1], 18); E(rf[0] + 5, rf[1], 10, 5);
        // 頭
        const nk = up(84);
        const hc = [nk[0] + 6 + Math.sin(p.lean + p.tilt) * 12, nk[1] - Math.cos(p.lean + p.tilt) * 12];
        E(hc[0], hc[1], 19, 16); E(hc[0] + 17, hc[1] + 5, 12, 8, 0.12);
        E(hc[0] - 6, hc[1] - 14, 6.5, 6.5); E(hc[0] + 6, hc[1] - 16, 5.5, 5.5);
        // 近側的手
        const re = [sh[0] + dir(p.ra1, 30)[0], sh[1] + dir(p.ra1, 30)[1]], rh = [re[0] + dir(p.ra2, 26)[0], re[1] + dir(p.ra2, 26)[1]];
        Lm(sh[0], sh[1], re[0], re[1], 16); Lm(re[0], re[1], rh[0], rh[1], 14); E(rh[0], rh[1], 7.5, 7.5);
        if (pass === 1 && a.prop && a.prop.kind === 'pack') {
          g.fillStyle = '#5b6b8a'; g.strokeStyle = '#121218'; g.lineWidth = 3;
          roundRect(tc[0] - 52, tc[1] - 34, 28, 54, 6); g.fill(); g.stroke();
          g.fillStyle = col;
        }
        local = { head: [hc[0], hc[1]], rH: rh, lH: lh, v: [[sh[0] + 2, sh[1] + 6], [sh[0] + 9, sh[1] + 15], [sh[0] + 17, sh[1] + 5]], eye: [hc[0] + 8, hc[1] - 3] };
      }
    };
    draw(0); draw(1);
    // 台灣黑熊胸口的白色 V 字和眼睛
    g.strokeStyle = '#f2f0f8'; g.lineWidth = 3.5;
    g.beginPath(); g.moveTo(...local.v[0]); g.lineTo(...local.v[1]); g.lineTo(...local.v[2]); g.stroke();
    g.fillStyle = '#f2f0f8'; g.beginPath(); g.arc(local.eye[0], local.eye[1], 1.9, 0, Math.PI * 2); g.fill();
    g.restore();
    return { head: toWorld(...local.head), rH: toWorld(...local.rH), lH: toWorld(...local.lH) };
  }

  // 飛爪繩：甩圈 → 飛出去 → 勾在卡片邊緣垂下來 → 爬完往上收
  function drawHook(x, y, ang) {
    g.save(); g.translate(x, y); g.rotate(ang || 0);
    g.strokeStyle = '#b8b8c6'; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -8); g.stroke();
    for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(sx * 7, 1, sx * 7, -5); g.stroke(); }
    g.restore();
  }
  function drawRope(a) {
    const r = a.rope;
    g.strokeStyle = '#d6b07a'; g.lineWidth = 2.5; g.lineCap = 'round';
    if (r.spin !== undefined) {
      const h = a.j.rH, R = 16;
      const hx = h[0] + Math.cos(r.spin) * R, hy = h[1] + Math.sin(r.spin) * R;
      g.beginPath(); g.moveTo(h[0], h[1]); g.lineTo(hx, hy); g.stroke();
      drawHook(hx, hy, r.spin + Math.PI / 2);
    } else if (r.fly !== undefined) {
      const h = a.j.rH, k = r.fly;
      const hx = h[0] + (r.cx - h[0]) * k, hy = h[1] + (r.top - h[1]) * k - Math.sin(k * Math.PI) * 70;
      g.beginPath(); g.moveTo(h[0], h[1]); g.quadraticCurveTo((h[0] + hx) / 2, Math.max(h[1], hy) + 20, hx, hy); g.stroke();
      drawHook(hx, hy, k * 8);
    } else {
      const len = (r.bottom - r.top) * (r.retract != null ? Math.max(0, r.retract / 0.35) : 1);
      const sway = Math.sin(T * 3) * 3;
      g.beginPath(); g.moveTo(r.cx, r.top); g.quadraticCurveTo(r.cx + sway * 2, r.top + len / 2, r.cx + sway, r.top + len); g.stroke();
      drawHook(r.cx, r.top + 2, Math.PI);
    }
  }

  // 轉火繩：兩條繩子在熊掌上繞圈，尾端是火球，邊轉邊噴火花
  function drawFireRopes(a) {
    const R = 36 * CM(), ang = a.prop.ang;
    for (const [hand, off] of [[a.j.rH, 0], [a.j.lH, Math.PI]]) {
      const bx = hand[0] + Math.cos(ang + off) * R, by = hand[1] + Math.sin(ang + off) * R;
      g.strokeStyle = 'rgba(255,170,60,0.25)'; g.lineWidth = 6;
      g.beginPath(); g.arc(hand[0], hand[1], R, ang + off - 1.4, ang + off); g.stroke();
      g.strokeStyle = '#c9a26b'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(hand[0], hand[1]); g.lineTo(bx, by); g.stroke();
      const gr = g.createRadialGradient(bx, by, 1, bx, by, 14);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.3, '#ffe066'); gr.addColorStop(0.7, '#ff7b00'); gr.addColorStop(1, 'rgba(255,60,0,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(bx, by, 14, 0, Math.PI * 2); g.fill();
      if (Math.random() < 0.8) parts.push({ kind: 'flame', x: bx, y: by, vx: rand(-30, 30), vy: rand(-90, -30), life: 0.5, max: 0.5 });
    }
  }

  // （舊版的泰迪熊畫法，已不使用）
  function drawBear(a, j, s) {
    const BLACK = '#121218', DARK = '#2a2a33', GREY = '#3c3c48';
    const limb = (pts, w, col) => { g.strokeStyle = col; g.lineWidth = w; poly(pts); };
    if (a.prop && a.prop.kind === 'pack') {
      const mx = (j.hip[0] + j.neck[0]) / 2 - a.f * 11 * s, my = (j.hip[1] + j.neck[1]) / 2 - 4 * s;
      g.fillStyle = '#5b6b8a'; g.strokeStyle = BLACK; g.lineWidth = 2 * s;
      roundRect(mx - 9 * s, my - 15 * s, 18 * s, 28 * s, 5 * s); g.fill(); g.stroke();
    }
    limb([j.sh, j.lE, j.lH], 6.5 * s, DARK);
    g.fillStyle = DARK; g.beginPath(); g.arc(j.lH[0], j.lH[1], 3.6 * s, 0, Math.PI * 2); g.fill();
    limb([j.hip, j.lK, j.lF], 7 * s, DARK);
    g.beginPath(); g.ellipse(j.lF[0] + a.f * 2 * s, j.lF[1], 5 * s, 3 * s, 0, 0, Math.PI * 2); g.fill();
    const b = a.belly || 1;
    const p = a.p || P({});
    const mx = (j.hip[0] + j.neck[0]) / 2 + a.f * 2 * s * b, my = (j.hip[1] + j.neck[1]) / 2 + 1 * s;
    g.fillStyle = BLACK; g.beginPath(); g.ellipse(mx, my, 10 * s * b, 12.5 * s * Math.sqrt(b), -p.lean * a.f, 0, Math.PI * 2); g.fill();
    g.fillStyle = GREY; g.beginPath(); g.ellipse(mx + a.f * 3 * s * b, my + 1.5 * s, 6 * s * b, 8 * s * Math.sqrt(b), -p.lean * a.f, 0, Math.PI * 2); g.fill();
    limb([j.hip, j.rK, j.rF], 7 * s, BLACK);
    g.fillStyle = BLACK; g.beginPath(); g.ellipse(j.rF[0] + a.f * 2 * s, j.rF[1], 5 * s, 3 * s, 0, 0, Math.PI * 2); g.fill();
    limb([j.sh, j.rE, j.rH], 6.5 * s, BLACK);
    g.beginPath(); g.arc(j.rH[0], j.rH[1], 3.6 * s, 0, Math.PI * 2); g.fill();
    const [qx, qy] = j.head;
    for (const ex of [-1, 1]) {
      g.fillStyle = BLACK; g.beginPath(); g.arc(qx + ex * 5.6 * s, qy - 6.4 * s, 3.4 * s, 0, Math.PI * 2); g.fill();
      g.fillStyle = GREY; g.beginPath(); g.arc(qx + ex * 5.6 * s, qy - 6.4 * s, 1.6 * s, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = BLACK; g.beginPath(); g.arc(qx, qy, 8.5 * s, 0, Math.PI * 2); g.fill();
    g.fillStyle = GREY; g.beginPath(); g.ellipse(qx + a.f * 4.5 * s, qy + 2.5 * s, 5 * s, 3.8 * s, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = BLACK; g.beginPath(); g.ellipse(qx + a.f * 7.6 * s, qy + 0.9 * s, 1.9 * s, 1.4 * s, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(qx + a.f * 2.6 * s, qy - 2.4 * s, 1.3 * s, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(qx - a.f * 1.6 * s, qy - 2.6 * s, 1.1 * s, 0, Math.PI * 2); g.fill();
  }

  function bone(x1, y1, x2, y2, s) {
    g.strokeStyle = INK; g.lineWidth = 5.5 * s; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.strokeStyle = BONE; g.lineWidth = 3 * s; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }
  function skullHead(x, y, s, tier, rot) {
    g.save(); g.translate(x, y); g.rotate(rot || 0);
    if (tier === 'boss') { g.fillStyle = INK; for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * 4 * s, -5 * s); g.lineTo(sx * 10 * s, -15 * s); g.lineTo(sx * 7 * s, -3 * s); g.closePath(); g.fill(); } }
    g.fillStyle = BONE; g.strokeStyle = INK; g.lineWidth = 2 * s;
    g.beginPath(); g.arc(0, 0, 7.5 * s, 0, Math.PI * 2); g.fill(); g.stroke();
    roundRect(-4.2 * s, 3 * s, 8.4 * s, 6 * s, 1.5 * s); g.fill(); g.stroke();
    g.fillStyle = INK;
    g.beginPath(); g.arc(-3 * s, -0.8 * s, 2.3 * s, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(3 * s, -0.8 * s, 2.3 * s, 0, Math.PI * 2); g.fill();
    g.fillStyle = tier === 'boss' ? '#ff4d5e' : SLIME;
    g.beginPath(); g.arc(-3 * s, -0.8 * s, 0.9 * s, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(3 * s, -0.8 * s, 0.9 * s, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  function drawSkullBody(a, j, s) {
    if (a.tier !== 'small') { g.shadowColor = a.tier === 'boss' ? 'rgba(255,77,94,.9)' : 'rgba(70,210,46,.95)'; g.shadowBlur = 18; }
    const hipY = a.p ? a.p.hipH * s : 22 * s;
    if (a.parts === 1) { skullHead(0, hipY - 7.5 * s, s, a.tier, Math.sin(T * 2 + a.id) * 0.5); g.shadowBlur = 0; return; }
    if (a.parts === 2) {
      const base = hipY;
      const hip = [-a.f * 10 * s, base - 5 * s], neck = [a.f * 8 * s, base - 11 * s];
      bone(hip[0], hip[1], neck[0], neck[1], s);
      for (const k of [0, Math.PI]) {
        const sw = Math.sin(a.ph + k);
        const hand = [neck[0] + a.f * (10 + 5 * sw) * s, base - 1];
        const el = [neck[0] + a.f * (5 + 2 * sw) * s, base - (12 + 4 * Math.max(0, sw)) * s];
        bone(neck[0], neck[1], el[0], el[1], s); bone(el[0], el[1], hand[0], hand[1], s);
      }
      skullHead(neck[0] + a.f * 7 * s, neck[1] - 5 * s, s, a.tier, a.f * 0.3);
      g.shadowBlur = 0; return;
    }
    bone(j.hip[0], j.hip[1], j.lK[0], j.lK[1], s); bone(j.lK[0], j.lK[1], j.lF[0], j.lF[1], s);
    bone(j.neck[0], j.neck[1], j.lE[0], j.lE[1], s); bone(j.lE[0], j.lE[1], j.lH[0], j.lH[1], s);
    bone(j.hip[0], j.hip[1], j.neck[0], j.neck[1], s);
    bone(j.hip[0], j.hip[1], j.rK[0], j.rK[1], s); bone(j.rK[0], j.rK[1], j.rF[0], j.rF[1], s);
    bone(j.neck[0], j.neck[1], j.rE[0], j.rE[1], s); bone(j.rE[0], j.rE[1], j.rH[0], j.rH[1], s);
    skullHead(j.head[0], j.head[1], s, a.tier, a.f * 0.08 * Math.sin(T * 3));
    g.shadowBlur = 0;
  }
  function bubble(x, y, text) {
    g.font = '700 13px ' + FONT;
    const w = g.measureText(text).width + 16;
    const bx = clamp(x - w / 2, 4, W - w - 4);
    g.fillStyle = '#ffffff'; g.strokeStyle = INK; g.lineWidth = 1.5;
    roundRect(bx, y - 22, w, 22, 9); g.fill(); g.stroke();
    g.fillStyle = INK; g.fillText(text, bx + 8, y - 6.5);
  }

  function drawWorld() {
    g.clearRect(0, 0, W, H);
    // 地面線
    g.strokeStyle = '#3e3e50'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, FLOOR + 1); g.lineTo(W, FLOOR + 1); g.stroke();
    // 積木堆和積木塔
    const colors = ['#e63946', '#f6c344', '#4cc9f0', '#46d22e', '#9b5de5', '#f4a261'];
    for (let i = 0; i < 6; i++) { g.fillStyle = colors[i]; g.strokeStyle = INK; g.lineWidth = 2; roundRect(pile.x - 30 + (i % 3) * 28 + (i > 2 ? 14 : 0), FLOOR - 28 - (i > 2 ? 28 : 0), 26, 26, 4); g.fill(); g.stroke(); }
    g.font = '700 12px ' + FONT; g.fillStyle = '#6c6a80'; g.fillText('積木', pile.x - 10, FLOOR + 22);
    drawStairs();
    for (let i = 0; i < S.tower; i++) { g.fillStyle = (S.towerColors || [])[i] || '#f6c344'; g.strokeStyle = INK; g.lineWidth = 2; roundRect(towerX - 14, FLOOR - (i + 1) * 28, 28, 28, 4); g.fill(); g.stroke(); }
    // 右下角：骷髏區
    const grd = g.createRadialGradient(pit.x2, FLOOR, 10, pit.x2, FLOOR, pit.x2 - pit.x1 + 60);
    grd.addColorStop(0, 'rgba(70,210,46,0.35)'); grd.addColorStop(0.6, 'rgba(20,80,20,0.18)'); grd.addColorStop(1, 'rgba(20,80,20,0)');
    g.fillStyle = grd; g.fillRect(pit.x1 - 60, FLOOR - 260, pit.x2 - pit.x1 + 70, 300);
    g.fillStyle = '#1f6b14'; g.beginPath(); g.ellipse((pit.x1 + pit.x2) / 2, FLOOR + 6, (pit.x2 - pit.x1) / 2, 12, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = SLIME;
    for (let i = 0; i < 6; i++) { const ph = (T * 1.3 + i * 0.37) % 1; g.globalAlpha = 1 - ph; g.beginPath(); g.arc(pit.x1 + 20 + i * (pit.x2 - pit.x1 - 40) / 5, FLOOR - ph * 18, 3 + ph * 5, 0, Math.PI * 2); g.fill(); }
    g.globalAlpha = 1;
    g.font = '900 14px ' + FONT; g.fillStyle = SLIME; g.textAlign = 'center';
    g.fillText('☠️ 骷髏區', (pit.x1 + pit.x2) / 2, FLOOR + 26);
    // 籠子和裡面的人（頭上有座號）
    const c = cage;
    g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(c.x1, c.top, c.x2 - c.x1, FLOOR - c.top);
    const n = S.caged.length;
    const per = Math.max(1, Math.floor((c.x2 - c.x1 - 10) / 20));
    S.caged.forEach((num, i) => {
      const row = Math.floor(i / per), col = i % per;
      if (row > 2) return;
      const sc = BASE * 0.62;
      const x = c.x1 + 14 + col * 20 + (row % 2) * 9;
      const y = FLOOR - row * 34;
      const pp = Math.sin(T * 1.4 + i) > 0.8 ? poseWave(T + i) : P({ ra1: 2.2, ra2: 2.6, la1: -0.2 });
      const jj = joints(pp, sc, i % 2 ? 1 : -1, false);
      g.save(); g.translate(x, y - pp.hipH * sc);
      g.shadowColor = 'rgba(255,255,255,0.9)'; g.shadowBlur = 4;
      drawKid({ num, f: 1 }, jj, sc);
      g.restore();
    });
    g.strokeStyle = '#8a8aa0'; g.lineWidth = 3;
    for (let x = c.x1; x <= c.x2 + 0.1; x += 14) { g.beginPath(); g.moveTo(x, c.top); g.lineTo(x, FLOOR); g.stroke(); }
    g.strokeStyle = '#c9c9d6'; g.lineWidth = 6; g.beginPath(); g.moveTo(c.x1 - 4, c.top); g.lineTo(c.x2 + 4, c.top); g.stroke();
    const label = '籠子 ' + n;
    g.font = '900 13px ' + FONT;
    const lw = g.measureText(label).width + 16;
    g.fillStyle = '#f6c344'; roundRect((c.x1 + c.x2) / 2 - lw / 2, c.top - 26, lw, 20, 7); g.fill();
    g.fillStyle = INK; g.fillText(label, (c.x1 + c.x2) / 2, c.top - 11);
    g.textAlign = 'left';
    if (n && (T % 6) < 1.8) bubble((c.x1 + c.x2) / 2, c.top - 32, '救我們出去～');
  }
  // 號碼格（拔下來拿在手上、或飛回去時）
  function drawCell(x, y, c, scale) {
    const w = 44 * scale, h = 38 * scale;
    g.save(); g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 6;
    g.fillStyle = c.color; roundRect(x - w / 2, y - h / 2, w, h, 5); g.fill();
    g.restore();
    g.fillStyle = /244, 162, 97/.test(c.color) ? '#1e1e24' : '#ffffff';
    g.font = '700 ' + 14 * scale + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(c.text, x, y + 1); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }
  function drawParts() {
    for (const p of parts) {
      const a = Math.max(0, p.life / p.max);
      if (p.kind === 'cellfly') {
        const k = 1 - a;
        const to = p.toXY || (p.to && p.to.j ? [p.to.j.head[0], p.to.j.head[1] - 34] : [p.to.x, p.to.y - 80]);
        const x = p.from[0] + (to[0] - p.from[0]) * k, y = p.from[1] + (to[1] - p.from[1]) * k - Math.sin(k * Math.PI) * 50;
        drawCell(x, y, p, 1);
        continue;
      }
      if (p.kind === 'fw') { g.globalAlpha = a; g.fillStyle = p.color; g.beginPath(); g.arc(p.x, p.y, 3.5, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; continue; }
      if (p.kind === 'flame') { g.globalAlpha = a; g.fillStyle = a > 0.6 ? '#ffe066' : a > 0.3 ? '#ff9f1c' : '#ff4d00'; g.beginPath(); g.arc(p.x, p.y, 2 + a * 4, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; continue; }
      if (p.kind === 'drop') { g.globalAlpha = a; g.fillStyle = SLIME; g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; continue; }
      g.globalAlpha = Math.min(1, a * 1.5);
      if (p.kind === 'bone') { g.save(); g.translate(p.x, p.y); g.rotate(p.rot); bone(-7 * p.s, 0, 7 * p.s, 0, p.s * 0.8); g.restore(); }
      else if (p.kind === 'block') { g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.color; g.strokeStyle = INK; g.lineWidth = 2; roundRect(-13, -13, 26, 26, 4); g.fill(); g.stroke(); g.restore(); }
      else if (p.kind === 'puff') { g.fillStyle = (p.grey ? 'rgba(160,160,180,' : 'rgba(70,210,46,') + (0.5 * a) + ')'; g.beginPath(); g.arc(p.x, p.y, 5 + (1 - a) * 12, 0, Math.PI * 2); g.fill(); }
      else if (p.kind === 'dust') { g.fillStyle = 'rgba(160,160,180,' + (0.45 * a) + ')'; g.beginPath(); g.arc(p.x, p.y, 2 + (1 - a) * 6, 0, Math.PI * 2); g.fill(); }
      else if (p.kind === 'food') { g.font = '22px ' + FONT; g.fillText(p.ch, p.x - 11, p.y); }
      else if (p.kind === 'note') { g.fillStyle = '#f6c344'; g.font = '900 16px ' + FONT; g.fillText('♪', p.x, p.y); }
      else if (p.kind === 'crumb') { g.fillStyle = '#d4a056'; g.fillRect(p.x, p.y, 3, 3); }
      else if (p.kind === 'z') { g.fillStyle = '#c9c9d6'; g.font = '900 14px ' + FONT; g.fillText('Z', p.x, p.y); }
      else if (p.kind === 'sweat') { g.fillStyle = '#4cc9f0'; g.beginPath(); g.arc(p.x, p.y, 3, 0, Math.PI * 2); g.fill(); }
      else if (p.kind === 'spark') { g.strokeStyle = '#f6c344'; g.lineWidth = 3; const r = (1 - a) * 30 + 6; for (let k = 0; k < 8; k++) { const an = k * Math.PI / 4; g.beginPath(); g.moveTo(p.x + Math.cos(an) * r * 0.5, p.y + Math.sin(an) * r * 0.5); g.lineTo(p.x + Math.cos(an) * r, p.y + Math.sin(an) * r); g.stroke(); } }
      g.globalAlpha = 1;
    }
    for (const b of balls) {
      g.fillStyle = '#ffffff'; g.strokeStyle = INK; g.lineWidth = 2;
      g.beginPath(); g.arc(b.x, b.y, b.r, 0, Math.PI * 2); g.fill(); g.stroke();
      g.strokeStyle = '#f6c344'; g.lineWidth = 2;
      g.beginPath(); g.arc(b.x - 4, b.y, b.r * 0.9, -1, 1); g.stroke();
      g.beginPath(); g.arc(b.x + 4, b.y, b.r * 0.9, Math.PI - 1, Math.PI + 1); g.stroke();
    }
  }
  function updateParts(dt) {
    for (const p of parts) {
      p.life -= dt;
      if (p.kind === 'food') { const k = 1 - p.life / p.max, to = p.to; const mouth = to.j ? to.j.head : [to.x, to.y - 100]; const mx = mouth[0] + to.f * 12, my = mouth[1] + 4; p.x += (mx - p.x) * k * 0.35; p.y += (my - p.y) * k * 0.35; continue; }
      if (p.kind === 'cellfly') continue;
      if (p.kind === 'fw') { p.vy += 220 * dt; p.vx *= 0.97; p.vy *= 0.97; }
      if (p.kind === 'bone' || p.kind === 'block' || p.kind === 'drop' || p.kind === 'crumb') p.vy += GRAV * 0.8 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.vr) p.rot += p.vr * dt;
      if ((p.kind === 'bone' || p.kind === 'block') && p.y > FLOOR - 6) { p.y = FLOOR - 6; p.vy *= -0.3; p.vx *= 0.6; p.vr *= 0.5; }
    }
    parts = parts.filter(p => p.life > 0);
    for (const b of balls) {
      b.vy += GRAV * 0.6 * dt; b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.target) {
        const s = b.target;
        if (s.dead) b.target = null;
        else if (Math.hypot(b.x - s.x, b.y - (s.y - 30 * s.s)) < 34 * s.s) {
          killSkull(s); S.defeated = true;
          const next = b.chain && skulls().find(k => !k.dead);
          if (next) aimBall(b, next); else { b.target = null; b.vx = -200; b.vy = -400; }
        }
      }
      if (b.y > FLOOR - b.r) { b.y = FLOOR - b.r; b.vy *= -0.55; b.vx *= 0.7; b.b++; }
      if (b.x < -30 || b.x > W + 30 || b.b > 4) b.done = true;
    }
    balls = balls.filter(b => !b.done);
  }

  // ---------- 主迴圈 ----------
  let last = performance.now();
  function frame(now) {
    if (!running) return;
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));   // 第一格的時間可能比 last 早，不能是負的 last = now; T += dt;
    // 任何一格出錯都只跳過那一格，動畫不會整個停住
    const safe = (fn, label) => { try { fn(); } catch (e) { if (!safe.seen) { safe.seen = true; console.error('動畫錯誤（' + label + '）', e && e.stack || e); } } };
    agents = agents.filter(a => !a.gone);
    for (const a of [...agents]) safe(() => update(a, dt), 'update ' + a.kind + ' ' + a.act.type);
    if (S.hunting) safe(() => updateHunt(dt), 'hunt');
    safe(() => updateParts(dt), 'parts');
    safe(drawWorld, 'world');
    const order = [...agents].sort((x, y) => (x.kind === 'skull') - (y.kind === 'skull'));
    for (const a of order) safe(() => { g.save(); drawAgent(a); g.restore(); }, 'draw ' + a.kind + ' ' + a.act.type + ' s=' + a.s);
    safe(drawParts, 'drawParts');
    requestAnimationFrame(frame);
  }

  function chips() { /* 正式網站不顯示狀態列 */ }
  function setup() {
    agents = []; parts = []; balls = [];
    S.caged = [...DATA.overdue.keys()].sort((a, b) => a - b);
    for (let num = 1; num <= DATA.count; num++) if (!DATA.overdue.has(num)) agents.push(makeAgent('kid', rand(140, kidMaxX()), { num }));
    agents.push(makeAgent('bear', W * 0.45));
    rebuildSkulls(false);
  }
  // 看板資料更新：誰逾期（關在籠子）、骷髏多大、誰補交完、哪張卡全班交齊
  function sync(count, list, cards) {
    const over = new Map(list);
    const prev = DATA;
    DATA = { count, overdue: over };
    const total = Math.min(20, [...over.values()].reduce((x, y) => x + y, 0));
    const day = new Date().toDateString();
    const newDay = dataDay && dataDay !== day; dataDay = day;
    const done = [];
    if (prevCards) for (const c of cards) { const p = prevCards.get(c.id); if (p && p.some(v => v > 0) && c.statuses.every(v => !(v > 0))) done.push(c.name); }
    prevCards = new Map(cards.map(c => [c.id, c.statuses.slice()]));
    if (!running) { S.overdue = total; agents = []; return; }
    measure();
    if (!agents.length || !prev || prev.count !== count) { S.overdue = total; S.defeated = false; setup(); return; }
    rebindCells();
    if (newDay) S.defeated = false;
    if (total !== S.overdue || newDay) { S.overdue = total; if (!S.hunting) rebuildSkulls(true); }
    const maxPrev = Math.max(0, ...prev.overdue.values());
    for (const [num, n] of prev.overdue) if (!over.has(num)) releaseSeat(num, n === maxPrev && n >= 2, n);
    for (const num of over.keys()) if (!prev.overdue.has(num) && !S.huntQueue.includes(num)) S.huntQueue.push(num);
    nextHunt();
    if (done.length) celebrate(done);
  }
  window.NiceBattle = { sync };

  // 偶爾有人邊走邊滑手機，掉進綠池（大約每 2 分鐘一次）；骷髏偶爾出來亂抓人（抓到沒欠交的會放回來）
  let nextClumsy = 90, nextRandomHunt = 200;
  setInterval(() => {
    if (!running) return;
    if (T > nextClumsy) { if (clumsy()) nextClumsy = T + rand(100, 160); else nextClumsy = T + 10; }
    if (T > nextRandomHunt) { nextRandomHunt = T + rand(180, 300); if (!S.huntQueue.length) startHunt(); }
  }, 2000);

  // 大熊老師走到骷髏區前面才殺球
  const baseArrive = onArrive;
  onArrive = function (a) {
    if (a.kind === 'bear' && a.goal && a.goal.then === 'spike') { a.goal = null; a.f = 1; startSkill(a, 'spike', true); return; }
    if (a.kind === 'skull' && a.goal && a.goal.then === 'home') { a.goal = null; if (a.home) setAct(a, 'skullHome'); else setAct(a, 'idle', { dur: 0.1 }); return; }
    if (a.kind === 'skull' && a.goal && a.goal.then === 'grab') { a.goal = null; setAct(a, 'idle', { dur: 0.05 }); return; }
    if (a.kind === 'kid' && a.goal && a.goal.then === 'pull') { a.goal = null; doPull(a); return; }
    if (a.kind === 'kid' && a.goal && a.goal.then === 'putBack') { a.goal = null; restoreCell(a); setAct(a, 'wave', { dur: 0.8 }); return; }
    if (a.kind === 'kid' && a.goal && a.goal.then === 'rescue') {
      a.goal = null; a.f = 1;
      setAct(a, 'punch', { dur: 0.5 });
      if (S.caged.length) {
        const num = S.caged.splice(Math.floor(Math.random() * S.caged.length), 1)[0];
        const k = spawnFromCage(num);
        say(k, '謝謝你！', 1.8);
        banner('🦸 ' + String(a.num).padStart(2, '0') + ' 號救出了 ' + String(num).padStart(2, '0') + ' 號！');
        fireworks(2);
      }
      return;
    }
    baseArrive(a);
  };

  // ---------- 開關（存在這台裝置）、手機不播放 ----------
  const OFF_KEY = 'nice-battle-off';
  const isOff = () => { try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; } };
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.id = 'battleToggle';
  toggle.onclick = () => { try { localStorage.setItem(OFF_KEY, isOff() ? '0' : '1'); } catch { /* 無痕模式 */ } checkSize(); };
  ground.appendChild(toggle);
  function checkSize() {
    const small = window.innerWidth < 768;
    const on = !small && !isOff();
    toggle.textContent = isOff() ? '🎮 打開操場動畫' : '🎮 關掉操場動畫';
    ground.classList.toggle('battle-on', on);
    cv.style.display = on ? 'block' : 'none';
    if (!on) {
      if (running) { recallAll(); running = false; agents = []; parts = []; balls = []; S.hunting = null; S.huntQueue = []; }
      return;
    }
    if (!DATA) return;              // 等看板資料讀到再開始
    measure();
    if (!agents.length) setup();
    if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
  }
  window.addEventListener('resize', () => { checkSize(); });
  setInterval(() => { if (running) measure(); }, 1500);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (running) measure(); });
  const baseSync = sync;
  window.NiceBattle.sync = (count, list, cards) => { const wasData = !!DATA; baseSync(count, list, cards); if (!wasData) checkSize(); };
  checkSize();
  // 看板資料可能比 battle.js 先讀到
  if (typeof window.syncBattle === "function") window.syncBattle();
})();
