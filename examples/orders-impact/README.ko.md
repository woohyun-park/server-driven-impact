# 독립 orders 도메인 예제

[English](./README.md) | [한국어](./README.ko.md)

`domain.ts`는 `orders`와 `order_items` Resource, tenant scope, 고객 selector, 추적되는 cascade를 정의합니다. 목록, 항목을 포함한 상세, 준비 상태 주문, 총액 Query를 등록하며 네 공개 `@server-driven-impact/*` 패키지 경계만 사용합니다.

`demo.ts`는 주문의 고객이 바뀌는 상황을 실행합니다. 이전 고객과 새 고객의 목록이 모두 impact에 포함되는지 확인하고, 결과 데이터와 `ImpactSet`을 출력합니다.

```bash
pnpm pack:check
```

이 명령은 네 패키지를 tarball로 만든 뒤 외부 임시 프로젝트에 설치하고 `demo.ts`를 컴파일해 실행합니다. 따라서 workspace 내부 연결에 기대어 우연히 성공하는 예제가 아닌지도 함께 확인할 수 있습니다.

PostgreSQL 통합 테스트는 격리된 테스트 DB에 임시 `sdi_test_*` schema를 만들고 전용 RLS role을 부여한 뒤 teardown에서 제거합니다. `pnpm test:postgres`는 생성, 이동, child cascade, 집계, 빈 Query, predicate, 정렬, rollback, savepoint, 지연 constraint 실패, RLS를 검사합니다. `pnpm test:matrix`는 같은 필수 suite를 PostgreSQL 14–18과 두 지원 드라이버에서 실행합니다.
