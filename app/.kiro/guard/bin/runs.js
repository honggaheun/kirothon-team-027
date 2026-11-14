// runs: counterexample records parsed from fast-check's Execution summary. // [guard-check:R3.1]
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './config.js';
import { runFileName } from './runfile.js';
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const LINE = /^((?:\. )*)([√×]) (.*)$/;
/** Remove ANSI color codes. // [guard-check:R3.2] */
export function stripAnsi(s) {
    return s.replace(ANSI, '');
}
function unwrap(v) {
    return v.startsWith('[') && v.endsWith(']') && v.length >= 2 ? v.slice(1, -1) : v;
}
/** Parse the Execution summary of failure messages, or null when there is none. // [guard-check:R3.2][guard-check:R3.3][guard-check:R3.4] */
export function parseSummary(messages) {
    const text = stripAnsi(messages.join('\n')).replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.includes('Execution summary:'));
    if (at < 0)
        return null;
    const items = [];
    for (const l of lines.slice(at + 1)) {
        const m = LINE.exec(l);
        if (!m)
            continue;
        items.push({ depth: m[1].length / 2, ok: m[2] === '√', v: unwrap(m[3]) });
    }
    const inputs = items.filter((i) => i.depth === 0).map((i) => ({ v: i.v, ok: i.ok }));
    const shrinkPath = [];
    for (let d = 0;; d++) {
        const fails = items.filter((i) => i.depth === d && !i.ok);
        if (fails.length === 0)
            break;
        shrinkPath.push(fails[fails.length - 1].v);
    }
    return { inputs, shrinkPath };
}
/** Write the run files of the given requirements and delete every other file. // [guard-check:R3.1][guard-check:R3.5] */
export function syncRuns(dir, records) {
    const keep = new Set();
    for (const [id, r] of records) {
        const name = runFileName(id);
        keep.add(name);
        atomicWriteJson(join(dir, name), {
            requirement: id,
            inputs: r.summary.inputs,
            shrinkPath: r.summary.shrinkPath,
            counterexample: r.counterexample,
        });
    }
    if (!existsSync(dir))
        return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && !keep.has(e.name))
            rmSync(join(dir, e.name), { force: true });
    }
}
