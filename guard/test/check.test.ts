// Tests for the check pipeline: report, seals, events, resolutions, if-changed, summary, locks (tasks 3, 6-9).
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/check.js';

const SPEC = `# Requirements Document

### Requirement 1

#### Acceptance Criteria

1. WHEN a THEN the system SHALL x
2. WHEN b THEN the system SHALL y

### Requirement 2

#### Acceptance Criteria

1. WHEN c THEN the system SHALL z
`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-check-'));
  put('.kiro/specs/demo/requirements.md', SPEC);
  put('src/a.ts', 'export const A = 1; // [R1.1]\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, text: string): void {
  const f = join(root, ...rel.split('/'));
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, text, 'utf8');
}
function read(rel: string): string {
  return readFileSync(join(root, ...rel.split('/')), 'utf8');
}
function json(rel: string): any {
  return JSON.parse(read(rel));
}
function names(rel: string): string[] {
  return existsSync(join(root, rel)) ? readdirSync(join(root, rel)).sort() : [];
}
function events(): { ts: string; action: string; target: string }[] {
  const f = '.kiro/guard/events.jsonl';
  return existsSync(join(root, f)) ? read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

type T = { title: string; status: string; failureMessages?: string[] };
/** vitest-like results: one file per entry. */
function results(files: Record<string, T[]>): string {
  const testResults = Object.entries(files).map(([name, tests]) => ({
    name: `C:/ws/${name}`,
    assertionResults: tests.map((t) => ({ failureMessages: [], ...t })),
  }));
  put('results.json', JSON.stringify({ testResults }));
  return 'results.json';
}
const allPass = (): string =>
  results({
    'tests/a.test.ts': [
      { title: '[R1.1] a', status: 'passed' },
      { title: '[R1.2] b', status: 'passed' },
      { title: '[R2.1] c', status: 'passed' },
    ],
  });
const check = (extra: Partial<Parameters<typeof runCheck>[0]> = {}) => runCheck({ root, cwd: root, results: 'results.json', ...extra });
const sha = (s: string): string => 'sha256:' + createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

const SUMMARY = ['Error: Property failed after 2 tests', 'Counterexample: ["bb"]', 'Shrunk 1 time(s)', '', 'Execution summary:', '√ ["a"]', '× ["ccc"]', '. × ["bb"]'].join('\n');

describe('report', () => {
  it('[guard-check:R2.1][guard-check:R2.3] writes index and report with the documented key order', async () => {
    allPass();
    const r = await check();
    expect(r.code).toBe(0);
    expect(json('.kiro/guard/index.json').specs[0].spec).toBe('demo');
    const rep = json('.kiro/guard/report.json');
    expect(Object.keys(rep)).toEqual(['generatedAt', 'overall', 'requirements', 'orphans', 'summary', 'code', 'inputsHash']);
    expect(rep.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(rep.overall).toBe('green');
  });

  it('[guard-check:R2.1] all tagged and passing gives green; a missing test gives yellow no-tests', async () => {
    allPass();
    expect((await check()).code).toBe(0);
    expect(json('.kiro/guard/report.json').overall).toBe('green');
    results({ 'tests/a.test.ts': [{ title: '[R1.1] a', status: 'passed' }] });
    await check();
    const rep = json('.kiro/guard/report.json');
    expect(rep.overall).toBe('yellow');
    expect(rep.requirements.map((q: any) => q.reason)).toEqual(['all-passed', 'no-tests', 'no-tests']);
  });

  it('[guard-check:R1.3] unreadable results make every requirement red run-failed with runError, exit 1', async () => {
    put('results.json', 'not json');
    const r = await check();
    expect(r.code).toBe(1);
    const rep = json('.kiro/guard/report.json');
    expect(rep.overall).toBe('red');
    expect(rep.requirements.map((q: any) => [q.id, q.verdict, q.reason, q.tests])).toEqual([
      ['demo:R1.1', 'red', 'run-failed', []],
      ['demo:R1.2', 'red', 'run-failed', []],
      ['demo:R2.1', 'red', 'run-failed', []],
    ]);
    expect(typeof rep.runError).toBe('string');
    expect(Object.keys(rep).at(-1)).toBe('runError');
    expect(events().map((e) => [e.action, e.target])).toEqual([['hook', 'guard check · 실행 실패']]);
    expect(r.stderr).toContain(rep.runError);
  });

  it('[guard-check:R1.3] without --results and without vitest installed the run fails the same way', async () => {
    const r = await runCheck({ root, cwd: root });
    expect(r.code).toBe(1);
    expect(json('.kiro/guard/report.json').runError).toContain('vitest not found');
  });
});

describe('undecidable', () => {
  it('[guard-check:R2.2] a duplicate ID turns the previous index into run-failed and keeps index.json', async () => {
    allPass();
    await check();
    const before = read('.kiro/guard/index.json');
    put('.kiro/specs/demo/requirements.md', SPEC.replace('### Requirement 2', '### Requirement 1'));
    const r = await check();
    expect(r.code).toBe(1);
    const rep = json('.kiro/guard/report.json');
    expect(rep.requirements.map((q: any) => q.reason)).toEqual(['run-failed', 'run-failed', 'run-failed']);
    expect(read('.kiro/guard/index.json')).toBe(before);
    expect(r.stderr).toContain('demo:R1.1 (run-failed)');
  });

  it('[guard-check:R2.2] with no previous index nothing is written and the exit code is 1', async () => {
    put('.kiro/specs/demo/requirements.md', SPEC.replace('### Requirement 2', '### Requirement 1'));
    allPass();
    const r = await check();
    expect(r.code).toBe(1);
    expect(existsSync(join(root, '.kiro/guard/report.json'))).toBe(false);
    expect(events()).toEqual([]);
  });

  it('[guard-check:R2.2] a sealed requirement that left the spec is reported with the first ID and a count', async () => {
    allPass();
    put('tests/a.test.ts', 'x');
    put('tests/b.test.ts', 'y');
    put('.kiro/guard/sealed.json', JSON.stringify({ sealed: [
      { path: 'tests/a.test.ts', sha256: sha('x'), requirements: ['demo:R1.1'] },
      { path: 'tests/b.test.ts', sha256: sha('y'), requirements: ['demo:R3.1', 'demo:R4.1'] },
    ] }));
    put('.kiro/guard/index.json', JSON.stringify({ specs: [{ spec: 'demo', requirements: [{ id: 'R1.1', text: 't', textHash: 'h' }] }] }));
    const r = await check();
    expect(r.code).toBe(1);
    expect(json('.kiro/guard/report.json').runError).toBe('sealed requirement demo:R3.1 is missing from the spec (and 1 more)');
  });

  it('[guard-check:R2.2] a judge crash writes a red report instead of keeping green', async () => {
    allPass();
    await check();
    put('results.json', JSON.stringify({ testResults: [{ name: 'x', assertionResults: [null] }] }));
    const r = await check();
    expect(r.code).toBe(1);
    expect(json('.kiro/guard/report.json').overall).toBe('red');
    expect(json('.kiro/guard/report.json').runError).toContain('guard check failed:');
  });
});

describe('runs and code', () => {
  it('[guard-check:R3.5] runs holds exactly the red requirements that have an execution summary', async () => {
    const subsets = fc.subarray([0, 1, 2], { minLength: 0, maxLength: 3 });
    const tags = ['[R1.1]', '[R1.2]', '[R2.1]'];
    await fc.assert(
      fc.asyncProperty(subsets, subsets, async (withSummary, plain) => {
        const tests: T[] = tags.map((tag, i) => {
          if (withSummary.includes(i)) return { title: `${tag} t`, status: 'failed', failureMessages: [SUMMARY] };
          if (plain.includes(i)) return { title: `${tag} t`, status: 'failed', failureMessages: ['AssertionError: nope'] };
          return { title: `${tag} t`, status: 'passed' };
        });
        results({ 'tests/a.test.ts': tests });
        await check();
        const want = withSummary.map((i) => ['demo__R1.1.json', 'demo__R1.2.json', 'demo__R2.1.json'][i]).sort();
        expect(names('.kiro/guard/runs')).toEqual(want);
      }),
      { numRuns: 12 },
    );
  });

  it('[guard-check:R3.1] the record has inputs, shrinkPath and the original counterexample', async () => {
    results({ 'tests/a.test.ts': [{ title: '[R1.1] t', status: 'failed', failureMessages: [SUMMARY] }] });
    await check();
    expect(json('.kiro/guard/runs/demo__R1.1.json')).toEqual({
      requirement: 'demo:R1.1',
      inputs: [{ v: '"a"', ok: true }, { v: '"ccc"', ok: false }],
      shrinkPath: ['"ccc"', '"bb"'],
      counterexample: '["bb"]',
    });
  });

  it('[guard-check:R2.4] the report code block lists the tagged source lines', async () => {
    allPass();
    await check();
    expect(json('.kiro/guard/report.json').code).toEqual({ file: 'src/a.ts', lines: [{ n: 1, text: 'export const A = 1; // [R1.1]', links: ['demo:R1.1'] }] });
  });
});

describe('seals', () => {
  const body = 'test body';
  function seal(extra: Record<string, unknown> = {}): void {
    put('tests/a.test.ts', body);
    put('.kiro/guard/sealed.json', JSON.stringify({ sealed: [{ path: 'tests/a.test.ts', sha256: sha(body), requirements: ['demo:R1.1'], ...extra }] }));
  }
  const reason = (): string => json('.kiro/guard/report.json').requirements[0].reason;

  it('[guard-check:R4.1] an intact, executed seal stays green', async () => {
    seal();
    allPass();
    await check();
    expect(reason()).toBe('all-passed');
  });

  it('[guard-check:R4.1] changed bytes, a missing file and a test that did not run are seal-broken in that order', async () => {
    seal();
    allPass();
    put('tests/a.test.ts', body + '!');
    await check();
    expect(json('.kiro/guard/report.json').requirements[0].brokenSeals).toEqual([{ path: 'tests/a.test.ts', problem: 'changed' }]);
    rmSync(join(root, 'tests/a.test.ts'));
    await check();
    expect(json('.kiro/guard/report.json').requirements[0].brokenSeals[0].problem).toBe('missing');
    seal();
    results({ 'tests/a.test.ts': [{ title: '[R1.1] a', status: 'skipped' }] });
    await check();
    expect(json('.kiro/guard/report.json').requirements[0].brokenSeals[0].problem).toBe('not-run');
  });

  it('[guard-check:R4.2] a textHash that differs from the spec makes the requirement stale', async () => {
    seal({ textHashes: { 'demo:R1.1': 'sha256:old' } });
    allPass();
    await check();
    expect(reason()).toBe('stale');
  });

  it('[guard-check:R4.3] without sealed.json the verdict is the plain one', async () => {
    put('tests/a.test.ts', body + '!');
    allPass();
    await check();
    expect(reason()).toBe('all-passed');
  });

  it('[guard-check:R4.4] an unreadable sealed.json exits 1 with `unreadable` and writes nothing', async () => {
    put('.kiro/guard/sealed.json', '{oops');
    allPass();
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unreadable');
    expect(names('.kiro/guard')).toEqual(['sealed.json']);
  });
});

describe('events, notices, resolutions', () => {
  it('[guard-check:R5.1] one check line with the verdict counts', async () => {
    allPass();
    await check();
    expect(events().map((e) => [e.action, e.target])).toEqual([['hook', 'guard check · 빨강 0 · 노랑 0 · 초록 3']]);
    expect(events()[0].ts).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('[guard-check:R5.2][guard-check:R5.3] notices only on red entry and red exit, exit code stays 0', async () => {
    const red = (): string => results({ 'tests/a.test.ts': [{ title: '[R1.1] a', status: 'failed', failureMessages: [SUMMARY] }, { title: '[R1.2] b', status: 'passed' }, { title: '[R2.1] c', status: 'passed' }] });
    allPass();
    expect((await check()).stderr).toBe('');
    red();
    const enter = await check();
    expect(enter.code).toBe(0);
    expect(enter.stderr).toBe('Tripwire: violated demo:R1.1 (counterexample ["bb"]). Further writes will be blocked until the user chooses: edit the spec or revert the code.\n');
    expect((await check()).stderr).toBe('');
    allPass();
    expect((await check()).stderr).toBe('Tripwire: no violated requirements now.\n');
  });

  it('[guard-check:R6.1][guard-check:R6.2] approved entries close when green and stay while red', async () => {
    put('.kiro/guard/resolution.json', JSON.stringify({ approved: [
      { requirement: 'demo:R1.1', choice: 'revert-code', by: 'human', approvedAt: 'x' },
      { requirement: 'demo:R1.2', choice: 'edit-spec', by: 'human', approvedAt: 'x' },
      { requirement: 'demo:R9.9', choice: 'edit-spec', by: 'human', approvedAt: 'x' },
    ] }));
    results({ 'tests/a.test.ts': [{ title: '[R1.1] a', status: 'passed' }, { title: '[R1.2] b', status: 'failed' }, { title: '[R2.1] c', status: 'passed' }] });
    await check();
    const res = json('.kiro/guard/resolution.json');
    expect(res.approved.map((a: any) => a.requirement)).toEqual(['demo:R1.2']);
    expect(res.closed.map((a: any) => a.requirement)).toEqual(['demo:R1.1', 'demo:R9.9']);
    expect(res.closed[0].closedAt).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(events().map((e) => e.target)).toEqual(['guard check · 빨강 1 · 노랑 0 · 초록 2', '해결 닫힘 · demo:R1.1', '해결 닫힘 · demo:R9.9']);
  });

  it('[guard-check:R6.3] no resolution.json is never created', async () => {
    allPass();
    await check();
    expect(existsSync(join(root, '.kiro/guard/resolution.json'))).toBe(false);
  });
});

describe('if-changed and summary', () => {
  it('[guard-check:R7.2][guard-check:R7.3] unchanged inputs skip silently; a changed watched file runs again', async () => {
    allPass();
    await check();
    const before = read('.kiro/guard/report.json');
    const n = events().length;
    const r = await check({ ifChanged: true });
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(read('.kiro/guard/report.json')).toBe(before);
    expect(events().length).toBe(n);
    put('src/a.ts', 'export const A = 2; // [R1.1]\n');
    await check({ ifChanged: true });
    expect(events().length).toBe(n + 1);
  });

  it('[guard-check:R7.2] if-changed with summary prints the summary of the existing report', async () => {
    allPass();
    await check();
    const r = await check({ ifChanged: true, summary: true });
    expect(r.stdout.startsWith('Tripwire: 3 requirements (3 green, 0 yellow, 0 red). All requirements pass.')).toBe(true);
    expect(r.stderr).toBe('');
  });

  it('[guard-check:R8.1][guard-check:R8.2] the summary line follows the template; without --summary stdout is empty', async () => {
    allPass();
    expect((await check()).stdout).toBe('');
    const ok = await check({ summary: true });
    expect(ok.stdout).toBe('Tripwire: 3 requirements (3 green, 0 yellow, 0 red). All requirements pass. Sealed test files: 0. Approved resolutions: none. If a requirement must change, ask the user; do not weaken requirements or tests.\n');
    results({ 'tests/a.test.ts': [{ title: '[R1.1] a', status: 'failed', failureMessages: [SUMMARY] }, { title: '[R1.2] b', status: 'passed' }] });
    const bad = await check({ summary: true });
    expect(bad.stdout).toContain('(1 green, 1 yellow, 1 red). Violated: demo:R1.1 (counterexample ["bb"]).');
    results({ 'tests/a.test.ts': [{ title: '[R1.1] a', status: 'passed' }, { title: '[R1.2] b', status: 'passed' }] });
    expect((await check({ summary: true })).stdout).toContain('Not verified: demo:R2.1 (no-tests).');
  });
});

describe('locks', () => {
  it('[guard-check:R9.7] adopt.lock makes check do nothing and say so', async () => {
    allPass();
    put('.kiro/guard/adopt.lock', '');
    const r = await check();
    expect(r).toEqual({ code: 0, stdout: '', stderr: 'adopt in progress\n' });
    expect(names('.kiro/guard')).toEqual(['adopt.lock']);
  });

  it('[guard-check:R9.7] check.lock is removed when check ends, also after a failure', async () => {
    put('results.json', 'bad');
    await check();
    expect(existsSync(join(root, '.kiro/guard/check.lock'))).toBe(false);
  });
});
