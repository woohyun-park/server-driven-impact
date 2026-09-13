import { WriteSet } from '@server-driven-impact/core';
import { canonical, isScalar, type Scalar, type ImpactSet } from '@server-driven-impact/core';
import type { Resources } from '../resources.js';
import { createImpact as createCalculator } from '@server-driven-impact/core';
import {
  compileManifest,
  executePlan,
  requiresNoStore,
  type Input,
  type Plan,
  type QueryDefinition,
} from '../query/plan.js';
import { bindAdapter, type ImpactAdapter } from './adapter.js';
import { ImpactUnavailableError } from './errors.js';
import {
  createCacheContractRegistry,
  defineCacheContract,
  type CacheContract,
  type CacheContractReference,
  type CacheInvalidationSet,
  type CacheCompileOptions,
} from '@server-driven-impact/cache-contract';

export interface Context {
  scope: Scalar;
}
export interface CommandOptions {
  /** Select an additional cache representation; logical ImpactSet is always retained. */
  cacheContract?: CacheContractReference;
}
export interface CommandResult<T> {
  data: T;
  impact: ImpactSet;
}
export interface CommandInvalidationResult<T> extends CommandResult<T> {
  cacheInvalidation: CacheInvalidationSet;
}

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
function parseInput(definition: QueryDefinition, value: unknown, exactStringInputs: readonly string[] = []): Input {
  const input = definition.input.parse(value);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_QUERY_INPUT');
  if (exactStringInputs.length) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('QUERY_INPUT_PRESERVATION_VIOLATION');
    for (const field of exactStringInputs) {
      if (
        Object.hasOwn(value, field) !== Object.hasOwn(input, field) ||
        (Object.hasOwn(value, field) &&
          (value as Record<string, unknown>)[field] !== (input as Record<string, unknown>)[field])
      ) {
        throw new Error('QUERY_INPUT_PRESERVATION_VIOLATION:' + field);
      }
    }
  }
  return input as Input;
}

export function createImpact<Db, Q extends Record<string, QueryDefinition>>(options: {
  adapter: ImpactAdapter<Db>;
  resources: Resources;
  queries: Q;
  cacheContracts?: readonly CacheContract[];
  cacheInvalidationOptions?: CacheCompileOptions;
}) {
  if (!options?.adapter || typeof options.adapter[bindAdapter] !== 'function')
    throw new Error('IMPACT_ADAPTER_REQUIRED');
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
  const adapter = options.adapter[bindAdapter](resources, manifest);
  const configuredCacheContracts = (options.cacheContracts ?? []).map(defineCacheContract);
  const cacheContracts = createCacheContractRegistry(configuredCacheContracts, {
    endpoints: Object.entries(queries).map(([endpoint, query]) => ({
      endpoint,
      cache: requiresNoStore(query.plan, queries) ? 'no-store' : 'cacheable',
    })),
    compile: options.cacheInvalidationOptions,
    stringComparison(endpoint, input) {
      return adapter.verifiedStringComparisons?.().some(proof => proof.endpoint === endpoint && proof.input === input)
        ? 'verified'
        : 'comparison-unproven';
    },
  });
  const calculator = createCalculator({ resources, manifest });
  const enabledStringInputs = new Map<string, Set<string>>();
  for (const contract of configuredCacheContracts)
    for (const query of contract.queries) {
      const fields = enabledStringInputs.get(query.endpoint) ?? new Set<string>();
      for (const [field, definition] of Object.entries(query.input))
        if (definition.type === 'string' && definition.required && !definition.coerce && definition.format !== 'uuid')
          fields.add(field);
      enabledStringInputs.set(query.endpoint, fields);
    }
  const exactStringInputs = (endpoint: string) => {
    const enabled = enabledStringInputs.get(endpoint);
    if (!enabled?.size) return [];
    return (
      adapter
        .verifiedStringComparisons?.()
        .filter(proof => proof.endpoint === endpoint && enabled.has(proof.input))
        .map(proof => proof.input) ?? []
    );
  };
  async function executeCommand<T>(scope: Scalar, work: (db: Db) => Promise<T>): Promise<CommandResult<T>> {
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
    } finally {
      writes.close();
    }
  }
  function command<T>(
    context: Context,
    work: (db: Db) => Promise<T>,
    output: CommandOptions & { cacheContract: CacheContractReference },
  ): Promise<CommandInvalidationResult<T>>;
  function command<T>(
    context: Context,
    work: (db: Db) => Promise<T>,
    output?: { cacheContract?: undefined },
  ): Promise<CommandResult<T>>;
  function command<T>(
    context: Context,
    work: (db: Db) => Promise<T>,
    output: CommandOptions | undefined,
  ): Promise<CommandResult<T> | CommandInvalidationResult<T>>;
  async function command<T>(
    context: Context,
    work: (db: Db) => Promise<T>,
    output: CommandOptions = {},
  ): Promise<CommandResult<T> | CommandInvalidationResult<T>> {
    // Validate the selected representation before work, and retain request-time
    // values even if the caller mutates its options/context while work awaits.
    const reference = output.cacheContract;
    const registered = reference === undefined ? undefined : cacheContracts.resolve(reference);
    const resolved = registered && { id: registered.id, version: registered.version };
    const scope = scopeOf(context);
    const result = await executeCommand(scope, work);
    if (!resolved) return result;
    try {
      return { ...result, cacheInvalidation: cacheContracts.compile(resolved, result.impact, scope) };
    } catch (cause) {
      throw new ImpactUnavailableError(result.data, { cause, phase: 'cache-invalidation', impact: result.impact });
    }
  }
  return Object.freeze({
    artifact: adapter.artifact,
    validate: () => adapter.validate(),
    async query(endpoint: keyof Q & string, input: unknown, context: Context): Promise<unknown> {
      const scope = scopeOf(context);
      if (!Object.hasOwn(queries, endpoint)) throw new Error('UNKNOWN_QUERY');
      if (requiresNoStore(queries[endpoint].plan, queries)) throw new Error('QUERY_REQUIRES_NO_STORE_EXECUTION');
      const parsed = parseInput(queries[endpoint], input, exactStringInputs(endpoint));
      return adapter.query(scope, select => executePlan(queries[endpoint].plan, parsed, queries, select, resources));
    },
    /** Each invocation executes anew. This response must never enter a reusable query cache. */
    async queryUncached(endpoint: keyof Q & string, input: unknown, context: Context) {
      const scope = scopeOf(context);
      if (!Object.hasOwn(queries, endpoint)) throw new Error('UNKNOWN_QUERY');
      const parsed = parseInput(queries[endpoint], input, exactStringInputs(endpoint));
      const data = await adapter.query(scope, select =>
        executePlan(queries[endpoint].plan, parsed, queries, select, resources),
      );
      return { data, cachePolicy: 'no-store' as const };
    },
    command,
  });
}
