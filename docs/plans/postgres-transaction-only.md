# PostgreSQL 실행을 transaction 수명주기로 통일하는 최종 계획

상태: 구현 완료. transaction-only 실행기, observer protocol 10, 단일 연결 API, 실제 PgBouncer 검증과 문서를 반영했다.

확정 결정: 단일 database API, session 전용 경로 제거, transaction gate 테이블 잠금, COMMIT 전 observation 확보, 업무 종료 시 ALL IMMEDIATE 전환, token을 유지한 sealed 상태, commit 결과별 오류 구분, 실제 pooler 혼합 부하 검증.

## 목표와 기준

Query, validate, Command에 같은 transaction 기반 연결 수명주기를 적용한다. 모든 observation SQL을 COMMIT 전에 끝내며, 성공한 COMMIT 뒤 같은 backend에 접근하지 않는다. SDI의 결과는 기존처럼 업무 데이터와 ImpactSet이다. ImpactSet v1 및 core 계산 규칙은 유지한다.

이번 사용자 결정은 이전 Query transaction / Command session 분리 계획의 최종 설계를 대체한다. session 실행 모드와 이를 위한 호환 분기를 남기지 않는다. 기존 deferred 실행과 완전한 동등성은 보장하지 않고, 아래 종료 계약을 새 Command 계약으로 삼는다.

- 작업 트리: `/Users/woohyunpark/Desktop/c/server-driven-impact-query-pooling`
- 작업 브랜치: `feat/postgres-query-pooling`; 이미 격리된 작업 트리에서 기존 미커밋 변경을 이어서 수정한다.
- Git 기반: `f518f1a` 및 이 작업 트리의 Query pooling 변경. 최종 PR은 이 전체 변경을 포함한다. 기반 브랜치의 main 병합 여부는 PR 준비 시 확인한다.
- 기존 전달 tarball은 보존한다. 새 결과는 다른 버전과 경로로 만든다.
- 구현은 로컬 작업 트리에 완료했다. commit·push·PR·npm 게시는 별도 사용자 승인 전에는 수행하지 않는다.
- toktok-world 전환, GraphQL/클라이언트 캐시, CDC/outbox, 읽기 replica는 범위 밖이다.

## 1. 공개 API

```ts
const database = postgres(transactionPoolUrl, {
  max: 1,
  prepare: false,
});

const adapter = postgresAdapter({
  database,
  isolationLevel: 'repeatable read',
  setup: async (tx, scope) => {
    await tx.unsafe("select set_config('app.account_id', $1, true)", [String(scope)]);
  },
});
```

- `database`, `setup`, `isolationLevel`만 연결 실행 설정으로 사용한다.
- `connectionMode`, `query`, `command` 연결 옵션과 관련 union을 제거한다. JS에서 제거된 설정을 전달하면 설명 가능한 configuration error로 거절하며 조용히 무시하지 않는다.
- pg, Drizzle, Prisma도 하나의 database/pool을 받아 같은 실행기를 사용한다. ORM 고유 옵션은 유지한다.
- Query 전용 서비스도 같은 adapter로 Query와 validate만 호출하면 된다. 별도 Query-only 연결 옵션과 session-required 오류 경로를 제거한다.
- direct DB 연결에서도 같은 실행기가 동작한다. backend 공유 효과는 실제 transaction pool endpoint를 연결해야 얻는다. SDI가 외부 pool 모드를 바꾸거나 URL로 감지하지 않는다.
- 기본 Repeatable Read와 기존 명시적 isolation level은 유지한다.
- 최초 지원 설정은 Postgres.js `prepare:false`로 고정하고 검증한다. PgBouncer가 특정 설정에서 prepared statements를 지원한다는 사실과 구분하여 SDI 지원 조건으로 문서화한다.

## 2. 최종 실행 순서

Query / validate:

```text
연결 획득
BEGIN ... READ ONLY
gate ACCESS SHARE 잠금
Query setup 및 Query 실행 / validate의 catalog·observer 검증
COMMIT
드라이버 연결 반환
```

Command:

```text
연결 획득
BEGIN
gate ACCESS SHARE 잠금
ON COMMIT DROP collector 생성
request token / scope / observation phase를 transaction-local로 설정
setup 및 역할·collector 권한 준비
업무 callback 실행
새 DB 호출 차단 → cursor/COPY/savepoint/이미 시작된 작업 정리
SET CONSTRAINTS ALL IMMEDIATE
collector DELETE ... RETURNING 결과를 메모리로 완전히 확보
observation phase를 sealed로 변경
COMMIT
드라이버 연결 반환
메모리의 rowsToFacts → WriteSet → impact 계산
{ data, impact } 반환
```

- gate 잠금 전에 SELECT, 타입 탐색 SELECT, 업무 DML, collector DDL이 끼어들지 않도록 드라이버 실행 순서를 확인한다.
- 업무 callback의 성공/실패 직후 새로운 DB 호출을 먼저 차단하고, 그 다음 이미 시작된 작업을 정리한다. 단순 Promise 대기만으로 종료를 구현하지 않는다. raw SQL, lazy postgres.js query, ORM, savepoint, cursor/COPY 모두 같은 경계를 통과한다. 기존 UNAWAITED_DATABASE_OPERATION 검사를 유지하며, 정리 완료를 방치된 작업의 성공 승인으로 바꾸지 않는다.
- COMMIT 성공 뒤 observation 조회, advisory unlock, backend 종료 SQL을 실행하지 않는다.
- collector 존재를 다음 transaction에서 재사용하지 않는다. 같은 이름의 잔여 객체를 `IF NOT EXISTS`로 조용히 채택하지 않는다.
- request token은 transaction-local로 생성·설정한다. observer 입력과 scope 의미는 유지한다.
- setup은 신뢰된 서버 코드이며 transaction-local 설정만 허용하는 계약을 갖는다. 임의 세션 설정을 분석하는 SQL sandbox는 만들지 않는다.

## 3. Deferred 지원 계약과 수집 종료 장치

새 계약: 업무 callback이 끝난 뒤 SDI가 모든 deferrable constraint를 IMMEDIATE로 전환한다. 이 단계에서 제약조건과 trigger 실행이 성공해야 Command를 커밋한다. 기존 COMMIT의 모든 deferred 처리 순서를 그대로 재현한다고 약속하지 않는다.

지원·실패 예제:

- 업무 callback 안에서 자식을 먼저 만들고 부모를 나중에 만드는 deferrable FK: 종료 시 최종 상태가 유효하면 성공.
- deferred 감사 trigger가 추가 행을 생성: 종료 단계에서 실행하고 observation에 포함.
- deferred trigger 1이 부모 없는 자식을 만들고 trigger 2가 부모를 만드는 반례: IMMEDIATE 단계에서 FK 위반, 전체 rollback. 과거 COMMIT 성공과 다른 의도된 계약으로 테스트한다.

`SET CONSTRAINTS ALL IMMEDIATE` 한 줄만으로 이후 모든 관찰 대상 DML이 불가능하다고 가정하지 않는다. observer에 transaction-local 수집 상태 검사를 추가한다.

```sql
-- 개념 예시: 실제 이름과 SQLSTATE는 구현 시 일관되게 지정
IF current_setting('sdi.observation_phase', true) = 'sealed' THEN
  RAISE EXCEPTION 'SDI_OBSERVATION_CLOSED';
END IF;
```

- 수집 후 늦은 trigger가 관찰 대상 데이터를 변경하면 observer가 오류를 발생시켜 해당 변경의 커밋을 막는다.
- 이 검사는 observer의 INSERT/UPDATE/DELETE/TRUNCATE 경로에서 observation 기록 및 정밀도 축소 이전에 실행한다. 파티션·cascade 경로도 포함한다.
- 새 request token이 설정된 Command는 기대한 phase가 없거나 잘못됐을 때도 안전하게 실패한다. 기존 일반 외부 쓰기의 token 없음 처리와는 구분한다.
- request token과 sealed phase는 COMMIT/ROLLBACK까지 유지한다. 수집 종료 때 token을 비우지 않는다. observer는 sealed 검사를 token 없음에 대한 조기 반환보다 먼저 수행하여, sealed인데 token만 사라진 경로도 거절한다. transaction 종료 뒤에는 LOCAL 설정이 되돌아가야 한다.
- trigger가 다시 DEFERRED로 바꾸고 후속 trigger를 예약하는 경우를 실제 PostgreSQL에서 재현한다. 수집 이후 관찰 대상 변경을 누락한 채 COMMIT 성공하는 경로가 없어야 한다.
- observer 오류를 PL/pgSQL subtransaction에서 잡더라도 실패한 하위 DML이 rollback되고 최종 커밋된 변경과 observation이 일치하는지 검증한다.
- 이 장치는 SDI의 token/phase를 고의로 조작하거나 observer를 끄는 신뢰 위반 코드를 방어하는 sandbox가 아니다. 등록된 resource와 정상 observer coverage 안에서 보장한다.
- 이 안전 장치가 검증되지 않으면 session fallback으로 우회하거나 불완전한 impact를 반환하지 않는다. release 완료 조건 미달로 남긴다.

## 4. Observer 설치·권한·migration

- phase 검사가 포함된 observer protocol/fingerprint를 갱신하고 observer 재설치를 필수로 한다.
- 새 runtime이 이전 observer를 이용해 수집 종료 검사를 우회하지 못하도록 한다. 배포의 명시적 validate에 더해, 새 Command의 첫 사용 전에 observer 검증이 성공해야 실행할 수 있도록 초기화 상태를 관리한다. 초기화 검증은 캐시하며 매 Command마다 전체 catalog를 조회하지 않는다. 실패는 정상 실행으로 전환하지 않는다.
- 기존 `sdi_control.transaction_gate` 물리 테이블을 공동 transaction gate로 사용한다. 별도 병렬 잠금 테이블을 만들지 않는다. 설치 helper 명칭/문서는 Query 전용 의미를 정리한다.
- Query/Command는 gate 공유 잠금만 사용한다.
- gate의 LOCK TABLE 잠금도 transaction 종료 시 자동 해제된다. `SELECT pg_advisory_xact_lock_shared(...)`로 단순 대체하지 않는다. 기본 Repeatable Read에서 잠금 함수를 실행하는 SELECT가 migration 대기 전에 snapshot을 고정할 수 있기 때문이다. gate 잠금 이전 SELECT가 없는 기존 순서를 유지하고 대기 이후 snapshot을 회귀 검증한다.
- migration은 기존 `pg_advisory_xact_lock`으로 관리자 migration을 직렬화한 뒤 gate 배타 잠금을 획득하고 DDL·재컴파일·observer 설치를 수행한다. 이 advisory 잠금은 transaction-local이므로 별도 unlock SQL이 없다.
- 기존 gate 설치의 구조·소유권 검증을 보완하고, gate 없는 오류명을 Query 전용이 아닌 공통 초기화 오류로 정리한다. runtime Query/validate에서 gate DDL을 실행하지 않는다.
- collector 생성자와 setup 후 effective role이 다른 경우 최소 권한으로 observer의 SELECT/INSERT/DELETE 및 drain이 가능하도록 실행 순서를 확정한다. collector 생성 역할과 setup 이후 effective role이 다르면 잠시 RESET ROLE로 생성 역할에 돌아가 해당 effective role에만 임시 collector 권한을 부여한 뒤 SET LOCAL ROLE을 복원한다. PUBLIC 권한은 사용하지 않는다.
- 첫 배포는 구 runtime 트래픽 중지·진행 중 Command drain → gate/observer migration → 새 artifact 배포·validate → 트래픽 재개 순서다. 새/구 runtime의 무중단 혼용은 이번 완료 조건에서 제외한다.
- 새 lifecycle marker 때문에 observer 재설치가 필요하지만 ImpactSet의 wire protocol은 바꾸지 않는다.

## 5. 오류와 드라이버 정리

| 시점 | 결과 |
| --- | --- |
| 업무/guard/constraint flush/observation 조회/seal 실패 | COMMIT하지 않고 rollback, 일반 Command 실패 |
| 서버가 COMMIT을 명확히 거절 | 기존 SQLSTATE 보존, 일반 Command 실패 |
| COMMIT 도중 네트워크 단절 등 결과 불명 | CommitStateUnknownError, data/impact 성공 결과 공개 금지 |
| COMMIT 후 rowsToFacts/WriteSet/impact 계산 실패 | ImpactUnavailableError.data 유지 |
| 연결 반환 오류 | 확인된 commit 결과나 원래 오류를 덮어쓰지 않고 연결 상태를 격리 |

- COMMIT 전후를 명시적인 상태로 관리한다. 모든 COMMIT 오류를 결과 불명으로 바꾸지 않으며 일반 자동 재시도를 추가하지 않는다.
- 실행기 상태는 최소 `before-commit`, `commit-in-flight`, `committed`, `commit-rejected`, `commit-unknown`으로 구분한다. 드라이버가 전송 여부를 확실히 제공하지 않으면 COMMIT 호출 시작부터 in-flight로 보수적으로 취급한다. IMMEDIATE 성공이나 observation 확보만으로 committed로 전환하지 않는다. commit-unknown 이후 rollback 성공도 이전 commit 성공 가능성을 지우지 않는다.
- pg는 같은 PoolClient를 사용하고 실패한 연결은 release(true)로 폐기한다.
- postgres.js는 공개 transaction API의 rollback/연결 단절 동작을 먼저 검증하고 활용한다. reservation이 필요한 경우 건강한 연결만 반환한다. rollback 상태를 확인할 수 없고 안전한 폐기도 불가능하면 해당 database 사용을 차단하고 앱 소유 pool 전체를 임의 종료하지 않는다.
- 깨진 reservation을 먼저 반환하고 bound adapter 하나만 격리하는 것으로 안전을 주장하지 않는다. 같은 database를 공유한 엔진의 재사용도 막아야 한다.
- pg_terminate_backend로 pooler 너머 backend를 정리하지 않는다. 정상 transaction의 backend 반환과 장애 시 격리는 별도 조건으로 기록한다.
- Query, validate, Command가 공통 정리 규칙을 사용한다.

## 6. 구현 순서와 파일 범위

1. **최소 실제 DB 실험:** deferred 정상/실패 반례, 재지연·늦은 DML과 sealed observer, 역할 전환, 오류 catch/subtransaction을 검증한다. 구현 방향의 정확성을 먼저 확정한다.
2. **Observer 계약:** `observer.ts`, protocol fingerprint, 초기화 검증, collector phase·권한·배포 SQL을 구현한다.
3. **Transaction 실행기:** `preamble.ts`, `session.ts`, `postgres/index.ts`에서 shared gate, transaction collector, flush/drain/seal/commit 및 드라이버 정리를 통합한다. PRESERVE ROWS·COMMIT 뒤 drain·세션 advisory·backend 종료 코드를 제거한다.
4. **API 단순화:** Postgres/Pg 옵션과 Drizzle/Prisma 전달 경로를 단일 database 설정으로 정리한다. 제거 옵션 오류와 타입 consumer를 갱신한다.
5. **통합·성능 검증:** 기존 conformance를 새 계약으로 전환하고 실제 pooler 혼합 부하 및 장애 주입을 추가한다.
6. **문서·배포 준비:** README EN/KO, compatibility/capability 문서, 예제, migration 가이드, changelog·changeset을 최종 설계로 다시 작성한다. 새 tarball과 설치 예시를 준비한다.

중간 session 호환 실행 경로, optional transaction 기능 스위치, 영속 collector/outbox는 구현하지 않는다.

## 7. 완료 조건

정확성:

- PostgreSQL 14–18 × postgres.js/pg에서 기존 core/observer 정확성, native result/codec, RLS, savepoint, cascade, partition, materialized view, COPY/cursor와 새 종료 계약 테스트 통과.
- deferred 처리 이후 발생한 모든 지원 대상 변경이 관찰되거나 Command가 rollback됨. silent omission 없음.
- 최초 observer 검증 실패, 이전 observer, 수집 종료 이후 DML, collector 권한 오류가 안전하게 실패함.
- 관찰 조회 실패는 실제 DB 변경 rollback으로 증명하고 COMMIT 후 변환 실패는 실제 커밋과 ImpactUnavailableError.data로 증명.
- COMMIT 응답 유실·서버 COMMIT 거절·rollback 실패·cancel·release 실패를 각각 구분하여 검증.
- migration 선행/Command 선행 양방향 대기, 기다린 뒤 catalog snapshot, 다중 SELECT 사이 Repeatable Read 유지 검증.

실제 pooling:

- digest를 고정한 PgBouncer 및 Supavisor fixture에서 테스트. 같은 acceptance suite를 사용하고 fixture가 없으면 skip을 완료로 계산하지 않음.
- 독립 client 30개 이상, 각 max 1, backend pool 5개에서 Query/Command 혼합 부하와 반복 부하.
- max 1은 client 인스턴스별 설정이며 전체 서비스 동시성 제한이 아님을 예제에 명시한다. 동시 요청 성공 건수뿐 아니라 실제 backend 연결 수, 활성/대기 backend 수, pool 대기시간과 p95를 수집하여 client 수보다 적은 backend를 공유함을 확인한다.
- 한 transaction의 PID는 동일하며 서로 다른 transaction은 backend 교체가 가능함을 강제로 backend 배정을 바꾸어 검증.
- 정상·rollback·cancel 이후 role, scope, search_path, token/phase, collector 유출 없음. 성공한 COMMIT 뒤 추가 SQL 0회, 세션 advisory 잠금 잔류 0개.
- Postgres.js와 pg 전체 acceptance, Drizzle/Prisma는 pooler를 경유한 DML·savepoint·결과 타입·오류 최소 acceptance 실행.

비용:

- 기존 전달 tarball과 새 빌드로 같은 부하의 p50/p95, 처리량, backend 활성/대기 수, SQL 왕복 수를 측정.
- Command별 CREATE/DROP의 catalog 비용과 COMMIT 전 수집으로 길어진 업무 잠금 유지 시간을 측정. 연결 효율 개선을 단일 요청 지연 개선으로 표현하지 않음.
- 결과를 검증 문서에 기록하고 실패·시간초과·observer 누락이 하나라도 있으면 통과로 기록하지 않음.

필수 검사: pnpm lint, pnpm typecheck, pnpm test, pnpm pack:check, PG matrix, 실제 pooler acceptance. 일반 pnpm test에서 환경 의존 fixture를 건너뛴 결과와 필수 통합 테스트를 구분한다.

## 8. 릴리스와 산출물

- 이 변경은 deferred 의미와 분리 옵션을 바꾸므로 breaking change로 기록한다. 단순 patch/무조건 하위 호환으로 설명하지 않는다.
- fixed-group 네 패키지 버전은 릴리스 준비 시 일치시키되 이번 변경을 위해 core impact 알고리즘이나 SQLite 동작을 바꾸지 않는다.
- 기존 `0.5.0-impact.0` tarball을 덮어쓰지 않는다. 현재 registry/changeset 상태를 확인한 뒤 구별되는 다음 prerelease를 선택한다.
- 로컬 tarball 검증 이후 사용자에게 사용 경로, observer migration 절차, deferred 제한과 검증 결과를 함께 제공한다.
- 구현 tarball: `.local/artifacts/transaction-only-20260915/server-driven-impact-postgres-0.5.0-impact.0.tgz` (SHA-256 `f51c841bfc07d0bce823f0b50cc6828017e3c906a9800bcd9f4cd8e3344db6f4`).
- 실제 Supavisor나 장애 검증이 미완료이면 실험용 tarball과 정식 지원 완료를 구분한다.

## 근거

검증 상태: transaction-only Command, 정상 deferred observation, 재지연된 늦은 쓰기의 sealed rollback과 오류 catch/subtransaction, PostgreSQL 14–18의 postgres.js/pg 전체 conformance, PgBouncer backend pool 5개·독립 client 30개 혼합 부하와 ORM 경로를 실행했다. PostgreSQL 14–17은 버전별 격리 컨테이너, PostgreSQL 18은 기존 격리 컨테이너에서 검증했다. Supavisor 자체 acceptance는 별도 운영 환경에서 남아 있다.

- 현재 작업 트리의 postgres/index.ts, preamble.ts, connection.ts, observer.ts, migration.ts 및 observer-precision.integration.test.ts.
- PostgreSQL 16.15에서 기존 COMMIT 성공 / ALL IMMEDIATE 외래키 실패 반례를 이전 검토에서 재현함.
- [PostgreSQL SET CONSTRAINTS](https://www.postgresql.org/docs/current/sql-set-constraints.html): 미처리 검사 실행과 검사 모드 전환.
- [PostgreSQL LOCK](https://www.postgresql.org/docs/current/sql-lock.html): transaction 잠금과 Repeatable Read 첫 조회 이전 획득 순서.
- [PgBouncer features](https://www.pgbouncer.org/features.html): ON COMMIT DROP, transaction pooling, prepared statement 설정별 지원.
