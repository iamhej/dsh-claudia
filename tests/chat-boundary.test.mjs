import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
// 单元测试使用最小宿主模块桩，不读取真实宿主凭据、不启动模型。
const modules = {
 '@deepseek-ai/dsh-llm': 'export const createUserMessage=x=>x;',
 '@deepseek-ai/dsh-agent': 'export const installModelSelection=()=>{};',
 '@deepseek-ai/dsh-system-prompt': 'export const PERSONA_PREFIX_SECTION="prefix", PERSONA_SUFFIX_SECTION="suffix";'
};
const hook=registerHooks({resolve(specifier,context,next){return modules[specifier]?{url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true}:next(specifier,context)}});
const { NativeRuntime } = await import('../native-runtime.mjs');
hook.deregister();
function fixture(t, pathService=true, options={}) {
 const home=mkdtempSync(join(tmpdir(),'claudia-chat-scope-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const events={},known=[];
 const ctx={on:(name,fn)=>{events[name]=fn;return ()=>{}},agents:{list:()=>[]},agentDefaultModel:{currentSelection:()=>({provider:'mock',model:'mock'})},llm:{resolveCallConfig:async()=>({})}};
 if(pathService)ctx.dshHomePath=name=>join(home,name);
 const runtime=new NativeRuntime(ctx,{get:()=>known,set:(_,v)=>known.splice(0,known.length,...v),messages:()=>[]},options);
 return {runtime,ctx,home,events,known};
}
function target(){const hooks={};const value={allow:null,guard:null,hook:null,count:0};return {value,ctx:{tools:{presentAs:()=>{},restrict:rule=>{value.allow=rule.allow;value.count++},guard:fn=>{value.guard=fn}},on:(name,fn)=>{hooks[name]=fn;value.hook=fn}}};}
test('对话范围来自真实宿主路径，不是启动cwd；状态不授予文件或Shell能力',async t=>{
 const {runtime,home}=fixture(t);const status=await runtime.status();assert.equal(status.fileAccess.root,realpathSync(home));assert.equal(status.fileAccess.mode,'denied');assert.equal(status.fileAccess.shell,false);assert.notEqual(status.fileAccess.root,process.cwd());
});
test('执行层拒绝所有对话工具，最终组装也会移除稍后注册的 own-scope 工具',async t=>{
 const diagnostics=[];
 const {runtime}=fixture(t,true,{onUnexpectedTools:value=>diagnostics.push(value)});const agent=target();runtime.restrict(agent.ctx,'owned');assert.deepEqual(agent.value.allow,[]);
 for(const call of [{name:'read',path:'../../Desktop/private.txt'},{name:'read',path:'.credentials.yaml'},{name:'shell',command:'pwd'},{name:'write',path:'claudia/note.md'}])assert.equal(typeof agent.value.guard(call),'string');
 const assembled={tools:[{name:'shell'},{name:'email_send'},{name:'shell'}],sections:['keep']};
 assert.deepEqual(await agent.value.hook({}, {}, async()=>assembled),{tools:[],sections:['keep']});
 assert.deepEqual(assembled.tools.map(tool=>tool.name),['shell','email_send','shell']);
 assert.deepEqual(diagnostics,[{sessionId:'owned',tools:'email_send,shell'}]);
 assert.deepEqual(await agent.value.hook({}, {}, async()=>({tools:[],sections:['keep']})),{tools:[],sections:['keep']});
 assert.equal(diagnostics.length,1);
});
test('从宿主恢复已登记会话时再次限制工具，不影响其他会话',t=>{
 const {runtime,events,known}=fixture(t);known.push('owned');const own=target(),other=target();events['agent/created']({agent:{session:{id:'owned'},ctx:own.ctx}});events['agent/created']({agent:{session:{id:'other'},ctx:other.ctx}});assert.deepEqual(own.value.allow,[]);assert.equal(other.value.allow,null);runtime.restrict(own.ctx);assert.equal(own.value.count,1);
});
test('普通 Claudia 显式复用宿主已打开的自有会话，不重复 resume 或取得其处置权',async t=>{
 const setup=[];const {runtime,ctx,known,events}=fixture(t,true,{reuseLiveAgent:true,setup:(a,agent)=>setup.push({a,agent})});known.push('owned');
 const agent={session:{id:'owned'},ctx:{}};let resumed=0;ctx.agents.get=id=>id==='owned'?agent:undefined;ctx.agents.resume=async()=>{resumed++;throw Error('不应重复 resume')};
 const handle=await runtime.prepare('owned');assert.equal(handle.agent,agent);assert.equal(handle.borrowed,true);assert.equal(resumed,0);assert.deepEqual(setup,[{a:agent.ctx,agent}]);
 events['agent/disposed']({agent});assert.equal(runtime.handles.has('owned'),false);await handle.dispose();
});
test('新会话cwd绑定宿主目录',async t=>{
 const {runtime,ctx,home}=fixture(t);let options;ctx.agents.resume=async()=>{const e=Error('not found');e.name='SessionPersistenceNotFoundError';throw e};ctx.agents.create=async o=>{options=o;return {dispose:async()=>{}}};await runtime.prepare('new');assert.equal(options.meta.cwd,realpathSync(home));
});
test('无法确定宿主目录时保持拒绝，且不以cwd降级创建会话',async t=>{
 const {runtime,ctx}=fixture(t,false);let created=false;ctx.agents.resume=async()=>{const e=Error('not found');e.name='SessionPersistenceNotFoundError';throw e};ctx.agents.create=async()=>{created=true};await assert.rejects(runtime.prepare('new'),/无法确认数据目录/);assert.equal(created,false);assert.equal((await runtime.status()).fileAccess.mode,'denied');
});
function storeFixture(t,values,agents=[]){
 const home=mkdtempSync(join(tmpdir(),'claudia-session-prune-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const store={get:(key,fallback)=>values.has(key)?values.get(key):fallback,set:(key,value)=>values.set(key,value),messages:()=>[],db:{prepare:()=>({all:()=>[...values.get('recorded')??[]].map(sessionId=>({sessionId}))})}};
 const ctx={on:()=>()=>{},agents:{list:()=>agents},agentDefaultModel:{currentSelection:()=>({provider:'mock',model:'mock'})},llm:{resolveCallConfig:async()=>({})},dshHomePath:name=>join(home,name)};
 return new NativeRuntime(ctx,store,{});
}
test('释放一次性会话即从清单摘除，主会话始终保留',async t=>{
 const values=new Map([['sessionId','main'],['harnessSessions',['main','temp']]]);
 const runtime=storeFixture(t,values);
 runtime.handles.set('temp',{agent:{},borrowed:false,dispose:async()=>{}});
 runtime.handles.set('main',{agent:{},borrowed:false,dispose:async()=>{}});
 await runtime.release('temp');assert.deepEqual(values.get('harnessSessions'),['main']);
 await runtime.release('main');assert.deepEqual(values.get('harnessSessions'),['main']);
});
test('启动清理只摘除一次性会话，主会话、有本地消息和仍存活的会话保留',t=>{
 const values=new Map([['sessionId','main'],['harnessSessions',['main','old-main','temp-1','temp-2','live-temp']],['recorded',['main','old-main']]]);
 const live=target();
 const runtime=storeFixture(t,values,[{session:{id:'live-temp'},ctx:live.ctx}]);
 assert.equal(runtime.pruneSessions(),2);
 assert.deepEqual(values.get('harnessSessions'),['main','old-main','live-temp']);
 assert.equal(runtime.pruneSessions(),0);
});
