import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, statSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';
import { EmailControl, emailPatch } from '../email-control.mjs';
import { startServer } from '../server.mjs';

// 只加载已安装宿主的正式解析器，不启动 CLI、不加载邮件插件或读取任何账号配置。
const hostModules = process.env.DSH_TEST_HOST_MODULES || join(homedir(), '.local/share/deepseek-harness/node_modules/.pnpm/node_modules');
const hostAnchor = realpathSync(join(hostModules, '@deepseek-ai/dsh-app-boot/package.json'));
const boot = createRequire(hostAnchor)('@deepseek-ai/dsh-app-boot');
const tools = fileURLToPath(new URL('../.tools/', import.meta.url));
const options = { timeout: 15_000 };
const disabledPatch = '# 保持默认关闭\n- id: tool-email\n  name: dsh-email\n  disabled: true\n';
const emailRow = { id: 'tool-email', name: 'dsh-email' };
const otherRow = { id: 'unrelated', name: 'synthetic-other', config: { keep: '原值' } };
const put = (path, value) => writeFileSync(path, value, { mode: 0o600 });
const text = path => readFileSync(path, 'utf8');
const rejectStatus = (fn, status) => assert.throws(fn, error => error.status === status);

function fixture(t, config = {}) {
  const root = mkdtempSync(join(tools, 'email-control-test-'));
  const cleanup = [];
  t.after(async () => { try { for (const close of cleanup) await close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const home = join(root, 'home'), dir = join(home, 'profiles', 'web'), dataDir = join(home, 'claudia');
  const bundleDir = join(dir, 'node_modules', 'claudia-email-control-fixture');
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(dir, 'package.json'), bundlePath = join(bundleDir, 'cordis.patch.yml');
  const manifest = { name: 'isolated-email-profile', version: '1.0.0', dsh: { profile: { bundles: ['claudia-email-control-fixture'], patchReload: config.reload ?? 'startup' } } };
  put(manifestPath, JSON.stringify(manifest));
  put(join(bundleDir, 'package.json'), JSON.stringify({ name: 'claudia-email-control-fixture', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  put(bundlePath, JSON.stringify([{ insert: config.rows ?? [emailRow, otherRow] }]));
  const path = join(dir, 'cordis.patch.yml'), homePath = join(home, 'cordis.patch.yml');
  if (config.patch !== null) put(path, config.patch ?? disabledPatch);
  if (config.homePatch !== undefined) put(homePath, config.homePatch);
  const plugin = { name: 'dsh-email', installed: true, enabled: false, phase: null };
  const getPlugins = () => ({ packages: [plugin] });
  const controlOptions = { home, profile: 'web', dataDir, hostAnchor, getPlugins };
  const control = new EmailControl(controlOptions);
  function compose() {
    const profile = boot.loadProfileDirectory('dsh', dir, hostAnchor);
    return boot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, boot.loadOptionalPatches('dsh', homePath) ?? []]);
  }
  return { root, home, dir, dataDir, path, homePath, manifestPath, manifest, bundlePath, plugin, control, controlOptions, compose, cleanup, reopen: () => new EmailControl(controlOptions) };
}

function assertClosed(control) {
  const status = control.status();
  assert.equal(status.supported, false, status.message);
  for (const key of ['revision', 'savedEnabled', 'enabled', 'phase']) assert.equal(status[key], null, key);
  assert.equal(status.needsRestart, false);
  rejectStatus(() => control.setEnabled(true, '0'.repeat(64)), 409);
  return status;
}

test('正式 hostAnchor 可解析，默认 disabled 来自 user patches，读取不写入或启用', options, t => {
  const f = fixture(t), before = text(f.path);
  assert.equal(f.control.boot.loadProfileDirectory, boot.loadProfileDirectory);
  const state = f.control.status();
  assert.equal(state.supported, true, state.message);
  assert.equal(state.savedEnabled, false);
  assert.equal(state.enabled, false);
  assert.equal(state.needsRestart, false);
  assert.match(state.revision, /^[a-f0-9]{64}$/);
  assert.equal(f.compose().find(row => row.id === 'tool-email').disabled, true);
  assert.equal(text(f.path), before);
  assert.equal(existsSync(f.dataDir), false);
});

test('on/off 独立保存、重建控制器保留，运行状态仅在模拟重启后改变；备份私有且不碰其它配置', options, t => {
  const original = disabledPatch + '# 原样保留注释与未知配置\n- id: unrelated\n  config:\n    keep: 自定义\n    nested: { untouched: [1, 2] }\n';
  const f = fixture(t, { patch: original });
  const manifest = text(f.manifestPath), bundle = text(f.bundlePath), other = f.compose().find(row => row.id === 'unrelated');
  const first = f.control.status();
  const on = f.control.setEnabled(true, first.revision);
  assert.equal(on.savedEnabled, true);
  assert.equal(on.enabled, false);
  assert.equal(on.needsRestart, true);
  assert.ok(text(f.path).startsWith(original));
  assert.notEqual(on.revision, first.revision);
  assert.equal(f.reopen().status().savedEnabled, true);
  assert.deepEqual(f.compose().find(row => row.id === 'unrelated'), other);
  f.plugin.enabled = true; f.plugin.phase = 'active';
  assert.equal(f.reopen().status().needsRestart, false);
  const off = f.reopen().setEnabled(false, on.revision);
  assert.equal(off.savedEnabled, false);
  assert.equal(off.enabled, true);
  assert.equal(off.needsRestart, true);
  assert.equal(f.reopen().status().savedEnabled, false);
  assert.equal((text(f.path).match(/# claudia-email-toggle:start/g) ?? []).length, 1);
  assert.equal(text(f.manifestPath), manifest);
  assert.equal(text(f.bundlePath), bundle);
  assert.equal(existsSync(f.homePath), false);
  const backupDir = join(f.dataDir, '.runtime', 'email-config');
  const backups = readdirSync(backupDir).filter(name => name.endsWith('.backup.yml'));
  assert.equal(backups.length, 2);
  assert.ok(backups.some(name => text(join(backupDir, name)) === original));
  for (const name of backups) assert.equal(statSync(join(backupDir, name)).mode & 0o777, 0o600);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(readdirSync(backupDir).some(name => name.endsWith('.candidate.yml')), false);
  assert.equal(readdirSync(f.dir).some(name => name.includes('candidate') || name.endsWith('.lock')), false);
});

test('同值保存无副作用，但仍要求正确 revision', options, t => {
  const f = fixture(t), before = text(f.path), state = f.control.status();
  assert.deepEqual(f.control.setEnabled(false, state.revision), state);
  rejectStatus(() => f.control.setEnabled(false, '0'.repeat(64)), 409);
  assert.equal(text(f.path), before);
  assert.equal(existsSync(f.dataDir), false);
  assert.equal(existsSync(join(f.dir, '.claudia-email.lock')), false);
});

test('开关与 revision 严格校验，不接受 truthy 或缺失值', options, t => {
  const f = fixture(t), before = text(f.path), revision = f.control.status().revision;
  for (const value of [undefined, null, 'true', 'false', 0, 1, [], {}]) rejectStatus(() => f.control.setEnabled(value, revision), 400);
  for (const value of [undefined, null, '', 'f'.repeat(63), 'F'.repeat(64), [], {}]) rejectStatus(() => f.control.setEnabled(true, value), 400);
  assert.equal(text(f.path), before);
});

for (const where of ['profile', 'home', 'bundle', 'manifest']) {
  test(`CAS 拒绝 ${where} 外部修改后的旧 revision，包括同值保存`, options, t => {
    const f = fixture(t), revision = f.control.status().revision;
    if (where === 'profile') put(f.path, text(f.path) + '# 外部编辑\n');
    if (where === 'home') put(f.homePath, '- id: unrelated\n  config: { keep: home }\n');
    if (where === 'bundle') put(f.bundlePath, JSON.stringify([{ insert: [emailRow, { ...otherRow, config: { keep: '新 bundle' } }] }]));
    if (where === 'manifest') { f.manifest.description = '外部修改'; put(f.manifestPath, JSON.stringify(f.manifest)); }
    const before = text(f.path);
    assert.notEqual(f.control.status().revision, revision);
    rejectStatus(() => f.control.setEnabled(true, revision), 409);
    rejectStatus(() => f.control.setEnabled(false, revision), 409);
    assert.equal(text(f.path), before);
    assert.equal(existsSync(join(f.dir, '.claudia-email.lock')), false);
  });
}

test('候选解析期间外部修改触发最终 CAS，不覆盖外部补丁', options, t => {
  const f = fixture(t), revision = f.control.status().revision, external = text(f.path) + '# 保存期间外部修改\n';
  f.control.boot = { ...boot, loadOptionalPatches(bin, path) {
    const result = boot.loadOptionalPatches(bin, path);
    if (path.endsWith('.candidate.yml')) put(f.path, external);
    return result;
  } };
  rejectStatus(() => f.control.setEnabled(true, revision), 409);
  assert.equal(text(f.path), external);
});

for (const enabled of [true, false]) {
  test(`home override 阻止保存 ${enabled}，不得改 home 文件或 profile 原文`, options, t => {
    const f = fixture(t, { homePatch: `# home 最后覆盖\n- id: tool-email\n  disabled: ${enabled}\n` });
    const state = f.control.status(), before = text(f.path), home = text(f.homePath);
    assert.equal(state.savedEnabled, !enabled);
    rejectStatus(() => f.control.setEnabled(enabled, state.revision), 409);
    assert.equal(text(f.path), before);
    assert.equal(text(f.homePath), home);
  });
}

for (const reload of ['live', 'missing', 'invalid']) {
  test(`只管理 startup reload：${reload} 拒绝且不写入`, options, t => {
    const f = fixture(t, { reload });
    if (reload === 'missing') { delete f.manifest.dsh.profile.patchReload; put(f.manifestPath, JSON.stringify(f.manifest)); }
    const before = text(f.path);
    assertClosed(f.control);
    assert.equal(text(f.path), before);
  });
}

for (const disabled of [false, true, { __js: 'true' }]) {
  test(`嵌套 group（disabled=${JSON.stringify(disabled)}）一致拒绝管理，不再读支持而写失败`, options, t => {
    const f = fixture(t, { rows: [{ id: 'group', group: true, disabled, config: [emailRow] }, otherRow] });
    const before = text(f.path);
    assertClosed(f.control);
    assert.equal(text(f.path), before);
    assert.equal(existsSync(f.dataDir), false);
  });
}

for (const [label, rows] of [
  ['缺少邮件条目', [otherRow]],
  ['错误邮件 ID', [{ ...emailRow, id: 'other-email' }]],
  ['多个邮件实例', [emailRow, { ...emailRow, id: 'second-email' }]],
  ['邮件自身是 group', [{ ...emailRow, group: true, config: [] }]],
  ['不同插件重复 tool-email ID', [emailRow, { id: 'tool-email', name: 'other-plugin' }]],
]) {
  test(`${label} fail closed`, options, t => { assertClosed(fixture(t, { rows }).control); });
}

test('动态 !!js disabled 不执行表达式、不视作布尔开关', options, t => {
  const f = fixture(t, { patch: '- id: tool-email\n  disabled: !!js "(() => { throw new Error(\'不得执行\'); })()"\n' });
  const state = assertClosed(f.control);
  assert.match(state.message, /动态/);
  assert.equal(state.message.includes('不得执行'), false);
});

test('解析未知失败、损坏 YAML、symlink 与过大文件均关闭管理，不泄露配置内容', options, t => {
  for (const kind of ['parser', 'yaml', 'symlink', 'size']) {
    const f = fixture(t);
    if (kind === 'parser') f.control.boot = { ...boot, loadProfileDirectory() { throw Error('SYNTHETIC_PRIVATE_CONFIG'); } };
    if (kind === 'yaml') put(f.path, 'secret: [SYNTHETIC_PRIVATE_CONFIG');
    if (kind === 'size') put(f.path, '#'.repeat(256 * 1024 + 1));
    if (kind === 'symlink') { renameSync(f.path, join(f.dir, 'kept.yml')); symlinkSync(join(f.dir, 'kept.yml'), f.path); }
    const before = text(f.path), state = assertClosed(f.control);
    assert.equal(state.message.includes('SYNTHETIC_PRIVATE_CONFIG'), false);
    assert.equal(text(f.path), before);
  }
});

test('无 parser 或未安装邮件包时不支持，不创建默认开关', options, t => {
  const f = fixture(t);
  f.control.boot = undefined;
  assertClosed(f.control);
  f.control.boot = boot;
  f.plugin.installed = false;
  assertClosed(f.control);
  assert.equal(text(f.path), disabledPatch);
});

for (const lockText of ['', JSON.stringify({ pid: process.pid, id: 'other-owner' }), JSON.stringify({ pid: 2147483647, id: 'unknown-owner' })]) {
  test(`已有锁拒绝且不自动清理（${lockText || '空锁'}）`, options, t => {
    const f = fixture(t), before = text(f.path), revision = f.control.status().revision;
    const lock = join(f.dir, '.claudia-email.lock'); put(lock, lockText);
    rejectStatus(() => f.control.setEnabled(true, revision), 409);
    assert.equal(text(lock), lockText);
    assert.equal(text(f.path), before);
  });
}

test('保存期间锁被替换时拒绝提交且不删除他人锁', options, t => {
  const f = fixture(t), revision = f.control.status().revision, before = text(f.path), lock = join(f.dir, '.claudia-email.lock');
  f.control.boot = { ...boot, loadOptionalPatches(bin, path) {
    const result = boot.loadOptionalPatches(bin, path);
    if (path.endsWith('.candidate.yml')) { renameSync(lock, join(f.dir, 'old-lock')); put(lock, 'replacement-owner'); }
    return result;
  } };
  rejectStatus(() => f.control.setEnabled(true, revision), 409);
  assert.equal(text(f.path), before);
  assert.equal(text(lock), 'replacement-owner');
});

test('候选文件使用 profile 相同解析目录，保留相对路径、!!js、未知配置与其它 patch 语义', options, t => {
  const f = fixture(t);
  const localName = pathToFileURL(join(f.dir, 'helper.mjs')).href;
  const original = disabledPatch + `# 自定义路径只解析，绝不导入\n- insert:\n    - id: local-helper\n      name: ./helper.mjs\n      config: { keep: before }\n- id: local-helper\n  name: ${JSON.stringify(localName)}\n  config:\n    keep: after\n    literal: !!js "(() => { throw new Error('不得执行'); })()"\n`;
  put(f.path, original);
  const rows = f.compose();
  let candidateRows;
  f.control.boot = { ...boot, loadOptionalPatches(bin, path) {
    const patches = boot.loadOptionalPatches(bin, path);
    if (path.endsWith('.candidate.yml')) {
      const profile = boot.loadProfileDirectory(bin, f.dir, hostAnchor);
      candidateRows = boot.composeEntries([...profile.layers.map(layer => layer.patches), patches]);
    }
    return patches;
  } };
  const result = f.control.setEnabled(true, f.control.status().revision);
  assert.equal(result.savedEnabled, true);
  const expected = structuredClone(rows); expected.find(row => row.id === 'tool-email').disabled = false;
  assert.deepEqual(candidateRows, expected);
  assert.deepEqual(f.compose(), expected);
  assert.ok(text(f.path).startsWith(original));
});

test('候选即使得到目标 disabled，只要改变其它配置仍拒绝提交', options, t => {
  const f = fixture(t), before = text(f.path), revision = f.control.status().revision;
  f.control.boot = { ...boot, loadOptionalPatches(bin, path) {
    const patches = boot.loadOptionalPatches(bin, path);
    if (path.endsWith('.candidate.yml')) patches.push({ id: 'unrelated', config: { keep: '不应写入' } });
    return patches;
  } };
  rejectStatus(() => f.control.setEnabled(true, revision), 409);
  assert.equal(text(f.path), before);
  assert.equal(f.compose().find(row => row.id === 'unrelated').config.keep, '原值');
});

test('锁路径是目录或 symlink 时安全拒绝，不改变目标', options, t => {
  for (const kind of ['directory', 'symlink']) {
    const f = fixture(t), revision = f.control.status().revision, lock = join(f.dir, '.claudia-email.lock');
    const target = join(f.dir, 'keep-lock'); put(target, '保留');
    if (kind === 'directory') mkdirSync(lock); else symlinkSync(target, lock);
    rejectStatus(() => f.control.setEnabled(true, revision), 409);
    assert.equal(text(target), '保留');
    assert.equal(text(f.path), disabledPatch);
    assert.equal(existsSync(lock), true);
  }
});

test('运行状态未观测保持 null，重复安装观测或清单异常拒绝管理', options, t => {
  const f = fixture(t);
  delete f.plugin.enabled; delete f.plugin.phase;
  const state = f.control.status();
  assert.equal(state.savedEnabled, false); assert.equal(state.enabled, null); assert.equal(state.phase, null);
  assert.equal(state.needsRestart, false);
  f.control.getPlugins = () => ({ packages: [f.plugin, f.plugin] });
  assertClosed(f.control);
  f.control.getPlugins = () => { throw Error('SYNTHETIC_PRIVATE_CONFIG'); };
  assert.equal(assertClosed(f.control).message.includes('SYNTHETIC_PRIVATE_CONFIG'), false);
});

test('只有自有标记块可替换，外部冲突/重复/破损标记拒绝，前后原文不变', options, () => {
  const block = emailPatch('', false);
  const original = '# 前缀\r\n' + block + '\n# 后缀\n- id: unrelated\n  config: { keep: after }\n';
  assert.equal(emailPatch(original, true), original.replace('disabled: true', 'disabled: false'));
  for (const invalid of [block + block, block.replace('name: dsh-email', 'name: other'), block.replace('# claudia-email-toggle:end', ''), '# claudia-email-toggle:end\n']) rejectStatus(() => emailPatch(invalid, true), 409);
});

test('空补丁文件缺失或 [] 可创建开关，注释与尾部空白不被裁剪', options, t => {
  const f = fixture(t, { rows: [{ ...emailRow, disabled: true }, otherRow], patch: null });
  assert.equal(f.control.setEnabled(true, f.control.status().revision).savedEnabled, true);
  const input = '# 保留前缀  \n[]\n# 保留尾注释  \n\n';
  const output = emailPatch(input, true);
  assert.ok(output.startsWith(input.replace('[]', '')));
});

test('flow list、多文档与已有标记后的覆盖均拒绝而不重写其它 patch', options, t => {
  for (const patch of [JSON.stringify([{ id: 'tool-email', disabled: true }]), '---\n' + disabledPatch + '---\n[]\n', emailPatch('', false) + '- id: tool-email\n  disabled: true\n']) {
    const f = fixture(t, { patch }), before = text(f.path), status = f.control.status();
    if (status.supported) rejectStatus(() => f.control.setEnabled(true, status.revision), 409);
    else assertClosed(f.control);
    assert.equal(text(f.path), before);
  }
});

test('候选校验和备份写入未知失败不提交，移除自己的锁且返回可安全公开的错误', options, t => {
  for (const kind of ['parse', 'backup']) {
    const f = fixture(t), before = text(f.path), revision = f.control.status().revision;
    if (kind === 'parse') f.control.boot = { ...boot, loadOptionalPatches(bin, path) { if (path.endsWith('.candidate.yml')) throw Error('SYNTHETIC_PRIVATE_CONFIG'); return boot.loadOptionalPatches(bin, path); } };
    if (kind === 'backup') { mkdirSync(f.dataDir, { recursive: true }); put(join(f.dataDir, '.runtime'), '阻止备份目录创建'); }
    assert.throws(() => f.control.setEnabled(true, revision), error => error.status === 500 && !error.message.includes('SYNTHETIC_PRIVATE_CONFIG'));
    assert.equal(text(f.path), before);
    assert.equal(existsSync(join(f.dir, '.claudia-email.lock')), false);
    assert.equal(readdirSync(f.dir).some(name => name.endsWith('.candidate.yml')), false);
  }
});

async function apiFixture(t, config = {}) {
  const f = fixture(t), calls = { reflection: [], model: 0, restart: 0 }, flags = { busy: false, hostBusy: false, hostError: false };
  const gate = Promise.withResolvers();
  let app, token;
  const runtime = { selection: () => ({}), status: async () => ({ configured: false, modelVerified: false }), async run() { calls.model++; throw Error('禁止模型调用'); }, async close() {} };
  const maintenance = { status: () => ({ running: flags.busy }), runReflection(date, params) { calls.reflection.push({ date, params }); flags.busy = true; return gate.promise.finally(() => { flags.busy = false; }); }, async close() { gate.resolve(); } };
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const requestHeaders = { connection: 'close', ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-claudia-token': token }), ...headers };
    for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
    return new Promise((resolve, reject) => {
      const req = httpRequest(new URL(path, app.url), { method, headers: requestHeaders, agent: false }, res => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; }); res.on('error', reject);
        res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw), raw }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.setTimeout(3000, () => req.destroy(Error('本机测试请求超时')));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function start() {
    app = await startServer({ dataDir: f.dataDir, home: f.home, port: 0, createRuntime: () => runtime,
      hasOtherAgents: () => { if (flags.hostError) throw Error('宿主未知'); return flags.hostBusy; },
      createServices: () => ({ ...(config.email === false ? {} : { email: f.reopen() }), ...(config.maintenance === false ? {} : { maintenance }), restart: { request() { calls.restart++; } } }),
    });
    token = (await request('/api/bootstrap')).data.csrfToken;
  }
  await start();
  f.cleanup.push(async () => { gate.resolve(); await app.close(); assert.equal(calls.model, 0); assert.equal(calls.restart, 0); });
  return { ...f, calls, flags, gate, request, get app() { return app; }, post: (path, body, headers) => request(path, { method: 'POST', body, headers }), async restart() { await app.close(); await start(); } };
}

const emailBody = state => ({ enabled: true, revision: state.revision, confirmHostTools: true });
const reflectionBody = () => ({ confirmDataSharing: true, requestId: randomUUID() });

test('邮件 API 默认关闭；独立保存返回待重启，服务重开后保留，不隐式启动模型或重启', options, async t => {
  const f = await apiFixture(t), state = await f.request('/api/email');
  assert.equal(state.status, 200); assert.equal(state.data.savedEnabled, false);
  const settings = text(join(f.dataDir, 'settings.md'));
  const response = await f.post('/api/email', emailBody(state.data));
  assert.equal(response.status, 200, response.raw); assert.equal(response.data.savedEnabled, true); assert.equal(response.data.needsRestart, true);
  assert.equal(text(join(f.dataDir, 'settings.md')), settings);
  await f.restart();
  assert.equal((await f.request('/api/email')).data.savedEnabled, true);
  assert.equal((await f.post('/api/email', emailBody(state.data))).status, 409);
  const current = (await f.request('/api/email')).data;
  assert.equal((await f.post('/api/email', { ...emailBody(current), enabled: false })).data.savedEnabled, false);
});

test('邮件 API 并发提交同一 revision 仅保存一次，未知失败后释放 configuring', options, async t => {
  const f = await apiFixture(t), revision = (await f.request('/api/email')).data.revision;
  f.app.services.email.boot = { ...boot, loadOptionalPatches(bin, path) {
    if (path.endsWith('.candidate.yml')) throw Error('SYNTHETIC_PRIVATE_CONFIG');
    return boot.loadOptionalPatches(bin, path);
  } };
  const failed = await f.post('/api/email', emailBody({ revision }));
  assert.equal(failed.status, 500); assert.equal(failed.raw.includes('SYNTHETIC_PRIVATE_CONFIG'), false);
  assert.equal(text(f.path), disabledPatch);
  assert.equal((await f.request('/api/health')).data.busy, false);
  f.app.services.email.boot = boot;
  const responses = await Promise.all([f.post('/api/email', emailBody({ revision })), f.post('/api/email', emailBody({ revision }))]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal((await f.request('/api/email')).data.savedEnabled, true);
  assert.equal(readdirSync(join(f.dataDir, '.runtime', 'email-config')).filter(name => name.endsWith('.backup.yml')).length, 1);
});

test('邮件与手动回顾 API 同样受 CSRF、JSON、Host、Origin 与跨站约束', options, async t => {
  const f = await apiFixture(t), state = (await f.request('/api/email')).data;
  for (const [path, body] of [['/api/email', emailBody(state)], ['/api/reflections/run', reflectionBody()]]) {
    for (const headers of [{ 'x-claudia-token': undefined }, { 'x-claudia-token': 'wrong' }, { 'content-type': 'text/plain' }, { host: 'invalid.local' }, { origin: 'http://localhost:1' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await f.post(path, body, headers)).status, 403);
  }
  assert.equal(text(f.path), disabledPatch); assert.equal(f.calls.reflection.length, 0);
});

test('邮件 API 拒绝缺少确认、额外字段、非法 bool/revision，无副作用', options, async t => {
  const f = await apiFixture(t), state = (await f.request('/api/email')).data, valid = emailBody(state);
  for (const body of [{}, { enabled: true, revision: state.revision }, { ...valid, confirmHostTools: false }, { ...valid, account: '禁止接收配置' }, { ...valid, enabled: 'true' }, { ...valid, revision: null }]) assert.equal((await f.post('/api/email', body)).status, 400);
  assert.equal(text(f.path), disabledPatch);
});

test('邮件 API 拒绝维护忙、宿主忙、宿主未知与重启排空，锁和 home override 保持 409', options, async t => {
  const f = await apiFixture(t), valid = emailBody((await f.request('/api/email')).data);
  for (const key of ['busy', 'hostBusy', 'hostError']) { f.flags[key] = true; assert.equal((await f.post('/api/email', valid)).status, 409); f.flags[key] = false; }
  const lock = join(f.dir, '.claudia-email.lock'); put(lock, 'other-owner');
  assert.equal((await f.post('/api/email', valid)).status, 409); assert.equal(text(lock), 'other-owner');
  renameSync(lock, join(f.dir, 'kept-lock'));
  put(f.homePath, '- id: tool-email\n  disabled: true\n');
  assert.equal((await f.post('/api/email', emailBody((await f.request('/api/email')).data))).status, 409);
  assert.equal((await f.post('/api/prepare-restart', {})).status, 200);
  assert.equal((await f.post('/api/email', valid)).status, 409);
  assert.equal(text(f.path), disabledPatch);
});

test('邮件服务缺失或 parser 失败时 GET 明确 unsupported，POST 不保存', options, async t => {
  const f = await apiFixture(t, { email: false });
  assert.equal((await f.request('/api/email')).data.supported, false);
  assert.equal((await f.post('/api/email', emailBody({ revision: '0'.repeat(64) }))).status, 503);
  const broken = await apiFixture(t);
  put(broken.path, 'secret: [SYNTHETIC_PRIVATE_CONFIG');
  const response = await broken.request('/api/email');
  assert.equal(response.data.supported, false); assert.equal(response.raw.includes('SYNTHETIC_PRIVATE_CONFIG'), false);
  assert.equal((await broken.post('/api/email', emailBody({ revision: '0'.repeat(64) }))).status, 409);
});

test('手动回顾 API 默认关闭；必须确认与 UUIDv4，202 立即受理且正确传递参数', options, async t => {
  const f = await apiFixture(t), body = reflectionBody();
  assert.equal((await f.post('/api/reflections/run', body)).status, 400);
  f.app.store.set('reflectionEnabled', true);
  for (const invalid of [{}, { requestId: body.requestId }, { ...body, confirmDataSharing: false }, { ...body, extra: true }, { ...body, requestId: 'invalid' }, { ...body, requestId: '11111111-1111-7111-8111-111111111111' }]) assert.equal((await f.post('/api/reflections/run', invalid)).status, 400);
  assert.equal(f.calls.reflection.length, 0);
  const response = await f.post('/api/reflections/run', body);
  assert.equal(response.status, 202); assert.deepEqual(response.data, { accepted: true });
  assert.equal(f.calls.reflection.length, 1);
  assert.ok(f.calls.reflection[0].date instanceof Date);
  assert.deepEqual(f.calls.reflection[0].params, { manual: true, requestId: body.requestId });
  assert.equal((await f.post('/api/reflections/run', reflectionBody())).status, 409);
  assert.equal(f.calls.reflection.length, 1);
});

test('手动回顾缺少服务返回 503，后台失败不会把 202 误报成完成或泄露原始错误', options, async t => {
  const missing = await apiFixture(t, { maintenance: false });
  missing.app.store.set('reflectionEnabled', true);
  assert.equal((await missing.post('/api/reflections/run', reflectionBody())).status, 503);
  const f = await apiFixture(t); f.app.store.set('reflectionEnabled', true);
  const response = await f.post('/api/reflections/run', reflectionBody());
  f.gate.reject(Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR'));
  assert.equal(response.status, 202); assert.deepEqual(response.data, { accepted: true });
  assert.equal((await f.request('/api/health')).status, 200);
});
