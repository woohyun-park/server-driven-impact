# Prisma transaction 관찰 가능성 판정

2026-09-10. 판정: **Prisma 7.10.0 + `@prisma/adapter-pg` 7.10.0은 공개 driver adapter 계약으로 연동 가능하다.** SDI가 바깥 transaction을 소유하고 Prisma의 실행을 그 연결로 전달하는 방식을 구현했다. 단순 `$transaction` callback에서 COMMIT 전에 facts를 읽는 방식은 사용하지 않는다.

## 확인한 버전과 공개 API

| 항목 | 실험 버전 |
| --- | --- |
| Prisma CLI / generated Client | 7.10.0 / 7.10.0 |
| `@prisma/adapter-pg`, `@prisma/driver-adapter-utils` | 7.10.0 |
| node-postgres | 8.16.3 |
| 독립 실험 Node / PostgreSQL | 25.8.0 / 18.6 |

조사 당시 npm의 Prisma `latest`는 8.0.0-rc.13이고 adapter-pg는 7.10.0이었다. 서로 다른 세대의 패키지를 섞지 않고 7.10.0으로 고정했다. 이 판정은 Prisma 8이나 다른 driver adapter에 대한 지원 선언이 아니다. 패키지 지원 Node/DB matrix는 저장소의 별도 conformance 결과를 따른다.

공식 PostgreSQL 문서는 generated Prisma Client 생성자에 `PrismaPg` driver adapter를 전달하는 진입점을 설명한다. 사용자의 generated 모델 코드는 `createClient(adapter)`로 주입한다. 임의 ORM 조회의 의존성을 이 API가 분석하는 것은 아니다. [Prisma PostgreSQL 문서](https://docs.prisma.io/docs/orm/core-concepts/supported-databases/postgresql)

공개 `SqlDriverAdapterFactory.connect()`는 `SqlDriverAdapter`를 반환한다. 여기에는 query 실행과 `startTransaction()`이 있다. 공개 `Transaction`에는 query 실행, `commit()`, `rollback()`, `options.usePhantomQuery`가 정의돼 있다. 실험과 구현은 이 인터페이스만 구현하며 Prisma Client의 비공개 engine 객체에 접근하지 않는다. [7.10.0 driver adapter 타입](https://github.com/prisma/prisma/blob/7.10.0/packages/driver-adapter-utils/src/types.ts)

`PrismaPg`는 외부 `pg.Pool`을 생성자에서 받으며, 그 Pool의 `query()`를 통해 Prisma의 parameter 및 result codec을 적용한다. 기본 `startTransaction()`은 Pool에서 연결을 얻고 BEGIN을 실행한다. 기본 transaction의 `commit()`은 연결 반환이므로 이것만 호출해서 실제 COMMIT을 했다고 판단할 수 없다. `underlyingDriver()`는 공개 반환 타입에 포함돼 있다. [7.10.0 adapter-pg 소스](https://github.com/prisma/prisma/blob/7.10.0/packages/adapter-pg/src/pg.ts)

Prisma 7.10.0 transaction manager는 `usePhantomQuery: true`일 때 SQL COMMIT/ROLLBACK을 직접 실행하지 않고 adapter의 해당 hook을 호출한다. 이 경로를 이용해 Prisma가 필요로 하는 transaction을 SDI savepoint로 연결한다. 공개 옵션의 실제 실행 의미를 pinned 소스와 실제 generated Client 실행으로 함께 확인했다. [7.10.0 transaction manager](https://github.com/prisma/prisma/blob/7.10.0/packages/client-engine-runtime/src/transaction-manager/transaction-manager.ts)

## 선택한 구조

1. 기존 SDI `pgAdapter`가 연결 예약, collector 준비, BEGIN, token/role 설정을 수행한다.
2. command마다 공개 `SqlDriverAdapterFactory`와 generated Prisma Client를 만든다.
3. command 전용 `pg.Pool` subclass의 `query()`는 guarded `PgCommandDb.query()`로 전달한다. 이 facade의 `connect()`는 거절한다. 실제 Pool이나 PoolClient, 전역 prototype은 수정하지 않는다.
4. Prisma의 nested relation write 또는 `$transaction`은 guarded SDI savepoint를 사용한다. Prisma commit hook은 savepoint를 RELEASE하고 rollback hook은 해당 savepoint로 되돌린다.
5. command callback이 끝나면 ORM 실행 문맥을 닫는다. 실제 바깥 COMMIT, deferred trigger 실행, 동일 연결의 collector drain은 기존 SDI 생명주기가 수행한다.
6. 기존 runtime이 회수한 WriteSet으로 ImpactSet을 계산하고 `{ data, impact }`를 반환한다.

Prisma가 바깥 transaction을 소유하면서 공개 transaction hook을 감싸는 방법도 타입상 후보였지만, 기존 observer 생명주기를 재사용하는 위 방식을 실제로 검증하고 선택했다. Prisma 소유 방식의 생산 지원을 별도로 주장하지 않는다.

## 재현

실험 파일: [`scripts/experiments/prisma-transaction`](../../scripts/experiments/prisma-transaction). 의존성을 루트 workspace에 설치하지 않고 임시 폴더에서 실행할 수 있다. 아래 DB URL은 별도로 띄운 **로컬 테스트 DB**를 지정한다. 매 실행마다 UUID schema를 생성하고 `finally`에서 그 schema만 제거한다.

```sh
experiment_dir=$(mktemp -d /tmp/sdi-prisma-repro.XXXXXX)
cp scripts/experiments/prisma-transaction/{package.json,schema.prisma,experiment.mjs} "$experiment_dir/"
cd "$experiment_dir"
npm install --ignore-scripts
npm run generate
SDI_PRISMA_DATABASE_URL=postgresql://postgres:sdi@127.0.0.1:32858/sdi npm test
```

이 standalone fixture는 최소 TEMP collector로 **공개 API 연결 가능성과 commit 경계**를 격리 검증한다. SDI observer 전체의 정확성 증거를 대체하지 않는다. 실제 SDI observer와 자동 ImpactSet은 [`prisma.integration.test.ts`](../../tests/server-driven-impact/prisma.integration.test.ts)가 별도로 검증한다.

생산 어댑터 focused conformance는 PostgreSQL 18.6에서 7개 테스트가 통과했다. nested model write·deferred 영향의 입력 정밀도, 취소된 savepoint 제외, interactive transaction과 isolation 거절, 바깥 rollback·최종 COMMIT 실패·late lazy query, 동시 command·cascade, await하지 않은 transaction의 정리, Prisma timeout 후 계속 실행을 포함한다. PostgreSQL 14–18 matrix는 공통 필수 검사에서 재실행한다.

저장한 독립 실험 결과: [`result.json`](../../scripts/experiments/prisma-transaction/result.json).

| 확인 항목 | 관찰 결과 |
| --- | --- |
| prepare / mutation / commit / drain 연결 | 성공 요청의 네 단계 모두 같은 `pg_backend_pid()` |
| nested Prisma create | 부모와 child의 DB 쓰기가 자동 collector에 포함됨 |
| deferred trigger | callback 내 collector에는 audit가 없고 최종 COMMIT 후에는 포함됨 |
| nested 쓰기 실패 후 계속 진행 | savepoint에서 취소된 부모/child 제외, 이후 성공한 부모와 deferred audit만 포함 |
| 바깥 rollback | 업무 행이 DB에 남지 않음 |
| deferred FK 위반 | 최종 COMMIT 실패, 정상 facts 응답 없음 |
| commit 후 drain 실패 주입 | 업무 행은 커밋됨, 정상 facts 응답은 거절됨 |
| callback 밖 client / 지연 실행 | 닫힌 문맥에서 query 거절 |
| 동시에 실행한 두 command | 각 token의 해당 행만 수집됨 |

## 공개 지원과 경계

생산 API는 `@server-driven-impact/postgres/prisma`의 `prismaAdapter({ database, createClient, schema?, ...pgOptions })`다. 첫 연동은 7.10.0에 고정한다. generated Client와 CLI는 라이브러리 필수 dependency가 아니며 앱의 모델 생성을 따른다. `createClient`는 받은 adapter를 사용해 새 client를 만들어야 한다. 이미 존재하는 전역 client를 반환하면 계약을 충족하지 않는다.

```sh
pnpm add @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0 @prisma/driver-adapter-utils@7.10.0 pg@8.16.3
pnpm add -D prisma@7.10.0
```

```ts
const engine = createImpact({
  resources,
  queries,
  adapter: prismaAdapter({
    database: pool,
    createClient: adapter => new PrismaClient({ adapter }),
  }),
});
const response = await engine.command(context, client =>
  client.order.update({ where: { id }, data: { customerId } }),
);
```

Prisma의 명시적 transaction isolation 변경은 이미 시작한 바깥 transaction에 적용할 수 없으므로 `PRISMA_NESTED_ISOLATION_UNSUPPORTED`로 거절한다. isolation은 SDI adapter 옵션으로 지정한다. Prisma transaction 안에 다시 중첩한 `$transaction`의 추가 savepoint hook은 제공하지 않는다. 동시에 겹치는 Prisma savepoint 작업은 기존 SDI `OVERLAPPING_SAVEPOINT` 계약을 따른다.

Prisma의 raw SQL도 기존 native SQL 검사와 작업 수명을 따른다. Prisma CLI의 migration/script 실행을 command 안에서 제공하지 않는다. callback에서 반환한 후 새로 실행되는 lazy query, 아직 끝나지 않은 실행, transaction 제어 SQL을 우회로 허용하지 않는다.

adapter-pg는 `instanceof pg.Pool`로 외부 Pool을 식별한다. 서로 다른 pg 설치본 때문에 facade를 인식하지 못하면 `underlyingDriver()` 동일성 검사에서 **SQL 실행 전에** `PRISMA_PG_INSTANCE_MISMATCH`로 거절한다. 지원 조합에서는 같은 pg 설치본을 사용해야 한다. Prisma 내부 비공개 접근, 전역 monkey patch, 영속 추적 테이블은 필요하지 않다.

Prisma Client를 command마다 생성하는 비용은 별도 측정 대상이다. 이 가능성 판정은 Prisma가 native SQL보다 빠르다는 주장이나 ORM 초기화 비용이 없다는 주장이 아니다.
