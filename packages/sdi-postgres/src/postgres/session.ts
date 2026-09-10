import type { Transaction } from './tracked-db.js';

export type ReservedSession = Transaction & { release(): void | Promise<void>; discard?(): void | Promise<void> };
const lockKeys = [0x534449,0x5047];

/** A session lock precedes BEGIN so a waiting request cannot retain an old catalog snapshot. */
export async function lockSession(session: ReservedSession) {
  await session.unsafe('select pg_advisory_lock_shared($1,$2)',lockKeys);
}
export async function releaseSession(session: ReservedSession, broken = false) {
  if (!broken) {
    try {
      await session.unsafe('select pg_advisory_unlock_shared($1,$2)',lockKeys);
      await session.release();
      return true;
    } catch { broken = true; }
  }
  if (session.discard) { await session.discard(); return true; }
  // postgres.js 3.4.8 has no public per-reservation destroy method. Terminate
  // this backend, never another connection; the driver replaces the closed socket.
  try {
    const rows=await session.unsafe('select pg_terminate_backend(pg_backend_pid()) as terminated');
    if(rows[0]?.terminated!==true)return false;
  } catch(error) {
    const code=error && typeof error==='object' && 'code' in error?String(error.code):'';
    if(!/^(57P0[123]|08\w{3}|ECONNRESET|EPIPE|CONNECTION_(CLOSED|ENDED|DESTROYED))$/.test(code))return false;
  }
  await session.release();
  return true;
}
