# ParaNovel

ParaNovel은 AI가 장기 연재형 한국 웹소설을 집필할 수 있도록 Canon, 회차 기억, 현재 아크, 현재 장면, 혼합 검색 기억과 사용자가 승인한 개선점을 한데 묶어 제공하는 단일 사용자용 집필 환경입니다. React 편집기와 NestJS API를 하나의 Docker 이미지로 빌드하며 데이터는 SQLite에 저장합니다.

## 주요 흐름

- 프로젝트를 만들 때 로그라인과 장르 태그를 먼저 받고, AI 인터뷰가 소설 제목을 반드시 물은 뒤 필요한 설정을 보충합니다.
- 프로젝트별로 Canon과 5~20화 단위의 현재 아크를 관리합니다.
- 새 회차는 ‘이번 회차에 원하는 것’만 선택 입력합니다. 비워 둔 채 다음으로 넘어가도 AI가 제목과 전개 방향을 자동으로 만들며, 확인 후 초안을 생성합니다.
- 생성 결과는 Canon과 기억을 기준으로 정합성 검토 및 최소 수정을 거친 뒤 편집기에 반환됩니다.
- 순수 텍스트 편집기의 커서 위치에서 AI 이어쓰기를 요청할 수 있습니다.
- 선택한 원문을 사용자가 고친 뒤 두 텍스트의 차이에서 개선점 후보를 추출합니다. 편집기에서 만든 개선점은 현재 프로젝트 범위가 기본입니다.
- ‘두 원고 비교’는 두 방식으로 사용할 수 있습니다. 공통 방향·브리프를 입력하면 AI 초안을 먼저 확인한 뒤 수정 원고를 입력합니다. 원고만 입력하는 경우에는 전·후 원고를 각각 직접 입력합니다. 두 방식 모두 전 원고 대비 후 원고의 개선점을 추출하며, 개선점은 전역 범위가 기본입니다.
- 승인된 전역 개선점과 현재 프로젝트 개선점은 이후 관련 AI 집필 요청에 함께 반영됩니다.

## 기억과 정합성

AI 요청의 문맥은 다음 우선순위로 조립됩니다.

1. 작업별 프롬프트와 공통 집필 규칙
2. 승인된 개선점
3. Canon
4. 현재 아크
5. 현재 장면
6. 최근 회차 기억과 열린 떡밥
7. 벡터·키워드 혼합 검색 결과
8. 현재 사용자 입력

Canon은 사용자가 확정한 사실만 포함합니다. 회차에서 새로 발견된 사실은 후보로 추출할 수 있지만 자동으로 Canon에 편입하지 않습니다. 검색은 프로젝트별로 격리되며, OpenRouter 임베딩을 사용할 수 없으면 SQLite 키워드 검색으로 자동 폴백합니다.

## 기술 구성

- 프런트엔드: React (`apps/web`)
- 백엔드: NestJS (`apps/api`)
- 데이터베이스: SQLite
- AI 게이트웨이: OpenRouter
- 외부 레퍼런스 검색: Tavily Search
- 기본 집필 모델: `google/gemini-3.8-flash`
- 개선점 추출 모델: `openai/gpt-5.6-luna`
- 기본 임베딩 모델: `openai/text-embedding-3-small`, 1536차원

## 로컬 실행

Node.js 22 이상과 npm이 필요합니다.

```bash
cp .env.example .env
npm ci
npm run dev
```

개발 서버는 React UI를 `http://localhost:5173`, NestJS API를 `http://localhost:3000`에서 실행합니다. 프로덕션 빌드와 Docker 이미지는 UI와 API를 모두 `http://localhost:3000`에서 제공합니다. `OPENROUTER_API_KEY` 없이도 프로젝트·회차·설정 CRUD와 키워드 검색은 사용할 수 있습니다. 이 경우 AI 생성 및 임베딩 요청은 `503 Service Unavailable`을 반환합니다.

프로덕션 빌드를 확인하려면 다음을 실행합니다.

```bash
npm run build
npm test
```

빌드 계약은 React 결과를 `apps/web/dist`에 만들고 NestJS 결과를 `apps/api/dist/main.js`에 만드는 것입니다. NestJS가 빌드된 React 자산도 정적으로 제공하므로 운영 환경에는 별도 웹 서버가 필요하지 않습니다.

## 환경변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | 없음 | AI 생성과 임베딩에 사용하는 OpenRouter API 키 |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter 호환 API 기준 URL |
| `TAVILY_API_KEY` | 없음 | 기획·집필용 웹 레퍼런스 검색 키. 미설정 시 웹 검색만 비활성화 |
| `AI_WRITING_MODEL` | `google/gemini-3.8-flash` | 프로젝트 기획, 세계관, 집필, 기억 및 정합성 작업 모델 |
| `AI_IMPROVEMENT_MODEL` | `openai/gpt-5.6-luna` | 전후 원고에서 개선점을 추출하는 모델 |
| `OPENROUTER_EMBEDDING_MODEL` | `openai/text-embedding-3-small` | 검색 기억 임베딩 모델 |
| `OPENROUTER_EMBEDDING_DIMENSIONS` | `1536` | 저장되는 임베딩 차원. 기존 DB를 사용 중일 때 임의 변경 금지 |
| `AI_MANDATORY_CONTEXT_MAX_CHARS` | `400000` | Canon·아크·장면·개선점 필수 문맥의 안전 한도. 초과 시 누락하지 않고 요청 실패 |
| `DB_PATH` | `./data/paranovel.sqlite` | SQLite 파일 경로. Docker 내부에서는 `/data/paranovel.sqlite` |
| `PROMPTS_DIR` | `./prompts` | 런타임 프롬프트 디렉터리 |
| `HOST` | `0.0.0.0` | API 바인드 주소 |
| `PORT` | `3000` | 로컬 서버 포트 또는 Compose의 호스트 공개 포트 |

## 프롬프트 관리

고정된 자연어 지시문은 코드에 두지 않고 모두 [`prompts`](./prompts)에 저장합니다. 레지스트리는 공통 프롬프트 `novelist-core`와 `memory-contract`를 작업 프롬프트와 함께 불러옵니다.

각 파일에는 다음 YAML front matter가 필요합니다.

```yaml
---
id: episode-draft
version: 1
task: episode_draft
responseMode: text
requiredVariables:
  - canon
---
```

- `responseMode`는 `text`, `json`, `tool` 중 하나입니다.
- 본문에는 `## System`과 `## User` 구역이 모두 있어야 합니다.
- 템플릿 변수는 `{{snake_case}}` 형식을 사용하고 `requiredVariables`에 등록합니다.
- 프롬프트는 파일 수정 시각을 기준으로 런타임에 다시 읽힙니다. 필수 파일, 구역 또는 변수가 없으면 해당 AI 요청이 명확한 구성 오류로 실패합니다.
- `json` 작업의 구체적인 응답 형태와 `tool` 작업의 도구 스키마는 코드에서 타입 안전하게 제공하며, 자연어 의미와 행동 규칙은 프롬프트 파일에 둡니다.

Docker에서 프롬프트를 이미지 재빌드 없이 조정하려면 Compose 서비스에 읽기 전용 바인드 마운트를 추가할 수 있습니다.

```yaml
volumes:
  - ./prompts:/app/prompts:ro
  - paranovel_data:/data
```

## 웹 레퍼런스 검색

`.env`에 `TAVILY_API_KEY`를 설정하고 API 서버를 재시작하면 프로젝트 청사진, 세계관, 아크, 회차 방향, 초안·이어쓰기, 비교용 초안 생성에 Tavily를 사용할 수 있습니다. Docker Compose도 같은 변수를 컨테이너에 전달합니다. 집필 모델은 OpenRouter의 function calling을 지원해야 합니다.

최종 생성 전에 LLM이 `tavily_search` 도구로 레퍼런스 필요성을 판단하고, 서버가 [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)를 호출한 결과를 LLM에 돌려줍니다. 검색이 불필요하면 곧바로 준비 단계를 마칩니다. 키를 설정한 경우에는 검색하지 않아도 이 판단을 위한 LLM 호출이 한 번 추가됩니다. 검색 결과는 제목·URL·최대 2,000자의 발췌와 함께 최종 작업에 전달하며, 최종 본문은 기존 방식으로 스트리밍합니다. 검색 판단과 최종 출력의 토큰 사용량은 같은 AI 실행 기록에 합산합니다.

사용 조건, JSON 인자와 예시, 출처 확인, Canon 우선순위, 검색 실패 시 처리는 [`reference-tools.md`](./prompts/reference-tools.md)에, 조사 단계의 종료 조건은 [`reference-research.md`](./prompts/reference-research.md)에 있습니다. 검색 인자는 `query`(1~400자), `search_depth`(`basic` 또는 `advanced`), `max_results`(1~5)입니다. 요청당 최대 3회 검색하며, 검색 한 번의 제한 시간은 15초입니다. API 키는 서버에서만 사용하고 검색어만 Tavily에 전달합니다.

키가 없으면 기존 생성 흐름을 사용합니다. 빈 결과, 검색 오류, 한도 도달 시에는 받은 자료로 작업을 계속하되 검색 성공이나 확인하지 못한 출처를 꾸미지 않도록 지시합니다. 프로젝트 인터뷰, 기억·장면·개선점 추출, 연속성 검토와 최소 수정에는 외부 검색을 추가하지 않습니다. 웹 자료는 참고용이며 작품의 확정 Canon이나 회차 기억으로 자동 편입되지 않습니다.

## Docker 단일 이미지

```bash
cp .env.example .env
docker compose up --build -d
```

Compose는 React 정적 자산과 NestJS API가 포함된 단일 컨테이너를 실행하고, named volume `paranovel_data`에 `/data/paranovel.sqlite`를 보존합니다. 컨테이너를 삭제해도 volume을 삭제하지 않는 한 소설 데이터는 남습니다. 운영 데이터는 volume 또는 SQLite 파일을 정기적으로 백업하세요.

레지스트리에 로그인한 뒤 한 번의 명령으로 이미지를 빌드하고 푸시할 수 있습니다.

```bash
./scripts/build-and-push.sh ghcr.io/OWNER/paranovel:1.0.0
```

기본 플랫폼은 `linux/amd64,linux/arm64`입니다. 단일 플랫폼이나 다른 조합이 필요하면 `PLATFORMS`를 지정합니다.

```bash
PLATFORMS=linux/amd64 ./scripts/build-and-push.sh ghcr.io/OWNER/paranovel:1.0.0
```

스크립트는 `docker buildx`와 대상 레지스트리에 대한 사전 로그인을 요구합니다.

## 데이터 보호

- `.env`와 SQLite 파일은 이미지 빌드 컨텍스트에서 제외됩니다.
- API 키를 프런트엔드 코드나 브라우저 저장소에 넣지 마세요. OpenRouter와 Tavily 호출은 NestJS 서버에서만 수행합니다.
- SQLite 파일을 복사해 백업할 때는 쓰기를 중단하거나 SQLite의 안전한 백업 절차를 사용해 WAL 파일과의 불일치를 피하세요.
