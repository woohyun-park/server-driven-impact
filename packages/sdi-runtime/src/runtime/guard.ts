/** Guard the public transaction object, including adapter-specific extensions. */
export interface GuardOptions {
  /** Native synchronous APIs are checked without converting their results to promises. */
  syncMethods?: ReadonlySet<string>;
  syncFactories?: ReadonlySet<string>;
}
export function guardDatabase<T extends object>(database: T, options: GuardOptions = {}) {
  let open = true;
  let pending = 0;
  let savepoint = false;
  let failed = false;
  const operations = new Set<Promise<unknown>>();
  const iterators = new Set<AsyncIterator<unknown>>();
  const children = new Set<{ close(): void }>();
  function wrap<O extends object>(target: O): O {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(target)) {
      if (typeof value !== 'function') {
        result[key] = value && typeof value === 'object' ? wrap(value) : value;
        continue;
      }
      result[key] = (...args: unknown[]) => {
        const synchronous = options.syncMethods?.has(key) || options.syncFactories?.has(key);
        if (!open) {
          if (synchronous) throw new Error('WRITE_CONTEXT_CLOSED');
          return Promise.reject(new Error('WRITE_CONTEXT_CLOSED'));
        }
        if (savepoint || (key === 'savepoint' && pending)) {
          if (synchronous) throw new Error('OVERLAPPING_SAVEPOINT');
          return Promise.reject(new Error('OVERLAPPING_SAVEPOINT'));
        }
        pending++;
        if (key === 'savepoint') {
          savepoint = true;
          const callback = args[0] as (db: object) => Promise<unknown>;
          args[0] = async (child: object) => {
            const guarded = guardDatabase(child, options);
            children.add(guarded);
            try { const data = await callback(guarded.db); guarded.finish(); return data; }
            finally { guarded.close(); await guarded.settle(); children.delete(guarded); }
          };
        }
        let returned: unknown;
        try { returned = value.apply(target, args); }
        catch (error) {
          pending--; if (key === 'savepoint') savepoint = false;
          if (key !== 'savepoint') failed = true;
          throw error;
        }
        if (synchronous) {
          pending--;
          return options.syncFactories?.has(key) && returned && typeof returned === 'object' ? wrap(returned) : returned;
        }
        if (returned && typeof returned === 'object' && Symbol.asyncIterator in returned) {
          const iterator=(returned as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          let done=false;
          iterators.add(iterator);
          const finishIterator=()=>{if(done)return;done=true;iterators.delete(iterator);pending--;if(key==='savepoint')savepoint=false;};
          return Object.freeze({
            [Symbol.asyncIterator](){return this;},
            async next(...values: [] | [unknown]) {
              if (!open || done) throw new Error('WRITE_CONTEXT_CLOSED');
              try { const next=await iterator.next(...values);if(next.done)finishIterator();return next; }
              catch(error){if(key!=='savepoint')failed=true;finishIterator();throw error;}
            },
            async return(value?:unknown) {
              try{return iterator.return ? await iterator.return(value) : {done:true,value};}
              finally{finishIterator();}
            },
            async throw(error?:unknown) {
              try{return iterator.throw ? await iterator.throw(error) : Promise.reject(error);}
              finally{if(key!=='savepoint')failed=true;finishIterator();}
            },
          });
        }
        const operation = (async () => {
          try { return await returned; }
          catch (error) { if (key !== 'savepoint') failed = true; throw error; }
          finally { pending--; if (key === 'savepoint') savepoint = false; }
        })();
        // Accidental fire-and-forget is rejected at finish, without an unhandled rejection.
        operations.add(operation);
        void operation.then(() => operations.delete(operation), () => operations.delete(operation));
        return operation;
      };
    }
    return Object.freeze(result) as O;
  }
  return {
    db: wrap(database),
    finish() {
      if (pending) throw new Error('UNAWAITED_DATABASE_OPERATION');
      if (failed) throw new Error('COMMAND_OPERATION_FAILED');
    },
    close() { open = false; for (const child of children) child.close(); },
    async settle() {
      await Promise.allSettled([...operations]);
      const outcomes = await Promise.allSettled([...iterators].map(iterator => iterator.return?.()));
      iterators.clear();
      const failure=outcomes.find(result=>result.status==='rejected');
      if(failure?.status==='rejected')throw new Error('DATABASE_STREAM_CLEANUP_FAILED',{cause:failure.reason});
    },
  };
}
