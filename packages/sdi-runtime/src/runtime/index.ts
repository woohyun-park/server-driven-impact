import { WriteSet } from '@server-driven-impact/core';
import { canonical, isScalar, type Scalar, type CommandResult } from '@server-driven-impact/core';
import type { Resources } from '../resources.js';
import { createImpact as createCalculator } from '@server-driven-impact/core';
import {
  compileManifest,
  executePlan,
  requiresNoStore,
  type Input,
  type NormalizedQuery,
  type OutputOf,
  type Plan,
  type QueryDefinition,
} from '../query/plan.js';
import { assertInputPreserved, snapshotInput, toParse, type QueryInput } from '../query/input.js';
import { bindAdapter, type ImpactAdapter } from './adapter.js';
import { applyAssessment, unavailableImpact } from '@server-driven-impact/core';

export interface Context {
  scope: Scalar;
}
export type { CommandResult } from '@server-driven-impact/core';

// Copy plan containers but preserve application callbacks and validators. Mutating a
// registered plan must never change execution without changing its dependency graph.
function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot)) as T;
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('NON_PLAIN_PLAN_VALUE');
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)]))) as T;
  }
  return value;
}
function scopeOf(context: Context): Scalar {
  if (!context || !Object.hasOwn(context, 'scope') || !isScalar(context.scope)) throw new Error('INVALID_SCOPE');
  return context.scope;
}
async function parseInput(
  definition: NormalizedQuery,
  value: unknown,
  preservedInputs: readonly string[],
): Promise<Input> {
  const before = snapshotInput(value, preservedInputs);
  const input = await definition.input.parse(value);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_QUERY_INPUT');
  assertInputPreserved(before, input, preservedInputs);
  return input as Input;
}

export function createImpact<Db, Q extends Record<string, QueryDefinition>>(options: {
  adapter: ImpactAdapter<Db>;
  resources: Resources;
  queries: Q;
}) {
  if (!options?.adapter || typeof options.adapter[bindAdapter] !== 'function')
    throw new Error('IMPACT_ADAPTER_REQUIRED');
  if (!options.queries || typeof options.queries !== 'object') throw new Error('QUERY_DEFINITIONS_REQUIRED');
  const resources = snapshot(JSON.parse(canonical(options.resources)) as Resources);
  const queries: Record<string, NormalizedQuery> = Object.create(null);
  for (const [name, query] of Object.entries(options.queries)) {
    if (!query?.input) throw new Error('INVALID_QUERY_DEFINITION');
    const parse = toParse(query.input);
    if (!query.plan) throw new Error('QUERY_PLAN_REQUIRED');
    if (query.inputRelation !== undefined && !['preserve', 'opaque'].includes(query.inputRelation))
      throw new Error('INVALID_INPUT_RELATION');
    queries[name] = Object.freeze({
      input: { parse },
      inputRelation: query.inputRelation ?? 'preserve',
      plan: snapshot<Plan>(query.plan),
    });
  }
  Object.freeze(queries);
  const manifest = compileManifest(queries, resources);
  const adapter = options.adapter[bindAdapter](resources, manifest);
  const calculator = createCalculator({ resources, manifest });
  const preservedInputs = (endpoint: string) => [
    ...new Set(manifest.reads[endpoint].flatMap(read => read.bindings.map(binding => binding.input))),
  ];
  async function executeCommand<T>(scope: Scalar, work: (db: Db) => Promise<T>): Promise<CommandResult<T>> {
    const writes = new WriteSet(new Set(Object.keys(resources)));
    try {
      const { data, assessment } = await adapter.command(scope, writes, work);
      // The driver resolves after commit. All observations are now available.
      let impact: ReturnType<typeof calculator.calculate>;
      try {
        impact = calculator.calculate(writes.snapshot(), scope, assessment);
      } catch {
        impact = applyAssessment(unavailableImpact(manifest, 'CALCULATION_FAILED'), assessment);
      }
      return { data, commitState: 'committed', impact };
    } finally {
      writes.close();
    }
  }
  function command<T>(context: Context, work: (db: Db) => Promise<T>): Promise<CommandResult<T>> {
    return executeCommand(scopeOf(context), work);
  }
  return Object.freeze({
    artifact: adapter.artifact,
    validate: () => adapter.validate(),
    async query<K extends keyof Q & string>(
      endpoint: K,
      input: QueryInput<Q[K]['input']>,
      context: Context,
    ): Promise<OutputOf<Q[K]['plan']>> {
      const scope = scopeOf(context);
      if (!Object.hasOwn(queries, endpoint)) throw new Error('UNKNOWN_QUERY');
      if (requiresNoStore(queries[endpoint].plan, queries)) throw new Error('QUERY_REQUIRES_NO_STORE_EXECUTION');
      const required = preservedInputs(endpoint);
      const parsed = await parseInput(queries[endpoint], input, required);
      return adapter.query(scope, select =>
        executePlan(queries[endpoint].plan, parsed, queries, select, resources, preservedInputs, required),
      ) as Promise<OutputOf<Q[K]['plan']>>;
    },
    /** Each invocation executes anew. This response must never enter a reusable query cache. */
    async queryUncached<K extends keyof Q & string>(
      endpoint: K,
      input: QueryInput<Q[K]['input']>,
      context: Context,
    ): Promise<{ data: OutputOf<Q[K]['plan']>; cachePolicy: 'no-store' }> {
      const scope = scopeOf(context);
      if (!Object.hasOwn(queries, endpoint)) throw new Error('UNKNOWN_QUERY');
      const required = preservedInputs(endpoint);
      const parsed = await parseInput(queries[endpoint], input, required);
      const data = (await adapter.query(scope, select =>
        executePlan(queries[endpoint].plan, parsed, queries, select, resources, preservedInputs, required),
      )) as OutputOf<Q[K]['plan']>;
      return { data, cachePolicy: 'no-store' as const };
    },
    command,
  });
}
