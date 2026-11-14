// tripwire: signup:R2.3 sha256:e5441aeb98e65ccaf026bc70d5349eb981e0466f1794f3beab5822bd702d4f89
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { validateSignup } from '../../src/signup/validate';

const TODAY = '2026-11-14';

// R2.3 '비밀번호가 8자 미만이면 거절'에서 읽은 기준값
const SPEC_MIN_LENGTH = 8;

// 비밀번호를 뺀 나머지는 모두 유효한 입력
const base = {
  email: 'user@example.com',
  birthDate: '2000-01-01',
  guardianConsent: false,
  today: TODAY,
};

// 영문자·숫자를 하나씩 넣어 R2.1·R2.2는 지키고 길이만 8자 미만(2~7자)으로 만든다.
// 길이를 먼저 고르므로 경계 바로 안쪽(7자)이 반드시 나온다.
const shortPassword = fc
  .integer({ min: 2, max: SPEC_MIN_LENGTH - 1 })
  .chain((len) =>
    fc
      .array(fc.constantFrom(...'abcXYZ0123456789!@#$%'.split('')), {
        minLength: len - 2,
        maxLength: len - 2,
      })
      .map((rest) => 'a1' + rest.join('')),
  );

describe('signup', () => {
  it('[R2.3] 8자 미만 비밀번호는 거절', () => {
    fc.assert(
      fc.property(shortPassword, (password) => {
        return validateSignup({ ...base, password }).ok === false;
      }),
    );
  });
});
