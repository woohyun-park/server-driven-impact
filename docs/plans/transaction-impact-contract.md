# SDI 트랜잭션 관찰과 ImpactSet 정확성 중심 최종 계획

작성: 2026-09-10. 상태: 1차 수직 구현 완료. native SQL 경로와 CRUD 제거는 검증됐고 ORM 세션 브리지는 후속 단계다.

## 1. 최종 결정

SDI의 책임은 **기존 DB 작업에서 발생한 실제 변경을 관찰하고, 등록된 조회의 영향 범위를 계산해 `{ data, impact }`를 반환하는 것**이다.

- 최우선 산출물은 쓰기 도구와 무관하게 커밋된 변경에 대해 누락 없는 ImpactSet을 만드는 것이다. API 삭제나 기존 코드 무수정 사용을 성공 기준으로 삼지 않는다.
- PostgreSQL의 Statement Trigger + transition table + 세션별 임시 collector 방식을 유지한다. WAL로 전환하지 않는다.
- SQLite의 관리 연결별 TEMP observer를 유지한다. PostgreSQL과 같은 SQL 기능이나 실행 비용을 약속하지 않는다.
- 구조를 transaction 생명주기 연결 → DB 변경 관찰 → 조회 의존성과 결합하는 순수 계산으로 분리한다. observer는 endpoint가 아닌 resource 중심 WriteFact를 반환한다.
- 기존 SQL 또는 ORM으로 업무를 작성하고, SDI 어댑터는 해당 작업의 연결·트랜잭션·관찰 수집 생명주기를 연결한다.
- SDI 고유의 공개 CRUD/쓰기 표현식 API는 대체 경로의 정확성이 검증된 뒤 제거한다. 별도 CRUD 패키지로 유지하지 않는다.
- 트랜잭션 종료, savepoint, 작업 수명 검사는 CRUD와 분리해 보존한다. 이들은 CRUD API를 유지해야만 가능한 기능이 아니다.
- 조회 의존성 등록과 계산은 보존한다. 쓰기 API 제거가 임의 ORM 조회의 자동 의존성 분석을 의미하지 않는다.

우선순위는 **관찰 정확성 → 최종 commit과 결과 회수 → 조회 의존성의 완전성 → 범위·비용 조정 → 쓰기 도구 연동과 API 정리**다. 기능이 이미 이 기준을 만족하면 재작성하지 않고 공통 계약과 회귀 검사로 보존한다.

### 정확성 계약

ImpactSet은 실제 결과 변경을 일일이 확인한 목록이 아니라 **해당 트랜잭션 때문에 결과가 달라질 수 있는 등록 Query와 입력 범위**다.

- 지원 Query를 동일한 입력·권한 문맥으로 변경 전후 실행했을 때 결과가 달라졌다면, 다른 동시 쓰기나 시간 변화 등의 영향을 배제한 비교에서 해당 Query/입력이 ImpactSet에 포함되어야 한다.
- 정확히 좁힐 근거가 부족하면 범위를 넓힌다. 입력 selector를 정밀하게 만드는 것보다 누락 방지가 우선이다.
- 같은 트랜잭션 안에서 변경 후 원래 값으로 돌아온 경우 등 실제 결과가 같아도 과잉 영향은 허용한다. 전체 변경을 재생해 최소 영향만 계산하는 엔진은 만들지 않는다.
- 영향은 등록·검증된 관찰 및 Query 범위에 한정된다. 기록 상한 초과는 넓은 영향으로 표현하고, collector 실패는 오류로 표현한다. 두 경우를 빈 ImpactSet으로 처리하지 않는다.
- 운영 요청에서 Query를 변경 전후 재실행해 영향을 찾지 않는다. 결과 비교는 격리된 검증 fixture에서 정확성 oracle로 사용한다.

### 선택한 방식의 절충

| 결정 | 얻는 것 | 감수하는 비용·한계 |
| --- | --- | --- |
| DB 내부 Statement observer | SQL/ORM 호출 문법과 무관하게 관찰 대상의 Trigger·Cascade·함수 쓰기 수집 | observer 설치, transition table 처리, 임시 기록 비용 |
| COMMIT 후 같은 세션에서 회수 | deferred write와 최종 commit 결과 반영 | 연결 점유 시간 증가, transaction pooling 미지원 |
| 사전 Query 의존성 + 순수 계산 | 요청별 업무 SELECT 없이 영향 계산 | Query 등록·분석 범위 및 배포 시 drift 관리 필요 |
| 불확실하면 넓히기 | 누락 방지와 제한된 기록 크기 | 불필요한 stale/refetch 허용 |
| 영속 재전달 시스템 미도입 | 현재 요청·응답 구조와 운영 단순성 유지 | commit 후 관찰 회수/응답 실패의 복구 보장 없음 |
| 전용 CRUD 제거 | 중복 쓰기 문법 유지 비용 제거 | 공통 CRUD 문법·writeAccess 이전, driver/ORM 호환 검증 필요 |

기존 비교 실험은 Statement 방식이 대량 변경에서 유리하고 WAL이 일부 단건·동시성 구간에서 유리함을 보였다. 모든 환경에서 가장 빠르다는 주장은 하지 않는다. WAL은 다른 연결의 쓰기 관찰·비동기 전달이 실제 요구가 될 때 별도 어댑터로 재평가한다.

## 2. 현재 기준선과 변경 위치

저장소: `/Users/woohyunpark/Desktop/c/server-driven-impact`.
확인한 HEAD: `ae492b9`, 현재 브랜치: `feat/database-correctness-performance`.
현재 패키지 선언 버전: `0.1.1`. HEAD에는 최초 공개 이후 DB 정확성·성능 보완이 있으므로 이를 보존한다.

착수 전 구현:

- `runtime/index.ts`: 어댑터 Command 완료 후 WriteSet으로 ImpactSet을 계산한다.
- `postgres/index.ts`: 연결 예약 → 임시 collector 준비 → BEGIN → 요청 token → callback → COMMIT → 같은 연결에서 collector 회수 → 연결 반환.
- `postgres/observer.ts`: 등록된 테이블에 statement observer를 생성한다. token 없는 다른 요청의 쓰기를 이 Command에 수집하지 않는다.
- `pg/index.ts`: node-postgres를 공통 실행 경로에 연결하지만 원래 PoolClient를 ORM에 연결하는 공개 경로는 없다.
- `runtime/guard.ts`: 일반 객체를 재귀적으로 감싸는 현재 방식은 ORM instance, prototype, lazy query builder에 그대로 적용할 수 없다.
- 공통 CRUD 외에 `db.operations`, `db.postgres`의 CRUD, `db.call` 등 여러 작성 경로가 공개돼 있다.

구현 착수 시 위 HEAD의 보완을 보존한 기준에서 `feat/transaction-impact-contract` 격리 worktree를 만들고 이 계획을 포함한다. 기존 브랜치를 reset/stash하거나 계획 작성 때문에 이동하지 않는다. PR 대상은 `main`이며, 선행 정확성 보완이 미병합이면 의존 관계를 명시한다.

## 3. 사용자에게 보이는 사용법

대표 진입점은 `engine.command(context, callback)` 하나로 유지한다. callback의 DB 도구는 engine에 설정한 어댑터가 결정한다. callback 안에 `db.postgres`, `db.operations`, `db.prisma` 등을 병렬로 늘리지 않는다.

native SQL 경로는 아래 생명주기로 구현됐다. ORM 예시는 동일 물리 세션에 client를 묶는 전용 브리지를 구현한 뒤 제공한다.

```ts
// node-postgres 연동: tx.query는 익숙한 pg 실행 문법을 제공한다.
const result = await engine.command(context, async tx => {
  const saved = await tx.query(
    'update todos set done = $1 where id = $2 returning *',
    [true, todoId],
  );
  return saved.rows[0];
});

// Drizzle 어댑터를 설정한 engine: 업무 함수는 Drizzle query client를 받는다.
const result = await drizzleEngine.command(context, async tx => {
  return todoRepository.complete(tx, todoId);
});

return { data: result.data, impact: result.impact };
```

- DB 도구의 반환 행, rowCount, codec과 오류 코드를 보존한다. 모든 결과를 SDI WriteResult로 변환하지 않는다.
- 기존 업무 함수는 전역 DB client 대신 전달받은 transaction client를 사용하도록 바꿀 수 있어야 한다. 연결 주입 변경까지 없어진다고 약속하지 않는다.
- 같은 pool 또는 같은 DB URL만으로 같은 트랜잭션이 되지 않는다. 지원 어댑터가 고정한 실제 연결에서 실행해야 한다.
- 전역 ORM client를 callback 안에서 호출하는 것만으로 추적되지 않는다. 이를 전역 패치로 가로채지 않는다.
- 트랜잭션을 밖에서 시작한 객체를 임의로 받는 API는 제공하지 않는다. 어댑터가 시작 전 준비부터 최종 commit과 기록 회수까지 연결할 수 있는 연동만 허용한다.
- `savepoint`는 트랜잭션 기능으로 남긴다. ORM의 중첩 transaction API는 동일한 savepoint 의미와 작업 수명이 검증된 경우만 제공한다.

## 4. 제거 범위와 보존 범위

| 대상 | 결정 |
| --- | --- |
| 공통 `CommandDb.select/insert/update/delete`, `Where`, `WriteResult` | 공개 API 제거, native SQL/ORM으로 소비처 이전 |
| `db.operations`, `e` 표현식, `remoteDb`, 업무 operation dispatcher | 공개 API 제거. 실제 소비처가 필요한 동작을 SQL/ORM으로 이전 |
| `db.postgres.select/require/lock/insert/insertSelect/update/delete` | SDI 고유 CRUD wrapper 제거. SQL 또는 DB 도구 사용 |
| `db.call`와 함수 별칭 registry | 지원되는 함수 호출을 매개변수화 SQL로 이전. 기존 권한 제한을 별도 확인 |
| `sql`, identifier/parameter 유틸리티 | 관찰·Query 컴파일에 필요한 내부 코드는 유지. 공개 전용 쓰기 DSL 의존은 이전 가이드와 함께 정리 |
| COPY/stream/cursor/materialized view 작업 | 기존 지원 동작을 보존할 native 실행 경로 제공. CRUD 정리 과정에서 조용히 삭제하지 않음 |
| transaction/savepoint/닫힌 context 보호 | 유지, driver 실행 지점에서 검사 |
| core, WriteFact, ImpactSet, 보수적 범위 확장 | 계약 유지 |
| Query Plan, PostgreSQL Query 컴파일, Resource/observer 설치·검증 | 유지 |
| 인증·RLS setup, COMMIT 오류 분류 | 유지 |

파일을 이름만 보고 지우지 않는다. `tracked-db.ts`와 `managed-db.ts`에 혼재한 실행·stream·savepoint 기능을 먼저 분리한 뒤 불필요해진 CRUD 코드만 제거한다. Query Plan이 사용하는 predicate/compiler 유틸리티도 함께 삭제하지 않는다.

### 쓰기 제한의 명시적 이전

현재 `writeAccess`는 일부 구조화 쓰기 경로에서 실행 전에 테이블/컬럼을 제한하며, native SQL과 함께 사용하지 못하도록 막는다. 이를 native SQL에서도 그대로 보장한다고 주장하지 않는다.

- 새로운 API에서는 `writeAccess`를 폐기한다. 런타임 설정에 남아 있으면 명시적인 migration 오류를 내며 무시하지 않는다.
- 기존 사용자가 의존한 제한은 DB role/GRANT, RLS 또는 앱의 명시적 인가 검사로 이전하도록 문서화한다. 이들은 각각 다른 역할이며 RLS만으로 컬럼 제한이 전부 대체되지는 않는다.
- Resource 등록은 관찰과 Query 의존성 정보다. 등록되지 않은 모든 테이블 쓰기를 막는 보안 장치라고 설명하지 않는다.
- SQL/RPC 실행은 신뢰된 서버 코드의 기능이다. raw SQL에 대한 제한 검사는 권한 시스템 전체를 대체하지 않는다.

## 5. 실행·관찰 생명주기 계약

현재 PostgreSQL 구현은 SDI가 트랜잭션을 소유하는 방식을 기본으로 유지한다. 제품의 필수 조건은 소유자의 이름이 아니라 아래 전체 순서를 책임지는 단일 생명주기다. 향후 ORM이 transaction을 소유해도 공개 확장 지점으로 같은 계약을 충족하면 어댑터 내부 구현으로 허용할 수 있다. 임의 외부 transaction을 중간부터 관찰하는 별도 public API는 추가하지 않는다.

PostgreSQL의 driver/ORM 어댑터를 바꿔도 다음 순서를 지킨다. SQLite는 같은 성공/rollback 의미를 해당 연결과 TEMP observer에 맞춰 검증한다.

1. 물리 연결을 예약하고 observer 수집 공간을 준비한다.
2. 트랜잭션을 시작하고 요청 token 및 앱의 검증된 권한 문맥을 설정한다.
3. 해당 연결에 바인딩된 DB client로 callback을 실행한다.
4. 실행 중인 작업, stream/cursor, 실패 상태를 확인하고 callback client를 닫는다.
5. 실제 COMMIT을 수행한다. 커밋 시 실행되는 deferred trigger의 쓰기도 관찰한다.
6. COMMIT 후 동일한 물리 연결에서 해당 token의 facts를 회수하고 정리한다.
7. 연결을 반환하고 core로 ImpactSet을 계산한다. 수집·계산 성공 후 `{ data, impact }`를 반환한다.

필수 동작:

- 전체 rollback과 savepoint rollback에서 취소된 쓰기는 영향에 포함하지 않는다.
- COMMIT이 DB에 의해 거절된 경우, commit 여부를 알 수 없는 경우, commit은 성공했지만 impact 회수가 실패한 경우를 구분한다.
- impact 회수 실패를 일반 저장 실패처럼 재시도하지 않는다. 기존 `CommitStateUnknownError`/`ImpactUnavailableError` 의미를 보존한다.
- public client가 임의 `COMMIT/ROLLBACK`, 연결 반환/종료, observer 해제·token 변경으로 관찰 생명주기를 바꾸지 못하도록 지원 경로를 제한하고 검증한다. 신뢰된 함수 내부의 모든 동작을 정적 분석한다고 약속하지 않는다.
- ORM 전체 객체를 재귀 복사하지 않는다. 실제 driver query 실행 시점을 감싸서 인자·결과·this·prototype·lazy 실행 의미를 보존한다.
- 아직 실행하지 않은 lazy query 생성은 실행된 쓰기로 간주하지 않는다. Command 종료 후 실행하려 하면 거절한다. 이미 시작한 미완료 쿼리는 commit 전에 탐지한다.
- native savepoint/중첩 transaction은 검증한 기능만 제공한다. 중첩 BEGIN이나 별도 pool 획득으로 조용히 다른 transaction을 만들지 않는다.
- transaction pooling은 계속 미지원이다. 같은 연결을 COMMIT 이후까지 유지해야 하는 현재 계약을 바꾸지 않는다.
- HTTP 전달 형식과 클라이언트 재조회는 앱이 책임진다. collector 회수까지 성공했어도 HTTP 응답이 유실될 수 있으며, 이를 복구하려고 영속 receipt나 자동 Command 재전송을 추가하지 않는다.

## 6. 연동 지원 순서

### 첫 전환의 필수 지원

1. node-postgres: SDI가 예약한 PoolClient에 묶인 실행 client. SQL 결과·parameter·SQLSTATE와 stream 정리를 보존한다.
2. postgres.js: SDI가 예약한 session에 묶인 실행 client. tagged template/lazy 실행·codec·cursor/COPY 지원 범위를 검증한다.
3. SQLite: 관리되는 `DatabaseSync` 연결의 native statement 실행. 준비된 statement의 종료 후 사용과 callback 중 비동기 간섭까지 검사한다. 전체 DatabaseSync API를 지원한다고 선언하지 않는다.
4. Drizzle + node-postgres: 동일 연결의 driver client에 Drizzle을 연결한다. 기존 repository가 transaction client를 인자로 받아 CRUD·JOIN·RETURNING을 실행하는 실제 예제를 필수로 만든다.

Drizzle은 PostgreSQL 어댑터의 별도 선택 subpath로 제공하는 것을 기본으로 한다. ORM은 선택 peer로 두고 core/runtime 및 SQLite 전용 설치에 유입시키지 않는다. 새 top-level 패키지를 먼저 늘리지 않는다. 정확한 버전과 subpath 이름은 단계 D에서 실제 실행한 조합으로 고정한다. Drizzle + postgres.js/SQLite는 첫 Drizzle 지원을 검증한 뒤 확대하며 미검증 조합을 함께 지원한다고 표시하지 않는다.

### Prisma: 삭제 전에 수행할 필수 가능성 검증

Prisma 지원 여부는 Trigger가 UPDATE를 볼 수 있느냐가 아니라, SDI가 해당 transaction에 수집 문맥을 연결하고 **최종 COMMIT 후에도 같은 연결에서 결과를 회수할 수 있느냐**로 판정한다.

- 검증할 Prisma 버전과 PostgreSQL driver adapter를 명시적으로 고정한다. 이전 대화의 특정 버전에 대한 추측을 구현 근거로 사용하지 않는다.
- 공개 driver/transaction 확장 지점으로 연결 고정, 수집 준비, commit 이후 drain을 구현할 수 있는지 최소 예제로 확인한다.
- SDI가 연결을 소유하는 방식 또는 Prisma driver adapter의 transaction 생명주기에 관찰을 결합하는 방식을 비교한다. 기본 Command API를 두 종류로 늘리지 않는다.
- 단순 `$transaction` callback 안에서 facts를 먼저 읽는 방법은 완료 기준을 만족하지 않는다. 최종 COMMIT 때 deferred write 또는 commit 실패가 발생할 수 있기 때문이다.
- Prisma 내부 비공개 객체 접근, 전역 monkey patch, 임시 데이터를 영속 추적 테이블에 남기는 우회는 첫 전환에 사용하지 않는다.
- 조건을 충족하면 검증된 버전의 선택 연동으로 구현한다. 불가능하면 정확히 부족한 공개 API와 재현 결과를 문서화하고 해당 버전은 미지원으로 남긴다. 이를 CRUD 유지 이유로 되돌리지 않는다.

Prisma 가능성 검증은 계획의 필수 산출물이다. Prisma 전체 버전 지원이나 미확인 연동 성공은 첫 릴리스의 약속이 아니다.

공식 자료: [Drizzle PostgreSQL 연결](https://orm.drizzle.team/docs/get-started-postgresql), [Drizzle transaction](https://orm.drizzle.team/docs/transactions), [Prisma transaction](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions), [Prisma PostgreSQL](https://www.prisma.io/docs/orm/core-concepts/supported-databases/postgresql). Prisma 링크는 버전별 API가 다르므로 구현 시 선택한 버전 문서·타입·테스트와 대조한다.

## 7. Query 측 경계

ORM 쓰기 연동이 완료돼도 Query 결과 의존성을 모르면 ImpactSet을 계산할 수 없다.

- 기존 Query Plan과 PostgreSQL SQL 분석/manifest 생성 경로를 사용하고, 정확성 계약에 필요한 누락을 검증·보완한다.
- SELECT 결과 컬럼뿐 아니라 WHERE/ORDER/JOIN, 집계, LIMIT/OFFSET으로 인한 목록 소속 변화, 지원되는 view·함수·RLS 의존성을 점검한다. 이미 지원하는 분석 기능을 중복 구현하지 않는다.
- 분석할 수 없는 의존성의 후보 resource를 모두 알면 그 범위로 넓힌다. 읽는 resource 자체를 알 수 없다면 endpoint 전체 selector만으로 충분하다고 간주하지 않는다. cacheable 등록을 거절하거나 명시적 no-store 경로를 요구한다.
- 다른 테이블을 읽는 RLS policy도 결과 의존성이다. 관찰 resource와 Query manifest 양쪽에서 빠지지 않는지 권한 문맥을 고정한 실제 DB fixture로 검증한다. scope 값 자체를 인증·인가로 취급하지 않는다.
- 최초 설치 및 Query/schema/policy/function 변경 배포 후 명시적으로 artifact를 재생성·설치·검증한다. observer가 없는 새 테이블이나 오래된 manifest를 성공한 검증으로 취급하지 않는다. 요청마다 전체 catalog를 조회하지 않는 대신 검증 이후 외부 DDL은 배포 정책으로 통제한다.
- 첫 전환에서 임의 Prisma/Drizzle 조회 코드를 자동 분석하거나, 조회할 때마다 동적 의존성을 등록하는 시스템을 만들지 않는다.
- Drizzle 예제는 기존 방식으로 등록한 Query와 ORM으로 실행한 Command를 결합해 검증한다.
- 설명은 “기존 쓰기 문법 유지”로 한정한다. “앱의 모든 DB 코드를 수정 없이 사용”으로 확대하지 않는다.
- 지원되지 않는 JOIN/조건, 상한 초과, 알 수 없는 값은 현재 보수적 범위 확장 계약을 유지한다.

## 8. 구현 단계와 통과 기준

### A. 정확성 계약과 기준선 확정

- 현재 HEAD의 실제 지원 범위, observer·Query 의존성 처리, commit 오류, 성능 기록을 기준선으로 남긴다.
- 지원 Query의 결과 변경 → ImpactSet 포함을 판정하는 격리 fixture를 정리한다. 기존 테스트를 재사용하고 부족한 의미 사례만 보강한다.
- 현재 native SQL 경로와 CRUD 소비처를 목록화한다. 알려진 Routine 소비 형태는 읽기 전용으로 확인한다.
- 통과 기준: 보장하는 범위와 불확실성 처리, 미지원 거절, 오류 의미가 명세·테스트에서 일치한다. 이미 발견한 정확성 결함이 있으면 API 확장보다 먼저 해결한다.

### B. 관찰 생명주기와 driver 실행 분리

- observer 설치·수집·회수·오류 처리를 CRUD에서 독립시킨다.
- 관찰 facts의 정본을 DB observer로 통일한다. CRUD와 native 경로가 같은 변경을 중복 수집하거나 다른 사실로 표현하지 않도록 한다.
- 실제 변경 행 0건, Trigger/Cascade/함수 쓰기, deferred write, 전체/savepoint rollback, commit 결과 불명 및 drain 실패를 검증한다.
- 상한 초과 시 영향을 받은 resource와 확보 가능한 scope를 보존해 넓힌다. 큰 transition relation 처리 비용까지 상수라고 주장하지 않는다.
- 통과 기준: callback 작성 방식과 무관하게 성공한 transaction의 관찰 사실이 같고, 실패·다른 요청의 기록이 섞이지 않는다. 연결 ID 검사로 쓰기/commit/drain이 같은 세션임을 증명한다.

### C. Query 의존성과 영향 계산 검증

- SELECT/WHERE/ORDER/JOIN/집계/페이지 범위와 지원되는 view·RLS 의존성을 결과 비교로 확인한다.
- 정밀 selector, endpoint 전체 확장, cacheable 등록 거절의 경계를 명시한다. 불확실성을 정밀한 결과로 가장하지 않는다.
- explain은 실제 계산 경로에서 제외·포함·확장 이유를 수집한다. 별도 판정 엔진을 만들지 않는다.
- 통과 기준: 전후 결과가 달라진 모든 지원 Query/입력이 포함되고, 과잉 영향에는 이유가 있다. 운영 영향 계산을 위한 추가 업무 SELECT가 없다.

### D. Native 실행과 ORM 연동

- node-postgres·postgres.js·SQLite native 실행 client와 실행 지점의 수명 검사를 구현한다. driver별 반환값·codec·stream·lazy 실행을 보존한다.
- `pg` bridge가 숨긴 실제 연결을 어댑터 내부에서 재사용할 수 있도록 변경한다. 외부에 무제한 PoolClient를 반환하지 않는다.
- Drizzle adapter와 transaction client를 인자로 받는 repository 예제를 완성한다.
- Prisma 가능성 실험을 수행한다. 조건을 만족하면 같은 conformance로 구현하고, 불가능하면 재현 결과와 부족한 공개 API를 문서화한다.
- 예제는 단일 UPDATE를 넘어 여러 업무 함수, 기존 transaction 경계, Trigger/Cascade, savepoint 취소, commit 후 영향 반환을 포함한다.
- 통과 기준: 같은 시작 상태와 논리적 쓰기·권한 문맥에서 native SQL과 ORM의 DB 결과 및 ImpactSet 의미가 일치한다. ORM이 추가 SQL/다른 순서로 쓰는 경우 차이를 설명하며 무조건 byte 단위 일치를 요구하지 않는다.

### E. CRUD 제거와 소비처 이전

- 공통 CRUD, operations/표현식 API, 전용 CRUD wrapper 및 불필요한 dispatcher를 제거한다.
- 예제·tests·벤치마크·pack 검사 코드를 native SQL/검증된 ORM 연동으로 이전한다.
- `writeAccess`/함수 registry 사용자의 권한 이전과 API 매핑을 문서화한다.
- Query 유틸리티와 필요한 실행 기능이 함께 삭제되지 않았는지 확인한다.
- 통과 기준: 공개 타입과 README 대표 예제에 SDI 고유 CRUD/operations가 없고, 내장 어댑터마다 실행 가능한 대체 경로가 있다.

### F. 비용 확인·회귀 검증·패키징·이전 문서

- 같은 업무 fixture의 관찰 없는 native 기준선, 기존 SDI, 변경 후 SDI를 비교한다. ORM 자체 비용과 관찰 비용을 구분한다.
- 연결 점유 시간과 동시성, facts/ImpactSet 크기, collector 처리와 계산 시간을 함께 본다. 무조건 작은 응답을 만들기 위해 영향을 누락하지 않는다.
- 관찰 비용이 허용하기 어려운 사례는 문서화하고 원인을 개선한다. 성능이 불리하다는 이유만으로 변경 감지를 끄거나 정확성을 낮추지 않는다.
- 아래 검증을 완료하고 EN/KO README, package README, 지원 matrix, migration guide, Changeset을 함께 갱신한다.
- 0.x의 호환성 파괴 변경으로 다음 minor 릴리스(현재 기준 후보 `0.2.0`)를 준비한다. 실제 버전 작업 시 기존 릴리스와 충돌 여부를 확인한다.
- fixed group과 peer 범위를 함께 조정하고, 호환되지 않는 0.1 runtime/새 adapter 조합이 설치 가능한 것으로 선언되지 않게 한다.
- 기존 npm 버전은 유지한다. 소스에서 이름만 바꾸는 것과 runtime 의미가 달라지는 것을 migration guide에서 구분한다.
- Routine은 별도 저장소이므로 이 계획으로 즉시 변경·배포하지 않는다. 영향을 받는 호출 유형과 로컬 전환 절차를 인계 자료로 제공한다.

## 9. 검증 기준

핵심 불변식은 1절의 결과 변경 → 영향 포함 계약이다. 동시 요청·시간·권한 변화가 테스트 결과를 혼동시키지 않도록 fixture와 조회 문맥을 고정한다.

필수 실제 DB 사례:

- INSERT/UPDATE/DELETE, 0행, 동일값 UPDATE, UPSERT, old/new 날짜·tenant·PK, 큰 배치의 보수적 상한.
- 빈 조회에 첫 행 삽입, 필터 진입·이탈, 정렬/페이지 경계 변화, JOIN 상대 행 및 지원되는 view·RLS 참조 테이블 변경.
- 업무 Trigger, native FK Cascade, SQL 함수의 쓰기, deferred trigger, commit 시 제약 실패.
- 전체 rollback, savepoint rollback, child context 종료, 동시 요청의 token·facts 격리.
- commit 직후 drain 실패, commit 응답 유실, 고장난 연결 폐기와 다음 요청의 collector 오염 없음.
- driver/ORM의 parameter binding, null/숫자/날짜/JSON codec, RETURNING·rowCount·SQLSTATE 보존.
- await하지 않은 실행, 닫힌 client 재사용, lazy query의 늦은 실행, callback 안의 잘못된 transaction 제어, stream/cursor 조기 종료.
- 설정한 RLS/role의 유지. 종전 writeAccess 제거를 무시하는 설정 경로가 없음.
- 별도 global client/연결의 쓰기가 현재 Command의 impact에 포함되지 않는 음성 사례. 앱 전체의 우회를 자동으로 차단한다고 주장하지 않음.

완료 검사:

- 개발 중에는 해당 core/driver/ORM 테스트만 실행한다.
- `pnpm typecheck`, `pnpm test`, `pnpm test:postgres`, `pnpm pack:check`.
- PostgreSQL 14–18 × postgres.js/pg 기존 matrix. Drizzle은 대표 버전에서 먼저 검증하고, 광고할 PostgreSQL 범위 전체에 conformance를 적용한다.
- Node 22.18/24 독립 tarball 소비. core/runtime 단독, SQLite 단독, pg 단독, postgres.js 단독, 선택 ORM 설치를 확인한다.
- ORM peer 미설치 시 무관한 subpath import가 실패하지 않음. public 타입에 비공개 SDI CRUD 또는 다른 driver 타입이 새어 나오지 않음.
- 같은 native SQL/fixture를 기준으로 전후 adapter 비용 비교: 1/1,000/10,000행, p50/p95, SQL 왕복, facts/impact bytes, 단건 동시성. ORM 자체 비용과 관찰 추가 비용을 구분한다.
- 기존 벤치마크 결과를 새 변경 통과 근거로 재사용하지 않는다. 추적 비용 0 또는 성능 개선을 미리 약속하지 않는다.

## 10. 제외 범위와 완료 산출물

이번 전환은 새 DB 종류, WAL/CDC, 외부 writer의 자동 전파, realtime/outbox, ORM 전체 조회 자동 분석, transaction pooling 지원을 포함하지 않는다.

완료 산출물은 transaction 관찰 계약과 실제 DB 검증 자료, 조회 의존성·ImpactSet 계산의 정확성 및 explain, native driver 실행 경로, 검증된 Drizzle 연동, Prisma 가능성 판정(가능하면 구현 포함), CRUD 정리가 반영된 API·예제, 비용 비교, 이전 가이드와 릴리스 준비 자료다.

최종 완료 판단은 **지원되는 transaction의 실제 변경을 누락하지 않고 수집하며, 그 변경으로 결과가 달라질 수 있는 등록 Query를 누락 없이 ImpactSet으로 반환하는가**다. CRUD 삭제 건수와 지원 ORM 개수로 완료를 판정하지 않는다.

현재 요청의 권한은 계획 작성·수정이다. 이 문서만 변경하며 구현·commit·push·PR·npm publish·원격 DB 변경은 수행하지 않는다. 구현 요청이 오면 A부터 시작하고, 미검증 ORM API를 실제 지원처럼 먼저 문서화하지 않는다.
