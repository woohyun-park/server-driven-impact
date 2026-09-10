export interface PostgresSetupTransaction {
  unsafe(text: string, values?: readonly unknown[]): PromiseLike<Record<string, unknown>[]>;
}
