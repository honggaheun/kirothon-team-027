// tripwire: notice-execution:R2.1 sha256:8292eab26007dcd4d92eee79f607b3ef28f9d956172da6cb14af8afaff8e135d
import { test, expect } from 'vitest';
import fc from 'fast-check';
import { check } from '../../scripts/python-predicate';

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// R2.1 '한국 시각 22:00 이상 또는 08:00 미만'. 경계 바로 안쪽 22:00을 항상 섞는다.
const forbiddenKoreaTime = fc.oneof(
  fc.constant('22:00'),
  fc.integer({ min: 1320, max: 1439 }).map(hhmm), // 22:00~23:59
  fc.integer({ min: 0, max: 479 }).map(hhmm), // 00:00~07:59
);

// 나머지 입력은 모두 유효: 일정은 2026-11-21 09:00~10:00(+09:00), 알림은 전날 2026-11-20.
const baseInput = (time: string) => ({
  userId: 'u1',
  ownerId: 'u1',
  approved: true,
  version: 1,
  expectedVersion: 1,
  duplicate: false,
  items: [
    {
      title: '공지 확인',
      kind: 'event',
      start: '2026-11-21T09:00:00+09:00',
      end: '2026-11-21T10:00:00+09:00',
      reminders: [`2026-11-20T${time}:00+09:00`],
    },
  ],
});

test('[notice-execution:R2.1] 한국 시각 22:00 이상 또는 08:00 미만 알림은 등록 거절', () => {
  fc.assert(
    fc.property(forbiddenKoreaTime, (time) => {
      expect(check(baseInput(time)).ok).toBe(false);
    }),
    { verbose: 2, examples: [['22:00'], ['07:59']] },
  );
});
