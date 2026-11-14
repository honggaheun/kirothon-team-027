// Tests for settings, globs, watch list, atomic writes and time helpers (task 1).
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  atomicWrite,
  atomicWriteJson,
  computeInputsHash,
  globToRegExp,
  hms,
  loadConfig,
  localIso,
  watchList,
} from '../src/config.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-config-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, text = 'x'): void {
  const f = join(root, ...rel.split('/'));
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, text, 'utf8');
}

const seg = fc.string({ unit: fc.constantFrom(...'abcxyz019_-'.split('')), minLength: 1, maxLength: 6 });

describe('glob rules', () => {
  it('[guard-check:R2.4] `**/` matches zero folders and many folders', () => {
    fc.assert(
      fc.property(fc.array(seg, { maxLength: 4 }), seg, (dirs, name) => {
        const rel = [...dirs, `${name}.test.ts`].join('/');
        expect(globToRegExp('tests/**/*.test.ts').test('tests/' + rel)).toBe(true);
      }),
    );
  });

  it('[guard-check:R2.4] `*` never crosses a slash and `?` is one non-slash char', () => {
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/b.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('a/.ts')).toBe(false);
    expect(globToRegExp('a?.ts').test('abc.ts')).toBe(false);
  });

  it('[guard-check:R2.4] a trailing `**` covers everything below, case is ignored, dots are literal', () => {
    expect(globToRegExp('src/**').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('SRC/**/*.TS').test('src/a.ts')).toBe(true);
    expect(globToRegExp('a.ts').test('axts')).toBe(false);
  });
});

describe('config and watch list', () => {
  it('[guard-check:R2.1] defaults apply when the file or keys are missing', () => {
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
    put('.kiro/guard/config.json', JSON.stringify({ sourceGlobs: ['lib/**/*.ts'], timeoutSeconds: 5 }));
    const c = loadConfig(root);
    expect(c.sourceGlobs).toEqual(['lib/**/*.ts']);
    expect(c.timeoutSeconds).toBe(5);
    expect(c.testGlobs).toEqual(DEFAULT_CONFIG.testGlobs);
  });

  it('[guard-check:R7.1] watch list holds specs, tests, sources, vitest files and guard files, skipping node_modules', () => {
    put('.kiro/specs/a/requirements.md');
    put('src/a.ts');
    put('src/node_modules/x.ts');
    put('tests/a.test.ts');
    put('package.json');
    put('vitest.config.ts');
    put('README.md');
    put('.kiro/guard/sealed.json', '{}');
    put('.kiro/guard/report.json', '{}');
    expect(watchList(root, loadConfig(root))).toEqual([
      '.kiro/guard/sealed.json',
      '.kiro/specs/a/requirements.md',
      'package.json',
      'src/a.ts',
      'tests/a.test.ts',
      'vitest.config.ts',
    ]);
  });

  it('[guard-check:R7.1] inputsHash changes with a watched byte and ignores unwatched files', () => {
    put('.kiro/specs/a/requirements.md', 'abc');
    put('src/a.ts', 'one');
    const cfg = loadConfig(root);
    const h0 = computeInputsHash(root, cfg);
    expect(computeInputsHash(root, cfg)).toBe(h0);
    put('notes.txt', 'unwatched');
    expect(computeInputsHash(root, cfg)).toBe(h0);
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 8 }), (s) => {
        put('src/a.ts', 'one' + s);
        const changed = computeInputsHash(root, cfg) !== h0;
        put('src/a.ts', 'one');
        expect(changed).toBe(true);
      }),
      { numRuns: 20 },
    );
    expect(h0).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('writes and time', () => {
  it('[guard-check:R2.3] atomic write replaces the file and leaves no temp file', () => {
    const f = join(root, 'out', 'r.json');
    atomicWriteJson(f, { a: 1 });
    atomicWrite(f, 'second\n');
    expect(readFileSync(f, 'utf8')).toBe('second\n');
    expect(readdirSync(join(root, 'out'))).toEqual(['r.json']);
  });

  it('[guard-check:R2.3] local ISO time has an offset and HH:MM:SS has eight characters', () => {
    expect(localIso(new Date(2026, 10, 14, 14, 2, 11))).toMatch(/^2026-11-14T14:02:11[+-]\d{2}:\d{2}$/);
    expect(hms(new Date(2026, 10, 14, 4, 2, 1))).toBe('04:02:01');
  });
});
