import { isAbsolute, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from './server.mjs';
import { NativeRuntime } from './native-runtime.mjs';
import { ActivityTracker } from './activity.mjs';
import { Maintenance } from './maintenance.mjs';
import { BackgroundService, createInstaller } from './lifecycle.mjs';
import { RestartControl } from './restart.mjs';
import { Logger, observeProcess } from './logger.mjs';
import { readFileSync } from 'node:fs';
const runningVersion=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
const exec=promisify(execFile);
export const name='dsh-claudia';
export const inject=['dshHomePath','appReady','webStartup','webServer','connection','agents','llm','systemPrompt','tools','agentDefaultModel'];
const open=async target=>{
  if(process.platform==='darwin')await exec('/usr/bin/open',[target],{timeout:10000});
  else if(process.platform==='linux')await exec('xdg-open',[target],{timeout:10000});
  else throw Object.assign(new Error('请手动打开设置中显示的路径或链接'),{status:501});
};
export async function apply(ctx,config={}) {
  const port=config.port??4317;
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('port must be an integer from 0 to 65535');
  const dataDir=config.dataDir??ctx.dshHomePath('claudia');
  if(typeof dataDir!=='string'||!isAbsolute(dataDir))throw new Error('dataDir must be absolute');
  const home=config.home??dirname(ctx.dshHomePath('claudia'));
  const profile=config.profile??'web';
  const logger=new Logger(dataDir,{...Number.isInteger(config.logMaxBytesPerDay)?{maxBytesPerDay:config.logMaxBytesPerDay}:{},...Number.isInteger(config.logRetainDays)?{retainDays:config.logRetainDays}:{}});
  const startedAt=Date.now();
  const hostUrl=()=>`http://127.0.0.1:${ctx.webServer.port}`;
  const app=await startServer({dataDir,port,home,profile,logger,hasOtherAgents:runtime=>{const owned=new Set([...runtime.handles.values()].map(h=>h.agent));return ctx.agents.list().some(a=>!owned.has(a));},createRuntime:store=>new NativeRuntime(ctx,store),getHostUrl:hostUrl,openFolder:open,openHarness:()=>open(ctx.connection.authenticatedUrl(hostUrl())),
    createServices:({store,runtime,isBusy,restartBusy,pluginPort})=>{
      const options={dataDir,home,profile,dshBin:config.dshBin??process.argv[1],nodeBin:config.nodeBin??process.execPath,hostPort:ctx.webServer.port,pluginPort,pnpmPath:config.pnpmPath};
      const activity=new ActivityTracker(dataDir,{logger});
      const maintenance=new Maintenance({store,runtime,activity,isBusy,installUpdate:createInstaller({...options,logger}),logger});
      const background=new BackgroundService(options,{logger});
      const restart=new RestartControl({...options,runningVersion,isBusy:restartBusy,logger});
      return {activity,maintenance,background,restart};
    }});
  let privacyTimer=null,privacySync=false;
  const syncPrivacy=async()=>{
    if(privacySync)return;privacySync=true;
    try{let enabled=false;try{enabled=app.store.get('activityEnabled',false)===true;}catch{}
      if(enabled!==app.services.activity.status().enabled)await app.services.activity.setEnabled(enabled);
    }finally{privacySync=false;}
  };
  const detach=observeProcess({logger,uptimeSec:()=>Math.round((Date.now()-startedAt)/1000)});
  ctx.effect(()=>async()=>{clearInterval(privacyTimer);detach();logger.info('plugin.close',{uptimeSec:Math.round((Date.now()-startedAt)/1000)});await app.close();logger.close();});
  ctx.appReady.onReady(()=>{
    privacyTimer=setInterval(()=>syncPrivacy().catch(()=>{}),1000);privacyTimer.unref();
    process.stderr.write(`Claudia plugin ready: ${app.url}\n`);
    logger.info('plugin.ready',{version:runningVersion,url:app.url,hostPort:ctx.webServer.port,pid:process.pid,supervised:process.env.CLAUDIA_SUPERVISED==='1'});
    app.services.activity.setEnabled(app.store.get('activityEnabled',false)).catch(()=>{});
    app.services.maintenance.start().catch(()=>{});
    if(config.openBrowser!==false&&ctx.webStartup.openBrowser&&!process.env.CLAUDIA_SUPERVISED&&!process.env.SSH_CONNECTION&&!process.env.SSH_TTY)open(app.url).catch(()=>{});
  });
}
