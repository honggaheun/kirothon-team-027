// Tests for recording resolutions and POST /api/resolve (guard-serve task 4).
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyApproval, canRecord, pickTargets, recordResolution, ResolveError } from '../src/resolve.js';
import type { Choice } from '../src/resolve.js';
import { startServe } from '../src/serve.js';
import type { ServeHandle } from '../src/serve.js';

const temps: string[] = [];
const handles: ServeHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const REPORT = {
  requirements: [
    { id: 'signup:R2.3', verdict: 'red', reason: 'test-failed' },
    { id: 'signup:R3.1', verdict: 'red', reason: 'seal-broken' },
    { id: 'signup:R4.1', verdict: 'yellow', reason: 'stale' },
    { id: 'signup:R5.1', verdict: 'yellow', reason: 'no-tests' },
    { id: 'other:R2.3', verdict: 'green' },
  ],
};

function workspace(report: unknown = REPORT, resolution?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  temps.push(root);
  const g = join(root, '.kiro', 'guard');
  mkdirSync(g, { recursive: true });
  if (report !== undefined) writeFileSync(join(g, 'report.json'), JSON.stringify(report));
  if (resolution !== undefined) writeFileSync(join(g, 'resolution.json'), JSON.stringify(resolution));
  return root;
}
const readRes = (root: string) => JSON.parse(readFileSync(join(root, '.kiro', 'guard', 'resolution.json'), 'utf8'));
const readEvents = (root: string) =>
  readFileSync(join(root, '.kiro', 'guard', 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l)
    .map((l) => JSON.parse(l) as { action: string; target: string });

describe('canRecord', () => {
  it('[guard-serve:R4.2] red: both; yellow stale: edit-spec only; no-tests and green: neither', () => {
    expect(canRecord({ verdict: 'red', reason: 'test-failed' }, 'revert-code')).toBe(true);
    expect(canRecord({ verdict: 'red', reason: 'seal-broken' }, 'edit-spec')).toBe(true);
    expect(canRecord({ verdict: 'yellow', reason: 'stale' }, 'edit-spec')).toBe(true);
    expect(canRecord({ verdict: 'yellow', reason: 'stale' }, 'revert-code')).toBe(false);
    for (const c of ['revert-code', 'edit-spec'] as Choice[]) {
      expect(canRecord({ verdict: 'yellow', reason: 'no-tests' }, c)).toBe(false);
      expect(canRecord({ verdict: 'green' }, c)).toBe(false);
    }
  });
});

describe('applyApproval', () => {
  const entry = fc.record({ requirement: fc.constantFrom('a:R1.1', 'a:R1.2', 'b:R1.1', 'b:R2.1'), choice: fc.constantFrom('revert-code', 'edit-spec'), by: fc.constant('human'), approvedAt: fc.constant('2026-11-14T10:00:00+09:00') });
  it('[guard-serve:R4.3] approving the same requirement many times leaves one entry; others and closed stay', () => {
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 8 }), fc.array(fc.constantFrom('a:R1.1', 'a:R1.2', 'b:R1.1'), { minLength: 1, maxLength: 5 }), fc.constantFrom('revert-code', 'edit-spec'), fc.array(fc.constantFrom(1, 2, 3), { maxLength: 3 }), (approved, targets, choice, closed) => {
        const before = { approved, closed, extra: 'x' };
        const once = applyApproval(before, targets, choice as Choice, 'T1');
        const twice = applyApproval(once, targets, choice as Choice, 'T2');
        for (const t of new Set(targets)) {
          if (twice.approved.filter((a) => (a as { requirement: string }).requirement === t).length !== 1) return false;
        }
        const others = approved.filter((a) => !targets.includes(a.requirement));
        const tail = twice.approved.filter((a) => !targets.includes((a as { requirement: string }).requirement));
        return JSON.stringify(tail) === JSON.stringify(others) && twice.closed === closed && twice.extra === 'x' && (twice.approved.at(-1) as { approvedAt: string }).approvedAt === 'T2';
      }),
    );
  });
  it('[guard-serve:R4.3] new entries have requirement, choice, by human, approvedAt', () => {
    const r = applyApproval({ approved: [] }, ['a:R1.1'], 'edit-spec', '2026-11-14T10:00:00+09:00');
    expect(r.approved).toEqual([{ requirement: 'a:R1.1', choice: 'edit-spec', by: 'human', approvedAt: '2026-11-14T10:00:00+09:00' }]);
  });
});

describe('recordResolution', () => {
  it('[guard-serve:R4.3] no targets means every red one; closed is kept; events human lines', () => {
    const root = workspace(REPORT, { approved: [{ requirement: 'signup:R2.3', choice: 'edit-spec', by: 'human', approvedAt: 'old' }], closed: [{ requirement: 'z', closedAt: 'x' }] });
    const { resolution, recorded } = recordResolution(root, undefined, 'revert-code', new Date(2026, 10, 14, 10, 0, 0));
    expect(recorded).toEqual(['signup:R2.3', 'signup:R3.1']);
    const disk = readRes(root);
    expect(disk).toEqual(resolution);
    expect(disk.approved.map((a: { requirement: string }) => a.requirement)).toEqual(['signup:R2.3', 'signup:R3.1']);
    expect(disk.approved[0].choice).toBe('revert-code');
    expect(disk.approved[0].approvedAt).toMatch(/^2026-11-14T10:00:00[+-]\d\d:\d\d$/);
    expect(disk.closed).toEqual([{ requirement: 'z', closedAt: 'x' }]);
    expect(readEvents(root).map((e) => [e.action, e.target])).toEqual([
      ['human', 'signup:R2.3 · 코드를 되돌린다 승인'],
      ['human', 'signup:R3.1 · 코드를 되돌린다 승인'],
    ]);
  });
  it('[guard-serve:R4.2] a stale one needs edit-spec; unrecordable ones change nothing', () => {
    const root = workspace();
    expect(() => recordResolution(root, ['signup:R4.1'], 'revert-code')).toThrow(ResolveError);
    for (const id of ['signup:R5.1', 'other:R2.3', 'nope:R1.1']) expect(() => recordResolution(root, [id], 'edit-spec')).toThrow(ResolveError);
    expect(() => recordResolution(root, ['signup:R2.3', 'signup:R5.1'], 'edit-spec')).toThrow(ResolveError);
    recordResolution(root, ['signup:R4.1'], 'edit-spec');
    expect(readRes(root).approved).toHaveLength(1);
    expect(readEvents(root)[0].target).toBe('signup:R4.1 · 스펙을 고친다 승인');
  });
  it('[guard-serve:R4.2] without red requirements and without targets it is an error', () => {
    const root = workspace({ requirements: [{ id: 'a:R1.1', verdict: 'green' }] });
    expect(() => recordResolution(root, undefined, 'edit-spec')).toThrow(ResolveError);
  });
});

describe('pickTargets', () => {
  const items = REPORT.requirements;
  it('[guard-serve:R5.1] full ids, unique short ids, all', () => {
    expect(pickTargets(items, 'signup:R2.3', 'revert-code')).toEqual(['signup:R2.3']);
    expect(pickTargets(items, 'R3.1', 'revert-code')).toEqual(['signup:R3.1']);
    expect(pickTargets(items, 'R4.1', 'edit-spec')).toEqual(['signup:R4.1']);
    expect(pickTargets(items, 'all', 'edit-spec')).toEqual(['signup:R2.3', 'signup:R3.1']);
    expect(() => pickTargets(items, 'R4.1', 'revert-code')).toThrow(ResolveError);
    expect(() => pickTargets(items, 'R5.1', 'edit-spec')).toThrow(ResolveError);
    expect(() => pickTargets(items, 'all', 'edit-spec')).not.toThrow();
    expect(() => pickTargets([{ id: 'a:R1.1', verdict: 'green' }], 'all', 'edit-spec')).toThrow(ResolveError);
  });
  it('[guard-serve:R5.1] an ambiguous short id is an error', () => {
    const amb = [{ id: 'a:R2.3', verdict: 'red' }, { id: 'b:R2.3', verdict: 'red' }];
    expect(() => pickTargets(amb, 'R2.3', 'revert-code')).toThrow(/ambiguous/);
    expect(pickTargets(amb, 'a:R2.3', 'revert-code')).toEqual(['a:R2.3']);
  });
});

describe('POST /api/resolve', () => {
  async function boot(report: unknown = REPORT): Promise<{ h: ServeHandle; root: string }> {
    const root = workspace(report);
    const h = await startServe({ root, port: 0, uiDir: root, humanWatch: false });
    handles.push(h);
    return { h, root };
  }
  function post(port: number, body: string | Buffer, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; body: string }> {
    return new Promise((ok, fail) => {
      const r = request({ host: '127.0.0.1', port, path: '/api/resolve', method, headers: { 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: out }));
      });
      r.on('error', fail);
      r.end(body);
    });
  }
  const origin = (port: number) => ({ Origin: `http://127.0.0.1:${port}` });

  it('[guard-serve:R4.1] no Origin or a foreign Origin is 403 and nothing is written', async () => {
    const { h, root } = await boot();
    expect((await post(h.port, '{"choice":"edit-spec"}')).status).toBe(403);
    expect((await post(h.port, '{"choice":"edit-spec"}', { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(h.port, '{"choice":"edit-spec"}', { Origin: `http://127.0.0.1:${h.port + 1}` })).status).toBe(403);
    expect(() => readRes(root)).toThrow();
  });
  it('[guard-serve:R4.2] bad bodies are 400, unrecordable ones 409', async () => {
    const { h } = await boot();
    const o = origin(h.port);
    for (const b of ['', 'nope', '[]', '{}', '{"choice":"x"}', '{"choice":"edit-spec","requirement":5}', '{"choice":"edit-spec","requirement":""}']) {
      expect((await post(h.port, b, o)).status, b).toBe(400);
    }
    expect((await post(h.port, JSON.stringify({ choice: 'edit-spec', pad: 'x'.repeat(5000) }), o)).status).toBe(400);
    expect((await post(h.port, '{"choice":"revert-code","requirement":"signup:R4.1"}', o)).status).toBe(409);
    expect((await post(h.port, '{"choice":"edit-spec","requirement":"signup:R5.1"}', o)).status).toBe(409);
    expect((await post(h.port, '{"choice":"edit-spec","requirement":"nope:R1.1"}', o)).status).toBe(409);
  });
  it('[guard-serve:R4.2] no requirement and no red is 409', async () => {
    const { h } = await boot({ requirements: [{ id: 'a:R1.1', verdict: 'green' }] });
    expect((await post(h.port, '{"choice":"edit-spec"}', origin(h.port))).status).toBe(409);
  });
  it('[guard-serve:R4.3] records every red when requirement is omitted and returns the resolution', async () => {
    const { h, root } = await boot();
    const r = await post(h.port, '{"choice":"edit-spec"}', { Origin: `http://localhost:${h.port}` });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toEqual(readRes(root));
    expect(body.approved.map((a: { requirement: string; by: string }) => [a.requirement, a.by])).toEqual([['signup:R2.3', 'human'], ['signup:R3.1', 'human']]);
    const one = await post(h.port, '{"choice":"edit-spec","requirement":"signup:R4.1"}', origin(h.port));
    expect(one.status).toBe(200);
    expect(JSON.parse(one.body).approved).toHaveLength(3);
  });
  it('[guard-serve:R4.4] GET on the resolve path is 405', async () => {
    const { h } = await boot();
    expect((await post(h.port, '', origin(h.port), 'GET')).status).toBe(405);
  });
});
