# 저장형 검증(stored validation) 계획

상태: 구현 및 로컬 검증 완료(PG 14~18 matrix, pgbouncer). commit·push·PR·배포 전. 측정 결과는 [벤치마크](../benchmarks/stored-validation-2026-09-28.md)에 있다.


후속 결정 (2026-09-28): 아래 설계에서 "SDI 밖 DDL은 다음 refresh까지 반영되지 않는다"는 공백을 catalog 게이트와 자동 기록으로 닫았다. 스냅샷에 catalog 해시(검증이 의존하는 catalog 행의 `xmin`)와 해시 대상 스키마를 함께 기록하고, 각 프로세스의 첫 Command가 preamble에서 해시를 대조한다. 해시가 다르면 live 검증 후 `sdi_control.record_validation()`(SECURITY DEFINER, 검증 전후 해시가 같을 때만 기록)으로 결과를 기록해 다음 프로세스가 쓰게 한다. 그래서 refresh는 정확성이 아니라 첫 요청의 성능을 위한 선택 사항이 되었다. runtime role이 스냅샷을 기록할 수 있게 된 신뢰 경계 변화와 비용은 [stored validation 가이드](../migrations/stored-validation.md)에 정리했다. 이 문서의 11절에서 채택하지 않았던 event trigger는 여전히 쓰지 않는다.
## 1. 배경과 목표

Supabase Edge Functions는 요청마다 짧게 사는 isolate를 자주 새로 띄운다. 현재 Postgres adapter는 isolate의 첫 Command에서 catalog 전체를 검증하고(`ensureCommandValidated`, `packages/sdi-postgres/src/postgres/index.ts:297`, `:336`), 그 결과를 isolate 메모리에만 보관한다. 따라서 cold start마다 무거운 검증이 사용자 요청 경로에서 반복되고 mutation 응답이 느려진다.

목표:

- Command 경로에서 전체 catalog 검증을 제거하고, cold start에 추가되는 비용을 preamble 안의 PK 조회 한 번으로 줄인다.
- 전체 검증은 migration과 명시적 refresh(owner 권한)에서 실행하고, 결과를 DB에 기록한다.
- 기록이 없으면 현재와 같은 live 검증으로 동작해 회귀를 만들지 않는다.

제외 항목:

- SQLite adapter. 빌드 단계가 없고 in-process로 동작하므로 현재 방식을 유지한다.
- event trigger 등 SDI 밖 DDL의 자동 감지. 11절 참고.
- report 전송량을 줄이는 version 캐시. 측정에서 문제가 드러날 때만 추가한다.
- 소비자 애플리케이션(toktok) 코드와 배포 파이프라인 수정. 운영 계약만 문서화한다.

## 2. 원칙

1. 단순하고 일관된 현재 설계를 택한다. 호환성 분기, 이중 경로, 옵션을 두지 않는다(AGENTS.md).
2. 잘못된 impact를 막는 안전장치는 유지한다. 증명하지 못한 결과를 `verified`로 보고하지 않는다.
3. 검증 문제는 write와 migration을 막지 않고 endpoint assessment로 보고한다. 막는 경우는 관찰 자체가 불가능한 write와 설정 오류로 한정한다.
4. 보장 범위는 "마지막 검증 스냅샷 기준"이다(`packages/sdi-core/src/contracts.ts:41`). 이번 변경은 스냅샷을 만드는 시점과 보관 위치만 바꾼다.
5. 처리 정책은 소비자가 정하고, SDI는 판단 근거(출처, 검증 시각, 원인 코드)를 제공한다.

## 3. 저장 테이블

```sql
create table if not exists sdi_control.validation(
  singleton boolean primary key default true check (singleton),
  fingerprint text not null,
  report jsonb not null,             -- ValidationReport
  equality_resources jsonb not null, -- string[], 정렬됨
  validated_at timestamptz not null
);
```

- `sdi_control`은 transaction gate가 있는 고정 스키마다. fingerprint에 따라 이름이 바뀌는 `sdi_<fp>` 스키마와 달리, 모든 preamble이 이미 이 스키마를 전제로 동작한다.
- 생성 위치: `installPostgresTransactionGate`(JS migration)와 `generateObserverMigration`(정적 SQL). 기존 gate처럼 shape을 검사하고, 다르면 `POSTGRES_TRANSACTION_GATE_CONFLICT`로 실패한다.
- 권한: `runtimeRole`에 `select`만 부여한다. 쓰기는 owner만 한다. runtime role이 쓸 수 있으면 `verified`를 위조할 수 있다.
- singleton이다. 한 DB를 manifest가 다른 앱 여러 개가 공유하면 서로의 기록을 덮어쓴다. 이 제약은 문서에 명시한다.
- 테이블 위치가 fingerprint 밖이므로 `observerProtocol`은 올리지 않는다. 다만 기존 DB에는 테이블이 없으므로 migration을 다시 적용해야 한다.

## 4. 결과를 기록하는 주체

| 경로 | 동작 |
|---|---|
| `migratePostgresQueries`, `migratePostgresArtifacts` | observer 설치 → report 모드 검증 → 모든 DDL 뒤 마지막 statement로 upsert. 검증 문제가 있어도 DDL은 커밋한다. 반환값에 `validation`을 포함한다 |
| `refreshPostgresValidation(database, resources, manifest)` (신규) | migration과 같은 advisory lock(`0x534449, 0x5047`)을 잡고, READ COMMITTED에서 전체 검증 후 upsert한다. gate의 exclusive lock은 잡지 않는다 |
| `generateObserverMigration` (정적 SQL) | 테이블과 권한만 만든다. 행은 기록하지 않는다 |

- migration의 strict 동작(drift가 있으면 throw하고 사용자 DDL까지 롤백)은 옵션 없이 제거한다. CI에서 막으려면 호출자가 반환된 `validation.report`를 확인한다.
- 검증은 savepoint로 감싼다. 검증 쿼리가 실패해도 바깥 트랜잭션이 abort되지 않고, 현재 `runValidation`과 같은 방식으로 모든 endpoint를 `OBSERVER_UNVERIFIED`, `CATALOG_DRIFT`, `VALIDATION_FAILED` 중 하나로 표시한 결과를 기록한다.
- 동시에 실행 중인 Command는 이전 행이나 새 행 중 하나를 읽는다. 어느 쪽이든 그 시점의 스냅샷으로 유효하다.

## 5. 런타임 흐름

### Command

1. `commandPreambleSql` 끝에 조회를 추가한다. fingerprint는 `observerLayout`과 같은 hex 검증을 거친 뒤 literal로 넣는다. postgres.js는 파라미터가 있으면 statement 하나만 보낼 수 있기 때문이다. 이 조회는 `setup` 전에 실행되므로 연결 role의 권한으로 읽는다.

   ```sql
   select report, equality_resources, validated_at
   from sdi_control.validation where fingerprint = '<fp>'
   ```

2. 행이 있으면 저장된 report와 `equalityResources`를 사용한다(`source: 'stored'`).
3. 행이 없으면 live 검증 결과를 사용한다(`source: 'live'`).
   - isolate에 live 결과가 캐시되어 있으면 재사용한다. 현재처럼 명시적 `validate()` 전까지 유지한다.
   - 캐시가 없으면 같은 Command 트랜잭션 안에서, `setup` 전에 검증한다. 별도 연결에서 검증하면 gate shared lock을 쥔 채 다른 트랜잭션을 기다리게 되어, 대기 중인 migration과 교착할 수 있다.
   - 같은 isolate에서 동시에 들어온 Command는 하나의 검증 promise를 공유한다.
4. 이후 과정은 현재와 같다. 검증 결과와 관계없이 write는 커밋하고, assessment로 보고한다.

행을 매 Command마다 읽으므로, isolate가 live 결과를 캐시한 뒤에 refresh가 실행되면 다음 Command부터 저장된 결과로 바뀐다.

### 오류 코드

command와 read preamble의 오류를 다음처럼 변환한다. 현재는 read preamble만 `42P01`을 변환한다(`index.ts:253`).

| SQLSTATE | 코드 | 의미 |
|---|---|---|
| `42P01` | `POSTGRES_CONTROL_NOT_INITIALIZED` | gate 또는 validation 테이블이 없음. migration을 적용하지 않았거나 라이브러리를 먼저 배포함 |
| `42501` | `POSTGRES_CONTROL_ACCESS_DENIED` | runtime role에 `sdi_control` 권한이 없음 |

`POSTGRES_TRANSACTION_GATE_NOT_INITIALIZED`는 `POSTGRES_CONTROL_NOT_INITIALIZED`로 대체한다. gate와 validation 테이블은 항상 함께 설치되므로 코드를 나누지 않는다. 이 두 경우는 설정 오류이므로 명확하게 실패한다. savepoint로 감싸서 live 검증으로 넘기는 방식은 오래된 DB만을 위한 영구 분기이고 권한 누락을 숨기므로 채택하지 않는다.

### `engine.validate()`

다음 Command가 사용할 결과를 반환한다.

```ts
interface ValidationResult {
  report: ValidationReport;
  source: 'stored' | 'live';
  validatedAt: string; // ISO 8601
}
```

- Postgres: 읽기 트랜잭션에서 행을 조회한다. 행이 있으면 부작용 없이 반환하고, 없으면 live 검증을 실행해 isolate 캐시를 갱신한다.
- SQLite: 현재 동작에 `source: 'live'`와 `validatedAt`만 붙인다.
- `ValidationResult`는 `@server-driven-impact/core`에 두고, `BoundAdapter.validate()`의 반환 타입을 바꾼다.

### 제거하는 코드

- `ensureCommandValidated`, `commandValidation`, Command 앞에서 별도 트랜잭션으로 실행하던 `runValidation` 경로.
- migration에서 report 없이 호출하던 strict `validateCatalog`.
- `index.ts:165-243`의 검증 로직은 삭제하지 않고 `postgres/validation.ts`로 옮겨 migration, refresh, live 검증이 공유한다.

## 6. 운영 계약

- **모든 migration 뒤에 `refreshPostgresValidation`을 실행한다.** JS migration은 스스로 기록하므로, 정적 SQL이나 SDI 밖 도구(Supabase Management API, 대시보드)로 DDL을 적용했을 때 필요하다.
- **DB migration을 먼저 적용하고 라이브러리를 배포한다.** 반대 순서면 모든 Command가 `POSTGRES_CONTROL_NOT_INITIALIZED`로 실패한다.
- **preflight에서 `validate()`를 확인한다.** `source === 'stored'`이고 `validatedAt`이 이번 배포 이후인지 확인하면, refresh 누락을 배포 단계에서 잡을 수 있다.
- **Supabase 플랫폼 업그레이드 뒤에도 refresh를 실행한다.** `auth` 스키마 함수처럼 RLS policy가 의존하는 객체가 바뀔 수 있다.

toktok 배포 절차 예시:

1. Management API로 migration을 적용한다.
2. owner(`postgres`) 연결 문자열을 CI secret으로 두고 `refreshPostgresValidation`을 실행한다.
3. `check-sdi-deployment.ts` preflight에서 `validate()`의 `source`와 `validatedAt`을 확인한다.

## 7. 구현 단계

0. **기준 측정.** 현재 첫 Command 지연과 `validate()` 비용을 쿼리별로 측정한다(catalog fingerprint, 테이블별 조회, policy 해석, observer 조회). 로컬 Postgres와 로컬 Supabase에서 측정하고 `docs/benchmarks/`에 기록한다.
1. **검증 모듈 분리.** `postgres/validation.ts`에 `computeValidation(tx, resources, manifest)`와 `verifyObservers`를 만든다. savepoint와 오류 분류를 포함한다.
2. **테이블과 권한.** `installPostgresTransactionGate`와 `generateObserverMigration`에 테이블 생성, shape 검사, `runtimeRole` 권한 부여를 추가한다.
3. **migration.** report 모드로 전환하고 마지막 statement로 upsert한다. 반환 타입에 `validation`을 추가한다.
4. **refresh.** `refreshPostgresValidation`을 구현하고 공개한다.
5. **런타임.** preamble 조회, stored/live 분기, 같은 트랜잭션 안의 live 검증, 오류 코드 변환을 구현하고 기존 경로를 제거한다.
6. **API 타입.** `ValidationResult`를 추가하고 runtime, Postgres, SQLite adapter의 `validate()`를 맞춘다. `src/pg`, `src/drizzle`, `src/prisma`가 같은 경로를 쓰는지 확인한다.
7. **테스트.** 8절을 추가하고 기존 `validate()` 호출(테스트 파일 16개, 약 60곳)을 새 반환 형태에 맞춘다. PG 14~18 matrix와 pgbouncer transaction pooling 테스트로 회귀를 확인한다.
8. **문서와 릴리스.** README(영문, 한국어), `packages/sdi-postgres/README*.md`, `spec/server-driven-impact/semantics.md`, `docs/migrations/`의 새 가이드, `.changeset/pre/`의 breaking changeset을 작성한다. 0단계와 같은 조건으로 다시 측정해 기록한다.

## 8. 테스트

| 시나리오 | 기대 결과 |
|---|---|
| JS migration 후 Command | `stored`, 저장된 report 사용, catalog 조회 없음 (`postgres-round-trips.test.ts`로 쿼리 수 고정) |
| 정적 SQL만 적용 | `live`로 검증, write 커밋 |
| 정적 SQL 적용 후 refresh | `stored` |
| live 결과를 캐시한 isolate에서 refresh 실행 | 다음 Command부터 `stored` |
| 새 migration 이후 이전 artifact로 Command | 행 fingerprint 불일치 → `live` → `OBSERVER_UNVERIFIED` |
| drift가 있는 상태로 migration (예: selector 컬럼의 nondeterministic collation) | DDL 커밋, 저장된 report가 `conservative` |
| 검증 쿼리가 실패하는 migration | savepoint로 복구, DDL 커밋, 저장된 report가 `unavailable` |
| gate가 없는 DB | Command와 Query 모두 `POSTGRES_CONTROL_NOT_INITIALIZED` |
| gate만 있고 validation 테이블이 없는 DB (라이브러리를 먼저 배포) | `POSTGRES_CONTROL_NOT_INITIALIZED` |
| `runtimeRole` 권한 없이 migration한 DB | `POSTGRES_CONTROL_ACCESS_DENIED` |
| runtime role로 validation 테이블에 쓰기 시도 | 권한 오류 |
| 같은 isolate에서 Command 동시 실행 (행 없음) | live 검증 1회, 교착 없음 |
| live 검증 중 migration이 exclusive lock 대기 | 교착 없이 완료 |
| `setup`이 role을 바꾸는 Command | 저장된 결과 조회가 `setup` 전 role로 성공 |
| 저장된 `equalityResources` | literal filter 가지치기가 live 검증과 같은 결과 |
| `validate()` | `source`, `validatedAt` 반환, 행이 있으면 부작용 없음 |
| migration 후 SDI 밖에서 `ENABLE ROW LEVEL SECURITY`, refresh 없음 | 저장된 결과가 계속 쓰임. 알려진 제약으로 테스트에 고정 |
| 위 상태에서 refresh 실행 | 저장된 report가 `CATALOG_DRIFT` |

## 9. 트레이드오프와 알려진 제약

- **SDI 밖 DDL은 다음 refresh까지 반영되지 않는다.** fingerprint는 artifact에서 계산하므로 catalog가 바뀌어도 그대로다. 현재는 cold start마다 이 공백이 초기화되지만, 이 설계에서는 다음 refresh까지 이어진다. 보장이 약해지는 지점이며, 6절의 운영 계약으로 닫는다. 계약 자체(스냅샷 이후 DDL은 감지하지 않음)는 바뀌지 않는다.
- **라이브러리를 먼저 배포하면 모든 Command가 실패한다.** 현재는 같은 상황에서 성능만 떨어진다. 초기 단계이므로 호환 분기를 두지 않고 배포 순서를 문서화한다.
- **migration은 drift로 실패하지 않는다.** CI 차단은 호출자의 책임이 된다.
- **refresh에는 owner 연결이 필요하다.** Management API만 쓰는 파이프라인에는 연결 문자열 secret이 추가된다.
- **refresh를 실행하지 않는 소비자는 현재와 같은 성능과 보장을 유지한다.**

## 10. 구현 전 확인 항목

1. 여러 statement를 합친 `unsafe` 호출에서 마지막 `select` 결과를 꺼낼 수 있는지 postgres.js와 node-postgres(`src/pg`)에서 확인한다. Drizzle과 Prisma 경로도 확인한다. 안 되면 조회를 분리하고 round trip을 1회 늘린다.
2. serializable 격리 수준의 Command 트랜잭션 안에서 catalog를 조회할 때 부작용(직렬화 실패 증가 등)이 없는지 확인한다.
3. Supavisor/pgbouncer transaction pooling에서 preamble 조회가 기존과 같은 연결 수명주기 안에 머무는지 확인한다.

## 11. 검토했으나 채택하지 않은 안

- **artifact(manifest)에 검증 결과를 저장.** 검증 결과는 코드가 아니라 DB 상태에 대한 사실이다. catalog stamp가 없는 artifact는 여러 DB에서 fingerprint가 같아져 다른 DB의 결과를 `verified`로 쓸 수 있고, 배포 없이 재검증할 수 없다.
- **검증 없이 `unverified` 상태로 보고.** 빠르지만 정밀도가 떨어지고 core contract에 상태가 추가된다. 저장형 검증이 같은 비용으로 `verified`를 제공한다.
- **event trigger로 SDI 밖 DDL 자동 무효화.** DB의 모든 DDL에 개입해 SDI의 관심사를 벗어난다. 행 UPDATE 방식은 SDI와 관계없는 migration끼리 대기와 교착을 일으켰고(로컬 Supabase 재현), 로그 INSERT 방식은 커밋 순서, trigger 활성 상태, 소유 role별 사각지대(Supabase는 `postgres`의 DDL에서만 발동) 처리가 새로 필요하다. 또 refresh를 배포 절차에 넣어야 성능 이득이 생기는 점은 event trigger가 있어도 같다. 자동 감지 요구가 실제로 생기면 별도 기능으로 검토한다.
- **테이블이 없을 때 savepoint로 감싸 live 검증으로 fallback.** 오래된 DB만을 위한 영구 분기이고 권한 누락을 숨긴다.
