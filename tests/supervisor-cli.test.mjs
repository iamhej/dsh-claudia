import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
// supervisor CLI 的纯函数：只验证参数解析与端口探测，不启动宿主、不 spawn 子进程、不读真实凭据。
import { parseArgs, probeHealth, makeHostArgs } from '../bin/claudia.mjs';

const HOME = join(homedir(), '.dsh');
const base = { home: HOME, dataDir: join(HOME, 'claudia'), profile: 'web', hostPort: 3088, pluginPort: 4317, open: true, background: false };

test('start 默认参数、环境变量 home 与数据目录推导', () => {
  assert.deepEqual(parseArgs(['start'], {}), base);
  assert.deepEqual(parseArgs(['start'], { DSH_HOME: '/tmp/other-home' }), { ...base, home: '/tmp/other-home', dataDir: join('/tmp/other-home', 'claudia') });
  assert.deepEqual(parseArgs(['start', '--data-dir', '/tmp/data'], {}), { ...base, dataDir: '/tmp/data' });
});

test('显式端口、profile、不打开浏览器与后台标记', () => {
  assert.deepEqual(parseArgs(['start', '--port', '4000', '--plugin-port', '4001'], {}), { ...base, hostPort: 4000, pluginPort: 4001 });
  assert.deepEqual(parseArgs(['start', '--profile', 'dev', '--no-open', '--background'], {}), { ...base, profile: 'dev', open: false, background: true });
  assert.deepEqual(parseArgs(['start', '--dsh-bin', '/tmp/dsh.mjs', '--pnpm-path', '/tmp/pnpm'], {}), { ...base, dshBin: '/tmp/dsh.mjs', pnpmPath: '/tmp/pnpm' });
});

test('非法命令、未知参数、缺值、重复、非法端口与相对路径一律报错', () => {
  // 不带参数只打印用法，不默认启动服务。
  assert.deepEqual(parseArgs([], {}), { help: true });
  assert.throws(() => parseArgs(['stop'], {}), /只支持 start/);
  assert.deepEqual(parseArgs(['--help'], {}), { help: true });
  assert.deepEqual(parseArgs(['-h'], {}), { help: true });
  assert.deepEqual(parseArgs(['start', '--help'], {}), { help: true });
  for (const argv of [['start', '--unknown'], ['start', '--port'], ['start', '--port', '--plugin-port', '4000'], ['start', '--port', '5000', '--port', '5000'], ['start', '--port', '0'], ['start', '--port', '65536'], ['start', '--port', '80a'], ['start', '--port', '4000', '--plugin-port', '4000'], ['start', '--home', 'relative'], ['start', '--home', '/tmp/../etc']]) {
    assert.throws(() => parseArgs(argv, {}), undefined, JSON.stringify(argv));
  }
});

test('宿主参数按 profile 组装，web 不加 --profile', () => {
  assert.deepEqual(makeHostArgs({ profile: 'web', hostPort: 3088 }, '/tmp/overlay.yml'), ['web', '--patch', '/tmp/overlay.yml', '--no-open', '--port', '3088']);
  assert.deepEqual(makeHostArgs({ profile: 'dev', hostPort: 4000 }, '/tmp/overlay.yml'), ['--profile', 'dev', '--patch', '/tmp/overlay.yml', '--no-open', '--port', '4000']);
});

test('端口探测：未占用、插件健康与非插件响应', async t => {
  const free = createServer();
  await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
  const port = free.address().port;
  await free.close();
  assert.deepEqual(await probeHealth(port), { occupied: false });
  const servers = [];
  const serve = (handler) => {
    const server = createServer(handler);
    servers.push(server);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  };
  const ok = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, plugin: 'dsh-claudia', version: '0.3.6', pid: process.pid, busy: false })); });
  assert.deepEqual(await probeHealth(ok), { occupied: true, health: { ok: true, plugin: 'dsh-claudia', version: '0.3.6', pid: process.pid, busy: false } });
  const bad = await serve((_req, res) => { res.writeHead(500); res.end('not claudia'); });
  assert.deepEqual(await probeHealth(bad), { occupied: true });
  const junk = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('not json'); });
  assert.deepEqual(await probeHealth(junk), { occupied: true });
  t.after(() => { for (const server of servers) server.close(); });
});
