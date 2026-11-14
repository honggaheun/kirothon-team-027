// check: run tagged tests, judge, write report/runs/events, close resolutions. // [guard-check:R2.1]
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { extractCode } from './code.js';
import { decodeUtf8 } from './common.js';
import { atomicWriteJson, computeInputsHash, guardDir, hms, loadConfig, localIso, } from './config.js';
import { describeRed } from './gate.js';
import { judge } from './judge.js';
import { parseSummary, syncRuns } from './runs.js';
import { readResultsFile, runVitest } from './runner.js';
import { scanSpecs } from './scan.js';
import { SealedUnreadableError, missingSealed, readSealed, sealInputs } from './seal.js';
import { makeResolver } from './tags.js';
const END_NOTE = 'If a requirement must change, ask the user; do not weaken requirements or tests.';
function readJsonFile(file) {
    try {
        return JSON.parse(decodeUtf8(readFileSync(file)));
    }
    catch {
        return undefined;
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** Take `check.lock`, waiting up to 60s and removing locks older than 120s. // [guard-check:R9.7] */
async function acquireLock(file) {
    mkdirSync(dirname(file), { recursive: true });
    const start = Date.now();
    for (;;) {
        try {
            closeSync(openSync(file, 'wx'));
            return;
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
        }
        try {
            if (Date.now() - statSync(file).mtimeMs > 120_000) {
                rmSync(file, { force: true });
                continue;
            }
        }
        catch {
            continue;
        }
        if (Date.now() - start > 60_000)
            throw new Error('check.lock is held by another process');
        await sleep(200);
    }
}
/** Append one activity line. */
export function appendEvent(g, action, target) {
    mkdirSync(g, { recursive: true });
    appendFileSync(join(g, 'events.jsonl'), JSON.stringify({ ts: hms(), action, target }) + '\n', 'utf8');
}
function fullIds(index) {
    return index.specs.flatMap((s) => s.requirements.map((r) => `${s.spec}:${r.id}`));
}
function approvedOf(resolution) {
    const list = resolution?.approved;
    if (!Array.isArray(list))
        return [];
    return list
        .map((a) => (a ?? {}))
        .filter((a) => typeof a.requirement === 'string')
        .map((a) => ({ requirement: String(a.requirement), choice: String(a.choice) }));
}
/** The one-line session summary. // [guard-check:R8.1] */
export function summaryLine(report, sealedCount, approved) {
    const { green, yellow, red } = report.summary;
    let state;
    if (red > 0) {
        const reds = report.requirements.filter((r) => r.verdict === 'red').map((r) => describeRed(r));
        state = `Violated: ${reds.join('; ')}.`;
    }
    else if (yellow > 0) {
        const ys = report.requirements.filter((r) => r.verdict === 'yellow').map((r) => `${r.id} (${r.reason})`);
        state = `Not verified: ${ys.join('; ')}.`;
    }
    else {
        state = 'All requirements pass.';
    }
    const seal = sealedCount > 0 ? `Sealed test files: ${sealedCount}; never edit them.` : 'Sealed test files: 0.';
    const appr = approved.length > 0 ? `Approved resolutions: ${approved.map((a) => `${a.requirement} (${a.choice})`).join('; ')}.` : 'Approved resolutions: none.';
    return `Tripwire: ${green + yellow + red} requirements (${green} green, ${yellow} yellow, ${red} red). ${state} ${seal} ${appr} ${END_NOTE}\n`;
}
/** stderr text for an overall transition, or ''. // [guard-check:R5.2][guard-check:R5.3] */
export function transitionNote(prevOverall, report) {
    if (report.overall === 'red' && prevOverall !== 'red') {
        const reds = report.requirements.filter((r) => r.verdict === 'red').map((r) => describeRed(r));
        return `Tripwire: violated ${reds.join('; ')}. Further writes will be blocked until the user chooses: edit the spec or revert the code.\n`;
    }
    if (prevOverall === 'red' && report.overall !== 'red')
        return 'Tripwire: no violated requirements now.\n';
    return '';
}
/** First failed test linked to a requirement: its failure messages. */
function firstFailureMessages(results, index, id) {
    const resolveTags = makeResolver(index);
    const files = results?.testResults;
    for (const f of Array.isArray(files) ? files : []) {
        const list = f?.assertionResults;
        for (const a of Array.isArray(list) ? list : []) {
            const ar = (a ?? {});
            if (ar.status !== 'failed' || typeof ar.title !== 'string')
                continue;
            if (!resolveTags(ar.title).includes(id))
                continue;
            return Array.isArray(ar.failureMessages) ? ar.failureMessages.map(String) : [];
        }
    }
    return null;
}
/** Run `guard check`. // [guard-check:R1.1][guard-check:R2.1] */
export async function runCheck(o) {
    const root = resolve(o.cwd, o.root ?? '.');
    const g = guardDir(root);
    if (existsSync(join(g, 'adopt.lock')))
        return { code: 0, stdout: '', stderr: 'adopt in progress\n' }; // [guard-check:R9.7]
    const cfg = loadConfig(root);
    let sealed;
    try {
        sealed = readSealed(join(g, 'sealed.json'));
    }
    catch (e) {
        if (e instanceof SealedUnreadableError)
            return { code: 1, stdout: '', stderr: 'sealed.json is unreadable\n' }; // [guard-check:R4.4]
        throw e;
    }
    const inputsHash = computeInputsHash(root, cfg);
    const prevReport = readJsonFile(join(g, 'report.json'));
    if (o.ifChanged && prevReport && prevReport.inputsHash === inputsHash) {
        // [guard-check:R7.2]
        const stdout = o.summary ? summaryLine(prevReport, sealed.length, approvedOf(readJsonFile(join(g, 'resolution.json')))) : '';
        return { code: 0, stdout, stderr: '' };
    }
    await acquireLock(join(g, 'check.lock'));
    try {
        return await checkBody(o, root, cfg, sealed, inputsHash, prevReport?.overall);
    }
    finally {
        rmSync(join(g, 'check.lock'), { force: true });
    }
}
async function checkBody(o, root, cfg, sealed, inputsHash, prevOverall) {
    const g = guardDir(root);
    const indexFile = join(g, 'index.json');
    const failure = (reqIds, index, runError) => {
        let code = { file: null, lines: [] };
        try {
            if (index)
                code = extractCode(root, cfg.sourceGlobs, index);
        }
        catch {
            // The code block is best effort in a failure report.
        }
        const requirements = reqIds.map((id) => ({ id, verdict: 'red', reason: 'run-failed', tests: [] }));
        const report = {
            generatedAt: localIso(),
            overall: 'red',
            requirements,
            orphans: [],
            summary: { green: 0, yellow: 0, red: requirements.length },
            code,
            inputsHash,
            runError,
        };
        atomicWriteJson(join(g, 'report.json'), report);
        syncRuns(join(g, 'runs'), new Map());
        appendEvent(g, 'hook', 'guard check · 실행 실패');
        return { code: 1, stdout: '', stderr: `${runError}\n${transitionNote(prevOverall, report)}` };
    };
    /** Report for a check that could not decide, built from the index on disk. // [guard-check:R2.2] */
    const undecidable = (reason) => {
        const prior = readJsonFile(indexFile);
        const ids = prior && Array.isArray(prior.specs) ? fullIds(prior) : [];
        if (ids.length === 0)
            return { code: 1, stdout: '', stderr: `${reason}\n` };
        return failure(ids, prior ?? null, reason);
    };
    let index;
    try {
        index = scanSpecs(resolve(root, cfg.specsDir));
    }
    catch (e) {
        return undecidable(e instanceof Error ? e.message : String(e));
    }
    const missing = missingSealed(sealed, index);
    if (missing.length > 0) {
        const more = missing.length > 1 ? ` (and ${missing.length - 1} more)` : '';
        return undecidable(`sealed requirement ${missing[0]} is missing from the spec${more}`);
    }
    try {
        atomicWriteJson(indexFile, index);
        const outcome = o.results !== undefined ? readResultsFile(resolve(o.cwd, o.results)) : await runVitest({ testDir: resolve(root, cfg.testDir), timeoutSeconds: cfg.timeoutSeconds });
        if (!outcome.ok)
            return failure(fullIds(index), index, outcome.error);
        const { brokenSeals, genHashes } = sealInputs(root, sealed, outcome.results, index);
        const j = judge({ index, results: outcome.results, genHashes, brokenSeals });
        const code = extractCode(root, cfg.sourceGlobs, index);
        const report = {
            generatedAt: localIso(),
            overall: j.overall,
            requirements: j.requirements,
            orphans: j.orphans,
            summary: j.summary,
            code,
            inputsHash,
        };
        atomicWriteJson(join(g, 'report.json'), report);
        // Counterexample records for red requirements that have an Execution summary. // [guard-check:R3.1][guard-check:R3.5]
        const records = new Map();
        for (const r of j.requirements) {
            if (r.verdict !== 'red' || r.reason !== 'test-failed')
                continue;
            const messages = firstFailureMessages(outcome.results, index, r.id);
            const summary = messages ? parseSummary(messages) : null;
            if (!summary)
                continue;
            const last = summary.shrinkPath[summary.shrinkPath.length - 1] ?? '';
            records.set(r.id, { summary, counterexample: r.counterexample ?? `[${last}]` });
        }
        syncRuns(join(g, 'runs'), records);
        appendEvent(g, 'hook', `guard check · 빨강 ${j.summary.red} · 노랑 ${j.summary.yellow} · 초록 ${j.summary.green}`); // [guard-check:R5.1]
        const approved = closeResolutions(g, j);
        const stderr = transitionNote(prevOverall, j);
        const stdout = o.summary ? summaryLine(j, sealed.length, approved) : '';
        return { code: 0, stdout, stderr };
    }
    catch (e) {
        return undecidable(`guard check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
/** Move approved entries that are green or gone to `closed`; returns the approvals left. // [guard-check:R6.1][guard-check:R6.2][guard-check:R6.3] */
function closeResolutions(g, report) {
    const file = join(g, 'resolution.json');
    const data = readJsonFile(file);
    if (typeof data !== 'object' || data === null)
        return [];
    const doc = data;
    if (!Array.isArray(doc.approved))
        return [];
    const verdict = new Map(report.requirements.map((r) => [r.id, r.verdict]));
    const keep = [];
    const closed = Array.isArray(doc.closed) ? [...doc.closed] : [];
    const closedIds = [];
    for (const a of doc.approved) {
        const id = a?.requirement;
        const v = typeof id === 'string' ? verdict.get(id) : undefined;
        if (typeof id === 'string' && (v === 'green' || v === undefined)) {
            closed.push({ ...a, closedAt: localIso() });
            closedIds.push(id);
        }
        else {
            keep.push(a);
        }
    }
    if (closedIds.length > 0) {
        atomicWriteJson(file, { ...doc, approved: keep, closed });
        for (const id of closedIds)
            appendEvent(g, 'hook', `해결 닫힘 · ${id}`);
    }
    return approvedOf({ approved: keep });
}
