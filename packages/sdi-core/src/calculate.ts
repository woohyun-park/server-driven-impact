import {
  LIMITS,
  byteLength,
  canonical,
  scalarMayEqual,
  validateImpactManifest,
  validateImpactResources,
  type ImpactResources,
  type Scalar,
  type ImpactManifest,
  type WriteFact,
  type ImpactSet,
  type EndpointTarget,
  type EndpointImpact,
  type CommandResult,
  type ValidationReport,
} from './contracts.js';
import type { WriteSet } from './write-set.js';
import { unavailableImpact, boundImpact, applyAssessment } from './assessment.js';
type ImpactTarget = EndpointTarget & { endpoint: string };
export interface Decision {
  resource: string;
  endpoint?: string;
  reason:
    | 'scope-excluded'
    | 'filter-excluded'
    | 'columns-unchanged'
    | 'unknown-row'
    | 'missing-binding'
    | 'matched'
    | 'selector-limit'
    | 'byte-limit';
}
/** Pure calculator: callers/adapters own manifest dependency and write observation completeness; no DB validation occurs here. */
export interface CalculateOptions {
  resources: ImpactResources;
  manifest: ImpactManifest;
  scope: Scalar;
  explain?: (decision: Decision) => void;
  assessment?: ValidationReport;
}
type IndexedRead = { endpoint: string; read: ImpactManifest['reads'][string][number] };
type ReadIndex = ReadonlyMap<string, readonly IndexedRead[]>;
const utf8 = new TextEncoder();
function indexReads(manifest: ImpactManifest): ReadIndex {
  const index = new Map<string, IndexedRead[]>();
  for (const [endpoint, reads] of Object.entries(manifest.reads))
    for (const read of reads) {
      const entries = index.get(read.resource) ?? [];
      entries.push({ endpoint, read });
      index.set(read.resource, entries);
    }
  return index;
}
export function calculateImpact(writes: readonly WriteFact[], options: CalculateOptions): ImpactSet {
  validateImpactResources(options.resources);
  validateImpactManifest(options.manifest, options.resources);
  return calculate(writes, options, indexReads(options.manifest));
}
function calculate(writes: readonly WriteFact[], options: CalculateOptions, readsByResource: ReadIndex): ImpactSet {
  const { resources, scope, explain } = options;
  type Alternative = { value: Record<string, Scalar>; fields: number; bytes: number };
  type TargetEntry = {
    target: ImpactTarget;
    bytes: number;
    alternatives: Map<string, Alternative>;
    minFields: number;
    maxFields: number;
  };
  const targets = new Map<string, TargetEntry>();
  const reduced = new Set<string>();

  function setTarget(
    key: string,
    target: ImpactTarget,
    alternatives = new Map<string, Alternative>(),
    bytes = byteLength(target),
    minFields = Infinity,
    maxFields = -Infinity,
  ): void {
    targets.set(key, { target, bytes, alternatives, minFields, maxFields });
  }
  for (const write of writes) {
    if (!Object.hasOwn(resources, write.resource)) throw new Error('UNREGISTERED_RESOURCE');
    const resource = resources[write.resource];
    for (const row of [write.before, write.after]) {
      if (row.kind === 'absent') continue;
      const targetScope = resource.scopeColumn === null ? 'global' : 'caller';
      for (const { endpoint, read: originalRead } of readsByResource.get(write.resource) ?? []) {
        const assessment = options.assessment?.endpoints[endpoint];
        if (assessment?.status === 'unavailable') continue;
        const broaden = assessment?.status === 'conservative';
        const read = broaden ? { ...originalRead, columns: '*' as const, bindings: [], filters: [] } : originalRead;
        if (!broaden && resource.scopeColumn !== null && row.kind === 'known' && row.scope !== scope) {
          explain?.({ resource: write.resource, reason: 'scope-excluded' });
          continue;
        }
        if (
          write.operation === 'update' &&
          write.changedColumns !== null &&
          !(resource.scopeColumn !== null && write.changedColumns.includes(resource.scopeColumn)) &&
          !write.changedColumns.some(
            c => read.columns === '*' || read.columns.includes(c) || read.filters?.some(filter => filter.column === c),
          )
        ) {
          explain?.({ resource: write.resource, endpoint, reason: 'columns-unchanged' });
          continue;
        }
        if (
          row.kind === 'known' &&
          read.filters?.some(
            filter =>
              row.equalityFields &&
              Object.hasOwn(row.equalityFields, filter.column) &&
              !filterMayEqual(row.equalityFields[filter.column], filter.value),
          )
        ) {
          explain?.({ resource: write.resource, endpoint, reason: 'filter-excluded' });
          continue;
        }
        if (
          row.kind === 'unknown' ||
          write.operation === 'unknown' ||
          (write.operation === 'update' && write.changedColumns === null && read.columns !== '*') ||
          read.filters?.some(
            filter =>
              row.kind !== 'known' ||
              !row.equalityFields ||
              !Object.hasOwn(row.equalityFields, filter.column) ||
              row.equalityFields[filter.column] !== filter.value,
          )
        )
          reduced.add(endpoint);
        const input: Record<string, Scalar> = Object.create(null);
        let reason: Decision['reason'] = row.kind === 'unknown' ? 'unknown-row' : 'matched';
        for (const binding of read.bindings) {
          if (row.kind === 'known' && Object.hasOwn(row.fields, binding.column)) {
            const value = row.fields[binding.column];
            // Contradictory bindings cannot safely be represented by a single conjunction.
            if (Object.hasOwn(input, binding.input) && input[binding.input] !== value) {
              for (const k of Object.keys(input)) delete input[k];
              reason = 'missing-binding';
              break;
            }
            input[binding.input] = value;
          } else reason = row.kind === 'unknown' ? 'unknown-row' : 'missing-binding';
        }
        const key = canonical([endpoint, targetScope]);
        const previous = targets.get(key);
        if (previous?.target.selector.kind !== 'all') {
          const fields = Object.keys(input).length;
          const valueKey = canonical(input);
          const alternatives = previous?.alternatives ?? new Map<string, Alternative>();
          const covered =
            alternatives.has(valueKey) ||
            (previous &&
              previous.minFields < fields &&
              [...alternatives.values()].some(value => value.fields < fields && subsumes(value.value, input)));
          if (!fields) setTarget(key, { endpoint, scope: targetScope, selector: { kind: 'all' } });
          else if (!covered) {
            const oldCount = alternatives.size;
            const inputBytes = utf8.encode(valueKey).length;
            let deltaBytes = inputBytes;
            if (previous && previous.maxFields > fields)
              for (const [alternativeKey, value] of alternatives)
                if (fields < value.fields && subsumes(input, value.value)) {
                  alternatives.delete(alternativeKey);
                  deltaBytes -= value.bytes;
                }
            const removed = oldCount !== alternatives.size;
            let values =
              previous?.target.selector.kind === 'inputs' && !removed
                ? previous.target.selector.values
                : [...alternatives.values()].map(value => value.value);
            values.push(input);
            alternatives.set(valueKey, { value: input, fields, bytes: inputBytes });
            if (values.length > LIMITS.selectors) {
              // Preserve constraints shared by every alternative before widening all.
              const common = Object.fromEntries(
                Object.entries(values[0]).filter(([name, value]) =>
                  values.every(item => Object.hasOwn(item, name) && item[name] === value),
                ),
              );
              alternatives.clear();
              if (Object.keys(common).length)
                alternatives.set(canonical(common), {
                  value: common,
                  fields: Object.keys(common).length,
                  bytes: byteLength(common),
                });
              values = [common];
              reason = 'selector-limit';
              setTarget(
                key,
                {
                  endpoint,
                  scope: targetScope,
                  selector: alternatives.size ? { kind: 'inputs', values } : { kind: 'all' },
                },
                alternatives,
                undefined,
                Object.keys(common).length,
                Object.keys(common).length,
              );
            } else {
              const target: ImpactTarget = { endpoint, scope: targetScope, selector: { kind: 'inputs', values } };
              const bytes = previous
                ? previous.bytes + deltaBytes + Math.max(0, values.length - 1) - Math.max(0, oldCount - 1)
                : byteLength(target);
              setTarget(
                key,
                target,
                alternatives,
                bytes,
                Math.min(previous?.minFields ?? Infinity, fields),
                Math.max(previous?.maxFields ?? -Infinity, fields),
              );
            }
          }
        }
        if (reason !== 'matched') reduced.add(endpoint);
        explain?.({ resource: write.resource, endpoint, reason });
      }
    }
  }
  const endpoints: Record<string, EndpointImpact> = Object.fromEntries(
    Object.keys(options.manifest.reads)
      .sort()
      .map(endpoint => [
        endpoint,
        reduced.has(endpoint)
          ? { status: 'conservative', codes: ['PRECISION_REDUCED'], targets: [] }
          : { status: 'verified', targets: [] },
      ]),
  );
  for (const { target } of [...targets.values()].sort((a, b) =>
    canonical([a.target.endpoint, a.target.scope]) < canonical([b.target.endpoint, b.target.scope]) ? -1 : 1,
  )) {
    if (target.selector.kind === 'inputs')
      target.selector.values.sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
    endpoints[target.endpoint].targets!.push({ scope: target.scope, selector: target.selector });
  }
  const result: ImpactSet = { endpoints };
  const onWiden = (endpoint: string) => explain?.({ resource: '*', endpoint, reason: 'byte-limit' });
  return options.assessment ? applyAssessment(result, options.assessment, onWiden) : boundImpact(result, onWiden);
}
// Mixed scalar types may be coerced by the DB (including PostgreSQL bool '1').
// Fractional/unsafe numbers may be rounded by database JSON encoders. Neither
// is proof of inequality, even when ordinary JavaScript comparison disagrees.
function filterMayEqual(actual: Scalar, expected: Scalar): boolean {
  if (actual === null || expected === null) return actual === expected;
  if (typeof actual !== typeof expected) return true;
  if (typeof actual === 'number' && (!Number.isSafeInteger(actual) || !Number.isSafeInteger(expected))) return true;
  return scalarMayEqual(actual, expected);
}
function subsumes(broad: Record<string, Scalar>, narrow: Record<string, Scalar>): boolean {
  return Object.entries(broad).every(([key, value]) => Object.hasOwn(narrow, key) && narrow[key] === value);
}
/** Resolves only after final commit and observer drain have populated the callback WriteSet. */
export interface CommandAdapter<Db> {
  command<T>(scope: Scalar, work: (db: Db, writes: WriteSet) => Promise<T>): Promise<T>;
}
export function createImpact(options: Omit<CalculateOptions, 'scope' | 'explain' | 'assessment'>) {
  validateImpactResources(options.resources);
  validateImpactManifest(options.manifest, options.resources);
  // Freeze a private JSON snapshot so later caller mutation cannot change the validated policy.
  const policy = JSON.parse(canonical(options)) as typeof options;
  const reads = indexReads(policy.manifest);
  return {
    calculate(writes: readonly WriteFact[], scope: Scalar, assessment?: ValidationReport) {
      return calculate(writes, { ...policy, scope, assessment }, reads);
    },
    explain(writes: readonly WriteFact[], scope: Scalar) {
      const decisions: Decision[] = [];
      const impact = calculate(writes, { ...policy, scope, explain: d => decisions.push(d) }, reads);
      return { impact, decisions };
    },
    async command<Db, T>(
      adapter: CommandAdapter<Db>,
      context: { scope: Scalar },
      work: (db: Db) => Promise<T>,
    ): Promise<CommandResult<T>> {
      const scope = context.scope;
      let committedWrites: WriteSet | undefined;
      const data = await adapter.command(scope, async (db, writes) => {
        committedWrites = writes;
        return work(db);
      });
      try {
        if (!committedWrites) throw new Error('COMMAND_CALLBACK_NOT_EXECUTED');
        return {
          data,
          commitState: 'committed',
          impact: calculate(committedWrites.snapshot(), { ...policy, scope }, reads),
        };
      } catch {
        return { data, commitState: 'committed', impact: unavailableImpact(policy.manifest, 'CALCULATION_FAILED') };
      }
    },
  };
}
