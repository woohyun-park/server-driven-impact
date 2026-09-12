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

서버 소유 키를 사용할 때는 버전된 계약을 `cacheContracts`로 등록하고 `command()`의 세 번째 인자로 출력 옵션을 선택합니다. 계약 정의와 OpenAPI 메타데이터는 `@server-driven-impact/cache-contract`에서 제공합니다.

필수 unrestricted string이 직접 equality predicate에 쓰이면, 내장 adapter는 `validate()`에서 실제 컬럼의 문자열 exact 비교를 증명한 뒤 캐시 무효화를 해당 입력으로 자동으로 좁힙니다. Runtime은 검증된 필드의 raw 값과 parse 결과를 매 요청 비교하며, parser가 값을 바꾸면 조회를 거절합니다. DB 검증 전이거나 collation/operator를 지원하지 않으면 endpoint fallback을 유지합니다.

```ts
// 업무 작업 하나에 아래 호출 중 하나를 사용합니다.
const logical = await engine.command(context, work);
// { data, impact }

const cached = await engine.command(context, work, {
  cacheContract: {id: 'web-cache', version: 1},
});
// { data, impact, cacheInvalidation }
```

옵션 생략, `{}`, `cacheContract: undefined`는 모두 기존 반환 타입을 유지하고 캐시 변환을 실행하지 않습니다. 계약을 명시하면 `CommandInvalidationResult<T>`, 동적인 `CommandOptions` 변수라면 결과 union을 추론하므로 `'cacheInvalidation' in result`로 구분합니다. `impact`는 항상 논리적 ImpactSet v1입니다. prerelease .0의 별도 `commandWithInvalidations()`는 .1에서 제거했습니다.

각 계약은 등록된 Read를 모두 연결하거나 `no-store` / `not-consumed`로 명시적으로 제외해야 합니다. 생성 시 coverage를 검증합니다. `cacheInvalidationOptions`로 예산과 `explain` 진단 callback을 설정하며 scope/계약 버전은 command 작업을 기다리기 전에 고정합니다.

선택한 계약은 transaction 시작 전에 확인합니다. 커밋 후 `ImpactUnavailableError.data`는 출력 옵션 유무와 모든 실패 단계에서 **항상 업무 결과**입니다. `phase`는 `impact-calculation` 또는 `cache-invalidation`, `impact`는 영향 계산에 성공한 경우에만 제공합니다. 전송 계층에서도 이 메타데이터를 보존하고, 후속 계산/변환 실패 때문에 command를 재시도하거나 커밋된 optimistic 상태를 rollback하지 마십시오. 캐시 재동기화는 별도로 처리합니다.

`validate()`는 명시적 메서드입니다. 시작, 배포, health check처럼 애플리케이션이 선택한 시점에 호출하세요. 일반 Query와 Command는 전체 DB catalog 검증을 반복하지 않습니다.

`scope`는 영향 범위를 나누는 값일 뿐 인증과 인가를 대신하지 않습니다. 검증된 사용자 정보만 context에 넣고 DB의 RLS나 동등한 정책으로 실제 접근을 통제해야 합니다.

`engine.query()`는 등록된 캐시 가능 plan을 실행합니다. PostgreSQL에서 `no-store`로 컴파일된 plan은 `engine.queryUncached()`로 실행하며 `{ data, cachePolicy: 'no-store' }`를 반환합니다.

adapter 작성자는 `@server-driven-impact/runtime/adapter`의 안정된 계약을 사용합니다. Query graph 진단 도구는 `@server-driven-impact/runtime/debug`에서 제공합니다. Node.js 22.18 이상이 필요합니다.

mutation 계약은 커밋된 변경의 WriteSet 자동 수집, 누락 없는 정밀 ImpactSet 계산, `{ data, impact }` 반환까지입니다. Native·ORM client는 각 도구의 실행 의미를 보존하며 Query 의존성 등록은 계속 필요합니다. [0.4 지원 범위와 이전](../../docs/migrations/transaction-impact-0.4.md).
