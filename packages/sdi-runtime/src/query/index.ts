export { q, compileManifest } from './plan.js';
export type {
  Input,
  Predicate,
  AtomicPredicate,
  PageValue,
  Value,
  Join,
  SelectOptions,
  SelectPlan,
  PostgresQueryPlan,
  ExecutableQueryPlan,
  Plan,
  QueryDefinition,
  QueryManifest,
  Manifest,
} from './plan.js';
export type {
  InputOf,
  InputParser,
  InputSchema,
  ParsedInputOf,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
} from './input.js';
import type { QueryDefinition } from './plan.js';
/** Register executable definitions; dependencies are derived by createImpact. */
export function defineQueries<T extends Record<string, QueryDefinition>>(queries: T): T {
  return queries;
}
