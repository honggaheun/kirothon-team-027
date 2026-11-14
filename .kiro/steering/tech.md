---
inclusion: always
---
# 기술

## 환경

- Windows 11, 셸은 PowerShell 5.1이다. 셸 명령은 PowerShell 문법으로 쓴다(`&&`·`||` 대신 `;`, 공백·한글이 든 경로는 따옴표로 감싼다)
- 사용자 폴더 경로에 한글이 있다. 경로를 ASCII로 가정하지 않고, 파일은 UTF-8(BOM 없음)로 읽고 쓴다
- `node`는 v22, `npm`·`npx`는 v26 설치본이다. 둘 다 PATH에 있고 이 조합이 정상이다 — Node를 새로 설치하거나 PATH를 바꾸지 않는다
- Rust 등 네이티브 툴체인을 쓰지 않는다 — 비ASCII 사용자 경로에서 GNU 링커가 실패한다

## 언어와 도구

- TypeScript(strict). 빌드 `npx tsc` → `guard/dist/cli.js`, 실행 `node guard/dist/cli.js <scan|judge|gate|check|serve|resolve|adopt>`
- 런타임 의존 없음(Node 내장 모듈만). 개발 의존(typescript·vitest·fast-check·@types/node)은 사람이 설치한다 — 위치는 저장소 루트의 `package.json`·`node_modules`(guard check의 `testDir` = `.`)와 `demo/`의 자체 `package.json`·`node_modules`. 없으면(`node_modules/vitest`가 없거나 `npx tsc`가 typescript를 찾지 못하면) 멈추고 사람에게 알린다
- 새 패키지를 설치하지 않는다(`npm install <이름>` 금지). package.json의 의존 목록을 바꾸지 않는다
- `guard/dist/`는 다른 폴더로 복사해도 그대로 돌아가야 한다(파워의 setup 스킬이 다른 저장소의 `.kiro/guard/bin/`으로 복사한다). dist 안에서는 Node 내장 모듈과 dist 안의 상대 경로 import만 쓰고, 빌드할 때 dist에 모듈 형식을 밝힌 `package.json`(ESM이면 `{"type": "module"}`)을 함께 쓴다 — 복사본은 저장소 루트의 package.json을 보지 못한다
- 테스트는 vitest 5 + fast-check 4. vitest setup 파일의 fast-check 전역 설정 `verbose: 2`를 지우지 않는다 — 반례 기록이 실패 메시지의 `Execution summary`를 읽는다
- fast-check 4에는 `fc.fullUnicode`·`fc.fullUnicodeString`·`fc.unicodeString`·`fc.stringOf`·`fc.asciiString`이 없다. 문자열은 `fc.string({ unit, minLength, maxLength })`로 만든다(`unit`: `'grapheme'`·`'grapheme-ascii'`·`'binary'`·`'binary-ascii'` 또는 한 글자를 내는 Arbitrary)

## 구현 규칙

- hook 명령은 작업 공간 루트에서 실행되고 이벤트 JSON을 표준입력으로 받는다. `.kiro/guard/`는 실행한 폴더(현재 작업 폴더) 기준으로 찾는다 — CLI 파일 위치 기준이 아니다. `demo/`에서 `node ../guard/dist/cli.js`로 부르면 `demo/.kiro/guard/`를 쓴다
- 표준입력 앞에 UTF-8 BOM이 붙어 올 수 있다. 떼고 파싱하고, 파싱에 실패하면 빈 이벤트로 다룬다
- 이벤트의 경로는 `c:\Users\...\src\a.ts`처럼 절대 경로(드라이브 소문자, 역슬래시)로 올 수 있다. 비교 전에 `\`를 `/`로 바꾸고 소문자로 만든다
- Kiro CLI에서 확인된 도구는 쓰기 `fs_write`·`str_replace`(대상 `tool_input.path`), 셸 `execute_pwsh`(`tool_input.command`)다. IDE에서는 이름이 다를 수 있으므로 도구 이름이 아니라 `tool_input`의 키로 대상을 정한다
- vitest는 `.cmd`를 shell 없이 띄우면 실패한다. `vitest` 패키지 package.json의 `bin` 경로(`vitest.mjs`)를 `process.execPath`로 직접 실행한다
- vitest JSON의 `failureMessages`에는 ANSI 색 코드가 섞여 있다. 벗기고 파싱한다
- Windows 파일 이름에 콜론을 쓰지 않는다. `signup:R2.3`의 기록 파일은 `runs/signup__R2.3.json`이다(콜론을 쓰면 NTFS 대체 데이터 스트림이 된다)
- `gate`는 검사를 돌리지 않고 `.kiro/guard/`의 report·resolution·sealed 파일만 읽는다. 지연 예산 100ms
- 판정 로직에 AI·네트워크 호출을 넣지 않는다
- JSON 출력은 UTF-8(BOM 없음), 들여쓰기 2칸

## 작성 관례

- 주석은 무엇을 하는지만 짧게 쓴다: 파일 머리 1~3줄, 함수 1줄
- 커밋 메시지는 영어 `type: Subject` — 제목 줄 50자 이내, Subject는 대문자로 시작하는 명령문, 끝에 마침표 없음. 필요하면 빈 줄 뒤 본문에 무엇을·왜 바꿨는지(줄마다 72자 이내). type = feat·fix·build·chore·ci·docs·style·refactor·test·release. 한 커밋에 한 작업
