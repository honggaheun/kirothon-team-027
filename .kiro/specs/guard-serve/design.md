# Design Document

## Overview

`guard serve`는 Node 내장 `http`·`fs`·`child_process`만 쓰는 작은 서버다. 바인딩 주소는 `127.0.0.1` 하나. 화면은 `/data/*`를 주기적으로 읽어도 되고(폴링), `/api/stream`으로 밀어 받는 것(SSE)을 기본으로 한다. `guard resolve`는 서버와 같은 기록 함수를 쓰는 CLI다.

## 경로

| 메서드·경로 | 동작 | 요구사항 |
|---|---|---|
| `GET /`, `GET /<파일>` | 화면 폴더의 정적 파일(`/` = `index.html`) | 1.2 |
| `GET /data/<이름>` | `.kiro/guard/`의 허용된 파일 | 1.3 |
| `GET /api/stream` | SSE | 2 |
| `POST /api/resolve` | 해결 승인 기록(사람) | 4 |
| `POST /api/replay` | 반례 재연(선택) | 6 |

- 화면 폴더 기본값: CLI 파일과 같은 폴더의 `ui/`가 있으면 그것, 없으면 CLI 파일(`guard/dist/cli.js`) 기준 `../../ui` = 저장소의 `ui/`. demo 작업 공간에서 `node ../guard/dist/cli.js serve`로 띄워도 화면은 저장소의 `ui/`, 데이터는 `demo/.kiro/guard/`. 파워에 넣는 guard(`power/tripwire/skills/setup/scripts/guard/`)에는 `ui/`를 함께 넣으므로, 다른 저장소에 설치된 `.kiro/guard/bin/cli.js`는 옆의 `ui/`를 쓴다
- `/data/` 허용 이름: `index.json`·`report.json`·`resolution.json`·`sealed.json`·`events.jsonl`·`runs/` + `^[A-Za-z0-9_-]+__R\d+\.\d+\.json$`
- 정적 경로 풀기: URL 디코드 → `path.resolve(uiDir, '.' + pathname)` → 결과가 `uiDir + path.sep`로 시작하지 않으면 404
- `/data/*`와 SSE 응답에는 `Cache-Control: no-store`

## SSE

- 응답 헤더: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `Connection: keep-alive`
- 메시지 한 개 = `event: <이름>\ndata: <한 줄 JSON>\n\n`

| 이벤트 | data |
|---|---|
| `index`·`report`·`resolution`·`sealed` | 그 파일의 JSON |
| `runs` | `{"name":"signup__R2.3.json","data":{…}}`, 지워졌으면 `"data":null` |
| `events` | 새로 덧붙은 완전한 줄의 객체 배열 — 화면은 목록 끝에 덧붙인다 |
| `events-reset` | 마지막 50줄의 객체 배열(파일이 없으면 `[]`) — 연결 직후, 그리고 파일이 보낸 위치보다 짧아지거나 없어졌을 때. 화면은 목록을 이것으로 갈아 끼운다 |

- 감시: `.kiro/guard/`를 `fs.watch(…, { recursive: true })`로 보고, 편집기·rename 저장에서 이벤트가 빠질 수 있으므로 500ms마다 대상 파일의 크기·수정 시각도 비교한다. 바뀐 파일은 100ms 뒤 읽는다(쓰는 중이면 JSON 파싱 실패 → 이번엔 보내지 않음)
- events.jsonl은 마지막으로 보낸 바이트 위치를 기억해 그 뒤의 완전한 줄(`\n`으로 끝난 것)만 `events`로 보낸다. 파일이 위치보다 짧아지면 처음부터 다시 읽어 마지막 50줄을 `events-reset`으로 보내고 위치를 마지막 완전한 줄 뒤로 옮긴다. 파일이 없어지면 `events-reset`(`[]`)을 보내고 위치를 0으로 둔다 — 다시 생긴 파일의 줄은 `events`로 간다
- 연결 직후 묶음도 `events-reset`이다. 브라우저의 EventSource는 끊기면 저절로 다시 연결하고 서버는 그때 현재 상태를 처음부터 보내므로, 이름이 `events`면 화면이 같은 줄을 두 번 덧붙인다
- 15초마다 `: ping\n\n`

화면에 필요한 값의 출처: 요구사항 문장·조문 배지 = `index.json`의 `text`·`basis` / 실·도장 = `report.json`의 `requirements`·`code` / 봉인 표시 = `sealed.json`과 reason `seal-broken` / 반례 막대 = `runs` / 활동 띠 = `events`(덧붙이기)·`events-reset`(갈아 끼우기) / 해결 버튼 상태 = `resolution.json`. 화면 쪽 규칙은 stage-ui 스펙이 정한다.

## 사람 저장 감시

1. guard-check 설정 절의 감시 대상(`specsDir` 아래 파일, `testGlobs`·`sourceGlobs`에 맞는 파일, `<testDir>`의 vitest 설정·`package.json`)만 본다. 작업 공간 루트를 `fs.watch(recursive)`로 보고, 바뀐 경로가 `specsDir` 아래이거나, `testGlobs`·`sourceGlobs`에 맞거나(같은 glob 함수 — `node_modules`·`.git`·`.kiro` 안은 보지 않음), `<testDir>`의 vitest 설정·`package.json`이면 감시 대상으로 본다. 그 밖(`.kiro/guard` 포함)은 무시
2. 변경마다 300ms 디바운스(경로별)
   - 저장이 아닌 것을 거른다: 감시를 시작할 때 감시 대상 파일을 모두 읽어 내용의 SHA-256을 경로별로 기억한다. 디바운스가 끝난 뒤 그 경로가 폴더면 무시하고, 파일이면 해시가 기억과 같을 때 무시한다(파일을 읽기만 해도 Windows는 그 파일과 폴더의 이벤트를 낸다). 기억에 있던 파일이 없어졌으면 변경이다. 해시가 다르면 기억을 새 값으로 바꾸고 3으로 간다
3. adopt 중이면 무시: `.kiro/guard/adopt.lock`이 있거나, 사라진 지 2초 안
4. 누가 바꿨나: events.jsonl의 마지막 줄들 중 `ts`가 지금부터 10초 안인 줄에 `action: "write"`이고 target이 바뀐 파일의 루트 기준 상대 경로(`/` 구분, 대소문자 무시)와 같은 줄이 있거나 `action: "shell"` 줄이 있으면 에이전트 → 아무것도 하지 않음(PostToolUse hook이 check를 돈다). 없으면 사람 저장
5. 사람 저장: `{"ts","action":"save","target":"<상대 경로> · 사람 저장"}` 덧붙이기 → `spawn(process.execPath, [cliFile, 'check', '--root', root, '--if-changed'], { windowsHide: true })`
6. 자식이 도는 중에 또 오면 플래그만 세우고, 끝나면 한 번 더(최대 하나 대기)

`ts`는 `HH:MM:SS`라 자정을 넘는 10초 구간은 비교하지 않는다(영향: 그 순간의 사람 저장 표시 하나).

## 해결 기록 — 버튼과 `guard resolve`가 같은 함수를 쓴다

`recordResolution(root, targets, choice, now)`:
1. report.json을 읽어 대상마다 기록할 수 있는지 확인(`canRecord`) — verdict가 red면 두 선택 모두, verdict yellow·reason `stale`이면 choice가 `edit-spec`일 때만. 하나라도 아니면 오류(POST는 409, CLI는 종료 코드 1). 닫기는 그대로 guard check가 그 요구사항이 green일 때 한다(guard-check 6.1)
2. resolution.json을 읽는다(없으면 `{ "approved": [] }`, `closed`는 있으면 그대로 둔다)
3. 대상마다 approved에서 같은 requirement 항목을 빼고 `{ requirement, choice, by: "human", approvedAt }`를 끝에 덧붙인다
4. 원자적 저장(임시 파일 → 이름 바꾸기), 대상마다 events `human` 줄
5. 새 resolution 객체를 돌려준다

- POST 검사 순서: 원격 주소(`req.socket.remoteAddress` ∈ `127.0.0.1`·`::1`·`::ffff:127.0.0.1`) → `Origin`(`http://127.0.0.1:<port>`·`http://localhost:<port>`) → 본문 크기 4KB → JSON 형식 → 기록할 수 있는지(`canRecord`). 브라우저는 같은 출처 POST에도 `Origin`을 보낸다. curl 같은 명령은 기본으로 보내지 않아 403이 되고, 에이전트의 셸 명령에 `/api/resolve`가 들어가면 문지기가 먼저 막는다
- 요청 본문에 requirement가 없으면 현재 red 전부가 대상이다(화면의 두 버튼은 요구사항을 고르지 않는다). stale(노랑) 요구사항은 ID를 적어야 대상이 된다 — 예: 사람이 봉인된 R2.3의 문장을 편집기에서 고쳐 노랑이 되면 `guard resolve signup:R2.3 edit-spec`으로 기록하고, 그 뒤 에이전트가 봉인 검사를 다시 만든다(문지기의 봉인 면제, guard-core 3.6). 이 기록이 없으면 봉인 파일 쓰기가 막혀 검사를 다시 만들 길이 없다
- `guard resolve`: 인자 2개가 아니거나 선택 값이 `revert-code`·`edit-spec`이 아니면 사용법 + 64. 짧은 ID(`R2.3`)는 그 선택으로 기록할 수 있는 요구사항 중 `:R2.3`으로 끝나는 것이 정확히 하나일 때만 받는다. `all`은 현재 red 전부다(stale 요구사항은 들어가지 않는다). 성공하면 stdout에 기록한 ID를 한 줄에 하나씩

## 반례 재연 (선택)

설정 `.kiro/guard/config.json`:
```json
{ "replay": {
    "module": "src/signup/validate.ts",
    "export": "validateSignup",
    "cases": {
      "signup:R2.3": { "email": "new@example.com", "password": "$0", "birthDate": "2000-01-01", "guardianConsent": true, "today": "2026-11-14" }
    } } }
```

- args: 본문의 `args`, 없으면 `JSON.parse(report의 counterexample)`(예: `["aaa000"]`)
- 틀 바꾸기: 객체·배열을 깊이 따라가며 값이 정확히 문자열 `"$N"`이면 `args[N]`으로 바꾼다. 그 밖의 값은 그대로
- 불러오기: `import(pathToFileURL(abs).href + '?v=' + mtimeMs)` — 쿼리가 다르면 새 모듈로 읽혀 코드 변경이 반영된다. Node v22.23.4는 타입 표기만 있는 TypeScript 파일(`export type`, 타입 주석, 제네릭 인자)을 그대로 import한다(signup `validate.ts`로 확인: 최소 길이 8이면 `aaa000` → `{ ok: false, reason: 'R2.3' }`, 6으로 바꾸고 다시 import하면 `{ ok: true }`). enum·namespace처럼 지울 수 없는 문법은 쓰지 않는다
- 응답 예: `{"requirement":"signup:R2.3","args":["aaa000"],"input":{…,"password":"aaa000",…},"result":{"ok":true}}`. 화면은 빨강일 때 받은 args를 기억했다가 해결 뒤 같은 args로 다시 불러 결과가 거절로 바뀌는 것을 보인다
- 서버 프로세스 안에서 작업 공간 코드를 실행하므로 이 컴퓨터의 요청(4.1 조건)만 받는다. 파일은 쓰지 않는다
- 끝나지 않는 동기 코드를 재연하면 서버가 멈춘다. 그런 코드는 check가 시간 제한으로 `run-failed`를 내므로, 화면은 report에 `run-failed`가 있을 때 재연을 요청하지 않는다(stage-ui 쪽 기준)
- 쿼리는 맨 위 모듈에만 붙는다. 그 모듈이 import한 다른 파일의 변경은 처음 읽은 것이 남으므로 검증 코드는 한 파일로 둔다(상대 import가 있으면 `.ts` 확장자까지 적어야 한다)

## 단위로 시험할 함수

- `resolveStaticPath(uiDir, urlPath)` — 폴더 밖이면 null
- `isAllowedDataName(name)`
- `isLoopback(addr)`, `isAllowedOrigin(origin, port)`
- `classifyChange(relPath, recentEvents, now)` → `agent` | `human`
- `canRecord(reportItem, choice)` — red면 참, yellow·`stale`이면 choice가 `edit-spec`일 때만 참, 그 밖은 거짓
- `recordResolution` 의 순수 부분 `applyApproval(resolution, targets, choice, approvedAt)`
- `fillTemplate(template, args)`
- `sseFrame(event, data)`

## Testing

- 단위 테스트 + PBT:
  - 정적 경로: 임의의 `..`·`%2e%2e`·역슬래시 조합이 화면 폴더 밖을 가리키면 항상 null
  - `applyApproval`: 같은 요구사항을 여러 번 승인해도 approved에 그 요구사항은 하나, 다른 요구사항 항목·`closed`는 그대로
  - `canRecord`: red → 두 선택 모두 참 / yellow·`stale` → `edit-spec`만 참 / yellow·`no-tests`와 green → 둘 다 거짓
  - `fillTemplate`: `"$N"`이 아닌 값은 바뀌지 않음, `"$0"`은 args[0]
  - `classifyChange`: 10초 안 같은 경로 write 줄 또는 shell 줄 → agent, 그 밖 → human
- 손 확인(저장소 루트, 사람 터미널. 문지기가 없는 곳):
  1. `node guard/dist/cli.js serve --root demo` → 브라우저 `http://127.0.0.1:4848/` 화면, `/data/report.json` 응답
  2. `curl.exe -s -X POST http://127.0.0.1:4848/api/resolve -d "{}"` → 403(Origin 없음)
  3. `curl.exe -s -N http://127.0.0.1:4848/api/stream` 연결 뒤 다른 터미널에서 `node guard/dist/cli.js check --root demo` → 1초 안에 `report` 이벤트
  4. demo의 `src/signup/validate.ts`를 편집기에서 저장 → events에 `· 사람 저장` 줄과 검사 줄
  5. 3의 연결을 연 채 `demo/.kiro/guard/events.jsonl`을 보관 폴더로 옮기기 → 1초 안에 `events-reset`(`[]`), 이어서 `node guard/dist/cli.js check --root demo` → 검사 줄 하나가 `events`로
