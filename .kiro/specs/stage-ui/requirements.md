# Requirements Document

## Introduction

`guard serve`가 제공하는 스펙 실 화면이다(`ui/` 정적 파일, 프레임워크·빌드 단계 없음). 1920×1080 무대 한 장에 상태 띠·요구사항 카드·스펙 실·코드 줄·활동 열·반례 띠를 두고, 데이터는 `guard serve`에서만 받는다(guard-serve 요구사항 1.3·2). 화면은 판정하지 않는다 — 보이는 값은 모두 `.kiro/guard/`의 기록(guard-core 데이터 계약)에서 온다. 연출(Requirement 10)은 주소의 `fx=0`으로 끌 수 있고, 끄면 Requirement 1~9의 기본 화면만 남는다.

용어

- 전체 ID: `<spec>:<Rn.m>`. report·sealed·resolution·runs가 쓰는 표기다
- 반례 표기: counterexample을 Requirement 4.1의 규칙으로 바꾼, 사람이 읽는 문자열
- 근거 문구: red 요구사항이 왜 red인지 보이는 짧은 문구(Requirement 4.2)
- 선택 문구: `revert-code` = "코드를 되돌린다", `edit-spec` = "스펙을 고친다"
- 주 실: 한 요구사항의 실 가운데 카드 가운데와 코드 줄 가운데의 세로 차가 가장 작은 실
- 매듭점: 주 실 위에서 도장의 지시선이 가리키는 점. 연출이 실을 끊는 자리다

## Requirements

### Requirement 1

**User Story:** 화면을 보는 사람으로서, 1920×1080 한 화면에 모든 영역이 스크롤 없이 보이길 원한다.

#### Acceptance Criteria

1. WHEN 화면을 열면 THEN 화면은 1920×1080 무대 하나를 창 가운데에 가로세로 비율을 유지한 채 창에 들어가는 가장 큰 배율로 그려야 하고, 무대 안 영역은 상태 띠 y 0~72, 가운데 y 72~880(카드 열 x 28~408, 실 구역 408~760, 코드 줄 열 760~1360, 활동 열 1382~1920), 반례 띠 y 880~1080이어야 하며, 문서에 가로·세로 스크롤바가 없어야 한다(SHALL)
2. WHEN 글자를 그리면 THEN 화면은 design '배치'의 글자 크기보다 작게 쓰지 않아야 한다(SHALL)
3. WHEN 색을 쓰면 THEN 화면은 민트(통과), 빨강(위반·차단), 노랑(확인 안 됨), 파랑(사람 결정), 앰버(방금 바뀐 코드)를 그 뜻에만 써야 하고, 모든 글자는 바로 아래 바탕과의 대비가 4.5:1 이상이어야 한다(SHALL) — 원뿔 빛이 목표가 아닌 글자 위를 지나는 동안은 예외다(Requirement 10.20)
4. WHEN 브라우저가 화면을 불러오면 THEN 화면은 같은 출처의 파일만 받아야 하고, 글꼴은 `ui/fonts/`에 실제로 있는 `.woff2`와 시스템 글꼴만 써야 한다(SHALL)

### Requirement 2

**User Story:** 화면을 띄우는 사람으로서, `guard serve`가 주는 실제 판정과 활동만으로 화면이 저절로 갱신되길 원한다.

#### Acceptance Criteria

1. WHEN 화면이 열리면 THEN 화면은 같은 출처의 `/api/stream`에 연결해 `index`·`report`·`resolution`·`sealed`·`runs`·`events`·`events-reset` 이벤트(guard-serve 요구사항 2)로 상태를 채워야 하고, 화면 파일에 표본 데이터나 시간표대로 재생하는 연출을 두지 않아야 한다(SHALL)
2. WHEN `index`·`report`·`resolution`·`sealed` 이벤트를 받으면 THEN 화면은 그 상태를 받은 데이터로 통째로 바꾸고 1초 안에 다시 그려야 한다(SHALL) — 연출이 돌고 있으면 Requirement 10.4의 공개 보류가 정한 부분만 연출의 박자에 맞춰 늦게 바뀐다
3. WHEN `runs` 이벤트를 받으면 THEN 화면은 `name`의 반례 기록을 `data`로 바꾸고, `data`가 null이면 그 기록을 지워야 한다(SHALL)
4. WHEN `events` 이벤트를 받으면 THEN 화면은 받은 객체들을 활동 목록 끝에 차례로 덧붙여야 하고, `events-reset` 이벤트를 받으면 활동 목록을 받은 배열로 통째로 갈아 끼워야 한다(SHALL)
5. WHEN `/api/stream` 연결이 끊기면 THEN 화면은 상태 띠 오른쪽 알약 자리에 "연결 끊김"을 보여야 하고, 다시 연결되면 그 글자를 지워야 한다(SHALL)

### Requirement 3

**User Story:** 화면을 보는 사람으로서, 스펙과 코드의 일치 상태를 한눈에 보고 싶다.

#### Acceptance Criteria

1. WHEN index가 있으면 THEN 화면은 카드 열에 요구사항 카드(ID·"검사 <n>개"·판정 배지)를, 코드 줄 열에 report `code.lines`의 줄(줄 번호·코드)을 보이고, `links`로 이어진 요구사항-코드 줄마다 실을 그려야 한다(SHALL)
2. WHEN 요구사항이 8개 이하이고 코드 줄이 12개 이하이면 THEN 화면은 모든 카드와 코드 줄을 스크롤 없이 한 화면에 보여야 하고, 카드 문장은 카드 높이에 들어가는 줄 수까지만 보이고 넘치는 끝을 "…"로 줄여야 한다(SHALL)
3. WHEN report에 요구사항의 판정이 있으면 THEN 화면은 판정 모양으로 그려야 한다(SHALL) — green: 배지 "✓ 통과", 흰 실선과 민트 확인 표시 / yellow: 배지 "확인 안 됨", 노란 실선 / red: 빨간 테두리와 배지 "✗ 위반"(reason이 `run-failed`면 "실행 실패"), 빨간 점선, 이어진 코드 줄의 빨간 테두리, 매듭점 옆 도장(윗줄 'CAUGHT!' — `run-failed`면 없음, 아랫줄 근거 문구) / report가 없거나 그 ID가 없음: 배지 "대기", 보라 반투명 실
4. WHEN 요구사항의 verdict가 red로 바뀌거나 red에서 다른 판정으로 바뀌면 THEN 화면은 0.4초 동안 그 실의 `stroke-dasharray`를 보간하며 도장을 나타내거나 지워야 한다(SHALL)
5. WHEN `code.file`이 null이 아니면 THEN 화면은 코드 줄 열 머리에 `code.file`을 보여야 하고, `file`이 있는 줄은 번호 자리에 `<file의 마지막 경로 조각>:<n>`을 보여야 한다(SHALL)
6. WHEN `code.file`이 null이면 THEN 화면은 코드 줄 열에 "태그 달린 코드 줄 없음"을 보이고 실을 그리지 않아야 한다(SHALL)
7. WHEN 코드 줄이 줄 너비보다 길면 THEN 화면은 고정폭 글자로 최대 2줄까지 감싸고 넘치는 끝을 "…"로 줄여야 한다(SHALL)
8. WHEN 새 report가 오면 THEN 화면은 코드 줄마다 직전 report에서 파일과 `links`가 같은 줄을 찾아 글자를 견줘, 글자가 바뀐 줄에 '방금 바뀜' 표시(바뀐 글자 조각의 앰버 강조, "방금 바뀜 <이전 조각> → <새 조각>" 칩, 앰버 테두리)를 보여야 하고, 다음 report에서 그 줄이 바뀌지 않았거나 red가 끝나면 표시를 지워야 한다(SHALL) — 위에 줄을 넣거나 빼 번호만 밀린 줄은 바뀐 줄이 아니다
9. WHEN 같은 파일의 이웃한 두 코드 줄 번호가 이어지지 않으면 THEN 화면은 두 줄 사이에 "⋮ <빠진 줄 수>줄"을 보여야 한다(SHALL)

### Requirement 4

**User Story:** 화면을 보는 사람으로서, 빨강·노랑이 왜 그런지 한 문구로 읽고 싶다.

#### Acceptance Criteria

1. WHEN 반례를 보이면 THEN 화면은 counterexample 원문을 JSON 배열로 읽을 수 있으면 원소를 `, `로 이어 보이되 문자열 원소는 따옴표 없이(빈 문자열은 `""`), 그 밖의 원소는 JSON 표기로 보이고, 읽을 수 없으면 원문에서 바깥 대괄호 한 쌍만 벗겨 보여야 한다(SHALL) — 예: `["aaa000"]` → `aaa000`, `["a",3]` → `a, 3`
2. WHEN 요구사항이 red면 THEN 근거 문구는 `test-failed`이고 counterexample이 있으면 "반례 <반례 표기>", `test-failed`이고 counterexample이 없으면 "검사 실패", `seal-broken`이면 "봉인 깨짐 <brokenSeals 첫 항목의 path>"(둘 이상이면 뒤에 " 외 <나머지 개수>"), `run-failed`면 "검사 실행 실패"여야 한다(SHALL)
3. WHEN report의 overall이 red이고 reason이 `run-failed`인 요구사항이 없으면 THEN 상태 띠는 빨간 바탕에 "<report 순서로 첫 red 요구사항의 전체 ID> 위반 · <그 근거 문구>"(red가 둘 이상이면 뒤에 " 외 <나머지 개수>건")와 끝말(5)을 보여야 한다(SHALL)
4. WHEN report의 overall이 red이고 reason이 `run-failed`인 요구사항이 있으면 THEN 상태 띠는 빨간 바탕에 "검사 실행 실패"(report에 `runError`가 있으면 뒤에 " · <runError>")와 끝말(5)을 보여야 한다(SHALL)
5. WHEN 상태 띠가 빨강이면 THEN 끝말은 red 요구사항이 모두 resolution의 approved에 있으면 " · 사람 결정 기록됨 · <첫 red 요구사항의 승인 선택 문구>", 아니면 " · 사람 결정 대기"여야 한다(SHALL)
6. WHEN report의 overall이 yellow면 THEN 상태 띠는 노란 바탕에 "확인 안 됨 · <첫 yellow 요구사항의 전체 ID> <reason 문구>"(`no-tests` = "검사 없음", `stale` = "검사를 봉인한 뒤 스펙 문장이 바뀜", 둘 이상이면 뒤에 " 외 <나머지 개수>건")를 보여야 한다(SHALL)
7. WHEN report의 overall이 green이면 THEN 상태 띠는 초록 바탕에 "모든 요구사항이 코드와 일치"를 보여야 하고, report를 아직 받지 않았으면 판색 바탕에 "판정 없음 · guard check를 기다리는 중"을 보여야 한다(SHALL)
8. WHEN report가 있으면 THEN 상태 띠 오른쪽에 고정폭 글자로 "통과 <summary.green> · 위반 <summary.red>"를 보여야 하고, summary.yellow가 0보다 크면 가운데에 " · 노랑 <summary.yellow>"를 끼워야 한다(SHALL)

### Requirement 5

**User Story:** 화면을 보는 사람으로서, 어느 요구사항이 법 조문에서 왔고 어느 검사가 봉인됐는지 카드에서 보고 싶다.

#### Acceptance Criteria

1. WHEN index의 요구사항에 `basis`가 있으면 THEN 화면은 그 카드의 문장 아래에 "근거: <basis>" 배지를 보여야 하고, 문장이 "(근거: <basis>)"로 끝나면 그 괄호는 문장에서 빼고 배지로만 보여야 한다(SHALL)
2. WHEN sealed의 어떤 항목의 `requirements`에 카드의 전체 ID가 있으면 THEN 화면은 그 카드의 "검사 <n>개" 옆에 "봉인" 알약을 보여야 한다(SHALL)
3. WHEN 봉인 표시가 있는 요구사항의 reason이 `seal-broken`이면 THEN 화면은 그 표시를 빨간 알약 "봉인 깨짐"으로 바꿔야 한다(SHALL)
4. WHEN sealed가 없거나 항목이 0개면 THEN 화면은 봉인 표시를 그리지 않아야 한다(SHALL)

### Requirement 6

**User Story:** 화면을 보는 사람으로서, 에이전트와 사람이 무엇을 했고 어디서 막혔는지 보고 싶다.

#### Acceptance Criteria

1. WHEN 활동 목록에 줄이 있으면 THEN 화면은 활동 열에 최근 12줄을 시각(`ts`)·동작 배지·대상(`target`)으로, 가장 최신 줄이 맨 아래에 오도록 보여야 하고, `events`로 덧붙은 줄은 36px 아래에서 올라오며 나타나야 한다(SHALL)
2. WHEN 줄을 그리면 THEN 화면은 동작 배지에 action 문자열을 대문자로 보여야 한다(SHALL) — 예 `write` → WRITE, `block` → BLOCK, `save` → SAVE
3. WHEN action이 `block`이면 THEN 그 줄은 빨간 바탕, `human`이면 파란 바탕이어야 하고, 그 밖의 줄은 판색 바탕이며 배지는 `write` 앰버, `hook` 보라, 그 밖은 연보라여야 한다(SHALL)
4. WHEN 대상이 줄 너비보다 길면 THEN 화면은 대상을 한 줄로 보이고 넘치는 끝을 "…"로 줄여야 한다(SHALL)

### Requirement 7

**User Story:** 사람으로서, 위반이 나면 화면에서 "코드를 되돌린다"·"스펙을 고친다"를 골라 기록하고 싶다.

#### Acceptance Criteria

1. WHEN report의 overall이 red면 THEN 화면은 활동 열 아래에 "코드를 되돌린다"·"스펙을 고친다" 버튼 두 개를 보여야 하고, red가 아니면 두 버튼을 투명하게 하고 누를 수 없게 해야 한다(SHALL)
2. WHEN 사람이 버튼을 누르면 THEN 화면은 같은 출처의 `POST /api/resolve`(guard-serve 요구사항 4)에 본문 `{"choice":"revert-code"}` 또는 `{"choice":"edit-spec"}`를 보내야 하고, 응답이 올 때까지 두 버튼을 누를 수 없게 해야 한다(SHALL)
3. WHEN 응답이 200이면 THEN 화면은 응답 본문을 resolution 상태로 쓰고 버튼 아래 알림 줄에 "기록됨 · <선택 문구>"를 2초 동안 보여야 하며, 200이 아니면 같은 자리에 "기록 실패 · <상태 코드>"(409면 "결정할 위반 없음")를 2초 동안 보여야 한다(SHALL)
4. WHEN report의 overall이 green이 되면 THEN 화면은 가진 resolution의 approved를 비워야 한다(SHALL)
5. WHEN 화면이 동작하는 동안 THEN 화면은 사람이 버튼을 누른 때에만 `POST /api/resolve`를 보내야 하고, 시간이나 상태 변화로 결정을 스스로 고르지 않아야 한다(SHALL)

### Requirement 8

**User Story:** 화면을 보는 사람으로서, 반례가 실제로 계산됐다는 기록을 보고 싶다.

#### Acceptance Criteria

1. WHEN report의 red 요구사항 중 반례 기록(`<spec>__<Rn.m>.json`)이 있는 것이 있으면 THEN 화면은 report 순서로 그 첫 요구사항의 기록을 반례 띠에 보여야 한다(SHALL) — 왼쪽 칸 줄에 `inputs` 하나를 칸 하나로(ok true는 민트 테두리·✓, false는 빨간 바탕·✗), 구분선 오른쪽에 `shrinkPath`를 화살표로 이은 빨간 칸들(마지막 칸 위에 "최소 반례"), 맨 아래 줄에 제목 "반례 찾기"와 "<전체 ID> · 검사 <runs>회 · 줄이기 <shrinks>회"
2. WHEN 칸을 그리면 THEN 화면은 입력 칸을 x 32~1140 안에 같은 너비로 놓아야 하고, 칸과 줄이기 칸의 값은 `[` + 값 + `]`를 Requirement 4.1의 규칙으로 표기해야 한다(SHALL)
3. WHEN `shrinkPath`가 5개를 넘으면 THEN 화면은 처음 2개와 마지막 3개만 보이고 그 사이 화살표 자리에 "…"를 보여야 한다(SHALL)
4. WHEN 보일 반례 기록이 없으면 THEN 화면은 빈 칸 테두리와 안내 "검사가 반례를 찾으면 시험한 입력이 이 칸에 쌓인다"를 보여야 한다(SHALL)

### Requirement 9 (선택 — 반례 재연 카드)

**User Story:** 화면을 보는 사람으로서, 반례를 실제 가입 화면에 넣으면 지금 코드가 어떻게 답하는지 보고 싶다.

#### Acceptance Criteria

1. WHEN 재연 설정이 있는 저장소에서 요구사항이 red이고 counterexample이 있으면 THEN 화면은 `POST /api/replay`(guard-serve 요구사항 6)로 지금 코드를 실행한 결과를 받아 활동 열 안의 카드에 보여야 하고, 결과 문구는 서버가 돌려준 값에서만 만들어야 한다(SHALL)
2. WHEN 재연 기록이 없으면 THEN 화면은 카드를 그리지 않고 활동 열·버튼 배치를 Requirement 6·7 그대로 써야 한다(SHALL)

### Requirement 10 (검사관 연출)

**User Story:** 화면을 보는 사람으로서, 검사관이 손전등으로 스펙 실을 비추며 검사하다 위반을 잡고, 에이전트를 막고, 사람의 결정에 끄덕이는 모습을 보고, 설명 없이도 무엇이 일어났는지 10초 안에 알고 싶다.

이 요구사항의 말:

- 신호: 연출이 마지막으로 본 상태와 지금 상태를 견줘 얻는 변화 — 새 red, red 끝, `write`·`block`·`human` 줄, 바뀐 코드 줄, 반례 띠 기록 변화, 실 구조 변화
- 반응: 신호 하나에 대해 검사관이 하는 장면 하나. 크루 장면은 크루가 따로 한다
- 대기 동작: 반응이 없을 때 하는 일 — report가 green·yellow면 순찰, red면 잡은 자리에서 빨간 빛으로 매듭점을 비춤
- 공개 보류: 기본 화면이 최종 값을 계산해 두고, 보이는 모습만 연출이 알리는 박자까지 늦추는 것(design '공개 보류')

#### Acceptance Criteria

1. WHEN 화면 주소에 `fx=0`이 있으면 THEN 화면은 연출 모듈(`ui/fx.js`)을 받지 않고 Requirement 1~9의 화면만 보여야 한다(SHALL)
2. WHEN 브라우저가 움직임 줄이기(`prefers-reduced-motion: reduce`)를 요청하면 THEN 화면은 검사관·크루·빛 끝을 보간 없이 새 자리로 옮기고 둥실·반동·불꽃·미끄러짐을 쓰지 않아야 한다(SHALL) — 반응의 시작·끝 시각은 보통 때와 같다
3. WHEN 연출을 그리면 THEN 움직임은 `requestAnimationFrame` 루프 하나에서 프레임 사이 시간(0.05초를 넘으면 0.05초로 자름)으로 계산해야 하고 `setTimeout`·`setInterval`을 쓰지 않아야 한다(SHALL)
4. WHEN SSE 이벤트를 받으면 THEN 화면은 1초 안에 Requirement 2~9의 상태를 최종 값으로 그리되 연출이 돌고 있으면 design '공개 보류'의 다섯 경우만 연출의 박자를 따라야 하고, 알림이 없어도 정해진 상한 안에 최종 값이 되어야 하며, 연출은 기본 요소의 속성과 자식을 바꾸지 않아야 한다(SHALL)
5. WHEN 신호가 오면 THEN 검사관은 그 신호의 장면을 해야 한다(SHALL) — green·yellow 대기 = 순찰(10.7), `write` 줄 = 단계 알림만(10.8), 바뀐 코드 줄 = 바뀐 글자 보기(10.9), 반례 띠 기록 변화 = 크루 장면(10.10), 새 red = 잡기(10.11, reason이 모두 `run-failed`면 10.12), red일 때의 `block` 줄 = 차단 유지(10.13), `human` 줄 = 끄덕임·표지판 내림(10.14), red 끝 = 복귀(10.15). `shell`·`save`·`hook` 줄에는 반응하지 않는다
6. WHEN 신호가 이어서 오면 THEN 검사관의 반응은 design '차례'의 우선순위대로 하나씩 해야 하고, 각 반응은 신호 뒤 0.2초 안에(앞 반응을 기다렸다면 그것이 끝난 뒤 0.2초 안에) 시작해야 한다(SHALL) — 같은 report에서는 바뀐 글자 보기 → 크루 장면 → 잡기 → 2.0초 머묾 → 차단 순서다
7. WHEN report가 green 또는 yellow이고 진행 중인 반응이 없으면 THEN 검사관은 실을 요구사항 순서로 번갈아 훑으며 순찰해야 한다(SHALL) — 처음 시작의 첫 바퀴는 실마다 훑기가 끝날 때 그 판정 모습을 공개한다
8. WHEN 활동 목록에 action이 `write`인 줄이 새로 붙으면 THEN 검사관은 하던 일을 그대로 이어 가며, 단계 알약만 "에이전트 작업 중"으로 바꿔야 한다(SHALL)
9. WHEN 새 report에서 바뀐 코드 줄(Requirement 3.8)이 생기면 THEN 검사관은 바뀐 글자로 날아가 빛을 비추고 'HMM?'을 보인 뒤 4.1초까지 머물러야 한다(SHALL)
10. WHEN 반례 띠에 보이는 반례 기록이 다른 기록으로 바뀌면 THEN 화면은 크루 장면을 해야 한다(SHALL) — 'KIRO CREW, ASSEMBLE!' 말풍선과 함께 크루가 칩을 들고 칸 위로 날아와 떨어뜨리면 그 프레임에 그 칸이 나타나고, 실패 칩 크루가 줄이기 값마다 칩을 옮겨 최소 반례까지 간다. 끝나면 연출 칩이 남지 않는다
11. WHEN 요구사항이 red로 바뀌고 그중 reason이 `run-failed`가 아닌 것이 있으면 THEN 검사관은 첫 요구사항의 주 실을 매듭점까지 훑어, 빛 끝이 닿는 프레임에 빛을 빨강으로 바꾸고 새로 red가 된 요구사항들의 실을 모두 같은 프레임에 끊어야 한다(SHALL) — 그 뒤 0.15초에 도장, 0.5초에 카드·코드 줄, 0.9초에 상태 띠·버튼이 공개되고, 불꽃과 '!' 말풍선이 나온다
12. WHEN 새로 red가 된 요구사항의 reason이 모두 `run-failed`면 THEN 검사관은 실을 끊지 않고 손전등을 끈 채 활동 열 자리로 날아가 '?' 말풍선을 보이고, 그 red 동안 거기서 대기해야 한다(SHALL) — 검사 실행 실패는 위반을 찾은 것이 아니다
13. WHEN 활동 목록에 action이 `block`인 줄이 새로 붙고 report가 red면 THEN 검사관은 활동 열 자리로 날아가 block 줄을 비추며 STOP! 표지판을 들고, `human` 줄이 붙거나 report가 red가 아니게 될 때까지 들고 있어야 한다(SHALL)
14. WHEN 활동 목록에 action이 `human`인 줄이 새로 붙으면 THEN 검사관은 그 줄을 바라보며 끄덕이고 표지판을 내려야 한다(SHALL)
15. WHEN report가 red에서 red가 아닌 것으로 바뀌면 THEN 끊긴 실은 0.4초 안에 다시 이어지고, 크루가 흩어지며, green이면 검사관이 기쁨과 'ALL CLEAR!'를 보인 뒤 순찰로 돌아가야 한다(SHALL) — 반례 띠는 이 반응이 끝날 때까지 마지막 기록을 보이다가 빈 반례 띠로 바뀐다
16. WHEN 1920×1080으로 띄우고 10.10·10.11·10.13이 이어지는 10초 동안 프레임 간격을 재면 THEN 프레임의 95% 이상이 20ms 이하이고 가장 긴 프레임이 50ms 이하여야 한다(SHALL)
17. WHEN 연출이 동작하는 동안 THEN 화면은 사람이 버튼을 누르지 않으면 `POST /api/resolve`를 보내지 않아야 한다(SHALL)
18. WHEN 루프가 프레임을 그리면 THEN 프레임마다 DOM에 쓰는 것은 `transform`·`opacity`·`stroke-dasharray`뿐이어야 하고, 요소 만들기·지우기와 레이아웃 읽기는 시작할 때·상태가 바뀔 때·창 크기가 바뀔 때만 해야 한다(SHALL)
19. WHEN 검사관·표지판·말풍선을 그리면 THEN 그 상자는 상태 띠·버튼 줄·알림 줄·도장·반례 띠의 글자 상자와 겹치지 않아야 한다(SHALL)
20. WHEN 연출이 켜져 있으면 THEN 빛이 목표 글자의 대비를 4.5 아래로 떨어뜨리지 않아야 하고, `mix-blend-mode`·`filter`를 쓰지 않아야 한다(SHALL)
21. WHEN 연출 층을 그리면 THEN 빨간 빛·불꽃은 빛 끝이 매듭점에 닿은 때부터 그 red가 끝날 때까지만, STOP! 표지판의 빨강은 차단에만 써야 한다(SHALL)
22. WHEN 연출이 시작되거나 SSE가 다시 연결되거나 `events-reset`을 받으면 THEN 화면은 지난 줄·지난 판정 변화에 반응하지 않고 지금 상태의 대기 모습을 움직임 없이 맞춰야 한다(SHALL)
23. WHEN 공개 보류 동안 크루 장면이 시작되면 THEN 상태 띠는 대기 바탕에 "반례 확인 중"을 보이고 요약을 비워야 한다(SHALL) — 활동 열이 빨강을 보이는 동안 직전 문구를 남기지 않는다
24. WHEN 상태가 바뀌어 실 구조가 달라지면 THEN 화면은 실에 묶인 진행 중 반응만 버리고 실에 묶인 연출 요소를 새로 만든 뒤 대기 모습을 맞춰야 한다(SHALL)
25. WHEN 연출이 장면을 시작하거나 장면 안의 박자에 이르면 THEN 화면은 상태 띠 오른쪽 알약에 단계 문구("순찰 중 · R2.3", "코드 변경 감지", "반례 찾기 기록", "위반 발견", "에이전트 차단", "사람 결정 대기", "사람이 결정", "복구 완료" 등)를 보여야 한다(SHALL) — 연결이 끊긴 동안은 "연결 끊김"이 이긴다
