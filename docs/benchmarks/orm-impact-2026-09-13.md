# Native SQL / ORM 관찰 비용 비교

2026-09-13. 측정 스크립트: [`benchmark-sdi-orm.mjs`](../../scripts/backend/benchmark-sdi-orm.mjs). 이 실행은 preamble typing/biome 작업(단일 왕복 command/read preamble, `search_path` 트랜잭션당 1회 설정)이 반영된 빌드로, 2026-09-10 문서 이후 처음 다시 측정한 결과다. 측정: `2026-09-13T09:41:11.589Z`, Node `v24.15.0`, PostgreSQL `18.6`(aarch64 Docker, 앞선 태스크들이 통합 테스트에 쓰던 `sdi-pg` 고정 포트 컨테이너, `127.0.0.1:55432`). pg `8.16.3`, Drizzle `0.45.2`, Prisma / adapter-pg `7.10.0`. Serial은 각 10회(표본 최솟값), 동시성은 mode별 성공 요청 40개다. 2026-09-10 실행은 Node `v25.8.0`, 임시 포트 컨테이너, serial 15회로 조건이 달라 ms 값을 직접 비교하지 않는다.

## 비교 조건

각 mode는 같은 형태의 `(id integer primary key, value integer)` 테이블에서 모든 행의 `value`를 1 증가시키고, 영향 행 수만 반환한 뒤 COMMIT한다. observer 없는 native SQL·Drizzle·Prisma와 SDI 관찰을 적용한 pg·Drizzle·Prisma를 각각 비교한다. 관찰 없는 테이블에는 observer trigger를 설치하지 않는다. 관찰 mode는 같은 Resource 정의와 ID 입력에 바인딩한 detail Query를 사용한다.

Native SQL은 비교 대상 Drizzle update builder의 `toSQL()` 결과와 parameters를 그대로 사용한다. 테이블 이름만 fixture마다 다르다. Prisma는 같은 의미의 `updateMany({ data: { value: { increment: 1 } } })`를 실행하므로 SQL text가 같다는 주장은 하지 않는다. Prisma는 두 mode 모두 command마다 Client를 생성하고 disconnect한다. 따라서 Prisma 결과에는 그 초기화 비용이 포함된다.

- 행 수: 1 / 1,000 / 10,000. 각 serial 시나리오에 warmup 2회와 측정 최소 10회.
- 격리 수준: REPEATABLE READ. node-postgres Pool 크기: 4.
- serial sample마다 첫 mode를 바꿔 고정 실행 순서의 영향을 줄인다.
- 단건 동시성: 같은 행을 동시에 변경하는 4개 command. serialization failure는 최대 20회 재시도한다.
- 같은 연결의 acquire→release 시간을 연결 점유 시간으로 기록한다. 전체 시간에는 연결 대기, ORM 초기화, ImpactSet 계산도 포함된다.
- SQL calls는 `pg.Client.query()` 호출 횟수다. 관찰 mode는 단일 왕복으로 합쳐진 command preamble(세션 잠금, collector 테이블, `BEGIN`, 요청 설정)과 그 뒤의 `COMMIT`, observer 회수 SQL을 포함하며, 네트워크 패킷을 측정한 값은 아니다.
- impact/response bytes의 JSON 직렬화와 DB 결과 검증용 SELECT는 측정 시간 밖에서 수행한다. 시간 안의 업무 SELECT는 0건인지 검사한다.
- 관찰 artifact 생성과 `engine.validate()`는 측정 전에 수행한다. 비용을 요청마다 발생하는 것으로 섞지 않는다.
- 동시성 결과의 `requestP50Ms` / `requestP95Ms`와 처리량에는 실패한 시도·재시도가 포함된다. 일반 `p50Ms` / `p95Ms`, 연결 점유 및 SQL calls는 성공한 시도만의 값이다.

## 재현

먼저 패키지를 빌드하고, 이 실행에서는 이미 떠 있던 `sdi-pg`(PostgreSQL 18.6, `127.0.0.1:55432`) 컨테이너와 `routine_runtime` role을 그대로 사용했다. 스크립트는 고유 schema를 만들고 완료 후 그 schema를 제거한다. Prisma generator의 출력도 `.local`의 고유 폴더에 만들고 제거한다.

```sh
pnpm build
export SDI_POSTGRES_ADMIN_URL=postgresql://postgres:sdi@127.0.0.1:55432/sdi
export SDI_POSTGRES_RUNTIME_URL=postgresql://routine_runtime:runtime@127.0.0.1:55432/sdi
SDI_BENCHMARK_SAMPLES=10 node scripts/backend/benchmark-sdi-orm.mjs
```

Prisma를 제외할 때만 `SDI_BENCHMARK_PRISMA=0`을 설정한다. 기본 실행은 여섯 mode를 모두 검사한다. `SDI_BENCHMARK_OUTPUT`을 지정하지 않아 원본 JSON은 기본 경로 `.local/runtime/orm-benchmark.json`에 남았다. PostgreSQL matrix·다른 benchmark와 동시에 실행하지 않는다.

## 실행 결과

### Serial 지연과 연결 점유

모든 시간 단위는 ms다. Impact bytes가 0이면 관찰 없는 대조군이다. SQL calls는 표본 10개 모두에서 최솟값과 최댓값이 같았다(변동 없음).

| 행 수 | Mode | p50 | p95 | 점유 p50 | 점유 p95 | SQL calls | Impact bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | native-plain | 1.057 | 2.656 | 1.050 | 2.629 | 3 | 0 |
| 1 | drizzle-plain | 1.175 | 3.391 | 1.168 | 3.371 | 3 | 0 |
| 1 | native-observed | 2.611 | 4.852 | 2.566 | 4.748 | 5 | 121 |
| 1 | drizzle-observed | 2.384 | 4.619 | 2.347 | 4.541 | 5 | 121 |
| 1 | prisma-plain | 2.118 | 5.059 | 1.778 | 4.431 | 4 | 0 |
| 1 | prisma-observed | 2.653 | 6.667 | 2.618 | 6.578 | 5 | 121 |
| 1,000 | native-plain | 2.354 | 3.375 | 2.345 | 3.366 | 3 | 0 |
| 1,000 | drizzle-plain | 2.476 | 2.939 | 2.468 | 2.927 | 3 | 0 |
| 1,000 | native-observed | 3.293 | 4.070 | 3.261 | 4.026 | 5 | 98 |
| 1,000 | drizzle-observed | 3.417 | 4.503 | 3.379 | 4.470 | 5 | 98 |
| 1,000 | prisma-plain | 3.254 | 3.843 | 2.945 | 3.538 | 4 | 0 |
| 1,000 | prisma-observed | 3.850 | 4.288 | 3.806 | 4.256 | 5 | 98 |
| 10,000 | native-plain | 13.567 | 25.291 | 13.548 | 25.272 | 3 | 0 |
| 10,000 | drizzle-plain | 13.465 | 26.681 | 13.446 | 26.661 | 3 | 0 |
| 10,000 | native-observed | 17.030 | 21.449 | 16.981 | 21.404 | 5 | 98 |
| 10,000 | drizzle-observed | 16.942 | 17.663 | 16.898 | 17.617 | 5 | 98 |
| 10,000 | prisma-plain | 15.468 | 28.086 | 15.126 | 27.738 | 4 | 0 |
| 10,000 | prisma-observed | 17.048 | 23.674 | 16.996 | 23.628 | 5 | 98 |

### 같은 행을 변경하는 동시 요청 4개

요청 지연과 처리량은 serialization failure에 따른 재시도를 포함한다.

| Mode | 요청 p50 ms | 요청 p95 ms | 성공/초 | 재시도 수 | 성공 시도 점유 p50 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| native-plain | 3.713 | 7.065 | 684.3 | 57 | 1.065 |
| drizzle-plain | 3.395 | 5.802 | 712.6 | 60 | 1.091 |
| native-observed | 4.909 | 8.488 | 482.2 | 58 | 1.973 |
| drizzle-observed | 6.107 | 9.855 | 437.2 | 60 | 2.027 |
| prisma-plain | 5.989 | 10.384 | 411.8 | 60 | 1.732 |
| prisma-observed | 7.115 | 10.766 | 383.7 | 60 | 2.369 |

## 해석과 한계

**단일 왕복 preamble이 관찰 SQL calls를 8회에서 5회로 줄였다.** 2026-09-10 문서는 세 관찰 mode(native/drizzle/prisma-observed) 모두 요청당 8회였다. 이번 실행에서는 같은 세 mode가 행 수·동시성 조건 전부에서 예외 없이 5회였고, 표본 10개의 최솟값과 최댓값이 모두 같아 변동이 없었다. 관찰 없는 대조군(native/drizzle-plain 3회, prisma-plain 4회)은 이번에도 그대로다. SQL calls는 실제 SQL round trip 횟수를 세는 결정적 카운터이므로, 이 감소는 표본 잡음이 아니라 command preamble을 세션 잠금·collector 테이블·BEGIN·요청 설정 한 번으로 합치고 읽기 경로에서 `search_path`를 트랜잭션당 한 번만 설정하도록 바꾼 구현 변경에 직접 대응한다.

**ms 값은 2026-09-10 문서와 나란히 비교하지 않는다.** 이번 실행은 Node `v24.15.0`(이전 `v25.8.0`), 임시 포트 컨테이너 대신 다른 태스크의 통합 테스트가 쓰던 `sdi-pg` 고정 포트 컨테이너(`127.0.0.1:55432`), serial 10회(이전 15회)로 조건이 다르다. 이 문서 안에서도 관찰 mode의 p50은 대조군보다 항상 컸다(예: 1행 native 1.057→2.611 ms, 10,000행 native 13.567→17.030 ms). 이는 preamble이 한 번으로 줄었어도 여전히 0이 아닌 고정 비용이 남아 있다는 뜻이지, 이전 실행 대비 지연이 개선되었다거나 악화되었다는 근거는 아니다. 서로 다른 실행·환경의 지연 수치를 이 구현 변경 하나의 효과로 돌리지 않는다.

**Serial 표 10개 표본의 nearest-rank p95는 사실상 최댓값이다.** `percentile = sorted[ceil(n × fraction) - 1]`이고 Serial 지연 표(1/1,000/10,000행)는 `n = 10`이므로 `ceil(0.95 × 10) - 1 = 9`(0-index), 즉 정렬한 10개 중 10번째 값 — 표본 최댓값을 그대로 p95로 쓴다. 꼬리 지연 분포를 추정한 값이 아니다. 예를 들어 10,000행 drizzle-observed는 p50 16.942 / p95 17.663으로 근접하지만, 1,000행 drizzle-observed는 p50 3.417 / p95 4.503으로 상대적으로 크게 벌어진다. 표본이 10개뿐인 단일 실행에서 mode 간 순위나 꼬리 지연 우열을 정하지 않는다.

**동시성 표의 p95는 성공 요청 40개에 대한 실제 nearest-rank 95번째 백분위수다.** 동시성 표는 `n = 40`(모드별 성공 요청 40개)이므로 `ceil(0.95 × 40) - 1 = 37`(0-index), 즉 정렬한 40개 중 38번째 값을 쓴다. 이는 40번째(최댓값)와 다른 값이므로 Serial 표의 "사실상 최댓값" caveat은 동시성 표에는 적용되지 않는다. 다만 40개도 여전히 작은 표본이므로, 이 값을 안정적인 tail-latency 추정치로 확대 해석하지는 않는다.

**Impact bytes는 2026-09-10 문서와 동일하다.** 1행 관찰 mode는 `inputs` 121 bytes, 1,000/10,000행은 `all` 98 bytes로 이전 문서와 일치한다. `{ data, impact }` 응답 형태와 ImpactSet 계산 로직은 이번 preamble/타입 추론 변경으로 바뀌지 않았음을 이 값이 뒷받침한다. 응답 최대 크기도 141 / 121 / 122 bytes로 동일하다.

네 writer가 같은 행에 경쟁하는 조건에서 native 처리량은 관찰 전후 684.3→482.2/s, Drizzle은 712.6→437.2/s, Prisma는 411.8→383.7/s였다. 각 mode에 57–60회의 serialization 재시도가 발생했다. 이는 서로 다른 행을 갱신하는 일반적인 병렬 처리량이나 무경합 성능이 아니며, 재시도는 benchmark harness의 정책이지 라이브러리가 자동으로 mutation을 재실행한다는 뜻이 아니다.

로컬 Docker, OS 스케줄링, GC 및 짧은 실행(표본 10개)의 영향을 포함한 한 번의 관찰이다. 성능 SLA 통과 여부를 정하려면 앱 workload와 예산에 맞춘 장시간·다중 실행 측정이 추가로 필요하다.

원본 전체 JSON은 실행 위치의 `.local/runtime/orm-benchmark.json`에 남겼다. Benchmark는 Drizzle `error.cause`의 `40001`과 Prisma의 `P2034`를 재시도 가능한 serialization failure로 분류한다.
