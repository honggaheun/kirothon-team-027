// Pure text rules for the stage screen (no DOM): counterexamples, reasons, band text, labels.

const CHOICE = { 'revert-code': '코드를 되돌린다', 'edit-spec': '스펙을 고친다' };
const YELLOW = { 'no-tests': '검사 없음', stale: '검사를 봉인한 뒤 스펙 문장이 바뀜' };
const TONES = new Set(['write', 'hook', 'block', 'human']);

/** Counterexample text: JSON array elements joined by ", ", else the outer brackets stripped. */
export function formatExample(raw) {
  const s = String(raw ?? '');
  let arr = null;
  try { const v = JSON.parse(s); if (Array.isArray(v)) arr = v; } catch { /* not JSON */ }
  if (arr) return arr.map((e) => (typeof e === 'string' ? (e === '' ? '""' : e) : JSON.stringify(e))).join(', ');
  const t = s.trim();
  return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : s;
}

/** One runs value (JSON text without the outer brackets) shown like a counterexample. */
export const valueText = (v) => formatExample('[' + String(v ?? '') + ']');

/** Character count when a runs value is a JSON string, else null. */
export function valueLength(v) {
  try { const x = JSON.parse(String(v)); return typeof x === 'string' ? Array.from(x).length : null; } catch { return null; }
}

/** Reason parts of a red requirement: lead words and the value shown in monospace. */
export function reasonParts(item) {
  if (!item) return { lead: '', value: '' };
  if (item.reason === 'run-failed') return { lead: '검사 실행 실패', value: '' };
  if (item.reason === 'seal-broken') {
    const list = Array.isArray(item.brokenSeals) ? item.brokenSeals : [];
    const first = list[0] && list[0].path ? String(list[0].path) : '';
    return { lead: '봉인 깨짐 ', value: first + (list.length > 1 ? ' 외 ' + (list.length - 1) : '') };
  }
  if (item.counterexample != null && item.counterexample !== '') return { lead: '반례 ', value: formatExample(item.counterexample) };
  return { lead: '검사 실패', value: '' };
}

/** Reason phrase of a red requirement. */
export function reasonPhrase(item) {
  const p = reasonParts(item);
  return p.lead + p.value;
}

/** Label of a resolution choice. */
export const choiceLabel = (choice) => CHOICE[choice] ?? String(choice ?? '');

/** Status band tone and text from the report and the resolution. */
export function bandText(report, resolution) {
  if (!report || !Array.isArray(report.requirements)) return { tone: 'none', text: '판정 없음 · guard check를 기다리는 중' };
  const reqs = report.requirements;
  const reds = reqs.filter((r) => r.verdict === 'red');
  const yellows = reqs.filter((r) => r.verdict === 'yellow');
  const overall = report.overall;
  if (overall === 'red' || (overall !== 'green' && overall !== 'yellow' && reds.length)) {
    const approved = resolution && Array.isArray(resolution.approved) ? resolution.approved : [];
    const byId = new Map();
    for (const a of approved) if (a && typeof a.requirement === 'string' && !byId.has(a.requirement)) byId.set(a.requirement, a);
    const tail = reds.length && reds.every((r) => byId.has(r.id))
      ? ' · 사람 결정 기록됨 · ' + choiceLabel(byId.get(reds[0].id).choice)
      : ' · 사람 결정 대기';
    if (reds.some((r) => r.reason === 'run-failed')) {
      return { tone: 'red', text: '검사 실행 실패' + (report.runError ? ' · ' + report.runError : '') + tail };
    }
    const first = reds[0];
    const more = reds.length > 1 ? ' 외 ' + (reds.length - 1) + '건' : '';
    return { tone: 'red', text: (first ? first.id + ' 위반 · ' + reasonPhrase(first) : '위반') + more + tail };
  }
  if (overall === 'yellow') {
    const first = yellows[0];
    const more = yellows.length > 1 ? ' 외 ' + (yellows.length - 1) + '건' : '';
    const why = first ? YELLOW[first.reason] ?? String(first.reason ?? '') : '';
    return { tone: 'yellow', text: '확인 안 됨' + (first ? ' · ' + first.id + ' ' + why : '') + more };
  }
  return { tone: 'green', text: '모든 요구사항이 코드와 일치' };
}

/** Right side summary of the status band. */
export function summaryText(summary) {
  if (!summary) return '';
  const g = summary.green ?? 0, y = summary.yellow ?? 0, r = summary.red ?? 0;
  return '통과 ' + g + (y > 0 ? ' · 노랑 ' + y : '') + ' · 위반 ' + r;
}

/** Activity badge text. */
export const actionLabel = (action) => String(action ?? '').toUpperCase();

/** Activity line tone: write · hook · block · human, or plain for every other action. */
export const actionTone = (action) => (TONES.has(action) ? action : 'plain');

/** Card badge state and text for a report item (null = no verdict yet). */
export function cardBadge(item) {
  if (!item) return { state: '', text: '대기' };
  if (item.verdict === 'green') return { state: 'pass', text: '통과' };
  if (item.verdict === 'yellow') return { state: 'yellow', text: '확인 안 됨' };
  if (item.verdict === 'red') return { state: 'red', text: item.reason === 'run-failed' ? '실행 실패' : '위반' };
  return { state: '', text: '대기' };
}

/** Requirement sentence without a trailing "(근거: <basis>)". */
export function stripBasis(text, basis) {
  const s = String(text ?? '');
  if (!basis) return s;
  const tail = '(근거: ' + basis + ')';
  const t = s.trimEnd();
  return t.endsWith(tail) ? t.slice(0, t.length - tail.length).trimEnd() : s;
}

/** Changed segment between two lines: common prefix length and the differing middle parts. */
export function diffSeg(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { p, from: a.slice(p, a.length - s), to: b.slice(p, b.length - s) };
}

/** Run file name of a full requirement ID. */
export const runName = (id) => String(id).replace(':', '__') + '.json';

/** First red requirement (report order) that has a counterexample record. */
export function runsFor(report, runs) {
  if (!report || !Array.isArray(report.requirements) || !runs) return null;
  for (const item of report.requirements) {
    if (item.verdict !== 'red') continue;
    const name = runName(item.id);
    const run = runs.get(name);
    if (run) return { item, run, name };
  }
  return null;
}

/** Shrink values to show: all when 5 or fewer, else first 2, a gap (null) and last 3. */
export function shrinkView(path) {
  const p = Array.isArray(path) ? path : [];
  if (p.length <= 5) return p.slice();
  return [p[0], p[1], null, p[p.length - 3], p[p.length - 2], p[p.length - 1]];
}

/** Band title info: "<ID> · 검사 <runs>회 · 줄이기 <shrinks>회". */
export function bandInfo(item, run) {
  const inputs = Array.isArray(run && run.inputs) ? run.inputs.length : 0;
  const path = Array.isArray(run && run.shrinkPath) ? run.shrinkPath.length : 0;
  const id = (item && item.id) || (run && run.requirement) || '';
  const runs = item && item.runs != null ? item.runs : inputs;
  const shrinks = item && item.shrinks != null ? item.shrinks : Math.max(0, path - 1);
  return id + ' · 검사 ' + runs + '회 · 줄이기 ' + shrinks + '회';
}
