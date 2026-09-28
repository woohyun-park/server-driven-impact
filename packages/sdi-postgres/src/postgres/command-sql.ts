import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

type CommandParser = {
  loadModule(): Promise<void>;
  parse(text: string): Promise<{ stmts?: { stmt: Record<string, unknown> }[] }>;
};
let commandParser: CommandParser | undefined;
const parser = () => (commandParser ??= require('@pgsql/parser/v18') as CommandParser);

let warming = false;
/**
 * Load and warm the WASM parser in the background when a command starts, so the work overlaps the
 * connection and preamble round trips instead of delaying the first statement. Binding an adapter stays
 * side-effect free, so an application can configure the parser module before the first command.
 */
export function preloadCommandSqlParser(): void {
  if (warming) return;
  warming = true;
  const current = parser();
  // Failures resurface from the first real parse, where they reject that command.
  current
    .loadModule()
    .then(() => current.parse('select 1'))
    .catch(() => undefined);
}

/** Keep transaction ownership and artifact-changing DDL outside the command API. */
export async function assertCommandSql(text: string) {
  const tree = await parser().parse(text);
  if (tree.stmts?.length !== 1) throw new Error('COMMAND_REQUIRES_ONE_STATEMENT');
  const statement = tree.stmts[0].stmt;
  const allowed = new Set([
    'SelectStmt',
    'InsertStmt',
    'UpdateStmt',
    'DeleteStmt',
    'MergeStmt',
    'TruncateStmt',
    'CopyStmt',
    'CallStmt',
    'DoStmt',
    'ConstraintsSetStmt',
  ]);
  if ('TransactionStmt' in statement) throw new Error('COMMAND_TRANSACTION_CONTROL_FORBIDDEN');
  if (!Object.keys(statement).every(kind => allowed.has(kind))) throw new Error('COMMAND_REQUIRES_MIGRATION_API');
}
