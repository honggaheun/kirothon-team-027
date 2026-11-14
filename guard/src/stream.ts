// stream: SSE hub that watches .kiro/guard/ and pushes changes. // [guard-serve:R2.1]
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { decodeUtf8 } from './common.js';
import { guardDir } from './config.js';

/** One SSE message. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const JSON_FILES = ['index', 'report', 'resolution', 'sealed'] as const;
const RUN_NAME = /^[A-Za-z0-9_-]+__R\d+\.\d+\.json$/;
const POLL_MS = 500;
const PING_MS = 15_000;
const SETTLE_MS = 100;
const TAIL_LINES = 50;

function sig(file: string): string | null {
  try {
    const s = statSync(file);
    return s.isFile() ? `${s.size}:${s.mtimeMs}` : null;
  } catch {
    return null;
  }
}

function readJson(file: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: JSON.parse(decodeUtf8(readFileSync(file))) };
  } catch {
    return { ok: false };
  }
}

/** Objects of the complete JSON lines in a text; lines that do not parse are skipped. // [guard-serve:R2.6] */
export function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // A broken line is not sent.
    }
  }
  return out;
}

/** Bytes of a file from `from` to its end. */
function readFrom(file: string, from: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - from));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** Length in bytes up to and including the last `\n`. */
function completeLength(buf: Buffer): number {
  const i = buf.lastIndexOf(0x0a);
  return i < 0 ? 0 : i + 1;
}

export class StreamHub {
  private clients = new Set<ServerResponse>();
  private seen = new Map<string, string | null>();
  private runSeen = new Map<string, string>();
  private pos = 0;
  private hadEvents = false;
  private timers: NodeJS.Timeout[] = [];
  private watcher: FSWatcher | null = null;
  private pending: NodeJS.Timeout | null = null;
  private readonly g: string;

  constructor(root: string, pingMs: number = PING_MS) {
    this.g = guardDir(root);
    // Start from the present state so only later changes are pushed.
    for (const n of JSON_FILES) {
      const f = join(this.g, `${n}.json`);
      const s = sig(f);
      this.seen.set(n, s !== null && readJson(f).ok ? s : null);
    }
    this.runSeen = this.runSigs();
    const ev = join(this.g, 'events.jsonl');
    if (existsSync(ev)) {
      this.hadEvents = true;
      this.pos = completeLength(readFrom(ev, 0));
    }
    this.timers.push(setInterval(() => this.poll(), POLL_MS), setInterval(() => this.ping(), pingMs));
    try {
      this.watcher = watch(this.g, { recursive: true }, () => this.kick());
      this.watcher.on('error', () => undefined);
    } catch {
      // The guard folder may not exist yet; polling covers it.
    }
  }

  /** Stop watching and end every connection. */
  close(): void {
    for (const t of this.timers) clearInterval(t);
    if (this.pending) clearTimeout(this.pending);
    this.watcher?.close();
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  /** Open an SSE connection and send the current state. // [guard-serve:R2.1] */
  connect(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    this.pollEvents(); // push anything pending to the others first, so the position stays consistent
    for (const n of JSON_FILES) {
      const r = readJson(join(this.g, `${n}.json`));
      if (r.ok) res.write(sseFrame(n, r.data));
    }
    for (const name of this.runNames()) {
      const r = readJson(join(this.g, 'runs', name));
      if (r.ok) res.write(sseFrame('runs', { name, data: r.data }));
    }
    res.write(sseFrame('events-reset', this.tail()));
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  private broadcast(frame: string): void {
    for (const c of this.clients) c.write(frame);
  }

  private ping(): void {
    this.broadcast(': ping\n\n'); // [guard-serve:R2.5]
  }

  private kick(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.poll();
    }, SETTLE_MS);
  }

  private runNames(): string[] {
    try {
      return readdirSync(join(this.g, 'runs')).filter((n) => RUN_NAME.test(n)).sort();
    } catch {
      return [];
    }
  }

  private runSigs(): Map<string, string> {
    const m = new Map<string, string>();
    for (const n of this.runNames()) {
      const s = sig(join(this.g, 'runs', n));
      if (s !== null) m.set(n, s);
    }
    return m;
  }

  /** The last 50 event objects. */
  private tail(): unknown[] {
    const ev = join(this.g, 'events.jsonl');
    try {
      const buf = readFrom(ev, 0);
      const text = buf.subarray(0, completeLength(buf)).toString('utf8');
      return parseLines(text).slice(-TAIL_LINES);
    } catch {
      return [];
    }
  }

  /** Compare every watched file with what was last sent. // [guard-serve:R2.2][guard-serve:R2.4] */
  poll(): void {
    try {
      this.pollJson();
      this.pollRuns();
      this.pollEvents();
    } catch {
      // A failed pass is retried on the next tick.
    }
  }

  private pollJson(): void {
    for (const n of JSON_FILES) {
      const f = join(this.g, `${n}.json`);
      const s = sig(f);
      if (s === null) {
        this.seen.set(n, null);
        continue;
      }
      if (this.seen.get(n) === s) continue;
      const r = readJson(f);
      if (!r.ok) continue; // [guard-serve:R2.6] unreadable now, read again next pass
      this.seen.set(n, s);
      this.broadcast(sseFrame(n, r.data));
    }
  }

  private pollRuns(): void {
    const now = this.runSigs();
    for (const [name, s] of now) {
      if (this.runSeen.get(name) === s) continue;
      const r = readJson(join(this.g, 'runs', name));
      if (!r.ok) {
        now.delete(name);
        continue;
      }
      this.broadcast(sseFrame('runs', { name, data: r.data }));
    }
    for (const name of this.runSeen.keys()) {
      if (!now.has(name) && !existsSync(join(this.g, 'runs', name))) this.broadcast(sseFrame('runs', { name, data: null }));
    }
    for (const [name, s] of this.runSeen) {
      if (!now.has(name) && existsSync(join(this.g, 'runs', name))) now.set(name, s); // still unreadable: retry
    }
    this.runSeen = now;
  }

  /** Send new complete lines, or a reset when the file shrank or vanished. // [guard-serve:R2.3] */
  private pollEvents(): void {
    const ev = join(this.g, 'events.jsonl');
    let size: number;
    try {
      const st = statSync(ev);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      if (this.hadEvents || this.pos > 0) {
        this.hadEvents = false;
        this.pos = 0;
        this.broadcast(sseFrame('events-reset', []));
      }
      return;
    }
    this.hadEvents = true;
    if (size < this.pos) {
      const buf = readFrom(ev, 0);
      const len = completeLength(buf);
      this.pos = len;
      this.broadcast(sseFrame('events-reset', parseLines(buf.subarray(0, len).toString('utf8')).slice(-TAIL_LINES)));
      return;
    }
    if (size === this.pos) return;
    const buf = readFrom(ev, this.pos);
    const len = completeLength(buf);
    if (len === 0) return;
    this.pos += len;
    const lines = parseLines(buf.subarray(0, len).toString('utf8'));
    if (lines.length > 0) this.broadcast(sseFrame('events', lines));
  }
}
