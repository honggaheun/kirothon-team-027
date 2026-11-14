# Requirements Document

## Introduction

공지를 실행 가능한 일정과 알림으로 바꾸는 서비스(챙김)의 등록 판정을 다룬다. 판정은 `chaenggim/rules.py`의 순수 함수 `check(dict)`가 맡는다.

## 다른 입력의 유효 전제

아래 두 기준의 검사는 대상 기준과 관련된 값만 바꾸고, 나머지 입력은 모두 다음처럼 유효하게 고정한다.

- userId = ownerId
- approved = true
- version = expectedVersion
- duplicate = false
- items는 한 항목
- 제목은 1~160자
- 날짜 순서는 정상(종료가 시작보다 뒤)
- 알림은 항목마다 최대 3개
- 알림은 일정 시작 이전

## Requirements

### Requirement 1

**User Story:** 사용자로서, 시작 날짜가 확인되지 않은 일정이 등록되지 않기를 원한다. 그래야 날짜 없는 일정이 달력에 남지 않는다.

#### Acceptance Criteria

1. WHEN 일정 종류가 event이고 시작 날짜가 확인되지 않아 start가 null인 경우 THEN 시스템은 그 일정의 등록을 거절해야 한다(SHALL).

### Requirement 2

**User Story:** 사용자로서, 밤과 이른 아침에 울리는 알림이 등록되지 않기를 원한다. 그래야 휴식 시간에 방해받지 않는다.

#### Acceptance Criteria

1. WHEN 알림의 한국 시각이 22:00 이상 또는 08:00 미만인 경우 THEN 시스템은 알림 등록을 거절해야 한다(SHALL).
