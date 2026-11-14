// Tests for code extraction (task 4).
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractCode, taggedLines } from '../src/code.js';
import type { SpecIndex } from '../src/scan.js';

const index: SpecIndex = {
  specs: [{ spec: 'signup', requirements: [1, 2, 3].map((m) => ({ id: `R1.${m}`, text: 't', textHash: 'h' })) }],
};

const lineArb = fc.oneof(
  fc.constant('const a = 1;'),
  fc.constant('x // [R1.1]'),
  fc.constant('  y // [signup:R1.2] and [R1.3]  '),
  fc.constant('z // [R9.9] unknown'),
  fc.constant(''),
);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-code-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function put(rel: string, text: string): void {
  const f = join(root, ...rel.split('/'));
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, text, 'utf8');
}

describe('code extraction', () => {
  it('[guard-check:R2.4] line numbers start at 1 and untagged or unresolved lines are left out', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 12 }), (lines) => {
        const got = taggedLines(lines.join('\n'), index);
        const want = lines.flatMap((l, i) => (/\[(?:signup:)?R1\.[123]\]/.test(l) ? [i + 1] : []));
        expect(got.map((g) => g.n)).toEqual(want);
        for (const g of got) expect(g.text).toBe(lines[g.n - 1].trim());
      }),
    );
  });

  it('[guard-check:R2.4] CRLF and LF files give the same lines', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 12 }), (lines) => {
        expect(taggedLines(lines.join('\r\n'), index)).toEqual(taggedLines(lines.join('\n'), index));
      }),
    );
  });

  it('[guard-check:R2.4] links are the full IDs in order of appearance without duplicates', () => {
    const [l] = taggedLines('a [R1.3] [signup:R1.1] [R1.3]', index);
    expect(l.links).toEqual(['signup:R1.3', 'signup:R1.1']);
  });

  it('[guard-check:R2.5] the file with most tagged lines is the main file; others follow with a file name', () => {
    put('src/a.ts', '// [R1.1]\n');
    put('src/b.ts', 'x\n// [R1.2]\n// [R1.3]\n');
    put('src/c.test.ts', '// [R1.1]\n');
    put('src/node_modules/d.ts', '// [R1.1]\n');
    const code = extractCode(root, ['src/**/*.ts'], index);
    expect(code.file).toBe('src/b.ts');
    expect(code.lines.map((l) => [l.n, l.file ?? null])).toEqual([
      [2, null],
      [3, null],
      [1, 'src/a.ts'],
    ]);
  });

  it('[guard-check:R2.5] no tagged line gives a null file and no lines', () => {
    put('src/a.ts', 'nothing here\n');
    expect(extractCode(root, ['src/**/*.ts'], index)).toEqual({ file: null, lines: [] });
  });
});
