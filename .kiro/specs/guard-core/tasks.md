# Implementation Plan

- [x] 1. 프로젝트 골격과 명령줄 처리
  - 하위 명령 분기(scan·judge·gate, 나머지는 자리만 — 하위 명령은 항상 첫 인자), 사용법 오류 종료 코드 64, JSON 입력·stdin의 BOM 떼기 공통 함수, 정규화(경로·명령) 공통 함수
  - 빌드 설정(`npx tsc` → `guard/dist/`)과 dist의 모듈 형식 `package.json`(tsconfig 출력 형식과 같게 — ESM이면 `{"type": "module"}`, 다시 빌드해도 남게). dist는 Node 내장 모듈과 dist 안의 상대 import만 쓴다 — 파워에 넣어 다른 저장소로 복사해도 돌아야 한다
  - _Requirements: 1.1, 2.1, 3.1_
- [ ] 2. scan 구현과 테스트
  - 단위 테스트 + PBT(ID 개수 = 수용 기준 개수, 중복 없음, basis는 마지막 `(근거:`부터 문장 끝까지가 괄호 묶음 하나일 때만 — 문장 중간의 `(근거:` 언급은 basis 없음, 근거 안의 짝 맞는 괄호는 유지, textHash는 근거를 포함한 text의 해시), 중복 ID 종료 코드 1
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
- [x] 3. judge 구현과 테스트
  - `--broken-seals`·`--gen-hashes` 입력, 판정 순서 seal-broken → test-failed → no-tests → stale → all-passed, passed·failed만 세기, 문구가 없는 실패 메시지, orphans, overall·summary
  - 단위 테스트 + PBT(seal-broken → 반드시 red, 실패 → red, 연결 0개 → yellow, 전부 통과·해시 같음 → green, skipped를 더해도 판정 불변)
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
- [x] 4. gate 구현과 테스트
  - 작업 공간 모드·파일 모드, 예약 경로, 승인 명령(토큰 규칙), 읽기 실패, 봉인 일치·edit-spec 면제, 빨강 메시지, events 한 줄(표시 경로·표시 명령)
  - 단위 테스트 + PBT(예약 → 항상 2, 봉인 일치·면제 없음 → report와 무관하게 2, 같은 입력 → 같은 결과, BOM 유무 → 같은 결과)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_
- [x] 5. 반례 기록 파일 이름 함수와 테스트
  - `signup:R2.3` → `signup__R2.3.json`. PBT(금지 문자 없음, 서로 다른 ID → 서로 다른 이름). guard-check가 이 함수를 쓴다
  - _Requirements: 4.1_
