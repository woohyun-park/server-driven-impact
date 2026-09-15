export type Input = Record<string, unknown>;

/** Minimal Standard Schema v1 surface (standardschema.dev), copied so no runtime dependency is needed. */
export interface StandardSchemaV1<In = unknown, Out = In> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Out> | Promise<StandardResult<Out>>;
    readonly types?: { readonly input: In; readonly output: Out };
  };
}
export type StandardIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
};
export type StandardResult<Out> =
  | { readonly value: Out; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

export interface InputParser<Out> {
  parse(value: unknown): Out | Promise<Out>;
}
export type InputSchema<In = unknown, Out = Input> = InputParser<Out> | StandardSchemaV1<In, Out>;
export type InputOf<S> =
  S extends StandardSchemaV1<infer In, any> ? In : S extends InputParser<infer Out> ? Awaited<Out> : never;
export type ParsedInputOf<S> =
  S extends StandardSchemaV1<any, infer Out> ? Out : S extends InputParser<infer Out> ? Awaited<Out> : never;
/**
 * The argument type `engine.query()` accepts for a definition. `Record<string, unknown>` rejects
 * `interface`-declared values because an interface carries no implicit index signature, so a schema
 * that did not narrow its input maps to `object` instead of leaking that restriction to the call site.
 */
export type QueryInput<S> = Input extends InputOf<S> ? object : InputOf<S>;

export type InputSnapshot = {
  object: boolean;
  fields: Readonly<Record<string, { present: boolean; value?: unknown }>>;
};

/** Capture selector inputs before a parser can mutate the caller-owned object. */
export function snapshotInput(raw: unknown, fields: readonly string[]): InputSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { object: false, fields: {} };
  return {
    object: true,
    fields: Object.fromEntries(
      fields.map(field => {
        const present = Object.hasOwn(raw, field);
        return [field, present ? { present, value: (raw as Record<string, unknown>)[field] } : { present }];
      }),
    ),
  };
}

/**
 * The impact selector carries the value the caller supplied, while SQL runs on the parsed value. A
 * schema that rewrites one of those fields makes the dependency disagree with the row actually read.
 * Refuse that mismatch rather than return an ImpactSet that can miss the affected query.
 */
export function assertInputPreserved(snapshot: InputSnapshot, parsed: object, fields: readonly string[]): void {
  if (!fields.length) return;
  if (!snapshot.object) throw new Error('QUERY_INPUT_PRESERVATION_VIOLATION');
  for (const field of fields) {
    const before = snapshot.fields[field] ?? { present: false };
    if (
      before.present !== Object.hasOwn(parsed, field) ||
      (before.present && before.value !== (parsed as Record<string, unknown>)[field])
    )
      throw new Error('QUERY_INPUT_PRESERVATION_VIOLATION:' + field);
  }
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    !!value &&
    typeof value === 'object' &&
    '~standard' in value &&
    typeof (value as StandardSchemaV1)['~standard']?.validate === 'function'
  );
}

/** Normalize either input style into one parse function. Throws at definition time for unsupported shapes. */
export function toParse(schema: InputSchema<any, any>): (value: unknown) => Promise<unknown> {
  if (isStandardSchema(schema)) {
    const standard = schema['~standard'];
    if (standard.version !== 1) throw new Error('UNSUPPORTED_INPUT_SCHEMA_VERSION');
    const settle = (result: StandardResult<unknown>): unknown => {
      if (result.issues) {
        const detail = result.issues.map(issue => issue.message).join('; ') || 'no issue details provided';
        throw new Error(`INVALID_QUERY_INPUT:${detail}`, { cause: result.issues });
      }
      if (!result.value || typeof result.value !== 'object') throw new Error('INVALID_QUERY_INPUT');
      return result.value;
    };
    return async value => settle(await standard.validate(value));
  }
  if (!schema || typeof (schema as InputParser<unknown>).parse !== 'function')
    throw new Error('INVALID_QUERY_DEFINITION');
  const parse = (schema as InputParser<unknown>).parse.bind(schema);
  return async value => parse(value);
}
