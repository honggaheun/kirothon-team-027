// Shared helpers: BOM stripping, normalization, hashing, JSON output, option parsing.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Decode bytes as UTF-8 and drop a leading BOM. */
export function decodeUtf8(buf: Buffer): string {
  const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  return buf.subarray(start).toString('utf8');
}

/** Read a text file, dropping a leading BOM. */
export function readTextFile(file: string): string {
  return decodeUtf8(readFileSync(file));
}

/** Normalize a path or command: `\` to `/`, lowercase, no leading `./`. */
export function normalize(s: string): string {
  return s.replace(/\\/g, '/').toLowerCase().replace(/^\.\//, '');
}

/** `sha256:<lowercase hex>` of a string's UTF-8 bytes. */
export function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Write JSON as UTF-8 without BOM, two-space indent. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Thrown for usage errors (exit code 64). */
export class UsageError extends Error {}

export type Options = Map<string, string[]>;

/** Parse `--key value` and `--key=value` options; the rest are positionals. */
export function parseOptions(args: string[]): { opts: Options; positionals: string[] } {
  const opts: Options = new Map();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key: string;
      let val: string;
      if (eq >= 0) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        if (i + 1 >= args.length) throw new UsageError(`missing value for --${key}`);
        val = args[++i];
      }
      const list = opts.get(key) ?? [];
      list.push(val);
      opts.set(key, list);
    } else {
      positionals.push(a);
    }
  }
  return { opts, positionals };
}

/** Last value of an option, or undefined. */
export function opt(opts: Options, key: string): string | undefined {
  const list = opts.get(key);
  return list ? list[list.length - 1] : undefined;
}

/** Required option value, or a usage error. */
export function requireOpt(opts: Options, key: string): string {
  const v = opt(opts, key);
  if (v === undefined) throw new UsageError(`missing required option --${key}`);
  return v;
}
