# Server-Driven Impact

[English](./README.md) | [한국어](./README.ko.md)

Server-Driven Impact(SDI)는 데이터베이스 Command가 끝난 뒤 어떤 등록 Query 결과가 오래됐을 가능성이 있는지 계산하는 백엔드 라이브러리입니다.

주문 한 건의 고객이 `old`에서 `new`로 바뀌었다고 해보겠습니다. 해당 주문의 상세 조회와 두 고객의 주문 목록은 이제 오래된 결과일 수 있습니다. SDI는 커밋된 쓰기를 관찰하고 그 관계를 다음과 같은 데이터로 반환합니다.

```json
{
  "protocolVersion": 1,
  "targets": [
    {
      "endpoint": "orders.detail",
      "scope": "caller",
      "selector": { "kind": "inputs", "values": [{ "id": "one" }] }
    },
    {
      "endpoint": "orders.list",
      "scope": "caller",
      "selector": {
        "kind": "inputs",
        "values": [{ "customer": "new" }, { "customer": "old" }]
      }
    }
  ]
}
```

`ImpactSet`은 결과가 **달라졌을 가능성**을 나타냅니다. 해당 결과가 실제로 캐시돼 있었거나 렌더링 결과가 반드시 바뀌었다는 뜻은 아닙니다. 애플리케이션은 이 보수적인 정보를 이용해 캐시를 무효화하거나, 다시 조회하거나, 메시지로 발행하거나, 원하는 응답 형식으로 직렬화할 수 있습니다.

## 동작 방식

```text
Resource + Query 정의 ─► 읽기 의존성
                           │
Database Command ─► 관찰한 쓰기 ─┼─► 순수 계산 ─► ImpactSet
        │                  │
        └──── 하나의 transaction ─┘
```

1. `Resources`에 테이블, 컬럼, 식별자, tenant scope를 선언합니다.
2. 실행 가능한 Query 정의에 읽기, 필터, 정렬, 조인을 표현합니다.
3. DB adapter가 transaction을 소유하고 실제로 커밋되는 쓰기를 기록합니다.
4. `@server-driven-impact/core`가 읽기 의존성과 OLD/NEW 행 상태를 비교합니다.
5. Command는 커밋 이후 `{ data, impact }`를 반환합니다.

OLD와 NEW를 함께 보는 것이 중요합니다. 값이 `old`에서 `new`로 이동하면 두 목록이 모두 오래됐을 수 있기 때문입니다. SDI가 입력 조건을 안전하게 유지할 수 없을 때는 가능한 대상을 누락하지 않고 selector를 `{ "kind": "all" }`로 넓힙니다.

## 패키지

| 패키지 | 역할 |
| --- | --- |
| [`@server-driven-impact/core`](./packages/sdi-core/README.ko.md) | DB 중립 계약과 순수 `ImpactSet` 계산 |
| [`@server-driven-impact/runtime`](./packages/sdi-runtime/README.ko.md) | Query/Command 실행 경계와 adapter 계약 |
| [`@server-driven-impact/postgres`](./packages/sdi-postgres/README.ko.md) | postgres.js와 node-postgres용 PostgreSQL adapter |
| [`@server-driven-impact/sqlite`](./packages/sdi-sqlite/README.ko.md) | Node 동기 SQLite 드라이버용 adapter |

하나의 계산 모델은 공통 패키지에 두고 transaction과 쓰기 관찰은 DB별 adapter가 담당합니다. 프론트 패키지는 제공하지 않습니다. HTTP 응답 형식, 메시지 전달, 캐시 연동은 애플리케이션의 책임입니다.

## SQLite로 시작하기

Node.js 22.18 이상이 필요합니다.

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/sqlite
```

```ts
import { DatabaseSync } from 'node:sqlite';
import {
  createImpact,
  defineQueries,
  q,
  type Input,
  type Resources,
} from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const database = new DatabaseSync(':memory:');
database.exec(`
  pragma foreign_keys = on;
  create table todos (
    id text primary key,
    account_id text not null,
    status text not null
  );
`);

const resources: Resources = {
  todos: {
    schema: 'main',
    table: 'todos',
    idColumn: 'id',
    scopeColumn: 'account_id',
    columns: ['id', 'account_id', 'status'],
  },
};

const statusInput = {
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
    input: statusInput,
    plan: q.select('todos', {
      where: [q.eq('status', q.input('status'))],
      order: [{ field: 'id' }],
    }),
  },
});

const engine = createImpact({
  resources,
  queries,
  adapter: sqliteAdapter({ database }),
});

// 호출 시점은 애플리케이션이 정합니다. 일반 Query와 Command는 전체 검증을
// 반복하지 않습니다.
await engine.validate();

const context = { scope: 'account-a' };
await engine.command(context, db => db.execute(
  'insert into todos(id, account_id, status) values(?1, ?2, ?3)',
  ['todo-1', 'account-a', 'open'],
));

const { data, impact } = await engine.command(context, db =>
  db.execute('update todos set status=?1 where id=?2', ['done', 'todo-1']),
);

console.log(data);
console.log(impact);
console.log(await engine.query('todos.byStatus', { status: 'done' }, context));

database.close();
```

두 번째 Command의 `impact`에는 `todos.byStatus`의 `{ status: "open" }`과 `{ status: "done" }`이 모두 포함됩니다. 애플리케이션은 이 값을 HTTP 응답에 넣거나, 메시지 시스템에 발행하거나, 서버 내부에서 바로 사용할 수 있습니다.

## 핵심 개념

### Resources

Resource는 애플리케이션의 이름을 DB relation에 연결합니다. `idColumn`은 행 식별자이고, `scopeColumn`은 호출자별 영향을 구분합니다. 전역 데이터에는 `null`을 사용합니다. `columns`는 Query plan을 검증하고 변경 사실을 수집할 필드를 설명합니다.

`scope`는 영향 범위를 구분하는 메타데이터이며 인증이나 인가 수단이 아닙니다. 애플리케이션이 사용자의 신원을 검증하고 RLS 같은 DB 규칙으로 접근을 통제해야 합니다.

### Queries

`defineQueries()`로 실행 가능한 plan을 등록합니다. SDI는 조회 컬럼, 필터, 정렬, 조인에서 의존성을 얻습니다. `q.call`, `q.combine`, `q.when`, `q.bind`, `q.map`, `q.choose`로 여러 plan을 조합할 수도 있습니다.

`engine.query()`는 등록된 캐시 가능 plan만 실행합니다. `no-store` 정책으로 컴파일한 plan은 `engine.queryUncached()`로 실행합니다.

### Commands와 WriteFacts

`engine.command()`는 쓰기 추적 경계입니다. adapter는 콜백을 자신의 transaction 안에서 실행하고 insert, update, delete, trigger, 지원되는 cascade에서 `WriteFact`를 기록합니다. rollback은 성공한 impact를 만들지 않으며 rollback된 savepoint의 쓰기는 버립니다.

Command 콜백의 모든 작업은 반드시 `await`해야 합니다. 다른 연결이나 adapter transaction 밖에서 실행한 쓰기는 해당 Command의 impact 결과에 포함되지 않습니다.

### ImpactSet

각 target에는 endpoint, scope, selector가 들어갑니다.

- `inputs`는 오래됐을 수 있는 결과와 일치하는 부분 입력 목록입니다.
- `all`은 해당 endpoint의 모든 입력을 포함합니다.
- `caller`는 검증된 Command scope로 제한됩니다.
- `global`은 `scopeColumn`이 `null`인 Resource에 사용됩니다.

애플리케이션에서 기준 selector 판정이 필요하면 `@server-driven-impact/core`의 `matchesInputSelector()`를 사용할 수 있습니다. 숫자 문자열 변환과 SQLite의 `NOCASE`·`RTRIM`처럼 DB 비교 방식이 다른 경우도 보수적으로 포함합니다. 일부 캐시를 더 갱신할 수는 있지만 영향받은 항목을 빠뜨리지는 않습니다.

## PostgreSQL 도입 순서

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/postgres postgres
```

PostgreSQL 애플리케이션은 보통 다음 두 실행 경로를 둡니다.

1. 관련 schema나 Query 정의가 바뀌면 schema owner 권한으로 `generateObserverMigration(...)` 결과를 적용합니다.
2. 시작, 배포 또는 health check 시점에 runtime 연결로 `engine.validate()`를 호출합니다.
3. 일반 요청에서는 전체 catalog 검증을 반복하지 않고 engine을 통해 Query와 Command를 실행합니다.

runtime role에는 일반적인 테이블 권한이 필요합니다. adapter의 `setup`이 설정하는 scope와 RLS 정책도 일치해야 합니다. postgres.js는 `postgresAdapter`를 사용합니다. node-postgres는 `@server-driven-impact/postgres/pg`의 `pgAdapter`를 사용하며, 이 드라이버에서 COPY를 사용할 때는 `pg-copy-streams`도 필요합니다.

자세한 내용은 [PostgreSQL 패키지 가이드](./packages/sdi-postgres/README.ko.md), [호환 계약](./spec/server-driven-impact/postgres-compatibility.md), [orders 예제](./examples/orders-impact)를 참고하세요.

## 보장 범위

SDI는 지원되는 작업이 SDI engine과 adapter가 소유한 transaction을 통해 실행될 때 impact를 추적합니다. 다른 연결의 직접 쓰기, 외부 서비스, transaction pooling, autonomous procedure, held cursor, two-phase commit은 원자적 Command 계약 밖에 있습니다.

좁은 결과를 증명할 수 없으면 누락하는 대신 실패하거나 범위를 넓힙니다. DB별 제한은 각 adapter 문서에 설명합니다. PostgreSQL 호환성은 PostgreSQL 14–18에서 postgres.js와 node-postgres를 모두 사용해 검사합니다.

## 커밋 결과 오류

- `ImpactUnavailableError`는 DB 커밋은 성공했지만 impact를 계산할 수 없었다는 뜻입니다. `data`를 사용할 수 있고 `commitState`는 `committed`입니다.
- `CommitStateUnknownError`는 클라이언트가 커밋 성공 여부를 알 수 없다는 뜻입니다. 멱등성이 없는 Command를 무조건 재시도하면 안 됩니다.

이 오류를 애플리케이션 프로토콜로 변환할 때는 `isCommitOutcomeError()`를 사용할 수 있습니다. SDI는 HTTP envelope, 재시도 정책, idempotency key, durable outbox 형식을 정하지 않습니다.

## 개발

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm pack:check
```

릴리스에는 Changesets와 `.github/workflows/sdi-release.yml`의 npm trusted publishing을 사용합니다.

## 라이선스

MIT
