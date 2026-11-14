# Requirements Document

## Introduction

`guard check`는 작업 공간의 태그된 테스트를 실제로 실행하고 guard-core의 판정 규칙으로 `.kiro/guard/report.json`을 만든다. 실패한 속성 검사는 fast-check가 시험한 입력과 줄이기 경로를 반례 기록(`runs/`)으로 남기고, 봉인 검사가 바뀌거나 사라지거나 실행되지 않았는지 확인한다. 결과는 활동 기록(`events.jsonl`)과 에이전트 알림(stderr·세션 요약)으로 알린다.

`guard adopt`는 검사의 검사(요구사항을 일부러 어긴 변형 구현에서 실패하는지)를 통과한 테스트 파일을 봉인한다. 봉인은 신뢰를 주는 일이라 사람만 실행한다 — 에이전트의 `adopt` 실행은 guard-core 문지기가 막는다.

데이터 형식(index·report·resolution·sealed·events·runs)과 판정 순서는 guard-core 스펙을 따른다. 경로는 모두 작업 공간 루트(`--root`, 기본 현재 폴더) 기준이고, 설정은 `.kiro/guard/config.json`(design, 없으면 기본값)이다.

## Requirements

### Requirement 1

**User Story:** 개발자로서, 태그된 테스트가 실제로 실행된 결과로 판정받고 싶다.

#### Acceptance Criteria

1. WHEN `guard check`를 `--results` 없이 실행하면 THEN 시스템은 `<testDir>/node_modules/vitest/package.json`의 `bin`(문자열이면 그 값, 객체면 `vitest` 키)이 가리키는 파일을 현재 Node 실행 파일(`process.execPath`)로 셸 없이 직접 실행해야 하고, 인자는 `run --reporter=json --outputFile=<임시 파일> --passWithNoTests --testNamePattern <태그 정규식>`, 작업 폴더는 `<testDir>`이어야 한다(SHALL) — Windows에서 `.cmd` 파일은 셸 없이 실행할 수 없다
2. WHEN vitest가 실패한 테스트 때문에 0이 아닌 종료 코드로 끝나도 출력 JSON이 있으면 THEN 시스템은 그 JSON을 정상 결과로 판정에 써야 한다(SHALL)
3. WHEN vitest 출력 JSON이 없거나 JSON으로 읽을 수 없거나, 실행이 `timeoutSeconds`(기본 50초)를 넘어 프로세스를 끝냈거나, `<testDir>/node_modules/vitest`가 없으면 THEN 시스템은 색인의 모든 요구사항을 verdict red·reason `run-failed`·tests `[]`로 하고 원인 문장을 `runError`에 담은 report.json을 쓰고, events.jsonl에 `{"ts":"HH:MM:SS","action":"hook","target":"guard check · 실행 실패"}`를 덧붙이고, stderr에 원인을 쓴 뒤 종료 코드 1로 끝나야 한다(SHALL) — 테스트가 돌지 못한 상태를 이전 판정(초록)으로 남기지 않는다
4. WHEN `--results <file>`이 주어지면 THEN 시스템은 vitest를 실행하지 않고 그 파일을 vitest JSON 결과로 써야 하며, 그 파일이 없거나 JSON으로 읽을 수 없으면 3과 같이 처리해야 한다(SHALL)

### Requirement 2

**User Story:** 개발자로서, 판정과 함께 각 요구사항이 코드의 어느 줄과 이어지는지 받고 싶다.

#### Acceptance Criteria

1. WHEN check가 실행되면 THEN 시스템은 설정 `specsDir`(기본 `.kiro/specs`)를 guard-core scan 규칙으로 색인해 `.kiro/guard/index.json`에 쓰고, 결과를 guard-core judge 규칙으로 판정하되 gen-hashes와 broken-seals는 Requirement 4에서 가져와야 한다(SHALL)
2. WHEN 판정을 내지 못하면 — 색인이 실패했거나(한 스펙 안에 같은 ID 두 번, `specsDir`을 읽을 수 없음 등), sealed.json 항목의 연결 요구사항이 색인에 없거나(스펙 파일이나 기준 줄이 지워짐), 색인 뒤 판정·기록 중 예기치 못한 오류가 나면 — THEN 시스템은 직전 `.kiro/guard/index.json`의 모든 요구사항을 verdict red·reason `run-failed`·tests `[]`로 하고 원인 문장을 `runError`에 담은 report.json을 쓰고, runs 파일을 모두 지우고, events.jsonl에 1.3의 `guard check · 실행 실패` 한 줄을 덧붙이고, stderr에 원인을 쓴 뒤 종료 코드 1로 끝나야 하며, resolution.json은 바꾸지 않아야 하고, 색인이 실패했거나 봉인된 요구사항이 색인에 없을 때는 index.json도 바꾸지 않아야 한다(SHALL) — 검사하지 못한 상태를 이전 판정(초록)으로 남기지 않는다. 직전 index.json이 없거나 요구사항이 하나도 없으면 지킬 요구사항이 아직 없으므로 report·runs·events를 바꾸지 않고 stderr에 원인만 쓰고 종료 코드 1로 끝난다
3. WHEN 판정을 마치면 THEN 시스템은 judge 결과에 `generatedAt`(로컬 시각, 초 단위, 오프셋 포함 — 예 `2026-11-14T14:02:11+09:00`), `code`, `inputsHash`(Requirement 7)를 더해 키 순서 generatedAt·overall·requirements·orphans·summary·code·inputsHash로 `.kiro/guard/report.json`을 임시 파일에 쓴 뒤 이름 바꾸기로 교체해야 한다(SHALL)
4. WHEN `code`를 만들면 THEN 시스템은 설정 `sourceGlobs`(기본 `["src/**/*.ts"]`, design의 glob 규칙)에 맞는 파일 중 이름에 `.test.`·`.spec.`이 없고 `node_modules`·`.git`·`.kiro` 밖에 있는 파일의 각 줄(줄 끝 `\r` 제거)에서 judge와 같은 태그 정규식·해석 규칙으로 요구사항을 찾아, 해석된 ID가 하나 이상인 줄마다 `{ "n": 1부터 센 줄 번호, "text": 앞뒤 공백을 지운 줄, "links": 해석된 전체 ID(등장 순, 중복 제거) }`를 기록하고 해석되는 태그가 없는 줄은 빼야 한다(SHALL)
5. WHEN 태그 줄이 있는 파일이 여럿이면 THEN 시스템은 태그 줄이 가장 많은 파일(같으면 경로순 앞)을 `code.file`로 두고 그 파일의 줄을 줄 번호순으로 먼저, 나머지 파일의 줄을 경로순·줄 번호순으로 뒤에 두며 나머지 파일의 줄에만 `file`(루트 기준 상대 경로, `/` 구분)을 붙여야 하고, 태그 줄이 하나도 없으면 `code`는 `{ "file": null, "lines": [] }`여야 한다(SHALL)

### Requirement 3

**User Story:** 검토하는 사람으로서, 반례가 실제로 계산됐다는 기록(시험한 입력과 줄이기 경로)을 보고 싶다.

#### Acceptance Criteria

1. WHEN 요구사항이 red이고 그 counterexample을 가져온 첫 실패 테스트의 failureMessages(줄바꿈으로 이은 것)에 `Execution summary:` 줄이 있으면 THEN 시스템은 `.kiro/guard/runs/<spec>__<Rn.m>.json`(guard-core 4.1의 이름)에 키 순서 requirement·inputs·shrinkPath·counterexample의 객체를 임시 파일에 쓴 뒤 이름 바꾸기로 써야 한다(SHALL)
2. WHEN 실행 요약을 읽으면 THEN 시스템은 먼저 ANSI 색 코드(ESC `[` 숫자·`;` `m`)를 모두 지우고, `Execution summary:` 다음 줄부터 정규식 `^((?:\. )*)([√×]) (.*)$`에 맞는 줄만 읽어 `. ` 반복 횟수를 깊이로, `√`(U+221A)를 통과·`×`(U+00D7)를 실패로 봐야 하며, 값은 세 번째 묶음이 `[`로 시작하고 `]`로 끝나면 바깥 대괄호 한 쌍을 벗긴 문자열이어야 한다(SHALL)
3. WHEN inputs를 만들면 THEN 시스템은 깊이 0 줄을 나온 순서대로 `{ "v": 값, "ok": 통과면 true·실패면 false }`로 기록해야 한다(SHALL) — 그 수는 `failed after N tests`의 N과 같다
4. WHEN shrinkPath를 만들면 THEN 시스템은 마지막 깊이 0 실패 줄의 값에서 시작해 깊이 1, 2, …마다 그 깊이의 마지막 실패 줄의 값을 차례로 덧붙이고, 실패 줄이 없는 깊이에서 멈춰야 한다(SHALL) — 길이는 shrinks + 1, 마지막 값은 counterexample에서 바깥 대괄호를 벗긴 값과 같다
5. WHEN check를 마치면 THEN `.kiro/guard/runs/`에는 1에 해당하는 요구사항의 파일만 있어야 하고, red가 아니거나 실행 요약이 없는 요구사항의 기존 파일은 지워야 한다(SHALL)

### Requirement 4

**User Story:** 개발자로서, 에이전트가 봉인된 검사를 바꾸거나 지우거나 실행되지 않게 만들어 통과시키면 빨강으로 드러나길 원한다.

#### Acceptance Criteria

1. WHEN `.kiro/guard/sealed.json`이 있으면 THEN 시스템은 각 항목의 각 연결 요구사항에 대해 파일이 없으면 `missing`, 파일 바이트의 SHA-256(`sha256:<hex>`)이 항목의 `sha256`과 다르면 `changed`, 결과 중 파일 이름(`testResults[].name`을 정규화한 값)이 그 path와 같거나 `/<path>`로 끝나는 파일에서 그 요구사항으로 해석되는 태그를 단 passed·failed 테스트가 0개면 `not-run`을 이 순서로 판단해, 첫 문제를 `{ "path", "problem" }`으로 그 요구사항의 broken-seals 목록(sealed.json 순서)에 넣어야 한다(SHALL)
2. WHEN 봉인 항목에 `textHashes`가 있으면 THEN 시스템은 그 값을 gen-hashes로 써야 하고, 같은 ID에 여러 항목의 값이 있으면 색인의 textHash와 다른 값을 우선해야 한다(SHALL)
3. WHEN sealed.json이 없으면 THEN 시스템은 broken-seals·gen-hashes를 비워, 봉인 기능이 없을 때와 같은 판정을 내야 한다(SHALL)
4. WHEN sealed.json이 있는데 JSON으로 읽을 수 없으면 THEN 시스템은 종료 코드 1로 끝나고 stderr에 `unreadable`을 쓰며 출력 파일을 바꾸지 않아야 한다(SHALL) — 이때 문지기도 모든 쓰기를 막는다(guard-core 3.5)

### Requirement 5

**User Story:** 개발자로서, 검사가 언제 돌았고 결과가 어땠는지 활동 기록으로 보고, 위반이 생긴 순간 에이전트가 알게 하고 싶다.

#### Acceptance Criteria

1. WHEN check가 테스트 결과로 판정을 마치면(1.3·2.2의 실행 실패가 아니면) THEN 시스템은 events.jsonl에 `{"ts":"HH:MM:SS","action":"hook","target":"guard check · 빨강 <r> · 노랑 <y> · 초록 <g>"}` 한 줄을 덧붙여야 한다(SHALL) — 실행 실패면 1.3의 `guard check · 실행 실패` 한 줄만 쓴다
2. WHEN 이번 overall이 red이고 직전 report.json이 없거나 그 overall이 red가 아니면 THEN 시스템은 stderr에 `Tripwire: violated <항목>; <항목>. Further writes will be blocked until the user chooses: edit the spec or revert the code.`(항목 = guard-core gate의 빨강 메시지와 같은 `<id> (<근거>)`)를 써야 하고, 직전 overall이 red였고 이번이 red가 아니면 `Tripwire: no violated requirements now.`를 써야 하며, 판정 전환은 종료 코드를 바꾸지 않아야 한다(정상 실행이면 0, 실행 실패면 1.3·2.2대로 1)(SHALL) — PostToolUse는 막지 못하므로 알림만 한다
3. WHEN 2의 전환이 아니면 THEN 시스템은 stderr에 판정 알림을 쓰지 않아야 한다(SHALL)

### Requirement 6

**User Story:** 개발자로서, 문제가 풀리면 해결 승인이 저절로 닫혀 다음 위반 때 다시 사람이 고르게 하고 싶다.

#### Acceptance Criteria

1. WHEN resolution.json의 approved 항목의 요구사항이 이번 판정에서 green이거나 색인에 없으면 THEN 시스템은 그 항목을 approved에서 빼고 `closedAt`(로컬 시각, 오프셋 포함)을 붙여 `closed` 끝에 덧붙이고, events.jsonl에 Requirement 5.1의 줄 다음으로 `{"action":"hook","target":"해결 닫힘 · <ID>"}` 줄을 덧붙여야 한다(SHALL)
2. WHEN approved 항목의 요구사항이 red나 yellow면 THEN 시스템은 그 항목을 그대로 두어야 한다(SHALL)
3. WHEN resolution.json이 없으면 THEN 시스템은 그 파일을 만들지 않아야 한다(SHALL)

### Requirement 7

**User Story:** 개발자로서, 감시 대상 파일이 그대로면 셸 명령마다 테스트를 다시 돌리지 않고 싶다.

#### Acceptance Criteria

1. WHEN check가 실행되면 THEN 시스템은 테스트 실행 전에 감시 대상 — `specsDir` 아래 모든 파일, `testGlobs`·`sourceGlobs`에 맞는 파일, `<testDir>`의 `vitest.config.*`·`vitest.setup.*`·`package.json`, `.kiro/guard/sealed.json`·`.kiro/guard/config.json`(없는 것은 건너뛰고, glob으로 찾을 때 `node_modules`·`.git`·`.kiro` 폴더 안은 제외 — 이름을 적은 `.kiro/guard/` 두 파일과 `specsDir` 아래 파일은 그대로 포함) — 을 루트 기준 상대 경로(`/` 구분)의 코드포인트 순으로 정렬해 `<경로>\t<파일 바이트 SHA-256 소문자 hex>\n`을 이어 붙인 UTF-8 문자열의 SHA-256을 `inputsHash`(`sha256:<hex>`)로 계산해야 한다(SHALL)
2. WHEN `--if-changed`가 주어지고 report.json의 inputsHash가 1의 값과 같으면 THEN 시스템은 테스트를 실행하지 않고 어떤 파일도 쓰지 않으며 stderr에 아무것도 쓰지 않고 종료 코드 0으로 끝나야 하고, stdout에는 `--summary`가 함께 주어졌을 때만 기존 report.json으로 Requirement 8의 한 줄을 써야 한다(SHALL)
3. WHEN `--if-changed`가 주어지고 report.json이 없거나 inputsHash가 다르면 THEN 시스템은 평소처럼 check를 해야 한다(SHALL)

### Requirement 8

**User Story:** 에이전트를 쓰는 개발자로서, 세션이 시작될 때 에이전트가 현재 판정과 지켜야 할 것을 한 단락으로 알게 하고 싶다.

#### Acceptance Criteria

1. WHEN `--summary`가 주어지면 THEN 시스템은 check(해결 닫기 포함)를 마친 뒤 stdout에 design의 틀대로 영어 한 줄(끝에 줄바꿈 하나)을 써야 하고, 그 줄은 요구사항 수와 판정별 개수, red 요구사항 ID와 근거(red가 없으면 yellow ID와 reason), 봉인 파일 수, 승인된 해결 목록을 담아야 한다(SHALL)
2. WHEN `--summary`가 없으면 THEN 시스템은 stdout에 아무것도 쓰지 않아야 한다(SHALL)

### Requirement 9

**User Story:** 개발자로서, 요구사항을 일부러 어긴 변형 구현을 잡는 검사만 봉인해 감시 대상으로 삼고 싶다.

#### Acceptance Criteria

1. WHEN `guard adopt <요구사항> --test <검사 파일> --mutant <변형 파일> [--mutant <변형 파일> …]`을 실행하면 THEN 시스템은 `.kiro/guard/adopt.lock`을 배타적으로 만들어야 하고(이미 있으면 종료 코드 1), 시작할 때 `.kiro/guard/mutant-backup/`에 남은 파일이 있으면 원래 경로로 되돌리고 stderr에 알려야 하며, 어떻게 끝나든 lock을 지워야 하고, 인자가 빠지면 사용법과 함께 종료 코드 64로 끝나야 한다(SHALL)
2. WHEN 변형 없이 그 검사 파일만 실행하면(Requirement 1.1의 실행에 파일 경로 인자를 더함) THEN 시스템은 그 파일의 태그 달린 passed·failed 테스트가 1개 이상이고, 모두 passed이며, 태그가 모두 그 요구사항(judge 해석 규칙)으로 해석될 때만 계속해야 하고 아니면 종료 코드 1로 끝나야 한다(SHALL) — 봉인은 파일 단위라 검사 파일 하나에 수용 기준 하나만 둔다
3. WHEN 변형 파일을 읽으면 THEN 시스템은 각 파일이 JSON `{ "requirement", "file", "find", "replace", "why"(선택) }`이고, requirement가 그 요구사항으로 해석되며, `find`가 `file`에 정확히 한 번 나올 때만 받아야 하고, 하나라도 어기면 아무것도 바꾸지 않고 종료 코드 1로 끝나야 한다(SHALL)
4. WHEN 변형 하나를 시험하면 THEN 시스템은 대상 파일을 mutant-backup에 복사하고 `find`를 `replace`로 바꿔 쓴 뒤 그 검사 파일만 실행하고, 결과·예외와 무관하게 원본 바이트로 되돌려 SHA-256으로 복원을 확인한 뒤 백업을 지워야 하며, 그 요구사항으로 해석되는 테스트 중 failed가 하나 이상일 때만 그 변형을 잡은 것으로 봐야 한다(SHALL) — 테스트 결과가 나오지 않는 변형(모듈 로드 실패)은 잡은 것이 아니다
5. WHEN 모든 변형을 잡으면 THEN 시스템은 sealed.json에서 같은 path의 항목을 `{ "path", "sha256", "requirements": [그 요구사항], "textHashes"(현재 색인 값), "sealedAt" }`으로 바꾸거나 끝에 덧붙이고, events.jsonl에 `{"action":"human","target":"검사 봉인 · <path> (<ID>)"}`를 덧붙이고, stdout에 `sealed <path> for <ID> (<n> mutants caught)`를 쓰고, lock을 지운 뒤 check를 한 번 실행하고 종료 코드 0으로 끝나야 한다(SHALL)
6. WHEN 잡지 못한 변형이 하나라도 있으면 THEN 시스템은 sealed.json을 바꾸지 않고 stderr에 잡지 못한 변형마다 `mutant survived: <ID> (<변형 파일>)`를 쓴 뒤 종료 코드 1로 끝나야 한다(SHALL)
7. WHEN check가 실행될 때 `.kiro/guard/adopt.lock`이 있으면 THEN check는 테스트를 실행하지 않고 어떤 파일도 쓰지 않으며 stderr에 `adopt in progress`를 쓰고 종료 코드 0으로 끝나야 한다(SHALL) — 변형이 심긴 코드로 판정하지 않기 위해
