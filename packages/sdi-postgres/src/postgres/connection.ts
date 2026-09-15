import type { Transaction } from './tracked-db.js';

export type ReservedConnection = Transaction & { release(): void | Promise<void>; discard?(): void | Promise<void> };

/** Return or discard a reserved connection without issuing SQL after transaction completion. */
export async function releaseTransactionConnection(session: ReservedConnection, broken = false) {
  try {
    if (broken) {
      if (!session.discard) return false;
      await session.discard();
    } else await session.release();
    return true;
  } catch {
    return false;
  }
}
