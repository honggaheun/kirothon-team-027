// tripwire: notice-execution:R1.1 sha256:54c7998927aee8f8367508d6f110891168364d1470f38d94b171f63698eeca6b
import { test, expect } from 'vitest';
import fc from 'fast-check';
import { check } from '../../scripts/python-predicate';

// R1.1 'event이고 start가 null이면 거절' 외의 입력은 모두 유효하게 고정한다.
const baseInput = (start: null) => ({
  userId: 'u1',
  ownerId: 'u1',
  approved: true,
  version: 1,
  expectedVersion: 1,
  duplicate: false,
  items: [{ title: '공지 확인', kind: 'event', start, end: null, reminders: [] as string[] }],
});

test('[notice-execution:R1.1] 시작 날짜가 없는 event 일정은 등록 거절', () => {
  fc.assert(
    fc.property(fc.constant(null), (start) => {
      expect(check(baseInput(start)).ok).toBe(false);
    }),
    { verbose: 2 },
  );
});
