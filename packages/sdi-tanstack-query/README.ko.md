# @server-driven-impact/tanstack-query

[English](./README.md) | [한국어](./README.ko.md)

서버 소유 무효화 응답을 검증하고 exact/partial 지시의 합집합을 한 번의 호출로 TanStack Query에 적용합니다.

```ts
import { applyCacheInvalidations } from '@server-driven-impact/tanstack-query';

await applyCacheInvalidations(queryClient, response.cacheInvalidation, {
  contract: {id: 'company-api', version: 1}, scope: currentTenant,
});
```

캐시를 건드리기 전에 계약과 요청 당시 scope가 현재 값과 같은지 검사합니다. 일치하는 active/inactive query를 모두 invalidate하고 기본 refetch 대상은 `active`입니다. mutation 완료에 active refetch 완료까지 포함하려면 반환 Promise를 기다리십시오. 별도로 보관하면 이미 커밋된 mutation과 후속 refetch 실패를 구분할 수 있습니다.

`@tanstack/query-core`는 peer dependency입니다. `QueryClient`와 캐시 생명주기는 애플리케이션이 소유합니다.

## 실행기의 보장 범위

- 실제 TanStack `matchQuery`로 exact hash/중첩 부분 키를 매칭합니다. scope/계약이 다르면 취소·무효화 전에 거절합니다.
- `refetchType` 기본값은 `active`, `none`은 stale 표시만 합니다. disabled/static query는 TanStack의 재조회 제외 규칙을 따릅니다.
- `cancelRefetch`는 TanStack에 전달하지만, 캐시 데이터가 없는 **최초 조회**를 취소한다고 보장하지 않습니다. 기본 동작에서는 수정 전에 시작한 응답을 재사용할 수 있습니다.
- `cancelInFlight:true`는 일치하는 query를 먼저 `cancelQueries`로 취소합니다. 최초 조회의 뒤늦은 결과도 버리고 active query를 다시 시작할 수 있습니다. 실제 네트워크 요청 중단에는 queryFn의 AbortSignal 사용도 필요합니다. inactive/disabled query를 무조건 다시 시작하지는 않습니다.
- `throwOnError` 기본값은 `true`이며 refetch 실패 시 반환 Promise가 reject됩니다. 이미 커밋된 업무 작업의 실패를 의미하지 않습니다. `false`면 refetch 오류를 전파하지 않습니다.

비동기 mutation callback 순서, 동시 command 조정, optimistic rollback, 로그인 응답 차단, artifact/persisted cache 정리는 앱 책임입니다. callback을 먼저 await한 뒤 무효화를 적용하고, 업무 성공과 callback/refetch 실패는 별도로 처리하십시오.

요청 당시의 session generation과 QueryClient를 보관하고 응답 및 callback 이후에도 현재 generation인지 검사합니다. 같은 사용자로 재로그인해도 scope 문자열 비교만으로는 구분할 수 없습니다. 로그아웃/로그인 시 기존 client를 폐기·정리하고 이전 응답을 막아야 합니다. 서버 artifact/계약 변경 시 client reset과 persistence/hydration buster도 앱에서 관리합니다.

후속 캐시 오류 때문에 command를 재실행하거나 커밋된 optimistic 상태를 rollback하지 마십시오. [통합 가이드](../../docs/migrations/cache-contract-0.5.md)에 예제가 있습니다. 최초 조회 경합은 실제 QueryObserver로 취소 유무 두 경로를 검증합니다.
