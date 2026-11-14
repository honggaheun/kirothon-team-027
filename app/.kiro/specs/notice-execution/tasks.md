# Implementation Plan

- [x] 1. 검사 진입점 만들기
  - `scripts/predicate_entry.py`, `scripts/python-predicate.ts`, `vitest.config.mts`, `vitest.setup.ts`
  - _Requirements: 1.1, 2.1_

- [x] 2. R1.1 속성 검사 만들기
  - `tests/tripwire/R1.1.prop.test.ts`
  - _Requirements: 1.1_

- [x] 3. R2.1 속성 검사 만들기
  - `tests/tripwire/R2.1.prop.test.ts`
  - _Requirements: 2.1_

- [x] 4. 변형 JSON 만들기
  - `mutants/notice-execution/R1.1-m1.json`, `R2.1-m1.json`, `R2.1-m2.json`
  - _Requirements: 1.1, 2.1_

- [x] 5. 사용자 명시 위임에 따른 검사 채택·봉인
  - `.kiro/guard/index.json` 생성 후 `textHash`를 테스트 머리 주석에 기록
  - 2026-11-14 사용자가 설정·봉인 실행을 Codex에 명시적으로 위임한 뒤 실행
  - R1.1: 변형 1개, R2.1: 변형 2개를 모두 검출한 검사 2개 채택·봉인
  - Kiro CLI v3에서 세션 시작·쓰기·명령 실행 hook 호출과 변경 후 검사 통과 기록 확인
  - _Requirements: 1.1, 2.1_
