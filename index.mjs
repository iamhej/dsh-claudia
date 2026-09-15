import { isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { startServer } from './server.mjs';
import { NativeRuntime } from './native-runtime.mjs';

export const name='dsh-claudia';
export const inject=['dshHomePath','appReady','webStartup','agents','llm','systemPrompt','tools','agentDefaultModel'];

export async function apply(ctx,config={}) {
  const port=config.port??4317;
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('port must be an integer from 0 to 65535');
  const dataDir=config.dataDir??ctx.dshHomePath('claudia');
  if(typeof dataDir!=='string'||!isAbsolute(dataDir))throw new Error('dataDir must be absolute');
  const app=await startServer({dataDir,port,createRuntime:store=>new NativeRuntime(ctx,store)});
  ctx.effect(()=>()=>app.close());
  ctx.appReady.onReady(()=>{
    process.stderr.write(`Claudia plugin ready: ${app.url}\n`);
    if(config.openBrowser!==false&&ctx.webStartup.openBrowser&&!process.env.SSH_CONNECTION&&!process.env.SSH_TTY){
      if(process.platform==='darwin')execFile('/usr/bin/open',[app.url],{timeout:10000},()=>{});
      else if(process.platform==='linux')execFile('xdg-open',[app.url],{timeout:10000},()=>{});
      // Windows users can open the printed local URL; no shell command interpolation.
    }
  });
}
