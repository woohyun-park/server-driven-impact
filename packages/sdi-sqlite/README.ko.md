# @server-driven-impact/sqlite

[English](./README.md) | [한국어](./README.ko.md)

Server-Driven Impact의 SQLite 실행과 transaction 단위 쓰기 관찰 도구입니다.

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
  create table notes(
    id text primary key,
    tenant_id text not null,
    category text not null,
    body text
  );
`);

const resources: Resources = {
  notes: {
    schema: 'main',
    table: 'notes',
    idColumn: 'id',
    scopeColumn: 'tenant_id',
    columns: ['id', 'tenant_id', 'category', 'body'],
  },
};

const input = {
  parse(value: unknown): Input {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('INVALID_INPUT');
    }
    const category = (value as Record<string, unknown>).category;
    if (typeof category !== 'string') throw new Error('INVALID_CATEGORY');
    return { category };
  },
};

const queries = defineQueries({
  'notes.byCategory': {
    input,
    plan: q.select('notes', {
      where: [q.eq('category', q.input('category'))],
    }),
  },
});

const engine = createImpact({
  resources,
  queries,
  adapter: sqliteAdapter({ database }),
});

await engine.validate();

const { impact } = await engine.command(
  { scope: 'tenant-a' },
  db => db.execute(
    'insert into notes(id, tenant_id, category, body) values(?, ?, ?, ?)',
    ['one', 'tenant-a', 'work', 'Ship SDI'],
  ),
);

console.log(impact);
database.close();
```

adapter는 Command transaction 안에서 native DML, trigger, foreign-key cascade, rollback, savepoint를 관찰합니다. connection-local TEMP observer를 사용하므로 `DatabaseSync` 연결 하나마다 adapter 하나를 공유하세요.

0.1 버전은 Node 동기 SQLite 드라이버, `main` 데이터베이스, 단일 primary key를 가진 일반 테이블, 등록된 `TEXT`, `INTEGER`, `REAL` 컬럼과 SQLite 기본 `BINARY`·`NOCASE`·`RTRIM` collation을 지원합니다. `ATTACH`, virtual table, generated/hidden column, 사용자 정의 collation, 스키마 충돌 정책을 포함한 `REPLACE`, Command 안의 transaction 제어와 DDL은 거부합니다.

Node.js 22.18 이상이 필요합니다.
