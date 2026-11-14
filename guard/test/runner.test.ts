// Tests for the vitest runner using a fake vitest package (task 2).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readResultsFile, runVitest, vitestBin } from '../src/runner.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-runner-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Create node_modules/vitest with a given `bin` field and entry script body. */
function fake(bin: unknown, script: string, entry = 'entry.mjs'): void {
  const p = join(dir, 'node_modules', 'vitest');
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'vitest', bin }), 'utf8');
  writeFileSync(join(p, entry), script, 'utf8');
}

const WRITES_JSON = `
import fs from 'node:fs';
const a = process.argv.slice(2);
const out = a.find((x) => x.startsWith('--outputFile=')).slice(13);
fs.writeFileSync(out, JSON.stringify({ args: a, cwd: process.cwd(), testResults: [] }));
process.exit(1);
`;

describe('vitest runner', () => {
  it('[guard-check:R1.1] bin as a string or as an object with a vitest key', () => {
    fake('./entry.mjs', WRITES_JSON);
    expect(vitestBin(dir)).toBe(join(dir, 'node_modules', 'vitest', 'entry.mjs'));
    fake({ vitest: './entry.mjs' }, WRITES_JSON);
    expect(vitestBin(dir)).toBe(join(dir, 'node_modules', 'vitest', 'entry.mjs'));
    fake({ other: './entry.mjs' }, WRITES_JSON);
    expect(vitestBin(dir)).toBeNull();
  });

  it('[guard-check:R1.1][guard-check:R1.2] runs with the given arguments in testDir and uses JSON despite exit code 1', async () => {
    fake('./entry.mjs', WRITES_JSON);
    const r = await runVitest({ testDir: dir, timeoutSeconds: 20, files: ['tests/a.test.ts'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.results as { args: string[]; cwd: string };
    expect(out.args[0]).toBe('run');
    expect(out.args).toContain('--reporter=json');
    expect(out.args).toContain('--passWithNoTests');
    expect(out.args[out.args.indexOf('--testNamePattern') + 1]).toBe(String.raw`\[(?:[A-Za-z0-9_-]+:)?R\d+\.\d+\]`);
    expect(out.args[out.args.length - 1]).toBe('tests/a.test.ts');
    expect(out.cwd.toLowerCase()).toBe(dir.toLowerCase());
  });

  it('[guard-check:R1.3] missing vitest, no output, non-JSON output and timeout are distinct failures', async () => {
    const missing = await runVitest({ testDir: dir, timeoutSeconds: 5 });
    expect(missing).toMatchObject({ ok: false });
    expect(!missing.ok && missing.error).toContain('vitest not found');

    fake('./entry.mjs', 'process.exit(0);');
    const none = await runVitest({ testDir: dir, timeoutSeconds: 20 });
    expect(!none.ok && none.error).toBe('vitest produced no output');

    fake('./entry.mjs', `import fs from 'node:fs'; const a = process.argv.find((x) => x.startsWith('--outputFile=')).slice(13); fs.writeFileSync(a, 'oops');`);
    const bad = await runVitest({ testDir: dir, timeoutSeconds: 20 });
    expect(!bad.ok && bad.error).toBe('vitest output is not JSON');

    fake('./entry.mjs', 'setInterval(() => {}, 1000);');
    const slow = await runVitest({ testDir: dir, timeoutSeconds: 1 });
    expect(!slow.ok && slow.error).toBe('vitest timed out after 1s');
  });

  it('[guard-check:R1.4] a results file is read as JSON; missing or non-JSON files fail', () => {
    const good = join(dir, 'r.json');
    writeFileSync(good, '\uFEFF{"testResults":[]}', 'utf8');
    expect(readResultsFile(good)).toEqual({ ok: true, results: { testResults: [] } });
    writeFileSync(join(dir, 'bad.json'), 'nope', 'utf8');
    expect(readResultsFile(join(dir, 'bad.json')).ok).toBe(false);
    expect(readResultsFile(join(dir, 'none.json')).ok).toBe(false);
  });
});
