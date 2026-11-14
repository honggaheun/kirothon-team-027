// scan: index acceptance criteria of every spec's requirements.md. // [guard-core:R1.1]
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readTextFile, sha256 } from './common.js';
/** Trim and collapse runs of spaces/tabs into one space. */
export function normalizeSentence(s) {
    return s.trim().replace(/[ \t]+/g, ' ');
}
const BASIS_OPEN = '(근거:';
/** Basis text when the last `(근거:` runs as one bracket group to the end. // [guard-core:R1.4] */
export function extractBasis(sentence) {
    const start = sentence.lastIndexOf(BASIS_OPEN);
    if (start < 0)
        return undefined;
    let depth = 0;
    const last = sentence.length - 1;
    for (let i = start; i <= last; i++) {
        const c = sentence[i];
        if (c === '(')
            depth++;
        else if (c === ')')
            depth--;
        if (depth <= 0 && i < last)
            return undefined;
    }
    if (depth !== 0 || sentence[last] !== ')')
        return undefined;
    const basis = sentence.slice(start + BASIS_OPEN.length, last).trim();
    return basis === '' ? undefined : basis;
}
const REQ_HEADING = /^#{2,5}\s+(?:Requirement|요구사항)\s+(\d+)/i;
const AC_HEADING = /^#{2,5}\s+(?:Acceptance Criteria|수용 기준)/i;
const ANY_HEADING = /^#{1,6}\s/;
const ITEM = /^\s*\d+\.\s+(.*)$/;
/** Parse the criteria of one requirements.md into indexed entries. // [guard-core:R1.1][guard-core:R1.2] */
export function parseRequirements(markdown) {
    const out = [];
    let reqNo = null;
    let inCriteria = false;
    let m = 0;
    for (const raw of markdown.split('\n')) {
        const line = raw.replace(/\r$/, '');
        const req = REQ_HEADING.exec(line);
        if (req) {
            reqNo = req[1];
            inCriteria = false;
            continue;
        }
        if (AC_HEADING.test(line)) {
            inCriteria = reqNo !== null;
            m = 0;
            continue;
        }
        if (ANY_HEADING.test(line)) {
            inCriteria = false;
            continue;
        }
        if (!inCriteria)
            continue;
        const item = ITEM.exec(line);
        if (!item)
            continue;
        m++;
        const text = normalizeSentence(item[1]);
        const entry = { id: `R${reqNo}.${m}`, text, textHash: sha256(text) };
        const basis = extractBasis(text);
        if (basis !== undefined)
            entry.basis = basis;
        out.push(entry);
    }
    return out;
}
/** IDs that appear more than once, in first-repeat order. */
export function duplicateIds(reqs) {
    const seen = new Set();
    const dups = [];
    for (const r of reqs) {
        if (seen.has(r.id) && !dups.includes(r.id))
            dups.push(r.id);
        seen.add(r.id);
    }
    return dups;
}
/** Index every `<dir>/<spec>/requirements.md`; throws on duplicate IDs. // [guard-core:R1.3] */
export function scanSpecs(specsDir) {
    const names = readdirSync(specsDir)
        .filter((n) => statSync(join(specsDir, n)).isDirectory())
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const specs = [];
    for (const name of names) {
        const file = join(specsDir, name, 'requirements.md');
        if (!existsSync(file))
            continue;
        const requirements = parseRequirements(readTextFile(file));
        const dups = duplicateIds(requirements);
        if (dups.length > 0)
            throw new DuplicateIdError(name, dups);
        specs.push({ spec: name, requirements });
    }
    return { specs };
}
export class DuplicateIdError extends Error {
    constructor(spec, ids) {
        super(`duplicate requirement ID in spec ${spec}: ${ids.join(', ')}`);
    }
}
