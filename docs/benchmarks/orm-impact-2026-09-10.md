# Native SQL / ORM 관찰 비용 비교

2026-09-10. 측정 스크립트: [`benchmark-sdi-orm.mjs`](../../scripts/backend/benchmark-sdi-orm.mjs).

## 비교 조건

각 mode는 같은 형태의 `(id integer primary key, value integer)` 테이블에서 모든 행의 `value`를 1 증가시키고, 영향 행 수만 반환한 뒤 COMMIT한다. observer 없는 native SQL·Drizzle·Prisma와 SDI 관찰을 적용한 pg·Drizzle·Prisma를 각각 비교한다. 관찰 없는 테이블에는 observer trigger를 설치하지 않는다. 관찰 mode는 같은 Resource 정의와 ID 입력에 바인딩한 detail Query를 사용한다.

Native SQL은 비교 대상 Drizzle update builder의 `toSQL()` 결과와 parameters를 그대로 사용한다. 테이블 이름만 fixture마다 다르다. Prisma는 같은 의미의 `updateMany({ data: { value: { increment: 1 } } })`를 실행하므로 SQL text가 같다는 주장은 하지 않는다. Prisma는 두 mode 모두 command마다 Client를 생성하고 disconnect한다. 따라서 Prisma 결과에는 그 초기화 비용이 포함된다.

- 행 수: 1 / 1,000 / 10,000. 각 serial 시나리오에 warmup 2회와 측정 최소 10회.
- 격리 수준: REPEATABLE READ. node-postgres Pool 크기: 4.
- serial sample마다 첫 mode를 바꿔 고정 실행 순서의 영향을 줄인다.
- 단건 동시성: 같은 행을 동시에 변경하는 4개 command. serialization failure는 최대 20회 재시도한다.
- 같은 연결의 acquire→release 시간을 연결 점유 시간으로 기록한다. 전체 시간에는 연결 대기, ORM 초기화, ImpactSet 계산도 포함된다.
- SQL calls는 `pg.Client.query()` 호출 횟수다. BEGIN/COMMIT과 collector SQL도 포함하며, 네트워크 패킷을 측정한 값은 아니다.
- impact/response bytes의 JSON 직렬화와 DB 결과 검증용 SELECT는 측정 시간 밖에서 수행한다. 시간 안의 업무 SELECT는 0건인지 검사한다.
- 관찰 artifact 생성과 `engine.validate()`는 측정 전에 수행한다. 비용을 요청마다 발생하는 것으로 섞지 않는다.
- 동시성 결과의 `requestP50Ms` / `requestP95Ms`와 처리량에는 실패한 시도·재시도가 포함된다. 일반 `p50Ms` / `p95Ms`, 연결 점유 및 SQL calls는 성공한 시도만의 값이다.

## 재현

먼저 패키지를 빌드하고 로컬 테스트 PostgreSQL 및 `routine_runtime` role을 준비한다. 스크립트는 고유 schema를 만들고 완료 후 그 schema를 제거한다. Prisma generator의 출력도 `.local`의 고유 폴더에 만들고 제거한다.

```sh
pnpm build
SDI_POSTGRES_ADMIN_URL=postgresql://postgres:sdi@127.0.0.1:32859/sdi \
SDI_POSTGRES_RUNTIME_URL=postgresql://routine_runtime:runtime@127.0.0.1:32859/sdi \
SDI_BENCHMARK_SAMPLES=15 \
SDI_BENCHMARK_OUTPUT=.local/runtime/orm-benchmark.json \
node scripts/backend/benchmark-sdi-orm.mjs
```

Prisma를 제외할 때만 `SDI_BENCHMARK_PRISMA=0`을 설정한다. 기본 실행은 여섯 mode를 모두 검사한다. PostgreSQL matrix·다른 benchmark와 동시에 실행하지 않는다.

## 실행 결과

측정: `2026-09-10T11:26:21.367Z`, Node `v25.8.0`, PostgreSQL `18.6` (aarch64 Docker). pg `8.16.3`, Drizzle `0.45.2`, Prisma / adapter-pg `7.10.0`. Serial은 각 15회, 동시성은 mode별 성공 요청 60개다. 단일 PK의 불필요한 batch min/max 집계를 생략하는 최종 observer 최적화가 반영된 빌드로 재실행했다.

### Serial 지연과 연결 점유

모든 시간 단위는 ms다. Impact bytes가 0이면 관찰 없는 대조군이다.

| 행 수 | Mode | p50 | p95 | 점유 p50 | 점유 p95 | SQL calls | Impact bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | native-plain | 1.495 | 1.897 | 1.478 | 1.872 | 3 | 0 |
| 1 | drizzle-plain | 1.480 | 2.564 | 1.464 | 2.538 | 3 | 0 |
| 1 | native-observed | 4.002 | 6.375 | 3.944 | 6.312 | 8 | 121 |
| 1 | drizzle-observed | 3.878 | 9.255 | 3.829 | 9.182 | 8 | 121 |
| 1 | prisma-plain | 2.698 | 7.211 | 2.296 | 6.630 | 4 | 0 |
| 1 | prisma-observed | 5.070 | 9.828 | 5.022 | 9.751 | 8 | 121 |
| 1,000 | native-plain | 6.975 | 11.692 | 6.944 | 11.654 | 3 | 0 |
| 1,000 | drizzle-plain | 5.667 | 10.282 | 5.637 | 10.224 | 3 | 0 |
| 1,000 | native-observed | 9.938 | 21.261 | 9.849 | 20.619 | 8 | 98 |
| 1,000 | drizzle-observed | 10.980 | 40.131 | 10.616 | 39.927 | 8 | 98 |
| 1,000 | prisma-plain | 8.056 | 11.518 | 7.129 | 10.720 | 4 | 0 |
| 1,000 | prisma-observed | 11.815 | 37.659 | 11.739 | 37.563 | 8 | 98 |
| 10,000 | native-plain | 23.192 | 36.202 | 23.164 | 36.169 | 3 | 0 |
| 10,000 | drizzle-plain | 21.347 | 34.244 | 21.311 | 34.172 | 3 | 0 |
| 10,000 | native-observed | 26.793 | 74.702 | 26.718 | 74.555 | 8 | 98 |
| 10,000 | drizzle-observed | 26.370 | 77.136 | 26.293 | 76.976 | 8 | 98 |
| 10,000 | prisma-plain | 22.761 | 48.126 | 22.278 | 47.506 | 4 | 0 |
| 10,000 | prisma-observed | 28.736 | 42.382 | 28.659 | 42.283 | 8 | 98 |

### 같은 행을 변경하는 동시 요청 4개

요청 지연과 처리량은 serialization failure에 따른 재시도를 포함한다.

| Mode | 요청 p50 ms | 요청 p95 ms | 성공/초 | 재시도 수 | 성공 시도 점유 p50 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| native-plain | 6.028 | 10.847 | 420.9 | 81 | 1.761 |
| drizzle-plain | 5.820 | 10.149 | 422.7 | 89 | 1.786 |
| native-observed | 12.436 | 23.129 | 186.9 | 88 | 5.236 |
| drizzle-observed | 11.588 | 17.911 | 233.0 | 90 | 4.049 |
| prisma-plain | 8.832 | 15.414 | 289.7 | 85 | 2.491 |
| prisma-observed | 11.165 | 20.936 | 197.8 | 90 | 4.785 |

## 해석과 한계

**관찰 비용은 유의미하다.** Native의 p50은 1행에서 1.495→4.002 ms, 1,000행에서 6.975→9.938 ms, 10,000행에서 23.192→26.793 ms로 증가했다. 대응하는 Drizzle 증가분은 2.398 / 5.313 / 5.023 ms, Prisma 증가분은 2.372 / 3.759 / 5.975 ms였다. 관찰 없는 native보다 빨라졌다고 주장할 근거가 없다. 특히 수 ms 수준의 단건 지연 예산에는 현재 비용이 클 수 있다.

관찰 mode는 모두 요청당 SQL calls가 8회이고, plain native/Drizzle은 3회다. collector 준비·token 설정·commit 이후 회수·artifact 동기화를 위한 연결 제어가 단건 비용에 기여한다. 대량 변경에서는 transition relation과 요약 계산 비용도 발생하므로 행 수와 무관한 상수 시간이라고 설명할 수 없다. 이 측정만으로 PostgreSQL 실행 비용과 JS 계산 비용을 각각 정확하게 분리할 수는 없다.

ORM 자체 비용과 관찰 비용을 구분해서 읽어야 한다. 1행 plain Prisma p50은 2.698 ms로 plain native의 1.495 ms보다 컸다. Prisma plain은 자체 transaction 시작 후 별도 isolation SQL을 보내 4회가 측정됐고, observed는 SDI가 바깥 BEGIN을 소유해 8회였다. 따라서 Prisma의 두 mode 차이는 observer만 한 겹 추가한 완전히 동일한 transaction 시작 경로의 차이가 아니다. Drizzle의 plain/observed는 같은 update builder를 사용하며, 모든 ORM 모델의 비용을 이 단순 update로 대표하지 않는다.

모든 성공 요청은 물리 연결을 정확히 한 번 예약했고, 측정 중 업무 SELECT는 0건이었다. 관찰 mode의 ImpactSet은 1행에서 `inputs` 121 bytes, 1,000/10,000행에서 `all` 98 bytes였다. 큰 배치가 더 작은 payload를 만든 이유는 상세 facts 상한 200을 넘어 요약되었기 때문이다. 이는 정밀도가 좋아졌다는 뜻이 아니다. 현재 Query는 ID 범위를 열어 두므로 변경 대상 외 ID까지 포함하는 보수적 확장을 허용한다. 단건에서는 해당 ID만 선택한다. 전체 응답 최대 크기는 관찰 mode에서 141 / 121 / 122 bytes였다.

네 writer가 같은 행에 경쟁하는 조건에서 native 처리량은 관찰 전후 420.9→186.9/s였다. Drizzle은 422.7→233.0/s, Prisma는 289.7→197.8/s였다. 각 mode에 81–90회의 serialization 재시도가 발생했다. 이는 서로 다른 행을 갱신하는 일반적인 병렬 처리량이나 무경합 성능이 아니다. 재시도는 benchmark harness의 정책이며 라이브러리가 자동으로 mutation을 재실행한다는 뜻이 아니다.

Serial 15개 표본의 nearest-rank p95는 사실상 최댓값이다. p95가 p50보다 크게 튀는 구간이 있고 mode별로 일관되지 않아, 소수 ms의 ORM 간 순위나 tail latency 우열을 확정하지 않는다. 로컬 Docker, OS 스케줄링, GC 및 짧은 실행의 영향을 포함한 한 번의 관찰이다. 특히 1,000행 plain baseline도 이전 실행과 변동하므로 실행 간 수치 차이를 모두 observer 최적화의 효과로 돌리지 않는다. 성능 SLA 통과 여부를 정하려면 앱 workload와 예산에 맞춘 장시간 측정이 추가로 필요하다.

원본 전체 JSON은 실행 위치의 `.local/runtime/orm-benchmark.json`에 남겼다. 위 표와 해석은 최종 observer 최적화 후 완료한 실행의 값으로 전부 갱신했다. 이전 실행이나 실패한 시도의 수치를 섞지 않았다. Benchmark는 Drizzle `error.cause`의 `40001`과 Prisma의 `P2034`를 재시도 가능한 serialization failure로 분류한다.
