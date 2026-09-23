# 프리앰블 병합 · 타입 추론 · Biome 도입 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PostgreSQL 커맨드·조회의 준비 SQL을 한 번의 왕복으로 합치고, Query 정의에서 입력·출력 타입이 `engine.query()`까지 흐르게 하며, Biome으로 포맷·린트를 고정한다.

**Architecture:** 세 작업은 서로 독립이지만 Biome 포맷을 먼저 적용해 이후 diff가 깨끗하게 남도록 한다. 프리앰블은 순수 함수로 SQL 문자열을 만들어 단위 테스트로 고정하고, 어댑터는 그 문자열을 한 번 보내도록만 바꾼다. 타입 추론은 `Plan<O>`에 phantom 출력 타입을 붙이고 `input`에 Standard Schema를 허용하는 방식으로, 런타임 동작은 파서 정규화 한 곳만 바꾼다.

**Tech Stack:** TypeScript 6.0.3, pnpm 10.33.0, vitest 4.1.7, Biome 2.5.13, postgres.js 3.4.8, node-postgres 8.16.3, `node:sqlite`

**Spec:** 이 문서의 "배경과 결정" 절. 별도 스펙 문서는 없으며 2026-09-13 분석 대화에서 합의한 내용을 아래에 옮겼다.

## Global Constraints

- Node.js `>=22.18`, CI는 Node 24. TypeScript `6.0.3`, pnpm `10.33.0`.
- AGENTS.md: 호환성 유지용 플래그·분기·shim을 추가하지 않는다. 안전 확장(보수적 무효화)은 유지한다.
- `{ data, impact }` 응답 형식과 `ImpactSet` protocol 1은 바꾸지 않는다.
- 런타임 의존성을 추가하지 않는다. Biome은 루트 devDependency로만 추가한다.
- 에러 코드는 기존 관례대로 `new Error('UPPER_SNAKE_CODE')` 또는 `'CODE:detail'` 형식을 따른다.
- 각 Task 끝에서 `pnpm typecheck && pnpm test`를 통과해야 한다. Task 3·4·7은 로컬 PostgreSQL 통합 테스트도 통과해야 한다.
- 작업 브랜치: `feat/preamble-typing-biome` (base `main`). 커밋 메시지는 `feat:`, `fix(postgres):`, `style:`, `docs:` 접두어를 쓴다.

---

## 배경과 결정

### 프리앰블 병합

현재 `packages/sdi-postgres/src/postgres/index.ts`의 커맨드 경로는 업무 SQL 전에 네 번 왕복한다: advisory lock, 임시 collector 테이블 생성 DO 블록, `begin isolation level ...`, `set_config` 두 개. 조회 경로는 lock과 `begin ... read only` 두 번이고, native SQL 플랜마다 `set_config('search_path', ...)`를 다시 보낸다. ORM 벤치마크(`docs/benchmarks/orm-impact-2026-09-10.md`)에서 관찰 커맨드는 SQL 호출 8회, 비관찰은 4회였다.

PostgreSQL 단순 프로토콜은 세미콜론으로 이어진 여러 문장을 한 번에 받는다. postgres.js는 파라미터가 없으면 단순 프로토콜을 쓰고, node-postgres는 `values`가 빈 배열이면 단순 프로토콜을 쓴다. `pg/index.ts`의 브리지는 이미 다중 결과를 평탄화한다.

주의할 PostgreSQL 규칙: 다중 문장은 암묵 트랜잭션 블록에서 실행되며, 그 안에서 `BEGIN`을 만나면 블록이 명시 트랜잭션으로 바뀌지만 이미 스냅샷이 잡힌 뒤라 `begin isolation level repeatable read`가 `SET TRANSACTION ISOLATION LEVEL must be called before any query`로 실패한다. 그래서 `BEGIN` 앞에 `commit`을 넣어 암묵 블록을 먼저 닫는다. 이 `commit`은 서버가 `WARNING 25P01 there is no transaction in progress`를 보내고 postgres.js는 기본 설정에서 이를 콘솔에 출력하므로, 문자열의 첫 문장으로 `set local client_min_messages = error`를 둔다. `SET LOCAL`은 암묵 블록이 `commit`으로 끝나면 자동으로 원래 값으로 돌아간다. lock은 세션 수준이라 commit과 무관하고, 임시 테이블은 `on commit preserve rows`라 유지된다. lock이 `BEGIN`보다 앞서는 기존 순서(마이그레이션 commit 이후 스냅샷 확보)는 그대로다.

2026-09-13에 로컬 PostgreSQL(postgres.js 3.4.8, pg 8.16.3)로 확인한 사실: `commit` 없는 문자열은 repeatable read에서 위 에러로 실패한다. `set local ... error; lock; do; commit; begin isolation level X; select set_config(...)`는 repeatable read, serializable, read committed read only 모두 성공하고, 트랜잭션 안에서 `transaction_isolation`이 요청한 값이며 `client_min_messages`는 `notice`로 복귀했고, notice 콜백에 아무것도 도착하지 않았다. 임시 테이블은 이후 `rollback` 뒤에도 남았다. pg 드라이버는 6개 결과 배열을 돌려주며 브리지가 평탄화한다.

값은 문자열에 직접 넣는다. 토큰은 서버가 만든 UUID이므로 정규식 검증 후 단일 인용 리터럴로, scope는 임의 문자열일 수 있으므로 `standard_conforming_strings` 설정과 무관한 dollar quoting(`$sdi_<토큰hex>$...$sdi_<토큰hex>$`)으로 넣는다.

commit과 collector 회수(`delete ... returning`)는 합치지 않는다. commit 성공 여부가 불확실한 상태를 `CommitStateUnknownError`로 구분하는 로직이 흐려진다.

기대 결과: 커맨드 SQL 호출 8회 → 5회(프리앰블, 업무 SQL, commit, 회수, unlock). 조회는 lock+begin 병합 및 트랜잭션당 search_path 1회.

### 타입 추론

`QueryDefinition`이 `{ input: { parse(value: unknown): unknown }; plan: Plan }`이라 `engine.query()`의 입력은 `unknown`, 반환은 `Promise<unknown>`이다. 두 단계로 고친다.

1. `input`에 Standard Schema v1(`~standard.validate`)을 허용한다. zod, valibot 등이 이 규약을 구현하므로 런타임 의존성 없이 스키마를 직접 넘길 수 있다. `validate`가 Promise를 돌려주는 경우도 `await`로 처리한다. 사양은 작아서 타입을 저장소 안에 복사한다.
2. `Plan<O>`에 phantom 출력 타입을 붙이고 `q.*` 빌더가 출력 타입을 전달한다. `q.select<Row>()`는 `Row[]`, `q.count()`는 `number`, `q.map`은 콜백 반환 타입, `q.combine`은 객체 매핑, `q.when`·`q.choose`는 합집합, `q.bind`는 `C | []`, `q.call`은 `unknown`(명시 제네릭 허용). `engine.query()`는 입력을 스키마의 입력 타입(Standard Schema) 또는 `parse` 반환 타입으로, 반환을 플랜 출력 타입으로 추론한다.

리소스 컬럼에서 행 타입을 자동 유도하는 것은 이번 범위 밖이다.

### Biome

포매터·린터가 없어 일부 파일이 한 줄에 여러 문장을 붙인 압축 스타일이다. Biome 2.5.13 하나로 포맷과 린트를 도입한다. 전체 포맷 커밋은 기능 변경과 분리하고 `.git-blame-ignore-revs`에 기록한다. 대상은 TypeScript 소스·테스트·예제와 `scripts/**/*.mjs`로 한정하고 JSON·Markdown은 건드리지 않는다. 템플릿 리터럴 내부(SQL)는 Biome이 바꾸지 않으므로 생성 SQL과 fingerprint는 영향이 없다.

---

## 파일 구조

| 파일 | 역할 | 작업 |
| --- | --- | --- |
| `biome.json` | 포맷·린트 설정 | 생성 (Task 1) |
| `.git-blame-ignore-revs` | 포맷 커밋 해시 | 생성 (Task 1) |
| `package.json` | `lint`/`format` 스크립트, Biome devDependency | 수정 (Task 1) |
| `.github/workflows/ci.yml` | `biome ci` 단계 | 수정 (Task 1) |
| `packages/sdi-postgres/src/postgres/sql.ts` | `literal()` 추가 | 수정 (Task 2) |
| `packages/sdi-postgres/src/postgres/observer.ts` | 자체 `literal` 제거, sql.ts 것을 import | 수정 (Task 2) |
| `packages/sdi-postgres/src/postgres/session.ts` | `lockKeys` export, `lockSession` 제거 | 수정 (Task 2, 4) |
| `packages/sdi-postgres/src/postgres/preamble.ts` | 프리앰블 SQL 순수 빌더 | 생성 (Task 2) |
| `packages/sdi-postgres/src/postgres/index.ts` | 커맨드·조회 경로에서 프리앰블 1회 호출, search_path 1회 | 수정 (Task 3, 4) |
| `tests/server-driven-impact/postgres-preamble.test.ts` | 프리앰블 문자열 검증 | 생성 (Task 2) |
| `tests/server-driven-impact/postgres-round-trips.test.ts` | 가짜 세션으로 SQL 호출 횟수·순서 검증 | 생성 (Task 3, 4) |
| `packages/sdi-runtime/src/query/input.ts` | `Input`, Standard Schema 타입, `toParse()` | 생성 (Task 5) |
| `packages/sdi-runtime/src/query/plan.ts` | `Plan<O>`, `QueryDefinition<S,P>`, `q` 제네릭, `executePlan` await | 수정 (Task 5, 6) |
| `packages/sdi-runtime/src/query/index.ts` | 타입 re-export, `defineQueries` 제약 | 수정 (Task 5, 6) |
| `packages/sdi-runtime/src/runtime/index.ts` | 파서 정규화, `query`/`queryUncached` 시그니처 | 수정 (Task 5, 6) |
| `packages/sdi-runtime/src/index.ts` | 새 타입 export | 수정 (Task 5, 6) |
| `tests/server-driven-impact/query-input-schema.test.ts` | Standard Schema 런타임 동작 | 생성 (Task 5) |
| `tests/server-driven-impact/typed-queries.test.ts` | 타입 추론(`expectTypeOf`, `@ts-expect-error`) | 생성 (Task 6) |
| `README.md`, `README.ko.md` | Queries·Development 절 갱신 | 수정 (Task 7) |
| `.changeset/pre/preamble-typed-queries.md` | 릴리스 노트 | 생성 (Task 7) |

---

## 로컬 PostgreSQL 준비 (Task 3, 4, 7에서 사용)

통합 테스트는 `SDI_POSTGRES_*` 환경변수가 없으면 스킵된다. 아래로 격리된 컨테이너를 띄운다.

```bash
docker run --detach --name sdi-pg --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_PASSWORD=sdi --env POSTGRES_DB=sdi postgres:18.6
until docker exec sdi-pg pg_isready -U postgres -d sdi >/dev/null 2>&1; do sleep 1; done
docker exec sdi-pg psql -U postgres -d sdi -v ON_ERROR_STOP=1 \
  -c "create role routine_runtime login password 'runtime' nobypassrls"
```

실행(빌드가 먼저 필요하다. `test:postgres` 스크립트는 빌드하지 않는다):

```bash
pnpm build
export SDI_POSTGRES_ADMIN_URL=postgresql://postgres:sdi@127.0.0.1:55432/sdi
export SDI_POSTGRES_RUNTIME_URL=postgresql://routine_runtime:runtime@127.0.0.1:55432/sdi
export SDI_POSTGRES_MAJOR=18
SDI_POSTGRES_DRIVER=postgres pnpm test:postgres
SDI_POSTGRES_DRIVER=pg pnpm test:postgres
```

정리: `docker rm --force --volumes sdi-pg`

---

### Task 1: Biome 도입과 전체 포맷

**Files:**
- Create: `biome.json`, `.git-blame-ignore-revs`
- Modify: `package.json` (scripts, devDependencies), `.github/workflows/ci.yml`, `README.md:218-225`, `README.ko.md:216-223`

**Interfaces:**
- Produces: `pnpm lint` (검사), `pnpm lint:fix` (안전 수정 적용), `pnpm format` (포맷만). 이후 모든 Task는 커밋 전 `pnpm lint`가 0 에러여야 한다.

- [ ] **Step 1: 브랜치 생성과 Biome 설치**

```bash
git checkout -b feat/preamble-typing-biome main
pnpm add -D -w @biomejs/biome@2.5.13
```

- [ ] **Step 2: `biome.json` 작성**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.13/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "includes": [
      "packages/*/src/**/*.ts",
      "tests/**/*.ts",
      "examples/**/*.ts",
      "scripts/**/*.mjs",
      "sdi.vitest.config.ts"
    ]
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all", "arrowParentheses": "asNeeded" }
  },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "assist": { "actions": { "source": { "organizeImports": "off" } } }
}
```

- [ ] **Step 3: `package.json` 스크립트 추가**

`"scripts"` 블록의 `"changeset"` 바로 아래에 추가:

```json
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
```

- [ ] **Step 4: 포맷만 적용하고 기존 검사 통과 확인**

```bash
pnpm format
pnpm typecheck && pnpm test && pnpm pack:check
```

Expected: 포맷으로 다수 파일이 바뀌고, typecheck·test(153 passed, 68 skipped)·pack:check가 모두 통과한다. 실패하면 포맷이 의미를 바꾼 곳이므로 해당 파일을 `git diff`로 확인하고 원인을 고친다(템플릿 리터럴 밖의 코드만 바뀌어야 한다).

- [ ] **Step 5: 포맷 전용 커밋과 blame 무시 등록**

```bash
git add -A
git commit -m "style: apply biome formatting"
git rev-parse HEAD > .git-blame-ignore-revs
git config blame.ignoreRevsFile .git-blame-ignore-revs
git add .git-blame-ignore-revs
git commit -m "chore: ignore formatting commit in blame"
```

- [ ] **Step 6: 린트 실행과 규칙 조정**

```bash
pnpm exec biome lint . 2>&1 | tail -40
pnpm exec biome lint . --reporter=summary 2>&1 | tail -40
```

규칙별 건수를 보고 다음을 적용한다.
- 안전 자동 수정으로 사라지는 항목: `pnpm lint:fix`.
- `suspicious/noExplicitAny`, `suspicious/noAssignInExpressions`처럼 기존 설계(`Json = Record<string, any>`, `execution ??= ...`)에 의도적으로 쓰인 규칙과 그 밖에 건수가 10건을 넘는 규칙은 `biome.json`의 `linter.rules`에 `"off"`로 명시한다. 예:

```json
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "off", "noAssignInExpressions": "off" }
    }
  }
```

- 10건 이하 규칙은 코드에서 고친다. 동작을 바꾸는 수정은 하지 않는다. 판단이 어려우면 해당 줄에 `// biome-ignore lint/<group>/<rule>: <이유>`를 붙인다.

- [ ] **Step 7: 린트 0 에러 확인 후 커밋**

```bash
pnpm lint
pnpm typecheck && pnpm test
git add -A
git commit -m "chore: add biome lint configuration"
```

Expected: `Checked N files ... No fixes applied` 또는 에러 0건.

- [ ] **Step 8: CI 단계와 문서 추가**

`.github/workflows/ci.yml`의 `- run: pnpm install --frozen-lockfile` 다음 줄에 추가:

```yaml
      - run: pnpm exec biome ci .
```

`README.md`의 `## Development` 코드 블록과 `README.ko.md`의 `## 개발` 코드 블록에 `pnpm lint` 한 줄을 `pnpm typecheck` 앞에 추가:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm pack:check
```

```bash
git add .github/workflows/ci.yml README.md README.ko.md
git commit -m "ci: run biome in verify job"
```

---

### Task 2: 프리앰블 SQL 빌더

**Files:**
- Create: `packages/sdi-postgres/src/postgres/preamble.ts`
- Modify: `packages/sdi-postgres/src/postgres/sql.ts` (`literal` 추가), `packages/sdi-postgres/src/postgres/observer.ts:30` (자체 `literal` 삭제 후 import), `packages/sdi-postgres/src/postgres/session.ts:4` (`lockKeys` export)
- Test: `tests/server-driven-impact/postgres-preamble.test.ts`

**Interfaces:**
- Produces:
  - `literal(value: string): string` in `sql.ts`. 단일 인용 이스케이프, NUL 포함 시 `INVALID_LITERAL`.
  - `export const lockKeys: readonly [number, number]` in `session.ts` (값 `0x534449, 0x5047`, 십진 `5456969, 20551`).
  - `preamble.ts`: `ISOLATION_LEVELS`, `type IsolationLevel`, `quietCommitSql: string` (`set local client_min_messages = error`), `sessionLockSql: string`, `collectorTableSql: string`, `readPreambleSql(isolationLevel: IsolationLevel): string`, `commandPreambleSql(options: { isolationLevel: IsolationLevel; token: string; scope: Scalar }): string`.
  - 커맨드 프리앰블 문장 순서: `set local`, lock, DO, `commit`, `begin`, `set_config` (6개). 읽기 프리앰블: `set local`, lock, `commit`, `begin ... read only` (4개).

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/server-driven-impact/postgres-preamble.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  commandPreambleSql,
  ISOLATION_LEVELS,
  readPreambleSql,
  sessionLockSql,
} from '../../packages/sdi-postgres/src/postgres/preamble.js';
import { lockKeys } from '../../packages/sdi-postgres/src/postgres/session.js';
import { literal } from '../../packages/sdi-postgres/src/postgres/sql.js';

const token = '0f1e2d3c-4b5a-4678-9abc-def012345678';
const tag = '$sdi_0f1e2d3c4b5a46789abcdef012345678$';

describe('PostgreSQL preamble SQL', () => {
  it('escapes single-quoted literals and rejects NUL bytes', () => {
    expect(literal("it's")).toBe("'it''s'");
    expect(() => literal('a\0b')).toThrow('INVALID_LITERAL');
  });

  it('inlines the session lock keys as decimal constants', () => {
    expect(lockKeys).toEqual([0x534449, 0x5047]);
    expect(sessionLockSql).toBe('select pg_advisory_lock_shared(5456969,20551)');
  });

  it('orders quiet, lock, collector table, commit, begin, and request settings in one string', () => {
    const statements = commandPreambleSql({ isolationLevel: 'repeatable read', token, scope: "tenant'a" }).split(';\n');
    expect(statements).toHaveLength(6);
    expect(statements[0]).toBe('set local client_min_messages = error');
    expect(statements[1]).toBe(sessionLockSql);
    expect(statements[2]).toMatch(/^do \$sdi\$ begin if to_regclass\('pg_temp\.sdi_observed_facts'\) is null then create temporary table sdi_observed_facts\(/);
    expect(statements[2]).toMatch(/on commit preserve rows; end if; end \$sdi\$$/);
    expect(statements[3]).toBe('commit');
    expect(statements[4]).toBe('begin isolation level repeatable read');
    expect(statements[5]).toBe(
      `select set_config('sdi.request_token','${token}',true),set_config('sdi.scope',${tag}tenant'a${tag},true)`,
    );
  });

  it('stringifies non-string scopes exactly like String()', () => {
    expect(commandPreambleSql({ isolationLevel: 'read committed', token, scope: 42 })).toContain(`${tag}42${tag}`);
    expect(commandPreambleSql({ isolationLevel: 'read committed', token, scope: null })).toContain(`${tag}null${tag}`);
    expect(commandPreambleSql({ isolationLevel: 'read committed', token, scope: true })).toContain(`${tag}true${tag}`);
  });

  it('rejects unknown isolation levels, malformed tokens, and scopes containing the quote tag', () => {
    expect(() => commandPreambleSql({ isolationLevel: 'snapshot' as never, token, scope: 'a' })).toThrow('INVALID_ISOLATION_LEVEL');
    expect(() => commandPreambleSql({ isolationLevel: 'read committed', token: "x'; drop table t; --", scope: 'a' })).toThrow('INVALID_REQUEST_TOKEN');
    expect(() => commandPreambleSql({ isolationLevel: 'read committed', token, scope: `a${tag}b` })).toThrow('INVALID_SCOPE_LITERAL');
    expect(() => commandPreambleSql({ isolationLevel: 'read committed', token, scope: 'a\0b' })).toThrow('INVALID_SCOPE_LITERAL');
    expect(() => readPreambleSql('serializable read only' as never)).toThrow('INVALID_ISOLATION_LEVEL');
    expect(ISOLATION_LEVELS).toEqual(['read uncommitted', 'read committed', 'repeatable read', 'serializable']);
  });

  it('builds the read-only preamble with the same quiet-lock-commit-begin order', () => {
    expect(readPreambleSql('read committed')).toBe(
      'set local client_min_messages = error;\nselect pg_advisory_lock_shared(5456969,20551);\ncommit;\nbegin isolation level read committed read only',
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm exec vitest run --config sdi.vitest.config.ts tests/server-driven-impact/postgres-preamble.test.ts
```

Expected: FAIL. `preamble.js` 모듈을 찾을 수 없고 `literal`, `lockKeys`가 export되지 않는다.

- [ ] **Step 3: `sql.ts`에 `literal` 추가**

`packages/sdi-postgres/src/postgres/sql.ts` 끝에 추가:

```ts
/** Single-quoted SQL literal. Only for trusted server-generated values that must be inlined. */
export function literal(value: string): string {
  if (value.includes('\0')) throw new Error('INVALID_LITERAL');
  return `'${value.replaceAll("'", "''")}'`;
}
```

- [ ] **Step 4: `observer.ts`의 자체 `literal`을 제거하고 import**

`packages/sdi-postgres/src/postgres/observer.ts`에서

```ts
function literal(value:string):string { return `'${value.replaceAll("'","''")}'`; }
```

줄을 삭제하고, 파일 상단 import에 추가:

```ts
import { literal } from './sql.js';
```

(포맷 적용 후라면 원래 줄의 공백 배치가 다를 수 있다. `function literal(` 로 검색해 그 함수 정의 전체를 지운다.)

- [ ] **Step 5: `session.ts`의 `lockKeys` export**

```ts
const lockKeys = [0x534449,0x5047];
```

를

```ts
export const lockKeys = [0x534449, 0x5047] as const;
```

로 바꾼다. postgres.js의 `unsafe` 시그니처는 가변 배열을 받으므로 `lockSession`/`releaseSession` 안의 두 호출을 `session.unsafe('...($1,$2)', [...lockKeys])`로 바꾼다.

- [ ] **Step 6: `preamble.ts` 작성**

```ts
import type { Scalar } from '@server-driven-impact/core';
import { observerInternals } from './observer.js';
import { lockKeys } from './session.js';
import { literal } from './sql.js';

export const ISOLATION_LEVELS = Object.freeze([
  'read uncommitted',
  'read committed',
  'repeatable read',
  'serializable',
] as const);
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertIsolationLevel(level: string): asserts level is IsolationLevel {
  if (!ISOLATION_LEVELS.includes(level as IsolationLevel)) throw new Error('INVALID_ISOLATION_LEVEL');
}

/**
 * The multi-statement string starts in an implicit transaction block; the `commit` that closes it
 * raises WARNING 25P01. SET LOCAL silences it and reverts when that block ends.
 */
export const quietCommitSql = 'set local client_min_messages = error';

/** Session-level lock taken before BEGIN so the transaction snapshot follows any migration commit. */
export const sessionLockSql = `select pg_advisory_lock_shared(${lockKeys[0]},${lockKeys[1]})`;

/** Per-session collector; `on commit preserve rows` keeps it across commands on the same backend. */
export const collectorTableSql =
  `do $sdi$ begin if to_regclass('pg_temp.${observerInternals.collectorTable}') is null then ` +
  `create temporary table ${observerInternals.collectorTable}(` +
  'token text not null,resource text not null,operation text not null,' +
  'before_state jsonb not null,after_state jsonb not null,changed_columns jsonb' +
  ') on commit preserve rows; end if; end $sdi$';

/**
 * One simple-protocol round trip. The `commit` closes the implicit multi-statement
 * transaction block; otherwise BEGIN could not change the isolation level.
 */
export function readPreambleSql(isolationLevel: IsolationLevel): string {
  assertIsolationLevel(isolationLevel);
  return [quietCommitSql, sessionLockSql, 'commit', `begin isolation level ${isolationLevel} read only`].join(';\n');
}

export function commandPreambleSql(options: { isolationLevel: IsolationLevel; token: string; scope: Scalar }): string {
  assertIsolationLevel(options.isolationLevel);
  if (!TOKEN.test(options.token)) throw new Error('INVALID_REQUEST_TOKEN');
  const tag = `$sdi_${options.token.replaceAll('-', '')}$`;
  const scope = String(options.scope);
  if (scope.includes(tag) || scope.includes('\0')) throw new Error('INVALID_SCOPE_LITERAL');
  return [
    quietCommitSql,
    sessionLockSql,
    collectorTableSql,
    'commit',
    `begin isolation level ${options.isolationLevel}`,
    `select set_config('sdi.request_token',${literal(options.token)},true),set_config('sdi.scope',${tag}${scope}${tag},true)`,
  ].join(';\n');
}
```

- [ ] **Step 7: 테스트 통과 확인**

```bash
pnpm build
pnpm exec vitest run --config sdi.vitest.config.ts tests/server-driven-impact/postgres-preamble.test.ts
```

Expected: 6 passed.

- [ ] **Step 8: 전체 검사 후 커밋**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/sdi-postgres/src/postgres/preamble.ts packages/sdi-postgres/src/postgres/sql.ts packages/sdi-postgres/src/postgres/observer.ts packages/sdi-postgres/src/postgres/session.ts tests/server-driven-impact/postgres-preamble.test.ts
git commit -m "feat(postgres): add single round-trip preamble SQL builders"
```

---

### Task 3: 커맨드 경로에서 프리앰블 1회 호출

**Files:**
- Modify: `packages/sdi-postgres/src/postgres/index.ts` (adapter 옵션 검증, `command()` 준비 구간)
- Test: `tests/server-driven-impact/postgres-round-trips.test.ts`

**Interfaces:**
- Consumes: `commandPreambleSql`, `ISOLATION_LEVELS`, `IsolationLevel` from `./preamble.js`.
- Produces: 커맨드 한 번의 `session.unsafe` 호출 순서가 `[프리앰블, (업무 SQL...), 'commit', 'delete from pg_temp.sdi_observed_facts ...', 'select pg_advisory_unlock_shared($1,$2)']`가 된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/server-driven-impact/postgres-round-trips.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { WriteSet } from '@server-driven-impact/core';
import { postgresAdapter } from '@server-driven-impact/postgres';
import { bindAdapter, type QueryManifest, type Resources } from '@server-driven-impact/runtime/adapter';

const resources: Resources = { rows: { table: 'rows', idColumn: 'id', scopeColumn: null, columns: ['id'] } };
const manifest: QueryManifest = {
  reads: { list: [{ resource: 'rows', columns: '*', bindings: [] }] },
};

export function fakeDatabase() {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  const session = {
    unsafe: vi.fn(async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      return [];
    }),
    release: vi.fn(),
  };
  const database = { begin: async () => undefined, reserve: async () => session };
  return { calls, session, database };
}
export function bound(database: unknown) {
  return postgresAdapter({ database: database as never })[bindAdapter](resources, manifest);
}

describe('PostgreSQL adapter round trips', () => {
  it('runs an empty command as preamble, commit, drain, and unlock', async () => {
    const { calls, session, database } = fakeDatabase();
    const data = await bound(database).command('tenant-a', new WriteSet(new Set(['rows'])), async () => 'saved');
    expect(data).toBe('saved');
    const texts = calls.map(call => call.text);
    expect(texts).toHaveLength(4);
    expect(texts[0].split(';\n').map(statement => statement.split(' ')[0])).toEqual(['set', 'select', 'do', 'commit', 'begin', 'select']);
    expect(texts[0]).toContain('begin isolation level repeatable read');
    expect(texts[0]).toContain("set_config('sdi.request_token'");
    expect(texts[0]).toContain('$tenant-a$');
    expect(calls[0].values).toBeUndefined();
    expect(texts[1]).toBe('commit');
    expect(texts[2]).toMatch(/^delete from pg_temp\.sdi_observed_facts where token=\$1 returning /);
    expect(texts[3]).toBe('select pg_advisory_unlock_shared($1,$2)');
    const token = /'sdi\.request_token','([0-9a-f-]{36})'/.exec(texts[0])?.[1];
    expect(token).toBeDefined();
    expect(calls[2].values).toEqual([token]);
    expect(session.release).toHaveBeenCalledOnce();
  });

  it('keeps business statements between the preamble and commit', async () => {
    const { calls, database } = fakeDatabase();
    await bound(database).command('tenant-a', new WriteSet(new Set(['rows'])), async db => {
      await db.unsafe('update rows set id=id');
    });
    const texts = calls.map(call => call.text);
    expect(texts).toHaveLength(5);
    expect(texts[1]).toBe('update rows set id=id');
    expect(texts[2]).toBe('commit');
  });

  it('honors a configured isolation level inside the preamble', async () => {
    const { calls, database } = fakeDatabase();
    const adapter = postgresAdapter({ database: database as never, isolationLevel: 'read committed' })[bindAdapter](resources, manifest);
    await adapter.command(null, new WriteSet(new Set(['rows'])), async () => undefined);
    expect(calls[0].text).toContain('begin isolation level read committed');
    expect(calls[0].text).toContain('$null$');
    expect(() => postgresAdapter({ database: database as never, isolationLevel: 'snapshot' as never })).toThrow('INVALID_ISOLATION_LEVEL');
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm exec vitest run --config sdi.vitest.config.ts tests/server-driven-impact/postgres-round-trips.test.ts
```

Expected: FAIL. 첫 테스트에서 `texts`가 7개(lock, do, begin, set_config, commit, drain, unlock)라 `toHaveLength(4)`에 실패한다.

- [ ] **Step 3: `index.ts` 수정**

import 추가:

```ts
import { commandPreambleSql, ISOLATION_LEVELS, type IsolationLevel } from './preamble.js';
```

`postgresAdapter()` 시작부의 isolation 검증 두 줄

```ts
  const isolationLevel=options.isolationLevel ?? 'repeatable read';
  ...
  if (!['read uncommitted','read committed','repeatable read','serializable'].includes(isolationLevel)) throw new Error('INVALID_ISOLATION_LEVEL');
```

를

```ts
  const isolationLevel = (options.isolationLevel ?? 'repeatable read') as IsolationLevel;
  if (!ISOLATION_LEVELS.includes(isolationLevel)) throw new Error('INVALID_ISOLATION_LEVEL');
```

로 바꾼다(`connectionMode` 검사는 그대로 둔다).

`command()` 안의 준비 구간

```ts
            await lockSession(session);
            await session.unsafe(`do $sdi$
              begin
                if to_regclass('pg_temp.${observerInternals.collectorTable}') is null then
                  create temporary table ${observerInternals.collectorTable}(
                    token text not null,resource text not null,operation text not null,
                    before_state jsonb not null,after_state jsonb not null,changed_columns jsonb
                  ) on commit preserve rows;
                end if;
              end
            $sdi$`);
            await session.unsafe(`begin isolation level ${isolationLevel}`);
            await session.unsafe("select set_config('sdi.request_token',$1,true),set_config('sdi.scope',$2,true)",[token,String(scope)]);
```

를 한 줄로 바꾼다:

```ts
            await session.unsafe(commandPreambleSql({ isolationLevel, token, scope }));
```

- [ ] **Step 4: 단위 테스트 통과 확인**

```bash
pnpm build
pnpm exec vitest run --config sdi.vitest.config.ts tests/server-driven-impact/postgres-round-trips.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: 실제 PostgreSQL로 통합 테스트**

"로컬 PostgreSQL 준비" 절대로 컨테이너를 띄운 뒤:

```bash
pnpm build
SDI_POSTGRES_DRIVER=postgres pnpm test:postgres
SDI_POSTGRES_DRIVER=pg pnpm test:postgres
```

Expected: 두 드라이버 모두 스킵 0, 실패 0. 콘솔에 `there is no transaction in progress` 경고가 보이면 `quietCommitSql`이 첫 문장인지 확인한다. `SET TRANSACTION ISOLATION LEVEL must be called before any query`가 나오면 프리앰블의 `commit` 순서를 확인한다. `cannot insert multiple commands into a prepared statement`가 나오면 `unsafe`에 빈 값 배열 대신 `undefined`가 아닌 파라미터가 넘어간 것이니 호출부에 values를 넘기지 않았는지 확인한다.

- [ ] **Step 6: 커밋**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/sdi-postgres/src/postgres/index.ts tests/server-driven-impact/postgres-round-trips.test.ts
git commit -m "feat(postgres): send the command preamble in one round trip"
```

---

### Task 4: 조회 경로 프리앰블과 search_path 1회

**Files:**
- Modify: `packages/sdi-postgres/src/postgres/index.ts` (`readTransaction`, `query()`), `packages/sdi-postgres/src/postgres/session.ts` (`lockSession` 삭제)
- Test: `tests/server-driven-impact/postgres-round-trips.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: `readPreambleSql` from `./preamble.js`.
- Produces: 조회 트랜잭션의 호출 순서 `[읽기 프리앰블, (setup), (role 확인), search_path 최초 1회, 쿼리..., 'commit', unlock]`. `session.ts`에서 `lockSession`이 사라지고 `lockKeys`, `releaseSession`, `ReservedSession`만 남는다.

- [ ] **Step 1: 실패하는 테스트 추가**

`postgres-round-trips.test.ts`의 `describe` 블록 안에 추가:

```ts
  it('runs a query transaction with one preamble and sets search_path once', async () => {
    const { calls, database } = fakeDatabase();
    const plan: PostgresQueryPlan = { kind: 'postgres-query', text: 'select 1', parameters: [], reads: [], searchPath: ['public'] };
    await bound(database).query('tenant-a', async select => {
      await select(plan, {});
      await select(plan, {});
      return undefined;
    });
    expect(calls.map(call => call.text)).toEqual([
      'set local client_min_messages = error;\nselect pg_advisory_lock_shared(5456969,20551);\ncommit;\nbegin isolation level repeatable read read only',
      "select set_config('search_path',$1,true)",
      'select 1',
      'select 1',
      'commit',
      'select pg_advisory_unlock_shared($1,$2)',
    ]);
    expect(calls[1].values).toEqual(['"public"']);
  });

  it('re-sends search_path only when a plan uses a different one', async () => {
    const { calls, database } = fakeDatabase();
    const first: PostgresQueryPlan = { kind: 'postgres-query', text: 'select 1', parameters: [], reads: [], searchPath: ['public'] };
    const second: PostgresQueryPlan = { kind: 'postgres-query', text: 'select 2', parameters: [], reads: [], searchPath: ['app', 'public'] };
    await bound(database).query('tenant-a', async select => {
      await select(first, {});
      await select(second, {});
      await select(first, {});
      return undefined;
    });
    expect(calls.map(call => call.text).filter(text => text.startsWith("select set_config('search_path'"))).toHaveLength(3);
    expect(calls.filter(call => call.text.startsWith("select set_config('search_path'")).map(call => call.values)).toEqual([
      ['"public"'],
      ['"app","public"'],
      ['"public"'],
    ]);
  });
```

파일 상단 import에 추가:

```ts
import type { PostgresQueryPlan } from '@server-driven-impact/runtime';
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm exec vitest run --config sdi.vitest.config.ts tests/server-driven-impact/postgres-round-trips.test.ts
```

Expected: 첫 새 테스트 FAIL. 실제 호출은 `['select pg_advisory_lock_shared($1,$2)', 'begin isolation level repeatable read read only', set_config, 'select 1', set_config, 'select 1', 'commit', unlock]` 8개다. (Task 2에서 `lockSession`이 `[...lockKeys]`를 넘기도록 바뀌었어도 SQL 텍스트는 같다.)

- [ ] **Step 3: `readTransaction` 수정**

`index.ts`의

```ts
          await lockSession(session);
          await session.unsafe(`begin isolation level ${isolationLevel} read only`);
```

를

```ts
          await session.unsafe(readPreambleSql(isolationLevel));
```

로 바꾸고 import를 갱신한다:

```ts
import { commandPreambleSql, ISOLATION_LEVELS, readPreambleSql, type IsolationLevel } from './preamble.js';
import { releaseSession } from './session.js';
```

(`lockSession` import 제거.)

- [ ] **Step 4: `query()`의 search_path를 트랜잭션당 1회로**

`query()` 안의

```ts
            const data = await work(async (plan, input) => {
              if (plan.kind === 'postgres-query') {
                if(plan.searchPath)await tx.unsafe("select set_config('search_path',$1,true)",[plan.searchPath.map(schema=>'"'+schema.replaceAll('"','""')+'"').join(',')]);
                return [...await tx.unsafe(plan.text,plan.parameters.map(field => input[field]) as never[])];
              }
```

를

```ts
            let currentSearchPath: string | undefined;
            const data = await work(async (plan, input) => {
              if (plan.kind === 'postgres-query') {
                if (plan.searchPath) {
                  const searchPath = plan.searchPath.map(schema => `"${schema.replaceAll('"', '""')}"`).join(',');
                  if (searchPath !== currentSearchPath) {
                    await tx.unsafe("select set_config('search_path',$1,true)", [searchPath]);
                    currentSearchPath = searchPath;
                  }
                }
                return [...(await tx.unsafe(plan.text, plan.parameters.map(field => input[field]) as never[]))];
              }
```

로 바꾼다. `currentSearchPath`는 `readTransaction` 콜백 안(트랜잭션 범위)에 선언한다. `setup` 콜백은 첫 플랜 실행 전에 이미 끝났으므로 첫 플랜은 항상 설정을 보내고, 이전과 동일한 우선순위를 유지한다.

- [ ] **Step 5: `session.ts`에서 `lockSession` 삭제**

```ts
/** A session lock precedes BEGIN so a waiting request cannot retain an old catalog snapshot. */
export async function lockSession(session: ReservedSession) {
  await session.unsafe('select pg_advisory_lock_shared($1,$2)',lockKeys);
}
```

를 삭제한다. 주석의 의도는 `preamble.ts`의 `sessionLockSql` 주석이 이어받는다.

```bash
grep -rn "lockSession" packages tests
```

Expected: 출력 없음.

- [ ] **Step 6: 단위·통합 테스트**

```bash
pnpm build
pnpm exec vitest run --config sdi.vitest.config.ts tests/server-driven-impact/postgres-round-trips.test.ts
SDI_POSTGRES_DRIVER=postgres pnpm test:postgres
SDI_POSTGRES_DRIVER=pg pnpm test:postgres
```

Expected: 라운드트립 테스트 5 passed, 통합 테스트 두 드라이버 모두 스킵 0·실패 0.

- [ ] **Step 7: 커밋**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/sdi-postgres/src/postgres/index.ts packages/sdi-postgres/src/postgres/session.ts tests/server-driven-impact/postgres-round-trips.test.ts
git commit -m "feat(postgres): merge the read preamble and set search_path once per transaction"
```

---

### Task 5: Standard Schema 입력 지원

**Files:**
- Create: `packages/sdi-runtime/src/query/input.ts`
- Modify: `packages/sdi-runtime/src/query/plan.ts` (`Input` 이동, `QueryDefinition.input`, `executePlan` call 분기), `packages/sdi-runtime/src/query/index.ts`, `packages/sdi-runtime/src/runtime/index.ts` (`createImpact` 정규화, `parseInput`), `packages/sdi-runtime/src/index.ts`
- Test: `tests/server-driven-impact/query-input-schema.test.ts`

**Interfaces:**
- Produces (`input.ts`):
  - `type Input = Record<string, unknown>`
  - `interface StandardSchemaV1<In = unknown, Out = In>`, `type StandardResult<Out>`, `type StandardIssue`
  - `interface InputParser<Out> { parse(value: unknown): Out | Promise<Out> }`
  - `type InputSchema<In = unknown, Out = Input> = InputParser<Out> | StandardSchemaV1<In, Out>`
  - `type InputOf<S>`: Standard Schema면 `In`, parser면 `Awaited<Out>`
  - `type ParsedInputOf<S>`: 정규화 후 출력 타입
  - `isStandardSchema(value: unknown): value is StandardSchemaV1`
  - `toParse(schema: InputSchema<any, any>): (value: unknown) => unknown | Promise<unknown>` — 잘못된 형태면 `INVALID_QUERY_DEFINITION`, 검증 실패면 `INVALID_QUERY_INPUT:<messages>` (`cause`에 issues)
- Task 6이 `QueryDefinition`의 두 번째 제네릭(플랜)을 추가한다. 이 Task에서는 첫 제네릭만 도입한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/server-driven-impact/query-input-schema.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createImpact, defineQueries, q, type Resources, type StandardSchemaV1 } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

const resources: Resources = {
  todos: { table: 'todos', idColumn: 'id', scopeColumn: 'account_id', columns: ['id', 'account_id', 'status'] },
};
const statusSchema: StandardSchemaV1<{ status: string }, { status: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value => {
      const status = (value as { status?: unknown } | null)?.status;
      return typeof status === 'string' ? { value: { status } } : { issues: [{ message: 'status must be a string' }] };
    },
  },
};
const asyncSchema: StandardSchemaV1<{ status: string }, { status: string }> = {
  '~standard': { version: 1, vendor: 'test', validate: async value => statusSchema['~standard'].validate(value) },
};
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('pragma foreign_keys=on; create table todos(id text primary key, account_id text not null, status text not null)');
  database.exec("insert into todos values('t1','a','open'),('t2','a','done')");
  const queries = defineQueries({
    'todos.byStatus': { input: statusSchema, plan: q.select('todos', { columns: ['id'], where: [q.eq('status', q.input('status'))], order: [{ field: 'id' }] }) },
    'todos.byStatusAsync': { input: asyncSchema, plan: q.select('todos', { columns: ['id'], where: [q.eq('status', q.input('status'))] }) },
    'todos.viaCall': { input: statusSchema, plan: q.call('todos.byStatus') },
    'todos.legacy': { input: { parse: (value: unknown) => value as { status: string } }, plan: q.call('todos.byStatus') },
  });
  return createImpact({ resources, queries, adapter: sqliteAdapter({ database }) });
}
const context = { scope: 'a' };

describe('Standard Schema query inputs', () => {
  it('validates with a synchronous standard schema', async () => {
    expect(await fixture().query('todos.byStatus', { status: 'open' }, context)).toEqual([{ id: 't1' }]);
  });
  it('rejects issues with the input error code and keeps issues as the cause', async () => {
    await expect(fixture().query('todos.byStatus', { status: 1 }, context)).rejects.toMatchObject({
      message: 'INVALID_QUERY_INPUT:status must be a string',
      cause: [{ message: 'status must be a string' }],
    });
  });
  it('awaits asynchronous validation', async () => {
    expect(await fixture().query('todos.byStatusAsync', { status: 'done' }, context)).toEqual([{ id: 't2' }]);
  });
  it('parses through q.call for both schema styles', async () => {
    const engine = fixture();
    expect(await engine.query('todos.viaCall', { status: 'open' }, context)).toEqual([{ id: 't1' }]);
    expect(await engine.query('todos.legacy', { status: 'done' }, context)).toEqual([{ id: 't2' }]);
  });
  it('still rejects definitions without a parser or standard schema', () => {
    expect(() =>
      createImpact({
        resources,
        queries: { broken: { input: {} as never, plan: q.select('todos') } },
        adapter: sqliteAdapter({ database: new DatabaseSync(':memory:') }),
      }),
    ).toThrow('INVALID_QUERY_DEFINITION');
    expect(() =>
      createImpact({
        resources,
        queries: { broken: { input: { '~standard': { version: 2, vendor: 'x', validate: () => ({ value: {} }) } } as never, plan: q.select('todos') } },
        adapter: sqliteAdapter({ database: new DatabaseSync(':memory:') }),
      }),
    ).toThrow('UNSUPPORTED_INPUT_SCHEMA_VERSION');
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm exec vitest run --config sdi.vitest.config.ts tests/server-driven-impact/query-input-schema.test.ts
```

Expected: FAIL. `StandardSchemaV1` export가 없고, 런타임은 `query.input.parse`가 함수가 아니라며 `INVALID_QUERY_DEFINITION`을 던진다.

- [ ] **Step 3: `input.ts` 작성**

```ts
export type Input = Record<string, unknown>;

/** Minimal Standard Schema v1 surface (standardschema.dev), copied so no runtime dependency is needed. */
export interface StandardSchemaV1<In = unknown, Out = In> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Out> | Promise<StandardResult<Out>>;
    readonly types?: { readonly input: In; readonly output: Out };
  };
}
export type StandardIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
};
export type StandardResult<Out> =
  | { readonly value: Out; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

export interface InputParser<Out> {
  parse(value: unknown): Out | Promise<Out>;
}
export type InputSchema<In = unknown, Out = Input> = InputParser<Out> | StandardSchemaV1<In, Out>;
export type InputOf<S> = S extends StandardSchemaV1<infer In, any> ? In : S extends InputParser<infer Out> ? Awaited<Out> : never;
export type ParsedInputOf<S> = S extends StandardSchemaV1<any, infer Out> ? Out : S extends InputParser<infer Out> ? Awaited<Out> : never;

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    !!value &&
    typeof value === 'object' &&
    '~standard' in value &&
    typeof (value as StandardSchemaV1)['~standard']?.validate === 'function'
  );
}

/** Normalize either input style into one parse function. Throws at definition time for unsupported shapes. */
export function toParse(schema: InputSchema<any, any>): (value: unknown) => unknown | Promise<unknown> {
  if (isStandardSchema(schema)) {
    const standard = schema['~standard'];
    if (standard.version !== 1) throw new Error('UNSUPPORTED_INPUT_SCHEMA_VERSION');
    const settle = (result: StandardResult<unknown>): unknown => {
      if (result.issues) {
        throw new Error(`INVALID_QUERY_INPUT:${result.issues.map(issue => issue.message).join('; ')}`, { cause: result.issues });
      }
      return result.value;
    };
    return value => {
      const result = standard.validate(value);
      return result instanceof Promise ? result.then(settle) : settle(result);
    };
  }
  if (!schema || typeof (schema as InputParser<unknown>).parse !== 'function') throw new Error('INVALID_QUERY_DEFINITION');
  return (schema as InputParser<unknown>).parse.bind(schema);
}
```

- [ ] **Step 4: `plan.ts` 갱신**

`export type Input = Record<string, unknown>;` 줄을 삭제하고 상단에 추가:

```ts
import { toParse, type Input, type InputSchema } from './input.js';
export type { Input } from './input.js';
```

`QueryDefinition`을

```ts
export type QueryDefinition<S extends InputSchema<any, any> = InputSchema<any, any>> = { input: S; plan: Plan };
```

로 바꾼다. `executePlan`의 `call` 분기

```ts
      const query = queries[plan.endpoint];
      return executePlan(query.plan, query.input.parse(plan.input ? plan.input(input) : input) as Input, queries, execute, resources);
```

를

```ts
      const query = queries[plan.endpoint];
      const parsed = (await toParse(query.input)(plan.input ? plan.input(input) : input)) as Input;
      return executePlan(query.plan, parsed, queries, execute, resources);
```

로 바꾼다.

- [ ] **Step 5: `query/index.ts`, `src/index.ts` export 갱신**

`packages/sdi-runtime/src/query/index.ts`에 추가:

```ts
export type { InputOf, InputParser, InputSchema, ParsedInputOf, StandardIssue, StandardResult, StandardSchemaV1 } from './input.js';
```

`packages/sdi-runtime/src/index.ts`의 query 타입 export 줄에 위 이름들을 덧붙인다:

```ts
export type { Input, InputOf, InputParser, InputSchema, ParsedInputOf, StandardIssue, StandardResult, StandardSchemaV1, QueryDefinition, Plan, SelectPlan, SelectOptions, Predicate, AtomicPredicate, PageValue, Value, Join, PostgresQueryPlan, ExecutableQueryPlan } from './query/index.js';
```

- [ ] **Step 6: `runtime/index.ts` 정규화와 `parseInput` 비동기화**

import 추가:

```ts
import { toParse } from '../query/input.js';
```

`createImpact`의 정의 루프

```ts
    if (!query?.input || typeof query.input.parse !== 'function') throw new Error('INVALID_QUERY_DEFINITION');
    const parse = query.input.parse.bind(query.input);
    if (!query.plan) throw new Error('QUERY_PLAN_REQUIRED');
    queries[name] = Object.freeze({ input: { parse }, plan: snapshot<Plan>(query.plan) });
```

를

```ts
    if (!query?.input) throw new Error('INVALID_QUERY_DEFINITION');
    const parse = toParse(query.input);
    if (!query.plan) throw new Error('QUERY_PLAN_REQUIRED');
    queries[name] = Object.freeze({ input: { parse }, plan: snapshot<Plan>(query.plan) });
```

로 바꾼다. `parseInput`을 비동기로:

```ts
async function parseInput(definition: QueryDefinition, value: unknown, exactStringInputs: readonly string[] = []): Promise<Input> {
  const input = await toParse(definition.input)(value);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_QUERY_INPUT');
  // 이하 기존 exactStringInputs 검사 그대로
```

호출부 두 곳(`query`, `queryUncached`)의 `const parsed = parseInput(...)`를 `const parsed = await parseInput(...)`로 바꾼다.

- [ ] **Step 7: 테스트 통과 확인**

```bash
pnpm build
pnpm exec vitest run --config sdi.vitest.config.ts tests/server-driven-impact/query-input-schema.test.ts
```

Expected: 5 passed.

- [ ] **Step 8: 전체 검사 후 커밋**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/sdi-runtime/src tests/server-driven-impact/query-input-schema.test.ts
git commit -m "feat(runtime): accept Standard Schema query inputs"
```

---

### Task 6: 플랜 출력 타입과 `engine.query()` 추론

**Files:**
- Modify: `packages/sdi-runtime/src/query/plan.ts` (`Typed<O>`, `Plan<O>`, `SelectPlan<O>`, `PostgresQueryPlan<O>`, `OutputOf`, `QueryDefinition<S, P>`, `q` 제네릭), `packages/sdi-runtime/src/query/index.ts` (`defineQueries`, export), `packages/sdi-runtime/src/runtime/index.ts` (`query`/`queryUncached` 시그니처), `packages/sdi-runtime/src/index.ts`
- Test: `tests/server-driven-impact/typed-queries.test.ts`, 기존 테스트의 의도적 잘못된 입력 호출부

**Interfaces:**
- Consumes: `InputOf<S>` from `./input.js` (Task 5).
- Produces:
  - `type Typed<O> = { readonly '~output'?: O }` (phantom, 런타임 부재. 문자열 키를 써서 선언 파일 emit 시 비공개 symbol 오류를 피한다)
  - `type Plan<O = unknown>`, `type SelectPlan<O = unknown>`, `type PostgresQueryPlan<O = unknown>`, `type OutputOf<P> = P extends Typed<infer O> ? O : unknown`
  - `type QueryDefinition<S extends InputSchema<any, any> = InputSchema<any, any>, P extends Plan<any> = Plan<any>> = { input: S; plan: P }`
  - `q.select<Row extends Record<string, unknown> = Record<string, unknown>>(...): SelectPlan<Row[]>`, `q.count(...): SelectPlan<number>`, `q.value<T>(v: T): Plan<T>`, `q.call<O = unknown>(...): Plan<O>`, `q.combine<C>(children: C): Plan<{ [K in keyof C]: OutputOf<C[K]> }>`, `q.when<A, B>(...): Plan<A | B>`, `q.bind<P, C>(...): Plan<C | []>`, `q.map<S, R>(source: Plan<S>, project: (data: S, input: Input) => R): Plan<R>`, `q.choose<C>(choices: C, choose: (input: Input) => keyof C & string): Plan<OutputOf<C[keyof C]>>`
  - `engine.query<K extends keyof Q & string>(endpoint: K, input: InputOf<Q[K]['input']>, context: Context): Promise<OutputOf<Q[K]['plan']>>`
  - `engine.queryUncached<K>(...): Promise<{ data: OutputOf<Q[K]['plan']>; cachePolicy: 'no-store' }>`

- [ ] **Step 1: 실패하는 타입 테스트 작성**

`tests/server-driven-impact/typed-queries.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, expectTypeOf, it } from 'vitest';
import { createImpact, defineQueries, q, type Resources, type StandardSchemaV1 } from '@server-driven-impact/runtime';
import { sqliteAdapter } from '@server-driven-impact/sqlite';

type Todo = { id: string; account_id: string; status: string };
const resources: Resources = {
  todos: { table: 'todos', idColumn: 'id', scopeColumn: 'account_id', columns: ['id', 'account_id', 'status'] },
};
const statusSchema: StandardSchemaV1<{ status: string }, { status: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value => {
      const status = (value as { status?: unknown } | null)?.status;
      return typeof status === 'string' ? { value: { status } } : { issues: [{ message: 'status must be a string' }] };
    },
  },
};
const legacyInput = { parse: (value: unknown) => value as { status: string } };
const queries = defineQueries({
  'todos.byStatus': { input: statusSchema, plan: q.select<Todo>('todos', { where: [q.eq('status', q.input('status'))] }) },
  'todos.count': { input: statusSchema, plan: q.count('todos', { where: [q.eq('status', q.input('status'))] }) },
  'todos.summary': { input: statusSchema, plan: q.combine({ rows: q.select<Todo>('todos'), total: q.count('todos') }) },
  'todos.ids': { input: statusSchema, plan: q.map(q.select<Todo>('todos'), rows => rows.map(row => row.id)) },
  'todos.either': { input: statusSchema, plan: q.when(() => true, q.count('todos'), q.value('none')) },
  'todos.legacy': { input: legacyInput, plan: q.select('todos') },
});
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

it('infers query input and output types from definitions', async () => {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('pragma foreign_keys=on; create table todos(id text primary key, account_id text not null, status text not null)');
  const engine = createImpact({ resources, queries, adapter: sqliteAdapter({ database }) });
  const context = { scope: 'a' };

  expectTypeOf(engine.query('todos.byStatus', { status: 'open' }, context)).resolves.toEqualTypeOf<Todo[]>();
  expectTypeOf(engine.query('todos.count', { status: 'open' }, context)).resolves.toEqualTypeOf<number>();
  expectTypeOf(engine.query('todos.summary', { status: 'open' }, context)).resolves.toEqualTypeOf<{ rows: Todo[]; total: number }>();
  expectTypeOf(engine.query('todos.ids', { status: 'open' }, context)).resolves.toEqualTypeOf<string[]>();
  expectTypeOf(engine.query('todos.either', { status: 'open' }, context)).resolves.toEqualTypeOf<number | string>();
  expectTypeOf(engine.query('todos.legacy', { status: 'open' }, context)).resolves.toEqualTypeOf<Record<string, unknown>[]>();
  expectTypeOf(engine.queryUncached('todos.ids', { status: 'open' }, context)).resolves.toEqualTypeOf<{ data: string[]; cachePolicy: 'no-store' }>();

  await expect(
    // @ts-expect-error status must be a string
    engine.query('todos.byStatus', { status: 1 }, context),
  ).rejects.toThrow('INVALID_QUERY_INPUT');
  await expect(
    // @ts-expect-error unknown endpoint
    engine.query('todos.missing', { status: 'open' }, context),
  ).rejects.toThrow('UNKNOWN_QUERY');

  expect(await engine.query('todos.ids', { status: 'open' }, context)).toEqual([]);
  expect(await engine.query('todos.count', { status: 'open' }, context)).toBe(0);
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm exec tsc -p tsconfig.json 2>&1 | grep typed-queries | head
```

Expected: `q.select<Todo>`에 타입 인자를 줄 수 없다는 에러(`Expected 0 type arguments`)와 `toEqualTypeOf` 불일치 에러가 난다.

- [ ] **Step 3: `plan.ts`에 phantom 출력 타입 도입**

`Value` 타입 선언 바로 위에 추가:

```ts
/** Phantom result type carried by builders; the key never exists at runtime. */
export type Typed<O> = { readonly '~output'?: O };
export type OutputOf<P> = P extends Typed<infer O> ? O : unknown;
```

기존 타입 선언들을 아래로 교체한다:

```ts
export type SelectPlan<O = unknown> = { kind: 'select'; resource: ResourceId; options: SelectOptions; result?: 'rows' | 'count' } & Typed<O>;
/** PostgreSQL SQL compiled ahead of runtime with its read dependencies attached. */
export type PostgresQueryPlan<O = unknown> = {
  kind: 'postgres-query';
  text: string;
  parameters: readonly string[];
  reads: readonly ReadDependency[];
  cache?: 'no-store';
  searchPath?: readonly string[];
  catalog?: PostgresCatalogStamp;
  policyProof?: PostgresPolicyProof;
} & Typed<O>;
export type ExecutableQueryPlan = SelectPlan<any> | PostgresQueryPlan<any>;
export type Plan<O = unknown> =
  | SelectPlan<O>
  | PostgresQueryPlan<O>
  | ({ kind: 'value'; value: unknown } & Typed<O>)
  | ({ kind: 'call'; endpoint: string; input?: (input: Input) => Input } & Typed<O>)
  | ({ kind: 'combine'; children: Record<string, Plan> } & Typed<O>)
  | ({ kind: 'when'; test: (input: Input) => boolean; yes: Plan; no: Plan } & Typed<O>)
  | ({ kind: 'bind'; parent: Plan; child: Plan; input: (data: unknown, input: Input) => Input | null } & Typed<O>)
  | ({ kind: 'map'; source: Plan; project: (data: unknown, input: Input) => unknown } & Typed<O>)
  | ({ kind: 'choose'; choices: Record<string, Plan>; choose: (input: Input) => string } & Typed<O>);
export type QueryDefinition<
  S extends InputSchema<any, any> = InputSchema<any, any>,
  P extends Plan<any> = Plan<any>,
> = { input: S; plan: P };
```

- [ ] **Step 4: `q` 빌더에 제네릭 부여**

`export const q = { ... }`를 아래로 교체한다. 런타임 반환 객체는 이전과 동일해야 한다(phantom 속성은 넣지 않는다).

```ts
export const q = {
  select<Row extends Record<string, unknown> = Record<string, unknown>>(resource: ResourceId, options: SelectOptions = {}): SelectPlan<Row[]> {
    return { kind: 'select', resource, options };
  },
  input(field: string): Value { return { kind: 'input', field }; },
  literal(value: unknown): Value { return { kind: 'literal', value }; },
  eq(field: string, value: Value): Predicate { return { field, op: '=', value }; },
  filter(field: string, op: AtomicPredicate['op'], value?: Value): Predicate { return { field, op, value }; },
  and(...predicates: Predicate[]): Predicate { return { kind: 'and', predicates }; },
  or(...predicates: Predicate[]): Predicate { return { kind: 'or', predicates }; },
  not(predicate: Predicate): Predicate { return { kind: 'not', predicate }; },
  count(resource: ResourceId, options: SelectOptions = {}): SelectPlan<number> {
    return { kind: 'select', resource, options, result: 'count' };
  },
  value<T>(value: T): Plan<T> { return { kind: 'value', value }; },
  call<O = unknown>(endpoint: string, input?: (input: Input) => Input): Plan<O> {
    return { kind: 'call', endpoint, ...(input ? { input } : {}) };
  },
  combine<C extends Record<string, Plan<any>>>(children: C): Plan<{ [K in keyof C]: OutputOf<C[K]> }> {
    return { kind: 'combine', children };
  },
  when<A, B>(test: (input: Input) => boolean, yes: Plan<A>, no: Plan<B>): Plan<A | B> {
    return { kind: 'when', test, yes, no };
  },
  bind<P, C>(parent: Plan<P>, child: Plan<C>, input: (data: P, input: Input) => Input | null): Plan<C | []> {
    return { kind: 'bind', parent, child, input: input as (data: unknown, input: Input) => Input | null };
  },
  map<S, R>(source: Plan<S>, project: (data: S, input: Input) => R): Plan<R> {
    return { kind: 'map', source, project: project as (data: unknown, input: Input) => unknown };
  },
  choose<C extends Record<string, Plan<any>>>(choices: C, choose: (input: Input) => keyof C & string): Plan<OutputOf<C[keyof C]>> {
    return { kind: 'choose', choices, choose };
  },
};
```

`plan.ts` 안에서 `Plan`을 인자로 받는 내부 함수(`requiresNoStore`, `walk`, `readsFor`, `proofs`, `executePlan`)는 `Plan`(= `Plan<unknown>`)을 그대로 쓰면 된다. `SelectPlan`을 받는 곳(`readOptions`, sqlite·postgres `compileSelect`)도 기본 인자로 컴파일된다.

- [ ] **Step 5: `defineQueries`와 export 갱신**

`packages/sdi-runtime/src/query/index.ts`:

```ts
export { q, compileManifest } from './plan.js';
export type { Input, Predicate, AtomicPredicate, PageValue, Value, Join, SelectOptions, SelectPlan, PostgresQueryPlan, ExecutableQueryPlan, Plan, QueryDefinition, QueryManifest, Manifest, Typed, OutputOf } from './plan.js';
export type { InputOf, InputParser, InputSchema, ParsedInputOf, StandardIssue, StandardResult, StandardSchemaV1 } from './input.js';
import type { QueryDefinition } from './plan.js';
/** Register executable definitions; dependencies are derived by createImpact. Preserves each entry's input and plan types. */
export function defineQueries<T extends Record<string, QueryDefinition>>(queries: T): T { return queries; }
```

`packages/sdi-runtime/src/index.ts`의 query 타입 export 줄에 `Typed, OutputOf`를 추가한다.

- [ ] **Step 6: `engine.query`/`queryUncached` 시그니처**

`packages/sdi-runtime/src/runtime/index.ts`에 import 추가:

```ts
import type { InputOf } from '../query/input.js';
import type { OutputOf } from '../query/plan.js';
```

`createImpact` 반환 객체의 두 메서드를 교체한다:

```ts
    async query<K extends keyof Q & string>(endpoint: K, input: InputOf<Q[K]['input']>, context: Context): Promise<OutputOf<Q[K]['plan']>> {
      const scope = scopeOf(context);
      if (!Object.hasOwn(queries, endpoint)) throw new Error('UNKNOWN_QUERY');
      if (requiresNoStore(queries[endpoint].plan, queries)) throw new Error('QUERY_REQUIRES_NO_STORE_EXECUTION');
      const parsed = await parseInput(queries[endpoint], input, exactStringInputs(endpoint));
      return adapter.query(scope, select => executePlan(queries[endpoint].plan, parsed, queries, select, resources)) as Promise<OutputOf<Q[K]['plan']>>;
    },
    /** Each invocation executes anew. This response must never enter a reusable query cache. */
    async queryUncached<K extends keyof Q & string>(endpoint: K, input: InputOf<Q[K]['input']>, context: Context): Promise<{ data: OutputOf<Q[K]['plan']>; cachePolicy: 'no-store' }> {
      const scope = scopeOf(context);
      if (!Object.hasOwn(queries, endpoint)) throw new Error('UNKNOWN_QUERY');
      const parsed = await parseInput(queries[endpoint], input, exactStringInputs(endpoint));
      const data = (await adapter.query(scope, select => executePlan(queries[endpoint].plan, parsed, queries, select, resources))) as OutputOf<Q[K]['plan']>;
      return { data, cachePolicy: 'no-store' as const };
    },
```

`createImpact`의 제네릭 제약 `Q extends Record<string, QueryDefinition>`은 기본 인자(`InputSchema<any, any>`, `Plan<any>`)로 그대로 둔다.

- [ ] **Step 7: 타입체크로 기존 호출부 수정**

```bash
pnpm build
pnpm exec tsc -p tsconfig.json 2>&1 | head -60
```

Expected: `typed-queries.test.ts`는 에러가 없어야 한다. 기존 테스트·예제 중 의도적으로 잘못된 입력을 넘기는 호출(예: `engine.query('x', 'not-an-object', context)`, `engine.query('x', null, context)`)만 에러가 난다. 그 호출의 입력 인자에 `as never`를 붙인다. `input: { parse(value: unknown): Input }` 형태의 정의는 `InputOf`가 `Record<string, unknown>`이므로 객체 입력은 모두 통과한다. 다른 종류의 에러가 나면 Step 3~6의 타입 선언을 다시 확인한다.

- [ ] **Step 8: 테스트 실행**

```bash
pnpm exec vitest run --config sdi.vitest.config.ts tests/server-driven-impact/typed-queries.test.ts
pnpm typecheck && pnpm test
```

Expected: typed-queries 1 passed, 전체 통과(단위 153 + Task 2~5에서 추가한 테스트).

- [ ] **Step 9: 커밋**

```bash
pnpm lint
git add packages/sdi-runtime/src tests examples
git commit -m "feat(runtime): infer query input and output types from definitions"
```

---

### Task 7: 문서, changeset, 전체 검증

**Files:**
- Modify: `README.md:164-168`, `README.ko.md:164-168`
- Create: `.changeset/pre/preamble-typed-queries.md`

- [ ] **Step 1: README Queries 절 갱신**

`README.md`의 `### Queries` 절, 두 번째 문단 뒤에 추가:

```markdown
`input` accepts any object with `parse(value)` or any [Standard Schema](https://standardschema.dev) v1 schema such as zod or valibot. `engine.query()` infers its input type from that schema and its return type from the plan: `q.select<Row>()` returns `Row[]`, `q.count()` returns `number`, and `q.map`, `q.combine`, `q.when`, `q.choose` follow their callbacks and children.
```

`README.ko.md`의 `### Queries` 절, 같은 위치에 추가:

```markdown
`input`에는 `parse(value)`를 가진 객체나 zod, valibot 같은 [Standard Schema](https://standardschema.dev) v1 스키마를 그대로 넣을 수 있습니다. `engine.query()`는 입력 타입을 그 스키마에서, 반환 타입을 plan에서 추론합니다. `q.select<Row>()`는 `Row[]`, `q.count()`는 `number`를 돌려주고 `q.map`, `q.combine`, `q.when`, `q.choose`는 콜백과 자식 plan의 타입을 따릅니다.
```

- [ ] **Step 2: PostgreSQL 절에 왕복 수 설명 추가**

`README.md` `## PostgreSQL adoption` 절의 "The runtime role needs ..." 문단 뒤에 추가:

```markdown
Each Command sends one preamble round trip (session lock, collector table, `BEGIN`, request settings) before the business SQL, then `COMMIT`, the observer drain, and the unlock. Reads use one preamble and set `search_path` once per transaction. The preamble temporarily sets `client_min_messages` to `error` for its own implicit block only; the setting reverts before `BEGIN`.
```

`README.ko.md`의 대응 절에 추가:

```markdown
Command는 업무 SQL 앞에 준비 왕복 한 번(세션 잠금, collector 테이블, `BEGIN`, 요청 설정)을 보내고, 뒤에 `COMMIT`, 관찰 결과 회수, 잠금 해제를 보냅니다. 조회는 준비 왕복 한 번과 트랜잭션당 한 번의 `search_path` 설정을 사용합니다.
```

- [ ] **Step 3: changeset 작성**

`.changeset/pre/preamble-typed-queries.md`:

```markdown
---
'@server-driven-impact/runtime': minor
'@server-driven-impact/postgres': minor
---

Accept Standard Schema v1 query inputs and infer `engine.query()` input and output types from Query definitions through typed `q.*` builders.

Send the PostgreSQL command preamble (session lock, collector table, BEGIN, request settings) and the read preamble as one simple-protocol round trip, and set `search_path` once per read transaction. Observed command SQL calls drop from eight to five for a single statement.
```

- [ ] **Step 4: 전체 검증**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm pack:check
pnpm test:matrix
```

Expected: 모두 통과. `test:matrix`는 PostgreSQL 14~18 × postgres.js/pg 10개 조합을 Docker로 실행하며 스킵 0이어야 한다(수 분 소요). 결과는 `.local/runtime/postgres-release/matrix.json`에 남는다.

- [ ] **Step 5: 벤치마크로 왕복 감소 확인 (선택, 근거 기록)**

"로컬 PostgreSQL 준비" 컨테이너가 살아 있는 상태에서:

```bash
SDI_BENCHMARK_SAMPLES=10 node scripts/backend/benchmark-sdi-orm.mjs 2>&1 | tail -30
```

Expected: `SQL calls` 열에서 `*-observed` 모드가 이전 8에서 5로 준다. p50 변화는 `docs/benchmarks/orm-impact-2026-09-10.md` 표와 나란히 `docs/benchmarks/orm-impact-<오늘 날짜>.md`에 같은 표 형식으로 기록한다. 측정 환경(Node, PostgreSQL 버전, 표본 수)을 첫 문단에 적는다.

- [ ] **Step 6: 커밋**

```bash
git add README.md README.ko.md .changeset/pre/preamble-typed-queries.md docs/benchmarks
git commit -m "docs: describe typed query inputs and the single-round-trip preamble"
```

---

## 완료 기준

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm pack:check`, `pnpm test:matrix` 모두 통과.
- `postgres-round-trips.test.ts`가 커맨드 4회(빈 커맨드)·5회(문장 1개), 조회 6회를 고정.
- `typed-queries.test.ts`가 `engine.query()`의 입력·출력 추론과 두 개의 `@ts-expect-error`를 고정.
- `.git-blame-ignore-revs`에 포맷 커밋 해시가 있고 CI가 `biome ci`를 실행.
- 응답 형식, ImpactSet 계산, 보수적 확장 로직은 변경 없음.
