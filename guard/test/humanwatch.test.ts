// Tests for human-save detection (guard-serve task 3).
import fc from 'fast-check';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { classifyChange, isWatchTarget, startHumanWatch } from '../src/humanwatch.js';

const p2 = (n: number) => String(n).padStart(2, '0');
const hms = (s: number) => `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
const NOW = new Date(2026, 10, 14, 12, 0, 30); // 12:00:30
const nowSec = 12 * 3600 + 30;

describe('classifyChange', () => {
  it('[guard-serve:R3.1] a write of the same path or a shell line within 10 seconds is the agent', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), fc.constantFrom('write', 'shell'), (age, action) => {
        const ev = { ts: hms(nowSec - age), action, target: action === 'write' ? 'SRC\\a.ts' : 'npm test' };
        return classifyChange('src/a.ts', [ev], NOW) === 'agent';
      }),
    );
  });
  it('[guard-serve:R3.1] anything else is a human save', () => {
    fc.assert(
      fc.property(fc.integer({ min: 11, max: 600 }), fc.constantFrom('write', 'shell'), (age, action) => {
        const old = { ts: hms(nowSec - age), action, target: 'src/a.ts' };
        const other = { ts: hms(nowSec - 1), action: 'write', target: 'src/b.ts' };
        const kinds = { ts: hms(nowSec - 1), action: 'hook', target: 'src/a.ts' };
        return classifyChange('src/a.ts', [old, other, kinds], NOW) === 'human';
      }),
    );
    expect(classifyChange('src/a.ts', [], NOW)).toBe('human');
  });
  it('[guard-serve:R3.1] lines that look like the future (across midnight) are not compared', () => {
    expect(classifyChange('a.ts', [{ ts: '23:59:58', action: 'shell', target: 'x' }], new Date(2026, 10, 14, 0, 0, 3))).toBe('human');
  });
});

describe('isWatchTarget', () => {
  const cfg = { ...DEFAULT_CONFIG, specsDir: '.kiro/specs', testGlobs: ['tests/**/*.test.ts'], sourceGlobs: ['src/**/*.ts'], testDir: '.' };
  it('[guard-serve:R3.1] spec, test, source and vitest files only', () => {
    const yes = ['.kiro/specs/signup/requirements.md', 'src/signup/validate.ts', 'tests/a.test.ts', 'vitest.config.ts', 'package.json'];
    const no = ['.kiro/guard/report.json', '.kiro/hooks/x.json', 'node_modules/x/src/a.ts', 'README.md', 'sub/package.json', 'src/a.js', '.git/HEAD'];
    for (const f of yes) expect(isWatchTarget(f, cfg, process.cwd()), f).toBe(true);
    for (const f of no) expect(isWatchTarget(f, cfg, process.cwd()), f).toBe(false);
  });
});

describe('startHumanWatch', () => {
  const temps: string[] = [];
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const s of stops.splice(0)) s();
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'hw-'));
    temps.push(root);
    mkdirSync(join(root, '.kiro', 'specs', 's'), { recursive: true });
    mkdirSync(join(root, '.kiro', 'guard'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, '.kiro', 'specs', 's', 'requirements.md'), 'one');
    writeFileSync(join(root, 'src', 'a.ts'), 'a');
    return root;
  }
  const events = (root: string) =>
    (() => {
      try {
        return readFileSync(join(root, '.kiro', 'guard', 'events.jsonl'), 'utf8')
          .split('\n')
          .filter((l) => l)
          .map((l) => JSON.parse(l) as { action: string; target: string; ts: string });
      } catch {
        return [];
      }
    })();

  function start(root: string, calls: { n: number; release?: () => void }, hold = false): void {
    stops.push(
      startHumanWatch({
        root,
        cliFile: 'unused',
        debounceMs: 60,
        runCheck: () => {
          calls.n++;
          return hold ? new Promise<void>((r) => (calls.release = r)) : Promise.resolve();
        },
      }),
    );
  }

  it('[guard-serve:R3.1] a human save writes a save line and runs check once; same-content events do not', async () => {
    const root = workspace();
    const calls = { n: 0 };
    start(root, calls);
    writeFileSync(join(root, 'src', 'a.ts'), 'a'); // same bytes
    await sleep(400);
    expect(calls.n).toBe(0);
    writeFileSync(join(root, 'src', 'a.ts'), 'b');
    writeFileSync(join(root, 'src', 'a.ts'), 'bc');
    await sleep(500);
    expect(calls.n).toBe(1);
    const saves = events(root).filter((e) => e.action === 'save');
    expect(saves.map((e) => e.target)).toEqual(['src/a.ts · 사람 저장']);
    expect(saves[0].ts).toMatch(/^\d\d:\d\d:\d\d$/);
  });

  it('[guard-serve:R3.1] a deleted watched file counts; a new file counts', async () => {
    const root = workspace();
    const calls = { n: 0 };
    start(root, calls);
    unlinkSync(join(root, 'src', 'a.ts'));
    await sleep(500);
    expect(calls.n).toBe(1);
    writeFileSync(join(root, 'src', 'new.ts'), 'x');
    await sleep(500);
    expect(calls.n).toBe(2);
    expect(events(root).filter((e) => e.action === 'save').map((e) => e.target)).toEqual(['src/a.ts · 사람 저장', 'src/new.ts · 사람 저장']);
  });

  it('[guard-serve:R3.1] an agent write line in the last 10 seconds means no save line and no check', async () => {
    const root = workspace();
    const calls = { n: 0 };
    start(root, calls);
    const d = new Date();
    appendFileSync(join(root, '.kiro', 'guard', 'events.jsonl'), JSON.stringify({ ts: `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`, action: 'write', target: 'src/a.ts' }) + '\n');
    writeFileSync(join(root, 'src', 'a.ts'), 'agent');
    await sleep(500);
    expect(calls.n).toBe(0);
    expect(events(root).filter((e) => e.action === 'save')).toEqual([]);
  });

  it('[guard-serve:R3.1] files outside the watch list are ignored', async () => {
    const root = workspace();
    const calls = { n: 0 };
    start(root, calls);
    writeFileSync(join(root, 'notes.md'), 'x');
    writeFileSync(join(root, '.kiro', 'guard', 'report.json'), '{}');
    await sleep(400);
    expect(calls.n).toBe(0);
  });

  it('[guard-serve:R3.2] saves during a running check run it once more, never two at once', async () => {
    const root = workspace();
    const calls: { n: number; release?: () => void } = { n: 0 };
    start(root, calls, true);
    writeFileSync(join(root, 'src', 'a.ts'), '1');
    await sleep(300);
    expect(calls.n).toBe(1);
    writeFileSync(join(root, 'src', 'a.ts'), '2');
    await sleep(200);
    writeFileSync(join(root, 'src', 'a.ts'), '3');
    await sleep(300);
    expect(calls.n).toBe(1); // still running: no second one
    calls.release!();
    await sleep(100);
    expect(calls.n).toBe(2);
    calls.release!();
    await sleep(300);
    expect(calls.n).toBe(2);
  });

  it('[guard-serve:R3.3] changes while adopt.lock exists or within 2 seconds after are ignored', async () => {
    const root = workspace();
    const calls = { n: 0 };
    writeFileSync(join(root, '.kiro', 'guard', 'adopt.lock'), '');
    start(root, calls);
    writeFileSync(join(root, 'src', 'a.ts'), 'mutant');
    await sleep(400);
    unlinkSync(join(root, '.kiro', 'guard', 'adopt.lock'));
    writeFileSync(join(root, 'src', 'a.ts'), 'a');
    await sleep(400);
    expect(calls.n).toBe(0);
    expect(events(root).filter((e) => e.action === 'save')).toEqual([]);
    await sleep(2000);
    writeFileSync(join(root, 'src', 'a.ts'), 'human');
    await sleep(400);
    expect(calls.n).toBe(1);
  });
});
