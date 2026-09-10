import { createImpact } from '@server-driven-impact/core';
import { performance } from 'node:perf_hooks';

const samples = Number(process.env.SDI_BENCHMARK_SAMPLES ?? 30);
if (!Number.isInteger(samples) || samples < 5 || samples > 1_000) throw new Error('INVALID_BENCHMARK_SAMPLES');

for (const endpoints of [1, 32, 128]) {
  const resources = { records: { scopeColumn: 'tenant', columns: ['id', 'tenant', 'category'] } };
  const manifest = {
    protocolVersion: 1,
    reads: Object.fromEntries(Array.from({ length: endpoints }, (_, index) => [`endpoint.${index}`, [{
      resource: 'records', columns: '*', bindings: [{ column: 'category', input: 'category' }],
    }]])),
  };
  const calculator = createImpact({ resources, manifest });
  const writes = Array.from({ length: 100 }, (_, index) => ({
    resource: 'records', operation: 'insert', before: { kind: 'absent' },
    after: { kind: 'known', scope: 'tenant', fields: { category: `category-${index}` } }, changedColumns: null,
  }));
  calculator.calculate(writes, 'tenant');
  const durations = [];
  let result;
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    result = calculator.calculate(writes, 'tenant');
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const percentile = value => durations[Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)];
  console.log(JSON.stringify({
    endpoints, facts: writes.length, samples,
    p50Ms: Number(percentile(0.5).toFixed(2)), p95Ms: Number(percentile(0.95).toFixed(2)),
    responseBytes: Buffer.byteLength(JSON.stringify(result)),
    broadTargets: result.targets.filter(target => target.selector.kind === 'all').length,
  }));
}
