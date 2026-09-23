# @server-driven-impact/postgres

[English](./README.md) | [한국어](./README.ko.md)

Server-Driven Impact의 PostgreSQL 실행, 쓰기 관찰, catalog 검증, migration 도구입니다.

postgres.js를 사용할 때:

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/postgres postgres
```

node-postgres를 사용할 때는 `pg`와 TypeScript 프로젝트의 `@types/pg`를 설치하고 `@server-driven-impact/postgres/pg`에서 `pgAdapter`를 가져옵니다. COPY도 사용한다면 `pg-copy-streams`가 필요합니다. `pg` 진입점은 postgres.js를 요구하지 않습니다.

```ts
import postgres from 'postgres';
import {
  compileManifest,
  createImpact,
  defineQueries,
  q,
  type Input,
  type Resources,
} from '@server-driven-impact/runtime';
import {
  generateObserverMigration,
  identifier,
  postgresAdapter,
  sql,
} from '@server-driven-impact/postgres';

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
const database = postgres(process.env.DATABASE_URL!, { max: 4 });

const resources: Resources = {
  todos: {
    schema: 'public',
    table: 'todos',
    idColumn: 'id',
    scopeColumn: 'account_id',
    columns: ['id', 'account_id', 'status'],
  },
};

const input = {
  parse(value: unknown): Input {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('INVALID_INPUT');
    }
    const status = (value as Record<string, unknown>).status;
    if (typeof status !== 'string') throw new Error('INVALID_STATUS');
    return { status };
  },
};

const queries = defineQueries({
  'todos.byStatus': {
    input,
    plan: q.select('todos', {
      where: [q.eq('status', q.input('status'))],
    }),
  },
});

// 관련 schema나 Query 정의가 변경될 때 schema owner 권한으로 실행합니다.
await admin.unsafe(generateObserverMigration(
  resources,
  compileManifest(queries, resources),
  { runtimeRole: 'app_runtime' },
));
await admin.end();

const adapter = postgresAdapter({
  database,
  setup: async (tx, scope) => {
    await tx.unsafe(
      "select set_config('app.account_id', $1, true)",
      [String(scope)],
    );
  },
});

const engine = createImpact({ resources, queries, adapter });

// 시작, 배포, health check 중 애플리케이션이 정한 시점에 호출합니다.
await engine.validate();

const result = await engine.command(
  { scope: 'account-a' },
  db => db.execute(sql`
    insert into ${identifier('public')}.${identifier('todos')}(id, account_id, status)
    values(${'todo-1'}, ${'account-a'}, ${'open'})
  `),
);

console.log(result.impact);
await database.end();
```

`execute()`는 SQL을 한 번 실행하고 선택한 드라이버가 반환한 결과 객체를 복사, 평탄화, 공통 형태 변환 없이 그대로 돌려줍니다. postgres.js에서는 결과가 `RowList<Record<string, unknown>[]>`이므로 행 배열처럼 순회할 수 있고 `result.count`, `result.command`도 사용할 수 있습니다. node-postgres에서는 `QueryResult<Record<string, unknown>>`이며 행은 `result.rows`, 처리 행 수는 `result.rowCount: number | null`에 있습니다. 드라이버 고유 필드는 해당 드라이버 버전의 계약을 따릅니다. SDI는 결과 컨테이너 타입을 보존하지만 SQL로부터 행 칼럼 타입을 추론하지는 않습니다.

드라이버 결과는 Command 결과의 `data`에 들어갑니다.

```ts
const { data, impact } = await engine.command(
  { scope: 'account-a' },
  db => db.execute(sql`
    update todos set status=${'closed'} where id=${'todo-1'}
  `),
);

console.log(data.count); // postgres.js: number
console.log(impact.endpoints);
```

`pgAdapter`에서는 `data.rowCount`를 사용하며 TypeScript 타입은 `number | null`입니다. 이 값은 실제 값이 달라진 행의 수가 아니라 PostgreSQL 명령 태그가 보고한 처리 행 수입니다. 따라서 한 행을 같은 값으로 갱신하면 처리 행 수는 `1`이어도 관찰 가능한 값이 바뀌지 않아 각 verified endpoint의 `targets`는 비어 있을 수 있습니다. SQLSTATE 같은 실행 실패 정보는 성공 결과와 별개인 드라이버 오류 객체로 유지됩니다. `savepoint()` 안에서도 같은 결과 타입이 이어지며, 커밋 뒤 impact 변환이 실패하면 원본 결과가 `CommandResult.data`에 보존됩니다.

테이블은 미리 존재해야 하며 runtime role에는 일반적인 테이블 권한이 필요합니다. RLS 정책은 `setup`에서 설정한 scope와 같은 기준을 사용해야 합니다.

운영 순서는 다음과 같습니다.

1. schema나 Query 정의가 바뀐 배포에서 observer migration을 생성하고 적용합니다.
2. 애플리케이션 시작이나 health check에서 `engine.validate()`를 호출합니다.
3. 일반 요청은 engine의 Query와 Command를 사용합니다. bound adapter의 첫 Command도 protocol 10 observer 검증을 한 번 수행해 캐시하며, 이후 요청은 전체 catalog 검증을 반복하지 않습니다.

자동 impact는 해당 SDI Command transaction 안의 등록 resource 쓰기를 대상으로 합니다. 다른 연결이나 외부 서비스에서 일어난 쓰기는 현재 Command 결과에 자동으로 포함되지 않습니다.

## Transaction pooling

Query, Command, catalog validation은 모두 한 transaction 동안만 연결을 사용합니다. adapter에는 PgBouncer 또는 Supavisor transaction endpoint 하나를 전달합니다.

```ts
const database = postgres(process.env.SUPAVISOR_TRANSACTION_URL!, {
  max: 1,
  prepare: false,
});

const adapter = postgresAdapter({ database, setup });
```

`pgAdapter({ database: pool })`, `drizzleAdapter`, `prismaAdapter`도 같은 계약을 사용합니다. 제거된 `query`, `command`, `connectionMode` 옵션을 전달하면 조용히 무시하지 않고 `POSTGRES_CONNECTION_OPTIONS_REMOVED`로 실패합니다.

각 작업은 transaction을 시작하고 애플리케이션 작업 전에 안정된 `sdi_control.transaction_gate`에 ACCESS SHARE lock을 잡습니다. migration helper는 같은 gate에 ACCESS EXCLUSIVE lock을 잡습니다. `generateObserverMigration()`은 gate를 설치하고 배타 잠금을 잡아 runtime role 권한을 부여합니다. 생성 SQL 전체를 하나의 명시적 migration transaction에서 적용해야 합니다. 또한 `migratePostgresQueries()`와 `migratePostgresArtifacts()`는 transaction 단위 advisory lock으로 migration 준비도 직렬화합니다. gate가 없으면 `POSTGRES_TRANSACTION_GATE_NOT_INITIALIZED`로 실패합니다.

Command는 transaction 안에서 `ON COMMIT DROP` collector를 만듭니다. callback을 닫고 이미 시작된 DB 작업을 모두 정리한 다음 `SET CONSTRAINTS ALL IMMEDIATE`를 실행하고, observation 행을 메모리로 복사하고, observation을 sealed 상태로 만든 뒤 COMMIT합니다. 성공한 COMMIT 뒤에는 SQL을 실행하지 않습니다. drain 뒤 다시 defer된 등록 resource 쓰기가 COMMIT에서 실행되면 `SDI_OBSERVATION_SEALED`로 전체 transaction이 실패하므로 impact 없이 커밋될 수 없습니다. 따라서 deferred constraint와 constraint trigger는 SDI의 COMMIT 전 observation 경계에서 성공해야 합니다. COMMIT 끝부분의 다른 실행 순서에 의존한 코드는 수정해야 합니다.

`setup`은 작업 transaction 안에서 실행되며 `SET LOCAL ROLE`, `set_config(..., true)`를 사용할 수 있습니다. 요청 사이 session 상태에 의존하면 안 됩니다. Supavisor/PgBouncer transaction endpoint에서는 postgres.js를 `prepare: false`로 생성해야 하며, SDI는 이 설정을 런타임에 안정적으로 검사할 수 없습니다.

PostgreSQL 14–18에서 postgres.js와 pg를 모두 사용하는 conformance suite를 실행합니다. opaque dynamic SQL 의존성 추론, 외부 I/O 관찰, autonomous procedure, held cursor, two-phase commit은 원자적 Command 계약 밖에 있습니다. 자세한 보장 범위는 [PostgreSQL 호환 가이드](../../spec/server-driven-impact/postgres-compatibility.md)를 참고하세요.

Node.js 22.18 이상이 필요합니다. 연결 API와 deferred 계약 변경은 [transaction-only 이전 가이드](../../docs/migrations/postgres-0.6.md)를 참고하세요.

0.1.x에서 올리는 경우 누락 내용을 보완한 [0.2.0 마이그레이션 문서](../../docs/migrations/postgres-0.2.md)를 참고하세요.

## Native 실행과 선택 ORM 연동

0.4는 pg의 `tx.query(text, values)`, postgres.js의 지연 실행 tagged query, 선택 subpath인 `drizzleAdapter`·`prismaAdapter`를 제공합니다. Drizzle 0.45.2 또는 Prisma/client/adapter-pg/driver-adapter-utils 7.10.0과 pg 8.16.3 조합을 사용합니다. ORM의 실제 실행은 보호된 같은 연결을 통과하고, 중첩 transaction은 SDI savepoint에 연결됩니다. 업무 함수에는 command client를 명시적으로 전달합니다.

업그레이드 시 observer protocol 10 artifact를 재생성·설치해야 합니다. 지원 메서드·설치·수명·codec·예제는 [0.4 이전 가이드](../../docs/migrations/transaction-impact-0.4.md)를 참고하세요.

### RLS 의존성 분석

`compilePostgresArtifacts(database, resources, definitions, {version, searchPath,
effectiveRole: 'authenticated'})`의 역할은 `setup`에서 `SET LOCAL ROLE` 등을
실행한 뒤의 실제 조회 역할입니다. 실행 역할이 다르면
`POSTGRES_ARTIFACT_ROLE_MISMATCH`로 거절합니다. 생략하면 역할별 정책을 보수적으로
합치며, catalog에 접속한 관리자 역할을 앱의 역할로 가정하지 않습니다.

일반 SELECT는 SELECT/ALL 정책의 `USING`을 분석합니다. 잠금 SELECT 분석에는
UPDATE의 `USING`도 포함하지만 `WITH CHECK`는 제외합니다. 적용되는 permissive와
restrictive 정책의 참조는 합집합으로 유지합니다. 역할 상속, 소유자, BYPASSRLS,
FORCE RLS를 반영하고, SQL SECURITY DEFINER 함수 내부는 함수 소유자 문맥으로 분석합니다.

정책에서 읽는 컬럼을 증명하면 SQL 조회 컬럼에 합칩니다. badge의 UPDATE 정책만
`profile.superuser`를 읽는다면 일반 badge SELECT에는 profile 의존성을 추가하지
않습니다. 외부 행 의존성은 컬럼을 좁혀도 빈 bindings와 global scope,
INSERT/DELETE 관찰을 유지합니다. session claim에서 caller binding을 추론하지 않습니다.
참조 테이블이 확인된 복잡한 조회는 컬럼을 넓히고, PL/pgSQL·동적 SQL 등으로 참조
테이블을 알 수 없으면 no-store 또는 거절이 필요합니다. 시간·sequence·session 값의
freshness 제약도 유지합니다.

compiler와 validator는 artifact의 정책 분석 근거를 공유합니다. 업그레이드 및
정책·함수·역할 변경 후 artifact를 재생성·설치해야 합니다. 기존 fingerprint가
정책·함수·소유자·역할 상속·RLS 상태 변경을 감지합니다. SDI는 PostgreSQL의 MVCC나
다른 행을 참조하는 정책 자체의 동시성 문제를 변경하지 않습니다.

검증은 `ValidationReport`를 반환합니다. 첫 command가 고정한 검증 스냅샷은 명시적 `validate()`까지 재사용하며, 검증 이후 DDL은 감지하지 않습니다. 매 응답의 endpoint 상태를 처리해야 합니다. `unavailable`에는 targets가 없으며 해당 endpoint의 캐시를 무효화하거나 재사용을 중단해야 합니다. [endpoint별 impact 변경 안내](../../docs/migrations/endpoint-assessment.md).
