// humanwatch: detect human saves of watched files and run `check --if-changed`. // [guard-serve:R3.1]
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeUtf8, normalize } from './common.js';
import { guardDir, loadConfig, matchesAny, relPath, watchList } from './config.js';
import { appendEvent } from './check.js';
const DEBOUNCE_MS = 300;
const RECENT_SECONDS = 10;
const ADOPT_QUIET_MS = 2000;
function seconds(ts) {
    const m = typeof ts === 'string' ? /^(\d{2}):(\d{2}):(\d{2})$/.exec(ts) : null;
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
/** `agent` when a write of this path or a shell line is within 10 seconds, else `human`. // [guard-serve:R3.1] */
export function classifyChange(relFile, recent, now) {
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const want = normalize(relFile);
    for (const e of recent) {
        const t = seconds(e.ts);
        if (t === null)
            continue;
        const diff = nowSec - t;
        if (diff < 0 || diff > RECENT_SECONDS)
            continue; // lines across midnight are not compared
        if (e.action === 'shell')
            return 'agent';
        if (e.action === 'write' && typeof e.target === 'string' && normalize(e.target) === want)
            return 'agent';
    }
    return 'human';
}
/** True when a root-relative `/` path is something `check` watches. // [guard-serve:R3.1] */
export function isWatchTarget(rel, cfg, root) {
    const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    const lower = p.toLowerCase();
    const specs = relPath(root, cfg.specsDir).toLowerCase().replace(/\/+$/, '');
    if (specs !== '' && lower.startsWith(specs + '/'))
        return true;
    if (p.split('/').some((s) => s === 'node_modules' || s === '.git' || s === '.kiro'))
        return false;
    if (matchesAny(p, [...cfg.testGlobs, ...cfg.sourceGlobs]))
        return true;
    const testRel = relPath(root, cfg.testDir).replace(/\/+$/, '');
    const dir = testRel === '' ? '' : testRel + '/';
    if (lower.startsWith(dir.toLowerCase())) {
        const name = p.slice(dir.length);
        if (!name.includes('/') && (/^vitest\.(config|setup)\./.test(name) || name === 'package.json'))
            return true;
    }
    return false;
}
function hashOf(file) {
    try {
        return createHash('sha256').update(readFileSync(file)).digest('hex');
    }
    catch {
        return null;
    }
}
function isDir(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
/** Last lines of events.jsonl as objects. */
function recentEvents(g) {
    try {
        const lines = decodeUtf8(readFileSync(join(g, 'events.jsonl'))).split('\n').filter((l) => l.trim() !== '').slice(-50);
        const out = [];
        for (const l of lines) {
            try {
                out.push(JSON.parse(l));
            }
            catch {
                // skip broken line
            }
        }
        return out;
    }
    catch {
        return [];
    }
}
/** Start watching; returns a stop function. // [guard-serve:R3.1][guard-serve:R3.2][guard-serve:R3.3] */
export function startHumanWatch(o) {
    const root = resolve(o.root);
    const g = guardDir(root);
    const cfg = loadConfig(root);
    const debounce = o.debounceMs ?? DEBOUNCE_MS;
    const hashes = new Map();
    const key = (rel) => rel.toLowerCase();
    for (const f of watchList(root, cfg)) {
        if (!isWatchTarget(f, cfg, root))
            continue;
        const h = hashOf(join(root, f));
        if (h !== null)
            hashes.set(key(f), h);
    }
    const timers = new Map();
    let lockSeenAt = existsSync(join(g, 'adopt.lock')) ? Date.now() : 0;
    let running = false;
    let again = false;
    const spawnCheck = o.runCheck ??
        (() => new Promise((done) => {
            const c = spawn(process.execPath, [o.cliFile, 'check', '--root', root, '--if-changed'], { windowsHide: true, stdio: 'ignore' });
            c.on('error', () => done());
            c.on('exit', () => done());
        }));
    const runChecks = async () => {
        if (running) {
            again = true; // [guard-serve:R3.2] at most one waits
            return;
        }
        running = true;
        try {
            do {
                again = false;
                await spawnCheck();
            } while (again);
        }
        finally {
            running = false;
        }
    };
    const adoptActive = () => {
        if (existsSync(join(g, 'adopt.lock'))) {
            lockSeenAt = Date.now();
            return true;
        }
        return Date.now() - lockSeenAt < ADOPT_QUIET_MS;
    };
    const settle = (rel) => {
        const abs = join(root, rel);
        if (isDir(abs))
            return;
        const h = hashOf(abs);
        const k = key(rel);
        if (h === null) {
            if (!hashes.delete(k))
                return; // never known: nothing changed
        }
        else {
            if (hashes.get(k) === h)
                return; // read only, same bytes
            hashes.set(k, h);
        }
        if (adoptActive())
            return; // [guard-serve:R3.3]
        if (classifyChange(rel, recentEvents(g), new Date()) === 'agent')
            return;
        try {
            appendEvent(g, 'save', `${rel} · 사람 저장`);
        }
        catch {
            // The line is informational.
        }
        void runChecks();
    };
    const onChange = (name) => {
        if (!name)
            return;
        const rel = name.replace(/\\/g, '/');
        if (!isWatchTarget(rel, cfg, root))
            return;
        const k = key(rel);
        const old = timers.get(k);
        if (old)
            clearTimeout(old);
        timers.set(k, setTimeout(() => {
            timers.delete(k);
            try {
                settle(rel);
            }
            catch {
                // A failed look is ignored; the next change retries.
            }
        }, debounce));
    };
    let watcher = null;
    try {
        watcher = watch(root, { recursive: true }, (_ev, name) => onChange(name === null ? null : String(name)));
        watcher.on('error', () => undefined);
    }
    catch {
        // Watching is best effort.
    }
    const lockPoll = setInterval(() => {
        if (existsSync(join(g, 'adopt.lock')))
            lockSeenAt = Date.now();
    }, 200);
    return () => {
        watcher?.close();
        clearInterval(lockPoll);
        for (const t of timers.values())
            clearTimeout(t);
        timers.clear();
    };
}
