# Design Document

## Overview

정적 파일, 모두 `ui/` 아래(프레임워크·빌드 단계 없음, ES 모듈):

| 파일 | 맡는 일 |
|---|---|
| `index.html` | 무대 뼈대와 층 |
| `style.css` | 배치·색·글꼴 |
| `core.js` | 배치 상수 `L`, 수학·이징·스프링, 곡선, DOM 도우미 |
| `format.js` | 문구 순수 함수(DOM 없음 — '문구') |
| `app.js` | SSE·상태·모형·기본 화면 그리기·기본 움직임·루프·버튼 |
| `fx.js` | 연출 — 검사관·빛·크루·소품·감독·장면 |

`guard serve`가 `ui/`를 제공하고(guard-serve 1.2), 데이터는 같은 출처의 `/api/stream`(SSE)으로 밀어 받는다.

```text
.kiro/guard/{index,report,resolution,sealed}.json · events.jsonl · runs/*.json
        │ guard serve가 바뀐 것을 SSE로 민다(guard-serve 2)
        ▼
EventSource('/api/stream') ──▶ state ──▶ modelFrom(state) = view ──▶ render(view) ──▶ fx.onState(view)
                                                                          ▲
사람의 버튼 클릭 ──▶ POST /api/resolve {choice} ──▶ 200 = 새 resolution ──┘
app.js 루프(rAF 하나) ──▶ 기본 움직임 ──▶ fx.frame(dt, t)
```

## 배치 (1920×1080)

`#viewport`(fixed) 안의 `#stage`(1920×1080)를 `translate(x, y) scale(s)`로 창에 맞춘다: s = min(창 너비 ÷ 1920, 창 높이 ÷ 1080). 기하는 모두 무대 좌표로 계산하고, DOM에서 재는 것은 글자 상자뿐이다.

| 영역 | 무대 좌표 | 요소 |
|---|---|---|
| 상태 띠 | 0~1920 × 0~72 | `#status`: 제품 표지, `#status-text`, `#status-phase` 알약, `#status-sum` |
| 카드 열 | x 28~408, y 128~866 | `#cards` — 카드 높이 = (738 − 10(N − 1)) ÷ N |
| 실 | 무대 전체를 덮는 SVG | `#threads`(`pointer-events: none`) |
| 코드 줄 열 | x 760~1360, y 128~866 | `#code` — 줄 간격 738 ÷ 줄 수, 줄 높이 46 |
| 활동 열 | x 1382~1920, y 72~880 | 줄 `#act-lines`, 버튼 줄 `#act-actions`, 알림 줄 `#toast` |
| 반례 띠 | y 880~1080 | 칸 `#slots`·`#shrink`, `#band-foot`, `#band-head` |

글자 크기의 아래 한계: 상태 띠 판정 문구 31px, 카드 ID 19px·문장 17px, 코드 줄 16px, 활동 줄 15px, 반례 띠 칸 값 20px, 도장 21px, 버튼 21px. 글꼴은 `ui/fonts/`의 `.woff2`와 시스템 글꼴만 쓴다 — `ui/fonts/README.md`.

## 모형과 그리기

- `modelFrom(state)`가 index·report·resolution·sealed·runs·events에서 화면 값(view)을 계산한다. 화면은 판정하지 않고 기록을 옮겨 그린다
- `render(view)`는 키로 요소를 다시 쓴다. 새 키만 만들고 없어진 키는 지우며, class·글자·`d`는 바뀔 때만 쓴다
- '방금 바뀜'은 직전 report의 같은 파일·같은 `links` 줄과 글자를 견줘 정한다(`diffSeg`). 줄 번호는 보지 않는다

## 문구 — DOM 없는 순수 함수(`format.js`)

`formatExample(raw)` — 요구사항 4.1

| 원문(counterexample) | 표기 |
|---|---|
| `["aaa000"]` | `aaa000` |
| `["a",3]` | `a, 3` |
| `[""]` | `""` |
| `[{"x":1}]` | `{"x":1}` |
| `[new Date("2013-06-15T00:00:00.000Z")]` | `new Date("2013-06-15T00:00:00.000Z")` — JSON 배열이 아니어서 바깥 대괄호만 벗김 |

runs의 값(`inputs[].v`·`shrinkPath[]`)은 바깥 대괄호가 이미 벗겨진 꼴(`"c003"`)이라 `formatExample('[' + v + ']')`로 표기한다.

`reasonPhrase(item)` — 요구사항 4.2

| report 항목 | 근거 문구 |
|---|---|
| `test-failed`, counterexample `["aaa000"]` | 반례 aaa000 |
| `test-failed`, counterexample 없음 | 검사 실패 |
| `seal-broken`, brokenSeals `[{ "path": "tests/signup/R2.3.prop.test.ts", "problem": "changed" }]` | 봉인 깨짐 tests/signup/R2.3.prop.test.ts |
| `seal-broken`, brokenSeals 2개 | 봉인 깨짐 <첫 path> 외 1 |
| `run-failed` | 검사 실행 실패 |

`bandText(report, resolution)` → `{ tone, text }` — 요구사항 4.3~4.7

| 상태 | 바탕 | 문구 |
|---|---|---|
| report 없음 | 판(`none`) | 판정 없음 · guard check를 기다리는 중 |
| green | 초록 | 모든 요구사항이 코드와 일치 |
| yellow, 첫 yellow = signup:R2.3 `stale` | 노랑 | 확인 안 됨 · signup:R2.3 검사를 봉인한 뒤 스펙 문장이 바뀜 |
| red signup:R2.3 `test-failed` `["aaa000"]`, 승인 없음 | 빨강 | signup:R2.3 위반 · 반례 aaa000 · 사람 결정 대기 |
| red signup:R2.3 `seal-broken` | 빨강 | signup:R2.3 위반 · 봉인 깨짐 tests/signup/R2.3.prop.test.ts · 사람 결정 대기 |
| red 6개 모두 `run-failed`, runError `vitest output is not JSON` | 빨강 | 검사 실행 실패 · vitest output is not JSON · 사람 결정 대기 |
| red 2개(signup:R2.1 `["12345678"]`, signup:R2.2), 둘 다 `revert-code` 승인 | 빨강 | signup:R2.1 위반 · 반례 12345678 외 1건 · 사람 결정 기록됨 · 코드를 되돌린다 |

`summaryText(summary)` — 요구사항 4.8: `{green: 6, yellow: 0, red: 0}` → "통과 6 · 위반 0", `{green: 5, yellow: 1, red: 0}` → "통과 5 · 노랑 1 · 위반 0".

`actionLabel(action)`·`actionTone(action)` — 요구사항 6.2·6.3

| action | 배지 | 줄 모양 | target 예 |
|---|---|---|---|
| `write` | WRITE | 판색 줄, 앰버 배지 | `src/signup/validate.ts` |
| `shell` | SHELL | 판색 줄, 연보라 배지 | `npx vitest run` |
| `block` | BLOCK | 빨간 줄(먹 글자), 먹 배지·빨간 글자 | `signup:R2.3 위반 · 사람 결정 대기` |
| `hook` | HOOK | 판색 줄, 보라 배지·흰 글자 | `guard check · 빨강 1 · 노랑 0 · 초록 5` |
| `human` | HUMAN | 파란 줄(흰 글자), 흰 배지·파란 글자 | `signup:R2.3 · 코드를 되돌린다 승인` |
| `save` | SAVE | 판색 줄, 연보라 배지 | `src/signup/validate.ts · 사람 저장` |

`cardBadge(item)` — 요구사항 3.3: green "통과" · yellow "확인 안 됨" · red "위반"(`run-failed`면 "실행 실패") · 없음 "대기".

`stripBasis(text, basis)` — 요구사항 5.1: `("WHEN … 한다(SHALL) (근거: 개인정보 보호법 제22조의2 제1항)", "개인정보 보호법 제22조의2 제1항")` → `"WHEN … 한다(SHALL)"`, basis가 없거나 문장이 그 괄호로 끝나지 않으면 그대로.

`diffSeg(a, b)` — 요구사항 3.8: `("…LENGTH = 8; // [R2.3]", "…LENGTH = 6; // [R2.3]")` → `{ p: <8의 자리>, from: "8", to: "6" }`.

`runsFor(report, runs)` — 요구사항 8.1: report 순서로 red 요구사항마다 `runs.get(id.replace(':', '__') + '.json')`을 찾아 처음 있는 것.

`shrinkView(path)` — 요구사항 8.3: 5개 이하면 그대로, 넘으면 처음 2개 + `…` + 마지막 3개.

`bandInfo(item, run)` — 요구사항 8.1: `"signup:R2.3 · 검사 10회 · 줄이기 7회"`(item에 `runs`·`shrinks`가 없으면 inputs 개수와 shrinkPath 개수 − 1).

`choiceLabel(choice)` — `revert-code` → 코드를 되돌린다, `edit-spec` → 스펙을 고친다.

## 해결 버튼

- 버튼의 click 처리에서만 `POST /api/resolve`를 보낸다(요구사항 7.5). requirement를 보내지 않으므로 대상은 현재 red 전부다
- 같은 출처 POST라 브라우저가 `Origin`을 붙인다. 화면은 `http://127.0.0.1:<port>/`나 `http://localhost:<port>/`로 연다. 다른 주소면 403이다(guard-serve 4.1)
- 응답 뒤 `resolution` SSE도 온다. 둘은 같은 내용이라 늦게 온 쪽으로 덮어도 된다

## 연출 층(요구사항 10)

원칙:

1. 연출은 SSE로 바뀐 상태로만 시작한다. 정해진 시간표대로 재생하지 않는다
2. 자동 결정은 없다. 해결 결정은 사람이 버튼을 눌렀을 때만 보낸다
3. 기본 화면이 끝 값을, 연출이 공개 박자를 정한다. 원인(빛이 실을 훑다 끊음)이 결과(빨강)보다 먼저 보여야 하기 때문이다
4. 프레임에서는 `transform`·`opacity`·`stroke-dasharray`만 쓴다
5. `fx=0`이면 `app.js`가 `fx.js`를 불러오지 않는다. 불러오기가 실패해도 기본 화면만으로 계속한다

### 경계 — `app.js`와 `fx.js`

| `app.js`(기본 — `fx=0`에서도) | `fx.js`(연출) |
|---|---|
| 무대·배치, 카드·코드 줄, 기본 실과 확인 표시, 도장, 상태 띠, 활동 줄, 버튼·알림, 반례 띠 칸, 루프, 공개 보류와 단계 알약(`APP.reveal`·`APP.phase`) | 빛 웅덩이·원뿔·칩·크루·검사관·손전등·표지판·말풍선·불꽃, 실 밝힘·끊긴 반쪽, 감독·신호·장면 |

`fx.js`가 기본 요소에 쓰는 것은 둘뿐이다: 실이 끊긴 동안 그 실의 기본 path의 `style.opacity`, 판 안 빛 얼룩 자리의 `style.transform`·`style.opacity`.

연결: `FX.start(view, APP)` → `render()`마다 `FX.onState(view)` → 덧붙은 줄마다 `FX.onEvents(view, lines)` → `events-reset`마다 `FX.onReset(view)` → 루프에서 `FX.frame(dt, t)`.

### 공개 보류

기본 화면은 SSE 상태마다 최종 값을 계산한다. 연출이 돌고 있으면 아래 다섯 경우만 보이는 모습을 늦추고, 연출이 `APP.reveal(부분, 대상)`으로 알리면 기본 화면이 자기 요소에 그린다. 알림이 없어도 상한 안에 최종 값이 된다.

| 경우 | 보류 동안 보이는 모습 | 공개 |
|---|---|---|
| ① 잡기 | 대상 요구사항의 실·도장·카드·코드 줄과 상태 띠·버튼 = 직전 모습(크루 장면이 시작하면 상태 띠는 "반례 확인 중") | 실을 끊는 프레임에 실 → 0.15초 도장 → 0.5초 카드·코드 줄 → 0.9초 상태 띠·버튼 |
| ② 반례 띠 | 크루 장면 전까지 빈 반례 띠, 시작하면 그 기록의 빈 칸 테두리 | 칩이 닿는 프레임마다 그 칸, 모두 놓은 0.45초 뒤 글자와 정보, 줄이기 칩이 닿을 때마다 그 칸과 화살표 |
| ③ 첫 순찰 | 실·카드·코드 줄 = 대기 모습, 상태 띠 = "순찰 중 · <n>/<카드 수> 통과" | 실마다 훑기가 끝날 때 그 판정 모습, 마지막 실 0.1초 뒤 모두 |
| ④ 활동 열 | 해당 줄이 없는 목록 | 첫 순찰 뒤 1초 간격, `hook` 줄은 크루 장면 0.2초, `block` 줄은 표지판을 드는 프레임 |
| ⑤ red 끝 | 상태 띠·카드·버튼 = red 모습, 반례 띠 = 마지막 기록 | 실을 잇기 시작한 0.4초 뒤 상태 띠·카드·버튼, 복귀가 끝날 때 빈 반례 띠 |

### 신호

`fx.js`는 마지막으로 본 view의 값을 기억하고 `onState`·`onEvents`마다 견준다.

- 새 red: 지금 red이고 마지막으로 본 report에서 red가 아니던 요구사항. red 끝: overall이 red에서 red가 아닌 것으로 바뀜
- 바뀐 코드: `generatedAt`이 새로 바뀐 report에 '방금 바뀜' 줄이 있음
- 반례 띠 기록 변화: 반례 띠 키가 마지막으로 본 것과 다름
- 줄: `onEvents`로 받은 줄의 action — `write`(단계 알림만)·`block`·`human`
- 실 구조 변화: 실 키 집합·카드 수·코드 줄 수가 다름. 실에 묶인 연출 요소를 새로 만든다
- 시작·`onReset` 뒤 1초 동안은 신호를 만들지 않고 대기 모습만 맞춘다

### 차례

검사관 반응은 감독의 세대 번호로 하나씩 진행하고, 크루 장면은 따로 세대 번호를 가진다.

| 반응 | 우선 | 다른 반응이 진행 중이면 |
|---|---|---|
| red 끝 | 1 | 모두 버리고 바로(기다리던 사람 끄덕임만 함께) |
| 잡기 · run-failed '?' | 2 | 순찰·대기 동작이면 끊고 바로. 같은 report의 바뀐 글자 보기와 크루 장면이 먼저 |
| 머묾(잡기 뒤 2.0초) | — | 기다리는 반응은 머묾이 끝난 뒤. 사람·red 끝은 머묾을 끊음 |
| 사람 · 차단 | 3 | 사람은 머묾까지 끊고 바로. 차단은 크루 장면·잡기·머묾이 끝난 뒤 |
| 바뀐 글자 보기 · 반례 띠 지켜보기 | 4 | 대기 동작·순찰이면 바로. 같은 report의 새 red와 함께면 잡기 칸을 따름 |
| 크루 장면(크루 몫) | 따로 | 검사관 반응과 함께 진행 |

## Testing

- 순수 함수는 `ui/format.js`에서 `guard/test/` 아래 시험 파일로 import해 위 표를 시험한다. 이 저장소에는 스펙이 여럿이므로 시험 제목 태그는 `[stage-ui:R4.1]`처럼 스펙 이름을 붙인다. 기대값은 손으로 쓴 값이다
- 손 확인: 1920×1080(배율 100%)에서 `?fx=0`으로 기본 화면을 먼저 보고, 초록·빨강·봉인 깨짐·노랑·실행 실패 상태와 버튼 흐름을 확인한 뒤 연출을 켠다
