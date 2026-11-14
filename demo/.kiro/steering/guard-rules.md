---
inclusion: always
---
# Tripwire 규칙

이 작업 공간은 Tripwire가 지킨다. 에이전트가 파일을 쓰거나 셸을 실행할 때마다 hook이 `node ../guard/dist/cli.js`로 판정을 갱신하고, 수용 기준을 어긴 상태(빨강)에서는 사람이 해결을 고르기 전까지 다음 쓰기와 셸 실행을 막는다.

## 기준

1. 검사와 판정의 기준은 `.kiro/specs/signup/requirements.md`의 수용 기준뿐이다. 지금의 코드, 기존 검사, 구현 상수는 기준이 아니다
2. 요구사항을 조용히 약화하지 않는다. 수용 기준의 문장·숫자·`(근거: …)` 표기를 바꾸거나 지우지 않는다. 바꿔야 한다고 보이면 EARS 수정안(diff)과 이유를 사람에게 보여 승인받는다
3. 스펙 문서 형식은 `### Requirement N` → `#### Acceptance Criteria` → `N. WHEN … THEN 시스템은 … 해야 한다(SHALL)`이다

## 검사 만들기 — 수용 기준마다 속성 검사

4. 검사 파일은 수용 기준마다 하나: `tests/signup/<Rn.m>.prop.test.ts`(예: `tests/signup/R2.3.prop.test.ts`). 한 파일에 여러 기준을 넣지 않는다 — 봉인이 파일 단위다. 테스트 이름은 그 기준의 태그로 시작한다. 예: `[R2.3] 8자 미만 비밀번호는 거절`
5. 기준값은 스펙 문장의 숫자에서 가져온다(R2.3이면 8, R3.1이면 14). `src/`에서 import하는 것은 시험 대상 진입점 `validateSignup`뿐이다 — 구현 상수(예: `MIN_PASSWORD_LENGTH`)를 기준으로 쓰면 구현이 틀릴 때 검사도 같이 틀린다
6. 그 기준의 WHEN 조건을 만족하는 입력을 넓게 생성하고, 조건을 만족하는 쪽의 경계값(경계 바로 안쪽, 예: R2.3이면 7자, R3.1이면 만 13세)을 반드시 생성한다. 조건 밖 입력(예: 8자 이상)에 스펙이 말하지 않은 결과를 단정하지 않는다. 나머지 입력은 모두 유효하게 고정해 그 기준만 결과를 가르게 한다
7. `today`는 항상 고정값을 넘긴다
8. 예시 하나가 아니라 속성(`fc.assert(fc.property(...))`)으로 쓴다. fast-check 4에는 `fc.fullUnicode`·`fc.fullUnicodeString`·`fc.unicodeString`·`fc.stringOf`·`fc.asciiString`이 없다 — `fc.string({ unit, minLength, maxLength })`를 쓴다
9. 새 검사는 지금 코드에서 통과해야 한다. 그다음 검사의 검사: 그 기준만 어긴 변형 구현을 경계값을 옮기는 그럴듯한 실수부터 만든다(예: `< 8`을 `< 7`·`< 6`으로, `14`를 `13`으로). 변형은 원본을 고치지 않고 `mutants/signup/<Rn.m>-m<k>.json`에 `{ "requirement", "file", "find", "replace", "why" }`로만 적는다(사람이 둔 변형은 `-h<k>` — 고치지 않는다). 사람이 실행한 adopt가 `mutant survived`를 내면 그 검사를 다시 쓴다 — 더 쉬운 변형으로 바꾸지 않는다
10. 채택(봉인)은 사람만 한다. 검사 파일과 변형 JSON을 만든 뒤, 기준마다 실행할 명령 줄 `node ../guard/dist/cli.js adopt signup:<Rn.m> --test tests/signup/<Rn.m>.prop.test.ts --mutant mutants/signup/<Rn.m>-m1.json [--mutant …]`(그 기준의 변형 파일을 모두, 사람이 둔 `-h<k>`까지)을 사람에게 보여 주고 사람이 실행하게 한다. 에이전트는 adopt를 실행하지 않는다(인자 없이도 — 문지기가 막는다). 채택된 검사는 봉인된다

## 막혔을 때

11. 쓰기나 셸 실행이 `Tripwire:`로 시작하는 메시지로 거부되면 곧바로 멈춘다. 다시 시도하거나 셸·다른 도구로 돌아가지 않는다
12. 거부 메시지를 그대로 보고한다. 요구사항 위반(`Tripwire: blocked. Violated: …`)이면 어긴 요구사항 ID와 반례를 밝히고 사람에게 묻는다: "스펙을 고친다" 또는 "코드를 되돌린다". 예약 경로나 봉인된 검사를 건드려 거부됐다면 그 쓰기를 그만두고 이유를 보고한다. 고르기와 기록은 사람만 한다 — 에이전트는 `guard resolve`를 실행하지 않는다
13. 사람이 고른 뒤에는 그 해결에 필요한 쓰기만 한다. 코드를 되돌린다면 위반한 변경을 되돌린다. 스펙을 고친다면 승인된 수정안대로 requirements.md를 고치고, 그 기준의 검사와 변형을 다시 만든 뒤, 다시 봉인할 adopt 명령 줄을 사람에게 보여 준다(실행은 사람)

## 손대지 않는 곳

14. `.kiro/guard/`(판정·승인·봉인 기록)와 `.kiro/hooks/`는 쓰지도 지우지도 않고, 셸 명령에 이 두 경로를 쓰지 않는다(문지기가 막는다). 판정은 읽기 도구로 `.kiro/guard/report.json`을 읽어 확인한다
15. 봉인된 검사(`.kiro/guard/sealed.json`에 오른 파일)는 고치거나 지우거나 옮기지 않고, 셸 명령에 그 경로를 쓰지 않는다. 검사를 돌릴 때는 파일 경로 없이 `npx vitest run`을 쓴다. 봉인된 검사는 그 요구사항에 사람이 승인한 "스펙을 고친다" 해결이 있을 때만 다시 만든다
16. 새 패키지를 설치하지 않는다. 개발 의존(vitest·fast-check 등)은 사람이 이 작업 공간에 설치해 둔다 — `node_modules/vitest`가 없으면 멈추고 알린다
17. 코드의 태그(판정 줄의 `no('[Rn.m]')`, 경계값 상수 줄 끝의 `// [R2.3]`)는 지우거나 옮기지 않는다. 판정하는 줄을 새로 쓰거나 바꿀 때도 product.md '태그'의 모양대로 둔다(예: `if (pw.length < MIN_PASSWORD_LENGTH) return no('[R2.3]')`) — guard가 이 태그로 요구사항과 코드 줄을 잇는다
