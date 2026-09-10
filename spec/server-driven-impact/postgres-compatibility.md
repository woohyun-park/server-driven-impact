# PostgreSQL 실행·캐시 호환 계약

적용: PostgreSQL 14~18, postgres.js 3.4.8, pg 8.16.3. 이 계약은 검증된 실행 모드를 정의하며 임의 확장과 외부 효과의 자동 추론을 약속하지 않는다.

## 공개 실행 모드

| 모드 | API | 보장 |
| --- | --- | --- |
| 관찰 가능한 정적 SELECT | `compilePostgresArtifacts` → `engine.query` | PostgreSQL에서 원문을 실행하고 등록된 의존성을 관찰한다. native parameter와 observer JSON의 동등성이 증명되지 않은 입력은 endpoint 전체 갱신으로 처리한다. |
| 시간·난수·세션·불투명 함수·custom type/operator | `engine.queryUncached` | 매번 DB에서 실행하고 전달 방식에 독립적인 `cachePolicy:'no-store'`를 반환한다. 일반 `query` API는 이 endpoint와 이를 포함하는 조합을 거절한다. |
| 로컬 DML·COPY·함수 호출 | `engine.command` | 같은 물리 연결에서 BEGIN → 실행 → deferred 동작을 포함한 COMMIT → 영향 회수 순서를 지킨다. |
| view·함수·RLS·권한·topology 변경 | `migratePostgresQueries` | 협력하는 요청을 차단하고 DDL, 원본 Query 재컴파일, 리소스 발견, observer 교체를 한 transaction으로 수행한다. 실패하면 함께 rollback한다. |

비캐시 SELECT도 읽기 전용 transaction에서 실행한다. `nextval`처럼 쓰기 의미가 있는 함수는 Command에서 실행한다. sequence 증가가 rollback되지 않는 PostgreSQL 동작도 바꾸지 않는다. DML의 RETURNING과 Query 데이터는 사용한 드라이버의 codec을 유지한다. postgres.js와 pg가 서로 다른 JS 타입을 반환하는 경우에는 각 드라이버의 native 실행 결과와 비교한다.

`compilePostgresQuery`는 기존 저수준 compiler로 유지한다. catalog·배포 변경·codec 안전성까지 묶는 새 애플리케이션은 `compilePostgresArtifacts` 또는 `migratePostgresQueries`를 사용한다. `onUnresolved:'reject'`는 활성화를 실패시키고, 기본값은 해당 SELECT를 비캐시로 전환해 diagnostic을 남긴다. 잘못된 SQL·parameter map·접근 실패를 빈 결과로 변환하지 않는다.

## 등록과 migration

```ts
import postgres from 'postgres';
import { createImpact } from '@server-driven-impact/runtime';
import { migratePostgresQueries, postgresAdapter } from '@server-driven-impact/postgres';

const definitions = {
  items: { input: inputSchema, source: { text: 'select * from app.items where id=$1', parameters: ['id'] } },
  clock: { input: emptyInputSchema, source: { text: 'select current_timestamp' } },
};
const artifact = await migratePostgresQueries(adminDatabase, resources, definitions, {
  version: 18, searchPath: ['app', 'public'], runtimeRole: 'app_runtime',
  change: async transaction => { /* deployment DDL */ },
});
const engine = createImpact({
  adapter: postgresAdapter({ database: runtimeDatabase, connectionMode: 'direct' }),
  resources: artifact.resources, queries: artifact.queries,
});
await engine.query('items', {id:'one'}, {scope:'user'});
const response = await engine.queryUncached('clock', {}, {scope:'user'});
// Map response.cachePolicy to the application's transport and cache implementation.
```

`pg` 이용 시 `@server-driven-impact/postgres/pg`의 `pgAdapter({database: pool})`를 사용한다. catalog/migration에는 `pgDatabase(adminPool)` bridge를 사용할 수 있다. COPY를 사용하는 pg 소비자는 `pg-copy-streams@7.0.0`도 설치한다.

catalog fingerprint는 관련 schema의 relation·column·function·view rewrite·RLS policy·trigger·type·operator·collation·constraint·partition 및 role·membership·extension 정의를 포함한다. 원본 SQL, parameter map, search_path, 캐시 정책도 observer artifact에 포함한다. `engine.validate()`는 호출할 때마다 현재 fingerprint와 observer coverage를 새로 확인하므로 view/function/GRANT만 바뀐 경우도 명시적 검증에서 중단한다. 일반 Query/Command는 전체 catalog 검증을 암묵적으로 수행하지 않는다.

요청은 session shared advisory lock을 BEGIN 전에 획득한다. migration은 READ COMMITTED transaction에서 같은 키의 exclusive lock을 획득한다. 따라서 잠금을 기다린 뒤 이전 catalog snapshot으로 요청을 실행하지 않는다. `migratePostgresArtifacts`는 기존 구조화 Query의 topology migration용이다. native manifest를 전달하면 원본 재컴파일이 필요한 새 API를 요구한다.

## 캐시와 실패 복구

- 서버가 배포한 `engine.artifact`를 authoritative metadata로 전달한다. JS input parser·setup callback 등 SQL/catalog 밖의 앱 코드가 바뀌면 앱 build ID도 결합해 배포를 구별한다. 클라이언트는 저장된 artifact와 비교하고 `cache.setArtifact(next)`를 완료한 뒤 기존 데이터를 사용한다. 메서드는 해당 사용자 scope의 진행 중 조회를 취소하고 기존 QueryCache 항목을 제거한다. 이전 요청의 응답을 새 배포 metadata로 취급하지 않는다.
- `COMMIT_STATE_UNKNOWN`은 성공/실패를 추정하거나 mutation을 자동 재시도하지 않는다. `IMPACT_UNAVAILABLE`은 commit 성공과 반환 데이터가 알려져 있지만 impact를 회수하지 못한 상태다. 둘 모두 `cache.applyOutcome(error)`로 해당 scope의 캐시를 제거하고 업무별 결과 확인 절차로 넘긴다.
- 세션/사용자 변경은 별도 cache scope로 분리한다. 비캐시 데이터는 HTTP·QueryClient·persisted cache에 저장하지 않는다. TTL API는 제공하지 않는다. 시간에 따른 결과 변화를 무지연으로 추적했다고 표시하지 않는다.
- cursor/stream은 Command 수명에 속한다. 미완료 iterator는 성공을 거절하고 return/close 후 rollback한다. rollback 또는 protocol 정리에 실패한 연결은 폐기한다. 폐기를 확인할 수 없으면 adapter를 격리하고 새 요청을 거절한다. pg는 `release(true)`, postgres.js는 자기 backend 종료 후 연결 교체를 이용한다.

## 보장의 전제와 경계

자동 impact는 SDI Command 안에서 커밋한 로컬 변경에 대한 응답이다. 다른 연결·기기의 쓰기를 기존 클라이언트에 전달하는 CDC/pubsub는 이 프로토콜에 포함하지 않는다. 해당 변경이 가능한 조회는 별도 관찰·전달 체계를 연결하거나 비캐시로 실행한다.

FDW/dblink/HTTP 및 불투명 확장은 native SELECT를 비캐시로 실행할 수 있지만, 공급자·권한·확장 설치와 읽기 전용 실행 가능 여부에 따른다. 각 외부 공급자를 통합 검증했다고 표시하지 않는다. 정적 PL/pgSQL을 포함해 분석이 증명되지 않은 함수도 같은 경로를 쓴다. cached 기능에서 거절한 사실을 그 기능의 자동 캐시 지원으로 계산하지 않는다.

transaction pooling은 collector의 같은 backend 회수를 보장하지 못하므로 설정에서 거절한다. proxy 종류를 자동 판별하지 않으며 실제 topology가 direct/session이라는 운영 계약이 필요하다. 해당 pool은 이 실행 경계에 전용으로 제공하고 setup은 검증된 scope와 transaction-local 설정만 적용한다. 자체 COMMIT procedure·2PC·WITH HOLD cursor·서버 파일/PROGRAM COPY는 단일 Command API의 지원 대상이 아니다. 필요한 경우 native driver와 별도 세션·복구 계약을 사용한다.

SQL·setup·등록 routine은 서버의 신뢰된 코드다. `execute`의 명시적 transaction 제어·다중 statement와 직접 DDL은 차단하지만 임의 함수/DO 내부의 악의적인 설정 변경을 막는 SQL sandbox는 아니다. schema·권한 변경은 migration 경계를 사용해야 한다. 관리자 DDL은 협력 잠금을 우회할 수 있으므로 동시 실행까지 원자적으로 차단한다고 주장하지 않는다.

## 검증

`pnpm test:sdi:matrix`는 버전별 격리 Docker를 만들고 두 드라이버의 동일 suite를 실행한 뒤 제거한다. 필수 fixture skip은 실패다. native 결과, numeric scale·JSON 원문 변화와 MVCC 비캐시 분류, SQLSTATE, self/outer/lateral/anti join, 집합 연산, 재귀 CTE, window, 페이지 이동, RLS, 함수·view 의존성, COPY/커서, partition, materialized view, migration/rollback/old artifact를 검증한다.

`scripts/backend/benchmark-sdi-postgres.mjs`는 1/1,000/10,000행에 대해 native·broad·narrow observer의 30회 표본 p50/p95/p99와 응답 바이트를 기록한다. 비용 확인용 업무 SELECT는 0회여야 한다. 대량 UPDATE는 OLD/NEW key join을 생략하고 transition rows에서 selector를 직접 수집한다. 상세 한도 초과는 공통 조건을 보존하거나 해당 resource/endpoint 범위로 확장하며 응답 상한을 유지한다. 측정값은 해당 환경의 결과이며 범용 성능 SLA가 아니다.

설계 근거: PostgreSQL [dependency tracking](https://www.postgresql.org/docs/18/ddl-depend.html)은 문자열 함수 본문의 의존성을 모두 저장하지 않는다. [node-postgres transaction](https://node-postgres.com/features/transactions)은 동일 client 사용을 요구하며, [pool API](https://node-postgres.com/apis/pool)는 실패한 client의 폐기를 제공한다. 구현은 이 제약을 수명과 비캐시 정책에 반영한다.

## 0.4 native/ORM 연동

pg 8.16.3, postgres.js 3.4.8, 선택 Drizzle 0.45.2 + pg 및 Prisma 7.10.0 + pg를 검증한다. ORM 변경은 기존 Query 의존성과 연결하며 임의 ORM 조회 코드를 자동 분석하지 않는다. 실제 실행과 최종 commit/drain은 같은 연결이다. 연결·메서드·codec·중첩 transaction 지원 범위는 [0.4 이전 가이드](../../docs/migrations/transaction-impact-0.4.md), 자동 도출/확장/거절 경계는 [분석 범위](../../docs/research/query-automation-boundaries.md)에 있다.
