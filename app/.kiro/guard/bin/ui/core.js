// Shared stage constants, math, easing, springs, curves and DOM helpers.
// Used by app.js (base screen) and fx.js (inspector layer).

export const TAU = Math.PI * 2;
export const NS = 'http://www.w3.org/2000/svg';
export const RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
export const DT_MAX = 0.05;

// Stage layout (stage px, same values as style.css)
export const L = {
  cards: { x: 28, y: 128, w: 380, h: 738, gap: 10 },
  code: { x: 760, y: 128, w: 600, h: 738, lineH: 46 },
  act: { x: 1402, y: 128, w: 498, h: 600, lineH: 46, gap: 4 },
  slots: { x: 32, y: 946, w: 100, h: 64, gap: 12 },
  shrink: { x: 1196, y: 946, w: 132, h: 64, arrow: 40 },
  zone: { x0: 408, x1: 760, y0: 128, y1: 866 },
};

// ✓ and ✗ drawn as lines instead of glyphs
export const ICON_OK = '<svg class="ico" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 6.5 L4.6 9.6 L10.5 2.6"/></svg>';
export const ICON_NG = '<svg class="ico" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 2.2 L9.8 9.8 M9.8 2.2 L2.2 9.8"/></svg>';

// Loop clock in seconds (advanced by the app loop only)
export const T = { now: 0 };

// ── math
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const easeInOutCos = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInSine = (t) => 1 - Math.cos((clamp(t, 0, 1) * Math.PI) / 2);
export const easeOutBack = (t, c = 1.70158) => { const u = clamp(t, 0, 1) - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
export const deg = (r) => (r * 180) / Math.PI;
export const r2 = (v) => Math.round(v * 100) / 100;
export const r3 = (v) => Math.round(v * 1000) / 1000;
export const approach = (v, goal, rate, dt) => (v < goal ? Math.min(goal, v + rate * dt) : Math.max(goal, v - rate * dt));

// Critically damped spring (closed form, stable for large dt)
export function springCD(x, v, target, omega, dt) {
  const y = x - target, e = Math.exp(-omega * dt), k = v + omega * y;
  return [target + (y + k * dt) * e, (v - k * omega * dt) * e];
}
// Underdamped spring, integrated in steps of at most 1/240 s
export function springUD(s, target, omega, zeta, dt) {
  let t = dt;
  while (t > 1e-6) {
    const h = Math.min(t, 1 / 240);
    s.v += (omega * omega * (target - s.x) - 2 * zeta * omega * s.v) * h;
    s.x += s.v * h;
    t -= h;
  }
}

// ── DOM helpers (attribute values also fill the setA cache)
export function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) {
    if (k === 'text') e.textContent = attrs[k];
    else { const v = String(attrs[k]); e.setAttribute(k, v); e['_a_' + k] = v; }
  }
  if (parent) parent.appendChild(e);
  return e;
}
export function htmlEl(tag, attrs, parent) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'text') e.textContent = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else { const v = String(attrs[k]); e.setAttribute(k, v); e['_a_' + k] = v; }
  }
  if (parent) parent.appendChild(e);
  return e;
}
// Write only when the value changed
export function setA(e, k, v) { const c = '_a_' + k; if (e[c] !== v) { e[c] = v; e.setAttribute(k, v); } }
export function setS(e, k, v) { const c = '_s_' + k; if (e[c] !== v) { e[c] = v; e.style[k] = v; } }
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── cubic Bézier curves
export function bez(q, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * q[0].x + b * q[1].x + c * q[2].x + d * q[3].x, y: a * q[0].y + b * q[1].y + c * q[2].y + d * q[3].y };
}
export function splitBez(q, t) {
  const m = (p, s) => ({ x: lerp(p.x, s.x, t), y: lerp(p.y, s.y, t) });
  const a = m(q[0], q[1]), b = m(q[1], q[2]), c = m(q[2], q[3]), d = m(a, b), e = m(b, c), f = m(d, e);
  return [[q[0], a, d, f], [f, e, c, q[3]]];
}
export const dOf = (q) => 'M' + r2(q[0].x) + ' ' + r2(q[0].y) + 'C' + r2(q[1].x) + ' ' + r2(q[1].y) + ' ' + r2(q[2].x) + ' ' + r2(q[2].y) + ' ' + r2(q[3].x) + ' ' + r2(q[3].y);
// Arc-length table so a point can move along the curve at even speed
export function arcTable(q, n = 96) {
  const pts = [], cum = [0];
  for (let s = 0; s <= n; s++) pts.push(bez(q, s / n));
  for (let s = 1; s <= n; s++) cum.push(cum[s - 1] + Math.hypot(pts[s].x - pts[s - 1].x, pts[s].y - pts[s - 1].y));
  return { pts, cum, len: cum[n] };
}
export function pointAt(tb, u) {
  const target = clamp(u, 0, 1) * tb.len;
  let lo = 0, hi = tb.cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tb.cum[mid] < target) lo = mid; else hi = mid; }
  const seg = tb.cum[hi] - tb.cum[lo] || 1, f = (target - tb.cum[lo]) / seg;
  return { x: lerp(tb.pts[lo].x, tb.pts[hi].x, f), y: lerp(tb.pts[lo].y, tb.pts[hi].y, f) };
}
