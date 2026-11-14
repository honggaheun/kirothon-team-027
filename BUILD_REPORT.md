# BUILD REPORT

이 레포에는 공지를 실행 계획으로 바꾸는 **LERO AI Agent**와, 개발 중 스펙 위반을 속성 검사로 찾는 **Kiro Power Tripwire**가 담겨 있다. Kiro CLI는 LERO의 `notice-execution` 스펙, 실제 Python 판정을 호출하는 속성 검사와 변형 구현, ICS 내보내기 기능을 만드는 데 사용했다. LERO의 API·인증·화면·외부 서비스 연동과 나머지 앱 구현·배포는 Codex가 담당했다. 설정·봉인 실행도 사용자의 명시적 위임 아래 Codex가 진행했다. 아래에 Kiro를 사용한 단계와 확인한 결과를 구체적으로 기록한다.

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
| 기획 | Specs (requirements, EARS) | guard를 스펙 4개로 나눴다 — guard-core(요구사항 4, 수용 기준 23), guard-check(9, 36), guard-serve(6, 22), stage-ui(10, 70) — 모두 151개. 수용 기준마다 ID(`R2.3`)를 붙여 검사·코드와 잇는다 | `.kiro/specs/*/requirements.md` |
| 기획 | Steering | 제품 규칙·구조·기술·guard 규칙(봉인된 검사는 고치지 않는다, 기준을 조용히 약화하지 않는다)을 항상 적용되는 문서로 | `.kiro/steering/` |
| 설계 | Specs (design) | 판정 규칙(빨강·노랑·초록), 데이터 계약(report.json·events.jsonl), hook 동작, 화면 배치를 설계 문서로 | `.kiro/specs/*/design.md` |
| 구현 | Specs (tasks) + Kiro CLI 에이전트 | tasks.md의 작업을 Kiro가 구현했다 — guard-core 5.5분, guard-check 8.6분, guard-serve 12.3분, 화면 58분(guard-serve와 동시에 진행). 끝난 뒤 guard 자체 검사 175개가 모두 통과했다 | `guard/`, `ui/`, `.kiro/specs/*/tasks.md` |
| 구현 | Kiro CLI 에이전트 | 예제 작업 공간의 가입 검증 코드(태그 줄 7개) | `demo/src/` |
| 검증 | Specs (tasks) | Kiro가 guard-core·guard-check의 작업 17개를 코드·검사와 하나씩 대조해 15개를 완료로 표시하고, 검사가 빠진 2개(scan 종료 코드, check 잠금 시간)를 찾아 검사를 더한 뒤 표시했다. guard-serve도 같은 방법으로 검사 2개를 더했다 | `.kiro/specs/*/tasks.md`, `guard/test/` |
| 검증 | Powers (property-tests · check-the-checks 스킬) | 예제의 수용 기준 6개마다 속성 검사를 만들고, 기준을 어긴 변형 13개를 모두 잡는지 확인한 뒤 사람이 봉인했다 | `demo/tests/`, `demo/mutants/`, `demo/.kiro/guard/sealed.json` |
| 검증 | Steering | 검사를 만들던 Kiro가 "판정 함수 외의 코드를 import하지 않는다" 규칙에 걸려 멈추고, 가입 상태를 만드는 준비 함수를 써도 되는지 사람에게 물었다. 허용한 뒤 진행했다 | `.kiro/steering/guard-rules.md` |
| 검증 | Hooks | 문지기(PreToolUse)와 쓰기 뒤 검사(PostToolUse)를 예제 작업 공간에 켰다. 사람이 비밀번호 최소 길이를 8에서 6으로 저장하자 수 초 안에 R2.3이 빨강이 됐고, 검사를 돌리려던 Kiro의 셸 실행이 막혔다. 사람이 '코드를 되돌린다'를 고르자 Kiro가 코드를 되돌렸고, 쓰기 뒤 검사가 초록으로 바꾸며 해결이 닫혔다 | `demo/.kiro/hooks/tripwire.json` |
| 기타 | Powers | guard 빌드와 화면을 파워에 묶고, 레포 밖 새 작업 공간에 설치했다. Kiro가 setup 스킬로 guard를 `.kiro/guard/bin/`에 복사하고 hook 6개를 깔았다(2.0분). 이어서 쓰기 하나와 셸 명령을 시키자, 쓰기·셸마다 hook이 그 guard를 불러 기록을 남겼다 | `power/tripwire/` |
### LERO AI Agent — 공지에서 실행 계획과 완료까지

| 단계 | 사용한 Kiro 기능 | 무엇을 했는지 | 결과물 위치 |
|---|---|---|---|
| 기획 | Kiro CLI · Specs(requirements) | 시작 날짜가 확인되지 않은 event를 거절하고, 한국 시각 심야 알림을 거절하는 두 수용 기준을 작성했다. 대상 규칙 외의 입력은 유효하게 고정한다는 검사 전제도 기록했다 | `app/.kiro/specs/notice-execution/requirements.md` |
| 설계 | Kiro CLI · Specs(design) | TypeScript에서 판정을 다시 만들지 않고, JSON 입력을 새 Python 프로세스에 전달해 실제 `chaenggim.rules.check(dict)` 결과를 받는 구조를 설계했다 | `app/.kiro/specs/notice-execution/design.md`, `app/scripts/python-predicate.ts`, `app/scripts/predicate_entry.py` |
| 구현 | Kiro CLI | Python 브리지, fast-check 속성 검사 2개, 규칙을 일부러 어기는 변형 3개를 만들었다 | `app/scripts/`, `app/tests/tripwire/`, `app/mutants/notice-execution/` |
| 구현 | Kiro CLI | 승인한 내부 event를 RFC 5545 ICS로 내보내는 순수 함수와 검사 9개를 구현했다. 승인·날짜 필터, UTC 변환, 텍스트 이스케이프, CRLF 주입 방지, 한글 75바이트 줄 접기를 다룬다 | `app/chaenggim/calendar_export.py`, `app/tests/test_calendar_export.py` |
| 검증 | Tripwire · guard adopt | `notice-execution:R1.1`에 변형 1개, `notice-execution:R2.1`에 변형 2개를 대조하고 두 기준을 채택·봉인했다. 설정과 봉인 명령은 사용자의 명시적 위임 아래 실행했다 | `app/.kiro/guard/sealed.json` |
| 기타 | Powers | `kiro-cli powers install`로 Tripwire Power를 설치했다. 앱의 스펙과 실제 판정 코드에 Power를 적용했다 | `power/tripwire/`, `app/.kiro/` |
| 검증 | Hooks · Steering | 실제 Kiro CLI에서 SessionStart, ICS 소스·단위 검사 쓰기, pytest 셸 실행, PostToolUse의 두 수용 기준 green 기록을 확인했다. LERO의 위반 후 후속 작업 차단 실증은 남아 있다 | `app/.kiro/`, `app/scripts/enable-tripwire.ps1` |

#### 두 속성 검사가 실제로 확인하는 것

| 스펙 수용 기준 | 검사 대상 | 변형 | 서버 규칙과의 관계 |
|---|---|---|---|
| `notice-execution:R1.1` | event의 `start=null`이면 등록 거절 | 누락된 시작 시각이 통과하도록 조건을 약화한 변형 1개 | `rules.check`의 날짜 유효성 검사. 거절 사유 코드는 `R5.1` |
| `notice-execution:R2.1` | KST 22:00 이상 또는 08:00 미만 알림 거절 | 허용 상한을 23시·24시로 옮긴 변형 2개 | `rules.check`의 알림 시간 검사. 거절 사유 코드는 `R8.1` |

스펙의 기준 ID와 서버의 사용자 안내용 거절 코드 ID는 별도 체계다. 속성 검사는 다른 필드가 유효한 입력에서 대상 조건을 바꾸며, 브리지는 판정을 추가하지 않는다. 매 호출마다 실제 Python 모듈을 실행하므로 소스 변형이 검사 대상에 반영된다.

`rules.check`는 사용자가 계획을 등록할 때 결정적으로 판정하는 서버 코드다. Tripwire는 개발 중 그 코드가 스펙을 벗어나게 바뀌는지 검사한다. 이번 LERO 적용에서 봉인한 범위는 위 두 기준이며, 소유권·승인·버전·중복·날짜·알림을 다루는 런타임 규칙 8개 전체를 봉인한 것은 아니다.

#### 확인한 결과와 남은 검증

| 항목 | 확인한 상태 | 해석 범위 |
|---|---|---|
| Power 설치 | Kiro CLI로 설치 실행 | 실제 설치 사용 기록 |
| 스펙·속성 검사·변형 | Kiro CLI가 파일 생성, 두 기준 채택·봉인 | 앱의 실제 Python 판정과 연결. 봉인된 검사 파일은 변경하지 않음 |
| 앱 Kiro hook 호출 | SessionStart·ICS 소스 쓰기·단위 검사 쓰기·pytest 셸·PostToolUse 두 기준 green 확인 | 실제 호출과 정상 판정 증거. LERO에서 위반 후 후속 작업 차단은 아직 실증 전 |
| ICS 기능 | Kiro CLI 구현 및 검사 9개 | 파일 내보내기 코드·검사 범위. Google Calendar 실계정 동기화 성공 증거와 구별 |
| 최신 백엔드 통합 검사 | 366개 통과 | 당일 전체 타임테이블·새 대화·자료 질문·외부 도구 경계 포함 |
| 봉인된 속성 검사 | 최종 제출본에서 두 수용 기준 통과(기준별 fast-check 100회) | 봉인 파일 해시 일치. 전체 런타임 규칙 봉인과 구별 |
| 프런트 문법 검사 | JavaScript 문법 검사와 v9 공식 URL 데모 통과 | 분석·승인·Calendar 9건 일괄 반영·오늘 일정 대화 브라우저 검증 |
| Tasks·Drive 어댑터 | 집중 pytest 65개 통과 | 모의 HTTP로 읽기 범위·소유권·응답 유실·용량·중복 방지 검사 |
| 실제 분석 입력 | 텍스트·이미지·[공식 공개 안내](https://kirothon.ausg.me) 분석 확인 | 해당 입력 사례의 성공. 일반 정확도 벤치마크로 확장하지 않음 |
| 로컬 UI | 미리보기·승인·저장·완료·캘린더 및 390px 모바일 스크린샷 확보 | 해당 로컬 브라우저 흐름의 증거 |
| 배포·공식 URL 분석 | v9에서 공식 KIROTHON 시간대 9개·할 일 2개 생성 | 지난 AI 준비 추천을 제외해 10개 승인. [분석 화면](docs/media/lero-plan.jpg) |
| 당일 Calendar 일괄 실행 | 성공 9건·실패 0건, 실제 Google Calendar 오늘 0→9개 확인 | [검증 전](docs/media/demo-calendar-before.jpg) · [반영 후](docs/media/demo-calendar-after.jpg) |
| 오늘 일정 대화 조회 | 정확한 질문에 오늘 9개와 KST HH:MM 시간 구간 응답. 대화 ID 새로고침 유지 | [대화 화면](docs/media/demo-calendar-chat.jpg) |
| Google 로그인·로그아웃 | 프로덕션 재로그인·로그아웃 성공 | 실제 브라우저 계정 흐름 확인 |
| Calendar·Tasks 실제 실행 | 테스트 일정·할 일 생성, 대화에서 완료 후 Tasks 반영 확인 | 테스트 자료·테스트 항목 범위의 실계정 성공 |
| Gmail OAuth·수동 수집 | 선택적 분류 추가 전 `subject:KIROTHON newer_than:30d`로 실제 메일 3건 → 초안 3개 확인 | 자동 수집 끔. 분류를 포함한 실제 메일 E2E는 대기 |
| Gmail 실행 필요성 분류 | Cloud AI의 선택적 분류를 연결하고 단위 검사 통과 | 설정한 검색 조건·새 메일 최대 10건 범위. 승인할 초안만 생성 |
| Drive 대화 가져오기 | 검색·파일 선택·가져오기·3개 항목 분석·승인 확인 | 공개 합성 테스트 자료로 실제 흐름 검증 |
| 자료 질문·새 대화 | 구현 및 단위 검사 통과 | v9 오늘 일정 조회 및 새로고침 후 대화 유지 확인 |
| Model Armor 입력 검사 | 미국 리전 PIJ 설정 및 인증 사용자의 한국어·영어 정상/공격 텍스트, 정상 PNG, 정상/공격 PDF 검사 확인 | 앱 런타임 서비스 계정에서 실제 정상 공지 ALLOW 후 분석 생성까지 확인. 런타임 공격 차단 시연은 별도 확인 |
| 검증용 원격 일정 정리 | 사용자가 승인한 검증 일정 9개의 ID·제목·출처를 확인하고 그 9개만 삭제. Google 화면 새로고침 후 오늘 0건 확인 | 사용자 Google 원본은 보존 |
| LERO 초기 상태 | 비공개 백업 후 자료 7·초안 7·항목 17·메일 중복 표식 3개를 각각 0건으로 정리. 자동 수집 끔·기본 검색 조건 복구·계정 세대 갱신 | 인증·서비스 연결·대화 유지. [정리 후 시작 화면](docs/media/lero-demo-ready.jpg) |
| Google 권한 공개 상태 | 외부 사용자용 프로덕션 공개 | 민감한 추가 권한의 Google 검증 완료는 주장하지 않음 |

## 개발 과정에서 바뀐 점

- 작업 완료 표시를 Kiro에게 맡겼다. 코드와 검사를 대조해 증거가 있는 작업만 체크하게 했더니, 검사가 빠진 작업을 Kiro가 스스로 찾아냈다.
- 파워 구현과 화면 구현을 Kiro 에이전트 두 개로 나눠 동시에 진행했다. 서로 다른 폴더(`guard/`, `ui/`)만 쓰게 하고, 커밋도 폴더별로 나눴다.

### LERO에서 바뀐 점

- 제품 범위를 행사 시간 추출에서 신청·제출·준비 업무의 실행 관리로 넓혔다. 항목 선택·수정과 명시적 승인 후 내부 일정·할 일을 만들고, 완료와 수정 공지 반영까지 연결했다.
- 사실과 추천을 `origin`으로 구분하고 원문 근거를 남겼다. 불확실한 날짜를 임의로 채우지 않고 질문으로 확인하도록 했다.
- 속성 검사가 실제 서버를 보호하도록 Python 브리지를 사용했다. TypeScript에 판정 함수를 따로 구현하면 두 코드가 달라질 수 있어, 실제 Python 결과를 검사했다.
- Kiro CLI에는 확인 가능한 독립 작업을 맡겼다. 스펙·속성 검사·변형과 ICS 기능을 결과 파일로 확인할 수 있다. 이를 앱 전체가 Kiro에서 작성됐다는 주장으로 확대하지 않는다.

## 어려웠던 점과 해결 방법

- 개발 의존 설치 중 npm 캐시 항목이 깨져 루트 설치가 실패했다. 캐시를 검증한 뒤 다시 설치하고, 레지스트리 서명을 확인했다.
- 에이전트 여러 개가 같은 저장소에서 동시에 일하면 한쪽의 중간 결과가 다른 쪽 커밋에 섞인다. 커밋할 때 그 작업의 경로만 담았다.

### LERO에서 해결한 문제

- **생성 응답만으로 실행이 끝났다고 볼 수 없다.** Google Tasks는 서버가 ID를 만들기 때문에 응답 유실 후 같은 요청을 다시 보내면 중복이 생길 수 있다. 고유 표식·생성 시도 기록·트랜잭션 claim을 남기고 원격 목록을 조회해 확인한다. 결과가 계속 불명확하면 충돌로 돌려주고 무조건 다시 만들지 않는다.
- **첨부 메타데이터와 실제 파일이 다를 수 있다.** Drive에서 지원 형식·용량을 먼저 확인하고, 실제 다운로드도 4MB에서 제한한다. PDF·이미지의 실제 바이트는 기존 입력 검사에 다시 통과시킨다. Drive 토큰은 서버에서만 사용한다.
- **탈퇴 중이던 네트워크 응답이 사용자 데이터를 되살릴 수 있다.** 비동기 호출 뒤 계정 세대와 최신 자료를 다시 확인하고, 이미 삭제된 문서를 이전 스냅샷으로 저장하지 않도록 처리했다. 관련 백엔드 검사는 통합 검증과 함께 확인한다.
- **설정 완료와 실제 동작 확인을 혼동하기 쉽다.** Power 설치, 검사 봉인, hook 설정, 실제 Kiro 차단, 클라우드 배포, 실계정 연동을 각각 구분해 기록한다. 아직 검증 중인 항목은 완료로 표시하지 않는다.
