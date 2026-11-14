// Seal checks: sealed test files that are missing, changed or not run, plus textHashes. // [guard-check:R4.1]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeUtf8, normalize } from './common.js';
import { makeResolver } from './tags.js';
export class SealedUnreadableError extends Error {
}
/** Read sealed.json: [] when absent; throws SealedUnreadableError when not JSON. // [guard-check:R4.3][guard-check:R4.4] */
export function readSealed(file) {
    if (!existsSync(file))
        return [];
    let data;
    try {
        data = JSON.parse(decodeUtf8(readFileSync(file)));
    }
    catch {
        throw new SealedUnreadableError('unreadable');
    }
    const list = data?.sealed;
    if (!Array.isArray(list))
        return [];
    const out = [];
    for (const e of list) {
        if (typeof e !== 'object' || e === null)
            continue;
        const o = e;
        if (typeof o.path !== 'string')
            continue;
        const th = typeof o.textHashes === 'object' && o.textHashes !== null ? o.textHashes : undefined;
        out.push({
            path: o.path,
            sha256: typeof o.sha256 === 'string' ? o.sha256 : '',
            requirements: Array.isArray(o.requirements) ? o.requirements.map(String) : [],
            ...(th ? { textHashes: th } : {}),
            ...(typeof o.sealedAt === 'string' ? { sealedAt: o.sealedAt } : {}),
        });
    }
    return out;
}
/** Sealed requirement IDs absent from the index, in sealed.json order, unique. // [guard-check:R2.2] */
export function missingSealed(entries, index) {
    const have = new Set(index.specs.flatMap((s) => s.requirements.map((r) => `${s.spec}:${r.id}`)));
    const out = [];
    for (const e of entries)
        for (const id of e.requirements)
            if (!have.has(id) && !out.includes(id))
                out.push(id);
    return out;
}
/** Assertions of the result files whose name equals or ends with `/<path>`. */
export function assertionsOf(results, path) {
    const p = normalize(path);
    const out = [];
    const files = results?.testResults;
    for (const f of Array.isArray(files) ? files : []) {
        const fo = (f ?? {});
        if (typeof fo.name !== 'string')
            continue;
        const n = normalize(fo.name);
        if (n !== p && !n.endsWith('/' + p))
            continue;
        for (const a of Array.isArray(fo.assertionResults) ? fo.assertionResults : []) {
            const ao = (a ?? {});
            out.push({ title: typeof ao.title === 'string' ? ao.title : '', status: typeof ao.status === 'string' ? ao.status : '' });
        }
    }
    return out;
}
/** broken-seals and gen-hashes for judge. // [guard-check:R4.1][guard-check:R4.2] */
export function sealInputs(root, entries, results, index) {
    const resolve = makeResolver(index);
    const current = new Map();
    for (const s of index.specs)
        for (const r of s.requirements)
            current.set(`${s.spec}:${r.id}`, r.textHash);
    const brokenSeals = {};
    const genHashes = {};
    for (const e of entries) {
        let actual = null;
        try {
            actual = 'sha256:' + createHash('sha256').update(readFileSync(join(root, e.path))).digest('hex');
        }
        catch {
            actual = null;
        }
        const asserts = assertionsOf(results, e.path);
        for (const id of e.requirements) {
            let problem = null;
            if (actual === null)
                problem = 'missing';
            else if (actual !== e.sha256)
                problem = 'changed';
            else if (!asserts.some((a) => (a.status === 'passed' || a.status === 'failed') && resolve(a.title).includes(id)))
                problem = 'not-run';
            if (problem !== null)
                (brokenSeals[id] ??= []).push({ path: e.path, problem });
        }
        for (const [id, h] of Object.entries(e.textHashes ?? {})) {
            const have = genHashes[id];
            if (have === undefined || (have === current.get(id) && h !== current.get(id)))
                genHashes[id] = h;
        }
    }
    return { brokenSeals, genHashes };
}
