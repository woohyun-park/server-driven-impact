# @server-driven-impact/cache-contract

[English](./README.md) | [한국어](./README.ko.md)

SDI endpoint, OpenAPI operation, 정규화 입력, 캐시 키의 관계를 버전된 계약으로 정의합니다. 브라우저 캐시를 조회하지 않고 `ImpactSet`을 데이터 전용 무효화 지시로 변환합니다.

```ts
import { buildQueryKey, defineCacheContract } from '@server-driven-impact/cache-contract';

const contract = defineCacheContract({
  id: 'company-api', version: 1,
  queries: [{
    operationId: 'getOrder', endpoint: 'orders.detail', kind: 'query',
    input: {id: {type: 'string', required: true, exclude: ['list']}},
    key: {prefix: ['orders'], path: ['id']}, fallback: ['orders'],
  }],
});

buildQueryKey(contract, 'getOrder', {id: 'one'}); // ['orders', 'one']
```

`cacheContractOpenApiExtension(contract)`의 결과를 루트 `x-sdi-cache` 확장 값으로 사용합니다. 생성 클라이언트는 mutation 요청에 `{id, version}`을 전달합니다. 서버의 `createCacheContractRegistry()`는 지원하지 않는 버전을 거절하며 `compileCacheInvalidations()`는 `{contractId, contractVersion, scope, invalidations}`를 만듭니다.

결과에 영향을 주는 identity 입력은 모두 선언하고 키에 포함해야 합니다. 선언하지 않은 입력은 버리지 않고 거절합니다. 기존 `prefix/path/params`와 중첩 선언형 template을 지원합니다. `fallback`은 생성되는 모든 키를 포함하는 TanStack 부분 키여야 하며 등록 시 검증합니다. query/infinite 키가 충돌할 가능성이 있으면 거절합니다.

`['orders', 'list', params]` 같은 키에서는 params 객체가 존재할 때 특정 필드가 반드시 있다는 입력 검증이 있을 때만 `paramsAnchor`를 지정합니다. 이 증명이 있으면 protocol-1의 missing-field 의미를 좁은 부분 키로 보존할 수 있고, 없으면 변환기는 안전하게 `fallback`으로 넓힙니다.

## 중첩 키와 입력

`key: {template: ...}`에 `literal`, `input`, `inputs`, `array`, `object` 노드를 조합합니다. oRPC 의존성이나 앱별 compiler 없이 기존 `[path, {input, type:'query'}]` 키를 표현할 수 있습니다. 실제 코드 예제는 [영문 README](./README.md#nested-keys-and-inputs), 전환 절차는 [통합 가이드](../../docs/migrations/cache-contract-0.5.md)에 있습니다.

- 배열: `{type:'array',items:...,order:'preserve'|'set'}`. 기본은 순서·중복 보존입니다. 명시적 `set`만 canonical JSON 기준 정렬·중복 제거를 합니다.
- 객체: `{type:'object',properties:...}`. 중첩 필드도 모두 선언하며 알 수 없는 필드는 거절합니다.
- 생략된 optional 필드는 없습니다. `default`를 선언한 경우에만 채웁니다. `null`은 `nullable:true`로 허용하며 생략과 구별합니다.
- 날짜는 timezone이 명시된 값만 받아 UTC ISO로 바꿉니다. `format:'uuid'`는 검증 후 소문자로 바꿉니다.

`prepareCacheQuery(contract, operationId, input)`의 `input`을 API에 전달하고 `queryKey`를 캐시에 사용하십시오. `normalizeCacheInput`도 제공합니다. 키만 정규화해서 요청 의미와 어긋나게 해서는 안 됩니다. 기존 키 유지가 목적이면 기존 API와 같은 정규화 정책을 선택합니다.

Infinite query는 `type:'infinite'` 같은 별도 literal로 구분합니다. `input`은 목록 identity, `pageInput`은 실행 전용 cursor/page 필드입니다. `buildQueryExecutionInput(contract, operationId, identity, page)`는 정규화한 실행 입력을 합칩니다. `buildQueryKey`는 page 전용 필드를 거절하며 모든 페이지가 목록 키 하나를 공유합니다.

## 누락 검증과 정밀도

`validateCacheContractCoverage(contract, [{endpoint, cache:'cacheable'|'no-store'}])`로 생성·시작 단계에 검증합니다. Runtime은 등록된 **각 계약**에 자동 적용합니다. 모든 endpoint는 query 또는 `excludedEndpoints:[{endpoint,reason:'no-store'|'not-consumed'}]`로 명시해야 합니다. no-store 조회에는 재사용 키를 등록할 수 없습니다. 계약에 없는 impact endpoint는 `CACHE_ENDPOINT_UNCOVERED` 오류이며 명시적으로 제외한 경우에만 생략합니다.

`compileCacheInvalidations`의 네 번째 인자 또는 runtime의 `cacheInvalidationOptions`에 `{explain, maxInvalidations, maxBytes}`를 전달합니다. 진단에는 endpoint/operation, selector 필드명, 확대 이유와 필터 수만 포함하며 사용자 값은 넣지 않습니다. 실제 범위는 반환된 filters와 함께 확인합니다. callback이 던진 오류도 커밋 후 실패로 처리되므로 로깅 callback은 예외를 던지지 않아야 합니다.

주요 확대 이유는 `missing-field`, `comparison-unproven`, `page-input`, `input-unrepresentable`, `endpoint-policy`, `budget`입니다. Protocol 1은 생략 필드와 보수적 DB equality까지 매칭합니다. 따라서 unrestricted string은 대소문자/후행 공백 때문에 `required:true`만으로 정밀 변환하지 않습니다. 숫자·boolean·정규화된 UUID 또는 일치 값이 하나인 유한 `enum`처럼 비교를 증명할 수 있어야 합니다. optional/default 필드는 보통 fallback으로 넓어집니다.

Runtime은 필수·비-coerce 문자열에서 입력 필드가 그대로 전달되고, 직접 Query equality binding과 실제 컬럼의 exact 비교에 대한 adapter 검증이 모두 있으면 자동으로 정밀화합니다. Runtime은 매 요청에서 parser 전후 값을 검사합니다. 독립 `compileCacheInvalidations()`는 runtime/DB 증명이 없으므로 보수적인 동작을 유지합니다. DB 비교가 미지원이거나 검증 전이면 `comparison-unproven`으로 확대합니다.

`paramsAnchor:['id']`는 `{page:2}`를 유효 입력으로 받지 않는 경우에만 사용합니다. 키 준비 함수가 이를 검사하지만, 기존 외부 캐시까지 보증하지는 않습니다. 잘못된 기존 키는 먼저 지우거나 이전해야 합니다. anchor가 있어도 optional page selector나 증명할 수 없는 문자열 비교는 넓힙니다.

Endpoint 대신 domain 단위 fallback도 지정할 수 있습니다. 예: `[['data','profile']]`. `invalidation:'endpoint'`는 항상 fallback을 선택합니다. 예산 초과 시 지시를 자르지 않고 넓히며, 최소 안전 지시도 담지 못하면 오류로 알립니다.

배열·객체 **키 표현**을 지원하는 것이 ImpactSet v1의 IN/range/중첩 selector 추론을 추가한다는 뜻은 아닙니다. 해당 정밀도는 후속 범위이며 현재는 안전한 fallback을 유지합니다.
