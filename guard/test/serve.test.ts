// Tests for the HTTP server skeleton and static serving (guard-serve task 1).
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentType, isAllowedDataName, isAllowedOrigin, isLoopback, resolveStaticPath, sseFrame, startServe } from '../src/serve.js';
import type { ServeHandle } from '../src/serve.js';

const temps: string[] = [];
const handles: ServeHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function workspace(): { root: string; ui: string } {
  const root = mkdtempSync(join(tmpdir(), 'serve-'));
  temps.push(root);
  const ui = join(root, 'ui');
  mkdirSync(ui, { recursive: true });
  mkdirSync(join(root, '.kiro', 'guard', 'runs'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(ui, 'app.js'), 'x');
  writeFileSync(join(root, 'secret.txt'), 'secret');
  writeFileSync(join(root, '.kiro', 'guard', 'report.json'), '{"overall":"green"}');
  writeFileSync(join(root, '.kiro', 'guard', 'check.lock'), '');
  writeFileSync(join(root, '.kiro', 'guard', 'runs', 'signup__R2.3.json'), '{}');
  return { root, ui };
}

async function boot(): Promise<{ h: ServeHandle; root: string }> {
  const { root, ui } = workspace();
  const h = await startServe({ root, port: 0, uiDir: ui, humanWatch: false });
  handles.push(h);
  return { h, root };
}

function get(port: number, path: string, method = 'GET'): Promise<{ status: number; type: string; cache: string; body: string }> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), cache: String(res.headers['cache-control'] ?? ''), body }));
    });
    r.on('error', fail);
    r.end();
  });
}

describe('static paths', () => {
  const ui = resolve(tmpdir(), 'ui-fixture');
  const seg = fc.constantFrom('..', '%2e%2e', '%2E%2E', '.', 'a', 'b.js', '%5c', '\\', '%2f', '..\\', '%2e%2e%5c', '...', 'x%00');
  it('[guard-serve:R1.2] any path that resolves outside the ui folder is null', () => {
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 8 }), (parts) => {
        const r = resolveStaticPath(ui, '/' + parts.join('/'));
        if (r === null) return true;
        return r.startsWith(resolve(ui) + sep);
      }),
      { numRuns: 500 },
    );
  });
  it('[guard-serve:R1.2] explicit escapes are null', () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/a/../../x', '/..\\x', '/%2e%2e%5cx', '/a%00b', '/c:/x']) {
      expect(resolveStaticPath(ui, p)).toBeNull();
    }
  });
  it('[guard-serve:R1.2] / maps to index.html', () => {
    expect(resolveStaticPath(ui, '/')).toBe(join(resolve(ui), 'index.html'));
    expect(resolveStaticPath(ui, '/app.js?v=1')).toBe(join(resolve(ui), 'app.js'));
  });
  it('[guard-serve:R1.2] content types by extension', () => {
    expect(contentType('a.html')).toContain('text/html');
    expect(contentType('a.js')).toContain('javascript');
    expect(contentType('a.css')).toContain('text/css');
    expect(contentType('a.json')).toContain('application/json');
    expect(contentType('a.svg')).toBe('image/svg+xml');
    expect(contentType('a.png')).toBe('image/png');
    expect(contentType('a.woff2')).toBe('font/woff2');
  });
});

describe('helpers', () => {
  it('[guard-serve:R1.3] data names allow list', () => {
    for (const n of ['index.json', 'report.json', 'resolution.json', 'sealed.json', 'events.jsonl', 'runs/signup__R2.3.json', 'runs/guard-core__R10.12.json']) {
      expect(isAllowedDataName(n)).toBe(true);
    }
    for (const n of ['config.json', 'adopt.lock', 'check.lock', '../report.json', 'runs/', 'runs/x.json', 'runs/a/b__R1.1.json', 'runs/a__R1.1.json.bak', 'runs/..\\x__R1.1.json', '']) {
      expect(isAllowedDataName(n)).toBe(false);
    }
  });
  it('[guard-serve:R4.1] loopback and origin', () => {
    expect(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:4848', 4848)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4848', 4848)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4849', 4848)).toBe(false);
    expect(isAllowedOrigin('http://evil.com:4848', 4848)).toBe(false);
    expect(isAllowedOrigin(undefined, 4848)).toBe(false);
  });
  it('[guard-serve:R2.1] sse frame is one data line', () => {
    expect(sseFrame('events', [{ a: 'x\ny' }])).toBe('event: events\ndata: [{"a":"x\\ny"}]\n\n');
  });
});

describe('server', () => {
  it('[guard-serve:R1.2] serves ui files and 404s outside', async () => {
    const { h } = await boot();
    const idx = await get(h.port, '/');
    expect(idx.status).toBe(200);
    expect(idx.type).toContain('text/html');
    expect(idx.body).toBe('<h1>hi</h1>');
    expect((await get(h.port, '/app.js')).type).toContain('javascript');
    expect((await get(h.port, '/nope.js')).status).toBe(404);
    expect((await get(h.port, '/..%2fsecret.txt')).status).toBe(404);
    expect((await get(h.port, '/%2e%2e/secret.txt')).status).toBe(404);
  });
  it('[guard-serve:R1.3] data allow list with no-store', async () => {
    const { h } = await boot();
    const ok = await get(h.port, '/data/report.json');
    expect(ok.status).toBe(200);
    expect(ok.cache).toBe('no-store');
    expect(ok.body).toBe('{"overall":"green"}');
    expect((await get(h.port, '/data/runs/signup__R2.3.json')).status).toBe(200);
    expect((await get(h.port, '/data/check.lock')).status).toBe(404);
    expect((await get(h.port, '/data/index.json')).status).toBe(404);
    expect((await get(h.port, '/data/..%2freport.json')).status).toBe(404);
  });
  it('[guard-serve:R4.4] wrong method is 405 and unknown path 404', async () => {
    const { h } = await boot();
    expect((await get(h.port, '/', 'DELETE')).status).toBe(405);
    expect((await get(h.port, '/missing')).status).toBe(404);
  });
  it('[guard-serve:R1.1] a busy port rejects', async () => {
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, '127.0.0.1', ok));
    const port = (blocker.address() as { port: number }).port;
    const { ui, root } = workspace();
    await expect(startServe({ root, port, uiDir: ui, humanWatch: false })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise((ok) => blocker.close(ok));
  });
});
