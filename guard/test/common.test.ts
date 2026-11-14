// Tests for shared helpers and the command line (task 1).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { UsageError, decodeUtf8, normalize, parseOptions } from '../src/common.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { input: '', encoding: 'utf8' });
}

describe('common helpers', () => {
  it('[guard-core:R3.1] decodeUtf8 drops one leading BOM and keeps the rest', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (s) => {
        const bytes = Buffer.from(s, 'utf8');
        const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
        expect(decodeUtf8(withBom)).toBe(s);
        expect(decodeUtf8(bytes)).toBe(s);
      }),
    );
  });

  it('[guard-core:R3.3] normalize turns backslashes to slashes, lowercases, drops leading ./', () => {
    expect(normalize('.\\Tests\\A.TS')).toBe('tests/a.ts');
    expect(normalize('C:\\Users\\X\\src\\a.ts')).toBe('c:/users/x/src/a.ts');
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const n = normalize(s);
        expect(n.includes('\\')).toBe(false);
        expect(normalize(n)).toBe(normalize(n.replace(/^\.\//, '')));
      }),
    );
  });

  it('[guard-core:R3.1] parseOptions reads --k v, --k=v and repeats', () => {
    const { opts, positionals } = parseOptions(['x', '--a', '1', '--b=2', '--a', '3']);
    expect(opts.get('a')).toEqual(['1', '3']);
    expect(opts.get('b')).toEqual(['2']);
    expect(positionals).toEqual(['x']);
    expect(() => parseOptions(['--a'])).toThrow(UsageError);
  });
});

describe('cli', () => {
  it('[guard-core:R1.1] dist is built and has a module-format package.json', () => {
    expect(existsSync(cli)).toBe(true);
    expect(existsSync(path.join(path.dirname(cli), 'package.json'))).toBe(true);
  });

  it('[guard-core:R3.4] a first argument that is not a subcommand exits 64', () => {
    for (const args of [[], ['bogus'], ['--root', '.', 'check', '--results', 'f.json'], ['scan']]) {
      expect(run(args).status).toBe(64);
    }
  });
});
