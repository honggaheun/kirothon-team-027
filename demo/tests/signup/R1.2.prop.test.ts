// tripwire: signup:R1.2 sha256:377265f81712277967829c74f06a994eefd9325ecc938ccf0fcf3eaefe4df44c
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { validateSignup, registerEmail } from '../../src/signup/validate';

const TODAY = '2026-11-14';

// 이메일을 뺀 나머지는 모두 유효한 입력
const base = {
  password: 'abcd1234',
  birthDate: '2000-01-01',
  guardianConsent: false,
  today: TODAY,
};

// R1.2 '이미 가입된 이메일이면 거절': @가 있는 이메일
const registeredEmail = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{1,12}$/),
    fc.stringMatching(/^[a-z0-9]{1,8}\.[a-z]{2,3}$/),
  )
  .map(([local, domain]) => `${local}@${domain}`);

describe('signup', () => {
  it('[R1.2] 이미 가입된 이메일은 거절', () => {
    fc.assert(
      fc.property(registeredEmail, (email) => {
        // 가입된 상태를 만드는 준비 동작
        registerEmail(email);
        return validateSignup({ ...base, email }).ok === false;
      }),
    );
  });
});
