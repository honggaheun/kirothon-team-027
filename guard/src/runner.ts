// vitest runner: runs the entry file with Node directly (no shell), reads the JSON report. // [guard-check:R1.1]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readTextFile } from './common.js';

export const TAG_PATTERN = String.raw`\[(?:[A-Za-z0-9_-]+:)?R\d+\.\d+\]`;

export type RunOutcome = { ok: true; results: unknown } | { ok: false; error: string };

export interface RunOptions {
  testDir: string; // absolute
  timeoutSeconds: number;
  files?: string[]; // extra file filters, relative to testDir, `/` separated
}

/** Path of the vitest entry file named by its package.json `bin`, or null. // [guard-check:R1.1] */
export function vitestBin(testDir: string): string | null {
  const pkgFile = join(testDir, 'node_modules', 'vitest', 'package.json');
  try {
    const pkg = JSON.parse(readTextFile(pkgFile)) as { bin?: unknown };
    let rel: unknown;
    if (typeof pkg.bin === 'string') rel = pkg.bin;
    else if (typeof pkg.bin === 'object' && pkg.bin !== null) rel = (pkg.bin as Record<string, unknown>).vitest;
    if (typeof rel !== 'string') return null;
    const bin = resolve(dirname(pkgFile), rel);
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** Parse vitest JSON text; null when it is not a JSON object. */
export function parseResults(text: string): unknown | null {
  try {
    const v = JSON.parse(text.replace(/^\uFEFF/, ''));
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}

/** Read a `--results` file as vitest JSON. // [guard-check:R1.4] */
export function readResultsFile(file: string): RunOutcome {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, error: `results file not found: ${file}` };
  }
  const v = parseResults(text);
  return v === null ? { ok: false, error: `results file is not JSON: ${file}` } : { ok: true, results: v };
}

/** Kill a process and its children. */
function killTree(pid: number | undefined, fallback: () => void): void {
  if (process.platform === 'win32' && pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    fallback();
  }
}

/** Run vitest once and return its parsed JSON, ignoring the exit code. // [guard-check:R1.1][guard-check:R1.2][guard-check:R1.3] */
export async function runVitest(o: RunOptions): Promise<RunOutcome> {
  const bin = vitestBin(o.testDir);
  if (bin === null) return { ok: false, error: `vitest not found under ${o.testDir.replace(/\\/g, '/')}/node_modules` };
  const tmpDir = mkdtempSync(join(tmpdir(), 'guard-vitest-'));
  const outFile = join(tmpDir, 'out.json');
  try {
    const args = [bin, 'run', '--reporter=json', '--outputFile=' + outFile, '--passWithNoTests', '--testNamePattern', TAG_PATTERN, ...(o.files ?? [])];
    const timedOut = await new Promise<boolean>((done, fail) => {
      const child = spawn(process.execPath, args, { cwd: o.testDir, shell: false, windowsHide: true, stdio: 'ignore' });
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        killTree(child.pid, () => child.kill('SIGKILL'));
      }, o.timeoutSeconds * 1000);
      child.on('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        done(late);
      });
    });
    if (timedOut) return { ok: false, error: `vitest timed out after ${o.timeoutSeconds}s` };
    if (!existsSync(outFile)) return { ok: false, error: 'vitest produced no output' };
    const v = parseResults(readFileSync(outFile, 'utf8'));
    return v === null ? { ok: false, error: 'vitest output is not JSON' } : { ok: true, results: v };
  } catch (e) {
    return { ok: false, error: `vitest could not run: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
