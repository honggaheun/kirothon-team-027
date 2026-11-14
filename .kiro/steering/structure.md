---
inclusion: always
---
# 구조

## 폴더

| 경로 | 내용 | 쓰는 쪽 |
|---|---|---|
| `.kiro/specs/guard-core/` | 색인·판정·문지기(`scan`·`judge`·`gate`) 스펙 | 사람 승인 뒤에만 수정 |
| `.kiro/specs/guard-check/` | 검사 실행·판정 기록(`check`) 스펙 | 사람 승인 뒤에만 수정 |
| `.kiro/specs/guard-serve/` | 화면 서버·파일 감시(`serve`) 스펙 | 사람 승인 뒤에만 수정 |
| `.kiro/specs/stage-ui/` | 무대 화면 스펙 | 사람 승인 뒤에만 수정 |
| `.kiro/steering/` | product·tech·structure·guard-rules | 사람 |
| `.kiro/hooks/tripwire.json` | 지금 켜져 있는 hook 정의 | 사람만 |
| `.kiro/guard/` | 설정 `config.json`(`testGlobs` `guard/test/**/*.test.ts`·`sourceGlobs` `guard/src/**/*.ts`·`testDir` `.`)과 실행 데이터 `index.json`·`report.json`·`resolution.json`·`sealed.json`·`events.jsonl`·`runs/<spec>__<Rn.m>.json` | 사람과 `guard`만 |
| `guard/src/`·`guard/test/` | CLI 소스와 그 검사 | 에이전트 |
| `guard/dist/cli.js` | 빌드 결과(`npx tsc`). hook이 이 파일을 실행한다 | 빌드 |
| `package.json`·`node_modules/` | 루트의 개발 의존(typescript·vitest·fast-check·@types/node). guard check가 루트(`testDir` `.`)의 `node_modules/vitest`로 검사를 돌린다 | 사람(설치·의존 목록) |
| `vitest.config.*` | 루트 검사 설정. `include`는 `guard/test/**/*.test.ts`만 | 에이전트 |
| `ui/` | 무대 화면 정적 파일(`guard serve`가 제공) | 에이전트 |
| `power/tripwire/` | Kiro 파워: `plugin.json` + `skills/<스킬>/SKILL.md`. hook은 파워에 넣을 수 없어, setup 스킬이 설치할 작업 공간의 `.kiro/hooks/`에 깐다 | 에이전트 |
| `power/tripwire/skills/setup/scripts/guard/` | 파워에 함께 넣는 guard: `guard/dist/` 빌드 결과를 그대로 복사한 것 + 모듈 형식을 밝힌 `package.json` + 화면 `ui/`(guard serve는 CLI 옆의 `ui/`를 먼저 찾는다). setup 스킬이 다른 저장소의 `.kiro/guard/bin/`으로 복사한다. 손으로 고치지 않는다 — 빌드 뒤 다시 복사해 갱신한다 | 빌드 복사 |
| `hooks-variants/` | 꺼 둔 hook 판(`tripwire.observe.json`·`tripwire.full.json`). 사람이 `.kiro/hooks/tripwire.json`으로 복사해 켠다 | 사람 |
| `demo/` | 시연 작업 공간. 독립된 `.kiro/`(specs/signup·steering·hooks·guard)와 자체 `package.json`·`node_modules`를 가지고 `node ../guard/dist/cli.js`로 가드를 부른다. guard 설정은 기본값(`src/**`·`tests/**`)이라 `config.json`이 없다 | demo 작업 공간의 에이전트 |
| `demo/hooks-variants/` | 꺼 둔 시연판 hook(`tripwire.json`). demo의 검사를 봉인한 뒤 사람이 `demo/.kiro/hooks/tripwire.json`으로 복사해 켠다 | 사람 |

하위 명령(`resolve`·`adopt` 포함)의 정확한 계약은 해당 스펙의 requirements.md·design.md가 기준이다.

## 규칙

- 이 저장소에는 스펙이 4개라 같은 ID(`R1.1` 등)가 여러 스펙에 있다. 짧은 태그 `[R1.1]`은 여러 스펙에 걸려 고아가 되므로, 검사 제목과 코드 태그는 항상 `[guard-core:R1.1]`처럼 스펙 이름을 붙인다
- 루트에서 도는 검사는 `guard/test/` 아래 것뿐이다(루트 vitest 설정의 `include`와 `.kiro/guard/config.json`의 `testGlobs` = `guard/test/**/*.test.ts`). `demo/`의 검사는 demo 작업 공간에서만 돈다 — 루트 검사가 demo의 `[R2.3]`을 모으면 가드 스펙에 잘못 연결된다
- `.kiro/guard/`는 실행한 폴더 기준이다: 루트에서 실행하면 루트의 `.kiro/guard/`, `demo/`에서 실행하면 `demo/.kiro/guard/`
- 요구사항 하나의 반례 기록 파일은 `runs/<spec>__<Rn.m>.json`이다(콜론 대신 밑줄 두 개)
- 소스 줄과 요구사항의 연결은 그 줄의 주석이나 문자열에 태그를 달아 표시한다(예: `// [guard-core:R3.2]`). 화면의 실이 이 태그를 잇는다
- 커밋 메시지는 영어로 `type: Subject` 형식이다. type은 feat·fix·docs·style·refactor·test·chore·build·ci·release, 제목은 50자 이내의 대문자로 시작하는 명령문이고 마침표를 찍지 않는다. 본문이 필요하면 72자에서 줄을 바꿔 무엇을 왜 바꿨는지 쓴다
