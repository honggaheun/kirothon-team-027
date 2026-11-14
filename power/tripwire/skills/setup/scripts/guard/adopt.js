// adopt: seal a test file after it fails on every requirement-breaking mutant (human only). // [guard-check:R9.1]
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendEvent, runCheck } from './check.js';
import { UsageError, decodeUtf8 } from './common.js';
import { atomicWriteJson, copyFileInto, guardDir, loadConfig, localIso, relPath } from './config.js';
import { runVitest } from './runner.js';
import { scanSpecs } from './scan.js';
import { assertionsOf, readSealed } from './seal.js';
import { makeResolver } from './tags.js';
const sha = (b) => 'sha256:' + createHash('sha256').update(b).digest('hex');
/** Move files left in mutant-backup back to their paths. // [guard-check:R9.1] */
function restoreLeftovers(root, g) {
    const dir = join(g, 'mutant-backup');
    const restored = [];
    const rec = (abs, rel) => {
        if (!existsSync(abs))
            return;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
            const r = rel === '' ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory())
                rec(join(abs, e.name), r);
            else {
                copyFileInto(join(abs, e.name), join(root, ...r.split('/')));
                rmSync(join(abs, e.name), { force: true });
                restored.push(r);
            }
        }
    };
    rec(dir, '');
    return restored;
}
/** Parse and validate one mutant file; returns an error text or the mutant. // [guard-check:R9.3] */
function readMutant(root, file, id) {
    let o;
    try {
        o = JSON.parse(decodeUtf8(readFileSync(resolve(root, file))));
    }
    catch {
        return `mutant file is not readable JSON: ${file}`;
    }
    const m = o;
    if (!m || typeof m.requirement !== 'string' || typeof m.file !== 'string' || typeof m.find !== 'string' || typeof m.replace !== 'string') {
        return `mutant file needs requirement, file, find, replace: ${file}`;
    }
    if (m.requirement !== id)
        return `mutant requirement ${m.requirement} is not ${id}: ${file}`;
    if (m.find === '')
        return `mutant find is empty: ${file}`;
    let text;
    try {
        text = readFileSync(resolve(root, m.file), 'utf8');
    }
    catch {
        return `mutant target not found: ${m.file} (${file})`;
    }
    if (text.split(m.find).length - 1 !== 1)
        return `mutant find must appear exactly once in ${m.file} (${file})`;
    return { requirement: m.requirement, file: m.file, find: m.find, replace: m.replace };
}
/** Resolve the argument to a full requirement ID in the index, or null. */
function fullId(index, arg) {
    const all = index.specs.flatMap((s) => s.requirements.map((r) => ({ id: `${s.spec}:${r.id}`, short: r.id })));
    const exact = all.find((a) => a.id === arg);
    if (exact)
        return exact.id;
    const shorts = all.filter((a) => a.short === arg);
    return shorts.length === 1 ? shorts[0].id : null;
}
/** Run `guard adopt`. // [guard-check:R9.1][guard-check:R9.2][guard-check:R9.4][guard-check:R9.5][guard-check:R9.6] */
export async function runAdopt(o) {
    if (!o.requirement || !o.test || o.mutants.length === 0)
        throw new UsageError('adopt needs <requirement> --test <file> --mutant <file> [--mutant <file> ...]');
    const root = resolve(o.cwd, o.root ?? '.');
    const g = guardDir(root);
    const lock = join(g, 'adopt.lock');
    mkdirSync(g, { recursive: true });
    try {
        closeSync(openSync(lock, 'wx'));
    }
    catch (e) {
        if (e.code === 'EEXIST')
            return { code: 1, stdout: '', stderr: 'adopt in progress\n' };
        throw e;
    }
    let stderr = '';
    try {
        const left = restoreLeftovers(root, g);
        if (left.length > 0)
            stderr += `restored files left by an interrupted adopt: ${left.join(', ')}\n`;
        const cfg = loadConfig(root);
        const fail = (msg) => ({ code: 1, stdout: '', stderr: stderr + msg + '\n' });
        let index;
        try {
            index = scanSpecs(resolve(root, cfg.specsDir));
        }
        catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
        }
        const id = fullId(index, o.requirement);
        if (id === null)
            return fail(`unknown requirement ${o.requirement}`);
        const testRel = relPath(root, o.test);
        const testAbs = resolve(root, o.test);
        if (!existsSync(testAbs))
            return fail(`test file not found: ${o.test}`);
        const testDir = resolve(root, cfg.testDir);
        const testArg = relPath(testDir, testAbs);
        const resolveTags = makeResolver(index);
        const tagRe = /\[(?:[A-Za-z0-9_-]+:)?R\d+\.\d+\]/g;
        // Baseline: the test file alone must pass and carry only this requirement's tags. // [guard-check:R9.2]
        const base = await runVitest({ testDir, timeoutSeconds: cfg.timeoutSeconds, files: [testArg] });
        if (!base.ok)
            return fail(`baseline run failed: ${base.error}`);
        const tagged = assertionsOf(base.results, testRel).filter((a) => a.title.match(tagRe) !== null);
        const counted = tagged.filter((a) => a.status === 'passed' || a.status === 'failed');
        if (counted.length === 0)
            return fail(`no tagged tests ran in ${testRel}`);
        if (counted.some((a) => a.status !== 'passed'))
            return fail(`tests fail without a mutant in ${testRel}`);
        for (const a of tagged) {
            const tags = a.title.match(tagRe) ?? [];
            const ids = resolveTags(a.title);
            if (ids.length !== tags.length || ids.some((x) => x !== id))
                return fail(`${testRel} has tags other than ${id}: ${a.title}`);
        }
        const mutants = [];
        for (const f of o.mutants) {
            const m = readMutant(root, f, id);
            if (typeof m === 'string')
                return fail(m);
            mutants.push({ m, path: f });
        }
        // Try every mutant: swap, run, always restore. // [guard-check:R9.4]
        const survivors = [];
        for (const { m, path } of mutants) {
            const target = resolve(root, m.file);
            const rel = relPath(root, target);
            const backup = join(g, 'mutant-backup', ...rel.split('/'));
            const original = readFileSync(target);
            copyFileInto(target, backup);
            let caught = false;
            try {
                writeFileSync(target, original.toString('utf8').replace(m.find, () => m.replace), 'utf8');
                const r = await runVitest({ testDir, timeoutSeconds: cfg.timeoutSeconds, files: [testArg] });
                if (r.ok) {
                    caught = assertionsOf(r.results, testRel).some((a) => a.status === 'failed' && resolveTags(a.title).includes(id));
                }
            }
            finally {
                writeFileSync(target, original);
                const back = sha(readFileSync(target));
                if (back !== sha(original))
                    throw new Error(`could not restore ${rel}`);
                rmSync(backup, { force: true });
            }
            if (!caught)
                survivors.push(path);
        }
        if (survivors.length > 0) {
            return { code: 1, stdout: '', stderr: stderr + survivors.map((p) => `mutant survived: ${id} (${p})\n`).join('') }; // [guard-check:R9.6]
        }
        // Seal. // [guard-check:R9.5]
        const sealFile = join(g, 'sealed.json');
        let doc = {};
        if (existsSync(sealFile)) {
            try {
                doc = JSON.parse(decodeUtf8(readFileSync(sealFile)));
            }
            catch {
                return fail('sealed.json is unreadable');
            }
        }
        const entries = existsSync(sealFile) ? readSealed(sealFile) : [];
        const textHash = index.specs.flatMap((s) => s.requirements.map((r) => [`${s.spec}:${r.id}`, r.textHash])).find(([k]) => k === id)?.[1] ?? '';
        const entry = { path: testRel, sha256: sha(readFileSync(testAbs)), requirements: [id], textHashes: { [id]: textHash }, sealedAt: localIso() };
        const at = entries.findIndex((e) => e.path === testRel);
        if (at >= 0)
            entries[at] = entry;
        else
            entries.push(entry);
        atomicWriteJson(sealFile, { ...doc, sealed: entries });
        appendEvent(g, 'human', `검사 봉인 · ${testRel} (${id})`);
        rmSync(lock, { force: true });
        const chk = await runCheck({ root, cwd: o.cwd });
        return { code: 0, stdout: `sealed ${testRel} for ${id} (${mutants.length} mutants caught)\n`, stderr: stderr + chk.stderr };
    }
    finally {
        rmSync(lock, { force: true });
    }
}
