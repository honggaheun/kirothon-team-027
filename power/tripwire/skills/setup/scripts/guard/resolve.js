// resolve: record human resolution approvals (shared by the screen button and `guard resolve`). // [guard-serve:R4.3]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError, decodeUtf8 } from './common.js';
import { atomicWriteJson, guardDir, localIso } from './config.js';
import { appendEvent } from './check.js';
/** Thrown when approvals cannot be recorded; `status` is the HTTP status. */
export class ResolveError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
export function isChoice(v) {
    return v === 'revert-code' || v === 'edit-spec';
}
/** Red always; yellow `stale` only for edit-spec. // [guard-serve:R4.2][guard-serve:R5.1] */
export function canRecord(item, choice) {
    if (item.verdict === 'red')
        return true;
    return item.verdict === 'yellow' && item.reason === 'stale' && choice === 'edit-spec';
}
/** Add approvals: older entries of the same requirement are dropped, new ones go last. // [guard-serve:R4.3] */
export function applyApproval(resolution, targets, choice, approvedAt) {
    const set = new Set(targets);
    const kept = resolution.approved.filter((a) => !(typeof a === 'object' && a !== null && set.has(String(a.requirement))));
    const added = [...set].map((requirement) => ({ requirement, choice, by: 'human', approvedAt }));
    return { ...resolution, approved: [...kept, ...added] };
}
function readJson(file, missing) {
    let text;
    try {
        text = decodeUtf8(readFileSync(file));
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return missing;
        throw new ResolveError(`${file} is unreadable`, 409);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new ResolveError(`${file} is unreadable`, 409);
    }
}
/** Requirement items of the current report. */
export function readReportItems(root) {
    const rep = readJson(join(guardDir(root), 'report.json'), undefined);
    const list = rep?.requirements;
    if (!Array.isArray(list))
        throw new ResolveError('report.json is missing or has no requirements', 409);
    return list.filter((r) => typeof r === 'object' && r !== null);
}
/** Ids of the red requirements. */
export function redIds(items) {
    return items.filter((r) => r.verdict === 'red').map((r) => String(r.id));
}
/** Record approvals for targets (empty = every red one); returns the new resolution. // [guard-serve:R4.3][guard-serve:R5.2] */
export function recordResolution(rootDir, targets, choice, now = new Date()) {
    const root = resolve(rootDir);
    const items = readReportItems(root);
    const ids = targets ?? redIds(items);
    if (ids.length === 0)
        throw new ResolveError('no violated requirements', 409);
    for (const id of ids) {
        const item = items.find((r) => String(r.id) === id);
        if (!item || !canRecord(item, choice))
            throw new ResolveError(`${id} cannot be resolved with ${choice}`, 409);
    }
    const g = guardDir(root);
    const raw = readJson(join(g, 'resolution.json'), { approved: [] });
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new ResolveError('resolution.json is unreadable', 409);
    const doc = raw;
    const current = { ...doc, approved: Array.isArray(doc.approved) ? doc.approved : [] };
    const next = applyApproval(current, ids, choice, localIso(now));
    atomicWriteJson(join(g, 'resolution.json'), next);
    const label = choice === 'revert-code' ? '코드를 되돌린다 승인' : '스펙을 고친다 승인';
    const recorded = [...new Set(ids)];
    for (const id of recorded)
        appendEvent(g, 'human', `${id} · ${label}`);
    return { resolution: next, recorded };
}
/** Resolve a command-line requirement word to full ids, or throw. // [guard-serve:R5.1] */
export function pickTargets(items, word, choice) {
    if (word === 'all') {
        const reds = redIds(items);
        if (reds.length === 0)
            throw new ResolveError('no violated requirements', 409);
        return reds;
    }
    const ok = items.filter((r) => canRecord(r, choice)).map((r) => String(r.id));
    if (ok.includes(word))
        return [word];
    const short = ok.filter((id) => id.endsWith(':' + word));
    if (short.length === 1)
        return short;
    if (short.length > 1)
        throw new ResolveError(`${word} is ambiguous: ${short.join(', ')}`, 409);
    throw new ResolveError(`${word} cannot be resolved with ${choice}`, 409);
}
/** `guard resolve <requirement|all> <revert-code|edit-spec> [--root]`. // [guard-serve:R5.1] */
export function resolveCommand(o) {
    const [word, choice] = o.positionals;
    if (o.positionals.length !== 2 || !isChoice(choice))
        throw new UsageError('resolve needs <requirement|all> <revert-code|edit-spec>');
    const root = resolve(o.cwd, o.root ?? '.');
    try {
        const targets = pickTargets(readReportItems(root), word, choice);
        const r = recordResolution(root, targets, choice);
        return { code: 0, stdout: r.recorded.map((id) => id + '\n').join(''), stderr: '' };
    }
    catch (e) {
        if (e instanceof ResolveError)
            return { code: 1, stdout: '', stderr: `guard resolve: ${e.message}\n` };
        throw e;
    }
}
