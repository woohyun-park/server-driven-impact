import { expect, it, vi } from 'vitest';
import { guardDatabase } from '../../packages/sdi-runtime/src/runtime/guard.js';
import { releaseSession, type ReservedSession } from '../../packages/sdi-postgres/src/postgres/session.js';

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
it('never returns a broken postgres.js connection to the pool when backend termination is forbidden', async () => {
  const release = vi.fn();
  const session = {
    unsafe: vi.fn(async () => {
      throw Object.assign(new Error('denied'), { code: '42501' });
    }),
    release,
  } as unknown as ReservedSession;
  expect(await releaseSession(session, true)).toBe(false);
  expect(release).not.toHaveBeenCalled();
});
