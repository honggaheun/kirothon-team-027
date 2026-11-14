# Requirements Document

## Introduction

회원가입 요청을 받아 가입을 받아들일지 거절할지 정하는 검증 모듈(`src/signup/validate.ts`)의 요구사항이다. 검증 함수는 받아들이면 `{ ok: true }`, 거절하면 `{ ok: false, reason }`을 돌려준다.

요구사항 3의 근거는 개인정보 보호법 제22조의2 제1항(2023. 3. 14. 개정으로 신설)이다: "개인정보처리자는 만 14세 미만 아동의 개인정보를 처리하기 위하여 이 법에 따른 동의를 받아야 할 때에는 그 법정대리인의 동의를 받아야 하며, 법정대리인이 동의하였는지를 확인하여야 한다."

## Requirements

### Requirement 1

**User Story:** 가입자로서, 올바른 이메일로만 가입되기를 원한다.

#### Acceptance Criteria

1. WHEN 이메일에 `@`가 없으면 THEN 시스템은 가입을 거절해야 한다(SHALL)
2. WHEN 이미 가입된 이메일이면 THEN 시스템은 가입을 거절해야 한다(SHALL)

### Requirement 2

**User Story:** 가입자로서, 안전한 비밀번호만 쓰이기를 원한다.

#### Acceptance Criteria

1. WHEN 비밀번호에 영문자가 없으면 THEN 시스템은 가입을 거절해야 한다(SHALL)
2. WHEN 비밀번호에 숫자가 없으면 THEN 시스템은 가입을 거절해야 한다(SHALL)
3. WHEN 비밀번호가 8자 미만이면 THEN 시스템은 가입을 거절해야 한다(SHALL)

### Requirement 3

**User Story:** 운영자로서, 만 14세 미만 가입에 법정대리인 동의를 받고 싶다.

#### Acceptance Criteria

1. WHEN 가입자가 만 14세 미만이고 법정대리인 동의가 없으면 THEN 시스템은 가입을 거절해야 한다(SHALL) (근거: 개인정보 보호법 제22조의2 제1항)
