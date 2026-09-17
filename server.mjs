import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Store, makeContext } from './store.mjs';
import { PROFILE_DEFAULTS } from './records.mjs';
import { noopLogger } from './logger.mjs';
import { existsSync, readFileSync } from 'node:fs';
const runningVersion=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
const root=dirname(fileURLToPath(import.meta.url));

export function normalizeName(value) {
  if(value===undefined)return 'Claudia';
  if(typeof value!=='string'||value.length>40||/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value))throw Object.assign(new Error('名字最多40个字符，不能包含换行、控制字符或方向控制符'),{status:400});
  return value.trim()||'Claudia';
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
async function body(req,maxBytes=65536,limitStatus=413){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>maxBytes)throw Object.assign(new Error('请求内容太长'),{status:limitStatus});chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();return value;}catch{throw Object.assign(new Error('无效 JSON 对象'),{status:400});}}
function requiredText(text,max){if(typeof text!=='string'||!text.trim()||text.length>max)throw Object.assign(new Error(`请输入 1—${max} 字的内容`),{status:400});return text.trim();}

export async function startServer({dataDir,port=4317,createRuntime,createServices,home='',profile='web',openFolder,openHarness,getHostUrl=()=>'',hasOtherAgents=()=>false,logger=noopLogger}) {
  const csrfToken=randomBytes(32).toString('hex');
  const store=new Store(resolve(dataDir,'claudia.sqlite'));
  const runtime=createRuntime(store);
  let active=null,configuring=false,closing=false,drainingUntil=0,actualPort,services={};
  const boolKeys=['allowContext','activityEnabled','reflectionEnabled','autoUpdateEnabled','memorySuggestionsEnabled'];
  const busy=()=>!!(active||configuring||Date.now()<drainingUntil||services.maintenance?.status().running);
  const hostBusy=()=>{try{return hasOtherAgents(runtime);}catch{return true;}};
  const preferences=()=>Object.fromEntries(boolKeys.map(key=>[key,store.get(key,false)]));
  const readBody=async(req,...limits)=>{const data=await body(req,...limits);if(closing)throw Object.assign(new Error('插件正在关闭'),{status:503});return data;};
  const publicSettings=()=>({assistantName:store.get('assistantName','Claudia'),...preferences(),...runtime.selection()});
  const safeSettings=()=>{try{return publicSettings();}catch{return {assistantName:store.get('assistantName','Claudia'),allowContext:store.get('allowContext',false),provider:'',model:''};}};
  let activityApply=null,activityError='',applyId=0;
  const effect=()=>{
    const a=services.activity?.status();
    if(activityError||a?.error)return {state:'error',message:activityError||a.error,restartRequired:false};
    if(activityApply||a?.state==='starting'||a?.state==='stopping')return {state:'applying',message:'已保存，正在应用时长设置；首次准备组件可能需要稍等，无需重启',restartRequired:false};
    return {state:'applied',message:'已保存，无需重启；人格在下一轮对话使用，自动任务按设定时间执行',restartRequired:false};
  };
  const applyActivity=value=>{
    activityError='';const id=++applyId;
    try{activityApply=Promise.resolve(services.activity?.setEnabled(value)).catch(()=>{if(id===applyId)activityError='时长组件应用失败，请查看采集状态后重试';}).finally(()=>{if(id===applyId)activityApply=null;});}
    catch{activityApply=null;activityError='时长组件应用失败，请查看采集状态后重试';}
  };
  const restartStatus=()=>services.restart?.status()||{supported:false,pending:false,state:'idle',message:'请使用新版 Claudia 启动器后再尝试一键重启',runningVersion,installedVersion:runningVersion};
  const validToken=value=>{const buffer=Buffer.from(value||'');const expected=Buffer.from(csrfToken);return buffer.length===expected.length&&timingSafeEqual(buffer,expected);};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const origins=[`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`];
    if(![`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(req.headers.host))return json(res,403,{error:'非法 Host'});
    if(req.headers.origin&&!origins.includes(req.headers.origin)||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'不允许跨站访问'});
    try {
      if(closing)return json(res,503,{error:'插件正在关闭'});
      let path;try{path=new URL(req.url,origins[0]).pathname;}catch{throw Object.assign(new Error('请求 URL 无效'),{status:400});}
      if(!['GET','POST','DELETE'].includes(req.method))return json(res,405,{error:'不支持的请求方法'});
      if(req.method!=='GET'&&(!validToken(req.headers['x-claudia-token'])||!req.headers['content-type']?.startsWith('application/json')))return json(res,403,{error:'缺少本机安全凭证'});
      if(req.method==='GET'&&path==='/api/bootstrap')return json(res,200,{csrfToken});
      if(req.method==='GET'&&path==='/api/state'){
        const end=new Date(),start=new Date(end.getTime()-86400000);
        return json(res,200,{journal:store.journal(),memories:store.memories(),messages:store.messages(),runtime:await runtime.status(),settings:safeSettings(),settingsEffect:effect(),restart:restartStatus(),sessionId:store.get('sessionId'),todos:store.todos(),profiles:store.profiles(),settingsRevision:store.records.read('settings.md').revision,profileDefaults:PROFILE_DEFAULTS,reflections:store.reflections(),memoryCandidates:store.memoryCandidates(),dataDirectory:dataDir,hostUrl:getHostUrl(),maintenance:services.maintenance?.status()||{},activity:services.activity?.status()||{enabled:false,running:false},activitySummary:services.activity?.summary(start.toISOString(),end.toISOString())||{apps:[],seconds:0},background:services.background?.status()||{enabled:false,supported:false},logs:logger.status()});
      }
      if(req.method==='GET'&&path==='/api/health')return json(res,200,{ok:true,plugin:'dsh-claudia',version:runningVersion,pid:process.pid,home,profile,busy:busy()||hostBusy(),runtime:await runtime.status()});
      if(req.method==='POST'&&path==='/api/restart'){
        const data=await readBody(req);if(Object.keys(data).length)return json(res,400,{error:'重启不接受外部参数'});
        if(busy()||hostBusy()||activityApply)return json(res,409,{error:'请等待当前任务或设置应用结束后再重启'});
        if(!services.restart)return json(res,503,{error:'请用新版 Claudia 启动器启动后重试'});
        const restart=services.restart.request();return json(res,202,{restart});
      }
      if(req.method==='POST'&&path==='/api/prepare-restart'){await readBody(req);if(busy()||hostBusy())return json(res,409,{error:'宿主仍有活动会话或任务，请稍后重启'});drainingUntil=Date.now()+15000;return json(res,200,{ok:true,draining:true});}
      if(req.method==='POST'&&path==='/api/todos'){const data=await readBody(req);return json(res,201,store.addTodo(requiredText(data.text,2000)));}
      if(req.method==='POST'&&path.startsWith('/api/todos/')){const data=await readBody(req);if(!['todo','done','dismissed'].includes(data.status))return json(res,400,{error:'待办状态无效'});return json(res,200,store.updateTodo(path.split('/').pop(),data.status,data.revision));}
      if(req.method==='POST'&&path.startsWith('/api/profiles/')){
        const data=await readBody(req);
        const hasBody=Object.hasOwn(data,'body'),hasText=Object.hasOwn(data,'text');
        if(hasBody&&hasText)return json(res,400,{error:'body 与 text 不能同时提供'});
        if(busy())return json(res,409,{error:'请等待当前任务结束后修改设定'});
        const name=path.split('/').pop();
        if(!['soul','user','system'].includes(name))return json(res,400,{error:'设定文件无效'});
        const text=hasBody?data.body:data.text;
        if(typeof text!=='string'||text.length>12000)return json(res,400,{error:'设定最多12000字符'});
        return json(res,200,hasBody?store.saveProfileBody(name,text,data.revision):store.saveProfile(name,text,data.revision));
      }
      if(req.method==='POST'&&path==='/api/reflections/run'){await readBody(req);if(busy())return json(res,409,{error:'请等待当前任务结束'});if(!store.get('reflectionEnabled',false))return json(res,400,{error:'请先在设置开启每日回顾并确认模型数据分享'});return json(res,200,await services.maintenance.runReflection());}
      if(req.method==='POST'&&path.startsWith('/api/reflections/')){const data=await readBody(req),entry=store.reflections().find(e=>e.id===path.split('/').pop());if(!entry)return json(res,404,{error:'回顾不存在'});return json(res,200,store.saveReflection({...entry,text:requiredText(data.text,12000)},data.revision));}
      if(req.method==='POST'&&path.startsWith('/api/memory-candidates/')){const data=await readBody(req);if(typeof data.accept!=='boolean')return json(res,400,{error:'确认选项无效'});return json(res,200,store.decideCandidate(path.split('/').pop(),data.accept));}
      if(req.method==='GET'&&path==='/api/logs'){
        // 只读自己的日志目录，不接受任何外部路径或文件名参数。
        const requested=Number(new URL(req.url,origins[0]).searchParams.get('limit'));
        return json(res,200,{lines:logger.recent(Number.isInteger(requested)&&requested>0?requested:200),status:logger.status()});
      }
      if(req.method==='POST'&&path==='/api/open-logs'){const data=await readBody(req);if(Object.keys(data).length)return json(res,400,{error:'打开日志不接受外部路径参数'});if(!openFolder)return json(res,501,{error:'当前环境不能打开文件夹'});const dir=logger.dir();if(!dir)return json(res,501,{error:'当前环境没有可用的日志目录'});if(!existsSync(dir))return json(res,409,{error:'日志目录尚未创建；写入第一条事件后才会出现'});await openFolder(dir);return json(res,200,{ok:true});}
      if(req.method==='POST'&&path==='/api/open-folder'){const data=await readBody(req);if(Object.keys(data).length)return json(res,400,{error:'打开文件夹不接受外部路径参数'});if(!openFolder)return json(res,501,{error:'当前环境不能打开文件夹'});await openFolder(dataDir);return json(res,200,{ok:true});}
      if(req.method==='POST'&&path==='/api/open-harness'){await readBody(req);if(!openHarness)return json(res,501,{error:'未找到宿主界面'});await openHarness();return json(res,200,{ok:true});}
      if(req.method==='POST'&&path==='/api/background'){const data=await readBody(req);if(typeof data.enabled!=='boolean')return json(res,400,{error:'后台开关无效'});if(busy())return json(res,409,{error:'请等待当前任务结束'});if(!services.background)return json(res,501,{error:'当前环境不支持后台服务'});configuring=true;try{return json(res,200,await services.background.setEnabled(data.enabled));}finally{configuring=false;}}
      if(req.method==='POST'&&path==='/api/journal'){
        const data=await readBody(req),text=requiredText(data.text,5000),date=new Date(data.occurredAt||Date.now());
        if(!Number.isFinite(date.getTime()))return json(res,400,{error:'记录时间无效'});
        return json(res,201,store.addJournal(text,date.toISOString()));
      }
      if(req.method==='DELETE'&&path.startsWith('/api/journal/'))return json(res,store.deleteJournal(path.split('/').pop())?200:404,{ok:true});
      if(req.method==='POST'&&path==='/api/memories'){const data=await readBody(req);return json(res,201,store.addMemory(requiredText(data.text,1000)));}
      if(req.method==='DELETE'&&path.startsWith('/api/memories/'))return json(res,store.deleteMemory(path.split('/').pop())?200:404,{ok:true});
      if(req.method==='POST'&&path==='/api/settings/batch'){
        // 三份 12000 字符正文，包括 JSON Unicode 转义，仍有固定请求总长上限。
        const data=await readBody(req,256*1024,400);
        if(busy())return json(res,409,{error:'请等待当前回复或配置操作结束'});
        configuring=true;
        try{
          const oldActivity=store.get('activityEnabled',false);
          const result=store.saveSettingsBatch(data);
          if(result.saved.includes('settings')){
            const activity=store.get('activityEnabled',false);
            try{store.set('reflectionSources',['journal','todos',...(activity?['activity']:[])]);}
            catch{result.errors.settings=[result.errors.settings,'行为配置已保存，但回顾来源同步失败，请检查本机存储后重试'].filter(Boolean).join('；');}
            if(Object.hasOwn(data.settings,'activityEnabled')&&(oldActivity!==activity||services.activity?.status().error||activityError))applyActivity(activity);
          }
          return json(res,200,{...result,settings:publicSettings(),profiles:store.profiles(),settingsRevision:store.records.read('settings.md').revision,settingsEffect:effect(),restart:restartStatus()});
        }catch(error){if(error.status===413)error.status=400;throw error;}
        finally{configuring=false;}
      }
      if(req.method==='POST'&&path==='/api/settings'){
        const data=await readBody(req);
        if(Object.keys(data).some(key=>!['assistantName',...boolKeys].includes(key)))return json(res,400,{error:'插件不接收模型端点或 API key，请在 Harness 中配置'});
        if(busy())return json(res,409,{error:'请等待当前回复或配置操作结束'});
        const name=normalizeName(data.assistantName===undefined?store.get('assistantName','Claudia'):data.assistantName);
        if(boolKeys.some(key=>data[key]!==undefined&&typeof data[key]!=='boolean'))return json(res,400,{error:'开关必须是布尔值'});
        configuring=true;
        try{
          const oldActivity=store.get('activityEnabled',false);
          if(data.assistantName!==undefined&&name!==store.get('assistantName','Claudia'))store.set('assistantName',name);
          for(const key of boolKeys)if(data[key]!==undefined&&data[key]!==store.get(key,false))store.set(key,data[key]);
          if(data.activityEnabled!==undefined){
            store.set('reflectionSources',['journal','todos',...(data.activityEnabled?['activity']:[])]);
            if(oldActivity!==data.activityEnabled||services.activity?.status().error||activityError)applyActivity(data.activityEnabled);
          }
          return json(res,200,{settings:safeSettings(),settingsEffect:effect(),restart:restartStatus()});
        }finally{configuring=false;}
      }
      if(req.method==='POST'&&path==='/api/session/reset'){
        await readBody(req);if(busy())return json(res,409,{error:'请等待当前回复或配置操作结束'});
        configuring=true;try{await runtime.release(store.get('sessionId'));return json(res,200,{sessionId:store.resetSession()});}finally{configuring=false;}
      }
      if(req.method==='POST'&&path==='/api/cancel'){
        const data=await readBody(req),runId=requiredText(data.runId,100),run=active;
        if(!run||run.id!==runId)return json(res,409,{error:'本次回复已结束或取消标识不匹配'});
        run.cancelled=true;await(run.cancelPromise||=runtime.cancel(run.sessionId));return json(res,200,{ok:true});
      }
      if(req.method==='POST'&&path==='/api/chat'){
        const data=await readBody(req),text=requiredText(data.text,12000);
        if(data.contextIds!==undefined&&(!Array.isArray(data.contextIds)||data.contextIds.length>30||data.contextIds.some(id=>typeof id!=='string')))return json(res,400,{error:'附件列表无效'});
        if(busy())return json(res,409,{error:`${store.get('assistantName','Claudia')} 正在回复，请先停止或等待完成`});
        const sessionId=store.get('sessionId'),run={id:randomUUID(),sessionId,cancelled:false};active=run;
        run.done=new Promise(resolve=>{run.finish=resolve;});
        try {
          const status=await runtime.status();if(!status.configured)return json(res,428,{error:'请在 Harness 模型设置中配置并选择默认模型。无需在插件重复填写 API key。'});
          const context=makeContext(store,{allowContext:store.get('allowContext',false),contextIds:data.contextIds||[]});
          res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});
          const send=value=>{if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify(value)+'\n');};
          let assistant=null,partial='',lastWrite=performance.now();
          const onClose=()=>{if(active===run&&!res.writableEnded){run.cancelled=true;(run.cancelPromise||=runtime.cancel(sessionId)).catch(()=>{});}};res.on('close',onClose);
          try {
            send({type:'status',runId:run.id,text:'正在使用 Harness 已配置的模型…'});
            await runtime.prepare(sessionId);if(run.cancelled)throw new Error('cancelled');
            store.addMessage('user',text);assistant=store.addMessage('assistant','','pending');send({type:'start',id:assistant.id,runId:run.id});
            const result=await runtime.run(sessionId,text+context,{onDelta:delta=>{partial+=delta;send({type:'delta',text:delta});const now=performance.now();if(now-lastWrite>=500){store.updateMessage(assistant.id,partial,'pending');lastWrite=now;}}});
            assistant.content=partial=result.text||partial;
            assistant.status=run.cancelled||result.reason?.kind==='aborted'?'cancelled':result.reason?.kind==='max-tokens'?'truncated':result.reason?.kind==='completed'?'complete':'error';
            if(assistant.status==='error'||!assistant.content&&assistant.status==='complete')throw new Error('incomplete');
            store.updateMessage(assistant.id,assistant.content,assistant.status);send({type:'done',message:assistant});
          }catch{
            if(assistant)store.updateMessage(assistant.id,partial,run.cancelled?'cancelled':'error');
            // Do not reflect arbitrary provider error text: it may contain credentials.
            const message='模型调用或会话恢复失败，请在 Harness 检查模型、凭据与网络。原会话没有被清空。';
            runtime.error=run.cancelled?'':message;send({type:'error',error:run.cancelled?'已停止回复':message});
          }finally{res.off('close',onClose);await run.cancelPromise?.catch(()=>{});res.end();}
        }finally{if(active===run)active=null;run.finish();}
        return;
      }
      if(req.method==='GET'){
        const files={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js'};
        if(files[path]){const data=await readFile(resolve(root,'public',files[path]));res.writeHead(200,{'Content-Type':path.endsWith('.css')?'text/css; charset=utf-8':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});return res.end(data);}
      }
      json(res,404,{error:'未找到该资源'});
    }catch(error){
      const status=error.status||500;
      // 只记录方法、路径与状态；请求体、对话正文和附件内容一律不进日志。
      if(status>=500)logger.error('http.error',{method:req.method,path:req.url?.split('?')[0],status,error});
      if(!res.headersSent)json(res,status,{error:error.status?error.message:'本机操作失败，请检查宿主状态后重试'});else res.end();
    }
  });
  try {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});actualPort=server.address().port;}
  catch(error){store.close();await runtime.close();throw error;}
  try{services=createServices?.({store,runtime,isBusy:()=>!!(active||configuring||closing||Date.now()<drainingUntil),restartBusy:()=>busy()||hostBusy()||!!activityApply,pluginPort:actualPort})||{};}catch(error){await new Promise(r=>server.close(r));store.close();await runtime.close();throw error;}
  return {server,store,runtime,services,url:`http://127.0.0.1:${actualPort}`,async close(){closing=true;const run=active;if(run){run.cancelled=true;await runtime.cancel(run.sessionId).catch(()=>{});}if(services.maintenance?.session)await runtime.cancel(services.maintenance.session).catch(()=>{});await services.maintenance?.close();await services.activity?.close();await activityApply;await runtime.close();await run?.done;await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});store.close();}};
}
