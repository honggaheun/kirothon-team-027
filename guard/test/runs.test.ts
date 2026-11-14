// Tests for counterexample records (task 5).
import fc from 'fast-check';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSummary, stripAnsi, syncRuns } from '../src/runs.js';

const G = '\u001b[32m√\u001b[0m';
const R = '\u001b[31m×\u001b[0m';

// A shrink tree: depth-0 inputs, then one list of attempts per depth.
interface Tree {
  zero: { v: string; ok: boolean }[];
  deeper: { v: string; ok: boolean }[][];
}
const val = fc.string({ unit: fc.constantFrom(...'abcdefgh0123456789,"'.split('')), minLength: 1, maxLength: 8 });
const attempt = fc.record({ v: val, ok: fc.boolean() });
const tree: fc.Arbitrary<Tree> = fc.record({
  zero: fc.array(attempt, { minLength: 1, maxLength: 6 }),
  deeper: fc.array(fc.array(attempt, { minLength: 1, maxLength: 4 }), { maxLength: 5 }),
});

function render(t: Tree): string {
  const lines = ['Error: Property failed after 3 tests', 'Counterexample: ["x"]', '', 'Execution summary:'];
  const put = (d: number, a: { v: string; ok: boolean }) =>
    lines.push(`${'. '.repeat(d)}${a.ok ? G : R} [${a.v}]`);
  t.zero.forEach((a) => put(0, a));
  t.deeper.forEach((lvl, i) => lvl.forEach((a) => put(i + 1, a)));
  lines.push('    at buildError (file:///x/fast-check.js:1:1)');
  return lines.join('\n');
}

function expected(t: Tree): { inputs: { v: string; ok: boolean }[]; shrinkPath: string[] } {
  const shrinkPath: string[] = [];
  const levels = [t.zero, ...t.deeper];
  for (const lvl of levels) {
    const fails = lvl.filter((a) => !a.ok);
    if (fails.length === 0) break;
    shrinkPath.push(fails[fails.length - 1].v);
  }
  return { inputs: t.zero, shrinkPath };
}

describe('execution summary', () => {
  it('[guard-check:R3.2][guard-check:R3.3][guard-check:R3.4] parsing a rendered tree gives the tree back', () => {
    fc.assert(
      fc.property(tree, (t) => {
        expect(parseSummary([render(t)])).toEqual(expected(t));
      }),
    );
  });

  it('[guard-check:R3.2] removing color codes twice equals once', () => {
    fc.assert(
      fc.property(tree, (t) => {
        const once = stripAnsi(render(t));
        expect(stripAnsi(once)).toBe(once);
        expect(once).not.toContain('\u001b');
      }),
    );
  });

  it('[guard-check:R3.2] stack lines and messages without a summary are ignored', () => {
    expect(parseSummary(['AssertionError: expected 1 to be 2'])).toBeNull();
    expect(parseSummary(['Execution summary:\n    at foo (a.js:1:1)\n√ ["a"]'])?.inputs).toEqual([{ v: '"a"', ok: true }]);
  });

  it('[guard-check:R3.2] only one outer bracket pair is removed and multi-argument values stay whole', () => {
    const s = parseSummary(['Execution summary:\n× ["a",3]\n× [[1,2]]\n× plain']);
    expect(s?.inputs.map((i) => i.v)).toEqual(['"a",3', '[1,2]', 'plain']);
  });
});

describe('runs files', () => {
  it('[guard-check:R3.1][guard-check:R3.5] writes records with a safe name and removes every other file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-runs-'));
    try {
      writeFileSync(join(dir, 'signup__R1.1.json'), '{}');
      writeFileSync(join(dir, 'signup__R9.9.json'), '{}');
      const summary = { inputs: [{ v: '"a"', ok: false }], shrinkPath: ['"a"'] };
      syncRuns(dir, new Map([['signup:R1.1', { summary, counterexample: '["a"]' }]]));
      expect(readdirSync(dir)).toEqual(['signup__R1.1.json']);
      const rec = JSON.parse(readFileSync(join(dir, 'signup__R1.1.json'), 'utf8'));
      expect(Object.keys(rec)).toEqual(['requirement', 'inputs', 'shrinkPath', 'counterexample']);
      expect(rec.requirement).toBe('signup:R1.1');
      syncRuns(dir, new Map());
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
