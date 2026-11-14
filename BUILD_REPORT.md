# BUILD REPORT

이 레포에서 Kiro는 두 가지로 쓰였다.

1. **만든 것: Kiro Power — Tripwire.** Kiro의 Specs·Hooks·Steering·Powers 위에서 동작하는 파워를 만들었다(`power/tripwire/`).
2. **만드는 방법: 개발 과정 전체를 Kiro로.** 파워와 AI 에이전트(캡처한 공지를 일정과 할 일로 처리)의 기획·설계·구현·검증을 Kiro 스펙과 Kiro 에이전트로 진행했고, 그 결과물이 `.kiro/`에 남아 있다.

---

## 1. 만든 Kiro Power — Tripwire

| 항목 | 내용 | 위치 |
|---|---|---|
| 무엇 | 스펙의 수용 기준(EARS)을 fast-check 속성 검사로 실행해, 코드나 에이전트가 기준을 어기는 순간 반례로 잡고 Kiro의 다음 작업을 막는 파워 | `power/tripwire/plugin.json` |
| 스킬 5개 | setup(작업 공간에 guard·steering·hook 설치) · rule-intake(한 문장 규칙 → 수용 기준) · property-tests(수용 기준 → 속성 검사) · check-the-checks(변형 구현으로 검사의 검사) · resolve-violation(위반 때 반례와 선택지 설명) | `power/tripwire/skills/` |
| guard CLI | `scan`·`check`·`gate`·`adopt`·`resolve`·`serve`. Node 내장 모듈만 쓴다 | `guard/src/`, 파워 안 번들 `power/tripwire/skills/setup/scripts/guard/` |
| Kiro와 맞물리는 곳 | PreToolUse hook = 문지기(빨강이면 종료 코드 2로 쓰기·셸 차단), PostToolUse hook = 쓰기 뒤 검사, SessionStart hook = 판정 요약, Steering = 봉인·결정 규칙 | `.kiro/hooks/`, `hooks-variants/`, `.kiro/steering/guard-rules.md` |
| 화면 | 수용 기준과 코드 줄을 실로 잇고, 반례·차단·사람의 결정을 보여 주는 `guard serve` 화면 | `ui/` |
| 확인한 동작 | 예제 작업 공간에서 수용 기준 6개를 봉인하고, 기준을 어긴 저장 → 반례 → Kiro 차단 → 사람의 결정 → 복구까지 확인했다. 레포 밖 새 작업 공간에도 파워만으로 설치됐다 | `demo/`, `power/tripwire/` |

---

## 2. Kiro 활용 내역

### Kiro Power — Tripwire

시간은 Kiro CLI 실행 기록에서 옮겼다.

| 단계 | 사용한 Kiro 기능 | 무엇을 했는지 | 결과물 위치 |
|---|---|---|---|
| 기획 | Specs (requirements, EARS) | guard를 스펙 4개로 나눴다 — guard-core(요구사항 4, 수용 기준 23), guard-check(9, 36), guard-serve(6, 22), stage-ui(10, 80). 수용 기준마다 ID(`R2.3`)를 붙여 검사·코드와 잇는다 | `.kiro/specs/*/requirements.md` |
| 기획 | Steering | 제품 규칙·구조·기술·guard 규칙(봉인된 검사는 고치지 않는다, 기준을 조용히 약화하지 않는다)을 항상 적용되는 문서로 | `.kiro/steering/` |
| 설계 | Specs (design) | 판정 규칙(빨강·노랑·초록), 데이터 계약(report.json·events.jsonl), hook 동작, 화면 배치를 설계 문서로 | `.kiro/specs/*/design.md` |
| 구현 | Specs (tasks) + Kiro CLI 에이전트 | tasks.md의 작업을 Kiro가 구현했다 — guard-core 5.5분, guard-check 8.6분, guard-serve 12.3분, 화면 58분(Claude Opus 5.5 high, guard-serve와 동시에 진행). 끝난 뒤 guard 자체 검사 175개가 모두 통과했다 | `guard/`, `ui/`, `.kiro/specs/*/tasks.md` |
| 구현 | Kiro CLI 에이전트 | 예제 작업 공간의 가입 검증 코드(태그 줄 7개) | `demo/src/` |
| 검증 | Specs (tasks) | Kiro가 guard-core·guard-check의 작업 17개를 코드·검사와 하나씩 대조해 15개를 완료로 표시하고, 검사가 빠진 2개(scan 종료 코드, check 잠금 시간)를 찾아 검사를 더한 뒤 표시했다. guard-serve도 같은 방법으로 검사 2개를 더했다 | `.kiro/specs/*/tasks.md`, `guard/test/` |
| 검증 | Powers (property-tests · check-the-checks 스킬) | 예제의 수용 기준 6개마다 속성 검사를 만들고, 기준을 어긴 변형 13개를 모두 잡는지 확인한 뒤 사람이 봉인했다 | `demo/tests/`, `demo/mutants/`, `demo/.kiro/guard/sealed.json` |
| 검증 | Steering | 검사를 만들던 Kiro가 "판정 함수 외의 코드를 import하지 않는다" 규칙에 걸려 멈추고, 가입 상태를 만드는 준비 함수를 써도 되는지 사람에게 물었다. 허용한 뒤 진행했다 | `.kiro/steering/guard-rules.md` |
| 검증 | Hooks | 문지기(PreToolUse)와 쓰기 뒤 검사(PostToolUse)를 예제 작업 공간에 켰다. 사람이 비밀번호 최소 길이를 8에서 6으로 저장하자 수 초 안에 R2.3이 빨강이 됐고, 검사를 돌리려던 Kiro의 셸 실행이 막혔다. 사람이 '코드를 되돌린다'를 고르자 Kiro가 코드를 되돌렸고, 쓰기 뒤 검사가 초록으로 바꾸며 해결이 닫혔다 | `demo/.kiro/hooks/tripwire.json` |
| 기타 | Powers | guard 빌드와 화면을 파워에 묶고, 레포 밖 새 작업 공간에 설치했다. Kiro가 setup 스킬로 guard를 `.kiro/guard/bin/`에 복사하고 hook 6개를 깔았다(2.0분). 이어서 쓰기 하나와 셸 명령을 시키자, 쓰기·셸마다 hook이 그 guard를 불러 기록을 남겼다 | `power/tripwire/` |
### AI 에이전트 — 캡처한 공지를 일정과 할 일로

| 단계 | 사용한 Kiro 기능 | 무엇을 했는지 | 결과물 위치 |
|---|---|---|---|
| 기획 | <!-- 예: Spec (requirements) --> | | |
| 설계 | | | |
| 구현 | | | |
| 검증 | | | |
| 기타 | <!-- Steering, Hooks, MCP, Tripwire 적용 등 --> | | |

## 개발 과정에서 바뀐 점

- 작업 완료 표시를 Kiro에게 맡겼다. 코드와 검사를 대조해 증거가 있는 작업만 체크하게 했더니, 검사가 빠진 작업을 Kiro가 스스로 찾아냈다.
- 파워 구현과 화면 구현을 Kiro 에이전트 두 개로 나눠 동시에 진행했다. 서로 다른 폴더(`guard/`, `ui/`)만 쓰게 하고, 커밋도 폴더별로 나눴다.

## 어려웠던 점과 해결 방법

- 개발 의존 설치 중 npm 캐시 항목이 깨져 루트 설치가 실패했다. 캐시를 검증한 뒤 다시 설치하고, 레지스트리 서명을 확인했다.
- 에이전트 여러 개가 같은 저장소에서 동시에 일하면 한쪽의 중간 결과가 다른 쪽 커밋에 섞인다. 커밋할 때 그 작업의 경로만 담았다.
