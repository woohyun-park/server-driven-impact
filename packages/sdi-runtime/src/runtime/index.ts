import { WriteSet } from '@server-driven-impact/core';
import { canonical, isScalar, type Scalar, type ImpactSet } from '@server-driven-impact/core';
import type { Resources } from '../resources.js';
import { createImpact as createCalculator } from '@server-driven-impact/core';
import { compileManifest, executePlan, requiresNoStore, type Input, type Plan, type QueryDefinition } from '../query/plan.js';
import { bindAdapter, type ImpactAdapter } from './adapter.js';
import { ImpactUnavailableError } from './errors.js';

export interface Context { scope: Scalar }
export interface CommandResult<T> { data: T; impact: ImpactSet }

// Copy plan containers but preserve application callbacks and validators. Mutating a
// registered plan must never change execution without changing its dependency graph.
function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot)) as T;
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('NON_PLAIN_PLAN_VALUE');
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)]))) as T;
  }
  return value;
}
function scopeOf(context: Context): Scalar {
  if (!context || !Object.hasOwn(context, 'scope') || !isScalar(context.scope)) throw new Error('INVALID_SCOPE');
  return context.scope;
}
function parseInput(definition: QueryDefinition, value: unknown): Input {
  const input = definition.input.parse(value);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_QUERY_INPUT');
  return input as Input;
}

export function createImpact<Db, Q extends Record<string, QueryDefinition>>(options: {
  adapter: ImpactAdapter<Db>; resources: Resources; queries: Q;
}) {
  if (!options?.adapter || typeof options.adapter[bindAdapter] !== 'function') throw new Error('IMPACT_ADAPTER_REQUIRED');
  if (!options.queries || typeof options.queries !== 'object') throw new Error('QUERY_DEFINITIONS_REQUIRED');
  const resources = snapshot(JSON.parse(canonical(options.resources)) as Resources);
  const queries: Record<string, QueryDefinition> = Object.create(null);
  for (const [name, query] of Object.entries(options.queries)) {
    if (!query?.input || typeof query.input.parse !== 'function') throw new Error('INVALID_QUERY_DEFINITION');
    const parse = query.input.parse.bind(query.input);
    if (!query.plan) throw new Error('QUERY_PLAN_REQUIRED');
    queries[name] = Object.freeze({ input: { parse }, plan: snapshot<Plan>(query.plan) });
  }
  Object.freeze(queries);
  const manifest = compileManifest(queries, resources);
  const calculator = createCalculator({ resources, manifest });
  const adapter = options.adapter[bindAdapter](resources, manifest);
  return Object.freeze({
    artifact: adapter.artifact,
    validate: () => adapter.validate(),
    async query(endpoint: keyof Q & string, input: unknown, context: Context): Promise<unknown> {
      const scope = scopeOf(context);
      if (!Object.hasOwn(queries, endpoint)) throw new Error('UNKNOWN_QUERY');
      if (requiresNoStore(queries[endpoint].plan, queries)) throw new Error('QUERY_REQUIRES_NO_STORE_EXECUTION');
      const parsed = parseInput(queries[endpoint], input);
      return adapter.query(scope, select => executePlan(queries[endpoint].plan, parsed, queries, select, resources));
    },
    /** Each invocation executes anew. This response must never enter a reusable query cache. */
    async queryUncached(endpoint: keyof Q & string, input: unknown, context: Context) {
      const scope = scopeOf(context);
      if (!Object.hasOwn(queries, endpoint)) throw new Error('UNKNOWN_QUERY');
      const parsed = parseInput(queries[endpoint], input);
      const data = await adapter.query(scope, select => executePlan(queries[endpoint].plan, parsed, queries, select, resources));
      return { data, cachePolicy: 'no-store' as const };
    },
    async command<T>(context: Context, work: (db: Db) => Promise<T>): Promise<CommandResult<T>> {
      const scope = scopeOf(context);
      const writes = new WriteSet(new Set(Object.keys(resources)));
      try {
        const data = await adapter.command(scope, writes, work);
        // The driver resolves after commit. All observations are now available.
        let impact: ReturnType<typeof calculator.calculate>;
        try {
          impact = calculator.calculate(writes.snapshot(), scope);
        } catch (cause) {
          throw new ImpactUnavailableError(data, { cause });
        }
        return { data, impact };
      } finally { writes.close(); }
    },
  });
}
