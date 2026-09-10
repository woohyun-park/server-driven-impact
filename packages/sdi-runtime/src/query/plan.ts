import { LIMITS, byteLength, validateImpactManifest, type ImpactManifest, type ReadDependency } from '@server-driven-impact/core';
import { validateResources, type Resources } from '../resources.js';
type ResourceId = string;
export type { ReadDependency } from '@server-driven-impact/core';

export interface QueryManifest extends ImpactManifest {
  /** Deployment definitions, independent of per-request data changes. */
  postgres?: { signature: string; catalog?: { schemas: readonly string[]; fingerprint: string } };
}

export function validateManifest(manifest: QueryManifest, resources: Resources): void {
  validateImpactManifest(manifest, resources);
  if (byteLength(manifest) > LIMITS.manifestBytes) throw new Error('MANIFEST_LIMIT');
}

export type Input = Record<string, unknown>;
export type Value = { kind: 'input'; field: string } | { kind: 'literal'; value: unknown };
export type AtomicPredicate = { kind?: 'atomic'; field: string; op: '=' | '<>' | '<' | '<=' | '>' | '>=' | 'in' | 'is-null' | 'not-null'; value?: Value };
export type Predicate = AtomicPredicate | { kind: 'and' | 'or'; predicates: Predicate[] } | { kind: 'not'; predicate: Predicate };
export type Join = SelectOptions & { as: string; resource: ResourceId; local: string; foreign: string; many?: boolean; required?: boolean };
export type PageValue = number | Value;
export type SelectOptions = { columns?: string[]; joins?: Join[]; where?: Predicate[]; order?: { field: string; ascending?: boolean; nullsFirst?: boolean }[]; limit?: PageValue; offset?: PageValue };
export type SelectPlan = { kind: 'select'; resource: ResourceId; options: SelectOptions; result?: 'rows' | 'count' };
/** PostgreSQL SQL compiled ahead of runtime with its read dependencies attached. */
export type PostgresQueryPlan = { kind: 'postgres-query'; text: string; parameters: readonly string[]; reads: readonly ReadDependency[]; cache?: 'no-store'; searchPath?: readonly string[]; catalog?: { schemas: readonly string[]; fingerprint: string } };
export type ExecutableQueryPlan = SelectPlan | PostgresQueryPlan;
export type Plan =
  | SelectPlan
  | PostgresQueryPlan
  | { kind: 'value'; value: unknown }
  | { kind: 'call'; endpoint: string; input: (input: Input) => Input }
  | { kind: 'combine'; children: Record<string, Plan> }
  | { kind: 'when'; test: (input: Input) => boolean; yes: Plan; no: Plan }
  | { kind: 'bind'; parent: Plan; child: Plan; input: (data: unknown, input: Input) => Input | null }
  | { kind: 'map'; source: Plan; project: (data: unknown, input: Input) => unknown }
  | { kind: 'choose'; choices: Record<string, Plan>; choose: (input: Input) => string };
export type QueryDefinition = { input: { parse(value: unknown): unknown }; plan: Plan };
export type Manifest = QueryManifest & { sources: Record<string, string[]>; dependents: Record<string, string[]> };

/** A no-store child makes the entire composed endpoint non-cacheable. */
export function requiresNoStore(plan: Plan, queries: Record<string, QueryDefinition>): boolean {
  switch (plan.kind) {
    case 'postgres-query': return plan.cache === 'no-store';
    case 'select': case 'value': return false;
    case 'call': return requiresNoStore(queries[plan.endpoint].plan, queries);
    case 'map': return requiresNoStore(plan.source, queries);
    case 'bind': return requiresNoStore(plan.parent, queries) || requiresNoStore(plan.child, queries);
    case 'when': return requiresNoStore(plan.yes, queries) || requiresNoStore(plan.no, queries);
    case 'combine': return Object.values(plan.children).some(child => requiresNoStore(child, queries));
    case 'choose': return Object.values(plan.choices).some(child => requiresNoStore(child, queries));
  }
}

export const q = {
  select(resource: ResourceId, options: SelectOptions = {}): SelectPlan { return { kind: 'select', resource, options }; },
  input(field: string): Value { return { kind: 'input', field }; },
  literal(value: unknown): Value { return { kind: 'literal', value }; },
  eq(field: string, value: Value): Predicate { return { field, op: '=', value }; },
  filter(field: string, op: AtomicPredicate['op'], value?: Value): Predicate { return { field, op, value }; },
  and(...predicates: Predicate[]): Predicate { return { kind: 'and', predicates }; },
  or(...predicates: Predicate[]): Predicate { return { kind: 'or', predicates }; },
  not(predicate: Predicate): Predicate { return { kind: 'not', predicate }; },
  count(resource: ResourceId, options: SelectOptions = {}): SelectPlan { return { kind: 'select', resource, options, result: 'count' }; },
  value(value: unknown): Plan { return { kind: 'value', value }; },
  call(endpoint: string, input: (input: Input) => Input = (input) => input): Plan { return { kind: 'call', endpoint, input }; },
  combine(children: Record<string, Plan>): Plan { return { kind: 'combine', children }; },
  when(test: (input: Input) => boolean, yes: Plan, no: Plan): Plan { return { kind: 'when', test, yes, no }; },
  bind(parent: Plan, child: Plan, input: (data: unknown, input: Input) => Input | null): Plan { return { kind: 'bind', parent, child, input }; },
  map(source: Plan, project: (data: unknown, input: Input) => unknown): Plan { return { kind: 'map', source, project }; },
  choose(choices: Record<string, Plan>, choose: (input: Input) => string): Plan { return { kind: 'choose', choices, choose }; },
};

export function compileManifest(queries: Record<string, QueryDefinition>, resources: Resources): Manifest {
  validateResources(resources);
  const assertResource = (id: string) => { if (!Object.hasOwn(resources,id)) throw new Error(`Unregistered resource: ${id}`); };
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
    return [resource, ...(options.joins ?? []).flatMap((join) => select(join.resource, join))];
  }
  function walk(plan: Plan): ResourceId[] {
    switch (plan.kind) {
      case 'select': return select(plan.resource, plan.options);
      case 'postgres-query': nativePlans.push(plan); return plan.reads.map(read => read.resource);
      case 'value': return [];
      case 'call': return endpoint(plan.endpoint);
      case 'combine': return Object.values(plan.children).flatMap(walk);
      case 'when': return [...walk(plan.yes), ...walk(plan.no)];
      case 'bind': return [...walk(plan.parent), ...walk(plan.child)];
      case 'map': return walk(plan.source);
      case 'choose': return Object.values(plan.choices).flatMap(walk);
    }
  }
  Object.keys(queries).sort().forEach(endpoint);
  const sortedSources = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
  const dependents: Record<string, string[]> = Object.create(null);
  for (const [id, tables] of Object.entries(sortedSources)) for (const table of tables) (dependents[table] ??= []).push(id);
  function readSelect(resource: ResourceId, options: SelectOptions, inherited: ReadDependency['bindings'] = [], foreign?: string): ReadDependency[] {
    const atomic = (predicate: Predicate): AtomicPredicate[] => 'predicates' in predicate
      ? predicate.predicates.flatMap(atomic) : 'predicate' in predicate ? atomic(predicate.predicate) : [predicate];
    const guaranteedBindings = (predicate: Predicate): ReadDependency['bindings'] => {
      if ('predicate' in predicate) return [];
      if ('predicates' in predicate && predicate.kind === 'and') return predicate.predicates.flatMap(guaranteedBindings);
      if ('predicates' in predicate) {
        const branches = predicate.predicates.map(guaranteedBindings);
        if (!branches.length) return [];
        return branches[0].filter(binding => branches.slice(1).every(branch => branch.some(candidate => candidate.column === binding.column && candidate.input === binding.input)));
      }
      return predicate.op === '=' && predicate.value?.kind === 'input' ? [{column:predicate.field,input:predicate.value.field}] : [];
    };
    const predicates = (options.where ?? []).flatMap(atomic);
    const columns = options.columns ? [...new Set([
      ...options.columns, ...predicates.map(p => p.field),
      ...(options.order ?? []).map(p => p.field), ...(options.joins ?? []).map(j => j.local),
      ...(foreign ? [foreign] : []),
    ])].sort() : '*' as const;
    const bindings = [...inherited, ...(options.where ?? []).flatMap(guaranteedBindings)];
    const children = (options.joins ?? []).flatMap(join => {
      const propagated = bindings.filter(binding => binding.column === join.local).map(binding => ({column:join.foreign,input:binding.input}));
      return readSelect(join.resource, join, propagated, join.foreign);
    });
    return [{ resource, columns, bindings }, ...children];
  }
  function readsFor(plan: Plan): ReadDependency[] {
    switch (plan.kind) {
      case 'select': return readSelect(plan.resource, plan.options);
      case 'postgres-query': return [...plan.reads];
      case 'value': return [];
      // Arbitrary input mapping cannot be inverted safely. Retain columns, widen inputs.
      case 'call': return readsFor(queries[plan.endpoint].plan).map(r => ({ ...r, bindings: [] }));
      case 'bind': return [...readsFor(plan.parent), ...readsFor(plan.child).map(r => ({ ...r, bindings: [] }))];
      case 'map': return readsFor(plan.source);
      case 'combine': return Object.values(plan.children).flatMap(readsFor);
      case 'when': return [...readsFor(plan.yes), ...readsFor(plan.no)];
      case 'choose': return Object.values(plan.choices).flatMap(readsFor);
    }
  }
  const reads = Object.fromEntries(Object.keys(sortedSources).map(id => [id, readsFor(queries[id].plan)]));
  // Selectors/column policies affect consistency too, so changes retire the previous graph.
  const manifest: Manifest = { protocolVersion:1, sources: sortedSources, dependents, reads };
  if (nativePlans.length) {
    const stamps = nativePlans.flatMap(plan => plan.catalog ? [plan.catalog] : []);
    const stamp = stamps[0];
    if (stamps.some(value => JSON.stringify(value) !== JSON.stringify(stamp))) throw new Error('MIXED_POSTGRES_ARTIFACTS');
    manifest.postgres = { signature: JSON.stringify(nativePlans.map(plan => [plan.text,plan.parameters,plan.cache ?? 'tracked',plan.searchPath ?? null])), ...(stamp ? {catalog:stamp} : {}) };
  }
  validateManifest(manifest,resources);
  return manifest;
}

export async function executePlan(plan: Plan, input: Input, queries: Record<string, QueryDefinition>, execute: (plan: ExecutableQueryPlan, input: Input) => Promise<unknown[]>, resources: Resources): Promise<unknown> {
  switch (plan.kind) {
    case 'select': {
      const rows = await execute(plan, input);
      return plan.result === 'count' ? (rows[0] ?? 0) : rows;
    }
    case 'postgres-query': return execute(plan,input);
    case 'value': return plan.value;
    case 'call': {
      if (!Object.hasOwn(queries, plan.endpoint)) throw new Error(`Query missing: ${plan.endpoint}`);
      const query = queries[plan.endpoint];
      return executePlan(query.plan, query.input.parse(plan.input(input)) as Input, queries, execute, resources);
    }
    case 'combine': {
      // One connection/snapshot; keep statements sequential rather than pretending parallel transactions.
      const data: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(plan.children)) data[key] = await executePlan(child, input, queries, execute, resources);
      return data;
    }
    case 'when': return executePlan(plan.test(input) ? plan.yes : plan.no, input, queries, execute, resources);
    case 'bind': {
      const data = await executePlan(plan.parent, input, queries, execute, resources);
      const next = plan.input(data, input);
      return next === null ? [] : executePlan(plan.child, next, queries, execute, resources);
    }
    case 'map': return plan.project(await executePlan(plan.source, input, queries, execute, resources), input);
    case 'choose': {
      const choice = plan.choose(input);
      if (!Object.hasOwn(plan.choices, choice)) throw new Error('Unregistered query choice');
      return executePlan(plan.choices[choice], input, queries, execute, resources);
    }
  }
}
