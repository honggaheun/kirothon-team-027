# LERO

받은 공지를 근거가 있는 준비 계획으로 바꾸고, 확인한 일정과 할 일을 실행하는 웹 에이전트다. FastAPI/Python 서버와 브라우저 JavaScript 화면으로 구성했다. 배포 주소: https://ai-hackathon.cloud

## 로컬 실행

Python 3.13 이상과 Google Cloud CLI를 준비한다. 다음은 PowerShell 예시다.

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-dev.txt
Copy-Item .env.example .env
# .env의 프로젝트, AI 런타임, OAuth 설정을 본인의 값으로 입력
gcloud auth login
.venv/Scripts/python.exe -X utf8 run.py --demo
```

http://127.0.0.1:4871 에서 연다. 로컬 체험 계정은 Google 로그인 없이 UI·내부 계획을 확인하는 용도이며 실제 AI 분석에는 Cloud 프로젝트의 권한·설정이 필요하다. 공개 주소에서는 체험 계정을 허용하지 않는다. 내부 Python 패키지 `chaenggim`은 초기 작업명으로 남겨 둔 식별자다.

Google 웹 OAuth 클라이언트의 승인된 리디렉션 URI에 `http://127.0.0.1:4871/auth/callback`을 등록한다. 로그인은 기본 프로필만 요청하며 Calendar, Gmail, Tasks, Drive는 설정 화면에서 따로 연결한다. 연결 테스트는 자신의 프로젝트와 계정에서 진행한다.

입력 보호는 `MODEL_ARMOR_TEMPLATE`에 Model Armor 템플릿을 지정하면 활성화된다. `scripts/configure-model-armor.py --help`와 `deploy/model-armor-template.json`으로 설정을 확인할 수 있다. 배포 환경에서는 한국어 텍스트·이미지·PDF의 프롬프트 인젝션·탈옥 탐지를 사용하며 검사 실패나 검사 생략 시 AI 분석으로 넘기지 않는다. 탐지 성능이 모든 공격의 차단을 보장하는 것은 아니다.

대화 목록·새 대화·대화 삭제를 지원하며, 대화와 검토 중인 계획은 계정별·대화별로 분리해 저장한다. 대화 삭제는 이미 등록한 자료·일정·할 일을 삭제하지 않는다. Gmail은 검색 범위에서 최대 10개 새 메일을 확인하고, 준비할 행동이 있는 메일만 계획 초안으로 만든다. 외부 일정 등록에는 별도의 확인이 필요하다.

## 검증

```powershell
.venv/Scripts/python.exe -X utf8 -m pytest
npm ci
npm test
```

Python 검사는 데이터 소유권, 승인·중복·수정, OAuth·CSRF, 입력·네트워크 경계, Google 어댑터, 채팅과 탈퇴 등을 검증한다. Node 검사는 Python의 실제 `check` 함수를 호출하는 Tripwire 속성 검사 2개다. 런타임 판정 8종 모두가 봉인된 것은 아니다.

## Tripwire 적용

Kiro CLI가 `notice-execution` 스펙과 속성 검사·변형 및 ICS 내보내기를 작성했다. 검사 채택·봉인은 사용자의 명시 위임으로 실행했다. 날짜가 없는 일정 등록 방지와 야간 알림 제한 기준 2개를 검사하고 변형 3개를 검출했다. 봉인된 검사는 수정하지 않았다.

설치된 CLI의 기본 v2 엔진 대신 다음처럼 v3로 실행해야 이 프로젝트의 hook이 호출된다.

```powershell
kiro-cli chat --v3 --trust-workspace
```

`.kiro/guard/events.jsonl`에는 Kiro 세션 시작 검사, ICS 코드와 단위 검사 쓰기 gate, pytest 실행 gate 및 변경 후 검사 통과 기록이 있다. 앱 개발 전체를 Kiro가 작성한 것으로 주장하지 않는다. 자세한 작업 구분은 저장소 루트 `BUILD_REPORT.md`를 참고한다.

## 운영 구성

Cloud Run에서는 실제 Google 로그인, Firestore와 비공개 GCS를 사용한다. 사용자 OAuth 토큰은 서버에서 암호화하며 비밀 값은 Secret Manager에 둔다. Dockerfile은 실행에 필요한 Python·웹 파일만 포함한다. `APP_ORIGIN`은 HTTPS 도메인과 일치해야 하며 OAuth 콜백도 같은 도메인으로 등록해야 한다.

Google API 활성화: Cloud Run, Vertex AI, Firestore, Cloud Storage, Secret Manager, Calendar API, Gmail API, Tasks API, Drive API. 기존 Google 일정 조회는 별도의 읽기 권한으로 제공하며 Tasks 목록도 채팅에서 조회할 수 있다. Calendar/Tasks 반영은 사용자의 요청으로 진행하며, Gmail 자동 수집은 별도로 켠 경우에만 5분마다 실행된다. 자동 수집 워커를 위해 현재 Cloud Run은 최소 인스턴스 1개와 인스턴스 기반 CPU를 사용한다.

Google OAuth 게시 상태와 Google의 앱 검증은 별개다. 민감한 권한의 미검증 앱 경고나 사용자 수 제한이 적용될 수 있다. 외부 푸시·이메일 알림 발송과 Google에서 변경한 내용을 앱으로 자동 수집하는 양방향 동기화는 현재 제공 범위에 포함하지 않는다.
