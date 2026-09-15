import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Store, makeContext } from './store.mjs';
const root=dirname(fileURLToPath(import.meta.url));

export function normalizeName(value) {
  if(value===undefined)return 'Claudia';
  if(typeof value!=='string'||value.length>40||/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value))throw Object.assign(new Error('名字最多40个字符，不能包含换行、控制字符或方向控制符'),{status:400});
  return value.trim()||'Claudia';
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
async function body(req){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>65536)throw Object.assign(new Error('请求内容太长'),{status:413});chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();return value;}catch{throw Object.assign(new Error('无效 JSON 对象'),{status:400});}}
function requiredText(text,max){if(typeof text!=='string'||!text.trim()||text.length>max)throw Object.assign(new Error(`请输入 1—${max} 字的内容`),{status:400});return text.trim();}

export async function startServer({dataDir,port=4317,createRuntime}) {
  const csrfToken=randomBytes(32).toString('hex');
  const store=new Store(resolve(dataDir,'claudia.sqlite'));
  const runtime=createRuntime(store);
  let active=null,configuring=false,closing=false,actualPort;
  const readBody=async req=>{const data=await body(req);if(closing)throw Object.assign(new Error('插件正在关闭'),{status:503});return data;};
  const publicSettings=()=>({assistantName:store.get('assistantName','Claudia'),allowContext:store.get('allowContext',false),...runtime.selection()});
  const safeSettings=()=>{try{return publicSettings();}catch{return {assistantName:store.get('assistantName','Claudia'),allowContext:store.get('allowContext',false),provider:'',model:''};}};
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
      if(req.method==='GET'&&path==='/api/state')return json(res,200,{journal:store.journal(),memories:store.memories(),messages:store.messages(),runtime:await runtime.status(),settings:safeSettings(),sessionId:store.get('sessionId')});
      if(req.method==='GET'&&path==='/api/health')return json(res,200,{ok:true,plugin:'dsh-claudia',version:'0.2.1',pid:process.pid,runtime:await runtime.status()});
      if(req.method==='POST'&&path==='/api/journal'){
        const data=await readBody(req),text=requiredText(data.text,5000),date=new Date(data.occurredAt||Date.now());
        if(!Number.isFinite(date.getTime()))return json(res,400,{error:'记录时间无效'});
        return json(res,201,store.addJournal(text,date.toISOString()));
      }
      if(req.method==='DELETE'&&path.startsWith('/api/journal/'))return json(res,store.deleteJournal(path.split('/').pop())?200:404,{ok:true});
      if(req.method==='POST'&&path==='/api/memories'){const data=await readBody(req);return json(res,201,store.addMemory(requiredText(data.text,1000)));}
      if(req.method==='DELETE'&&path.startsWith('/api/memories/'))return json(res,store.deleteMemory(path.split('/').pop())?200:404,{ok:true});
      if(req.method==='POST'&&path==='/api/settings'){
        const data=await readBody(req);
        if(Object.keys(data).some(key=>!['assistantName','allowContext'].includes(key)))return json(res,400,{error:'插件不接收模型端点或 API key，请在 Harness 中配置'});
        if(active||configuring)return json(res,409,{error:'请等待当前回复或配置操作结束'});
        const name=normalizeName(data.assistantName===undefined?store.get('assistantName','Claudia'):data.assistantName);
        if(data.allowContext!==undefined&&typeof data.allowContext!=='boolean')return json(res,400,{error:'上下文开关必须是布尔值'});
        store.set('assistantName',name);if(data.allowContext!==undefined)store.set('allowContext',data.allowContext);
        return json(res,200,{settings:safeSettings()});
      }
      if(req.method==='POST'&&path==='/api/session/reset'){
        await readBody(req);if(active||configuring)return json(res,409,{error:'请等待当前回复或配置操作结束'});
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
        if(active||configuring)return json(res,409,{error:`${store.get('assistantName','Claudia')} 正在回复，请先停止或等待完成`});
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
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'本机操作失败，请检查宿主状态后重试'});else res.end();}
  });
  try {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});actualPort=server.address().port;}
  catch(error){store.close();await runtime.close();throw error;}
  return {server,store,runtime,url:`http://127.0.0.1:${actualPort}`,async close(){closing=true;const run=active;if(run){run.cancelled=true;await runtime.cancel(run.sessionId).catch(()=>{});}await runtime.close();await run?.done;await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});store.close();}};
}
