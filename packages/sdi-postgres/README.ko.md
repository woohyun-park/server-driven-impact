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
console.log(impact.targets);
```

`pgAdapter`에서는 `data.rowCount`를 사용하며 TypeScript 타입은 `number | null`입니다. 이 값은 실제 값이 달라진 행의 수가 아니라 PostgreSQL 명령 태그가 보고한 처리 행 수입니다. 따라서 한 행을 같은 값으로 갱신하면 처리 행 수는 `1`이어도 관찰 가능한 값이 바뀌지 않아 `impact.targets`는 비어 있을 수 있습니다. SQLSTATE 같은 실행 실패 정보는 성공 결과와 별개인 드라이버 오류 객체로 유지됩니다. `savepoint()` 안에서도 같은 결과 타입이 이어지며, 커밋 뒤 impact 수집이 실패하면 원본 결과가 `ImpactUnavailableError.data`에 보존됩니다.

테이블은 미리 존재해야 하며 runtime role에는 일반적인 테이블 권한이 필요합니다. RLS 정책은 `setup`에서 설정한 scope와 같은 기준을 사용해야 합니다.

운영 순서는 다음과 같습니다.

1. schema나 Query 정의가 바뀐 배포에서 observer migration을 생성하고 적용합니다.
2. 애플리케이션 시작이나 health check에서 `engine.validate()`를 호출합니다.
3. 일반 요청은 engine의 Query와 Command를 사용합니다. 이 경로는 전체 catalog 검증을 매번 반복하지 않습니다.

adapter는 하나의 물리 세션에서 transaction, 임시 collector, COMMIT 이후 관찰 결과 수집을 이어갑니다. 따라서 transaction pooling은 이 계약을 만족하지 않습니다. 다른 연결이나 외부 서비스에서 일어난 쓰기도 현재 Command 결과에 자동으로 포함되지 않습니다.

PostgreSQL 14–18에서 postgres.js와 pg를 모두 사용하는 conformance suite를 실행합니다. opaque dynamic SQL 의존성 추론, 외부 I/O 관찰, autonomous procedure, held cursor, two-phase commit은 원자적 Command 계약 밖에 있습니다. 자세한 보장 범위는 [PostgreSQL 호환 가이드](../../spec/server-driven-impact/postgres-compatibility.md)를 참고하세요.

Node.js 22.18 이상이 필요합니다.

0.1.x에서 올리는 경우 누락 내용을 보완한 [0.2.0 마이그레이션 문서](../../docs/migrations/postgres-0.2.md)를 참고하세요.
