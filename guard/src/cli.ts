// guard CLI entry: scan, judge, gate (check/adopt/resolve/serve are other specs).
import { readFileSync } from 'node:fs';
import { UsageError, opt, parseOptions, readTextFile, requireOpt, writeJson } from './common.js';
import { runGate } from './gate.js';
import { judge } from './judge.js';
import { DuplicateIdError, scanSpecs } from './scan.js';
import type { SpecIndex } from './scan.js';

const USAGE = `usage: guard <command> [options]
  scan  --specs <dir> --out <file>
  judge --index <f> --results <f> [--gen-hashes <f>] [--broken-seals <f>] --out <f>
  gate  [--root <dir>] | --report <f> [--resolution <f>] [--sealed <f>] [--events <f>]   (stdin = event JSON)`;
const OTHER = ['check', 'adopt', 'resolve', 'serve'];

function readStdin(): Buffer {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

function main(argv: string[]): number {
  const cmd = argv[0];
  if (cmd === undefined || (cmd !== 'scan' && cmd !== 'judge' && cmd !== 'gate' && !OTHER.includes(cmd))) {
    throw new UsageError('unknown or missing command');
  }
  if (OTHER.includes(cmd)) {
    process.stderr.write(`guard ${cmd}: not implemented in guard-core\n`);
    return 70;
  }
  const { opts } = parseOptions(argv.slice(1));
  if (cmd === 'scan') {
    const specs = requireOpt(opts, 'specs');
    const out = requireOpt(opts, 'out');
    try {
      writeJson(out, scanSpecs(specs));
    } catch (e) {
      if (e instanceof DuplicateIdError) {
        process.stderr.write(e.message + '\n');
        return 1;
      }
      throw e;
    }
    return 0;
  }
  if (cmd === 'judge') {
    const index = JSON.parse(readTextFile(requireOpt(opts, 'index'))) as SpecIndex;
    const results = JSON.parse(readTextFile(requireOpt(opts, 'results')));
    const out = requireOpt(opts, 'out');
    const gh = opt(opts, 'gen-hashes');
    const bs = opt(opts, 'broken-seals');
    const report = judge({
      index,
      results,
      genHashes: gh ? JSON.parse(readTextFile(gh)) : undefined,
      brokenSeals: bs ? JSON.parse(readTextFile(bs)) : undefined,
    });
    writeJson(out, report);
    return 0;
  }
  const r = runGate({
    root: opt(opts, 'root'),
    report: opt(opts, 'report'),
    resolution: opt(opts, 'resolution'),
    sealed: opt(opts, 'sealed'),
    events: opt(opts, 'events'),
    stdin: readStdin(),
    cwd: process.cwd(),
  });
  if (r.stderr) process.stderr.write(r.stderr);
  return r.code;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`${e.message}\n${USAGE}\n`);
    process.exitCode = 64;
  } else {
    process.stderr.write(`guard: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
