---
inclusion: always
---
# 제품 — 회원가입 검증 모듈

가입 요청(이메일·비밀번호·생년월일·법정대리인 동의)을 받아 가입을 받아들일지 거절할지 정하는 모듈이다.

- 진입점: `src/signup/validate.ts`의 `validateSignup(input)`. 결과는 `{ ok: true }` 또는 `{ ok: false, reason }`(reason = 어긴 요구사항 ID)
- 태그: guard는 줄에 든 `[Rn.m]`으로 요구사항과 코드 줄을 잇고, 무대 화면은 태그 줄 하나를 실 하나로 그린다. 태그 줄은 수용 기준마다 판정하는 줄 하나와 숫자 경계가 있는 기준(R2.3)의 경계값 상수 줄 하나뿐이다 — signup은 7줄. 한 줄에 태그는 하나만 쓰고, 다른 줄(다른 상수·주석·도우미)에는 대괄호 ID를 쓰지 않는다. 이미 쓴 태그는 지우거나 옮기지 않는다
- 판정 줄은 거절할 때 도우미 `no('[Rn.m]')`로 그 기준의 태그를 넘긴다. `no`는 `{ ok: false, reason }`을 돌려주고 reason은 대괄호를 뗀 ID(`'R2.3'`)다. 경계값 상수 줄은 끝에 `// [R2.3]`을 단다. 태그 줄은 앞 공백을 빼고 56자 이하로 쓴다(무대 화면 코드 열의 한 줄 폭). 모양:

```ts
export const MIN_PASSWORD_LENGTH = 8; // [R2.3]
const no = (tag: string): SignupResult => ({ ok: false, reason: tag.slice(1, -1) });
// validateSignup 안의 판정 줄
if (!input.email.includes('@')) return no('[R1.1]')
if (isRegistered(input.email)) return no('[R1.2]')
if (!/[a-z]/i.test(pw)) return no('[R2.1]')
if (!/\d/.test(pw)) return no('[R2.2]')
if (pw.length < MIN_PASSWORD_LENGTH) return no('[R2.3]')
if (age < 14 && !consent) return no('[R3.1]')
```
- 입력: `email`, `password`, `birthDate`(`YYYY-MM-DD`), `guardianConsent`(boolean), `today`(선택, `YYYY-MM-DD`)
- 요구사항: `.kiro/specs/signup/requirements.md` — 요구사항 3개, 수용 기준 6개(R1.1·R1.2 이메일, R2.1·R2.2·R2.3 비밀번호, R3.1 만 14세 미만 법정대리인 동의)
- R3.1의 근거는 개인정보 보호법 제22조의2 제1항이다: "개인정보처리자는 만 14세 미만 아동의 개인정보를 처리하기 위하여 이 법에 따른 동의를 받아야 할 때에는 그 법정대리인의 동의를 받아야 하며, 법정대리인이 동의하였는지를 확인하여야 한다." 요구사항 문장 끝에 `(근거: …)`로 적혀 있다
- 검사: 수용 기준마다 fast-check 속성 검사 파일 하나 `tests/signup/<Rn.m>.prop.test.ts`. 테스트 이름은 `[R2.3]`처럼 태그로 시작한다. 검사의 검사에 쓰는 변형은 `mutants/signup/<Rn.m>-m<k>.json`(사람이 둔 변형은 `-h<k>`)

## 구현 환경

- TypeScript, vitest 5 + fast-check 4. `vitest.setup.ts`가 fast-check 전역 설정 `verbose: 2`를 켠다
- 검사 실행: `npx vitest run`
- Windows 11, 셸은 PowerShell 5.1(`&&` 대신 `;`)
- 새 패키지를 설치하지 않는다. 개발 의존(vitest·fast-check 등)은 사람이 이 작업 공간의 `package.json`·`node_modules`에 설치해 둔다 — 없으면 멈추고 알린다
