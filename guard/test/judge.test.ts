// Tests for judge (task 3).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { judge, parseFailure } from '../src/judge.js';

const index = {
  specs: [
    { spec: 'a', requirements: [{ id: 'R1.1', text: 't', textHash: 'sha256:aa' }, { id: 'R1.2', text: 't', textHash: 'sha256:bb' }] },
    { spec: 'b', requirements: [{ id: 'R1.1', text: 't', textHash: 'sha256:cc' }, { id: 'R2.1', text: 't', textHash: 'sha256:dd' }] },
  ],
};
const results = (tests: { title: string; status: string; failureMessages?: string[] }[]) => ({
  testResults: [{ assertionResults: tests.map((t) => ({ failureMessages: [], ...t })) }],
});
const one = (r: ReturnType<typeof judge>, id: string) => r.requirements.find((x) => x.id === id)!;

const status = fc.constantFrom('passed', 'failed', 'skipped', 'pending', 'todo');
const nonCounted = fc.constantFrom('skipped', 'pending', 'todo');

describe('judge', () => {
  it('[guard-core:R2.2] a broken seal is always red seal-broken, whatever the results', () => {
    fc.assert(
      fc.property(fc.array(status, { maxLength: 5 }), fc.constantFrom('missing', 'changed', 'not-run'), (sts, problem) => {
        const res = results(sts.map((s) => ({ title: '[a:R1.2] x', status: s, failureMessages: ['Counterexample: [1]'] })));
        const seals = { 'a:R1.2': [{ path: 'tests/x.ts', problem }] };
        const r = one(judge({ index, results: res, brokenSeals: seals }), 'a:R1.2');
        expect(r.verdict).toBe('red');
        expect(r.reason).toBe('seal-broken');
        expect(r.brokenSeals).toEqual(seals['a:R1.2']);
        expect('counterexample' in r || 'runs' in r || 'shrinks' in r).toBe(false);
      }),
    );
  });

  it('[guard-core:R2.3] any failed linked test makes red test-failed with parsed counterexample', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('passed', 'failed', 'skipped'), { maxLength: 4 }), fc.nat(500), fc.nat(50), (before, runs, shr) => {
        const msg = `\u001b[31mProperty failed after ${runs + 1} tests\nShrunk ${shr} time(s)\nCounterexample: ["aaa000"]\u001b[39m\nmore`;
        const tests = [
          ...before.map((s) => ({ title: '[R2.1] p', status: s === 'failed' ? 'passed' : s })),
          { title: '[R2.1] f', status: 'failed', failureMessages: [msg] },
        ];
        const r = one(judge({ index, results: results(tests) }), 'b:R2.1');
        expect(r.verdict).toBe('red');
        expect(r.reason).toBe('test-failed');
        expect(r.counterexample).toBe('["aaa000"]');
        expect(r.runs).toBe(runs + 1);
        expect(r.shrinks).toBe(shr);
      }),
    );
  });

  it('[guard-core:R2.3] missing phrases leave out counterexample and runs, shrinks is 0', () => {
    expect(parseFailure(['boom'])).toEqual({ shrinks: 0 });
    const r = one(judge({ index, results: results([{ title: '[R2.1] f', status: 'failed', failureMessages: ['boom'] }]) }), 'b:R2.1');
    expect(r).toEqual({ id: 'b:R2.1', verdict: 'red', reason: 'test-failed', shrinks: 0, tests: [{ title: '[R2.1] f', status: 'failed' }] });
  });

  it('[guard-core:R2.4] zero counted tests is yellow no-tests; skipped and pending do not count', () => {
    fc.assert(
      fc.property(fc.array(nonCounted, { maxLength: 5 }), (sts) => {
        const r = one(judge({ index, results: results(sts.map((s) => ({ title: '[R2.1] x', status: s }))) }), 'b:R2.1');
        expect(r.verdict).toBe('yellow');
        expect(r.reason).toBe('no-tests');
        expect(r.tests).toEqual([]);
      }),
    );
  });

  it('[guard-core:R2.5] a differing gen-hash makes yellow stale, an equal one stays green', () => {
    const res = results([{ title: '[b:R2.1] ok', status: 'passed' }]);
    expect(one(judge({ index, results: res, genHashes: { 'b:R2.1': 'sha256:other' } }), 'b:R2.1').reason).toBe('stale');
    expect(one(judge({ index, results: res, genHashes: { 'b:R2.1': 'sha256:dd' } }), 'b:R2.1').reason).toBe('all-passed');
    expect(one(judge({ index, results: res }), 'b:R2.1').reason).toBe('all-passed');
  });

  it('[guard-core:R2.6] all passed (plus skipped noise) is always green all-passed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.array(nonCounted, { maxLength: 4 }), (n, noise) => {
        const base = Array.from({ length: n }, (_, i) => ({ title: `[R2.1] p${i}`, status: 'passed' }));
        const a = one(judge({ index, results: results(base), genHashes: { 'b:R2.1': 'sha256:dd' } }), 'b:R2.1');
        const b = one(
          judge({ index, results: results([...base, ...noise.map((s) => ({ title: '[R2.1] n', status: s }))]), genHashes: { 'b:R2.1': 'sha256:dd' } }),
          'b:R2.1',
        );
        expect(a.verdict).toBe('green');
        expect(a.reason).toBe('all-passed');
        expect(b.verdict).toBe(a.verdict);
        expect(b.reason).toBe(a.reason);
      }),
    );
  });

  it('[guard-core:R2.1] short tags link only when exactly one spec has the ID; full tags always', () => {
    const r = judge({
      index,
      results: results([
        { title: '[R1.1] ambiguous', status: 'passed' },
        { title: '[R1.2] unique', status: 'passed' },
        { title: '[a:R1.1][b:R1.1] both', status: 'passed' },
      ]),
    });
    expect(one(r, 'a:R1.2').tests.map((t) => t.title)).toEqual(['[R1.2] unique']);
    expect(one(r, 'a:R1.1').tests.map((t) => t.title)).toEqual(['[a:R1.1][b:R1.1] both']);
    expect(one(r, 'b:R1.1').tests.map((t) => t.title)).toEqual(['[a:R1.1][b:R1.1] both']);
  });

  it('[guard-core:R2.7] unknown and ambiguous tags become orphans in order without duplicates', () => {
    const r = judge({
      index,
      results: results([
        { title: '[R9.9] x [R1.1]', status: 'passed' },
        { title: '[zz:R1.1] y [R9.9]', status: 'passed' },
      ]),
    });
    expect(r.orphans).toEqual(['R9.9', 'R1.1', 'zz:R1.1']);
  });

  it('[guard-core:R2.8] overall is the worst verdict and summary counts them', () => {
    const r = judge({ index, results: results([{ title: '[a:R1.1] x', status: 'passed' }, { title: '[R2.1] y', status: 'failed' }]) });
    expect(r.overall).toBe('red');
    expect(r.summary).toEqual({ green: 1, yellow: 2, red: 1 });
    const y = judge({ index, results: results([]) });
    expect(y.overall).toBe('yellow');
    const g = judge({
      index: { specs: [index.specs[0]] },
      results: results([{ title: '[R1.1] a', status: 'passed' }, { title: '[R1.2] b', status: 'passed' }]),
    });
    expect(g.overall).toBe('green');
    expect(g.summary).toEqual({ green: 2, yellow: 0, red: 0 });
  });
});
