// gate: allow or block an agent write/shell event from guard data files. // [guard-core:R3.1]
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { decodeUtf8, normalize } from './common.js';
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'file'];
export const RESERVED_MESSAGE = 'Tripwire: .kiro/guard/ and .kiro/hooks/ are reserved for the user.';
const APPROVAL_MESSAGE = 'Tripwire: approving resolutions and sealing tests are reserved for the user (guard resolve, guard adopt, guard check --results, /api/resolve). Ask the user.';
/** Parse the event JSON bytes into a target path/command. // [guard-core:R3.1] */
export function parseEvent(buf) {
    const empty = { path: '', command: '' };
    let ev;
    try {
        ev = JSON.parse(decodeUtf8(buf));
    }
    catch {
        return empty;
    }
    if (typeof ev !== 'object' || ev === null)
        return empty;
    const e = ev;
    const target = { path: '', command: '' };
    if (typeof e.cwd === 'string')
        target.cwd = e.cwd;
    const input = e.tool_input;
    if (typeof input !== 'object' || input === null)
        return target;
    const ti = input;
    for (const k of PATH_KEYS) {
        const v = ti[k];
        if (typeof v === 'string') {
            target.path = v;
            return target;
        }
    }
    if (typeof ti.command === 'string')
        target.command = ti.command;
    return target;
}
/** True when the path or command touches `.kiro/guard` or `.kiro/hooks`. // [guard-core:R3.3] */
export function isReserved(path, command) {
    const p = normalize(path);
    const c = normalize(command);
    const dirs = ['.kiro/guard/', '.kiro/hooks/'];
    for (const d of dirs) {
        if (p.startsWith(d) || p.includes('/' + d))
            return true;
    }
    return c.includes('.kiro/guard') || c.includes('.kiro/hooks');
}
const STRIP = /^["'`;&|()]+|["'`;&|()]+$/g;
function isGuardToken(t) {
    if (t.endsWith('cli.js'))
        return true;
    for (const n of ['guard', 'guard.cmd', 'guard.exe', 'guard.ps1']) {
        if (t === n || t.endsWith('/' + n))
            return true;
    }
    return false;
}
/** True for guard resolve/adopt, check --results, or /api/resolve. // [guard-core:R3.4] */
export function isApprovalCommand(command) {
    const c = normalize(command);
    if (c.includes('/api/resolve'))
        return true;
    const tokens = c
        .split(/\s+/)
        .map((t) => t.replace(STRIP, ''))
        .filter((t) => t !== '');
    for (let i = 0; i + 1 < tokens.length; i++) {
        if (!isGuardToken(tokens[i]))
            continue;
        const next = tokens[i + 1];
        if (next === 'resolve' || next === 'adopt')
            return true;
        if (next === 'check') {
            for (let j = i + 2; j < tokens.length; j++) {
                if (tokens[j] === '--results' || tokens[j].startsWith('--results='))
                    return true;
            }
        }
    }
    return false;
}
/** Read a JSON file; missing and unreadable are told apart. */
export function loadJson(file) {
    let text;
    try {
        text = decodeUtf8(readFileSync(file));
    }
    catch (e) {
        const code = e.code;
        return { path: file, status: code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
    try {
        return { path: file, status: 'ok', data: JSON.parse(text) };
    }
    catch {
        return { path: file, status: 'unreadable' };
    }
}
function asArray(v) {
    return Array.isArray(v) ? v : [];
}
function approvals(resolution) {
    const all = new Set();
    const editSpec = new Set();
    if (resolution.status === 'ok' && typeof resolution.data === 'object' && resolution.data !== null) {
        for (const a of asArray(resolution.data.approved)) {
            if (typeof a !== 'object' || a === null)
                continue;
            const { requirement, choice } = a;
            if (typeof requirement !== 'string')
                continue;
            all.add(requirement);
            if (choice === 'edit-spec')
                editSpec.add(requirement);
        }
    }
    return { all, editSpec };
}
/** `<id> (<reason>)` text for a red requirement, shared with check. */
export function describeRed(r) {
    const id = String(r.id);
    if (r.reason === 'seal-broken') {
        const items = asArray(r.brokenSeals).map((b) => {
            const o = (b ?? {});
            return `${String(o.path)} ${String(o.problem)}`;
        });
        return `${id} (seal broken: ${items.join(', ')})`;
    }
    if (typeof r.counterexample === 'string')
        return `${id} (counterexample ${r.counterexample})`;
    return `${id} (${String(r.reason)})`;
}
/** Decide from the target and loaded files, first matching rule wins. // [guard-core:R3.3][guard-core:R3.4][guard-core:R3.5][guard-core:R3.6][guard-core:R3.7][guard-core:R3.8] */
export function decide(t, report, resolution, sealed) {
    if (isReserved(t.path, t.command)) {
        return { code: 2, stderr: RESERVED_MESSAGE, kind: 'reserved', detail: [] };
    }
    if (t.command !== '' && isApprovalCommand(t.command)) {
        return { code: 2, stderr: APPROVAL_MESSAGE, kind: 'reserved', detail: [] };
    }
    for (const f of [report, sealed]) {
        if (f.status === 'unreadable') {
            return {
                code: 2,
                stderr: `Tripwire: ${f.path} is unreadable. Ask the user to run guard check.`,
                kind: 'unreadable',
                detail: [basename(f.path)],
            };
        }
    }
    const { all, editSpec } = approvals(resolution);
    const np = normalize(t.path);
    const nc = normalize(t.command);
    const blocked = [];
    const entries = sealed.status === 'ok' && typeof sealed.data === 'object' && sealed.data !== null
        ? asArray(sealed.data.sealed)
        : [];
    for (const e of entries) {
        const s = (e ?? {});
        if (typeof s.path !== 'string' || s.path === '')
            continue;
        const p = normalize(s.path);
        const hit = (np !== '' && (np === p || np.endsWith('/' + p))) || (nc !== '' && nc.includes(p));
        if (!hit)
            continue;
        const ids = asArray(s.requirements).map(String);
        if (ids.every((id) => editSpec.has(id)))
            continue;
        blocked.push({ path: s.path, ids });
    }
    if (blocked.length > 0) {
        const list = blocked.map((b) => `${b.path} (${b.ids.join(', ')})`).join('; ');
        return {
            code: 2,
            stderr: `Tripwire: sealed tests cannot be changed by the agent: ${list}. Do not edit, move or delete them or name them in shell commands; run the whole test suite instead. If a requirement must change, ask the user to approve "edit the spec".`,
            kind: 'sealed',
            detail: blocked.map((b) => b.path),
        };
    }
    if (report.status === 'ok' && typeof report.data === 'object' && report.data !== null) {
        const rep = report.data;
        if (rep.overall === 'red') {
            const reds = asArray(rep.requirements)
                .map((r) => (r ?? {}))
                .filter((r) => r.verdict === 'red' && !all.has(String(r.id)));
            if (reds.length > 0) {
                return {
                    code: 2,
                    stderr: `Tripwire: blocked. Violated: ${reds.map(describeRed).join('; ')}. Stop writing and ask the user to choose: edit the spec or revert the code.`,
                    kind: 'red',
                    detail: reds.map((r) => String(r.id)),
                };
            }
        }
    }
    return { code: 0, stderr: '', kind: 'allow', detail: [] };
}
function hms(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** Path shown in events: slashes, relative to cwd, no leading `./`. */
export function displayPath(path, cwd) {
    let p = path.replace(/\\/g, '/');
    const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    if (base !== '' && p.toLowerCase().startsWith(base.toLowerCase() + '/'))
        p = p.slice(base.length + 1);
    return p.replace(/^\.\//, '');
}
/** Command shown in events: one line, at most 80 chars plus an ellipsis. */
export function displayCommand(command) {
    const one = command.replace(/[\r\n\t]/g, ' ');
    return one.length > 80 ? one.slice(0, 80) + '…' : one;
}
/** The events line for a decision, or null when nothing is written. // [guard-core:R3.10] */
export function eventFor(t, d, cwd, now) {
    const ts = hms(now);
    const shown = t.path !== '' ? displayPath(t.path, cwd) : displayCommand(t.command);
    switch (d.kind) {
        case 'allow':
            if (t.path !== '')
                return { ts, action: 'write', target: displayPath(t.path, cwd) };
            if (t.command !== '')
                return { ts, action: 'shell', target: displayCommand(t.command) };
            return null;
        case 'reserved':
            return { ts, action: 'block', target: `예약 영역 차단 · ${shown}` };
        case 'unreadable':
            return { ts, action: 'block', target: `판정 파일 읽기 실패 · ${d.detail[0]}` };
        case 'sealed':
            return { ts, action: 'block', target: `봉인 검사 차단 · ${d.detail.join(', ')}` };
        default:
            return { ts, action: 'block', target: `${d.detail.join(', ')} 위반 · 사람 결정 대기` };
    }
}
/** Run the gate: read files, decide, append the events line. // [guard-core:R3.2][guard-core:R3.9][guard-core:R3.10] */
export function runGate(o) {
    const target = parseEvent(o.stdin);
    const none = (p) => ({ path: p, status: 'missing' });
    let report;
    let resolution;
    let sealed;
    let eventsFile = o.events;
    const root = resolve(o.root ?? o.cwd);
    if (o.report === undefined) {
        const dir = join(root, '.kiro', 'guard');
        report = loadJson(join(dir, 'report.json'));
        resolution = loadJson(join(dir, 'resolution.json'));
        sealed = loadJson(join(dir, 'sealed.json'));
        if (eventsFile === undefined && isDirectory(dir))
            eventsFile = join(dir, 'events.jsonl');
    }
    else {
        report = loadJson(o.report);
        resolution = o.resolution !== undefined ? loadJson(o.resolution) : none('');
        sealed = o.sealed !== undefined ? loadJson(o.sealed) : none('');
    }
    const decision = decide(target, report, resolution, sealed);
    if (eventsFile !== undefined) {
        try {
            const line = eventFor(target, decision, target.cwd ?? root, new Date());
            if (line)
                appendFileSync(eventsFile, JSON.stringify(line) + '\n', 'utf8');
        }
        catch {
            // Recording failure never changes the decision.
        }
    }
    return { code: decision.code, stderr: decision.stderr === '' ? '' : decision.stderr + '\n' };
}
function isDirectory(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
