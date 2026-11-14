// tripwire: signup:R2.1 sha256:fcb2987c5eac02d1353128f347285186a690b450d54ea23586b2040acf93feea
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { validateSignup } from '../../src/signup/validate';

const TODAY = '2026-11-14';

// 비밀번호를 뺀 나머지는 모두 유효한 입력
const base = {
  email: 'user@example.com',
  birthDate: '2000-01-01',
  guardianConsent: false,
  today: TODAY,
};

// R2.1 '영문자가 없으면 거절': 숫자·기호만, 길이 8자 이상, 숫자 하나 이상 포함
// (R2.2·R2.3은 지킨다)
const noLetterPassword = fc
  .tuple(
    fc.constantFrom(...'0123456789'.split('')),
    fc.array(fc.constantFrom(...'0123456789!@#$%^&*()-_=+.,'.split('')), {
      minLength: 7,
      maxLength: 24,
    }),
  )
  .map(([digit, rest]) => digit + rest.join(''));

describe('signup', () => {
  it('[R2.1] 영문자가 없는 비밀번호는 거절', () => {
    fc.assert(
      fc.property(noLetterPassword, (password) => {
        return validateSignup({ ...base, password }).ok === false;
      }),
    );
  });
});
