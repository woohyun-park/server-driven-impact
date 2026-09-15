import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** Keep transaction ownership and artifact-changing DDL outside the command API. */
export async function assertCommandSql(text: string) {
  const parser = require('@pgsql/parser/v18') as {
    parse(text: string): Promise<{ stmts?: { stmt: Record<string, unknown> }[] }>;
  };
  const tree = await parser.parse(text);
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
