export const executeDriver = Symbol('sdi.postgres.execute-driver');

export interface DriverExecution<TResult> {
  [executeDriver](text: string, values: readonly unknown[]): Promise<TResult>;
}
