import { expect, it, vi } from 'vitest';
import { guardDatabase } from '../../packages/sdi-runtime/src/runtime/guard.js';
import {
  releaseTransactionConnection,
  type ReservedConnection,
} from '../../packages/sdi-postgres/src/postgres/connection.js';

it('closes all open iterators and surfaces protocol cleanup failure', async () => {
  const close = vi.fn(async () => {
    throw new Error('protocol lost');
  });
  const guarded = guardDatabase({
    cursor: () => ({
      [Symbol.asyncIterator]() {
        return { next: async () => ({ done: false, value: 1 }), return: close };
      },
    }),
  });
  const iterator = guarded.db.cursor()[Symbol.asyncIterator]();
  await iterator.next();
  expect(() => guarded.finish()).toThrow('UNAWAITED_DATABASE_OPERATION');
  guarded.close();
  await expect(guarded.settle()).rejects.toThrow('DATABASE_STREAM_CLEANUP_FAILED');
  expect(close).toHaveBeenCalledOnce();
});
it('quarantines a broken connection when the driver cannot discard one reservation', async () => {
  const release = vi.fn();
  const session = {
    unsafe: vi.fn(),
    release,
  } as unknown as ReservedConnection;
  expect(await releaseTransactionConnection(session, true)).toBe(false);
  expect(release).not.toHaveBeenCalled();
  expect(session.unsafe).not.toHaveBeenCalled();
});
