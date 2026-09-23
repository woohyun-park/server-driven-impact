# @server-driven-impact/core

[English](./README.md) | [한국어](./README.ko.md)

DB와 무관한 Server-Driven Impact 계약과 순수 `ImpactSet` 계산기입니다.

```bash
pnpm add @server-driven-impact/core
```

```ts
import {
  calculateImpact,
  type ImpactManifest,
  type ImpactResources,
  type WriteFact,
} from '@server-driven-impact/core';

const resources: ImpactResources = {
  todos: {
    scopeColumn: 'account_id',
    columns: ['id', 'account_id', 'status'],
  },
};

const manifest: ImpactManifest = {
  reads: {
    'todos.byStatus': [{
      resource: 'todos',
      columns: ['id', 'status'],
      bindings: [{ column: 'status', input: 'status' }],
    }],
  },
};

const writes: WriteFact[] = [{
  resource: 'todos',
  operation: 'update',
  before: {
    kind: 'known',
    scope: 'account-a',
    fields: { status: 'open' },
  },
  after: {
    kind: 'known',
    scope: 'account-a',
    fields: { status: 'done' },
  },
  changedColumns: ['status'],
}];

console.log(calculateImpact(writes, {
  resources,
  manifest,
  scope: 'account-a',
}));
```

결과에는 `todos.byStatus`의 `{ status: "open" }`과 `{ status: "done" }`이 모두 들어갑니다. OLD와 NEW를 함께 계산하므로 목록 사이를 이동한 행도 놓치지 않습니다.

`WriteFact`는 커밋된 DB 쓰기를 나타냅니다. `ImpactSet`은 어떤 등록 Query 입력이 오래됐을 가능성이 있는지를 보수적으로 표현합니다. `unknown` 행이나 되돌릴 수 없는 입력 변환처럼 좁은 selector를 증명할 수 없는 경우에는 해당 endpoint의 모든 입력으로 넓힙니다.

이 패키지는 I/O를 수행하지 않고 DB 드라이버나 프론트엔드에 의존하지 않습니다. adapter를 직접 작성하거나 계산기만 별도로 사용하지 않는 일반적인 백엔드 애플리케이션이라면 `@server-driven-impact/runtime`과 DB adapter를 함께 사용하세요.

주요 공개 도구는 다음과 같습니다.

- `calculateImpact()`: `WriteFact` 목록을 바로 `ImpactSet`으로 계산합니다.
- `createImpact()`: 검증된 계산기를 만들며 `calculate()`와 같은 계산 경로를 사용하는 `explain()` 결정 기록도 제공합니다.
- `WriteSet`: transaction 동안 fact를 모으고 snapshot을 만드는 제한된 버퍼입니다.
- `matchesInputSelector()`: 애플리케이션 입력이 target selector와 일치하는지 판정합니다.

프로토콜 1 소비자는 `matchesInputSelector()`를 기준 구현으로 사용해야 합니다. 정확히 같은 JSON scalar뿐 아니라 유한 숫자와 숫자 문자열, SQLite 기본 `NOCASE`·`RTRIM` 비교도 보수적으로 일치시킵니다.
- `canonical()`: 지원되는 JSON 값의 결정적 표현을 만듭니다.

Node.js 22.18 이상이 필요합니다.

WriteSet은 상한을 넘긴 resource부터 요약하고 제한된 크기 안에서 OLD/NEW 공통 scope·field를 보존합니다. selector 개수 상한은 공통 조건을 유지하고, byte 상한은 개별 target부터 확장합니다. `createImpact().command()`는 adapter의 COMMIT·기록 회수 후 계산하며, commit 이후 계산 실패를 endpoint의 `unavailable` 상태로 구분합니다. [의미 명세](../../spec/server-driven-impact/semantics.md).

순수 계산기는 DB를 검증하지 않습니다. manifest 의존성과 변경 사실의 완전성은 호출자·adapter의 책임입니다. runtime adapter가 검증 스냅샷을 고정하고 endpoint별 상태를 반환합니다. 매 command 응답에서 unavailable endpoint를 처리해야 합니다. [endpoint별 impact 변경 안내](../../docs/migrations/endpoint-assessment.md).
