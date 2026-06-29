# Blueprint — Claude Code 설계 세션 시각화 도구

## 문제

Claude Code는 CLI 환경이라 아키텍처 설계·구현 논의가 전부 텍스트로 흐른다.
설계 전체 구조를 머릿속에 그리는 데 시간이 오래 걸린다. 시각화(다이어그램)로
"빠른 이해"를 돕고, 지난 세션의 주요 설계를 다시 확인할 수 있어야 한다.

## 목표 (MVP)

세션을 고르면 → 자동으로 설계 다이어그램을 보여준다.

대화형 질의, 실시간 세션 추적은 후속 단계(비목표).

## 스택

- **Tauri** (Rust 백엔드 + 웹뷰 프론트). 경량 .app 번들.
- **다이어그램 생성**: 로컬 `claude -p` (headless) 위임 — 별도 API 키 불필요,
  사용자의 기존 Claude Code 인증 사용.
- **렌더링 2계통**:
  - `mermaid` (기본, 항상 동작) — 웹뷰에서 JS로 즉시 렌더
  - `mingrammer/diagrams` (보강, 선택) — Python+Graphviz로 SVG 생성. 인프라/
    클라우드 아키텍처에 적합. 의존성 미설치 시 해당 다이어그램만 안내로 대체,
    앱은 계속 동작.

## 아키텍처

```
Tauri App
  webview(UI)  <-- IPC -->  Rust 백엔드
   ·세션 목록                 ·세션 스캔/JSONL 파싱/추출
   ·mermaid 렌더              ·claude -p 호출
   ·SVG 표시                  ·python(mingrammer) 실행
   ·원본/소스 토글            ·결과 캐시

  읽기 전용:  ~/.claude/projects/<proj>/<uuid>.jsonl
  서브프로세스: claude -p (headless),  python3 (diagrams)
```

## 컴포넌트별 책임

### 1. 세션 스캔 & 추출 (Rust)
- `~/.claude/projects/<encoded-path>/*.jsonl` 스캔.
- 각 세션 메타: 제목(`ai-title` 레코드 → 없으면 첫 `user` 프롬프트),
  프로젝트명(디렉토리에서 역인코딩), 수정시각, 메시지 수.
- 프로젝트별 그룹핑, 수정시각 내림차순.
- **추출**: JSONL에서 `type:user`/`type:assistant`의 텍스트 본문만 남기고
  `tool_use`/`tool_result`/`file-history-snapshot`/`system` 노이즈 제거 →
  "대화 전사본" 문자열. 이게 LLM 입력.

### 2. 다이어그램 생성 (Rust → claude -p)
- 전사본을 임시 파일로 쓰고 headless 호출:
  `claude -p --output-format json [--model <m>]`.
- 프롬프트: "이 설계 대화를 읽고 아키텍처를 가장 잘 설명하는 다이어그램 1~3개를
  생성. 인프라/클라우드 구성이면 mingrammer/diagrams Python 코드로, 그 외
  플로우·시퀀스·관계는 mermaid로. 아래 JSON 스키마로만 출력."
- 출력 스키마:
  ```json
  { "diagrams": [
    { "title": "string", "kind": "mermaid|mingrammer", "source": "string",
      "explanation": "string" }
  ]}
  ```
- `kind:mingrammer`면 Rust가 `python3 <code>` 실행 → SVG 파일. Python/Graphviz
  미설치 시 그 항목은 `unavailable` 플래그 + 안내 메시지로 표시.

### 3. 캐싱 (Rust)
- 키: 세션 파일 경로 + mtime(+크기). 앱 데이터 디렉토리에 생성 결과(JSON, SVG)
  저장. 세션 미변경 시 재호출 안 함.
- "재생성" 버튼으로 캐시 무효화 후 강제 갱신.

### 4. UI (웹뷰)
- 좌측: 세션 목록(프로젝트 그룹, 제목·날짜).
- 메인: 다이어그램 뷰. 여러 개면 세로 스택/탭. 각 다이어그램에 제목+설명.
  - mermaid: 웹뷰에서 렌더.
  - mingrammer: 생성된 SVG 표시(또는 unavailable 안내).
- 토글: "원본 대화 보기" / "다이어그램 소스 보기".
- 액션: 생성/재생성 버튼, 생성 중 진행 표시.

## IPC 커맨드 (Tauri)
- `list_sessions() -> [SessionMeta]`
- `get_transcript(session_path) -> String`  (원본 보기용, 추출본)
- `generate_diagrams(session_path, force: bool) -> DiagramSet`  (캐시 우선)
- `check_deps() -> { python: bool, graphviz: bool, diagrams_pkg: bool, claude: bool }`

## 에러 처리
- `claude` 미설치/실패 → UI에 명확한 에러 + 재시도.
- LLM 출력이 스키마 위반 → 파싱 실패 시 1회 재시도, 그래도 실패면 원문 표시.
- mingrammer 실행 실패 → 해당 다이어그램만 unavailable, 나머지는 정상.
- 대용량 세션 → 추출로 노이즈 제거. 그래도 크면 claude 컨텍스트에 위임.

## 비목표 (후속)
- 대화형 질의 / 후속 질문
- 실시간 진행 중 세션 추적
- 다이어그램 수동 편집
- 내보내기(PNG/PDF 등)

## 테스트 전략
- Rust: JSONL 추출 로직(노이즈 제거, 제목 추출) 단위 테스트 — 고정 픽스처.
- Rust: claude/python 호출은 커맨드를 주입 가능하게 추상화해 모킹.
- 통합: 실제 샘플 세션 1개로 end-to-end 수동 확인.
