import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { BackgroundService, createInstaller, homeHash, installedPackage, pruneUpdates, resolveDsh, resolveExecutable, rollbackInstall, satisfies, toolEnvironment, validateArchive } from '../lifecycle.mjs';
import { CHILD_BOOT, makeHostArgs, parseArgs, runSupervisor } from '../bin/claudia.mjs';

const exec = promisify(execFile), root = dirname(dirname(fileURLToPath(import.meta.url)));
const lifecycle = join(root, 'lifecycle.mjs'), cli = join(root, 'bin', 'claudia.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const template = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = (extra = {}) => ({ ...template, version: '0.3.0', peerDependencies: {}, ...extra });
const required = ['index.mjs', 'native-runtime.mjs', 'server.mjs', 'store.mjs', 'records.mjs', 'activity.mjs', 'maintenance.mjs', 'lifecycle.mjs', 'bin/claudia.mjs', 'public/index.html', 'public/app.js', 'public/style.css', 'native/activity.swift'];
function write(path, data) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); }
function tar(entries, ending = true) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || ''), header = Buffer.alloc(512);
    const put = (text, offset, size) => header.write(text, offset, size, 'utf8');
    put(entry.name, 0, 100); put(`${(entry.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 8);
    put('0000000\0', 108, 8); put('0000000\0', 116, 8); put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    put('00000000000\0', 136, 12); header.fill(32, 148, 156); put(entry.type || '0', 156, 1);
    if (entry.link) put(entry.link, 157, 100);
    put('ustar\0', 257, 6); put('00', 263, 2); if (entry.prefix) put(entry.prefix, 345, 155);
    const sum = header.reduce((a, b) => a + b, 0); put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  if (ending) chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
function packageEntries(pkg = manifest()) {
  return [{ name: 'package/', type: '5' }, { name: 'package/package.json', data: JSON.stringify(pkg) }, ...[...required, 'cordis.patch.yml'].map(file => ({ name: `package/${file}`, data: file === 'index.mjs' ? 'export const version="0.3.0";\n' : 'TEST_PACKAGE_FILE\n' }))];
}
function archive(pkg = manifest(), extra = []) {
  return tar([...packageEntries(pkg), ...extra]);
}
const FAKE_HOST = `#!/usr/bin/env node
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,renameSync,symlinkSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export async function runCli(){
const home=process.env.DSH_HOME,args=process.argv.slice(2);
if(args[0]==='--version'){process.stdout.write('0.1.5-rc.1\\n');return;}
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const event=data=>appendFileSync(join(home,'events.jsonl'),JSON.stringify(data)+'\\n');
if(args[0]==='plugin'){
  event({type:'install',args,node:process.execPath});
  const p=spawnSync('pnpm',['--record'],{env:process.env,encoding:'utf8'});if(p.status!==0)process.exit(8);
  const profile=join(home,'profiles',args[2]);
  const {validateArchive}=await import(pathToFileURL(${JSON.stringify(lifecycle)}));
  const bytes=readFileSync(args[4]),pkg=validateArchive(bytes,'0.3.0');
  const dest=join(profile,'node_modules','.pnpm','dsh-claudia@0.3.0','node_modules','dsh-claudia');
  mkdirSync(dest,{recursive:true});
  for(const [name,data] of pkg.files){mkdirSync(dirname(join(dest,name)),{recursive:true});writeFileSync(join(dest,name),data);}
  const slot=join(profile,'node_modules','dsh-claudia');renameSync(slot,join(profile,'node_modules','old-claudia-fixture-'+process.pid));symlinkSync(relative(dirname(slot),dest),slot);
  writeFileSync(join(profile,'package.json'),JSON.stringify({dependencies:{'dsh-claudia':'file:'+args[4]}}));
  writeFileSync(join(profile,'pnpm-lock.yaml'),'new lock');writeFileSync(join(profile,'cordis.patch.yml'),'new patch');
  writeFileSync(join(profile,'cordis.yaml'),'new optional config');
  if(existsSync(join(home,'break-rollback'))){renameSync(join(profile,'cordis.yaml'),join(home,'new-config'));symlinkSync(join(home,'new-config'),join(profile,'cordis.yaml'));process.exit(19);}
  if(existsSync(join(home,'fail-install')))process.exit(19);
  if(existsSync(join(home,'wrong-install')))writeFileSync(join(dest,'index.mjs'),'wrong');
  process.exit(0);
}
const patches=read(args[args.indexOf('--patch')+1]),overlay=patches.find(p=>p.id==='dsh-claudia').config,webserver=patches.find(p=>p.id==='webserver')?.config;
const pkg=read(join(home,'profiles',overlay.profile,'node_modules','dsh-claudia','package.json'));
const allSettings=existsSync(join(home,'host-test.json'))?read(join(home,'host-test.json')):{};
const settings={...allSettings,...allSettings.versions?.[pkg.version]};
event({type:'start',pid:process.pid,args,overlay,webserver,node:process.execPath,version:pkg.version});
if(settings.crash)process.exit(23);
let ready=false,draining=false,healthCount=0;
const present=name=>existsSync(join(home,name));
const server=createServer(async(req,res)=>{
  const reply=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  const busy=present('busy')||present('foreign-busy');
  if(req.url==='/api/bootstrap'){event({type:'bootstrap',pid:process.pid});return reply(200,{csrfToken:'test-csrf-'+process.pid});}
  if(req.url==='/api/prepare-restart'){
    for await(const chunk of req){}
    event({type:'prepare',pid:process.pid,healthCount,token:req.headers['x-claudia-token'],method:req.method,draining});
    if(req.method!=='POST'||req.headers['x-claudia-token']!=='test-csrf-'+process.pid)return reply(403,{});
    if(present('missing-prepare'))return reply(404,{});
    if(present('reject-prepare'))return reply(403,{});
    if(present('prepare-race')||present('foreign-idle')||present('foreign-busy')||present('busy'))return reply(409,{});
    if(present('no-draining'))return reply(200,{ok:true,draining:false});
    draining=true;event({type:'draining',pid:process.pid});return reply(200,{ok:true,draining});
  }
  if(req.url==='/api/chat')return reply(draining?503:200,{draining});
  if(req.url!=='/api/health')return reply(404,{});
  healthCount++;
  const health={ok:true,plugin:'dsh-claudia',version:settings.healthVersion||pkg.version,pid:process.pid,home,profile:overlay.profile,ready,draining};
  if(!present('missing-busy'))health.busy=busy;
  reply(200,health);
});
const host=createServer((req,res)=>res.end('TEST_HOST'));
host.listen(webserver.port,webserver.host);
server.listen(overlay.port,'127.0.0.1',()=>{
  if(!settings.noReady)setTimeout(()=>{ready=true;event({type:'ready',pid:process.pid});process.stderr.write('Claudia plugin ready: http://127.0.0.1:'+overlay.port+'\\n');},settings.readyDelay??30);
});
process.on('SIGTERM',()=>{event({type:'term',pid:process.pid,draining});server.closeAllConnections();host.closeAllConnections();host.close();server.close(()=>process.exit(0));});
}
if(import.meta.main)await runCli();
`;
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'claudia-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), dataDir = join(home, 'claudia'), profile = join(home, 'profiles', 'web');
  const plugin = join(profile, 'node_modules', 'dsh-claudia');
  write(join(plugin, 'package.json'), manifest({ version: '0.2.1' })); write(join(plugin, 'index.mjs'), 'OLD_PLUGIN');
  write(join(plugin, 'bin', 'claudia.mjs'), '#!/usr/bin/env node\n');
  write(join(profile, 'package.json'), { name: 'test-profile', dependencies: { 'dsh-claudia': '0.2.1', 'unrelated-plugin': '1.0.0' } });
  write(join(profile, 'pnpm-lock.yaml'), 'old lock'); write(join(profile, 'cordis.patch.yml'), 'old patch');
  write(join(profile, 'node_modules', 'unrelated-plugin', 'keep.txt'), 'OTHER_PLUGIN_UNCHANGED');
  write(join(dataDir, 'journal.md'), 'USER_DATA_UNCHANGED'); mkdirSync(join(dataDir, '.updates'));
  write(join(home, 'settings.yaml'), 'DO_NOT_COPY_MODEL_SETTINGS');
  symlinkSync(join(dir, 'NEVER_READ_CREDENTIALS'), join(home, '.credentials.yaml'));
  const dshBin = join(dir, 'fake-dsh.mjs'); write(dshBin, FAKE_HOST); chmodSync(dshBin, 0o700);
  const pnpmPath = join(dir, "tool 'with spaces", 'pnpm-test.cjs');
  write(pnpmPath, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(require('node:path').join(process.env.DSH_HOME,'pnpm-called.json'),JSON.stringify({file:__filename,args:process.argv.slice(2)}));\n`); chmodSync(pnpmPath, 0o700);
  const options = { home, dataDir, dshBin, nodeBin: process.execPath, profile: 'web', pnpmPath };
  const bytes = archive(), path = join(dataDir, '.updates', 'download.tgz'); write(path, bytes);
  return { dir, home, dataDir, profile, plugin, dshBin, pnpmPath, options, update: { path, version: '0.3.0', sha256: digest(bytes) } };
}
function events(home) {
  if (!existsSync(join(home, 'events.jsonl'))) return [];
  return readFileSync(join(home, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
async function eventually(check, message = '等待条件超时', timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(message);
}
async function ports() {
  const a = createServer(), b = createServer();
  await new Promise(resolve => a.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => b.listen(0, '127.0.0.1', resolve));
  const pair = { hostPort: a.address().port, pluginPort: b.address().port };
  await Promise.all([new Promise(resolve => a.close(resolve)), new Promise(resolve => b.close(resolve))]); return pair;
}
function supervisor(t, f, extra = {}, hooks = {}) {
  const controller = new AbortController(), errors = [], opened = [];
  const promise = runSupervisor({ ...f.options, ...extra }, { signal: controller.signal, pollMs: 30, readyTimeout: 1500, shutdownTimeout: 1000, openURL: url => opened.push(url), log() {}, ...hooks });
  promise.catch(error => errors.push(error));
  t.after(async () => { controller.abort(); await promise.catch(() => {}); });
  return { promise, opened, errors, stop: async () => { controller.abort(); await promise; } };
}

test('构造和 import 默认不安装、不创建运行目录、不启动后台', async t => {
  const f = fixture(t); const absent = join(f.dir, 'not-created');
  const installer = createInstaller({ ...f.options, dataDir: absent }); assert.equal(typeof installer, 'function');
  let called = 0;
  const service = new BackgroundService({ ...f.options, dataDir: absent }, { userHome: join(f.dir, 'user'), platform: 'darwin', query: () => { called++; return { status: 0 }; }, run: async () => { called++; } });
  assert.equal(called, 0); assert.equal(existsSync(absent), false); assert.equal(existsSync(service.plist), false);
  const result = await exec(process.execPath, [cli], { env: { ...process.env, DSH_HOME: f.home } });
  assert.match(result.stdout, /用法/); assert.equal(events(f.home).length, 0);
});

test('SemVer 验证 Node 范围、peer 预发布、通配及拒绝未知语法', () => {
  assert.equal(satisfies('22.22.2', '^22.19.0 || >=24.0.0'), true);
  assert.equal(satisfies('23.0.0', '^22.19.0 || >=24.0.0'), false);
  assert.equal(satisfies('0.1.5-rc.2', '~0.1.5-rc.1'), true);
  assert.equal(satisfies('0.1.6-rc.1', '~0.1.5-rc.1'), false);
  assert.equal(satisfies('0.2.0', '~0.1.5-rc.1'), false);
  assert.equal(satisfies('1.2.4', '^1.2.3'), true); assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('22.22.2', '22.x'), true); assert.equal(satisfies('0.3.0', '0.2.0 - 0.4.0'), true);
  assert.throws(() => satisfies('1.0.0', 'workspace:*'));
});

test('tgz 严格校验恶意路径、链接、特殊条目、重复、截断和 gzip 炸弹', () => {
  assert.equal(validateArchive(archive(), '0.3.0').manifest.name, 'dsh-claudia');
  for (const name of ['/tmp/escape', '../escape', 'package/../escape', 'package/a/../../escape', 'package//escape', 'package/./escape', 'other/file', 'package\\escape', 'C:/escape']) {
    assert.throws(() => validateArchive(archive(manifest(), [{ name, data: 'x' }]), '0.3.0'), undefined, name);
  }
  for (const type of ['1', '2', '3', '4', '6', '7', 'x', 'g', 'L', 'K', 'S']) {
    assert.throws(() => validateArchive(archive(manifest(), [{ name: 'package/evil', type, link: '/tmp/out' }]), '0.3.0'));
  }
  assert.throws(() => validateArchive(archive(manifest(), [{ name: 'package/package.json', data: '{}' }]), '0.3.0'), /重复/);
  assert.throws(() => validateArchive(archive(manifest(), [{ name: 'package/PACKAGE.JSON', data: '{}' }]), '0.3.0'), /重复/);
  assert.throws(() => validateArchive(archive(manifest(), [{ name: 'package/index.mjs/evil', data: 'x' }]), '0.3.0'), /父目录/);
  assert.throws(() => validateArchive(archive(manifest(), [{ name: 'package/suid', data: 'x', mode: 0o4755 }]), '0.3.0'), /权限/);
  assert.throws(() => validateArchive(tar([{ name: 'package/package.json', data: '{}' }], false), '0.3.0'), /结束/);
  assert.throws(() => validateArchive(Buffer.from('not-gzip'), '0.3.0'), /gzip/);
  assert.throws(() => validateArchive(gzipSync(Buffer.alloc(64 * 1024 * 1024 + 512)), '0.3.0'), /64 MiB/);
});

test('拒绝包名版本不符、安装脚本、普通及可选依赖', () => {
  for (const changes of [{ name: 'other' }, { version: '0.4.0' }, { dependencies: { evil: '*' } }, { optionalDependencies: { evil: '*' } }, { bundledDependencies: ['evil'] }, { engines: {} }, { peerDependencies: undefined }]) {
    assert.throws(() => validateArchive(archive(manifest(changes)), '0.3.0'));
  }
  for (const key of ['preinstall', 'install', 'postinstall', 'prepare']) assert.throws(() => validateArchive(archive(manifest({ scripts: { [key]: '' } })), '0.3.0'), /scripts/);
});

test('安装成功：官方 argv、精确 pnpm、完整无密钥备份和 pending restart', async t => {
  const f = fixture(t), result = await createInstaller(f.options)(f.update);
  assert.equal(result.installed, true); assert.equal(result.pendingRestart, true); assert.equal(result.version, '0.3.0');
  assert.ok(result.backupDir.startsWith(join(f.dataDir, '.updates', 'backups', '0.3.0-')));
  const invocation = events(f.home).find(e => e.type === 'install');
  assert.deepEqual(invocation.args.slice(0, 4), ['plugin', '--profile', 'web', 'add']);
  assert.ok(invocation.args[4].startsWith(join(f.dataDir, '.updates'))); assert.ok(invocation.args.includes('--offline')); assert.ok(invocation.args.includes('--ignore-scripts'));
  assert.equal(invocation.node, realpathSync(process.execPath));
  assert.equal(JSON.parse(readFileSync(join(f.home, 'pnpm-called.json'))).file, f.pnpmPath);
  assert.equal(readFileSync(join(result.backupDir, 'plugin', 'index.mjs'), 'utf8'), 'OLD_PLUGIN');
  assert.equal(readFileSync(join(result.backupDir, 'pnpm-lock.yaml'), 'utf8'), 'old lock');
  assert.equal(existsSync(join(result.backupDir, '.credentials.yaml')), false); assert.equal(existsSync(join(result.backupDir, 'settings.yaml')), false);
  assert.equal(readFileSync(join(f.dataDir, 'journal.md'), 'utf8'), 'USER_DATA_UNCHANGED');
  assert.equal(readFileSync(join(f.profile, 'node_modules', 'unrelated-plugin', 'keep.txt'), 'utf8'), 'OTHER_PLUGIN_UNCHANGED');
  const restart = JSON.parse(readFileSync(join(f.dataDir, '.runtime', 'restart-request.json')));
  assert.equal(restart.version, '0.3.0'); assert.equal(restart.verifiedVersion, '0.3.0'); assert.equal(restart.oldVersion, '0.2.1'); assert.equal(restart.backupDir, result.backupDir);
  assert.equal(restart.phase, 'pending'); assert.equal(result.applied, false); assert.equal(result.state, 'pending-restart');
  assert.equal(existsSync(join(f.dataDir, '.runtime', 'restart-result.json')), false);
  assert.equal(installedPackage(f.home).manifest.version, '0.3.0'); assert.equal(events(f.home).some(e => e.type === 'start'), false);
  assert.equal(existsSync(join(f.dataDir, '.updates', 'install.lock')), false);
  // 安装成功后不能把本次的包删掉：profile 的 package.json / lock 会用 file: 指向它，
  // 删了之后后续任何 pnpm add 都会 ENOENT。只保留备份供回滚，旧包交给 pruneUpdates 按引用清理。
  assert.equal(existsSync(f.update.path), true);
  assert.equal(existsSync(join(result.backupDir, 'complete.json')), true);
});

test('清理 .updates 残留：只删没人引用的已校验包、过期下载和超出保留数的备份', async t => {
  const f = fixture(t), updates = join(f.dataDir, '.updates');
  const opts = () => ({ dataDir: f.dataDir, home: f.home, profile: 'web' });
  const verified = join(updates, `verified-0.3.0-${randomUUID()}.tgz`); write(verified, 'x');
  const fresh = join(updates, `dsh-claudia-0.3.0-${randomUUID()}.tgz`); write(fresh, 'x');
  const stale = join(updates, `dsh-claudia-0.2.9-${randomUUID()}.tgz`); write(stale, 'x');
  const past = new Date(Date.now() - 8 * 86400000); utimesSync(stale, past, past);
  // .updates 是所有插件共用的暂存目录：profile 用 file: 指向的包（可能是别的插件装进来的）
  // 绝不能删，删掉之后本 profile 里任何后续 pnpm add 都会 ENOENT 失败。
  const pinnedName = `verified-other-plugin-1.0.0-${randomUUID()}.tgz`, pinned = join(updates, pinnedName);
  write(pinned, 'x');
  const pinnedStaleName = `dsh-claudia-0.2.5-${randomUUID()}.tgz`, pinnedStale = join(updates, pinnedStaleName);
  write(pinnedStale, 'x');
  const ancient = new Date(Date.now() - 60 * 86400000); utimesSync(pinnedStale, ancient, ancient);
  write(join(f.profile, 'package.json'), { name: 'test-profile', dependencies: { 'other-plugin': `file:${pinned}`, 'dsh-claudia': `file:${pinnedStale}` } });
  write(join(f.profile, 'pnpm-lock.yaml'), `dependencies:\n  other-plugin:\n    specifier: file:${pinned}\n`);
  const keep = join(updates, 'not-a-package.txt'); write(keep, 'USER_DATA_UNCHANGED');
  const outside = join(f.dir, 'outside-target'); write(outside, 'USER_DATA_UNCHANGED');
  const linked = join(updates, `verified-0.2.8-${randomUUID()}.tgz`); symlinkSync(outside, linked);
  const backups = join(updates, 'backups'), names = []; mkdirSync(backups);
  for (let i = 0; i < 5; i++) {
    const name = `0.2.${i}-${randomUUID()}`, dir = join(backups, name); mkdirSync(dir);
    const when = new Date(Date.now() - i * 1000); utimesSync(dir, when, when); names.push(name);
  }
  mkdirSync(join(backups, 'not-a-backup'));
  const result = pruneUpdates(opts());
  assert.equal(result.skipped, false); assert.equal(result.keptBackups, 3);
  assert.equal(existsSync(verified), false); assert.equal(existsSync(stale), false);
  assert.equal(existsSync(pinned), true, '被 package.json 引用：必须留下');
  assert.equal(existsSync(pinnedStale), true, '过期但被引用：也必须留下');
  assert.equal(existsSync(fresh), true); assert.equal(existsSync(keep), true);
  assert.equal(existsSync(linked), true); assert.equal(readFileSync(outside, 'utf8'), 'USER_DATA_UNCHANGED');
  assert.equal(existsSync(join(backups, 'not-a-backup')), true);
  const left = readdirSync(backups).filter(name => name !== 'not-a-backup').sort();
  assert.deepEqual(left, names.slice(0, 3).sort());
  // 有更新等待重启确认或安装进行中时一律不清理：回滚现场必须完整。
  const request = join(f.dataDir, '.runtime', 'restart-request.json');
  write(request, { version: '0.3.0', verifiedVersion: '0.3.0', oldVersion: '0.2.1', backupDir: join(backups, names[0]), phase: 'pending', id: randomUUID() });
  assert.equal(pruneUpdates(opts()).skipped, true);
  rmSync(request); write(join(updates, 'install.lock'), '{}');
  assert.equal(pruneUpdates(opts()).skipped, true);
  rmSync(join(updates, 'install.lock'));
  assert.equal(pruneUpdates(opts()).removed, 0);
  assert.equal(pruneUpdates({ ...opts(), dataDir: join(f.dir, 'absent') }).removed, 0);
});

test('失败及虚假成功都恢复 profile 和本插件，不删其他插件或用户数据', async t => {
  for (const flag of ['fail-install', 'wrong-install']) {
    await t.test(flag, async t => {
      const f = fixture(t); write(join(f.home, flag), '1');
      const before = readFileSync(join(f.profile, 'package.json'));
      await assert.rejects(createInstaller(f.options)(f.update), error => {
        assert.match(error.message, /已恢复/); assert.equal(error.installationStarted, true); assert.equal(error.rollbackComplete, true); assert.equal(error.installationUncertain, false); return true;
      });
      assert.deepEqual(readFileSync(join(f.profile, 'package.json')), before);
      assert.equal(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8'), 'old lock');
      assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), 'old patch');
      assert.equal(existsSync(join(f.profile, 'cordis.yaml')), false);
      assert.equal(readFileSync(join(f.plugin, 'index.mjs'), 'utf8'), 'OLD_PLUGIN');
      assert.equal(lstatSync(f.plugin).isSymbolicLink(), false);
      assert.equal(readFileSync(join(f.profile, 'node_modules', 'unrelated-plugin', 'keep.txt'), 'utf8'), 'OTHER_PLUGIN_UNCHANGED');
      assert.equal(readFileSync(join(f.dataDir, 'journal.md'), 'utf8'), 'USER_DATA_UNCHANGED');
      assert.equal(existsSync(join(f.dataDir, '.runtime', 'restart-request.json')), false);
      const backups = readdirSync(join(f.dataDir, '.updates', 'backups'));
      assert.equal(backups.length, 1); assert.ok(existsSync(join(f.dataDir, '.updates', 'backups', backups[0], 'complete.json')));
    });
  }
});

test('安装预检查拒绝越界、sha 不符、symlink、缺失 pnpm、不兼容 engines 和 peer', async t => {
  const f = fixture(t);
  const install = createInstaller(f.options);
  const outside = join(f.dir, 'outside.tgz'); write(outside, archive());
  await assert.rejects(install({ ...f.update, path: outside }), /同一 dataDir/);
  await assert.rejects(install({ ...f.update, sha256: '0'.repeat(64) }), /sha256/);
  const linked = join(f.dataDir, '.updates', 'linked.tgz'); symlinkSync(f.update.path, linked);
  await assert.rejects(install({ ...f.update, path: linked }), /symlink/);
  await assert.rejects(createInstaller({ ...f.options, pnpmPath: join(f.dir, 'missing') })(f.update), /pnpm/);
  assert.throws(() => resolveExecutable(undefined, 'pnpm', ''), /找不到 pnpm/);
  for (const change of [{ engines: { node: '>=999.0.0' } }, { peerDependencies: { 'new-peer': '^1.0.0' } }]) {
    const bytes = archive(manifest(change)); write(f.update.path, bytes);
    await assert.rejects(install({ ...f.update, sha256: digest(bytes) }), /engines|peer/);
  }
  assert.equal(events(f.home).length, 0); assert.equal(readFileSync(join(f.plugin, 'index.mjs'), 'utf8'), 'OLD_PLUGIN');
});

test('peer 兼容性取自已安装包，不能只相信远端元数据', async t => {
  const f = fixture(t), peer = { '@deepseek-ai/dsh-agent': '~0.1.5-rc.1' };
  write(join(f.plugin, 'package.json'), manifest({ version: '0.2.1', peerDependencies: peer }));
  write(join(f.profile, 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json'), { name: '@deepseek-ai/dsh-agent', version: '0.2.0' });
  let bytes = archive(manifest({ peerDependencies: peer })); write(f.update.path, bytes);
  await assert.rejects(createInstaller(f.options)({ ...f.update, sha256: digest(bytes) }), /peer .*不兼容/);
  write(join(f.profile, 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json'), { name: '@deepseek-ai/dsh-agent', version: '0.1.5-rc.2' });
  assert.equal((await createInstaller(f.options)({ ...f.update, sha256: digest(bytes) })).installed, true);
});

test('备份未完成不得调用安装或恢复；绝不清理另一安装者的锁', async t => {
  const f = fixture(t), lock = join(f.dataDir, '.updates', 'install.lock');
  write(lock, 'OTHER_OWNER');
  await assert.rejects(createInstaller(f.options)(f.update), /EEXIST/);
  assert.equal(readFileSync(lock, 'utf8'), 'OTHER_OWNER');
  rmSync(lock); symlinkSync(join(f.dir, 'outside'), join(f.plugin, 'unsafe-link'));
  await assert.rejects(createInstaller(f.options)(f.update), /symlink/);
  assert.equal(events(f.home).length, 0); assert.equal(existsSync(lock), false);
  assert.equal(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8'), 'old patch');
});

test('拒绝更新目录、运行目录和插件入口的越界 symlink', async t => {
  for (const kind of ['updates', 'runtime', 'plugin']) {
    await t.test(kind, async t => {
      const f = fixture(t), outside = join(f.dir, 'outside'); mkdirSync(outside);
      if (kind === 'updates') {
        const bytes = archive(); rmSync(join(f.dataDir, '.updates'), { recursive: true }); write(join(outside, 'download.tgz'), bytes);
        symlinkSync(outside, join(f.dataDir, '.updates'));
      } else if (kind === 'runtime') symlinkSync(outside, join(f.dataDir, '.runtime'));
      else { rmSync(f.plugin, { recursive: true }); write(join(outside, 'package.json'), manifest({ version: '0.2.1' })); symlinkSync(outside, f.plugin); }
      await assert.rejects(createInstaller(f.options)(f.update), /symlink|插件链接/);
      assert.equal(events(f.home).length, 0);
    });
  }
});

test('CLI argv 绝对路径、默认值、profile、安全的插件覆盖及显式 pnpm shim', async t => {
  const f = fixture(t);
  const defaults = parseArgs(['start'], { DSH_HOME: f.home }); assert.equal(defaults.pluginPort, 4317); assert.equal(defaults.hostPort, 3088); assert.equal(defaults.background, false);
  const parsed = parseArgs(['start', '--dsh-bin', f.dshBin, '--home', f.home, '--profile', 'web', '--port', '3088', '--plugin-port', '4318', '--pnpm-path', f.pnpmPath, '--no-open']);
  assert.equal(parsed.open, false); assert.equal(parsed.pluginPort, 4318);
  for (const args of [['start', '--home', 'relative'], ['start', '--profile', '../bad'], ['start', '--profile', 'desktop'], ['start', '--port', '1;false'], ['start', '--bad'], ['start', '--port', '4317'], ['start', '--home', f.home, '--home', f.home]]) assert.throws(() => parseArgs(args));
  assert.deepEqual(makeHostArgs(parsed, '/absolute/patch.json'), ['web', '--patch', '/absolute/patch.json', '--no-open', '--port', '3088']);
  const tools = toolEnvironment({ ...f.options, nodeBin: realpathSync(process.execPath) });
  await exec('pnpm', ['--record'], { env: tools.env });
  assert.equal(JSON.parse(readFileSync(join(f.home, 'pnpm-called.json'))).file, f.pnpmPath);
});

test('supervisor 等待 ready 后只打开插件一次；覆盖配置不含密钥', async t => {
  const f = fixture(t), pair = await ports(); write(join(f.home, 'host-test.json'), { readyDelay: 250 });
  const s = supervisor(t, f, pair);
  await eventually(() => events(f.home).some(e => e.type === 'start'));
  assert.equal(s.opened.length, 0);
  await eventually(() => s.opened.length === 1);
  assert.deepEqual(s.opened, [`http://127.0.0.1:${pair.pluginPort}`]);
  const start = events(f.home).find(e => e.type === 'start');
  assert.ok(start.args.includes('--no-open')); assert.equal(start.args.at(-1), String(pair.hostPort)); assert.equal(start.node, realpathSync(process.execPath));
  assert.equal(start.overlay.port, pair.pluginPort); assert.equal(start.overlay.openBrowser, false); assert.equal(start.overlay.pnpmPath, f.pnpmPath);
  assert.deepEqual(start.webserver, { host: '127.0.0.1', port: pair.hostPort });
  assert.equal(await (await fetch(`http://127.0.0.1:${pair.hostPort}`)).text(), 'TEST_HOST');
  assert.equal(/apiKey|credential|secret|DO_NOT_COPY/.test(JSON.stringify(start.overlay)), false);
  await s.stop(); assert.equal(events(f.home).filter(e => e.type === 'term').length, 1);
  assert.equal(existsSync(join(f.home, '.claudia-supervisor.lock')), false);
});

test('no-open 禁止打开；只有 health 没有 ready 日志不能假装成功', async t => {
  const f = fixture(t), pair = await ports(); write(join(f.home, 'host-test.json'), { noReady: true });
  const s = supervisor(t, f, { ...pair, open: false }, { readyTimeout: 250 });
  await assert.rejects(s.promise, /ready/); assert.equal(s.opened.length, 0); assert.equal(events(f.home).filter(e => e.type === 'term').length, 1);
});

test('已有同 home health 只打开已有实例；身份不明或不同 home 时不启动', async t => {
  const f = fixture(t), pair = await ports();
  let home = f.home;
  const server = createServer((req, res) => res.end(JSON.stringify({ ok: true, plugin: 'dsh-claudia', version: '0.2.1', pid: process.pid, home, profile: 'web', busy: false })));
  await new Promise(resolve => server.listen(pair.pluginPort, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const s = supervisor(t, f, pair); const result = await s.promise;
  assert.equal(result.existing, true); assert.equal(s.opened.length, 1); assert.equal(events(f.home).length, 0);
  home = join(f.dir, 'different-home');
  await assert.rejects(supervisor(t, f, pair).promise, /端口被占用/); assert.equal(events(f.home).length, 0);
});

test('后台 supervisor 留驻等待前台退出，退出后才接管', async t => {
  const f = fixture(t), pair = await ports();
  const server = createServer((req, res) => res.end(JSON.stringify({ ok: true, plugin: 'dsh-claudia', version: '0.2.1', pid: process.pid, home: f.home, profile: 'web', busy: false })));
  await new Promise(resolve => server.listen(pair.pluginPort, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const s = supervisor(t, f, { ...pair, background: true, open: false }); let finished = false; s.promise.finally(() => { finished = true; }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(finished, false); assert.equal(events(f.home).length, 0);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await eventually(() => events(f.home).some(e => e.type === 'ready'));
  assert.equal(events(f.home).filter(e => e.type === 'start').length, 1); assert.equal(s.opened.length, 0); await s.stop();
});

test('更新只重启自有空闲 child；缺失 busy 时保守等待；重载已安装版本', async t => {
  const f = fixture(t), pair = await ports(); write(join(f.home, 'busy'), '1');
  const s = supervisor(t, f, pair);
  await eventually(() => s.opened.length === 1);
  await createInstaller(f.options)(f.update);
  const request = join(f.dataDir, '.runtime', 'restart-request.json');
  await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(events(f.home).filter(e => e.type === 'start').length, 1);
  write(join(f.home, 'missing-busy'), '1'); rmSync(join(f.home, 'busy'));
  await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(events(f.home).filter(e => e.type === 'start').length, 1);
  rmSync(join(f.home, 'missing-busy'));
  await eventually(() => events(f.home).filter(e => e.type === 'ready').length === 2);
  await eventually(() => !existsSync(request));
  const starts = events(f.home).filter(e => e.type === 'start');
  assert.deepEqual(starts.map(e => e.version), ['0.2.1', '0.3.0']); assert.notEqual(starts[0].pid, starts[1].pid);
  assert.equal(s.opened.length, 1); assert.equal(events(f.home).filter(e => e.type === 'term').length, 1);
  await s.stop();
});

test('CLI SIGTERM 转发给自有宿主并清理；父被强制退出也不遗留子进程', async t => {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    await t.test(signal, async t => {
      const f = fixture(t), pair = await ports();
      const parent = spawn(process.execPath, [cli, 'start', '--home', f.home, '--dsh-bin', f.dshBin, '--port', String(pair.hostPort), '--plugin-port', String(pair.pluginPort), '--no-open'], { stdio: 'ignore' });
      const exited = new Promise(resolve => parent.once('exit', resolve));
      t.after(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM'); await exited; });
      await eventually(() => events(f.home).some(e => e.type === 'ready'));
      parent.kill(signal); await exited;
      await eventually(() => events(f.home).some(e => e.type === 'term'), '父退出后子宿主必须自行清理');
    });
  }
});

test('完整归档契约：拒绝仅 manifest 和缺失关键文件，允许新版本增加文件', () => {
  assert.throws(() => validateArchive(tar([{ name: 'package/package.json', data: JSON.stringify(manifest()) }]), '0.3.0'), /入口|缺少/);
  for (const file of [...required, 'cordis.patch.yml']) {
    assert.throws(() => validateArchive(tar(packageEntries().filter(entry => entry.name !== `package/${file}`)), '0.3.0'), /入口|关键文件/, file);
  }
  for (const change of [
    { main: undefined }, { main: './server.mjs' }, { exports: {} }, { exports: { '.': './server.mjs' } },
    { bin: undefined }, { bin: { 'dsh-claudia': './index.mjs' } }, { dsh: {} },
    ...['../index.mjs', '/index.mjs', './a/../index.mjs', './missing.yml', 'C:/index.mjs', 'a\\\\b', './public/'].map(patch => ({ dsh: { bundle: { patch } } })),
  ]) assert.throws(() => validateArchive(archive(manifest(change)), '0.3.0'));
  const next = manifest({ files: [], exports: './index.mjs', dsh: { bundle: { patch: './extra/patch.yml' } } });
  const accepted = validateArchive(archive(next, [{ name: 'package/extra/patch.yml', data: '[]' }, { name: 'package/future.mjs', data: 'export {}' }]), '0.3.0');
  assert.ok(accepted.files.has('future.mjs'));
  // 用真实发布模板及源码打包，而不是只验证合成清单；不检查 manifest.files。
  const entries = ['package.json', ...required, 'cordis.patch.yml'].map(file => ({ name: `package/${file}`, data: readFileSync(join(root, file)) }));
  assert.equal(validateArchive(tar(entries), template.version).manifest.version, template.version);
});

test('真实模板 Node/peer 范围覆盖稳定版与 prerelease 边界', () => {
  assert.equal(template.engines.node, '^22.19.0 || >=24.0.0');
  for (const version of ['22.19.0', '22.22.2', '24.0.0', '25.1.0']) assert.equal(satisfies(version, template.engines.node), true, version);
  for (const version of ['22.18.0', '23.0.0', '24.0.0-rc.1', '25.1.0-beta.1']) assert.equal(satisfies(version, template.engines.node), false, version);
  for (const range of Object.values(template.peerDependencies)) {
    assert.equal(range, '~0.1.5-rc.1');
    for (const version of ['0.1.5-rc.1', '0.1.5-rc.2', '0.1.5', '0.1.6']) assert.equal(satisfies(version, range), true, version);
    for (const version of ['0.1.5-rc.0', '0.1.6-rc.1', '0.2.0', '0.2.0-rc.1']) assert.equal(satisfies(version, range), false, version);
  }
});

test('安装前失败及成功回滚都可重试，不确定恢复明确阻止重试', async t => {
  const f = fixture(t), install = createInstaller(f.options);
  await assert.rejects(install({ ...f.update, sha256: '0'.repeat(64) }), error => {
    assert.equal(error.installationStarted, false); assert.equal(error.installationUncertain, false); assert.equal(error.rollbackComplete, false); return true;
  });
  write(join(f.home, 'fail-install'), '1');
  await assert.rejects(install(f.update), error => error.installationStarted && error.rollbackComplete && !error.installationUncertain);
  rmSync(join(f.home, 'fail-install'));
  assert.equal((await install(f.update)).pendingRestart, true);
  const requestPath = join(f.dataDir, '.runtime', 'restart-request.json'), before = readFileSync(requestPath);
  await assert.rejects(install(f.update), error => error.installationStarted === false && error.installationUncertain === true);
  assert.deepEqual(readFileSync(requestPath), before);
  const broken = fixture(t); write(join(broken.home, 'break-rollback'), '1');
  await assert.rejects(createInstaller(broken.options)(broken.update), error => {
    assert.equal(error.installationStarted, true); assert.equal(error.installationUncertain, true); assert.equal(error.rollbackComplete, false); assert.ok(existsSync(error.backupDir)); return true;
  });
});

test('rollbackInstall 严格限制同一 backups、home/profile/版本、拒绝链接并只回滚一次', async t => {
  const f = fixture(t), result = await createInstaller(f.options)(f.update);
  const options = { ...f.options, backupDir: result.backupDir, oldVersion: '0.2.1' };
  for (const backupDir of [f.dir, join(f.dataDir, '.updates', 'backups-other', 'x'), join(result.backupDir, 'nested')]) assert.throws(() => rollbackInstall({ ...options, backupDir }), /backupDir/);
  assert.throws(() => rollbackInstall({ ...options, home: join(f.dir, 'another-home') }), /不匹配/);
  assert.throws(() => rollbackInstall({ ...options, profile: 'other' }), /不匹配/);
  assert.throws(() => rollbackInstall({ ...options, oldVersion: '0.1.0' }), /不匹配/);
  const link = join(f.dataDir, '.updates', 'backups', 'linked'); symlinkSync(result.backupDir, link);
  assert.throws(() => rollbackInstall({ ...options, backupDir: link }), /symlink/);
  write(join(f.dataDir, 'journal.md'), 'NEW_BUSINESS_DATA_AFTER_INSTALL');
  assert.equal(rollbackInstall(options).rollbackComplete, true);
  assert.equal(installedPackage(f.home).manifest.version, '0.2.1');
  assert.equal(readFileSync(join(f.dataDir, 'journal.md'), 'utf8'), 'NEW_BUSINESS_DATA_AFTER_INSTALL');
  assert.throws(() => rollbackInstall(options), /EEXIST/);
  assert.equal(readFileSync(join(f.plugin, 'index.mjs'), 'utf8'), 'OLD_PLUGIN');
});

test('mock 与真实 CLI 同样使用 import.meta.main 门控，包装器显式运行一次', async t => {
  const f = fixture(t);
  const bare = await exec(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(f.dshBin).href)})`], { env: { ...process.env, DSH_HOME: f.home } });
  assert.equal(bare.stdout, ''); assert.equal(events(f.home).length, 0);
  const wrapped = await exec(process.execPath, ['--input-type=module', '--eval', CHILD_BOOT, f.dshBin, '--version'], { env: { ...process.env, DSH_HOME: f.home } });
  assert.equal(wrapped.stdout.trim(), '0.1.5-rc.1');
});

test('真实 CLI 0.1.5-rc.1：仅 import 不启动，实际包装器可运行 --version', async t => {
  if (!process.env.TEST_DSH_BIN) return t.skip('需显式提供 TEST_DSH_BIN，绝不默认使用用户 home');
  const f = fixture(t), dsh = resolveDsh(process.env.TEST_DSH_BIN);
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(dsh)), 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@deepseek-ai/dsh'); assert.equal(pkg.version, '0.1.5-rc.1');
  const source = readFileSync(dsh, 'utf8'); assert.match(source, /if\s*\(import\.meta\.main\)\s*await runCli\(\)/); assert.match(source, /export\s*\{\s*runCli\s*\}/);
  const env = { ...process.env, DSH_HOME: f.home, HOME: f.dir, DSH_TELEMETRY_DISABLED: '1' };
  const imported = await exec(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(dsh).href)})`], { cwd: f.home, env, timeout: 10000 });
  assert.equal(imported.stdout, '');
  const result = await exec(process.execPath, ['--input-type=module', '--eval', CHILD_BOOT, dsh, '--version'], { cwd: f.home, env, timeout: 10000 });
  assert.equal(result.stdout.trim(), pkg.version);
});

test('真实 CLI + web 模板在临时 home 启动，supervisor overlay 覆盖 profile 固定端口', async t => {
  if (!process.env.TEST_DSH_BIN) return t.skip('需显式提供 TEST_DSH_BIN；不安装到用户 home');
  const f = fixture(t), dsh = resolveDsh(process.env.TEST_DSH_BIN), pair = await ports();
  const hostRequire = createRequire(dsh);
  const { PROFILE_TEMPLATES } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')));
  assert.deepEqual(PROFILE_TEMPLATES.web.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  for (const file of ['package.json', ...required, 'cordis.patch.yml']) write(join(f.plugin, file), readFileSync(join(root, file)));
  write(join(f.profile, 'package.json'), { name: 'isolated-real-cli', private: true, dependencies: { 'dsh-claudia': template.version }, dsh: { profile: { ...PROFILE_TEMPLATES.web, bundles: [...PROFILE_TEMPLATES.web.bundles, 'dsh-claudia'] } } });
  write(join(f.profile, 'cordis.patch.yml'), [{ id: 'webserver', config: { port: 1 } }]);
  write(join(f.home, 'settings.yaml'), {});
  rmSync(join(f.home, '.credentials.yaml')); write(join(f.home, '.credentials.yaml'), { version: 1, refs: {} }); chmodSync(join(f.home, '.credentials.yaml'), 0o600);
  const env = { ...process.env, HOME: f.dir, DSH_HOME: f.home, DSH_TELEMETRY_DISABLED: '1', XDG_CONFIG_HOME: join(f.dir, 'config'), XDG_CACHE_HOME: join(f.dir, 'cache'), XDG_DATA_HOME: join(f.dir, 'data') };
  const parent = spawn(process.execPath, [cli, 'start', '--home', f.home, '--dsh-bin', dsh, '--port', String(pair.hostPort), '--plugin-port', String(pair.pluginPort), '--no-open'], { cwd: f.home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; parent.stdout.on('data', bytes => { logs += bytes; }); parent.stderr.on('data', bytes => { logs += bytes; });
  const exited = new Promise(resolve => parent.once('exit', resolve));
  t.after(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM'); await exited; });
  await eventually(() => { assert.equal(parent.exitCode, null, logs); return logs.includes('Claudia plugin ready:'); }, '真实 CLI 未达到 appReady', 45000);
  const health = await (await fetch(`http://127.0.0.1:${pair.pluginPort}/api/health`)).json();
  assert.equal(health.home, f.home); assert.equal(health.version, template.version); assert.equal(health.ok, true);
  assert.notEqual(health.pid, parent.pid);
  const response = await fetch(`http://127.0.0.1:${pair.hostPort}/`);
  // 宿主可能要求自己的认证令牌；401/403/404 同样证明指定端口已监听，不能替它绕过认证。
  assert.ok(response.status < 500); await response.body?.cancel();
  const fallback = createRequire(join(f.plugin, 'package.json'));
  for (const [name, range] of Object.entries(template.peerDependencies)) {
    let dir = dirname(realpathSync(fallback.resolve(name)));
    while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
    const peer = JSON.parse(readFileSync(join(dir, 'package.json')));
    assert.equal(satisfies(peer.version, range), true, `${name}@${peer.version}`);
    t.diagnostic(`真实 peer ${name}@${peer.version}`);
  }
  parent.kill('SIGTERM'); await exited;
  assert.equal(existsSync(join(f.home, '.claudia-supervisor.lock')), false);
  assert.equal(existsSync(join(f.home, 'pnpm-called.json')), false);
});

test('重启握手拒绝其他 agent、idle 竞态、CSRF/接口失败及未 draining；无 pending 不触发', async t => {
  const f = fixture(t), pair = await ports(); write(join(f.home, 'foreign-busy'), '1');
  const s = supervisor(t, f, pair); await eventually(() => s.opened.length === 1);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(events(f.home).some(e => e.type === 'prepare'), false);
  await createInstaller(f.options)(f.update);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(events(f.home).some(e => e.type === 'prepare'), false);
  write(join(f.home, 'foreign-idle'), '1'); rmSync(join(f.home, 'foreign-busy'));
  await eventually(() => events(f.home).some(e => e.type === 'prepare'));
  assert.equal(events(f.home).some(e => e.type === 'term'), false);
  for (const flag of ['prepare-race', 'reject-prepare', 'missing-prepare', 'no-draining']) {
    write(join(f.home, flag), '1');
    if (existsSync(join(f.home, 'foreign-idle'))) rmSync(join(f.home, 'foreign-idle'));
    const count = events(f.home).filter(e => e.type === 'prepare').length;
    await eventually(() => events(f.home).filter(e => e.type === 'prepare').length > count);
    assert.equal(events(f.home).some(e => e.type === 'term'), false, flag);
    write(join(f.home, 'foreign-idle'), '1'); rmSync(join(f.home, flag));
  }
  rmSync(join(f.home, 'foreign-idle'));
  await eventually(() => !existsSync(join(f.dataDir, '.runtime', 'restart-request.json')));
  const log = events(f.home), drain = log.findIndex(e => e.type === 'draining'), term = log.findIndex(e => e.type === 'term');
  assert.ok(drain >= 0 && drain < term); assert.equal(log[term].draining, true);
  for (const event of log.filter(e => e.type === 'prepare')) { assert.equal(event.method, 'POST'); assert.equal(event.token, `test-csrf-${event.pid}`); assert.ok(event.healthCount >= 2); }
  const result = JSON.parse(readFileSync(join(f.dataDir, '.runtime', 'restart-result.json')));
  assert.equal(result.state, 'applied'); assert.equal(result.applied, true); assert.equal(result.runningVersion, '0.3.0');
  await s.stop();
});

test('安装后必须新 child ready 和 health 版本一致才确认；迟到 ready 之前保留请求', async t => {
  const f = fixture(t), pair = await ports();
  write(join(f.home, 'host-test.json'), { versions: { '0.3.0': { readyDelay: 400 } } });
  const s = supervisor(t, f, pair); await eventually(() => s.opened.length === 1);
  await createInstaller(f.options)(f.update);
  await eventually(() => events(f.home).filter(e => e.type === 'start').length === 2);
  assert.equal(existsSync(join(f.dataDir, '.runtime', 'restart-request.json')), true);
  assert.equal(existsSync(join(f.dataDir, '.runtime', 'restart-result.json')), false);
  await eventually(() => !existsSync(join(f.dataDir, '.runtime', 'restart-request.json')));
  assert.equal(JSON.parse(readFileSync(join(f.dataDir, '.runtime', 'restart-result.json'))).state, 'applied');
  await s.stop();
});

test('新版崩溃、45s 门限无 ready 或 health 版本不符均只回滚一次并启动旧版', async t => {
  for (const settings of [{ crash: true }, { noReady: true }, { healthVersion: '0.9.9' }]) {
    await t.test(JSON.stringify(settings), async t => {
      const f = fixture(t), pair = await ports();
      write(join(f.home, 'host-test.json'), { versions: { '0.3.0': settings } });
      // 测试缩短与生产默认 45000ms 相同的门限路径。
      const s = supervisor(t, f, { ...pair, background: true }, { readyTimeout: 1500 });
      await eventually(() => s.opened.length === 1);
      const result = await createInstaller(f.options)(f.update);
      write(join(f.dataDir, 'journal.md'), 'BUSINESS_DATA_DURING_UPGRADE');
      const resultPath = join(f.dataDir, '.runtime', 'restart-result.json');
      await eventually(() => existsSync(resultPath));
      const finished = JSON.parse(readFileSync(resultPath));
      assert.equal(finished.state, 'rolled-back'); assert.equal(finished.applied, false); assert.equal(finished.rollbackComplete, true); assert.equal(finished.rollbackAttempted, true);
      assert.equal(installedPackage(f.home).manifest.version, '0.2.1');
      assert.equal(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8'), 'old lock');
      assert.equal(readFileSync(join(f.dataDir, 'journal.md'), 'utf8'), 'BUSINESS_DATA_DURING_UPGRADE');
      assert.equal(readFileSync(join(f.profile, 'node_modules', 'unrelated-plugin', 'keep.txt'), 'utf8'), 'OTHER_PLUGIN_UNCHANGED');
      assert.ok(existsSync(join(result.backupDir, 'rollback-complete.json')));
      await new Promise(resolve => setTimeout(resolve, 160));
      assert.deepEqual(events(f.home).filter(e => e.type === 'start').map(e => e.version), ['0.2.1', '0.3.0', '0.2.1']);
      assert.equal(s.errors.length, 0); await s.stop();
    });
  }
});

test('新版超时但其他 live agent 尚在时推迟回滚，不绕过 draining', async t => {
  const f = fixture(t), pair = await ports();
  write(join(f.home, 'host-test.json'), { versions: { '0.3.0': { noReady: true } } });
  const s = supervisor(t, f, pair, { readyTimeout: 250 });
  await eventually(() => s.opened.length === 1);
  await createInstaller(f.options)(f.update);
  await eventually(() => events(f.home).filter(e => e.type === 'start').length === 2);
  write(join(f.home, 'foreign-idle'), '1');
  const prepares = events(f.home).filter(e => e.type === 'prepare').length;
  await eventually(() => events(f.home).filter(e => e.type === 'prepare').length > prepares);
  assert.equal(events(f.home).filter(e => e.type === 'term').length, 1);
  assert.equal(installedPackage(f.home).manifest.version, '0.3.0');
  rmSync(join(f.home, 'foreign-idle'));
  await eventually(() => existsSync(join(f.dataDir, '.runtime', 'restart-result.json')));
  assert.equal(installedPackage(f.home).manifest.version, '0.2.1');
  await s.stop();
});

test('无运行 child 时接手待确认新版也能回滚；旧版也失败时停止重试', async t => {
  const f = fixture(t), pair = await ports(); await createInstaller(f.options)(f.update);
  write(join(f.home, 'host-test.json'), { versions: { '0.3.0': { crash: true }, '0.2.1': { crash: true } } });
  const s = supervisor(t, f, { ...pair, background: true });
  await assert.rejects(s.promise, /自有宿主已退出/);
  assert.deepEqual(events(f.home).filter(e => e.type === 'start').map(e => e.version), ['0.3.0', '0.2.1']);
  assert.equal(JSON.parse(readFileSync(join(f.dataDir, '.runtime', 'restart-request.json'))).phase, 'recovery-failed');
  await assert.rejects(supervisor(t, f, { ...pair, background: true }).promise, /停止自动启动/);
  assert.equal(events(f.home).filter(e => e.type === 'start').length, 2);
  assert.equal(s.opened.length, 0);
});

test('启动回滚失败持久标记且再次 supervisor 不重复安装或回滚', async t => {
  const f = fixture(t), pair = await ports();
  const result = await createInstaller(f.options)(f.update);
  write(join(f.home, 'host-test.json'), { versions: { '0.3.0': { crash: true } } });
  write(join(result.backupDir, 'complete.json'), { version: '0.2.1', home: f.home, profile: 'WRONG', present: ['package.json'] });
  await assert.rejects(supervisor(t, f, { ...pair, background: true }).promise, /回滚未完成/);
  const request = JSON.parse(readFileSync(join(f.dataDir, '.runtime', 'restart-request.json')));
  assert.equal(request.phase, 'rollback-failed'); assert.equal(request.installationUncertain, true); assert.equal(request.rollbackAttempted, true);
  await assert.rejects(supervisor(t, f, pair).promise, /回滚未完成/);
  assert.equal(events(f.home).filter(e => e.type === 'start').length, 1);
  assert.equal(installedPackage(f.home).manifest.version, '0.3.0');
});

test('LaunchAgent 仅点击才生成；真实查询判定，不以 plist 存在视为已启用', async t => {
  const f = fixture(t); let loaded = false; const calls = [];
  const service = new BackgroundService(f.options, { userHome: join(f.dir, 'user'), uid: 501, platform: 'darwin', query: args => { calls.push(args); return loaded ? { status: 0 } : { status: 113, stderr: 'Could not find service' }; }, run: async args => { calls.push(args); loaded = args[0] === 'bootstrap'; } });
  assert.equal(calls.length, 0); assert.equal(existsSync(service.plist), false);
  assert.equal(service.status().enabled, false);
  const enabled = await service.setEnabled(true); assert.equal(enabled.enabled, true);
  const xml = readFileSync(service.plist, 'utf8');
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/); assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml, /--background/); assert.match(xml, /--no-open/); assert.match(xml, /--pnpm-path/); assert.match(xml, /&apos;/);
  assert.ok(xml.includes(join(f.plugin, 'bin', 'claudia.mjs'))); assert.equal(/DO_NOT_COPY|apiKey|credentials/.test(xml), false);
  loaded = false; assert.equal(service.status().enabled, false); loaded = true;
  const disabled = await service.setEnabled(false); assert.equal(disabled.enabled, false); assert.equal(existsSync(service.plist), false);
  assert.ok(calls.some(args => args[0] === 'bootout' && args[1] === `gui/501/com.iamhej.dsh-claudia.${homeHash(f.home)}`));
  assert.equal(calls.some(args => args.includes('system') || args.includes('kill')), false);
});

test('后台宿主内关闭先返回 pending，不同步 bootout 自杀设置请求', async t => {
  const f = fixture(t); let invoked = false;
  const service = new BackgroundService(f.options, { platform: 'darwin', userHome: join(f.dir, 'user'), query: () => ({ status: 0 }), run: async () => { invoked = true; } });
  const oldLabel = process.env.CLAUDIA_BACKGROUND_LABEL, oldSupervised = process.env.CLAUDIA_SUPERVISED;
  try {
    process.env.CLAUDIA_BACKGROUND_LABEL = service.label; process.env.CLAUDIA_SUPERVISED = '1';
    const result = await service.setEnabled(false);
    assert.equal(result.enabled, true); assert.equal(result.pending, true); assert.equal(invoked, false);
    assert.ok(existsSync(join(f.dataDir, '.runtime', 'background-disable-request.json')));
  } finally {
    if (oldLabel === undefined) delete process.env.CLAUDIA_BACKGROUND_LABEL; else process.env.CLAUDIA_BACKGROUND_LABEL = oldLabel;
    if (oldSupervised === undefined) delete process.env.CLAUDIA_SUPERVISED; else process.env.CLAUDIA_SUPERVISED = oldSupervised;
  }
});

test('launchctl 失败不报告成功；非 macOS 明确不支持', async t => {
  const f = fixture(t);
  const unavailable = new BackgroundService(f.options, { platform: 'linux', userHome: join(f.dir, 'user'), query() { assert.fail('不应调用'); } });
  assert.equal(unavailable.status().supported, false); await assert.rejects(unavailable.setEnabled(true), /仅支持 macOS/);
  const service = new BackgroundService(f.options, { platform: 'darwin', userHome: join(f.dir, 'user'), query: () => ({ status: 113, stderr: 'Could not find service' }), run: async () => { const error = new Error('模拟失败'); error.stderr = 'Bootstrap failed: 125: Domain does not exist token=sk-abcdefghijklmnop'; throw error; } });
  await assert.rejects(service.setEnabled(true), error => {
    // 失败要带上可排查的输出片段，同时抹掉任何凭据样式的字符串。
    assert.match(error.message, /注册失败/); assert.match(error.message, /Domain does not exist/);
    assert.doesNotMatch(error.message, /sk-abcdefghijklmnop/); return true;
  });
  assert.equal(service.status().enabled, false);
  // 注册失败必须当场清除刚写入的 plist：launchctl 不认识它，status 照样报关闭，
  // 但 RunAtLoad 会在下次登录把后台悄悄拉起来，违反“不偷偷注册”的约定。
  assert.equal(existsSync(service.plist), false);
  // 再次关闭仍是安全的空操作，不因文件已不存在而报错。
  await service.setEnabled(false); assert.equal(existsSync(service.plist), false);
});

test('bootstrap 成功但 launchctl 未确认时同样回滚 plist', async t => {
  const f = fixture(t);
  let bootstrapped = false;
  // run 不抛错，但 query 始终报告未找到服务：属于“写了文件却没真正注册”的情况。
  const service = new BackgroundService(f.options, { platform: 'darwin', userHome: join(f.dir, 'user'), uid: 501, query: () => ({ status: 113, stderr: 'Could not find service' }), run: async args => { bootstrapped = args[0] === 'bootstrap'; } });
  await assert.rejects(service.setEnabled(true), /未确认注册/);
  assert.equal(bootstrapped, true);
  assert.equal(existsSync(service.plist), false);
});
