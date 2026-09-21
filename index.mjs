import { isAbsolute, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from './server.mjs';
import { NativeRuntime } from './native-runtime.mjs';
import { NewsRuntime } from './news-runtime.mjs';
import { createPluginInventory } from './plugins.mjs';
import { EmailControl } from './email-control.mjs';
import { EmailAccount } from './email-account.mjs';
import { EmailReview } from './email-review.mjs';
import { ActivityTracker } from './activity.mjs';
import { Maintenance } from './maintenance.mjs';
import { BackgroundService, createInstaller, pruneUpdates } from './lifecycle.mjs';
import { RestartControl } from './restart.mjs';
import { createHostBusy } from './host-busy.mjs';
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
  let news, web, settings, emailReview;
  ctx.inject(['web'], child => { web=child.web; child.effect(()=>()=>{web=undefined;}); });
  ctx.inject(['settings'], child => { settings=child.settings; child.effect(()=>()=>{settings=undefined;}); });
  const getPlugins=createPluginInventory({home,profile,hostAnchor:config.dshBin??process.argv[1],getEntries:()=>ctx.get('loader')?.entries()??null});
  // 宿主 agent 清单里凡是本插件自己持有的都算“自有”，借用（borrowed）的宿主 live agent 同样自有：
  // 复用 live agent 时它正是本插件主对话所在的会话，之前把它过滤掉会让 hostBusy 恒为真，
  // 一键重启与邮件开关被永久卡住，而日志里看不出是谁在占（判定规则见 host-busy.mjs，低频记日志）。
  // 各服务持有的 runtime 位置不同：news 是 NewsRuntime（真正的 runtime 在 .runtime），
  // emailReview 是 EmailReview（.reader / .analysis）。少算任何一个，都会把它们自己的会话
  // 当成“别人在用”，一键重启和邮件开关照旧被卡住。
  const hasOtherAgents=createHostBusy({ctx,logger,getRuntimes:runtime=>[runtime,news?.runtime,emailReview?.reader,emailReview?.analysis]});
  const app=await startServer({dataDir,port,home,profile,logger,getPlugins,hasOtherAgents,createRuntime:store=>new NativeRuntime(ctx,store,{reuseLiveAgent:true,onUnexpectedTools:({sessionId,tools})=>logger.warn('chat.tools.suppressed',{sessionId,tools})}),getHostUrl:hostUrl,openFolder:open,openHarness:()=>open(ctx.connection.authenticatedUrl(hostUrl())),
    createServices:({store,runtime,isBusy,restartBusy,pluginPort})=>{
      const options={dataDir,home,profile,dshBin:config.dshBin??process.argv[1],nodeBin:config.nodeBin??process.execPath,hostPort:ctx.webServer.port,pluginPort,pnpmPath:config.pnpmPath};
      const activity=new ActivityTracker(dataDir,{logger});
      news=new NewsRuntime(ctx,store,()=>web);
      const maintenance=new Maintenance({store,runtime,activity,news,isBusy,installUpdate:createInstaller({...options,logger}),logger});
      const background=new BackgroundService(options,{logger});
      const restart=new RestartControl({...options,runningVersion,isBusy:restartBusy,logger});
      const email=new EmailControl({home,profile,dataDir,hostAnchor:options.dshBin,getPlugins});
      const emailAccount=new EmailAccount({getSettings:()=>settings,getEntries:()=>ctx.get('loader')?.entries()??null,getPlugins});
      emailReview=new EmailReview(ctx,store,emailAccount);
      return {activity,maintenance,background,restart,news,email,emailAccount,emailReview};
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
    // 启动时清理上次更新留下的临时包、过期备份，以及一次性会话的累积 ID。
    try{pruneUpdates({dataDir,home,profile,logger});}catch(error){logger.warn('update.prune.fail',{error});}
    try{
      const runtimes=[app.runtime,app.services.news?.runtime,app.services.emailReview?.reader,app.services.emailReview?.analysis].filter(Boolean);
      const dropped=runtimes.reduce((sum,runtime)=>sum+(runtime.pruneSessions?.()??0),0);
      if(dropped)logger.info('sessions.prune',{dropped});
    }catch(error){logger.warn('sessions.prune.fail',{error});}
    if(config.openBrowser!==false&&ctx.webStartup.openBrowser&&!process.env.CLAUDIA_SUPERVISED&&!process.env.SSH_CONNECTION&&!process.env.SSH_TTY)open(app.url).catch(()=>{});
  });
}
