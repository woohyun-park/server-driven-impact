import { compileManifest, type QueryDefinition } from '../query/plan.js';
import type { Resources } from '../resources.js';
/** Diagnostic graph derived from executable definitions, never supplied as policy. */
export function describeQueries(resources: Resources, queries: Record<string, QueryDefinition>) {
  return compileManifest(queries, resources);
}
export type { Manifest } from '../query/plan.js';
