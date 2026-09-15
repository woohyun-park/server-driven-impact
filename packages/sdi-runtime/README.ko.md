# @server-driven-impact/runtime

[English](./README.md) | [한국어](./README.ko.md)

Server-Driven Impact의 Query/Command 실행 경계입니다.

```bash
pnpm add @server-driven-impact/core @server-driven-impact/runtime @server-driven-impact/sqlite
```

runtime은 다음 세 가지를 하나의 engine으로 묶습니다.

- `Resources`: 테이블, 식별자, scope와 허용 컬럼
- `Queries`: 실행 가능한 조회 plan과 입력 검증
- `ImpactAdapter`: DB별 transaction, 조회 실행, 쓰기 관찰, 명시적 검증

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
database.exec(`create table todos(
  id text primary key,
  account_id text not null,
  status text not null
)`);

const resources: Resources = {
  todos: {
    schema: 'main',
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

const engine = createImpact({
  resources,
  queries,
  adapter: sqliteAdapter({ database }),
});

await engine.validate();

const context = { scope: 'account-a' };
const result = await engine.command(context, db => db.execute(
  'insert into todos(id, account_id, status) values(?, ?, ?)',
  ['todo-1', 'account-a', 'open'],
));

console.log(result.data);
console.log(result.impact);
console.log(await engine.query('todos.byStatus', { status: 'open' }, context));

database.close();
```

Command는 커밋 뒤 `{ data, impact }`를 반환합니다. 애플리케이션은 이 값을 HTTP나 메시지로 표현하는 방법과 프론트 캐시에서 사용하는 방법을 직접 정합니다.

Query 입력은 기본적으로 `inputRelation: 'preserve'`입니다. parser가 selector에 사용되는 scalar를 바꾸면 SQL이 실행한 입력과 의존성이 달라지므로 runtime이 Query를 거절합니다. 정규화를 서버만 소유하려면 `inputRelation: 'opaque'`를 선언합니다.

```ts
const queries = defineQueries({
  'profiles.byUsername': {
    input: z.object({ username: z.string().trim().toLowerCase() }),
    inputRelation: 'opaque',
    plan: q.select('profiles', { where: [q.eq('username', q.input('username'))] }),
  },
});
```

opaque endpoint는 파싱한 값으로 그대로 실행하되 manifest의 입력 binding은 제거합니다. 따라서 일치하는 쓰기가 생기면 해당 endpoint의 selector는 `all`이 됩니다. 프론트는 이 논리 target을 TanStack Query, Apollo, Relay, RTK Query 또는 다른 캐시에 원하는 방식으로 연결할 수 있습니다.

커밋 뒤 impact 계산이 실패하면 `ImpactUnavailableError.data`에 업무 결과가 보존됩니다. 전송 계층에서도 이를 유지해야 하며, 이미 커밋된 쓰기를 다시 실행하지 않도록 주의합니다.

`validate()`는 명시적 메서드입니다. 시작, 배포, health check처럼 애플리케이션이 선택한 시점에 호출하세요. 일반 Query와 Command는 전체 DB catalog 검증을 반복하지 않습니다.

`scope`는 영향 범위를 나누는 값일 뿐 인증과 인가를 대신하지 않습니다. 검증된 사용자 정보만 context에 넣고 DB의 RLS나 동등한 정책으로 실제 접근을 통제해야 합니다.

`engine.query()`는 등록된 캐시 가능 plan을 실행합니다. PostgreSQL에서 `no-store`로 컴파일된 plan은 `engine.queryUncached()`로 실행하며 `{ data, cachePolicy: 'no-store' }`를 반환합니다.

adapter 작성자는 `@server-driven-impact/runtime/adapter`의 안정된 계약을 사용합니다. Query graph 진단 도구는 `@server-driven-impact/runtime/debug`에서 제공합니다. Node.js 22.18 이상이 필요합니다.

mutation 계약은 커밋된 변경의 WriteSet 자동 수집, 누락 없는 정밀 ImpactSet 계산, `{ data, impact }` 반환까지입니다. Native·ORM client는 각 도구의 실행 의미를 보존하며 Query 의존성 등록은 계속 필요합니다. [0.4 지원 범위와 이전](../../docs/migrations/transaction-impact-0.4.md).
