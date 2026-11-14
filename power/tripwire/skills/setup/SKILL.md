---
name: setup
description: "작업 공간에 Tripwire를 설치한다. guard 실행 파일이 없으면 이 스킬에 든 것을 .kiro/guard/bin으로 복사하고, 사람 확인을 받아 가며 steering(.kiro/steering/guard-rules.md)을 쓰고, 설정(.kiro/guard/config.json)은 내용을 보여 주어 사람이 넣게 하고, 검사가 없는 기준은 property-tests와 check-the-checks로 검사와 변형을 먼저 만들어 사람이 봉인(guard adopt)하게 한 뒤, hook(.kiro/hooks/tripwire.json)을 맨 마지막에 켠다. 'Tripwire 설치', '훅 설치', 'set up tripwire', 'install the hooks' 같은 요청이나, 다른 tripwire 스킬이 설치가 안 돼 있다고 판단할 때 쓴다."
---

# setup — 작업 공간에 Tripwire 깔기

파워에는 hook을 넣을 수 없다. 그래서 이 스킬의 절차대로 에이전트가 (guard가 없으면) 이 스킬에 든 guard를 `.kiro/guard/bin/`으로 복사하고 작업 공간에 steering과 hook을 깔며, 설정 파일과 검사 봉인은 사람이 하도록 내용과 명령 줄을 준비한다. 판정과 차단은 `guard` CLI가 하고, 이 스킬은 그 CLI를 부르는 hook과 규칙을 놓는다.

## 원칙

- **[사람 확인]** 표시가 있는 단계에서는 이번 응답을 질문으로 끝내고, 사람이 명시적으로 승인하거나 맡은 일을 했다고 알릴 때까지 다음 단계로 가지 않는다. 사람에게 물을 수 없는 실행(무인 실행)이면 1단계 결과와 확인할 것만 보고하고 멈춘다.
- hook 파일을 쓰는 순간부터 `.kiro/guard/`와 `.kiro/hooks/`는 에이전트가 쓸 수 없다(집행 모드의 문지기가 막는다). 그래서 steering을 먼저 쓰고(config는 사람이 넣는다) **hook 파일은 맨 마지막에** 쓴다.
- 셸 명령에 `.kiro/guard`·`.kiro/hooks` 문자열을 넣지 않는다. 설치 뒤에는 문지기가 그런 셸 명령을 모두 막는다. 이 두 폴더의 파일은 파일 읽기 도구로 읽는다. 예외는 hook을 깔기 전의 4-0(guard 복사)과 4-4(첫 check)뿐이다.
- 패키지는 사람의 승인 없이 설치하지 않는다. `config.json`·`resolution.json`·`sealed.json`·`report.json`·`index.json`·`events.jsonl`은 쓰지 않는다 — 사람이나 guard가 쓴다.
- 봉인(`guard adopt`)과 해결 기록(`guard resolve`)은 사람이 실행한다. 에이전트는 실행할 명령 줄을 보여 줄 뿐 실행하지 않는다(인자 없이도) — hook을 깔기 전이라 문지기가 없어도 같다.
- 셸은 PowerShell일 수 있다. 명령을 이을 때 `&&` 대신 `;`를 쓰고, 공백·한글이 든 경로는 따옴표로 감싼다.

이 문서에서 `<guard>`는 guard 실행 명령이다. 1단계에서 정한다. 다른 저장소에 설치하면 `node .kiro/guard/bin/cli.js`(4-0에서 이 스킬이 복사해 둔 guard)이고, guard를 개발하는 저장소라면 `node guard/dist/cli.js` 또는 `node ../guard/dist/cli.js`다. guard는 실행한 폴더의 `.kiro/guard/`를 쓰므로 항상 작업 공간 루트에서 실행한다.

## 1. 상태 확인 (읽기만)

| 확인 | 방법 | 결과에 따라 |
|---|---|---|
| 작업 공간 루트 | Kiro가 연 폴더(`.kiro/`가 있는 곳). hook 명령은 여기서 실행된다 | |
| 스펙 | `.kiro/specs/*/requirements.md`에서 `Requirement N`(또는 `요구사항 N`) 제목 아래 `Acceptance Criteria`(또는 `수용 기준`) 번호 목록. m번째 항목이 ID `RN.m` | 스펙이 없으면 멈추고 알린다 |
| 설치 여부 | `.kiro/hooks/tripwire.json`이 있는가 | 있으면 이미 설치된 것이다. hook 파일과 `.kiro/guard/`는 쓰지 않는다 — 바꿀 것이 있으면 사람이 직접 고쳐야 한다고 알린다. `.kiro/guard/config.json`이 없는데 기본값이 맞지 않으면 4-2대로 내용을 보여 주고 사람이 넣게 한다. steering이 없으면 4-1만 쓰고, 검사가 모자라면 5단계, 그다음 7단계 확인을 한다 |
| guard CLI | ① `.kiro/guard/bin/cli.js`(설치된 복사본) ② `guard/dist/cli.js` ③ `../guard/dist/cli.js`(guard를 개발하는 저장소) 순서로 찾는다 | 찾은 경로로 `<guard>` = `node <경로>`. 셋 다 없으면 4-0에서 이 스킬에 든 guard를 복사하고 `<guard>` = `node .kiro/guard/bin/cli.js` |
| node | `node --version` | 실패하면 멈추고 알린다 |
| vitest·fast-check | `<testDir>/node_modules/vitest/package.json`(guard check는 상위 폴더를 찾지 않는다)·`<testDir>/node_modules/fast-check/package.json`. `<testDir>`는 `.kiro/guard/config.json`의 `testDir`, 없으면 작업 공간 루트 | 없으면 3단계 |
| 반례 기록 설정 | vitest 설정의 `setupFiles`가 `fc.configureGlobal({ verbose: 2 })`를 부르는가 | 없으면 4단계에서 추가를 제안 |
| 기존 검사 | 테스트 이름이 `[Rn.m]` 또는 `[<spec>:Rn.m]`으로 시작하는 검사 | 기준별 개수를 센다 |
| steering | `.kiro/steering/guard-rules.md`가 있는가 | 있으면 덮어쓰지 않고, 4-1의 내용과의 차이를 보여 준 뒤 묻는다 |

## 2. 계획 보고 [사람 확인]

다음을 보여 주고 승인을 받는다.

- 스펙별 수용 기준 수, 이미 검사가 있는 기준 수
- `<guard>` 실행 명령
- 모드 — 아래 둘 중 사람이 고른다
- 에이전트가 만들 파일: (guard가 없으면) `.kiro/guard/bin/`(이 스킬에 든 guard 복사, 4-0), `.kiro/steering/guard-rules.md`, (필요하면) vitest 설정 변경, 검사 파일과 변형 파일, 맨 마지막에 `.kiro/hooks/tripwire.json`
- 사람이 할 일: (기본값이 맞지 않으면) `.kiro/guard/config.json` 넣기(4-2), 기준마다 봉인 명령 `<guard> adopt …` 실행(5단계)

| 모드 | hook | 맞는 곳 |
|---|---|---|
| 집행(enforce) | 문지기(쓰기·셸 전 `gate`) + 쓰기 후 검사 + 스펙 작업 시작 막기 + 세션 요약 | 에이전트에게 길게 맡기는 작업 공간(스펙 작업 일괄 실행, CLI 무인 실행) |
| 관찰(observe) | 쓰기 후 검사 + 세션 요약. 막지 않는다 | guard 자체를 개발하는 저장소처럼, 새로 쓰는 검사나 도구 결함 때문에 스스로 막힐 수 있는 곳 |

## 3. 패키지 [사람 확인] — 없을 때만

vitest나 fast-check가 없으면 설치 명령을 보여 주고, 승인을 받은 뒤에만 실행한다. 버전은 고정하고 공식 레지스트리를 쓴다. `<testDir>`(1단계)에서 실행한다 — guard check는 그 폴더의 `node_modules/vitest`만 찾는다. `package.json`이 없으면 먼저 `npm init -y`.

`npm install --save-dev --save-exact --registry=https://registry.npmjs.org/ vitest@5.0.5 fast-check@4.10.2`

설치 뒤 `npm audit signatures --registry=https://registry.npmjs.org/`로 레지스트리 서명을 확인한다. 이 밖의 패키지는 설치하지 않는다. IDE에서 `npm`·`npx`를 찾지 못하면, PATH를 바꾼 뒤에는 IDE를 다시 실행해야 새 PATH를 읽는다고 알린다.

## 4. guard·steering·config·vitest 설정

**4-0. guard 복사** — 1단계에서 guard CLI를 찾지 못했을 때만. 이 스킬의 `scripts/guard/` 폴더에는 guard 빌드 결과(Node 내장 모듈만 쓰므로 node 22 이상만 있으면 된다), 모듈 형식을 밝힌 `package.json`, 화면 파일 `ui/`(guard serve가 쓴다)가 들어 있다. 폴더 전체를 작업 공간의 `.kiro/guard/bin/`으로 복사한다. hook을 깔기 전이므로 이 단계에서는 셸 명령에 `.kiro/guard` 경로를 쓴다.

- PowerShell: `New-Item -ItemType Directory -Force .kiro\guard\bin | Out-Null; Copy-Item -Recurse -Force "<스킬 폴더>\scripts\guard\*" .kiro\guard\bin\`
- macOS·Linux: `mkdir -p .kiro/guard/bin && cp -R "<스킬 폴더>/scripts/guard/." .kiro/guard/bin/`
- `<스킬 폴더>`는 이 SKILL.md가 들어 있는 폴더다. Kiro가 경로를 알려 주지 않으면 사용자 홈의 `.kiro/powers/` 아래에서 `skills/setup/scripts/guard/cli.js`를 찾는다.
- 복사한 뒤 `node .kiro/guard/bin/cli.js`를 인자 없이 실행해 사용법이 나오는지 본다.
- 설치된 guard는 예약 경로 안에 있다. hook을 깐 뒤에는 에이전트가 이 파일을 고칠 수 없고, 셸로 실행하지도 못한다(문지기가 막는다). 그래서 guard를 실행하는 확인(4-4)은 hook을 깔기 전에 하고, 그 뒤에는 사람이 실행한다.
- 팀원도 같은 guard로 검사받게 하려면 `.kiro/guard/bin/`을 저장소에 함께 커밋하라고 알린다.

**4-1. `.kiro/steering/guard-rules.md`** — 아래 내용 그대로 쓴다. 앞머리는 첫 줄부터, 빈 줄 없이 시작한다.

```markdown
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
```

**4-2. `.kiro/guard/config.json`** **[사람 확인]** — 사람만 쓰는 설정 파일이다. 에이전트는 이 파일을 쓰지 않고, 내용을 보여 주어 사람이 넣게 한다.

- 파일이 없을 때의 기본값: `specsDir` `.kiro/specs`, `testGlobs` `["tests/**/*.test.ts", "test/**/*.test.ts"]`, `sourceGlobs` `["src/**/*.ts"]`, `testDir` `.`, `timeoutSeconds` 50. 작업 공간이 이 배치와 맞으면 파일을 두지 않고 다음으로 간다.
- 맞지 않으면 작업 공간에 맞게 채운 내용을 보여 주고, 사람이 `.kiro/guard/config.json`으로 저장하게 한다. 사람이 저장했다고 하면 파일 읽기 도구로 읽어 확인한다.

```json
{
  "specsDir": ".kiro/specs",
  "testGlobs": ["tests/**/*.test.ts"],
  "sourceGlobs": ["src/**/*.ts"],
  "testDir": "."
}
```

- `specsDir`: 스펙 폴더
- `testGlobs`: `[Rn.m]` 태그 검사가 들어 있는 파일. vitest가 실제로 찾는 범위 안이어야 한다
- `sourceGlobs`: 검사 대상 코드. 바뀌면 검사를 다시 돌리고, 코드 줄의 `[Rn.m]` 태그를 모아 요구사항과 잇는다
- `testDir`: `node_modules/vitest`와 vitest 설정이 있는 폴더. guard check는 이 폴더에서 vitest를 실행하고 상위 폴더는 찾지 않는다

**4-3. vitest 설정** — 1단계에서 반례 기록 설정이 없었다면, 2단계에서 승인받은 대로 `setupFiles`에 `fc.configureGlobal({ verbose: 2 })`를 부르는 파일을 추가한다. 시험한 입력과 줄이기 경로가 실패 메시지에 남아야 guard가 반례 찾기 기록을 만든다.

**4-4.** `<guard> check`를 실행해 색인과 판정이 만들어지는지 본다. 검사가 없는 기준은 노랑(`no-tests`)으로 나온다.

## 5. 검사 만들기 — 검사가 없거나 모자란 기준이 있을 때

hook보다 먼저 한다. 집행 모드의 문지기가 켜진 뒤에 새 검사가 현재 코드에서 실패하면, 쓰기 후 검사가 그 순간 빨강을 기록하고 문지기가 다음 쓰기를 막는다.

1. property-tests 스킬로 기준마다 검사를 만들고, 현재 코드에서 통과하는지 확인한다.
2. check-the-checks 스킬로 기준마다 변형 JSON을 만든다.
3. **[사람 확인]** 봉인은 사람이 실행한다. 기준마다 `<guard> adopt <spec>:<Rn.m> --test <검사 파일> --mutant <변형 JSON> [--mutant <변형 JSON> …]` 명령 줄을 보여 주고, 사람이 작업 공간 루트의 자기 터미널에서 실행하게 한다. 에이전트는 adopt를 실행하지 않는다(인자 없이도).
4. 사람이 실행했다고 하면 `.kiro/guard/sealed.json`을 파일 읽기 도구로 읽어 결과 표(기준 · 검사 파일 · 변형 · 봉인 여부)를 사람에게 보여 준다. 못 잡은 변형(`mutant survived`)이 있었으면 check-the-checks 3절대로 검사를 다시 만들고 3번을 다시 한다.

## 6. hook 설치 [사람 확인]

아래 JSON의 `node ../guard/dist/cli.js`를 1단계의 `<guard>`로 바꿔 보여 주고, 다음을 알린 뒤 승인을 받는다. 바꾸는 것은 그 명령 앞부분뿐이다 — `matcher`는 그대로 둔다. `write`는 파일을 만들고·고치고·덧붙이고·지우는 도구 모두에, `shell`은 셸 실행 도구에 걸린다(Kiro CLI의 `fs_write`·`str_replace`·`fs_append`·`delete_file`, `execute_pwsh`에서 확인). 도구 이름을 늘어놓은 식으로 바꾸지 않는다.

- 쓰고 나면 `.kiro/hooks/`와 `.kiro/guard/`는 사람만 바꿀 수 있다(집행 모드).
- 끄려면 사람이 `.kiro/hooks/tripwire.json`을 지우거나 `.kiro/hooks/` 밖으로 옮긴다.
- hook 파일을 언제 다시 읽는지는 실행 환경마다 다를 수 있다. 7단계 확인에서 기록이 늘지 않으면 새 세션을 열고 다시 확인한다. IDE가 hook 명령 실행 승인을 물으면 사람이 허용해야 hook이 돈다.

집행 모드:

```json
{
  "version": "v1",
  "hooks": [
    { "name": "tripwire-gate-write", "trigger": "PreToolUse", "matcher": "write", "action": { "type": "command", "command": "node ../guard/dist/cli.js gate" }, "timeout": 10 },
    { "name": "tripwire-gate-shell", "trigger": "PreToolUse", "matcher": "shell", "action": { "type": "command", "command": "node ../guard/dist/cli.js gate" }, "timeout": 10 },
    { "name": "tripwire-check-write", "trigger": "PostToolUse", "matcher": "write", "action": { "type": "command", "command": "node ../guard/dist/cli.js check" }, "timeout": 60 },
    { "name": "tripwire-check-shell", "trigger": "PostToolUse", "matcher": "shell", "action": { "type": "command", "command": "node ../guard/dist/cli.js check --if-changed" }, "timeout": 60 },
    { "name": "tripwire-gate-task", "trigger": "PreTaskExec", "action": { "type": "command", "command": "node ../guard/dist/cli.js gate" }, "timeout": 10 },
    { "name": "tripwire-session-summary", "trigger": "SessionStart", "action": { "type": "command", "command": "node ../guard/dist/cli.js check --if-changed --summary" }, "timeout": 60 }
  ]
}
```

관찰 모드는 위에서 `tripwire-check-write`·`tripwire-check-shell`·`tripwire-session-summary` 세 개만 남긴다.

hook마다 하는 일:

- **문지기**(`PreToolUse`, `write`·`shell`): 판정 파일만 읽고 바로 끝난다. 빨강인 요구사항에 사람의 해결 승인이 없으면 종료 코드 2로 그 쓰기·셸 실행을 막고 사유를 에이전트에게 전한다. 예약 경로(`.kiro/guard/`·`.kiro/hooks/`)를 쓰거나 셸 명령에 넣는 것, 봉인된 검사 파일을 쓰거나 셸 명령에 그 경로를 넣는 것은 판정과 무관하게 막는다(봉인은 그 요구사항에 '스펙을 고친다'가 승인된 동안만 예외). 쓰기만 막으면 셸로 파일을 만들어 우회할 수 있고 셸로 만든 파일에는 파일 hook이 돌지 않으므로, 쓰기와 셸 둘 다에 건다.
- **쓰기 후 검사**(`PostToolUse`, `write`·`shell`): 태그된 검사를 돌려 판정을 갱신하고, 빨강으로 바뀌면 에이전트에게 알린다. 셸 쪽은 감시 대상 파일이 바뀌었을 때만 검사한다.
- **스펙 작업 시작 막기**(`PreTaskExec`): 빨강이고 승인이 없으면 다음 스펙 작업 시작을 막는다. IDE의 작업 실행에서만 의미가 있다.
- **세션 요약**(`SessionStart`): 현재 판정 요약을 표준출력으로 낸다. 실행 환경이 이 출력을 새 세션의 맥락에 넣으면, 에이전트는 시작부터 빨강·노랑을 안다.

hook 명령은 PowerShell 같은 셸을 한 번 더 거치지 않고 `node`를 직접 부른다. hook은 도구 호출마다 차례로 돌기 때문에 셸을 거치면 그만큼 느려진다. 사람이 편집기에서 저장한 변경에는 파일 hook이 돌지 않는다 — 사람의 변경은 `guard serve`가 파일을 지켜보다 검사하고 화면으로 경고한다(막지 않는다).

## 7. 확인과 보고

1. hook이 실제로 도는지 본다. 먼저 `.kiro/guard/events.jsonl`의 줄 수를 파일 읽기 도구로 적어 둔다.
   - 집행 모드: 무해한 셸 명령 하나(`node --version`)를 실행한 뒤 다시 읽어, 문지기가 덧붙인 `shell` 줄(`"action":"shell","target":"node --version"`)이 생겼는지 본다.
   - 관찰 모드: 셸 명령으로는 줄이 늘지 않는다(감시 대상 파일이 그대로면 셸 쪽 쓰기 후 검사가 건너뛴다). 적어 둔 줄 수와 마지막 줄의 시각을 사람에게 알리고 새 세션을 열어 달라고 한다. 새 세션에서 그 시각 뒤의 `guard check · 빨강 …` 줄(세션 요약 hook이 남긴 줄)이 하나 늘었으면 hook이 돌고 있다.
2. 줄이 그대로라면 hook이 돌지 않는 것이다. hook 명령이 실패해도 종료 코드가 2가 아니면 아무것도 막지 않으므로, 지금은 보호가 꺼진 상태라고 사람에게 분명히 알린다. 볼 것: hook을 띄우는 프로세스가 `node`를 찾는가(PATH를 바꿨다면 IDE를 다시 실행), `<guard>` 경로가 맞는가, 새 세션에서도 같은가.
3. `report.json`을 파일 읽기 도구로 다시 읽는다. `<guard>`가 `.kiro/guard/bin/` 안에 있으면 에이전트는 guard를 셸로 실행하지 않는다(집행 모드에서는 문지기가 막는다) — 4-4와 쓰기 후 검사가 만든 판정을 읽는다. guard를 개발하는 저장소의 `<guard>`라면 `<guard> check --summary`를 실행한 뒤 읽어도 된다.
4. 보고: 모드, 설치한 파일, hook 동작 확인 결과, 전체 판정과 초록·노랑·빨강 개수, 봉인된 검사 수, 다음에 할 일(노랑이 있으면 property-tests).
5. 집행 모드라면, 이제부터 `Tripwire:`로 시작하는 거부를 받으면 resolve-violation 스킬을 따른다고 사람에게 알린다.

## 되돌리기

hook은 사람이 `.kiro/hooks/tripwire.json`을 지우거나 `.kiro/hooks/` 밖으로 옮겨서 끈다. 에이전트는 지우지 못하고, 지우려고 시도하지도 않는다. 4-0에서 복사한 guard(`.kiro/guard/bin/`)를 지우는 것도 사람이 한다 — hook을 먼저 끄지 않고 지우면 hook 명령이 실패해 아무것도 막지 않는 상태가 된다.
