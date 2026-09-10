# Query 자동화와 정밀 영향 분석 경계

2026-09-10 transaction impact 전환 기준. SDI는 지원되는 mutation의 WriteSet과 배포 시 도출한 조회 의존성을 결합한다. 운영 영향 계산에서 업무 SELECT를 추가 실행하지 않는다. 아래의 정밀도는 실제 변경 전후 결과를 모두 재실행해 구하는 수학적 최소 집합을 뜻하지 않는다.

## 자동 도출과 안전한 축소

| 조회 정의 | 자동으로 도출하는 정보 | 안전하게 좁히는 범위 |
| --- | --- | --- |
| `q.select` | 조회 resource, 명시적 SELECT 컬럼, WHERE의 모든 컬럼, ORDER 컬럼, JOIN의 local/foreign 컬럼, 필요한 고정 scalar equality 조건 | 무관 resource·컬럼 제외, 보장되는 동등 입력 binding 및 관찰자가 비교 가능성을 인증한 literal 조건 |
| `q.select`의 JOIN | 모든 하위 resource와 하위 조회 조건·컬럼, parent equality와 local/foreign 관계 | parent의 local 컬럼 입력 binding을 child의 foreign 컬럼에 전달 |
| `q.count` | count에 실제 쓰이는 root WHERE와 required JOIN | 사용되지 않는 root projection·ORDER·페이지 및 optional JOIN 의존성을 제외. INSERT/DELETE, WHERE 이동, required JOIN 소속 변화는 유지 |
| AND / OR / NOT | 모든 조건의 읽기 컬럼 | AND는 보장 binding의 합집합, OR는 모든 branch가 공통으로 보장하는 binding만 유지, NOT은 binding 확장 |
| `q.call` / `q.map` / combine / when / choose | 호출 또는 분기의 모든 resource·컬럼 | 입력 mapping이 없는 call과 map은 binding 유지. 모든 분기의 의존성은 포함 |
| `q.bind` / 임의 call 입력 함수 | parent와 child 또는 호출 대상의 모든 resource·컬럼 | parent 입력 binding 유지. 임의 함수로 변환되는 child/callee 입력은 역변환할 수 없으므로 전체 입력으로 확장 |
| PostgreSQL SQL parser | SELECT와 CTE·중첩 SELECT에 나타나는 직접 relation, 직접 동등 입력 조건 | 저수준 compiler는 증명한 WHERE equality만 보존. self-join은 독립적인 읽기 경로를 합집합으로 유지 |
| PostgreSQL catalog artifacts의 일반 테이블 | catalog가 rules·policy 없는 일반/partitioned 테이블임을 확인하고, SQL의 projection·WHERE·JOIN ON·GROUP·HAVING·ORDER 표현식에서 컬럼 도출 | 사용하지 않는 컬럼 UPDATE를 제외. `count(*)`는 행 소속에 필요한 조건 컬럼만 관찰. LIMIT/OFFSET 쿼리도 정렬·조건 컬럼은 유지 |
| PostgreSQL view / SQL 함수 / RLS | catalog와 지원 함수 본문의 relation 의존성 전개, 활성화된 미등록 일반 테이블 발견 | 발견한 resource 전체를 관찰. 숨은 읽기 컬럼과 입력은 보수적으로 확장 |

WriteSet의 OLD/NEW 상태 각각에 equality binding을 적용하므로 고객 A → B 이동은 A와 B 조회를 모두 포함한다. 이전 결과가 비어 있던 입력도 첫 INSERT의 새 상태로 선택된다. 이는 실행된 캐시 목록을 재사용하거나 mutation마다 수동 invalidation 목록을 적는 방식이 아니다.

### 새로 보장하는 컬럼 정밀도

PostgreSQL의 column pruning은 `PostgresCatalogResolver.canPruneColumns`가 명시적으로 증명한 직접 relation에만 적용한다. 기본 catalog resolver는 relation을 성공적으로 해석한 뒤 일반/partitioned 테이블이며 rules와 policy가 없을 때만 이를 허용한다. 사용자 resolver가 이 메서드를 제공하지 않거나 저수준 compiler를 catalog 없이 호출하면 기존 `columns: '*'`를 유지한다.

RLS가 결과에 필요한 같은 테이블의 숨은 컬럼을 읽을 수 있으므로, policy가 하나라도 있으면 해당 테이블의 컬럼은 넓게 유지한다. SELECT `id`에 드러나지 않는 `visible` 컬럼을 RLS가 검사하는 경우도 변경 영향에서 빠지지 않는다. 함수에서 같은 테이블을 추가로 읽는 경우의 broad dependency도 직접 SELECT의 좁은 컬럼 목록으로 덮어쓰지 않는다.

중첩/상관 SELECT, whole-row expression, `*`, NATURAL/USING JOIN, 해석이 모호한 컬럼·alias는 컬럼 분석을 넓힌다. 3-part 컬럼 이름처럼 현재 컬럼 분석이 지원하지 않는 구문도 resource 의존성을 유지하고 전체 컬럼으로 처리한다. 이 경우를 좁힌 것으로 보고하지 않는다.

## 명시적 등록과 보완이 필요한 부분

- Resource 식별, scope 정책, Query 등록, 입력 parser는 앱의 계약이다. 임의 Drizzle/Prisma 조회 함수를 자동 분석하지 않는다.
- PostgreSQL SQL artifact의 **입력 binding은 계속 비운다**. driver parameter codec, DB 비교, observer JSON, 프론트 cache key의 동등 정규화가 아직 일반적으로 증명되지 않았기 때문이다. 이번 SQL 개선은 자동 컬럼 제외이며 native SQL 입력의 정밀 selector 지원 확대라고 주장하지 않는다.
- 임의 입력 parser/mapping의 계산을 정적으로 역변환하지 않는다. 캐시 입력은 실행에 쓰인 정규화 계약과 일치해야 한다.
- Query Plan의 고정 scalar equality만 제한적으로 평가한다. SQL literal 조건 자동 분석, range/IN/NOT 조건의 메모리 평가와 임의 DB type/codec 비교는 지원하지 않는다. 기존 응답 selector 표현은 부분 입력 equality의 합집합 또는 전체 입력이다.
- RLS가 참조하는 별도 테이블, view와 함수의 숨은 resource는 catalog artifact 경로로 확장하거나 검증된 manifest에 포함해야 한다. endpoint selector를 전체로 넓히는 것만으로 누락된 resource를 대신할 수 없다.
- 배포 후 DDL·policy·function 변경은 artifact 재생성과 observer 설치·검증을 요구한다. runtime 요청마다 전체 catalog를 다시 읽지 않는다.

## 보수적 확장과 거절

| 상황 | 처리 |
| --- | --- |
| 이미 알고 있는 resource에서 OLD/NEW·binding 값이 불명확함 | 그 resource를 읽는 endpoint의 입력을 필요한 만큼 확장 |
| 조건·JOIN·집계·페이지의 최소 소속을 정적 정보로 판정할 수 없음 | 관련 resource/컬럼을 유지하고 입력 범위를 확장 |
| 같은 resource의 여러 read path | 경로별 입력 selector의 합집합. 서로 다른 경로의 binding을 AND로 합치지 않음 |
| catalog로 view·RLS·지원 SQL 함수 의존성을 모두 해석함 | 알려진 모든 resource를 포함하고 숨은 컬럼·입력은 넓게 유지 |
| 읽는 resource 자체를 찾을 수 없음, 불명확한 함수 본문/동적 SQL/custom type/operator | artifact는 명시적 no-store로 전환하고 진단을 제공하거나 `onUnresolved: 'reject'`로 거절 |
| 시간·세션·sequence·비결정적 함수 등 DB row 변경만으로 보장할 수 없는 의존성 | freshness 정책 없는 cacheable 등록 거절 또는 no-store |
| no-store 자식을 포함한 합성 Query | 부모도 no-store. 캐시 응답으로 승격하지 않음 |
| binding 또는 fact/selector 크기 상한 | 계산의 보수적 확장 및 explain 이유 유지. 수집 실패는 성공한 빈 영향으로 대체하지 않음 |

## 의미 검증 fixture

- `tests/server-driven-impact/query-precision.test.ts`: 실제 SQLite Query 전후 비교로 `q.count`의 무관 projection/order UPDATE 및 optional JOIN 제외, required JOIN 변화 포함, 빈 count 입력과 OLD/NEW 입력 선택을 확인한다. 기존 안전한 parent → child JOIN binding도 회귀로 고정한다.
- `tests/server-driven-impact/postgres-query-compiler.test.ts`: SQL의 SELECT/WHERE/JOIN/GROUP/HAVING/ORDER 컬럼, count row membership, self-join의 독립 경로, broad fallback과 catalog proof 경계를 검사한다.
- `tests/server-driven-impact/postgres-query-precision.integration.test.ts`: 실제 catalog artifact → observer → native mutation → 최종 결과 비교를 연결한다. 무관 컬럼 제외, ORDER/LIMIT 페이지 변경, 필터·집계 변경, JOIN 상대 행 변경, 같은 테이블 RLS의 숨은 컬럼 변경 포함을 검사한다. PostgreSQL matrix의 driver 선택을 따른다.
- 기존 core·unified·PostgreSQL fixture는 scope, 변경 컬럼, OLD/NEW, empty-result insertion, OR 보장, no-store, RLS 별도 resource, cast parameter 확대 및 상한의 정확성 검사를 보존한다.

## 고정 equality 조건의 정밀화

`q.eq('status', q.literal('ready'))` 같은 고정 조건은 `ReadDependency.filters?: { column, value }[]`로 자동 도출한다. 각 filter는 결과 행에 반드시 필요한 조건이며 함께 AND로 해석한다. AND는 필요한 조건을 모으고, OR는 모든 branch가 동일하게 보장하는 조건만 남긴다. NOT과 non-scalar literal은 도출하지 않는다. Read당 최대 100개를 유지하며 추가 조건을 버리는 것은 과잉 영향을 허용하는 안전한 확장이다. 임의 call 입력 함수에서도 고정 literal 조건 자체는 유지한다.

계산은 OLD/NEW 각각에 적용한다. ready → draft 이동은 OLD가 속했던 입력을 포함하고, draft → ready 이동은 NEW 입력을 포함한다. draft → archived처럼 양쪽이 모두 조건에 맞을 수 없다고 증명되는 변경은 제외하며, 실제 계산 경로에 `filter-excluded` explain 이유를 남긴다. 변경 컬럼 검사는 filter 컬럼도 읽기 의존성으로 취급한다.

필터 비교에는 일반 `fields`를 쓰지 않고 관찰자가 제공하는 선택적 `RowState.equalityFields`만 쓴다. PostgreSQL은 검증을 마친 RLS/rule 없는 resource에서 builtin boolean·smallint·integer·bigint·text·varchar 값만 인증한다. Date/time·float4·그 밖의 type은 입력이나 JSON 변환이 다른 값을 만들 수 있어 인증하지 않는다. SQLite는 지원하는 테이블 타입과 내장 BINARY/NOCASE/RTRIM collation 경계에서 인증한다. RLS가 다른 행의 visibility에 영향을 줄 수 있는 PostgreSQL resource는 고정 조건으로 제외하지 않는다.

타입이 서로 다르면 DB coercion 가능성이 있으므로 제외하지 않는다. 분수나 안전한 정수 범위 밖의 숫자도 JSON encoder의 반올림 가능성 때문에 넓게 유지한다. 같은 문자열은 SQLite NOCASE와 RTRIM의 동등 가능성을 포함한다. NULL literal은 SQL의 3-valued logic을 정밀 평가하지 않고 보수적으로 처리한다. 인증 map이 없거나 필드가 누락되면 필터를 평가하지 않는다. 지원하지 않는 type을 조용히 정밀하다고 가정하지 않는다.

WriteSet 요약은 모든 포함 행에 공통인 인증 값만 유지한다. 어느 행의 인증 정보라도 없거나 공통 값이 사라지면 뒤의 행이 그 제약을 다시 복원할 수 없다. Byte 상한이 필요한 경우 인증 정보를 버리고 넓힌다. 이 정보는 서버 내부 WriteFact/manifest의 선택적 확장이며 `{ data, impact }` 프론트 응답 형식은 바뀌지 않는다. 이전 사실처럼 인증 map이 없는 데이터도 계산할 수 있고 더 넓은 결과를 낸다. 새 manifest/fact의 엄격한 schema consumer는 함께 갱신해야 한다.

검증: `literal-filter-precision.test.ts`는 AND/common-OR/NOT, OLD/NEW, 누락된 인증, 상한, 요약, 타입 coercion, SQLite의 실제 empty-result INSERT와 filter 이동, NOCASE/RTRIM 및 숫자 표현을 검사한다. `postgres-literal-filter.integration.test.ts`는 실제 PostgreSQL 관찰의 인증 map, date/float 인증 제외, driver별 mixed-type 입력의 보수적 처리 및 고정 조건 이동을 검사한다. 언어 중립 fixture `literal-filter-excluded.json`과 `literal-filter-old-new.json`도 동일 의미를 고정한다.

### PostgreSQL RLS 활성화 검증

고정 조건 인증은 `engine.validate()` 또는 bound adapter의 `validate()`가 성공한 뒤에만 활성화된다. 검증되지 않은 resource의 `equalityFields`는 계산 전에 제거되어 넓은 결과를 유지한다.

RLS가 같은 행의 숨은 컬럼을 읽으면 좁은 manifest도 그 컬럼을 읽기 의존성에 포함해야 한다. `scopeColumn`으로 이미 처리되는 단순 tenant 조건은 유지한다. Whole-row policy 표현식은 해당 resource의 전체 컬럼 의존성으로 취급한다. SQL helper, 별도 relation 또는 subquery가 다른 행을 읽는 경우에는 endpoint마다 모든 숨은 dependency resource에 `columns: '*'`와 빈 `bindings`를 가진 읽기 경로가 필요하다. 이때 어떤 resource가 먼저 검사되었는지와 무관하게 고정 literal 인증도 끈다. 필요한 resource는 global scope로 등록해야 하며, tenant를 넘는 읽기가 없다는 근거 없이 scoped resource로 좁히면 거절한다.

이 조건을 충족하지 못하면 `UNRESOLVED_RLS_DEPENDENCY`, `UNRESOLVED_RLS_COLUMN_DEPENDENCY` 또는 `UNRESOLVED_RLS_SCOPE_DEPENDENCY`로 활성화를 거절한다. 배포 시 명시적인 broad dependency를 등록하거나 no-store로 실행해야 한다. `postgres-rls-dependency.integration.test.ts`가 같은 행의 숨은 컬럼·whole-row 표현식, 같은 테이블 helper/subquery, 숨은 resource의 input/scope 제약, 검사 순서와 실제 visibility 변경을 검증한다.
