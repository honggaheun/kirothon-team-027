// Check settings, glob rules, watch list, atomic writes, time helpers. // [guard-check:R2.1]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { readTextFile } from './common.js';
export const DEFAULT_CONFIG = {
    specsDir: '.kiro/specs',
    testGlobs: ['tests/**/*.test.ts', 'test/**/*.test.ts'],
    sourceGlobs: ['src/**/*.ts'],
    testDir: '.',
    timeoutSeconds: 50,
};
const SKIP_DIRS = new Set(['node_modules', '.git', '.kiro']);
function strings(v) {
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;
}
/** Read `.kiro/guard/config.json`; missing file or keys fall back to the defaults. */
export function loadConfig(root) {
    const cfg = { ...DEFAULT_CONFIG };
    let raw;
    try {
        raw = JSON.parse(readTextFile(join(root, '.kiro', 'guard', 'config.json')));
    }
    catch {
        return cfg;
    }
    if (typeof raw !== 'object' || raw === null)
        return cfg;
    const o = raw;
    if (typeof o.specsDir === 'string')
        cfg.specsDir = o.specsDir;
    if (typeof o.testDir === 'string')
        cfg.testDir = o.testDir;
    if (typeof o.timeoutSeconds === 'number' && o.timeoutSeconds > 0)
        cfg.timeoutSeconds = o.timeoutSeconds;
    const tg = strings(o.testGlobs);
    if (tg)
        cfg.testGlobs = tg;
    const sg = strings(o.sourceGlobs);
    if (sg)
        cfg.sourceGlobs = sg;
    return cfg;
}
/** Guard data folder of a workspace. */
export function guardDir(root) {
    return join(root, '.kiro', 'guard');
}
/** Compile a glob (`**\/`, trailing `**`, `*`, `?`) to a case-insensitive regex. // [guard-check:R2.4] */
export function globToRegExp(glob) {
    const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
    let re = '';
    let i = 0;
    while (i < g.length) {
        const c = g[i];
        if (c === '*' && g[i + 1] === '*') {
            if (g[i + 2] === '/') {
                re += '(?:.*/)?';
                i += 3;
            }
            else {
                re += '.*';
                i += 2;
            }
        }
        else if (c === '*') {
            re += '[^/]*';
            i++;
        }
        else if (c === '?') {
            re += '[^/]';
            i++;
        }
        else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
            i++;
        }
    }
    return new RegExp('^' + re + '$', 'i');
}
/** True when a root-relative `/` path matches any glob. */
export function matchesAny(rel, globs) {
    return globs.some((g) => globToRegExp(g).test(rel));
}
/** Every file under a folder as root-relative `/` paths; `skip` names are not entered. */
export function walkFiles(root, start, skip = SKIP_DIRS) {
    const out = [];
    const rec = (abs, rel) => {
        let entries;
        try {
            entries = readdirSync(abs, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const r = rel === '' ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory()) {
                if (!skip.has(e.name))
                    rec(join(abs, e.name), r);
            }
            else if (e.isFile()) {
                out.push(r);
            }
        }
    };
    rec(resolve(root, start), start === '.' ? '' : start.replace(/\\/g, '/').replace(/\/+$/, ''));
    return out;
}
/** Files under the root that match globs, outside node_modules/.git/.kiro. // [guard-check:R2.4] */
export function globFiles(root, globs) {
    const res = globs.map(globToRegExp);
    return walkFiles(root, '.')
        .filter((f) => res.some((r) => r.test(f)))
        .sort(cmpCodePoint);
}
/** Compare strings by code point (UTF-8 byte order equals code point order). */
export function cmpCodePoint(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
/** Root-relative `/` path of an absolute or relative path. */
export function relPath(root, p) {
    const abs = resolve(root, p);
    const base = resolve(root);
    let rel = abs.slice(base.length).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!abs.toLowerCase().startsWith(base.toLowerCase()))
        rel = abs.replace(/\\/g, '/');
    return rel;
}
/** Watched files (root-relative, sorted, unique). // [guard-check:R7.1] */
export function watchList(root, cfg) {
    const set = new Set();
    const specsRel = relPath(root, cfg.specsDir) || '.';
    for (const f of walkFiles(root, specsRel, new Set()))
        set.add(f);
    for (const f of globFiles(root, [...cfg.testGlobs, ...cfg.sourceGlobs]))
        set.add(f);
    const testRel = relPath(root, cfg.testDir);
    const testAbs = resolve(root, cfg.testDir);
    try {
        for (const e of readdirSync(testAbs, { withFileTypes: true })) {
            if (!e.isFile())
                continue;
            if (/^vitest\.(config|setup)\./.test(e.name) || e.name === 'package.json') {
                set.add(testRel === '' ? e.name : `${testRel}/${e.name}`);
            }
        }
    }
    catch {
        // No test folder: nothing to watch there.
    }
    for (const f of ['.kiro/guard/sealed.json', '.kiro/guard/config.json']) {
        if (existsSync(join(root, f)))
            set.add(f);
    }
    return [...set].filter((f) => isFile(join(root, f))).sort(cmpCodePoint);
}
function isFile(p) {
    try {
        return statSync(p).isFile();
    }
    catch {
        return false;
    }
}
/** `sha256:<hex>` of file bytes. */
export function fileHash(file) {
    return 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
}
/** inputsHash over the watched files. // [guard-check:R7.1] */
export function computeInputsHash(root, cfg) {
    let text = '';
    for (const rel of watchList(root, cfg)) {
        const h = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
        text += `${rel}\t${h}\n`;
    }
    return 'sha256:' + createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}
/** Block the thread for `ms` milliseconds. */
export function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** Rename with up to 5 retries on EPERM/EBUSY, 100ms apart. */
function renameRetry(from, to) {
    for (let attempt = 0;; attempt++) {
        try {
            renameSync(from, to);
            return;
        }
        catch (e) {
            const code = e.code;
            if ((code === 'EPERM' || code === 'EBUSY') && attempt < 5)
                sleepSync(100);
            else
                throw e;
        }
    }
}
/** Write text through a temp file and rename it into place. // [guard-check:R2.3] */
export function atomicWrite(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameRetry(tmp, file);
}
/** Atomically write JSON (UTF-8, no BOM, two-space indent). */
export function atomicWriteJson(file, value) {
    atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}
/** Copy one file (never a folder tree), creating the target folder. */
export function copyFileInto(src, dst) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
}
const p2 = (n) => String(n).padStart(2, '0');
/** Local time `YYYY-MM-DDTHH:MM:SS+09:00`. // [guard-check:R2.3] */
export function localIso(d = new Date()) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return (`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` +
        `${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`);
}
/** Local time `HH:MM:SS`. */
export function hms(d = new Date()) {
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
