// tripwire: signup:R2.2 sha256:3ed592500104927964ebd4eb830824ed4761f1274a458c91f4e1ba5955faea04
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

// R2.2 '숫자가 없으면 거절': 영문자·기호만, 길이 8자 이상, 영문자 하나 이상 포함
// (R2.1·R2.3은 지킨다)
const noDigitPassword = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    fc.array(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()-_=+.,'.split(''),
      ),
      { minLength: 7, maxLength: 24 },
    ),
  )
  .map(([letter, rest]) => letter + rest.join(''));

describe('signup', () => {
  it('[R2.2] 숫자가 없는 비밀번호는 거절', () => {
    fc.assert(
      fc.property(noDigitPassword, (password) => {
        return validateSignup({ ...base, password }).ok === false;
      }),
    );
  });
});
