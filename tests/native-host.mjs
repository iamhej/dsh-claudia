import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Use an explicitly selected test home with this plugin already installed.
// All credentials below are synthetic, accepted only by the local mock server.
const home=process.env.TEST_DSH_HOME;
if(!home||!existsSync(resolve(home,'profiles/web/node_modules/dsh-claudia/package.json')))throw new Error('Set TEST_DSH_HOME to an isolated home containing the installed plugin');
const bin=process.env.DSH_BIN||'dsh';
const port=Number(process.env.TEST_PLUGIN_PORT||4321),hostPort=Number(process.env.TEST_HOST_PORT||4322);
const secret='synthetic-host-credential-only';
const calls=[];let child,logs='',authOK=true;
const mock=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const data=JSON.parse(raw);calls.push(data);authOK&&=req.headers.authorization===`Bearer ${secret}`;
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'native-test',object:'chat.completion.chunk',created:0,model:data.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
 send({role:'assistant'});send({content:'NATIVE_HOST_OK'});
 if(JSON.stringify(data.messages.at(-1)).includes('cancel-case')){const timer=setTimeout(()=>{send({},'stop');res.end('data: [DONE]\n\n');},15000);res.on('close',()=>clearTimeout(timer));}
 else{send({},'stop');res.end('data: [DONE]\n\n');}
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const settings={'agent-default-model':{provider:'deepseek-official',model:'deepseek-v4-flash'},'llm-deepseek':{baseURL:`http://127.0.0.1:${mock.address().port}`,apiKeyEnv:'CLAUDIA_NATIVE_TEST_KEY'}};
writeFileSync(resolve(home,'settings.yaml'),JSON.stringify(settings),{mode:0o600});
writeFileSync(resolve(home,'.credentials.yaml'),JSON.stringify({version:1,refs:{CLAUDIA_NATIVE_TEST_KEY:secret}}),{mode:0o600});
writeFileSync(resolve(home,'profiles/web/cordis.patch.yml'),JSON.stringify([{id:'dsh-claudia',config:{port,openBrowser:false}},{id:'session-title-llm',disabled:true}]),{mode:0o600});
const base=`http://127.0.0.1:${port}`;
async function start(){
 const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'};delete env.DEEPSEEK_API_KEY;delete env.DEEPSEEK_BASE_URL;delete env.CLAUDIA_NATIVE_TEST_KEY;
 logs='';const args=['web','--no-open','--port',String(hostPort)];
 child=bin.endsWith('.js')?spawn(process.execPath,[bin,...args],{env,cwd:home,stdio:['ignore','pipe','pipe']}):spawn(bin,args,{env,cwd:home,stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('native host startup timeout\n'+logs)),30000);const onData=c=>{logs=(logs+c).slice(-12000);if(logs.includes('Claudia plugin ready:')){clearTimeout(timer);resolve();}};child.stdout.on('data',onData);child.stderr.on('data',onData);child.once('exit',code=>{clearTimeout(timer);reject(new Error('host exited '+code+'\n'+logs));});});
}
async function stop(){if(!child)return;const c=child;child=null;if(c.exitCode!==null)return;const exit=once(c,'exit');c.kill('SIGTERM');const timer=setTimeout(()=>c.kill('SIGKILL'),6000);await exit;clearTimeout(timer);}
let token;
const get=async path=>(await fetch(base+path)).json();
const post=async(path,data)=>(await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Claudia-Token':token},body:JSON.stringify(data)}));
const chat=async text=>{const res=await post('/api/chat',{text});const raw=await res.text();const events=raw.trim().split('\n').map(JSON.parse);assert.equal(events.at(-1).type,'done',raw+'\n'+logs);return events;};
try{
 await start();token=(await get('/api/bootstrap')).csrfToken;
 let state=await get('/api/state');assert.equal(state.runtime.credentialSource,'harness');assert.equal(state.settings.model,'deepseek-v4-flash');assert.equal(state.runtime.modelVerified,false);
 assert.equal((await get('/api/health')).pid,child.pid);
 await post('/api/settings',{assistantName:'小岚',allowContext:true});
 const journal=await(await post('/api/journal',{text:'NATIVE journal walk at 09:30'})).json();
 const first=await chat('first native turn');assert.ok(first.some(e=>e.type==='delta'));assert.ok(authOK);assert.ok(calls.length>0);
 const firstCall=calls.at(-1);assert.equal(firstCall.tools?.length||0,0);assert.match(JSON.stringify(firstCall.messages),/小岚/);assert.match(JSON.stringify(firstCall.messages),/NATIVE journal/);
 state=await get('/api/state');assert.equal(state.runtime.modelVerified,true);assert.ok(!JSON.stringify(state).includes(secret));
 await post('/api/settings',{assistantName:'{{unknown_name}}'});await chat('template-safe nickname');assert.match(JSON.stringify(calls.at(-1).messages),/unknown_name/);
 await post('/api/settings',{assistantName:'Mira'});await chat('second turn after name change');assert.match(JSON.stringify(calls.at(-1).messages),/Mira/);
 const oldId=state.sessionId;await stop();await start();token=(await get('/api/bootstrap')).csrfToken;state=await get('/api/state');assert.equal(state.settings.assistantName,'Mira');assert.equal(state.sessionId,oldId);assert.ok(state.journal.some(e=>e.id===journal.id));
 await chat('third turn after host restart');assert.match(JSON.stringify(calls.at(-1).messages),/first native turn/);
 const response=await post('/api/chat',{text:'cancel-case'});const reader=response.body.getReader();let content='',runId,cancelled=false;const decoder=new TextDecoder();
 for(;;){const {done,value}=await reader.read();if(done)break;content+=decoder.decode(value,{stream:true});for(const line of content.split('\n').filter(Boolean)){let event;try{event=JSON.parse(line);}catch{continue;}if(event.runId)runId=event.runId;if(event.type==='delta'&&!cancelled){cancelled=true;const cancel=await post('/api/cancel',{runId});assert.equal(cancel.status,200);}}}
 assert.ok(cancelled);assert.match(content,/cancelled|已停止/);
 console.log(JSON.stringify({nativeBundle:true,sameProcess:true,hostCredentialInherited:authOK,settingsModelInherited:true,nicknamePersona:true,restartPersistence:true,sessionResume:true,streaming:true,cancel:true,toolsExposed:0,model:'LOCAL_MOCK_ONLY',calls:calls.length}));
}catch(error){console.error(error);console.error(logs);process.exitCode=1;}
finally{await stop();mock.closeAllConnections();mock.close();}
