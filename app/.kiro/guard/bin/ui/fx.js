// Inspector layer: inspector and crew, flashlight, props, director and the scenes that react to state signals.
// Writes only its own layers, plus the cut thread's base path opacity and the light spots inside panels.
import { L, T, RM, TAU, clamp, lerp, rand, easeInOutCos, easeOutCubic, easeInSine, easeOutBack, smooth, angDiff, deg, r2, r3, approach, springCD, springUD, svgEl, setA, setS, $, bez, splitBez, dOf, arcTable, pointAt } from './core.js';
import { formatExample } from './format.js';

// Inspector and crew shape: Kiro mascot outline taken from its public SVG
const GHOST = {
  body: 'M210 64C262 64 300 100 308 150C315 200 306 262 284 296C268 322 246 335 228 334C216 333 211 324 207 316C197 326 178 335 155 334C134 333 122 318 125 300C126 290 130 281 132 275C120 279 104 282 95 276C86 270 88 254 95 244C104 230 108 215 110 196C113 160 116 130 130 108C148 80 178 64 210 64Z',
  dash: 'M245 95C300 95 338 138 338 192C338 248 298 288 242 288C200 288 160 290 120 296C96 300 74 306 60 300C48 294 54 282 66 276C46 278 22 276 14 264C8 254 20 246 34 244C18 238 6 226 10 214C14 202 34 202 50 204C38 194 34 182 42 174C80 140 170 95 245 95Z',
  eyes: [[214, 161], [260, 161]],
  dashEyes: [[268, 176], [306, 176]],
  rx: 13, ry: 21, cx: 200, cy: 200, h: 271,
};
const CREW_FILLS = ['#ffffff', '#ece2ff', '#dccbff', '#c7a6ff'];
const BUB_ZONE = [L.zone.x0 + 6, L.zone.x1 - 6];
const BUB_ACT = [L.code.x + L.code.w + 6, 1920 - 6];
const BUTTONS = { x: L.act.x + L.act.w / 2, y: 72 + 672 + 30 };
const REST = { x: 560, y: 470 };
const WORDS = ['NIGHT PATROL', 'HMM?', 'KIRO CREW,\nASSEMBLE!', '!', 'ALL CLEAR!', '?'];

const fxLog = window.fxLog || (window.fxLog = []);
const note = (what) => { fxLog.push({ t: performance.now(), what }); };

let APP = null, VIEW = null, ready = false;
const V = { layer: {}, maskSpot: null, threads: new Map(), patrol: [], structKey: null };
let G = null;

function stops(g, arr) { arr.forEach(([o, c, a]) => svgEl('stop', { offset: String(o), 'stop-color': c, 'stop-opacity': String(a) }, g)); }
// Gradients and the layer groups of the inspector layer
function buildFx() {
  const fx = $('fx'), bf = $('beamfx');
  const d1 = svgEl('defs', null, fx);
  svgEl('path', { id: 'gBody', d: GHOST.body }, d1);
  svgEl('path', { id: 'gDash', d: GHOST.dash }, d1);
  stops(svgEl('radialGradient', { id: 'ghostFill', cx: '0.4', cy: '0.3', r: '0.85' }, d1), [[0, '#ffffff', 1], [0.6, '#f6f1ff', 1], [1, '#d6c8f0', 1]]);
  stops(svgEl('radialGradient', { id: 'aura' }, d1), [[0, '#c7a6ff', 0.32], [0.55, '#8a44ff', 0.13], [1, '#8a44ff', 0]]);
  stops(svgEl('radialGradient', { id: 'burstGrad' }, d1), [[0, '#ffffff', 0.95], [0.4, '#ff8a7d', 0.6], [1, '#ff4d3d', 0]]);
  // Cone: transparent from 0.74 of the path box (0.929 of the distance) so the target glyph stays clear
  const d2 = svgEl('defs', null, bf);
  stops(svgEl('linearGradient', { id: 'beamGrad', x1: '0', y1: '0', x2: '1', y2: '0' }, d2), [[0, '#fff7e6', 0.74], [0.3, '#e4d4ff', 0.3], [0.58, '#c7a6ff', 0.1], [0.74, '#c7a6ff', 0]]);
  stops(svgEl('linearGradient', { id: 'beamGradRed', x1: '0', y1: '0', x2: '1', y2: '0' }, d2), [[0, '#ffe0db', 0.78], [0.3, '#ff7a6b', 0.34], [0.58, '#ff4d3d', 0.11], [0.74, '#ff4d3d', 0]]);
  const pf = $('poolfx'), d3 = svgEl('defs', null, pf);
  stops(svgEl('radialGradient', { id: 'poolGrad' }, d3), [[0, '#ffffff', 0.5], [0.45, '#d9c4ff', 0.24], [1, '#c7a6ff', 0]]);
  stops(svgEl('radialGradient', { id: 'poolGradRed' }, d3), [[0, '#ffd2cc', 0.5], [0.45, '#ff6a5a', 0.26], [1, '#ff4d3d', 0]]);
  V.layer = {
    pool: svgEl('g', null, pf), beam: svgEl('g', null, bf),
    chips: svgEl('g', null, fx), crew: svgEl('g', null, fx), ghost: svgEl('g', null, fx), lamp: svgEl('g', null, fx),
    sign: svgEl('g', null, fx), bubble: svgEl('g', null, fx), burst: svgEl('g', null, fx),
  };
}

// ── director on the loop clock. Owners: 'i' inspector reactions, 'c' crew scene, 'x' everything else
const D = { cues: [], tweens: [], gen: { i: 0, c: 0, x: 0 } };
function at(delay, fn, own = 'i') { D.cues.push({ t: T.now + delay, fn, own, gen: D.gen[own] }); }
function tween(delay, dur, fn, o = {}, own = 'i') {
  D.tweens.push({ t0: T.now + delay, dur: Math.max(0.001, dur), fn, ease: o.ease || easeInOutCos, done: o.done, motion: !!o.motion, own, gen: D.gen[own] });
}
// Callbacks that arrive after their owner moved on are dropped
function guard(fn, own = 'i') { const g = D.gen[own]; return (...a) => { if (g === D.gen[own]) fn(...a); }; }
function kill(own) { D.gen[own] += 1; }
function runDirector(t) {
  if (D.cues.length) {
    D.cues.sort((a, b) => a.t - b.t);
    while (D.cues.length && D.cues[0].t <= t) { const c = D.cues.shift(); if (c.gen === D.gen[c.own]) c.fn(); }
  }
  D.tweens = D.tweens.filter((tw) => {
    if (tw.gen !== D.gen[tw.own]) return false;
    if (t < tw.t0) return true;
    const u = clamp((t - tw.t0) / tw.dur, 0, 1);
    if (tw.motion && RM) { if (u < 1) return true; tw.fn(1); if (tw.done) tw.done(); return false; }
    tw.fn(tw.ease(u));
    if (u >= 1) { if (tw.done) tw.done(); return false; }
    return true;
  });
}

// ── actor (inspector and crew)
class Ghost {
  constructor(layer, o) {
    this.size = o.size;
    this.s = o.size / GHOST.h;
    this.big = !!o.big;
    this.p = { x: o.x, y: o.y };
    this.v = { x: 0, y: 0 };
    this.lead = { x: o.x, y: o.y };
    this.seg = null;
    this.track = null;
    this.omega = o.omega || 14;
    this.bobA = o.bobA != null ? o.bobA : rand(4, 6);
    this.bobP = rand(2.5, 3.5);
    this.bobPh = rand(0, TAU);
    this.bobRot = 0;
    this.tilt = { x: 0, v: 0 };
    this.face = 1;
    this.faceS = 1;
    this.faceLock = 0;
    this.faceGoal = 1;
    this.faceHold = 0; // no turning back for 0.4 s after a turn
    this.faceRate = o.big ? 18 : 12;
    this.faceByVel = !o.big;
    this.reacts = []; // short tweens added to the leading point
    this.tgt = { x: o.x, y: o.y };
    this.lean = { x: 0, v: 0 };
    this.leanGoal = 0;
    this.leanUntil = 0;
    this.tiltR = 0;
    this.dash = 0;
    this.dashOn = false;
    this.dashV = o.dashV || 1050;
    this.blink = 1;
    this.blinkT0 = -1;
    this.nextBlink = T.now + rand(2.5, 6);
    this.look = { x: 0, y: 0, vx: 0, vy: 0 };
    this.lookAt = null;
    this.eyeS = { x: 1, v: 0 };
    this.eyeGoal = 1;
    this.eyeUntil = 0;
    this.happy = 0;
    this.happyGoal = 0;
    this.sq = null;
    this.alpha = o.alpha != null ? o.alpha : 1;
    this.alphaGoal = this.alpha;
    this.speed = 0;
    this.rc = { x: o.x, y: o.y };
    this.build(layer, o.fill || 'url(#ghostFill)', o.cls || 'crew');
  }
  build(layer, fill, cls) {
    const g = (this.g = svgEl('g', { class: 'ghost ' + cls, opacity: r3(this.alpha), transform: 'translate(-999 -999)' }, layer));
    if (this.big) svgEl('circle', { cx: 200, cy: 205, r: 178, fill: 'url(#aura)' }, g);
    this.bodyG = svgEl('g', { class: 'body', opacity: '1' }, g);
    svgEl('use', { href: '#gBody', fill }, this.bodyG);
    this.eyeEls = GHOST.eyes.map(([cx, cy]) => svgEl('ellipse', { cx, cy, rx: GHOST.rx, ry: GHOST.ry, fill: '#0b0b0c', opacity: '1' }, this.bodyG));
    this.happyG = svgEl('g', { opacity: 0, fill: 'none', stroke: '#0b0b0c', 'stroke-width': 9, 'stroke-linecap': 'round' }, this.bodyG);
    GHOST.eyes.forEach(([cx, cy]) => svgEl('path', { d: 'M' + (cx - 13) + ' ' + (cy + 6) + ' Q' + cx + ' ' + (cy - 14) + ' ' + (cx + 13) + ' ' + (cy + 6) }, this.happyG));
    this.dashG = svgEl('g', { class: 'dash', opacity: 0 }, g);
    svgEl('use', { href: '#gDash', fill }, this.dashG);
    GHOST.dashEyes.forEach(([cx, cy]) => svgEl('ellipse', { cx, cy, rx: GHOST.rx, ry: GHOST.ry, fill: '#0b0b0c' }, this.dashG));
  }
  // Facing. now = a decided direction (segment start): turn at once, skipping the hold
  setFace(f, now) {
    if (!f) return;
    this.faceGoal = f;
    if (now && this.face !== f) { this.face = f; this.faceHold = T.now + 0.4; }
    if (this.faceByVel) this.faceLock = Math.max(this.faceLock, T.now + 0.3);
  }
  // Segment move: anticipation back (0.11 s) → travel with overshoot
  flyTo(x, y, dur, o = {}) {
    const dx0 = x - this.lead.x;
    this.setFace(o.face || (Math.abs(dx0) > 120 ? Math.sign(dx0) : 0), true);
    const from = { x: this.lead.x, y: this.lead.y };
    const dx = x - from.x, dy = y - from.y, dist = Math.hypot(dx, dy) || 1;
    const A = o.antic != null ? o.antic : Math.min(this.big ? 16 : 10, dist * 0.08);
    if (RM) {
      // Reduced motion: jump there and fade in; arrival is still reported at the usual time
      this.place(x, y); this.alpha = 0;
      if (o.done) at((A > 0.5 ? 0.11 : 0) + Math.max(0.05, dur), o.done, 'x');
      return;
    }
    this.track = null;
    this.seg = { from, to: { x, y }, dir: { x: dx / dist, y: dy / dist }, A, t0: T.now, ta: A > 0.5 ? 0.11 : 0, dur: Math.max(0.05, dur), c: dist < 220 ? 1.70158 : 1.05, done: o.done };
  }
  follow(fn, face) { this.seg = null; this.track = fn; this.setFace(face, true); }
  place(x, y) { this.p.x = this.lead.x = this.tgt.x = x; this.p.y = this.lead.y = this.tgt.y = y; this.v.x = this.v.y = 0; this.seg = null; this.track = null; }
  boo(amp = 1) { if (!RM) this.sq = { t0: T.now, amp }; }
  hop(dx, dy, dur = 0.34, delay = 0) { if (!RM) this.reacts.push({ t0: T.now + delay, dur, dx, dy }); }
  leanTo(degv, hold) { if (!RM) { this.leanGoal = degv; this.leanUntil = T.now + hold; } }
  eyesWide(k, hold) { this.eyeGoal = k; this.eyeUntil = T.now + hold; }
  surprise(hold = 0.8) { this.eyesWide(1.42, hold); this.boo(2.4); }
  reactOffset(t) {
    let ox = 0, oy = 0;
    if (this.reacts.length) {
      this.reacts = this.reacts.filter((r) => {
        const u = (t - r.t0) / r.dur;
        if (u < 0) return true;
        if (u >= 1) return false;
        const e = u < 0.35 ? easeOutCubic(u / 0.35) : 1 - easeOutBack((u - 0.35) / 0.65, 1.4);
        ox += r.dx * e;
        oy += r.dy * e;
        return true;
      });
    }
    this.tgt.x = this.lead.x + ox;
    this.tgt.y = this.lead.y + oy;
  }
  updateLead(t) {
    const s = this.seg;
    if (s) {
      const e = t - s.t0;
      if (e < s.ta) {
        const u = Math.sin(((e / s.ta) * Math.PI) / 2);
        this.lead.x = s.from.x - s.dir.x * s.A * u;
        this.lead.y = s.from.y - s.dir.y * s.A * u;
      } else {
        const u = clamp((e - s.ta) / s.dur, 0, 1), k = easeOutBack(easeInSine(u), s.c);
        const sx = s.from.x - s.dir.x * s.A, sy = s.from.y - s.dir.y * s.A;
        this.lead.x = lerp(sx, s.to.x, k);
        this.lead.y = lerp(sy, s.to.y, k);
        if (u >= 1) { this.seg = null; if (s.done) s.done(); }
      }
    } else if (this.track) {
      const q = this.track(t);
      this.lead.x = q.x;
      this.lead.y = q.y;
    }
  }
  update(dt, t) {
    this.updateLead(t);
    this.reactOffset(t);
    if (RM) {
      // Reduced motion: no travel; more than 40px fades in again from transparent
      if (Math.hypot(this.tgt.x - this.p.x, this.tgt.y - this.p.y) > 40) this.alpha = 0;
      this.p.x = this.tgt.x; this.p.y = this.tgt.y; this.v.x = this.v.y = 0;
    } else {
      [this.p.x, this.v.x] = springCD(this.p.x, this.v.x, this.tgt.x, this.omega, dt);
      [this.p.y, this.v.y] = springCD(this.p.y, this.v.y, this.tgt.y, this.omega, dt);
    }
    const sp = (this.speed = Math.hypot(this.v.x, this.v.y));
    if (this.faceByVel) {
      if (!RM && t > this.faceLock && t >= this.faceHold && Math.abs(this.v.x) > 200) {
        const f = Math.sign(this.v.x);
        if (f !== this.face) { this.face = f; this.faceHold = t + 0.35; }
      }
    } else if (t >= this.faceHold && this.face !== this.faceGoal) { this.face = this.faceGoal; this.faceHold = t + 0.4; }
    this.faceS = RM ? this.face : approach(this.faceS, this.face, this.faceRate, dt);
    springUD(this.tilt, RM ? 0 : clamp(this.v.x * 0.0085, -8, 8), 10, 0.42, dt);
    if (t > this.leanUntil) this.leanGoal = 0;
    springUD(this.lean, RM ? 0 : this.leanGoal, 9, 0.5, dt);
    // Dash shape only above the speed, after facing the travel direction, within ±40° of horizontal
    const aligned = Math.abs(this.faceS) > 0.9 && this.v.x * this.faceS > 0 && Math.abs(this.v.y) < Math.abs(this.v.x) * 0.84;
    if (!this.dashOn && sp > this.dashV && aligned) this.dashOn = true;
    else if (this.dashOn && (sp < this.dashV * 0.66 || !aligned)) this.dashOn = false;
    this.dash = approach(this.dash, this.dashOn && !RM ? 1 : 0, 1 / 0.15, dt);
    if (!RM && t >= this.nextBlink && this.blinkT0 < 0) this.blinkT0 = t;
    if (this.blinkT0 >= 0) {
      const e = t - this.blinkT0;
      if (e < 0.08) this.blink = lerp(1, 0.1, e / 0.08);
      else if (e < 0.2) this.blink = lerp(0.1, 1, easeOutCubic((e - 0.08) / 0.12));
      else { this.blink = 1; this.blinkT0 = -1; this.nextBlink = t + rand(2.5, 6); }
    }
    if (t > this.eyeUntil) this.eyeGoal = 1;
    springUD(this.eyeS, RM ? 1 : this.eyeGoal, 16, 0.45, dt);
    this.happy = approach(this.happy, this.happyGoal, 1 / 0.15, dt);
    this.alpha = approach(this.alpha, this.alphaGoal, 4, dt);
    const ph = (TAU * t) / this.bobP + this.bobPh;
    this.rc.x = this.p.x;
    this.rc.y = this.p.y + (RM ? 0 : this.bobA * Math.sin(ph));
    this.bobRot = RM ? 0 : 1.2 * Math.sin(ph + Math.PI / 2);
    // Pupils toward what it looks at (at most 6 in body units)
    let lx = 0, ly = 0;
    const fsg = this.faceS >= 0 ? 1 : -1;
    if (!RM && this.lookAt) {
      const dx = (this.lookAt.x - this.rc.x) * fsg, dy = this.lookAt.y - this.rc.y, d = Math.hypot(dx, dy) || 1, m = Math.min(6, d * 0.04);
      lx = (dx / d) * m;
      ly = (dy / d) * m;
    } else if (!RM) {
      lx = clamp(this.v.x * 0.004 * fsg, -4, 4);
      ly = clamp(this.v.y * 0.004, -4, 4);
    }
    [this.look.x, this.look.vx] = springCD(this.look.x, this.look.vx, lx, 18, dt);
    [this.look.y, this.look.vy] = springCD(this.look.y, this.look.vy, ly, 18, dt);
  }
  // Squash: 1 → (1.06, 0.94) → (0.97, 1.04) → 1 over 0.6 s
  squash(t) {
    if (!this.sq) return [1, 1];
    const e = t - this.sq.t0, a = this.sq.amp;
    if (e >= 0.6) { this.sq = null; return [1, 1]; }
    const K = [[0, 1, 1], [0.2, 1 + 0.06 * a, 1 - 0.06 * a], [0.4, 1 - 0.03 * a, 1 + 0.04 * a], [0.6, 1, 1]];
    let k = 0;
    while (k < K.length - 2 && e > K[k + 1][0]) k++;
    const u = easeInOutCos((e - K[k][0]) / (K[k + 1][0] - K[k][0]));
    return [lerp(K[k][1], K[k + 1][1], u), lerp(K[k][2], K[k + 1][2], u)];
  }
  render(t) {
    const [qx, qy] = this.squash(t);
    const st = RM ? 0 : Math.min(0.08, this.speed * 0.00007);
    const th = deg(Math.atan2(this.v.y, this.v.x || 1e-6));
    const fs = Math.abs(this.faceS) < 0.12 ? 0.12 * (this.faceS < 0 ? -1 : 1) : this.faceS;
    this.tiltR = 8 * Math.tanh(this.tilt.x / 8);
    let tr = 'translate(' + r2(this.rc.x) + ' ' + r2(this.rc.y) + ') rotate(' + r2(this.tiltR + this.bobRot + this.lean.x) + ')';
    if (st > 0.002) tr += ' rotate(' + r2(th) + ') scale(' + r3(1 + st) + ' ' + r3(1 / (1 + st)) + ') rotate(' + r2(-th) + ')';
    tr += ' scale(' + r3(fs * this.s * qx) + ' ' + r3(this.s * qy) + ') translate(-200 -200)';
    setA(this.g, 'transform', tr);
    setA(this.g, 'opacity', String(r3(this.alpha)));
    setA(this.bodyG, 'opacity', String(r3(1 - this.dash)));
    setA(this.dashG, 'opacity', String(r3(this.dash)));
    if (this.dash > 0.001) {
      const a = Math.atan2(this.v.y, this.v.x) - (this.tiltR * Math.PI) / 180;
      let la = fs >= 0 ? a : Math.PI - a;
      la = clamp(Math.atan2(Math.sin(la), Math.cos(la)), -0.6, 0.6);
      setA(this.dashG, 'transform', 'rotate(' + r2(deg(la)) + ' 200 200)');
    }
    const es = this.eyeS.x;
    this.eyeEls.forEach((e, k) => {
      const [cx, cy] = GHOST.eyes[k];
      setA(e, 'transform', 'translate(' + r2(this.look.x + cx) + ' ' + r2(this.look.y + cy) + ') scale(' + r3(es) + ' ' + r3(es * this.blink) + ') translate(' + -cx + ' ' + -cy + ')');
      setA(e, 'opacity', String(r3(1 - this.happy)));
    });
    setA(this.happyG, 'opacity', String(r3(this.happy)));
  }
}

// ── flashlight: hand and lamp, cone, pool (same spot as the thread mask)
const Beam = {
  build() {
    const d = 'M0 -9 L1000 -255 A 255 255 0 0 1 1000 255 L0 9 Z';
    this.cone = svgEl('g', { transform: 'translate(-999 -999)', opacity: 0 }, V.layer.beam);
    this.coneW = svgEl('path', { d, fill: 'url(#beamGrad)', opacity: 1 }, this.cone);
    this.coneR = svgEl('path', { d, fill: 'url(#beamGradRed)', opacity: 0 }, this.cone);
    this.pool = svgEl('g', { transform: 'translate(-999 -999)', opacity: 0 }, V.layer.pool);
    this.poolW = svgEl('circle', { r: 1, fill: 'url(#poolGrad)', opacity: 1 }, this.pool);
    this.poolR = svgEl('circle', { r: 1, fill: 'url(#poolGradRed)', opacity: 0 }, this.pool);
    this.lamp = svgEl('g', { class: 'lamp', transform: 'translate(-999 -999)' }, V.layer.lamp);
    svgEl('rect', { class: 'body', x: -2, y: -8, width: 32, height: 16, rx: 5 }, this.lamp);
    svgEl('rect', { class: 'body', x: 24, y: -11, width: 11, height: 22, rx: 3 }, this.lamp);
    svgEl('ellipse', { class: 'lens', cx: 35, cy: 0, rx: 3, ry: 9.5 }, this.lamp);
    svgEl('ellipse', { class: 'hand', cx: -2, cy: 0, rx: 13, ry: 11 }, this.lamp);
    this.spot = { x: 600, y: 480, vx: 0, vy: 0 };
    this.goal = { x: 600, y: 480 };
    this.ang = 0.6; this.on = 0; this.onGoal = 0; this.red = 0; this.redGoal = 0;
    this.hand = { x: 0, y: 0 }; this.lens = { x: 0, y: 0 }; this.pr = 60;
  },
  aim(x, y) { if (x && typeof x === 'object') { y = x.y; x = x.x; } this.goal.x = x; this.goal.y = y; },
  update(dt, t, G) {
    if (RM) {
      if (Math.hypot(this.goal.x - this.spot.x, this.goal.y - this.spot.y) > 40) this.on = 0;
      this.spot.x = this.goal.x; this.spot.y = this.goal.y;
    } else {
      [this.spot.x, this.spot.vx] = springCD(this.spot.x, this.spot.vx, this.goal.x, 20, dt);
      [this.spot.y, this.spot.vy] = springCD(this.spot.y, this.spot.vy, this.goal.y, 20, dt);
    }
    this.on = approach(this.on, this.onGoal, 4, dt);
    this.red = approach(this.red, this.redGoal, 1 / 0.18, dt);
    const c = G.rc, target = Math.atan2(this.spot.y - c.y, this.spot.x - c.x);
    this.ang = RM ? target : this.ang + angDiff(this.ang, target) * (1 - Math.exp(-14 * dt));
    const ca = Math.cos(this.ang), sa = Math.sin(this.ang);
    this.hand.x = c.x + ca * 104 * G.s;
    this.hand.y = c.y + sa * 124 * G.s;
    this.lens.x = this.hand.x + ca * 35;
    this.lens.y = this.hand.y + sa * 35;
    const dist = Math.max(40, Math.hypot(this.spot.x - this.lens.x, this.spot.y - this.lens.y));
    const ab = Math.atan2(this.spot.y - this.lens.y, this.spot.x - this.lens.x);
    const pr = 60 + dist * 0.06;
    setA(this.cone, 'transform', 'translate(' + r2(this.lens.x) + ' ' + r2(this.lens.y) + ') rotate(' + r2(deg(ab)) + ') scale(' + r3(dist / 1000) + ')');
    setA(this.cone, 'opacity', String(r3(this.on)));
    setA(this.coneW, 'opacity', String(r3(1 - this.red)));
    setA(this.coneR, 'opacity', String(r3(this.red)));
    setA(this.pool, 'transform', 'translate(' + r2(this.spot.x) + ' ' + r2(this.spot.y) + ') scale(' + r2(pr) + ')');
    setA(this.pool, 'opacity', String(r3(this.on)));
    setA(this.poolW, 'opacity', String(r3(1 - this.red)));
    setA(this.poolR, 'opacity', String(r3(this.red)));
    setA(this.lamp, 'transform', 'translate(' + r2(this.hand.x) + ' ' + r2(this.hand.y) + ') rotate(' + r2(deg(this.ang)) + ')');
    setA(this.lamp, 'opacity', String(r3(G.alpha)));
    if (V.maskSpot) setA(V.maskSpot, 'transform', 'translate(' + r2(this.spot.x) + ' ' + r2(this.spot.y) + ') scale(' + r2(pr * 1.4 * this.on) + ')');
    this.pr = pr;
  },
};

// ── speech bubbles (hand lettering): one per phrase, made and measured at start
class Bubble {
  constructor(layer, msg) {
    this.g = svgEl('g', { class: 'bubble', opacity: 0 }, layer);
    this.tailG = svgEl('g', null, this.g);
    this.tail = svgEl('path', { d: 'M-13 0 L-6 27 L13 0 Z' }, this.tailG);
    this.rect = svgEl('rect', { rx: 16, ry: 16 }, this.g);
    this.coverG = svgEl('g', null, this.g);
    this.cover = svgEl('rect', { style: 'stroke:none', x: -11, y: -1, width: 22, height: 5 }, this.coverG);
    this.text = svgEl('text', { x: 0, y: 0, 'text-anchor': 'middle' }, this.g);
    this.lines = String(msg).split('\n').map((s, k) => svgEl('tspan', { x: 0, dy: k ? '30' : '0', text: s }, this.text));
    this.a = 0; this.aGoal = 0; this.t0 = -9; this.until = 0; this.W = 200; this.H = 56; this.hh = 28; this.zone = BUB_ZONE;
  }
  say(dur, zone) { this.zone = zone || BUB_ZONE; this.t0 = T.now; this.until = T.now + dur; this.aGoal = 1; }
  measure() {
    let w = 0;
    this.lines.forEach((ln) => {
      let m = ln.textContent.length * 17.5;
      try { const c = ln.getComputedTextLength(); if (c > 10) m = c; } catch { /* keep the estimate */ }
      w = Math.max(w, m);
    });
    const n = Math.max(1, this.lines.length);
    const W = (this.W = Math.round(w + 46)), H = (this.H = 56 + 30 * (n - 1)), hw = W / 2, hh = H / 2;
    setA(this.rect, 'x', String(-hw)); setA(this.rect, 'y', String(-hh));
    setA(this.rect, 'width', String(W)); setA(this.rect, 'height', String(H));
    setA(this.text, 'y', String(r2(-hh + 28 + 10)));
    this.hh = hh;
  }
  hide() { this.until = 0; }
  update(dt, t, G) {
    if (t > this.until) this.aGoal = 0;
    this.a = approach(this.a, this.aGoal, this.aGoal ? 8 : 5, dt);
    setA(this.g, 'opacity', String(r3(this.a)));
    if (this.a <= 0 && !this.aGoal) return;
    const e = t - this.t0, hw = this.W / 2;
    const sc = RM ? 1 : 0.55 + 0.45 * (e < 0.35 ? easeOutBack(e / 0.35, 2.2) : 1);
    const z0 = this.zone[0] + hw * 1.1, z1 = this.zone[1] - hw * 1.1;
    const x = z0 <= z1 ? clamp(G.rc.x, z0, z1) : (this.zone[0] + this.zone[1]) / 2;
    const y = Math.max(80 + this.hh, G.rc.y - G.size * 0.5 - 8 - this.hh);
    const tx = clamp(G.rc.x - x, -hw + 24, hw - 24);
    setA(this.g, 'transform', 'translate(' + r2(x) + ' ' + r2(y) + ') scale(' + r3(sc) + ')');
    const ttr = 'translate(' + r2(tx) + ' ' + r2(this.hh - 3) + ')';
    setA(this.tailG, 'transform', ttr);
    setA(this.coverG, 'transform', ttr);
  }
}
const BUB = { map: new Map(), cur: null };
function say(msg, dur, zone) {
  const b = BUB.map.get(msg);
  if (!b) return;
  if (BUB.cur && BUB.cur !== b) BUB.cur.hide();
  BUB.cur = b;
  b.say(dur, zone);
}
const measureBubbles = () => BUB.map.forEach((b) => b.measure());

// ── STOP! sign (red board, ink letters)
const Sign = {
  build() {
    this.g = svgEl('g', { class: 'sign', opacity: 0 }, V.layer.sign);
    svgEl('rect', { class: 'stick', x: -4, y: -96, width: 8, height: 100, rx: 3 }, this.g);
    svgEl('rect', { class: 'board', x: -84, y: -180, width: 168, height: 90, rx: 10, transform: 'rotate(-5 0 -135)' }, this.g);
    svgEl('text', { x: 0, y: -118, 'text-anchor': 'middle', transform: 'rotate(-5 0 -135)', text: 'STOP!' }, this.g);
    svgEl('ellipse', { cx: 0, cy: 2, rx: 13, ry: 11, fill: '#f4efff' }, this.g);
    this.rot = { x: 110, v: 0 }; this.up = 0; this.a = 0;
  },
  raise(on) { this.up = on ? 1 : 0; },
  snap(on) { this.up = on ? 1 : 0; this.rot.x = on ? 0 : 110; this.rot.v = 0; this.a = this.up; },
  update(dt, t, G) {
    springUD(this.rot, this.up ? 0 : 110, 11, 0.38, dt);
    if (RM) this.rot.x = this.up ? 0 : 110;
    this.a = approach(this.a, this.up, this.up ? 6 : 3, dt);
    const f = G.face >= 0 ? 1 : -1;
    setA(this.g, 'transform', 'translate(' + r2(G.rc.x + f * 112 * G.s) + ' ' + r2(G.rc.y + 26) + ') rotate(' + r2(f * this.rot.x) + ')');
    setA(this.g, 'opacity', String(r3(this.a)));
  },
};

// ── cut sparks: one set made ahead and reused
const Bursts = {
  build() {
    this.g = svgEl('g', { transform: 'translate(-999 -999)', opacity: 0 }, V.layer.burst);
    this.flash = svgEl('circle', { r: 1, fill: 'url(#burstGrad)' }, this.g);
    this.parts = [];
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * TAU + rand(-0.25, 0.25);
      this.parts.push({ a, sp: rand(150, 280), el: svgEl('line', { x1: 0, y1: 0, x2: 12, y2: 0, stroke: '#ff8a7d', 'stroke-width': 3, 'stroke-linecap': 'round' }, this.g) });
    }
    this.t0 = -9; this.on = false;
  },
  add(x, y) {
    if (RM) return;
    setA(this.g, 'transform', 'translate(' + r2(x) + ' ' + r2(y) + ')');
    this.t0 = T.now; this.on = true;
  },
  update(t) {
    if (!this.on) return;
    const u = (t - this.t0) / 0.5;
    if (u >= 1) { this.on = false; setA(this.g, 'opacity', '0'); return; }
    setA(this.g, 'opacity', '1');
    setA(this.flash, 'transform', 'scale(' + r2(14 + 70 * easeOutCubic(u)) + ')');
    setA(this.flash, 'opacity', String(r3(1 - u)));
    this.parts.forEach((p) => {
      const d = p.sp * easeOutCubic(u) * 0.5;
      setA(p.el, 'transform', 'translate(' + r2(Math.cos(p.a) * d) + ' ' + r2(Math.sin(p.a) * d) + ') rotate(' + r2(deg(p.a)) + ') scale(' + r3(1 - u) + ')');
    });
  },
  clear() { this.on = false; setA(this.g, 'opacity', '0'); },
};

// ── input chip a crew member carries: a neutral face and the result face, crossed by opacity
class Chip {
  constructor(layer, cell, ng) {
    const w = cell.w;
    this.g = svgEl('g', { class: 'chip', opacity: 0, transform: 'translate(-200 -200)' }, layer);
    const face = (g, res) => {
      svgEl('rect', { x: -w / 2, y: -32, width: w, height: 64, rx: 10 }, g);
      if (w >= 48) svgEl('text', { class: 'cv', x: 0, y: w >= 72 ? -2 : 4, 'text-anchor': 'middle', text: fit(cell.text, w) }, g);
      if (w >= 72 && cell.len != null) svgEl('text', { class: 'cl', x: -10, y: 21, 'text-anchor': 'middle', text: cell.len + '자' }, g);
      if (res && w >= 72) svgEl('path', { class: 'cmk', d: ng ? 'M15.5 11.5 L24.5 20.5 M24.5 11.5 L15.5 20.5' : 'M14 16.5 L18 20.5 L26 11.5' }, g);
    };
    this.neu = svgEl('g', { opacity: 1 }, this.g);
    face(this.neu, false);
    this.res = svgEl('g', { class: 'res ' + (ng ? 'ng' : 'ok'), opacity: 0 }, this.g);
    face(this.res, true);
    this.w = w;
    this.p = { x: -200, y: -200 }; this.rot = 0; this.sc = 1; this.a = 0; this.aGoal = 0; this.rate = 6;
    this.rv = 0; this.rvGoal = 0;
    this.holder = null;
  }
  reveal() { this.rvGoal = 1; if (RM) this.rv = 1; }
  update(dt) {
    if (this.holder) {
      const h = this.holder;
      this.p.x = h.rc.x;
      this.p.y = h.rc.y + h.size * 0.5 + 26;
      this.rot = -h.tilt.x * 0.9;
    }
    this.a = approach(this.a, this.aGoal, this.rate, dt);
    this.rv = approach(this.rv, this.rvGoal, 4, dt);
    setA(this.g, 'transform', 'translate(' + r2(this.p.x) + ' ' + r2(this.p.y) + ') rotate(' + r2(this.rot) + ') scale(' + r3(this.sc) + ')');
    setA(this.g, 'opacity', String(r3(this.a)));
    setA(this.neu, 'opacity', String(r3(1 - this.rv)));
    setA(this.res, 'opacity', String(r3(this.rv)));
  }
}
// Value text cut to the chip width (monospace 20px ≈ 12px a glyph)
function fit(s, w) {
  const a = Array.from(String(s)), max = Math.max(1, Math.floor((w - 12) / 12));
  return a.length > max ? a.slice(0, max - 1).join('') + '…' : a.join('');
}

// ── threads: lit copies under the spot mask, and cut halves that replace a broken base path
function buildThreads(view) {
  const glow = document.querySelector('#threads > g.glow'), cutG = document.querySelector('#threads > g.cut');
  glow.textContent = ''; cutG.textContent = '';
  const defs = svgEl('defs', null, glow);
  stops(svgEl('radialGradient', { id: 'maskGrad' }, defs), [[0, '#ffffff', 1], [0.55, '#ffffff', 0.8], [1, '#ffffff', 0]]);
  const mask = svgEl('mask', { id: 'spotMask', maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: '1920', height: '1080' }, defs);
  V.maskSpot = svgEl('circle', { r: '1', fill: 'url(#maskGrad)', transform: 'translate(-999 -999) scale(0)' }, mask);
  const lit = svgEl('g', { mask: 'url(#spotMask)' }, glow);
  V.threads = new Map();
  for (const th of view.threads) {
    const red = th.cls === 'red';
    const gl = svgEl('path', { d: th.d, class: 'th-glow' + (red ? ' red' : ''), 'stroke-dasharray': '1 0' }, lit);
    const ln = svgEl('path', { d: th.d, class: 'th-lit' + (red ? ' red' : ''), 'stroke-dasharray': '1 0' }, lit);
    V.threads.set(th.key, {
      key: th.key, id: th.id, i: th.i, j: th.j, q: th.q, tb: th.tb, span: th.span, above: th.above, mid: th.mid,
      base: th, glow: [gl, ln], red, halves: null, broken: false, cutT: 0.5, cutAt: null,
      droop: [{ x: 0, v: 0 }, { x: 0, v: 0 }], droopT: [0, 0], retract: [0, 0], pivots: [th.q[0], th.q[3]],
      dashP: 0, dashFrom: 0, dashTo: 0, dashT0: -1, joined: false,
    });
  }
  V.patrol = view.patrol.map((k) => V.threads.get(k)).filter(Boolean);
  V.structKey = view.structKey;
}
// Lit copies follow the base thread's shown state (red ones are off so dashes and gaps stay visible)
function syncGlow() {
  for (const th of VIEW.threads) {
    const f = V.threads.get(th.key);
    if (!f) continue;
    f.base = th; f.above = th.above;
    const red = th.cls === 'red' || f.broken;
    if (f.red !== red) { f.red = red; f.glow[0].setAttribute('class', 'th-glow' + (red ? ' red' : '')); f.glow[1].setAttribute('class', 'th-lit' + (red ? ' red' : '')); }
  }
}
// Cut halves for one thread at curve parameter t (made at a state change, hidden until the cut)
function prepareCut(f, t) {
  dropHalves(f);
  const halves = splitBez(f.q, t), mid = halves[0][3];
  f.cutT = t; f.cutAt = mid; f.halves = [];
  const cutG = document.querySelector('#threads > g.cut');
  let offset = 0;
  halves.forEach((hq, h) => {
    const piv = f.pivots[h], len = arcTable(hq, 32).len || 1;
    const df = angDiff(Math.atan2(mid.y - piv.y, mid.x - piv.x), Math.PI / 2);
    f.droopT[h] = Math.sign(df) * Math.min(14, Math.abs(deg(df)) * 0.35, deg(Math.atan(22 / len)));
    f.retract[h] = Math.min(26, 0.16 * len) / len;
    const g = svgEl('g', { opacity: '0', transform: 'rotate(0)', 'data-key': f.key, 'data-half': h ? 'b' : 'a' }, cutG);
    const attrs = { d: dOf(hq), class: 'th-dim red', 'stroke-dasharray': '1 0' };
    if (h) attrs['stroke-dashoffset'] = r2(offset);
    const path = svgEl('path', attrs, g);
    f.halves.push({ g, path });
    offset = len;
  });
  f.droop.forEach((d) => { d.x = 0; d.v = 0; });
  f.dashP = 0; f.dashT0 = -1; f.joining = false; f.broken = false;
}
function dropHalves(f) {
  if (!f.halves) return;
  f.halves.forEach((h) => h.g.remove());
  f.halves = null;
}
// The frame the beam reaches the knot: hide the base path, show the halves, open the gap
function cutThread(f, snap) {
  if (!f.halves) prepareCut(f, f.cutT);
  setS(f.base.path, 'opacity', '0');
  f.halves.forEach((h) => setA(h.g, 'opacity', '1'));
  f.broken = true; f.joining = false;
  f.dashFrom = f.dashP; f.dashTo = 1; f.dashT0 = snap ? -1 : T.now;
  if (snap) { f.dashP = 1; f.droop.forEach((d) => { d.x = 1; d.v = 0; }); }
  if (!f.red) { f.red = true; f.glow[0].setAttribute('class', 'th-glow red'); f.glow[1].setAttribute('class', 'th-lit red'); }
}
// Close the gap; the base path comes back the frame the halves meet
function joinThread(f) {
  if (!f.halves || !f.broken) return;
  const c = f.base.path.getAttribute('class') || 'th-dim';
  f.halves.forEach((h) => h.path.setAttribute('class', c));
  f.broken = false; f.joining = true;
  f.dashFrom = f.dashP; f.dashTo = c.includes('red') ? 1 : 0; f.dashT0 = T.now;
}
function updateThreads(dt, t) {
  for (const f of V.threads.values()) {
    if (!f.halves) continue;
    if (f.dashT0 >= 0) {
      const u = clamp((t - f.dashT0) / 0.4, 0, 1);
      f.dashP = lerp(f.dashFrom, f.dashTo, easeInOutCos(u));
      if (u >= 1) f.dashT0 = -1;
    }
    const da = r2(lerp(1, 10, f.dashP)) + ' ' + r2(lerp(0, 6, f.dashP));
    for (let h = 0; h < 2; h++) {
      const d = f.droop[h];
      if (RM) { d.x = f.broken ? 1 : 0; d.v = 0; } else springUD(d, f.broken ? 1 : 0, 7.5, 0.34, dt);
      const b = d.x, piv = f.pivots[h];
      const k = 1 - f.retract[h] * clamp(b, 0, 1.15), rot = RM ? 0 : f.droopT[h] * b;
      const tr = Math.abs(b) < 0.002 ? 'rotate(0)' : 'translate(' + r2(piv.x) + ' ' + r2(piv.y) + ') rotate(' + r2(rot) + ') scale(' + r3(k) + ') translate(' + r2(-piv.x) + ' ' + r2(-piv.y) + ')';
      setA(f.halves[h].g, 'transform', tr);
      setA(f.halves[h].path, 'stroke-dasharray', da);
    }
    if (f.joining && (RM || f.droop[0].x < 0 || f.droop[1].x < 0)) {
      f.joining = false;
      setS(f.base.path, 'opacity', '');
      f.halves.forEach((h) => setA(h.g, 'opacity', '0'));
      f.done = true;
    }
  }
}

// ── scene tools
// Nearest arc-length ratio on a thread to point p
function uOf(th, p) {
  let bi = 0, bd = 1e9;
  th.tb.pts.forEach((q, k) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; bi = k; } });
  return th.tb.cum[bi] / th.tb.len;
}
// Stamp boxes the inspector keeps clear of: the visible ones, or all of them
function stampBoxes(all) {
  const out = [];
  for (const s of VIEW.stamps) {
    if (!all) {
      const r = VIEW.reqs.find((x) => x.id === s.id);
      const th = r && r.primary ? VIEW.threads.find((t) => t.key === r.primary) : null;
      if (th && th.cls !== 'red') continue;
    }
    out.push(s.box);
  }
  return out;
}
// Move a standing spot away from stamps until the body box (±93, ±115) clears them by 8px
function avoid(pos, boxes) {
  let x = pos.x, y = pos.y;
  for (let n = 0; n < 4; n++) {
    let moved = false;
    for (const b of boxes) {
      if (x - 93 < b.x1 + 8 && b.x0 - 8 < x + 93 && y - 115 < b.y1 + 8 && b.y0 - 8 < y + 115) {
        y = clamp(y < (b.y0 + b.y1) / 2 ? b.y0 - 8 - 115 : b.y1 + 8 + 115, 205, 760);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x, y };
}
// Spot over a thread: below threads high on the stage, above the low ones; dir keeps 24px behind the beam
function hoverFor(th, u, dir = 0, boxes) {
  const p = pointAt(th.tb, u), above = th.above;
  const pos = { x: clamp(p.x - dir * 24 + (dir ? 0 : above ? -10 : 10), 462, 698), y: clamp(p.y + (above ? -150 : 150), 205, 760) };
  return avoid(pos, boxes || stampBoxes(false));
}
// Sweep one thread with the beam (u0 → u1); the body faces the sweep and does not turn during it
function sweep(th, delay, dur, u0, u1, done, ease, boxes) {
  const a = pointAt(th.tb, u0), b = pointAt(th.tb, u1), dir = Math.abs(b.x - a.x) > 40 ? Math.sign(b.x - a.x) : 0;
  at(delay, () => { th._u = u0; G.follow(() => hoverFor(th, th._u, dir, boxes), dir); G.lookAt = Beam.spot; });
  tween(delay, dur, (e) => { th._u = lerp(u0, u1, e); const p = pointAt(th.tb, th._u); Beam.aim(p.x, p.y); }, { motion: true, done, ease });
}
const actEntry = (ev) => (ev ? VIEW.act.find((a) => a.ev === ev) || null : null);
const lastShown = (action) => { for (let k = VIEW.act.length - 1; k >= 0; k--) { const a = VIEW.act[k]; if (a.shown && a.ev.action === action) return a; } return null; };
const reqOf = (id) => VIEW.reqs.find((r) => r.id === id) || null;
const inZone = (p) => p.x > L.zone.x0 && p.x < L.zone.x1 && p.y > L.zone.y0 && p.y < L.zone.y1;

// ── crew: carries input chips onto the band cells, then walks the shrink path
const CR = { key: null, crew: [], chips: [], shrink: [], idx: [], carrier: null, carrierK: -1, band: null, busy: false, t0: -9, endAt: -9, old: [], oldChips: [] };
const holdY = (c) => c.size * 0.5 + 26;
const cellPos = (c) => ({ x: c.x + c.w / 2, y: L.slots.y + L.slots.h / 2 });
function perchPos(slot, c, k, w) { return { x: w < 60 ? slot.x : slot.x + (k % 2 ? 1 : -1) * (w / 2 - 22), y: slot.y - 32 - c.size * 0.38 }; }
function carrierPerch(slot, c, w) { return { x: Math.min(1920 - c.size * 0.5, slot.x + w / 2 + 6 + c.size * 0.42), y: slot.y - 4 }; }
function makeCrew(k) {
  const c = new Ghost(V.layer.crew, { size: Math.round(rand(46, 62)), x: -200, y: -200, fill: CREW_FILLS[k % CREW_FILLS.length], omega: rand(11, 15), bobA: rand(4, 5), alpha: 0, dashV: 620, cls: 'crew' });
  c.alphaGoal = 0;
  return c;
}
// Made at the state change that brings a new band record: all hidden until the scene uses them
function prepareCrew(band) {
  scatterCrew(CR.crew);
  for (const ch of CR.chips.concat(CR.shrink)) { ch.aGoal = 0; ch.dead = true; CR.oldChips.push(ch); }
  CR.crew = []; CR.chips = []; CR.shrink = []; CR.idx = []; CR.carrier = null; CR.carrierK = -1;
  CR.key = band ? band.key : null; CR.band = band; CR.busy = false;
  if (!band || !band.cells.length) return;
  const n = band.cells.length, c = Math.min(n, 10);
  for (let k = 0; k < c; k++) {
    const idx = n > 10 ? Math.round((k * (n - 1)) / 9) : k;
    CR.idx.push(idx);
    CR.crew.push(makeCrew(k));
    CR.chips.push(new Chip(V.layer.chips, band.cells[idx], !band.cells[idx].ok));
    if (CR.carrierK < 0 && !band.cells[idx].ok) CR.carrierK = k;
  }
  if (CR.carrierK >= 0) CR.carrier = CR.crew[CR.carrierK];
  for (const s of band.shrink) CR.shrink.push(new Chip(V.layer.chips, s, true));
}
// Chip drop: 0.24 s fall → landing press, then the chip fades over the base cell
function dropTo(ch, slot, done) {
  ch.holder = null;
  const fade = () => { ch.rate = 1 / 0.15; ch.aGoal = 0; ch.dead = true; };
  if (RM) { ch.p.x = slot.x; ch.p.y = slot.y; ch.rot = 0; if (done) done(); fade(); return; }
  const x0 = ch.p.x, y0 = ch.p.y, r0 = ch.rot;
  tween(0, 0.24, (e) => { ch.p.x = lerp(x0, slot.x, e); ch.p.y = lerp(y0, slot.y, e); ch.rot = lerp(r0, 0, e); }, {
    ease: easeInSine, motion: true,
    done: () => {
      ch.p.x = slot.x; ch.p.y = slot.y; ch.rot = 0;
      tween(0, 0.22, (e) => { ch.sc = 1 - 0.09 * Math.sin(e * Math.PI); }, { ease: (u) => u, done: fade }, 'c');
      if (done) done();
    },
  }, 'c');
}
// One crew member: fly in with a chip, drop it on its cell and sit on the cell
function deliver(k, onLanded) {
  const cell = CR.band.cells[CR.idx[k]], slot = cellPos(cell), c = CR.crew[k], ch = CR.chips[k];
  const fromEdge = k % 2 === 0;
  const sx = fromEdge ? -90 : G.rc.x + rand(-30, 30), sy = fromEdge ? rand(800, 960) : G.rc.y + rand(-10, 30);
  c.place(sx, sy); c.alpha = 0; c.alphaGoal = 1;
  c.setFace(slot.x >= sx ? 1 : -1, true);
  c.faceS = c.face;
  ch.holder = c; ch.aGoal = 1; ch.rate = 6; ch.dead = false;
  c.lookAt = slot;
  c.flyTo(slot.x, slot.y - 40 - holdY(c), rand(0.75, 0.95), {
    done: guard(() => dropTo(ch, slot, () => {
      ch.reveal();
      APP.reveal('cell', CR.idx[k]);
      c.hop(0, -16, 0.3);
      if (c === CR.carrier) c.lookAt = CR.band.shrink[0] ? cellPos(CR.band.shrink[0]) : null;
      else {
        const pp = perchPos(slot, c, k, cell.w);
        at(0.16, () => c.flyTo(pp.x, pp.y, 0.45, { antic: 0 }), 'c');
        c.lookAt = null;
      }
      if (onLanded) onLanded();
    }), 'c'),
  });
}
// Shrinking: the failing input is carried cell to cell down to the minimal counterexample
function shrinkStep(m, onEnd) {
  const c = CR.carrier, cells = CR.band.shrink;
  if (!c || !cells[m]) { if (onEnd) onEnd(); return; }
  const from = m === 0 ? CR.chips[CR.carrierK] : CR.shrink[m - 1];
  const slot = cellPos(cells[m]);
  c.lookAt = slot;
  c.flyTo(from.p.x, from.p.y - holdY(c), m === 0 ? 0.42 : 0.3, {
    antic: m === 0 ? undefined : 0,
    done: guard(() => {
      const ch = CR.shrink[m];
      ch.p.x = from.p.x; ch.p.y = from.p.y; ch.aGoal = 1; ch.rate = 6; ch.dead = false; ch.holder = c;
      at(0.1, () => c.flyTo(slot.x, slot.y - 36 - holdY(c), 0.5, {
        done: guard(() => dropTo(ch, slot, () => {
          ch.reveal();
          APP.reveal('shrink', m);
          if (m < cells.length - 1) at(0.18, () => shrinkStep(m + 1, onEnd), 'c');
          else {
            const pp = carrierPerch(slot, c, cells[m].w);
            c.lookAt = slot;
            c.flyTo(pp.x, pp.y, 0.45, { antic: 0, done: guard(() => { if (onEnd) onEnd(); }, 'c') });
          }
        }), 'c'),
      }), 'c');
    }, 'c'),
  });
}
// Crew sent off outwards and faded (about 700px over 1.4–1.6 s)
function scatterCrew(list) {
  const go = list.filter((c) => !c.gone);
  CR.crew = CR.crew.filter((c) => !go.includes(c));
  if (go.includes(CR.carrier)) CR.carrier = null;
  go.forEach((c, k) => {
    c.gone = true;
    CR.old.push(c);
    at(k * 0.07, () => {
      const a = Math.atan2(c.p.y - 760, c.p.x - 900) + rand(-0.5, 0.5);
      c.lookAt = null;
      c.flyTo(c.p.x + Math.cos(a) * 700, c.p.y + Math.sin(a) * 450 - 160, rand(1.4, 1.6), { antic: 10 });
      at(0.75, () => { c.alphaGoal = 0; }, 'x');
    }, 'x');
  });
}
// Crew scene: cells revealed as chips land, then info, shrink cells, and the band in full
function startCrew() {
  kill('c');
  const band = CR.band;
  if (!band) return;
  CR.busy = true; CR.t0 = T.now;
  note('crew:start');
  APP.reveal('slots');
  APP.phase('반례 찾기 기록');
  at(0.2, () => revealHeld('hook'), 'c');
  const n = CR.crew.length;
  const startShrink = guard(() => {
    APP.reveal('info');
    APP.phase('반례 줄이기');
    const s0 = band.shrink[0];
    if (s0 && watching()) { const p = cellPos(s0); G.lookAt = p; Beam.aim(p.x + 120, p.y); }
    at(0.3, () => shrinkStep(0, guard(endCrew, 'c')), 'c');
  }, 'c');
  let landed = 0;
  const onLanded = () => { landed += 1; if (landed === n) at(0.45, startShrink, 'c'); };
  for (let k = 0; k < n; k++) at(1.7 + k * 0.22, () => deliver(k, onLanded), 'c');
  if (!n) at(1.7, startShrink, 'c');
}
function endCrew() {
  CR.busy = false; CR.endAt = T.now;
  note('crew:end');
  APP.reveal('band');
  const band = CR.band;
  APP.phase('최소 반례 ' + formatExample(band.counterexample));
  const last = band.shrink[band.shrink.length - 1];
  if (last && watching()) Beam.aim(cellPos(last));
  if (R.onCrewEnd) { const f = R.onCrewEnd; R.onCrewEnd = null; f(); }
}
// Crew already in place (start, reconnect, reset): sitting on the cells, no chips
function snapCrew() {
  const band = CR.band;
  CR.chips.concat(CR.shrink).forEach((ch) => { ch.a = 0; ch.aGoal = 0; ch.holder = null; ch.dead = true; });
  if (!band) return;
  CR.crew.forEach((c, k) => {
    const cell = band.cells[CR.idx[k]], slot = cellPos(cell), pp = perchPos(slot, c, k, cell.w);
    c.place(pp.x, pp.y); c.alpha = 1; c.alphaGoal = 1; c.lookAt = null; c.gone = false;
  });
  const last = band.shrink[band.shrink.length - 1];
  if (CR.carrier && last) { const s = cellPos(last), pp = carrierPerch(s, CR.carrier, last.w); CR.carrier.place(pp.x, pp.y); CR.carrier.lookAt = s; }
  CR.busy = false;
}

// Reveal held activity lines of one kind ('hook' held with a new red, 'block' held until the sign)
function revealHeld(action) {
  const why = action === 'hook' ? 'c' : 'd';
  for (const a of VIEW.act.slice()) if (!a.shown && a.hold === why && a.ev.action === action) APP.reveal('act', a.ev);
}
// After the first lap: lines that came during it, one a second from 0.95 s
function lapLines() {
  const next = () => {
    const a = VIEW.act.find((x) => !x.shown && x.hold === 'b');
    if (!a) return;
    APP.reveal('act', a.ev);
    at(1.0, next, 'x');
  };
  at(0.95, next, 'x');
}

// ── inspector reactions: one at a time, by priority (design '차례')
const R = { mode: 'none', idle: '', queue: [], holding: false, holdEv: null, holdT: 0, holdPhased: false, onCrewEnd: null, patrolN: 0, firstLap: false, lapLeft: 0, lookUntil: 0, lookAt: null, cutDone: false };
const watching = () => R.mode === 'watch' || R.mode === 'chain-watch';
const labelOf = (th) => { const r = VIEW.reqs[th.i]; return r ? r.label : ''; };
function endFirstLap() {
  if (!R.firstLap) return;
  R.firstLap = false;
  APP.reveal('all');
  lapLines();
}
function begin(mode, kind) {
  if (R.mode === 'idle' && R.idle === 'patrol') endFirstLap();
  kill('i');
  R.mode = mode;
  if (kind) note(kind + ':start');
}
function finish(kind) {
  if (kind) note(kind + ':end');
  enterIdle();
  pump();
}
// What the inspector does between reactions
function enterIdle() {
  kill('i');
  R.mode = 'idle';
  const rep = VIEW.report;
  if (!rep) { R.idle = 'rest'; Beam.onGoal = 0; G.lookAt = null; G.flyTo(REST.x, REST.y, 1.0); Beam.aim(700, 760); return; }
  if (rep.overall === 'red') {
    const reds = VIEW.reqs.filter((r) => r.verdict === 'red');
    if (reds.length && reds.every((r) => r.reason === 'run-failed')) {
      R.idle = 'failed'; Beam.onGoal = 0;
      const p = VIEW.guardPost;
      if (Math.hypot(G.lead.x - p.x, G.lead.y - p.y) > 8) G.flyTo(p.x, p.y, 1.0, { face: 1 });
      return;
    }
    if (R.holding) { holdIdle(); return; }
    redIdle();
    return;
  }
  startPatrol(false);
}
// The red being watched: first red requirement (report order) that is not run-failed
function redTarget() {
  const items = VIEW.report && Array.isArray(VIEW.report.requirements) ? VIEW.report.requirements : [];
  for (const it of items) {
    if (it.verdict !== 'red' || it.reason === 'run-failed') continue;
    const r = reqOf(it.id);
    if (r) return r;
  }
  return null;
}
// Where the inspector stands to hold a red: over the knot of its main thread, clear of every stamp
function catchSpot(r) {
  const th = r && r.primary ? V.threads.get(r.primary) : null;
  if (!th || !r.anchor) return { spot: { x: 462, y: clamp((r ? r.cy : 470) - 150, 205, 760) }, aim: { x: 408, y: r ? r.cy : 470 }, th: null };
  return { spot: hoverFor(th, uOf(th, r.anchor), 0, stampBoxes(true)), aim: r.anchor, th };
}
function redIdle() {
  R.idle = 'red';
  const r = redTarget();
  const c = catchSpot(r);
  R.lastCatch = c;
  if (Math.hypot(G.lead.x - c.spot.x, G.lead.y - c.spot.y) > 12) G.flyTo(c.spot.x, c.spot.y, 0.95);
  Beam.aim(c.aim); Beam.onGoal = 1; Beam.redGoal = 1;
  G.lookAt = c.aim;
}
// Holding the STOP! sign at the activity post: beam on the block line, then on the buttons
function holdIdle() {
  R.idle = 'hold';
  const p = VIEW.guardPost;
  if (Math.hypot(G.lead.x - p.x, G.lead.y - p.y) > 8) {
    Beam.onGoal = 0; Sign.raise(false);
    G.flyTo(p.x, p.y, 1.0, { face: 1, done: guard(() => { Beam.onGoal = 1; Sign.raise(true); }) });
  } else { Sign.raise(true); Beam.onGoal = 1; }
}
function holdAim() {
  if (R.mode !== 'idle' || R.idle !== 'hold') return;
  const e = T.now - R.holdT;
  if (!R.holdPhased && e >= 2.8) { R.holdPhased = true; APP.phase('사람 결정 대기'); }
  const a = actEntry(R.holdEv);
  const p = e < 3.3 && a ? a.ts : BUTTONS;
  Beam.aim(p.x, p.y);
  G.lookAt = p;
}

// ── patrol: threads in order, even ones 0.05 → 0.95, odd ones back, 1.0 s each, 1.65 s apart, no rest between laps
function routeAt(n) {
  const th = V.patrol[n % V.patrol.length], odd = n % 2 === 1;
  return { th, u0: odd ? 0.95 : 0.05, u1: odd ? 0.05 : 0.95, dir: odd ? -1 : 1 };
}
function startPatrol(entrance) {
  R.idle = 'patrol';
  if (!V.patrol.length) { R.idle = 'rest'; Beam.onGoal = 0; G.lookAt = null; G.flyTo(REST.x, REST.y, 1.0); return; }
  R.lapLeft = V.patrol.length;
  const r0 = routeAt(R.patrolN), h = hoverFor(r0.th, r0.u0, r0.dir), p = pointAt(r0.th.tb, r0.u0);
  Beam.onGoal = 0;
  if (entrance) {
    at(0.15, () => { APP.phase('순찰 시작'); G.flyTo(h.x, h.y, 1.0); });
    at(0.25, () => say('NIGHT PATROL', 1.0));
  } else {
    APP.phase('순찰 시작');
    G.lookAt = null;
    G.flyTo(h.x, h.y, 1.0);
  }
  at(1.15, () => { Beam.aim(p.x, p.y); Beam.onGoal = 1; });
  patrolStep(1.45, true);
}
function patrolStep(delay, first) {
  const r = routeAt(R.patrolN);
  R.patrolN += 1;
  const th = r.th;
  if (!first) {
    at(delay - 0.55, () => {
      const h = hoverFor(th, r.u0, r.dir), p = pointAt(th.tb, r.u0);
      G.flyTo(h.x, h.y, 0.42);
      Beam.aim(p.x, p.y);
    });
  }
  at(delay, () => { APP.phase('순찰 중 · ' + labelOf(th)); Beam.onGoal = 1; });
  sweep(th, delay, 1.0, r.u0, r.u1, () => {
    if (!R.firstLap) return;
    APP.reveal('patrol', th.key);
    R.lapLeft -= 1;
    if (R.lapLeft <= 0) {
      R.firstLap = false;
      at(0.1, () => { APP.reveal('all'); APP.phase('순찰 완료'); lapLines(); }, 'x');
    }
  });
  at(delay + 1.0, () => patrolStep(0.65, false));
}

// ── scenes
// Changed glyph look: fly near the line, beam on the new glyph, 'HMM?', stay until 4.1 s
function codeLook(next) {
  const ln = VIEW.changed[0];
  if (!ln) { next(); return; }
  const mk = ln.mark || { x: L.code.x + 60, y: ln.cy };
  APP.phase('코드 변경 감지');
  G.lookAt = mk;
  at(0.3, () => {
    const s = avoid({ x: 650, y: clamp(ln.cy + 170, 205, 760) }, stampBoxes(false));
    G.flyTo(s.x, s.y, 0.6);
    Beam.aim(mk.x, mk.y); Beam.onGoal = 1;
    say('HMM?', 1.5);
    G.boo(1);
  });
  at(4.1, () => { note('code:end'); next(); });
}
// Watching the band during the crew scene (the inspector's part)
function watch(next) {
  const band = CR.band;
  const row = band ? band.row : { x: 590, y: 978 };
  const e = T.now - CR.t0;
  const spot = avoid({ x: 640, y: 650 }, stampBoxes(false));
  at(Math.max(0, 0.5 - e), () => { G.flyTo(spot.x, spot.y, 0.7); Beam.aim(row.x, row.y); Beam.onGoal = 1; G.lookAt = { x: row.x, y: row.y }; });
  if (e < 1.3) at(1.3 - e, () => { say('KIRO CREW,\nASSEMBLE!', 2.6); G.boo(1.6); });
  if (!CR.busy) at(Math.max(0, CR.endAt + 1.1 - T.now), next);
  else R.onCrewEnd = guard(() => at(1.1, next));
}
// Catch: sweep the main thread to the knot, cut every new red thread in the same frame, then the reveal beats
function catchScene(ids, done) {
  const items = VIEW.report && Array.isArray(VIEW.report.requirements) ? VIEW.report.requirements : [];
  const first = items.find((it) => ids.has(it.id) && it.reason !== 'run-failed');
  const r = first ? reqOf(first.id) : null;
  const a = r && r.primary ? V.threads.get(r.primary) : null;
  const cutList = [...V.threads.values()].filter((f) => ids.has(f.id) && f.halves && !f.broken);
  R.cutDone = false;
  Sign.raise(false);
  note('red:start');
  APP.phase('다시 순찰 · ' + (r ? r.label : ''));
  const beats = () => {
    R.cutDone = true;
    Beam.redGoal = 1;
    APP.reveal('cut');
    cutList.forEach((f) => cutThread(f, false));
    const k = (r && r.anchor) || { x: 408, y: r ? r.cy : 470 };
    Bursts.add(k.x, k.y);
    G.surprise(0.9);
    G.hop(-26 * G.face, -56, 0.5);
    say('!', 0.9);
    G.lookAt = k;
    CR.crew.forEach((c) => { if (!c.gone) { c.lookAt = k; c.eyesWide(1.3, 0.7); } });
    note('red:cut');
    at(0.15, () => APP.reveal('stamp'));
    at(0.5, () => APP.reveal('card'));
    at(0.9, () => { APP.reveal('status'); APP.phase('위반 발견'); if (!CR.busy) revealHeld('hook'); });
    at(1.0, () => { note('red:end'); done(); });
  };
  if (!a || !r.anchor) {
    const c = catchSpot(r);
    at(0.1, () => { G.flyTo(c.spot.x, c.spot.y, 0.5); Beam.aim(c.aim); Beam.onGoal = 1; });
    at(0.7, beats);
    return;
  }
  const boxes = stampBoxes(true);
  at(0.1, () => {
    const h = hoverFor(a, 0.05, 1, boxes), p = pointAt(a.tb, 0.05);
    G.flyTo(h.x, h.y, 0.34);
    Beam.aim(p.x, p.y); Beam.onGoal = 1;
  });
  sweep(a, 0.6, 0.75, 0.05, uOf(a, r.anchor), guard(beats), easeInOutCos, boxes);
}
// Every new red is run-failed: lamp off, fly to the activity post, look at the latest hook line, '?'
function failedScene(done) {
  note('failed:start');
  APP.phase('검사 실행 실패');
  Beam.onGoal = 0;
  const hk = lastShown('hook');
  G.lookAt = hk ? hk.center : null;
  const p = VIEW.guardPost;
  G.flyTo(p.x, p.y, 1.0, { face: 1, done: guard(() => say('?', 0.9, BUB_ACT)) });
  at(1.3, () => { note('failed:end'); done(); });
}
// Block: lamp off, fly to the post, light the latest write line, then the block line with the STOP! sign
function blockScene(ev, done) {
  note('block:start');
  APP.phase('에이전트 차단');
  Beam.onGoal = 0;
  Sign.raise(false);
  const w = lastShown('write');
  const first = w ? w.ts : (actEntry(ev) || { ts: BUTTONS }).ts;
  G.lookAt = first;
  const p = VIEW.guardPost;
  const raise = () => {
    const a = actEntry(ev), t = a ? a.ts : BUTTONS;
    Beam.aim(t.x, t.y); G.lookAt = t;
    Sign.raise(true);
    G.boo(1.4);
    G.hop(12 * G.face, -16, 0.3);
    revealHeld('block');
    APP.reveal('act', ev);
    note('block:end');
    R.holding = true; R.holdEv = ev; R.holdT = T.now; R.holdPhased = false;
    done();
  };
  G.flyTo(p.x, p.y, 1.0, {
    face: 1,
    done: guard(() => {
      const a = w || actEntry(ev), t = a ? a.ts : BUTTONS;
      Beam.aim(t.x, t.y); Beam.onGoal = 1;
      if (w) at(0.7, raise); else raise();
    }),
  });
}
// Person decided: look at the HUMAN line and nod; lower the sign; go back to the knot if still red
function humanScene(ev, done) {
  note('human:start');
  nod(ev);
  APP.phase('사람이 결정');
  const had = R.holding;
  R.holding = false;
  if (had || Sign.up) at(0.6, () => Sign.raise(false));
  at(1.0, () => {
    const rep = VIEW.report;
    if (rep && rep.overall === 'red' && redTarget()) {
      const c = catchSpot(redTarget());
      Beam.aim(c.aim); G.lookAt = c.aim; Beam.onGoal = 1;
      G.flyTo(c.spot.x, c.spot.y, 0.95, { done: guard(() => { note('human:end'); done(); }) });
    } else { note('human:end'); done(); }
  });
}
function nod(ev) {
  const a = actEntry(ev);
  if (a) G.lookAt = a.center;
  G.boo(1);
  G.leanTo(8 * G.face, 0.9);
  G.hop(16 * G.face, 8, 0.42);
}
// Red ended: rejoin the threads, lower the sign, white beam at 0.4 s, crew scatter at 1.1 s, joy when green
function clearScene(nodEv, green) {
  note('clear:start');
  for (const f of V.threads.values()) if (f.broken) joinThread(f);
  Sign.raise(false);
  R.holding = false; R.holdEv = null;
  if (nodEv) nod(nodEv);
  at(0.4, () => { APP.reveal('clear'); Beam.redGoal = 0; if (green) APP.phase('복구 완료'); });
  at(1.1, () => scatterCrew(CR.crew));
  const bandClear = () => {
    APP.reveal('band-clear');
    for (const ch of CR.chips.concat(CR.shrink, CR.oldChips)) { ch.rate = 1 / 0.35; ch.aGoal = 0; ch.dead = true; ch.holder = null; }
  };
  if (!green) { at(0.4, () => { bandClear(); note('clear:end'); finish(); }); return; }
  const t0 = T.now;
  const joy = () => {
    at(Math.max(0, 0.6 - (T.now - t0)), () => {
      G.happyGoal = 1; G.boo(1.8); G.hop(0, -48, 0.36); G.hop(0, -34, 0.32, 0.4);
      say('ALL CLEAR!', 2.0);
      note('clear:joy');
      at(2.6, () => { G.happyGoal = 0; G.lookAt = null; bandClear(); note('clear:end'); finish(); });
    });
  };
  Beam.onGoal = 1;
  if (!inZone(G.lead)) {
    const c = R.lastCatch || { spot: { x: 560, y: 470 }, aim: { x: 700, y: 760 } };
    Beam.aim(c.aim);
    G.flyTo(c.spot.x, c.spot.y, 0.95, { done: guard(joy) });
  } else joy();
}

// ── queue: start, wait or drop each pending reaction against what the inspector is doing
function decide(r) {
  const m = R.mode, idle = m === 'idle';
  switch (r.kind) {
    case 'chain': case 'failed':
      if (r.gate && r.gate() > T.now) return 'wait';
      return idle || m === 'code' || m === 'watch' ? 'start' : 'wait';
    case 'human':
      return idle || ['code', 'watch', 'chain-code', 'chain-watch', 'dwell'].includes(m) ? 'start' : 'wait';
    case 'block':
      if (!VIEW.report || VIEW.report.overall !== 'red') return 'drop';
      if (R.queue.some((q) => q.kind === 'chain' || q.kind === 'failed')) return 'wait';
      if (CR.busy || watching()) return 'wait';
      return idle || m === 'code' ? 'start' : 'wait';
    case 'code':
      return idle ? 'start' : m === 'dwell' ? 'wait' : 'drop';
    case 'watch':
      if (!CR.busy) return 'drop';
      return idle ? 'start' : m === 'dwell' ? 'wait' : 'drop';
    default: return 'drop';
  }
}
function pump() {
  if (!ready) return;
  for (let n = 0; n < 8; n++) {
    R.queue.sort((a, b) => a.prio - b.prio || a.t - b.t);
    let acted = false;
    for (const r of R.queue) {
      const d = decide(r);
      if (d === 'wait') continue;
      R.queue.splice(R.queue.indexOf(r), 1);
      if (d === 'start') startReaction(r);
      acted = true;
      break;
    }
    if (!acted) break;
  }
}
const enqueue = (r) => { r.t = T.now; R.queue.push(r); };
function startReaction(r) {
  if (r.kind === 'human' && (R.mode === 'chain-code' || R.mode === 'chain-watch') && R.cur) {
    // The person cuts in before the catch: the catch follows (after the band watch if the crew is still on)
    const ch = R.cur;
    if (ch.crew && !ch.crewStarted) { ch.crewStarted = true; startCrew(); }
    const wasWatch = R.mode === 'chain-watch';
    enqueue({ kind: 'chain', prio: 2, ids: ch.ids, code: false, crew: false, gate: wasWatch ? () => (CR.busy ? Infinity : CR.endAt + 1.1) : null });
  }
  switch (r.kind) {
    case 'chain': runChain(r); break;
    case 'failed': begin('failed'); R.cur = r; failedScene(() => finish()); break;
    case 'human': begin('human'); R.cur = r; humanScene(r.ev, () => finish()); break;
    case 'block': begin('blockfly'); R.cur = r; blockScene(r.ev, () => finish()); break;
    case 'code': begin('code', 'code'); R.cur = r; codeLook(() => finish()); break;
    case 'watch': begin('watch'); R.cur = r; watch(() => finish()); break;
    default: break;
  }
}
function runChain(r) {
  begin(r.code ? 'chain-code' : r.crew ? 'chain-watch' : 'catch', r.code ? 'code' : null);
  R.cur = r;
  if (r.code) codeLook(() => afterCode(r)); else afterCode(r);
}
function afterCode(r) {
  if (r.crew && CR.band) {
    R.mode = 'chain-watch';
    if (!r.crewStarted) { r.crewStarted = true; startCrew(); }
    watch(() => toCatch(r));
  } else toCatch(r);
}
function toCatch(r) {
  R.mode = 'catch';
  R.lastCatch = catchSpot(redTarget());
  catchScene(r.ids, dwell);
}
// After a catch: 2.0 s on the knot with the red beam
function dwell() {
  kill('i');
  R.mode = 'dwell';
  if (R.cur) R.cur.done = true;
  redIdle();
  at(2.0, () => finish());
}

// ── signals: the last seen view against the new one
let LAST = null, quietUntil = Infinity;
function snapshot(view) {
  const items = view.report && Array.isArray(view.report.requirements) ? view.report.requirements : [];
  return {
    has: !!view.report, gen: view.generatedAt, overall: view.overall,
    red: new Set(items.filter((r) => r.verdict === 'red').map((r) => r.id)),
    band: view.band ? view.band.key : null,
  };
}
// Cut spots for the threads of requirements about to be caught: the knot on the main thread, a clear spot on the rest
function prepareCuts(ids) {
  const boxes = VIEW.stamps.map((s) => s.box);
  const all = [...V.threads.values()];
  for (const id of ids) {
    const r = reqOf(id);
    if (!r) continue;
    for (const f of all) {
      if (f.id !== id) continue;
      f.base = VIEW.threads.find((t) => t.key === f.key) || f.base;
      if (r.primary === f.key && r.anchor) prepareCut(f, r.t || 0.5);
      else prepareCut(f, pickCut(f, all, boxes, r));
    }
  }
}
function pickCut(f, all, boxes, r) {
  const others = all.filter((o) => o !== f).map((o) => ({ pts: o.tb.pts.filter((_, k) => k % 4 === 0), chk: o.base && o.base.check }));
  const prim = r && r.anchor ? r.anchor : null;
  const ghostAt = prim ? { x: prim.x, y: prim.y + (r.sigma > 0 ? -150 : 150) } : null;
  const boxDist = (p, b) => Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.y0 - p.y, 0, p.y - b.y1));
  let best = 0.5, bs = -Infinity;
  for (let t = 0.3; t <= 0.76; t += 0.02) {
    const p = bez(f.q, t);
    let s = Math.min(p.x - L.zone.x0 - 60, L.zone.x1 - p.x - 70);
    if (ghostAt) s = Math.min(s, Math.hypot(ghostAt.x - p.x, ghostAt.y - p.y) - 130);
    others.forEach((o) => { o.pts.forEach((q) => { s = Math.min(s, Math.hypot(q.x - p.x, q.y - p.y)); }); if (o.chk) s = Math.min(s, Math.hypot(o.chk.x - p.x, o.chk.y - p.y) - 14); });
    boxes.forEach((b) => { s = Math.min(s, boxDist(p, b) - 8); });
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}

// ── waiting look of the current state, without motion (start, reconnect, reset)
function snapBroken() {
  const rep = VIEW.report;
  const reds = rep && rep.overall === 'red' ? VIEW.reqs.filter((r) => r.verdict === 'red') : [];
  const cutting = reds.some((r) => r.reason !== 'run-failed');
  for (const f of V.threads.values()) {
    if (f.broken || f.joining) { setS(f.base.path, 'opacity', ''); f.broken = false; f.joining = false; }
    dropHalves(f);
  }
  if (cutting) {
    prepareCuts(reds.map((r) => r.id));
    for (const f of V.threads.values()) if (f.halves) cutThread(f, true);
  }
  Beam.redGoal = Beam.red = cutting ? 1 : 0;
}
function lastBlockAfterHuman() {
  let b = null, h = -1, bi = -1;
  VIEW.act.forEach((a, k) => { if (a.ev.action === 'block') { b = a; bi = k; } if (a.ev.action === 'human') h = k; });
  return b && bi > h ? b : null;
}
function snapAll(first) {
  kill('i'); kill('c');
  R.queue = []; R.onCrewEnd = null; R.cur = null; R.mode = 'idle';
  Bursts.clear();
  BUB.map.forEach((b) => b.hide());
  snapBroken();
  const rep = VIEW.report;
  const blk = rep && rep.overall === 'red' ? lastBlockAfterHuman() : null;
  R.holding = !!blk; R.holdEv = blk ? blk.ev : null; R.holdT = T.now; R.holdPhased = false;
  Sign.snap(!!blk);
  const band = VIEW.band ? VIEW.band.final : null;
  if (band && band.key) { if (CR.key !== band.key) prepareCrew(band); snapCrew(); } else if (CR.key) prepareCrew(null);
  if (first) {
    G.place(-170, 300); G.face = G.faceS = G.faceGoal = 1; Beam.on = 0; Beam.onGoal = 0;
    if (rep && (rep.overall === 'green' || rep.overall === 'yellow')) { R.firstLap = !!VIEW.patrolHold; R.idle = 'patrol'; startPatrol(true); }
    else at(0.15, () => enterIdle());
  } else enterIdle();
}
// Thread layout changed: rebuild what hangs on threads, drop reactions bound to them
function restructure() {
  for (const f of V.threads.values()) if (f.broken || f.joining) setS(f.base.path, 'opacity', '');
  buildThreads(VIEW);
  const m = R.mode;
  const bound = (m === 'idle' && R.idle === 'patrol') || m === 'code' || m === 'chain-code' || (m === 'catch' && !R.cutDone);
  if (bound) {
    if ((m === 'chain-code' || m === 'catch') && R.cur && R.cur.ids) enqueue({ kind: 'chain', prio: 2, ids: R.cur.ids, code: false, crew: false });
    if (m === 'idle') endFirstLap();
    kill('i'); R.mode = 'idle';
  }
  const pending = new Set();
  R.queue.forEach((q) => { if (q.ids) q.ids.forEach((id) => pending.add(id)); });
  const rep = VIEW.report;
  if (rep && rep.overall === 'red') {
    const done = VIEW.reqs.filter((r) => r.verdict === 'red' && !pending.has(r.id)).map((r) => r.id);
    if (VIEW.reqs.some((r) => r.verdict === 'red' && r.reason !== 'run-failed')) {
      prepareCuts(done);
      for (const f of V.threads.values()) if (f.halves && done.includes(f.id)) cutThread(f, true);
    }
    const pre = [...pending];
    if (pre.length) prepareCuts(pre);
  }
  if (bound) enterIdle();
}
function cleanup() {
  CR.old = CR.old.filter((c) => { if (c.alpha <= 0.01 && c.alphaGoal === 0) { c.g.remove(); return false; } return true; });
  const chipGone = (ch) => { if (ch.dead && ch.a <= 0.001 && !ch.removed) { ch.g.remove(); ch.removed = true; } };
  CR.chips.forEach(chipGone); CR.shrink.forEach(chipGone);
  CR.oldChips = CR.oldChips.filter((ch) => { chipGone(ch); return !ch.removed; });
  for (const f of V.threads.values()) if (f.done) { f.done = false; dropHalves(f); }
}

// ── entry points called by app.js
export function onState(view) {
  VIEW = view;
  if (!ready) return;
  cleanup();
  if (view.structKey !== V.structKey) restructure();
  syncGlow();
  const prev = LAST, cur = snapshot(view);
  LAST = cur;
  if (!prev || T.now < quietUntil) {
    if (prev && (prev.overall !== cur.overall || [...cur.red].some((id) => !prev.red.has(id)) || prev.band !== cur.band)) snapAll(false);
    return;
  }
  const redEnd = prev.overall === 'red' && cur.overall !== 'red';
  const newGen = cur.gen !== prev.gen;
  if (redEnd) {
    note('signal:clear');
    const human = R.queue.find((q) => q.kind === 'human');
    R.queue = []; R.onCrewEnd = null; CR.busy = false; CR.key = cur.band;
    kill('c');
    begin('clear');
    R.cur = null;
    clearScene(human ? human.ev : null, cur.overall === 'green');
    return;
  }
  if (cur.overall === 'red') {
    const ended = [...prev.red].filter((id) => !cur.red.has(id));
    for (const f of V.threads.values()) if (ended.includes(f.id) && f.broken) joinThread(f);
  }
  const fresh = prev.has && newGen ? [...cur.red].filter((id) => !prev.red.has(id)) : [];
  const code = newGen && view.changed.length > 0;
  if (fresh.length) {
    note('signal:red');
    const items = view.report.requirements.filter((r) => fresh.includes(r.id));
    if (items.every((r) => r.reason === 'run-failed')) enqueue({ kind: 'failed', prio: 2, ids: new Set(fresh) });
    else {
      if (code) note('signal:code');
      prepareCuts(fresh);
      const r = { kind: 'chain', prio: 2, ids: new Set(fresh), code, crew: false };
      enqueue(r);
      R.lastChain = { r, t: T.now };
    }
  } else if (code) { note('signal:code'); enqueue({ kind: 'code', prio: 4 }); }
  if (cur.band !== prev.band) onBandChange(view.band.final, cur.band);
  pump();
}
function onBandChange(band, key) {
  if (!key) { prepareCrew(null); return; }
  note('signal:crew');
  prepareCrew(band);
  const lc = R.lastChain;
  if (lc && T.now - lc.t <= 1 && !lc.r.done) {
    const r = lc.r;
    r.crew = true;
    if (R.queue.includes(r)) { if (!r.code) { r.crewStarted = true; startCrew(); } return; }
    if (R.cur === r && R.mode === 'chain-code') return;
    if (R.cur === r && R.mode === 'catch' && !R.cutDone) {
      kill('i'); R.mode = 'chain-watch'; r.crewStarted = true; startCrew(); watch(() => toCatch(r));
      return;
    }
  }
  startCrew();
  enqueue({ kind: 'watch', prio: 4 });
}
export function onEvents(view, lines) {
  VIEW = view;
  if (!ready || T.now < quietUntil) return;
  const red = view.report && view.report.overall === 'red';
  for (const ev of lines) {
    if (!ev) continue;
    if (ev.action === 'write') { note('signal:write'); APP.phase('에이전트 작업 중'); }
    else if (ev.action === 'block') {
      note('signal:block');
      if (!red) { const a = actEntry(ev); if (a) { G.lookAt = a.center; R.lookUntil = T.now + 1.0; } continue; }
      if (R.holding && R.mode === 'idle' && R.idle === 'hold') { R.holdEv = ev; R.holdT = T.now; R.holdPhased = false; continue; }
      const q = R.queue.find((x) => x.kind === 'block');
      if (q) q.ev = ev; else enqueue({ kind: 'block', prio: 3, ev });
    } else if (ev.action === 'human') { note('signal:human'); enqueue({ kind: 'human', prio: 3, ev }); }
  }
  pump();
}
export function onReset(view) {
  VIEW = view;
  if (!ready) return;
  cleanup();
  if (view.structKey !== V.structKey) {
    for (const f of V.threads.values()) if (f.broken || f.joining) setS(f.base.path, 'opacity', '');
    buildThreads(view);
  }
  syncGlow();
  quietUntil = T.now + 1;
  LAST = snapshot(view);
  snapAll(false);
}
// Light spots inside panels: stronger the closer the beam end, slid under the beam (transform only)
const litV = new WeakMap();
function litBox(o, dt) {
  if (!o.lit) return;
  const sp = Beam.spot, b = o.box;
  const dx = Math.max(b.x0 - sp.x, 0, sp.x - b.x1), dy = Math.max(b.y0 - sp.y, 0, sp.y - b.y1);
  const goal = Beam.on * (1 - smooth(0, o.fall || 44, Math.hypot(dx, dy)));
  const v = approach(litV.get(o.lit) || 0, goal, 5, dt);
  litV.set(o.lit, v);
  setS(o.lit, 'opacity', String(r3(v)));
  if (v > 0.001) setS(o.lit, 'transform', 'translateX(' + r2(clamp(sp.x - b.x0, -60, b.x1 - b.x0 + 60)) + 'px)');
  if (o.litW) setS(o.litW, 'opacity', String(r3(1 - Beam.red)));
  if (o.litR) setS(o.litR, 'opacity', String(r3(Beam.red)));
}
function updateLit(dt) {
  for (const p of VIEW.panels) litBox(p, dt);
  for (const a of VIEW.act) if (a.shown) litBox(a, dt);
}
export function frame(dt, t) {
  if (!ready) return;
  runDirector(t);
  pump();
  holdAim();
  if (R.lookUntil && t > R.lookUntil) { R.lookUntil = 0; if (R.mode === 'idle' && R.idle === 'patrol') G.lookAt = Beam.spot; }
  G.update(dt, t);
  Beam.update(dt, t, G);
  G.render(t);
  Sign.update(dt, t, G);
  BUB.map.forEach((b) => b.update(dt, t, G));
  for (const c of CR.crew) { c.update(dt, t); c.render(t); }
  for (const c of CR.old) { c.update(dt, t); c.render(t); }
  for (const ch of CR.chips) if (!ch.removed) ch.update(dt);
  for (const ch of CR.shrink) if (!ch.removed) ch.update(dt);
  for (const ch of CR.oldChips) if (!ch.removed) ch.update(dt);
  updateThreads(dt, t);
  Bursts.update(t);
  updateLit(dt);
}
// Wait for the fonts the bubbles use, at most ms (timed with rAF)
function fontsReady(ms) {
  const F = document.fonts;
  if (!F || !F.load) return Promise.resolve();
  const loads = [
    F.load('28px "Permanent Marker"', WORDS.join(' ')), F.load('600 16px "IBM Plex Mono"', '0123456789'), F.load('500 16px "IBM Plex Mono"', '0123456789'),
    F.load('800 31px "Pretendard Variable"', '모든 요구사항'), F.load('900 34px "Anybody"', 'Tripwire'),
  ].map((p) => p.catch(() => null));
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    Promise.all(loads).then(fin, fin);
    const t0 = performance.now();
    const tick = (now) => { if (done) return; if (now - t0 > ms) fin(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}
export function start(view, app) {
  APP = app;
  VIEW = view;
  buildFx();
  Beam.build();
  Sign.build();
  Bursts.build();
  G = new Ghost(V.layer.ghost, { size: 220, x: -170, y: 300, big: true, omega: 13, bobA: 5, cls: 'insp' });
  for (const w of WORDS) BUB.map.set(w, new Bubble(V.layer.bubble, w));
  buildThreads(view);
  fontsReady(2500).then(() => {
    measureBubbles();
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', measureBubbles);
    if (VIEW.structKey !== V.structKey) buildThreads(VIEW);
    syncGlow();
    ready = true;
    quietUntil = T.now + 1;
    LAST = snapshot(VIEW);
    snapAll(true);
  });
}
