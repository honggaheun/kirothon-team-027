import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function pythonPath(): string {
  for (const candidate of [join(root, '.venv', 'Scripts', 'python.exe'), join(root, '.venv', 'bin', 'python')]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'python3';
}

// chaenggim.rules.check(dict)를 새 Python 프로세스로 호출하고 결과 JSON을 그대로 돌려준다. 판정은 하지 않는다.
export function check(input: unknown): { ok: boolean; reason?: string } {
  const output = execFileSync(pythonPath(), ['-B', join(root, 'scripts', 'predicate_entry.py')], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(output);
}
