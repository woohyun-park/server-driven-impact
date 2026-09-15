# Postgres Query transaction pooling 지원 계획

후속 결정: 이 문서의 Query/Command 연결 분리 및 session 경로 유지 설계는 [transaction 수명주기 통일 계획](./postgres-transaction-only.md)으로 대체한다. 아래 내용은 이미 전달한 Query pooling tarball의 구현 기록이다.

상태: 구현 및 로컬 검증 완료. commit·push·PR·배포 전. 실제 Supavisor fixture 검증은 미완료.

## 1. 목표와 범위

Query가 session pool의 backend를 장시간 점유하는 문제를 해결한다. Query는 transaction pool, Command는 direct/session pool을 사용하도록 연결과 수명주기를 분리한다. SDI는 계속 `{ data, impact }`만 반환하고 ImpactSet v1 계산 의미를 유지한다.

지원 항목:

- Postgres.js와 node-postgres의 Query/Command 연결 분리.
- transaction-mode Query 및 `queryUncached()` 실행과 catalog validation.
- Query 전용 설정: Command 연결 없이 생성하고, Command 호출은 업무 콜백·연결 획득 전에 거부.
- 기존 `postgresAdapter({ database, setup, isolationLevel, connectionMode })` 및 `pgAdapter` 호출의 타입·실행 호환 유지.
- 기본 `repeatable read`, 명시적인 기존 isolation level의 의미 유지.
- transaction 내부의 `SET LOCAL ROLE`, `set_config(..., true)`, search_path 설정 지원.
- 두 pool의 독립적인 연결 획득·정리·장애 격리.
- Drizzle/Prisma가 공유하는 PgOptions 전달 경로와 Command 동작 유지.

제외 항목:

- Command의 transaction pooling, COMMIT 전 observation 수집.
- read replica 라우팅, 다른 DB/클러스터를 Query와 Command에 연결하는 구성.
- toktok-world/Next.js 애플리케이션 수정.
- 사용자 setup/routine의 임의 세션 변경을 방어하는 SQL sandbox.
- 지연 실행, deferred trigger, commit-state 계약 변경.
- 클라이언트 캐시 키 생성, 캐시 실행 어댑터.

## 2. 작업 기준

- 기준 커밋: `f518f1a24aba8e9ca1eba35c30778e2052fc1655` (`0.5.0-impact.0`).
- 기준 브랜치: `refactor/impact-only`.
- 작업 브랜치: `feat/postgres-query-pooling`.
- 작업트리: `/Users/woohyunpark/Desktop/c/server-driven-impact-query-pooling`.
- PR은 기반 변경이 main에 병합됐으면 main, 아니면 `refactor/impact-only`를 대상으로 하여 본 작업만 비교되게 한다.
- 이 요청은 기존 API의 완전한 호환을 명시했으므로 `database` 입력 형태는 유지한다. 이전 캐시 API를 복원하지 않는다.
- 구현 승인을 반영했다. 이전 기능의 commit/push/npm release 승인을 이번 기능의 배포 승인으로 확대하지 않는다.

## 3. API 결정

연결별 모드를 묶어 의미를 명확히 한다. 새로운 설정에서 query는 필수, command는 선택이다.

```ts
const queryDatabase = postgres(transactionUrl, {
  prepare: false,
  max: 1, // 예시: 인스턴스별 설정. 전체 동시성 제한을 의미하지 않음.
});
const commandDatabase = postgres(sessionUrl, {
  prepare: false,
  max: 1,
});

const adapter = postgresAdapter({
  query: {
    database: queryDatabase,
    connectionMode: 'transaction',
  },
  command: {
    database: commandDatabase,
    connectionMode: 'session',
  },
  isolationLevel: 'repeatable read',
  setup,
});
```

```ts
// Query 전용
postgresAdapter({
  query: { database: queryDatabase, connectionMode: 'transaction' },
  setup,
});

// 기존 설정: 기존 의미 유지
postgresAdapter({ database, setup });
```

- `query.connectionMode`: `direct | session | transaction`, 명시 필수.
- `command.connectionMode`: `direct | session`, 명시 필수.
- `isolationLevel`, `setup`은 기존처럼 공통 옵션이다. 이번 작업에서 경로별 setup/격리 수준 옵션은 추가하지 않는다.
- 기존 형식과 새 형식은 TypeScript union으로 배타적으로 표현한다. JS 호출에서도 혼합 설정은 `INVALID_POSTGRES_CONNECTION_OPTIONS`로 거부한다.
- 기존 `{ database, connectionMode: 'transaction' }`는 기존처럼 생성 시 `POSTGRES_SESSION_CONNECTION_REQUIRED`로 거부한다. Query 전용은 새 형식으로 명시한다.
- 새 형식에서 command 모드가 transaction이면 타입 검사 및 생성 시 검증에서 거부한다.
- Query 전용 엔진의 `command()`는 `POSTGRES_SESSION_CONNECTION_REQUIRED`로 거부한다. query pool로 자동 대체하지 않는다.
- 모드는 배포자의 선언이다. URL 포트나 `postgres.Sql` 객체만으로 실제 외부 pool 모드까지 자동 판별한다고 보장하지 않는다.
- Supavisor 호환 기준으로 transaction Query용 Postgres.js 인스턴스는 `prepare: false`를 요구한다. 공개 options에서 확인 가능한 경우 생성 시 잘못된 설정을 거부하고 `POSTGRES_QUERY_PREPARE_UNSUPPORTED`를 사용한다. node-postgres의 SDI Query 실행은 named prepared statement를 만들지 않는다.
- 새 설정도 기존 공개 PostgresOptions/PgOptions 타입 사용, 제네릭 추론, DrizzleOptions/PrismaOptions 사용이 깨지지 않도록 타입 consumer로 검증한다. union 도입 시 기존 interface 상속 구조는 정리하되 호출부 호환을 유지한다.

## 4. Query 트랜잭션과 migration 잠금

### 4.1 현재 제약

현재 `readPreambleSql()`은 BEGIN 전에 session advisory lock을 획득하고, `releaseSession()`은 COMMIT 뒤 세션 잠금을 해제한다. transaction pooling에서는 이 경로를 재사용할 수 없다.

단순히 BEGIN 뒤 `SELECT pg_advisory_xact_lock_shared(...)`를 실행하는 변경도 채택하지 않는다. Repeatable Read에서 잠금을 기다리기 전에 snapshot이 결정되어 migration 이전 catalog를 검증할 수 있다.

### 4.2 전용 잠금 테이블

안정된 내부 테이블 `sdi_control.query_gate`를 migration 준비 단계에서 설치한다. 업무 데이터나 observer 기록을 저장하지 않는 잠금 대상이며, artifact fingerprint별로 새 테이블을 만들지 않는다. runtime role에는 schema USAGE와 테이블 SELECT만 부여한다. 정의·소유권이 다른 같은 이름의 객체는 조용히 채택하지 않고 설치 시 거부한다.

transaction-mode Query/validate 경로:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
LOCK TABLE ONLY sdi_control.query_gate IN ACCESS SHARE MODE;
-- 여기까지 SELECT, 드라이버의 타입 탐색 SELECT, setup 실행이 끼어들면 안 됨.
-- 잠금 획득 이후 setup, catalog 검증 또는 Query 실행.
COMMIT;
-- COMMIT 이후 세션 상태에 의존하는 정리 SQL 없음.
```

첫 SQL 조회 전에 `LOCK TABLE`을 실행하면 migration 대기 후 snapshot을 얻을 수 있다는 PostgreSQL의 문서화된 동작을 사용한다. 공유 잠금은 여러 Query를 직렬화하지 않는다. 트랜잭션 종료 시 잠금이 자동 해제된다.

cooperating migration 경로:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT pg_advisory_xact_lock(...); -- 기존 Command/session Query와 조율
-- 최초 도입 시 여기서 관리 권한으로 gate를 생성.
LOCK TABLE ONLY sdi_control.query_gate IN ACCESS EXCLUSIVE MODE;
-- 애플리케이션 DDL → 재컴파일 → observer 설치 → 검증
COMMIT;
```

- migration 잠금 순서는 기존 advisory exclusive → gate exclusive로 고정한다.
- 새로운 transaction Query는 gate만 획득하며 나중에 기존 advisory lock을 추가 획득하지 않는다. 역순 잠금에 의한 deadlock을 방지한다.
- 기존 direct/session Query 및 Command는 현재 advisory lock 계약을 유지한다.
- gate는 `change()` 콜백과 모든 관련 DDL보다 먼저 획득해야 한다. observer SQL 마지막에만 잠금을 추가하는 구현은 불충분하다.
- `migratePostgresArtifacts()`와 `migratePostgresQueries()` 모두 적용한다. raw SQL migration 사용자는 전체 DDL을 같은 잠금 규약 안에 넣도록 문서·예제를 제공한다.
- gate 초기 설치와 권한 부여는 관리자가 migration에서 실행한다. Query/validate가 런타임 DDL을 실행하지 않는다.
- gate가 없으면 새 transaction Query/validate는 `POSTGRES_QUERY_POOL_NOT_INITIALIZED`로 실패하며 설치 절차를 안내한다. 기존 설정에는 새 gate 설치를 요구하지 않는다.
- 신규 Query 활성화 전에 모든 cooperating migrator를 새 프로토콜로 업그레이드한다. 오래된 migration 실행기는 gate를 무시하므로 혼용 상태의 보장을 주장하지 않는다.
- gate는 별도 내부 schema에 두고 업무 Resources 및 artifact별 catalog 추적 대상으로 섞지 않는다. 관련 fingerprint·권한 변화가 있으면 재컴파일 필요 여부를 통합 테스트로 확인하고 설치 가이드에 반영한다.
- 첫 구현 단계에서 PG 14–18의 잠금·snapshot 회귀를 증명한다. 실패하면 격리 수준을 조용히 Read Committed로 낮추거나 migration 잠금을 제거하지 않고, 해당 설계를 수정한 후 다음 단계로 진행한다.

## 5. 연결 수명주기와 오류 처리

- 옵션을 내부 query/command 연결 명세로 한 번 정규화한다. 업무 Query 실행·manifest 계산은 공통 로직을 유지하고 연결 수명주기만 모드별로 선택한다.
- Query 처리 중 command pool을 reserve/connect 하지 않는다. 생성 시에도 eager Command 연결을 만들지 않는다.
- Postgres.js는 드라이버가 제공하는 transaction 수명주기를 우선 사용한다. node-postgres는 체크아웃한 PoolClient 하나에서 BEGIN부터 COMMIT/ROLLBACK까지 실행한다.
- Query용 reservation이 고정하는 것은 pooler까지의 client 연결이다. backend 고정은 명시적인 transaction과 pooler가 보장한다.
- native/structured/composed/no-store Query와 validate가 동일한 transaction-safe 실행기를 사용한다.
- setup은 gate 획득 이후, 업무 SQL 이전에 한 번 실행한다. `SET LOCAL ROLE`, 로컬 claims/search_path만 지원하고 세션 SET·LISTEN·세션 advisory lock 사용 금지를 문서화한다. 신뢰된 callback을 임의 SQL parser로 sandbox화하지 않는다.
- transaction Query의 성공 후 정리는 client 반환만 수행한다. COMMIT 이후 advisory unlock 또는 backend 종료 SQL을 보내지 않는다.
- SQL 오류는 같은 transaction에서 ROLLBACK 후 반환한다. 연결 단절·rollback 불명 상태는 드라이버의 안전한 폐기/격리 경로로 처리하고 깨진 연결을 재사용하지 않는다.
- Postgres.js의 실제 실패 정리 동작은 fault test로 확인한다. 공개 API로 per-connection discard가 불가능한 경우 adapter의 해당 query 경로를 fail-closed로 격리하고, 애플리케이션 소유 pool 전체를 임의 종료하지 않는다. 다른 backend에서 `pg_terminate_backend()`를 실행하는 fallback은 금지한다.
- 별도 연결의 quarantine은 독립적으로 관리한다. 동일한 pool을 재사용하는 기존 구성은 기존 장애 의미를 유지한다.
- Command collector, deferred 동작 이후 COMMIT/drain 순서, CommitStateUnknownError 및 ImpactUnavailableError 계약은 유지한다.

## 6. validate와 배포 조건

- Query 전용 validate는 queryDatabase의 read-only transaction에서 catalog와 기존 observer metadata/coverage를 검사한다. Query 전용이라고 observer 설치 검사를 생략하는 별도 의미는 만들지 않는다.
- 두 연결 구성은 Query 측 읽기 검증과 Command 측 observer/비교 의미 검증을 각각 수행한다. Command 정밀도에 사용하는 검증 결과를 다른 연결에서 얻은 결과로 무조건 대체하지 않는다.
- 같은 DB와 같은 artifact/manifest를 사용하는 것이 지원 전제다. 읽기 replica·서로 다른 클러스터는 범위 밖이다. fingerprint 일치만으로 물리 DB 동일성을 증명했다고 표현하지 않는다.
- 명시적 `validate()`에서는 양쪽 pool에 접근할 수 있지만, 정상 Query 트래픽에는 그 검사를 반복하지 않는다. query-only 설정에는 command 접근이 없다.
- 검증 실패 또는 재검증 실패 후 오래된 정밀도 증명이 계속 사용되지 않도록 상태를 초기화한다.
- 기존 validate는 context/setup 없이 수행되므로 새로 임의 scope를 만들어 setup을 호출하지 않는다. 로그인 역할의 catalog 접근 권한과 실제 Query의 SET LOCAL ROLE/effectiveRole 검사는 구분한다.
- 배포 순서: 관리용 migration 코드 업그레이드 → gate 설치·권한 부여 → 필요한 artifact/observer 갱신 → 명시적 validate → transaction Query 트래픽 활성화.
- 새 Query 설정을 되돌려 기존 database 설정으로 복구할 수 있다. gate는 남겨두어도 기존 Command/session Query 동작에 영향을 주지 않는다.

## 7. 구현 순서

1. **잠금·snapshot 검증:** gate 방식과 migration 대기 테스트부터 작성한다. 신규 Query와 기존 Command/migration이 공존할 때 교착·catalog snapshot 회귀가 없는지 증명한다.
2. **DB 설치 경로:** gate 설치, 최소 권한, migration lock 순서, 미설치 오류와 배포 문서를 구현한다.
3. **공개 옵션과 연결 라우팅:** 새 API, 기존 형식 호환, query-only 거부 조건, query/command 독립 상태를 구현한다.
4. **Query transaction 실행기:** preamble·setup·실행·종료와 오류 정리를 적용한다. 기존 Command 경로를 유지한다.
5. **검증·드라이버 연결:** validate의 연결별 증명, pg bridge, Drizzle/Prisma 전달, Postgres.js prepared 설정과 driver lifecycle을 확인한다.
6. **실제 pooler conformance:** PgBouncer transaction 모드를 필수 CI에 추가하고 Supavisor도 고정된 버전의 실제 환경에서 검증한다.
7. **문서·릴리스 준비:** 연결 모드 지원표, Supabase 설정, migration/복구 절차, examples, capability manifest, changelog/changeset, 독립 tarball consumer를 갱신한다.

## 8. 검증과 완료 조건

### API·회귀

- 기존 database 형식, PgOptions 및 ORM 옵션 사용 consumer가 컴파일되고 기존 결과 타입이 유지됨.
- 혼합 설정, transaction-mode Command, query-only Command 거부가 callback 실행·DB 접근 전에 발생함.
- Query-only 생성/실행/validate에서 command pool 획득 0회.
- Query 작업 중 command pool이 이미 포화되어 있어도 Query는 query pool을 통해 완료됨.
- 기존 Command WriteFacts/ImpactSet/driver result/savepoint/deferred trigger/commit-state conformance가 그대로 통과함.

### 실제 transaction pooling

- Postgres.js와 node-postgres 모두 실제 PgBouncer transaction 모드를 통과함. Pooler 버전/이미지 digest를 고정함.
- Supavisor도 실제 transaction mode fixture에서 두 드라이버의 최소 acceptance suite를 통과해야 함. 현재 로컬 검증은 PgBouncer까지 완료했으며 Supavisor 운영 fixture 검증은 미완료다.
- Supavisor 환경을 확보하지 못하면 그 검증은 미완료로 남기고, PgBouncer 통과만으로 Supavisor 검증 완료를 주장하지 않음.
- 독립된 client 인스턴스 30개, 각각 max 1, backend pool 5개로 동시에 Query를 수행함. pooler client 한도는 30보다 크게 설정하고 큐 대기를 허용함.
- 단일 client의 Promise.all 테스트로 대체하지 않음. 반복된 부하 후 command pool 획득 0회, session 잠금 잔류 0개, connection leak 없음.
- 한 composed Query 안에서 여러 SQL의 backend PID가 같음. 서로 다른 트랜잭션이 반드시 다른 PID를 쓸 필요는 없음.
- query backend를 재사용해도 role·claims·search_path가 다음 요청에 유출되지 않음. 성공·SQL 오류·cancel·연결 단절·rollback 실패를 포함함.
- 다중 SQL Query 사이 외부 UPDATE를 끼워도 기본 Repeatable Read snapshot을 유지함.
- migration 선행/Query 선행 모두 테스트함. migration 완료 후 validate가 변경된 catalog를 확인하고 기존 drift 오류를 반환함.
- 신규 transaction Query·기존 session Query·기존 Command·migration의 동시 실행에서 교착과 잘못된 영향 계산이 없음.

### 실행할 검사

- 개발 중 관련 unit/type/integration 테스트만 실행.
- 완료 시 `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm pack:check`.
- PostgreSQL 14–18 × postgres.js/pg 기존 conformance와 migration gate 회귀.
- 추가하는 실제 pooler 테스트 실행 명령과 CI job을 문서화하고 필수 fixture의 skip을 성공으로 취급하지 않음.
- 현재 서버리스 장애의 성공 기준은 Query가 session pool을 점유하지 않는 것이다. 전체 DB 부하, transaction queue timeout, Command 인스턴스 증가로 인한 session pool 고갈까지 없어졌다고 주장하지 않음.

## 9. 릴리스와 후속 작업

- 기존 안정 API를 유지하는 기능 추가로 기록한다. 네 패키지의 fixed release 정책과 내부 dependency 범위를 맞춘다.
- 다음 prerelease 후보는 `0.5.0-impact.1`이며 구현 완료 시 registry와 브랜치 상태를 확인해 충돌 없는 버전을 확정한다. 기존 게시 버전을 덮어쓰지 않는다.
- 구현 승인 이후에도 테스트·pack 결과를 갖춘 상태로 commit/push/PR/release 대상을 제시한다. 이번 계획 작성만으로 npm 게시·DB 운영 환경 변경은 수행하지 않는다.
- Command transaction pooling은 별도 설계로 남긴다. COMMIT 전 drain만 옮기면 deferred trigger 변경을 누락한다. SET CONSTRAINTS 시점 변경, collector ON COMMIT 수명, 커밋 결과 불명까지 다루는 독립 작업이 필요하다.

## 10. 근거

- 현재 Query의 세션 잠금: `packages/sdi-postgres/src/postgres/preamble.ts`, `session.ts`.
- read/validate/command 공유 reservation 및 precision proof: `packages/sdi-postgres/src/postgres/index.ts`.
- 기존 migration advisory protocol: `packages/sdi-postgres/src/postgres/migration.ts`.
- migration 대기 뒤 snapshot 회귀: `tests/server-driven-impact/postgres-release.integration.test.ts`.
- deferred trigger 이후 observation 회수: `tests/server-driven-impact/observer-precision.integration.test.ts`.
- [PostgreSQL LOCK](https://www.postgresql.org/docs/current/sql-lock.html): 트랜잭션 수명, 권한 및 Repeatable Read에서 SELECT 전 잠금 순서.
- [PostgreSQL SET TRANSACTION](https://www.postgresql.org/docs/current/sql-set-transaction.html): snapshot·isolation 의미.
- [PgBouncer features](https://www.pgbouncer.org/features.html): transaction pooling 및 session 기능 제약.
- [Supabase 연결 가이드](https://supabase.com/docs/guides/database/connecting-to-postgres).
- [Supabase prepared statements 안내](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL).
