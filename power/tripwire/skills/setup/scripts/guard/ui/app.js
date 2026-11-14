// Stage screen: SSE state → view model → base drawing and motion, resolve buttons,
// and the reveal holds the inspector layer (fx.js) uses to time what becomes visible.
import { L, T, RM, DT_MAX, ICON_OK, ICON_NG, clamp, lerp, easeInOutCos, easeOutCubic, easeOutBack, r2, r3, approach, springCD, svgEl, htmlEl, setA, setS, $, esc, bez, dOf, arcTable } from './core.js';
import { reasonParts, bandText, summaryText, actionLabel, actionTone, cardBadge, stripBasis, diffSeg, choiceLabel, runsFor, shrinkView, bandInfo, valueText, valueLength } from './format.js';

const params = new URLSearchParams(location.search);
const FX_WANTED = params.get('fx') !== '0';
const SPEED = Number(params.get('fxspeed')) > 0 ? Number(params.get('fxspeed')) : 1;
const fxLog = window.fxLog || (window.fxLog = []);
const note = (what) => { fxLog.push({ t: performance.now(), what }); };

const state = {
  index: null, report: null, resolution: null, sealed: null,
  prevReport: null,
  runs: new Map(),
  events: [],
  changed: new Map(),   // pair key → changed segment of the current report
  connected: null,
  notice: null,
  pending: false,
};

// ── connection and fx flags
let FX = null;              // fx module once imported
let fxStarted = false;      // FX.start called
let everOpen = false;       // a stream connection opened before
let reconnecting = false;   // from a reconnect until its events-reset
let firstReset = true;      // the first events-reset is still to come
let quietUntil = Infinity;  // no holds before this loop time
let reportSeen = false;     // a report was drawn on this page
let patrolPending = false;  // the first report asks for the first-patrol hold
let snapNext = true;        // next render places things without motion
let phaseText = '';
let dirty = true;

// ── reveal holds
const H = { patrol: null, catchH: null, band: null, clear: null };
const actHide = new Map();  // event → { why: 'b'|'c'|'d'|'wait', cap, at }
const enter = new Map();    // event → how its line appears: 'slide' | 'reveal'
let excluded = null;        // signature → count of first-draw lines kept hidden
let nB = 0;                 // lines held during the first patrol lap
let signRaised = false;     // the inspector raised the sign in this red
let lastNewRedAt = -Infinity;
let cutAt = -Infinity;      // loop time of the last cut (estimates the dwell)
let lastBandKey = null;
let bandKeyAt = -Infinity;

const holdsOn = () => !!(FX && fxStarted && !reconnecting && T.now >= quietUntil);
const sig = (ev) => (ev && ev.ts) + '|' + (ev && ev.action) + '|' + (ev && ev.target);
const dwellLeft = () => Math.max(0, cutAt + 3.25 - T.now);

// ── view shared with fx.js (stage coordinates, updated in place)
const V = {
  L, scale: 1, report: null, overall: null, generatedAt: null,
  reqs: [], lines: [], threads: [], patrol: [], stamps: [], act: [], band: null,
  panels: [], boxes: {}, guardPost: { x: 1385, y: 300 }, changed: [], structKey: '', patrolHold: false,
};

// ── DOM registries keyed by data
const dom = { cards: new Map(), lines: new Map(), chips: new Map(), gaps: new Map(), threads: new Map(), stamps: new Map(), act: new Map(), band: null, bandSig: '' };

// Writes that run only when the value changed
const put = (el, k, v, fn) => { const c = '_c_' + k; if (el[c] !== v) { el[c] = v; fn(v); } };
const txt = (el, v) => put(el, 'text', v, () => { el.textContent = v; });
const htm = (el, v) => put(el, 'html', v, () => { el.innerHTML = v; });
const cls = (el, v) => put(el, 'class', v, () => { el.setAttribute('class', v); });
const hid = (el, v) => put(el, 'hidden', v, () => { el.hidden = v; });
const attr = (el, k, v) => setA(el, k, String(v));

// Code line HTML: strings, comments and the changed segment
function codeHTML(text, mark) {
  const cl = new Array(text.length).fill('');
  const ci = text.indexOf('//');
  const end = ci >= 0 ? ci : text.length;
  if (ci >= 0) for (let k = ci; k < text.length; k++) cl[k] = 'cm';
  let inStr = false;
  for (let k = 0; k < end; k++) { if (text[k] === "'") { cl[k] = 'str'; inStr = !inStr; } else if (inStr) cl[k] = 'str'; }
  if (mark) for (let k = mark.p; k < mark.p + mark.len && k < text.length; k++) cl[k] = 'mark';
  let out = '', cur = null, buf = '';
  const flush = () => {
    if (!buf) return;
    const t = esc(buf);
    out += cur === 'mark' ? '<mark>' + t + '</mark>' : cur ? '<span class="' + cur + '">' + t + '</span>' : t;
    buf = '';
  };
  for (let k = 0; k < text.length; k++) { if (cl[k] !== cur) { flush(); cur = cl[k]; } buf += text[k]; }
  flush();
  return out;
}
// EARS sentence: keywords and `code`
const earsHTML = (t) => esc(t)
  .replace(/`([^`]+)`/g, '<span class="kw">$1</span>')
  .replace(/\b(WHEN|THEN|SHALL|IF|WHILE|WHERE)\b/g, '<span class="kw">$1</span>');
const litHTML = '<i class="lit-w"></i><i class="lit-r"></i>';
const lastPart = (p) => String(p).split(/[\\/]/).pop();
const cut12 = (s) => (Array.from(s).length > 12 ? Array.from(s).slice(0, 11).join('') + '…' : s);

// ── code line keys
// Line key = file#n; pair key = file|links|order among lines with the same file and links
function lineKeys(code) {
  const lines = code && Array.isArray(code.lines) ? code.lines : [];
  const main = code ? code.file : null;
  const seenPair = new Map(), seenKey = new Map();
  return lines.map((ln) => {
    const f = ln.file ?? main;
    const links = Array.isArray(ln.links) ? ln.links : [];
    const base = f + '|' + links.join(',');
    const order = seenPair.get(base) || 0;
    seenPair.set(base, order + 1);
    let key = f + '#' + ln.n;
    const dup = seenKey.get(key) || 0;
    seenKey.set(key, dup + 1);
    if (dup) key += '~' + dup;
    return { ln, f, links, key, pair: base + '|' + order };
  });
}
// Changed lines of a new report against the report before it
function computeChanged(old, rep) {
  state.changed = new Map();
  if (!old || !rep || !old.code || !rep.code) return;
  if (old.overall === 'red' && rep.overall !== 'red') return;
  const before = new Map(lineKeys(old.code).map((k) => [k.pair, String(k.ln.text ?? '')]));
  for (const k of lineKeys(rep.code)) {
    const a = before.get(k.pair), b = String(k.ln.text ?? '');
    if (a != null && a !== b) state.changed.set(k.pair, diffSeg(a, b));
  }
}

// ── counterexample band model
function emptyBand() {
  const slots = [], shrinks = [];
  for (let k = 0; k < 10; k++) slots.push({ x: L.slots.x + k * (L.slots.w + L.slots.gap), w: L.slots.w });
  for (let m = 0; m < 4; m++) shrinks.push({ x: L.shrink.x + m * (L.shrink.w + L.shrink.arrow), w: L.shrink.w });
  return { key: null, empty: true, slots, shrinks, cells: [], shrink: [], arrows: [], info: '', footIn: '', footShrink: '', row: { x: 590, y: 978 } };
}
function bandModel(rep) {
  const rec = runsFor(rep, state.runs);
  if (!rec) return emptyBand();
  const inputs = Array.isArray(rec.run.inputs) ? rec.run.inputs : [];
  const n = inputs.length;
  let gap = 12, w = 0;
  if (n) { const w12 = (1108 - 12 * (n - 1)) / n; if (w12 >= 48) w = Math.min(100, w12); else { gap = 2; w = (1108 - 2 * (n - 1)) / n; } }
  const cells = inputs.map((x, k) => ({ k, x: 32 + k * (w + gap), y: 946, w, ok: !!(x && x.ok), text: valueText(x && x.v), len: valueLength(x && x.v) }));
  const sv = shrinkView(rec.run.shrinkPath);
  const vals = [];
  sv.forEach((v, i) => { if (v !== null) vals.push({ v, afterGap: i > 0 && sv[i - 1] === null }); });
  const kc = vals.length, sw = kc ? Math.min(132, (692 - 40 * (kc - 1)) / kc) : 132;
  const shrink = vals.map((o, m) => ({ m, x: 1196 + m * (sw + 40), y: 946, w: sw, text: valueText(o.v), len: valueLength(o.v) }));
  const arrows = shrink.slice(1).map((s, i) => ({ m: i + 1, x: shrink[i].x + sw, text: vals[i + 1].afterGap ? '…' : '→' }));
  const row = cells.length ? { x: (cells[0].x + cells[cells.length - 1].x + w) / 2, y: 978 } : { x: 590, y: 978 };
  return {
    key: rec.name + '|' + rec.run.counterexample, empty: false, id: rec.item.id, counterexample: rec.run.counterexample ?? rec.item.counterexample,
    slots: cells.map((c) => ({ x: c.x, w })), shrinks: shrink.map((s) => ({ x: s.x, w: sw })),
    cells, shrink, arrows, info: bandInfo(rec.item, rec.run),
    footIn: '시험한 입력(기록된 ' + n + '개)', footShrink: '줄이기 경로 → 최소 반례', row,
  };
}
const crewDur = (b) => {
  const c = Math.min(b.cells.length, 10), m = b.shrink.length;
  return 5.68 + 0.22 * Math.max(0, c - 1) + 1.43 * Math.max(0, m - 1);
};

// ── model from data (no DOM): cards, code lines, threads, patrol order, band
let M = null;
function buildModel() {
  const rep = state.report, idx = state.index;
  const specs = idx && Array.isArray(idx.specs) ? idx.specs : [];
  const multi = specs.length > 1;
  const items = new Map((rep && Array.isArray(rep.requirements) ? rep.requirements : []).map((r) => [r.id, r]));
  const reqs = [];
  for (const sp of specs) for (const r of (Array.isArray(sp.requirements) ? sp.requirements : [])) {
    const id = sp.spec + ':' + r.id;
    reqs.push({ id, label: multi ? id : r.id, text: stripBasis(r.text, r.basis), basis: r.basis || null, item: items.get(id) || null, threads: [], primary: null, anchor: null, t: 0.5 });
  }
  const N = reqs.length, ch = N ? (L.cards.h - L.cards.gap * (N - 1)) / N : 0;
  const reqIndex = new Map();
  reqs.forEach((r, i) => {
    const top = i * (ch + L.cards.gap);
    r.i = i; r.top = top; r.h = ch; r.cy = L.cards.y + top + ch / 2;
    r.box = { x0: L.cards.x, y0: L.cards.y + top, x1: L.cards.x + L.cards.w, y1: L.cards.y + top + ch };
    r.clamp = Math.max(1, Math.floor((ch - 46 - (r.basis ? 22 : 0)) / 21.76));
    r.verdict = r.item ? r.item.verdict : null;
    r.reason = r.item ? r.item.reason : null;
    reqIndex.set(r.id, r);
  });
  const code = rep ? rep.code : null;
  const file = code && code.file != null ? code.file : null;
  const keyed = file !== null ? lineKeys(code) : [];
  const nl = keyed.length, pitch = nl ? L.code.h / nl : 0;
  const lh = nl > 12 ? Math.min(46, pitch - 4) : 46;
  const lines = keyed.map((k, j) => {
    const cy = L.code.y + pitch * (j + 0.5);
    const seg = state.changed.get(k.pair) || null;
    return {
      key: k.key, pair: k.pair, j, n: k.ln.n, file: k.f, text: String(k.ln.text ?? ''), links: k.links,
      label: k.ln.file ? lastPart(k.ln.file) + ':' + k.ln.n : String(k.ln.n),
      cy, top: cy - L.code.y - lh / 2, h: lh, one: lh < 42, seg, mark: null, end: 0,
      box: { x0: L.code.x, y0: cy - lh / 2, x1: L.code.x + L.code.w, y1: cy + lh / 2 },
    };
  });
  const gaps = [];
  for (let j = 0; j + 1 < lines.length; j++) {
    const a = lines[j], b = lines[j + 1];
    if (a.file === b.file && typeof a.n === 'number' && typeof b.n === 'number' && b.n - a.n > 1) {
      gaps.push({ key: a.key + '>' + b.key, text: '⋮ ' + (b.n - a.n - 1) + '줄', top: pitch * (j + 1) - 9 });
    }
  }
  const threads = [];
  lines.forEach((ln) => ln.links.forEach((id) => {
    const r = reqIndex.get(id);
    if (!r) return;
    const p0 = { x: L.cards.x + L.cards.w, y: r.cy }, p3 = { x: L.code.x, y: ln.cy }, dx = p3.x - p0.x;
    const q = [p0, { x: p0.x + 0.45 * dx, y: p0.y }, { x: p3.x - 0.45 * dx, y: p3.y }, p3];
    const th = { key: id + '|' + ln.key, id, i: r.i, j: ln.j, line: ln.key, q, tb: arcTable(q), span: Math.abs(p3.y - p0.y), d: dOf(q), mid: bez(q, 0.5), check: null, cls: '', path: null, above: bez(q, 0.5).y >= 430 };
    threads.push(th);
    r.threads.push(th.key);
    const best = r.primary ? threads.find((t) => t.key === r.primary) : null;
    if (!best || th.span < best.span) r.primary = th.key;
  }));
  const patrol = threads.slice().sort((a, b) => a.i - b.i || a.span - b.span).map((t) => t.key);
  M = { rep, reqs, reqIndex, lines, gaps, threads, patrol, file, noCode: !!rep && file === null, specs, band: bandModel(rep) };
  M.structKey = N + '|' + nl + '|' + threads.map((t) => t.key + '@' + t.i + ',' + t.j).join(';');
  return M;
}

// ── what each part shows while a hold is on
function itemFor(kind, id) {
  const fin = M.reqIndex.get(id) ? M.reqIndex.get(id).item : null;
  const c = H.catchH;
  if (c && c.ids.has(id)) {
    const prev = c.prevItems.get(id) || null;
    if ((kind === 'thread') && !c.cut) return prev;
    if (kind === 'stamp' && !c.stamp) return prev;
    if ((kind === 'card' || kind === 'line') && !c.card) return prev;
  }
  if (kind === 'card' && H.clear && !H.clear.status) return H.clear.items.get(id) || null;
  return fin;
}
const stateOf = (item) => cardBadge(item).state;
function threadCls(th) {
  if (H.patrol && !H.patrol.threads.has(th.key)) return '';
  return stateOf(itemFor('thread', th.id));
}
function lineCls(ln) {
  if (H.patrol && !H.patrol.lines.has(ln.key)) return '';
  const st = ln.links.filter((id) => M.reqIndex.has(id)).map((id) => stateOf(itemFor('line', id)));
  if (st.includes('red')) return 'red';
  return st.length && st.every((s) => s === 'pass') ? 'pass' : '';
}
function cardItem(r) {
  if (H.patrol && !H.patrol.cards.has(r.id)) return null;
  return itemFor('card', r.id);
}
function shownStatus() {
  const rep = state.report;
  if (H.patrol) {
    const n = M.reqs.filter((r) => H.patrol.cards.has(r.id) && r.verdict === 'green').length;
    return { tone: 'none', text: '순찰 중 · ' + n + '/' + M.reqs.length + ' 통과', sum: '', red: false };
  }
  if (H.catchH && !H.catchH.status) {
    if (H.catchH.crew) return { tone: 'none', text: '반례 확인 중', sum: '', red: false };
    const p = H.catchH.prev, b = bandText(p, state.resolution);
    return { tone: b.tone, text: b.text, sum: p ? summaryText(p.summary) : '', red: !!p && p.overall === 'red' };
  }
  if (H.clear && !H.clear.status) {
    const closed = state.resolution && Array.isArray(state.resolution.closed) ? state.resolution.closed : [];
    const b = bandText(H.clear.report, { approved: H.clear.approved.concat(closed) });
    return { tone: b.tone, text: b.text, sum: summaryText(H.clear.report.summary), red: true };
  }
  const b = bandText(rep, state.resolution);
  return { tone: b.tone, text: b.text, sum: rep ? summaryText(rep.summary) : '', red: !!rep && rep.overall === 'red' };
}

// ── holds set by a new report (the fx layer reacts to the same change)
function cCap() { return H.band ? H.band.cap : H.catchH ? H.catchH.cap : T.now + 4; }
function holdForReport(old, rep) {
  if (!old || !rep) return;
  const before = new Map((old.requirements || []).map((r) => [r.id, r]));
  const fresh = (rep.requirements || []).filter((r) => r.verdict === 'red' && !(before.get(r.id) && before.get(r.id).verdict === 'red'));
  if (old.overall !== 'red' && rep.overall === 'red') signRaised = false;
  if (fresh.some((r) => r.reason !== 'run-failed')) {
    const hasCode = state.changed.size > 0;
    let cap = hasCode ? 8.5 : 4.0;
    if (dwellLeft() > 0) cap += dwellLeft() + 0.2;
    H.catchH = {
      ids: new Set(fresh.map((r) => r.id)), prev: old, prevItems: before, hasCode,
      crew: false, cut: false, stamp: false, card: false, status: false, cap: T.now + cap, joined: false,
    };
    if (H.band && T.now - bandKeyAt <= 1 && !H.band.slots) { H.catchH.cap += crewDur(H.band.model) + 1.3; H.catchH.joined = true; }
    lastNewRedAt = T.now;
    for (const h of actHide.values()) if (h.why === 'wait' && h.at >= T.now - 1) { h.why = 'c'; h.cap = cCap(); }
  }
  if (old.overall === 'red' && rep.overall !== 'red') {
    H.clear = {
      report: old, items: before, approved: state.resolution && Array.isArray(state.resolution.approved) ? state.resolution.approved.slice() : [],
      status: false, capStatus: T.now + 1.5, band: shownBand && !shownBand.empty ? shownBand : null, capBand: T.now + 4,
    };
    H.band = null;
    for (const [ev, h] of actHide) if (h.why !== 'wait') actHide.delete(ev);
    signRaised = false;
  }
}

// ── activity list: last 12 lines without the first-draw lines; held lines keep their slot
const actTop = (k, n) => L.act.h - L.act.lineH - (n - 1 - k) * (L.act.lineH + L.act.gap);
function actLists() {
  const left = excluded ? new Map(excluded) : null;
  const all = [];
  for (const ev of state.events) {
    if (left) { const s = sig(ev), c = left.get(s); if (c > 0) { left.set(s, c - 1); continue; } }
    all.push(ev);
  }
  const full = all.slice(-12);
  const vis = all.filter((ev) => !actHide.has(ev)).slice(-12);
  return { full, vis };
}
function actView(lists) {
  const out = [];
  const slotOf = new Map(lists.full.map((ev, k) => [ev, L.act.y + actTop(k, lists.full.length)]));
  const visAt = new Map(lists.vis.map((ev, k) => [ev, L.act.y + actTop(k, lists.vis.length)]));
  const order = lists.full.slice();
  for (const ev of lists.vis) if (!slotOf.has(ev)) order.push(ev);
  order.sort((a, b) => state.events.indexOf(a) - state.events.indexOf(b));
  for (const ev of order) {
    const shown = visAt.has(ev);
    const slot = slotOf.has(ev) ? slotOf.get(ev) : visAt.get(ev);
    const y = shown ? visAt.get(ev) : slot;
    const it = dom.act.get(ev);
    const h = actHide.get(ev);
    out.push({
      ev, shown, y, slot, hold: h ? h.why : null,
      ts: { x: L.act.x + 64, y: y + L.act.lineH / 2 }, center: { x: L.act.x + 150, y: y + L.act.lineH / 2 },
      lit: it ? it.lit : null, litW: it ? it.litW : null, litR: it ? it.litR : null,
      box: { x0: L.act.x, y0: y, x1: L.act.x + L.act.w, y1: y + L.act.lineH },
    });
  }
  return out;
}

// ── drawing: status band
function drawStatus() {
  const s = shownStatus();
  const stage = $('stage');
  if (stage.dataset.overall !== s.tone) stage.dataset.overall = s.tone;
  txt($('status-text'), s.text);
  txt($('status-sum'), s.sum);
  txt($('status-phase'), state.connected === false ? '연결 끊김' : phaseText);
  return s;
}
// ── drawing: requirement cards
function drawCards() {
  const box = $('cards'), keep = new Set();
  const sealedIds = new Set();
  const sl = state.sealed && Array.isArray(state.sealed.sealed) ? state.sealed.sealed : [];
  for (const e of sl) for (const id of (Array.isArray(e && e.requirements) ? e.requirements : [])) sealedIds.add(id);
  for (const r of M.reqs) {
    keep.add(r.id);
    let c = dom.cards.get(r.id);
    if (!c) {
      const el = htmlEl('div', { class: 'card' }, box);
      const lit = htmlEl('i', { class: 'lit', html: litHTML }, el);
      const top = htmlEl('div', { class: 'card-top' }, el);
      c = {
        el, lit, litW: lit.firstChild, litR: lit.lastChild,
        idEl: htmlEl('span', { class: 'card-id' }, top), tests: htmlEl('span', { class: 'card-tests' }, top),
        seal: htmlEl('span', { class: 'card-seal' }, top), badge: htmlEl('span', { class: 'card-badge' }, top),
        text: htmlEl('div', { class: 'card-text' }, el), basis: htmlEl('div', { class: 'card-basis' }, el),
      };
      dom.cards.set(r.id, c);
    }
    setS(c.el, 'top', r.top + 'px');
    setS(c.el, 'height', r.h + 'px');
    const item = cardItem(r), b = cardBadge(item);
    cls(c.el, 'card' + (b.state ? ' ' + b.state : ''));
    txt(c.idEl, r.label);
    txt(c.tests, '검사 ' + (r.item && Array.isArray(r.item.tests) ? r.item.tests.length : state.report ? 0 : '-') + '개');
    const sealed = sealedIds.has(r.id), broken = sealed && item && item.reason === 'seal-broken';
    hid(c.seal, !sealed);
    cls(c.seal, 'card-seal' + (broken ? ' broken' : ''));
    txt(c.seal, broken ? '봉인 깨짐' : '봉인');
    htm(c.badge, (b.state === 'pass' ? ICON_OK : b.state === 'red' ? ICON_NG : '') + b.text);
    htm(c.text, earsHTML(r.text));
    setS(c.text, 'webkitLineClamp', String(r.clamp));
    hid(c.basis, !r.basis);
    txt(c.basis, r.basis ? '근거: ' + r.basis : '');
  }
  for (const [id, c] of dom.cards) if (!keep.has(id)) { c.el.remove(); dom.cards.delete(id); }
  const sp = M.specs;
  txt($('req-path'), sp.length === 1 ? '.kiro/specs/' + sp[0].spec : '.kiro/specs');
}

// ── drawing: code lines, gap marks and "just changed" chips
function drawLines() {
  const box = $('code'), keep = new Set();
  txt($('code-file'), M.file ?? '');
  let empty = box.querySelector('.no-code');
  if (M.noCode && !empty) empty = htmlEl('div', { class: 'no-code', text: '태그 달린 코드 줄 없음' }, box);
  if (empty) hid(empty, !M.noCode);
  for (const ln of M.lines) {
    keep.add(ln.key);
    let d = dom.lines.get(ln.key);
    if (!d) {
      const el = htmlEl('div', { class: 'cline', 'data-line': ln.key }, box);
      const lit = htmlEl('i', { class: 'lit', html: litHTML }, el);
      d = { el, lit, litW: lit.firstChild, litR: lit.lastChild, ln: htmlEl('span', { class: 'ln' }, el), tx: htmlEl('span', { class: 'tx' }, el), chip: null, chipA: 0 };
      dom.lines.set(ln.key, d);
    }
    setS(d.el, 'top', ln.top + 'px');
    setS(d.el, 'height', ln.h + 'px');
    const st = lineCls(ln);
    cls(d.el, 'cline' + (st ? ' ' + st : '') + (ln.seg ? ' changed' : '') + (ln.one ? ' one' : ''));
    txt(d.ln, ln.label);
    htm(d.tx, codeHTML(ln.text, ln.seg && ln.seg.to.length ? { p: ln.seg.p, len: ln.seg.to.length } : null));
    if (ln.seg && !d.chip) { d.chip = htmlEl('div', { class: 'diffchip' }, box); d.chipA = 0; }
    if (d.chip) {
      setS(d.chip, 'top', ln.top + 'px');
      if (ln.seg) {
        const f = cut12(ln.seg.from), t = cut12(ln.seg.to);
        txt(d.chip, f || t ? '방금 바뀜 ' + f + ' → ' + t : '방금 바뀜');
      }
      d.chipGoal = ln.seg ? 1 : 0;
    }
  }
  for (const [k, d] of dom.lines) if (!keep.has(k)) { d.el.remove(); if (d.chip) d.chip.remove(); dom.lines.delete(k); }
  const gk = new Set();
  for (const g of M.gaps) {
    gk.add(g.key);
    let el = dom.gaps.get(g.key);
    if (!el) { el = htmlEl('div', { class: 'gapmark' }, box); dom.gaps.set(g.key, el); }
    txt(el, g.text);
    setS(el, 'top', g.top + 'px');
  }
  for (const [k, el] of dom.gaps) if (!gk.has(k)) { el.remove(); dom.gaps.delete(k); }
}

// ── drawing: base threads (one path each) and their check marks
function drawThreads(snap) {
  const gDim = document.querySelector('#threads > g.dim'), gMk = document.querySelector('#threads > g.mk');
  const keep = new Set();
  for (const th of M.threads) {
    keep.add(th.key);
    let e = dom.threads.get(th.key);
    if (!e) {
      const path = svgEl('path', { class: 'th-dim', d: th.d, 'stroke-dasharray': '1 0' }, gDim);
      const chk = svgEl('g', { class: 'chk', transform: 'translate(-99 -99) scale(0)', opacity: '0' }, gMk);
      svgEl('circle', { r: '12' }, chk);
      svgEl('path', { d: 'M-5.5 0.5 L-1.5 4.5 L6 -4' }, chk);
      e = { path, chk, cls: null, dashP: 0, dashFrom: 0, dashTo: 0, dashT0: -1, chkV: 0, chkGoal: 0, pos: null };
      dom.threads.set(th.key, e);
    }
    attr(e.path, 'd', th.d);
    const c = threadCls(th);
    if (e.cls !== c) {
      const wasRed = e.cls === 'red', isRed = c === 'red';
      e.cls = c;
      cls(e.path, 'th-dim' + (c ? ' ' + c : ''));
      e.dashFrom = e.dashP; e.dashTo = isRed ? 1 : 0;
      if (snap || wasRed === isRed) { e.dashP = e.dashTo; e.dashT0 = -1; } else e.dashT0 = T.now;
    }
    th.cls = c;
    th.path = e.path;
  }
  for (const [k, e] of dom.threads) if (!keep.has(k)) { e.path.remove(); e.chk.remove(); dom.threads.delete(k); }
}
// Check spots: t 0.5, else the farthest of 0.35..0.65 from other checks (28px) and stamps (8px)
function placeChecks(snap) {
  const placed = [], boxes = V.stamps.map((s) => s.box);
  const boxDist = (p, b) => Math.hypot(Math.max(b.x0 - p.x, 0, p.x - b.x1), Math.max(b.y0 - p.y, 0, p.y - b.y1));
  const green = new Set(M.reqs.filter((r) => r.verdict === 'green').map((r) => r.id));
  if (H.catchH) for (const [id, it] of H.catchH.prevItems) if (it && it.verdict === 'green' && H.catchH.ids.has(id)) green.add(id);
  const byKey = new Map(M.threads.map((t) => [t.key, t]));
  for (const t of M.threads) t.check = null;
  for (const key of M.patrol) {
    const th = byKey.get(key);
    if (!green.has(th.id)) continue;
    const score = (p) => Math.min(placed.reduce((m, o) => Math.min(m, Math.hypot(o.x - p.x, o.y - p.y)), Infinity) - 28, boxes.reduce((m, b) => Math.min(m, boxDist(p, b)), Infinity) - 8);
    let best = bez(th.q, 0.5), bs = score(best);
    if (bs < 0) for (let t = 0.35; t <= 0.651; t += 0.05) { const p = bez(th.q, t), s = score(p); if (s > bs) { bs = s; best = p; } }
    if (bs < 0) continue;
    th.check = best;
    placed.push(best);
  }
  for (const th of M.threads) {
    const e = dom.threads.get(th.key);
    e.pos = th.check;
    e.chkGoal = th.check && th.cls === 'pass' ? 1 : 0;
    if (snap) e.chkV = e.chkGoal;
  }
}

// ── drawing: stamps (one per red requirement) beside the knot of its main thread
function stampEl(id) {
  let s = dom.stamps.get(id);
  if (s) return s;
  const layer = $('stamps');
  const lead = svgEl('line', { class: 'stamp-lead', x1: '0', y1: '0', x2: '0', y2: '0', opacity: '0' }, layer);
  const g = svgEl('g', { class: 'stamp', opacity: '0', transform: 'translate(-999 -999)' }, layer);
  const rect = svgEl('rect', { x: '-88', y: '-29', width: '176', height: '58', rx: '8' }, g);
  const s1 = svgEl('text', { class: 's1', x: '0', y: '-6', 'text-anchor': 'middle' }, g);
  const s2 = svgEl('text', { class: 's2', x: '0', y: '20', 'text-anchor': 'middle' }, g);
  const s2a = document.createTextNode('');
  s2.appendChild(s2a);
  const s2v = svgEl('tspan', { class: 'v' }, s2);
  s = { id, g, lead, rect, s1, s2, s2a, s2v, x: -999, y: -999, rot: 0, t0: -9, a: 0, aGoal: 0, shown: false, live: true };
  dom.stamps.set(id, s);
  return s;
}
const textLen = (el, fallback) => { try { const v = el.getComputedTextLength(); return v > 1 ? v : fallback; } catch { return fallback; } };
function measureStamp(s, parts, runFailed) {
  txt(s.s1, runFailed ? '' : 'CAUGHT!');
  attr(s.s2, 'y', runFailed ? 7 : 20);
  put(s.s2a, 'lead', parts.lead, (v) => { s.s2a.data = v; });
  let value = parts.value;
  txt(s.s2v, value);
  let w = textLen(s.s2, (parts.lead.length + value.length) * 13);
  if (w + 32 > 320 && value) {
    const chars = Array.from(value);
    let keep = chars.length;
    for (let tries = 0; tries < 6 && w + 32 > 320 && keep > 1; tries++) {
      const per = w / Math.max(1, Array.from(parts.lead).length + keep);
      keep = Math.max(1, keep - Math.ceil((w + 32 - 320) / Math.max(4, per)));
      value = '…' + chars.slice(chars.length - keep).join('');
      txt(s.s2v, value);
      w = textLen(s.s2, w);
    }
  }
  return Math.max(176, Math.min(320, w + 32));
}

const TS = [0.5, 0.4, 0.6, 0.3, 0.7];
function placeStamps(snap) {
  const rep = state.report;
  const reds = (rep && Array.isArray(rep.requirements) ? rep.requirements : []).filter((r) => r.verdict === 'red' && M.reqIndex.has(r.id));
  const byKey = new Map(M.threads.map((t) => [t.key, t]));
  const list = reds.map((item) => {
    const r = M.reqIndex.get(item.id), s = stampEl(item.id);
    s.live = true;
    const W = measureStamp(s, reasonParts(item), item.reason === 'run-failed');
    return { r, s, W, th: r.primary ? byKey.get(r.primary) : null };
  });
  const boxOf = (cx, cy, W) => ({ x0: cx - W / 2, x1: cx + W / 2, y0: cy - 29, y1: cy + 29 });
  const hit = (a, b, m) => a.x0 - m < b.x1 && b.x0 - m < a.x1 && a.y0 - m < b.y1 && b.y0 - m < a.y1;
  const inside = (b, p) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
  const cand = (o, t, sg) => {
    const p = bez(o.th.q, t);
    const cx = clamp(p.x + 44, 408 + o.W / 2 + 4, 760 - o.W / 2 - 4), cy = p.y + 64 * sg;
    return { t, sg, p, cx, cy, box: boxOf(cx, cy, o.W) };
  };
  const tryAll = (force, lenient) => {
    const done = [];
    for (const o of list) {
      if (!o.th) continue;
      const others = list.filter((x) => x !== o && x.th).map((x) => { const d = done.find((y) => y.o === x); return d ? d.c.p : bez(x.th.q, 0.5); });
      let pick = null;
      for (const t of TS) {
        const s0 = bez(o.th.q, t).y >= 430 ? 1 : -1;
        for (const sg of force ? [force] : [s0, -s0]) {
          const c = cand(o, t, sg);
          if (c.box.y0 - 8 < 128 || c.box.y1 + 8 > 866) continue;
          if (done.some((d) => hit(d.c.box, c.box, 8))) continue;
          if (others.some((p) => inside(c.box, p))) continue;
          pick = c; break;
        }
        if (pick) break;
      }
      if (!pick && !lenient) return { ok: false, done };
      if (!pick) {
        // No free spot: the first candidate of the first pass, pushed into the zone
        pick = cand(o, 0.5, bez(o.th.q, 0.5).y >= 430 ? 1 : -1);
        const dy = pick.box.y0 < 128 ? 128 - pick.box.y0 : pick.box.y1 > 866 ? 866 - pick.box.y1 : 0;
        pick.cy += dy; pick.box = boxOf(pick.cx, pick.cy, o.W);
      }
      done.push({ o, c: pick });
    }
    return { ok: true, done };
  };
  let res = tryAll(0);
  if (!res.ok) res = tryAll(-1);
  if (!res.ok) res = tryAll(1, true);
  const out = [];
  for (const o of list) {
    const d = res.done.find((x) => x.o === o);
    const s = o.s;
    let anchor, x, y, rot, sg = 1, t = 0.5;
    if (d) { anchor = d.c.p; x = d.c.cx; y = d.c.cy; sg = d.c.sg; t = d.c.t; rot = sg > 0 ? -5 : 5; }
    else { x = 408 + o.W / 2 + 8; y = o.r.cy; rot = 0; anchor = { x: 408, y: o.r.cy }; }
    s.x = x; s.y = y; s.rot = rot;
    attr(s.rect, 'x', r2(-o.W / 2)); attr(s.rect, 'width', r2(o.W));
    if (d) {
      const ex = x - 34, ey = y - 27 * sg, dd = Math.hypot(ex - anchor.x, ey - anchor.y) || 1;
      attr(s.lead, 'x1', r2(anchor.x + ((ex - anchor.x) / dd) * 16)); attr(s.lead, 'y1', r2(anchor.y + ((ey - anchor.y) / dd) * 16));
      attr(s.lead, 'x2', r2(ex)); attr(s.lead, 'y2', r2(ey));
    }
    s.hasLead = !!d;
    o.r.anchor = anchor; o.r.t = t; o.r.sigma = sg;
    if (o.th) o.th.above = sg > 0;
    out.push({ id: o.r.id, box: boxOf(x, y, o.W), anchor, t, sigma: sg, x, y, W: o.W });
  }
  V.stamps = out;
  applyStamps(snap);
}
function applyStamps(snap) {
  for (const [id, s] of dom.stamps) {
    const it = s.live ? itemFor('stamp', id) : null;
    const on = !!it && it.verdict === 'red';
    if (on && !s.shown) { s.t0 = snap ? -9 : T.now; s.aGoal = 1; if (snap) s.a = 1; }
    if (!on) s.aGoal = 0;
    s.shown = on;
  }
}
function sweepStamps() {
  for (const [id, s] of dom.stamps) {
    if (!s.live && s.a <= 0.001) { s.g.remove(); s.lead.remove(); dom.stamps.delete(id); }
    else s.live = false;
  }
}

// ── drawing: activity lines (latest at the bottom)
function drawAct() {
  const box = $('act-lines');
  const lists = actLists();
  const vis = lists.vis, n = vis.length, keep = new Set(vis);
  vis.forEach((ev, k) => {
    let it = dom.act.get(ev);
    const ty = actTop(k, n);
    if (!it) {
      const tone = actionTone(ev.action);
      const el = htmlEl('div', { class: 'aline' + (tone === 'plain' ? '' : ' ' + tone) }, box);
      const lit = htmlEl('i', { class: 'lit', html: litHTML }, el);
      htmlEl('span', { class: 'ts', text: String(ev.ts ?? '') }, el);
      htmlEl('span', { class: 'act', text: actionLabel(ev.action) }, el);
      const target = String(ev.target ?? '');
      htmlEl('span', { class: 'tg' + (/[가-힣]/.test(target) ? ' kr' : ''), text: target }, el);
      const how = enter.get(ev);
      const slide = !RM && (how === 'slide' || (how === 'reveal' && k === n - 1));
      it = { el, lit, litW: lit.firstChild, litR: lit.lastChild, y: ty + (slide ? 36 : 0), vy: 0, a: how ? 0 : 1, ty };
      dom.act.set(ev, it);
      enter.delete(ev);
    }
    it.ty = ty;
  });
  for (const [ev, it] of dom.act) if (!keep.has(ev)) { it.el.remove(); dom.act.delete(ev); }
  V.act = actView(lists);
}
// ── drawing: resolve buttons and the notice line
function drawButtons(s) {
  const row = $('act-actions');
  const show = s.red;
  put(row, 'show', show, (v) => row.classList.toggle('show', v));
  for (const b of row.querySelectorAll('button')) put(b, 'dis', !show || state.pending, (v) => { b.disabled = v; });
  const t = $('toast'), n = state.notice;
  const on = !!n && performance.now() < n.until;
  if (n) { txt(t, n.text); put(t, 'fail', !n.ok, (v) => t.classList.toggle('fail', v)); }
  put(t, 'show', on, (v) => t.classList.toggle('show', v));
}

// ── drawing: counterexample band
let shownBand = null;
function cellEl(parent, c, ng, cls0) {
  const el = htmlEl('div', { class: cls0 + (ng ? ' ng' : ' ok') + (c.w >= 48 && c.w < 72 ? ' mid' : '') }, parent);
  setS(el, 'left', r2(c.x) + 'px'); setS(el, 'top', '66px'); setS(el, 'width', r2(c.w) + 'px');
  if (c.w >= 48) htmlEl('span', { class: 'cv', text: c.text }, el);
  if (c.w >= 72) {
    if (c.len != null) htmlEl('span', { class: 'cl', text: c.len + '자' }, el);
    htmlEl('span', { class: 'cmk', html: ng ? ICON_NG : ICON_OK }, el);
  }
  return el;
}
function buildBandDom(b) {
  const sl = $('slots'), sh = $('shrink');
  if (!dom.notice) { dom.notice = htmlEl('div', { class: 'band-empty' }); htmlEl('span', { text: '검사가 반례를 찾으면 시험한 입력이 이 칸에 쌓인다' }, dom.notice); }
  sl.textContent = ''; sh.textContent = '';
  const B = { cells: [], shrink: [], arrows: [], min: null };
  for (const s of b.slots) { const e = htmlEl('div', { class: 'slot' }, sl); setS(e, 'left', r2(s.x) + 'px'); setS(e, 'top', '66px'); setS(e, 'width', r2(s.w) + 'px'); }
  for (const s of b.shrinks) { const e = htmlEl('div', { class: 'shrink-slot' }, sh); setS(e, 'left', r2(s.x) + 'px'); setS(e, 'top', '66px'); setS(e, 'width', r2(s.w) + 'px'); }
  for (const c of b.cells) B.cells.push(cellEl(sl, c, !c.ok, 'cell'));
  for (const c of b.shrink) B.shrink.push(cellEl(sh, c, true, 'cell'));
  for (const a of b.arrows) {
    const e = htmlEl('div', { class: 'arrow', text: a.text }, sh);
    setS(e, 'left', r2(a.x) + 'px'); setS(e, 'top', '66px');
    B.arrows.push({ el: e, m: a.m, a: 0, goal: 0 });
  }
  if (b.shrink.length) {
    const last = b.shrink[b.shrink.length - 1];
    B.min = htmlEl('div', { class: 'minlabel', text: '최소 반례' }, sh);
    setS(B.min, 'left', r2(last.x + last.w / 2 - 44) + 'px'); setS(B.min, 'top', '38px');
  }
  htmlEl('div', { class: 'sep' }, sh);
  sl.appendChild(dom.notice);
  dom.band = B;
}
function drawBand(snap) {
  let b = M.band, see = null;
  if (H.clear && H.clear.band) b = H.clear.band;
  else if (H.band && H.band.key === b.key) {
    if (!H.band.slots) b = emptyBand();
    else see = H.band;
  }
  shownBand = b;
  const sigNow = JSON.stringify([b.slots, b.cells, b.shrink, b.arrows]);
  if (sigNow !== dom.bandSig || !dom.band) { dom.bandSig = sigNow; buildBandDom(b); }
  const B = dom.band;
  b.cells.forEach((c, k) => setS(B.cells[k], 'opacity', !see || see.cells.has(k) ? '1' : '0'));
  b.shrink.forEach((c, m) => setS(B.shrink[m], 'opacity', !see || see.shrink.has(m) ? '1' : '0'));
  for (const a of B.arrows) { a.goal = !see || see.shrink.has(a.m) ? 1 : 0; if (snap) a.a = a.goal; }
  if (B.min) setS(B.min, 'opacity', !see || see.shrink.has(b.shrink.length - 1) ? '1' : '0');
  const info = !see || see.info;
  txt($('band-info'), info ? b.info : '');
  txt($('foot-inputs'), info ? b.footIn : '');
  txt($('foot-shrink'), info ? b.footShrink : '');
  setS(dom.notice, 'opacity', b.empty || (see && see.cells.size === 0) ? '1' : '0');
  V.band = { key: M.band.key, final: M.band, shown: b, row: M.band.row, held: !!see || b !== M.band };
}

// ── measuring (state changes only): changed glyph boxes, code text ends, guard post
function measure() {
  const st = $('stage').getBoundingClientRect(), s = st.width / 1920 || 1;
  V.scale = s;
  const toStage = (r) => ({ x0: (r.left - st.left) / s, y0: (r.top - st.top) / s, x1: (r.right - st.left) / s, y1: (r.bottom - st.top) / s });
  const range = document.createRange();
  for (const ln of M.lines) {
    const d = dom.lines.get(ln.key);
    ln.mark = null; ln.end = L.code.x;
    if (!d) continue;
    const mk = d.tx.querySelector('mark');
    if (mk) { const r = mk.getClientRects()[0]; if (r) { const b = toStage(r); ln.mark = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; } }
    if (ln.seg && !ln.mark) ln.mark = { x: L.code.x + 50 + ln.seg.p * 9.6, y: ln.cy };
    range.selectNodeContents(d.tx);
    for (const r of range.getClientRects()) ln.end = Math.max(ln.end, toStage(r).x1);
  }
  const post = { x: 1385, y: 300 }, body = { x0: post.x - 93, x1: post.x + 93, y0: post.y - 110, y1: post.y + 110 };
  const hitsCode = M.lines.some((ln) => ln.box.y1 > body.y0 && ln.box.y0 < body.y1 && ln.end > body.x0);
  V.guardPost = hitsCode ? { x: L.act.x + 59, y: post.y } : post;
}
// Panels with a light spot slot (cards and code lines); activity lines come with V.act
function panels() {
  const out = [];
  for (const r of M.reqs) { const c = dom.cards.get(r.id); if (c) out.push({ lit: c.lit, litW: c.litW, litR: c.litR, box: r.box, fall: 70 }); }
  for (const ln of M.lines) { const d = dom.lines.get(ln.key); if (d) out.push({ lit: d.lit, litW: d.litW, litR: d.litR, box: ln.box, fall: 44 }); }
  return out;
}
function fillView(s) {
  const rep = state.report;
  V.report = rep; V.overall = rep ? rep.overall : null; V.generatedAt = rep ? rep.generatedAt : null;
  V.reqs = M.reqs.map((r) => ({ id: r.id, i: r.i, label: r.label, verdict: r.verdict, reason: r.reason, box: r.box, cy: r.cy, threads: r.threads, primary: r.primary, anchor: r.anchor, t: r.t, sigma: r.sigma }));
  V.lines = M.lines.map((ln) => ({ key: ln.key, j: ln.j, cy: ln.cy, box: ln.box, mark: ln.mark, changed: !!ln.seg, end: ln.end }));
  V.changed = V.lines.filter((ln) => ln.changed);
  V.threads = M.threads;
  V.patrol = M.patrol;
  V.structKey = M.structKey;
  V.panels = panels();
  V.patrolHold = !!H.patrol;
  V.boxes = {
    status: { x0: 0, y0: 0, x1: 1920, y1: 72 }, buttons: s.red ? { x0: 1402, y0: 744, x1: 1900, y1: 804 } : null,
    toast: { x0: 1402, y0: 820, x1: 1900, y1: 862 }, band: { x0: 0, y0: 880, x1: 1920, y1: 1080 },
  };
}

// ── render: rebuild the model when data changed, then draw what each hold allows
function bandHold() {
  if (M.band.key === lastBandKey) return;
  if (M.band.key && holdsOn()) {
    let cap = crewDur(M.band) + 1.5;
    if (H.catchH && T.now - lastNewRedAt <= 1) {
      if (H.catchH.hasCode) cap += 4.3;
      if (!H.catchH.joined) { H.catchH.cap += crewDur(M.band) + 1.3; H.catchH.joined = true; }
    } else if (H.catchH) cap += 4.8;
    if (dwellLeft() > 0) cap += dwellLeft() + 0.2;
    H.band = { key: M.band.key, model: M.band, slots: false, cells: new Set(), shrink: new Set(), info: false, cap: T.now + cap };
    for (const h of actHide.values()) if (h.why === 'c') h.cap = Math.max(h.cap, H.band.cap);
  } else H.band = null;
  lastBandKey = M.band.key;
  bandKeyAt = T.now;
}
function render(fromState) {
  const rebuilt = dirty || !M;
  if (rebuilt) {
    buildModel();
    if (patrolPending && state.report) {
      patrolPending = false;
      if (state.report.overall === 'green' || state.report.overall === 'yellow') {
        H.patrol = { threads: new Set(), lines: new Set(), cards: new Set(), cap: T.now + 5 + 1.65 * M.threads.length };
      }
    }
    bandHold();
  }
  const snap = snapNext;
  drawCards();
  drawLines();
  drawThreads(snap);
  if (rebuilt) { sweepStamps(); measure(); placeStamps(snap); } else applyStamps(snap);
  placeChecks(snap);
  drawAct();
  const s = drawStatus();
  drawButtons(s);
  drawBand(snap);
  fillView(s);
  dirty = false;
  snapNext = false;
  if (fromState && FX && fxStarted && !reconnecting) {
    try { FX.onState(V); } catch (e) { console.error('[stage] fx', e); }
  }
}
const changedState = () => { dirty = true; render(true); };

// ── SSE
function onReport(rep) {
  const old = state.report;
  const same = !!old && !!rep && old.generatedAt === rep.generatedAt;
  if (!same) {
    state.prevReport = old;
    computeChanged(old, rep);
    if (old) { H.patrol = null; H.catchH = null; }
    if (holdsOn()) holdForReport(old, rep);
  }
  state.report = rep;
  if (rep && rep.overall === 'green' && state.resolution) state.resolution = { ...state.resolution, approved: [] };
  if (!reportSeen && rep) { reportSeen = true; if (FX) patrolPending = true; snapNext = true; }
}
function onEventsMsg(lines) {
  for (const ev of lines) {
    if (!ev || typeof ev !== 'object') continue;
    state.events.push(ev);
    enter.set(ev, 'slide');
    let why = null, cap = 0;
    if (H.patrol && fxStarted) { why = 'b'; nB += 1; cap = H.patrol.cap + 1.0 * nB; }
    else if (holdsOn()) {
      if (ev.action === 'hook') {
        if (T.now - lastNewRedAt <= 1) { why = 'c'; cap = cCap(); } else { why = 'wait'; cap = T.now + 1; }
      } else if (ev.action === 'block' && state.report && state.report.overall === 'red' && !signRaised) {
        why = 'd'; cap = H.catchH ? H.catchH.cap + 5 : H.band ? H.band.cap + 3 : T.now + 12;
      }
    }
    if (why) actHide.set(ev, { why, cap, at: T.now });
  }
  if (state.events.length > 50) state.events.splice(0, state.events.length - 50);
}
function onReset(lines) {
  state.events = (Array.isArray(lines) ? lines : []).filter((e) => e && typeof e === 'object').slice(-50);
  enter.clear();
  if (firstReset) {
    firstReset = false;
    if (H.patrol) {
      excluded = new Map();
      for (const ev of state.events) { const s = sig(ev); excluded.set(s, (excluded.get(s) || 0) + 1); }
    }
  } else {
    H.catchH = null; H.band = null; H.clear = null; H.patrol = null;
    actHide.clear();
  }
  reconnecting = false;
  snapNext = true;
}
const handlers = {
  index: (d) => { state.index = d; },
  report: (d) => onReport(d),
  resolution: (d) => { state.resolution = d && state.report && state.report.overall === 'green' ? { ...d, approved: [] } : d; },
  sealed: (d) => { state.sealed = d; },
  runs: (d) => { if (!d || typeof d.name !== 'string') return; if (d.data == null) state.runs.delete(d.name); else state.runs.set(d.name, d.data); },
};
function connect() {
  if (typeof EventSource !== 'function') { poll(); return; }
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    note('sse:open');
    if (everOpen) reconnecting = true;
    everOpen = true;
    state.connected = true;
    render(false);
  };
  es.onerror = () => {
    note('sse:error');
    state.connected = false;
    render(false);
  };
  for (const name of Object.keys(handlers)) {
    es.addEventListener(name, (e) => {
      note('sse:' + name);
      let d;
      try { d = JSON.parse(e.data); } catch { return; }
      handlers[name](d);
      changedState();
    });
  }
  es.addEventListener('events', (e) => {
    note('sse:events');
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!Array.isArray(d)) return;
    onEventsMsg(d);
    render(false);
    if (FX && fxStarted && !reconnecting) { try { FX.onEvents(V, d); } catch (err) { console.error('[stage] fx', err); } }
  });
  es.addEventListener('events-reset', (e) => {
    note('sse:events-reset');
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    const first = firstReset;
    onReset(d);
    dirty = true;
    render(false);
    if (!FX) return;
    try {
      if (first || !fxStarted) { FX.start(V, APP); fxStarted = true; } else FX.onReset(V);
    } catch (err) {
      console.error('[stage] fx', err);
      FX = null; fxStarted = false; excluded = null;
      H.patrol = null; H.catchH = null; H.band = null; H.clear = null; actHide.clear();
      render(false);
    }
    quietUntil = T.now + 1;
  });
}
// Fallback without EventSource: read /data/ once a second (driven by the loop)
let polling = false, nextPoll = 0, pollBusy = false;
const lastRaw = new Map();
function poll() { polling = true; state.connected = true; FX = null; patrolPending = false; }
async function pollOnce() {
  pollBusy = true;
  const get = async (name) => { try { const r = await fetch('/data/' + name, { cache: 'no-store' }); return r.ok ? await r.text() : null; } catch { return null; } };
  let changed = false;
  for (const name of ['index', 'report', 'resolution', 'sealed']) {
    const raw = await get(name + '.json');
    if (raw === lastRaw.get(name)) continue;
    lastRaw.set(name, raw);
    let d = null;
    try { d = raw == null ? null : JSON.parse(raw); } catch { continue; }
    handlers[name](d);
    changed = true;
  }
  const rep = state.report;
  for (const it of (rep && Array.isArray(rep.requirements) ? rep.requirements : [])) {
    if (it.verdict !== 'red') continue;
    const name = it.id.replace(':', '__') + '.json', raw = await get('runs/' + name);
    if (raw === lastRaw.get('runs/' + name)) continue;
    lastRaw.set('runs/' + name, raw);
    let d = null;
    try { d = raw == null ? null : JSON.parse(raw); } catch { continue; }
    handlers.runs({ name, data: d });
    changed = true;
  }
  const ev = await get('events.jsonl');
  if (ev !== lastRaw.get('events')) {
    lastRaw.set('events', ev);
    const lines = [];
    for (const s of String(ev ?? '').split(/\r?\n/)) { if (!s.trim()) continue; try { lines.push(JSON.parse(s)); } catch { /* partial line */ } }
    onReset(lines.slice(-50));
    changed = true;
  }
  if (changed) changedState();
  pollBusy = false;
}

// ── channel the fx layer uses to tell when a held part becomes visible
const APP = {
  reveal(part, target) {
    note('reveal:' + part);
    const c = H.catchH, b = H.band;
    switch (part) {
      case 'patrol': if (H.patrol) {
        const th = M.threads.find((t) => t.key === target);
        if (th) { H.patrol.threads.add(th.key); H.patrol.lines.add(th.line); H.patrol.cards.add(th.id); }
      } break;
      case 'all': H.patrol = null; break;
      case 'cut': if (c) { c.cut = true; cutAt = T.now; } break;
      case 'stamp': if (c) c.stamp = true; break;
      case 'card': if (c) c.card = true; break;
      case 'status': if (c) H.catchH = null; break;
      case 'slots': if (b) b.slots = true; if (c) c.crew = true; break;
      case 'cell': if (b) { b.slots = true; b.cells.add(target); } break;
      case 'info': if (b) b.info = true; break;
      case 'shrink': if (b) b.shrink.add(target); break;
      case 'band': H.band = null; break;
      case 'act': if (actHide.has(target)) { actHide.delete(target); enter.set(target, 'reveal'); } if (target && target.action === 'block') signRaised = true; break;
      case 'clear': if (H.clear) { H.clear.status = true; if (!H.clear.band) H.clear = null; } break;
      case 'band-clear': if (H.clear) { H.clear.band = null; if (H.clear.status) H.clear = null; } break;
      default: break;
    }
    render(false);
  },
  phase(text) {
    const t = String(text ?? '');
    if (t === phaseText) return;
    phaseText = t;
    note('reveal:phase');
    txt($('status-phase'), state.connected === false ? '연결 끊김' : phaseText);
  },
};

// ── timers checked every frame: hold caps, hook lines waiting one second, the notice
function timers() {
  const now = T.now;
  let capped = false, waited = false;
  if (H.patrol && now >= H.patrol.cap) { H.patrol = null; capped = true; }
  if (H.catchH && now >= H.catchH.cap) { H.catchH = null; capped = true; }
  if (H.band && now >= H.band.cap) { H.band = null; capped = true; }
  if (H.clear && !H.clear.status && now >= H.clear.capStatus) { H.clear.status = true; capped = true; }
  if (H.clear && H.clear.band && now >= H.clear.capBand) { H.clear.band = null; capped = true; }
  if (H.clear && H.clear.status && !H.clear.band) H.clear = null;
  for (const [ev, h] of actHide) {
    if (now < h.cap) continue;
    actHide.delete(ev);
    enter.set(ev, 'reveal');
    if (h.why === 'wait') waited = true; else capped = true;
  }
  const n = state.notice;
  if (n && !n.gone && performance.now() >= n.until) { n.gone = true; drawButtons(shownStatus()); }
  if (capped) note('reveal:cap');
  if (waited) note('reveal:act');
  if (capped || waited) render(false);
}
// ── base motion (frame writes: transform · opacity · stroke-dasharray only)
function baseMotion(dt) {
  const t = T.now;
  for (const e of dom.threads.values()) {
    if (e.dashT0 >= 0) {
      const u = clamp((t - e.dashT0) / 0.4, 0, 1);
      e.dashP = lerp(e.dashFrom, e.dashTo, easeInOutCos(u));
      if (u >= 1) e.dashT0 = -1;
    }
    setA(e.path, 'stroke-dasharray', r2(lerp(1, 10, e.dashP)) + ' ' + r2(lerp(0, 6, e.dashP)));
    e.chkV = approach(e.chkV, e.chkGoal, e.chkGoal ? 5 : 4, dt);
    const s = RM ? 1 : e.chkGoal ? easeOutBack(e.chkV, 2.4) : e.chkV;
    if (e.pos) setA(e.chk, 'transform', 'translate(' + r2(e.pos.x) + ' ' + r2(e.pos.y) + ') scale(' + r3(s) + ')');
    setA(e.chk, 'opacity', String(r3(e.chkV)));
  }
  for (const s of dom.stamps.values()) {
    s.a = approach(s.a, s.aGoal, s.aGoal ? 9 : 3, dt);
    let sc = 1, r = s.rot;
    if (!RM && s.aGoal) {
      const u = clamp((t - s.t0) / 0.3, 0, 1);
      sc = lerp(1.5, 1, easeOutBack(u, 1.4));
      r = lerp(s.rot - 10, s.rot, easeOutCubic(u));
    } else if (!RM) sc = lerp(0.8, 1, s.a);
    setA(s.g, 'transform', 'translate(' + r2(s.x) + ' ' + r2(s.y) + ') rotate(' + r2(r) + ') scale(' + r3(sc) + ')');
    setA(s.g, 'opacity', String(r3(s.a)));
    setA(s.lead, 'opacity', String(r3(s.hasLead ? s.a : 0)));
  }
  for (const it of dom.act.values()) {
    if (RM) it.y = it.ty; else [it.y, it.vy] = springCD(it.y, it.vy, it.ty, 16, dt);
    it.a = approach(it.a, 1, 5, dt);
    setS(it.el, 'transform', 'translateY(' + r2(it.y) + 'px)');
    setS(it.el, 'opacity', String(r3(it.a)));
  }
  for (const d of dom.lines.values()) {
    if (!d.chip) continue;
    d.chipA = approach(d.chipA, d.chipGoal || 0, 4, dt);
    setS(d.chip, 'opacity', String(r3(d.chipA)));
  }
  if (dom.band) for (const a of dom.band.arrows) { a.a = approach(a.a, a.goal, 5, dt); setS(a.el, 'opacity', String(r3(a.a))); }
}

// ── one rAF loop (dt capped at 0.05 s, scaled by fxspeed)
let lastMs = 0, frameErrs = 0;
function frame(ms) {
  requestAnimationFrame(frame);
  try { step(ms); } catch (e) {
    frameErrs += 1;
    if (frameErrs === 1 || frameErrs % 600 === 0) console.error('[stage] 프레임 오류(' + frameErrs + '회)', e);
  }
}
function step(ms) {
  let dt = lastMs ? (ms - lastMs) / 1000 : 1 / 60;
  lastMs = ms;
  dt = clamp(dt, 0, DT_MAX) * SPEED;
  T.now += dt;
  if (polling && !pollBusy && ms >= nextPoll) { nextPoll = ms + 1000; pollOnce(); }
  if (M) timers();
  baseMotion(dt);
  if (FX && fxStarted) FX.frame(dt, T.now);
}

// ── fit the stage into the window (only on resize)
function fit() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  const x = (window.innerWidth - 1920 * s) / 2, y = (window.innerHeight - 1080 * s) / 2;
  $('stage').style.transform = 'translate(' + r2(x) + 'px, ' + r2(y) + 'px) scale(' + r3(s) + ')';
  V.scale = s;
}

// ── resolve buttons (sent only when a person clicks)
function notice(text, ok) { state.notice = { text, ok, until: performance.now() + 2000, gone: false }; }
async function resolve(choice) {
  if (state.pending) return;
  state.pending = true;
  render(false);
  try {
    const r = await fetch('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) });
    if (r.ok) { state.resolution = await r.json(); notice('기록됨 · ' + choiceLabel(choice), true); }
    else notice(r.status === 409 ? '결정할 위반 없음' : '기록 실패 · ' + r.status, false);
  } catch { notice('기록 실패 · 연결 안 됨', false); }
  finally { state.pending = false; changedState(); }
}

async function boot() {
  fit();
  window.addEventListener('resize', fit);
  $('btn-revert').addEventListener('click', (e) => { e.currentTarget.blur(); resolve('revert-code'); });
  $('btn-spec').addEventListener('click', (e) => { e.currentTarget.blur(); resolve('edit-spec'); });
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => { if (M) changedState(); });
  if (FX_WANTED) {
    try { FX = await import('./fx.js'); } catch (e) { console.error('[stage] fx.js를 불러오지 못해 기본 화면만 그립니다', e); FX = null; }
  }
  render(false);
  connect();
  requestAnimationFrame(frame);
}
boot();
