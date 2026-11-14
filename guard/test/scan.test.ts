// Tests for scan (task 2).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DuplicateIdError, extractBasis, parseRequirements, scanSpecs } from '../src/scan.js';

const word = fc.string({ unit: fc.constantFrom('a', 'b', 'c', '가', '나', '1', ' ', 'x'), minLength: 1, maxLength: 12 });
const sentence = word.map((w) => 'WHEN ' + w.trim() + 'x THEN 시스템은 거절해야 한다(SHALL)');
const hex = (s: string) => 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');

// Balanced bracket content that never contains `(근거:`.
const balanced: fc.Arbitrary<string> = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.string({ unit: fc.constantFrom('a', 'b', '가', '1', ' ', '.', ','), maxLength: 6 }),
    fc.tuple(tie('node'), tie('node')).map(([a, b]) => `${a}(${b})`),
  ),
})).node as fc.Arbitrary<string>;

function doc(groups: string[][], heading = '###', ac = '####'): string {
  return groups
    .map((items, i) => `${heading} Requirement ${i + 1}\n\n${ac} Acceptance Criteria\n\n${items.map((s, j) => `${j + 1}. ${s}`).join('\n')}\n`)
    .join('\n');
}

describe('scan', () => {
  it('[guard-core:R1.1] ID count equals criteria line count and IDs are unique', () => {
    fc.assert(
      fc.property(fc.array(fc.array(sentence, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 4 }), fc.constantFrom(2, 3, 4, 5), (groups, h) => {
        const reqs = parseRequirements(doc(groups, '#'.repeat(h), '#'.repeat(Math.min(h + 1, 5))));
        expect(reqs.length).toBe(groups.reduce((n, g) => n + g.length, 0));
        expect(new Set(reqs.map((r) => r.id)).size).toBe(reqs.length);
        expect(reqs[0].id).toBe('R1.1');
      }),
    );
  });

  it('[guard-core:R1.1] accepts Korean headings and any heading case', () => {
    const md = '## 요구사항 2\n\n### 수용 기준\n\n1. 첫째\n2. 둘째\n\n## REQUIREMENT 3\n\n## acceptance criteria\n1. 셋째\n';
    expect(parseRequirements(md).map((r) => r.id)).toEqual(['R2.1', 'R2.2', 'R3.1']);
  });

  it('[guard-core:R1.2] text is trimmed and collapsed; textHash is sha256 of text', () => {
    const [r] = parseRequirements('### Requirement 1\n#### Acceptance Criteria\n1.   a \t  b    c  \r\n');
    expect(r.text).toBe('a b c');
    expect(r.textHash).toBe(hex('a b c'));
  });

  it('[guard-core:R1.3] duplicate IDs in one spec throw and name the ID', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-scan-'));
    try {
      mkdirSync(path.join(dir, 's1'));
      writeFileSync(path.join(dir, 's1', 'requirements.md'), '### Requirement 1\n#### Acceptance Criteria\n1. a\n### Requirement 1\n#### Acceptance Criteria\n1. b\n');
      expect(() => scanSpecs(dir)).toThrow(DuplicateIdError);
      expect(() => scanSpecs(dir)).toThrow(/R1\.1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('[guard-core:R1.1] same ID in different specs is fine and specs are sorted by name', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-scan-'));
    try {
      for (const n of ['b', 'a']) {
        mkdirSync(path.join(dir, n));
        writeFileSync(path.join(dir, n, 'requirements.md'), '### Requirement 1\n#### Acceptance Criteria\n1. x\n');
      }
      expect(scanSpecs(dir).specs.map((s) => s.spec)).toEqual(['a', 'b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('[guard-core:R1.4] basis is the trimmed content of a final (근거: …) group', () => {
    fc.assert(
      fc.property(sentence, balanced, (s, x) => {
        fc.pre(x.trim() !== '');
        const text = `${s} (근거: ${x})`;
        expect(extractBasis(text)).toBe(x.trim());
        const [r] = parseRequirements(`### Requirement 1\n#### Acceptance Criteria\n1. ${text}\n`);
        expect(r.basis).toBe(x.trim().replace(/[ \t]+/g, ' '));
        expect(r.text).toBe(text.trim().replace(/[ \t]+/g, ' '));
        expect(r.textHash).toBe(hex(r.text));
      }),
    );
  });

  it('[guard-core:R1.4] trailing characters outside the group mean no basis', () => {
    fc.assert(
      fc.property(sentence, balanced, fc.constantFrom(' 이어서', ' (SHALL)', ' 끝'), (s, x, tail) => {
        fc.pre(x.trim() !== '');
        expect(extractBasis(`${s} (근거: ${x})${tail}`)).toBeUndefined();
      }),
    );
  });

  it('[guard-core:R1.4] spec example, nested brackets, mid-sentence mention and empty basis', () => {
    expect(extractBasis('거절해야 한다(SHALL) (근거: 개인정보 보호법 제22조의2 제1항)')).toBe('개인정보 보호법 제22조의2 제1항');
    expect(extractBasis('x (근거: 제1항(2023. 3. 14. 개정으로 신설))')).toBe('제1항(2023. 3. 14. 개정으로 신설)');
    expect(extractBasis('문장 끝의 (근거: …) 표기는 선택이다(SHALL)')).toBeUndefined();
    expect(extractBasis('x (근거: )')).toBeUndefined();
    expect(extractBasis('x (근거: a)) ')).toBeUndefined();
    expect(extractBasis('no basis')).toBeUndefined();
  });

  it('[guard-core:R1.1] the guard-core requirements parse with their own basis rules', () => {
    const md = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.kiro/specs/guard-core/requirements.md'), 'utf8');
    const reqs = parseRequirements(md);
    expect(reqs.map((r) => r.id).slice(0, 4)).toEqual(['R1.1', 'R1.2', 'R1.3', 'R1.4']);
    expect(reqs.find((r) => r.id === 'R1.4')!.basis).toBeUndefined();
  });
});
