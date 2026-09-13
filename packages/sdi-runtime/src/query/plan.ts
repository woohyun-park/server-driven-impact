import {
  LIMITS,
  byteLength,
  canonical,
  isScalar,
  validateImpactManifest,
  type ImpactManifest,
  type ReadDependency,
} from '@server-driven-impact/core';
import { validateResources, type Resources } from '../resources.js';
import { assertInputPreserved, type Input, type InputParser, type InputSchema } from './input.js';
export type { Input } from './input.js';
type ResourceId = string;
export type { ReadDependency } from '@server-driven-impact/core';
export interface PostgresPolicyProof {
  resources: readonly string[];
  dependencies: readonly { resource: string; columns: '*' | readonly string[]; rowConstraint: 'same-row' | 'all' }[];
}
export interface PostgresCatalogStamp {
  schemas: readonly string[];
  fingerprint: string;
  effectiveRole?: string;
}

export interface QueryManifest extends ImpactManifest {
  /** Deployment definitions, independent of per-request data changes. */
  postgres?: {
    signature: string;
    catalog?: PostgresCatalogStamp;
    policyProofs?: Record<string, readonly PostgresPolicyProof[]>;
  };
}

export function validateManifest(manifest: QueryManifest, resources: Resources): void {
  validateImpactManifest(manifest, resources);
  if (byteLength(manifest) > LIMITS.manifestBytes) throw new Error('MANIFEST_LIMIT');
}

/**
 * Phantom result type carried by builders; the key never exists at runtime, so plan objects stay
 * byte-identical and manifest/observer/artifact fingerprints are unaffected.
 *
 * The key must stay the string `'~output'`. A `unique symbol` would need to be declared and, because
 * these packages build with `declaration: true`, a non-exported symbol cannot be named in the emitted
 * `.d.ts` — swapping the string for a symbol breaks declaration emit for all six packages.
 */
export type Typed<O> = { readonly '~output'?: O };
/** The result type a plan produces when executed; `unknown` for anything that carries no phantom. */
export type OutputOf<P> = P extends Typed<infer O> ? O : unknown;

export type Value = { kind: 'input'; field: string } | { kind: 'literal'; value: unknown };
export type AtomicPredicate = {
  kind?: 'atomic';
  field: string;
  op: '=' | '<>' | '<' | '<=' | '>' | '>=' | 'in' | 'is-null' | 'not-null';
  value?: Value;
};
export type Predicate =
  | AtomicPredicate
  | { kind: 'and' | 'or'; predicates: Predicate[] }
  | { kind: 'not'; predicate: Predicate };
export type Join = SelectOptions & {
  as: string;
  resource: ResourceId;
  local: string;
  foreign: string;
  many?: boolean;
  required?: boolean;
};
export type PageValue = number | Value;
export type SelectOptions = {
  columns?: string[];
  joins?: Join[];
  where?: Predicate[];
  order?: { field: string; ascending?: boolean; nullsFirst?: boolean }[];
  limit?: PageValue;
  offset?: PageValue;
};
export type SelectPlan<O = unknown> = {
  kind: 'select';
  resource: ResourceId;
  options: SelectOptions;
  result?: 'rows' | 'count';
} & Typed<O>;
/** PostgreSQL SQL compiled ahead of runtime with its read dependencies attached. */
export type PostgresQueryPlan<O = unknown> = {
  kind: 'postgres-query';
  text: string;
  parameters: readonly string[];
  reads: readonly ReadDependency[];
  cache?: 'no-store';
  searchPath?: readonly string[];
  catalog?: PostgresCatalogStamp;
  policyProof?: PostgresPolicyProof;
} & Typed<O>;
export type ExecutableQueryPlan = SelectPlan<unknown> | PostgresQueryPlan<unknown>;
export type Plan<O = unknown> =
  | SelectPlan<O>
  | PostgresQueryPlan<O>
  | ({ kind: 'value'; value: unknown } & Typed<O>)
  | ({ kind: 'call'; endpoint: string; input?: (input: Input) => Input } & Typed<O>)
  | ({ kind: 'combine'; children: Record<string, Plan> } & Typed<O>)
  | ({ kind: 'when'; test: (input: Input) => boolean; yes: Plan; no: Plan } & Typed<O>)
  | ({ kind: 'bind'; parent: Plan; child: Plan; input: (data: unknown, input: Input) => Input | null } & Typed<O>)
  | ({ kind: 'map'; source: Plan; project: (data: unknown, input: Input) => unknown } & Typed<O>)
  | ({ kind: 'choose'; choices: Record<string, Plan>; choose: (input: Input) => string } & Typed<O>);
export type QueryDefinition<
  S extends InputSchema<unknown, unknown> = InputSchema<unknown, unknown>,
  P extends Plan<unknown> = Plan<unknown>,
> = { input: S; plan: P };
/** A definition after `createImpact` has normalized either input style into one `{ parse }`. */
export type NormalizedQuery = { input: InputParser<unknown>; plan: Plan };
export type Manifest = QueryManifest & { sources: Record<string, string[]>; dependents: Record<string, string[]> };

/** A no-store child makes the entire composed endpoint non-cacheable. */
export function requiresNoStore(plan: Plan, queries: Record<string, QueryDefinition>): boolean {
  switch (plan.kind) {
    case 'postgres-query':
      return plan.cache === 'no-store';
    case 'select':
    case 'value':
      return false;
    case 'call':
      return requiresNoStore(queries[plan.endpoint].plan, queries);
    case 'map':
      return requiresNoStore(plan.source, queries);
    case 'bind':
      return requiresNoStore(plan.parent, queries) || requiresNoStore(plan.child, queries);
    case 'when':
      return requiresNoStore(plan.yes, queries) || requiresNoStore(plan.no, queries);
    case 'combine':
      return Object.values(plan.children).some(child => requiresNoStore(child, queries));
    case 'choose':
      return Object.values(plan.choices).some(child => requiresNoStore(child, queries));
  }
}

export const q = {
  // `Row` carries no constraint and defaults to `unknown`: an `interface` has no implicit index
  // signature, and a `Record<string, unknown>` default would make `unknown[] as Todo[]` fail at the call site.
  select<Row = unknown>(resource: ResourceId, options: SelectOptions = {}): SelectPlan<Row[]> {
    return { kind: 'select', resource, options };
  },
  input(field: string): Value {
    return { kind: 'input', field };
  },
  literal(value: unknown): Value {
    return { kind: 'literal', value };
  },
  eq(field: string, value: Value): Predicate {
    return { field, op: '=', value };
  },
  filter(field: string, op: AtomicPredicate['op'], value?: Value): Predicate {
    return { field, op, value };
  },
  and(...predicates: Predicate[]): Predicate {
    return { kind: 'and', predicates };
  },
  or(...predicates: Predicate[]): Predicate {
    return { kind: 'or', predicates };
  },
  not(predicate: Predicate): Predicate {
    return { kind: 'not', predicate };
  },
  count(resource: ResourceId, options: SelectOptions = {}): SelectPlan<number> {
    return { kind: 'select', resource, options, result: 'count' };
  },
  value<T>(value: T): Plan<T> {
    return { kind: 'value', value };
  },
  // NoInfer keeps the contextual `Plan<unknown>`/`Plan<any>` of the surrounding definition from
  // instantiating O. Without it a bare q.call() widens to the context instead of honoring its default.
  call<O = unknown>(endpoint: string, input?: (input: Input) => Input): Plan<NoInfer<O>> {
    return { kind: 'call', endpoint, ...(input ? { input } : {}) };
  },
  combine<C extends Record<string, Plan<any>>>(children: C): Plan<{ [K in keyof C]: OutputOf<C[K]> }> {
    return { kind: 'combine', children };
  },
  when<A, B>(test: (input: Input) => boolean, yes: Plan<A>, no: Plan<B>): Plan<A | B> {
    return { kind: 'when', test, yes, no };
  },
  bind<P, C>(parent: Plan<P>, child: Plan<C>, input: (data: P, input: Input) => Input | null): Plan<C | []> {
    return { kind: 'bind', parent, child, input: input as (data: unknown, input: Input) => Input | null };
  },
  map<S, R>(source: Plan<S>, project: (data: S, input: Input) => R): Plan<R> {
    return { kind: 'map', source, project: project as (data: unknown, input: Input) => unknown };
  },
  choose<C extends Record<string, Plan<any>>>(
    choices: C,
    choose: (input: Input) => keyof C & string,
  ): Plan<OutputOf<C[keyof C]>> {
    return { kind: 'choose', choices, choose };
  },
};

// Both executors ignore the count root projection, ordering, pagination and
// optional joins. Keep dependency derivation aligned with that execution path.
function readOptions(plan: SelectPlan): SelectOptions {
  return plan.result === 'count'
    ? { columns: [], where: plan.options.where, joins: plan.options.joins?.filter(join => join.required) }
    : plan.options;
}

export function compileManifest(queries: Record<string, QueryDefinition>, resources: Resources): Manifest {
  validateResources(resources);
  const assertResource = (id: string) => {
    if (!Object.hasOwn(resources, id)) throw new Error(`Unregistered resource: ${id}`);
  };
  const sources: Record<string, ResourceId[]> = Object.create(null);
  const visiting = new Set<string>();
  const nativePlans: PostgresQueryPlan[] = [];
  function endpoint(id: string): ResourceId[] {
    if (visiting.has(id)) throw new Error(`Query cycle: ${id}`);
    if (sources[id]) return sources[id];
    if (!Object.hasOwn(queries, id)) throw new Error(`Query missing: ${id}`);
    visiting.add(id);
    sources[id] = [...new Set(walk(queries[id].plan))].sort();
    visiting.delete(id);
    return sources[id];
  }
  function select(resource: ResourceId, options: SelectOptions): ResourceId[] {
    assertResource(resource);
    return [resource, ...(options.joins ?? []).flatMap(join => select(join.resource, join))];
  }
  function walk(plan: Plan): ResourceId[] {
    switch (plan.kind) {
      case 'select':
        return select(plan.resource, readOptions(plan));
      case 'postgres-query':
        nativePlans.push(plan);
        return plan.reads.map(read => read.resource);
      case 'value':
        return [];
      case 'call':
        return endpoint(plan.endpoint);
      case 'combine':
        return Object.values(plan.children).flatMap(walk);
      case 'when':
        return [...walk(plan.yes), ...walk(plan.no)];
      case 'bind':
        return [...walk(plan.parent), ...walk(plan.child)];
      case 'map':
        return walk(plan.source);
      case 'choose':
        return Object.values(plan.choices).flatMap(walk);
    }
  }
  Object.keys(queries).sort().forEach(endpoint);
  const sortedSources = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
  const dependents: Record<string, string[]> = Object.create(null);
  for (const [id, tables] of Object.entries(sortedSources)) {
    // biome-ignore lint/suspicious/noAssignInExpressions: intentional `??=` default-initialization - lazily creates the per-table dependents bucket on first use so it can be pushed to in the same expression.
    for (const table of tables) (dependents[table] ??= []).push(id);
  }
  function readSelect(
    resource: ResourceId,
    options: SelectOptions,
    inherited: ReadDependency['bindings'] = [],
    foreign?: string,
  ): ReadDependency[] {
    const atomic = (predicate: Predicate): AtomicPredicate[] =>
      'predicates' in predicate
        ? predicate.predicates.flatMap(atomic)
        : 'predicate' in predicate
          ? atomic(predicate.predicate)
          : [predicate];
    const guaranteedBindings = (predicate: Predicate): ReadDependency['bindings'] => {
      if ('predicate' in predicate) return [];
      if ('predicates' in predicate && predicate.kind === 'and')
        return predicate.predicates.flatMap(guaranteedBindings);
      if ('predicates' in predicate) {
        const branches = predicate.predicates.map(guaranteedBindings);
        if (!branches.length) return [];
        return branches[0].filter(binding =>
          branches
            .slice(1)
            .every(branch =>
              branch.some(candidate => candidate.column === binding.column && candidate.input === binding.input),
            ),
        );
      }
      return predicate.op === '=' && predicate.value?.kind === 'input'
        ? [{ column: predicate.field, input: predicate.value.field }]
        : [];
    };
    const guaranteedFilters = (predicate: Predicate): NonNullable<ReadDependency['filters']> => {
      if ('predicate' in predicate) return [];
      if ('predicates' in predicate && predicate.kind === 'and') return predicate.predicates.flatMap(guaranteedFilters);
      if ('predicates' in predicate) {
        const branches = predicate.predicates.map(guaranteedFilters);
        if (!branches.length) return [];
        return branches[0].filter(filter =>
          branches
            .slice(1)
            .every(branch =>
              branch.some(candidate => candidate.column === filter.column && candidate.value === filter.value),
            ),
        );
      }
      return predicate.op === '=' && predicate.value?.kind === 'literal' && isScalar(predicate.value.value)
        ? [{ column: predicate.field, value: predicate.value.value }]
        : [];
    };
    // Every retained condition is necessary independently, so truncating this
    // list is a safe loss of precision when a plan exceeds the bounded format.
    const filters = [
      ...new Map((options.where ?? []).flatMap(guaranteedFilters).map(filter => [canonical(filter), filter])).values(),
    ].slice(0, LIMITS.readFilters);
    const predicates = (options.where ?? []).flatMap(atomic);
    const columns = options.columns
      ? [
          ...new Set([
            ...options.columns,
            ...predicates.map(p => p.field),
            ...(options.order ?? []).map(p => p.field),
            ...(options.joins ?? []).map(j => j.local),
            ...(foreign ? [foreign] : []),
          ]),
        ].sort()
      : ('*' as const);
    const bindings = [...inherited, ...(options.where ?? []).flatMap(guaranteedBindings)];
    const children = (options.joins ?? []).flatMap(join => {
      const propagated = bindings
        .filter(binding => binding.column === join.local)
        .map(binding => ({ column: join.foreign, input: binding.input }));
      return readSelect(join.resource, join, propagated, join.foreign);
    });
    return [{ resource, columns, bindings, ...(filters.length ? { filters } : {}) }, ...children];
  }
  function readsFor(plan: Plan): ReadDependency[] {
    switch (plan.kind) {
      case 'select':
        return readSelect(plan.resource, readOptions(plan));
      case 'postgres-query':
        return [...plan.reads];
      case 'value':
        return [];
      // Arbitrary input mapping cannot be inverted safely. Retain columns, widen inputs.
      case 'call':
        return readsFor(queries[plan.endpoint].plan).map(r => (plan.input ? { ...r, bindings: [] } : r));
      case 'bind':
        return [...readsFor(plan.parent), ...readsFor(plan.child).map(r => ({ ...r, bindings: [] }))];
      case 'map':
        return readsFor(plan.source);
      case 'combine':
        return Object.values(plan.children).flatMap(readsFor);
      case 'when':
        return [...readsFor(plan.yes), ...readsFor(plan.no)];
      case 'choose':
        return Object.values(plan.choices).flatMap(readsFor);
    }
  }
  const reads = Object.fromEntries(Object.keys(sortedSources).map(id => [id, readsFor(queries[id].plan)]));
  // Selectors/column policies affect consistency too, so changes retire the previous graph.
  const manifest: Manifest = { protocolVersion: 1, sources: sortedSources, dependents, reads };
  if (nativePlans.length) {
    const stamps = nativePlans.flatMap(plan => (plan.catalog ? [plan.catalog] : []));
    const stamp = stamps[0];
    if (stamps.some(value => JSON.stringify(value) !== JSON.stringify(stamp)))
      throw new Error('MIXED_POSTGRES_ARTIFACTS');
    manifest.postgres = {
      signature: JSON.stringify(
        nativePlans.map(plan => [plan.text, plan.parameters, plan.cache ?? 'tracked', plan.searchPath ?? null]),
      ),
      ...(stamp ? { catalog: stamp } : {}),
    };
    function proofs(plan: Plan, unproven: Set<string>): PostgresPolicyProof[] {
      switch (plan.kind) {
        case 'postgres-query': {
          const proof = plan.cache !== 'no-store' && plan.catalog ? plan.policyProof : undefined;
          for (const read of plan.reads) if (!proof?.resources.includes(read.resource)) unproven.add(read.resource);
          return proof ? [proof] : [];
        }
        case 'select':
          for (const read of readsFor(plan)) unproven.add(read.resource);
          return [];
        case 'call':
          return proofs(queries[plan.endpoint].plan, unproven);
        case 'map':
          return proofs(plan.source, unproven);
        case 'bind':
          return [...proofs(plan.parent, unproven), ...proofs(plan.child, unproven)];
        case 'combine':
          return Object.values(plan.children).flatMap(child => proofs(child, unproven));
        case 'when':
          return [...proofs(plan.yes, unproven), ...proofs(plan.no, unproven)];
        case 'choose':
          return Object.values(plan.choices).flatMap(child => proofs(child, unproven));
        default:
          return [];
      }
    }
    const policyProofs = Object.fromEntries(
      Object.entries(queries).flatMap(([id, query]) => {
        const unproven = new Set<string>();
        const found = proofs(query.plan, unproven);
        // A definer helper's proof must not suppress validation of a separate
        // structured/direct read of that same table in a composed endpoint.
        return found.length
          ? [
              [
                id,
                found.map(proof => ({
                  ...proof,
                  resources: proof.resources.filter(resource => !unproven.has(resource)),
                })),
              ],
            ]
          : [];
      }),
    );
    if (Object.keys(policyProofs).length) manifest.postgres.policyProofs = policyProofs;
  }
  validateManifest(manifest, resources);
  return manifest;
}

export async function executePlan(
  plan: Plan,
  input: Input,
  queries: Record<string, NormalizedQuery>,
  execute: (plan: ExecutableQueryPlan, input: Input) => Promise<unknown[]>,
  resources: Resources,
  exactStringInputs: (endpoint: string) => readonly string[],
  /**
   * Exact-string fields carried from the endpoint the caller actually requested, or `null` once an
   * ancestor has widened the path. The cache key is built from the contract on the requested endpoint,
   * so every hop that still receives the caller's own input must preserve these fields, whether or not
   * a contract happens to name the hop as well.
   *
   * `null` and `[]` are deliberately different: `null` means an ancestor already widened this endpoint's
   * bindings, so nothing below it can desynchronize a selector and no hop may reintroduce a check from
   * its own declarations; `[]` means the path is still the caller's but nothing has been declared on it
   * yet, so a callee's own declarations still apply. Collapsing the two is what let a widened path be
   * re-checked by a contract that named only the callee.
   */
  requiredStringInputs: readonly string[] | null,
): Promise<unknown> {
  switch (plan.kind) {
    case 'select': {
      const rows = await execute(plan, input);
      return plan.result === 'count' ? (rows[0] ?? 0) : rows;
    }
    case 'postgres-query':
      return execute(plan, input);
    case 'value':
      return plan.value;
    case 'call': {
      if (!Object.hasOwn(queries, plan.endpoint)) throw new Error(`Query missing: ${plan.endpoint}`);
      const query = queries[plan.endpoint];
      const raw = plan.input ? plan.input(input) : input;
      const parsed = await query.input.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_QUERY_INPUT');
      // An input mapper ends the identity chain: `readsFor` drops this endpoint's bindings, so impact
      // has already widened and nothing below has to reproduce the caller's exact string. A path an
      // ancestor already widened stays widened, whatever this callee's own contracts declare.
      let carried: readonly string[] | null = null;
      if (!plan.input && requiredStringInputs) {
        // The nested schema re-parses a value the caller's cache key already committed to, so it needs
        // the same preservation check the top level applies. Both lists matter: a field declared only on
        // the requested endpoint and one declared only on this callee each need preserving.
        const callee = exactStringInputs(plan.endpoint);
        carried = callee.length ? [...new Set([...requiredStringInputs, ...callee])] : requiredStringInputs;
        assertInputPreserved(raw, parsed, carried);
      }
      return executePlan(query.plan, parsed as Input, queries, execute, resources, exactStringInputs, carried);
    }
    case 'combine': {
      // One connection/snapshot; keep statements sequential rather than pretending parallel transactions.
      const data: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(plan.children))
        data[key] = await executePlan(
          child,
          input,
          queries,
          execute,
          resources,
          exactStringInputs,
          requiredStringInputs,
        );
      return data;
    }
    case 'when':
      return executePlan(
        plan.test(input) ? plan.yes : plan.no,
        input,
        queries,
        execute,
        resources,
        exactStringInputs,
        requiredStringInputs,
      );
    case 'bind': {
      const data = await executePlan(
        plan.parent,
        input,
        queries,
        execute,
        resources,
        exactStringInputs,
        requiredStringInputs,
      );
      const next = plan.input(data, input);
      // The child's input is derived, not the caller's, and `readsFor` already dropped its bindings, so
      // the calculator emits a value-independent selector for it and there is no key left to mismatch.
      return next === null ? [] : executePlan(plan.child, next, queries, execute, resources, exactStringInputs, null);
    }
    case 'map':
      return plan.project(
        await executePlan(plan.source, input, queries, execute, resources, exactStringInputs, requiredStringInputs),
        input,
      );
    case 'choose': {
      const choice = plan.choose(input);
      if (!Object.hasOwn(plan.choices, choice)) throw new Error('Unregistered query choice');
      return executePlan(
        plan.choices[choice],
        input,
        queries,
        execute,
        resources,
        exactStringInputs,
        requiredStringInputs,
      );
    }
  }
}
