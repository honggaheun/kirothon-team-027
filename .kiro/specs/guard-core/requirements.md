# Requirements Document

## Introduction

guard는 Kiro 스펙(requirements.md)과 테스트 결과를 비교해 요구사항별 판정을 내리고, 에이전트의 쓰기를 허용하거나 막는 CLI다. 판정은 결정적이며 AI를 쓰지 않는다.

이 스펙은 핵심 하위 명령 `scan`·`judge`·`gate`와 `.kiro/guard/` 데이터 계약을 다룬다. `check`·`adopt`는 guard-check 스펙, `serve`·`resolve`는 guard-serve 스펙이 다룬다.

용어

- 봉인 검사: 검사의 검사(요구사항을 일부러 어긴 변형 구현에서 실패하는지)를 통과해 `.kiro/guard/sealed.json`에 경로·내용 해시·연결 요구사항이 기록된 테스트 파일. 에이전트는 봉인 검사를 바꿀 수 없다
- 해결 승인: 사람이 고른 "코드를 되돌린다(`revert-code`)" 또는 "스펙을 고친다(`edit-spec`)". `.kiro/guard/resolution.json`의 `approved`에 기록된다
- 정규화(경로·명령): `\`를 `/`로 바꾸고 소문자로 만든 뒤 맨 앞의 `./`를 지운 문자열

## Requirements

### Requirement 1

**User Story:** 개발자로서, 스펙에서 요구사항 ID 색인을 얻고 싶다.

#### Acceptance Criteria

1. WHEN `guard scan --specs <dir> --out <file>`을 실행하면 THEN 시스템은 `<dir>/<spec>/requirements.md`마다 `Requirement N`(또는 `요구사항 N`) 제목 아래 `Acceptance Criteria`(또는 `수용 기준`) 제목 다음 번호 목록의 m번째 항목을 ID `RN.m`으로 색인해 JSON으로 써야 하며, 제목의 `#` 개수(2~5)와 영문 대소문자는 따지지 않아야 한다(SHALL)
2. WHEN 수용 기준 문장을 색인하면 THEN 시스템은 앞뒤 공백을 지우고 연속 공백을 하나로 줄인 문장을 text로, 그 UTF-8 바이트의 SHA-256을 `sha256:<소문자 hex>`로 textHash에 기록해야 한다(SHALL)
3. WHEN 한 스펙 안에서 같은 ID가 두 번 나오면 THEN 시스템은 종료 코드 1로 끝나고 중복 ID를 stderr에 써야 한다(SHALL)
4. WHEN 정규화한 문장에서 마지막 `(근거:`부터 문장 끝까지가 하나의 괄호 묶음이면(그 구간에서 `(`와 `)`의 수가 같고, 끝의 `)` 앞에서는 괄호 깊이가 0이 되지 않으면) THEN 시스템은 그 `(근거:` 바로 뒤부터 끝의 `)` 앞까지를 앞뒤 공백을 지워 `basis`로 기록해야 하고(예: `… 거절해야 한다(SHALL) (근거: 개인정보 보호법 제22조의2 제1항)` → `개인정보 보호법 제22조의2 제1항`, 근거 안의 짝 맞는 괄호는 그대로 둔다), text·textHash는 근거를 포함한 문장 그대로 계산해야 하며, 조건에 맞지 않거나(문장 중간에서 `(근거:`를 언급한 경우 포함) 근거 내용이 비면 `basis` 키를 쓰지 않아야 한다(SHALL)

### Requirement 2

**User Story:** 개발자로서, 테스트 결과로 요구사항별 판정을 받고 싶다.

#### Acceptance Criteria

1. WHEN `guard judge`를 실행하면 THEN 시스템은 vitest JSON의 `testResults[].assertionResults[].title`에서 `[RN.m]` 또는 `[spec:RN.m]` 태그를 모두 찾아 요구사항과 연결해야 하고, 짧은 태그는 그 ID를 가진 스펙이 정확히 하나일 때만 연결해야 하며, status가 `passed`·`failed`인 결과만 연결된 테스트로 세야 한다(`skipped`·`pending`·`todo` 등은 세지 않는다)(SHALL)
2. WHEN broken-seals 입력에 그 요구사항 ID가 있으면 THEN 시스템은 테스트 결과와 무관하게 verdict red, reason `seal-broken`을 내고 그 항목 목록을 `brokenSeals`로 기록해야 하며 counterexample·runs·shrinks는 쓰지 않아야 한다(SHALL)
3. WHEN 2에 해당하지 않고 연결된 테스트 중 하나라도 status가 failed면 THEN verdict는 red, reason은 test-failed여야 하고, 첫 실패 테스트의 failureMessages에서 `Counterexample: ` 뒤부터 줄 끝까지를 counterexample로, `failed after N tests`의 N을 runs로 기록하되 해당 문구가 없으면 그 키를 쓰지 않아야 하며, `Shrunk N time`의 N을 shrinks로(없으면 0) 기록해야 한다(SHALL)
4. WHEN 2·3에 해당하지 않고 연결된 테스트가 0개면 THEN verdict는 yellow, reason은 no-tests여야 한다(SHALL)
5. WHEN 2~4에 해당하지 않고 gen-hashes에 그 요구사항 ID가 있으며 값이 색인의 textHash와 다르면 THEN verdict는 yellow, reason은 stale이어야 한다(SHALL)
6. WHEN 2~5에 해당하지 않으면(연결된 테스트가 1개 이상이고 모두 passed) THEN verdict는 green, reason은 all-passed여야 한다(SHALL)
7. WHEN 태그가 어떤 스펙에도 없는 ID이거나 짧은 태그가 여러 스펙에 걸리면 THEN 시스템은 태그 문자열(대괄호 제외)을 orphans에 넣어야 한다(SHALL)
8. WHEN 판정을 마치면 THEN overall은 red가 하나라도 있으면 red, 아니면 yellow가 있으면 yellow, 아니면 green이어야 하고 summary에 판정별 개수를 써야 한다(SHALL)

### Requirement 3

**User Story:** 개발자로서, 스펙을 어긴 상태이거나 에이전트가 봉인 검사·승인 기록을 건드리려 할 때 그 쓰기를 막고 싶다.

#### Acceptance Criteria

1. WHEN `guard gate`가 stdin으로 이벤트 JSON을 받으면 THEN 시스템은 맨 앞의 UTF-8 BOM(EF BB BF)을 떼고 파싱해야 하고, `tool_input`에서 path, file_path, filePath, target_file, file 순서로 처음 발견되는 문자열 값을 대상 경로로 쓰며, 그런 키가 없고 `command` 문자열이 있으면 그것을 대상 명령으로 써야 하고, 파싱에 실패하면 대상 경로·명령을 빈 문자열로 봐야 한다(SHALL)
2. WHEN `--report`가 없으면(작업 공간 모드) THEN 시스템은 `<root>/.kiro/guard/`(`--root`, 기본 현재 폴더)의 `report.json`·`resolution.json`·`sealed.json`을 읽어야 하고, `--report`가 있으면(파일 모드) 명시된 파일만 읽어야 한다(SHALL)
3. WHEN 정규화한 대상 경로가 `.kiro/guard/`·`.kiro/hooks/`로 시작하거나 `/.kiro/guard/`·`/.kiro/hooks/`를 포함하면, 또는 정규화한 대상 명령이 `.kiro/guard`나 `.kiro/hooks`를 포함하면 THEN 시스템은 다른 모든 규칙보다 먼저 종료 코드 2로 끝나고 stderr에 `Tripwire: .kiro/guard/ and .kiro/hooks/ are reserved for the user.`를 써야 한다(SHALL)
4. WHEN 3에 해당하지 않고 정규화한 대상 명령이 `/api/resolve`를 포함하거나, 대상 명령의 토큰 중 guard 실행 토큰(design의 정의) 바로 다음 토큰이 `resolve` 또는 `adopt`이거나, guard 실행 토큰 바로 다음 토큰이 `check`이고 그 뒤에 `--results` 또는 `--results=`로 시작하는 토큰이 있으면 THEN 시스템은 종료 코드 2로 끝나고 stderr에 `reserved`와 `guard resolve`를 포함한 메시지를 써야 한다(SHALL) — 해결 승인·검사 봉인·판정 입력 바꿔치기는 사람만 한다
5. WHEN 3·4에 해당하지 않고 report나 sealed 파일이 있는데 JSON으로 읽을 수 없으면 THEN 시스템은 종료 코드 2로 끝나고 stderr에 `unreadable`을 포함한 메시지를 써야 하며, 파일이 없으면 report는 빨강 없음, sealed는 봉인 없음, resolution은 승인 없음으로 봐야 한다(resolution을 읽을 수 없을 때도 승인 없음)(SHALL)
6. WHEN 3~5에 해당하지 않고 정규화한 대상 경로가 sealed 항목의 정규화한 path와 같거나 `/<path>`로 끝나면, 또는 정규화한 대상 명령이 그 path를 포함하면 THEN 시스템은 그 항목의 requirements 모두에 choice `edit-spec`인 승인이 있지 않는 한 종료 코드 2로 끝나고 stderr에 `sealed`와 그 path·요구사항 ID를 포함한 메시지를 써야 한다(SHALL)
7. WHEN 3~6에 해당하지 않고 report의 overall이 red이며 red인 요구사항 중 resolution의 approved에 없는 것이 하나라도 있으면 THEN 시스템은 종료 코드 2로 끝나고 그 ID들과 각자의 근거(counterexample, seal-broken이면 봉인 path와 문제, 둘 다 아니면 reason)를 포함한 메시지를 stderr에 써야 한다(SHALL)
8. WHEN 3~7에 해당하지 않으면 THEN 시스템은 종료 코드 0으로 끝나고 stderr에 아무것도 쓰지 않아야 한다(SHALL)
9. WHEN 같은 입력(stdin 바이트와 읽는 파일 내용)으로 여러 번 실행하면 THEN 시스템은 항상 같은 종료 코드와 같은 stderr를 내야 하며, 맨 앞의 BOM 유무만 다른 두 입력에도 같은 결과를 내야 한다(SHALL)
10. WHEN 작업 공간 모드이고 `<root>/.kiro/guard/` 폴더가 있으면, 또는 `--events <file>`이 주어지면 THEN 시스템은 결정 뒤 events 파일에 design 형식의 한 줄을 덧붙여야 하되(허용이면서 대상 경로·명령이 없으면 쓰지 않는다), 파일 모드에서 `--events`가 없으면 어떤 파일도 쓰지 않아야 하며, 기록 실패는 종료 코드·stderr에 영향을 주지 않아야 한다(SHALL)

### Requirement 4

**User Story:** 개발자로서, guard가 만드는 기록 파일 이름이 Windows에서도 그대로 보이길 원한다.

#### Acceptance Criteria

1. WHEN 요구사항 전체 ID(`spec:RN.m`)로 반례 기록 파일 이름을 만들면 THEN 시스템은 `:`를 `__`로 바꾸고 `.json`을 붙여 `.kiro/guard/runs/` 아래 이름으로 써야 하며(예: `signup:R2.3` → `signup__R2.3.json`), 결과 이름에 `<`·`>`·`:`·`"`·`/`·`\`·`|`·`?`·`*` 문자가 없어야 하고 서로 다른 ID는 서로 다른 이름이 되어야 한다(SHALL) — Windows는 `signup:R2.3.json`을 파일 `signup`의 대체 데이터 스트림으로 해석한다
