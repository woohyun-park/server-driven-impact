import { createRequire } from 'node:module';
import type { Transaction } from './tracked-db.js';
import { sqlReferences } from './sql-references.js';

const require = createRequire(import.meta.url);
type Json = Record<string, any>;
export type PolicyCommand = 'select' | 'select-for-update' | 'select-for-share';
export interface PolicyAnalysisContext {
  command: PolicyCommand;
  effectiveRole?: string;
}
export interface PolicyRead {
  schema: string;
  name: string;
  columns: '*' | string[];
  /** Same-row predicates may use the direct query path. Other reads must stay unbound. */
  rowConstraint: 'same-row' | 'all';
}
export interface PolicyAnalysis {
  reads: PolicyRead[];
  active: boolean;
  schemas: string[];
}
type Relation = {
  oid: string;
  schema: string;
  name: string;
  kind: string;
  owner: string;
  rls: boolean;
  force: boolean;
  columns: string[];
  options?: string[];
};
type Binding = { alias: string; relation: Relation; read: PolicyRead };

/** Policy selection and expression analysis shared by compilation and validation.
 * Roles are optional for compatibility: absence means union all possible policies,
 * never infer the application's role from the catalog connection (often an owner).
 */
export function createPolicyAnalyzer(
  database: Transaction,
  options: {
    parserVersion?: 14 | 15 | 16 | 17 | 18;
    searchPath?: readonly string[];
    nonRowDependencies?: 'reject' | 'ignore';
  } = {},
) {
  const parser = require(`@pgsql/parser/v${options.parserVersion ?? 18}`) as { parse(text: string): Promise<Json> };
  const searchPath = options.searchPath ?? ['public'];
  const relations = new Map<string, Promise<Relation>>();
  const string = (value: Json) => value?.String?.sval ?? value?.String?.str;
  const fail = (): never => {
    throw new Error('UNRESOLVED_POLICY_EXPRESSION');
  };
  async function relation(schema: string | undefined, name: string, path: readonly string[]): Promise<Relation> {
    const key = JSON.stringify([schema, name, path]);
    if (!relations.has(key))
      relations.set(
        key,
        (async () => {
          const [row] = await database.unsafe(
            `select c.oid::text,n.nspname as schema,c.relname as name,c.relkind as kind,
        pg_get_userbyid(c.relowner) as owner,c.relrowsecurity as rls,c.relforcerowsecurity as force,c.reloptions as options,
        array(select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by a.attnum) as columns
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relname=$1 and ($2::text is not null and n.nspname=$2 or $2::text is null and n.nspname=any($3::text[]))
        order by array_position($3::text[],n.nspname) limit 1`,
            [name, schema ?? null, path],
          );
          if (!row) throw new Error(`UNRESOLVED_QUERY_RELATION:${schema ?? ''}.${name}`);
          return row as unknown as Relation;
        })(),
      );
    return relations.get(key)!;
  }
  async function analyze(
    reference: { schema?: string; name: string },
    context: PolicyAnalysisContext,
  ): Promise<PolicyAnalysis> {
    // pg_get_expr/pg_get_functiondef omit qualification relative to the catalog
    // connection, not the application's configured runtime search_path.
    const [environment] = await database.unsafe('select current_schemas(true) as schemas');
    const deparsePath = environment.schemas as string[];
    const reads: PolicyRead[] = [];
    const schemas = new Set<string>();
    let active = false;
    let expansions = 0;
    const add = (rel: Relation, rowConstraint: PolicyRead['rowConstraint']): PolicyRead => {
      const read: PolicyRead = { schema: rel.schema, name: rel.name, columns: [], rowConstraint };
      reads.push(read);
      return read;
    };
    const observe = (binding: Binding, column?: string) => {
      if (column && !binding.relation.columns.includes(column)) fail();
      if (!column) binding.read.columns = '*';
      else if (binding.read.columns !== '*' && !binding.read.columns.includes(column))
        binding.read.columns.push(column);
    };
    function limit(path: Set<string>) {
      if (path.size >= 128 || ++expansions > 4096) throw new Error('CATALOG_DEPENDENCY_LIMIT');
    }
    async function policies(
      rel: Relation,
      role: string | undefined,
      command: PolicyCommand,
      path: Set<string>,
      sameRow: boolean,
      runtimeSearch: readonly string[] = searchPath,
    ): Promise<void> {
      if (!rel.rls) return;
      if (role) {
        const [rights] = await database.unsafe(
          `select rolsuper or rolbypassrls or ($2::boolean=false and pg_has_role(oid,(select oid from pg_roles where rolname=$3),'USAGE')) as bypass from pg_roles where rolname=$1`,
          [role, rel.force, rel.owner],
        );
        if (!rights) throw new Error(`UNRESOLVED_POLICY_ROLE:${role}`);
        if (rights.bypass) return;
      }
      const selected = await database.unsafe(
        `select polname,polpermissive,pg_get_expr(polqual,polrelid) as expression
        from pg_policy where polrelid=$1::oid and (polcmd in ('r','*') or ($2::boolean and polcmd='w'))
        and ($3::text is null or exists(select 1 from unnest(polroles) as roles(roleid)
          where case when roleid=0 then true else pg_has_role($3::name,roleid,'USAGE') end)) order by oid`,
        [rel.oid, command !== 'select', role ?? null],
      );
      active = true;
      // References of permissive OR and restrictive AND are deliberately unioned.
      // No constant folding: retain dependencies even when another policy is true.
      const key = JSON.stringify(['policy', rel.oid, role, command]);
      if (path.has(key)) {
        const read = add(rel, 'all');
        read.columns = '*';
        return;
      }
      limit(path);
      const next = new Set([...path, key]);
      for (const policy of selected)
        if (policy.expression) {
          const binding = { alias: rel.name, relation: rel, read: add(rel, sameRow ? 'same-row' : 'all') };
          const tree = await parser.parse(`select 1 where (${policy.expression})`);
          await expression(
            tree.stmts[0].stmt.SelectStmt.whereClause,
            [[binding]],
            role,
            deparsePath,
            next,
            runtimeSearch,
          );
        }
    }
    async function source(
      range: Json,
      role: string | undefined,
      search: readonly string[],
      path: Set<string>,
      command: PolicyCommand,
      runtimeSearch: readonly string[],
    ): Promise<Binding> {
      const rel = await relation(range.schemaname, range.relname, search);
      schemas.add(rel.schema);
      if (rel.kind === 'v') {
        const key = JSON.stringify(['view', rel.oid, role]);
        if (path.has(key)) throw new Error('UNRESOLVED_RECURSIVE_POLICY_VIEW');
        limit(path);
        const [view] = await database.unsafe('select pg_get_viewdef($1::oid,true) as body', [rel.oid]);
        const tree = await parser.parse(view.body);
        const before = reads.length;
        await select(
          tree.stmts[0].stmt.SelectStmt,
          [],
          rel.options?.includes('security_invoker=true') ? role : rel.owner,
          deparsePath,
          new Set([...path, key]),
          runtimeSearch,
        );
        // View output-column lineage is not proven; retain its known row reads.
        for (const read of reads.slice(before)) {
          read.columns = '*';
          read.rowConstraint = 'all';
        }
        return {
          alias: range.alias?.Alias?.aliasname ?? range.alias?.aliasname ?? range.relname,
          relation: rel,
          read: { schema: rel.schema, name: rel.name, columns: '*', rowConstraint: 'all' },
        };
      }
      if (!['r', 'p', 'm'].includes(rel.kind))
        throw new Error(`UNRESOLVED_POLICY_RELATION_KIND:${rel.schema}.${rel.name}:${rel.kind}`);
      const binding = {
        alias: range.alias?.Alias?.aliasname ?? range.alias?.aliasname ?? range.relname,
        relation: rel,
        read: add(rel, 'all'),
      };
      await policies(rel, role, command, path, false, runtimeSearch);
      return binding;
    }
    async function routine(
      call: Json,
      role: string | undefined,
      search: readonly string[],
      path: Set<string>,
      runtimeSearch: readonly string[],
    ): Promise<void> {
      const names = call.funcname.map(string);
      if (names.some((name: unknown) => !name) || names.length > 2) fail();
      const rows = await database.unsafe(
        `select p.oid::text,n.nspname as schema,p.proname as name,l.lanname,p.prosrc,
        p.provolatile,p.prosecdef,pg_get_userbyid(p.proowner) as owner,p.proconfig,p.proargnames,p.pronargs,p.prosqlbody is not null as sqlbody,
        exists(select 1 from pg_type t where t.oid=any(p.proargtypes::oid[] || array[p.prorettype]) and t.typnamespace<>'pg_catalog'::regnamespace) as custom_types,
        case when l.lanname='sql' then pg_get_functiondef(p.oid) end as definition
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
        where p.proname=$1 and p.pronargs-p.pronargdefaults<=$2 and (p.pronargs>=$2 or p.provariadic<>0)
        and ($3::text is not null and n.nspname=$3 or $3::text is null and n.nspname=any($4::text[]))`,
        [names.at(-1), call.args?.length ?? 0, names.length === 2 ? names[0] : null, ['pg_catalog', ...search]],
      );
      if (!rows.length) throw new Error(`UNRESOLVED_QUERY_FUNCTION:${names.join('.')}`);
      for (const fn of rows) {
        if (fn.schema === 'pg_catalog' && Number(fn.oid) < 16384) {
          if (options.nonRowDependencies !== 'ignore' && fn.provolatile !== 'i')
            throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
          continue;
        }
        if (fn.lanname !== 'sql') throw new Error(`UNRESOLVED_FUNCTION_BODY:${fn.schema}.${fn.name}:${fn.lanname}`);
        if (fn.custom_types) throw new Error('UNRESOLVED_FUNCTION_TYPES');
        if (Number(fn.pronargs) > (call.args?.length ?? 0)) throw new Error('UNRESOLVED_FUNCTION_DEFAULTS');
        schemas.add(fn.schema);
        const key = JSON.stringify(['function', fn.oid, role]);
        if (path.has(key)) throw new Error('UNRESOLVED_RECURSIVE_POLICY_FUNCTION');
        limit(path);
        const next = new Set([...path, key]);
        const configured = (fn.proconfig as string[] | null)?.find(value => value.startsWith('search_path='));
        // A function-local path must be explicit, simple identifiers. Do not guess
        // $user, temporary schemas or quoted comma-separated identifiers.
        const fnPath = configured
          ? configured
              .slice(12)
              .split(',')
              .map(value => value.trim().replace(/^"|"$/g, ''))
          : runtimeSearch;
        if (fnPath.some(value => !/^\w+$/.test(value) || value === 'pg_temp'))
          throw new Error('UNRESOLVED_FUNCTION_SEARCH_PATH');
        let tree: Json;
        try {
          tree = await parser.parse(fn.sqlbody ? fn.definition : fn.prosrc);
        } catch {
          throw new Error('UNRESOLVED_FUNCTION_BODY');
        }
        const before = reads.length;
        // Named SQL arguments resolve after relation columns. Their values are
        // already observed at the call site, so this binding adds no row read.
        const parameters: Binding = {
          alias: fn.name,
          relation: {
            oid: '',
            schema: fn.schema,
            name: fn.name,
            kind: 'parameter',
            owner: '',
            rls: false,
            force: false,
            columns: fn.proargnames ?? [],
          },
          read: { schema: fn.schema, name: fn.name, columns: [], rowConstraint: 'same-row' },
        };
        if (fn.sqlbody) {
          const body = tree.stmts?.[0]?.stmt?.CreateFunctionStmt?.sql_body;
          if (!body) throw new Error('UNRESOLVED_FUNCTION_BODY');
          await expression(body, [[parameters]], fn.prosecdef ? fn.owner : role, deparsePath, next, fnPath);
        } else
          for (const stmt of tree.stmts ?? []) {
            if (!stmt.stmt.SelectStmt) throw new Error('UNRESOLVED_POLICY_FUNCTION_COMMAND');
            await select(stmt.stmt.SelectStmt, [[parameters]], fn.prosecdef ? fn.owner : role, fnPath, next, fnPath);
          }
        if (options.nonRowDependencies !== 'ignore' && reads.length === before && fn.provolatile !== 'i')
          throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
      }
    }
    async function select(
      stmt: Json,
      outer: Binding[][],
      role: string | undefined,
      search: readonly string[],
      path: Set<string>,
      runtimeSearch: readonly string[],
    ): Promise<void> {
      if (stmt.intoClause) throw new Error('UNRESOLVED_POLICY_QUERY_SHAPE');
      const simpleFrom = (entry: Json): boolean =>
        !!entry.RangeVar || (!!entry.JoinExpr && simpleFrom(entry.JoinExpr.larg) && simpleFrom(entry.JoinExpr.rarg));
      if (stmt.withClause || (stmt.op && stmt.op !== 'SETOP_NONE') || !(stmt.fromClause ?? []).every(simpleFrom)) {
        // For known complex SELECT shapes, prove resources first and widen their
        // columns. In particular CTE and UNION output lineage must not be guessed.
        const references = sqlReferences({ SelectStmt: stmt });
        if (references.unresolvedExpression) fail();
        if (options.nonRowDependencies !== 'ignore' && references.nonRow)
          throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
        const hasWrite = (value: unknown): boolean =>
          !!value &&
          typeof value === 'object' &&
          (Object.keys(value).some(key =>
            ['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt', 'intoClause'].includes(key),
          ) ||
            Object.values(value).some(hasWrite));
        if (hasWrite(stmt)) throw new Error('UNRESOLVED_POLICY_FUNCTION_COMMAND');
        for (const binding of outer.flat()) observe(binding);
        const before = reads.length;
        // Locking nested queries may require UPDATE policies too. Broad fallback
        // conservatively unions those requirements for every referenced table.
        const command: PolicyCommand = JSON.stringify(stmt).includes('"lockingClause"')
          ? 'select-for-update'
          : 'select';
        for (const reference of references.relations)
          await source(
            { schemaname: reference.schema, relname: reference.name },
            role,
            search,
            path,
            command,
            runtimeSearch,
          );
        for (const reference of references.functions)
          await routine(
            {
              funcname: [...(reference.schema ? [reference.schema] : []), reference.name].map(sval => ({
                String: { sval },
              })),
              args: Array.from({ length: reference.arguments }, () => ({})),
            },
            role,
            search,
            path,
            runtimeSearch,
          );
        for (const read of reads.slice(before)) {
          read.columns = '*';
          read.rowConstraint = 'all';
        }
        return;
      }
      const local: Binding[] = [];
      const command: PolicyCommand = stmt.lockingClause?.length ? 'select-for-update' : 'select';
      async function from(entry: Json): Promise<void> {
        if (entry.RangeVar) {
          local.push(await source(entry.RangeVar, role, search, path, command, runtimeSearch));
          return;
        }
        if (entry.JoinExpr) {
          await from(entry.JoinExpr.larg);
          await from(entry.JoinExpr.rarg);
          if (entry.JoinExpr.usingClause || entry.JoinExpr.isNatural) for (const binding of local) observe(binding);
          return;
        }
        throw new Error('UNRESOLVED_POLICY_QUERY_SHAPE');
      }
      for (const entry of stmt.fromClause ?? []) await from(entry);
      const scopes = [local, ...outer];
      for (const [key, value] of Object.entries(stmt))
        if (key !== 'fromClause') await expression(value, scopes, role, search, path, runtimeSearch);
      async function joins(entry: Json): Promise<void> {
        if (entry.JoinExpr) {
          await expression(entry.JoinExpr.quals, scopes, role, search, path, runtimeSearch);
          await joins(entry.JoinExpr.larg);
          await joins(entry.JoinExpr.rarg);
        }
      }
      for (const entry of stmt.fromClause ?? []) await joins(entry);
    }
    async function expression(
      value: unknown,
      scopes: Binding[][],
      role: string | undefined,
      search: readonly string[],
      path: Set<string>,
      runtimeSearch: readonly string[],
    ): Promise<void> {
      if (Array.isArray(value)) {
        for (const child of value) await expression(child, scopes, role, search, path, runtimeSearch);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const node = value as Json;
      if (node.InsertStmt || node.UpdateStmt || node.DeleteStmt || node.MergeStmt)
        throw new Error('UNRESOLVED_POLICY_FUNCTION_COMMAND');
      if (node.SelectStmt) {
        await select(node.SelectStmt, scopes, role, search, path, runtimeSearch);
        return;
      }
      if (node.ColumnRef) {
        const fields = node.ColumnRef.fields;
        const names = fields.map(string);
        const star = fields.at(-1)?.A_Star !== undefined;
        if (names.length > 3) fail();
        const column = star ? undefined : names.at(-1);
        const alias = names.length > 1 ? names.at(-2) : undefined;
        for (const scope of scopes) {
          const owners = scope.filter(
            binding =>
              (names.length !== 3 || binding.relation.schema === names[0]) &&
              (alias
                ? binding.alias === alias
                : star || binding.relation.columns.includes(column) || binding.alias === column),
          );
          if (!owners.length) continue;
          if (owners.length !== 1 && !star) fail();
          for (const owner of owners) observe(owner, !alias && owner.alias === column ? undefined : column);
          return;
        }
        fail();
      }
      const refs = sqlReferences(node);
      if (refs.unresolvedExpression) fail();
      if (options.nonRowDependencies !== 'ignore' && (node.SQLValueFunction || node.NextValueExpr))
        throw new Error('POSTGRES_QUERY_REQUIRES_FRESHNESS_POLICY');
      if (node.FuncCall) await routine(node.FuncCall, role, search, path, runtimeSearch);
      for (const child of Object.values(node)) await expression(child, scopes, role, search, path, runtimeSearch);
    }
    const root = await relation(reference.schema, reference.name, searchPath);
    await policies(root, context.effectiveRole, context.command, new Set(), true);
    return {
      active,
      schemas: [...schemas],
      reads: reads.map(read => ({ ...read, columns: read.columns === '*' ? '*' : [...new Set(read.columns)].sort() })),
    };
  }
  return { analyze };
}
