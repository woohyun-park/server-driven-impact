export const executeDriver = Symbol('sdi.postgres.execute-driver');

/** Only result decoding options cross this internal bridge; SQL is validated separately. */
export interface DriverQueryOptions {
  rowMode?: 'array';
  types?: unknown;
  name?: string;
}
export interface DriverExecution<TResult> {
  [executeDriver](text: string, values: readonly unknown[], options?: DriverQueryOptions): Promise<TResult>;
}
