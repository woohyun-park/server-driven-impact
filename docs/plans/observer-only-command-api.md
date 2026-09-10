# SDI mutation effect 자동 수집·정밀 영향 분석·프론트 반환 최종 계획

작성: 2026-09-10. 상태: A–F 로컬 구현·검증·0.4.0 릴리스 준비 완료. 후속 “릴리즈 진행” 요청으로 commit·push·PR·main 반영·npm publish가 승인됐다.

## 0. 실행 요약

이번 작업의 단위는 mutation 실행부터 프론트엔드가 사용할 영향 응답까지의 전체 경로다. WriteSet 수집 자동화·완전성, 영향 분석 자동화·완전성·정밀도를 함께 완료 기준으로 삼는다.

| 순서 | 산출물 | 다음 단계로 넘어가는 조건 |
| --- | --- | --- |
| A | 현재 동작·자동화 경계·정확성 및 정밀도 fixture 기준선 | 수집 누락, 영향 누락, 불필요한 영향 포함을 각각 판정할 수 있음 |
| B | CRUD와 독립된 WriteSet 자동 수집 및 transaction 생명주기 | 직접·간접 커밋 변경 포함, 취소된 변경 제외, commit/drain 실패 구분 |
| C | 자동 의존성 도출과 안전한 ImpactSet 범위 축소 | 영향 누락 0건, 정밀도 fixture의 기대 범위 충족, 확장 이유 설명 |
| D | native driver 및 Drizzle 실행 경로, Prisma 가능성 판정 | 같은 연결·생명주기 보장과 driver/ORM 의미 보존을 실제 DB로 검증 |
| E | mutation 응답·프론트 소비 예제, 기존 CRUD 소비처 이전 및 API 제거 | 수동 WriteFact/무효화 목록 없이 전체 흐름이 동작하고 대체 경로가 검증됨 |
| F | 성능·호환성 검증, 문서·migration·Changeset | 아래 전체 완료 검사 통과 및 남은 지원 한계 명시 |

A → B → C → D → E → F 순서로 진행한다. Prisma 가능성 실험은 A에서 제약을 목록화하고 D에서 판정을 완료한다. E의 삭제는 B·C·D 통과 이후에만 수행한다. 구현 중 발견한 수집·영향 누락은 다음 API 확장보다 먼저 해결한다.

사용자의 “계획대로 진행” 요청으로 구현이 승인됐고, 후속 “릴리즈 진행” 요청으로 검증된 0.4.0 변경의 commit·push·PR·main 반영·npm publish까지 승인됐다.

완료 증거: [구현·검증 기록](../research/transaction-impact-0.4-verification.md). 타입 검사와 일반 테스트 120개, PostgreSQL 14–18 × 두 드라이버의 조합당 64개 검사(총 640개, skip 0), Node 22.18·24.21·25.8의 동일 0.4.0 tarball 소비 검사를 통과했다. native/ORM·observer·core 비용은 각 벤치마크 문서에 기록했다.

## 1. 최종 결정

SDI의 책임은 **기존 DB 작업에서 발생한 실제 변경을 관찰하고, 등록된 조회의 영향 범위를 계산해 `{ data, impact }`를 반환하는 것**이다.

### 라이브러리의 궁극적인 목표

**mutation 함수가 DB에 일으킨 실제 변경(effect)을 SDI가 WriteSet으로 최대한 자동으로 누락 없이 수집하고, 조회 의존성과 결합해 영향받는 조회·입력 범위를 자동 분석한 뒤, 누락 없이 안전하게 증명할 수 있는 가장 좁은 ImpactSet을 mutation 결과와 함께 프론트엔드에 반환하는 것이 궁극적인 목표다.**

전체 흐름은 `mutation 실행 → 실제 DB effect의 WriteSet 자동 수집 → 조회 의존성과 결합한 영향 분석·범위 축소 → { data, impact }를 프론트엔드에 반환`이다. 개발자가 mutation마다 변경 사실이나 영향받는 조회 목록을 수동으로 작성하지 않아도 이 흐름이 연결돼야 한다.

- 쓰기 수집 자동화: mutation이 직접 실행한 SQL/ORM 쓰기뿐 아니라 호출한 업무 함수·DB 함수, Trigger·Cascade 및 최종 COMMIT의 deferred write로 발생한 간접 변경도 지원·검증된 관찰 범위에서 자동 수집한다. 실행 의도나 반환 행만으로 WriteSet을 추정하지 않고 실제 DB 변경을 기준으로 삼으며, rollback으로 취소된 쓰기는 제외한다. 수집 범위와 미지원 경계를 명시하고 넓혀 나간다.
- 영향 분석 자동화: 지원되는 Query 정의·SQL 및 DB 메타데이터에서 읽기 의존성을 최대한 자동으로 도출하고, 수집된 WriteSet과 결합해 ImpactSet을 계산한다. 수동 의존성 보완이 필요한 경계는 명시하고 줄여 나간다. Resource/Query 등록 자체가 없어지거나 임의 ORM 조회를 이미 자동 분석한다는 뜻은 아니다.
- 완전성: 지원·검증된 범위에서 결과가 바뀌는 Query/입력을 빠뜨리지 않는다. 분석 불가능한 의존성을 조용히 생략하지 않는다.
- 정밀도: 완전성을 유지하면서 관련 endpoint, scope, 입력 selector를 가능한 한 좁힌다. 이미 확보한 의존성·조건·OLD/NEW 값으로 제외하거나 좁힐 수 있는 범위를 불필요하게 넓히지 않는다.
- 프론트엔드 반환: SDI는 수집과 분석을 완료한 `{ data, impact }`를 제공하고, 앱은 이를 mutation 응답으로 프론트엔드에 전달한다. HTTP 전송 및 프론트엔드의 캐시 무효화·재조회 정책은 앱이 담당한다.

보수적 확장은 불확실할 때 정확성을 지키는 fallback이다. 전체 영향 반환만으로 목표를 달성했다고 보지 않는다. 자동 분석의 지원 범위와 안전한 범위 축소를 함께 개선하되, 운영 요청에서 모든 Query를 재실행해 수학적으로 최소인 영향 집합을 구하는 것은 요구하지 않는다.

### 구현 방향

- 최우선 산출물은 쓰기 도구와 무관하게 mutation의 커밋된 직접·간접 변경을 WriteSet으로 자동 수집하고, 누락 없는 ImpactSet을 자동 계산해 안전하게 가능한 만큼 범위를 좁힌 뒤 mutation 응답으로 전달할 수 있게 하는 것이다. API 삭제나 기존 코드 무수정 사용을 성공 기준으로 삼지 않는다.
- PostgreSQL의 Statement Trigger + transition table + 세션별 임시 collector 방식을 유지한다. WAL로 전환하지 않는다.
- SQLite의 관리 연결별 TEMP observer를 유지한다. PostgreSQL과 같은 SQL 기능이나 실행 비용을 약속하지 않는다.
- 구조를 transaction 생명주기 연결 → DB 변경 관찰 → 조회 의존성과 결합하는 순수 계산으로 분리한다. observer는 endpoint가 아닌 resource 중심 WriteFact를 반환한다.
- 기존 SQL 또는 ORM으로 업무를 작성하고, SDI 어댑터는 해당 작업의 연결·트랜잭션·관찰 수집 생명주기를 연결한다.
- SDI 고유의 공개 CRUD/쓰기 표현식 API는 대체 경로의 정확성이 검증된 뒤 제거한다. 별도 CRUD 패키지로 유지하지 않는다.
- 트랜잭션 종료, savepoint, 작업 수명 검사는 CRUD와 분리해 보존한다. 이들은 CRUD API를 유지해야만 가능한 기능이 아니다.
- 조회 의존성 등록과 계산은 보존한다. 쓰기 API 제거가 임의 ORM 조회의 자동 의존성 분석을 의미하지 않는다.

우선순위는 **관찰 정확성 → 최종 commit과 결과 회수 → 조회 의존성의 완전성과 자동 도출 → 누락 없는 영향 범위 최소화 → 비용 조정 → 쓰기 도구 연동과 API 정리**다. 기능이 이미 이 기준을 만족하면 재작성하지 않고 공통 계약과 회귀 검사로 보존한다.

### 정확성 계약

WriteSet은 mutation이 관찰 대상 DB에 일으켜 최종 커밋된 변경 사실을 담는다. 지원되는 직접·간접 변경이 수동 WriteFact 작성 없이 수집돼야 하며, 기록 상한 때문에 상세 사실을 유지하지 못하면 해당 변경을 포괄하는 보수적 사실로 표현한다. 수집 실패나 미지원 관찰 경계를 변경 없음으로 처리하지 않는다.

ImpactSet은 실제 결과 변경을 일일이 확인한 목록이 아니라 **해당 트랜잭션 때문에 결과가 달라질 수 있는 등록 Query와 입력 범위**다.

- 지원 Query를 동일한 입력·권한 문맥으로 변경 전후 실행했을 때 결과가 달라졌다면, 다른 동시 쓰기나 시간 변화 등의 영향을 배제한 비교에서 해당 Query/입력이 ImpactSet에 포함되어야 한다.
- 정확히 좁힐 근거가 부족하면 범위를 넓힌다. 입력 selector를 정밀하게 만드는 것보다 누락 방지가 우선이다.
- 안전하게 좁힐 근거가 있는 경우에는 이를 실제 계산에 사용한다. 누락 없는 포함 검사와 함께, 관련 없는 endpoint·scope·입력을 제외하는 정밀도 회귀 사례를 둔다.
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

계획 당시 원본 폴더는 `/Users/woohyunpark/Desktop/c/server-driven-impact`, 브랜치는 `feat/database-correctness-performance`, HEAD는 `ae492b9`였다. 구현 착수 때 최신 로컬 main에 observer-only Command와 native driver 결과 보존이 이미 병합된 것을 확인했다.

- 실제 기준선: `main`의 `c24e226` (공개 패키지 0.3.0).
- 작업 브랜치: `feat/transaction-impact-contract`.
- 격리 worktree: `/Users/woohyunpark/Desktop/c/.worktrees/server-driven-impact-contract`.
- PR 대상: `main`. 선행 보완은 기준선에 포함돼 있다. 원본 폴더 및 기존 main worktree는 변경하지 않았다.
- 다음 릴리스 준비 버전: 0.4.0. 기존 npm 버전은 변경하거나 재발행하지 않는다.

현재 변경 지점:

- `sdi-core/src/write-set.ts`, `calculate.ts`: resource별 요약, 공통 조건 보존, endpoint별 byte 확장, core command의 commit 이후 계산.
- `sdi-postgres/src/postgres/observer.ts`: batch 공통 scope/binding 요약 및 resource별 collector 확장. observer protocol 9로 설치·검증 구분.
- `sdi-runtime/src/query/plan.ts`, PostgreSQL compiler/catalog: 사용하지 않는 count 의존성 제외, catalog 증거가 있는 SQL 읽기 컬럼 자동 도출, 인증된 literal equality 필터의 OLD/NEW별 제외, 숨은 RLS 컬럼·입력·scope 의존성 검증.
- `sdi-postgres/src/pg`, `drizzle`, `prisma`, native command client: 고정 연결에서 실제 driver 실행·savepoint·lazy 수명 보존. 미사용 전용 CRUD 내부 코드 제거.
- `sdi-sqlite/src/sqlite/index.ts`, runtime guard: 동기 prepared statement 수명, 공유 관리 연결의 observer 전환, collector 접근 차단 및 resource별 확장.
- `examples/orders-impact`, `docs/research`, `docs/migrations`: 프론트 selector 소비, ORM 업무 함수, 자동화·권한·지원 경계 및 Routine 인계.

## 3. 사용자에게 보이는 사용법

대표 진입점은 `engine.command(context, callback)` 하나로 유지한다. callback의 DB 도구는 engine에 설정한 어댑터가 결정한다. callback 안에 `db.postgres`, `db.operations`, `db.prisma` 등을 병렬로 늘리지 않는다.

다음은 구현된 API의 사용 형태다. 실제 실행 가능한 repository와 응답 소비 예제는 `examples/orders-impact` 및 conformance tests에 있다.

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
- fixture별로 기대 DB effect, 자동 수집되는 WriteSet, 도출된 의존성, 기대 ImpactSet 범위와 허용되는 확장 이유를 연결한다. 현재 결과를 무조건 정답으로 고정하지 않는다.
- 지원 matrix에 `자동 도출 / 명시적 보완 / 보수적 확장 / 등록 거절 또는 no-store`를 구분한다. PostgreSQL과 SQLite의 차이, 다른 연결·미등록 resource·권한 문맥 경계를 함께 기록한다.
- 현재 native SQL 경로와 CRUD 소비처를 목록화한다. 알려진 Routine 소비 형태는 읽기 전용으로 확인한다.
- 통과 기준: 보장하는 범위와 불확실성 처리, 미지원 거절, 오류 의미가 명세·테스트에서 일치한다. 이미 발견한 정확성 결함이 있으면 API 확장보다 먼저 해결한다.

### B. 관찰 생명주기와 driver 실행 분리

- observer 설치·수집·회수·오류 처리를 CRUD에서 독립시킨다.
- 관찰 facts의 정본을 DB observer로 통일한다. CRUD와 native 경로가 같은 변경을 중복 수집하거나 다른 사실로 표현하지 않도록 한다.
- 실제 변경 행 0건, Trigger/Cascade/함수 쓰기, deferred write, 전체/savepoint rollback, commit 결과 불명 및 drain 실패를 검증한다.
- 여러 업무 함수를 호출하는 mutation fixture에서 직접·간접 DB 변경의 기대 사실을 WriteSet과 대조한다. 수동 WriteFact 보고 없이 수집되는지, 취소된 변경이 제외되는지, 상세 기록 상한에서도 변경의 영향이 보존되는지 검사한다.
- 상한 초과 시 영향을 받은 resource와 확보 가능한 scope를 보존해 넓힌다. 큰 transition relation 처리 비용까지 상수라고 주장하지 않는다.
- collector와 메모리 WriteSet의 상한 처리를 함께 점검한다. bounded resource별 요약으로 보존 가능한 정보부터 유지하고, 정보가 부족할 때만 단계적으로 넓힌다. 수집 오류는 요약 성공으로 위장하지 않는다.
- 통과 기준: callback 작성 방식과 무관하게 성공한 transaction의 관찰 사실이 같고, 실패·다른 요청의 기록이 섞이지 않는다. 연결 ID 검사로 쓰기/commit/drain이 같은 세션임을 증명한다.

### C. Query 의존성과 영향 계산 검증

- SELECT/WHERE/ORDER/JOIN/집계/페이지 범위와 지원되는 view·RLS 의존성을 결과 비교로 확인한다.
- 지원 Query 정의·SQL에서 자동 도출되는 의존성과 수동 보완이 필요한 경계를 목록화한다. 쓰기별 수동 invalidation 매핑 없이 관찰 facts와 도출된 의존성으로 영향을 계산하는지 검증한다.
- 정밀 selector, endpoint 전체 확장, cacheable 등록 거절의 경계를 명시한다. 불확실성을 정밀한 결과로 가장하지 않는다.
- OLD/NEW 값, 변경 컬럼, 조건과 입력 매핑, scope를 이용해 안전하게 좁힐 수 있는 대표 fixture의 기대 범위를 명시한다. 결과가 바뀐 입력의 포함뿐 아니라 무관하다고 증명 가능한 endpoint·scope·입력의 제외도 검사한다.
- 범위 축소 순서는 무관 resource/endpoint 제외 → 무관 변경 컬럼·scope 제외 → OLD/NEW 입력 binding → DB 비교 의미를 검증한 조건·JOIN·합성 Query의 추가 축소 → resource/endpoint별 상한 처리다. 조건·JOIN·집계·페이지 경계를 메모리 정보만으로 판단할 수 없는 경우 필요한 범위로 넓힌다.
- manifest나 selector의 표현 확장이 필요한 경우 먼저 fixture와 의미 계약을 작성한다. 응답 selector는 기존 표현을 우선하며, 확장이 필요하면 protocol 및 프론트 matcher의 호환성 검증을 E·F에 포함한다. 패키지 minor 변경만으로 protocol 호환성이 보장된다고 간주하지 않는다.
- explain은 실제 계산 경로에서 제외·포함·확장 이유를 수집한다. 별도 판정 엔진을 만들지 않는다.
- 통과 기준: 전후 결과가 달라진 모든 지원 Query/입력이 자동 계산 결과에 포함되고, 안전하게 좁힐 수 있는 fixture는 기대 범위까지 좁혀진다. 과잉 영향에는 분석 한계·정보 부족·상한 등 구체적인 이유가 있고, 자동 도출과 수동 보완의 경계가 문서화돼 있다. 운영 영향 계산을 위한 추가 업무 SELECT가 없다.

### D. Native 실행과 ORM 연동

- node-postgres·postgres.js·SQLite native 실행 client와 실행 지점의 수명 검사를 구현한다. driver별 반환값·codec·stream·lazy 실행을 보존한다.
- `pg` bridge가 숨긴 실제 연결을 어댑터 내부에서 재사용할 수 있도록 변경한다. 외부에 무제한 PoolClient를 반환하지 않는다.
- Drizzle adapter와 transaction client를 인자로 받는 repository 예제를 완성한다.
- Prisma 가능성 실험을 수행한다. 조건을 만족하면 같은 conformance로 구현하고, 불가능하면 재현 결과와 부족한 공개 API를 문서화한다.
- 예제는 단일 UPDATE를 넘어 여러 업무 함수, 기존 transaction 경계, Trigger/Cascade, savepoint 취소, commit 후 영향 반환을 포함한다.
- 통과 기준: 같은 시작 상태와 논리적 쓰기·권한 문맥에서 native SQL과 ORM의 DB 결과 및 ImpactSet 의미가 일치한다. ORM이 추가 SQL/다른 순서로 쓰는 경우 차이를 설명하며 무조건 byte 단위 일치를 요구하지 않는다.

### E. 프론트 반환 검증·소비처 이전·CRUD 제거

- 기존 orders 예제를 mutation → 여러 repository 호출 → 직접·간접 DB effect 수집 → commit → 정밀 ImpactSet 계산 → `{ data, impact }` 응답 직렬화 → 프론트 입력 selector 매칭까지 연결한다. UI 프레임워크나 캐시 라이브러리의 새 의존성은 필수로 추가하지 않는다.
- 프론트 소비 예제는 주문 상세 및 OLD/NEW 고객 목록처럼 영향받는 입력이 선택되고, 무관한 고객 목록은 안전한 경우 선택되지 않는 것을 검증한다. 초기 조회가 비어 있었던 입력도 포함한다. mutation별 수동 WriteFact·무효화 목록을 넣지 않는다.
- raw WriteSet, DB OLD/NEW 행, 내부 tenant 값, 전체 의존성 graph는 응답에 포함하지 않는다. 응답은 기존 `{ data, impact }` 계약을 기본으로 하며, 앱이 반환하는 업무 data의 권한은 앱이 책임진다.
- rollback과 commit/drain 오류에서 정상 impact 응답을 만들지 않는지 검증한다. 프론트 예제도 commit 후 impact 실패를 단순 mutation 재시도로 처리하지 않는다. 네트워크 응답 유실에 대한 영속 복구는 추가하지 않는다.
- 공통 CRUD, operations/표현식 API, 전용 CRUD wrapper 및 불필요한 dispatcher를 제거한다.
- 예제·tests·벤치마크·pack 검사 코드를 native SQL/검증된 ORM 연동으로 이전한다.
- `writeAccess`/함수 registry 사용자의 권한 이전과 API 매핑을 문서화한다.
- Query 유틸리티와 필요한 실행 기능이 함께 삭제되지 않았는지 확인한다.
- 통과 기준: 전체 mutation 응답 예제가 수동 변경 보고·무효화 매핑 없이 동작한다. 공개 타입과 README 대표 예제에 SDI 고유 CRUD/operations가 없고, 내장 어댑터마다 실행 가능한 대체 경로가 있다. 삭제 전에 이전한 소비처의 의미와 권한 경계를 검증한다.

### F. 비용 확인·회귀 검증·패키징·이전 문서

- 같은 업무 fixture의 관찰 없는 native 기준선, 기존 SDI, 변경 후 SDI를 비교한다. ORM 자체 비용과 관찰 비용을 구분한다.
- 연결 점유 시간과 동시성, facts/ImpactSet 크기, collector 처리와 계산 시간을 함께 본다. 무조건 작은 응답을 만들기 위해 영향을 누락하지 않는다.
- 고정된 Query/입력 fixture에서 누락 여부와 불필요하게 포함된 입력 수, 전체 selector로 확장된 사례 및 이유를 전후 비교한다. 자동 의존성 도출 범위와 수동 보완 사례도 기록해 자동화·정밀도 개선을 비용과 함께 평가한다.
- 관찰 비용이 허용하기 어려운 사례는 문서화하고 원인을 개선한다. 성능이 불리하다는 이유만으로 변경 감지를 끄거나 정확성을 낮추지 않는다.
- 아래 검증을 완료하고 EN/KO README의 궁극적 목표와 실제 지원 범위, package README, `spec/server-driven-impact/semantics.md`와 관련 schemas, 지원 matrix, migration guide, Changeset을 함께 갱신한다. 목표와 아직 구현하지 않은 지원은 구분한다.
- 0.x의 호환성 파괴 변경으로 다음 minor 릴리스(착수 시 최신 기준 `0.4.0`)를 준비한다. 실제 버전 작업 시 기존 릴리스와 충돌 여부를 확인한다.
- fixed group과 peer 범위를 함께 조정하고, 호환되지 않는 0.1 runtime/새 adapter 조합이 설치 가능한 것으로 선언되지 않게 한다.
- 기존 npm 버전은 유지한다. 소스에서 이름만 바꾸는 것과 runtime 의미가 달라지는 것을 migration guide에서 구분한다.
- Routine은 별도 저장소이므로 이 계획으로 즉시 변경·배포하지 않는다. 영향을 받는 호출 유형과 로컬 전환 절차를 인계 자료로 제공한다.

## 9. 검증 기준

핵심 불변식은 1절의 결과 변경 → 영향 포함 계약이다. 동시 요청·시간·권한 변화가 테스트 결과를 혼동시키지 않도록 fixture와 조회 문맥을 고정한다.

세 종류의 판정을 분리한다.

| 검증 축 | 판정 방법 | 완료 기준 |
| --- | --- | --- |
| WriteSet 수집 완전성 | 알려진 직접·간접 effect fixture를 수집 facts/보수적 요약과 대조 | 지원되는 커밋 변경 누락 0건, 취소된 변경 혼입 0건 |
| ImpactSet 완전성 | 고정 입력 Query의 변경 전·최종 commit 후 결과를 실제 DB에서 비교 | 결과가 바뀐 모든 입력이 selector에 포함됨 |
| ImpactSet 정밀도·자동화 | 증명 가능한 기대 selector와 비교하고 자동 도출/수동 보완/확장 이유 기록 | 정밀도 fixture의 불필요한 포함 제거, mutation별 수동 매핑 없음 |

정밀도 대표 사례는 무관 컬럼 UPDATE의 제외, 주문 상세 ID 제한, OLD/NEW 고객 목록 제한, 첫 INSERT로 영향을 받는 빈 목록 포함, 알려진 scope 구분, 안전한 JOIN binding 전파, 상세 정보를 잃는 상한의 국소적 확장이다. 집계·페이지 등에서 실제 결과가 같다는 사실만으로 제외를 요구하지 않는다. 수집 facts와 정적 의존성으로 제외를 증명할 수 있는 경우를 정밀도 계약으로 삼는다.

누락 0건은 지원 범위와 검증 fixture의 통과 조건이며 임의 SQL 전체에 대한 수학적 증명 주장이 아니다. 추가된 지원에는 해당 의미를 검증하는 사례가 따라야 한다.

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
- `pnpm test:matrix`: PostgreSQL 14–18 × postgres.js/pg 기존 matrix. Drizzle은 대표 버전에서 먼저 검증하고, 광고할 PostgreSQL 범위 전체에 conformance를 적용한다.
- Node 22.18/24 독립 tarball 소비. core/runtime 단독, SQLite 단독, pg 단독, postgres.js 단독, 선택 ORM 설치를 확인한다.
- ORM peer 미설치 시 무관한 subpath import가 실패하지 않음. public 타입에 비공개 SDI CRUD 또는 다른 driver 타입이 새어 나오지 않음.
- 같은 native SQL/fixture를 기준으로 전후 adapter 비용 비교: 1/1,000/10,000행, p50/p95, SQL 왕복, facts/impact bytes, 단건 동시성. ORM 자체 비용과 관찰 추가 비용을 구분한다.
- 기존 벤치마크 결과를 새 변경 통과 근거로 재사용하지 않는다. 추적 비용 0 또는 성능 개선을 미리 약속하지 않는다.

## 10. 제외 범위와 완료 산출물

이번 전환은 새 DB 종류, WAL/CDC, 외부 writer의 자동 전파, realtime/outbox, ORM 전체 조회 자동 분석, transaction pooling 지원을 포함하지 않는다.

완료 산출물은 transaction 관찰 계약과 실제 DB 검증 자료, 조회 의존성·ImpactSet 계산의 정확성 및 explain, native driver 실행 경로, 검증된 Drizzle 연동, Prisma 가능성 판정(가능하면 구현 포함), CRUD 정리가 반영된 API·예제, 비용 비교, 이전 가이드와 릴리스 준비 자료다.

최종 완료 판단은 **mutation 함수가 지원되는 transaction에서 일으킨 직접·간접 DB effect를 WriteSet으로 최대한 자동으로 누락 없이 수집하고, 등록 Query의 의존성과 결합해 영향받는 Query/입력을 자동 분석하며, 누락 없이 안전하게 좁힌 ImpactSet을 mutation 결과와 함께 프론트엔드에 전달할 수 있는가**다. mutation 실행부터 응답까지 연결된 예제, WriteSet 수집 완전성, 수집·분석의 자동화 경계, 정밀도 회귀 사례 및 보수적 확장의 이유를 함께 검증한다. CRUD 삭제 건수와 지원 ORM 개수로 완료를 판정하지 않는다.

후속 릴리스 요청에 따라 검증된 0.4.0 변경을 원격 저장소에 반영하고 기존 릴리스 CI를 통해 npm에 배포한다. 앱의 원격 DB migration이나 Routine 배포는 포함하지 않는다. 실제 검증한 버전·범위만 지원 문서에 기록한다.
