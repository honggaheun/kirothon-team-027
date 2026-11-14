// Tests for adopt with a fake vitest: mutants are caught when the source holds BAD (task 10).
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAdopt } from '../src/adopt.js';

const SPEC = `### Requirement 1

#### Acceptance Criteria

1. WHEN a THEN the system SHALL x
2. WHEN b THEN the system SHALL y
`;

// Fake vitest: reads src/x.ts; the test file named last fails when the source contains BAD.
const FAKE = `
import fs from 'node:fs';
const a = process.argv.slice(2);
const out = a.find((x) => x.startsWith('--outputFile=')).slice(13);
const file = a[a.length - 1];
const bad = fs.readFileSync('src/x.ts', 'utf8').includes('BAD');
const title = fs.existsSync('title.txt') ? fs.readFileSync('title.txt', 'utf8') : '[demo:R1.1] t';
const status = fs.existsSync('crash.txt') ? null : bad ? 'failed' : 'passed';
const testResults = status ? [{ name: process.cwd().replace(/\\\\/g, '/') + '/' + file, assertionResults: [{ title, status, failureMessages: [] }] }] : [];
fs.writeFileSync(out, JSON.stringify({ testResults }));
`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-adopt-'));
  put('.kiro/specs/demo/requirements.md', SPEC);
  put('src/x.ts', 'export const N = 8; // GOOD\n');
  put('tests/demo/R1.1.prop.test.ts', 'test body');
  put('node_modules/vitest/package.json', JSON.stringify({ name: 'vitest', bin: { vitest: './fake.mjs' } }));
  put('node_modules/vitest/fake.mjs', FAKE);
  mutant('m1', 'GOOD', 'BAD');
  mutant('m2', '8;', '7; // BAD');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, text: string): void {
  const f = join(root, ...rel.split('/'));
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, text, 'utf8');
}
function mutant(name: string, find: string, replace: string, extra: Record<string, unknown> = {}): void {
  put(`mutants/${name}.json`, JSON.stringify({ requirement: 'demo:R1.1', file: 'src/x.ts', find, replace, why: 'w', ...extra }));
}
const run = (mutants: string[], over: Partial<Parameters<typeof runAdopt>[0]> = {}) =>
  runAdopt({ root, cwd: root, requirement: 'demo:R1.1', test: 'tests/demo/R1.1.prop.test.ts', mutants: mutants.map((m) => `mutants/${m}.json`), ...over });
const src = (): string => readFileSync(join(root, 'src/x.ts'), 'utf8');
const sealedPath = join('.kiro', 'guard', 'sealed.json');

describe('adopt', () => {
  it('[guard-check:R9.1] missing arguments are a usage error', async () => {
    await expect(run([])).rejects.toThrow();
    await expect(run(['m1'], { test: undefined })).rejects.toThrow();
    await expect(run(['m1'], { requirement: undefined })).rejects.toThrow();
  });

  it('[guard-check:R9.5] when every mutant is caught, the test is sealed and the source bytes are unchanged', async () => {
    const before = readFileSync(join(root, 'src/x.ts'));
    const r = await run(['m1', 'm2']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('sealed tests/demo/R1.1.prop.test.ts for demo:R1.1 (2 mutants caught)\n');
    expect(readFileSync(join(root, 'src/x.ts')).equals(before)).toBe(true);
    const sealed = JSON.parse(readFileSync(join(root, sealedPath), 'utf8')).sealed;
    expect(sealed).toHaveLength(1);
    expect(sealed[0].path).toBe('tests/demo/R1.1.prop.test.ts');
    expect(sealed[0].requirements).toEqual(['demo:R1.1']);
    expect(sealed[0].sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sealed[0].textHashes['demo:R1.1']).toMatch(/^sha256:/);
    const ev = readFileSync(join(root, '.kiro/guard/events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(ev[0]).toMatchObject({ action: 'human', target: '검사 봉인 · tests/demo/R1.1.prop.test.ts (demo:R1.1)' });
    expect(existsSync(join(root, '.kiro/guard/adopt.lock'))).toBe(false);
    expect(existsSync(join(root, '.kiro/guard/report.json'))).toBe(true); // check ran once
  });

  it('[guard-check:R9.5] sealing the same path again replaces the entry', async () => {
    await run(['m1']);
    await run(['m1']);
    expect(JSON.parse(readFileSync(join(root, sealedPath), 'utf8')).sealed).toHaveLength(1);
  });

  it('[guard-check:R9.6] a surviving mutant leaves sealed.json untouched and restores the source', async () => {
    mutant('m3', 'GOOD', 'STILL OK');
    const before = readFileSync(join(root, 'src/x.ts'));
    const r = await run(['m1', 'm3']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('mutant survived: demo:R1.1 (mutants/m3.json)\n');
    expect(existsSync(join(root, sealedPath))).toBe(false);
    expect(readFileSync(join(root, 'src/x.ts')).equals(before)).toBe(true);
    expect(existsSync(join(root, '.kiro/guard/adopt.lock'))).toBe(false);
    expect(readdirSync(join(root, '.kiro/guard/mutant-backup'))).toEqual(['src']);
    expect(readdirSync(join(root, '.kiro/guard/mutant-backup/src'))).toEqual([]);
  });

  it('[guard-check:R9.4] a mutant whose run yields no test results is not caught', async () => {
    put('crash.txt', '');
    const r = await run(['m1']);
    expect(r.code).toBe(1); // baseline has no tagged tests
    rmSync(join(root, 'crash.txt'));
  });

  it('[guard-check:R9.2] tags that belong to another requirement stop the adoption', async () => {
    put('title.txt', '[demo:R1.2] other');
    const r = await run(['m1']);
    expect(r.code).toBe(1);
    expect(existsSync(join(root, sealedPath))).toBe(false);
    put('title.txt', '[demo:R1.1][demo:R1.2] both');
    expect((await run(['m1'])).code).toBe(1);
  });

  it('[guard-check:R9.3] a bad mutant file changes nothing: wrong requirement, find twice, find absent, not JSON', async () => {
    put('src/x.ts', 'a a\n');
    mutant('w', 'a', 'b', { requirement: 'demo:R1.2' });
    mutant('twice', 'a', 'BAD');
    mutant('none', 'zzz', 'BAD');
    put('mutants/junk.json', 'junk');
    for (const m of ['w', 'twice', 'none', 'junk']) {
      const r = await run(['m1', m]);
      expect(r.code, m).toBe(1);
    }
    expect(src()).toBe('a a\n');
    expect(existsSync(join(root, sealedPath))).toBe(false);
  });

  it('[guard-check:R9.1] an existing adopt.lock stops adopt; leftover backups are restored first', async () => {
    put('.kiro/guard/adopt.lock', '');
    expect((await run(['m1'])).code).toBe(1);
    rmSync(join(root, '.kiro/guard/adopt.lock'));
    put('.kiro/guard/mutant-backup/src/x.ts', 'export const N = 8; // GOOD\n');
    put('src/x.ts', 'broken by a crash BAD\n');
    const r = await run(['m1']);
    expect(r.stderr).toContain('src/x.ts');
    expect(src()).toBe('export const N = 8; // GOOD\n');
    expect(r.code).toBe(0);
  });
});
