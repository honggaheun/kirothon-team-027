// guard CLI entry: scan, judge, gate, check, adopt (resolve/serve are other specs).
import { readFileSync } from 'node:fs';
import { UsageError, opt, parseOptions, readTextFile, requireOpt, writeJson } from './common.js';
import { runAdopt } from './adopt.js';
import { runCheck } from './check.js';
import { runGate } from './gate.js';
import { judge } from './judge.js';
import { DuplicateIdError, scanSpecs } from './scan.js';
const USAGE = `usage: guard <command> [options]
  scan  --specs <dir> --out <file>
  judge --index <f> --results <f> [--gen-hashes <f>] [--broken-seals <f>] --out <f>
  check [--root <dir>] [--results <f>] [--if-changed] [--summary]
  adopt <requirement> --test <f> --mutant <f> [--mutant <f> ...] [--root <dir>]
  gate  [--root <dir>] | --report <f> [--resolution <f>] [--sealed <f>] [--events <f>]   (stdin = event JSON)`;
const OTHER = ['resolve', 'serve'];
function readStdin() {
    try {
        return readFileSync(0);
    }
    catch {
        return Buffer.alloc(0);
    }
}
async function main(argv) {
    const cmd = argv[0];
    if (cmd === undefined || (cmd !== 'scan' && cmd !== 'judge' && cmd !== 'gate' && cmd !== 'check' && cmd !== 'adopt' && !OTHER.includes(cmd))) {
        throw new UsageError('unknown or missing command');
    }
    if (OTHER.includes(cmd)) {
        process.stderr.write(`guard ${cmd}: not implemented in guard-core\n`);
        return 70;
    }
    const { opts, positionals } = parseOptions(argv.slice(1), cmd === 'check' ? ['if-changed', 'summary'] : []);
    if (cmd === 'adopt') {
        const r = await runAdopt({
            requirement: positionals[0],
            test: opt(opts, 'test'),
            mutants: opts.get('mutant') ?? [],
            root: opt(opts, 'root'),
            cwd: process.cwd(),
        });
        if (r.stdout)
            process.stdout.write(r.stdout);
        if (r.stderr)
            process.stderr.write(r.stderr);
        return r.code;
    }
    if (cmd === 'check') {
        const r = await runCheck({
            root: opt(opts, 'root'),
            cwd: process.cwd(),
            results: opt(opts, 'results'),
            ifChanged: opts.has('if-changed'),
            summary: opts.has('summary'),
        });
        if (r.stdout)
            process.stdout.write(r.stdout);
        if (r.stderr)
            process.stderr.write(r.stderr);
        return r.code;
    }
    if (cmd === 'scan') {
        const specs = requireOpt(opts, 'specs');
        const out = requireOpt(opts, 'out');
        try {
            writeJson(out, scanSpecs(specs));
        }
        catch (e) {
            if (e instanceof DuplicateIdError) {
                process.stderr.write(e.message + '\n');
                return 1;
            }
            throw e;
        }
        return 0;
    }
    if (cmd === 'judge') {
        const index = JSON.parse(readTextFile(requireOpt(opts, 'index')));
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
    if (r.stderr)
        process.stderr.write(r.stderr);
    return r.code;
}
function fail(e) {
    if (e instanceof UsageError) {
        process.stderr.write(`${e.message}\n${USAGE}\n`);
        process.exitCode = 64;
    }
    else {
        process.stderr.write(`guard: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
    }
}
main(process.argv.slice(2)).then((c) => {
    process.exitCode = c;
}, fail);
