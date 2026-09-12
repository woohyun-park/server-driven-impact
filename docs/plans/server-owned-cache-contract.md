# 백엔드 캐시 계약과 자동 무효화 최종 계획

작성: 2026-09-11. 갱신: 2026-09-12. 상태: 범용 계약 보완과 command 출력 옵션 통합 및 로컬 prerelease 검증 완료. IN/range 영향 추론, 앱 실연동, 정식 배포는 후속 범위다.

## 소비자 피드백 반영 범위

- 중첩 배열/객체 선언형 key template. 기존 prefix/path/params는 호환 표기로 유지한다. oRPC 전용 runtime 의존성 없이 동일 key를 fixture로 검사한다.
- 재귀 입력 schema, 배열 기본 순서 보존/명시적 set 정규화, 생략/null 구분. infinite의 identity input과 page input 분리.
- 모든 post-commit `ImpactUnavailableError.data`는 업무 결과. `phase`와 선택적 `impact`로 실패 단계 구분. 요청 scope/계약 버전은 시작 시 snapshot.
- runtime 등록 endpoint를 계약에 연결하거나 이유와 함께 제외. 독립 compiler에서도 미처리 endpoint는 오류. no-store는 등록 정책으로 검사.
- selector 원문을 기본 로그에 남기지 않는 정밀도 진단. 증명 없는 string equality, optional field, 예산 초과는 안전하게 확대.
- TanStack 적용 범위, 최초 fetch 경쟁, 세션 종료, callback 순서, artifact/hydration 책임을 테스트/예제로 명시.
- 6개 패키지를 현재 `0.5.0-cache-contract.1`로 식별하고 호환 범위/manifest/독립 consumer 검사 동기화. 이전 .0 산출물은 보존하며 npm publish는 수행하지 않는다.
- PostgreSQL SQL 분석/observer 비교 로직은 이 보완의 변경 대상이 아니다. focused 회귀 후 typecheck/test/pack/diff 필수 검사.

## 1. 확정한 방향

백엔드가 캐시 키 구조와 무효화 정책을 정의한다. 동일한 정의에서 OpenAPI를 통한 프론트 조회 코드와 서버의 무효화 지시 생성기를 만든다. 프론트 개발자가 mutation별 업무 영향이나 endpoint-to-key 변환을 다시 작성하지 않도록 한다.

```text
백엔드 Query 정의 + 캐시 계약
  ├─ OpenAPI 확장 → 프론트 API/query key/query options 생성
  └─ 서버 계약 compiler
       실제 DB 변경 → 논리적 impact → 캐시 계약별 무효화 지시
                                      ↓
                           프론트 공통 실행부 → TanStack Query
```

- 실제 query key 기준의 exact와 부분 매칭을 서버가 결정한다. 논리적 입력의 exact와 혼동하지 않는다.
- 서버는 캐시 형식을 알지만 브라우저의 실제 캐시 목록을 저장하지 않는다. 조회 등록 DB, Redis, 구독 registry는 도입하지 않는다.
- 프론트는 캐시 보관, 활성 상태, 재조회, 화면 상태를 관리한다. 조건 지시가 필요한 경우에도 업무 판단 없이 공통 연산만 실행한다.
- core의 기존 DB 중립 ImpactSet은 유지한다. 서버의 선택적 변환 계층이 별도 버전의 캐시 무효화 응답을 생성한다.
- 기존처럼 논리적 ImpactSet을 프론트가 직접 소비하는 방식도 유지한다. 두 경로는 같은 영향 계산을 사용하되 외부 응답 표현이 다를 수 있다.
- OpenAPI 생성은 계약의 전달 수단이다. mutation별 무효화 목록이나 SQL 의존성을 OpenAPI에 수동으로 중복 작성하지 않는다.

## 2. 현재 기준선

- 구현 브랜치: `feat/server-owned-cache-contract` (기준 `09632ea`).
- `packages/sdi-core/src/contracts.ts`: 현재 selector는 `all`과 scalar 부분 입력의 합집합이다.
- 현재 `matchesInputSelector()`는 입력 필드가 없으면 보수적으로 매칭하며, 숫자 문자열 및 일부 문자열 비교도 넓게 처리한다. TanStack의 부분 key 매칭과 의미가 동일하지 않다.
- `packages/sdi-runtime/src/query/plan.ts`: equality binding, 제한된 literal 조건, 일부 JOIN 전파가 있다. IN/range binding은 없다.
- `packages/sdi-runtime/src/runtime/index.ts`: commit 후 WriteSet에서 논리적 impact를 계산한다.
- `examples/orders-impact/consume-impact.ts`: 현재 세션의 endpoint/input 매칭 예제이며 공식 TanStack adapter는 아니다.
- 이 저장소에서는 회사 OpenAPI 생성기의 구현과 설정을 확인하지 못했다. 독립 `x-sdi-cache` 메타데이터 export까지 구현했고 특정 생성기 플러그인 연결은 가정하지 않는다.

## 3. 캐시 계약

백엔드의 API/Query 등록에 다음 정보를 연결한다. 공개 구현은 `@server-driven-impact/cache-contract`의 `defineCacheContract()`를 기준으로 한다.

| 정보 | 의미 |
| --- | --- |
| 계약 ID와 버전 | 프론트 생성물과 서버 변환기의 호환 단위 |
| operationId ↔ SDI endpoint | HTTP 조회와 논리적 읽기 의존성 연결 |
| key template | literal, 정규화된 path/query 입력, 캐시 문맥으로 키 구성 |
| 입력 정규화 | 기본값, 생략/null, 숫자/문자열, 날짜 표현을 요청·키·매칭에서 공유 |
| 조회 형태 | 일반 query와 infinite query를 구분 |
| 무효화 정책 | 증명한 입력 조건 보존 또는 endpoint 범위로 확대 |
| 안전한 확대 대상 | 정밀 필터를 표현하지 못할 때 사용할 계약 버전별 캐시 범위 |

회사 기본 규칙인 `['A', id]`, `['A', 'list']`, `['A', 'list', params]`를 지원하고 endpoint별 template 재정의를 허용한다. 임의 JavaScript 실행 코드를 OpenAPI나 응답에 싣지 않는다.

검증 조건:

- 결과를 바꾸는 입력과 인증 문맥은 key 또는 격리된 QueryClient 생명주기에 반영한다.
- 사용자/tenant namespace를 쓰는 계약이면 서버 변환에도 요청 당시의 같은 문맥을 사용한다.
- 상세 ID가 `'list'`인 경우처럼 template 충돌이 가능한 계약은 입력 제약으로 증명하거나 거절한다.
- 일반/infinite query의 데이터 구조가 다른데 같은 키를 공유하지 않도록 한다.
- 입력 없는 목록과 `{}`의 같은 의미 여부를 정의한다. 생략된 입력을 임의의 기본값과 같다고 가정하지 않는다.
- 배열 정렬·중복 제거는 실제 API 의미상 순서가 무관할 때만 적용한다.
- 캐시의 전체 키 template과 무효화용 부분 필터를 구분한다. 키에 저장할 입력을 빼서 정밀도 문제를 해결하지 않는다.

## 4. 서버 무효화 지시와 대표 시나리오

새 응답은 기존 논리적 ImpactSet v1을 덮어쓰지 않는 별도 계약으로 둔다. 계약 버전과 요청 문맥 연결 정보를 포함한다. 아래는 현재 인증 문맥 안의 개념 payload다.

```ts
{
  contractId: 'company-api',
  contractVersion: 1,
  invalidations: [
    { queryKey: ['A', 1], exact: true },
    { queryKey: ['A', 'list'], exact: true },
    { queryKey: ['A', 'list', { id: 1 }], exact: false },
  ],
}
```

실제 Query 정의가 이 무효화 범위를 보장하는 fixture에서 다음 결과를 확인한다.

| 캐시 | 결과 |
| --- | --- |
| `['A', 1]` | 무효화 |
| `['A', 2]` | 유지 |
| `['A', 'list']` | 무효화 |
| `['A', 'list', { id: 1 }]` | 무효화 |
| `['A', 'list', { id: 1, page: 2 }]` | 무효화 |
| `['A', 'list', { id: 2 }]` | 유지 |

`['A', 'list']`에 `exact: false`를 쓰면 id가 2인 목록까지 포함하므로 이를 구분하는 회귀 검사를 둔다. 변경된 ID만으로 모든 목록의 필터 의미를 추측하지 않는다.

변환의 정확성 원칙:

- 논리적 impact가 포함하는 모든 유효 조회 입력의 생성된 캐시 키가 최종 지시에 포함돼야 한다.
- 기존 selector의 missing-field와 보수적 equality 의미를 단순 queryKey 부분 매칭으로 축소하지 않는다. `{status:'open'}`처럼 id가 없는 추가 입력도 검사한다.
- 타입 정규화만으로 DB collation/codec까지 같은 의미라고 가정하지 않는다. 직접 필터로의 변환이 안전한 조건을 증명한다.
- 직접 표현이 불가능하면 계약에 정의된 안전한 endpoint 범위로 넓힌다. endpoint의 키 형식이 여러 개이면 그 형식들을 모두 포함한다.
- 무효화 정책은 검증된 범위를 넓힐 수 있다. 조회 의미의 증명 없이 필요한 입력이나 endpoint를 제거할 수 없다.
- 예산 초과 시 필터를 잘라내지 않고 넓힌다. 최소 안전 지시도 맞지 않으면 명시적으로 전달 불가를 보고한다.
- 변환은 commit 후 처리다. 변환 실패를 성공한 빈 영향으로 바꾸지 않고 기존 커밋 결과 오류 구분을 유지한다.

## 5. 구성 요소

패키지 경계는 다음과 같이 구현했다.

| 구성 요소 | 위치/역할 |
| --- | --- |
| 기존 core/runtime | DB 변경 관찰 및 논리적 영향 계산. TanStack 의존성 추가 없음 |
| `@server-driven-impact/cache-contract` | 계약 검증, 서버 필터 생성, 계약 버전 관리, OpenAPI 확장 내보내기 |
| OpenAPI 생성기 연동 | 동일 계약에서 API/query key/query options 생성. 실제 회사 생성기 확인 후 연결 |
| `@server-driven-impact/tanstack-query` | 지시 검증, query 선택·중복 제거, 무효화 실행 |

브라우저용 export에 서버 runtime/DB driver/Node 전용 코드를 포함하지 않는다. TanStack Query는 peer dependency로 두고 앱의 QueryClient를 전달받는다.

서버 계약 모드에서는 프론트가 endpoint-to-key 규칙을 별도로 작성하지 않는다. 논리적 impact 직접 연동 모드의 key mapping은 생성 또는 수동 등록할 수 있다.

## 6. 버전·scope·실행 계약

- 생성 SDK는 사용 중인 캐시 계약 ID/버전을 요청에 전달한다. 서버는 최신 버전을 임의로 가정하지 않고 해당 버전의 계약으로 변환한다.
- 지원하는 구버전 정의를 보존한다. 지원 종료된 버전은 가능하면 mutation 실행 전에 명시적으로 거절하고 SDK가 재로딩/재동기화 안내를 할 수 있게 한다.
- 이미 커밋된 후 응답이 실패한 경우는 별도 커밋 결과 계약으로 처리하고 mutation을 자동 재시도하지 않는다.
- persisted cache/hydration 데이터에도 캐시 계약 버전 호환 검사를 적용한다.
- 요청 시작 당시의 사용자/tenant 문맥을 사용해 늦게 도착한 응답을 새 사용자 캐시에 잘못 적용하지 않는다. scope 필드는 인증 수단이 아니다.
- 여러 무효화 지시의 합집합을 공통 실행부에서 한 번 적용해 같은 query에 반복 refetch를 유발하지 않도록 한다.
- 일치하는 활성·비활성 query를 모두 invalidate하고 기본 refetch 대상은 active다. invalidation 필터 자체를 active로 제한하지 않는다.
- infinite query는 해당 query 전체를 무효화한다. cursor/pageParam을 임의의 개별 key로 취급하거나 캐시 행 ID를 보고 페이지를 선택하지 않는다.
- mutation 완료와 active refetch 완료를 함께 기다릴지 공통 연동 옵션으로 제공한다. DB 성공과 후속 refetch 실패를 구분한다.
- 외부 변경 수집이 없으므로 SDI 도입만으로 모든 조회의 freshness를 무한으로 설정하지 않는다. disabled/static query의 갱신 예외도 문서화한다.

## 7. 구현 순서

### 단계 1: 계약과 대표 fixture 확정

key template, 입력 정규화, operation 연결, 정책, 버전 및 안전한 확대 의미를 정의한다. A 상세/list 예제를 첫 fixture로 만들고 일반 key 생성과 실제 TanStack 필터 매칭을 연결한다. 회사 생성기의 종류와 커스텀 지점은 이 단계에서 확인한다.

### 단계 2: 서버 변환기

현재 core의 all/equality를 계약에 따라 실제 key 필터로 내린다. missing-field·타입·여러 read path·scope·OLD/NEW를 보존한다. 등록 단계에서 계약과 Query 정의를 검증하고 요청마다 재컴파일하지 않는다.

### 단계 3: OpenAPI와 클라이언트 생성

같은 정의를 `x-sdi-cache` 같은 명시적 확장으로 내보내고 생성기를 연결한다. 확장 필드는 사용자 정의이므로 도구의 자동 지원을 가정하지 않는다. API 호출과 key에 같은 정규화 입력을 사용한다. 기존 key 규칙을 유지하는 migration 예제를 제공한다.

### 단계 4: TanStack 공통 실행부와 수직 통합

실제 mutation 응답을 공통 wrapper에 연결한다. 먼저 all/equality와 exact/partial key 매칭으로 A 예제를 완성한다. 논리적 impact 직접 소비 모드도 회귀 검사한다. 초기 수직 구현에서는 범위/배열을 안전하게 넓힌다.

### 단계 5: 제한된 배열·범위 자동 판정

첫 수직 구현의 지표와 실제 Query를 기준으로 IN 배열 및 정규화된 날짜/숫자 범위를 확장한다. key 구조를 아는 것만으로 영향 분석이 가능해지는 것은 아니다.

- 서버가 Query 정의와 OLD/NEW에서 판정 조건을 자동 도출한다. endpoint별 수동 업무 matcher는 만들지 않는다.
- key exact/partial로 표현할 수 없는 범위는 버전 관리되는 제한된 데이터 연산자로 전달하고 클라이언트는 공통 연산만 실행한다. raw JavaScript 함수를 전달하지 않는다.
- 논리적 v1 ImpactSet에서 이미 all로 손실된 정보를 응답 변환기가 복구한다고 가정하지 않는다. 필요하면 compiler/calculator의 내부 조건 표현을 먼저 확장하고 기존 v1 응답으로는 안전하게 넓혀 내린다.
- 서버/클라이언트가 공유하는 타입·비교 증명, 구간 경계, null, timezone, OLD/NEW, 예산을 함께 검증한다.
- 지원하지 않는 계약 버전/연산에는 알려진 구버전 계약으로 안전하게 확대하거나 명시적으로 호환 불가를 처리한다. 모르는 버전을 조용히 v1로 취급하지 않는다.

### 단계 6: 배포 준비

구버전 브라우저 공존, 계약 drift, 예산, 번들 및 설치 검사를 마친다. 최소 진단은 계약 버전·확대 이유·필터 수·실제 재조회 수/비용으로 두고 사용자 입력 원문은 기본 로그에 남기지 않는다. 문서/Changeset/패키지 산출물을 준비한 뒤 별도 승인된 릴리스 절차를 따른다.

## 8. 검증과 완료 기준

- A 대표 캐시 집합의 정확한 무효화 결과, id 없는 추가 필터, 추가 params, 키 template 충돌을 실제 TanStack Query로 검사한다.
- 입력 정규화, INSERT/DELETE, 빈 결과에서 첫 INSERT, OLD/NEW 이동, 무관 endpoint/컬럼 제외를 DB 결과 비교와 연결한다.
- 기존 matcher가 선택한 유효 입력을 서버 변환이 누락하지 않는 속성을 검증한다. 불확실한 비교에서는 기대하는 broad fallback을 확인한다.
- active/inactive, infinite query, 중복 지시, 사용자 전환 중 지연 응답, 구버전 클라이언트와 새 서버 조합을 검사한다.
- 범위 단계에서는 09-02~10-01 같은 임의 구간, 경계값, 시간대, 숫자 정밀도, 배열의 빈 값/중복/타입을 검사한다.
- DB 결과가 실제로 바뀐 모든 유효 조회의 생성된 캐시가 무효화되는 것을 최종 정확성 기준으로 삼는다. 캐시 결과에 변경 ID가 있는지만 검사하지 않는다.
- 개발 중 영향받는 focused test를 실행한다. 구현 완료 시 `pnpm typecheck`, `pnpm test`, `pnpm pack:check`, `git diff --check`를 실행한다.
- PostgreSQL 분석/observer/비교 계약이 바뀌는 단계는 관련 DB 통합 검사 및 저장소의 PostgreSQL 14–18 × driver matrix를 완료한다. 순수 코드 생성 변경만으로 전체 DB matrix를 반복하지 않는다.
- 새 패키지와 브라우저 consumer가 build/typecheck/pack 검사에 실제 포함되는지 확인한다. 브라우저 경계는 Node 타입 없는 consumer와 독립 의존성 설치로 검사하며 실제 브라우저 UI 검증과 구분한다.

## 9. 범위 밖 및 후속 과제

- 실제 클라이언트 캐시 목록의 서버 저장, CDC/외부 변경 전달, WebSocket 구독 시스템은 별도 설계다.
- 임의 함수 역변환, 역관계 조회/저장, 모든 SQL 조건의 프론트 재현은 포함하지 않는다.
- 기존 RLS 정확성 검증은 유지한다. 구조화 조회의 RLS 자동 합성은 이 계획의 선행 필수가 아닌 별도 기능으로 진행할 수 있다.
- 목록 자동 패치, 서버에서 staleTime/gcTime 등 모든 UI 캐시 옵션 강제, core의 TanStack 전용화는 목표가 아니다.

## 10. 작업 및 인계

- 독립 계약, runtime 연결, OpenAPI 확장, 대표 fixture, TanStack 실행부는 `feat/server-owned-cache-contract`에서 구현했다. 회사 OpenAPI 생성기 연결, commit, push, PR, npm 배포는 아직 수행하지 않았다.
- 회사 생성기 자료가 없더라도 독립 계약·서버 변환기·대표 생성 fixture는 진행 가능하다. 회사 생성기 실연동에는 해당 설정/소스 확인이 필요하다.
- 다음 기능 작업은 단계 5의 배열·범위 조건 표현이다. 회사 생성기 실연동과 배포 준비는 외부 설정 확인 뒤 진행한다.

### 소비자 피드백 보완 결과

- oRPC 전용 runtime 의존성 없이 재귀 template으로 실제 oRPC 1.15.0 key 생성 함수와 동일한 query/infinite 키를 검증했다.
- 배열/중첩 객체, 생략/null/default, 명시적 set 정규화, infinite identity/page 분리를 구현했다.
- scope/계약 snapshot, 두 post-commit 오류의 업무 결과 보존, coverage/exclusion, 확대 진단을 구현했다.
- 최초 fetch 경합의 기본/취소 경로 및 async callback/세션 폐기 예제를 테스트했다.
- `pnpm typecheck` 통과. 전체 테스트 144개 통과/68개 PostgreSQL 조건부 제외 후 consumer 예제 테스트 2개를 추가하여 해당 파일 16개와 root TypeScript 검사를 통과했다.
- `pnpm pack:check` 통과: 여섯 패키지 독립 설치, SQLite 실행, PostgreSQL/ORM import·타입 검사, Node 타입 없는 browser consumer, TanStack 5.100.14/5.102.8.
- PostgreSQL SQL/observer 코드는 바꾸지 않았으므로 실서버 14–18 matrix는 이번 보완에서 재실행하지 않았다. 릴리스 workflow의 필수 matrix는 유지한다.
- 산출물: `.local/artifacts/sdi/0.5.0-cache-contract.0/`의 여섯 tarball, 호환 범위·SHA-512 release manifest, pnpm overrides. 이전 0.4.1 파일은 보존했다.
- [전환 가이드](../migrations/cache-contract-0.5.md)에 설정·정밀도 한계·앱 책임·설치/복구 절차를 정리했다. 소비 앱은 수정하지 않았으며 commit/push/npm publish는 수행하지 않았다.

### Command 출력 옵션 통합 — 2026-09-12

- 공개 메서드를 `command(context, work, {cacheContract})`로 통합하고 `commandWithInvalidations()`를 제거했다.
- 기존 2인자 호출과 빈 옵션은 `{data, impact}`를 반환하며 캐시 compiler를 실행하지 않는다. 명시적 계약 옵션은 `cacheInvalidation`을 추가하며 overload로 타입을 구분한다. 동적인 `CommandOptions`는 결과 union으로 반환한다.
- 계약 사전 검증, 단일 업무 실행, 요청 당시 scope/계약 snapshot, 두 post-commit 오류의 업무 결과 보존을 유지한다.
- 검증: `pnpm typecheck`, 전체 Vitest 149개 통과/68개 PostgreSQL 조건부 제외, `git diff --check` 통과.
- 독립 tarball consumer에 실제 SQLite command의 옵션 유무 및 반환 타입 검사를 추가했다. 생성 예제의 괄호 누락 수정 후 기존 .1 tarball로 `SDI_PACK_USE_EXISTING=1 pnpm pack:check`를 통과했다.
- 산출물: `.local/artifacts/sdi/0.5.0-cache-contract.1/`의 여섯 tarball 및 manifest/overrides. .0은 이전 API로 보존한다. npm 배포와 PostgreSQL 실서버 matrix는 수행하지 않았다.
