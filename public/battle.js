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
  const S = { overdue: 0, defeated: false, caged: [], tower: 0, hunts: [], huntQueue: [], raid: null, scene: 'playground', patrol: null, snowmen: [] };
  // 好幾隻骷髏可以同時抓人（S.hunts）；S.hunting = 有沒有人正在被抓
  Object.defineProperty(S, 'hunting', { get() { return S.hunts.length ? S.hunts[0] : null; }, set(v) { if (!v) S.hunts = []; } });
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
      const lift = el.classList.contains('homework-card') ? (S.scene === 'ninja' ? 7 : S.scene === 'snow' ? 6 : S.scene === 'sanguo' ? 9 : 0) : 0;
      m.set(key, { id: key, x1: r.left + sx + 6, x2: r.right + sx - 6, top: r.top + sy - lift, el });
    });
    m.set('floor', { id: 'floor', x1: 6, x2: W - 6, top: FLOOR, floor: true });
    pit = { x1: W - Math.min(300, W * 0.2), x2: W - 4 };
    cage = { x1: pit.x1 - Math.min(230, W * 0.16), x2: pit.x1 - 16, top: FLOOR - 120 };
    pile = { x: 60 };
    towerX = Math.max(220, W * 0.3);
    if (S.tower > 0) m.set('tower', { id: 'tower', x1: towerX - 15, x2: towerX + 15, top: FLOOR - S.tower * 28 });
    const old = surfaces;
    surfaces = m;
    for (const a of agents) {
      const o = old.get(a.surf), n = m.get(a.surf);
      if (o && n && !n.floor && !a.air && (o.x1 !== n.x1 || o.x2 !== n.x2)) a.x = n.x1 + clamp((a.x - o.x1) / Math.max(1, o.x2 - o.x1), 0, 1) * (n.x2 - n.x1);
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
    // 離開下課活動（被骷髏抓、逃跑、活動結束）：手上的東西、頭上的字都收掉
    if (a.act && a.act.type === 'play' && type !== 'play') {
      a.group = null; a.item = null; a.tag = null; a.hop = 0; a.carry = null; a.rot = 0; a.weapon = null; a.kimono = false; a.sw = null; a.morph = null; a.hero = null; if (a.prop && a.prop.byPlay) a.prop = null;
      if (a.surf === 'floor' && !a.air) a.y = FLOOR;
    }
    if (a.hidden && type !== 'tele') a.hidden = false;
    a.act = Object.assign({ type, t: 0 }, o);
  }
  // 說話分三級：0 = 隨口一句（最常被省略）、1 = 遊戲和聊天的台詞、2 = 重要的事（被抓、補交、大熊老師、骷髏）
  // 畫面上泡泡太多、旁邊已經有人在講話，就先不講；20 幾個人才不會吵成一團
  let chatQuiet = 0;
  function say(a, text, sec = 1.6, lv = 0) {
    text = foeName(text);
    if (a.kind !== 'kid') lv = 2;
    if (lv < 2) {
      const live = agents.filter(x => x !== a && x.say && x.say.until > T && !(a.group && x.group === a.group));
      if (live.length >= (lv ? 3 : 1)) return false;
      if (!lv && T < chatQuiet) return false;
      const gap = lv ? 150 : 240;
      if (live.some(x => Math.abs(x.x - a.x) < gap && Math.abs(x.y - a.y) < 120)) return false;
      if (!lv) chatQuiet = T + 6;
    }
    a.say = { text, until: T + sec, lv };
    return true;
  }

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
    const fast = (a.kind === 'skull' && !goal.walk) || goal.run;
    if (cur.id === target.id) { setAct(a, fast ? 'run' : 'walk', { tx, arrive: true }); return; }
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
    if (Math.abs(side - a.x) > 4) { setAct(a, fast ? 'run' : 'walk', { tx: side, step: true }); return; }
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
  const BUSY_ACTS = ['ash', 'play', 'tele', 'push', 'stairRide', 'greet', 'taunt', 'grabbed', 'sink', 'thrown', 'puppet', 'boost', 'bearThrow', 'hook', 'walljump', 'mantle', 'climb', 'freeze', 'skill', 'jumpTo', 'flipTo', 'fall', 'flipHop'];
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
      if (a.x >= pit.x1) {
        if (a.sinkMsg) { sinkIntoPool(a); return true; }      // 滑手機掉進去
        // 從卡片上跳下來剛好掉進綠池：被燙得跳出來，不會被關
        a.goal = null; a.air = true; a.vx = -320; a.vy = -560; a.y = FLOOR - 2;
        for (let k = 0; k < 8; k++) parts.push({ kind: 'drop', x: a.x, y: FLOOR - 4, vx: rand(-120, 120), vy: rand(-300, -100), life: 0.7, max: 0.7 });
        say(a, '燙燙燙！', 1.2); setAct(a, 'flipHop');
        return true;
      }
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
    // 版面變動（換場景、卡片換裝）時地板可能往上移，人已經在地板下面：直接站回地板，不會一直往下掉不見
    if (!best && a.y >= FLOOR) { a.y = FLOOR; best = surfaces.get('floor'); }
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
    if (S.scene === 'ninja' && r < 0.25) {
      const up = plats.length && Math.random() < 0.5 ? pick(plats) : null;
      const dest = up || surf('floor');
      setAct(a, 'tele', { sid: dest.id, tx: up ? rand(up.x1 + 10, up.x2 - 10) : roomyX(a, 30, kidMaxX()) });
      return;
    }
    if (r < 0.22 && plats.length) {
      const s = pick(plats);
      travel(a, s.id, rand(s.x1 + 10, s.x2 - 10));
      return;
    }
    // 疊積木只是偶爾的事，大部分時間在玩下課活動（見 startActivity）
    if (r < 0.25 && cur.floor && S.tower < 7) { travel(a, 'floor', pile.x + 20, 'build'); return; }
    if (r < 0.27 && cur.floor && S.tower >= 7) { travel(a, 'floor', towerX - 22, 'kick'); return; }
    if (r < 0.35 && !cur.floor) {
      setAct(a, 'sit', { dur: rand(3, 6) });
      const rightOk = cur.x2 < cage.x1 - 40;     // 右邊下面是骷髏區就坐左邊
      a.x = rightOk && Math.random() < 0.5 ? cur.x2 - 2 : cur.x1 + 2;
      a.f = a.x < (cur.x1 + cur.x2) / 2 ? -1 : 1; return;
    }
    if (r < 0.40) { setAct(a, 'flipHop'); a.vx = rand(-40, 40); a.vy = -520; a.air = true; return; }
    if (r < 0.45) { startDance(a); return; }
    if (r < 0.48) { setAct(a, 'wave', { dur: 1.4 }); return; }
    if (r < 0.51 && cur.floor) { setAct(a, 'sleep', { dur: rand(3, 5) }); return; }
    if (r < 0.55 && cur.floor && tryPush(a)) return;
    if (r < 0.70) { setAct(a, 'idle', { dur: rand(2, 4) }); return; }     // 站著發呆、看別人玩
    const hi = cur.floor ? kidMaxX() : cur.x2 - 6;
    const running = Math.random() < 0.1;
    if (!running && Math.random() < 0.25) a.phone = true;    // 邊走邊滑手機
    setAct(a, running ? 'run' : 'walk', { tx: roomyX(a, cur.x1 + 6, hi) });
  }
  // 找一個人比較少的地方走過去，不要大家擠在一起撞來撞去
  function roomyX(a, lo, hi) {
    let best = rand(lo, hi), bs = Infinity;
    for (let i = 0; i < 6; i++) {
      const x = rand(lo, hi);
      const c = agents.filter(o => o !== a && o.surf === a.surf && Math.abs(o.x - x) < 45).length + groups.filter(G => Math.abs(G.x - x) < 130).length * 3;
      if (c < bs) { bs = c; best = x; }
    }
    return best;
  }
  function chooseBear(a) {
    const r = Math.random();
    if (r < 0.05 && a.surf === 'floor' && bearSalute(true)) return;
    if (r < 0.4) { startSkill(a, pick(['spike', 'stick', 'fire', 'hike', 'eat', 'shiver'])); return; }
    if (r < 0.6) { const plats = [...surfaces.values()].filter(s => !s.floor && s.x2 - s.x1 > 120); if (plats.length) { const s = pick(plats); travel(a, s.id, rand(s.x1 + 20, s.x2 - 20)); return; } }
    const cur = surf(a.surf);
    setAct(a, 'walk', { tx: roomyX(a, cur.x1 + 10, cur.floor ? kidMaxX() : cur.x2 - 10) });
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
          else setAct(a, 'idle', { dur: a.kind === 'kid' ? rand(1, 3) : rand(0.3, 1.2) });
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
        const hh = S.hunts.find(x => x.v === a), h = hh && hh.hunter;
        if (act.phase === 0) {
          const d = act.tx - a.x;
          if (Math.abs(d) > 4) { a.f = Math.sign(d); a.x += Math.sign(d) * Math.min(Math.abs(d), 55 * BASE / 1.5 * dt); a.ph += dt * 3; a.p = poseWalk(a.ph, 0.7, -0.15); }
          else { act.phase = 1; act.t0 = act.t; a.f = 1; }
        } else {
          a.f = 1; a.p = poseTaunt(act.t);
          const k = act.t - act.t0;
          const lines = ['來啊！我才不怕你！', '略略略～', '你抓不到我啦！'];
          const i = Math.floor(k / 1.1);
          if (i < lines.length && i !== act.line) { act.line = i; say(a, lines[i], 1.1, 2); }
        }
        if (h && Math.abs(h.x - a.x) < 110 && h.surf === a.surf) { say(a, '…媽、媽呀！', 1.4, 2); setAct(a, 'freeze'); }
        break;
      }
      case 'play': {
        // 下課活動：走到活動指定的位置，到了就擺活動給的姿勢（活動本身在 stepGroups 裡決定）
        const G = act.g;
        if (!G || G.over) { setAct(a, 'idle', { dur: rand(0.8, 2) }); break; }
        if (act.tx != null && Math.abs(act.tx - a.x) >= 3) {
          const d = act.tx - a.x, sp = (act.sp || 45) * BASE / 1.5;
          a.f = Math.sign(d); a.x += Math.sign(d) * Math.min(Math.abs(d), sp * dt);
          a.ph += dt * (sp > 80 ? 9 : 4);
          a.p = sp > 80 ? poseRun(a.ph) : poseWalk(a.ph);
          if (act.yf) a.y += (act.yf(a.x) - a.y) * Math.min(1, dt * 14);
        } else {
          if (act.tx != null) a.x = act.tx;
          a.p = typeof act.pose === 'function' ? act.pose(T) : (act.pose || P({}));
          if (act.face) a.f = act.face;
        }
        break;
      }
      case 'tele': {
        // 忍者瞬間移動：結印 → 一陣煙消失 → 在目的地一陣煙出現
        if (act.t < 0.3) a.p = P({ ra1: 1.3, ra2: 3.3, la1: 1.2, la2: 3.3 });
        else if (!act.gone) { act.gone = true; a.hidden = true; smoke(a.x, a.y); }
        if (act.t > 0.65 && !act.back) {
          act.back = true;
          const s2 = surf(act.sid);
          a.surf = s2.id; a.x = clamp(act.tx, s2.x1 + 6, s2.floor ? kidMaxX() : s2.x2 - 6); a.y = s2.top;
          a.hidden = false; a.p = P({ lean: 0.3, ra1: -0.8, la1: 0.8, hipH: 18 }); smoke(a.x, a.y);
        }
        if (act.t > 0.95) setAct(a, 'idle', { dur: rand(1, 2.5) });
        break;
      }
      case 'punch': a.p = P({ lean: 0.25, ra1: 1.57, ra2: 1.57, la1: 0.9, la2: 2.3, rl1: 0.5, ll1: -0.4, hipH: 20 }); if (act.t > act.dur) setAct(a, 'idle', { dur: 0.5 }); break;
      case 'sleep':
        a.p = P({ ra1: 0.3, la1: -0.3 }); a.rot = -a.f * Math.PI / 2;
        if (Math.random() < dt * 1.2) parts.push({ kind: 'z', x: a.x - a.f * 20, y: a.y - 18, vx: -a.f * 6, vy: -20, life: 1.6, max: 1.6 });
        if (act.t > act.dur) { a.rot = 0; setAct(a, 'idle', { dur: 0.3 }); say(a, '嗯？', 1); }
        break;
      case 'ash': {
        // 燒焦定格 1.5 秒 → 碎成灰 → 灰堆冒煙 → 爬出來拍拍身上的灰
        if (!act.p0) act.p0 = a.p || P({});
        if (!act.back) a.p = act.p0;
        if (act.t > 1.5 && !act.crumbled) {
          act.crumbled = true; a.hidden = true;
          for (let k = 0; k < 34; k++) parts.push({ kind: 'ash', x: a.x + rand(-9, 9), y: a.y - rand(0, 58) * a.s, vx: rand(-25, 45), vy: rand(-60, 10), life: rand(0.8, 1.5), max: 1.5, c: pick(['#2e2a28', '#4a4440', '#6b6560', '#8a837c', '#ff7a1a']) });
        }
        // 灰堆冒一下煙，再被風吹進籠子，在籠子裡變回人（沒缺交的過一下就會溜出來）
        if (act.t > 4.6) {
          for (let k = 0; k < 18; k++) parts.push({ kind: 'ash', x: a.x + rand(-12, 12), y: a.y - rand(0, 10), vx: rand(60, 160) * Math.sign(cage.x1 - a.x || 1), vy: rand(-140, -60), life: 1, max: 1.5, c: pick(['#4a4440', '#6b6560', '#8a837c']) });
          narrate('⛓️ ' + tagOf(a.num) + '那堆灰被風吹進籠子裡，在籠子裡重新變回人了', true);
          intoCage(a);
        }
        break;
      }
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
          if (!a.quietSink) banner(msg);
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

  // ---------- 下課活動 ----------
  // 幾個人湊在一起玩一個遊戲（剪刀石頭布、聊天、鬼抓人…）；操場下方的旁白說明誰在玩什麼。
  // 聊天的台詞在 TALKS，每個遊戲在 ACTS；想加新的直接往裡面加。
  let groups = [];
  const rint = (a, b) => Math.floor(rand(a, b + 1));
  const numOf = m => String(m.num).padStart(2, '0');
  const tagsOf = ms => ms.map(numOf).join('、') + ' 號';
  const pgLabel = ground.querySelector('.pg-label');
  let narrTimer = 0, narrAt = -99, narrNext = 0, sceneSel = null;
  const narrQueue = [];
  // 旁白：一次一行，至少停 4 秒才換；太密的排隊（重要的事直接插隊）
  function narrate(text, important) {
    if (!pgLabel) return;
    text = foeName(text);
    if (!important && T - narrAt < 4) {
      // 排太久（超過 6 秒）的就不講了，免得跟畫面對不上
      if (narrQueue.length < 3 && !narrQueue.some(q => q.text === text)) narrQueue.push({ text, at: T });
      clearTimeout(narrNext);
      narrNext = setTimeout(() => {
        while (narrQueue.length && T - narrQueue[0].at > 6) narrQueue.shift();
        if (narrQueue.length) narrate(narrQueue.shift().text);
      }, (4 - (T - narrAt)) * 1000 + 100);
      return;
    }
    narrAt = T;
    pgLabel.textContent = text; pgLabel.classList.add('narr');
    clearTimeout(narrTimer);
    narrTimer = setTimeout(() => { pgLabel.textContent = sceneLabel(); pgLabel.classList.remove('narr'); }, 14000);
  }
  const AMBIENT = ['☀️ 下課了！大家衝出來玩', '🔔 再過幾分鐘就要上課囉', '🐻 大熊老師在操場巡邏中', '🍱 快到午餐時間，大家肚子都餓了',
    '🌬️ 今天有點風，好舒服', '📚 有人在偷偷背等一下要考的生字', '🧃 福利社前面排了好長一排', '🎒 放學前記得把聯絡簿拿給爸媽簽名'];

  const SCENE_AMBIENT = {
    ninja: ['🏯 忍者村的鐘聲響了', '🌸 櫻花瓣一直飄下來', '🥷 聽說今天下午有忍者考試', '🍡 有人在偷吃糰子', '🎋 竹林裡好像有人在練功'],
    ocean: ['🐠 一群熱帶魚游過去', '🫧 咕嚕咕嚕…到處都是泡泡', '🐢 遠遠的好像有一隻海龜', '🐙 章魚躲在石頭後面偷看', '🐚 沙子裡有好多貝殼'],
    sanguo: ['🚢 江上的連環船一艘接一艘，用鐵鍊綁在一起', '🪶 孔明搖著羽扇：萬事俱備，只欠東風', '🧔 關羽摸了摸他的長鬍子', '🏮 對岸的曹營燈火通明', '🪨 山崖上刻著「赤壁」兩個大字', '🥁 遠遠傳來咚咚咚的戰鼓聲', '📜 今天主角輪到誰？看看衣服上的名字'],
    icefire: ['🌋 火山轟隆隆地在冒煙', '🧊 冰牆後面好像有東西在走…', '🐉 遠遠的好像聽到龍在叫', '🧟 冰原上的殭屍眼睛在發藍光', '🔥 左邊冷得發抖、右邊熱到流汗', '❄️ 凜冬將至…', '🐺 冰原狼跟在主人旁邊，耳朵豎得高高的', '🥚 抱著龍蛋的人說：蛋好像越來越燙了…', '🗡️ 披著黑斗篷的守夜人在冰牆下巡邏', '🔥 火把的光把冰牆照得亮亮的'],
    snow: ['❄️ 好冷喔，大家呼出白白的氣', '⛄ 雪越下越大了', '🧤 有人的手套不見了', '☕ 好想喝一杯熱可可'],
  };
  // 聊天話題資料庫：[說話的人（0、1、2）, 台詞]；三個人聊時 2 號角色才會出現，兩個人聊時由 0 號代講
  const TALKS = [
    { name: '營養午餐', lines: [[0, '今天營養午餐吃什麼？'], [1, '聽說有炸雞腿！'], [0, '真的假的！我要第一個盛飯！'], [1, '你上次也這樣說～']] },
    { name: '福利社', item: '🧃', lines: [[0, '下課要不要去福利社？'], [1, '我要買養樂多！'], [2, '我只有十塊…'], [0, '那我們一人一半～']] },
    { name: '閃卡', item: '🃏', lines: [[0, '你看！我抽到閃卡了！'], [1, '哇！借我看一下～'], [0, '只能看，不能摸喔！'], [1, '小氣鬼～']] },
    { name: '數學習作', lines: [[0, '數學習作寫完了沒？'], [1, '還差兩頁…'], [0, '快點！不然骷髏要來抓你了！'], [1, '哇！我現在就去寫！']] },
    { name: '聯絡簿', lines: [[0, '聯絡簿給爸媽簽名了嗎？'], [1, '啊！我忘了…'], [0, '趕快補簽，不然大熊老師會發現！']] },
    { name: '躲避球', lines: [[0, '等一下打躲避球！'], [1, '我要當外場！'], [2, '上次你被我 K 到～'], [1, '那是我讓你的啦！']] },
    { name: '週末', lines: [[0, '週末你去哪裡玩？'], [1, '去阿嬤家，有吃芒果冰！'], [0, '好好喔～我在家寫作業…']] },
    { name: '寵物', lines: [[0, '我家的狗會握手喔！'], [1, '我家的貓只會睡覺'], [0, '那也很可愛啊～']] },
    { name: '生日', lines: [[0, '下禮拜是我生日！'], [1, '要請全班吃蛋糕嗎？'], [0, '嘿嘿，看你們表現～']] },
    { name: '國語考試', lines: [[0, '明天要考國語…'], [1, '我生字還沒背！'], [0, '考你：「蝴蝶」是什麼部首？'], [1, '虫字旁！']] },
    { name: '打掃', lines: [[0, '今天輪到誰掃廁所？'], [1, '……是我。'], [0, '加油！我幫你拿掃把～']] },
    { name: '午休', lines: [[0, '午休我都睡不著'], [1, '我也是，偷偷看窗外'], [0, '噓～老師在看！']] },
    { name: '長大以後', lines: [[0, '你長大要做什麼？'], [1, '我要當 YouTuber！'], [2, '我要當老師，像大熊老師一樣！'], [0, '那你要先長很高～']] },
    { name: '恐龍', lines: [[0, '暴龍跟三角龍誰比較強？'], [1, '暴龍啊！'], [0, '三角龍有角耶！'], [1, '那…打平！']] },
    { name: '天氣', lines: [[0, '外面好熱喔～'], [1, '等一下去飲水機喝水'], [0, '順便洗把臉！']] },
    { name: '新鞋子', lines: [[0, '你的鞋子會發光耶！'], [1, '我媽媽買的！'], [0, '好帥喔！']] },
    { name: '祕密', lines: [[0, '跟你說一個祕密…'], [1, '什麼什麼？'], [0, '……我忘了。'], [1, '欸～！']] },
    { name: '冷笑話', lines: [[0, '什麼動物最會算數？'], [1, '不知道…'], [0, '數「鼠」啊！'], [1, '好冷喔～']] },
    { name: '謎語', lines: [[0, '什麼東西越洗越髒？'], [1, '衣服？'], [0, '是水啦！'], [1, '喔～～']] },
    { name: '掉牙齒', lines: [[0, '我門牙掉了！'], [1, '哇！說話會漏風嗎？'], [0, '不會～哩看～']] },
    { name: '借東西', item: '✏️', lines: [[0, '可以借我橡皮擦嗎？'], [1, '可以，要還我喔'], [0, '謝謝！明天還你～']] },
    { name: '值日生', lines: [[0, '今天誰是值日生？'], [1, '是我！要擦黑板'], [0, '我幫你一起擦！']] },
    { name: '校外教學', lines: [[0, '聽說要校外教學！'], [1, '去動物園嗎？'], [0, '我要看熊！像大熊老師那種～']] },
    { name: '點心', item: '🍪', lines: [[0, '我媽媽幫我帶了餅乾'], [1, '可以分我一片嗎？'], [0, '好啊，一人一片！'], [1, '你最好了～']] },
    { name: '下課要玩什麼', lines: [[0, '下一節下課玩什麼？'], [1, '鬼抓人！'], [2, '一二三木頭人！'], [0, '那猜拳決定！']] },
    { name: '才藝班', lines: [[0, '你放學要去補習嗎？'], [1, '要去學游泳！'], [0, '我要去學畫畫～']] },
    { name: '晚餐', lines: [[0, '你晚餐想吃什麼？'], [1, '咖哩飯！'], [0, '我想吃牛肉麵！'], [1, '講得我好餓～']] },
    { name: '準時交作業', lines: [[0, '你看籠子裡那幾個…'], [1, '他們作業還沒交吧'], [0, '我們要準時交，才不會被抓！']] },
  ];
  let recentTalks = [];

  // 動作
  const poseTalk = t => P({ ra1: 0.8 + 0.35 * Math.sin(t * 7), ra2: 1.6 + 0.3 * Math.sin(t * 5), la1: -0.2 });
  const poseListen = () => P({ tilt: 0.12 });
  const poseLaugh = t => P({ lean: -0.1, ra1: 0.6, ra2: 2.2 + 0.25 * Math.sin(t * 22), la1: 0.5, la2: 2.1 + 0.25 * Math.sin(t * 22), hipH: 22 + Math.abs(Math.sin(t * 11)) });
  const posePump = t => P({ ra1: 1.0 + 0.55 * Math.abs(Math.sin(t * 6)), ra2: 1.9 + 0.55 * Math.abs(Math.sin(t * 6)), la1: -0.15 });
  const poseShow = () => P({ ra1: 1.45, ra2: 1.5, la1: -0.15 });
  const poseSlump = () => P({ lean: 0.3, tilt: 0.35, ra1: 0.05, ra2: 0, la1: -0.05, la2: 0, hipH: 21 });
  const poseCover = () => P({ tilt: 0.3, ra1: 2.3, ra2: 4.4, la1: 2.1, la2: 4.3 });                       // 摀眼睛數數
  const posePoint = () => P({ ra1: 1.55, ra2: 1.55, la1: -0.1 });                                          // 轉身指人
  const poseKick = () => P({ lean: -0.1, tilt: 0.25, ra1: -0.6, ra2: -0.3, la1: 0.6, la2: 0.9, rl1: 1.2, rl2: 0.3, ll1: -0.05, hipH: 22 });
  const poseReady = () => P({ tilt: -0.25, ra1: -0.5, ra2: -0.2, la1: 0.5, la2: 0.8, rl1: 0.15, ll1: -0.15 });
  const poseHold = ph => P({ ra1: 1.3 + 0.6 * Math.sin(ph), ra2: 1.3 + 0.6 * Math.sin(ph), la1: -0.2 });  // 甩繩子
  const poseCatch = () => P({ ra1: 1.6, ra2: 2.0, la1: 1.4, la2: 1.9 });
  const poseThrow = () => P({ lean: 0.15, ra1: 1.9, ra2: 2.3, la1: -0.3 });
  const poseOw = () => P({ lean: -0.2, tilt: -0.45, ra1: 2.4, ra2: 4.2, la1: -0.2 });                     // 被彈額頭，手摸額頭
  const poseMeasure = () => P({ ra1: 3.3, ra2: 2.5, la1: -0.15 });                                        // 手平放在頭頂比身高
  const posePant = () => P({ lean: 0.4, ra1: 0.6, ra2: 0.9, la1: 0.6, la2: 0.9, hipH: 19 });              // 手撐膝蓋喘氣
  const STATUES = [
    () => P({ rl1: 1.1, rl2: 0.3, ra1: 2.4, ra2: 2.6, la1: -2.4, la2: -2.6 }),                            // 單腳站
    () => P({ ra1: 1.57, ra2: 1.57, la1: -1.57, la2: -1.57, lean: 0.2 }),                                 // 飛機
    () => P({ lean: 0.4, ra1: 1.0, ra2: 0.4, la1: -0.9, la2: -0.4, rl1: 0.7, ll1: -0.6, hipH: 18 }),      // 跨大步
    () => P({ tilt: 0.4, ra1: 2.8, ra2: 3.0, la1: 0.8, la2: 2.5 }),                                       // 抓頭
  ];
  const poseWobble = t => { const p = STATUES[0](); p.lean = 0.25 * Math.sin(t * 14); p.rl1 = 0.8 + 0.4 * Math.sin(t * 9); return p; };
  const RPS = ['✊', '✌️', '🖐️'], RPS_NAME = ['石頭', '剪刀', '布'];
  const RPS_WIN = ['耶！我贏了！', '哈哈！你輸了！', '我是猜拳王！'], RPS_LOSE = ['再來一次！我不服！', '可惡～', '你一定偷看！'];

  // 小工具
  const go = (m, x, sp) => { m.act.tx = clamp(x, 24, kidMaxX() - 6); m.act.sp = sp || 60; };
  const halt = m => { m.act.tx = null; };
  const ready = G => G.members.every(m => m.act.tx == null || Math.abs(m.act.tx - m.x) < 3);
  const phase = (G, p) => { G.phase = p; G.t0 = G.t; G.f = {}; };
  const pose = (m, p, face) => { m.act.pose = p; if (face) m.act.face = face; };
  const hand = m => m.j ? m.j.rH : [m.x, m.y - 45];
  // 同一組一次只有一個人講話（新的一句出來，上一句就收掉）
  function line(G, m, text, sec = 2) {
    for (const o of G.members) if (o !== m && o.say && o.say.lv === 1) o.say = null;
    return say(m, text, sec, 1);
  }
  // 照順序講台詞：script = [[人, 台詞, 講的時候做的事?], ...]，每句 2.3 秒
  function runScript(G, k) {
    if (k < G.next) return false;
    if (G.i >= G.script.length) return true;
    const [m, text, fn] = G.script[G.i++];
    line(G, m, text, 2.2);
    for (const o of G.members) pose(o, o === m ? poseTalk : poseListen());
    if (fn) fn();
    G.next = k + 2.4;
    return false;
  }

  const ACTS = {
    chat: { name: '聊天', n: [2, 3], w: 6,
      setup(G) {
        const pool = TALKS.filter(t => !recentTalks.includes(t.name));
        G.topic = pick(pool.length ? pool : TALKS);
        recentTalks = recentTalks.concat(G.topic.name).slice(-8);
        const n = G.members.length;
        G.members.forEach((m, i) => go(m, G.x + (i - (n - 1) / 2) * 38));
        phase(G, 'gather');
      },
      step(G) {
        const ms = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          ms.forEach((m, i) => pose(m, poseListen(), i < (ms.length - 1) / 2 ? 1 : -1));
          if (G.topic.item) ms.forEach(m => { m.item = G.topic.item; });
          G.script = G.topic.lines.filter(([who]) => who < 2 || ms.length > 2).map(([who, text]) => [ms[who % ms.length], text]);
          G.i = 0; G.next = 0.3;
          narrate('💬 ' + tagsOf(ms) + '在聊「' + G.topic.name + '」');
          phase(G, 'talk'); return;
        }
        if (G.phase === 'talk') { if (runScript(G, k)) { ms.forEach(m => pose(m, poseLaugh)); phase(G, 'bye'); } return; }
        if (k > 1.4) endGroup(G);
      } },

    rps: { name: '剪刀石頭布', n: [2, 2], w: 4,
      setup(G) { const [A, B] = G.members; go(A, G.x - 20); go(B, G.x + 20); G.ties = 0; G.rounds = 0; phase(G, 'gather'); },
      step(G) {
        const [A, B] = G.members, k = G.t - G.t0;
        const chant = () => { phase(G, 'chant'); line(G, G.caller, '剪刀、石頭、布！', 1.6); pose(A, posePump); pose(B, posePump); };
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          pose(A, P({}), 1); pose(B, P({}), -1);
          G.caller = pick([A, B]);
          line(G, G.caller, pick(['來猜拳！', '剪刀石頭布決定！', '輸的人要被彈額頭喔！']), 1.6);
          narrate('✊ ' + tagsOf([A, B]) + '在玩剪刀石頭布');
          phase(G, 'wait'); return;
        }
        if (G.phase === 'wait') { if (k > 1.5) chant(); return; }
        if (G.phase === 'chant') {
          if (k > 1.5) { G.ca = rint(0, 2); G.cb = rint(0, 2); A.item = RPS[G.ca]; B.item = RPS[G.cb]; pose(A, poseShow()); pose(B, poseShow()); phase(G, 'show'); }
          return;
        }
        if (G.phase === 'show') {
          if (k > 0.9 && !G.f.judged) {
            G.f.judged = true;
            if (G.ca === G.cb) { G.win = null; line(G, pick([A, B]), pick(['平手！再來！', '一樣耶！再一次！', '心有靈犀～再來！']), 1.4); }
            else {
              const aw = (G.cb - G.ca + 3) % 3 === 1;
              G.win = aw ? A : B; G.lose = aw ? B : A;
              const wc = aw ? G.ca : G.cb, lc = aw ? G.cb : G.ca;
              line(G, G.win, pick(RPS_WIN), 1.5); pose(G.win, poseCheer); pose(G.lose, poseSlump());
              narrate('✊ ' + numOf(G.win) + ' 號出' + RPS_NAME[wc] + '，贏了 ' + numOf(G.lose) + ' 號的' + RPS_NAME[lc] + '！');
            }
          }
          if (k > 2.4) {
            A.item = null; B.item = null;
            if (!G.win) { if (++G.ties > 3) { endGroup(G); return; } chant(); }
            else phase(G, 'after');
          }
          return;
        }
        if (G.phase === 'after') {
          const w = G.win, l = G.lose;
          if (!G.f.p) {
            G.f.p = pick(['flick', 'whine', 'again']);
            if (G.f.p === 'flick') { line(G, w, '彈額頭！', 1.2); pose(w, poseThrow()); pose(l, P({})); }
            else if (G.f.p === 'whine') line(G, l, pick(RPS_LOSE), 1.6);
            else line(G, l, '三戰兩勝！再來！', 1.5);
          }
          if (G.f.p === 'flick' && k > 0.6 && !G.f.ow) { G.f.ow = true; pose(l, poseOw()); line(G, l, pick(['好痛～', '哎呦！', '你等著！下次換我！']), 1.4); }
          if (k > 2.2) {
            pose(w, P({})); pose(l, P({}));
            if (G.f.p === 'again' && ++G.rounds < 3) { G.win = null; chant(); }
            else endGroup(G);
          }
        }
      } },

    tag: { name: '鬼抓人', n: [3, 4], w: 2.5,
      setup(G) {
        G.lo = clamp(G.x - 170, 24, Math.max(24, kidMaxX() - 346)); G.hi = Math.min(kidMaxX() - 6, G.lo + 340); G.x = (G.lo + G.hi) / 2;
        G.it = pick(G.members); G.swaps = 0;
        G.members.forEach(m => go(m, rand(G.lo, G.hi)));
        phase(G, 'gather');
      },
      step(G) {
        const it = G.it, runners = G.members.filter(m => m !== it), k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          it.tag = '鬼';
          line(G, it, '我當鬼！數到三喔～', 1.6);
          narrate('🏃 ' + tagsOf(G.members) + '在玩鬼抓人，' + numOf(it) + ' 號當鬼');
          phase(G, 'count'); return;
        }
        if (G.phase === 'count') {
          if (!G.f.go) {
            G.f.go = true; halt(it); pose(it, poseCover());
            const farLeft = it.x - G.lo > G.hi - it.x;
            for (const m of runners) { go(m, (farLeft ? rand(G.lo, G.lo + 90) : rand(G.hi - 90, G.hi)), 110); pose(m, P({})); }
          }
          if (k > 2) { pose(it, P({})); phase(G, 'chase'); }
          return;
        }
        if (G.phase === 'chase') {
          const tgt = runners.slice().sort((p, q) => Math.abs(p.x - it.x) - Math.abs(q.x - it.x))[0];
          go(it, tgt.x, 118);
          for (const m of runners) {
            const d = m.x - it.x, s = Math.sign(d) || 1;
            if (Math.abs(d) < 150) {
              let tx = clamp(m.x + s * 70, G.lo, G.hi);
              if (Math.abs(tx - m.x) < 10) tx = it.x - s * 70;      // 被逼到角落：從鬼旁邊閃過去
              go(m, clamp(tx, G.lo, G.hi), 104);
            } else { halt(m); pose(m, poseWave); }
          }
          if (Math.abs(tgt.x - it.x) < 14 && k > 0.6) {
            line(G, it, pick(['抓到你了！', '換你當鬼！', '嘿嘿，抓到了！']), 1.4);
            it.tag = null; G.it = tgt; tgt.tag = '鬼'; G.swaps++;
            narrate('🏃 ' + numOf(it) + ' 號抓到 ' + numOf(tgt) + ' 號，換 ' + numOf(tgt) + ' 號當鬼！');
            G.members.forEach(halt);
            phase(G, G.swaps >= 3 ? 'end' : 'count');
          } else if (k > 12) { line(G, it, '你們跑太快了啦～', 1.6); phase(G, 'end'); }
          return;
        }
        if (G.phase === 'end') {
          if (!G.f.s) { G.f.s = true; G.members.forEach(m => { halt(m); pose(m, posePant()); }); }
          if (k > 1.6 && !G.f.l) { G.f.l = true; line(G, pick(G.members), pick(['好累喔～', '喘死了…', '下一節再玩！']), 1.6); }
          if (k > 3.2) endGroup(G);
        }
      } },

    statue: { name: '一二三木頭人', n: [4, 5], w: 1.8,
      setup(G) {
        G.lo = clamp(G.x - 150, 24, Math.max(24, kidMaxX() - 300)); G.x = G.lo + 150;
        G.caller = G.members[0]; G.start = G.lo + 270; G.rounds = 0; G.backs = new Set();
        go(G.caller, G.lo);
        G.members.slice(1).forEach((m, i) => go(m, G.start + (i % 3) * 9 - 9));
        phase(G, 'gather');
      },
      step(G) {
        const c = G.caller, ps = G.members.filter(m => m !== c), k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          ps.forEach(m => { m.spd = rand(22, 42); pose(m, P({}), -1); });
          narrate('🗿 ' + tagsOf(G.members) + '在玩一二三木頭人，' + numOf(c) + ' 號當鬼');
          phase(G, 'count'); return;
        }
        if (G.phase === 'count') {
          if (!G.f.s) { G.f.s = true; G.f.dur = rand(1.6, 3); pose(c, poseCover(), -1); line(G, c, pick(['一、二、三…', '一、二、三～', '一二三…']), G.f.dur); }
          for (const m of ps) {
            if (G.backs.has(m)) { if (Math.abs(m.x - G.start) < 4) G.backs.delete(m); else continue; }
            go(m, c.x + 20, m.spd);
          }
          const hit = ps.find(m => Math.abs(m.x - c.x) < 24);
          if (hit) { G.hit = hit; phase(G, 'tap'); return; }
          if (k > G.f.dur) {
            phase(G, 'look');
            pose(c, posePoint(), 1);
            line(G, c, '木頭人！', 1.2);
            ps.forEach(m => { if (!G.backs.has(m)) { halt(m); pose(m, pick(STATUES)(), -1); } });
            const still = ps.filter(m => !G.backs.has(m));
            G.mover = still.length && Math.random() < 0.45 ? pick(still) : null;
          }
          return;
        }
        if (G.phase === 'look') {
          const mv = G.mover;
          if (mv && k > 0.5 && !G.f.w) { G.f.w = true; pose(mv, poseWobble); }
          if (mv && k > 1.0 && !G.f.c) { G.f.c = true; line(G, c, numOf(mv) + ' 號你動了！回去～', 1.6); narrate('🗿 ' + numOf(mv) + ' 號玩木頭人的時候偷動，被抓到了！'); }
          if (mv && k > 1.8 && !G.f.b) { G.f.b = true; G.backs.add(mv); go(mv, G.start, 70); line(G, mv, pick(['我哪有！', '好啦…', '可惡～']), 1.4); }
          if (k > (mv ? 2.6 : 1.8)) { if (++G.rounds > 7) { endGroup(G); return; } phase(G, 'count'); }
          return;
        }
        if (G.phase === 'tap') {
          if (!G.f.t) {
            G.f.t = true; line(G, G.hit, '碰！', 1);
            narrate('🗿 ' + numOf(G.hit) + ' 號拍到鬼了！大家快跑～');
            pose(c, P({}), 1);
            ps.forEach(m => go(m, m.x + rand(140, 220), 130));
          }
          if (k > 0.5 && !G.f.ch) { G.f.ch = true; go(c, c.x + 130, 118); }
          if (k > 2.4) endGroup(G);
        }
      } },

    rope: { name: '跳繩', n: [3, 3], w: 1.8,
      setup(G) { [G.L, G.R, G.J] = G.members; G.round = 0; ropePlace(G); },
      step(G, dt) {
        const { L, R, J } = G, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          pose(L, P({}), 1); pose(R, P({}), -1); pose(J, P({}), 1);
          if (!G.round) narrate('🪢 ' + tagsOf(G.members) + '在跳繩');
          line(G, L, pick(['預備～跳！', '我們甩，你跳！', '換你跳了！']), 1.4);
          G.ph = Math.PI; G.count = 0; G.fail = rint(4, 16);
          phase(G, 'swing'); return;
        }
        if (G.phase === 'swing') {
          const prev = G.ph; G.ph += dt * 5.2;
          pose(L, poseHold(G.ph)); pose(R, poseHold(G.ph));
          J.hop = 20 * Math.pow(Math.max(0, Math.cos(G.ph)), 0.7);
          pose(J, J.hop > 3 ? P({ ra1: 0.5, ra2: 0.9, la1: 0.5, la2: 0.9, rl1: 0.3, rl2: -0.3, ll1: 0.2, ll2: -0.4 }) : P({ ra1: 0.4, la1: 0.4 }));
          // 繩子轉到最下面（cos = 1）算一下
          if (Math.floor(prev / (2 * Math.PI)) !== Math.floor(G.ph / (2 * Math.PI))) {
            if (G.count >= G.fail) { G.ph = Math.round(G.ph / (2 * Math.PI)) * 2 * Math.PI; J.hop = 0; phase(G, 'trip'); return; }
            G.count++; J.tag = String(G.count);
          }
          return;
        }
        if (G.phase === 'trip') {
          if (!G.f.s) {
            G.f.s = true; pose(L, P({})); pose(R, P({})); pose(J, poseStumble);
            line(G, J, pick(['哎呀！絆到了！', '腳勾到繩子了啦～', G.count + ' 下！']), 1.5);
            narrate('🪢 ' + numOf(J) + ' 號跳繩連續跳了 ' + G.count + ' 下！');
          }
          if (k > 2) { J.tag = null; J.hop = 0; if (++G.round >= 3) { endGroup(G); return; } [G.L, G.R, G.J] = [G.J, G.L, G.R]; ropePlace(G); }
        }
      },
      draw(G) {
        if ((G.phase !== 'swing' && G.phase !== 'trip') || !G.L.j || !G.R.j) return;
        const [x1, y1] = G.L.j.rH, [x2, y2] = G.R.j.rH, hy = (y1 + y2) / 2;
        const c = Math.cos(G.ph), top = FLOOR - 105 * BASE / 1.5;
        const mid = c >= 0 ? hy + c * (FLOOR - 1 - hy) : hy + c * (hy - top);
        g.strokeStyle = '#ff9f1c'; g.lineWidth = 2.5; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo((x1 + x2) / 2, 2 * mid - hy, x2, y2); g.stroke();
      } },

    kick: { name: '踢毽子', n: [1, 1], w: 1.8,
      setup(G) { go(G.members[0], G.x); G.round = 0; phase(G, 'gather'); },
      step(G, dt) {
        const m = G.members[0], k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          pose(m, poseReady(), G.round ? m.act.face : pick([1, -1]));
          if (!G.round) narrate('🪶 ' + numOf(m) + ' 號在踢毽子');
          G.h = 30; G.v = 330; G.count = 0; G.fail = rint(5, 22); G.kt = -9; G.sx = m.x + m.f * 9;
          phase(G, 'play'); return;
        }
        G.v -= 760 * dt; G.h += G.v * dt;
        if (G.phase === 'play') {
          G.sx = m.x + m.f * 9;
          if (G.h <= 16 && G.v < 0) {
            if (G.count < G.fail) { G.v = rand(330, 390); G.count++; G.kt = T; m.tag = String(G.count); }
            else { G.v = -40; phase(G, 'drop'); G.sx += m.f * 16; return; }
          }
          pose(m, T - G.kt < 0.22 ? poseKick() : poseReady());
        }
        if (G.h <= 3) { G.h = 3; G.v = 0; }
        if (G.phase === 'drop') {
          if (!G.f.s && G.h <= 3) {
            G.f.s = true;
            const good = G.count >= 15;
            pose(m, good ? poseCheer : poseSlump());
            line(G, m, good ? pick([G.count + ' 下！新紀錄！', '我是踢毽子大王！']) : pick(['啊～掉了！', '差一點點！', '再來再來！']), 1.6);
            narrate('🪶 ' + numOf(m) + ' 號踢毽子連續踢了 ' + G.count + ' 下！');
          }
          if (k > 2.4) { m.tag = null; if (++G.round >= 2) { endGroup(G); return; } phase(G, 'gather'); }
        }
      },
      draw(G) {
        if (G.phase !== 'play' && G.phase !== 'drop') return;
        const x = G.sx, y = FLOOR - G.h;
        g.lineWidth = 2; g.lineCap = 'round';
        [['#f6c344', -0.35], ['#4cc9f0', 0], ['#46d22e', 0.35]].forEach(([col, a]) => { g.strokeStyle = col; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(a) * 10, y - Math.cos(a) * 10); g.stroke(); });
        g.fillStyle = '#e63946'; g.beginPath(); g.arc(x, y + 1, 3.2, 0, Math.PI * 2); g.fill();
      } },

    ball: { name: '丟接球', n: [2, 2], w: 2,
      setup(G) { const [A, B] = G.members; G.homeA = G.x - 65; G.homeB = G.x + 65; go(A, G.homeA); go(B, G.homeB); G.misses = 0; G.streak = 0; G.best = 0; G.from = A; phase(G, 'gather'); },
      step(G, dt) {
        const [A, B] = G.members, k = G.t - G.t0, other = m => m === A ? B : A;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          pose(A, P({}), 1); pose(B, P({}), -1);
          if (!G.f0) { G.f0 = true; narrate('⚾ ' + tagsOf([A, B]) + '在丟接球'); }
          G.missAt = rint(3, 8); G.passes = 0;
          phase(G, 'throw'); return;
        }
        if (G.phase === 'throw') {
          const fr = G.from, to = other(fr);
          if (!G.f.s) { G.f.s = true; G.dur = rand(0.9, 1.2); G.miss = G.passes + 1 >= G.missAt; pose(fr, poseThrow()); pose(to, poseCatch()); G.p0 = hand(fr).slice(); }
          const u = Math.min(1, k / G.dur), p1 = G.miss ? [to.x + (to.x > fr.x ? 70 : -70), FLOOR - 6] : hand(to);
          G.bx = G.p0[0] + (p1[0] - G.p0[0]) * u; G.by = G.p0[1] + (p1[1] - G.p0[1]) * u - Math.sin(u * Math.PI) * 85;
          if (u > 0.35) pose(fr, P({}));
          if (u >= 1) {
            if (!G.miss) { G.passes++; G.streak++; G.best = Math.max(G.best, G.streak); G.from = to; phase(G, 'throw'); }
            else {
              G.misses++; G.streak = 0;
              line(G, fr, pick(['漏接了啦～', '哈哈，你沒接到！', '球跑掉了！']), 1.4);
              pose(to, P({}));
              phase(G, 'fetch');
            }
          }
          return;
        }
        if (G.phase === 'fetch') {
          const to = other(G.from), dir = to.x > G.from.x ? 1 : -1;
          if (k < 0.8) G.bx = clamp(G.bx + dir * 90 * dt * (1 - k / 0.8), 24, kidMaxX() - 6);
          G.by = FLOOR - 6;
          if (k > 0.4) go(to, G.bx, 110);
          if (k > 0.9 && Math.abs(to.x - G.bx) < 4) {
            if (G.misses >= 2) { narrate('⚾ ' + tagsOf([A, B]) + '丟接球，最多連續接到 ' + G.best + ' 球'); endGroup(G); return; }
            go(to, to === A ? G.homeA : G.homeB, 60);
            G.from = to; phase(G, 'carry');
          }
          return;
        }
        if (G.phase === 'carry') {
          [G.bx, G.by] = hand(G.from);
          if (ready(G)) phase(G, 'gather');
        }
      },
      draw(G) {
        if (G.bx == null || G.phase === 'gather') return;
        g.fillStyle = '#ff7b3a'; g.strokeStyle = INK; g.lineWidth = 1.5;
        g.beginPath(); g.arc(G.bx, G.by, 5.5, 0, Math.PI * 2); g.fill(); g.stroke();
      } },

    height: { name: '比身高', n: [2, 2], w: 1.5,
      setup(G) { const [A, B] = G.members; go(A, G.x - 6); go(B, G.x + 6); phase(G, 'gather'); },
      step(G) {
        const [A, B] = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          pose(A, P({}), -1); pose(B, P({}), 1);         // 背靠背
          const ha = kidHeight(A.num), hb = kidHeight(B.num);
          const tall = ha >= hb ? A : B, short = tall === A ? B : A, diff = Math.abs(ha - hb);
          G.script = [
            [A, '我們來比身高！'],
            [B, '背靠背站好，不准踮腳！'],
            [tall, diff <= 2 ? '欸？好像一樣高！' : '看！我比較高！', () => {
              narrate(diff <= 2 ? '📏 ' + tagsOf([A, B]) + '比身高，幾乎一樣高！' : '📏 ' + numOf(tall) + ' 號比 ' + numOf(short) + ' 號高 ' + diff + ' 公分');
            }],
            [short, diff <= 2 ? '那我們是雙胞胎！' : pick(['你一定有踮腳！', '我還會再長高的！', '我每天喝牛奶，下次就贏你！'])],
          ];
          G.tall = tall; G.i = 0; G.next = 0.3;
          phase(G, 'talk'); return;
        }
        if (G.phase === 'talk') {
          const done = runScript(G, k);
          if (G.i >= 3) pose(G.tall, poseMeasure());          // 手平放在兩個人頭上量
          if (done) phase(G, 'bye');
          return;
        }
        if (k > 1.4) endGroup(G);
      } },
  };
  function ropePlace(G) { go(G.L, G.x - 58, 60); go(G.R, G.x + 58, 60); go(G.J, G.x, 60); G.L.tag = G.R.tag = G.J.tag = null; phase(G, 'gather'); }

  // 可以找來玩的人：站在地上、沒事做、不是被抓的人
  const freeKid = k => k.surf === 'floor' && !k.air && !k.cell && !k.fear && !k.goal && !k.phone && !k.group
    && ['idle', 'walk', 'run'].includes(k.act.type) && k.x < kidMaxX() - 10 && k.y >= FLOOR - 1;
  // 找一塊空地、找附近閒著的人開始一個活動；同時最多 3 組，不重複同一種
  function startActivity(force) {
    if (S.raid) return null;
    const ks = kids();
    if (!force && groups.length >= clamp(Math.floor(ks.length / 5), 1, 3)) return null;
    const free = ks.filter(freeKid);
    const defs = Object.entries(ACTS).filter(([id, d]) => free.length >= d.n[0] && (!d.scenes || d.scenes.includes(S.scene)) && (force ? id === force : !groups.some(G => G.kind === id)));
    if (!defs.length) return null;
    let r = Math.random() * defs.reduce((x, [, d]) => x + d.w, 0), id = defs[defs.length - 1][0];
    for (const [i, d] of defs) { r -= d.w; if (r <= 0) { id = i; break; } }
    const def = ACTS[id];
    const lo = 200, hi = kidMaxX() - 110;       // 左邊是積木堆和開關按鈕
    if (hi <= lo) return null;
    const b = bear();
    let cx = null, best = -1;
    for (let i = 0; i < 10; i++) {
      const x = rand(lo, hi);
      const dmin = Math.min(1e9, ...groups.map(G => Math.abs(G.x - x)), b && b.surf === 'floor' ? Math.abs(b.x - x) + 120 : 1e9, S.tower ? Math.abs(towerX - x) + 140 : 1e9);
      if (dmin > best) { best = dmin; cx = x; }
    }
    if (best < 260 && !force) return null;
    const n = Math.min(rint(def.n[0], def.n[1]), free.length);
    const ms = free.sort((p, q) => Math.abs(p.x - cx) - Math.abs(q.x - cx)).slice(0, n);
    const G = { kind: id, def, members: ms, x: cx, t: 0, t0: 0, f: {} };
    for (const m of ms) { m.goal = null; m.phone = false; m.carry = null; setAct(m, 'play', { g: G }); m.group = G; }
    def.setup(G);
    groups.push(G);
    return G;
  }
  function endGroup(G) {
    if (G.over) return;
    G.over = true;
    for (const m of G.members) if (!m.gone && m.act.type === 'play' && m.act.g === G) setAct(m, 'idle', { dur: rand(0.8, 2.5) });
  }
  function stepGroups(dt) {
    for (const G of groups) {
      if (G.over) continue;
      // 有人被抓走、跑掉：這組就散了
      if (G.members.some(m => m.gone || m.act.type !== 'play' || m.act.g !== G) || G.t > 75) { endGroup(G); continue; }
      G.t += dt;
      G.def.step(G, dt);
    }
    groups = groups.filter(G => !G.over);
  }
  function drawGroups() { for (const G of groups) if (G.def.draw) G.def.draw(G); }

  // ---------- 場景：一般、忍者村、海底、雪地、冰與火（老師手動選；想加新場景就往 SCENES 加一筆） ----------
  // 換場景時整個看板的背景、作業卡片、號碼格也跟著換裝（index.html 用 <html data-scene> 切換 CSS）
  const SCENES = [
    { id: 'playground', label: '一 般', banner: '🏫 回到平常的樣子囉！' },
    { id: 'ninja', label: '忍 者 村', banner: '🥷 布景主題切換：忍者村！有人帶武士刀、有人拿長槍、有人穿和服，還會瞬間移動' },
    { id: 'ocean', label: '海 底', banner: '🌊 布景主題切換：海底世界！大家戴上潛水鏡，咕嚕咕嚕～' },
    { id: 'snow', label: '雪 地', banner: '❄️ 布景主題切換：下雪了！大家穿上厚厚的雪衣，號碼都變成雪人了' },
    { id: 'sanguo', label: '三 國', banner: '⚔️ 布景主題切換：三國！赤壁江上一整排連環船，孔明、周瑜、黃蓋、曹操、劉關張都來了（名字寫在衣服上）' },
    { id: 'icefire', label: '冰 與 火', banner: '🔥❄️ 布景主題切換：冰與火！大家披上黑斗篷，有人拿長劍、有人舉火把、有人抱龍蛋，還有冰原狼跟著；天上有黑色巨龍在飛' },
  ];
  function applySceneDom() {
    const root = document.documentElement;
    if (running && S.scene !== 'playground') root.dataset.scene = S.scene; else delete root.dataset.scene;
    for (const ms of [120, 450, 1000]) setTimeout(() => { if (running) measure(); }, ms);     // 卡片換裝後大小會變，重新量站的位置
  }
  const sceneLabel = () => (SCENES.find(x => x.id === S.scene) || SCENES[0]).label;
  function setScene(id, quiet) {
    if (!SCENES.some(x => x.id === id) || id === S.scene) return;
    S.scene = id;
    applySceneDom();
    if (sceneSel) sceneSel.value = id;
    if (quiet) { for (const G of groups) if (G.def.scenes && !G.def.scenes.includes(id)) endGroup(G); if (pgLabel && !pgLabel.classList.contains('narr')) pgLabel.textContent = sceneLabel(); return; }
    if (id !== 'snow') S.snowmen = [];
    // 只屬於別的場景的活動（雪仗、射飛鏢…）收掉
    for (const G of groups) if (G.def.scenes && !G.def.scenes.includes(id)) endGroup(G);
    banner(SCENES.find(x => x.id === id).banner);
    if (pgLabel && !pgLabel.classList.contains('narr')) pgLabel.textContent = sceneLabel();
    // 換場景時大家嚇一跳、跳一下
    for (const k of kids()) if (!k.air && STANDING.includes(k.act.type) && !k.fear && Math.random() < 0.5) { k.goal = null; setAct(k, 'flipHop'); k.vx = 0; k.vy = -380; k.air = true; }
    for (let i = 0; i < 6; i++) smoke(rand(80, kidMaxX()), FLOOR);
  }
  // 背景：雪地有雪和飄雪；忍者村有鳥居和櫻花瓣（都是淡淡的，不搶人物）
  function drawScene() {
    if (S.scene === 'snow') {
      g.fillStyle = 'rgba(235,242,255,0.85)';
      roundRect(0, FLOOR - 5, pit.x1 - 20, 9, 4); g.fill();
      for (const sm of S.snowmen) drawSnowman(sm.x, 1, sm.hat);
      g.fillStyle = 'rgba(255,255,255,0.75)';
      for (let i = 0; i < 70; i++) {
        const x = (i * 137.5 + Math.sin(T * 0.7 + i) * 18 + T * (8 + (i % 4) * 4)) % W;
        const y = (i * 91.3 + T * (28 + (i % 5) * 9)) % (H - 20);
        g.beginPath(); g.arc(x, y, 1.4 + (i % 3) * 0.7, 0, Math.PI * 2); g.fill();
      }
    } else if (S.scene === 'ninja') {
      // 鳥居 + 兩座石燈籠
      const cx = Math.min(kidMaxX() - 130, W * 0.42), hw = 70 * BASE / 1.5, top = FLOOR - 165 * BASE / 1.5;
      g.save(); g.fillStyle = '#c0392b';
      g.fillRect(cx - hw + 8, top + 10, 10, FLOOR - top - 10); g.fillRect(cx + hw - 18, top + 10, 10, FLOOR - top - 10);
      g.fillRect(cx - hw - 16, top, hw * 2 + 32, 10); g.fillRect(cx - hw - 4, top + 26, hw * 2 + 8, 7);
      g.fillRect(cx - 5, top + 10, 10, 16);
      g.fillStyle = '#1e1e24'; g.beginPath(); g.moveTo(cx - hw - 26, top - 10); g.quadraticCurveTo(cx, top - 2, cx + hw + 26, top - 10); g.lineTo(cx + hw + 20, top + 1); g.lineTo(cx - hw - 20, top + 1); g.closePath(); g.fill();
      g.fillRect(cx - hw + 6, FLOOR - 8, 14, 8); g.fillRect(cx + hw - 20, FLOOR - 8, 14, 8);
      for (const lx of [cx - hw - 50, cx + hw + 50]) stoneLantern(lx);
      g.restore();
      // 櫻花瓣
      g.fillStyle = 'rgba(255,183,213,0.85)';
      for (let i = 0; i < 26; i++) {
        const x = (i * 211.7 + T * (22 + (i % 3) * 8) + Math.sin(T + i) * 20) % W;
        const y = (i * 67.1 + T * (20 + (i % 4) * 6)) % (H - 20);
        g.save(); g.translate(x, y); g.rotate(T * 2 + i); g.beginPath(); g.ellipse(0, 0, 4, 2.2, 0, 0, Math.PI * 2); g.fill(); g.restore();
      }
    } else if (S.scene === 'icefire') {
      // 左邊結冰、右邊是燒紅的地；左邊飄雪、右邊往上飄餘燼
      const mid = kidMaxX() * 0.5;
      g.fillStyle = 'rgba(210,240,255,0.85)'; roundRect(0, FLOOR - 5, mid, 9, 4); g.fill();
      g.fillStyle = 'rgba(70,20,12,0.9)'; g.fillRect(mid, FLOOR - 4, pit.x1 - 20 - mid, 8);
      g.strokeStyle = 'rgba(255,' + (120 + Math.sin(T * 3) * 30 | 0) + ',30,0.9)'; g.lineWidth = 2;
      g.beginPath(); for (let x = mid; x < pit.x1 - 30; x += 38) { g.moveTo(x, FLOOR - 1); g.lineTo(x + 14, FLOOR + 2); g.lineTo(x + 26, FLOOR - 2); } g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.8)';
      for (let i = 0; i < 30; i++) {
        const x = (i * 137.5 + Math.sin(T * 0.7 + i) * 18 + T * 10) % mid;
        const y = (i * 91.3 + T * (28 + (i % 5) * 9)) % (H - 20);
        g.beginPath(); g.arc(x, y, 1.4 + (i % 3) * 0.6, 0, Math.PI * 2); g.fill();
      }
      for (let i = 0; i < 26; i++) {
        const x = mid + (i * 173.3 + Math.sin(T + i) * 14) % (W - mid), y = FLOOR - ((T * (40 + (i % 4) * 12) + i * 37) % 320);
        g.fillStyle = i % 3 ? 'rgba(255,150,40,0.85)' : 'rgba(255,220,90,0.9)';
        g.beginPath(); g.arc(x, y, 1.5 + (i % 3) * 0.7, 0, Math.PI * 2); g.fill();
      }
      drawDragon();
    } else if (S.scene === 'sanguo') {
      const xr = pit.x1 - 20;
      g.fillStyle = 'rgba(30,60,110,0.8)'; roundRect(0, FLOOR - 4, xr, 9, 4); g.fill();
      g.strokeStyle = 'rgba(160,210,255,0.55)'; g.lineWidth = 1.5; g.beginPath();
      for (let x = (T * 22) % 40; x < xr - 20; x += 40) { g.moveTo(x, FLOOR + 1); g.quadraticCurveTo(x + 8, FLOOR - 2, x + 16, FLOOR + 1); }
      g.stroke();
      // 東風：一條一條的風往曹營（右邊）吹
      if (S.wind > T) {
        const fade = Math.min(1, (S.wind - T) / 2);
        g.strokeStyle = 'rgba(230,240,255,' + (0.55 * fade).toFixed(2) + ')'; g.lineWidth = 2; g.lineCap = 'round';
        for (let i = 0; i < 34; i++) {
          const x = (i * 173.3 + T * (420 + (i % 5) * 70)) % (W + 240) - 120, y = 30 + (i * 57.7) % Math.max(60, FLOOR - 60), L = 40 + (i % 4) * 18;
          g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + L * 0.5, y - 4, x + L, y); g.stroke();
        }
        for (let i = 0; i < 10; i++) {
          const x = (i * 211 + T * 360) % (W + 100) - 50, y = FLOOR - 20 - (i * 37) % 160 + Math.sin(T * 6 + i) * 8;
          g.fillStyle = i % 2 ? 'rgba(120,180,90,0.85)' : 'rgba(200,160,80,0.85)';
          g.save(); g.translate(x, y); g.rotate(T * 8 + i); g.beginPath(); g.ellipse(0, 0, 4, 2, 0, 0, Math.PI * 2); g.fill(); g.restore();   // 被吹走的葉子
        }
      }
    } else if (S.scene === 'ocean') {
      const xr = kidMaxX();
      g.fillStyle = 'rgba(214,190,140,0.6)'; roundRect(0, FLOOR - 4, pit.x1 - 20, 9, 4); g.fill();
      // 海草
      for (let i = 0; i < 10; i++) {
        const x = 110 + i * (xr - 150) / 9 + (i % 2) * 21, h = (42 + (i * 37) % 46) * BASE / 1.5;
        g.strokeStyle = ['#2a9d6f', '#1f7a5a', '#3cb47e'][i % 3]; g.lineWidth = 5; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x, FLOOR);
        for (let k = 1; k <= 6; k++) g.lineTo(x + Math.sin(T * 1.6 + i + k * 0.7) * k * 1.6, FLOOR - h * k / 6);
        g.stroke();
      }
      // 魚
      const FISH = ['#ffd166', '#ff8c61', '#9be7ff', '#ffb3c6', '#b8f28c'];
      for (let i = 0; i < 6; i++) {
        const sp = 26 + (i % 3) * 13, dir = i % 2 ? 1 : -1, span = xr + 200;
        let x = (T * sp + i * 233) % span - 100; if (dir < 0) x = span - 200 - x;
        const y = FLOOR - 80 - (i * 53) % 150 + Math.sin(T * 1.5 + i) * 6;
        drawFish(x, y, dir, FISH[i % FISH.length], (0.8 + (i % 3) * 0.25) * BASE / 1.5);
      }
      // 骷髏區後面的沉船：斷掉的船頭、桅杆、破帆和海盜旗
      drawWreck((pit.x1 + pit.x2) / 2 + 20);
      // 泡泡
      g.strokeStyle = 'rgba(210,245,255,0.7)'; g.lineWidth = 1.3;
      for (let i = 0; i < 16; i++) {
        const x = (i * 97.3) % xr + Math.sin(T * 2 + i) * 6, y = FLOOR - ((T * (28 + (i % 4) * 9) + i * 45) % 280);
        g.beginPath(); g.arc(x, y, 2 + (i % 3), 0, Math.PI * 2); g.stroke();
      }
    }
  }
  function drawWreck(cx) {
    const k = BASE / 1.5;
    g.save(); g.translate(cx, FLOOR + 4); g.rotate(-0.12); g.scale(k, k);
    g.fillStyle = '#5b3a22'; g.strokeStyle = '#2b1a0e'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-110, 0); g.quadraticCurveTo(-100, -40, -60, -52); g.lineTo(70, -52); g.lineTo(95, -78); g.lineTo(100, -50); g.lineTo(80, 0); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = '#3d2614'; g.lineWidth = 3; for (const y of [-36, -20]) { g.beginPath(); g.moveTo(-100, y); g.lineTo(88, y); g.stroke(); }
    g.fillStyle = '#1c1008'; for (const x of [-60, -25, 10, 45]) { g.beginPath(); g.arc(x, -42, 5, 0, Math.PI * 2); g.fill(); }
    // 破洞
    g.fillStyle = '#0d1f2c'; g.beginPath(); g.moveTo(-20, -10); g.lineTo(-5, -30); g.lineTo(15, -18); g.lineTo(5, -2); g.closePath(); g.fill();
    g.strokeStyle = '#4a2f1a'; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-10, -52); g.lineTo(-18, -150); g.stroke();
    g.beginPath(); g.moveTo(-17, -130); g.lineTo(-60, -124); g.stroke();
    g.fillStyle = 'rgba(220,210,180,0.55)'; g.beginPath(); g.moveTo(-18, -128); g.quadraticCurveTo(-50, -110, -40, -80); g.lineTo(-30, -95); g.lineTo(-22, -84); g.closePath(); g.fill();
    g.fillStyle = '#121218'; g.beginPath(); g.moveTo(-18, -150); g.lineTo(18 + Math.sin(T * 3) * 3, -144); g.lineTo(-18, -134); g.closePath(); g.fill();
    g.fillStyle = '#f1efe6'; g.beginPath(); g.arc(-6, -142, 2.6, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // 冰與火的龍：每隔一陣子從天上飛過去，中間噴一口火；被火噴到附近的人會跳起來
  function startDragon() {
    if (S.scene !== 'icefire' || S.dragon) return false;
    const dir = Math.random() < 0.5 ? 1 : -1;
    S.dragon = { t0: T, dir, y: FLOOR - rand(190, 240) * BASE / 1.5, fireAt: rand(0.35, 0.6), hit: new Set() };
    narrate('🐉 一條黑色巨龍從天上飛過來了…', true);
    return true;
  }
  function drawDragon() {
    const D = S.dragon; if (!D) return;
    const u = (T - D.t0) / 8;
    if (u > 1 || S.scene !== 'icefire') { S.dragon = null; return; }
    const k = BASE / 1.5 * 1.7, x = D.dir > 0 ? -260 + u * (W + 520) : W + 260 - u * (W + 520), y = D.y + Math.sin(T * 1.6) * 12;
    const fire = Math.abs(u - D.fireAt) < 0.11;
    const flap = Math.sin(T * 5.5);
    g.save(); g.translate(x, y); g.scale(D.dir * k, k);
    const BLK = '#17110f', RED = '#8e1c14', MEM = 'rgba(70,14,12,0.92)';
    // 後面那片翅膀（比較暗）
    wing(-6, -8, flap * 0.8 + 0.3, 'rgba(40,10,8,0.85)');
    // 尾巴
    g.fillStyle = BLK; g.beginPath(); g.moveTo(-40, -6);
    g.bezierCurveTo(-80, -2 + Math.sin(T * 3) * 6, -110, 16 + Math.sin(T * 3 + 1) * 10, -150, 6 + Math.sin(T * 3 + 2) * 12);
    g.lineTo(-148, 12 + Math.sin(T * 3 + 2) * 12); g.bezierCurveTo(-108, 24, -80, 10, -40, 8); g.closePath(); g.fill();
    const tx = -150, ty = 9 + Math.sin(T * 3 + 2) * 12;
    g.fillStyle = RED; g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx - 12, ty - 9); g.lineTo(tx - 8, ty + 2); g.lineTo(tx - 12, ty + 11); g.closePath(); g.fill();
    // 身體
    g.fillStyle = BLK; g.beginPath(); g.ellipse(-8, 0, 46, 15, -0.05, 0, Math.PI * 2); g.fill();
    g.fillStyle = RED; g.beginPath(); g.ellipse(-6, 8, 36, 5, -0.05, 0, Math.PI * 2); g.fill();
    // 背刺
    g.fillStyle = RED; for (let b = -40; b <= 20; b += 10) { g.beginPath(); g.moveTo(b - 4, -12); g.lineTo(b, -21); g.lineTo(b + 4, -12); g.closePath(); g.fill(); }
    // 腳（縮在身體下面）
    g.strokeStyle = BLK; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-28, 10); g.lineTo(-34, 24); g.lineTo(-26, 28); g.stroke();
    // 脖子和頭
    const jaw = fire ? 0.35 + Math.sin(T * 20) * 0.05 : 0.05;
    g.fillStyle = BLK; g.beginPath(); g.moveTo(26, -10); g.bezierCurveTo(44, -22, 52, -34, 66, -36); g.lineTo(72, -26); g.bezierCurveTo(58, -22, 50, -8, 34, 8); g.closePath(); g.fill();
    g.save(); g.translate(68, -32);
    g.beginPath(); g.moveTo(-6, -8); g.lineTo(18, -6); g.lineTo(30, -1); g.lineTo(14, 3); g.lineTo(-6, 6); g.closePath(); g.fill();          // 上顎
    g.save(); g.rotate(jaw); g.beginPath(); g.moveTo(-4, 3); g.lineTo(24, 4); g.lineTo(10, 9); g.lineTo(-4, 8); g.closePath(); g.fill(); g.restore();   // 下巴
    g.fillStyle = '#e8dcc0'; for (const hx of [-4, 2]) { g.beginPath(); g.moveTo(hx, -6); g.lineTo(hx - 14, -16 + (hx > 0 ? 3 : 0)); g.lineTo(hx + 3, -5); g.closePath(); g.fill(); }  // 角
    g.fillStyle = '#ff9a1a'; g.shadowColor = 'rgba(255,150,40,0.9)'; g.shadowBlur = 6; g.beginPath(); g.ellipse(10, -3, 2.6, 1.6, -0.2, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
    g.restore();
    // 前面那片翅膀
    wing(-2, -10, flap, MEM);
    g.restore();
    function wing(sx, sy, fl, fill) {
      // 翅膀：手臂骨到翼腕，再分出四根指骨，中間是翅膜
      const wx = sx + 20, wy = sy - 50 - fl * 40;                 // 翼腕
      const tips = [[wx + 50, wy - 10 - fl * 12], [wx + 30, wy + 24 - fl * 4], [wx - 4, wy + 44], [wx - 40, wy + 52 + fl * 6]];
      g.fillStyle = fill; g.beginPath(); g.moveTo(sx, sy); g.lineTo(wx, wy);
      for (let n = 0; n < tips.length; n++) {
        g.lineTo(tips[n][0], tips[n][1]);
        const nx = n + 1 < tips.length ? tips[n + 1] : [sx - 44, sy + 4];
        g.quadraticCurveTo((tips[n][0] + nx[0]) / 2 - 4, (tips[n][1] + nx[1]) / 2 - 10, nx[0], nx[1]);
      }
      g.closePath(); g.fill();
      g.strokeStyle = '#120c0a'; g.lineWidth = 2.6; g.beginPath(); g.moveTo(sx, sy); g.lineTo(wx, wy);
      for (const [px, py] of tips) { g.moveTo(wx, wy); g.lineTo(px, py); }
      g.stroke();
      g.fillStyle = '#e8dcc0'; g.beginPath(); g.moveTo(wx, wy); g.lineTo(wx + 4, wy - 9); g.lineTo(wx + 6, wy); g.closePath(); g.fill();
    }
    if (fire) {
      if (!D.said) { D.said = true; narrate('🔥 黑龍噴火了！好燙好燙好燙！', true); }
      const ca = Math.cos(0.6), sa = Math.sin(0.6);
      const mx = x + D.dir * (68 + 26) * k * 1, my = y + (-32 + 2) * k;
      const gx = mx + D.dir * 70, len = Math.hypot(gx - mx, FLOOR - my);
      g.save();
      g.translate(mx, my); g.rotate(Math.atan2(FLOOR - my, gx - mx));
      for (let n = 0; n < 3; n++) {
        const w = [26, 16, 7][n] * (1 + Math.sin(T * 25 + n) * 0.12);
        g.fillStyle = ['rgba(230,60,20,0.75)', 'rgba(255,150,30,0.85)', 'rgba(255,240,170,0.95)'][n];
        g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(len * 0.5, -w, len, -w * 1.6); g.lineTo(len, w * 1.6); g.quadraticCurveTo(len * 0.5, w, 0, 0); g.closePath(); g.fill();
      }
      g.restore();
      // 地上燒起來
      for (let n = 0; n < 5; n++) {
        const fx = gx + (n - 2) * 16, h = 18 + Math.sin(T * 18 + n * 2) * 7;
        g.fillStyle = n % 2 ? 'rgba(255,120,30,0.9)' : 'rgba(255,210,80,0.9)';
        g.beginPath(); g.moveTo(fx - 9, FLOOR); g.quadraticCurveTo(fx - 4, FLOOR - h * 0.6, fx, FLOOR - h); g.quadraticCurveTo(fx + 4, FLOOR - h * 0.6, fx + 9, FLOOR); g.closePath(); g.fill();
      }
      for (const kd of kids()) {
        if (D.hit.has(kd) || kd.surf !== 'floor' || kd.air || Math.abs(kd.x - gx) > 90 || BUSY_ACTS.includes(kd.act.type)) continue;
        D.hit.add(kd); kd.goal = null;
        if (Math.random() < 0.45) {
          setAct(kd, 'ash');
          if (!D.ashSaid) { D.ashSaid = true; setTimeout(() => narrate('💨 ' + tagOf(kd.num) + '被龍火燒成焦炭，碎成一堆灰…灰會飄進籠子裡', true), 1600); }
          continue;
        }
        kd.burn = T + 3.4; setAct(kd, 'flipHop'); kd.vx = 0; kd.vy = -430; kd.air = true;
        if (Math.random() < 0.75) say(kd, pick(['燙燙燙！', '我的屁股著火了！', '頭髮燒焦了啦！', '呼呼呼～好燙！', '水！誰有水！', '我變烤肉了！']), 1.5, 1);
      }
    }
  }
  // 曹軍戰船：船身、船艙、桅杆、帆、寫「曹」的旗子；點火後帆燒掉、整艘變黑
  function drawWarship(x, fire) {
    const k = BASE / 1.5, y = FLOOR, on = fire >= 0 && T >= fire, age = on ? T - fire : 0, burnt = on && age > 2.5;
    g.save(); g.shadowBlur = 0;
    g.fillStyle = burnt ? '#2a1a12' : '#6b3f1f';
    g.beginPath(); g.moveTo(x - 30 * k, y - 16 * k); g.lineTo(x + 30 * k, y - 16 * k); g.quadraticCurveTo(x + 26 * k, y, x + 18 * k, y); g.lineTo(x - 18 * k, y); g.quadraticCurveTo(x - 26 * k, y, x - 30 * k, y - 16 * k); g.closePath(); g.fill();
    g.fillStyle = burnt ? '#1e1410' : '#8a5a2b'; g.fillRect(x - 12 * k, y - 26 * k, 24 * k, 10 * k);
    g.strokeStyle = burnt ? '#1a100a' : '#3a2412'; g.lineWidth = 2.5 * k; g.beginPath(); g.moveTo(x, y - 16 * k); g.lineTo(x, y - 64 * k); g.stroke();
    if (!burnt) {
      g.fillStyle = on ? '#8a6a3a' : '#d9c39a'; g.fillRect(x - 14 * k, y - 62 * k, 28 * k, 30 * k);
      g.strokeStyle = '#8a6a3a'; g.lineWidth = 1.2; g.beginPath(); for (let t = 1; t < 4; t++) { g.moveTo(x - 14 * k, y - 62 * k + t * 7.5 * k); g.lineTo(x + 14 * k, y - 62 * k + t * 7.5 * k); } g.stroke();
      g.fillStyle = '#2b4fa8'; g.fillRect(x, y - 74 * k, 13 * k, 9 * k);
      g.fillStyle = '#fff'; g.font = '900 ' + (7.5 * k) + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('曹', x + 6.5 * k, y - 69.3 * k); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    }
    if (on) {
      const grow = Math.min(1, age / 0.6) * (burnt ? 0.6 : 1);
      g.shadowColor = 'rgba(255,140,30,0.9)'; g.shadowBlur = 12;
      for (let n = 0; n < 5; n++) {
        const fx = x + (n - 2) * 11 * k, h = (26 + Math.sin(T * 17 + n * 2) * 8 + (n % 2) * 14) * k * grow, base = y - 14 * k;
        g.fillStyle = n % 2 ? 'rgba(255,120,30,0.9)' : 'rgba(255,214,90,0.92)';
        g.beginPath(); g.moveTo(fx - 7 * k, base); g.quadraticCurveTo(fx - 4 * k, base - h * 0.6, fx + (S.wind > T ? 4 * k : 0), base - h); g.quadraticCurveTo(fx + 4 * k, base - h * 0.6, fx + 7 * k, base); g.closePath(); g.fill();
      }
      g.shadowBlur = 0;
      for (let n = 0; n < 3; n++) {
        const u = (T * 0.5 + n / 3) % 1;
        g.fillStyle = 'rgba(50,40,44,' + (0.5 * (1 - u)).toFixed(2) + ')';
        g.beginPath(); g.arc(x + u * 40 * k, y - 50 * k - u * 60 * k, (8 + u * 14) * k, 0, Math.PI * 2); g.fill();
      }
    }
    g.restore();
  }
  function stoneLantern(x) {
    const k = BASE / 1.5;
    g.fillStyle = '#6d6a72';
    g.fillRect(x - 12 * k, FLOOR - 8 * k, 24 * k, 8 * k); g.fillRect(x - 4 * k, FLOOR - 40 * k, 8 * k, 32 * k);
    g.fillRect(x - 13 * k, FLOOR - 46 * k, 26 * k, 6 * k); g.fillRect(x - 9 * k, FLOOR - 63 * k, 18 * k, 17 * k);
    g.beginPath(); g.moveTo(x - 19 * k, FLOOR - 63 * k); g.lineTo(x, FLOOR - 77 * k); g.lineTo(x + 19 * k, FLOOR - 63 * k); g.closePath(); g.fill();
    g.save(); g.shadowColor = 'rgba(255,190,90,0.9)'; g.shadowBlur = 10; g.fillStyle = '#ffcf73'; g.fillRect(x - 5 * k, FLOOR - 59 * k, 10 * k, 9 * k); g.restore();
  }
  function drawFish(x, y, dir, c, k) {
    g.save(); g.translate(x, y); g.scale(dir * k, k);
    g.fillStyle = c; g.beginPath(); g.ellipse(0, 0, 13, 7, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(-10, 0); g.lineTo(-21, -7 + Math.sin(T * 10 + x) * 1.5); g.lineTo(-21, 7 + Math.sin(T * 10 + x) * 1.5); g.closePath(); g.fill();
    g.fillStyle = '#0b2540'; g.beginPath(); g.arc(6, -2, 1.6, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  function drawSnowman(x, k, hat) {
    const r1 = 17 * k, r2 = 12 * k, r3 = 9 * k;
    g.fillStyle = '#f4f7ff'; g.strokeStyle = '#9aa6c0'; g.lineWidth = 1.5;
    if (r1 > 1) { g.beginPath(); g.arc(x, FLOOR - r1, r1, 0, Math.PI * 2); g.fill(); g.stroke(); }
    if (k > 0.45) { g.beginPath(); g.arc(x, FLOOR - 2 * r1 - r2 + 4, r2, 0, Math.PI * 2); g.fill(); g.stroke(); }
    if (k > 0.75) {
      const hy = FLOOR - 2 * r1 - 2 * r2 - r3 + 7;
      g.beginPath(); g.arc(x, hy, r3, 0, Math.PI * 2); g.fill(); g.stroke();
      if (k >= 1) {
        g.fillStyle = INK; g.beginPath(); g.arc(x - 3, hy - 2, 1.4, 0, Math.PI * 2); g.arc(x + 3, hy - 2, 1.4, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ff8c1a'; g.beginPath(); g.moveTo(x, hy + 1); g.lineTo(x + 9, hy + 2.5); g.lineTo(x, hy + 4); g.fill();
        if (hat) { g.fillStyle = '#e63946'; g.fillRect(x - 8, hy - r3 - 2, 16, 4); g.fillRect(x - 5, hy - r3 - 9, 10, 8); }
      }
    }
  }

  // ---------- 骷髏出來散步：走到操場上或爬上卡片，東張西望再回去 ----------
  function skullPatrol() {
    if (S.hunting || S.patrol || S.raid) return false;
    const s = pick(skulls().filter(x => x.home && !x.minion && !x.dead && x.act.type === 'skullHome'));
    if (!s) return false;
    const plats = [...surfaces.values()].filter(p => !p.floor && p.id !== 'tower' && p.x2 - p.x1 > 90 && p.x1 < kidMaxX());
    s.home = false; S.patrol = { s, t: T };
    if (plats.length && Math.random() < 0.5) {
      const p = pick(plats);
      travel(s, p.id, rand(p.x1 + 20, p.x2 - 20), 'patrolEnd');
      narrate('💀 骷髏貼著牆爬上去了…站在上面的人小心！', true);
    } else {
      travel(s, 'floor', roomyX(s, 220, kidMaxX() - 40), 'patrolEnd');     // 走到沒有人在玩的地方
      narrate('💀 骷髏跑出來散步了…大家小心', true);
    }
    if (s.goal) s.goal.walk = true;
    return true;
  }
  function endPatrol(s) {
    if (!S.patrol || S.patrol.s !== s) return;
    S.patrol = null;
    if (s.gone) return;
    s.home = true;
    travel(s, 'floor', rand(pit.x1 + 30, pit.x2 - 30), 'home');
    if (s.goal) s.goal.walk = true;
  }
  // 散步的骷髏旁邊的人會躲開（在卡片上的就跳下去）
  function patrolScare() {
    const P_ = S.patrol;
    if (!P_) return;
    if (P_.s.gone || S.hunting) { if (!P_.s.gone) endPatrol(P_.s); else S.patrol = null; return; }
    if (T - P_.t > 40) { endPatrol(P_.s); return; }
    const s = P_.s;
    let shouted = false;
    for (const k of kids()) {
      if (k.air || k.fear || k.surf !== s.surf || Math.abs(k.x - s.x) > (k.group ? 60 : 130) || ['grabbed', 'sink', 'thrown', 'tele'].includes(k.act.type)) continue;
      if (!shouted) shouted = say(k, pick(['骷髏！', '快閃開！', '它過來了！']), 1.2, 1);
      k.goal = null;
      if (k.surf === 'floor') { const d = Math.sign(k.x - s.x) || 1; setAct(k, 'flee', { tx: clamp(k.x + d * rand(160, 260), 20, kidMaxX()) }); }
      else travel(k, 'floor', clamp(k.x + (Math.sign(k.x - s.x) || 1) * 120, 20, kidMaxX()));
    }
  }

  // ---------- 新的活動：籃球、積木樓梯、雪仗、溜冰、堆雪人、射飛鏢、分身術 ----------
  const poseShoot = () => P({ ra1: 2.7, ra2: 2.9, la1: 2.5, la2: 2.9, hipH: 23 });
  const poseMake = () => P({ lean: 0.9, ra1: 1.0, ra2: 0.6, la1: 0.9, la2: 0.5, rl1: 1.3, rl2: -0.6, ll1: 1.1, ll2: -0.8, hipH: 12 });
  const poseSkate = (t, side) => P({ lean: 0.45, ra1: -0.7 + 0.3 * side, ra2: -0.5, la1: 0.8 - 0.3 * side, la2: 1.1, rl1: side > 0 ? 0.25 : -1.1, rl2: side > 0 ? 0 : -0.9, ll1: side > 0 ? -1.1 : 0.25, ll2: side > 0 ? -0.9 : 0, hipH: 19 });
  const poseSign = () => P({ ra1: 1.3, ra2: 3.3, la1: 1.2, la2: 3.3 });          // 忍者結印
  // 拋物線：u 從 0 到 1，從 p0 飛到 p1，最高多 h
  const arc = (p0, p1, u, h) => [p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u - Math.sin(u * Math.PI) * h];

  Object.assign(ACTS, {
    hoop: { name: '投籃', n: [2, 3], w: 3,
      setup(G) {
        G.hx = clamp(G.x + 80, 260, kidMaxX() - 10); G.up = 0; G.turn = 0; G.score = new Map();
        G.members.forEach((m, i) => go(m, G.hx - 90 - i * 30));
        phase(G, 'gather');
      },
      step(G, dt) {
        const ms = G.members, k = G.t - G.t0, n = ms.length;
        const rim = [G.hx - 16, FLOOR - 118 * BASE / 1.5];
        if (G.phase !== 'end') G.up = Math.min(1, G.up + dt * 1.6); else G.up = Math.max(0, G.up - dt * 1.4);
        if (G.phase === 'gather') {
          if (k < 0.1 && !G.f.n) { G.f.n = true; dust(G.hx, FLOOR, 12); }
          if (!ready(G)) return;
          ms.forEach(m => pose(m, P({}), 1));
          narrate('🏀 地上突然冒出一個籃球架！' + tagsOf(ms) + '在比投籃');
          phase(G, 'shoot'); return;
        }
        if (G.phase === 'shoot') {
          const m = ms[G.turn % n];
          if (!G.f.s) {
            G.f.s = true; G.make = Math.random() < 0.5; G.p0 = null;
            ms.forEach(o => pose(o, o === m ? poseShoot() : P({ tilt: -0.2 }), 1));
          }
          if (!G.p0 && m.j) G.p0 = [m.j.head[0], m.j.head[1] - 14];
          if (!G.p0) return;
          const u = Math.min(1, k / 1.0);
          if (u < 1) [G.bx, G.by] = arc(G.p0, [rim[0] + (G.make ? 0 : 9), rim[1] - 6], u, 70);
          else if (G.make) { G.by = Math.min(FLOOR - 6, G.by + 260 * dt); G.bx = rim[0]; }
          else { if (!G.f.bv) { G.f.bv = { vx: -rand(80, 150), vy: -180 }; } G.f.bv.vy += 900 * dt; G.bx += G.f.bv.vx * dt; G.by = Math.min(FLOOR - 6, G.by + G.f.bv.vy * dt); }
          if (u >= 1 && !G.f.r) {
            G.f.r = true;
            if (G.make) { G.score.set(m, (G.score.get(m) || 0) + 1); m.tag = String(G.score.get(m)); line(G, m, pick(['進了！', '空心球！', '耶！三分！']), 1.3); pose(m, poseCheer); }
            else line(G, m, pick(['打框了…', '差一點點！', '啊～歪掉了']), 1.3);
          }
          if (k > 2.3) { G.turn++; phase(G, G.turn >= n * 3 ? 'end' : 'shoot'); }
          return;
        }
        if (G.phase === 'end') {
          if (!G.f.e) {
            G.f.e = true; G.bx = null;
            const best = ms.slice().sort((p, q) => (G.score.get(q) || 0) - (G.score.get(p) || 0))[0];
            narrate('🏀 投籃比賽：' + numOf(best) + ' 號投進最多，' + (G.score.get(best) || 0) + ' 球！');
            ms.forEach(m => { m.tag = null; pose(m, m === best ? poseCheer : P({})); });
          }
          if (k > 1.6) endGroup(G);
        }
      },
      draw(G) {
        if (G.up <= 0) return;
        const k = G.up, rimY = FLOOR - 118 * BASE / 1.5, hx = G.hx;
        const lift = (1 - k) * (FLOOR - rimY + 40);
        g.save(); g.beginPath(); g.rect(hx - 60, 0, 80, FLOOR); g.clip();
        g.translate(0, lift);
        g.fillStyle = '#7d7f8f'; g.fillRect(hx + 2, rimY - 34, 5, FLOOR - rimY + 34);
        g.fillStyle = '#f4f4f8'; g.strokeStyle = INK; g.lineWidth = 1.5; g.fillRect(hx - 4, rimY - 40, 8, 46); g.strokeRect(hx - 4, rimY - 40, 8, 46);
        g.strokeStyle = '#ff6b1a'; g.lineWidth = 3; g.beginPath(); g.moveTo(hx - 30, rimY); g.lineTo(hx - 4, rimY); g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1;
        for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(hx - 30 + i * 8, rimY); g.lineTo(hx - 25 + i * 6, rimY + 16); g.stroke(); }
        g.restore();
        if (G.bx != null) { g.fillStyle = '#ff7b1a'; g.strokeStyle = INK; g.lineWidth = 1.5; g.beginPath(); g.arc(G.bx, G.by, 6, 0, Math.PI * 2); g.fill(); g.stroke(); }
      } },

    pyramid: { name: '積木樓梯', n: [3, 4], w: 3, scenes: ['playground'],
      setup(G) {
        G.B = 24 * BASE / 1.5; G.cx = clamp(G.x, 200 + 3 * G.B, kidMaxX() - 3 * G.B); G.x = G.cx;
        G.placed = 0; G.colors = []; G.st = new Map();
        G.members.forEach(m => { G.st.set(m, 'toPile'); go(m, pile.x + 30 + rand(-8, 8), 120); });
        narrate('🧱 ' + tagsOf(G.members) + '要用積木疊樓梯');
        phase(G, 'build');
      },
      // 第 i 塊積木的位置：最下面 5 塊、往上 4、3、2、1（每層往內縮半塊）
      spot(G, i) { let r = 0, c = i; while (c >= 5 - r) { c -= 5 - r; r++; } return [G.cx - (5 - r) * G.B / 2 + c * G.B, FLOOR - (r + 1) * G.B]; },
      height(G, x) { let h = 0; for (let r = 0; r < 5; r++) if (Math.abs(x - G.cx) <= (5 - r) * G.B / 2 - 3) h = r + 1; return FLOOR - h * G.B; },
      step(G) {
        const ms = G.members, k = G.t - G.t0, foot = G.cx - 2.5 * G.B - 16, foot2 = G.cx + 2.5 * G.B + 16;
        if (G.phase === 'build') {
          const carrying = ms.filter(m => m.carry).length;
          for (const m of ms) {
            const st = G.st.get(m);
            if (Math.abs(m.act.tx - m.x) >= 3) continue;
            if (st === 'toPile') {
              if (G.placed + ms.filter(o => o.carry).length * 2 >= 15) { G.st.set(m, 'wait'); go(m, foot - 20 - ms.indexOf(m) * 16, 60); continue; }
              m.carry = pick(['#e63946', '#f6c344', '#4cc9f0', '#46d22e', '#9b5de5', '#f4a261']);
              G.st.set(m, 'carry'); go(m, foot + rand(-14, 6), 100);
            } else if (st === 'carry') {
              // 一次抱兩塊
              for (let n2 = 0; n2 < 2 && G.placed < 15; n2++) { G.colors[G.placed] = n2 ? pick(['#e63946', '#f6c344', '#4cc9f0', '#46d22e']) : m.carry; const [bx, by] = this.spot(G, G.placed); sparkle(bx + G.B / 2, by + G.B / 2); G.placed++; }
              m.carry = null; m.act.face = 1; G.st.set(m, 'toPile'); go(m, pile.x + 30 + rand(-8, 8), 120);
            }
          }
          if (G.placed >= 15 && !carrying) {
            ms.forEach((m, i) => { G.st.set(m, 0); go(m, foot - i * 18, 70); });
            phase(G, 'count');
          }
          return;
        }
        if (G.phase === 'count') {
          if (!ready(G)) return;
          if (!G.f.c) { G.f.c = true; ms.forEach(m => pose(m, P({}), 1)); line(G, ms[0], '5、4、3、2、1！蓋好了！', 2); narrate('🧱 ' + tagsOf(ms) + '用積木疊出 5、4、3、2、1 的樓梯！'); }
          if (k > 2.2) phase(G, 'climb');
          return;
        }
        if (G.phase === 'climb') {
          let done = 0;
          ms.forEach((m, i) => {
            const st = G.st.get(m);
            if (st === 0 && k > i * 1.6) { G.st.set(m, 1); m.act.yf = x => this.height(G, x); go(m, foot, 70); }
            else if (st === 1 && Math.abs(m.x - foot) < 3) { G.st.set(m, 2); go(m, G.cx, 32); }
            else if (st === 2 && Math.abs(m.x - G.cx) < 3) {
              G.st.set(m, 3); m.topAt = G.t;
              if (Math.random() < 0.6) { line(G, m, pick(['看我的紙飛機！', '飛啊～', '我最高！']), 1.5); parts.push({ kind: 'plane', x: m.x + 8, y: m.y - 50, vx: rand(110, 160), vy: -20, life: 3, max: 3 }); pose(m, poseThrow(), 1); }
              else { line(G, m, pick(['我最高！', '好高喔～', '大家看我！']), 1.4); pose(m, poseCheer); }
            } else if (st === 3 && G.t - m.topAt > 1.6) { G.st.set(m, 4); pose(m, P({})); go(m, foot2 + i * 16, 32); }
            else if (st === 4 && Math.abs(m.x - m.act.tx) < 3) { G.st.set(m, 5); m.act.yf = null; m.y = FLOOR; }
            if (G.st.get(m) === 5) done++;
          });
          if (done === ms.length) phase(G, 'knock');
          return;
        }
        if (G.phase === 'knock') {
          const m = ms[ms.length - 1];
          if (!G.f.k) { G.f.k = true; go(m, foot2 - 6, 60); }
          if (Math.abs(m.x - m.act.tx) < 3 && !G.f.b) {
            G.f.b = true; pose(m, P({ lean: 0.25, ra1: 1.57, ra2: 1.57, la1: 0.9, la2: 2.3, rl1: 0.5, ll1: -0.4, hipH: 20 }), -1);
            for (let i = 0; i < G.placed; i++) { const [bx, by] = this.spot(G, i); parts.push({ kind: 'block', color: G.colors[i] || '#f6c344', x: bx + G.B / 2, y: by + G.B / 2, vx: rand(-320, -60), vy: rand(-420, -120), rot: 0, vr: rand(-8, 8), life: 2.2, max: 2.2 }); }
            G.placed = 0; line(G, m, '倒囉～', 1.2);
          }
          if (G.f.b && k > 2.4) endGroup(G);
        }
      },
      under(G) {
        for (let i = 0; i < G.placed; i++) {
          const [x, y] = this.spot(G, i);
          g.fillStyle = G.colors[i] || '#f6c344'; g.strokeStyle = INK; g.lineWidth = 2;
          roundRect(x + 1, y + 1, G.B - 2, G.B - 2, 4); g.fill(); g.stroke();
        }
      } },

    snowball: { name: '打雪仗', n: [2, 4], w: 6, scenes: ['snow', 'icefire'],
      setup(G) {
        const ms = G.members;
        G.A = ms.filter((_, i) => i % 2 === 0); G.Bt = ms.filter((_, i) => i % 2 === 1);
        G.A.forEach((m, i) => go(m, G.x - 80 - i * 30)); G.Bt.forEach((m, i) => go(m, G.x + 80 + i * 30));
        G.balls = []; G.hits = [0, 0]; G.st = new Map();
        phase(G, 'gather');
      },
      step(G, dt) {
        const ms = G.members, k = G.t - G.t0;
        const team = m => G.A.includes(m) ? 0 : 1, foes = m => team(m) ? G.A : G.Bt;
        for (const b of G.balls) {
          b.u = Math.min(1, b.u + dt / b.dur);
          [b.x, b.y] = arc(b.p0, b.p1(), b.u, b.big ? 60 : 45);
          if (b.u >= 1 && !b.done) {
            b.done = true;
            for (let i = 0; i < (b.big ? 22 : 8); i++) parts.push({ kind: 'snow', x: b.x, y: b.y, vx: rand(-120, 120), vy: rand(-200, -40), life: 0.7, max: 0.7 });
            for (const t of b.targets) if (b.hit) { G.st.get(t).ouch = T; }
            if (b.hit && b.targets.length === 1 && Math.random() < 0.35) line(G, b.targets[0], pick(['好冰！', '中了啦～', '哇！冷冷冷！']), 1.2);
          }
        }
        G.balls = G.balls.filter(b => !b.done);
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          ms.forEach(m => { pose(m, P({}), team(m) ? -1 : 1); G.st.set(m, { cd: rand(0.5, 1.8), ouch: -9 }); });
          line(G, pick(ms), '打雪仗囉！', 1.4);
          narrate('❄️ ' + tagsOf(G.A) + ' 對上 ' + tagsOf(G.Bt) + '，打雪仗！');
          phase(G, 'fight'); return;
        }
        if (G.phase === 'fight') {
          for (const m of ms) {
            const st = G.st.get(m);
            st.cd -= dt;
            if (T - st.ouch < 0.6) { pose(m, poseStumble); continue; }
            if (st.cd > 0.6) pose(m, poseMake());
            else if (st.cd > 0) pose(m, P({ ra1: 2.6, ra2: 3.0, la1: 0.6 }));
            else {
              const tgt = pick(foes(m)), hit = Math.random() < 0.55, p0 = hand(m).slice();
              const miss = rand(25, 45) * (team(m) ? -1 : 1);
              G.balls.push({ p0, p1: () => hit ? [tgt.x, tgt.y - 50 * tgt.s / 1.5] : [tgt.x + miss, FLOOR - 4], u: 0, dur: 0.75, hit, targets: [tgt] });
              if (hit) G.hits[team(m)]++;
              pose(m, poseThrow()); st.cd = rand(1.4, 2.4);
            }
          }
          if (k > 13) phase(G, 'finale');
          return;
        }
        if (G.phase === 'finale') {
          const win = G.hits[0] >= G.hits[1] ? 0 : 1, thrower = (win ? G.Bt : G.A)[0], losers = win ? G.A : G.Bt;
          if (!G.f.s) {
            G.f.s = true; ms.forEach(m => pose(m, P({})));
            pose(thrower, poseShoot()); line(G, thrower, '大雪球來了！', 1.6);
          }
          if (k > 1.2 && !G.f.t) {
            G.f.t = true;
            const cx = losers.reduce((x, m) => x + m.x, 0) / losers.length;
            G.balls.push({ p0: [thrower.x, thrower.y - 70], p1: () => [cx, FLOOR - 40], u: 0, dur: 1.0, hit: true, big: true, targets: losers });
            pose(thrower, poseThrow());
          }
          if (G.f.t) for (const m of losers) if (T - G.st.get(m).ouch < 1) pose(m, poseStumble);
          if (k > 2.4 && !G.f.n) {
            G.f.n = true;
            narrate('❄️ 雪仗結束！' + tagsOf(G.A) + '打中 ' + G.hits[0] + ' 次，' + tagsOf(G.Bt) + '打中 ' + G.hits[1] + ' 次');
            losers.forEach(m => pose(m, P({ lean: -0.1, ra1: 2.5, ra2: 3.2, la1: -2.5, la2: -3.2 })));
            line(G, losers[0], pick(['全身都是雪啦！', '好冰喔～～', '下次換我們！']), 1.6);
          }
          if (k > 4) endGroup(G);
        }
      },
      draw(G) {
        g.fillStyle = '#ffffff'; g.strokeStyle = '#9aa6c0'; g.lineWidth = 1;
        for (const b of G.balls) { g.beginPath(); g.arc(b.x, b.y, b.big ? 13 : 4.5, 0, Math.PI * 2); g.fill(); g.stroke(); }
      } },

    skate: { name: '溜冰', n: [2, 3], w: 4, scenes: ['snow', 'icefire'],
      setup(G) { G.members.forEach((m, i) => go(m, G.x + (i - 1) * 40)); G.st = new Map(); phase(G, 'gather'); },
      step(G, dt) {
        const ms = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          narrate('⛸️ ' + tagsOf(ms) + '在冰上溜冰');
          ms.forEach((m, i) => { halt(m); G.st.set(m, { ph: i * 2.1, fall: -9 }); });
          G.fallAt = rand(3, 7); G.spinAt = rand(6, 10);
          phase(G, 'skate'); return;
        }
        for (const [i, m] of ms.entries()) {
          const st = G.st.get(m);
          if (T - st.fall < 1.5) { m.rot = -m.f * 1.2; pose(m, P({ ra1: 2.2, la1: -2.2, rl1: 1.4, ll1: 1.2, hipH: 6 })); continue; }
          m.rot = 0;
          st.ph += dt * 1.3;
          const nx = G.x + Math.sin(st.ph) * 65 + (i - 1) * 20;
          const v = nx - m.x; m.x = nx;
          if (Math.abs(v) > 0.05) m.act.face = Math.sign(v);
          if (st.spin && T - st.spin < 1.2) { m.act.face = Math.sin(T * 25) > 0 ? 1 : -1; pose(m, P({ ra1: 1.57, ra2: 1.57, la1: -1.57, la2: -1.57 })); }
          else pose(m, poseSkate(T, Math.sin(st.ph * 2)));
        }
        if (k > G.fallAt && !G.f.fall) {
          G.f.fall = true; const m = pick(ms); G.st.get(m).fall = T;
          line(G, m, pick(['哎呀！滑倒了！', '我的屁股～', '冰好滑喔！']), 1.4);
          narrate('⛸️ ' + numOf(m) + ' 號溜冰滑倒了，一屁股坐在冰上～');
        }
        if (k > G.spinAt && !G.f.spin) { G.f.spin = true; const m = pick(ms); G.st.get(m).spin = T; line(G, m, '看我轉圈圈！', 1.3); }
        if (k > 15) endGroup(G);
      },
      under(G) {
        if (G.phase === 'gather') return;
        g.fillStyle = 'rgba(160,215,255,0.45)'; g.strokeStyle = 'rgba(220,240,255,0.8)'; g.lineWidth = 1.5;
        g.beginPath(); g.ellipse(G.x, FLOOR + 1, 120, 9, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      } },

    snowman: { name: '堆雪人', n: [2, 2], w: 3, scenes: ['snow'],
      setup(G) { const [A, B] = G.members; go(A, G.x - 26); go(B, G.x + 26); G.k = 0; phase(G, 'gather'); },
      step(G, dt) {
        const [A, B] = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') { if (!ready(G)) return; pose(A, poseMake(), 1); pose(B, poseMake(), -1); line(G, A, '我們來堆雪人！', 1.6); phase(G, 'build'); return; }
        if (G.phase === 'build') {
          G.k = Math.min(1, k / 8);
          const push = Math.sin(T * 6) > 0;
          pose(A, push ? poseMake() : P({ lean: 0.5, ra1: 1.4, ra2: 1.2, la1: 1.3, la2: 1.1, hipH: 17 }));
          pose(B, push ? P({ lean: 0.5, ra1: 1.4, ra2: 1.2, la1: 1.3, la2: 1.1, hipH: 17 }) : poseMake());
          if (G.k >= 1) {
            if (S.snowmen.length >= 3) S.snowmen.shift();
            S.snowmen.push({ x: G.x, hat: Math.random() < 0.5 });
            pose(A, poseCheer); pose(B, poseCheer); line(G, B, pick(['雪人完成了！', '幫它戴帽子～', '好可愛！']), 1.6);
            narrate('⛄ ' + tagsOf([A, B]) + '堆了一個雪人！');
            phase(G, 'done');
          }
          return;
        }
        if (k > 2.4) endGroup(G);
      },
      under(G) { if (G.phase === 'build') drawSnowman(G.x, G.k, false); } },

    shuriken: { name: '射飛鏢', n: [2, 3], w: 5, scenes: ['ninja'],
      setup(G) {
        G.tx = clamp(G.x + 95, 300, kidMaxX() - 10); G.stuck = []; G.turn = 0; G.score = new Map();
        G.members.forEach((m, i) => go(m, G.tx - 150 - i * 26));
        phase(G, 'gather');
      },
      step(G) {
        const ms = G.members, k = G.t - G.t0, n = ms.length, cy = FLOOR - 62;
        if (G.phase === 'gather') { if (!ready(G)) return; ms.forEach(m => pose(m, P({}), 1)); narrate('🥷 ' + tagsOf(ms) + '在練習射飛鏢'); phase(G, 'throw'); return; }
        if (G.phase === 'throw') {
          const m = ms[G.turn % n];
          if (!G.f.s) { G.f.s = true; G.err = [rand(-13, 13), rand(-13, 13)]; pose(m, poseSign()); G.p0 = null; }
          if (k > 0.4 && !G.p0) { G.p0 = hand(m).slice(); pose(m, P({ lean: 0.2, ra1: 1.6, ra2: 1.6, la1: -0.6 })); }
          if (G.p0) {
            const u = Math.min(1, (k - 0.4) / 0.4);
            [G.sx, G.sy] = arc(G.p0, [G.tx + G.err[0] * 0.3, cy + G.err[1]], u, 12);
            if (u >= 1 && !G.f.h) {
              G.f.h = true; G.stuck.push([G.err[0] * 0.3, G.err[1]]); G.sx = null;
              const d = Math.hypot(G.err[0] * 0.3, G.err[1]);
              if (d < 5) { G.score.set(m, (G.score.get(m) || 0) + 1); line(G, m, '正中紅心！', 1.3); pose(m, poseCheer); }
              else if (Math.random() < 0.4) line(G, m, pick(['差一點！', '再一次！', '喝！']), 1.1);
            }
          }
          if (k > 1.8) { G.turn++; pose(m, P({})); phase(G, G.turn >= n * 3 ? 'end' : 'throw'); }
          return;
        }
        if (!G.f.e) {
          G.f.e = true;
          const best = ms.slice().sort((p, q) => (G.score.get(q) || 0) - (G.score.get(p) || 0))[0];
          narrate((G.score.get(best) ? '🥷 ' + numOf(best) + ' 號射中紅心 ' + G.score.get(best) + ' 次！' : '🥷 射飛鏢練習結束，大家都沒射中紅心～'));
        }
        if (k > 1.5) endGroup(G);
      },
      under(G) {
        const x = G.tx, cy = FLOOR - 62;
        g.fillStyle = '#8a5a2b'; g.fillRect(x - 3, cy, 6, FLOOR - cy);
        [[20, '#f4ead5'], [14, '#c0392b'], [9, '#f4ead5'], [4.5, '#c0392b']].forEach(([r, c]) => { g.fillStyle = c; g.beginPath(); g.arc(x, cy, r, 0, Math.PI * 2); g.fill(); });
        for (const [dx, dy] of G.stuck) drawStar(x + dx, cy + dy, 0.6);
      },
      draw(G) { if (G.sx != null && G.phase === 'throw') drawStar(G.sx, G.sy, T * 20); } },

    clone: { name: '分身術', n: [1, 1], w: 2, scenes: ['ninja'],
      setup(G) { go(G.members[0], G.x); G.offs = []; phase(G, 'gather'); },
      step(G) {
        const m = G.members[0], k = G.t - G.t0;
        if (G.phase === 'gather') { if (!ready(G)) return; pose(m, poseSign(), 1); line(G, m, '分身術！', 1.4); phase(G, 'sign'); return; }
        if (G.phase === 'sign') {
          if (k > 1 && !G.offs.length) {
            G.offs = [-55, 55]; for (const o of G.offs) smoke(m.x + o, FLOOR);
            narrate('🥷 ' + numOf(m) + ' 號使出分身術，一下子變成三個人！');
            pose(m, posePoint(), 1);
          }
          if (k > 3.6) { for (const o of G.offs) smoke(m.x + o, FLOOR); G.offs = []; phase(G, 'done'); }
          return;
        }
        if (k > 0.8) endGroup(G);
      },
      draw(G) {
        const m = G.members[0];
        for (const o of G.offs) {
          g.save(); g.globalAlpha = 0.45;
          const c = Object.assign({}, m, { x: m.x + o, say: null, tag: null, item: null, f: o < 0 ? -1 : 1 });
          drawAgent(c);
          g.restore();
        }
      } },
  });
  function drawStar(x, y, rot) {
    g.save(); g.translate(x, y); g.rotate(rot); g.fillStyle = '#c9ccd8'; g.strokeStyle = INK; g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < 8; i++) { const r = i % 2 ? 2 : 7, an = i * Math.PI / 4; g.lineTo(Math.cos(an) * r, Math.sin(an) * r); }
    g.closePath(); g.fill(); g.stroke(); g.restore();
  }


  // ---------- 忍者村：練刀、比劍、練長槍、盆舞、扇子舞 ----------
  const poseGuard = () => P({ ra1: 1.0, ra2: 1.9, la1: 0.9, la2: 1.8, rl1: 0.35, ll1: -0.35, hipH: 20 });     // 雙手握刀擺架式
  const poseRaise = () => P({ lean: -0.1, ra1: 2.9, ra2: 3.1, la1: 2.8, la2: 3.0, rl1: 0.3, ll1: -0.3 });   // 刀舉過頭
  const poseCut = () => P({ lean: 0.3, ra1: 1.2, ra2: 1.0, la1: 1.1, la2: 0.9, rl1: 0.7, rl2: 0.2, ll1: -0.5, hipH: 18 });
  const poseBlock = () => P({ ra1: 2.3, ra2: 2.9, la1: 2.2, la2: 2.9, rl1: 0.4, ll1: -0.4, hipH: 20 });
  const poseThrust = () => P({ lean: 0.2, ra1: 1.5, ra2: 1.55, la1: 1.3, la2: 1.5, rl1: 0.75, rl2: 0.1, ll1: -0.55, hipH: 18 });
  const poseBow = () => P({ lean: 0.75, tilt: 0.2, ra1: 0.1, ra2: 0, la1: 0.1, la2: 0 });
  const poseBon = t => { const u = Math.sin(t * 3.2); return P({ ra1: 2.2 + u * 0.6, ra2: 2.6 + u * 0.5, la1: -1.0 + u * 0.4, la2: -0.7, rl1: 0.25 * u, ll1: -0.25 * u, hipH: 21 + Math.abs(u) }); };
  const poseFan = t => { const u = Math.sin(t * 2.4); return P({ lean: 0.1 * u, ra1: 2.0 + u * 0.9, ra2: 2.4 + u * 0.8, la1: 1.2 - u * 0.5, la2: 1.6, rl1: 0.2 * u, ll1: -0.3 * u, hipH: 20 }); };
  const poseDrum = t => { const u = Math.sin(t * 10); return P({ lean: 0.1, ra1: 1.6 + u * 0.6, ra2: 1.3 + u * 0.6, la1: 1.6 - u * 0.6, la2: 1.3 - u * 0.6, rl1: 0.3, ll1: -0.3, hipH: 20 }); };
  const poseSwim = t => { const u = Math.sin(t * 4); return P({ ra1: 2.7 + u * 0.4, ra2: 2.9 + u * 0.5, la1: 2.7 + u * 0.4, la2: 2.9 + u * 0.5, rl1: 0.3 * Math.sin(t * 12), ll1: -0.3 * Math.sin(t * 12), rl2: 0, ll2: 0 }); };
  const poseZap = t => P({ ra1: 2.3 + Math.sin(t * 40) * 0.3, ra2: 2.0, la1: -2.3 - Math.sin(t * 40) * 0.3, la2: -2.0, rl1: 0.5, ll1: -0.5, hipH: 22 });
  // 變身術可以變成的東西
  const MORPHS = ['daruma', 'bird', 'frog', 'tanuki', 'cat', 'log', 'daruma', 'bird'];
  const MORPH_NAME = { daruma: '達摩', bird: '小鳥', frog: '青蛙', tanuki: '狸貓', cat: '小貓', log: '一根木頭', };
  const MORPH_EMOJI = { bird: '🐦', frog: '🐸', tanuki: '🦝', cat: '🐈', log: '🪵' };
  function drawMorph(a) {
    const k = BASE / 1.5, x = a.x, y = a.y - (a.hop || 0), M = a.morph;
    let top;
    g.save();
    g.shadowColor = 'rgba(255,255,255,0.9)'; g.shadowBlur = 5;
    if (M.kind === 'daruma') {
      // 搖來搖去的達摩（底部是支點）
      g.translate(x, y); g.rotate(Math.sin(T * 5 + a.num) * 0.28);
      const w = 21 * k, h = 27 * k;
      g.fillStyle = '#d62f2f'; g.beginPath(); g.ellipse(0, -h, w, h, 0, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#fff6e6'; g.beginPath(); g.ellipse(0, -h * 1.2, w * 0.62, h * 0.48, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = INK;
      for (const sx of [-1, 1]) {
        g.beginPath(); g.arc(sx * w * 0.25, -h * 1.3, 2.6 * k, 0, Math.PI * 2); g.fill();
        g.lineWidth = 2.2 * k; g.strokeStyle = INK; g.beginPath(); g.moveTo(sx * w * 0.1, -h * 1.55); g.quadraticCurveTo(sx * w * 0.3, -h * 1.7, sx * w * 0.48, -h * 1.5); g.stroke();
      }
      g.beginPath(); g.moveTo(-w * 0.3, -h * 0.98); g.quadraticCurveTo(0, -h * 0.85, w * 0.3, -h * 0.98); g.stroke();
      g.fillStyle = '#f6c344'; g.beginPath(); g.ellipse(0, -h * 0.42, w * 0.42, h * 0.16, 0, 0, Math.PI * 2); g.fill();
      g.restore();
      top = y - 2 * 27 * k - 6;
    } else if (M.kind === 'bird') {
      // 自己畫的小鳥（翅膀拍動）
      g.translate(x, y - 12 * k); g.scale(a.f > 0 ? 1 : -1, 1);
      const fl = Math.sin(T * 18);
      g.fillStyle = '#3fa9f5'; g.beginPath(); g.moveTo(-10 * k, 0); g.lineTo(-19 * k, -5 * k); g.lineTo(-18 * k, 4 * k); g.closePath(); g.fill();
      g.beginPath(); g.ellipse(0, 0, 12 * k, 9 * k, 0, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#e8f6ff'; g.beginPath(); g.ellipse(2 * k, 3 * k, 7 * k, 5 * k, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1f7fd0'; g.beginPath(); g.moveTo(-3 * k, -2 * k); g.lineTo(-12 * k, -2 * k - fl * 12 * k); g.lineTo(4 * k, -3 * k); g.closePath(); g.fill();
      g.fillStyle = '#ffb02e'; g.beginPath(); g.moveTo(11 * k, -2 * k); g.lineTo(17 * k, 0); g.lineTo(11 * k, 2 * k); g.closePath(); g.fill();
      g.fillStyle = INK; g.beginPath(); g.arc(6 * k, -3 * k, 1.6 * k, 0, Math.PI * 2); g.fill();
      g.restore();
      top = y - 30 * k;
    } else {
      const size = (M.kind === 'log' ? 40 : 36) * k;
      g.translate(x, y); if (M.kind !== 'log') g.scale(a.f > 0 ? -1 : 1, 1);
      if (M.kind === 'bird') g.rotate(Math.sin(T * 14) * 0.12);
      g.font = size + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText(MORPH_EMOJI[M.kind], 0, 2);
      g.restore();
      top = y - size - 4;
    }
    // 座號跟著
    g.font = '900 12px ' + FONT; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = INK; g.fillStyle = '#ffffff';
    const tag = String(a.num).padStart(2, '0');
    g.strokeText(tag, x, top); g.fillText(tag, x, top); g.textAlign = 'left';
    a.j = { rH: [x + 8, y - 10], lH: [x - 8, y - 10], head: [x, top + 4] };
    a.bubbleAt = a.say && a.say.until > T ? [x, top - 10] : null;
  }
  // 刀光
  function drawSlash(sl) {
    if (!sl) return;
    const u = (T - sl.t) / 0.28;
    if (u < 0 || u > 1) return;
    g.save(); g.translate(sl.x, sl.y); g.scale(sl.f, 1);
    g.strokeStyle = 'rgba(255,255,255,' + (1 - u) + ')'; g.lineWidth = 4 * (1 - u) + 1; g.lineCap = 'round';
    g.beginPath(); g.arc(0, 0, 26 * BASE / 1.5, -1.4, 0.9); g.stroke();
    g.strokeStyle = 'rgba(160,220,255,' + (0.6 * (1 - u)) + ')'; g.lineWidth = 2;
    g.beginPath(); g.arc(0, 0, 21 * BASE / 1.5, -1.2, 0.7); g.stroke();
    g.restore();
  }
  function drawLantern(x, y, sw) {
    g.save(); g.translate(x, y); g.rotate(Math.sin(T * 2 + x) * 0.08 * sw);
    g.shadowColor = 'rgba(255,170,60,0.9)'; g.shadowBlur = 10;
    g.fillStyle = '#e8432f'; g.beginPath(); g.ellipse(0, 9, 7, 9, 0, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0; g.fillStyle = '#1b1b22'; g.fillRect(-4, -1, 8, 2.5); g.fillRect(-4, 16.5, 8, 2.5);
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; for (const dy of [5, 9, 13]) { g.beginPath(); g.moveTo(-6.5, dy); g.lineTo(6.5, dy); g.stroke(); }
    g.restore();
  }
  // 沙裡的寶藏
  const TREASURES = [['🪙', '一整箱金幣！', '我們發財了！'], ['📘', '一本沒寫完的數學習作…', '這…是誰的？'], ['🍱', '大熊老師的便當！', '噓～快放回去！'],
    ['🦪', '一顆超大的珍珠', '好漂亮喔！'], ['🗺️', '一張藏寶圖', '還有下一個寶藏！'], ['🦀', '一隻寄居蟹', '牠在跟我們揮手！'], ['📝', '一張一百分的考卷', '是誰的？好厲害！']];

  Object.assign(ACTS, {
    kata: { name: '練武士刀', n: [1, 1], w: 3, scenes: ['ninja'],
      setup(G) { go(G.members[0], G.x); phase(G, 'gather'); },
      step(G) {
        const m = G.members[0], k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          m.weapon = { kind: 'katana', ang: -0.6 }; pose(m, poseGuard(), pick([1, -1]));
          line(G, m, '拔刀！', 1.2); narrate('⚔️ ' + numOf(m) + ' 號拔出武士刀，一個人在練刀');
          G.n = 0; phase(G, 'swing'); return;
        }
        if (G.phase === 'swing') {
          if (k < 0.35) { pose(m, poseRaise()); m.weapon.ang = -2.1; }
          else if (!G.f.c) {
            G.f.c = true; pose(m, poseCut()); m.weapon.ang = 0.5;
            G.slash = { x: m.x + m.f * 22 * m.s, y: m.y - 32 * m.s, f: m.f, t: T };
            if (Math.random() < 0.4) line(G, m, pick(['喝！', '哈！', '斬！']), 0.8);
          }
          if (k > 0.95) { G.n++; if (G.n % 2 === 0) m.act.face = -(m.act.face || 1); pose(m, poseGuard()); m.weapon.ang = -0.6; phase(G, G.n >= 6 ? 'end' : 'swing'); }
          return;
        }
        if (!G.f.e) { G.f.e = true; m.weapon = null; pose(m, poseBow()); line(G, m, '收刀。', 1.2); }
        if (k > 1.4) endGroup(G);
      },
      draw(G) { drawSlash(G.slash); } },

    duel: { name: '比劍', n: [2, 2], w: 5, scenes: ['ninja'],
      setup(G) { const [A, B] = G.members; go(A, G.x - 38); go(B, G.x + 38); phase(G, 'gather'); },
      step(G) {
        const [A, B] = G.members, k = G.t - G.t0;
        // 躲刀的人往上跳
        if (G.jumper) { const u = (T - G.jt) / 0.6; G.jumper.hop = u < 1 ? Math.sin(u * Math.PI) * 42 : 0; if (u >= 1) G.jumper = null; }
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          for (const m of G.members) m.weapon = { kind: 'katana', ang: -0.6 };
          pose(A, poseGuard(), 1); pose(B, poseGuard(), -1);
          line(G, A, '來比劍吧！', 1.4);
          narrate('⚔️ ' + numOf(A) + ' 號和 ' + numOf(B) + ' 號拔刀比劍！');
          G.round = 0; phase(G, 'face'); return;
        }
        if (G.phase === 'face') { if (k > 0.9) phase(G, 'attack'); return; }
        if (G.phase === 'attack') {
          const att = G.round % 2 ? B : A, def = att === A ? B : A;
          if (!G.f.s) { G.f.s = true; G.dodge = Math.random() < 0.3; pose(att, poseRaise()); att.weapon.ang = -2.1; }
          if (k > 0.32 && !G.f.c) {
            G.f.c = true; pose(att, poseCut()); att.weapon.ang = 0.4;
            const my = FLOOR - 40 * att.s;
            if (G.dodge) { G.jumper = def; G.jt = T; line(G, def, pick(['跳！', '躲過了！', '太慢了！']), 1); }
            else {
              pose(def, poseBlock()); def.weapon.ang = -0.15;
              for (let i = 0; i < 5; i++) sparkle((A.x + B.x) / 2 + rand(-6, 6), my + rand(-10, 6));
              line(G, att, pick(['鏘！', '看招！', '喝！']), 0.8);
            }
            G.slash = { x: att.x + att.f * 22 * att.s, y: my, f: att.f, t: T };
          }
          if (k > 1.15) { for (const m of G.members) { pose(m, poseGuard()); m.weapon.ang = -0.6; } G.round++; phase(G, G.round >= 6 ? 'end' : 'attack'); }
          return;
        }
        if (!G.f.e) {
          G.f.e = true;
          for (const m of G.members) { m.weapon = null; pose(m, poseBow()); m.hop = 0; }
          line(G, A, '承讓！', 1.4);
          narrate('⚔️ ' + numOf(A) + ' 號和 ' + numOf(B) + ' 號打成平手，收刀互相鞠躬');
        }
        if (k > 1.8) endGroup(G);
      },
      draw(G) { drawSlash(G.slash); } },

    spear: { name: '練長槍', n: [2, 3], w: 3, scenes: ['ninja'],
      setup(G) { G.members.forEach((m, i) => go(m, G.x - 50 + i * 50)); phase(G, 'gather'); },
      step(G) {
        const ms = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          G.face = pick([1, -1]);
          ms.forEach(m => { m.weapon = { kind: 'spear', ang: -1.2, push: 0 }; pose(m, poseGuard(), G.face); });
          narrate('🔱 ' + tagsOf(ms) + '拿著長槍排成一排，一起練刺槍');
          G.n = 0; phase(G, 'thrust'); return;
        }
        if (G.phase === 'thrust') {
          if (!G.f.s) { G.f.s = true; ms.forEach(m => { pose(m, P({ lean: -0.05, ra1: 1.2, ra2: 1.6, la1: 0.9, la2: 1.3 })); m.weapon.ang = -0.12; m.weapon.push = -4; }); }
          if (k > 0.45 && !G.f.t) { G.f.t = true; ms.forEach(m => { pose(m, poseThrust()); m.weapon.ang = 0; m.weapon.push = 12; }); line(G, ms[0], ['一！', '二！', '三！', '喝！'][G.n % 4], 0.6); }
          if (k > 0.95) { G.n++; phase(G, G.n >= 8 ? 'end' : 'thrust'); }
          return;
        }
        if (!G.f.e) { G.f.e = true; ms.forEach(m => { m.weapon = { kind: 'spear', ang: -Math.PI / 2 }; pose(m, P({})); }); line(G, ms[0], '收槍！', 1.2); }
        if (k > 1.3) endGroup(G);
      } },

    bon: { name: '盆舞', n: [4, 5], w: 4, scenes: ['ninja'],
      setup(G) {
        G.x = clamp(G.x, 330, kidMaxX() - 130);
        G.dr = G.members[0]; G.dancers = G.members.slice(1);
        go(G.dr, G.x - 16, 70);
        G.dancers.forEach((m, i) => { m.th0 = i * Math.PI * 2 / G.dancers.length; m.kimono = true; go(m, G.x + Math.cos(m.th0) * 100, 70); });
        phase(G, 'gather');
      },
      step(G, dt) {
        const k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          G.dr.weapon = { kind: 'sticks' }; pose(G.dr, poseDrum, 1);
          G.dancers.forEach(m => { m.weapon = { kind: 'fan', ang: -1.2 }; });
          narrate('🏮 ' + tagsOf(G.dancers) + '換上和服跳盆舞，' + numOf(G.dr) + ' 號在打太鼓');
          G.beat = 0; phase(G, 'dance'); return;
        }
        if (G.phase === 'dance') {
          G.dancers.forEach(m => {
            const th = m.th0 + k * 0.55;
            m.act.tx = null; m.x = G.x + Math.cos(th) * 100; m.act.face = -Math.sin(th) >= 0 ? 1 : -1;
            m.act.pose = poseBon; if (m.weapon) m.weapon.ang = -1.2 + Math.sin(T * 3.2) * 0.6;
          });
          if (k > G.beat) { G.beat += 0.6; G.hit = T; if (Math.random() < 0.25) line(G, G.dr, pick(['咚！', '咚咚！', '咚～咚～']), 0.6); }
          if (k > 16) {
            G.dancers.forEach(m => pose(m, poseCheer)); pose(G.dr, poseCheer);
            narrate('🏮 盆舞跳完了，大家一起拍手！'); phase(G, 'end');
          }
          return;
        }
        if (k > 1.6) endGroup(G);
      },
      under(G) {
        const x = G.x, top = FLOOR - 150 * BASE / 1.5;
        // 燈籠串
        g.strokeStyle = 'rgba(30,20,20,0.9)'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(x - 150, top); g.quadraticCurveTo(x, top + 30, x + 150, top); g.stroke();
        for (let i = 0; i <= 6; i++) { const u = i / 6, lx = x - 150 + u * 300, ly = top + 2 * u * (1 - u) * 30; drawLantern(lx, ly, 1); }
        // 太鼓
        const dx = x + 6, hit = G.hit && T - G.hit < 0.12 ? 1.5 : 0;
        g.fillStyle = '#5a3420'; g.fillRect(dx - 2, FLOOR - 30, 4, 30); g.fillRect(dx - 16, FLOOR - 4, 32, 4);
        g.save(); g.translate(dx, FLOOR - 40);
        g.fillStyle = '#8b3a22'; g.strokeStyle = INK; g.lineWidth = 1.5;
        g.beginPath(); g.ellipse(0, 0, 18 + hit, 15 + hit, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = '#f1e3c4'; g.beginPath(); g.ellipse(-4, 0, 6, 13 + hit, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.restore();
      } },

    fan: { name: '扇子舞', n: [1, 2], w: 2, scenes: ['ninja'],
      setup(G) { G.members.forEach((m, i) => { m.kimono = true; go(m, G.x - 30 + i * 60); }); phase(G, 'gather'); },
      step(G) {
        const ms = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          ms.forEach((m, i) => { m.weapon = { kind: 'fan', ang: -1 }; pose(m, poseFan, i ? -1 : 1); });
          narrate('🪭 ' + tagsOf(ms) + '穿著和服，拿扇子跳日本舞');
          phase(G, 'dance'); return;
        }
        if (G.phase === 'dance') {
          ms.forEach((m, i) => { m.weapon.ang = -1 + Math.sin(T * 2.4 + i) * 0.9; if (Math.floor(k / 2.6) % 2 !== (m.flip || 0)) { m.flip = Math.floor(k / 2.6) % 2; m.act.face = -(m.act.face || 1); } });
          if (k > 10) { ms.forEach(m => { pose(m, poseBow()); m.weapon = null; }); phase(G, 'end'); }
          return;
        }
        if (k > 1.4) endGroup(G);
      } },

    henge: { name: '變身術', n: [1, 3], w: 6, scenes: ['ninja'],
      setup(G) { G.members.forEach((m, i) => go(m, G.x - 50 + i * 50)); phase(G, 'gather'); },
      step(G, dt) {
        const ms = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') { if (!ready(G)) return; ms.forEach(m => pose(m, poseSign(), m.f)); line(G, ms[0], ms.length > 1 ? '大家一起，變身術！' : '變身術！', 1.2); phase(G, 'sign'); return; }
        if (G.phase === 'sign') {
          if (k < 0.9) return;
          const pool = MORPHS.slice().sort(() => Math.random() - 0.5);
          ms.forEach((m, i) => { m.morph = { kind: pool[i % pool.length], dir: m.f || 1, x0: m.x }; smoke(m.x, FLOOR); });
          narrate('🥷 ' + ms.map(m => numOf(m) + ' 號變成' + MORPH_NAME[m.morph.kind]).join('，') + '！');
          phase(G, 'morph'); return;
        }
        if (G.phase === 'morph') {
          for (const m of ms) {
            const M = m.morph; if (!M) continue;
            m.act.tx = null;
            const lo = Math.max(30, M.x0 - 140), hi = Math.min(kidMaxX() - 20, M.x0 + 140);
            if (M.kind === 'bird') { m.hop = Math.min(1, k) * (70 + Math.sin(T * 3 + m.num) * 14); m.x += M.dir * 70 * dt; }
            else if (M.kind === 'frog') { const u = (k * 1.6) % 1; m.hop = Math.sin(u * Math.PI) * 34; if (u < 0.75) m.x += M.dir * 75 * dt; }
            else if (M.kind === 'tanuki' || M.kind === 'cat') { m.hop = 0; m.x += M.dir * 35 * dt; }
            else m.hop = 0;
            if (m.x < lo || m.x > hi) { m.x = clamp(m.x, lo, hi); M.dir = -M.dir; }
            m.f = m.act.face = M.dir;
          }
          if (!G.f.say && k > 2.5) {
            G.f.say = true; const m = pick(ms), t = { bird: '啾啾～', frog: '呱！呱！', daruma: '不倒翁～倒不了！', tanuki: '我是狸貓～', cat: '喵～', log: '……（我是一根木頭）' }[m.morph.kind];
            line(G, m, t, 1.6);
          }
          if (k > 7) { ms.forEach(m => { smoke(m.x, FLOOR); m.morph = null; m.hop = 0; pose(m, poseCheer, m.f); }); line(G, ms[0], '解除！', 1.2); phase(G, 'end'); }
          return;
        }
        if (k > 1.5) endGroup(G);
      } },

    // ---------- 冰與火：冰火對決、烤棉花糖 ----------
    // 借東風：孔明在七星壇上搖羽扇，東南風吹起來，接著就火燒連環船
    eastwind: { name: '借東風', n: [1, 1], w: 5, scenes: ['sanguo'],
      setup(G) { const m = G.members[0]; m.hero = '孔明'; go(m, G.x); phase(G, 'gather'); },
      step(G) {
        const m = G.members[0], k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          m.weapon = { kind: 'feather', ang: -1.3 }; pose(m, poseRaise(), 1);
          line(G, m, '東風啊，快來吧！', 1.8);
          narrate('🪶 孔明（' + numOf(m) + ' 號）登上七星壇，搖著羽扇借東風…');
          phase(G, 'pray'); return;
        }
        if (G.phase === 'pray') {
          m.weapon.ang = -1.3 + Math.sin(T * 5) * 0.6;
          if (k > 3) {
            S.wind = T + 14;
            narrate('🌬️ 東南風呼呼地吹起來了！孔明借到東風了！', true);
            for (const kd of kids()) if (kd !== m && Math.random() < 0.3 && STANDING.includes(kd.act.type)) say(kd, pick(['好大的風！', '我的帽子！', '風往曹營那邊吹了！']), 1.4);
            phase(G, 'wind');
          }
          return;
        }
        if (G.phase === 'wind') {
          pose(m, poseCheer(T)); m.weapon.ang = -2;
          if (k > 1.2 && !G.f.l) { G.f.l = true; line(G, m, '萬事俱備，東風也來了！', 2); }
          if (k > 5) { m.weapon = null; endGroup(G); if (!groups.some(x => x.kind === 'chainfire' && !x.over)) startActivity('chainfire'); }
        }
      },
      draw(G) {
        // 七星壇：三層土台＋四面旗子（有東風時旗子往右飄）
        const k = BASE / 1.5, x = G.x, wind = S.wind > T;
        g.save();
        g.fillStyle = '#7a5a3a'; g.fillRect(x - 34 * k, FLOOR - 6 * k, 68 * k, 6 * k);
        g.fillStyle = '#8a6a48'; g.fillRect(x - 26 * k, FLOOR - 4 * k, 52 * k, 4 * k);
        for (const [dx, c] of [[-46, '#2b4fa8'], [-30, '#15151b'], [30, '#c0392b'], [46, '#f6c344']]) {
          const px = x + dx * k, top = FLOOR - 62 * k, fl = wind ? 1 : 0.25, wv = Math.sin(T * (wind ? 14 : 3) + dx) * 2 * k;
          g.strokeStyle = '#5a3a22'; g.lineWidth = 2; g.beginPath(); g.moveTo(px, FLOOR); g.lineTo(px, top); g.stroke();
          g.fillStyle = c; g.beginPath(); g.moveTo(px, top); g.lineTo(px + 16 * k * fl + 2, top + (1 - fl) * 14 * k + wv); g.lineTo(px + 16 * k * fl + 2, top + 10 * k + (1 - fl) * 14 * k + wv); g.lineTo(px, top + 10 * k); g.closePath(); g.fill();
        }
        g.restore();
      } },

    // 苦肉計：周瑜打黃蓋——一個願打，一個願挨
    kurou: { name: '苦肉計', n: [2, 2], w: 4, scenes: ['sanguo'],
      setup(G) { const [A, B] = G.members; A.hero = '周瑜'; B.hero = '黃蓋'; go(A, G.x - 34); go(B, G.x + 18); phase(G, 'gather'); },
      step(G) {
        const [A, B] = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          pose(A, posePoint(), 1); pose(B, poseBow(), -1);
          A.prop = { kind: 'stick', ang: -1.2, byPlay: true };
          line(G, A, '黃蓋不聽軍令，給我打！', 1.8);
          narrate('🎭 周瑜（' + numOf(A) + ' 號）要打黃蓋（' + numOf(B) + ' 號）的屁股…');
          phase(G, 'hit'); return;
        }
        if (G.phase === 'hit') {
          if (k < 1.6) return;
          const t2 = k - 1.6, cyc = Math.floor(t2 / 1.1), u = (t2 % 1.1) / 1.1;
          if (cyc >= 3) {
            A.prop = null; pose(A, poseGuard(), 1); pose(B, poseSalute(), -1);
            line(G, B, '打得好！再打！', 1.6);
            narrate('🎭 周瑜打黃蓋——一個願打，一個願挨！（這是苦肉計，演給曹操看的）');
            phase(G, 'wink'); return;
          }
          A.prop.ang = u < 0.7 ? -2.2 : 0.5; pose(A, u < 0.7 ? poseRaise() : poseCut(), 1);
          if (u >= 0.7 && !G.f['h' + cyc]) {
            G.f['h' + cyc] = true; pose(B, poseOw(), -1);
            line(G, B, pick(['哎喲！', '啪！好痛！', '嗚…我忍！']), 0.8);
            for (let i = 0; i < 4; i++) sparkle(B.x + rand(-8, 8), B.y - 18 * B.s + rand(-6, 6));
          } else if (u < 0.3) pose(B, poseBow(), -1);
          return;
        }
        if (G.phase === 'wink') {
          if (k > 2 && !G.f.w) { G.f.w = true; line(G, B, '（小聲）其實一點都不痛～', 1.6); }
          if (k > 4) endGroup(G);
        }
      } },

    // 火燒連環船：黃蓋假裝投降、點火，火沿著鐵鍊一艘燒過一艘，曹操逃走
    chainfire: { name: '火燒連環船', n: [2, 2], w: 5, scenes: ['sanguo'],
      setup(G) {
        const [A, B] = G.members, k = BASE / 1.5;
        A.hero = '黃蓋'; B.hero = '曹操';
        G.ships = [0, 1, 2].map(i => ({ x: G.x - 40 * k + i * 70 * k, fire: -1 }));
        go(A, G.x - 110 * k); go(B, G.ships[2].x);
        phase(G, 'gather');
      },
      step(G) {
        const [A, B] = G.members, k = G.t - G.t0, wind = S.wind > T;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          A.weapon = { kind: 'torch', ang: -1.45 }; B.weapon = { kind: 'longsword', ang: -0.9 };
          pose(B, poseLaugh(T), -1);
          line(G, B, '船都用鐵鍊綁在一起，穩得很！哈哈哈', 2);
          narrate('🚢 曹操（' + numOf(B) + ' 號）把戰船用鐵鍊一艘一艘連起來…');
          phase(G, 'boast'); return;
        }
        if (G.phase === 'boast') {
          pose(B, poseLaugh(T), -1);
          if (k > 2.4 && !G.f.a) { G.f.a = true; line(G, A, '曹丞相～我黃蓋來投降了～', 1.8); go(A, G.ships[0].x - 40 * BASE / 1.5); }
          if (G.f.a && ready(G)) {
            pose(A, poseThrow(), 1); G.ships[0].fire = T;
            narrate('🔥 黃蓋（' + numOf(A) + ' 號）放火了！' + (wind ? '東風一吹，' : '') + '火沿著鐵鍊燒到每一艘船！', true);
            phase(G, 'burn');
          }
          return;
        }
        if (G.phase === 'burn') {
          const gap = wind ? 0.6 : 1.1;
          G.ships.forEach((sh, i) => { if (sh.fire < 0 && T - G.ships[0].fire > i * gap) sh.fire = T; });
          if (G.ships[2].fire > 0 && !G.f.run) {
            G.f.run = true; B.weapon = null; line(G, B, '哇啊啊！快跑啊！', 1.4); go(B, kidMaxX() - 6, 170);
            pose(A, poseCheer(T), 1);
          }
          if (G.f.run) pose(A, poseCheer(T), 1);
          if (k > 6.5) { narrate('🏃 曹操敗走華容道！赤壁之戰，孫權和劉備聯手打贏了！'); phase(G, 'end'); }
          return;
        }
        if (k > 3) endGroup(G);
      },
      draw(G) {
        const k = BASE / 1.5;
        // 鐵鍊
        g.save(); g.strokeStyle = '#9aa0aa'; g.lineWidth = 2;
        for (let i = 0; i + 1 < G.ships.length; i++) {
          const x1 = G.ships[i].x + 28 * k, x2 = G.ships[i + 1].x - 28 * k;
          for (let x = x1; x < x2; x += 6) { g.beginPath(); g.ellipse(x + 3, FLOOR - 9 * k, 3, 1.8, 0, 0, Math.PI * 2); g.stroke(); }
        }
        g.restore();
        for (const sh of G.ships) drawWarship(sh.x, sh.fire);
      } },

    // 草船借箭：孔明和魯肅在大霧裡放稻草人，曹軍一直射箭，箭都插在稻草上
    arrows: { name: '草船借箭', n: [2, 2], w: 3, scenes: ['sanguo'],
      setup(G) {
        const [A, B] = G.members, k = BASE / 1.5;
        A.hero = '孔明'; B.hero = '魯肅';
        go(A, G.x - 66 * k); go(B, G.x - 40 * k);
        G.straw = [0, 1, 2].map(i => G.x + (4 + i * 30) * k); G.arrows = []; G.count = 0;
        phase(G, 'gather');
      },
      step(G, dt) {
        const [A, B] = G.members, k = G.t - G.t0;
        for (const ar of G.arrows) if (!ar.stuck && T - ar.t0 >= ar.dur) { ar.stuck = true; G.count += rint(1800, 3600); }
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          A.weapon = { kind: 'feather', ang: -1 }; pose(A, poseTalk(T), 1); pose(B, poseListen(), -1);
          line(G, A, '今晚起大霧，我們去跟曹操借箭。', 1.8);
          narrate('🌫️ 孔明（' + numOf(A) + ' 號）和魯肅（' + numOf(B) + ' 號）在大霧裡擺了一排稻草人…');
          phase(G, 'talk'); return;
        }
        if (G.phase === 'talk') {
          if (k > 2 && !G.f.b) { G.f.b = true; line(G, B, '借箭？曹操怎麼可能借我們？', 1.6); }
          if (k > 3.8) { narrate('🏹 曹軍以為有人來偷襲，咻咻咻一直射箭！', true); phase(G, 'rain'); }
          return;
        }
        if (G.phase === 'rain') {
          pose(A, poseTalk(T), 1); pose(B, poseCover(), -1);
          if (k < 6 && Math.random() < dt * 9) {
            const tx = pick(G.straw) + rand(-5, 5);
            G.arrows.push({ sx: Math.min(W - 10, G.x + 320), sy: FLOOR - rand(90, 140), tx, ty: FLOOR - rand(12, 34) * BASE / 1.5, t0: T, dur: rand(0.45, 0.7) });
          }
          if (k > 6.8) {
            G.count = 100000; pose(A, poseCheer(T), 1); pose(B, poseCheer(T), -1);
            line(G, A, '多謝曹丞相送的十萬支箭！', 2);
            narrate('🏹 草船借箭成功！一支箭都沒做，就借到十萬支箭！');
            phase(G, 'end');
          }
          return;
        }
        pose(A, poseCheer(T), 1); pose(B, poseCheer(T), -1);
        if (k > 3) endGroup(G);
      },
      draw(G) {
        const k = BASE / 1.5;
        g.save();
        // 霧
        if (G.phase === 'talk' || G.phase === 'rain') for (let i = 0; i < 6; i++) {
          g.fillStyle = 'rgba(225,228,235,0.16)'; g.beginPath(); g.ellipse(G.x - 120 + i * 70 + Math.sin(T * 0.6 + i) * 20, FLOOR - 30 - (i % 3) * 22, 70, 18, 0, 0, Math.PI * 2); g.fill();
        }
        // 稻草人
        for (const x of G.straw) {
          g.fillStyle = '#d9b45a'; g.strokeStyle = '#8a6a2a'; g.lineWidth = 1;
          g.beginPath(); g.ellipse(x, FLOOR - 20 * k, 8 * k, 20 * k, 0, 0, Math.PI * 2); g.fill(); g.stroke();
          g.beginPath(); g.arc(x, FLOOR - 44 * k, 6 * k, 0, Math.PI * 2); g.fill(); g.stroke();
          g.strokeStyle = '#8a4a1a'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x - 8 * k, FLOOR - 28 * k); g.lineTo(x + 8 * k, FLOOR - 28 * k); g.moveTo(x - 8 * k, FLOOR - 12 * k); g.lineTo(x + 8 * k, FLOOR - 12 * k); g.stroke();
        }
        // 箭（從右邊射過來，插在稻草上）
        g.lineCap = 'round';
        for (const ar of G.arrows) {
          const u = Math.min(1, (T - ar.t0) / ar.dur), x = ar.sx + (ar.tx - ar.sx) * u, y = ar.sy + (ar.ty - ar.sy) * u - Math.sin(u * Math.PI) * 18;
          const ang = Math.atan2(ar.ty - ar.sy, ar.tx - ar.sx), cx = Math.cos(ang), cy = Math.sin(ang);
          g.strokeStyle = '#5a3a22'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(x, y); g.lineTo(x - cx * 16, y - cy * 16); g.stroke();
          g.strokeStyle = '#e8e2d0'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(x - cx * 13, y - cy * 13); g.lineTo(x - cx * 16, y - cy * 16); g.stroke();
        }
        if (G.count > 0) {
          const txt = G.count >= 100000 ? '🏹 十萬支箭！' : '🏹 ' + G.count.toLocaleString() + ' 支';
          g.font = '900 13px ' + FONT; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = INK; g.fillStyle = '#f6c344';
          g.strokeText(txt, G.straw[1], FLOOR - 64 * k); g.fillText(txt, G.straw[1], FLOOR - 64 * k); g.textAlign = 'left';
        }
        g.restore();
      } },

    // 桃園三結義：劉備、關羽、張飛舉杯結拜
    oath: { name: '桃園三結義', n: [3, 3], w: 3, scenes: ['sanguo'],
      setup(G) { const names = ['劉備', '關羽', '張飛']; G.members.forEach((m, i) => { m.hero = names[i]; go(m, G.x - 40 + i * 40); }); phase(G, 'gather'); },
      step(G) {
        const ms = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          ms.forEach((m, i) => { m.item = '🍶'; pose(m, poseCheer(T), i === 2 ? -1 : 1); });
          narrate('🍑 桃園三結義：' + ms.map(m => numOf(m) + ' 號' + m.hero).join('、') + '結拜成兄弟！');
          line(G, ms[0], '我們三個今天結拜！', 1.8);
          phase(G, 'oath'); return;
        }
        ms.forEach((m, i) => pose(m, poseCheer(T + i), i === 2 ? -1 : 1));
        if (k > 2.2 && !G.f.a) { G.f.a = true; line(G, ms[1], '有福同享，有難同當！', 2); }
        if (k > 4.4 && !G.f.b) { G.f.b = true; line(G, ms[2], '大哥！二哥！乾杯！', 1.6); }
        if (k > 6.5) endGroup(G);
      } },

    elements: { name: '冰火對決', n: [2, 2], w: 6, scenes: ['icefire'],
      setup(G) { const [A, B] = G.members; go(A, G.x - 70); go(B, G.x + 70); G.shots = []; phase(G, 'gather'); },
      step(G, dt) {
        const [A, B] = G.members, k = G.t - G.t0;
        for (const sh of G.shots) { sh.u = Math.min(1, sh.u + dt * 1.6); }
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          pose(A, poseGuard(), 1); pose(B, poseGuard(), -1);
          A.item = null; G.round = 0;
          narrate('🔥❄️ ' + numOf(A) + ' 號用冰、' + numOf(B) + ' 號用火，冰火對決開始！');
          line(G, A, '看我的冰！', 1.2);
          phase(G, 'cast'); return;
        }
        if (G.phase === 'cast') {
          if (!G.f.s) { G.f.s = true; pose(A, poseThrust()); pose(B, poseThrust()); G.shots = [{ from: A, ice: true, u: 0 }, { from: B, ice: false, u: 0 }]; G.win = Math.random(); }
          if (k > 0.65 && !G.f.h) {
            G.f.h = true; G.shots = [];
            const mx = (A.x + B.x) / 2, my = FLOOR - 40 * A.s;
            for (let i = 0; i < 8; i++) parts.push({ kind: 'puff', grey: true, x: mx + rand(-10, 10), y: my + rand(-10, 10), vx: rand(-60, 60), vy: rand(-70, -10), life: 0.9, max: 0.9 });
            if (G.win < 0.25) { line(G, B, '好冷好冷！', 1.2); pose(B, poseZap); }
            else if (G.win > 0.75) { line(G, A, '好燙！融化了！', 1.2); pose(A, poseZap); }
            else if (Math.random() < 0.5) line(G, pick([A, B]), '滋～變成蒸汽了！', 1.1);
          }
          if (k > 1.5) { pose(A, poseGuard()); pose(B, poseGuard()); G.round++; phase(G, G.round >= 5 ? 'end' : 'cast'); }
          return;
        }
        if (!G.f.e) { G.f.e = true; pose(A, poseCheer); pose(B, poseCheer); narrate('🔥❄️ 冰火對決結束：冰和火打成平手，變出一大團蒸汽！'); }
        if (k > 1.6) endGroup(G);
      },
      draw(G) {
        const orb = (x, y, ice, r) => {
          g.save(); g.shadowColor = ice ? 'rgba(140,220,255,0.95)' : 'rgba(255,140,40,0.95)'; g.shadowBlur = 12;
          g.fillStyle = ice ? '#bfe9ff' : '#ff8a2a'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
          g.fillStyle = ice ? '#ffffff' : '#ffe07a'; g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2); g.fill();
          g.restore();
        };
        const [A, B] = G.members;
        if (G.phase !== 'gather') { if (A.j) orb(A.j.rH[0], A.j.rH[1], true, 4); if (B.j) orb(B.j.rH[0], B.j.rH[1], false, 4); }
        for (const sh of G.shots) {
          const m = sh.from; if (!m.j) continue;
          const mx = (A.x + B.x) / 2, my = FLOOR - 40 * A.s;
          orb(m.j.rH[0] + (mx - m.j.rH[0]) * sh.u, m.j.rH[1] + (my - m.j.rH[1]) * sh.u, sh.ice, 6);
        }
      } },

    roast: { name: '烤棉花糖', n: [2, 3], w: 4, scenes: ['icefire'],
      setup(G) { G.members.forEach((m, i) => go(m, G.x + (i % 2 ? 1 : -1) * (34 + Math.floor(i / 2) * 22))); G.burnt = null; phase(G, 'gather'); },
      step(G) {
        const ms = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          ms.forEach(m => pose(m, P({ lean: 0.15, ra1: 1.3, ra2: 1.2, la1: -0.2 }), m.x < G.x ? 1 : -1));
          narrate('🔥 ' + tagsOf(ms) + '在火山旁邊升火，烤棉花糖');
          phase(G, 'roast'); return;
        }
        if (G.phase === 'roast') {
          if (!G.f.b && k > 4) { G.f.b = true; G.burnt = pick(ms); line(G, G.burnt, '啊！燒焦了！', 1.5); }
          if (!G.f.y && k > 6.5) { G.f.y = true; const o = ms.find(m => m !== G.burnt) || ms[0]; line(G, o, '我的烤得剛剛好～好好吃！', 1.8); pose(o, poseCheer); }
          if (k > 9) { narrate('🍡 棉花糖烤好了，' + numOf(G.burnt) + ' 號那支烤成黑炭…'); phase(G, 'end'); }
          return;
        }
        if (k > 1.5) endGroup(G);
      },
      under(G) {
        const x = G.x;
        g.fillStyle = '#5a3420'; g.save(); g.translate(x, FLOOR - 4);
        g.rotate(0.3); g.fillRect(-16, -3, 32, 6); g.rotate(-0.6); g.fillRect(-16, -3, 32, 6); g.restore();
        for (let i = 0; i < 3; i++) {
          const h = 22 + Math.sin(T * 12 + i * 2) * 5 - i * 4;
          g.fillStyle = ['#ff5a1a', '#ff9a2a', '#ffe07a'][i];
          g.beginPath(); g.moveTo(x - 12 + i * 4, FLOOR - 6); g.quadraticCurveTo(x - 6 + i * 2, FLOOR - 6 - h * 0.6, x, FLOOR - 6 - h); g.quadraticCurveTo(x + 6 - i * 2, FLOOR - 6 - h * 0.6, x + 12 - i * 4, FLOOR - 6); g.closePath(); g.fill();
        }
      },
      draw(G) {
        if (G.phase === 'gather') return;
        for (const m of G.members) {
          if (!m.j) continue;
          const [hx, hy] = m.j.rH, tx = hx + (G.x - hx) * 0.8, ty = FLOOR - 26;
          g.strokeStyle = '#c69b6d'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(hx, hy); g.lineTo(tx, ty); g.stroke();
          g.fillStyle = m === G.burnt && G.f.b ? '#2a1a12' : '#fff7ec';
          g.beginPath(); g.ellipse(tx, ty, 4, 3, 0, 0, Math.PI * 2); g.fill();
        }
      } },

    // ---------- 海底：游泳、挖寶藏、水母 ----------
    swim: { name: '游泳', n: [1, 2], w: 5, scenes: ['ocean'],
      setup(G) { G.members.forEach((m, i) => go(m, G.x - 40 + i * 50)); phase(G, 'gather'); },
      step(G, dt) {
        const ms = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          G.dir = G.x > (200 + kidMaxX()) / 2 ? -1 : 1;
          ms.forEach(m => { m.sw = { sp: rand(70, 110), top: rand(80, 140), x0: m.x }; m.act.pose = poseSwim; });
          narrate(ms.length > 1 ? '🏊 ' + tagsOf(ms) + '游上去比賽，看誰游得快' : '🏊 ' + numOf(ms[0]) + ' 號往上游，在海裡游來游去');
          phase(G, 'swim'); return;
        }
        if (G.phase === 'swim' || G.phase === 'down') {
          const up = G.phase === 'swim' ? Math.min(1, k / 1.2) : Math.max(0, 1 - k / 1.2);
          for (const m of ms) {
            m.hop = m.sw.top * up + Math.sin(T * 2 + m.num) * 8 * up;
            m.rot = G.dir * 1.3 * up;
            m.act.tx = null; m.act.face = G.dir; m.act.pose = up > 0.3 ? poseSwim : P({});
            if (G.phase === 'swim') m.x = clamp(m.x + G.dir * m.sw.sp * dt * up, 40, kidMaxX() - 20);
          }
          if (G.phase === 'swim' && (k > 6 || ms.some(m => m.x <= 40 || m.x >= kidMaxX() - 20))) phase(G, 'down');
          else if (G.phase === 'down' && k > 1.25) {
            ms.forEach(m => { m.hop = 0; m.rot = 0; });
            if (ms.length > 1) { const best = ms.slice().sort((p, q) => G.dir * (q.x - p.x))[0]; narrate('🏊 ' + numOf(best) + ' 號游得比較快！'); line(G, best, '我贏了！', 1.4); pose(best, poseCheer); }
            phase(G, 'end');
          }
          return;
        }
        if (k > 1.4) endGroup(G);
      } },

    treasure: { name: '挖寶藏', n: [2, 3], w: 3, scenes: ['ocean'],
      setup(G) { G.members.forEach((m, i) => go(m, G.x + (i % 2 ? 1 : -1) * (28 + Math.floor(i / 2) * 26))); G.up = 0; G.open = 0; phase(G, 'gather'); },
      step(G, dt) {
        const ms = G.members, k = G.t - G.t0;
        if (G.phase === 'gather') {
          if (!ready(G)) return;
          ms.forEach(m => pose(m, poseMake(), m.x < G.x ? 1 : -1));
          narrate('💰 ' + tagsOf(ms) + '發現沙子裡埋著東西，開始挖…');
          line(G, ms[0], '這裡有東西！', 1.4);
          phase(G, 'dig'); return;
        }
        if (G.phase === 'dig') { if (Math.random() < dt * 6) dust(G.x + rand(-14, 14), FLOOR, 2); G.up = Math.min(1, k / 3.5); if (k > 3.6) phase(G, 'open'); return; }
        if (G.phase === 'open') {
          G.open = Math.min(1, k / 0.6);
          if (!G.f.o && k > 0.6) {
            G.f.o = true; G.prize = pick(TREASURES);
            for (let i = 0; i < 8; i++) sparkle(G.x + rand(-16, 16), FLOOR - 20 - rand(0, 30));
            ms.forEach(m => pose(m, poseCheer));
            line(G, ms[1] || ms[0], G.prize[2], 2);
            narrate('💰 寶箱打開了！裡面是' + G.prize[1]);
          }
          if (k > 3.4) phase(G, 'end');
          return;
        }
        G.up = Math.max(0, 1 - k / 1.2);
        if (k > 1.3) endGroup(G);
      },
      under(G) {
        if (G.up <= 0) return;
        const x = G.x, y = FLOOR - G.up * 16, w = 30, h = 18;
        g.save(); g.beginPath(); g.rect(x - 40, 0, 80, FLOOR + 2); g.clip();
        g.fillStyle = '#8a5a2b'; g.strokeStyle = INK; g.lineWidth = 1.5;
        g.fillRect(x - w / 2, y - h + 16, w, h); g.strokeRect(x - w / 2, y - h + 16, w, h);
        g.fillStyle = '#f6c344'; g.fillRect(x - 3, y - h + 20, 6, 6);
        g.save(); g.translate(x - w / 2, y - h + 16); g.rotate(-G.open * 1.2);
        g.fillStyle = '#9c6a35'; g.fillRect(0, -9, w, 9); g.strokeRect(0, -9, w, 9); g.restore();
        if (G.open > 0.5) { g.fillStyle = 'rgba(255,215,90,0.35)'; g.beginPath(); g.arc(x, y - h + 10, 26, 0, Math.PI * 2); g.fill(); }
        g.restore();
        if (G.prize && G.phase === 'open') { g.font = '22px ' + FONT; g.textAlign = 'center'; g.fillText(G.prize[0], x, y - h - 4 - Math.min(1, (G.t - G.t0)) * 14); g.textAlign = 'left'; }
      } },

    jelly: { name: '摸水母', n: [2, 3], w: 3, scenes: ['ocean'],
      setup(G) {
        G.dir = G.x > (200 + kidMaxX()) / 2 ? -1 : 1;
        G.jx = G.x - G.dir * 260; G.jy = FLOOR - 150 * BASE / 1.5; G.a = 0;
        G.members.forEach((m, i) => go(m, G.x - 30 + i * 32));
        phase(G, 'gather');
      },
      step(G, dt) {
        const ms = G.members, k = G.t - G.t0;
        G.a = Math.min(1, G.a + dt);
        if (G.phase === 'gather' || G.phase === 'come') {
          G.jx += (G.x + 6 - G.jx) * Math.min(1, dt * 0.9);
          if (G.phase === 'gather' && ready(G)) { ms.forEach(m => pose(m, P({ tilt: -0.3 }), Math.sign(G.jx - m.x) || 1)); narrate('🪼 一隻水母飄過來，' + tagsOf(ms) + '好奇想去摸它…'); phase(G, 'come'); }
          if (G.phase === 'come' && k > 2.2) { G.v = ms[0]; pose(G.v, P({ ra1: 2.6, ra2: 2.8, la1: -0.2 }), Math.sign(G.jx - G.v.x) || 1); line(G, G.v, '我摸摸看～', 1.2); phase(G, 'poke'); }
          return;
        }
        if (G.phase === 'poke') { if (k > 1) { pose(G.v, poseZap); line(G, G.v, '哇啊！好麻！', 1.6); phase(G, 'zap'); } return; }
        if (G.phase === 'zap') {
          G.v.hop = Math.abs(Math.sin(T * 50)) * 3;
          if (k > 1.4) { G.v.hop = 0; pose(G.v, poseSlump()); ms.forEach(m => { if (m !== G.v) pose(m, poseLaugh); }); narrate('🪼 ' + numOf(G.v) + ' 號被水母電到，頭髮都豎起來了！'); phase(G, 'leave'); }
          return;
        }
        G.jy -= dt * 60; G.a = Math.max(0, 1 - k / 2.2);
        if (k > 2.2) endGroup(G);
      },
      draw(G) {
        const x = G.jx, y = G.jy + Math.sin(T * 2) * 6, pulse = 1 + Math.sin(T * 4) * 0.08;
        g.save(); g.globalAlpha = 0.85 * G.a;
        g.shadowColor = 'rgba(255,150,230,0.9)'; g.shadowBlur = 12;
        g.fillStyle = 'rgba(255,170,230,0.75)';
        g.beginPath(); g.ellipse(x, y, 16 * pulse, 13 / pulse, 0, Math.PI, 0); g.closePath(); g.fill();
        g.shadowBlur = 0; g.strokeStyle = 'rgba(255,190,240,0.8)'; g.lineWidth = 1.6;
        for (let i = 0; i < 5; i++) {
          const tx = x - 12 + i * 6; g.beginPath(); g.moveTo(tx, y);
          for (let s = 1; s <= 6; s++) g.lineTo(tx + Math.sin(T * 3 + i + s) * 3, y + s * 6);
          g.stroke();
        }
        g.restore();
        if (G.phase === 'zap' && G.v && G.v.j) {
          const [hx, hy] = G.v.j.head;
          g.strokeStyle = '#ffe14d'; g.lineWidth = 2;
          for (let i = 0; i < 3; i++) { const an = rand(0, Math.PI * 2); g.beginPath(); g.moveTo(hx + Math.cos(an) * 10, hy + Math.sin(an) * 10); g.lineTo(hx + Math.cos(an) * 18 + rand(-4, 4), hy + Math.sin(an) * 18); g.lineTo(hx + Math.cos(an) * 26, hy + Math.sin(an) * 26); g.stroke(); }
        }
      } },
  });

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

  // 可以出去抓人的骷髏：在骷髏區、已經拼好（3 塊）、不是小兵
  const freeHunters = () => skulls().filter(s => s.parts === 3 && s.home && !s.minion && !s.dead).sort((x, y) => y.s - x.s);
  const canPlayBusy = k => !BUSY_ACTS.includes(k.act.type) || k.act.type === 'play';
  function beginHunt(h, v, o = {}) {
    const H_ = { hunter: h, v, t: 0, raid: !!o.raid, dropX: pit.x1 + 24 + (o.raid ? rand(-6, 46) : 0) };
    S.hunts.push(H_);
    h.home = false;
    v.goal = null; v.fear = true; v.carry = null; v.rot = 0; v.phone = false;
    if (o.brave) setAct(v, 'taunt', { tx: kidMaxX() - 8, phase: 0 });
    else if (!v.air && v.act.type !== 'climb') setAct(v, 'freeze');
    v.item = null;
    chase(h, v);
    return H_;
  }
  // 被抓的人旁邊的人嚇得逃跑（骷髏大軍時全場都逃）；只有一個人喊，不然太吵
  // 離得遠、正在玩遊戲的人繼續玩
  function scatter(victims, all) {
    let shouted = false;
    const near = k => victims.some(v => Math.abs(v.x - k.x) < (k.group ? 100 : 320));
    for (const k of kids()) if (!victims.includes(k) && !k.air && (all || near(k)) && !['stairRide', 'push', 'puppet', 'greet'].includes(k.act.type) && Math.random() < 0.7) {
      k.goal = null; k.carry = null;
      if (!shouted) shouted = say(k, pick(['骷髏來了！', '快逃！', '哇啊！', '大家快跑！']), 1.2, 1);
      const cs = surf(k.surf); setAct(k, 'flee', { tx: rand(cs.x1, cs.floor ? kidMaxX() : cs.x2) });
    }
  }
  function startHunt(brave, victimNum) {
    if (S.hunting) return false;
    const hunters = freeHunters();
    if (victimNum != null) {
      // 新出現逾期的人：一隻骷髏專門去抓他
      const target = kids().find(k => k.num === victimNum && !k.air && !k.cell && canPlayBusy(k));
      if (!target) return false;
      if (!hunters.length) {
        // 骷髏還沒拼好：直接被拖進綠池
        if (target.act.type === 'play') setAct(target, 'idle');
        target.sinkMsg = '💀 ' + tagOf(target.num) + '有作業逾期，被拖進綠池，關進籠子了！補交完就能出來'; target.goal = null; restoreCell(target, true); sinkIntoPool(target); return true;
      }
      banner('💀 ' + tagOf(target.num) + '有作業逾期，骷髏爬出來抓人了！');
      beginHunt(hunters[0], target);
      scatter([target]);
      say(hunters[0], '嘿嘿嘿…', 1.6);
      return true;
    }
    if (!hunters.length) return false;
    const pool = kids();
    if (!pool.length) return false;
    // 有幾隻拼好的骷髏，就同時出去抓幾個人；有時候有人裝勇敢跑去挑釁
    const braves = pool.filter(k => k.surf === 'floor' && !k.air && !k.cell && canPlayBusy(k));
    const isBrave = braves.length > 0 && (brave || Math.random() < 0.3);
    const victims = [];
    if (isBrave) victims.push(braves.sort((p, q) => q.x - p.x)[Math.floor(Math.random() * Math.min(3, braves.length))]);
    const rest = pool.filter(k => !victims.includes(k)).sort(() => Math.random() - 0.5);
    if (Math.random() < 0.4) rest.sort((p, q) => (p.surf !== 'floor') - (q.surf !== 'floor'));   // 站在卡片上的人排到最後（先被挑）
    while (victims.length < hunters.length && rest.length) victims.push(rest.pop());
    victims.forEach((v, i) => beginHunt(hunters[i], v, { brave: isBrave && i === 0 }));
    if (isBrave) banner('😤 ' + tagOf(victims[0].num) + '裝勇敢，跑去挑釁骷髏…');
    if (victims.length > 1) banner('💀 ' + victims.length + ' 隻骷髏一起爬出來了！要抓 ' + victims.map(v => String(v.num).padStart(2, '0')).join('、') + ' 號！');
    else if (!isBrave) banner('💀 骷髏爬出來了！它要抓 ' + tagOf(victims[0].num) + '！');
    scatter(victims);
    say(hunters[0], '嘿嘿嘿…', 1.6);
    return true;
  }
  // 骷髏大軍：偶爾從綠池爬出一群小骷髏，一次抓 7、8 個人（沒有缺交的過一下就會溜出來）
  function startRaid() {
    if (S.hunting || S.defeated || !skulls().length) return false;
    const pool = kids().sort(() => Math.random() - 0.5);
    const n = Math.min(Math.random() < 0.5 ? 7 : 8, pool.length - 3);
    if (n < 4) return false;
    const victims = pool.slice(0, n);
    const hunters = freeHunters().slice(0, n);
    while (hunters.length < n) {
      const m = makeAgent('skull', rand(pit.x1 + 20, pit.x2 - 20), { tier: 'small', parts: 3 });
      m.minion = true; m.home = false; m.y = FLOOR; m.surf = 'floor';
      agents.push(m); hunters.push(m);
      for (let k = 0; k < 6; k++) parts.push({ kind: 'puff', x: m.x + rand(-14, 14), y: FLOOR - rand(4, 40), vx: rand(-20, 20), vy: rand(-50, -10), life: 0.9, max: 0.9 });
    }
    S.raid = { n, caught: 0 };
    victims.forEach((v, i) => beginHunt(hunters[i], v, { raid: true }));
    banner('☠️ 骷髏大軍從綠池爬出來了！一次要抓 ' + n + ' 個人！');
    narrate('☠️ 骷髏大軍出動！' + victims.map(v => String(v.num).padStart(2, '0')).join('、') + ' 號快逃啊！', true);
    scatter(victims, true);
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
    if (h.goal) h.goal.run = true;
    h.act.tx = v.x;
  }
  // 抓完回骷髏區；小兵回到綠池就消失
  function sendHome(h) {
    if (h.minion) travel(h, 'floor', rand(pit.x1 + 30, pit.x2 - 30), 'vanish');
    else { h.home = true; travel(h, 'floor', rand(pit.x1 + 30, pit.x2 - 30), 'home'); }
  }
  function endHunt(H_) {
    S.hunts = S.hunts.filter(x => x !== H_);
    if (S.hunts.length) return;
    for (const k of kids()) { k.fear = false; if (k.act.type === 'flee' || k.act.type === 'freeze') setAct(k, 'idle', { dur: rand(0.2, 1) }); }
    if (S.raid) { if (S.raid.caught) banner('😱 骷髏大軍抓走了 ' + S.raid.caught + ' 個人！沒有缺交的等一下就會溜出來'); S.raid = null; }
    setTimeout(nextHunt, 2000);
  }
  function updateHunts(dt) { for (const H_ of [...S.hunts]) stepHunt(H_, dt); }
  function stepHunt(H_, dt) {
    H_.t += dt;
    const { hunter: h, v } = H_;
    if (h.gone) {
      // 骷髏被大熊老師打散：抓到一半的人掉下來
      if (v.act.type === 'grabbed') { v.air = true; v.vx = 0; v.vy = 0; setAct(v, 'fall'); }
      v.fear = false; endHunt(H_); return;
    }
    if (!H_.caught) {
      if (v.gone) { sendHome(h); endHunt(H_); return; }       // 自己掉進綠池了
      if (h.act.type === 'idle' && !h.goal) chase(h, v);
      if (h.surf === v.surf && !h.air && !v.air && Math.abs(h.x - v.x) < 26 * h.s / 1.5) {
        H_.caught = true; h.goal = null; h.f = Math.sign(v.x - h.x) || 1;
        setAct(v, 'grabbed', { by: h });
        say(v, '救命～～', 1.6, H_.raid ? 1 : 2);
        if (!H_.raid) say(h, '抓到了！', 1.2);
        travel(h, 'floor', H_.dropX, 'home');
      } else if (h.act.type === 'idle' && h.act.t > 0.3) chase(h, v);
      if (H_.t > 30 && !H_.caught) {
        v.fear = false; if (['freeze', 'taunt'].includes(v.act.type)) setAct(v, 'idle');
        sendHome(h); endHunt(H_);
      }
    } else if (!H_.thrown && h.surf === 'floor' && Math.abs(h.x - H_.dropX) < 8 && !h.air) {
      // 丟進綠池，之後在籠子裡重生
      H_.thrown = true;
      const T0 = 0.8, cx = (pit.x1 + pit.x2) / 2 + 20 + (H_.raid ? rand(-30, 30) : 0);
      v.sinkMsg = '😱 ' + tagOf(v.num) + '被骷髏丟進綠池，關進籠子了！' + (DATA && DATA.overdue.has(v.num) ? '補交完就能出來' : '');
      v.quietSink = H_.raid;
      if (H_.raid && S.raid) S.raid.caught++;
      v.air = true; v.vx = (cx - v.x) / T0; v.vy = (FLOOR - v.y - 0.5 * GRAV * T0 * T0) / T0;
      setAct(v, 'thrown');
      if (!H_.raid) say(h, '下去吧！', 1.2);
    } else if (H_.thrown && v.gone) {
      sendHome(h); endHunt(H_);
    } else if (H_.t > 45) { sendHome(h); endHunt(H_); }
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
      // 彩蛋：拔到自己還沒交的格子，被大熊老師發現
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
  // 某個座號的逾期全部補交完：從籠子放出來；原本逾期最多的人是英雄
  function releaseSeat(num, hero, n) {
    const i = S.caged.indexOf(num);
    if (i < 0) return;
    S.caged.splice(i, 1);
    const k = spawnFromCage(num);
    if (hero) {
      say(k, '我補交完了！', 2);
      banner('🦸 ' + tagOf(num) + '把逾期的 ' + n + ' 份作業都補交完，自己衝出籠子！');
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
  let freeing = 0, freedNums = [], freedTimer = 0;
  function intoCage(a) {
    restoreCell(a, true);
    a.gone = true;
    agents = agents.filter(x => x !== a);
    if (a.kind === 'kid') {
      S.caged.push(a.num);
      // 沒有缺交的人過一下就溜出來；一次被抓很多人時一個一個出來，橫幅合併成一則
      if (!DATA || !DATA.overdue.has(a.num)) {
        const wait = 7000 + freeing * 900; freeing++;
        setTimeout(() => {
          freeing = Math.max(0, freeing - 1);
          const i = S.caged.indexOf(a.num); if (!running || i < 0 || (DATA && DATA.overdue.has(a.num))) return;
          S.caged.splice(i, 1);
          const k = spawnFromCage(a.num); say(k, '呼～出來了', 1.4);
          freedNums.push(a.num);
          clearTimeout(freedTimer);
          freedTimer = setTimeout(() => {
            banner('😮‍💨 ' + freedNums.map(n => String(n).padStart(2, '0')).join('、') + ' 號沒有缺交，從籠子溜出來了～');
            freedNums = [];
          }, 1300);
        }, wait);
      }
    }
    for (let k = 0; k < 8; k++) parts.push({ kind: 'puff', grey: true, x: rand(cage.x1 + 10, cage.x2 - 10), y: FLOOR - rand(10, 60), vx: rand(-20, 20), vy: rand(-40, -10), life: 0.8, max: 0.8 });
    chips();
  }
  // ---------- 特效 ----------
  function dust(x, y, n) { for (let k = 0; k < n; k++) parts.push({ kind: 'dust', x: x + rand(-10, 10), y, vx: rand(-60, 60), vy: rand(-50, -5), life: 0.6, max: 0.6 }); }
  function smoke(x, y) { for (let k = 0; k < 9; k++) parts.push({ kind: 'puff', grey: true, x: x + rand(-14, 14), y: y - rand(4, 60), vx: rand(-40, 40), vy: rand(-40, 10), life: 0.6, max: 0.6 }); }
  function sparkle(x, y) { parts.push({ kind: 'spark', x, y, vx: 0, vy: 0, life: 0.6, max: 0.6 }); }
  function killSkull(s) {
    if (s.dead) return;
    s.dead = true; s.gone = true;
    for (let k = 0; k < 14; k++) parts.push({ kind: 'bone', x: s.x, y: s.y - 30 * s.s, vx: rand(-260, 260), vy: rand(-480, -150), rot: rand(0, 6), vr: rand(-12, 12), life: 2, max: 2, s: s.s });
    for (let k = 0; k < 12; k++) parts.push({ kind: 'puff', x: s.x + rand(-20, 20) * s.s, y: s.y - rand(5, 50) * s.s, vx: rand(-40, 40), vy: rand(-60, -10), life: 1, max: 1 });
    setTimeout(() => { if (!skulls().some(k => !k.dead)) banner('🎉 大熊老師一記殺球，骷髏被打散了！（逾期沒補完，過幾分鐘又會拼回來）'); }, 0);
  }
  // 橫幅排隊：同時發生好幾件事（例如英雄補交＋全班交齊）時輪流顯示，每則至少 2.8 秒
  let bannerTimer = 0, bannerUntil = 0;
  const bannerQueue = [];
  function banner(text) {
    if (performance.now() < bannerUntil) { if (!bannerQueue.includes(text) && bannerQueue.length < 4) bannerQueue.push(text); return; }
    showBanner(text);
  }
  function showBanner(text) {
    text = foeName(text);
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

  const SWIM_ACTS = ['walk', 'run', 'flee', 'idle', 'wave'];
  function drawAgent(a) {
    if (a.hidden) { if (a.act.type === 'ash') drawAshPile(a); a.bubbleAt = null; return; }
    if (a.morph) { drawMorph(a); return; }
    if (a.burn) {
      if (a.burn > T) { if (!a.air && a.act.type !== 'play') a.hop = Math.abs(Math.sin(T * 13)) * 7; }
      else { a.burn = 0; if (a.act.type !== 'play') a.hop = 0; }
    }
    let p = a.p || P({}), rot = a.rot || 0, lift = 0;
    if (a.kind === 'kid') {
      // 海底：在地上走、跑、站著的人改成在水裡游：走動時身體橫過來自由式，停下來時直直的踩水
      const on = S.scene === 'ocean' && a.surf === 'floor' && !a.air && !a.rot && !a.carry && !a.cell && SWIM_ACTS.includes(a.act.type);
      const mv = on && a.act.type !== 'idle' && a.act.type !== 'wave';
      a.swK = (a.swK || 0) + ((on ? 1 : 0) - (a.swK || 0)) * 0.06;
      a.swH = (a.swH || 0) + ((mv ? 1 : 0) - (a.swH || 0)) * 0.08;
      if (a.swK > 0.02) {
        const n = a.num || 0, ph = T * (a.act.type === 'walk' ? 6 : 9) + n;
        lift = (26 + ((n * 37) % 6) * 17 + Math.sin(T * 1.3 + n) * 7) * a.swK;
        rot = (a.f || 1) * 1.35 * a.swH * a.swK;
        if (on) p = a.swH > 0.5
          ? P({ ra1: ph % (Math.PI * 2), ra2: ph % (Math.PI * 2) + 0.25, la1: (ph + Math.PI) % (Math.PI * 2), la2: (ph + Math.PI) % (Math.PI * 2) + 0.25, rl1: 0.35 * Math.sin(T * 14 + n), rl2: 0.1, ll1: -0.35 * Math.sin(T * 14 + n), ll2: 0.1 })
          : P({ ra1: 1.3 + 0.5 * Math.sin(T * 5 + n), ra2: 1.8, la1: -1.3 - 0.5 * Math.sin(T * 5 + n), la2: -1.8, rl1: 0.3 * Math.sin(T * 7 + n), rl2: 0.4, ll1: -0.3 * Math.sin(T * 7 + n), ll2: 0.4 });
      }
    }
    const isBear = a.kind === 'bear';
    const j = joints(p, a.s, a.f, isBear);
    const legScale = j.legLen / 22;
    let hy = a.y - p.hipH * a.s * legScale - (a.hop || 0) - lift;
    if (a.act.type === 'sleep') hy = a.y - 4 * a.s;
    const hx = a.x;
    const c = Math.cos(rot), sn = Math.sin(rot);
    const W2 = q => [hx + q[0] * c - q[1] * sn, hy + q[0] * sn + q[1] * c];
    g.save(); g.translate(hx, hy); g.rotate(rot);
    g.lineCap = 'round'; g.lineJoin = 'round';
    const s = a.s;
    // 黑色角色在深色看板上加一圈白光邊，才看得清楚
    const charred = a.act.type === 'ash' && !a.act.back;
    if (a.kind !== 'skull') { g.shadowColor = charred ? 'rgba(255,90,20,' + (0.6 + Math.sin(T * 30) * 0.3).toFixed(2) + ')' : 'rgba(255,255,255,0.95)'; g.shadowBlur = charred ? 9 : 5; }
    if (a.kind === 'skull') drawSkullBody(a, j, s);
    else if (!isBear) drawKid(a, j, s);
    g.restore();
    a.j = isBear ? drawBearReal(a) : { rH: W2(j.rH), lH: W2(j.lH), head: W2(j.head) };
    if (a.burn > T) drawBurn(a.j.head[0], a.j.head[1] - 8 * a.s, a.s, a.burn - T);
    if (charred) drawCharred(a);
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
    if (a.tag) { g.font = '900 12px ' + FONT; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = INK; g.fillStyle = a.tag === '鬼' ? '#ff4d5e' : '#f6c344'; const ty = a.j.head[1] - 12 * s; g.strokeText(a.tag, a.j.head[0], ty); g.fillText(a.tag, a.j.head[0], ty); g.textAlign = 'left'; }
    a.bubbleAt = a.say && a.say.until > T ? [a.j.head[0], a.j.head[1] - (isBear ? 34 : a.kind === 'skull' ? 22 : a.tag ? 26 : 14) * s] : null;
  }

  // 每個人在忍者村固定一種打扮（照座號分）
  const NINJA_ROLES = ['katana', 'kimono', 'spear', 'katana', 'kunai', 'kimono', 'katana', 'spear', 'kunai', 'kimono'];
  const roleOf = a => NINJA_ROLES[(a.num || 0) % NINJA_ROLES.length];
  const KIMONO = ['#e05a8a', '#3d5a98', '#c0392b', '#2a9d8f', '#9b5de5', '#e9a23b'];
  const SCARF = { katana: '#b8323f', spear: '#2b5fa8', kunai: '#6a3cb0' };
  function drawKid(a, j, s) {
    const nj = S.scene === 'ninja', f = a.f || 1, snowy = S.scene === 'snow', icf = S.scene === 'icefire', sg = S.scene === 'sanguo';
    const hero = sg ? heroOf(a) : null;
    const role = nj ? (a.kimono ? 'kimono' : roleOf(a)) : null;
    const irole = icf ? ICE_ROLES[(a.num || 0) % ICE_ROLES.length] : null;
    const held = a.weapon || (role === 'spear' ? { kind: 'spear', ang: -Math.PI / 2 } : null) || (irole && ICE_HELD[irole] && !a.item && a.act && a.act.type !== 'play' ? ICE_HELD[irole] : null) || (sg && !a.item && a.act && a.act.type !== 'play' ? (hero ? hero.held : (a.num % 2 ? null : { kind: 'spear', ang: -1.5 })) : null);
    if (irole === 'wolf' && a.act && !a.air && !a.rot) drawWolf(-f * 17 * s, Math.max(j.lF[1], j.rF[1]), f, s, !!a.act && ['walk', 'run', 'flee'].includes(a.act.type));
    if (nj) ninjaBack(a, j, s, f, role, held);
    if (icf) drawCloak(a, j, s, f);
    if (sg && !hero) soldierFlag(a, j, s, f);
    g.strokeStyle = INK; g.fillStyle = INK; g.lineWidth = 3.4 * s;
    poly([j.lF, j.lK, j.hip]); poly([j.rF, j.rK, j.hip]);
    if (role === 'kimono') drawKimono(a, j, s);
    if (snowy) drawParka(a, j, s);
    if (sg) sanguoRobe(a, j, s, f, hero);
    g.strokeStyle = INK; g.fillStyle = INK; g.lineWidth = 3.4 * s;
    poly([j.lH, j.lE, j.neck]); poly([j.hip, j.neck]); poly([j.rH, j.rE, j.neck]);
    if (role === 'kimono') drawSleeves(a, j, s);
    if (snowy) drawParkaSleeves(a, j, s);
    if (sg) sanguoChest(a, j, s, hero);
    else if (nj) { g.save(); g.shadowBlur = 0; g.fillStyle = SCARF[role] || '#b8323f'; g.fillRect(j.hip[0] - 3.2 * s, j.hip[1] - 2.6 * s, 6.4 * s, 2.6 * s); g.restore(); }   // 腰帶
    const r = 7.5 * s;
    g.fillStyle = INK; g.beginPath(); g.arc(j.head[0], j.head[1], r, 0, Math.PI * 2); g.fill();
    if (nj) ninjaHead(a, j, s, f, role, r);
    if (snowy) drawHood(a, j, s, r);
    if (sg) sanguoHead(a, j, s, f, hero, r);
    if (icf) { g.save(); g.shadowBlur = 0; g.fillStyle = '#d9cbb0'; g.beginPath(); g.ellipse(j.neck[0], j.neck[1] + 0.5 * s, 5.4 * s, 2.6 * s, 0, 0, Math.PI * 2); g.fill(); g.restore(); }   // 斗篷的毛領
    // 頭上的白色座號（翻跟斗時也跟著轉）
    g.fillStyle = '#ffffff';
    g.font = '900 ' + (a.num >= 10 ? 8.4 : 9.5) * s + 'px ' + FONT;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(a.num).padStart(2, '0'), j.head[0], j.head[1] + 0.6 * s);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    if (S.scene === 'ocean') diveGear(a, j, s, f, r);
    if (held) drawHeld(j, s, f, held);
  }
  // ---------- 三國：主角每天輪流（名字寫在衣服上），其他人是吳、蜀、魏的士兵 ----------
  const HEROES = [
    { n: '孔明', c: '#ece6d6', dark: true, hat: 'scarf', held: { kind: 'feather', ang: -1.2 } },
    { n: '周瑜', c: '#c0392b', hat: 'crown', held: { kind: 'longsword', ang: -1.1 } },
    { n: '黃蓋', c: '#8e3b2a', hat: 'helmet', beard: '#f1efe6', held: { kind: 'torch', ang: -1.45 } },
    { n: '曹操', c: '#33367a', hat: 'tall', held: { kind: 'longsword', ang: -0.9 } },
    { n: '劉備', c: '#d4a72c', dark: true, hat: 'crown', held: { kind: 'longsword', ang: -1.1 } },
    { n: '關羽', c: '#2e8b57', hat: 'green', beard: '#15151b', long: true, held: { kind: 'guandao', ang: -1.45 } },
    { n: '張飛', c: '#3a3a44', hat: 'band', beard: '#15151b', held: { kind: 'spear', ang: -1.5 } },
    { n: '趙雲', c: '#dfe6ee', dark: true, hat: 'helmet', held: { kind: 'spear', ang: -1.3 } },
    { n: '魯肅', c: '#2b5fa8', hat: 'scholar', held: null },
  ];
  const FACTIONS = [{ n: '吳', c: '#b8323f' }, { n: '蜀', c: '#2e8b57' }, { n: '魏', c: '#2b4fa8' }];
  const dayNo = () => Math.floor((Date.now() + 8 * 3600e3) / 86400e3);
  function heroOf(a) {
    if (a.hero) return HEROES.find(h => h.n === a.hero) || null;
    const slot = ((a.num || 0) + dayNo() * 7) % 25;          // 每天換一批人當主角
    if (slot >= HEROES.length) return null;
    // 有人在故事裡正在演這個角色（例如借東風的孔明）：原本今天輪到的人先當士兵，畫面上不會有兩個孔明
    return agents.some(k => k !== a && k.hero === HEROES[slot].n && !k.gone) ? null : HEROES[slot];
  }
  const factionOf = a => FACTIONS[(a.num || 0) % 3];
  // 士兵背後插的背旗（寫吳、蜀、魏）
  function soldierFlag(a, j, s, f) {
    const fc = factionOf(a), [hx, hy] = j.hip, top = j.head[1] - 16 * s, px = hx - f * 4 * s, wave = Math.sin(T * 6 + (a.num || 0)) * 1.5 * s;
    g.save(); g.shadowBlur = 0;
    g.strokeStyle = '#5a3a22'; g.lineWidth = 1.4 * s; g.beginPath(); g.moveTo(px, hy); g.lineTo(px, top); g.stroke();
    g.fillStyle = fc.c; g.beginPath(); g.moveTo(px, top); g.lineTo(px - f * 11 * s, top + wave); g.lineTo(px - f * 11 * s, top + 13 * s + wave); g.lineTo(px, top + 13 * s); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.font = '900 ' + (8 * s) + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(fc.n, px - f * 5.5 * s, top + 6.8 * s + wave / 2);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.restore();
  }
  // 主角穿長袍，士兵穿短短的戰袍
  function sanguoRobe(a, j, s, f, hero) {
    const [nx, ny] = j.neck, [hx, hy] = j.hip, c = hero ? hero.c : factionOf(a).c, hem = hero ? 10 : 4, w = hero ? 8 : 6;
    g.save(); g.shadowBlur = 0;
    g.fillStyle = c; g.beginPath();
    g.moveTo(nx - 5 * s, ny); g.lineTo(nx + 5 * s, ny); g.lineTo(hx + w * s, hy + hem * s); g.lineTo(hx - w * s, hy + hem * s); g.closePath(); g.fill();
    g.fillStyle = hero ? '#f6c344' : '#3a2a20'; g.fillRect(hx - 5.4 * s, hy - 1.6 * s, 10.8 * s, 2.2 * s);       // 腰帶
    if (!hero) {                                                                                                   // 士兵的鎧甲片
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.7 * s; g.beginPath();
      for (let t = 0.25; t < 0.9; t += 0.2) { const y = ny + (hy - ny) * t; g.moveTo(nx - 4.5 * s, y); g.lineTo(nx + 4.5 * s, y); }
      g.stroke();
    }
    g.restore();
  }
  // 胸口：主角寫名字，士兵是圓圈裡的「兵」
  function sanguoChest(a, j, s, hero) {
    const x = (j.neck[0] + j.hip[0]) / 2, y = j.neck[1] + (j.hip[1] - j.neck[1]) * 0.45;
    g.save(); g.shadowBlur = 0; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (hero) {
      g.font = '900 ' + (7.4 * s) + 'px ' + FONT; g.lineWidth = 2.4 * s; g.lineJoin = 'round';
      g.strokeStyle = hero.dark ? '#fffaf0' : '#15151b'; g.fillStyle = hero.dark ? '#7a1a12' : '#fff4c8';
      g.strokeText(hero.n, x, y); g.fillText(hero.n, x, y);
    } else {
      g.fillStyle = '#f4ecd8'; g.beginPath(); g.arc(x, y, 3.6 * s, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#15151b'; g.font = '900 ' + (5 * s) + 'px ' + FONT; g.fillText('兵', x, y + 0.3 * s);
    }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.restore();
  }
  // 頭上：綸巾、冠、頭盔、長鬍子…；士兵戴尖頂頭盔
  function sanguoHead(a, j, s, f, hero, r) {
    const [hx, hy] = j.head;
    g.save(); g.shadowBlur = 0; g.lineCap = 'round';
    const hat = hero ? hero.hat : 'soldier';
    if (hat === 'scarf') {             // 孔明的綸巾：藍色頭巾＋後面兩條飄帶
      g.fillStyle = '#2b3f7a'; g.beginPath(); g.moveTo(hx - r, hy - r * 0.35); g.lineTo(hx - r * 0.7, hy - r * 1.55); g.lineTo(hx + r * 0.7, hy - r * 1.55); g.lineTo(hx + r, hy - r * 0.35); g.closePath(); g.fill();
      g.strokeStyle = '#2b3f7a'; g.lineWidth = 1.6 * s; const wv = Math.sin(T * 6) * 2 * s;
      g.beginPath(); g.moveTo(hx - f * r * 0.8, hy - r * 0.6); g.quadraticCurveTo(hx - f * r * 1.6, hy, hx - f * r * 2, hy + r * 0.6 + wv); g.stroke();
    } else if (hat === 'crown') {      // 髮髻上的金冠
      g.fillStyle = '#15151b'; g.beginPath(); g.arc(hx, hy - r * 1.05, r * 0.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f6c344'; g.fillRect(hx - r * 0.45, hy - r * 1.5, r * 0.9, r * 0.45);
      g.strokeStyle = '#f6c344'; g.lineWidth = 1 * s; g.beginPath(); g.moveTo(hx - r * 1.1, hy - r * 1.3); g.lineTo(hx + r * 1.1, hy - r * 1.3); g.stroke();   // 簪子
    } else if (hat === 'helmet') {     // 銀色頭盔＋紅纓
      g.fillStyle = '#b9c0cc'; g.beginPath(); g.arc(hx, hy - r * 0.3, r * 1.08, Math.PI, 0); g.fill();
      g.strokeStyle = '#c0392b'; g.lineWidth = 2.2 * s; g.beginPath(); g.moveTo(hx, hy - r * 1.35); g.quadraticCurveTo(hx - f * r * 0.8, hy - r * 2.1, hx - f * r * 1.5, hy - r * 1.4 + Math.sin(T * 7) * s); g.stroke();
    } else if (hat === 'tall') {       // 曹操的高冠
      g.fillStyle = '#15151b'; g.beginPath(); g.moveTo(hx - r * 0.55, hy - r * 0.85); g.lineTo(hx - r * 0.75, hy - r * 2.1); g.lineTo(hx + r * 0.75, hy - r * 2.1); g.lineTo(hx + r * 0.55, hy - r * 0.85); g.closePath(); g.fill();
      g.fillStyle = '#f6c344'; g.fillRect(hx - r * 0.75, hy - r * 2.2, r * 1.5, r * 0.22);
    } else if (hat === 'green') {      // 關羽的綠頭巾
      g.fillStyle = '#2e8b57'; g.beginPath(); g.arc(hx, hy - r * 0.25, r * 1.06, Math.PI * 1.05, Math.PI * 1.95); g.fill();
      g.beginPath(); g.arc(hx, hy - r * 1.25, r * 0.42, 0, Math.PI * 2); g.fill();
    } else if (hat === 'band') {       // 張飛的頭帶
      g.strokeStyle = '#c0392b'; g.lineWidth = 2.4 * s; g.beginPath(); g.moveTo(hx - r, hy - r * 0.45); g.lineTo(hx + r, hy - r * 0.45); g.stroke();
      g.lineWidth = 1.5 * s; g.beginPath(); g.moveTo(hx - f * r, hy - r * 0.45); g.lineTo(hx - f * r * 1.7, hy + Math.sin(T * 8) * 2 * s); g.stroke();
    } else if (hat === 'scholar') {    // 文官的方帽
      g.fillStyle = '#15151b'; g.fillRect(hx - r * 0.75, hy - r * 1.6, r * 1.5, r * 0.75);
      g.fillRect(hx - r * 1.3, hy - r * 1.05, r * 2.6, r * 0.2);
    } else {                           // 士兵：尖頂頭盔（陣營的顏色）
      g.fillStyle = factionOf(a).c; g.beginPath(); g.moveTo(hx - r * 1.08, hy - r * 0.3); g.lineTo(hx, hy - r * 1.75); g.lineTo(hx + r * 1.08, hy - r * 0.3); g.closePath(); g.fill();
      g.fillStyle = '#c9a24a'; g.fillRect(hx - r * 1.08, hy - r * 0.42, r * 2.16, r * 0.24);
    }
    if (hero && hero.beard) {          // 長鬍子（關羽的美髯最長）
      const L = (hero.long ? 15 : 8) * s, sway = Math.sin(T * 3 + (a.num || 0)) * s;
      g.fillStyle = hero.beard; g.strokeStyle = hero.beard === '#15151b' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.25)'; g.lineWidth = 0.7 * s;
      g.beginPath(); g.moveTo(hx - r * 0.55 + f * r * 0.3, hy + r * 0.55); g.quadraticCurveTo(hx + f * r * 0.3, hy + r * 0.55 + L * 0.6, hx + f * r * 0.35 + sway, hy + r * 0.6 + L);
      g.quadraticCurveTo(hx + f * r * 0.5, hy + r * 0.55 + L * 0.5, hx + r * 0.55 + f * r * 0.3, hy + r * 0.55); g.closePath(); g.fill(); g.stroke();
    }
    g.restore();
  }

  // ---------- 雪地：厚雪衣、毛毛帽兜、手套、雪靴 ----------
  const COATS = ['#e63946', '#2b7bd6', '#f4a261', '#2a9d8f', '#9b5de5', '#e9a23b', '#ff6fa5', '#3d9b4a'];
  const coatOf = a => COATS[((a.num || 0) * 3) % COATS.length];
  function drawParka(a, j, s) {
    const c = coatOf(a), [nx, ny] = j.neck, [hx, hy] = j.hip;
    g.save(); g.shadowBlur = 0;
    g.fillStyle = c; g.beginPath();
    g.moveTo(nx - 4.2 * s, ny); g.lineTo(nx + 4.2 * s, ny); g.lineTo(hx + 6 * s, hy + 4 * s); g.lineTo(hx - 6 * s, hy + 4 * s); g.closePath(); g.fill();
    g.fillStyle = '#f3ead6'; g.fillRect(hx - 6.2 * s, hy + 2.4 * s, 12.4 * s, 2.4 * s);                    // 衣襬的毛邊
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.8 * s; g.beginPath(); g.moveTo((nx + hx) / 2, ny + 1 * s); g.lineTo(hx, hy + 2.4 * s); g.stroke();   // 拉鍊
    g.fillStyle = '#5a3a22';
    for (const [x, y] of [j.lF, j.rF]) { roundRect(x - 3.2 * s, y - 4.4 * s, 6.4 * s, 5 * s, 1.6 * s); g.fill(); }   // 雪靴
    g.restore();
  }
  function drawParkaSleeves(a, j, s) {
    const c = coatOf(a);
    g.save(); g.shadowBlur = 0; g.strokeStyle = c; g.lineWidth = 4.6 * s; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const [h, e] of [[j.lH, j.lE], [j.rH, j.rE]]) {
      g.beginPath(); g.moveTo(j.neck[0], j.neck[1]); g.lineTo(e[0], e[1]); g.lineTo(h[0] + (e[0] - h[0]) * 0.25, h[1] + (e[1] - h[1]) * 0.25); g.stroke();
      g.fillStyle = '#f3ead6'; g.beginPath(); g.arc(h[0], h[1], 2.6 * s, 0, Math.PI * 2); g.fill();          // 毛手套
    }
    g.restore();
  }
  function drawHood(a, j, s, r) {
    const [hx, hy] = j.head;
    g.save(); g.shadowBlur = 0;
    g.strokeStyle = coatOf(a); g.lineWidth = 3.4 * s; g.beginPath(); g.arc(hx, hy, r + 2.6 * s, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#f3ead6'; g.lineWidth = 2.4 * s; g.setLineDash([1.6 * s, 1.1 * s]); g.beginPath(); g.arc(hx, hy, r + 0.9 * s, 0, Math.PI * 2); g.stroke();   // 毛毛的邊
    g.setLineDash([]);
    g.restore();
  }

  // ---------- 冰與火：黑斗篷、長劍、火把、龍蛋、冰原狼 ----------
  const ICE_ROLES = ['sword', 'torch', 'egg', 'wolf', 'sword', 'torch', 'cloak', 'wolf', 'egg', 'sword'];
  const ICE_HELD = { sword: { kind: 'longsword', ang: -1.15 }, torch: { kind: 'torch', ang: -1.45 }, egg: { kind: 'egg', ang: 0 } };
  function drawCloak(a, j, s, f) {
    const [nx, ny] = j.neck, [hx, hy] = j.hip, wave = Math.sin(T * 5 + (a.num || 0)) * 1.6 * s + (a.act && (a.act.type === 'run' || a.act.type === 'flee') ? 5 * s : 0);
    g.save(); g.shadowBlur = 0;
    g.fillStyle = '#2d2622'; g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 0.8 * s;
    g.beginPath(); g.moveTo(nx + f * 3 * s, ny); g.lineTo(nx - f * 4 * s, ny - 0.5 * s);
    g.quadraticCurveTo(hx - f * (8 * s + wave), (ny + hy) / 2, hx - f * (11 * s + wave), hy + 9 * s);
    g.lineTo(hx + f * 1 * s, hy + 7 * s); g.closePath(); g.fill(); g.stroke();
    g.restore();
  }
  function drawWolf(x, y, f, s, moving) {
    const leg = moving ? Math.sin(T * 12) * 2.6 : 0, k = s * 1.15;
    g.save(); g.shadowBlur = 0; g.translate(x, y); g.scale(f * k, k); g.lineCap = 'round';
    g.strokeStyle = '#c9cfd8'; g.lineWidth = 2.4;
    for (const [lx, d] of [[-7, 1], [-4, -1], [6, -1], [9, 1]]) { g.beginPath(); g.moveTo(lx, -8); g.lineTo(lx + leg * d, 0); g.stroke(); }
    g.fillStyle = '#eef1f5'; g.strokeStyle = '#8a94a6'; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(-10, -12); g.quadraticCurveTo(-17, -9 + Math.sin(T * 4) * 1.5, -20, -15); g.quadraticCurveTo(-16, -13, -10, -9); g.closePath(); g.fill(); g.stroke();   // 尾巴
    g.beginPath(); g.ellipse(1, -11, 11.5, 5, 0, 0, Math.PI * 2); g.fill(); g.stroke();                   // 身體
    g.beginPath(); g.ellipse(12, -16, 5, 4.2, -0.2, 0, Math.PI * 2); g.fill(); g.stroke();               // 頭
    g.beginPath(); g.moveTo(15, -18); g.lineTo(21, -15); g.lineTo(15, -13); g.closePath(); g.fill(); g.stroke();   // 嘴
    g.beginPath(); g.moveTo(9.5, -19); g.lineTo(10.5, -25); g.lineTo(13, -19.5); g.closePath(); g.fill(); g.stroke();   // 耳朵
    g.fillStyle = '#d9372b'; g.beginPath(); g.arc(14.2, -17.2, 1, 0, Math.PI * 2); g.fill();          // 紅眼睛
    g.fillStyle = '#1b1b22'; g.beginPath(); g.arc(20.6, -15, 0.9, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // 被燒焦：身上一閃一閃的火星、往上冒的黑煙
  function drawCharred(a) {
    g.save(); g.shadowBlur = 0;
    const s = a.s, [hx, hy] = a.j.head;
    for (let n = 0; n < 7; n++) {
      const u = (n * 0.37 + T * 0.2) % 1;
      g.fillStyle = 'rgba(255,' + (90 + (n * 23) % 90) + ',20,' + (0.5 + 0.5 * Math.sin(T * 9 + n * 2)).toFixed(2) + ')';
      g.beginPath(); g.arc(a.x + Math.sin(n * 2.1) * 6 * s, hy + (8 + u * 40) * s, 1.4 * s, 0, Math.PI * 2); g.fill();
    }
    for (let n = 0; n < 3; n++) {
      const u = (T * 0.9 + n / 3) % 1;
      g.fillStyle = 'rgba(40,36,36,' + (0.6 * (1 - u)).toFixed(2) + ')';
      g.beginPath(); g.arc(hx + Math.sin(u * 6 + n) * 5 * s, hy - 10 * s - u * 30 * s, (3 + u * 6) * s, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
  // 一堆灰：慢慢堆起來、冒煙、偶爾有火星；上面標座號，大家知道是誰
  function drawAshPile(a) {
    const k = BASE / 1.5, u = clamp((a.act.t - 1.5) / 0.6, 0, 1), x = a.x, y = a.y;
    g.save();
    g.fillStyle = '#4a4440'; g.beginPath(); g.ellipse(x, y, 16 * k * u, 8 * k * u, 0, Math.PI, 0); g.fill();
    g.fillStyle = '#6b6560'; g.beginPath(); g.ellipse(x - 3 * k, y - 2 * k * u, 9 * k * u, 5 * k * u, 0, Math.PI, 0); g.fill();
    for (let n = 0; n < 4; n++) {
      g.fillStyle = 'rgba(255,120,30,' + Math.max(0, Math.sin(T * 6 + n * 1.7)).toFixed(2) + ')';
      g.fillRect(x + (n - 1.5) * 6 * k, y - (2 + (n % 2) * 3) * k * u, 2, 2);
    }
    for (let n = 0; n < 2; n++) {
      const v = (T * 0.6 + n / 2) % 1;
      g.fillStyle = 'rgba(120,115,110,' + (0.45 * (1 - v)).toFixed(2) + ')';
      g.beginPath(); g.arc(x + Math.sin(v * 5 + n) * 6, y - 10 * k - v * 34, 4 + v * 7, 0, Math.PI * 2); g.fill();
    }
    if (u >= 1) { g.font = '900 11px ' + FONT; g.textAlign = 'center'; g.fillStyle = '#d8d2cc'; g.fillText(String(a.num).padStart(2, '0'), x, y - 12 * k); g.textAlign = 'left'; }
    g.restore();
  }
  // 被龍火燙到：頭上冒火、冒煙
  function drawBurn(x, y, s, left) {
    const k = Math.min(1, left / 0.8);
    g.save(); g.shadowColor = 'rgba(255,140,30,0.9)'; g.shadowBlur = 8;
    for (let n = 0; n < 3; n++) {
      const fx = x + (n - 1) * 3.4 * s, h = (9 + Math.sin(T * 22 + n * 2) * 3) * s * k;
      g.fillStyle = ['rgba(255,90,20,0.9)', 'rgba(255,200,60,0.95)', 'rgba(255,120,30,0.9)'][n];
      g.beginPath(); g.moveTo(fx - 2.6 * s, y); g.quadraticCurveTo(fx - 1.6 * s, y - h * 0.6, fx, y - h); g.quadraticCurveTo(fx + 1.6 * s, y - h * 0.6, fx + 2.6 * s, y); g.closePath(); g.fill();
    }
    g.shadowBlur = 0;
    for (let n = 0; n < 3; n++) {
      const u = (T * 1.4 + n / 3) % 1;
      g.fillStyle = 'rgba(160,160,170,' + (0.55 * (1 - u)).toFixed(2) + ')';
      g.beginPath(); g.arc(x + Math.sin(u * 7 + n) * 4 * s, y - 12 * s - u * 22 * s, (2 + u * 4) * s, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
  // 背後：飄動的圍巾、背在背上的武士刀、大腿上的苦無
  function ninjaBack(a, j, s, f, role, held) {
    g.save(); g.shadowBlur = 0; g.lineCap = 'round';
    const wave = Math.sin(T * 8 + (a.num || 0)) * 2 * s;
    if (role !== 'kimono') {
      g.strokeStyle = SCARF[role]; g.lineWidth = 2.4 * s;
      const [nx, ny] = j.neck;
      g.beginPath(); g.moveTo(nx, ny + s); g.quadraticCurveTo(nx - f * 7 * s, ny + 2 * s + wave, nx - f * 14 * s, ny + 5 * s - wave); g.stroke();
      g.beginPath(); g.moveTo(nx, ny + s); g.quadraticCurveTo(nx - f * 6 * s, ny + 5 * s - wave, nx - f * 11 * s, ny + 9 * s + wave); g.stroke();
    }
    if (role === 'katana') {
      const ax = j.hip[0] - f * 6 * s, ay = j.hip[1] - 2 * s, bx = j.neck[0] + f * 4 * s, by = j.neck[1] - 5 * s;
      g.strokeStyle = '#3b2416'; g.lineWidth = 2.6 * s; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      if (!held || held.kind !== 'katana') {
        const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
        g.fillStyle = '#d4a72c'; g.beginPath(); g.arc(bx, by, 1.8 * s, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#efe3c2'; g.lineWidth = 2.2 * s; g.beginPath(); g.moveTo(bx + ux * 1.5 * s, by + uy * 1.5 * s); g.lineTo(bx + ux * 7 * s, by + uy * 7 * s); g.stroke();
      }
    }
    if (role === 'kunai') {
      g.fillStyle = '#c9ccd8';
      for (const dx of [-1.5, 1.5]) { const x = j.hip[0] + dx * s, y = j.hip[1] + 1 * s; g.beginPath(); g.moveTo(x, y + 7 * s); g.lineTo(x - 1.3 * s, y + 2 * s); g.lineTo(x + 1.3 * s, y + 2 * s); g.closePath(); g.fill(); }
    }
    g.restore();
  }
  // 頭：頭巾（前面有一塊鐵片）；穿和服的人是髮髻和花簪
  function ninjaHead(a, j, s, f, role, r) {
    g.save(); g.shadowBlur = 0; g.lineCap = 'round';
    const [hx, hy0] = j.head;
    if (role === 'kimono') {
      g.fillStyle = INK; g.beginPath(); g.arc(hx - f * r * 0.55, hy0 - r * 0.85, r * 0.45, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ff8fb8'; for (const [dx, dy] of [[0, 0], [2, 1.5], [-1.5, 2]]) { g.beginPath(); g.arc(hx - f * (r * 0.15 - dx * s), hy0 - r * 0.95 + dy * s, 1.4 * s, 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = '#f6c344'; g.lineWidth = 1 * s; g.beginPath(); g.moveTo(hx - f * r * 0.2, hy0 - r * 0.9); g.lineTo(hx - f * r * 1.1, hy0 - r * 1.25); g.stroke();
    } else {
      const hy = hy0 - 3.4 * s, bx = hx - f * r * 0.9, wave = Math.sin(T * 9 + (a.num || 0)) * 2 * s;
      g.strokeStyle = role === 'spear' ? '#2b5fa8' : role === 'kunai' ? '#6a3cb0' : '#e63946';
      g.lineWidth = 2.8 * s;
      g.beginPath(); g.moveTo(hx - r * 0.95, hy); g.lineTo(hx + r * 0.95, hy); g.stroke();
      g.lineWidth = 1.8 * s;
      g.beginPath(); g.moveTo(bx, hy); g.lineTo(bx - f * 9 * s, hy + 2 * s + wave); g.stroke();
      g.beginPath(); g.moveTo(bx, hy); g.lineTo(bx - f * 7 * s, hy + 5 * s - wave); g.stroke();
      g.fillStyle = '#cfd3de'; g.fillRect(hx + f * r * 0.15 - 2.6 * s, hy - 1.6 * s, 5.2 * s, 3.2 * s);
    }
    g.restore();
  }
  function drawKimono(a, j, s) {
    const c = KIMONO[(a.num || 0) % KIMONO.length];
    const hemY = Math.max(j.lK[1], j.rK[1]) + 6 * s, kx = (j.lK[0] + j.rK[0]) / 2;
    g.save(); g.shadowBlur = 0;
    g.fillStyle = c; g.beginPath();
    g.moveTo(j.neck[0] - 2.5 * s, j.neck[1] + s); g.lineTo(j.neck[0] + 2.5 * s, j.neck[1] + s);
    g.lineTo(j.hip[0] + 5.5 * s, j.hip[1]); g.lineTo(kx + 8.5 * s, hemY); g.lineTo(kx - 8.5 * s, hemY); g.lineTo(j.hip[0] - 5.5 * s, j.hip[1]);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (const [u, v] of [[-0.4, 0.4], [0.35, 0.65], [-0.1, 0.85], [0.2, 0.25]]) { g.beginPath(); g.arc(kx + u * 12 * s, j.hip[1] + (hemY - j.hip[1]) * v, 1.1 * s, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#f6c344'; g.fillRect(j.hip[0] - 5.8 * s, j.hip[1] - 4.5 * s, 11.6 * s, 3.8 * s);       // 腰帶
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.1 * s;
    g.beginPath(); g.moveTo(j.neck[0] - 2.2 * s, j.neck[1] + 1.2 * s); g.lineTo(j.neck[0], j.neck[1] + 6 * s); g.lineTo(j.neck[0] + 2.2 * s, j.neck[1] + 1.2 * s); g.stroke();
    g.restore();
  }
  function drawSleeves(a, j, s) {
    const c = KIMONO[(a.num || 0) % KIMONO.length];
    g.save(); g.shadowBlur = 0; g.fillStyle = c;
    for (const [ex, ey] of [j.lE, j.rE]) { roundRect(ex - 3.2 * s, ey - 1.5 * s, 6.4 * s, 8.5 * s, 2 * s); g.fill(); }
    g.restore();
  }
  // 手上拿的東西：武士刀、長槍、扇子、太鼓棒（ang：0 = 朝前面水平，負的往上）
  function drawHeld(j, s, f, w) {
    const [hx, hy] = j.rH, dx = Math.cos(w.ang || 0) * f, dy = Math.sin(w.ang || 0);
    g.save(); g.shadowBlur = 0; g.lineCap = 'round';
    if (w.kind === 'katana') {
      g.strokeStyle = '#efe3c2'; g.lineWidth = 2.4 * s; g.beginPath(); g.moveTo(hx - dx * 5 * s, hy - dy * 5 * s); g.lineTo(hx + dx * 1.5 * s, hy + dy * 1.5 * s); g.stroke();
      g.fillStyle = '#d4a72c'; g.beginPath(); g.arc(hx + dx * 2 * s, hy + dy * 2 * s, 1.9 * s, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#e8eef5'; g.lineWidth = 1.9 * s; g.beginPath(); g.moveTo(hx + dx * 3 * s, hy + dy * 3 * s); g.lineTo(hx + dx * 25 * s - dy * f * 1.5 * s, hy + dy * 25 * s + dx * f * 1.5 * s); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 0.7 * s; g.beginPath(); g.moveTo(hx + dx * 5 * s, hy + dy * 5 * s); g.lineTo(hx + dx * 22 * s, hy + dy * 22 * s); g.stroke();
    } else if (w.kind === 'spear') {
      const p = (w.push || 0) * s * 0.5;
      const bx = hx + dx * (p - 16 * s), by = hy + dy * (p - 16 * s), tx = hx + dx * (p + 28 * s), ty = hy + dy * (p + 28 * s);
      g.strokeStyle = '#8a5a2b'; g.lineWidth = 1.8 * s; g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
      g.fillStyle = '#e8eef5'; g.beginPath(); g.moveTo(tx + dx * 7 * s, ty + dy * 7 * s); g.lineTo(tx - dy * f * 2 * s, ty + dx * f * 2 * s); g.lineTo(tx + dy * f * 2 * s, ty - dx * f * 2 * s); g.closePath(); g.fill();
      g.fillStyle = '#e63946'; g.beginPath(); g.arc(tx, ty, 1.5 * s, 0, Math.PI * 2); g.fill();
    } else if (w.kind === 'fan') {
      const an = Math.atan2(dy, dx);
      g.fillStyle = '#e63946'; g.beginPath(); g.moveTo(hx, hy); g.arc(hx, hy, 10 * s, an - 1, an + 1); g.closePath(); g.fill();
      g.strokeStyle = '#f6c344'; g.lineWidth = 1.2 * s; g.beginPath(); g.arc(hx, hy, 10 * s, an - 1, an + 1); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 0.6 * s;
      for (let k = -2; k <= 2; k++) { const b = an + k * 0.45; g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx + Math.cos(b) * 10 * s, hy + Math.sin(b) * 10 * s); g.stroke(); }
    } else if (w.kind === 'feather') {
      const an = Math.atan2(dy, dx), tx = hx + dx * 6 * s, ty = hy + dy * 6 * s;
      g.strokeStyle = '#7a4a24'; g.lineWidth = 1.8 * s; g.beginPath(); g.moveTo(hx - dx * 2 * s, hy - dy * 2 * s); g.lineTo(tx, ty); g.stroke();
      g.fillStyle = '#fbfaf5'; g.strokeStyle = '#b9b2a2'; g.lineWidth = 0.7 * s;
      g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(tx + Math.cos(an - 0.7) * 14 * s, ty + Math.sin(an - 0.7) * 14 * s, tx + Math.cos(an) * 17 * s, ty + Math.sin(an) * 17 * s);
      g.quadraticCurveTo(tx + Math.cos(an + 0.7) * 14 * s, ty + Math.sin(an + 0.7) * 14 * s, tx, ty); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); for (let k = -2; k <= 2; k++) { const b = an + k * 0.22; g.moveTo(tx, ty); g.lineTo(tx + Math.cos(b) * 14 * s, ty + Math.sin(b) * 14 * s); } g.stroke();
    } else if (w.kind === 'guandao') {
      const bx = hx - dx * 18 * s, by = hy - dy * 18 * s, tx = hx + dx * 30 * s, ty = hy + dy * 30 * s, nx = -dy * f, ny = dx * f;
      g.strokeStyle = '#6b3f1f'; g.lineWidth = 2 * s; g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
      g.fillStyle = '#d6dde6'; g.strokeStyle = '#2e8b57'; g.lineWidth = 0.9 * s;
      g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(tx + dx * 8 * s + nx * 8 * s, ty + dy * 8 * s + ny * 8 * s, tx + dx * 18 * s + nx * 2 * s, ty + dy * 18 * s + ny * 2 * s);
      g.quadraticCurveTo(tx + dx * 8 * s + nx * 2 * s, ty + dy * 8 * s + ny * 2 * s, tx - dx * 2 * s, ty - dy * 2 * s); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#c0392b'; g.beginPath(); g.arc(tx - dx * 2 * s, ty - dy * 2 * s, 1.8 * s, 0, Math.PI * 2); g.fill();   // 紅纓
    } else if (w.kind === 'longsword') {
      const nx = -dy * f, ny = dx * f;                                    // 垂直方向（護手）
      g.strokeStyle = '#5a3a22'; g.lineWidth = 2.2 * s; g.beginPath(); g.moveTo(hx - dx * 5 * s, hy - dy * 5 * s); g.lineTo(hx + dx * 1.5 * s, hy + dy * 1.5 * s); g.stroke();
      g.strokeStyle = '#b9a27a'; g.lineWidth = 1.8 * s; g.beginPath(); g.moveTo(hx + dx * 2 * s - nx * 4.5 * s, hy + dy * 2 * s - ny * 4.5 * s); g.lineTo(hx + dx * 2 * s + nx * 4.5 * s, hy + dy * 2 * s + ny * 4.5 * s); g.stroke();
      g.strokeStyle = '#c9d1dc'; g.lineWidth = 2.4 * s; g.beginPath(); g.moveTo(hx + dx * 3 * s, hy + dy * 3 * s); g.lineTo(hx + dx * 30 * s, hy + dy * 30 * s); g.stroke();
      g.strokeStyle = 'rgba(60,66,80,0.8)'; g.lineWidth = 0.6 * s; g.beginPath();                          // 劍身上的波紋
      for (let t = 5; t < 28; t += 3) { g.moveTo(hx + dx * t * s - nx * 0.8 * s, hy + dy * t * s - ny * 0.8 * s); g.lineTo(hx + dx * (t + 1.5) * s + nx * 0.8 * s, hy + dy * (t + 1.5) * s + ny * 0.8 * s); }
      g.stroke();
    } else if (w.kind === 'torch') {
      const tx = hx + dx * 13 * s, ty = hy + dy * 13 * s;
      g.strokeStyle = '#7a4a24'; g.lineWidth = 2.2 * s; g.beginPath(); g.moveTo(hx - dx * 4 * s, hy - dy * 4 * s); g.lineTo(tx, ty); g.stroke();
      g.shadowColor = 'rgba(255,150,40,0.95)'; g.shadowBlur = 12;
      for (let n = 0; n < 2; n++) {
        const h = (11 - n * 4 + Math.sin(T * 20 + n) * 2) * s, w2 = (4 - n * 1.5) * s;
        g.fillStyle = n ? 'rgba(255,230,120,0.95)' : 'rgba(255,110,30,0.9)';
        g.beginPath(); g.moveTo(tx - w2, ty); g.quadraticCurveTo(tx - w2, ty - h * 0.6, tx + Math.sin(T * 9) * 1.5 * s, ty - h); g.quadraticCurveTo(tx + w2, ty - h * 0.6, tx + w2, ty); g.closePath(); g.fill();
      }
    } else if (w.kind === 'egg') {
      const ex = (j.rH[0] + j.lH[0]) / 2 + f * 2 * s, ey = Math.min(j.rH[1], j.lH[1]) - 3 * s;
      g.shadowColor = 'rgba(255,120,40,' + (0.5 + Math.sin(T * 3) * 0.3).toFixed(2) + ')'; g.shadowBlur = 10;
      g.fillStyle = '#6b1d1d'; g.beginPath(); g.ellipse(ex, ey, 4.2 * s, 5.6 * s, 0, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0; g.fillStyle = '#d4a72c';
      for (const [ox, oy] of [[-1.6, -2.4], [1.4, -0.6], [-1, 1.6], [1.8, 2.6], [0, -4]]) { g.beginPath(); g.arc(ex + ox * s, ey + oy * s, 0.8 * s, 0, Math.PI * 2); g.fill(); }
    } else if (w.kind === 'sticks') {
      g.strokeStyle = '#c69b6d'; g.lineWidth = 1.4 * s;
      for (const [x, y] of [j.rH, j.lH]) { g.beginPath(); g.moveTo(x, y); g.lineTo(x + f * 8 * s, y - 3 * s); g.stroke(); }
    }
    g.restore();
  }
  // 海底：額頭上的潛水鏡、旁邊的呼吸管，偶爾冒泡泡
  function diveGear(a, j, s, f, r) {
    const [hx, hy] = j.head;
    g.save(); g.shadowBlur = 0;
    g.strokeStyle = '#1b1b22'; g.lineWidth = 1.6 * s; g.beginPath(); g.moveTo(hx - r, hy - r * 0.45); g.lineTo(hx + r, hy - r * 0.45); g.stroke();
    g.fillStyle = 'rgba(140,220,255,0.9)'; g.strokeStyle = '#ffffff'; g.lineWidth = 1 * s;
    roundRect(hx + f * r * 0.25 - 4 * s, hy - r * 0.95, 8 * s, 4.6 * s, 1.8 * s); g.fill(); g.stroke();
    g.strokeStyle = '#ffd23f'; g.lineWidth = 2 * s; g.lineCap = 'round';
    g.beginPath(); g.moveTo(hx - f * r * 0.95, hy + 2 * s); g.lineTo(hx - f * r * 1.15, hy - r - 4 * s); g.stroke();
    g.strokeStyle = '#ff7b1a'; g.beginPath(); g.moveTo(hx - f * r * 1.15, hy - r - 4 * s); g.lineTo(hx - f * r * 1.18, hy - r - 6 * s); g.stroke();
    if (a.num) {
      g.strokeStyle = 'rgba(220,245,255,0.85)'; g.lineWidth = 1;
      for (let k = 0; k < 2; k++) {
        const u = ((T * 0.7 + a.num * 0.37 + k * 0.5) % 1);
        if (u > 0.85) continue;
        g.beginPath(); g.arc(hx - f * r * 1.2 + Math.sin(u * 9) * 2 * s, hy - r - 8 * s - u * 26 * s, (1.2 + k) * s * 0.8, 0, Math.PI * 2); g.stroke();
      }
    }
    g.restore();
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

  // 骷髏跟著場景換造型：忍者村是鬼（赤鬼、青鬼）、海底是幽靈海盜骷髏、雪地是冰骷髏
  const FOE = {
    playground: { name: '骷髏', pit: '☠️ 骷髏區', glow: [70, 210, 46], ground: '#1f6b14', drip: SLIME },
    ninja: { name: '鬼', pit: '👹 鬼門', glow: [230, 70, 40], ground: '#5a1a14', drip: '#ff7a3d' },
    ocean: { name: '海盜骷髏', pit: '🏴‍☠️ 沉船', glow: [40, 200, 190], ground: '#0d4a52', drip: '#7ff3e6' },
    sanguo: { name: '曹營骷髏兵', pit: '🚢 曹營', glow: [255, 130, 50], ground: '#4a1c10', drip: '#ff9a4d', label: '#ffd9a8' },
    icefire: { name: '冰原殭屍', pit: '🧟 殭屍墓', glow: [110, 200, 255], ground: '#1d3550', drip: '#bfe6ff', label: '#bfe6ff' },
    snow: { name: '冰骷髏', pit: '❄️ 冰窟', glow: [140, 200, 255], ground: '#2d5a8a', drip: '#d6f0ff', label: '#1f5f9e' },
  };
  const foe = () => FOE[S.scene] || FOE.playground;
  const foeName = text => S.scene === 'playground' ? text : String(text).replace(/骷髏/g, foe().name).replace(/綠池/g, foe().pit.replace(/^\S+\s*/, ''));
  let curFoe = null;     // 正在畫的那隻（鬼的顏色看牠是哪一隻）
  const oniRed = a => !a || a.id % 2 === 0;
  const isIce = () => S.scene === 'snow';
  const isFire = () => false;
  const isZombie = () => S.scene === 'icefire';
  function boneColor() {
    if (S.scene === 'ninja') return oniRed(curFoe) ? '#d9443a' : '#3f73d6';
    if (S.scene === 'ocean') return '#dff7f2';
    if (isZombie()) return '#5d7083';
    if (isIce()) return '#bfe6ff';
    if (isFire()) return '#4a2e28';
    return BONE;
  }
  function bone(x1, y1, x2, y2, s) {
    g.strokeStyle = INK; g.lineWidth = 5.5 * s; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    g.strokeStyle = boneColor(); g.lineWidth = 3 * s; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }
  // 鬼的臉：紅（藍）皮膚、兩支角、亂髮、怒眉、黃眼睛、往上翹的獠牙
  function oniHead(s, tier) {
    const skin = oniRed(curFoe) ? '#d9443a' : '#3f73d6', H = tier === 'boss' ? 1.5 : 1;
    g.fillStyle = INK;
    for (let i = -4; i <= 4; i++) { g.beginPath(); g.moveTo(i * 1.9 * s - 2 * s, -4 * s); g.lineTo(i * 2.1 * s, -10.5 * s - (i % 2 ? 1.5 : 0) * s); g.lineTo(i * 1.9 * s + 2 * s, -4 * s); g.closePath(); g.fill(); }
    g.fillStyle = tier === 'boss' ? '#f6c344' : '#f1e6c8'; g.strokeStyle = INK; g.lineWidth = 1.2 * s;
    for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * 2.5 * s, -5.5 * s); g.quadraticCurveTo(sx * 6 * s, -10 * s * H, sx * 4.5 * s, -14 * s * H); g.lineTo(sx * 6 * s, -5 * s); g.closePath(); g.fill(); g.stroke(); }
    g.fillStyle = skin; g.lineWidth = 2 * s;
    g.beginPath(); g.arc(0, 0, 7.5 * s, 0, Math.PI * 2); g.fill(); g.stroke();
    g.strokeStyle = INK; g.lineWidth = 1.6 * s;
    for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * 5.5 * s, -4.2 * s); g.lineTo(sx * 1.2 * s, -2.2 * s); g.stroke(); }
    g.fillStyle = '#ffd23f'; for (const sx of [-1, 1]) { g.beginPath(); g.arc(sx * 3 * s, -0.4 * s, 1.8 * s, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = INK; for (const sx of [-1, 1]) { g.beginPath(); g.arc(sx * 3 * s, -0.2 * s, 0.8 * s, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#3a0f0f'; g.beginPath(); g.ellipse(0, 4 * s, 4.2 * s, 2.2 * s, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff'; for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * 3.2 * s, 5.6 * s); g.lineTo(sx * 2.4 * s, 2 * s); g.lineTo(sx * 1.6 * s, 5.6 * s); g.closePath(); g.fill(); }
  }
  // 鬼的虎皮褲和狼牙棒
  function oniGear(a, j, s) {
    g.save(); g.shadowBlur = 0;
    g.fillStyle = '#f6c344'; g.beginPath(); g.moveTo(j.hip[0] - 6 * s, j.hip[1] - 3 * s); g.lineTo(j.hip[0] + 6 * s, j.hip[1] - 3 * s); g.lineTo(j.hip[0] + 5 * s, j.hip[1] + 5 * s); g.lineTo(j.hip[0] - 5 * s, j.hip[1] + 5 * s); g.closePath(); g.fill();
    g.strokeStyle = INK; g.lineWidth = 1.3 * s; for (const dx of [-3, 0, 3]) { g.beginPath(); g.moveTo(j.hip[0] + dx * s - s, j.hip[1] - 3 * s); g.lineTo(j.hip[0] + dx * s + s, j.hip[1] + 4 * s); g.stroke(); }
    const [hx, hy] = j.rH, an = -1.1 + Math.sin(T * 2 + a.id) * 0.15, dx = Math.cos(an) * a.f, dy = Math.sin(an);
    g.strokeStyle = '#3a3a44'; g.lineCap = 'round'; g.lineWidth = 2.2 * s; g.beginPath(); g.moveTo(hx - dx * 3 * s, hy - dy * 3 * s); g.lineTo(hx + dx * 6 * s, hy + dy * 6 * s); g.stroke();
    g.lineWidth = 4.5 * s; g.beginPath(); g.moveTo(hx + dx * 6 * s, hy + dy * 6 * s); g.lineTo(hx + dx * 22 * s, hy + dy * 22 * s); g.stroke();
    g.fillStyle = '#c9ccd8'; for (let k = 8; k <= 20; k += 4) for (const sd of [-1, 1]) { g.beginPath(); g.arc(hx + dx * k * s - dy * a.f * sd * 2.4 * s, hy + dy * k * s + dx * a.f * sd * 2.4 * s, 0.9 * s, 0, Math.PI * 2); g.fill(); }
    g.restore();
  }
  // 海盜：彎刀、身上掛著海草
  function pirateGear(a, j, s) {
    g.save(); g.shadowBlur = 0; g.lineCap = 'round';
    g.strokeStyle = '#2a9d6f'; g.lineWidth = 1.6 * s;
    g.beginPath(); g.moveTo(j.neck[0], j.neck[1]); for (let k = 1; k <= 5; k++) g.lineTo(j.neck[0] + Math.sin(T * 3 + k) * 2 * s - a.f * k * 0.6 * s, j.neck[1] + k * 3 * s); g.stroke();
    const [hx, hy] = j.rH;
    g.strokeStyle = '#d4a72c'; g.lineWidth = 2 * s; g.beginPath(); g.moveTo(hx, hy + 2 * s); g.lineTo(hx, hy - 2 * s); g.stroke();
    g.strokeStyle = '#e8eef5'; g.lineWidth = 2.2 * s; g.beginPath(); g.moveTo(hx, hy - 2 * s); g.quadraticCurveTo(hx + a.f * 4 * s, hy - 12 * s, hx + a.f * 11 * s, hy - 17 * s); g.stroke();
    g.restore();
  }
  // 冰原殭屍：灰藍色的臉、凹陷的眼窩發冰藍光、張開的嘴；最大隻的是冰王，臉更白、頭上一圈冰刺
  function zombieHead(s, tier) {
    const king = tier === 'boss';
    if (king) {
      g.fillStyle = '#d9ecff'; g.strokeStyle = '#7fb8e6'; g.lineWidth = 0.8 * s;
      for (let i = -3; i <= 3; i++) { const h = (11 - Math.abs(i) * 1.8) * s; g.beginPath(); g.moveTo(i * 2.2 * s - 1.3 * s, -5 * s); g.lineTo(i * 2.5 * s, -5 * s - h); g.lineTo(i * 2.2 * s + 1.3 * s, -5 * s); g.closePath(); g.fill(); g.stroke(); }
    } else {
      g.strokeStyle = '#2a2f36'; g.lineWidth = 1.2 * s;
      for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(i * 2 * s, -6.5 * s); g.lineTo(i * 2.6 * s + Math.sin(T * 2 + i) * s, -2 * s + Math.abs(i) * 1.2 * s); g.stroke(); }
    }
    g.fillStyle = king ? '#e4eef7' : '#8fa3b5'; g.strokeStyle = INK; g.lineWidth = 2 * s;
    g.beginPath(); g.ellipse(0, 0, 6.8 * s, 7.8 * s, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    if (!king) { g.strokeStyle = '#2a2f36'; g.lineWidth = 1.1 * s; for (let i = -3; i <= 3; i++) { g.beginPath(); g.moveTo(i * 2 * s, -7.6 * s); g.lineTo(i * 2.4 * s, -4.5 * s); g.stroke(); } }
    g.fillStyle = '#26303b'; for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * 2.8 * s, -1 * s, 2.1 * s, 2.5 * s, 0, 0, Math.PI * 2); g.fill(); }
    g.save(); g.shadowColor = 'rgba(110,210,255,1)'; g.shadowBlur = 8 * s; g.fillStyle = '#9fe8ff';
    for (const sx of [-1, 1]) { g.beginPath(); g.arc(sx * 2.8 * s, -1 * s, 1.3 * s, 0, Math.PI * 2); g.fill(); }
    g.restore();
    g.fillStyle = '#1b1f26'; g.beginPath(); g.moveTo(-3 * s, 3.5 * s); g.lineTo(3 * s, 3.2 * s); g.lineTo(2.2 * s, 6 * s); g.lineTo(-2.4 * s, 6.2 * s); g.closePath(); g.fill();
    g.strokeStyle = '#cfd8e0'; g.lineWidth = 0.7 * s; for (const tx of [-1.6, 0, 1.6]) { g.beginPath(); g.moveTo(tx * s, 3.4 * s); g.lineTo(tx * s, 4.6 * s); g.stroke(); }
  }
  // 殭屍的破衣服（身上、腰上一片片的破布）
  function zombieGear(a, j, s) {
    g.save(); g.shadowBlur = 0;
    const [nx, ny] = j.neck, [hx, hy] = j.hip;
    g.fillStyle = a.tier === 'boss' ? 'rgba(30,45,70,0.95)' : 'rgba(52,44,38,0.95)';
    g.beginPath(); g.moveTo(nx - 4.5 * s, ny); g.lineTo(nx + 4.5 * s, ny);
    g.lineTo(hx + 5.5 * s, hy + 2 * s);
    for (let i = 0; i < 5; i++) { const xx = hx + 5.5 * s - (i + 0.5) * 2.2 * s; g.lineTo(xx, hy + (6 + (i % 2) * 3 + Math.sin(T * 3 + i) * 0.8) * s); g.lineTo(xx - 1.1 * s, hy + 3 * s); }
    g.lineTo(hx - 5.5 * s, hy + 2 * s); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(180,220,255,0.35)'; g.lineWidth = 0.8 * s;
    g.beginPath(); g.moveTo(nx - 2 * s, ny + 4 * s); g.lineTo(hx + 1 * s, hy - 2 * s); g.stroke();
    if (a.tier === 'boss') { g.strokeStyle = '#bfe6ff'; g.lineWidth = 2 * s; g.lineCap = 'round'; const [rx, ry] = j.rH; g.beginPath(); g.moveTo(rx, ry + 3 * s); g.lineTo(rx + a.f * 4 * s, ry - 20 * s); g.stroke(); }  // 冰矛
    g.restore();
  }
  // 火骷髏：兩隻手冒火
  function fireGear(a, j, s) {
    g.save(); g.shadowBlur = 0;
    for (const [x, y] of [j.lH, j.rH]) {
      const h = (7 + Math.sin(T * 16 + x) * 2) * s;
      g.fillStyle = '#ff7a1a'; g.beginPath(); g.moveTo(x - 3 * s, y); g.quadraticCurveTo(x - 2 * s, y - h * 0.6, x, y - h); g.quadraticCurveTo(x + 2 * s, y - h * 0.6, x + 3 * s, y); g.closePath(); g.fill();
      g.fillStyle = '#ffd35a'; g.beginPath(); g.arc(x, y - 1.5 * s, 1.6 * s, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
  // 冰骷髏：手臂下掛著冰柱
  function iceGear(a, j, s) {
    g.save(); g.shadowBlur = 0; g.fillStyle = 'rgba(220,245,255,0.9)';
    for (const [x, y] of [j.lE, j.rE, j.lK, j.rK]) { g.beginPath(); g.moveTo(x - 1.5 * s, y); g.lineTo(x + 1.5 * s, y); g.lineTo(x, y + 5 * s); g.closePath(); g.fill(); }
    g.restore();
  }
  function skullHead(x, y, s, tier, rot) {
    g.save(); g.translate(x, y); g.rotate(rot || 0);
    if (S.scene === 'ninja') { oniHead(s, tier); g.restore(); return; }
    if (isZombie()) { zombieHead(s, tier); g.restore(); return; }
    if (isFire()) {
      // 頭上燒著火
      for (let i = -2; i <= 2; i++) {
        const h = (8 - Math.abs(i) * 2 + Math.sin(T * 14 + i * 2) * 2) * s * (tier === 'boss' ? 1.4 : 1);
        g.fillStyle = i % 2 ? '#ff7a1a' : '#ffd35a';
        g.beginPath(); g.moveTo(i * 2.6 * s - 2.2 * s, -4.5 * s); g.quadraticCurveTo(i * 2.6 * s - 1 * s, -4.5 * s - h * 0.6, i * 2.6 * s, -4.5 * s - h); g.quadraticCurveTo(i * 2.6 * s + 1 * s, -4.5 * s - h * 0.6, i * 2.6 * s + 2.2 * s, -4.5 * s); g.closePath(); g.fill();
      }
    }
    if (S.scene === 'sanguo') {
      const k2 = tier === 'boss' ? 1.35 : 1;
      g.fillStyle = '#5d6370'; g.beginPath(); g.arc(0, -2.5 * s, 8 * s * k2, Math.PI, 0); g.fill();
      g.strokeStyle = '#c0392b'; g.lineWidth = 2.2 * s; g.beginPath(); g.moveTo(0, -10 * s * k2); g.quadraticCurveTo(-5 * s, -16 * s * k2, -10 * s, -11 * s * k2 + Math.sin(T * 7) * s); g.stroke();
    }
    if (isIce()) {
      // 冰做的王冠
      g.fillStyle = '#e6f7ff'; g.strokeStyle = '#7fb8e6'; g.lineWidth = 1 * s;
      for (let i = -2; i <= 2; i++) { const h = (i === 0 ? 9 : 6 - Math.abs(i)) * s * (tier === 'boss' ? 1.4 : 1); g.beginPath(); g.moveTo(i * 2.6 * s - 1.6 * s, -5.5 * s); g.lineTo(i * 2.8 * s, -5.5 * s - h); g.lineTo(i * 2.6 * s + 1.6 * s, -5.5 * s); g.closePath(); g.fill(); g.stroke(); }
    }
    if (tier === 'boss' && S.scene === 'playground') { g.fillStyle = INK; for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * 4 * s, -5 * s); g.lineTo(sx * 10 * s, -15 * s); g.lineTo(sx * 7 * s, -3 * s); g.closePath(); g.fill(); } }
    g.fillStyle = boneColor(); g.strokeStyle = INK; g.lineWidth = 2 * s;
    g.beginPath(); g.arc(0, 0, 7.5 * s, 0, Math.PI * 2); g.fill(); g.stroke();
    roundRect(-4.2 * s, 3 * s, 8.4 * s, 6 * s, 1.5 * s); g.fill(); g.stroke();
    g.fillStyle = INK;
    g.beginPath(); g.arc(-3 * s, -0.8 * s, 2.3 * s, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(3 * s, -0.8 * s, 2.3 * s, 0, Math.PI * 2); g.fill();
    g.fillStyle = isFire() ? '#ffb03a' : tier === 'boss' ? '#ff4d5e' : isIce() ? '#6fd3ff' : S.scene === 'ocean' ? '#7ff3e6' : SLIME;
    g.beginPath(); g.arc(-3 * s, -0.8 * s, 0.9 * s, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(3 * s, -0.8 * s, 0.9 * s, 0, Math.PI * 2); g.fill();
    if (S.scene === 'ocean') {
      // 眼罩和海盜帽
      g.fillStyle = INK; g.beginPath(); g.arc(-3 * s, -0.8 * s, 2.8 * s, 0, Math.PI * 2); g.fill();
      g.strokeStyle = INK; g.lineWidth = 0.9 * s; g.beginPath(); g.moveTo(-7 * s, -4 * s); g.lineTo(6.5 * s, 2.5 * s); g.stroke();
      const B = tier === 'boss' ? 1.25 : 1;
      g.fillStyle = '#1b1b22'; g.beginPath(); g.moveTo(-11 * s * B, -4 * s); g.quadraticCurveTo(0, -1 * s, 11 * s * B, -4 * s); g.quadraticCurveTo(7 * s, -15 * s * B, 0, -13 * s * B); g.quadraticCurveTo(-7 * s, -15 * s * B, -11 * s * B, -4 * s); g.closePath(); g.fill();
      g.strokeStyle = '#d4a72c'; g.lineWidth = 0.8 * s; g.stroke();
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(0, -8.5 * s * B, 1.6 * s, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
  function drawSkullBody(a, j, s) {
    curFoe = a;
    const gl = foe().glow;
    if (a.tier !== 'small') { g.shadowColor = a.tier === 'boss' && S.scene === 'playground' ? 'rgba(255,77,94,.9)' : 'rgba(' + gl.join(',') + ',.95)'; g.shadowBlur = 18; }
    else if (S.scene !== 'playground') { g.shadowColor = 'rgba(' + gl.join(',') + ',.8)'; g.shadowBlur = 8; }
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
    if (S.scene === 'ninja') oniGear(a, j, s);
    else if (S.scene === 'ocean') pirateGear(a, j, s);
    else if (isIce()) iceGear(a, j, s);
    else if (isFire()) fireGear(a, j, s);
    else if (isZombie()) zombieGear(a, j, s);
    else if (S.scene === 'sanguo') { g.save(); g.shadowBlur = 0; const [x, y] = j.rH; g.strokeStyle = '#6b3f1f'; g.lineWidth = 2 * s; g.beginPath(); g.moveTo(x, y + 12 * s); g.lineTo(x, y - 34 * s); g.stroke(); g.fillStyle = '#c9d1dc'; g.beginPath(); g.moveTo(x - 2 * s, y - 34 * s); g.lineTo(x, y - 44 * s); g.lineTo(x + 2 * s, y - 34 * s); g.closePath(); g.fill(); g.beginPath(); g.moveTo(x, y - 30 * s); g.quadraticCurveTo(x + a.f * 9 * s, y - 33 * s, x + a.f * 8 * s, y - 24 * s); g.lineTo(x, y - 26 * s); g.closePath(); g.fill(); g.restore(); }
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

  // 所有泡泡最後一起畫：重要的先放，位置重疊就往上移，真的放不下的閒聊就不畫
  function drawBubbles() {
    const list = agents.filter(a => a.bubbleAt && a.say && a.say.until > T)
      .sort((x, y) => (y.say.lv || 0) - (x.say.lv || 0) || x.say.until - y.say.until);
    const placed = [];
    g.font = '700 13px ' + FONT;
    for (const a of list) {
      const w = g.measureText(a.say.text).width + 16;
      const [ax, ay] = a.bubbleAt;
      let r = null, k = 0;
      for (; k < 4 && !r; k++) {
        const c = [clamp(ax - w / 2, 4, W - w - 4), ay - 22 - k * 26, w, 22];
        if (!placed.some(q => c[0] < q[0] + q[2] + 4 && q[0] < c[0] + c[2] + 4 && c[1] < q[1] + q[3] + 2 && q[1] < c[1] + c[3] + 2)) r = c;
      }
      if (!r) { if ((a.say.lv || 0) < 2) continue; r = [clamp(ax - w / 2, 4, W - w - 4), ay - 22, w, 22]; k = 1; }
      placed.push(r);
      if (k > 1) { g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(ax, ay - 2); g.lineTo(clamp(ax, r[0] + 8, r[0] + r[2] - 8), r[1] + 22); g.stroke(); }
      g.fillStyle = '#ffffff'; g.strokeStyle = INK; g.lineWidth = 1.5;
      roundRect(r[0], r[1], r[2], 22, 9); g.fill(); g.stroke();
      g.fillStyle = INK; g.fillText(a.say.text, r[0] + 8, r[1] + 15.5);
    }
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
    drawScene();
    for (const G of groups) if (G.def.under) G.def.under(G);
    drawStairs();
    for (let i = 0; i < S.tower; i++) { g.fillStyle = (S.towerColors || [])[i] || '#f6c344'; g.strokeStyle = INK; g.lineWidth = 2; roundRect(towerX - 14, FLOOR - (i + 1) * 28, 28, 28, 4); g.fill(); g.stroke(); }
    // 右下角：骷髏區
    const grd = g.createRadialGradient(pit.x2, FLOOR, 10, pit.x2, FLOOR, pit.x2 - pit.x1 + 60);
    const PC = foe().glow.join(',');
    grd.addColorStop(0, 'rgba(' + PC + ',0.35)'); grd.addColorStop(0.6, 'rgba(' + PC + ',0.12)'); grd.addColorStop(1, 'rgba(' + PC + ',0)');
    g.fillStyle = grd; g.fillRect(pit.x1 - 60, FLOOR - 260, pit.x2 - pit.x1 + 70, 300);
    g.fillStyle = foe().ground; g.beginPath(); g.ellipse((pit.x1 + pit.x2) / 2, FLOOR + 6, (pit.x2 - pit.x1) / 2, 12, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = foe().drip;
    for (let i = 0; i < 6; i++) { const ph = (T * 1.3 + i * 0.37) % 1; g.globalAlpha = 1 - ph; g.beginPath(); g.arc(pit.x1 + 20 + i * (pit.x2 - pit.x1 - 40) / 5, FLOOR - ph * 18, 3 + ph * 5, 0, Math.PI * 2); g.fill(); }
    g.globalAlpha = 1;
    g.font = '900 14px ' + FONT; g.fillStyle = foe().label || foe().drip; g.textAlign = 'center';
    g.fillText(foe().pit, (pit.x1 + pit.x2) / 2, FLOOR + 26);
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
      else if (p.kind === 'plane') { g.font = '18px ' + FONT; g.fillText('✈️', p.x - 9, p.y); }
      else if (p.kind === 'snow') { g.fillStyle = '#ffffff'; g.beginPath(); g.arc(p.x, p.y, 2.5, 0, Math.PI * 2); g.fill(); }
      else if (p.kind === 'crumb') { g.fillStyle = '#d4a056'; g.fillRect(p.x, p.y, 3, 3); }
      else if (p.kind === 'ash') { g.globalAlpha = Math.min(1, a * 1.5); g.fillStyle = p.c; g.fillRect(p.x, p.y, 2.6, 2.6); g.globalAlpha = 1; }
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
      if (p.kind === 'bone' || p.kind === 'block' || p.kind === 'drop' || p.kind === 'crumb' || p.kind === 'snow') p.vy += GRAV * 0.8 * dt;
      if (p.kind === 'ash') { p.vy += GRAV * 0.25 * dt; if (p.y > FLOOR) { p.y = FLOOR; p.vy = 0; p.vx *= 0.8; } }
      if (p.kind === 'plane') { p.vy = 18 + Math.sin(p.life * 4) * 30; }
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
          killSkull(s); S.defeated = true; S.defeatedAt = T;
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
    // 第一格的時間可能比 last 早，不能是負的
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now; T += dt;
    // 任何一格出錯都只跳過那一格，動畫不會整個停住
    const safe = (fn, label) => { try { fn(); } catch (e) { if (!safe.seen) { safe.seen = true; console.error('動畫錯誤（' + label + '）', e && e.stack || e); } } };
    agents = agents.filter(a => !a.gone);
    safe(() => stepGroups(dt), 'groups');
    for (const a of [...agents]) safe(() => update(a, dt), 'update ' + a.kind + ' ' + a.act.type);
    if (S.hunts.length) safe(() => updateHunts(dt), 'hunt');
    safe(() => updateParts(dt), 'parts');
    safe(drawWorld, 'world');
    const order = [...agents].sort((x, y) => (x.kind === 'skull') - (y.kind === 'skull'));
    for (const a of order) safe(() => { g.save(); drawAgent(a); g.restore(); }, 'draw ' + a.kind + ' ' + a.act.type + ' s=' + a.s);
    safe(drawGroups, 'drawGroups');
    safe(drawParts, 'drawParts');
    safe(drawBubbles, 'bubbles');
    requestAnimationFrame(frame);
  }

  function chips() { /* 正式網站不顯示狀態列 */ }
  function setup() {
    agents = []; parts = []; balls = []; groups = [];
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
  window.NiceBattle = { sync, dragon: () => startDragon(), scene: (id, quiet) => setScene(id, quiet), scenes: () => SCENES.map(x => ({ id: x.id, label: x.label.replace(/ /g, '') })), activity: id => !!startActivity(id), patrol: () => skullPatrol(), raid: () => startRaid(), debug: () => ({ scene: S.scene, groups: groups.map(G => G.kind + ':' + G.phase), hunts: S.hunts.length, kids: kids().length, free: kids().filter(freeKid).length, floor: kids().filter(k => k.surf === 'floor').length }), pos: () => kids().map(k => ({ n: k.num, x: Math.round(k.x), y: Math.round(k.y), F: Math.round(FLOOR), vy: Math.round(k.vy), surf: k.surf, air: k.air, act: k.act.type, t: Math.round((k.act.t || 0) * 10) / 10, hid: !!k.hidden })) };

  // 偶爾有人邊走邊滑手機，掉進綠池（大約每 2 分鐘一次）；骷髏偶爾出來亂抓人（抓到沒有缺交的會放回來）
  // 骷髏大約每 15～30 秒走出骷髏區抓一個人；沒有缺交的人被抓進籠子，過一下會自己跑出來
  // 骷髏大軍：第一次大約 2 分鐘後，之後每 3～5 分鐘一次
  // 場景由老師在操場左下角的選單手動切換（存在雲端，全班螢幕跟著換）；骷髏大約每 35～60 秒出來散步
  let nextDragon = 0, nextClumsy = 90, nextRandomHunt = rand(10, 20), nextRaid = rand(100, 160), nextPatrol = rand(25, 40);
  setInterval(() => {
    if (!running) return;
    if (Math.random() < 0.7) startActivity();
    if (T > nextPatrol) nextPatrol = T + (skullPatrol() ? rand(35, 60) : 8);
    if (S.scene === 'icefire' && T > nextDragon) nextDragon = T + (startDragon() ? rand(20, 35) : 5);
    patrolScare();
    if (!S.hunting && T - narrAt > 25 && !narrQueue.length) narrate(pick(SCENE_AMBIENT[S.scene] && Math.random() < 0.6 ? SCENE_AMBIENT[S.scene] : AMBIENT));
    if (T > nextRaid) nextRaid = T + (startRaid() ? rand(180, 300) : 15);
    if (T > nextClumsy) { if (clumsy()) nextClumsy = T + rand(100, 160); else nextClumsy = T + 10; }
    if (S.defeated && T - (S.defeatedAt || 0) > 300 && !S.hunting) { S.defeated = false; rebuildSkulls(true); if (skulls().length) banner('💀 骷髏又拼回來了！'); }
    if (T > nextRandomHunt) {
      // 沒有完整的骷髏（逾期不到 3 份或剛被打散）、有人正在被抓：3 秒後再試
      const ok = !S.huntQueue.length && !S.hunting && startHunt();
      nextRandomHunt = T + (ok ? rand(15, 30) : 3);
    }
  }, 2000);

  // 大熊老師走到骷髏區前面才殺球
  const baseArrive = onArrive;
  onArrive = function (a) {
    if (a.kind === 'bear' && a.goal && a.goal.then === 'spike') { a.goal = null; a.f = 1; startSkill(a, 'spike', true); return; }
    if (a.kind === 'skull' && a.goal && a.goal.then === 'patrolEnd') {
      a.goal = null; a.f = Math.random() < 0.5 ? 1 : -1; setAct(a, 'idle', { dur: 0.2 });
      say(a, pick(['嘿嘿…有人嗎？', '作業交了沒…', '咔咔咔…']), 1.6);
      setTimeout(() => endPatrol(a), 2600);
      return;
    }
    if (a.kind === 'skull' && a.goal && a.goal.then === 'vanish') {
      a.goal = null; a.gone = true;
      for (let k = 0; k < 8; k++) parts.push({ kind: 'puff', x: a.x + rand(-14, 14), y: FLOOR - rand(4, 40), vx: rand(-20, 20), vy: rand(-50, -10), life: 0.9, max: 0.9 });
      return;
    }
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
  sceneSel = document.createElement('select');
  sceneSel.id = 'sceneSelect'; sceneSel.className = 'teacher-only'; sceneSel.title = '切換布景主題（全班螢幕一起換）';
  for (const sc of SCENES) { const o = document.createElement('option'); o.value = sc.id; o.textContent = '🎨 ' + sc.label.replace(/ /g, ''); sceneSel.appendChild(o); }
  sceneSel.value = S.scene;
  sceneSel.onchange = () => {
    const id = sceneSel.value, prev = S.scene;
    setScene(id);
    if (typeof window.saveBattleScene === 'function') window.saveBattleScene(id).catch(() => { setScene(prev, true); });
  };
  ground.appendChild(sceneSel);
  function checkSize() {
    const small = window.innerWidth < 768;
    const on = !small && !isOff();
    toggle.textContent = isOff() ? '🎮 打開操場動畫' : '🎮 關掉操場動畫';
    ground.classList.toggle('battle-on', on);
    cv.style.display = on ? 'block' : 'none';
    if (!on) {
      if (running) { recallAll(); running = false; agents = []; parts = []; balls = []; S.hunting = null; S.raid = null; S.patrol = null; S.huntQueue = []; groups = []; }
      applySceneDom();
      return;
    }
    if (!DATA) return;              // 等看板資料讀到再開始
    measure();
    if (!agents.length) setup();
    if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); applySceneDom(); }
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
