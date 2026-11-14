// Tests for `guard resolve` and `guard serve` command lines (guard-serve task 5).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCommand } from '../src/resolve.js';
import { startServe } from '../src/serve.js';

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const REPORT = {
  requirements: [
    { id: 'signup:R2.3', verdict: 'red', reason: 'test-failed' },
    { id: 'signup:R4.1', verdict: 'yellow', reason: 'stale' },
    { id: 'signup:R5.1', verdict: 'yellow', reason: 'no-tests' },
    { id: 'other:R2.3', verdict: 'red', reason: 'test-failed' },
  ],
};

function workspace(report: unknown = REPORT): string {
  const root = mkdtempSync(join(tmpdir(), 'rcli-'));
  temps.push(root);
  mkdirSync(join(root, '.kiro', 'guard'), { recursive: true });
  writeFileSync(join(root, '.kiro', 'guard', 'report.json'), JSON.stringify(report));
  return root;
}
const approved = (root: string): { requirement: string; choice: string }[] => JSON.parse(readFileSync(join(root, '.kiro', 'guard', 'resolution.json'), 'utf8')).approved;

describe('resolveCommand', () => {
  it('[guard-serve:R5.1] full id and exact short id record and print the ids', () => {
    const root = workspace();
    const r = resolveCommand({ positionals: ['signup:R2.3', 'revert-code'], root, cwd: process.cwd() });
    expect(r).toEqual({ code: 0, stdout: 'signup:R2.3\n', stderr: '' });
    const s = resolveCommand({ positionals: ['R4.1', 'edit-spec'], root, cwd: process.cwd() });
    expect(s.code).toBe(0);
    expect(s.stdout).toBe('signup:R4.1\n');
    expect(approved(root).map((a) => `${a.requirement}/${a.choice}`)).toEqual(['signup:R2.3/revert-code', 'signup:R4.1/edit-spec']);
  });
  it('[guard-serve:R5.1] all records every red, one id per line', () => {
    const root = workspace();
    const r = resolveCommand({ positionals: ['all', 'edit-spec'], root, cwd: process.cwd() });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('signup:R2.3\nother:R2.3\n');
  });
  it('[guard-serve:R5.1] unrecordable, ambiguous and all-without-red are exit 1 and write nothing', () => {
    const root = workspace();
    for (const args of [['signup:R4.1', 'revert-code'], ['signup:R5.1', 'edit-spec'], ['R2.3', 'revert-code'], ['nope:R1.1', 'edit-spec']]) {
      const r = resolveCommand({ positionals: args, root, cwd: process.cwd() });
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stdout).toBe('');
    }
    expect(existsSync(join(root, '.kiro', 'guard', 'resolution.json'))).toBe(false);
    const none = workspace({ requirements: [{ id: 'a:R1.1', verdict: 'green' }] });
    expect(resolveCommand({ positionals: ['all', 'edit-spec'], root: none, cwd: process.cwd() }).code).toBe(1);
  });
  it('[guard-serve:R5.1] wrong argument count or choice is a usage error', () => {
    const root = workspace();
    for (const args of [[], ['all'], ['all', 'nope'], ['a', 'edit-spec', 'extra']]) {
      expect(() => resolveCommand({ positionals: args, root, cwd: process.cwd() })).toThrow();
    }
  });
});

describe('built CLI', () => {
  const cli = resolve(__dirname, '..', 'dist', 'cli.js');
  const run = (args: string[], cwd: string) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 20000 });

  it('[guard-serve:R5.1] exit codes 0, 1 and 64', () => {
    const root = workspace();
    expect(run(['resolve', 'signup:R2.3', 'revert-code', '--root', root], tmpdir()).status).toBe(0);
    expect(run(['resolve', 'signup:R4.1', 'revert-code', '--root', root], tmpdir()).status).toBe(1);
    expect(run(['resolve', 'signup:R2.3'], root).status).toBe(64);
    expect(run(['resolve', 'signup:R2.3', 'bogus'], root).status).toBe(64);
  });

  it('[guard-serve:R1.1] a port that is in use exits 1 with a reason on stderr', async () => {
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, '127.0.0.1', ok));
    const port = (blocker.address() as { port: number }).port;
    const root = workspace();
    const r = await new Promise<{ status: number | null; stderr: string; stdout: string }>((ok) => {
      const res = spawnSync(process.execPath, [cli, 'serve', '--root', root, '--port', String(port)], { encoding: 'utf8', timeout: 20000 });
      ok({ status: res.status, stderr: res.stderr, stdout: res.stdout });
    });
    await new Promise((ok) => blocker.close(ok));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/EADDRINUSE|in use/);
    expect(r.stdout).toBe('');
  });

  it('[guard-serve:R1.1] stdout gets http://127.0.0.1:<port>/ and only that port is bound', async () => {
    const root = workspace();
    const child = spawn(process.execPath, [cli, 'serve', '--root', root, '--port', '0', '--ui', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const out = await new Promise<string>((ok, fail) => {
        let s = '';
        const timer = setTimeout(() => fail(new Error('no output')), 10000);
        child.stdout.on('data', (c: Buffer) => {
          s += c.toString('utf8');
          if (s.includes('\n')) {
            clearTimeout(timer);
            ok(s);
          }
        });
        child.on('error', fail);
      });
      expect(out).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\r?\n$/);
    } finally {
      child.kill();
    }
  });
});

describe('same recording function', () => {
  it('[guard-serve:R5.2] the CLI and the button leave entries of the same form', async () => {
    const viaCli = workspace();
    expect(resolveCommand({ positionals: ['signup:R2.3', 'edit-spec'], root: viaCli, cwd: process.cwd() }).code).toBe(0);
    const viaHttp = workspace();
    const h = await startServe({ root: viaHttp, port: 0, uiDir: viaHttp, humanWatch: false });
    try {
      const body = '{"choice":"edit-spec","requirement":"signup:R2.3"}';
      const status = await new Promise<number>((ok, fail) => {
        const r = request({ host: '127.0.0.1', port: h.port, path: '/api/resolve', method: 'POST', headers: { Origin: `http://127.0.0.1:${h.port}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          res.resume();
          res.on('end', () => ok(res.statusCode ?? 0));
        });
        r.on('error', fail);
        r.end(body);
      });
      expect(status).toBe(200);
    } finally {
      await h.close();
    }
    const strip = (root: string) => approved(root).map((a) => ({ ...a, approvedAt: String((a as { approvedAt?: unknown }).approvedAt).replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/, 'ISO-LOCAL') }));
    expect(strip(viaCli)).toEqual([{ requirement: 'signup:R2.3', choice: 'edit-spec', by: 'human', approvedAt: 'ISO-LOCAL' }]);
    expect(strip(viaHttp)).toEqual(strip(viaCli));
  });
});
