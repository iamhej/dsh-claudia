import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RestartControl, SupervisorRestart } from '../restart.mjs';
import { installedPackage, writePrivate } from '../lifecycle.mjs';
import { runSupervisor } from '../bin/claudia.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'bin', 'claudia.mjs');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'claudia-manual-restart-'));
  const home = join(dir, 'home'), dataDir = join(home, 'claudia'), profile = 'web';
  const manifest = join(home, 'profiles', profile, 'node_modules', 'dsh-claudia', 'package.json');
  write(manifest, { name: 'dsh-claudia', version: '0.3.0' });
  // 整个测试只用临时合成 home；凭据入口故意不可读，禁止使用真实 provider。
  symlinkSync(join(dir, 'NEVER_READ_CREDENTIALS'), join(home, '.credentials.yaml'));
  write(join(dataDir, 'journal.md'), 'SYNTHETIC_DATA_UNCHANGED');
  const runtime = join(dataDir, '.runtime'), request = join(runtime, 'manual-restart.json'), result = join(runtime, 'manual-restart-result.json');
  const heartbeat = join(runtime, 'supervisor-state.json'), lock = join(home, '.claudia-supervisor.lock');
  const options = { home, dataDir, profile, runningVersion: '0.3.0', supervised: true };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, home, dataDir, profile, manifest, runtime, request, result, heartbeat, lock, options };
}
function heartbeatFixture(f, changes = {}) {
  const token = randomUUID();
  const heartbeat = { pid: process.ppid, hostPid: process.pid, home: f.home, dataDir: f.dataDir, profile: f.profile, version: '0.3.0', protocol: 1, token, updatedAt: new Date().toISOString(), ...changes };
  write(f.lock, { pid: process.ppid, token, home: f.home }); write(f.heartbeat, heartbeat);
  return heartbeat;
}
function manualRequest(f, changes = {}) {
  const heartbeat = read(f.heartbeat);
  const value = { id: randomUUID(), requestedAt: new Date().toISOString(), expectedPid: heartbeat.hostPid, desiredVersion: read(f.manifest).version, home: f.home, profile: f.profile, supervisorToken: heartbeat.token, phase: 'pending', ...changes };
  writePrivate(f.request, JSON.stringify(value)); return value;
}
function unchanged(f) {
  assert.equal(readFileSync(join(f.dataDir, 'journal.md'), 'utf8'), 'SYNTHETIC_DATA_UNCHANGED');
  assert.equal(lstatSync(join(f.home, '.credentials.yaml')).isSymbolicLink(), true);
  assert.equal(existsSync(join(f.dataDir, '.updates')), false);
  assert.equal(existsSync(join(f.runtime, 'restart-request.json')), false);
  assert.equal(existsSync(join(f.runtime, 'restart-result.json')), false);
}
async function eventually(check, message = '等待隔离测试条件超时', timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(message);
}
async function ports() {
  const servers = [createServer(), createServer()];
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const [hostPort, pluginPort] = servers.map(server => server.address().port);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return { hostPort, pluginPort };
}
function events(f, type) {
  const path = join(f.home, 'events.jsonl');
  const all = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return type ? all.filter(event => event.type === type) : all;
}
async function polls(f, count = 5) {
  const before = events(f, 'health').length;
  await eventually(() => events(f, 'health').length >= before + count);
}

// 只实现测试宿主；权限与 CSRF 的真实 HTTP 路由由主 server 的测试负责。
const MOCK_HOST = `#!/usr/bin/env node
import {createServer} from 'node:http';
import {readFileSync,appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {RestartControl} from ${JSON.stringify(pathToFileURL(join(root, 'restart.mjs')).href)};
export async function runCli(){
 const home=process.env.DSH_HOME,args=process.argv.slice(2);
 if(args[0]==='--version'){process.stdout.write('MOCK_ONLY\\n');return;}
 const read=p=>JSON.parse(readFileSync(p,'utf8'));
 const overlay=read(args[args.indexOf('--patch')+1]);
 const o=overlay.find(v=>v.id==='dsh-claudia').config,web=overlay.find(v=>v.id==='webserver').config;
 const pkg=read(join(home,'profiles',o.profile,'node_modules','dsh-claudia','package.json'));
 const event=value=>appendFileSync(join(home,'events.jsonl'),JSON.stringify({...value,pid:process.pid})+'\\n');
 const settings=()=>existsSync(join(home,'mock.json'))?read(join(home,'mock.json')):{};
 const mode=()=>({...settings(),...settings().versions?.[pkg.version]});
 const busy=()=>({busy:!!mode().busy,otherAgents:mode().otherAgents||0});
 const control=new RestartControl({...o,runningVersion:pkg.version,isBusy:busy});
 let draining=false,healthCount=0;
 event({type:'start',version:pkg.version});
 if(mode().crash)process.exit(23);
 const server=createServer(async(req,res)=>{
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/api/bootstrap')return reply(200,{csrfToken:'fixture-token'});
  if(req.url==='/api/prepare-restart'){
   for await(const chunk of req){}
   event({type:'prepare',healthCount,token:req.headers['x-claudia-token'],origin:req.headers.origin});
   if(req.headers['x-claudia-token']!=='fixture-token'||req.headers.origin!=='http://127.0.0.1:'+o.port)return reply(403,{});
   if(mode().prepareStatus)return reply(mode().prepareStatus,{});
   if(mode().busy||mode().otherAgents||mode().raceBusy)return reply(409,{});
   draining=!mode().noDraining;
   event({type:'draining',draining});return reply(200,{ok:true,draining});
  }
  if(req.url==='/test/request'){
   for await(const chunk of req){}
   try{return reply(200,control.request());}catch(error){return reply(error.status||500,{error:error.message});}
  }
  if(req.url!=='/api/health')return reply(404,{});
  healthCount++;event({type:'health',healthCount,busy:!!(mode().busy||mode().otherAgents)});
  const health={ok:true,plugin:'dsh-claudia',home,profile:o.profile,pid:process.pid,version:mode().healthVersion||pkg.version,restart:control.status()};
  if(!mode().missingBusy)health.busy=!!(mode().busy||mode().otherAgents);
  return reply(200,health);
 });
 const host=createServer((req,res)=>res.end('MOCK_ONLY'));
 host.listen(web.port,web.host);
 server.listen(o.port,'127.0.0.1',()=>{
  if(!mode().noReady)setTimeout(()=>{event({type:'ready'});process.stderr.write('Claudia plugin ready: http://127.0.0.1:'+o.port+'\\n');},mode().readyDelay||10);
 });
 process.on('SIGTERM',()=>{event({type:'term',draining});host.closeAllConnections();server.closeAllConnections();host.close();server.close(()=>process.exit(0));});
}
if(import.meta.main)await runCli();
`;
async function supervisor(t, f, extra = {}, hooks = {}) {
  const pair = await ports(), dshBin = join(f.dir, 'mock-dsh.mjs');
  write(dshBin, MOCK_HOST); chmodSync(dshBin, 0o700);
  const abort = new AbortController(), logs = [], options = { ...f.options, ...pair, dshBin, open: false, ...extra };
  const promise = runSupervisor(options, { signal: abort.signal, pollMs: 35, readyTimeout: 1200, shutdownTimeout: 700, log: value => logs.push(value), openURL() { assert.fail('测试不得打开浏览器'); }, ...hooks });
  promise.catch(() => {});
  t.after(async () => { abort.abort(); await promise.catch(() => {}); });
  const json = async (path = '/api/health', method = 'GET') => {
    const response = await fetch('http://127.0.0.1:' + pair.pluginPort + path, { method, signal: AbortSignal.timeout(2000) });
    return { status: response.status, value: await response.json() };
  };
  return { promise, logs, options, json, stop: async () => { abort.abort(); await promise; } };
}
async function ready(f, s) {
  await eventually(() => s.logs.some(line => line.startsWith('Claudia plugin ready:')));
  assert.equal((await s.json()).value.restart.supported, true);
}

test('构造与 status 不创建目录；环境变量不足以支持重启；版本差异直接显示 pending', t => {
  const f = fixture(t), control = new RestartControl(f.options);
  assert.equal(existsSync(f.runtime), false);
  assert.deepEqual(control.status(), { supported: false, pending: false, state: 'idle', reason: 'unsupported', message: '没有有效且存活的自有 supervisor；请使用启动入口启动', busy: false, runningVersion: '0.3.0', installedVersion: '0.3.0' });
  assert.throws(() => control.request(), error => error.status === 503);
  assert.equal(existsSync(f.runtime), false);
  write(f.manifest, { name: 'dsh-claudia', version: '0.4.0' });
  assert.equal(control.status().pending, true); assert.equal(control.status().state, 'pending');
  unchanged(f);
});

test('有效心跳必须匹配父进程、自身 PID、home/profile、锁、协议与有效期', async t => {
  for (const [label, change] of [
    ['正确', {}], ['错误父 PID', { pid: process.pid }], ['错误子 PID', { hostPid: process.ppid }],
    ['错误 home', { home: '/not-the-same-home' }], ['错误 profile', { profile: 'other' }], ['错误 dataDir', { dataDir: '/not-the-same-data' }],
    ['未知协议', { protocol: 2 }], ['无效版本', { version: '../bad' }], ['其他运行版本', { version: '0.4.0' }], ['无效 token', { token: 'forged' }],
    ['过期', { updatedAt: new Date(Date.now() - 10001).toISOString() }], ['未来', { updatedAt: new Date(Date.now() + 60000).toISOString() }],
    ['无效时间', { updatedAt: 'bad' }], ['不允许进程组', { pid: -1 }],
  ]) await t.test(label, t => {
    const f = fixture(t); heartbeatFixture(f, change);
    const control = new RestartControl(f.options);
    assert.equal(control.status().supported, label === '正确');
    if (label !== '正确') assert.throws(() => control.request(), error => error.status === 503);
    assert.equal(existsSync(f.request), false);
  });
  const f = fixture(t); heartbeatFixture(f);
  write(f.lock, { pid: process.ppid, token: randomUUID(), home: f.home });
  assert.equal(new RestartControl(f.options).status().supported, false);
  heartbeatFixture(f);
  assert.equal(new RestartControl({ ...f.options, supervised: false }).status().supported, false);
});

test('kill0 已退出或权限不可验证时拒绝支持；request 绝不发送终止信号', t => {
  const f = fixture(t); heartbeatFixture(f);
  const control = new RestartControl(f.options);
  const kill = t.mock.method(process, 'kill', (target, signal) => { assert.equal(target, process.ppid); assert.equal(signal, 0); return true; });
  assert.equal(control.request().pending, true);
  for (const code of ['ESRCH', 'EPERM']) {
    kill.mock.mockImplementation((target, signal) => { assert.equal(signal, 0); throw Object.assign(new Error('模拟不可用'), { code }); });
    assert.equal(control.status().supported, false);
    assert.throws(() => control.request(), error => error.status === 503);
  }
});

test('busy 与 otherAgents 明确拒绝 409，回调异常保守拒绝，状态保留 pending', async t => {
  for (const value of [true, { busy: false, otherAgents: 1 }, { busy: false, otherAgents: ['agent'] }, { busy: true, otherAgents: 0 }, undefined, 'unknown']) await t.test(String(value), t => {
    const f = fixture(t); heartbeatFixture(f);
    write(f.manifest, { name: 'dsh-claudia', version: '0.4.0' });
    const control = new RestartControl({ ...f.options, isBusy: () => value });
    assert.equal(control.status().busy, true); assert.equal(control.status().pending, true);
    assert.match(control.status().message, /其他 agent/);
    assert.throws(() => control.request(), error => error.status === 409);
    assert.equal(existsSync(f.request), false);
  });
  const f = fixture(t); heartbeatFixture(f);
  assert.throws(() => new RestartControl({ ...f.options, isBusy() { throw new Error(); } }).request(), error => error.status === 409);
});

test('installed 仅来自固定 profile 包，包名验证且支持受限 pnpm 链接', t => {
  const f = fixture(t); heartbeatFixture(f);
  const control = new RestartControl(f.options);
  write(f.manifest, { name: 'another-package', version: '0.4.0' });
  assert.equal(control.status().state, 'error'); assert.equal(control.status().installedVersion, null);
  assert.throws(() => control.request(), error => error.status === 503);
  const slot = dirname(f.manifest), modules = dirname(slot);
  rmSync(slot, { recursive: true });
  const target = join(modules, '.pnpm', 'dsh-claudia@0.4.0', 'node_modules', 'dsh-claudia');
  write(join(target, 'package.json'), { name: 'dsh-claudia', version: '0.4.0' }); symlinkSync(target, slot);
  assert.equal(control.status().installedVersion, '0.4.0'); assert.equal(control.status().pending, true);
  rmSync(slot); symlinkSync(f.dir, slot);
  assert.equal(control.status().state, 'error');
  assert.throws(() => new RestartControl({ ...f.options, profile: '../other' }));
});

test('心跳、请求、结果、锁拒绝 symlink、hardlink、不私有文件及损坏 JSON', async t => {
  for (const key of ['heartbeat', 'request', 'result', 'lock']) await t.test(key, async t => {
    for (const kind of ['symlink', 'hardlink', 'public', 'directory', 'json', 'null', 'oversize']) await t.test(kind, t => {
      const f = fixture(t); heartbeatFixture(f); const outside = join(f.dir, 'protected.json');
      write(outside, { sentinel: true });
      if (existsSync(f[key])) rmSync(f[key]);
      if (kind === 'symlink') symlinkSync(outside, f[key]);
      else if (kind === 'hardlink') linkSync(outside, f[key]);
      else if (kind === 'directory') mkdirSync(f[key]);
      else { write(f[key], kind === 'oversize' ? 'x'.repeat(4097) : kind === 'null' ? 'null' : '{broken'); if (kind === 'public') chmodSync(f[key], 0o644); }
      const control = new RestartControl(f.options);
      assert.equal(control.status().state, 'error'); assert.throws(() => control.request(), error => error.status === 503);
      assert.deepEqual(read(outside), { sentinel: true });
    });
  });
});

test('运行目录不能链接到其他目录；构造和拒绝请求均不创建外部文件', t => {
  const f = fixture(t), outside = join(f.dir, 'outside'); mkdirSync(outside);
  symlinkSync(outside, f.runtime);
  const control = new RestartControl(f.options);
  assert.equal(control.status().supported, false);
  assert.throws(() => control.request(), error => error.status === 503);
  assert.equal(existsSync(join(outside, 'manual-restart.json')), false);
});

test('重复 request 幂等，固定 UUID/PID/版本，忽略调用参数且不使用自动更新请求', t => {
  const f = fixture(t); heartbeatFixture(f);
  const control = new RestartControl(f.options);
  const first = control.request({ expectedPid: -1, desiredVersion: 'evil', path: '/outside' });
  const bytes = readFileSync(f.request), initial = read(f.request);
  assert.match(initial.id, /^[0-9a-f-]{36}$/); assert.equal(initial.expectedPid, process.pid); assert.equal(initial.desiredVersion, '0.3.0');
  assert.equal(first.state, 'pending'); assert.equal(first.pending, true);
  for (let i = 0; i < 5; i++) assert.deepEqual(control.request(), first);
  assert.deepEqual(readFileSync(f.request), bytes); assert.equal(lstatSync(f.request).mode & 0o777, 0o600);
  assert.equal(initial.backupDir, undefined); unchanged(f);
});

test('supervisor 心跳清理只移除自有记录；无法覆盖其他存活 supervisor', t => {
  const f = fixture(t), token = randomUUID();
  write(f.lock, { pid: process.pid, token, home: f.home });
  const manual = new SupervisorRestart(f.options, token);
  manual.publish({ hostPid: process.ppid, version: '0.3.0' });
  assert.equal(read(f.heartbeat).protocol, 1); assert.equal(lstatSync(f.heartbeat).mode & 0o777, 0o600);
  const foreign = { ...read(f.heartbeat), token: randomUUID() }; writePrivate(f.heartbeat, JSON.stringify(foreign));
  manual.clear(); assert.deepEqual(read(f.heartbeat), foreign);
  assert.throws(() => manual.publish({ hostPid: process.ppid, version: '0.3.0' }), /其他 supervisor/);
  writePrivate(f.heartbeat, JSON.stringify({ ...foreign, token })); manual.clear(); assert.equal(existsSync(f.heartbeat), false);
});

test('手动请求消费一次；重放、换 PID 和被替换请求不产生额外重启', t => {
  const f = fixture(t), token = randomUUID();
  write(f.lock, { pid: process.pid, token, home: f.home });
  const manual = new SupervisorRestart(f.options, token);
  manual.publish({ hostPid: process.ppid, version: '0.3.0' });
  const request = manualRequest(f);
  assert.equal(manual.pending(process.pid), null);
  manual.start(request, process.ppid); assert.equal(read(f.request).phase, 'restarting');
  assert.equal(manual.pending(process.ppid), null); assert.throws(() => manual.start(request, process.ppid));
  const later = manualRequest(f, { expectedPid: process.pid });
  manual.finish({ pid: process.pid, version: '0.3.0', home: f.home, profile: f.profile });
  assert.deepEqual(read(f.request), later); assert.equal(read(f.result).id, request.id);
  writePrivate(f.request, JSON.stringify({ ...request, expectedPid: process.pid }));
  assert.equal(manual.pending(process.pid), null);
  const next = new SupervisorRestart(f.options, token);
  assert.equal(next.pending(process.pid), null);
});

test('supervisor 每两秒刷新心跳，旧版本显示 pending；同版本用户请求也只重启一次', async t => {
  const f = fixture(t), s = await supervisor(t, f); await ready(f, s);
  const first = read(f.heartbeat), hostPid = first.hostPid;
  assert.equal(first.pid, process.pid); assert.equal(first.home, f.home); assert.equal(first.profile, f.profile);
  await eventually(() => read(f.heartbeat).updatedAt !== first.updatedAt);
  const gap = Date.parse(read(f.heartbeat).updatedAt) - Date.parse(first.updatedAt);
  assert.ok(gap >= 1800 && gap < 5000, '心跳应按两秒间隔刷新');
  const response = await s.json('/test/request', 'POST'); assert.equal(response.status, 200); assert.equal(response.value.pending, true);
  await eventually(() => existsSync(f.result));
  const result = read(f.result); assert.equal(result.applied, true); assert.equal(result.state, 'idle'); assert.notEqual(result.pid, hostPid);
  assert.equal(existsSync(f.request), false); await polls(f);
  assert.equal(events(f, 'start').length, 2); assert.equal(events(f, 'term').length, 1);
  assert.equal((await s.json()).value.restart.state, 'idle'); unchanged(f);
  await s.stop(); assert.equal(existsSync(f.heartbeat), false); assert.equal(existsSync(f.lock), false);
});

test('本地包替换后手动启动新版，必须等实际 appReady 与 health 版本确认', async t => {
  const f = fixture(t), s = await supervisor(t, f); await ready(f, s);
  write(f.manifest, { name: 'dsh-claudia', version: '0.4.0' });
  write(join(f.home, 'mock.json'), { versions: { '0.4.0': { readyDelay: 500 } } });
  const before = (await s.json()).value.restart;
  assert.equal(before.runningVersion, '0.3.0'); assert.equal(before.installedVersion, '0.4.0'); assert.equal(before.pending, true);
  assert.equal((await s.json('/test/request', 'POST')).status, 200);
  await eventually(() => events(f, 'start').length === 2);
  assert.equal(existsSync(f.result), false); assert.equal(read(f.request).phase, 'restarting');
  await eventually(() => existsSync(f.result));
  assert.equal(read(f.result).runningVersion, '0.4.0'); assert.equal(existsSync(f.request), false);
  const log = events(f), prepare = log.find(e => e.type === 'prepare');
  assert.ok(prepare.healthCount >= 3); assert.equal(prepare.token, 'fixture-token');
  assert.equal(events(f, 'term')[0].draining, true);
  assert.ok(log.findIndex(e => e.type === 'draining') < log.findIndex(e => e.type === 'term'));
  assert.deepEqual(events(f, 'start').map(e => e.version), ['0.3.0', '0.4.0']);
  assert.equal((await s.json()).value.restart.pending, false); unchanged(f); await s.stop();
});

test('其他 agent、缺 busy、权限/CSRF 握手失败及 idle 竞态均等待，不杀宿主', async t => {
  const f = fixture(t); write(join(f.home, 'mock.json'), { otherAgents: 1 });
  const s = await supervisor(t, f); await ready(f, s);
  assert.equal((await s.json('/test/request', 'POST')).status, 409);
  manualRequest(f);
  await polls(f); assert.equal(events(f, 'prepare').length, 0); assert.equal(events(f, 'term').length, 0);
  const health = (await s.json()).value;
  assert.equal(health.busy, true); assert.equal(health.restart.busy, true); assert.match(health.restart.message, /其他 agent/);
  for (const mode of [{ missingBusy: true }, { raceBusy: true }, { prepareStatus: 403 }, { prepareStatus: 404 }, { prepareStatus: 503 }, { noDraining: true }]) {
    write(join(f.home, 'mock.json'), mode);
    if (mode.missingBusy) await polls(f);
    else { const before = events(f, 'prepare').length; await eventually(() => events(f, 'prepare').length > before); }
    assert.equal(events(f, 'term').length, 0, JSON.stringify(mode)); assert.equal(read(f.request).phase, 'pending');
  }
  write(join(f.home, 'mock.json'), {});
  await eventually(() => existsSync(f.result)); await polls(f);
  assert.equal(events(f, 'start').length, 2); assert.equal(events(f, 'term').length, 1);
  await s.stop(); unchanged(f);
});

test('伪造 expectedPid、scope/token 或版本不能停止任何进程；安全文件失败不消费', async t => {
  const f = fixture(t), s = await supervisor(t, f); await ready(f, s);
  for (const changes of [{ expectedPid: process.pid }, { expectedPid: -1 }, { profile: 'other' }, { home: f.dir }, { supervisorToken: randomUUID() }, { desiredVersion: '9.9.9' }]) {
    manualRequest(f, changes); await polls(f, 4);
    assert.equal(events(f, 'term').length, 0); assert.equal(events(f, 'start').length, 1);
  }
  rmSync(f.request); const sentinel = join(f.dir, 'sentinel.json'); write(sentinel, { keep: true }); symlinkSync(sentinel, f.request);
  await polls(f, 4); assert.deepEqual(read(sentinel), { keep: true }); assert.equal(events(f, 'term').length, 0);
  assert.equal((await s.json('/test/request', 'POST')).status, 503);
  rmSync(f.request); await s.stop(); unchanged(f);
});

test('新版崩溃、无 appReady、health 版本错误都明确失败并停止，不回滚或后台重试', async t => {
  for (const mode of [{ crash: true }, { noReady: true }, { healthVersion: '0.9.9' }]) await t.test(JSON.stringify(mode), async t => {
    const f = fixture(t), s = await supervisor(t, f, { background: true }, { readyTimeout: 400 }); await ready(f, s);
    write(f.manifest, { name: 'dsh-claudia', version: '0.4.0' });
    write(join(f.home, 'mock.json'), { versions: { '0.4.0': mode } });
    assert.equal((await s.json('/test/request', 'POST')).status, 200);
    await assert.rejects(s.promise, /手动重启失败/);
    assert.equal(read(f.result).state, 'error'); assert.equal(read(f.result).applied, false); assert.equal(read(f.request).phase, 'error');
    assert.match(read(f.result).message, /不回滚/);
    assert.equal(installedPackage(f.home).manifest.version, '0.4.0');
    assert.deepEqual(events(f, 'start').map(e => e.version), ['0.3.0', '0.4.0']);
    assert.equal(existsSync(f.heartbeat), false); assert.equal(existsSync(f.lock), false);
    const again = await supervisor(t, f, { background: true }); await assert.rejects(again.promise, /上次手动重启/);
    assert.equal(events(f, 'start').length, 2); unchanged(f);
  });
});

test('新版未就绪但其他 agent 忙时推迟安全失败停止，并在 health 提示', async t => {
  const f = fixture(t), s = await supervisor(t, f, {}, { readyTimeout: 1500 }); await ready(f, s);
  write(f.manifest, { name: 'dsh-claudia', version: '0.4.0' });
  write(join(f.home, 'mock.json'), { versions: { '0.4.0': { noReady: true, otherAgents: 1 } } });
  assert.equal((await s.json('/test/request', 'POST')).status, 200);
  await eventually(() => s.logs.some(line => line.includes('启动验证超时')));
  assert.equal(events(f, 'term').length, 1); assert.equal(existsSync(f.result), false);
  const status = (await s.json()).value.restart; assert.equal(status.busy, true); assert.match(status.message, /其他 agent/);
  write(join(f.home, 'mock.json'), { versions: { '0.4.0': { noReady: true } } });
  await assert.rejects(s.promise, /手动重启失败/);
  assert.equal(events(f, 'term').length, 2); assert.equal(read(f.result).state, 'error'); unchanged(f);
});

test('启动入口 existing 检测只观察外部宿主，不创建心跳、不读取凭据、不消费请求', async t => {
  const f = fixture(t), pair = await ports(), dshBin = join(f.dir, 'mock-dsh.mjs'); write(dshBin, MOCK_HOST); chmodSync(dshBin, 0o700);
  const server = createServer((req, res) => res.end(JSON.stringify({ ok: true, plugin: 'dsh-claudia', version: '0.2.0', pid: process.pid, home: f.home, profile: f.profile, busy: false })));
  await new Promise(resolve => server.listen(pair.pluginPort, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await runSupervisor({ ...f.options, ...pair, dshBin, open: false }, { log() {} });
  assert.equal(result.existing, true); assert.equal(result.pendingRestart, true);
  assert.equal(existsSync(f.runtime), false); assert.equal(events(f).length, 0); unchanged(f);
});

test('消费后父崩溃保留 restarting 标记，新 supervisor 不重复消费或回滚', async t => {
  const f = fixture(t), pair = await ports(), dshBin = join(f.dir, 'mock-dsh.mjs'); write(dshBin, MOCK_HOST); chmodSync(dshBin, 0o700);
  const parent = spawn(process.execPath, [cli, 'start', '--home', f.home, '--dsh-bin', dshBin, '--port', String(pair.hostPort), '--plugin-port', String(pair.pluginPort), '--no-open'], { stdio: 'ignore', env: { ...process.env, HOME: f.dir, DSH_HOME: f.home } });
  const exited = new Promise(resolve => parent.once('exit', resolve));
  t.after(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM'); await exited; });
  await eventually(() => events(f, 'ready').length === 1);
  write(f.manifest, { name: 'dsh-claudia', version: '0.4.0' });
  write(join(f.home, 'mock.json'), { versions: { '0.4.0': { noReady: true } } });
  manualRequest(f);
  await eventually(() => events(f, 'start').length === 2);
  assert.equal(read(f.request).phase, 'restarting');
  parent.kill('SIGKILL'); await exited;
  await eventually(() => events(f, 'term').length === 2);
  const again = await supervisor(t, f, { background: true });
  await assert.rejects(again.promise, /上次手动重启/);
  assert.equal(events(f, 'start').length, 2); assert.equal(installedPackage(f.home).manifest.version, '0.4.0');
  assert.equal(existsSync(f.result), false); unchanged(f);
});

test('父退出守护：SIGTERM 清理自有心跳，SIGKILL 后 child 自行退出', async t => {
  for (const signal of ['SIGTERM', 'SIGKILL']) await t.test(signal, async t => {
    const f = fixture(t), pair = await ports(), dshBin = join(f.dir, 'mock-dsh.mjs'); write(dshBin, MOCK_HOST); chmodSync(dshBin, 0o700);
    const parent = spawn(process.execPath, [cli, 'start', '--home', f.home, '--dsh-bin', dshBin, '--port', String(pair.hostPort), '--plugin-port', String(pair.pluginPort), '--no-open'], { stdio: 'ignore', env: { ...process.env, HOME: f.dir, DSH_HOME: f.home } });
    const exited = new Promise(resolve => parent.once('exit', resolve));
    t.after(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM'); await exited; });
    await eventually(() => events(f, 'ready').length === 1);
    assert.equal(read(f.heartbeat).pid, parent.pid);
    parent.kill(signal); await exited;
    await eventually(() => events(f, 'term').length === 1);
    if (signal === 'SIGTERM') { assert.equal(existsSync(f.heartbeat), false); assert.equal(existsSync(f.lock), false); }
    else {
      const record = read(f.heartbeat);
      assert.throws(() => process.kill(record.pid, 0), error => error.code === 'ESRCH');
      assert.equal(new RestartControl(f.options).status().supported, false);
    }
    unchanged(f);
  });
});
