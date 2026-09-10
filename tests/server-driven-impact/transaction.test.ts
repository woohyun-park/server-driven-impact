import {it,expect} from 'vitest';
import {createImpact,WriteSet,type CommandAdapter} from '@server-driven-impact/core';
const engine=createImpact({resources:{r:{scopeColumn:null,columns:['id']}},manifest:{protocolVersion:1,reads:{list:[{resource:'r',columns:'*',bindings:[]}]}}});
it('engine response waits for the adapter commit and propagates commit rejection',async()=>{
  let release!:()=>void;
  const commit=new Promise<void>(resolve=>{release=resolve;});
  const adapter:CommandAdapter<object>={async command(_scope,work){const writes=new WriteSet();const result=await work({},writes);await commit;writes.close();return result;}};
  let resolved=false;
  const pending=engine.command(adapter,{scope:null},async()=>42).then(result=>{resolved=true;return result;});
  await Promise.resolve();await Promise.resolve();expect(resolved).toBe(false);release();expect((await pending).data).toBe(42);
  const failing:CommandAdapter<object>={async command(_scope,work){await work({},new WriteSet());throw new Error('COMMIT_FAILED');}};
  await expect(engine.command(failing,{scope:null},async()=>42)).rejects.toThrow('COMMIT_FAILED');
});
