# Design Document

## Overview

하위 명령을 가진 단일 CLI `guard`(TypeScript, Node 내장 모듈만, 외부 서비스·AI 호출 없음). 실행은 `node guard/dist/cli.js <명령>`. 이 문서는 `scan`·`judge`·`gate`와 `.kiro/guard/` 데이터 계약을 정한다. 다른 하위 명령의 동작은 guard-check·guard-serve 스펙이 정하고, 여기의 데이터 형식을 그대로 쓴다.

## Command line

- 하위 명령은 항상 첫 인자다. 첫 인자가 하위 명령 이름이 아니면(옵션 포함) 사용법을 stderr에 쓰고 종료 코드 64 — 문지기의 승인 명령 판정(gate 5단계)이 guard 실행 토큰 바로 다음 토큰을 보기 때문이다(옵션을 앞에 받으면 `cli.js --root . check --results fake.json`이 예약을 비켜 간다)
- 알 수 없는 하위 명령이나 필수 인자 누락: 사용법을 stderr에 쓰고 종료 코드 64
- 모든 JSON 출력은 UTF-8(BOM 없음), 들여쓰기 2칸, 키 순서는 이 문서의 예시 순서
- JSON 입력 파일과 stdin은 맨 앞의 UTF-8 BOM을 떼고 읽는다
- `.kiro/guard/`는 현재 작업 폴더(또는 `--root`) 기준으로 찾는다. CLI 파일 위치 기준이 아니다

| 명령 | 인자 | 정하는 스펙 |
|---|---|---|
| `scan` | `--specs <dir> --out <file>` | guard-core |
| `judge` | `--index <f> --results <f> [--gen-hashes <f>] [--broken-seals <f>] --out <f>` | guard-core |
| `gate` | `[--root <dir>]` 또는 `--report <f> [--resolution <f>] [--sealed <f>] [--events <f>]`, stdin = 이벤트 JSON | guard-core |
| `check` | `[--root <dir>] [--results <f>] [--if-changed] [--summary]` | guard-check |
| `adopt` | `<요구사항> --test <f> --mutant <f> [--mutant <f> …] [--root <dir>]` (사람 전용) | guard-check |
| `resolve` | `<요구사항 또는 all> <revert-code 또는 edit-spec> [--root <dir>]` (사람 전용) | guard-serve |
| `serve` | `[--root <dir>] [--port <n>] [--ui <dir>]` | guard-serve |

hook이 부르는 형태(명령은 작업 공간 루트에서 실행된다. guard가 `../guard`에 있을 때):

| hook | 명령 |
|---|---|
| 문지기 PreToolUse(write·shell), PreTaskExec | `node ../guard/dist/cli.js gate` |
| 쓰기 후 검사 PostToolUse(write) | `node ../guard/dist/cli.js check` |
| 쓰기 후 검사 PostToolUse(shell) | `node ../guard/dist/cli.js check --if-changed` |
| 세션 요약 SessionStart | `node ../guard/dist/cli.js check --if-changed --summary` |

## 데이터 계약 — `.kiro/guard/`

사람과 guard만 쓴다(예외는 `bin/` — setup 스킬이 hook을 깔기 전에 한 번 복사한다). 에이전트의 쓰기·셸 명령은 문지기가 막는다(요구사항 3.3).

| 파일 | 쓰는 쪽 | 내용 |
|---|---|---|
| `config.json` | 사람 | check·serve 설정(guard-check design) |
| `index.json` | check(scan 규칙) | 요구사항 색인 |
| `report.json` | check | judge 결과 + `generatedAt`·`code`·`inputsHash`(+ 실행 실패 시 `runError`) |
| `resolution.json` | 사람(serve 버튼·`guard resolve`), check(닫기만) | 해결 승인 |
| `sealed.json` | adopt(사람이 실행) | 봉인 검사 목록 |
| `events.jsonl` | gate·check·adopt·resolve·serve | 활동 기록, 한 줄에 객체 하나 |
| `runs/<spec>__<Rn.m>.json` | check | 반례 기록(시험한 입력·줄이기 경로) |
| `check.lock`·`adopt.lock`·`mutant-backup/` | check·adopt | 작업 중에만 생기는 임시 파일 |
| `bin/` | setup 스킬(사람이 계획을 승인한 뒤, hook을 깔기 전 한 번) | setup 스킬이 다른 저장소에 설치한 guard 실행 파일 — 그 저장소의 hook 명령은 `node .kiro/guard/bin/cli.js …`. 예약 경로 안이라 문지기가 켜진 뒤에는 에이전트가 고치거나 셸로 실행할 수 없다(guard는 hook이나 사람이 실행한다) |

`index.json`
```json
{ "specs": [ { "spec": "signup", "requirements": [
  { "id": "R2.3", "text": "WHEN 비밀번호가 8자 미만이면 THEN 시스템은 가입을 거절해야 한다(SHALL)", "textHash": "sha256:…" },
  { "id": "R3.1", "text": "WHEN … 거절해야 한다(SHALL) (근거: 개인정보 보호법 제22조의2 제1항)", "textHash": "sha256:…", "basis": "개인정보 보호법 제22조의2 제1항" } ] } ] }
```

`report.json`의 requirements 항목 — reason별 키(순서 그대로)

| reason | verdict | 키 |
|---|---|---|
| `seal-broken` | red | id, verdict, reason, brokenSeals, tests |
| `test-failed` | red | id, verdict, reason, counterexample(있을 때), runs(있을 때), shrinks, tests |
| `run-failed` | red | id, verdict, reason, tests — check가 판정을 내지 못했을 때만(테스트 실행 실패·색인 실패·봉인된 요구사항 없음 — guard-check 1.3, 2.2) |
| `no-tests`·`stale` | yellow | id, verdict, reason, tests |
| `all-passed` | green | id, verdict, reason, tests |

`tests` = `[{ "title", "status" }]`(결과 파일 등장 순서). `brokenSeals` = `[{ "path", "problem" }]`, problem은 `missing`·`changed`·`not-run`.

`resolution.json`
```json
{ "approved": [ { "requirement": "signup:R2.3", "choice": "revert-code", "by": "human", "approvedAt": "2026-11-14T14:05:00+09:00" } ],
  "closed": [ { "requirement": "signup:R1.1", "choice": "edit-spec", "by": "human", "approvedAt": "2026-11-14T13:20:00+09:00", "closedAt": "2026-11-14T13:31:12+09:00" } ] }
```
`closed`는 없어도 된다. 시각은 로컬 시각·초 단위·오프셋 포함 ISO 8601.

`sealed.json`
```json
{ "sealed": [ { "path": "tests/signup/R2.3.prop.test.ts", "sha256": "sha256:…", "requirements": ["signup:R2.3"],
  "textHashes": { "signup:R2.3": "sha256:…" }, "sealedAt": "2026-11-14T13:40:00+09:00" } ] }
```
`path`는 작업 공간 루트 기준 상대 경로(`/` 구분), `sha256`은 파일 바이트 그대로의 해시, `textHashes`는 봉인 당시 색인의 textHash.

`events.jsonl` — 한 줄 = `{"ts":"HH:MM:SS","action":"…","target":"…"}`(로컬 시각, 키 순서 그대로, UTF-8, 끝에 `\n`)

| action | 쓰는 쪽 | target 예 |
|---|---|---|
| `write` | gate(허용한 쓰기) | `src/signup/validate.ts` |
| `shell` | gate(허용한 셸 명령) | `npx vitest run` |
| `block` | gate(막음) | `signup:R2.3 위반 · 사람 결정 대기` |
| `hook` | check | `guard check · 빨강 1 · 노랑 0 · 초록 5` |
| `human` | resolve·serve 버튼·adopt | `signup:R2.3 · 코드를 되돌린다 승인` |
| `save` | serve(사람 저장) | `src/signup/validate.ts · 사람 저장` |

`runs/<spec>__<Rn.m>.json`(guard-check가 씀)
```json
{ "requirement": "signup:R2.3", "inputs": [ { "v": "\"c003\"", "ok": true }, { "v": "\"ijed569\"", "ok": false } ],
  "shrinkPath": ["\"ijed569\"", "\"jed569\"", "\"aaa000\""], "counterexample": "[\"aaa000\"]" }
```

judge 입력 broken-seals: `{ "signup:R2.3": [ { "path": "tests/signup/R2.3.prop.test.ts", "problem": "changed" } ] }` / gen-hashes: `{ "signup:R2.3": "sha256:<hex>" }`

반례 기록 파일 이름(요구사항 4.1): `id.replace(':', '__') + '.json'` — 스펙 이름은 폴더 이름이라 `[A-Za-z0-9_-]`, ID는 `R\d+\.\d+`이므로 마지막 `__R`에서 다시 나눌 수 있다.

## scan

1. `<specs>`의 하위 폴더를 이름순으로 돈다. 폴더 이름 = spec
2. `requirements.md`를 줄 단위로 읽는다(줄 끝 `\r` 제거). `^#{2,5}\s+(?:Requirement|요구사항)\s+(\d+)`(대소문자 무시)에 맞는 줄에서 현재 N을 바꾸고, 그 아래 `^#{2,5}\s+(?:Acceptance Criteria|수용 기준)` 제목 다음의 `^\s*\d+\.\s+(.*)$` 줄들을 차례로 수용 기준 1, 2, …로 읽는다(다음 제목까지). 제목 단계는 `###`/`####`(IDE 템플릿)와 `##`/`###`(CLI 에이전트) 둘 다 온다
3. 문장 정규화: 앞뒤 공백 제거 → 연속 공백(스페이스·탭)을 스페이스 하나로
4. 근거: 정규화한 문장에서 `lastIndexOf('(근거:')`로 마지막 `(근거:`를 찾는다(없으면 근거 없음). 그 위치부터 문장 끝까지 한 글자씩 보며 `(`면 깊이 +1, `)`면 −1 — 깊이가 마지막 글자에서 처음으로 0이 될 때만(그 전에 0이 되거나 끝에서 0이 아니면 근거 없음) 그 `(근거:` 다음(`'(근거:'.length` = 4글자 다음)부터 마지막 `)` 앞까지를 trim → 비어 있지 않으면 `basis`
   - 근거 안의 짝 맞는 괄호는 그대로 둔다: `… (근거: 개인정보 보호법 제22조의2 제1항(2023. 3. 14. 개정으로 신설))` → `개인정보 보호법 제22조의2 제1항(2023. 3. 14. 개정으로 신설)`
   - 문장 중간에서 `(근거:`를 언급하면 근거 없음: 그 묶음 뒤에 묶음 밖 글자가 오기 때문이다(예: 요구사항 1.4 자신 — 마지막 `(근거:` 다음에 `)`가 나와 깊이가 끝 전에 0이 된다). `)`로 끝나는지만 보면 이런 문장에서 엉뚱한 basis가 나온다
   - text·textHash는 근거를 지우지 않은 문장으로 계산한다(근거를 바꾸는 것도 요구사항 문장을 바꾸는 것이다)
5. 결과 키 순서: `id`, `text`, `textHash`, `basis`(있을 때)

## judge

1. 색인에서 전체 ID `spec:RN.m` 목록을 만든다
2. 각 assertionResult의 title에서 정규식 `\[(?:([A-Za-z0-9_-]+):)?(R\d+\.\d+)\]`의 모든 일치를 태그로 읽는다
3. 태그 해석: spec이 있으면 `spec:RN.m`(색인에 있을 때), 없으면 그 ID를 가진 스펙이 하나일 때만 그 스펙으로. 해석 실패 → orphans(대괄호만 뺀 태그 원문, 중복 제거, 등장 순)
4. 연결된 테스트 = 그 요구사항으로 해석되는 태그를 단 결과 중 status가 `passed`·`failed`인 것
5. 요구사항별 판정 순서: seal-broken → test-failed → no-tests → stale → all-passed. 봉인이 깨진 검사의 통과·실패는 믿을 수 없으므로 seal-broken이 맨 앞이다
6. failureMessages 해석: 문자열들을 줄바꿈으로 이어 붙인 뒤 `Counterexample: (.*)`, `failed after (\d+) tests`, `Shrunk (\d+) time`. 앞의 둘은 없으면 키를 쓰지 않고, shrinks는 없으면 0
7. requirements 배열은 색인 순서, tests는 결과 파일 등장 순서
8. 결과 예:
```json
{ "overall": "red",
  "requirements": [
    { "id": "signup:R2.3", "verdict": "red", "reason": "test-failed", "counterexample": "[\"aaa000\"]", "runs": 10, "shrinks": 7,
      "tests": [ { "title": "[R2.3] 8자 미만 비밀번호는 거절", "status": "failed" } ] },
    { "id": "signup:R3.1", "verdict": "red", "reason": "seal-broken",
      "brokenSeals": [ { "path": "tests/signup/R3.1.prop.test.ts", "problem": "changed" } ],
      "tests": [ { "title": "[R3.1] 14세 미만 동의 없으면 거절", "status": "passed" } ] } ],
  "orphans": [], "summary": { "green": 4, "yellow": 0, "red": 2 } }
```

## gate

결정은 아래 순서로 처음 걸리는 규칙 하나로 정한다. 테스트를 돌리지 않고 테스트 파일 해시도 계산하지 않는다(그건 check의 일) — 지연 예산 100ms.

1. 입력: stdin 바이트 → 맨 앞 BOM(EF BB BF) 제거 → UTF-8 → `JSON.parse`. 실패하면 대상 경로·명령 = 빈 문자열
2. 대상: `tool_input`의 path → file_path → filePath → target_file → file 중 처음 나오는 문자열 = 대상 경로. 없고 `command` 문자열이 있으면 대상 명령. 실제 Kiro 이벤트의 경로는 `c:\Users\…\src\a.ts` 같은 절대 경로(드라이브 소문자, 역슬래시)다. 도구 이름이 아니라 키로 정한다
3. 읽는 파일: 작업 공간 모드(`--report` 없음) = `<root>/.kiro/guard/{report,resolution,sealed}.json`, events = `<root>/.kiro/guard/events.jsonl`(폴더가 있을 때만). 파일 모드(`--report` 있음) = 명시한 파일만, events는 `--events`가 있을 때만
4. 예약 경로(요구사항 3.3) → 2, stderr `Tripwire: .kiro/guard/ and .kiro/hooks/ are reserved for the user.`
5. 승인 명령(요구사항 3.4) → 2, stderr `Tripwire: approving resolutions and sealing tests are reserved for the user (guard resolve, guard adopt, guard check --results, /api/resolve). Ask the user.`
   - 토큰: 정규화한 명령을 공백으로 나누고, 각 토큰의 앞뒤에서 `"` `'` `` ` `` `;` `&` `|` `(` `)`를 벗긴다(빈 토큰은 버림)
   - guard 실행 토큰: `guard`·`guard.cmd`·`guard.exe`·`guard.ps1`와 같거나, `/guard`·`/guard.cmd`·`/guard.exe`·`/guard.ps1`로 끝나거나, `cli.js`로 끝나는 토큰
   - 예약: guard 실행 토큰 바로 다음 토큰이 `resolve`·`adopt` / guard 실행 토큰 바로 다음 토큰이 `check`이고 그 `check` 뒤 어딘가에 `--results` 또는 `--results=`로 시작하는 토큰 / 명령 어디든 `/api/resolve`
   - `--results`를 막는 대상은 check뿐이다(판정 입력 바꿔치기). `judge --results`는 필수 인자라 막지 않는다 — judge의 출력이 `.kiro/guard`를 향하면 4의 예약 경로가 먼저 막는다

   | 명령 | 결과 |
   |---|---|
   | `node ../guard/dist/cli.js resolve signup:R2.3 revert-code` | 예약 |
   | `node "C:\Users\x\repo\guard\dist\cli.js" adopt signup:R1.1 --test t.ts --mutant m.json` | 예약 |
   | `GUARD.CMD Resolve signup:R2.3 edit-spec` | 예약 |
   | `node ..\guard\dist\cli.js check --results fake.json` | 예약 |
   | `node ../guard/dist/cli.js check --results=fake.json` | 예약 |
   | `curl.exe -X POST http://127.0.0.1:4848/api/resolve -d "{}"` | 예약 |
   | `node ../guard/dist/cli.js check --summary` | 통과 |
   | `node guard/dist/cli.js judge --index i.json --results r.json --out o.json` | 통과 |
   | `npm run resolve` · `git merge -s resolve topic` · `node scripts/resolve-deps.js` | 통과 |

6. 파일 읽기: report 파일 없음 → 빨강 없음, sealed 없음 → 봉인 없음, resolution 없음·읽기 실패 → 승인 없음. report나 sealed가 있는데 JSON이 아니면 → 2, stderr `Tripwire: <그 파일 경로> is unreadable. Ask the user to run guard check.`
7. 봉인(요구사항 3.6): 각 항목의 path를 정규화해 p라 할 때, 정규화한 대상 경로가 p와 같거나 `/` + p로 끝나면, 또는 정규화한 대상 명령이 p를 포함하면 일치. 그 항목의 requirements가 모두 choice `edit-spec` 승인을 가지면 면제. 면제되지 않은 일치 항목이 있으면(sealed.json 순서) → 2, stderr `Tripwire: sealed tests cannot be changed by the agent: <path> (<id>, <id>); <path> (<id>). Do not edit, move or delete them or name them in shell commands; run the whole test suite instead. If a requirement must change, ask the user to approve "edit the spec".` (`<path>`는 sealed.json에 적힌 그대로)
   - 테스트 파일 하나가 여러 요구사항을 담으면 면제에 그 요구사항 모두의 edit-spec 승인이 필요하다. 그래서 검사 파일은 수용 기준마다 하나로 둔다(guard-check design)
8. 빨강(요구사항 3.7): overall이 red이고 approved에 없는 red 요구사항이 있으면(report 순서) → 2, stderr `Tripwire: blocked. Violated: <항목>; <항목>. Stop writing and ask the user to choose: edit the spec or revert the code.` 항목 = `<id> (counterexample <ce>)` / seal-broken이면 `<id> (seal broken: <path> <problem>, <path> <problem>)` / 그 밖은 `<id> (<reason>)`
9. 그 외 → 0, stderr 없음
10. events 한 줄(요구사항 3.10). `ts`는 로컬 `HH:MM:SS`. 파일이 없으면 덧붙이기로 새로 만들되 폴더는 만들지 않는다(작업 공간 모드에서 `.kiro/guard/`가 없으면 쓰지 않음)
    - 표시 경로: 대상 경로의 `\`를 `/`로. 이벤트 `cwd`(문자열로 오지 않으면 작업 공간 루트 = `--root`, 없으면 현재 작업 폴더)도 같은 방식으로 바꾼 뒤, 대소문자 무시로 `cwd + "/"`로 시작하면 그 뒤만 남긴다(원래 대소문자 유지). 맨 앞 `./` 제거. 기준 폴더가 없으면 절대 경로가 그대로 남아 guard serve가 에이전트의 쓰기를 사람 저장으로 잘못 가른다(guard-serve 3.1은 write 줄의 target을 루트 기준 상대 경로와 비교한다)
    - 표시 명령: 줄바꿈·탭을 공백으로 바꾸고, 80자(JavaScript 문자열 길이)를 넘으면 앞 80자 + `…`
    - 허용 + 대상 경로 → `write` / 표시 경로. 허용 + 대상 명령 → `shell` / 표시 명령. 허용 + 대상 없음 → 쓰지 않음
    - 예약(4·5) → `block` / `예약 영역 차단 · <표시 경로 또는 표시 명령>`
    - 읽기 실패(6) → `block` / `판정 파일 읽기 실패 · <파일 이름>`
    - 봉인(7) → `block` / `봉인 검사 차단 · <막힌 path들을 ", "로>`
    - 빨강(8) → `block` / `<막힌 ID들을 ", "로> 위반 · 사람 결정 대기`

## 문자열 규칙의 한계

문지기는 이벤트 문자열만 본다. 흔한 경로(직접 쓰기, 경로가 적힌 셸 명령, guard 승인 명령, 해결 엔드포인트 호출)는 막지만 와일드카드·문자열 조립·스크립트 파일을 거친 우회는 남는다. 두 번째 방어선은 check다 — 봉인 파일의 내용 해시가 바뀌거나 그 검사가 실행되지 않으면 seal-broken(빨강)이 되어 다음 쓰기부터 막힌다. 해결 기록은 `by: "human"`만 쓰이고 승인 시각·대상이 events.jsonl에 남는다.

## Testing

- 단위 테스트 + 속성 기반 테스트(PBT):
  - scan: 임의로 만든 요구사항 문서에서 추출 ID 개수 = 수용 기준 줄 개수, ID 중복 없음 / 문장이 하나의 괄호 묶음 `(근거: X)`로 끝나고(X는 `(근거:`를 담지 않고 `(`·`)`의 짝이 맞는 문자열 — 어느 앞부분에서도 `)`가 `(`보다 많지 않음) trim(X)가 비지 않을 때만 basis = trim(X) / 그런 문장 뒤에 `(근거:`가 없는 묶음 밖 글자(예: ` 이어서`, ` (SHALL)`)를 붙이면 basis 없음 / basis 유무와 무관하게 textHash = sha256(text)
  - judge: broken-seals에 있으면 테스트 결과와 무관하게 반드시 red·seal-broken / 그 밖에 연결된 테스트에 failed가 있으면 반드시 red / 연결 0개면 반드시 yellow·no-tests / 모두 passed이고 해시 같으면 반드시 green / skipped·pending 결과를 더해도 판정이 바뀌지 않음
  - gate: 대상이 `.kiro/guard/`·`.kiro/hooks/` 아래면 report·resolution·sealed와 무관하게 반드시 2 / 봉인 path와 일치하고 면제가 없으면 report와 무관하게 반드시 2 / 초록·봉인 불일치·예약 아님이면 반드시 0 / 같은 입력 두 번 → 같은 결과 / 입력 앞에 BOM을 붙여도 같은 결과
  - 반례 기록 파일 이름: 금지 문자 없음, 서로 다른 ID → 서로 다른 이름
