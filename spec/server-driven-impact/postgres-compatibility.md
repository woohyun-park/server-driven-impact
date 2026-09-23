# PostgreSQL 실행·Impact 호환 계약

적용: PostgreSQL 14~18, postgres.js 3.4.8, pg 8.16.3. Query, Command, catalog validation은 모두 transaction pooling을 지원하는 하나의 실행 모델을 사용한다.

## 공개 실행 모드

| 작업 | API | 보장 |
| --- | --- | --- |
| 관찰 가능한 정적 SELECT | `compilePostgresArtifacts` → `engine.query` | 원문 SQL과 등록된 의존성을 사용한다. 증명하지 못한 비교는 endpoint 전체 impact로 넓힌다. |
| 시간·난수·세션·불투명 함수·custom type/operator | `engine.queryUncached` | 매번 DB에서 실행하고 `cachePolicy:'no-store'`를 반환한다. |
| 로컬 DML·COPY·함수 호출 | `engine.command` | callback, deferred 실행, observation drain, COMMIT을 한 transaction에서 수행한다. 성공한 COMMIT 뒤에는 SQL을 실행하지 않는다. |
| view·함수·RLS·권한·topology 변경 | `migratePostgresQueries` | 협력 요청을 gate로 차단하고 DDL, 재컴파일, observer 교체를 한 transaction으로 수행한다. |

비캐시 SELECT도 읽기 전용 transaction에서 실행한다. DML 결과와 Query 데이터는 선택한 드라이버의 codec과 결과 컨테이너를 유지한다. `compilePostgresQuery`는 저수준 compiler이며, 배포 변경과 catalog 검증까지 묶는 애플리케이션은 `compilePostgresArtifacts` 또는 `migratePostgresQueries`를 사용한다.

## 등록과 연결

```ts
import postgres from 'postgres';
import { createImpact } from '@server-driven-impact/runtime';
import { migratePostgresQueries, postgresAdapter } from '@server-driven-impact/postgres';

const artifact = await migratePostgresQueries(adminDatabase, resources, definitions, {
  version: 18,
  searchPath: ['app', 'public'],
  runtimeRole: 'app_runtime',
  change: async transaction => { /* deployment DDL */ },
});

const database = postgres(process.env.SUPAVISOR_TRANSACTION_URL!, {
  max: 1,
  prepare: false,
});
const engine = createImpact({
  adapter: postgresAdapter({ database, setup }),
  resources: artifact.resources,
  queries: artifact.queries,
});
```

`pg`는 `pgAdapter({database: pool})`, catalog/migration은 `pgDatabase(adminPool)`을 사용한다. Drizzle과 Prisma adapter도 같은 단일 pool을 사용한다. 제거된 `query`, `command`, `connectionMode` 옵션은 `POSTGRES_CONNECTION_OPTIONS_REMOVED`로 거절한다.

postgres.js는 Supavisor/PgBouncer transaction endpoint에서 `prepare:false`가 필요하다. `max:1`은 서버리스 인스턴스 하나가 여는 연결 수 예시이며 요청마다 새 client를 만들라는 뜻이 아니다. SDI는 proxy 종류나 prepare 설정을 런타임에 판별하지 않는다.

## Transaction과 migration gate

Query와 validation은 다음 순서를 따른다.

```text
BEGIN ... READ ONLY
→ LOCK sdi_control.transaction_gate IN ACCESS SHARE MODE
→ setup / work
→ COMMIT
→ 연결 반환
```

Command는 다음 순서를 따른다.

```text
BEGIN
→ query_gate ACCESS SHARE
→ CREATE TEMP collector ON COMMIT DROP
→ request token/scope/phase=collecting 설정
→ setup / callback
→ 새 DB 호출 차단
→ 이미 시작한 raw/ORM/savepoint/cursor/COPY 정리
→ SET CONSTRAINTS ALL IMMEDIATE
→ observation 행을 메모리로 drain
→ phase=sealed
→ COMMIT
→ 연결 반환
→ 메모리 행을 WriteFact/ImpactSet으로 변환
```

`setup`은 transaction 안에서 실행되며 `SET LOCAL ROLE`, `set_config(..., true)`를 사용할 수 있다. 요청 사이 session state, session advisory lock, LISTEN, 임시 객체 존속에 의존하면 안 된다.

`generateObserverMigration()`은 안정된 `sdi_control.transaction_gate`를 설치하고 배타 잠금을 잡으며 runtime role에 접근 권한을 준다. 생성 SQL 전체는 하나의 명시적 migration transaction에서 적용한다. migration helper는 READ COMMITTED transaction에서 기존 migration 직렬화용 `pg_advisory_xact_lock`을 잡은 다음 gate의 ACCESS EXCLUSIVE lock을 잡는다. 둘 다 transaction 종료와 함께 해제되며 별도 unlock SQL이 없다. gate가 없으면 실행은 `POSTGRES_TRANSACTION_GATE_NOT_INITIALIZED`로 실패한다.

## Deferred 계약과 sealed 안전장치

SDI Command는 callback 종료 뒤 `SET CONSTRAINTS ALL IMMEDIATE`를 실행한다. 이 명령이 실패하면 observation을 공개하지 않고 transaction 전체를 rollback한다. 따라서 PostgreSQL의 일반 COMMIT에서는 성공하지만 constraint trigger 사이의 특정 end-of-COMMIT 순서에만 의존하는 transaction은 SDI Command에서 더 일찍 실패할 수 있다.

observer phase는 `collecting → sealed`로 이동하고 request token은 COMMIT까지 유지한다. drain 이후 다시 defer된 constraint trigger가 등록 resource를 쓰려 하면 observer가 `SDI_OBSERVATION_SEALED`를 발생시켜 COMMIT을 중단한다. 늦은 쓰기가 impact에서 빠진 채 커밋되는 경로는 허용하지 않는다.

## 실패 복구

- callback, pending 작업 정리, `SET CONSTRAINTS`, observation drain, seal 중 실패: COMMIT 전 실패이므로 rollback하고 원래 오류를 반환한다.
- COMMIT의 명확한 PostgreSQL 거절: 원래 SQLSTATE 오류를 유지한다.
- COMMIT 전송 뒤 성공 여부를 확인할 수 없음: `CommitStateUnknownError`. impact를 공개하거나 mutation을 자동 재시도하지 않는다.
- 성공한 COMMIT 뒤 메모리 observation 변환 실패: `CommandResult.data`에 커밋된 callback 결과를 보존한다.
- rollback 또는 protocol 정리에 실패한 연결: pg는 `release(true)`로 폐기한다. 안전한 단일 연결 폐기를 확인할 수 없는 postgres.js adapter는 격리되어 후속 요청을 거절한다.

성공한 COMMIT 뒤에는 collector 조회, advisory unlock, backend 종료 SQL을 실행하지 않는다. 연결 반환 오류는 확인된 COMMIT 결과나 원래 업무 오류를 덮어쓰지 않는다.

## 보장의 경계

자동 impact는 SDI Command transaction 안에서 일어난 등록 PostgreSQL resource 변경에 대한 응답이다. 다른 연결·기기의 쓰기를 기존 클라이언트에 전달하는 CDC/pubsub는 포함하지 않는다. FDW, dblink, HTTP, autonomous procedure, two-phase commit, WITH HOLD cursor, 서버 파일/PROGRAM COPY와 분석할 수 없는 외부 효과도 자동 관찰 범위가 아니다.

SQL, setup, 등록 routine은 신뢰된 서버 코드다. SDI는 공개 Command API의 명시적 transaction 제어, 다중 statement, 직접 DDL을 차단하지만 함수 내부의 악의적인 설정 변경을 막는 SQL sandbox는 아니다. schema·권한·observer 변경은 migration 경계를 사용해야 한다.

## 검증

`pnpm test:sdi:matrix`는 PostgreSQL 14~18에서 postgres.js와 pg conformance를 실행한다. `pnpm test:pgbouncer`는 고정된 PgBouncer transaction mode, backend pool 5개, 독립 client 30개로 Query·Command 혼합 부하, transaction 안 backend 고정, role/token/observation 누출 방지를 검증한다. Supavisor 자체 acceptance는 별도 운영 fixture가 필요하다.
