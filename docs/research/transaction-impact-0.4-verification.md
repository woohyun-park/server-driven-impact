# SDI 0.4 구현·검증 기록

검증일: 2026-09-10. 기준선 `c24e226`(0.3.0), 작업 브랜치 `feat/transaction-impact-contract`. 원본 폴더와 기존 main worktree를 유지하고 별도 worktree에서 구현했다.

## 구현 결과

- mutation의 직접 쓰기, FK cascade, 업무 trigger 및 COMMIT 시 deferred write를 관찰한 후 WriteSet을 회수한다. rollback/savepoint 취소는 제외하며 core helper도 COMMIT·drain 완료 뒤 계산한다.
- WriteSet 상한은 resource별로 요약하며 공통 OLD/NEW scope·binding을 보존한다. selector 상한은 공통 입력 조건을 남기고 응답 byte 상한은 개별 endpoint/scope를 넓힌다.
- 지원 Query Plan의 고정 equality 필터, count의 실제 읽기 의존성, catalog로 증명한 native SQL 컬럼 의존성으로 불필요한 영향을 줄인다. 비교 의미가 검증되지 않으면 확장한다.
- RLS의 숨은 컬럼·다른 행·다른 scope 의존성을 검증하고 안전한 무조건 의존성이 없으면 활성화를 거절한다. SQLite의 `UPDATE OR REPLACE` 등 관찰 누락 경계도 거절한다.
- pg native QueryResult·per-query codec, postgres.js lazy query, SQLite 동기 prepared statement를 보존하고 실행 수명을 검사한다. 비동기 검증 중 SQL/scope가 변경돼 검증 기준이 달라지는 경로도 차단했다.
- 선택 Drizzle 0.45.2 및 Prisma 7.10.0 연동을 같은 pg 연결·transaction·savepoint에 연결했다. ORM 프로토타입과 실제 실행 결과를 보존한다.
- orders 예제는 수동 WriteFact/무효화 목록 없이 `{ data, impact }`를 직렬화하고 프론트에서 OLD/NEW 고객 목록·상세 입력을 선택한다.

## 검증

| 검사 | 결과 |
| --- | --- |
| `pnpm typecheck` | 통과: 4개 package 및 repository 타입 검사 |
| `pnpm test` | 120 passed; DB 환경이 필요한 58개는 이 실행에서 skipped, 아래 필수 matrix로 별도 검증 |
| PostgreSQL 14–18 × postgres.js/pg | 10개 조합 모두 통과: 조합당 64개, 총 640 passed / 0 skipped |
| 0.4.0 tarball 독립 소비 | Node 25.8.0, 22.18.0, 24.21.0 통과 |
| 각 Node의 tarball PostgreSQL 예제 | postgres.js·pg 모두 통과 |
| 선택 의존성·공개 타입 | core/runtime/SQLite 단독, pg만, postgres.js만, Drizzle만, Prisma adapter만 설치·import·factory 타입 검사 통과 |
| 소스 diff·matrix runner 문법 | `git diff --check`, `node --check` 통과 |

Prisma 생성 모델을 사용하는 실제 transaction 검증은 DB matrix에서 수행한다. tarball의 Prisma 단독 소비 검사는 생성기 없이 공개 factory 타입과 import 독립성을 확인한다.

Node 22·24 검사는 `SDI_PACK_USE_EXISTING=1`로 같은 네 tarball을 사용했다. Drizzle 소비자만 upstream 0.45.2 선언 문제로 `skipLibCheck`를 사용하며 소비자 코드와 잘못된 모델 입력 거절은 별도 타입 검사한다. 다른 소비자는 declaration 검사도 수행한다.

필수 PostgreSQL runner는 fixture skip을 실패로 처리한다. 기존 runner에 빠져 있던 공통 어댑터의 PostgreSQL 사례도 필수 목록에 추가했다. 공통 어댑터 사례는 SQLite와 postgres.js를 사용하며 pg 모드에서는 기존 pg 전용 conformance와 함께 반복 실행된다. 대량 배치의 공통 고객 조건 보존도 기대값으로 검증한다. Docker VM 디스크 부족으로 DB 초기화가 중단됐던 실행은 통과 근거에 포함하지 않았고, 작업 전용 DB/볼륨 정리 후 runner의 기동 실패 로그·볼륨 정리를 보완해 재실행했다. 기존 앱 컨테이너/볼륨은 변경하지 않았다.

## 비용과 지원 경계

[Core 정밀도 비용](../benchmarks/impact-precision-2026-09-10.md), [0.3 대비 observer 비용](../benchmarks/observer-cost-2026-09-10.md), [native/Drizzle/Prisma 비용](../benchmarks/orm-impact-2026-09-10.md)을 별도로 기록했다. 정밀도 보존은 CPU와 응답 크기를 늘릴 수 있다. 최종 native/ORM 실험은 모두 같은 연결을 사용했고 영향 계산을 위한 추가 업무 SELECT는 0건이었다. 로컬 표본 결과를 보편적인 성능 개선이나 SLA로 해석하지 않는다.

Resource/Query 등록과 배포 시 artifact 설치·검증은 필요하다. 임의 ORM 조회 전체 자동 분석, 별도 연결의 외부 쓰기 전파, realtime/outbox, transaction pooling 및 네트워크 응답 유실 복구는 이번 범위에 없다. 세부 사항은 [0.4 migration](../migrations/transaction-impact-0.4.md), [자동 분석 경계](./query-automation-boundaries.md)를 따른다.

## 릴리스 준비와 증거 위치

Changeset minor를 적용해 공개 4개 package를 `0.4.0`으로 맞추고 core/runtime peer를 `^0.4.0`으로 제한했다. observer protocol은 9, 프론트 ImpactSet protocol은 1이다. 이 로컬 검증을 마친 뒤 사용자가 “릴리즈 진행”을 요청해 commit·push·PR·main 반영·npm publish를 승인했다. 원격 배포 결과는 GitHub release와 workflow 실행 기록으로 확인한다. Routine은 별도 이전 안내만 작성했고 소스를 변경하지 않았다.

- `.local/runtime/final-matrix.log`, `.local/runtime/postgres-release/matrix.json` 및 조합별 JSON
- `.local/runtime/final-pack-node25.log`, `final-pack-node22.log`, `final-pack-node24.log`
- `.local/artifacts/sdi/`: 4개 tarball과 SHA-512를 포함한 `release-manifest.json`
- `.local/postgres-baseline-output.json`, `.local/postgres-current-output.json`, `.local/runtime/orm-benchmark.json`

위 `.local` 증거와 tarball은 저장소에서 ignore한다. 결과 요약·재현 명령·지원 한계는 추적 가능한 이 문서와 연결된 보고서에 보존한다.
