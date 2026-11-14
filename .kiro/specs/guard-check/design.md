# Design Document

## Overview

`guard check [--root <dir>] [--results <f>] [--if-changed] [--summary]`의 흐름:

1. `adopt.lock`이 있으면 stderr `adopt in progress`, 종료 코드 0(아무것도 쓰지 않음)
2. 설정 읽기(`.kiro/guard/config.json`, 없으면 기본값)
3. sealed.json 읽기 — JSON이 아니면 종료 코드 1(아무것도 쓰지 않음, 요구사항 4.4)
4. inputsHash 계산 → `--if-changed`이고 report.json의 값과 같으면 끝(요약만 선택 출력)
5. `check.lock` 잡기(아래 동시 실행)
6. scan — 실패하거나 sealed.json 항목의 연결 요구사항이 색인에 없으면 판정 불가 보고서(아래, 요구사항 2.2), 아니면 `index.json`
7. 테스트 실행(또는 `--results` 읽기) — 실패하면 run-failed 보고서(요구사항 1.3)
8. 봉인 검사(파일 해시·실행 여부) → broken-seals·gen-hashes
9. judge(guard-core) → `code` 추출 → `report.json`(원자적 교체)
10. `runs/` 쓰기·정리 → 해결 닫기 → events 줄 → stderr 전환 알림 → (`--summary`) stdout 한 줄
11. `check.lock` 놓기(예외가 나도). 6~10에서 예외가 나면 놓기 전에 판정 불가 보고서를 쓴다

`guard adopt <요구사항> --test <f> --mutant <f> [--mutant <f> …] [--root <dir>]`는 아래 adopt 절. 두 명령 모두 Node 내장 모듈만 쓴다.

`guard/dist/`는 다른 폴더로 복사해도 그대로 돌아가야 한다(power의 setup 스킬이 다른 저장소의 `.kiro/guard/bin/`으로 복사한다) — dist 안에서는 Node 내장 모듈과 dist 안의 상대 경로 import만 쓰고, 빌드할 때 dist에 모듈 형식을 밝힌 `package.json`(ESM이면 `{"type": "module"}`)을 함께 쓴다. 복사본은 저장소 루트의 package.json을 보지 못한다.

## 설정 — `.kiro/guard/config.json` (사람만 쓴다)

```json
{
  "specsDir": ".kiro/specs",
  "testGlobs": ["tests/**/*.test.ts", "test/**/*.test.ts"],
  "sourceGlobs": ["src/**/*.ts"],
  "testDir": ".",
  "timeoutSeconds": 50
}
```

- 파일이 없거나 키가 빠지면 위 값이 기본값. 앞의 네 키는 power의 setup 스킬이 사람에게 보여 주는 형식과 같다
- `specsDir`: 스펙 폴더. `testGlobs`: 태그 검사가 든 파일(vitest가 실제로 찾는 범위 안이어야 한다). `sourceGlobs`: 검사 대상 코드 — 코드 줄 태그를 모으고(`code`), 바뀌면 다시 검사한다
- glob 규칙: 루트 기준 상대 경로(`/` 구분)에 맞춘다. `**/` = 0개 이상의 폴더, 맨 끝의 `**` = 그 아래 모든 파일, `*` = `/`를 뺀 0글자 이상, `?` = `/`를 뺀 한 글자, 나머지는 글자 그대로(예: `tests/**/*.test.ts`는 `tests/a.test.ts`와 `tests/signup/R2.3.prop.test.ts`에 맞는다). 대소문자는 무시한다. `node_modules`·`.git`·`.kiro` 폴더 안은 보지 않는다(스펙은 `specsDir`로 따로 읽고, `.kiro/guard/bin/`에 설치된 guard 파일이 검사 대상 코드로 잡히지 않게 한다)
- 감시 대상(inputsHash·serve의 사람 저장 감시) = `specsDir` 아래 모든 파일 + `testGlobs` + `sourceGlobs` + `<testDir>`의 `vitest.config.*`·`vitest.setup.*`·`package.json` + `.kiro/guard/sealed.json`·`config.json`
- `testDir`: `node_modules/vitest`와 vitest 설정이 있는 폴더. vitest는 이 폴더에서 실행된다
- `timeoutSeconds`: hook timeout(60초)보다 짧게 둬서 check가 스스로 실패를 기록하고 끝나게 한다
- `replay`: guard-serve의 반례 재연 설정(선택)
- 스펙이 여럿인 저장소(예: guard 자신의 저장소, 스펙 4개)에서는 짧은 태그 `[R1.1]`이 여러 스펙에 걸려 고아가 된다 → 테스트 제목·코드 태그를 `[guard-core:R1.1]`처럼 쓴다. 그 저장소의 설정(`.kiro/guard/config.json`, 사람이 넣음): `{ "specsDir": ".kiro/specs", "testGlobs": ["guard/test/**/*.test.ts"], "sourceGlobs": ["guard/src/**/*.ts"], "testDir": ".", "timeoutSeconds": 50 }` — package.json·node_modules는 저장소 루트에 있고, 루트 vitest 설정의 include를 `testGlobs`와 같은 `guard/test/**/*.test.ts`로 좁힌다

## 테스트 실행

- vitest 진입 파일: `<testDir>/node_modules/vitest/package.json`의 `bin` → 문자열이면 그 값, 객체면 `bin.vitest`, 패키지 폴더 기준으로 푼다. vitest 5.0.5는 `{"vitest":"./vitest.mjs"}` → `node_modules/vitest/vitest.mjs`
- 실행: `spawn(process.execPath, [bin, 'run', '--reporter=json', '--outputFile=' + tmp, '--passWithNoTests', '--testNamePattern', TAG], { cwd: testDir, shell: false, windowsHide: true })`
  - `TAG` = `\[(?:[A-Za-z0-9_-]+:)?R\d+\.\d+\]` — 태그 달린 테스트만 돈다. vitest의 `-t`는 describe 제목까지 이은 전체 이름에 맞추지만, judge는 테스트 제목(`title`)의 태그만 본다
  - `tmp` = `os.tmpdir()` 아래 고유 파일. 읽은 뒤 지운다
  - 종료 코드는 보지 않는다. 실패한 테스트가 있으면 vitest는 1로 끝나지만 JSON은 정상이다
- 시간 초과: `timeoutSeconds`가 지나면 프로세스 트리를 끝낸다(Windows: `taskkill /PID <pid> /T /F` — vitest가 띄운 worker까지). 동기 무한 루프는 vitest의 테스트 시간 제한으로 끊기지 않으므로 이 제한이 바깥 안전망이다
- run-failed 보고서(요구사항 1.3): requirements = 색인 순서의 모든 ID에 `{ "id", "verdict": "red", "reason": "run-failed", "tests": [] }`, orphans `[]`, summary는 그대로 계산, `code`·`inputsHash`는 평소대로, 맨 끝 키 `runError`(예: `vitest timed out after 50s`, `vitest output is not JSON`, `vitest not found under <testDir>/node_modules`). runs는 모두 지운다(red지만 실행 요약이 없으므로)
- 판정 불가 보고서(요구사항 2.2): run-failed 보고서와 같은 모양이고 같은 함수로 쓴다. 문지기는 report만 읽으므로, 여기서 아무것도 쓰지 않으면 직전 초록을 보고 다음 쓰기를 허용한다. 달라지는 점은 셋이다
  - 요구사항은 새 색인이 아니라 직전 `index.json`의 순서로 적고, `code`도 직전 색인으로 만든다(만들다 실패하면 `{ "file": null, "lines": [] }`)
  - 색인 실패와 봉인 요구사항 없음은 `index.json`을 쓰기 전에 판단한다. 직전 색인을 남겨 둬야 화면이 지워진 문장까지 보이고, 다음 실패 때도 목록이 있다
  - `runError` = 원인 문장. 색인 실패는 scan의 메시지(예: `duplicate requirement id signup:R1.1`), 봉인 요구사항 없음은 `sealed requirement <id> is missing from the spec`(여럿이면 sealed.json 순서의 첫 ID 뒤에 ` (and <나머지 개수> more)`), 그 밖의 예외는 `guard check failed: <메시지>`
- 봉인된 요구사항을 정말 없앨 때는 사람이 스펙과 sealed.json의 그 항목을 함께 지운다. `.kiro/guard/`는 에이전트가 쓸 수 없으므로 에이전트만으로는 봉인된 요구사항을 없앨 수 없다. 봉인되지 않은 요구사항을 지우는 것은 평소의 스펙 변경이다
- 참고 측정(Windows 11, Node v22.23.4로 vitest 5.0.5 진입 파일 직접 실행, 테스트 파일 1개): 첫 실행 약 9.1초, 이어서 약 2.1초. PostToolUse(write) hook은 에이전트의 쓰기마다 check를 돌리므로 쓰기 하나에 대략 vitest 한 번이 붙는다

## report.json

- 키 순서: `generatedAt`, `overall`, `requirements`, `orphans`, `summary`, `code`, `inputsHash`(, `runError`)
- `generatedAt`: 로컬 시각 `YYYY-MM-DDTHH:MM:SS±HH:MM`. JavaScript `toISOString()`은 UTC(`Z`)라 쓰지 않는다 — 오프셋은 `-date.getTimezoneOffset()`분
- 원자적 교체: `report.json.<pid>.tmp`에 쓰고 `fs.renameSync`. Windows에서 다른 프로세스가 파일을 열고 있으면 EPERM·EBUSY가 날 수 있어 100ms 간격으로 최대 5번 다시 시도한다. runs 파일·resolution.json·index.json도 같은 방식
- `.kiro/guard/`(와 `runs/`)가 없으면 만든다. check는 작업 공간에 처음 판정을 쓰는 명령이다(문지기는 폴더를 만들지 않는다)
- 파일 복사는 `fs.copyFileSync`로 한 파일씩 한다. Node v22.23.4에서 비ASCII 사용자 경로 아래 폴더를 `fs.cpSync(…, { recursive: true })`로 복사하면 프로세스가 접근 위반(0xC0000005)으로 끝난 일이 있다(파일 하나 `cpSync`·`copyFileSync`는 정상)

## code — 요구사항과 코드 줄 잇기

- 파일 모으기: `sourceGlobs`에 맞는 파일 중 이름에 `.test.`·`.spec.`이 없는 것(glob 규칙대로 `node_modules`·`.git`·`.kiro` 밖)
- 줄마다(1부터, 줄 끝 `\r` 제거) judge의 태그 정규식으로 찾고 judge의 해석 규칙으로 전체 ID로 바꾼다. 해석되는 ID가 없는 줄은 뺀다
- 주 파일 = 태그 줄이 가장 많은 파일(같으면 경로순 앞). 주 파일의 줄 다음에 나머지 파일의 줄(경로순·줄 번호순), 나머지 파일의 줄에만 `file`
```ts
export const MIN_PASSWORD_LENGTH = 8; // [R2.3]
  if (!input.email.includes('@')) return { ok: false, reason: '[R1.1]' };
```
→ `{ "n": 4, "text": "export const MIN_PASSWORD_LENGTH = 8; // [R2.3]", "links": ["signup:R2.3"] }`, `{ "n": 18, "text": "if (!input.email.includes('@')) return { ok: false, reason: '[R1.1]' };", "links": ["signup:R1.1"] }`

## runs — 반례 기록

fast-check 4를 `verbose: 2`로 설정하면 실패 메시지에 실행 요약이 붙는다(vitest setup 파일의 `fc.configureGlobal({ verbose: 2 })`). vitest JSON의 `failureMessages` 실물(색 코드 표시는 생략, 실제는 `ESC[32m√ESC[0m`·`ESC[31m×ESC[0m`):

```
Error: Property failed after 10 tests
{ seed: -501581587, path: "9:1:1:2:2:4:4:4", endOnFailure: true }
Counterexample: ["aaa000"]
Shrunk 7 time(s)

Execution summary:
√ ["c003"]
   … (깊이 0의 √ 줄 8개 더: hd569 ineh0 gaxp6 mqyj6 ik4 ohi31 l8 n1)
× ["ijed569"]
. √ ["d569"]
. × ["jed569"]
. . √ ["ed569"]
. . × ["aed569"]
   … (깊이 3~6의 × 줄: aad569 aaa569 aaa069 aaa009)
. . . . . . . × ["aaa000"]
. . . . . . . . √ ["aa000"]
   … (깊이 8의 √ 줄 3개 더)
    at buildError (file:///…/node_modules/fast-check/lib/fast-check.js:2469:16)
```

1. 메시지들을 줄바꿈으로 잇고 `\x1b\[[0-9;]*m`을 모두 지운다
2. `Execution summary:` 다음 줄부터 `^((?:\. )*)([√×]) (.*)$`에 맞는 줄만 본다(스택 줄 `    at …`은 맞지 않는다). 깊이 = 첫 묶음 길이 / 2
3. 값 = 셋째 묶음. `[`로 시작하고 `]`로 끝나면 한 쌍만 벗긴다(`["c003"]` → `"c003"`, 인자가 둘이면 `"a",3`)
4. inputs = 깊이 0 줄 순서대로 `{ v, ok }`. shrinkPath = 깊이 0의 마지막 × 값, 이어서 깊이 1, 2, …의 마지막 × 값(× 없는 깊이에서 멈춤)

위 메시지의 결과(`runs/signup__R2.3.json`):
```json
{ "requirement": "signup:R2.3",
  "inputs": [ { "v": "\"c003\"", "ok": true }, { "v": "\"hd569\"", "ok": true }, …, { "v": "\"n1\"", "ok": true }, { "v": "\"ijed569\"", "ok": false } ],
  "shrinkPath": ["\"ijed569\"", "\"jed569\"", "\"aed569\"", "\"aad569\"", "\"aaa569\"", "\"aaa069\"", "\"aaa009\"", "\"aaa000\""],
  "counterexample": "[\"aaa000\"]" }
```
inputs 10개 = `failed after 10 tests`, shrinkPath 8개 = `Shrunk 7` + 1. 테스트 하나에 태그가 여럿이면(`[R2.1][R2.2]`) 두 요구사항 모두 같은 내용의 파일을 받는다(requirement만 다름). 실행 요약이 없는 실패(일반 assertion)는 runs 파일이 없다.

## 봉인 검사

- 항목마다 파일 바이트를 읽어 `sha256:<hex>`와 비교. 없음 → `missing`, 다름 → `changed`
- `not-run`: 결과의 `testResults[].name`(vitest 5는 `C:/Users/…/tests/signup/R2.3.prop.test.ts`처럼 절대 경로)을 정규화해 그 path와 같거나 `/<path>`로 끝나는 파일 안에서, 그 요구사항으로 해석되는 태그를 단 passed·failed 테스트가 0개면. vitest 설정에서 검사를 빼거나, 테스트 파일이 모듈 로드에 실패하거나, 테스트를 건너뛰게 만든 경우가 여기에 걸린다
- 문제 판단 순서 missing → changed → not-run, 항목·요구사항마다 첫 문제 하나
- gen-hashes = 항목들의 `textHashes`. 같은 ID에 값이 여럿이면 색인 textHash와 다른 값을 고른다(하나라도 낡았으면 stale)
- 봉인 단위는 파일이다. 그래서 검사 파일은 수용 기준마다 하나(`tests/<spec>/<Rn.m>.prop.test.ts`)로 둔다 — 그래야 봉인 깨짐과 edit-spec 면제(guard-core 3.6)가 요구사항 하나씩 움직인다

## events·알림

- 판정을 마칠 때마다 한 줄: `guard check · 빨강 <r> · 노랑 <y> · 초록 <g>` (실행 실패면 `guard check · 실행 실패`)
- 이어서 해결 닫힘마다 한 줄: `해결 닫힘 · <ID>`
- stderr 전환 알림(직전 report.json의 overall과 비교):
  - 빨강이 아님(또는 report 없음) → 빨강: `Tripwire: violated signup:R2.3 (counterexample ["aaa000"]). Further writes will be blocked until the user chooses: edit the spec or revert the code.`
  - 빨강 → 빨강 아님: `Tripwire: no violated requirements now.`
- 항목 표기 `<id> (<근거>)`는 guard-core gate 빨강 메시지와 같은 함수로 만든다: `counterexample <ce>` / `seal broken: <path> <problem>, …` / `<reason>`

## 해결 닫기

approved 항목마다 그 요구사항의 이번 판정이 green이거나 색인에 없으면 approved에서 빼서 `closedAt`을 붙여 `closed` 끝에 덧붙인다. 하나라도 바뀌면 resolution.json을 원자적으로 교체한다. 파일이 없으면 만들지 않는다. 사람이 쓴 approved 항목을 지우는 일은 이것뿐이다.

## --if-changed

- 대상: 설정 절의 감시 대상(`specsDir` 아래 모든 파일, `testGlobs`·`sourceGlobs`에 맞는 파일, `<testDir>`의 `vitest.config.*`·`vitest.setup.*`·`package.json`, `.kiro/guard/sealed.json`·`config.json` — 있는 것만)
- 정렬: 루트 기준 상대 경로(`/` 구분) 문자열의 코드포인트 순. 같은 파일이 두 번 잡히면 한 번만
- `inputsHash` = `sha256:` + SHA-256(`"<경로>\t<파일 SHA-256 hex>\n"`를 이은 UTF-8)
- 테스트를 돌리기 전에 계산해 report.json에 넣는다. 다음 `--if-changed` 실행에서 같으면 아무것도 하지 않는다. resolution.json은 판정에 영향이 없어 넣지 않는다

## --summary — 세션 시작 때 에이전트 맥락에 들어가는 한 줄

틀(부분 사이는 공백 하나, 끝에 `\n`):

```
Tripwire: <N> requirements (<g> green, <y> yellow, <r> red). <상태> <봉인> <승인> If a requirement must change, ask the user; do not weaken requirements or tests.
```

- N = g + y + r
- 상태: r > 0이면 `Violated: <항목>; <항목>.`(report 순서), r = 0이고 y > 0이면 `Not verified: <id> (<reason>); <id> (<reason>).`, 아니면 `All requirements pass.`
- 봉인: sealed.json 항목 수 k가 1 이상이면 `Sealed test files: <k>; never edit them.`, 0이거나 파일이 없으면 `Sealed test files: 0.`
- 승인: 해결 닫기 뒤 approved가 있으면 `Approved resolutions: <id> (<choice>); <id> (<choice>).`, 없으면 `Approved resolutions: none.`

예:
- `Tripwire: 6 requirements (5 green, 0 yellow, 1 red). Violated: signup:R2.3 (counterexample ["aaa000"]). Sealed test files: 6; never edit them. Approved resolutions: none. If a requirement must change, ask the user; do not weaken requirements or tests.`
- `Tripwire: 6 requirements (6 green, 0 yellow, 0 red). All requirements pass. Sealed test files: 6; never edit them. Approved resolutions: none. If a requirement must change, ask the user; do not weaken requirements or tests.`

## adopt — 검사의 검사와 봉인 (사람 전용)

에이전트는 수용 기준마다 검사 파일(`tests/<spec>/<Rn.m>.prop.test.ts`)과 변형 파일을 만들고, 실행할 명령 줄을 사람에게 보여 준다. 사람이 `guard adopt`를 실행한다. 문지기는 에이전트의 `adopt` 실행을 막는다(guard-core 3.4) — 에이전트가 고친 검사를 스스로 다시 봉인하는 길을 닫기 위해서다.

```powershell
node ../guard/dist/cli.js adopt signup:R2.3 --test tests/signup/R2.3.prop.test.ts --mutant mutants/signup/R2.3-m1.json --mutant mutants/signup/R2.3-m2.json
```

변형 파일 하나 = 변형 하나(예: `mutants/signup/R2.3-m1.json`, 사람이 미리 둔 변형은 `-h<k>`):
```json
{
  "requirement": "signup:R2.3",
  "file": "src/signup/validate.ts",
  "find": "export const MIN_PASSWORD_LENGTH = 8;",
  "replace": "export const MIN_PASSWORD_LENGTH = 7;",
  "why": "7자 비밀번호 abcdef1을 받아들여 R2.3을 어긴다"
}
```
- 변형은 경계값을 옮기는 그럴듯한 실수부터 만든다(8 → 7·6, 14 → 13). 줄 삭제처럼 뻔한 변형만으로는 구현 상수에 묶인 약한 검사를 걸러내지 못한다
- `find`는 대상 파일에 정확히 한 번 나와야 한다. `why`는 guard가 읽지 않는 기록이다

절차:
1. `adopt.lock` 배타 생성(`fs.openSync(…, 'wx')`). `mutant-backup/`에 남은 파일이 있으면 먼저 원래 경로로 되돌린다(이전 adopt가 중간에 끊긴 경우)
2. 검사 파일만 실행: 요구사항 1.1의 인자에 검사 파일 경로(`testDir` 기준, `/` 구분)를 덧붙인다. 그 파일의 태그 테스트가 1개 이상이고, 모두 passed이고, 태그가 모두 그 요구사항이어야 한다
3. 변형 파일 검증: 형식, requirement 일치, `find`가 정확히 한 번. 하나라도 어기면 아무것도 바꾸지 않고 1
4. 변형마다: 대상 파일을 `mutant-backup/<루트 기준 경로>`에 복사(`copyFileSync`) → 바꿔 쓰기 → 검사 파일만 실행 → `finally`에서 원본 바이트로 되돌리고 해시 확인 → 백업 삭제. 그 요구사항 태그 테스트 중 failed가 있어야 잡은 것
5. 모두 잡으면 sealed.json 갱신(같은 path는 교체), events `human` 줄, stdout `sealed … (<n> mutants caught)`, lock 해제, check 1회 → 0. 하나라도 못 잡으면 stderr `mutant survived: <ID> (<변형 파일>)` → 1
- 변형은 원본 파일을 잠깐 바꿨다 되돌리는 방식이다(사람이 실행하므로 hook은 돌지 않는다). 그동안 guard serve는 파일 감시를 멈추고(guard-serve 3.3), check는 `adopt in progress`로 비켜 선다

## 동시 실행

- check는 시작할 때 `.kiro/guard/check.lock`을 배타 생성한다. 이미 있으면 200ms마다 다시 시도해 최대 60초 기다리고, 수정 시각이 120초보다 오래된 lock은 지우고 진행한다. 끝날 때(예외 포함) 지운다
- hook은 동기·순차로 돌아 같은 에이전트의 check끼리는 겹치지 않는다. 겹치는 경우는 guard serve의 사람 저장 검사와 hook 검사가 동시에 돌 때뿐이다

## Testing

- 단위 테스트 + PBT:
  - 실행 요약 해석: 임의의 줄이기 트리(깊이 0 입력 목록 + 깊이별 시도 목록)를 fast-check 형식 문자열(색 코드 포함)로 만들어 해석하면 inputs·shrinkPath가 원래 트리와 같다 / 색 코드 제거는 두 번 해도 같다
  - code 추출: 줄 번호는 1부터, 해석되는 태그가 없는 줄은 결과에 없다, `\r\n` 파일과 `\n` 파일의 결과가 같다
  - inputsHash: 같은 파일 집합 → 같은 값, 감시 파일 한 바이트를 바꾸면 다른 값, 감시 밖 파일을 바꾸면 같은 값
  - runs 정리: check 뒤 runs 폴더의 파일 집합 = 실행 요약이 있는 red 요구사항의 이름 집합
