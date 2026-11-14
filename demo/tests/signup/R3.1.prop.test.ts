// tripwire: signup:R3.1 sha256:5aadf75836c05ffab4ab907752780f1c0c25d1b7b8997e1fc4a72db4044e7b33
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { validateSignup } from '../../src/signup/validate';

// 오늘을 고정한다. 2012-11-14 출생은 만 14세, 2012-11-15 출생은 만 13세.
const TODAY = '2026-11-14';

// R3.1 '만 14세 미만'에서 읽은 기준값
const SPEC_ADULT_AGE = 14;

// 생년월일을 뺀 나머지는 모두 유효한 입력(동의 없음은 이 기준의 조건이라 고정)
const base = {
  email: 'user@example.com',
  password: 'abcd1234',
  guardianConsent: false,
  today: TODAY,
};

// 만 0~13세 생년월일. 만 나이를 먼저 고르고(경계 바로 안쪽 13을 섞는다)
// 생일이 오늘이거나 이미 지난 경우, 아직 안 지난 경우를 함께 만든다.
const underageBirthDate = fc
  .tuple(
    fc.oneof(
      fc.constant(SPEC_ADULT_AGE - 1),
      fc.integer({ min: 0, max: SPEC_ADULT_AGE - 1 }),
    ),
    fc.constantFrom('01-01', '11-14', '11-15'),
  )
  .map(([age, monthDay]) => {
    // 11-15 생일은 오늘(11-14)까지 안 지났으므로 한 해 더 앞선 해에 태어나야 같은 만 나이
    const year = monthDay === '11-15' ? 2025 - age : 2026 - age;
    return `${String(year).padStart(4, '0')}-${monthDay}`;
  });

describe('signup', () => {
  it('[R3.1] 만 14세 미만이고 법정대리인 동의가 없으면 거절', () => {
    fc.assert(
      fc.property(underageBirthDate, (birthDate) => {
        return validateSignup({ ...base, birthDate }).ok === false;
      }),
    );
  });
});
