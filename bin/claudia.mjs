#!/usr/bin/env node
import { constants, closeSync, existsSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { absolutePath, defaultHome, homeHash, installedPackage, privateDirectory, profileName, readSafe, resolveDsh, resolveExecutable, rollbackInstall, safePath, writePrivate } from '../lifecycle.mjs';

const HELP = '用法：dsh-claudia start [--dsh-bin ABS] [--home ABS] [--profile web] [--port 3088] [--plugin-port 4317] [--pnpm-path ABS] [--no-open]\n后台 LaunchAgent 专用：--background；数据目录默认 HOME/claudia，可用 --data-dir ABS 指定。';
const delay = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
});
export function parseArgs(argv, env = process.env) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { help: true };
  if (argv[0] !== 'start') throw new Error('只支持 start 命令；不默认启动服务');
  const options = { home: env.DSH_HOME || join(homedir(), '.dsh'), profile: 'web', hostPort: 3088, pluginPort: 4317, open: true, background: false };
  const flags = { '--dsh-bin': 'dshBin', '--home': 'home', '--profile': 'profile', '--port': 'hostPort', '--plugin-port': 'pluginPort', '--pnpm-path': 'pnpmPath', '--data-dir': 'dataDir' }, seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`参数重复：${flag}`); seen.add(flag);
    if (flag === '--no-open') { options.open = false; continue; }
    if (flag === '--background') { options.background = true; continue; }
    if (flag === '--help') return { help: true };
    const key = flags[flag];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`未知参数或缺少值：${flag}`);
    options[key] = argv[++i];
  }
  for (const key of ['hostPort', 'pluginPort']) {
    if (!/^\d+$/.test(String(options[key])) || Number(options[key]) < 1 || Number(options[key]) > 65535) throw new Error('端口必须为 1—65535 的整数');
    options[key] = Number(options[key]);
  }
  if (options.hostPort === options.pluginPort) throw new Error('宿主与插件必须使用不同端口');
  for (const key of ['home', 'dshBin', 'pnpmPath', 'dataDir']) if (options[key] !== undefined) options[key] = absolutePath(options[key]);
  options.dataDir ||= join(options.home, 'claudia'); options.profile = profileName(options.profile);
  return options;
}

export async function probeHealth(port) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: 'error', signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); return { occupied: true }; }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { if ((size += chunk.length) > 65536) { controller.abort(); return { occupied: true }; } chunks.push(chunk); }
    try { return { occupied: true, health: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { return { occupied: true }; }
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return { occupied: false };
    return { occupied: true };
  } finally { clearTimeout(timer); }
}
function sameHome(health, o) {
  return health?.ok === true && health.plugin === 'dsh-claudia' && typeof health.version === 'string'
    && Number.isInteger(health.pid) && health.pid > 0 && health.home === o.home && health.profile === o.profile;
}
async function portOccupied(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(800, () => finish(true)); socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
}
function openBrowser(url) {
  if (process.platform === 'darwin') execFile('/usr/bin/open', [url], { timeout: 10000 }, () => {});
  else if (process.platform === 'linux') execFile('xdg-open', [url], { timeout: 10000 }, () => {});
  else process.stdout.write(`请打开 ${url}\n`);
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('supervisor 锁的 PID 无效');
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; }
}
function takeLock(home, token, options) {
  const path = join(home, '.claudia-supervisor.lock'); safePath(path, { missing: true });
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, home, background: !!options.background, pluginPort: options.pluginPort })); } finally { closeSync(fd); }
    return path;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(readSafe(path, 4096).toString('utf8'));
    if (processAlive(previous.pid)) return null;
    // 只移除已证明持有者退出、内容没有变化的自有锁；从不向外部 PID 发送停止信号。
    if (JSON.parse(readSafe(path, 4096).toString('utf8')).token !== previous.token) return null;
    unlinkSync(path); return takeLock(home, token, options);
  }
}
function dropLock(path, token) {
  if (!path || !existsSync(path)) return;
  const current = JSON.parse(readSafe(path, 4096).toString('utf8'));
  if (current.pid === process.pid && current.token === token) unlinkSync(path);
}

export function makeHostArgs({ profile, hostPort }, overlay) {
  return [...(profile === 'web' ? ['web'] : ['--profile', profile]), '--patch', overlay, '--no-open', '--port', String(hostPort)];
}
// 包装器与 dsh 在同一 Node 子进程；即使 supervisor 被 SIGKILL，也由 PPID 监视器收掉自有宿主。
export const CHILD_BOOT = `import {pathToFileURL} from 'node:url';
const [dsh,...args]=process.argv.slice(1);process.argv=[process.execPath,dsh,...args];
const parent=process.ppid;let stopping=false;
setInterval(()=>{if(!stopping&&process.ppid!==parent){stopping=true;process.kill(process.pid,'SIGTERM');setTimeout(()=>process.exit(1),5000).unref();}},500).unref();
const {runCli}=await import(pathToFileURL(dsh).href);
if(typeof runCli!=='function')throw new Error('dsh 缺少已验证的 runCli 入口');
await runCli();`;

async function prepareRestart(o, pid) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  const base = `http://127.0.0.1:${o.pluginPort}`;
  const json = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, redirect: 'error', signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('重启握手被拒绝'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { if ((size += chunk.length) > 65536) { controller.abort(); throw new Error('重启握手响应过大'); } chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  try {
    const { csrfToken } = await json('/api/bootstrap');
    if (typeof csrfToken !== 'string' || !csrfToken || csrfToken.length > 256) return false;
    const health = await json('/api/health');
    if (!sameHome(health, o) || health.pid !== pid || health.busy !== false) return false;
    // 服务端必须在同一临界区检查所有 live agents 并置 draining；不能用 GET idle 代替。
    const result = await json('/api/prepare-restart', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Claudia-Token': csrfToken, Origin: base }, body: '{}' });
    return result.ok === true && result.draining === true;
  } catch { return false; } finally { clearTimeout(timer); }
}

export async function runSupervisor(input, { signal, openURL = openBrowser, log = message => process.stdout.write(`${message}\n`), pollMs = 500, readyTimeout = 45000, shutdownTimeout = 10000 } = {}) {
  const o = { home: defaultHome(), profile: 'web', hostPort: 3088, pluginPort: 4317, open: true, background: false, ...input };
  o.home = absolutePath(o.home); o.dataDir = absolutePath(o.dataDir || join(o.home, 'claudia')); o.profile = profileName(o.profile);
  safePath(o.home);
  const node = resolveExecutable(o.nodeBin || process.execPath, 'node'), dsh = resolveDsh(o.dshBin);
  const pnpm = o.pnpmPath ? resolveExecutable(o.pnpmPath, 'pnpm') : undefined;
  const url = `http://127.0.0.1:${o.pluginPort}`, token = randomUUID();
  let child, childExit, ready = false, readySince = 0, opened = false, lock, idleRequest, recoveryIdle, trial, launchedVersion, recovered = false, lastNotice = '', disableIdle = false, disableStarted = false;
  const stop = new AbortController();
  const onStop = () => stop.abort();
  signal?.addEventListener('abort', onStop, { once: true });
  if (signal?.aborted) stop.abort();
  process.on('SIGINT', onStop); process.on('SIGTERM', onStop);
  const emergency = () => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  process.on('exit', emergency);
  const notice = message => { if (message !== lastNotice) { lastNotice = message; log(message); } };
  const openOnce = () => { if (o.open && !opened) { opened = true; openURL(url); } };
  async function stopChild() {
    if (!child) return;
    const current = child;
    if (current.exitCode === null && current.signalCode === null) {
      current.kill('SIGTERM');
      const timer = setTimeout(() => { if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL'); }, shutdownTimeout);
      try { await childExit; } finally { clearTimeout(timer); }
    }
    if (child === current) child = null;
  }
  function request() {
    const path = join(o.dataDir, '.runtime', 'restart-request.json');
    safePath(path, { missing: true });
    if (!existsSync(path)) return null;
    const value = JSON.parse(readSafe(path, 4096).toString('utf8'));
    const validVersion = version => typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version);
    if (!value || !validVersion(value.verifiedVersion) || value.version !== value.verifiedVersion || !validVersion(value.oldVersion) || typeof value.id !== 'string' || !value.id) throw new Error('重启请求版本或 ID 无效');
    if (dirname(absolutePath(value.backupDir)) !== join(o.dataDir, '.updates', 'backups')) throw new Error('重启请求 backupDir 越界');
    safePath(value.backupDir);
    if (!['pending', 'verifying', 'rolling-back', 'rolled-back', 'rollback-failed', 'recovery-failed'].includes(value.phase)) throw new Error('重启请求阶段无效');
    return { path, value, identity: JSON.stringify(value) };
  }
  function transition(update, changes) {
    if (request()?.identity !== update.identity) throw new Error('重启请求已变化，拒绝继续操作');
    writePrivate(update.path, JSON.stringify({ ...update.value, ...changes }));
    return request();
  }
  function finish(update, state, health) {
    if (request()?.identity !== update.identity) throw new Error('重启请求已变化，拒绝确认');
    writePrivate(join(o.dataDir, '.runtime', 'restart-result.json'), JSON.stringify({ ...update.value, state, applied: state === 'applied', pendingRestart: false, runningVersion: health.version, pid: health.pid, completedAt: new Date().toISOString() }));
    if (request()?.identity === update.identity) unlinkSync(update.path);
    trial = null; idleRequest = null;
  }
  async function recover(reason) {
    if (trial?.value.phase === 'rolled-back') {
      trial = transition(trial, { phase: 'recovery-failed', error: reason });
      throw new Error(`回滚后旧版本启动失败；停止自动重试：${reason}`);
    }
    if (!trial || trial.value.phase !== 'verifying' || trial.value.rollbackAttempted) throw new Error(reason);
    trial = transition(trial, { phase: 'rolling-back', rollbackAttempted: true, error: reason });
    await stopChild();
    try {
      rollbackInstall({ ...o, backupDir: trial.value.backupDir, oldVersion: trial.value.oldVersion });
      trial = transition(trial, { phase: 'rolled-back', rollbackComplete: true, installationUncertain: false });
      recovered = true;
      notice('新版启动验证失败；已恢复旧插件和 profile，将只启动旧版本，不覆盖业务数据');
    } catch (error) {
      trial = transition(trial, { phase: 'rollback-failed', rollbackComplete: false, installationUncertain: true });
      throw new Error('启动失败且回滚未完成；停止自动重试，保留备份供人工恢复', { cause: error });
    }
  }
  try {
    while (!stop.signal.aborted) {
      if (child && (child.exitCode !== null || child.signalCode !== null || !child.pid)) {
        const result = await childExit; child = null;
        const reason = `自有宿主已退出（${result.code ?? result.signal ?? '启动失败'}）`;
        if (trial) { await recover(reason); continue; }
        if (!o.background || trial || recovered) throw new Error(reason);
        notice('自有后台宿主已退出，等待后重新启动'); await delay(Math.max(pollMs, 1000), stop.signal); continue;
      }
      const pkg = installedPackage(o.home, o.profile);
      const probe = await probeHealth(o.pluginPort), health = probe.health;
      if (!child) {
        if (probe.occupied) {
          if (sameHome(health, o)) {
            openOnce();
            notice(health.version === pkg.manifest.version ? '已发现同 home 的 Claudia；不重复启动宿主' : '已有同 home 宿主仍运行旧版本；不热替换或停止外部进程');
            if (!o.background) return { existing: true, version: health.version, pendingRestart: health.version !== pkg.manifest.version, url };
          } else {
            if (!o.background) throw new Error('插件端口被占用，或 health 缺少可验证的 home/profile；不会启动第二个宿主');
            notice('后台等待：端口被占用或无法证明已有宿主身份；不会结束外部进程');
          }
          await delay(pollMs, stop.signal); continue;
        }
        if (await portOccupied(o.hostPort)) {
          if (!o.background) throw new Error('宿主端口已被占用；不会重复启动或结束外部进程');
          notice('后台等待前台宿主退出后接管'); await delay(pollMs, stop.signal); continue;
        }
        lock ||= takeLock(o.home, token, o);
        if (!lock) { notice('同 home 已有 supervisor；等待其宿主就绪或退出'); await delay(pollMs, stop.signal); continue; }
        // 拿锁后再探测，减少与另一启动者的竞态。
        if ((await probeHealth(o.pluginPort)).occupied || await portOccupied(o.hostPort)) { await delay(pollMs, stop.signal); continue; }
        const runtime = privateDirectory(join(o.dataDir, '.runtime'));
        const overlay = join(runtime, `start-${o.profile}.json`);
        const config = { port: o.pluginPort, dataDir: o.dataDir, openBrowser: false, home: o.home, profile: o.profile, dshBin: dsh, nodeBin: node, hostPort: o.hostPort, ...(pnpm ? { pnpmPath: pnpm } : {}) };
        // profile 的常量配置会覆盖模板中读取 webStartup.port 的表达式，故最终 overlay 也必须改 webserver。
        writePrivate(overlay, JSON.stringify([{ id: 'webserver', config: { host: '127.0.0.1', port: o.hostPort } }, { id: 'dsh-claudia', config }]));
        const update = request();
        if (update) {
          if (['rolling-back', 'rollback-failed', 'recovery-failed'].includes(update.value.phase)) throw new Error('上次回滚未完成或旧版启动失败，停止自动启动及重复回滚');
          const expected = update.value.phase === 'rolled-back' ? update.value.oldVersion : update.value.verifiedVersion;
          if (pkg.manifest.version !== expected) throw new Error('已安装版本与重启请求不一致，拒绝启动');
          trial = update.value.phase === 'pending' ? transition(update, { phase: 'verifying' }) : update;
          recovered ||= trial.value.phase === 'rolled-back';
        }
        launchedVersion = pkg.manifest.version;
        const args = makeHostArgs(o, overlay);
        child = spawn(node, ['--input-type=module', '--eval', CHILD_BOOT, dsh, ...args], { cwd: o.home, env: { ...process.env, DSH_HOME: o.home, CLAUDIA_SUPERVISED: '1', CLAUDIA_SUPERVISOR_HOME_HASH: homeHash(o.home), ...(o.background ? { CLAUDIA_BACKGROUND_LABEL: `com.iamhej.dsh-claudia.${homeHash(o.home)}` } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
        const current = child;
        childExit = new Promise(resolve => { current.once('exit', (code, signal) => resolve({ code, signal })); current.once('error', error => resolve({ error })); });
        ready = false; readySince = Date.now(); idleRequest = null; recoveryIdle = null;
        for (const stream of [current.stdout, current.stderr]) {
          let pending = '';
          stream.on('data', bytes => {
            // 不转发宿主的任意日志或凭据；只输出已经验证的就绪标记。
            pending = (pending + bytes.toString('utf8')).slice(-16384);
            const lines = pending.split(/\r?\n/); pending = lines.pop();
            for (const line of lines) {
              const match = /Claudia plugin ready:\s*(http:\/\/(?:127\.0\.0\.1|localhost):\d+)\/?(?:\s|$)/.exec(line);
              if (match && new URL(match[1]).port === String(o.pluginPort) && child === current) ready = true;
            }
          });
        }
        notice(`正在启动 Claudia supervisor（${pkg.manifest.version}）`);
      } else {
        const ours = child.exitCode === null && child.signalCode === null && sameHome(health, o) && health.pid === child.pid;
        const verified = ready && ours && health.version === launchedVersion;
        if (!verified && Date.now() - readySince > readyTimeout) {
          // 未达 appReady 的宿主也可能已接受其他任务；有 health 时，回滚同样不能绕过 draining。
          if (ours) {
            const idle = health.busy === false;
            if (!idle || recoveryIdle !== child.pid || !await prepareRestart(o, child.pid)) {
              recoveryIdle = idle ? child.pid : null;
              notice('启动验证超时，但宿主尚未确认可安全停止；继续等待，不打断其他任务');
              await delay(pollMs, stop.signal); continue;
            }
          }
          await recover('等待 Claudia plugin ready 日志及同 home、同版本健康检查超时');
          continue;
        }
        if (verified) {
          if (trial) {
            if (trial.value.phase === 'verifying' && health.version === trial.value.verifiedVersion && pkg.manifest.version === trial.value.verifiedVersion) finish(trial, 'applied', health);
            else if (trial.value.phase === 'rolled-back' && health.version === trial.value.oldVersion && pkg.manifest.version === trial.value.oldVersion) finish(trial, 'rolled-back', health);
          }
          openOnce(); notice(`Claudia plugin ready: ${url}`);
          const disablePath = join(o.dataDir, '.runtime', 'background-disable-request.json');
          safePath(disablePath, { missing: true });
          if (o.background && process.platform === 'darwin' && !disableStarted && existsSync(disablePath)) {
            const pending = JSON.parse(readSafe(disablePath, 4096));
            if (!pending.id || typeof pending.id !== 'string') throw new Error('后台停用请求无效');
            if (health.busy === false && disableIdle && await prepareRestart(o, child.pid)) {
              // 单独的自有 helper 执行 bootout，以免设置请求等待自身退出造成死锁。
              const code = `import {pathToFileURL} from 'node:url';const {BackgroundService,writePrivate,safePath}=await import(pathToFileURL(process.argv[1]));const {unlinkSync}=await import('node:fs');const o=JSON.parse(process.argv[2]),p=process.argv[3];try{await new BackgroundService(o).setEnabled(false);safePath(p);unlinkSync(p);}catch{writePrivate(p,JSON.stringify({id:'failed',error:'launchctl 停用失败，服务未确认关闭'}));process.exitCode=1;}`;
              const env = { ...process.env }; delete env.CLAUDIA_BACKGROUND_LABEL; delete env.CLAUDIA_SUPERVISED;
              const helper = spawn(node, ['--input-type=module', '--eval', code, join(pkg.slot, 'lifecycle.mjs'), JSON.stringify({ dataDir: o.dataDir, home: o.home, dshBin: dsh, nodeBin: node, profile: o.profile, hostPort: o.hostPort, pluginPort: o.pluginPort, pnpmPath: pnpm }), disablePath], { env, detached: true, stdio: 'ignore' });
              helper.on('error', () => notice('后台停用 helper 未启动；服务仍未确认关闭')); helper.unref(); disableStarted = true;
            }
            disableIdle = health.busy === false;
          } else disableIdle = false;
          const update = request();
          if (update && !disableStarted && pkg.manifest.version === update.value.verifiedVersion && update.value.phase === 'pending') {
            if (health.busy === false) {
              // 两次 idle 之后还需 CSRF 原子 draining 握手；缺接口、其他 live agent 或竞态均只等待。
              if (idleRequest === update.identity) {
                idleRequest = null;
                if (await prepareRestart(o, child.pid) && request()?.identity === update.identity) {
                  trial = transition(update, { phase: 'verifying' });
                  await stopChild();
                  notice('已完成 draining 握手并优雅停止自有宿主，将验证新版启动');
                  continue;
                }
              } else idleRequest = update.identity;
            } else idleRequest = null;
          } else idleRequest = null;
        }
      }
      await delay(pollMs, stop.signal);
    }
    return { stopped: true, url };
  } finally {
    // launchctl 的 bootout 只针对本 label；任何前台/外部 health PID 都不会传入 kill。
    await stopChild(); dropLock(lock, token);
    process.off('SIGINT', onStop); process.off('SIGTERM', onStop); process.off('exit', emergency); signal?.removeEventListener('abort', onStop);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(`${HELP}\n`); return; }
  await runSupervisor(options);
}
const invoked = process.argv[1] && (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) main().catch(error => { process.stderr.write(`Claudia：${error.message}\n`); process.exitCode = 1; });
