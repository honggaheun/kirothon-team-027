// Tests for SSE and .kiro/guard/ watching (guard-serve task 2).
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServe } from '../src/serve.js';
import type { ServeHandle } from '../src/serve.js';
import { parseLines } from '../src/stream.js';

interface Msg {
  event: string;
  data: unknown;
}
const temps: string[] = [];
const handles: ServeHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function line(n: number): string {
  return JSON.stringify({ ts: '10:00:00', action: 'write', target: `f${n}` }) + '\n';
}

async function boot(pingMs?: number): Promise<{ h: ServeHandle; g: string }> {
  const root = mkdtempSync(join(tmpdir(), 'stream-'));
  temps.push(root);
  const g = join(root, '.kiro', 'guard');
  mkdirSync(join(g, 'runs'), { recursive: true });
  writeFileSync(join(g, 'report.json'), '{"overall":"green"}');
  writeFileSync(join(g, 'index.json'), '{"specs":[]}');
  writeFileSync(join(g, 'runs', 'signup__R2.3.json'), '{"a":1}');
  const h = await startServe({ root, port: 0, uiDir: root, pingMs, humanWatch: false });
  handles.push(h);
  return { h, g };
}

/** Open the stream; collects messages and raw text. */
function open(port: number): { msgs: Msg[]; raw: () => string; close: () => void } {
  const msgs: Msg[] = [];
  let raw = '';
  let buf = '';
  const req = request({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      raw += c;
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block);
        const data = /^data: (.*)$/m.exec(block);
        if (ev && data) msgs.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
    });
  });
  req.on('error', () => undefined);
  req.end();
  return { msgs, raw: () => raw, close: () => req.destroy() };
}

async function until(f: () => boolean, ms = 1500): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (f()) return true;
    await sleep(25);
  }
  return f();
}

describe('stream', () => {
  it('[guard-serve:R2.1] connect sends current files, runs and events-reset (empty without events)', async () => {
    const { h } = await boot();
    const s = open(h.port);
    expect(await until(() => s.msgs.some((m) => m.event === 'events-reset'))).toBe(true);
    const names = s.msgs.map((m) => m.event);
    expect(names).toEqual(['index', 'report', 'runs', 'events-reset']);
    expect(s.msgs[2].data).toEqual({ name: 'signup__R2.3.json', data: { a: 1 } });
    expect(s.msgs[3].data).toEqual([]);
    s.close();
  });

  it('[guard-serve:R2.1] connect sends the last 50 event lines as events-reset', async () => {
    const { h, g } = await boot();
    for (let i = 0; i < 60; i++) appendFileSync(join(g, 'events.jsonl'), line(i));
    const s = open(h.port);
    expect(await until(() => s.msgs.some((m) => m.event === 'events-reset'))).toBe(true);
    const data = s.msgs.find((m) => m.event === 'events-reset')!.data as { target: string }[];
    expect(data).toHaveLength(50);
    expect(data[0].target).toBe('f10');
    expect(data[49].target).toBe('f59');
    s.close();
  });

  it('[guard-serve:R2.2] a changed report is pushed within 1 second; unreadable JSON is skipped then retried', async () => {
    const { h, g } = await boot();
    const s = open(h.port);
    await until(() => s.msgs.some((m) => m.event === 'events-reset'));
    const before = s.msgs.length;
    writeFileSync(join(g, 'report.json'), '{"overall":"red"}');
    const t = Date.now();
    expect(await until(() => s.msgs.length > before, 1000)).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(s.msgs[s.msgs.length - 1]).toEqual({ event: 'report', data: { overall: 'red' } });
    const n = s.msgs.length;
    writeFileSync(join(g, 'report.json'), '{"overall":'); // half written
    await sleep(800);
    expect(s.msgs.length).toBe(n); // [guard-serve:R2.6]
    writeFileSync(join(g, 'report.json'), '{"overall":"yellow"}');
    expect(await until(() => s.msgs.length > n, 1000)).toBe(true);
    expect(s.msgs[s.msgs.length - 1].data).toEqual({ overall: 'yellow' });
    s.close();
  });

  it('[guard-serve:R2.3] appended complete lines arrive as events; a partial line waits', async () => {
    const { h, g } = await boot();
    appendFileSync(join(g, 'events.jsonl'), line(1));
    await sleep(100);
    const s = open(h.port);
    await until(() => s.msgs.some((m) => m.event === 'events-reset'));
    appendFileSync(join(g, 'events.jsonl'), line(2) + line(3).slice(0, 10));
    expect(await until(() => s.msgs.some((m) => m.event === 'events'), 1000)).toBe(true);
    const ev = s.msgs.filter((m) => m.event === 'events');
    expect(ev).toHaveLength(1);
    expect((ev[0].data as { target: string }[]).map((x) => x.target)).toEqual(['f2']);
    appendFileSync(join(g, 'events.jsonl'), line(3).slice(10));
    expect(await until(() => s.msgs.filter((m) => m.event === 'events').length === 2, 1000)).toBe(true);
    expect((s.msgs.filter((m) => m.event === 'events')[1].data as { target: string }[]).map((x) => x.target)).toEqual(['f3']);
    s.close();
  });

  it('[guard-serve:R2.3] moving events.jsonl away gives events-reset [], and a new file sends events', async () => {
    const { h, g } = await boot();
    appendFileSync(join(g, 'events.jsonl'), line(1) + line(2));
    await sleep(100);
    const s = open(h.port);
    await until(() => s.msgs.some((m) => m.event === 'events-reset'));
    renameSync(join(g, 'events.jsonl'), join(g, 'events.old'));
    expect(await until(() => s.msgs.filter((m) => m.event === 'events-reset').length === 2, 1000)).toBe(true);
    expect(s.msgs.filter((m) => m.event === 'events-reset')[1].data).toEqual([]);
    appendFileSync(join(g, 'events.jsonl'), line(9));
    expect(await until(() => s.msgs.some((m) => m.event === 'events'), 1000)).toBe(true);
    expect((s.msgs.find((m) => m.event === 'events')!.data as { target: string }[])[0].target).toBe('f9');
    s.close();
  });

  it('[guard-serve:R2.3] a file shorter than the sent position resets to its last lines', async () => {
    const { h, g } = await boot();
    appendFileSync(join(g, 'events.jsonl'), line(1) + line(2) + line(3));
    await sleep(100);
    const s = open(h.port);
    await until(() => s.msgs.some((m) => m.event === 'events-reset'));
    writeFileSync(join(g, 'events.jsonl'), line(7));
    expect(await until(() => s.msgs.filter((m) => m.event === 'events-reset').length === 2, 1000)).toBe(true);
    expect((s.msgs.filter((m) => m.event === 'events-reset')[1].data as { target: string }[]).map((x) => x.target)).toEqual(['f7']);
    s.close();
  });

  it('[guard-serve:R2.4] runs files created, changed and removed are pushed', async () => {
    const { h, g } = await boot();
    const s = open(h.port);
    await until(() => s.msgs.some((m) => m.event === 'events-reset'));
    writeFileSync(join(g, 'runs', 'signup__R2.4.json'), '{"b":2}');
    expect(await until(() => s.msgs.some((m) => m.event === 'runs' && (m.data as { name: string }).name === 'signup__R2.4.json'), 1000)).toBe(true);
    writeFileSync(join(g, 'runs', 'signup__R2.3.json'), '{"a":22}');
    expect(await until(() => s.msgs.some((m) => m.event === 'runs' && JSON.stringify(m.data).includes('22')), 1000)).toBe(true);
    rmSync(join(g, 'runs', 'signup__R2.4.json'));
    expect(await until(() => s.msgs.some((m) => m.event === 'runs' && (m.data as { data: unknown }).data === null), 1000)).toBe(true);
    s.close();
  });

  it('[guard-serve:R2.5] a ping comment is sent on the interval', async () => {
    const { h } = await boot(100);
    const s = open(h.port);
    expect(await until(() => s.raw().includes(': ping\n\n'), 1000)).toBe(true);
    s.close();
  });

  it('[guard-serve:R2.6] broken event lines are skipped', () => {
    expect(parseLines('{"a":1}\nnot json\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('[guard-serve:R4.4] stream rejects POST with 405', async () => {
    const { h } = await boot();
    const status = await new Promise<number>((ok) => {
      const r = request({ host: '127.0.0.1', port: h.port, path: '/api/stream', method: 'POST' }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      r.end();
    });
    expect(status).toBe(405);
  });
});
