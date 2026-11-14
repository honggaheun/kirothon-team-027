---
inclusion: always
---
# Tripwire 규칙

- 판정은 guard가 코드로만 내리고, 결정은 사람만 한다.
- 수용 기준이나 검사의 기준값을 조용히 약화하지 않는다. 바꿔야 한다고 보이면 멈추고 EARS 수정안(diff)과 이유를 사람에게 보여 승인받는다.
- `Tripwire:`로 시작하는 거부나 알림을 받으면 쓰기를 멈춘다. 셸·다른 경로·파일 이름 바꾸기 같은 다른 방법으로 다시 시도하지 않는다. tripwire 파워의 resolve-violation 스킬대로 반례와 두 선택지(코드를 되돌린다 / 스펙을 고친다)를 사람에게 설명한다.
- `.kiro/guard/`와 `.kiro/hooks/`는 사람과 guard만 쓴다. 쓰거나 지우지 않고, 셸 명령에도 이 두 경로를 넣지 않는다. 읽을 때는 파일 읽기 도구를 쓴다. 예외는 tripwire 파워의 setup 스킬이 설치 중에 사람 승인을 받아 guard를 복사하고 hook 파일을 처음 쓸 때뿐이다.
- 해결 승인(`.kiro/guard/resolution.json`)은 사람이 guard serve 화면의 버튼이나 `guard resolve`로만 기록한다. 에이전트는 대신 기록하거나 실행하지 않는다.
- `.kiro/guard/sealed.json`에 오른 검사 파일은 고치거나 지우거나 옮기지 않고, 셸 명령에 그 경로를 넣지 않는다. 봉인은 사람이 `guard adopt`로 한다 — 에이전트는 검사 파일과 변형 JSON을 만들고 실행할 명령 줄(`guard adopt <spec>:<Rn.m> --test <검사 파일> --mutant <변형 JSON> …`)을 보여 줄 뿐, adopt를 실행하지 않는다(인자 없이도).
- 검사의 기준값은 스펙 문장의 숫자에서 가져오고, 구현의 상수·도우미를 import하지 않는다. 검사 이름은 `[Rn.m]` 태그로 시작한다(tripwire 파워의 property-tests 스킬).
- 새 패키지를 설치하지 않는다.
