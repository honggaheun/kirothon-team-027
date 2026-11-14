// Tests for the counterexample record file name (task 5).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runFileName } from '../src/runfile.js';

const specName = fc.string({ unit: fc.constantFrom(...'abcxyzABC019_-'.split('')), minLength: 1, maxLength: 10 });
const reqId = fc.tuple(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 })).map(([n, m]) => `R${n}.${m}`);
const fullId = fc.tuple(specName, reqId).map(([s, r]) => `${s}:${r}`);

describe('runFileName', () => {
  it('[guard-core:R4.1] replaces the colon with two underscores and adds .json', () => {
    expect(runFileName('signup:R2.3')).toBe('signup__R2.3.json');
  });

  it('[guard-core:R4.1] the name never has a character Windows forbids in file names', () => {
    fc.assert(
      fc.property(fullId, (id) => {
        expect(runFileName(id)).not.toMatch(/[<>:"/\\|?*]/);
        expect(runFileName(id).endsWith('.json')).toBe(true);
      }),
    );
  });

  it('[guard-core:R4.1] different IDs give different names', () => {
    fc.assert(
      fc.property(fullId, fullId, (a, b) => {
        fc.pre(a !== b);
        expect(runFileName(a)).not.toBe(runFileName(b));
      }),
    );
  });
});
