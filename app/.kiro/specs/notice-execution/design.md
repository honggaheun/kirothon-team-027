# Design Document

## Overview

등록 판정은 Python 서버의 `chaenggim/rules.py`에 있는 `check(dict)`다. 이 함수는 외부 상태를 읽지 않으며 `{'ok': bool, ...}`를 돌려준다. TypeScript로 판정을 다시 구현하지 않는다.

## 검사 진입점

- `scripts/python-predicate.ts`: `node:child_process`의 `execFileSync`로 `scripts/predicate_entry.py`를 호출한다. JSON을 표준입력으로 넘기고, `chaenggim.rules.check`의 결과 JSON을 그대로 돌려준다. 이 파일에서는 판정하지 않는다.
- `scripts/predicate_entry.py`: `json`, `sys`, `pathlib`과 `chaenggim.rules.check`만 사용한다.
- Python 경로는 `.venv/Scripts/python.exe`, `.venv/bin/python`, `python3` 순서로 고른다.
- 호출마다 새 프로세스를 `-B`(`.pyc` 캐시 끔)와 UTF-8 입출력으로 실행한다. 그래서 변형으로 바뀐 실제 `chaenggim/rules.py`가 같은 초 안에도 반영된다.
- 환경 변수, 네트워크, 현재 시각은 기대값에 쓰지 않는다.

## 검사 방식

| 기준 | 속성 | 생성기 |
|---|---|---|
| R1.1 | event의 start가 null이면 거절 | `fc.constant(null)` (start=null, end=null, reminders=[]) |
| R2.1 | 한국 시각 22:00 이상 또는 08:00 미만이면 거절 | `'22:00'`, 1320~1439분, 0~479분을 `HH:MM`으로 변환 |

R2.1의 고정 입력: 알림 날짜 2026-11-20, 일정 시작 2026-11-21T09:00:00+09:00, 종료 같은 날 10:00.

## 변형 (check-the-checks)

변형은 `mutants/notice-execution/*.json`에 둔다. 원본 소스는 바꾸지 않는다.

- R1.1-m1: event의 start 누락 거절 조건에 `item.get('start')`를 덧붙여 start가 null이면 통과시킨다.
- R2.1-m1: 알림 시각 상한 `<22`를 `<23`으로 옮긴다.
- R2.1-m2: 같은 상한을 `<24`로 옮긴다.

## 봉인 상태

2026-11-14 index 생성 후 실제 `textHash`를 검사 주석에 기록했다. 사용자가 설정·봉인 실행을 Codex에 명시적으로 위임했고, R1.1의 변형 1개와 R2.1의 변형 2개를 모두 검출한 뒤 검사 2개를 채택·봉인했다. 봉인된 검사는 이후 수정하지 않았다.

Kiro CLI v3로 표시 이름 수정 작업을 실행하여 세션 시작 검사, `calendar_export.py`와 해당 단위 검사에 대한 쓰기 gate, pytest 명령 gate 및 변경 후 검사 통과를 events 기록으로 확인했다. CLI 기본 v2 대신 `kiro-cli chat --v3 --trust-workspace`로 실행한다. 실제 위반의 쓰기 차단 시나리오는 별도 검증 범위다.
