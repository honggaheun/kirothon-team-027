const TAG = /\[(?:([A-Za-z0-9_-]+):)?(R\d+\.\d+)\]/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
/** Parse failure messages into counterexample, runs, shrinks. // [guard-core:R2.3] */
export function parseFailure(messages) {
    const text = messages.join('\n').replace(ANSI, '').replace(/\r\n/g, '\n');
    const out = { shrinks: 0 };
    const ce = /Counterexample: (.*)/.exec(text);
    if (ce)
        out.counterexample = ce[1];
    const runs = /failed after (\d+) tests/.exec(text);
    if (runs)
        out.runs = Number(runs[1]);
    const sh = /Shrunk (\d+) time/.exec(text);
    if (sh)
        out.shrinks = Number(sh[1]);
    return out;
}
/** Judge every indexed requirement. // [guard-core:R2.1][guard-core:R2.2][guard-core:R2.8] */
export function judge(input) {
    const { index, genHashes = {}, brokenSeals = {} } = input;
    const fullIds = [];
    const hashes = new Map();
    const specsById = new Map();
    for (const s of index.specs) {
        for (const r of s.requirements) {
            const full = `${s.spec}:${r.id}`;
            fullIds.push(full);
            hashes.set(full, r.textHash);
            const list = specsById.get(r.id) ?? [];
            list.push(s.spec);
            specsById.set(r.id, list);
        }
    }
    const linked = new Map();
    const orphans = [];
    const results = input.results;
    for (const file of results?.testResults ?? []) {
        for (const a of file?.assertionResults ?? []) {
            const ar = a;
            const title = typeof ar.title === 'string' ? ar.title : '';
            const status = typeof ar.status === 'string' ? ar.status : '';
            const messages = Array.isArray(ar.failureMessages) ? ar.failureMessages.map(String) : [];
            const seen = new Set();
            for (const m of title.matchAll(TAG)) {
                const spec = m[1];
                const id = m[2];
                let full = null;
                if (spec !== undefined) {
                    if (fullIds.includes(`${spec}:${id}`))
                        full = `${spec}:${id}`;
                }
                else {
                    const owners = specsById.get(id);
                    if (owners && owners.length === 1)
                        full = `${owners[0]}:${id}`;
                }
                if (full === null) {
                    const raw = m[0].slice(1, -1);
                    if (!orphans.includes(raw))
                        orphans.push(raw);
                    continue;
                }
                if (seen.has(full))
                    continue;
                seen.add(full);
                if (status !== 'passed' && status !== 'failed')
                    continue;
                const list = linked.get(full) ?? [];
                list.push({ title, status, failureMessages: messages });
                linked.set(full, list);
            }
        }
    }
    const requirements = [];
    for (const id of fullIds) {
        const tests = linked.get(id) ?? [];
        const refs = tests.map((t) => ({ title: t.title, status: t.status }));
        const broken = brokenSeals[id];
        const first = tests.find((t) => t.status === 'failed');
        const gen = genHashes[id];
        if (broken !== undefined) {
            requirements.push({ id, verdict: 'red', reason: 'seal-broken', brokenSeals: broken, tests: refs });
        }
        else if (first) {
            const f = parseFailure(first.failureMessages);
            const entry = { id, verdict: 'red', reason: 'test-failed' };
            if (f.counterexample !== undefined)
                entry.counterexample = f.counterexample;
            if (f.runs !== undefined)
                entry.runs = f.runs;
            entry.shrinks = f.shrinks;
            entry.tests = refs;
            requirements.push(entry);
        }
        else if (tests.length === 0) {
            requirements.push({ id, verdict: 'yellow', reason: 'no-tests', tests: refs });
        }
        else if (gen !== undefined && gen !== hashes.get(id)) {
            requirements.push({ id, verdict: 'yellow', reason: 'stale', tests: refs });
        }
        else {
            requirements.push({ id, verdict: 'green', reason: 'all-passed', tests: refs });
        }
    }
    const summary = { green: 0, yellow: 0, red: 0 };
    for (const r of requirements)
        summary[r.verdict]++;
    const overall = summary.red > 0 ? 'red' : summary.yellow > 0 ? 'yellow' : 'green';
    return { overall, requirements, orphans, summary };
}
