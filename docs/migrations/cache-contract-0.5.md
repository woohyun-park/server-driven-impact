# 기존 캐시를 유지하는 server-owned 계약 전환

대상: `0.5.0-cache-contract.1`. 정식 npm 배포 전 로컬 검증용 prerelease다. 앱의 업무 API·화면·oRPC 사용 방식을 바꾸는 것이 아니라 서버 dispatch와 공통 캐시 consumer에 연결한다.

## 1. 같은 정의로 요청과 키 생성

[중첩 template 예제](../../packages/sdi-cache-contract/README.md#nested-keys-and-inputs)는 기존 oRPC 형태 `[path, {input, type}]`를 만든다. 기존 path를 literal로 옮기고, 실제 API 입력 schema를 빠짐없이 선언한다. oRPC는 SDI의 런타임 의존성이 아니다.

`prepareCacheQuery()`에서 나온 `input`을 RPC 호출에, `queryKey`를 query options에 사용한다. 기존 oRPC 키를 계속 쓴다면 같은 정규화 입력을 oRPC에 전달하고 두 키가 동일한지 먼저 검사한다. 정규화로 API 의미가 달라져서는 안 된다.

배열은 기본적으로 순서와 중복을 보존한다. 순서가 결과에 영향을 주지 않는 필드만 `order:'set'`을 선택한다. 중첩 객체의 unknown 필드는 거절하며, optional 생략과 null은 다른 키다. 기본값·coerce·UUID 정규화 도입으로 기존 키가 바뀐다면 별도 캐시 이전/정리를 해야 한다.

Infinite query는 `type:'infinite'`로 구분하고 페이지 cursor를 `pageInput`에 선언한다. 목록 identity만 키에 넣고 `buildQueryExecutionInput()`으로 매 페이지 실행 입력을 만든다. 페이지별 키로 쪼개지 않는다.

## 2. 시작 시 coverage 검증

Runtime의 `cacheContracts`는 등록된 Read 목록과 자동 비교된다. 독립 생성기는 `validateCacheContractCoverage()`를 직접 호출한다.

- 캐시 대상: 하나 이상의 operation에 endpoint 연결.
- no-store: `excludedEndpoints:[{endpoint,reason:'no-store'}]`.
- 이 클라이언트가 사용하지 않는 Read: `reason:'not-consumed'`.

신규 Read를 누락하면 시작/생성 단계에 실패한다. compiler만 단독 사용해도 알 수 없는 impact endpoint는 오류다. 명시적 제외를 성공한 빈 무효화와 혼동하지 않도록 진단을 수집한다.

계약은 데이터 전용이며 `cacheContractOpenApiExtension()`으로 내보낸다. 특정 OpenAPI 생성기를 자동 설정하지 않는다. 기존 헤더명을 SDI가 차지하지도 않는다. 계약 reference와 응답의 전송 위치는 앱이 선택한다.

## 3. 커밋과 후속 처리 분리

`command(context, work)`는 기존 `{data, impact}`를 반환한다. 세 번째 인자에 `{cacheContract: reference}`를 전달하면 `{data, impact, cacheInvalidation}`를 반환한다. 옵션이 없으면 캐시 변환은 실행하지 않는다.

```ts
// .0에서 사용하던 별도 메서드는 .1에서 제거됐다.
// 이전: engine.commandWithInvalidations(reference, context, work)
const result = await engine.command(context, work, {
  cacheContract: reference,
});
```

계약은 work 실행 전에 확인하고 요청 당시 scope/계약을 고정한다. 캐시 출력 옵션을 추가해도 업무 작업이나 영향 계산을 다시 실행하지 않는다. 명시적 옵션은 캐시 결과 타입을, optional `CommandOptions` 변수는 결과 union을 추론한다.

| 커밋 후 실패 | error.data | error.phase | error.impact |
| --- | --- | --- | --- |
| 영향 계산 | 업무 결과 | impact-calculation | 없음 |
| 캐시 지시 생성 | 업무 결과 | cache-invalidation | 계산된 ImpactSet |

`commitState:'committed'`를 전송 계층에서도 보존한다. 두 실패 모두 업무 작업을 재실행하거나 optimistic 상태를 rollback할 이유가 아니다. 기존 `command()`도 같은 오류 규칙을 따른다. `CommitStateUnknownError`는 확정 커밋이 아니므로 별도의 기존 처리 경로를 유지한다.

실행 가능한 [공통 consumer 예제](../../examples/cache-contract-consumer.ts)는 다음 순서다.

1. 요청 당시 QueryClient·scope·session generation을 보관한다.
2. 커밋 응답을 받은 뒤 generation을 검사한다.
3. 비동기 업무 callback을 기다린다.
4. generation을 다시 검사한 뒤 최초 조회 취소 옵션과 함께 무효화한다.
5. callback/refetch 오류는 `followUpErrors`로 반환하고 업무 결과를 유지한다.

영향 정보를 만들지 못한 확정 커밋은 예제에서 해당 세션의 전체 QueryClient를 재동기화한다. 무효화 실패 후 재시도 UI도 업무 command 대신 캐시 조회만 다시 수행해야 한다. Transport가 확정 커밋 오류를 일반 reject로 바꾸면 예제의 보호를 우회하므로 먼저 오류 직렬화 계약을 맞춘다.

## 4. 경쟁 상태와 앱 책임

`applyCacheInvalidations()`는 지시 검증·선택·취소 옵션·무효화·refetch 대기까지만 담당한다. 비동기 mutation callback 순서, 동시 mutation 조정, 사용자 전환, artifact 교체는 자동 처리하지 않는다.

최초 Read가 진행 중일 때 기본 TanStack invalidation은 그 요청을 재사용할 수 있다. `cancelInFlight:true`를 선택하면 일치하는 첫 Read도 취소하고 active query를 다시 조회할 수 있다. queryFn은 실제 네트워크 중단을 위해 AbortSignal을 사용한다. disabled/static/inactive query가 모두 즉시 재조회되는 것은 아니다.

로그아웃·재로그인 때는 같은 userId라도 generation을 증가시키고 이전 QueryClient를 retire/clear한다. 기존 응답이 새 client를 조회해 적용하지 않게 한다. callback 자체의 비동기 부작용도 앱이 generation/취소로 보호해야 한다.

서버 artifact 또는 계약 변경 시 기존 cache와 persistence/hydration을 정리하거나 buster를 교체한다. executor의 scope/계약 검증은 이 수명 관리의 대체물이 아니다. 여러 동시 command의 완전한 순서 보장이 필요하면 기존 coordinator를 유지한다.

## 5. 정밀도 점검

`cacheInvalidationOptions.explain`으로 확대 이유·operation·selector 필드명·필터 수를 수집한다. 사용자 입력과 실제 키는 기본 로그에 남기지 않는다.

일반 문자열 equality 정밀화는 Query graph가 직접 `column = input` binding을 만들고 `engine.validate()`가 실제 DB 컬럼의 exact 비교를 확인하면 자동으로 활성화된다. Runtime은 검증된 문자열 필드의 raw 값과 parse 결과가 같은지 매 조회에서 검사한다. 별도 문자열 비교 옵션은 없다.

parser가 값을 변경하면 조회를 거절한다. DB collation/operator를 증명하지 못하거나 `validate()` 전이면 endpoint fallback을 유지한다. `lower(username)`, `NOCASE`, `RTRIM`, `citext`, 임의 cast와 URL decode는 문자열 exact 경로에 포함되지 않는다. 독립 cache compiler는 runtime/DB 증명이 없으므로 endpoint fallback을 유지한다.

Optional 필드는 입력에서 생략되어도 SDI selector와 매칭하므로 fallback이 필요할 수 있다. Unrestricted string은 대소문자·후행 공백 등 기존 conservative equality 때문에 값 하나로 좁히지 않는다. 숫자, boolean, UUID, 유한 enum처럼 비교가 증명되는 입력은 정밀 변환할 수 있다.

`paramsAnchor`는 실제 입력 제약이지 성능 옵션이 아니다. `id` anchor를 선언하면 `{page:2}`는 유효한 params가 아니다. 예전 앱이 이런 키를 만들었다면 anchor 선언 전에 정리해야 한다. query/infinite·endpoint/domain fallback 범위와 후속 refetch 수를 함께 확인한다.

배열·중첩 객체 키 지원과 IN/range 영향 자동 추론은 별개다. 후자는 아직 지원하지 않으며 원래 ImpactSet v1이 가진 정밀도 이상을 만들어내지 않는다.

## 6. 로컬 설치와 복구

Tarball 위치:

```text
<SDI 저장소>/.local/artifacts/sdi/0.5.0-cache-contract.1/
```

동일 버전의 core/cache-contract/runtime/postgres/sqlite/tanstack-query 여섯 tarball과 `release-manifest.json`, `pnpm-overrides.json`을 제공한다. Manifest에 의존/peer 범위·SHA-512·소스 revision/dirty 상태를 기록한다. 초기 `0.4.1` 및 `0.5.0-cache-contract.0` 파일은 덮어쓰지 않는다. .0은 이전 메서드 API이므로 새 호출을 시험할 때는 .1을 설치한다.

소비 앱에서는 필요한 패키지를 절대 `file:` 경로로 지정하고, transitive SDI 의존성도 같은 tarball을 사용하도록 manifest 옆 overrides 값을 앱의 pnpm overrides 설정에 **병합**한다. 기존 overrides를 덮어쓰지 않는다. 파일을 다른 위치로 옮기면 경로도 수정한다. 변경한 manifest/lockfile을 보관해 복구 기준으로 삼는다.

검증 순서:

1. `pnpm why` / 설치된 package.json으로 모든 SDI 패키지가 prerelease 하나로 통일됐는지 확인.
2. 기존 oRPC 키와 SDI 키 비교: 생략/null, 배열 순서·중복, nested filters, query/infinite.
3. 신규 Read 누락 및 no-store 제외를 시작 단계에서 검사.
4. insert/update/delete의 실제 화면 갱신, 무관 키 유지, prefix fallback 진단 확인.
5. 커밋 후 두 오류 경로에서 업무 결과·단일 command 실행·rollback 금지 확인.
6. 최초 조회 경합, 비동기 callback, 로그인 전환, artifact 교체, refetch 실패 확인.

복구는 소비 앱의 변경 전 package manifest/lockfile을 복원한 뒤 frozen-lockfile 설치로 수행한다. 호환되지 않는 persisted cache도 정리한다. 기존 `0.4.1`과 이번 prerelease를 같은 버전으로 취급하지 않는다.

이 저장소는 Changesets prerelease 모드(`cache-contract`)다. 이후 수정은 새 changeset을 추가하고 version을 진행해 다음 prerelease로 구분한다. 정식 전환은 별도 검증/승인 후 pre exit/version 절차를 따른다. npm publish는 수행하지 않았다.
