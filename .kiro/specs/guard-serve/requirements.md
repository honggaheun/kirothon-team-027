# Requirements Document

## Introduction

`guard serve`는 스펙 실 화면(`ui/` 정적 파일)을 이 컴퓨터에서만 제공하고, `.kiro/guard/`의 색인·판정·승인·봉인·활동·반례 기록이 바뀌면 화면으로 밀어 보낸다(SSE). 사람이 편집기에서 저장한 변경에는 hook이 돌지 않으므로 파일 감시로 `guard check`를 돌린다(막지 않고 화면에 경고로 보인다).

해결 승인("코드를 되돌린다 `revert-code`" / "스펙을 고친다 `edit-spec`")은 사람만 기록한다 — 화면 버튼(`POST /api/resolve`) 또는 터미널의 `guard resolve`. 에이전트가 셸로 이 둘을 부르는 것은 guard-core 문지기가 막는다(요구사항 3.4).

기록할 수 있는 요구사항은 현재 report.json에서 red인 요구사항이고, 선택이 `edit-spec`이면 verdict yellow·reason `stale`인 요구사항도 포함한다. 사람이 봉인된 요구사항의 문장을 고치면 그 요구사항은 stale(노랑)이 되는데, 봉인 검사를 다시 만들려면 그 요구사항에 edit-spec 승인이 있어야 하기 때문이다(guard-core 3.6). 승인은 그 요구사항이 green이 될 때 guard check가 닫는다(guard-check 6.1).

데이터 형식은 guard-core 데이터 계약, 감시 대상과 설정 파일(`.kiro/guard/config.json`)은 guard-check 설정을 따른다. 경로는 작업 공간 루트(`--root`, 기본 현재 폴더) 기준이다.

## Requirements

### Requirement 1

**User Story:** 사용자로서, 브라우저 하나로 스펙 실 화면을 열고 싶다.

#### Acceptance Criteria

1. WHEN `guard serve [--root <dir>] [--port <n>] [--ui <dir>]`를 실행하면 THEN 시스템은 `127.0.0.1`의 `<n>`(기본 4848) 포트에서만 연결을 받고 stdout에 `http://127.0.0.1:<n>/`을 써야 하며, 그 포트를 쓸 수 없으면 stderr에 이유를 쓰고 종료 코드 1로 끝나야 한다(SHALL)
2. WHEN `GET /` 또는 `GET /<경로>`를 받으면 THEN 시스템은 화면 폴더(`--ui`, 기본 = CLI 파일과 같은 폴더의 `ui/`가 있으면 그것, 없으면 CLI 파일 기준 `../../ui`)의 `index.html` 또는 그 파일을 확장자에 맞는 Content-Type(`.html`·`.js`·`.css`·`.json`·`.svg`·`.png`·`.woff2`)으로 보내야 하고, 경로를 풀었을 때 화면 폴더 밖이면(`..` 포함) 404를 보내야 한다(SHALL)
3. WHEN `GET /data/<이름>`을 받으면 THEN 시스템은 이름이 `index.json`·`report.json`·`resolution.json`·`sealed.json`·`events.jsonl`·`runs/<spec>__<Rn.m>.json` 중 하나일 때만 `<root>/.kiro/guard/<이름>`을 `Cache-Control: no-store`로 보내고, 그 밖의 이름이나 없는 파일은 404를 보내야 한다(SHALL)

### Requirement 2

**User Story:** 사용자로서, 판정·활동·반례가 바뀌는 순간 화면이 저절로 갱신되길 원한다.

#### Acceptance Criteria

1. WHEN `GET /api/stream`을 받으면 THEN 시스템은 `Content-Type: text/event-stream`으로 연결을 열고 곧바로 있는 파일마다 `index`·`report`·`resolution`·`sealed` 이벤트(데이터 = 파일 JSON), runs 파일마다 `runs` 이벤트(데이터 = `{"name","data"}`), events.jsonl의 마지막 50줄을 담은 `events-reset` 이벤트(데이터 = 객체 배열, 파일이 없으면 빈 배열)를 보내야 한다(SHALL)
2. WHEN index·report·resolution·sealed 파일이 바뀌면 THEN 시스템은 1초 안에 열린 모든 연결에 그 이벤트를 보내야 한다(SHALL)
3. WHEN events.jsonl에 줄이 덧붙으면 THEN 시스템은 1초 안에 새로 덧붙은 완전한 줄만 담은 `events` 이벤트를 보내야 하고, 파일이 마지막으로 보낸 위치보다 짧아지거나 없어지면 1초 안에 마지막 50줄(없으면 빈 배열)을 담은 `events-reset` 이벤트(데이터 = 객체 배열)를 보내야 한다(SHALL) — 화면은 `events`를 목록 끝에 덧붙이고 `events-reset`으로 목록을 갈아 끼운다(stage-ui). events.jsonl을 옮기거나 지운 뒤에도 옛 줄이 남지 않는다
4. WHEN runs 파일이 생기거나 바뀌거나 지워지면 THEN 시스템은 1초 안에 `runs` 이벤트(지워졌으면 data는 null)를 보내야 한다(SHALL)
5. WHEN 연결이 열려 있으면 THEN 시스템은 15초마다 주석 줄 `: ping`을 보내야 한다(SHALL)
6. WHEN 바뀐 파일을 JSON으로 읽을 수 없으면 THEN 시스템은 그 이벤트를 보내지 않고 다음 변경 때 다시 읽어야 한다(SHALL)

### Requirement 3

**User Story:** 사용자로서, 내가 편집기에서 직접 저장한 변경도 검사되어 화면에 경고로 보이길 원한다.

#### Acceptance Criteria

1. WHEN guard-check의 감시 대상(`specsDir` 아래 파일, `testGlobs`·`sourceGlobs`에 맞는 파일, vitest 설정 파일) 중 하나의 내용이 바뀌거나 그 파일이 없어지면 THEN 시스템은 300ms 동안 더 바뀌지 않기를 기다린 뒤, 최근 10초 안의 events.jsonl에 그 파일의 루트 기준 상대 경로와 같은 target의 `write` 줄도 `shell` 줄도 없을 때만 사람 저장으로 보고 `{"ts":"HH:MM:SS","action":"save","target":"<상대 경로> · 사람 저장"}`을 덧붙인 뒤 `check --if-changed`를 같은 Node·같은 CLI 파일로 자식 프로세스로 실행해야 한다(SHALL) — 에이전트의 쓰기는 hook이 이미 검사한다. 폴더의 변경 이벤트와 내용이 그대로인 파일의 이벤트는 저장이 아니다(파일을 읽기만 해도 Windows는 그 파일과 폴더의 이벤트를 낸다)
2. WHEN check 자식 프로세스가 도는 중에 또 사람 저장이 오면 THEN 시스템은 동시에 둘을 돌리지 않고, 끝난 뒤 한 번만 더 실행해야 한다(SHALL)
3. WHEN `.kiro/guard/adopt.lock`이 있거나 사라진 지 2초가 안 됐으면 THEN 시스템은 그동안의 파일 변경으로 save 줄을 쓰거나 check를 실행하지 않아야 한다(SHALL) — adopt가 변형을 심었다 되돌리는 변경이고, adopt가 끝에 check를 돌린다

### Requirement 4

**User Story:** 사용자로서, 위반이 나면 화면 버튼으로 "코드를 되돌린다"·"스펙을 고친다"를 골라 기록하고 싶다.

#### Acceptance Criteria

1. WHEN `POST /api/resolve`를 받으면 THEN 시스템은 요청의 원격 주소가 `127.0.0.1`·`::1`·`::ffff:127.0.0.1` 중 하나이고 `Origin` 헤더가 `http://127.0.0.1:<port>` 또는 `http://localhost:<port>`일 때만 처리하고, 아니면 403을 보내야 한다(SHALL)
2. WHEN 본문이 4KB 이하의 JSON `{"choice":"revert-code"|"edit-spec","requirement":"<전체 ID>"(선택)}`이 아니면 THEN 시스템은 400을 보내야 하고, requirement가 있는데 그 요구사항이 그 choice로 기록할 수 있는 요구사항(현재 report.json에서 red, 또는 choice가 `edit-spec`일 때 reason이 `stale`인 yellow)이 아니거나 requirement가 없는데 red 요구사항이 하나도 없으면 409를 보내야 한다(SHALL) — requirement가 없으면 대상은 현재 red 전부다(3)
3. WHEN 1·2를 통과하면 THEN 시스템은 대상(requirement가 있으면 그것, 없으면 현재 red 요구사항 전부)마다 resolution.json의 approved에서 같은 요구사항 항목을 빼고 `{"requirement","choice","by":"human","approvedAt":<로컬 시각, 오프셋 포함>}`를 끝에 덧붙여 원자적으로 저장하고, 대상마다 events.jsonl에 `{"action":"human","target":"<ID> · 코드를 되돌린다 승인"}`(edit-spec이면 `<ID> · 스펙을 고친다 승인`)을 덧붙이고, 200과 새 resolution JSON을 보내야 한다(SHALL)
4. WHEN 정의되지 않은 메서드·경로를 받으면 THEN 시스템은 메서드가 틀리면 405, 경로가 없으면 404를 보내야 한다(SHALL)

### Requirement 5

**User Story:** 사용자로서, 화면 없이 터미널에서도 해결을 승인하고 싶다.

#### Acceptance Criteria

1. WHEN `guard resolve <요구사항|all> <revert-code|edit-spec> [--root <dir>]`를 실행하면 THEN 시스템은 요구사항(전체 ID, 그 선택으로 기록할 수 있는 요구사항 중 하나에만 맞는 짧은 ID, 또는 현재 red 전부를 뜻하는 `all`)이 그 선택으로 기록할 수 있는 요구사항(현재 report.json에서 red, 또는 선택이 `edit-spec`일 때 reason이 `stale`인 yellow)일 때만 Requirement 4.3과 같은 기록과 events 줄을 남기고 stdout에 기록한 ID를 쓴 뒤 종료 코드 0으로 끝나야 하며, 기록할 수 없는 요구사항이거나(`all`인데 red가 없을 때 포함) 짧은 ID가 모호하면 종료 코드 1, 인자 개수나 선택 값이 틀리면 64로 끝나야 한다(SHALL)
2. WHEN 기록하면 THEN 시스템은 serve의 버튼과 같은 함수를 써서 같은 형식의 항목을 남겨야 한다(SHALL)

### Requirement 6 (선택 — 반례 재연)

**User Story:** 사용자로서, 줄여 낸 반례를 실제 검증 함수에 넣어 지금 코드가 그 입력을 받아들이는지, 고친 뒤에는 거절하는지 보여 주고 싶다.

#### Acceptance Criteria

1. WHEN `POST /api/replay`를 받으면 THEN 시스템은 Requirement 4.1과 같은 원격 주소·Origin 조건을 지켜야 하고 본문이 4KB 이하 JSON `{"requirement":"<전체 ID>","args":[…](선택)}`이 아니면 400을 보내야 한다(SHALL)
2. WHEN `args`가 없으면 THEN 시스템은 report.json에 있는 그 요구사항의 counterexample을 JSON 배열로 읽어 args로 써야 하고, 둘 다 없거나 counterexample을 JSON 배열로 읽을 수 없으면(fast-check는 날짜 등을 JSON이 아닌 꼴로 적을 수 있다) 404를 보내야 한다(SHALL)
3. WHEN 설정 `replay.cases`에 그 요구사항이 있으면 THEN 시스템은 그 입력 틀에서 값이 정확히 `"$N"`인 문자열을 args의 N번째 값으로 바꾼 객체를 만들고, `replay.module`을 파일 수정 시각을 쿼리로 붙인 파일 URL로 매번 새로 import해 `replay.export` 함수에 넣은 결과를 `{"requirement","args","input","result"}`로 200과 함께 보내야 하며, 설정이 없으면 404, 실행 중 예외는 500과 메시지를 보내야 한다(SHALL)
4. WHEN 이 엔드포인트가 응답하면 THEN 시스템은 어떤 파일도 쓰지 않아야 한다(SHALL)
