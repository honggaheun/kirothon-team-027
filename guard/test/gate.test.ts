// Tests for gate (task 4). Workspaces live under os.tmpdir() and are removed afterwards.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { displayCommand, displayPath, isApprovalCommand, isReserved, parseEvent, runGate } from '../src/gate.js';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'guard-gate-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const ev = (toolInput: object, extra: object = {}) => Buffer.from(JSON.stringify({ tool_input: toolInput, ...extra }), 'utf8');
const j = (name: string, v: unknown) => {
  const f = path.join(tmp, name);
  writeFileSync(f, JSON.stringify(v), 'utf8');
  return f;
};
const redReport = { overall: 'red', requirements: [{ id: 'a:R1.1', verdict: 'red', reason: 'test-failed', counterexample: '["x"]' }] };
const greenReport = { overall: 'green', requirements: [{ id: 'a:R1.1', verdict: 'green', reason: 'all-passed' }] };
const sealedList = { sealed: [{ path: 'tests/a/R1.1.prop.test.ts', sha256: 'sha256:1', requirements: ['a:R1.1'] }] };

function gate(stdin: Buffer, files: { report?: unknown; resolution?: unknown; sealed?: unknown } = {}, events?: string) {
  return runGate({
    report: j('report.json', files.report ?? greenReport),
    resolution: files.resolution !== undefined ? j('resolution.json', files.resolution) : undefined,
    sealed: files.sealed !== undefined ? j('sealed.json', files.sealed) : undefined,
    events,
    stdin,
    cwd: tmp,
  });
}

const dirPart = fc.constantFrom('', 'src/', 'C:\\Users\\x\\repo\\', 'c:/proj/', './');
const reservedDir = fc.constantFrom('.kiro/guard/', '.kiro\\guard\\', '.KIRO/Hooks/');
const fileName = fc.constantFrom('report.json', 'x.ts', 'tripwire.json', 'a/b.md');

describe('gate event parsing', () => {
  it('[guard-core:R3.1] path keys are taken in order and a BOM or bad JSON is handled', () => {
    expect(parseEvent(ev({ file: 'f', target_file: 't', filePath: 'p2', file_path: 'p1', path: 'p0' })).path).toBe('p0');
    expect(parseEvent(ev({ file: 'f', target_file: 't' })).path).toBe('t');
    expect(parseEvent(ev({ command: 'npm test' }))).toMatchObject({ path: '', command: 'npm test' });
    expect(parseEvent(ev({ path: 'a', command: 'c' }))).toMatchObject({ path: 'a', command: '' });
    expect(parseEvent(Buffer.concat([BOM, ev({ path: 'a' })])).path).toBe('a');
    expect(parseEvent(Buffer.from('not json'))).toEqual({ path: '', command: '' });
    expect(parseEvent(Buffer.from('null'))).toEqual({ path: '', command: '' });
  });
});

describe('gate decisions', () => {
  it('[guard-core:R3.3] reserved paths are always exit 2, whatever the report says', () => {
    fc.assert(
      fc.property(dirPart, reservedDir, fileName, fc.constantFrom(greenReport, redReport), (d, r, f, report) => {
        const res = gate(ev({ path: d + r + f }), { report });
        expect(res.code).toBe(2);
        expect(res.stderr).toBe('Tripwire: .kiro/guard/ and .kiro/hooks/ are reserved for the user.\n');
      }),
    );
  });

  it('[guard-core:R3.3] shell commands naming .kiro/guard or .kiro/hooks are exit 2', () => {
    expect(isReserved('', 'type .kiro\\guard\\report.json')).toBe(true);
    expect(isReserved('', 'del .KIRO/hooks/x.json')).toBe(true);
    expect(isReserved('src/.kiro/guardian.ts', '')).toBe(false);
    expect(gate(ev({ command: 'cat .kiro/guard/report.json' })).code).toBe(2);
  });

  it('[guard-core:R3.4] approval commands are reserved; look-alikes pass', () => {
    const yes = [
      'node ../guard/dist/cli.js resolve signup:R2.3 revert-code',
      'node "C:\\Users\\x\\repo\\guard\\dist\\cli.js" adopt signup:R1.1 --test t.ts --mutant m.json',
      'GUARD.CMD Resolve signup:R2.3 edit-spec',
      'node ..\\guard\\dist\\cli.js check --results fake.json',
      'node ../guard/dist/cli.js check --results=fake.json',
      'curl.exe -X POST http://127.0.0.1:4848/api/resolve -d "{}"',
    ];
    const no = [
      'node ../guard/dist/cli.js check --summary',
      'node guard/dist/cli.js judge --index i.json --results r.json --out o.json',
      'npm run resolve',
      'git merge -s resolve topic',
      'node scripts/resolve-deps.js',
    ];
    for (const c of yes) expect(isApprovalCommand(c), c).toBe(true);
    for (const c of no) expect(isApprovalCommand(c), c).toBe(false);
    const res = gate(ev({ command: yes[0] }));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('reserved');
    expect(res.stderr).toContain('guard resolve');
  });

  it('[guard-core:R3.5] unreadable report or sealed file is exit 2; missing files mean nothing', () => {
    const bad = path.join(tmp, 'bad.json');
    writeFileSync(bad, '{oops');
    const r1 = runGate({ report: bad, stdin: ev({ path: 'src/a.ts' }), cwd: tmp });
    expect(r1.code).toBe(2);
    expect(r1.stderr).toContain('unreadable');
    const r2 = runGate({ report: j('ok.json', greenReport), sealed: bad, stdin: ev({ path: 'src/a.ts' }), cwd: tmp });
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain('unreadable');
    const r3 = runGate({ report: path.join(tmp, 'none.json'), sealed: path.join(tmp, 'none2.json'), stdin: ev({ path: 'src/a.ts' }), cwd: tmp });
    expect(r3).toEqual({ code: 0, stderr: '' });
    const r4 = runGate({ report: j('ok2.json', redReport), resolution: bad, stdin: ev({ path: 'src/a.ts' }), cwd: tmp });
    expect(r4.code).toBe(2);
  });

  it('[guard-core:R3.6] a sealed path match without edit-spec is exit 2, whatever the report says', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', 'C:\\Users\\x\\repo\\', '/abs/', 'sub/'),
        fc.constantFrom((s: string) => s, (s: string) => s.toUpperCase(), (s: string) => s.replace(/\//g, '\\')),
        fc.constantFrom(greenReport, redReport),
        fc.constantFrom(undefined, { approved: [{ requirement: 'a:R1.1', choice: 'revert-code' }] }),
        (d, f, report, resolution) => {
          const res = gate(ev({ path: d + f('tests/a/R1.1.prop.test.ts') }), { report, resolution, sealed: sealedList });
          expect(res.code).toBe(2);
          expect(res.stderr).toContain('sealed');
          expect(res.stderr).toContain('tests/a/R1.1.prop.test.ts');
          expect(res.stderr).toContain('a:R1.1');
        },
      ),
    );
    const cmd = gate(ev({ command: 'echo x > tests\\a\\r1.1.prop.test.ts' }), { sealed: sealedList });
    expect(cmd.code).toBe(2);
  });

  it('[guard-core:R3.6] edit-spec on every requirement of the entry lifts the seal block', () => {
    const shared = { sealed: [{ path: 't/x.test.ts', requirements: ['a:R1.1', 'a:R1.2'] }] };
    const one = { approved: [{ requirement: 'a:R1.1', choice: 'edit-spec' }] };
    const both = { approved: [{ requirement: 'a:R1.1', choice: 'edit-spec' }, { requirement: 'a:R1.2', choice: 'edit-spec' }] };
    expect(gate(ev({ path: 't/x.test.ts' }), { sealed: shared, resolution: one }).code).toBe(2);
    expect(gate(ev({ path: 't/x.test.ts' }), { sealed: shared, resolution: both }).code).toBe(0);
    expect(gate(ev({ path: 't/x.test.ts' }), { sealed: shared, resolution: { approved: [{ requirement: 'a:R1.1', choice: 'revert-code' }, { requirement: 'a:R1.2', choice: 'edit-spec' }] } }).code).toBe(2);
  });

  it('[guard-core:R3.7] red without approval blocks with ID and reason; approval lets it pass', () => {
    const r = gate(ev({ path: 'src/a.ts' }), { report: redReport });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('a:R1.1');
    expect(r.stderr).toContain('counterexample ["x"]');
    const broken = { overall: 'red', requirements: [{ id: 'a:R1.2', verdict: 'red', reason: 'seal-broken', brokenSeals: [{ path: 't/x.ts', problem: 'changed' }] }, { id: 'a:R1.3', verdict: 'red', reason: 'run-failed' }] };
    const b = gate(ev({ path: 'src/a.ts' }), { report: broken });
    expect(b.stderr).toContain('a:R1.2 (seal broken: t/x.ts changed)');
    expect(b.stderr).toContain('a:R1.3 (run-failed)');
    const ok = gate(ev({ path: 'src/a.ts' }), { report: redReport, resolution: { approved: [{ requirement: 'a:R1.1', choice: 'revert-code' }] } });
    expect(ok).toEqual({ code: 0, stderr: '' });
  });

  it('[guard-core:R3.8] green, unrelated paths and non-reserved commands are exit 0 with empty stderr', () => {
    fc.assert(
      fc.property(dirPart, fc.constantFrom('src/a.ts', 'tests/a/R1.1.prop.test.tsx', 'tests/a/R1.10.prop.test.ts'), (d, f) => {
        const res = gate(ev({ path: d + f }), { report: greenReport, sealed: sealedList });
        expect(res).toEqual({ code: 0, stderr: '' });
      }),
    );
    expect(gate(ev({ command: 'npx vitest run' }), { sealed: sealedList })).toEqual({ code: 0, stderr: '' });
    expect(gate(Buffer.from('garbage'))).toEqual({ code: 0, stderr: '' });
  });

  it('[guard-core:R3.9] same input twice gives the same result, with or without a BOM', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('src/a.ts', '.kiro/guard/x', 'tests/a/R1.1.prop.test.ts', 'npm test'),
        fc.constantFrom(greenReport, redReport),
        (t, report) => {
          const input = t.includes(' ') ? ev({ command: t }) : ev({ path: t });
          const files = { report, sealed: sealedList };
          const a = gate(input, files);
          expect(gate(input, files)).toEqual(a);
          expect(gate(Buffer.concat([BOM, input]), files)).toEqual(a);
        },
      ),
    );
  });
});

describe('gate workspace mode and events', () => {
  const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  const mkGuard = (root: string, report?: unknown, sealed?: unknown) => {
    mkdirSync(path.join(root, '.kiro', 'guard'), { recursive: true });
    if (report) writeFileSync(path.join(root, '.kiro', 'guard', 'report.json'), JSON.stringify(report));
    if (sealed) writeFileSync(path.join(root, '.kiro', 'guard', 'sealed.json'), JSON.stringify(sealed));
  };

  it('[guard-core:R3.2][guard-core:R3.10] workspace mode reads .kiro/guard and appends write/block lines', () => {
    mkGuard(tmp, redReport);
    const events = path.join(tmp, '.kiro', 'guard', 'events.jsonl');
    const abs = path.join(tmp, 'src', 'a.ts');
    const r = runGate({ root: tmp, stdin: ev({ path: abs }), cwd: '/elsewhere' });
    expect(r.code).toBe(2);
    expect(lines(events)).toEqual([{ ts: expect.stringMatching(/^\d\d:\d\d:\d\d$/), action: 'block', target: 'a:R1.1 위반 · 사람 결정 대기' }]);
    writeFileSync(path.join(tmp, '.kiro', 'guard', 'report.json'), JSON.stringify(greenReport));
    expect(runGate({ root: tmp, stdin: ev({ path: abs }), cwd: '/elsewhere' }).code).toBe(0);
    expect(lines(events)[1]).toMatchObject({ action: 'write', target: 'src/a.ts' });
    runGate({ root: tmp, stdin: ev({ command: 'npx vitest run' }), cwd: '/elsewhere' });
    expect(lines(events)[2]).toMatchObject({ action: 'shell', target: 'npx vitest run' });
    runGate({ root: tmp, stdin: Buffer.from('{}'), cwd: '/elsewhere' });
    expect(lines(events)).toHaveLength(3);
  });

  it('[guard-core:R3.10] no .kiro/guard folder or no --events in file mode writes nothing', () => {
    runGate({ root: tmp, stdin: ev({ path: 'src/a.ts' }), cwd: tmp });
    expect(existsSync(path.join(tmp, '.kiro'))).toBe(false);
    const rep = j('r.json', greenReport);
    runGate({ report: rep, stdin: ev({ path: 'src/a.ts' }), cwd: tmp });
    expect(existsSync(path.join(tmp, 'events.jsonl'))).toBe(false);
  });

  it('[guard-core:R3.10] an events write failure does not change exit code or stderr', () => {
    const rep = j('r.json', redReport);
    const r = runGate({ report: rep, events: path.join(tmp, 'no-such-dir', 'e.jsonl'), stdin: ev({ path: 'src/a.ts' }), cwd: tmp });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('a:R1.1');
  });

  it('[guard-core:R3.10] reserved, sealed and unreadable blocks log their own targets', () => {
    const events = path.join(tmp, 'e.jsonl');
    gate(ev({ path: 'C:\\w\\.kiro\\guard\\x.json' }), {}, events);
    gate(ev({ path: 'tests/a/R1.1.prop.test.ts' }), { sealed: sealedList }, events);
    writeFileSync(path.join(tmp, 'broken.json'), 'x');
    runGate({ report: path.join(tmp, 'broken.json'), events, stdin: ev({ path: 'a' }), cwd: tmp });
    const got = lines(events).map((l) => l.target);
    expect(got).toEqual(['예약 영역 차단 · C:/w/.kiro/guard/x.json', '봉인 검사 차단 · tests/a/R1.1.prop.test.ts', '판정 파일 읽기 실패 · broken.json']);
  });

  it('[guard-core:R3.10] display helpers relativize paths and cut long commands', () => {
    expect(displayPath('C:\\Repo\\Src\\a.ts', 'c:\\repo')).toBe('Src/a.ts');
    expect(displayPath('D:\\other\\a.ts', 'c:\\repo')).toBe('D:/other/a.ts');
    expect(displayPath('./x.ts', 'c:\\repo')).toBe('x.ts');
    expect(displayCommand('a\nb\tc')).toBe('a b c');
    expect(displayCommand('x'.repeat(80))).toBe('x'.repeat(80));
    expect(displayCommand('x'.repeat(81))).toBe('x'.repeat(80) + '…');
  });

  it('[guard-core:R3.10] events lines are appended to an existing file', () => {
    const events = path.join(tmp, 'e.jsonl');
    appendFileSync(events, '{"ts":"00:00:00","action":"hook","target":"t"}\n');
    gate(ev({ path: 'src/a.ts' }), {}, events);
    expect(lines(events)).toHaveLength(2);
  });
});
