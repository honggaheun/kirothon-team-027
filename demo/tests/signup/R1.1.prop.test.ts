// tripwire: signup:R1.1 sha256:0ebd1eb9b3a5c5282579348066735c11ba8712bebb60191d12e55a24c3297c4f
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { validateSignup } from '../../src/signup/validate';

const TODAY = '2026-11-14';

// 이메일을 뺀 나머지는 모두 유효한 입력
const base = {
  password: 'abcd1234',
  birthDate: '2000-01-01',
  guardianConsent: false,
  today: TODAY,
};

// R1.1 '이메일에 @가 없으면 거절': @가 없는 이메일(빈 문자열 포함)
const emailWithoutAt = fc
  .string({ unit: 'grapheme-ascii', minLength: 0, maxLength: 30 })
  .map((s) => s.replaceAll('@', ''));

describe('signup', () => {
  it('[R1.1] @가 없는 이메일은 거절', () => {
    fc.assert(
      fc.property(emailWithoutAt, (email) => {
        return validateSignup({ ...base, email }).ok === false;
      }),
    );
  });
});
