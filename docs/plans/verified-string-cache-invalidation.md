# 문자열 비교 자동 검증 기반 캐시 정밀화 계획

작성: 2026-09-12. 상태: SQLite 수직 경로와 PostgreSQL catalog 경로 구현 및 로컬 검증 완료. PostgreSQL 실서버 검증은 환경 설정 부재로 대기.

## 목표와 범위

SDI가 Query와 실제 DB의 비교 규칙을 검증해 일반 문자열 동등 조회의 캐시 무효화 범위를 자동으로 좁힌다. username, slug, 외부 ID 등 필드 이름과 무관하게 적용한다.

- 기존 조회 API와 query key template을 유지한다.
- 개발자가 컬럼별 `exact: true`, collation, 비교 증명을 중복 작성하지 않는다. 증명은 SDI가 생성한다.
- 새로운 정규화 옵션이나 URL decode, trim, lowercase 기능은 추가하지 않는다. 기존 정규화 기능도 제거하지 않는다.
- username→UUID 매핑, 화면별 무효화 정책, 배지·그룹 관계 역추적은 범위 밖이다.
- 서버 입력이 캐시 키의 문자열과 동일하게 DB에 전달되는 경로만 정밀화한다. Runtime이 검증된 문자열의 parser 전후 값을 자동 확인하며, 불일치는 계약 위반으로 거절한다.

| 상황 | As-is | To-be: 검증 성공 시 |
| --- | --- | --- |
| A의 생일 변경 | 해당 endpoint 전체 무효화 | A의 username 조회만 무효화 |
| A → B 이름 변경 | 해당 endpoint 전체 무효화 | 이전 A와 새 B 조회 모두 무효화 |
| 사용자 생성·삭제 | 해당 endpoint 전체 무효화 | 해당 이름 조회 무효화, 캐시된 빈 결과 포함 |
| 비교 미검증 | 해당 endpoint 전체 무효화 | 동일한 fallback 유지 |
| parser가 문자열 변경 | 기존 API 동작 | 계약 위반으로 조회 거절 |

표는 Query graph가 해당 사용자 입력을 특정할 수 있는 직접 조회 기준이다. 다른 의존성이 전체 영향을 요구하면 전체 무효화한다. 실제 키는 기존 계약에서 렌더링하며 예제 키 구조를 강제하지 않는다.

## 현재 코드에서 확인한 연결 지점

- `sdi-cache-contract/src/input.ts`의 `selectorValue()`는 일반 문자열에 대한 protocol-1 비교 증명이 없어 fallback한다.
- `sdi-core/src/contracts.ts`의 matcher는 생략 필드·ASCII 대소문자·후행 공백·일부 scalar coercion을 보수적으로 포함한다.
- `sdi-runtime/src/query/plan.ts`는 직접 equality binding을 추론하지만 비교 타입·collation 증명을 보존하지 않는다.
- `sdi-runtime/src/runtime/index.ts`의 `input.parse()`는 임의 함수다. 함수 이름이나 샘플 입력 통과를 근거로 모든 입력의 무변환을 증명할 수 없다.
- `sdi-postgres/src/postgres/artifact.ts`는 현재 native parameter codec의 불확실성 때문에 생성 plan의 bindings를 모두 제거한다. 이 경로에서는 cache compiler만 수정해도 정밀해지지 않는다.
- `sdi-core/src/calculate.ts`는 OLD/NEW 양쪽을 이미 처리한다. 이를 새 경로에서도 보존한다.

## 설계 결정

### 1. 지원 가능한 직접 비교부터 자동 검증

첫 범위는 필수·비-null·기본값 없는 string 입력과 직접 `column = parameter` 비교다. 입력의 coercion/format 변환은 이 새 증명 경로에서 제외한다.

- SQLite: 실제 대상 컬럼이 TEXT이며 유효 비교가 BINARY인 경우. 컬럼 선언, 저장된 값의 표현, parameter 전달, observer 문자열 직렬화까지 확인한다.
- PostgreSQL: 구조화된 Query의 내장 text/varchar 직접 비교 중 타입·유효 collation·parameter 및 observer 표현의 일치가 검증된 경우. 초기에는 검증한 내장 collation 범위로 한정한다.
- `lower()`, trim, cast, ILIKE, NOCASE/RTRIM, char/citext, 사용자 정의 타입·연산자, 분석하지 못하는 명시적 COLLATE 등은 새 정밀화 대상에서 제외한다.
- JOIN을 통한 비교 전파, 변환된 call/bind, 여러 비교 의미가 섞인 composition은 초기에는 증명을 전파하지 않는다. 이미 안전한 기존 동작은 유지한다.
- 기존 adapter가 거절하던 비지원 Query/DB를 이번 기능에서 임의로 허용하지 않는다.

문자열 정확 비교는 대소문자, 후행 공백, 숫자처럼 보이는 표기, 서로 다른 Unicode 표현을 임의로 합치지 않는 의미로 정의한다. 성공 사례 몇 개를 DB에 질의한 결과만으로 증명을 발급하지 않는다.

### 2. 입력 무변환도 증명의 일부로 취급

새 정규화 기능 없이, 키의 입력부터 실제 SQL parameter까지 값이 유지되는 경로를 연결한다.

- 별도 기능 옵션 없이 등록된 cache contract에 자동 적용한다.
- Runtime은 DB 비교가 검증된 문자열 필드에 대해 raw 요청 값과 `input.parse()` 결과를 매 조회 자동 비교한다.
- parser가 필드를 생략하거나 값을 변경하면 계약 위반으로 조회를 거절한다. 이를 일부 요청에만 fallback하는 방식은 다른 프로세스와 과거 캐시의 안전성을 보장하지 못한다.
- 앱의 반복 URL decode가 캐시 키 생성 이후에 실행된다면 해당 앱은 이 초기 지원 조건을 충족하지 않는다. 앱 코드 확인 없이 해결됐다고 주장하지 않는다.

비교 규칙과 parser 전후 값 검사는 자동이다. 개발자는 문자열 값을 바꾸지 않는 입력 계약을 지킨다.

### 3. 서버 내부 증명 경로와 기존 protocol 분리

- Query 분석과 adapter 검증이 endpoint, read 경로, input, resource/column, 비교 의미, 입력 경로, Query/catalog revision을 연결한 내부 증명을 생성한다.
- DB 미검증 상태, 증명 누락·불일치 상태에서는 정밀화를 활성화하지 않는다. 마이그레이션과 Query 변경 시 재검증하고, 기존 artifact drift 거절 동작을 유지한다.
- `matchesInputSelector()`와 공개 `ImpactSet` protocol 1의 의미를 변경하지 않는다.
- 기존 `compileCacheInvalidations(contract, impact, ...)`만 호출하는 경우에는 이전 의미를 유지한다. 계약 JSON에 문자열 옵션을 넣는 것만으로 기존 matcher보다 좁힐 수 없게 한다.
- 새 계약 모드의 서버 경로는 동일한 committed WriteSet과 검증된 read 정보로 별도의 정밀 캐시 영향을 계산한다. 비교 근거가 사라진 공개 selector를 나중에 exact로 재해석하지 않는다.
- PostgreSQL native artifact가 codec 불확실성 때문에 제거하는 bindings는 계속 fallback한다. 이번 범위는 구조화된 직접 equality Query다.
- 각 selector 대안의 출처와 증명을 유지하거나, 첫 버전에서는 관련 경로 전체가 같은 의미로 검증된 경우만 허용한다. endpoint 이름과 input 이름만으로 다른 read 경로의 증명을 재사용하지 않는다.
- 내부 계산에서 unknown row, 누락 binding, 전체 의존성, 예산 초과로 넓힌 대상은 다시 좁히지 않는다.

### 4. 기존 키와 버전 호환

- key template과 cache contract 형식은 그대로 사용하며 별도 기능 플래그를 추가하지 않는다.
- 초기 개발 단계 정책에 따라 이전 cache-contract 동작 보존을 위한 이중 경로나 호환 분기는 추가하지 않는다.
- persisted cache/hydration을 사용하는 앱은 배포 시 기존 데이터를 정리한다.
- 프론트 공통 consumer는 기존 서버 지시 실행 구조를 활용한다. 회사 생성기·실제 앱은 이 저장소에서 확인되지 않았으므로 저장소 내 fixture와 연결 가이드까지가 이번 산출물이다.

### 5. 예산과 진단

- OLD/NEW, insert/delete, 캐시된 빈 결과를 모두 무효화 범위에 포함한다.
- 정밀 지시가 개수·바이트 예산을 넘으면 해당 endpoint fallback으로 확대한다. 필요한 항목을 잘라내지 않는다.
- fallback조차 예산을 넘으면 기존 post-commit 오류 계약을 유지하고 성공한 빈 지시로 처리하지 않는다.
- explain에 정밀화 성공, 비교 미검증, 계약 호환, 예산 초과를 구분한다. parser 위반은 조회 오류 코드로 구분한다.
- 진단에 실제 username, raw selector, query key를 넣지 않는다.

## 구현 순서와 완료 기준

1. 서버 내부 증명 타입과 무변환 입력 검사를 구현한다. parser가 문자열을 변경하는 경우의 거절 동작을 먼저 고정한다.
2. SQLite 직접 TEXT/BINARY 조회로 Query → catalog 검증 → OLD/NEW → cache compiler → 실제 TanStack 무효화의 수직 경로를 완성한다.
3. PostgreSQL 구조화 Query의 검증된 직접 text/varchar 비교를 같은 경로에 연결한다. native artifact의 parameter codec은 후속 범위로 fallback을 유지한다.
4. 기존 nested/oRPC key, explain, 예산 초과를 통합 검증한다.
5. README·마이그레이션 가이드·changeset을 추가하고 패키지 검증을 완료한다. 이전 로컬 prerelease 산출물은 보존한다.

필수 검증:

- A의 생일 변경 시 A만 무효화되고 무관한 B는 유지된다.
- 이름 변경 시 이전 이름 성공 응답과 새 이름의 빈 결과가 모두 무효화된다. 생성·삭제도 포함한다.
- Alice/alice, 후행 공백, `1`/`01`, 한글·Unicode 조합형 차이를 실제 DB 조회 결과와 대조한다.
- 비지원 collation과 변환 함수는 fallback하고, parser가 raw 문자열을 바꾸는 입력은 조회를 거절한다.
- 여러 read 경로 중 하나의 미검증 비교를 다른 경로의 증명으로 좁히지 않는다.
- DB/Query/입력 계약 변경 후 오래된 증명을 재사용하지 않는다.
- 독립 compiler의 보수적 포함 관계 회귀는 그대로 통과한다. runtime 경로는 실제 DB 결과가 바뀐 모든 캐시 키가 최종 지시에 포함되는지 별도로 검사한다.
- OLD/NEW·내부 영향·최종 지시 예산 각각에서 누락이 없다. commit 후 실패도 mutation 재실행으로 이어지지 않는다.

개발 중에는 관련 focused 검사를 수행한다. 완료 시 `pnpm typecheck`, `pnpm test`, PostgreSQL 실서버 지원 버전 matrix, `pnpm pack:check`, diff 검사를 수행한다. PostgreSQL 실서버 검사를 실행하지 못했다면 미검증으로 명시하고 해당 지원을 완료로 보고하지 않는다.

## 작업 기반과 현재 산출물

- 현재 workspace: `/Users/woohyunpark/Desktop/c/server-driven-impact`.
- 현재 branch: `feat/server-owned-cache-contract`, HEAD `09632ea` 및 미커밋 cache-contract 구현이 실제 기준선이다.
- 현재 미커밋 cache-contract 기준선 위에 runtime 증명 전달, SQLite/PostgreSQL catalog 검증, cache compiler 정밀화, 회귀 테스트, 문서와 changeset을 구현했다.
- `pnpm typecheck`, 전체 Vitest, `pnpm pack:check`를 통과했다. PostgreSQL 실서버 검사는 `SDI_POSTGRES_ADMIN_URL`과 `SDI_POSTGRES_RUNTIME_URL`이 없고 로컬 Docker daemon도 실행 중이 아니어서 수행하지 못했으며, 관련 integration fixture를 추가했다.
- commit, push, PR, 배포는 수행하지 않는다.
