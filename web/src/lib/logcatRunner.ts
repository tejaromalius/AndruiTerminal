/** Logcat Runner: the hidden endless-runner easter egg. Pure canvas, no device or backend access. */

const W = 720;
const H = 280;
const G = 232;
const PX = 70;
const BEST_KEY = 'andrui_logcat_runner_best';
const CODES = ['NPE', 'OOM', 'DEAD', 'SEC', 'CCE'];
const NAMES = ['Lollipop', 'Marshmallow', 'Nougat', 'Oreo', 'Pie', 'Android 10', 'Android 11', 'Android 12', 'Android 13', 'Android 14', 'Android 15'];

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB;
// Per level: sky top, sky bottom, far layer, mid layer, accent (sun/moon, windows).
const PAL: RGB[][] = [
  ['#0b0f14', '#16263f', '#1b2d4d', '#0e182b', '#cfe3ff'],
  ['#170b26', '#3b1553', '#2f1749', '#1a0b2c', '#ffb4e6'],
  ['#06140e', '#0e3a24', '#10331f', '#08180f', '#8affb8'],
  ['#26110a', '#7a3a16', '#55280f', '#2b1409', '#ffd27a'],
  ['#061a1c', '#0e4a52', '#0d3d44', '#07252b', '#b4fff6'],
  ['#1c0b12', '#5a1630', '#3e1023', '#210812', '#ff9ea8'],
].map(r => r.map(hex));
const rgb = (a: RGB, al = 1) => `rgba(${a[0] | 0},${a[1] | 0},${a[2] | 0},${al})`;
const PU = {
  su: { n: 'SHIELD', c: '#d2a8ff' },
  adb: { n: 'MAGNET', c: '#58a6ff' },
  doze: { n: 'SLOW-MO', c: '#39d0c8' },
} as const;
type PuKind = keyof typeof PU;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

interface Obstacle { k: 'g' | 't' | 'f'; x: number; w: number; h: number; t: string; ph: number; passed?: boolean }
interface Coin { x: number; y: number; hit?: boolean }
interface Pickup { x: number; y: number; k: PuKind; hit?: boolean }
interface Particle { x: number; y: number; vx: number; vy: number; l: number; l0: number; col: string; r: number; g: number }
interface Popup { x: number; y: number; t: string; col: string; l: number }
interface Ghost { y: number; l: number }
interface Banner { t: number; a: string; b: string }
interface Game {
  y: number; vy: number; jumps: number; short: boolean; duck: boolean; duckAmt: number; land: number; flip: number;
  dustT: number; tTrail: number; score: number; dist: number; speed: number; level: number; banner: Banner;
  obs: Obstacle[]; items: Coin[]; pups: Pickup[]; parts: Particle[]; pop: Popup[]; trail: Ghost[];
  next: number; combo: number; comboT: number; shield: boolean; inv: number; magnet: number; slow: number;
  shake: number; flash: number; flashCol: string; wave: number; t: number; seen: { f: number; t: number };
  over: boolean; pal: RGB[];
  stars: { x: number; y: number; s: number; p: number }[];
  rain: { x: number; y: number; v: number; s: number }[];
  streaks: { x: number; y: number; l: number }[];
}
type Mode = 'start' | 'play' | 'pause' | 'over';

export interface RunnerHandle {
  /** Re-fit the backing store after the canvas CSS size changed (resize, fullscreen). */
  resize(): void;
  pause(): void;
  destroy(): void;
}

const loadBest = (): number => {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
};
const saveBest = (v: number) => {
  try { localStorage.setItem(BEST_KEY, String(Math.floor(v))); } catch { /* storage unavailable */ }
};

export const startLogcatRunner = (canvas: HTMLCanvasElement): RunnerHandle => {
  const g = canvas.getContext('2d');
  if (!g) return { resize() {}, pause() {}, destroy() {} };

  let hi = loadBest();
  let st: Mode = 'start';
  let keyDown = false;
  let duckHeld = false;
  let muted = false;
  let au: AudioContext | undefined;
  let raf = 0;
  let S: Game;

  const beep = (f: number, d: number, t: OscillatorType = 'square', v = 0.04) => {
    if (muted) return;
    try {
      au = au || new AudioContext();
      const o = au.createOscillator();
      const a = au.createGain();
      o.type = t; o.frequency.value = f; a.gain.value = v;
      o.connect(a); a.connect(au.destination); o.start();
      a.gain.exponentialRampToValueAtTime(0.0001, au.currentTime + d);
      o.stop(au.currentTime + d);
    } catch { /* audio unavailable */ }
  };

  const banner = (lv: number): Banner => ({ t: 2.6, a: `LEVEL ${lv + 1}`, b: `API ${21 + lv * 2} · ${NAMES[lv] || 'Android ∞'}` });

  const reset = () => {
    S = {
      y: G, vy: 0, jumps: 2, short: false, duck: false, duckAmt: 0, land: 0, flip: 0, dustT: 0, tTrail: 0, score: 0, dist: 0, speed: 300,
      level: 0, banner: banner(0), obs: [], items: [], pups: [], parts: [], pop: [], trail: [], next: 500, combo: 1, comboT: 0,
      shield: false, inv: 0, magnet: 0, slow: 0, shake: 0, flash: 0, flashCol: '255,255,255', wave: 0, t: 0, seen: { f: 0, t: 0 },
      over: false, pal: PAL[0].map(a => [...a] as RGB),
      stars: Array.from({ length: 40 }, () => ({ x: rnd(0, W), y: rnd(0, G - 60), s: rnd(0.8, 2), p: rnd(0, 6) })),
      rain: Array.from({ length: 20 }, () => ({ x: rnd(0, W), y: rnd(-100, G), v: rnd(40, 110), s: rnd(0, 9) | 0 })),
      streaks: Array.from({ length: 9 }, () => ({ x: rnd(0, W), y: rnd(10, G - 10), l: rnd(30, 80) })),
    };
  };

  const burst = (x: number, y: number, col: string, n: number, o: { vx?: [number, number]; vy?: [number, number]; g?: number; r?: number } = {}) => {
    for (let i = 0; i < n; i++) {
      const l = rnd(0.3, 0.8);
      S.parts.push({ x, y, vx: rnd(...(o.vx || [-160, 160])), vy: rnd(...(o.vy || [-220, 60])), l, l0: l, col, r: o.r || rnd(2, 4), g: o.g ?? 600 });
    }
  };
  const pop = (x: number, y: number, t: string, col: string) => { S.pop.push({ x, y, t, col, l: 0.9 }); };

  const jump = () => {
    if (st === 'start' || st === 'over') { reset(); st = 'play'; return; }
    if (st === 'pause') { st = 'play'; return; }
    if (S.jumps > 0) {
      const dbl = S.y < G;
      S.vy = dbl ? -520 : -580; S.jumps--; S.short = false;
      if (dbl) S.flip = 0.4;
      burst(PX + 12, S.y, dbl ? '#58a6ff' : '#8b949e', dbl ? 12 : 6, { vx: [-90, 90], vy: [-30, 60], g: 200 });
      beep(dbl ? 620 : 440, 0.08);
    }
  };
  const release = () => { if (S.vy < -250 && !S.short) { S.vy *= 0.5; S.short = true; } };

  const onKeyDown = (e: KeyboardEvent) => {
    if ([' ', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault();
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w') { keyDown = true; jump(); }
    else if (e.key === 'ArrowDown' || e.key === 's') duckHeld = true;
    else if (e.key === 'p') { if (st === 'play') st = 'pause'; else if (st === 'pause') st = 'play'; }
    else if (e.key === 'm') muted = !muted;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w') { keyDown = false; release(); }
    else if (e.key === 'ArrowDown' || e.key === 's') duckHeld = false;
  };
  const onPointerDown = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if ((e.clientY - r.top) / r.height > 0.6 && st === 'play') duckHeld = true; else { keyDown = true; jump(); }
  };
  const onPointerUp = () => { duckHeld = false; if (keyDown) { keyDown = false; release(); } };
  const onVisibility = () => { if (document.hidden && st === 'play') st = 'pause'; };

  const spawn = () => {
    const lv = S.level;
    const pool = ['g', 'g'];
    if (lv >= 1) pool.push('f', 'f');
    if (lv >= 2) pool.push('t');
    if (lv >= 3) pool.push('gg');
    const k = pool[Math.random() * pool.length | 0];
    const x = W + 40;
    const mkG = (gx: number): Obstacle => ({ k: 'g', x: gx, w: rnd(54, 80), h: rnd(22, 40), t: `E/${CODES[Math.random() * 5 | 0]}`, ph: 0 });
    const ob: Obstacle[] = [];
    let width = 60;
    if (k === 'g') ob.push(mkG(x));
    else if (k === 'gg') { const a = mkG(x); const b = mkG(x + a.w + rnd(120, 160)); ob.push(a, b); width = b.x + b.w - x; }
    else if (k === 't') ob.push({ k: 't', x, w: 44, h: 100, t: 'F/ FATAL', ph: 0 });
    else ob.push({ k: 'f', x, w: 76, h: 24, t: 'W/ ANR', ph: rnd(0, 6) });
    S.obs.push(...ob);
    const o = ob[0];
    if (Math.random() < 0.75) {
      // Coins span the obstacle's own width, arcing over it (or on the ground under a flyer).
      const n = Math.min(6, Math.max(3, Math.floor((o.w + 20) / 22) + 1));
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1);
        const cx = o.x - 10 + f * (o.w + 20);
        if (k === 'f') {
          // Flyers outrun the scenery (x1.25), so shift the row to arrive under the flyer, not behind it.
          S.items.push({ x: PX + (cx - PX) / 1.25, y: G - 14 });
        } else {
          S.items.push({ x: cx, y: G - o.h - 18 - Math.sin(f * Math.PI) * (k === 't' ? 35 : 45) });
        }
      }
    }
    if (Math.random() < 0.1) S.pups.push({ x: x + width + S.speed * 0.45, y: G - rnd(50, 90), k: (['su', 'adb', 'doze'] as PuKind[])[Math.random() * 3 | 0] });
    S.next = width + S.speed * (0.75 + Math.random() * 0.6);
  };

  const hurt = (o: Obstacle) => {
    if (S.shield) {
      S.shield = false; S.inv = 1; S.flash = 0.35; S.flashCol = '210,168,255';
      burst(PX + 12, S.y - 15, '#d2a8ff', 26); pop(PX + 12, S.y - 50, 'BLOCKED!', '#d2a8ff'); beep(180, 0.2, 'sawtooth');
      S.obs = S.obs.filter(q => q !== o);
      return;
    }
    S.over = true; st = 'over'; S.shake = 0.4; S.flash = 0.6; S.flashCol = '255,255,255';
    burst(PX + 12, S.y - 15, '#3ddc84', 44); beep(110, 0.5, 'sawtooth', 0.07);
    if (S.score > hi) { hi = S.score; saveBest(hi); }
  };

  const ambient = (dt: number) => {
    S.t += dt;
    S.flash = Math.max(0, S.flash - dt * 2); S.wave = Math.max(0, S.wave - dt * 0.8); S.shake = Math.max(0, S.shake - dt);
    const tp = PAL[S.level % 6];
    const k = Math.min(1, dt * 1.5);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) S.pal[i][j] += (tp[i][j] - S.pal[i][j]) * k;
    for (const q of S.parts) { q.x += q.vx * dt; q.y += q.vy * dt; q.vy += q.g * dt; q.l -= dt; }
    S.parts = S.parts.filter(q => q.l > 0);
    for (const p of S.pop) { p.y -= 36 * dt; p.l -= dt; }
    S.pop = S.pop.filter(p => p.l > 0);
    for (const r of S.rain) { r.y += r.v * dt; if (r.y > G + 60) { r.y = -70; r.x = rnd(0, W); r.v = rnd(40, 110); } }
    for (const q of S.trail) q.l -= dt;
    S.trail = S.trail.filter(q => q.l > 0);
    S.land = Math.max(0, S.land - dt); S.flip = Math.max(0, S.flip - dt);
    S.duckAmt += ((duckHeld && S.y >= G && !S.over ? 1 : 0) - S.duckAmt) * Math.min(1, dt * 18);
    S.banner.t -= dt;
  };

  const update = (dt: number) => {
    const ts = S.slow > 0 ? 0.65 : 1;
    const d = dt * ts;
    ambient(dt);
    const target = Math.min(720, 300 + S.level * 28);
    S.speed += (target - S.speed) * Math.min(1, dt * 0.8);
    S.dist += S.speed * d; S.score += S.speed * d / 30;
    const lv = Math.floor(S.score / 400);
    if (lv > S.level) {
      S.level = lv; S.banner = banner(lv); S.wave = 1; S.flash = 0.25; S.flashCol = '255,255,255';
      beep(660, 0.15); window.setTimeout(() => beep(880, 0.2), 120);
    }
    // player
    const was = S.y < G;
    S.duck = duckHeld && S.y >= G;
    S.vy += 1700 * d + (duckHeld && S.y < G ? 3200 * d : 0); S.y += S.vy * d;
    if (S.y >= G) {
      if (was && S.vy > 250) {
        S.land = 0.18;
        burst(PX + 12, G - 2, '#8b949e', 8, { vx: [-110, 110], vy: [-50, -5], g: -30, r: 3 });
        beep(150, 0.05, 'triangle', 0.03);
      }
      S.y = G; S.vy = 0; S.jumps = 2;
    } else if (S.jumps === 2) S.jumps = 1;
    if (S.y >= G && !S.duck) {
      S.dustT -= dt;
      if (S.dustT <= 0) { S.dustT = 0.08; S.parts.push({ x: PX + 4, y: G - 2, vx: -S.speed * 0.35, vy: rnd(-30, -5), l: 0.35, l0: 0.35, col: '#8b949e', r: rnd(2, 3.5), g: -10 }); }
    }
    S.tTrail -= dt;
    if ((S.slow > 0 || S.magnet > 0 || S.speed > 480) && S.tTrail <= 0) { S.tTrail = 0.04; S.trail.push({ y: S.y, l: 0.25 }); }
    S.inv = Math.max(0, S.inv - dt); S.magnet = Math.max(0, S.magnet - dt); S.slow = Math.max(0, S.slow - dt); S.comboT -= dt;
    if (S.comboT <= 0) S.combo = 1;
    // world
    S.next -= S.speed * d;
    if (S.next <= 0) spawn();
    const mv = S.speed * d;
    for (const o of S.obs) {
      o.x -= mv * (o.k === 'f' ? 1.25 : 1);
      if (o.k === 'f') {
        o.ph += dt * 4;
        if (Math.random() < dt * 20) S.parts.push({ x: o.x + o.w, y: G - 36 + Math.sin(o.ph) * 6, vx: rnd(0, 60), vy: rnd(-20, 20), l: 0.4, l0: 0.4, col: '#d29922', r: 2, g: 0 });
      }
      if (o.k === 't' && Math.random() < dt * 10) S.parts.push({ x: o.x + rnd(0, o.w), y: G - o.h - 4, vx: rnd(-20, 20), vy: -60, l: 0.5, l0: 0.5, col: '#ff7b72', r: 2, g: 0 });
      if (!o.passed && o.x + o.w < PX) { o.passed = true; if (o.k === 'f' || o.k === 't') S.seen[o.k]++; }
    }
    for (const i of S.items) i.x -= mv;
    for (const p of S.pups) p.x -= mv;
    for (const s of S.streaks) { s.x -= S.speed * 1.8 * d; if (s.x < -100) { s.x = W + rnd(0, 200); s.y = rnd(10, G - 10); s.l = rnd(30, 80); } }
    S.obs = S.obs.filter(o => o.x + o.w > -20);
    S.items = S.items.filter(i => i.x > -50);
    S.pups = S.pups.filter(p => p.x > -90);
    // collisions
    const ph = S.duck ? 16 : 30;
    const px = PX + 4;
    const pw = 18;
    const py = S.y - ph;
    for (const o of S.obs) {
      const top = o.k === 'f' ? G - 48 + Math.sin(o.ph) * 6 : G - o.h - 2;
      const bot = o.k === 'f' ? top + 24 : G;
      if (px + pw > o.x + 4 && px < o.x + o.w - 4 && py + ph > top + 3 && py < bot - 3 && S.inv <= 0) { hurt(o); if (S.over) return; break; }
    }
    const cxp = px + pw / 2;
    const cyp = py + ph / 2;
    for (const i of S.items) {
      if (S.magnet > 0) {
        const dx = cxp - i.x, dy = cyp - i.y, dd = Math.hypot(dx, dy);
        if (dd < 220) { i.x += dx / dd * 520 * dt; i.y += dy / dd * 520 * dt; }
      }
      if (Math.abs(i.x - cxp) < 20 && Math.abs(i.y - cyp) < ph / 2 + 10) {
        i.hit = true; S.combo = S.comboT > 0 ? Math.min(5, S.combo + 1) : 1; S.comboT = 1.6; S.score += 10 * S.combo;
        burst(i.x, i.y, '#3fb950', 6, { vx: [-90, 90], vy: [-120, 0], g: 300, r: 2 });
        if (S.combo > 1) pop(i.x, i.y - 14, `x${S.combo}`, '#e3b341');
        beep(700 + S.combo * 110, 0.06, 'triangle');
      }
    }
    S.items = S.items.filter(i => !i.hit);
    for (const p of S.pups) {
      if (Math.abs(p.x + 36 - cxp) < 44 && Math.abs(p.y - cyp) < ph / 2 + 14) {
        p.hit = true; burst(p.x + 36, p.y, PU[p.k].c, 18); pop(p.x + 36, p.y - 18, `${PU[p.k].n}!`, PU[p.k].c); beep(900, 0.15, 'sine', 0.06);
        if (p.k === 'su') S.shield = true; else if (p.k === 'adb') S.magnet = 8; else S.slow = 6;
      }
    }
    S.pups = S.pups.filter(p => !p.hit);
  };

  // ---------- drawing helpers ----------
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  };
  const mountains = (sc: number, col: string, base: number, amp: number) => {
    g.fillStyle = col; g.beginPath(); g.moveTo(0, G);
    for (let x = 0; x <= W; x += 8) {
      const u = x + sc;
      const n = 0.5 + 0.5 * (Math.sin(u / 110) * 0.55 + Math.sin(u / 47 + 2) * 0.3 + Math.sin(u / 21 + 1) * 0.15);
      g.lineTo(x, base - amp * n);
    }
    g.lineTo(W, G); g.closePath(); g.fill();
  };
  const city = (sc: number, col: string, base: number, hm: number, lit: RGB) => {
    const cell = 58, s = Math.floor(sc / cell);
    for (let i = s; i <= s + Math.ceil(W / cell) + 1; i++) {
      const x = i * cell - sc, bw = 38 + hash(i + 9) * 16, bh = 30 + hash(i + 3) * hm;
      g.fillStyle = col; g.fillRect(x, base - bh, bw, bh);
      for (let r = 0; r < bh - 8; r += 10) for (let q = 0; q < bw - 6; q += 9) {
        if (hash(i * 57 + r * 3.1 + q * 1.7) > 0.62) {
          const tw = hash(i * 13 + r + q + Math.floor(S.t * 0.4)) > 0.9;
          g.fillStyle = rgb(lit, tw ? 0.12 : 0.45); g.fillRect(x + 4 + q, base - bh + r + 4, 4, 5);
        }
      }
    }
  };
  const towers = (sc: number, col: string, base: number) => {
    const cell = 190, s = Math.floor(sc / cell);
    g.lineWidth = 2;
    for (let i = s; i <= s + Math.ceil(W / cell) + 1; i++) {
      const x = i * cell - sc + hash(i) * 60, h = 100 + hash(i + 5) * 70;
      g.strokeStyle = col; g.beginPath(); g.moveTo(x - 16, base); g.lineTo(x, base - h); g.lineTo(x + 16, base);
      for (let y = base - 10; y > base - h + 10; y -= 18) { const w = 16 * (1 - (base - y) / h); g.moveTo(x - w, y); g.lineTo(x + w, y - 9); }
      g.stroke();
      g.fillStyle = ((S.t * 1.4 + hash(i) * 5) % 1) < 0.5 ? '#ff5555' : '#552222'; g.beginPath(); g.arc(x, base - h, 3, 0, 7); g.fill();
      const ph = (S.t * 0.8 + hash(i + 2)) % 1;
      g.strokeStyle = rgb(S.pal[4], 0.3 * (1 - ph)); g.lineWidth = 1.5; g.beginPath(); g.arc(x, base - h, 6 + ph * 26, -2.2, -0.9); g.stroke(); g.lineWidth = 2;
    }
  };
  const racks = (sc: number, col: string, base: number) => {
    const cell = 72, s = Math.floor(sc / cell);
    for (let i = s; i <= s + Math.ceil(W / cell) + 1; i++) {
      const x = i * cell - sc, bh = 50 + hash(i + 4) * 60, bw = 52;
      g.fillStyle = col; g.fillRect(x, base - bh, bw, bh);
      for (let r = 0; r < bh - 10; r += 12) {
        g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x + 4, base - bh + r + 5, bw - 8, 8);
        const on = ((S.t * (1 + hash(i * 9 + r) * 2) + hash(r + i)) % 1) < 0.5;
        g.fillStyle = on ? '#3fb950' : '#1f4d2a'; g.fillRect(x + 8, base - bh + r + 8, 3, 3);
        g.fillStyle = (hash(i + r * 2) > 0.8 && on) ? '#d29922' : '#1f2b3a'; g.fillRect(x + 15, base - bh + r + 8, 3, 3);
      }
    }
  };
  const poles = (sc: number, base: number) => {
    const cell = 260, s = Math.floor(sc / cell);
    g.strokeStyle = 'rgba(0,0,0,.5)';
    let p0: number | null = null;
    for (let i = s; i <= s + Math.ceil(W / cell) + 1; i++) {
      const x = i * cell - sc;
      g.lineWidth = 3; g.beginPath(); g.moveTo(x, base); g.lineTo(x, base - 80); g.moveTo(x - 14, base - 72); g.lineTo(x + 14, base - 72); g.stroke();
      if (p0 !== null) {
        g.lineWidth = 1.5; g.beginPath();
        g.moveTo(p0 - 12, base - 72); g.quadraticCurveTo((p0 + x) / 2, base - 50, x - 12, base - 72);
        g.moveTo(p0 + 12, base - 72); g.quadraticCurveTo((p0 + x) / 2, base - 50, x + 12, base - 72);
        g.stroke();
      }
      p0 = x;
    }
  };
  const droid = (x: number, y: number, al: number, ghost: boolean) => {
    const air = y < G - 1, da = S.duckAmt, ph = S.dist / 16, run = !air && st === 'play';
    const bob = run ? -Math.abs(Math.sin(ph)) * 1.6 : 0;
    let sx = 1, sy = 1, rot = 0;
    if (!ghost) {
      if (S.land > 0) { const k = S.land / 0.18; sy = 1 - 0.22 * k; sx = 1 + 0.2 * k; }
      else if (air) { const k = Math.min(1, Math.abs(S.vy) / 700); sy = 1 + 0.15 * k; sx = 1 - 0.1 * k; }
      rot = S.flip > 0 ? -(1 - S.flip / 0.4) * Math.PI * 2 : (air ? Math.max(-0.25, Math.min(0.35, S.vy / 2500)) : 0);
    }
    g.save(); g.globalAlpha = al; g.translate(x, y - 14); g.rotate(rot); g.translate(0, 14); g.scale(sx, sy);
    const bh = 20 - 12 * da, hr = 12 - 3 * da, bb = -4 + bob, top = bb - bh - hr;
    g.fillStyle = '#3ddc84'; g.strokeStyle = '#3ddc84';
    const l1 = air ? 3 : Math.max(0, Math.sin(ph)) * 3, l2 = air ? 3 : Math.max(0, -Math.sin(ph)) * 3;
    g.fillRect(-8, bb, 5, -bb - l1); g.fillRect(3, bb, 5, -bb - l2);
    g.fillRect(-12, bb - bh, 24, bh); g.beginPath(); g.arc(0, bb - bh, hr, Math.PI, 0); g.fill();
    const sw = run ? Math.sin(ph) * 2.5 : (air ? -2 : 0);
    g.fillRect(-17, bb - bh + 3 + sw, 4, Math.max(5, bh - 8)); g.fillRect(13, bb - bh + 3 - sw, 4, Math.max(5, bh - 8));
    const wag = Math.max(-3, Math.min(3, -S.vy / 400)) + Math.sin(S.t * 10) * (run ? 1 : 0.4);
    g.lineWidth = 2; g.beginPath(); g.moveTo(-7, top + 3); g.lineTo(-10 + wag, top - 6); g.moveTo(7, top + 3); g.lineTo(10 + wag, top - 6); g.stroke();
    if (!ghost) { g.fillStyle = '#000'; const eh = (S.t % 3.2) < 0.12 ? 1 : 3, ey = bb - bh - hr * 0.5; g.fillRect(-6, ey, 3, eh); g.fillRect(3, ey, 3, eh); }
    g.restore();
  };

  const draw = () => {
    const P = S.pal;
    g.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    g.save();
    if (S.shake > 0) g.translate(rnd(-5, 5), rnd(-5, 5));
    // sky
    const gr = g.createLinearGradient(0, 0, 0, G); gr.addColorStop(0, rgb(P[0])); gr.addColorStop(1, rgb(P[1])); g.fillStyle = gr; g.fillRect(-10, -10, W + 20, H + 20);
    for (const s of S.stars) { g.fillStyle = `rgba(255,255,255,${0.15 + 0.35 * Math.abs(Math.sin(S.t * 1.2 + s.p))})`; g.fillRect(s.x, s.y, s.s, s.s); }
    // sun / moon crossing the sky
    const ox = ((W + 160) - ((S.t * 7 + 300) % (W + 160))) - 80, oy = Math.pow((ox / W - 0.5) * 2, 2) * 70 + 40;
    const rg = g.createRadialGradient(ox, oy, 4, ox, oy, 64); rg.addColorStop(0, rgb(P[4], 0.8)); rg.addColorStop(1, rgb(P[4], 0));
    g.fillStyle = rg; g.fillRect(ox - 64, oy - 64, 128, 128);
    g.fillStyle = rgb(P[4], 0.95); g.beginPath(); g.arc(ox, oy, 12, 0, 7); g.fill();
    // parallax layers
    const sty = S.level % 3;
    mountains(S.dist * 0.05, rgb(P[2], 0.9), G - 20, 100);
    if (sty === 0) city(S.dist * 0.16, rgb(P[3]), G, 90, P[4]); else if (sty === 1) towers(S.dist * 0.16, rgb(P[3]), G); else racks(S.dist * 0.16, rgb(P[3]), G);
    poles(S.dist * 0.42, G);
    // faint falling log characters
    g.font = '11px monospace'; g.fillStyle = rgb(P[4], 0.09);
    for (const r of S.rain) for (let k = 0; k < 5; k++) g.fillText('01{}</>/'[(r.s + k) % 8], r.x, r.y - k * 12);
    // speed streaks
    if (S.speed > 380) { g.fillStyle = `rgba(255,255,255,${Math.min(0.14, (S.speed - 380) / 2500)})`; for (const s of S.streaks) g.fillRect(s.x, s.y, s.l, 1); }
    // ground
    g.fillStyle = rgb(P[3]); g.fillRect(0, G, W, H - G);
    g.fillStyle = rgb(P[4], 0.5); g.fillRect(0, G, W, 2);
    g.strokeStyle = rgb(P[4], 0.13); g.lineWidth = 1; g.beginPath();
    for (let x = -(S.dist % 48) - W; x < W * 2; x += 48) { g.moveTo(x, G + 2); g.lineTo(W / 2 + (x - W / 2) * 2.4, H); }
    for (const y of [G + 7, G + 16, G + 29]) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    // obstacles
    g.textAlign = 'center';
    for (const o of S.obs) {
      const pulse = 0.5 + 0.5 * Math.sin(S.t * 6 + o.x * 0.02);
      if (o.k === 'f') {
        const y = G - 48 + Math.sin(o.ph) * 6, fl = Math.abs(Math.sin(S.t * 18));
        g.fillStyle = `rgba(210,153,34,${0.1 + 0.12 * pulse})`; g.fillRect(o.x - 5, y - 5, o.w + 10, 34);
        g.fillStyle = '#d29922';
        g.beginPath(); g.moveTo(o.x + 20, y); g.lineTo(o.x + 46, y); g.lineTo(o.x + 33, y - 4 - 14 * fl); g.fill();
        g.beginPath(); g.moveTo(o.x + 20, y + 24); g.lineTo(o.x + 46, y + 24); g.lineTo(o.x + 33, y + 28 + 8 * fl); g.fill();
        rr(o.x, y, o.w, 24, 8); g.fill(); g.fillStyle = '#000'; g.font = 'bold 12px monospace'; g.fillText(o.t, o.x + o.w / 2, y + 16);
        if (S.seen.f < 3 && o.x < W - 30 && o.x > PX + 30) { g.fillStyle = '#d29922'; g.fillText('▼ DUCK', o.x + o.w / 2, y - 24); }
      } else {
        const col = o.k === 't' ? '#ff7b72' : '#f85149';
        g.fillStyle = `rgba(248,81,73,${0.1 + 0.12 * pulse})`; g.fillRect(o.x - 5, G - o.h - 10, o.w + 10, o.h + 10);
        g.fillStyle = col; g.beginPath(); g.moveTo(o.x, G); g.lineTo(o.x, G - o.h);
        for (let xx = o.x; xx < o.x + o.w; xx += 10) { g.lineTo(Math.min(xx + 5, o.x + o.w), G - o.h - 6); g.lineTo(Math.min(xx + 10, o.x + o.w), G - o.h); }
        g.lineTo(o.x + o.w, G); g.closePath(); g.fill();
        g.fillStyle = 'rgba(0,0,0,.18)'; for (let yy = G - o.h + 6; yy < G; yy += 8) g.fillRect(o.x, yy, o.w, 2);
        g.fillStyle = '#fff'; g.font = 'bold 12px monospace';
        const jx = Math.random() < 0.04 ? rnd(-2, 2) : 0;
        if (o.k === 't') {
          g.save(); g.translate(o.x + o.w / 2 + jx, G - o.h / 2); g.rotate(-Math.PI / 2); g.fillText(o.t, 0, 4); g.restore();
          if (S.seen.t < 3 && o.x < W - 30 && o.x > PX + 30) { g.fillStyle = '#ff7b72'; g.fillText('▲▲ DOUBLE JUMP', o.x + o.w / 2, G - o.h - 18); }
        } else g.fillText(o.t, o.x + o.w / 2 + jx, G - o.h / 2 + 4);
      }
    }
    // coins
    for (const i of S.items) {
      const by = i.y + Math.sin(S.t * 4 + i.x * 0.03) * 3, sx = Math.max(0.25, Math.abs(Math.cos(S.t * 5 + i.x * 0.05)));
      g.fillStyle = 'rgba(63,185,80,.18)'; g.beginPath(); g.arc(i.x, by, 11, 0, 7); g.fill();
      g.fillStyle = '#3fb950'; g.beginPath(); g.ellipse(i.x, by, 7 * sx, 7, 0, 0, 7); g.fill();
      g.fillStyle = '#8ae89a'; g.beginPath(); g.ellipse(i.x, by, 4 * sx, 4, 0, 0, 7); g.fill();
    }
    // power-ups
    for (const p of S.pups) {
      const u = PU[p.k], by = p.y + Math.sin(S.t * 3 + p.x * 0.02) * 4;
      g.fillStyle = `${u.c}33`; g.beginPath(); g.arc(p.x + 36, by, 30 + 3 * Math.sin(S.t * 6), 0, 7); g.fill();
      g.fillStyle = u.c; rr(p.x, by - 11, 72, 22, 11); g.fill(); g.fillStyle = '#000'; g.font = 'bold 11px monospace'; g.fillText(u.n, p.x + 36, by + 4);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(p.x + 36 + Math.cos(S.t * 4) * 38, by + Math.sin(S.t * 4) * 16, 2, 0, 7); g.fill();
    }
    // ghost trail
    for (const q of S.trail) droid(PX + 12 - (0.25 - q.l) * S.speed * 0.6, q.y, q.l * 1.2, true);
    // player
    if (!(S.inv > 0 && Math.floor(S.t * 20) % 2) && st !== 'over') {
      droid(PX + 12, S.y, 1, false);
      const cy = S.y - 16;
      if (S.shield) {
        g.save(); g.translate(PX + 12, cy); g.fillStyle = 'rgba(210,168,255,.08)'; g.beginPath(); g.arc(0, 0, 27, 0, 7); g.fill();
        g.rotate(S.t * 2); g.setLineDash([8, 6]); g.strokeStyle = '#d2a8ff'; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, 27, 0, 7); g.stroke(); g.restore(); g.setLineDash([]);
      }
      if (S.magnet > 0) {
        g.strokeStyle = '#58a6ff'; g.lineWidth = 1.5;
        for (let k = 0; k < 2; k++) { const u = (S.t * 1.2 + k * 0.5) % 1; g.globalAlpha = 0.5 * (1 - u); g.beginPath(); g.arc(PX + 12, cy, 20 + u * 60, 0, 7); g.stroke(); }
        g.globalAlpha = 1;
      }
    }
    // particles
    for (const q of S.parts) { g.globalAlpha = Math.max(0, q.l / q.l0); g.fillStyle = q.col; const r = q.r * (0.4 + 0.6 * q.l / q.l0); g.fillRect(q.x - r / 2, q.y - r / 2, r, r); }
    g.globalAlpha = 1;
    g.restore();
    // screen effects
    if (S.slow > 0) {
      g.fillStyle = 'rgba(57,208,200,.07)'; g.fillRect(0, 0, W, H);
      const vg = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,20,30,.45)');
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }
    if (S.wave > 0) { g.strokeStyle = rgb(P[4], S.wave * 0.6); g.lineWidth = 3; g.beginPath(); g.arc(PX + 12, S.y - 16, (1 - S.wave) * 560, 0, 7); g.stroke(); }
    if (S.flash > 0) { g.fillStyle = `rgba(${S.flashCol},${Math.min(0.5, S.flash)})`; g.fillRect(0, 0, W, H); }
    // popups
    g.font = 'bold 14px monospace'; g.textAlign = 'center';
    for (const p of S.pop) { g.globalAlpha = Math.min(1, p.l * 2); g.fillStyle = p.col; g.fillText(p.t, p.x, p.y); }
    g.globalAlpha = 1;
    // HUD
    g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(0, 0, W, 28);
    g.font = 'bold 13px monospace'; g.textAlign = 'left'; g.fillStyle = '#e6edf3'; g.fillText(`LEVEL ${S.level + 1}`, 10, 18);
    g.font = '12px monospace'; g.fillStyle = '#8b949e'; g.fillText(`API ${21 + S.level * 2} · ${NAMES[S.level] || 'Android ∞'}`, 80, 18);
    g.textAlign = 'right'; g.font = 'bold 13px monospace'; g.fillStyle = '#e6edf3'; g.fillText(`SCORE ${S.score | 0}`, W - 10, 18);
    g.font = '12px monospace'; g.fillStyle = '#8b949e'; g.fillText(`BEST ${hi | 0}`, W - 130, 18);
    g.textAlign = 'center';
    if (S.combo > 1 && S.comboT > 0) { g.font = 'bold 13px monospace'; g.fillStyle = '#e3b341'; g.fillText(`COMBO x${S.combo}`, W / 2, 18); g.fillRect(W / 2 - 35, 22, 70 * Math.min(1, S.comboT / 1.6), 2); }
    g.textAlign = 'left';
    let hy = 46; g.font = 'bold 11px monospace';
    const bar = (n: string, v: number, m: number, col: string) => { g.fillStyle = col; g.fillText(n, 10, hy); g.fillStyle = '#21262d'; g.fillRect(74, hy - 8, 90, 7); g.fillStyle = col; g.fillRect(74, hy - 8, 90 * v / m, 7); hy += 15; };
    if (S.shield) { g.fillStyle = '#d2a8ff'; g.fillText('SHIELD ready', 10, hy); hy += 15; }
    if (S.magnet > 0) bar('MAGNET', S.magnet, 8, '#58a6ff');
    if (S.slow > 0) bar('SLOW-MO', S.slow, 6, '#39d0c8');
    g.textAlign = 'center';
    // level banner
    if (S.banner.t > 0 && st !== 'start') {
      const u = 1 - S.banner.t / 2.6, a = Math.min(1, u * 6, S.banner.t * 2), e = 1 - Math.pow(1 - Math.min(1, u * 5), 3);
      g.globalAlpha = a; g.fillStyle = '#fff'; g.font = 'bold 28px monospace'; g.fillText(S.banner.a, W / 2, 92 - (1 - e) * 18);
      g.font = '14px monospace'; g.fillStyle = '#c9d1d9'; g.fillText(S.banner.b, W / 2, 114 - (1 - e) * 18); g.globalAlpha = 1;
    }
    const ov = (a: string, b: string, c2?: string) => {
      g.fillStyle = 'rgba(0,0,0,.72)'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#fff'; g.font = 'bold 24px monospace'; g.fillText(a, W / 2, 110);
      g.font = '14px monospace'; g.fillStyle = '#c9d1d9'; g.fillText(b, W / 2, 140);
      if (c2) { g.fillStyle = '#8b949e'; g.fillText(c2, W / 2, 166); }
    };
    if (st === 'start') ov('LOGCAT RUNNER', 'Dodge errors, collect coins, survive the API levels.', `press SPACE or tap to start${hi ? `   ·   best ${hi | 0}` : ''}`);
    if (st === 'pause') ov('PAUSED', 'press P or SPACE to resume');
    if (st === 'over') ov("Runner isn't responding", `Score ${S.score | 0}   ·   Best ${hi | 0}${S.score >= hi && S.score > 0 ? '   NEW BEST!' : ''}`, 'SPACE or tap = Close app (restart)');
    g.textAlign = 'left';
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(W, Math.round(rect.width * dpr));
    if (canvas.width !== w) { canvas.width = w; canvas.height = Math.round(w * H / W); }
  };

  reset();
  resize();
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (st === 'play') update(dt);
    else if (st !== 'pause') { ambient(dt); if (st === 'start') S.dist += 80 * dt; }
    draw();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pointerup', onPointerUp);
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('pointerdown', onPointerDown);

  return {
    resize,
    pause() { if (st === 'play') st = 'pause'; },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      if (au) au.close().catch(() => {});
    },
  };
};
