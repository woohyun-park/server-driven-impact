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

it('classifies core calculation failures after commit as impact unavailable with saved data', async () => {
  const adapter: CommandAdapter<object> = {async command(_scope,work) {
    const writes = new WriteSet();
    const data = await work({}, writes);
    writes.add([{resource:'missing',operation:'unknown',before:{kind:'unknown'},after:{kind:'unknown'},changedColumns:null}]);
    writes.close();
    return data;
  }};
  await expect(engine.command(adapter,{scope:null},async()=>({id:'saved'}))).rejects.toMatchObject({
    code:'IMPACT_UNAVAILABLE',commitState:'committed',data:{id:'saved'},cause:new Error('UNREGISTERED_RESOURCE'),
  });
});

it('uses the execution scope snapshot when the caller mutates context before commit', async () => {
  const scoped = createImpact({resources:{r:{scopeColumn:'tenant',columns:['id','tenant']}},manifest:{protocolVersion:1,reads:{list:[{resource:'r',columns:'*',bindings:[]}]}}});
  const context = {scope:'a'};
  const adapter: CommandAdapter<object> = {async command(scope,work) {
    const writes = new WriteSet();
    const data = await work({},writes);
    writes.add([{resource:'r',operation:'insert',before:{kind:'absent'},after:{kind:'known',scope,fields:{id:'one'}},changedColumns:null}]);
    return data;
  }};
  const result = await scoped.command(adapter,context,async()=>{context.scope='b';return 'saved';});
  expect(result.impact.targets).toEqual([{endpoint:'list',scope:'caller',selector:{kind:'all'}}]);
});
