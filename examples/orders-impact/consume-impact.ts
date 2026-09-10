import { matchesInputSelector, type ImpactSet } from '@server-driven-impact/core';

/** Example for the current signed-in frontend session; cache ownership stays in the app. */
export function affectedQueries(
  impact: ImpactSet,
  queries: readonly {endpoint: string; input: Record<string, unknown>}[],
) {
  return queries.filter(query => impact.targets.some(target =>
    target.endpoint === query.endpoint && matchesInputSelector(query.input, target.selector),
  ));
}
