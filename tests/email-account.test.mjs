import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { EmailAccount } from '../email-account.mjs';
import { startServer } from '../server.mjs';
import { Logger } from '../logger.mjs';

// 运行方式：指定 managed node 直接执行本文件；node:test 仍输出真实 TAP 与退出码。
// 不导入 CLI、文件 settings provider、邮件 runtime，不启动账号检查或邮件连接。
// 测试内文件守卫拦截日常 .dsh；保留 Records 对真实祖先目录的 lstat 检查。
const project = fileURLToPath(new URL('../', import.meta.url));
const realHome = homedir();
const tools = join(project, '.tools');
// 纯设置测试不产生磁盘文件；只有 HTTP 集成测试创建隔离目录。
const root = join(tools, `email-account-test-${randomUUID()}`);
const envKeys = ['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DSH_EMAIL_PASSWORD'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
for (const key of envKeys) process.env[key] = key === 'DSH_EMAIL_PASSWORD' ? '' : join(root, key.toLowerCase());
const dailyHome = join(realHome, '.dsh');
let blockedDailyAccess = 0;
function guardPath(path) {
  if (typeof path === 'number' || path === undefined) return;
  if (path instanceof URL) path = fileURLToPath(path);
  if (Buffer.isBuffer(path)) path = path.toString();
  if (typeof path !== 'string') return;
  const absolute = resolve(path);
  if (absolute === dailyHome || absolute.startsWith(dailyHome + '/')) {
    blockedDailyAccess++;
    throw Object.assign(Error('测试禁止访问日常 Harness 目录'), { code: 'EMAIL_TEST_FORBIDDEN_HOME' });
  }
}
for (const api of [fs, fsp]) {
  for (const name of ['access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lstat', 'link', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'symlink', 'truncate', 'unlink', 'utimes', 'watch', 'watchFile', 'writeFile', 'createReadStream', 'createWriteStream']) {
    for (const method of [name, name + 'Sync']) {
      if (typeof api[method] !== 'function') continue;
      const original = api[method];
      mock.method(api, method, function (...args) {
        guardPath(args[0]);
        if (['copyFile', 'cp', 'link', 'rename', 'symlink'].includes(name)) guardPath(args[1]);
        return original.apply(this, args);
      });
    }
  }
}
syncBuiltinESMExports();
const sourcePaths = ['email-account.mjs', 'index.mjs', 'server.mjs'].map(name => join(project, name));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceHashes = sourcePaths.map(sha);
const allowedPorts = new Set();
let forbiddenNetwork = 0;
const connect = net.Socket.prototype.connect;
mock.method(net.Socket.prototype, 'connect', function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof normalized[0] === 'object' ? normalized[0] : { port: normalized[0], host: normalized[1] };
  if (options.path || !['127.0.0.1', 'localhost'].includes(options.host) || !allowedPorts.has(Number(options.port))) {
    forbiddenNetwork++;
    throw Error('测试禁止非自有 HTTP 回环连接');
  }
  return Reflect.apply(connect, this, args);
});
mock.method(tls, 'connect', () => { forbiddenNetwork++; throw Error('测试禁止 TLS/邮件连接'); });
mock.method(globalThis, 'fetch', () => { forbiddenNetwork++; throw Error('测试禁止外部 fetch'); });
after(t => {
  try {
    assert.equal(forbiddenNetwork, 0, '不得调用邮件或外部 API');
    assert.equal(blockedDailyAccess, 2, '除守卫自检外不应尝试访问日常 .dsh');
    assert.deepEqual(sourcePaths.map(sha), sourceHashes, '生产文件必须保持原样');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    // 经授权保留测试目录；不取消生产锁、不绕删除守卫，也不声称完成清理。
    if (existsSync(root)) t.diagnostic(`测试目录保留，未执行清理：${root}`);
  }
});

const hostModules = process.env.DSH_TEST_HOST_MODULES || join(realHome, '.local/share/deepseek-harness/node_modules/.pnpm/node_modules');
const hostPackage = realpathSync(join(hostModules, '@deepseek-ai/dsh-settings/package.json'));
const hostRequire = createRequire(hostPackage);
const settingsPath = hostRequire.resolve('@deepseek-ai/dsh-settings');
const { SettingsProvider, SettingsConflictError } = await import(pathToFileURL(settingsPath));
const { Context, Service } = hostRequire('@deepseek-ai/cordis');
const mailPath = fileURLToPath(new URL('../../dsh-email-compat/lib/settings.js', import.meta.url));
const legacyPath = fileURLToPath(new URL('../../.tools/email-audit-0.11.0/package/lib/settings.js', import.meta.url));
// 分别导入真实兼容版与原版静态模块；不复制 schema，不给原版填新字段假测。
// 兼容包缺失时直接失败，不把跳过或原版替代标成通过。
const schemaDependency = hostRequire.resolve('@deepseek-ai/schemastery');
const dependencyHook = registerHooks({ resolve(specifier, context, nextResolve) {
  if ([mailPath, legacyPath].some(path => context.parentURL === pathToFileURL(path).href) && specifier === 'schemastery') return { url: pathToFileURL(schemaDependency).href, shortCircuit: true };
  if ([mailPath, legacyPath].some(path => context.parentURL === new URL('./config.js', pathToFileURL(path)).href) && specifier === 'yaml') return { url: pathToFileURL(hostRequire.resolve('yaml')).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
let mailModule, legacyModule, mailConfig, legacyConfig;
try {
  mailModule = await import(pathToFileURL(mailPath));
  legacyModule = await import(pathToFileURL(legacyPath));
  mailConfig = await import(new URL('./config.js', pathToFileURL(mailPath)));
  legacyConfig = await import(new URL('./config.js', pathToFileURL(legacyPath)));
}
finally { dependencyHook.deregister(); }
const { EmailSettingsSchema } = mailModule;
const hostMeta = JSON.parse(readFileSync(hostPackage, 'utf8'));
const mailMeta = JSON.parse(readFileSync(new URL('../package.json', pathToFileURL(mailPath)), 'utf8'));
const legacyMeta = JSON.parse(readFileSync(new URL('../package.json', pathToFileURL(legacyPath)), 'utf8'));
const NS = 'dsh-email';
const PASSWORD = 'abcdefghijklmnop';
const NEXT_PASSWORD = 'ponmlkjihgfedcba';
const SECRET = 'SYNTHETIC_PRIVATE_EMAIL_SENTINEL';
const USER = 'claudia.synthetic@qq.com';
const NEXT_USER = 'claudia.other@foxmail.com';
const options = { timeout: 15_000, concurrency: false };
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const poisoned = status => Object.assign(new Error(`${SECRET} ${PASSWORD} ${NEXT_PASSWORD}`), { status, cause: Error(SECRET) });
function clean(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [SECRET, PASSWORD, NEXT_PASSWORD]) assert.equal(raw.includes(secret), false, '公开输出不可包含合成凭据');
}
function snapshot(value) {
  assert.deepEqual(Object.keys(value).sort(), ['applies', 'compatible', 'configured', 'message', 'passwordSet', 'receiveEnabled', 'revision', 'sendEnabled', 'supported', 'user']);
  clean(value);
  assert.equal(value.applies, 'live');
  for (const key of ['compatible', 'configured', 'receiveEnabled', 'sendEnabled']) assert.equal(typeof value[key], 'boolean');
  if (value.supported) { assert.match(value.revision, /^[a-f0-9]{64}$/); assert.equal(value.configured, value.user !== '' && value.passwordSet); }
  else {
    assert.equal(value.revision, null); assert.equal(value.user, ''); assert.equal(value.passwordSet, false);
    for (const key of ['compatible', 'configured', 'receiveEnabled', 'sendEnabled']) assert.equal(value[key], false);
  }
}
async function rejects(fn, status) {
  return assert.rejects(fn, error => {
    assert.equal(error.status, status);
    clean([error.message, error.stack, error.cause, { ...error }]);
    return true;
  });
}
const body = (account, patch = {}) => ({ user: USER, password: PASSWORD, revision: account.status().revision, confirmHostStorage: true, receiveEnabled: true, sendEnabled: false, ...patch });

// 只实现真实抽象类规定的存储钩子，不复刻 update/merge/schema/CAS。
class MemorySettings extends SettingsProvider {
  writable = true;
  constructor(ctx, storage) { super(ctx); this.storage = storage; this.persisted = []; this.loads = 0; this.beforePersist = null; }
  async load() { this.loads++; return clone(this.storage.document); }
  async persist(ns, section) {
    this.persisted.push({ ns, section: clone(section) });
    await this.beforePersist?.(ns, section);
    this.storage.document[ns] = clone(section);
  }
  external(document) { this.storage.document = clone(document); this.publish(clone(document)); }
}
async function fixture(t, { row = {}, user, other = { 'other-plugin': { secret: SECRET, nested: { keep: [1, 2] } } }, storage, base, legacy = false } = {}) {
  const ctx = new Context();
  storage ??= { document: { ...clone(other), ...(user === undefined ? {} : { [NS]: clone(user) }) } };
  const provider = new MemorySettings(ctx, storage);
  const disposeInit = await ctx.effect(() => provider[Service.init]());
  t.after(async () => { await disposeInit(); await ctx.fiber.dispose(); });
  const settings = ctx.settings;
  const schemaModule = legacy ? legacyModule : mailModule;
  const scope = settings.register(NS, schemaModule.EmailSettingsSchema, { base: base ?? schemaModule.toSettingsBase(row), applies: 'live', validate: schemaModule.validateSettingsValue });
  const entry = { options: { name: NS }, disabled: false, fiber: { state: 2, config: clone(row) } };
  const plugin = { name: NS, installed: true, version: legacy ? legacyMeta.version : mailMeta.version };
  const access = { settings, entries: [entry], packages: [plugin] };
  const accountOptions = { getSettings: () => access.settings, getEntries: () => access.entries, getPlugins: () => ({ packages: access.packages }) };
  const account = new EmailAccount(accountOptions);
  const mutateCalls = [];
  const originalMutate = provider.mutate;
  assert.equal(originalMutate, SettingsProvider.prototype.mutate);
  t.mock.method(provider, 'mutate', function (...args) { mutateCalls.push(clone(args)); return originalMutate.apply(this, args); });
  return { ctx, provider, settings, storage, scope, entry, plugin, access, account, accountOptions, mutateCalls,
    descriptor: () => settings.describe().find(d => d.ns === NS),
    reopen: () => new EmailAccount(accountOptions),
    resolved: () => (legacy ? legacyConfig : mailConfig).resolveEmailConfig({ ...entry.fiber.config, ...schemaModule.toEmailConfig(scope.get(), provider.storage.document[NS]) }),
    view(change) { const describe = settings.describe.bind(settings); access.settings = { writable: true, describe: () => change(clone(describe())), mutate: settings.mutate.bind(settings) }; },
  };
}
async function closed(f) {
  snapshot(f.account.status());
  assert.equal(f.account.status().supported, false);
  const before = clone(f.storage.document);
  await rejects(() => f.account.save(body(f.account, { revision: '0'.repeat(64) })), 409);
  assert.deepEqual(f.storage.document, before);
  assert.equal(f.mutateCalls.length, 0);
}

async function apiFixture(t, config = {}) {
  const f = await fixture(t, config);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dataDir = mkdtempSync(join(root, 'http-'));
  const home = join(dataDir, 'isolated-home');
  mkdirSync(home, { mode: 0o700 });
  const logger = new Logger(dataDir);
  const logCalls = [];
  for (const method of ['info', 'warn', 'error']) {
    const original = logger[method];
    t.mock.method(logger, method, function (...args) { logCalls.push(args); return original.apply(this, args); });
  }
  logger.info('email.test.start', { isolated: true });
  const flags = { busy: false };
  let modelCalls = 0;
  const app = await startServer({ dataDir, home, port: 0, logger,
    createRuntime: () => ({ selection: () => ({}), status: async () => ({ configured: false }), async close() {}, async run() { modelCalls++; throw Error('禁止模型调用'); } }),
    createServices: () => ({ ...(config.missing ? {} : { emailAccount: f.account }), maintenance: { status: () => ({ running: flags.busy }), async close() {} } }),
  });
  const port = Number(new URL(app.url).port);
  allowedPorts.add(port);
  t.after(async () => { try { await app.close(); assert.equal(modelCalls, 0); } finally { allowedPorts.delete(port); logger.close(); } });
  let token;
  async function request(path = '/api/email/account', { method = 'GET', body: value, raw, headers = {} } = {}) {
    const requestHeaders = { connection: 'close', ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-claudia-token': token }), ...headers };
    for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
    return new Promise((resolve, reject) => {
      const req = httpRequest(new URL(path, app.url), { method, headers: requestHeaders, agent: false }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('error', reject);
        res.on('end', () => { try { resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null, raw: text, headers: res.headers }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.setTimeout(3000, () => req.destroy(Error('本机测试请求超时')));
      req.end(raw ?? (value === undefined ? undefined : JSON.stringify(value)));
    });
  }
  token = (await request('/api/bootstrap')).data.csrfToken;
  return { ...f, app, logger, logCalls, dataDir, flags, request, post: (value, headers) => request('/api/email/account', { method: 'POST', body: value, headers }) };
}

test('浏览器默认 favicon 请求返回204空正文，不产生404', options, async t => {
  const f = await apiFixture(t);
  const response = await f.request('/favicon.ico');
  assert.equal(response.status, 204);
  assert.equal(response.raw, '');
});

// 01
test('空账号 snapshot 严格投影、HMAC 稳定且不泄漏其它 namespace secret；文件守卫隔离真实设置', options, async t => {
  assert.throws(() => fs.readFileSync(join(dailyHome, 'email-account-test-denied')), { code: 'EMAIL_TEST_FORBIDDEN_HOME' });
  assert.throws(() => fs.writeFileSync(join(dailyHome, 'email-account-test-denied'), ''), { code: 'EMAIL_TEST_FORBIDDEN_HOME' });
  assert.ok(process.env.DSH_HOME.startsWith(root));
  const f = await fixture(t), state = f.account.status();
  snapshot(state); assert.equal(state.supported, true); assert.equal(state.user, ''); assert.equal(state.passwordSet, false);
  assert.equal(state.compatible, true); assert.equal(state.configured, false);
  assert.equal(state.receiveEnabled, true); assert.equal(state.sendEnabled, false);
  assert.deepEqual(f.account.status(), state); assert.equal(f.provider.persisted.length, 0);
  const d = f.descriptor();
  assert.equal(state.revision, createHmac('sha256', f.account.key).update(JSON.stringify([d.revision, f.entry.fiber.config, d.base, d.user, d.value])).digest('hex'));
});

// 02
test('真实已安装 SettingsProvider + 邮件 schema：持久存储钩子、重建 readback、校验与 CAS', options, async t => {
  const f = await fixture(t);
  assert.equal(hostMeta.version, '0.1.5-rc.2'); assert.equal(mailMeta.version, '0.11.0-claudia.2');
  assert.ok(f.provider instanceof SettingsProvider); assert.equal(f.provider.loads, 1);
  assert.equal(f.settings.documentPath, undefined);
  assert.deepEqual(f.descriptor().schema, EmailSettingsSchema.toJSON());
  t.mock.method(f.provider, 'register', () => assert.fail('EmailAccount 不得重复注册 namespace'));
  const revision = f.descriptor().revision;
  const saved = await f.account.save(body(f.account));
  snapshot(saved); assert.equal(saved.user, USER); assert.equal(saved.passwordSet, true);
  assert.equal(f.mutateCalls.length, 1); assert.equal(f.mutateCalls[0][0], NS); assert.equal(f.mutateCalls[0][2], revision);
  assert.equal(f.provider.persisted.length, 1); assert.equal(f.storage.document[NS].password, PASSWORD);
  assert.equal(f.scope.get().password, PASSWORD); assert.equal(f.descriptor().revision, revision + 1);
  const reopened = await fixture(t, { storage: f.storage });
  assert.equal(reopened.provider.loads, 1); assert.equal(reopened.scope.get().password, PASSWORD);
  assert.equal(reopened.account.status().user, USER);
  const before = clone(f.storage.document);
  for (const patch of [{ password: 123 }, { sendApproval: 'false' }, { receiveEnabled: 'true' }, { sendEnabled: 1 }, { maxBodyChars: 10 }, { imap: { port: 70000 } }]) {
    await assert.rejects(() => f.settings.update(NS, patch, f.descriptor().revision));
    assert.deepEqual(f.storage.document, before);
  }
  await assert.rejects(() => f.settings.update(NS, { user: NEXT_USER }, revision), error => error instanceof SettingsConflictError && error.code === 'SETTINGS_CONFLICT');
  assert.equal(f.provider.persisted.length, 1);
  const redacted = f.settings.describe({ redactSecrets: true }).find(d => d.ns === NS);
  clean(redacted); assert.equal(Object.hasOwn(redacted.value, 'password'), false);
  t.diagnostic(JSON.stringify({ host: hostMeta.version, hostModule: settingsPath, hostSHA256: sha(settingsPath), email: mailMeta.version, schemaModule: mailPath, schemaSHA256: sha(mailPath), schemaDependency, inheritedMutate: true, persistCalls: f.provider.persisted.length, reloadCalls: reopened.provider.loads, validationRejected: 6, staleCAS: 'SETTINGS_CONFLICT', realMailboxCalls: forbiddenNetwork }));
});

// 03
test('QQ 合成保存保留其它 namespace、文件夹、正文上限及 row，强制开启发信审批', options, async t => {
  const row = { inboxFolder: 'Archive', sendApproval: false, maxBodyChars: 12000, downloadDir: 'synthetic-downloads' };
  const f = await fixture(t, { row, user: { inboxFolder: 'Saved', maxBodyChars: 18000 } });
  const before = clone(f.storage.document), rowBefore = clone(f.entry.fiber.config);
  await f.account.save(body(f.account, { user: ` ${USER} `, password: ` ${PASSWORD} ` }));
  assert.deepEqual(f.storage.document['other-plugin'], before['other-plugin']);
  assert.equal(f.scope.get().inboxFolder, 'Saved'); assert.equal(f.scope.get().sendApproval, true);
  assert.equal(f.scope.get().maxBodyChars, 18000); assert.equal(f.scope.get().downloadDir, 'synthetic-downloads');
  assert.deepEqual(f.entry.fiber.config, rowBefore);
  assert.deepEqual(f.mutateCalls[0][1], [
    { op: 'set', path: ['provider'], value: 'qq' }, { op: 'set', path: ['user'], value: USER },
    { op: 'set', path: ['receiveEnabled'], value: true }, { op: 'set', path: ['sendEnabled'], value: false },
    { op: 'set', path: ['sendApproval'], value: true }, { op: 'set', path: ['password'], value: PASSWORD },
    { op: 'set', path: ['imap'], value: { host: 'imap.qq.com', port: 993, secure: true } }, { op: 'unset', path: ['smtp'] },
  ]);
  snapshot(f.account.status()); assert.equal(forbiddenNetwork, 0);
});

// 04
test('同一账号空授权码保留现有 user/base 密码，patch 不携带旧凭据', options, async t => {
  for (const layer of ['user', 'row']) {
    const f = await fixture(t, { [layer]: { provider: 'qq', user: USER, password: PASSWORD } });
    const saved = await f.account.save(body(f.account, { password: '  ' }));
    snapshot(saved); assert.equal(saved.passwordSet, true); assert.equal(f.scope.get().password, PASSWORD);
    assert.equal(f.mutateCalls[0][1].some(op => op.path[0] === 'password'), false);
    clean(f.mutateCalls);
    assert.equal(Object.hasOwn(f.storage.document[NS], 'password'), layer === 'user');
  }
});

// 05
test('首次配置或更换地址空 password 拒绝；新授权码可以更换 foxmail 地址', options, async t => {
  const empty = await fixture(t);
  await rejects(() => empty.account.save(body(empty.account, { password: '' })), 400);
  assert.equal(empty.mutateCalls.length, 0);
  const f = await fixture(t, { user: { provider: 'qq', user: USER, password: PASSWORD } });
  const before = clone(f.storage.document);
  for (const user of [NEXT_USER, USER.toUpperCase()]) await rejects(() => f.account.save(body(f.account, { user, password: '' })), 400);
  assert.deepEqual(f.storage.document, before); assert.equal(f.mutateCalls.length, 0);
  snapshot(await f.account.save(body(f.account, { user: NEXT_USER, password: NEXT_PASSWORD })));
  assert.equal(f.scope.get().user, NEXT_USER); assert.equal(f.scope.get().password, NEXT_PASSWORD);
});

// 06
test('严格 body：仅六个字段、明确同意、plain object；不接受高级字段或原型字段', options, async t => {
  const f = await fixture(t), valid = body(f.account), before = clone(f.storage.document);
  const invalid = [null, [], 'x', 1, true, {}, new Date(), Object.assign(Object.create({ inherited: true }), valid)];
  for (const key of Object.keys(valid)) { const missing = { ...valid }; delete missing[key]; invalid.push(missing); }
  for (const confirmHostStorage of [false, undefined, null, 'true', 1]) invalid.push({ ...valid, confirmHostStorage });
  for (const key of ['receiveEnabled', 'sendEnabled']) for (const value of [undefined, null, 'true', 1, [], {}]) invalid.push({ ...valid, [key]: value });
  for (const key of ['accounts', 'accountsYaml', 'imap', 'smtp', 'endpoint', 'provider', 'inboxFolder', 'sendApproval', 'maxBodyChars', 'config', '__proto__']) invalid.push({ ...valid, [key]: SECRET });
  for (const data of invalid) await rejects(() => f.account.save(data), 400);
  assert.deepEqual(f.storage.document, before); assert.equal(f.mutateCalls.length, 0);
});

// 07
test('严格 schema：非法账号、授权码和 revision 类型/长度/字符均无写入', options, async t => {
  const f = await fixture(t), valid = body(f.account);
  for (const user of [null, 12, {}, '', 'x@example.test', 'x@qq.com.invalid', 'x@y@qq.com', 'a\nb@qq.com', 'a'.repeat(101) + '@qq.com']) await rejects(() => f.account.save({ ...valid, user }), 400);
  for (const password of [null, 16, {}, [], 'a'.repeat(15), 'a'.repeat(17), '1234567890123456', 'abcd efghijklmno', '中'.repeat(16)]) await rejects(() => f.account.save({ ...valid, password }), 400);
  for (const revision of [null, 1, {}, [], '', 'f'.repeat(63), 'f'.repeat(65), 'F'.repeat(64), 'z'.repeat(64)]) await rejects(() => f.account.save({ ...valid, revision }), 400);
  assert.equal(f.mutateCalls.length, 0);
});

// 08
test('HMAC CAS 覆盖外部 user/revision/base/value 修改，包括数值 revision 不变的快照变化', options, async t => {
  for (const layer of ['external-user', 'raw-override', 'revision', 'base', 'user', 'value']) {
    const f = await fixture(t), valid = body(f.account);
    if (layer === 'external-user') f.provider.external({ ...f.storage.document, [NS]: { user: NEXT_USER } });
    else if (layer === 'raw-override') f.provider.external({ ...f.storage.document, [NS]: { inboxFolder: 'INBOX' } });
    else f.view(ds => { const d = ds.find(d => d.ns === NS); if (layer === 'revision') d.revision++; else d[layer] = { ...d[layer], inboxFolder: 'External' }; return ds; });
    assert.notEqual(f.account.status().revision, valid.revision);
    const before = clone(f.storage.document);
    await rejects(() => f.account.save(valid), 409);
    assert.deepEqual(f.storage.document, before); assert.equal(f.mutateCalls.length, 0);
  }
});

// 09
test('row 配置外部修改或新增 named accounts 后旧 token 拒绝', options, async t => {
  for (const change of [{ inboxFolder: 'External' }, { accounts: { hidden: { password: SECRET } } }]) {
    const f = await fixture(t), valid = body(f.account);
    Object.assign(f.entry.fiber.config, change);
    await rejects(() => f.account.save(valid), 409);
    assert.equal(f.mutateCalls.length, 0); assert.equal(f.provider.persisted.length, 0);
  }
});

// 10
test('不同 EmailAccount 实例 token 无效，篡改或已成功提交的旧 token 不可重放', options, async t => {
  const f = await fixture(t), valid = body(f.account), second = f.reopen();
  assert.notEqual(second.status().revision, valid.revision);
  await rejects(() => second.save(valid), 409);
  await rejects(() => f.account.save({ ...valid, revision: '0'.repeat(64) }), 409);
  await f.account.save(valid);
  await rejects(() => f.account.save(valid), 409);
  assert.equal(f.mutateCalls.length, 1); assert.equal(f.provider.persisted.length, 1);
});

// 11
test('active 未知/非 active、disabled 未知、重复条目或 group 一律拒绝', options, async t => {
  const changes = [
    ...[undefined, null, 0, 1, 3, 4, 5, '2'].map(state => f => { f.entry.fiber.state = state; }),
    ...[undefined, null, true, 'false'].map(disabled => f => { f.entry.disabled = disabled; }),
    f => { f.access.entries = []; }, f => { f.access.entries = null; },
    f => { f.access.entries.push(clone(f.entry)); }, f => { f.entry.options.group = true; },
    f => { f.entry.fiber.config = []; },
  ];
  for (const change of changes) { const f = await fixture(t); change(f); await closed(f); }
});

// 12
test('错误版本、未安装、readonly、缺 settings service 或不可信 descriptor 拒绝', options, async t => {
  const changes = [
    f => { f.plugin.version = '0.10.0'; }, f => { f.plugin.installed = false; }, f => { f.access.packages = []; },
    f => { f.access.packages.push(clone(f.plugin)); }, f => { f.access.settings = undefined; },
    f => { f.provider.writable = false; }, f => { f.provider.writable = 'true'; },
    f => { f.access.settings = { writable: true, describe() { return []; } }; },
    f => f.view(() => []), f => f.view(ds => [...ds, clone(ds[0])]),
    ...[undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(revision => f => f.view(ds => { ds[0].revision = revision; return ds; })),
    f => f.view(ds => { ds[0].applies = 'restart'; return ds; }),
    f => f.view(ds => { ds[0].value = null; return ds; }),
  ];
  for (const change of changes) { const f = await fixture(t); change(f); await closed(f); }
});

// 13
test('row/base/user/value 的 named accounts、高级配置或非 QQ 账号拒绝且不回显', options, async t => {
  for (const layer of ['row', 'base', 'user', 'value']) {
    for (const patch of [{ accounts: { work: { password: SECRET } } }, { accountsYaml: SECRET }, { serverPresets: SECRET }, { defaultAccount: SECRET }, { clientId: SECRET }, { provider: 'gmail' }]) {
      const f = await fixture(t);
      if (layer === 'row') Object.assign(f.entry.fiber.config, patch);
      else f.view(ds => { ds[0][layer] = { ...ds[0][layer], ...patch }; return ds; });
      await closed(f);
    }
  }
  for (const user of [{ user: 'outside@example.test', password: PASSWORD }, { user: 123, password: PASSWORD }, { user: USER, password: 123 }]) {
    const f = await fixture(t); f.view(ds => { Object.assign(ds[0].value, user); return ds; }); await closed(f);
  }
});

// 14
test('禁止各层自定义 endpoint、关闭 TLS、额外 endpoint 字段和错误类型', options, async t => {
  for (const layer of ['row', 'base', 'user', 'value']) {
    for (const endpoint of [{ host: 'mail.example.test' }, { port: 25 }, { secure: false }, { host: 'imap.qq.com', password: SECRET }, { port: '993' }, null, []]) {
      const f = await fixture(t), patch = { imap: endpoint };
      if (layer === 'row') Object.assign(f.entry.fiber.config, patch);
      else f.view(ds => { ds[0][layer] = { ...ds[0][layer], ...patch }; return ds; });
      await closed(f);
    }
  }
  const smtp = await fixture(t, { row: { smtp: { host: 'smtp.qq.com', port: 587, secure: true } } });
  await closed(smtp);
});

// 15
test('真实宿主队列产生 SETTINGS_CONFLICT，外部更新保留且不重试', options, async t => {
  const f = await fixture(t), valid = body(f.account), hostMutate = SettingsProvider.prototype.mutate;
  let external;
  t.mock.method(f.provider, 'mutate', function (ns, ops, revision) {
    external = hostMutate.call(this, ns, [{ op: 'set', path: ['inboxFolder'], value: 'External' }], revision);
    return hostMutate.call(this, ns, ops, revision);
  });
  await rejects(() => f.account.save(valid), 409); await external;
  assert.equal(f.scope.get().inboxFolder, 'External'); assert.equal(f.scope.get().password, '');
  assert.equal(f.provider.persisted.length, 1);
});

// 16
test('原始异常携带 secret/status/message/stack/cause 均不泄漏，不信任伪装安全 status', options, async t => {
  for (const point of ['settings', 'entries', 'plugins', 'describe', 'mutate']) {
    for (const status of [400, 409, 503]) {
      const f = await fixture(t), valid = body(f.account);
      const fail = () => { throw poisoned(status); };
      if (point === 'settings') f.account.getSettings = fail;
      if (point === 'entries') f.account.getEntries = fail;
      if (point === 'plugins') f.account.getPlugins = fail;
      if (point === 'describe') t.mock.method(f.provider, 'describe', fail);
      if (point === 'mutate') t.mock.method(f.provider, 'mutate', fail);
      if (point !== 'mutate') { const state = f.account.status(); snapshot(state); assert.equal(state.supported, false); }
      await rejects(() => f.account.save(valid), 503);
      assert.equal(f.provider.persisted.length, 0);
    }
  }
});

// 17
test('提交已落入内存存储但确认失败时只读回，不重放；保存后状态漂移明确失败', options, async t => {
  const f = await fixture(t), valid = body(f.account);
  f.provider.beforePersist = (ns, section) => { f.storage.document[ns] = clone(section); throw poisoned(409); };
  await rejects(() => f.account.save(valid), 503);
  assert.equal(f.storage.document[NS].password, PASSWORD); assert.equal(f.scope.get().password, '');
  await tick(); assert.equal(f.mutateCalls.length, 1); assert.equal(f.provider.persisted.length, 1);
  f.provider.publish(await f.provider.load());
  snapshot(f.account.status()); assert.equal(f.account.status().passwordSet, true);
  await rejects(() => f.account.save(valid), 409);
  assert.equal(f.mutateCalls.length, 1);
  for (const change of ['user', 'provider', 'entry', 'settings']) {
    const g = await fixture(t), mutate = SettingsProvider.prototype.mutate;
    t.mock.method(g.provider, 'mutate', async function (...args) {
      await mutate.apply(this, args);
      if (change === 'user') g.provider.external({ ...g.storage.document, [NS]: { ...g.storage.document[NS], user: NEXT_USER } });
      if (change === 'provider') g.provider.external({ ...g.storage.document, [NS]: { ...g.storage.document[NS], provider: '' } });
      if (change === 'entry') g.access.entries = [clone(g.entry)];
      if (change === 'settings') g.view(ds => ds);
    });
    await rejects(() => g.account.save(body(g.account)), 503);
    assert.equal(g.provider.persisted.length, 1); assert.equal(g.account.writing, false);
  }
});

// 18
test('同实例并发提交只进入一次 mutate，锁在异常后释放', options, async t => {
  const f = await fixture(t), valid = body(f.account), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.provider.beforePersist = async () => { entered.resolve(); await release.promise; };
  const saving = f.account.save(valid);
  try { await entered.promise; await rejects(() => f.account.save(valid), 409); assert.equal(f.mutateCalls.length, 1); }
  finally { release.resolve(); }
  snapshot(await saving); assert.equal(f.account.writing, false);
  f.provider.beforePersist = () => { throw poisoned(500); };
  await rejects(() => f.account.save(body(f.account, { password: NEXT_PASSWORD })), 503);
  assert.equal(f.account.writing, false);
});

// 19
test('真实 HTTP 合成保存/readback，无凭据响应、state/logger 或磁盘副本；不验证邮箱连接', options, async t => {
  const f = await apiFixture(t), first = await f.request();
  assert.equal(first.status, 200); snapshot(first.data);
  const response = await f.post({ ...body(f.account), revision: first.data.revision });
  assert.equal(response.status, 200); snapshot(response.data); assert.equal(response.data.passwordSet, true);
  assert.match(response.data.message, /不等于已验证邮箱连接/);
  assert.deepEqual((await f.request()).data, response.data);
  assert.equal(f.storage.document[NS].password, PASSWORD); assert.equal(f.provider.persisted.length, 1);
  assert.equal(response.headers['cache-control'], 'no-store');
  clean((await f.request('/api/state')).raw); clean((await f.request('/api/logs')).raw);
  assert.ok(f.logger.recent().some(line => line.includes('email.test.start')));
  clean(f.logCalls); clean(f.logger.recent());
  function scan(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) scan(path); else clean(readFileSync(path).toString('utf8')); } }
  scan(f.dataDir); assert.equal(forbiddenNetwork, 0);
});

// 20
test('真实 HTTP CSRF、Origin、Host、跨站标记与方法限制先拒绝再写入', options, async t => {
  const f = await apiFixture(t), valid = body(f.account);
  for (const headers of [{ 'x-claudia-token': undefined }, { 'x-claudia-token': 'wrong' }, { 'content-type': 'text/plain' }, { 'content-type': undefined }, { host: 'invalid.local' }, { origin: 'http://localhost:1' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await f.post(valid, headers); assert.equal(response.status, 403); clean(response.raw);
  }
  assert.equal((await f.request('/api/email/account', { headers: { origin: 'http://localhost:1' } })).status, 403);
  assert.equal((await f.request('/api/email/account', { method: 'PUT', body: valid })).status, 405);
  assert.equal((await f.request('/api/email/account', { method: 'DELETE', body: valid })).status, 404);
  assert.equal(f.mutateCalls.length, 0);
  assert.equal((await f.post(valid, { origin: f.app.url })).status, 200);
});

// 21
test('真实 HTTP 4096 字节边界、UTF-8 字节数、畸形 JSON 和严格 body/schema', options, async t => {
  const f = await apiFixture(t), valid = body(f.account);
  for (const raw of ['{', 'null', '[]', 'true', '"text"', '', JSON.stringify({ ...valid, extra: SECRET }), JSON.stringify({ ...valid, password: 123 }), JSON.stringify({ ...valid, confirmHostStorage: false })]) {
    const response = await f.request('/api/email/account', { method: 'POST', raw });
    assert.equal(response.status, 400); clean(response.raw);
  }
  const prefix = JSON.stringify(valid);
  const exact = prefix + ' '.repeat(4096 - Buffer.byteLength(prefix));
  for (const raw of [exact + ' ', JSON.stringify({ ...valid, extra: '中'.repeat(1500) })]) {
    const response = await f.request('/api/email/account', { method: 'POST', raw });
    assert.equal(response.status, 413); clean(response.raw);
  }
  assert.equal(f.mutateCalls.length, 0);
  assert.equal((await f.request('/api/email/account', { method: 'POST', raw: exact })).status, 200);
  assert.equal(f.provider.persisted.length, 1);
});

// 22
test('真实 HTTP 原始异常 status/secret 不进响应及 logger，冲突/不确定提交不会重放', options, async t => {
  const f = await apiFixture(t), valid = body(f.account);
  const originalSave = f.account.save.bind(f.account);
  for (const status of [400, 409, 418, 500, 503]) {
    f.account.save = async () => { throw poisoned(status); };
    const response = await f.post(valid);
    assert.equal(response.status, [400, 409].includes(status) ? status : 503); clean(response.raw);
    assert.equal((await f.request('/api/health')).data.busy, false);
  }
  f.account.save = originalSave;
  const originalMutate = f.provider.mutate;
  f.provider.mutate = async () => { throw Object.assign(poisoned(500), { code: 'SETTINGS_CONFLICT' }); };
  assert.equal((await f.post(valid)).status, 409);
  f.provider.mutate = originalMutate;
  f.provider.beforePersist = (ns, section) => { f.storage.document[ns] = clone(section); throw poisoned(400); };
  const uncertain = await f.post(valid); assert.equal(uncertain.status, 503); clean(uncertain.raw);
  await tick(); assert.equal(f.provider.persisted.length, 1); assert.equal(f.mutateCalls.length, 1);
  f.provider.publish(await f.provider.load());
  assert.equal((await f.post(valid)).status, 409); assert.equal(f.mutateCalls.length, 1);
  clean(f.logCalls); clean(f.logger.recent()); clean((await f.request('/api/logs')).raw);
  assert.equal(f.logCalls.filter(([event]) => event === 'http.error').length, 0, '原始异常不得进入通用 logger');
});

test('原版真实 schema 只读显示 SMTP 预设能力，拒绝新权限保存和 review 绑定', options, async t => {
  const f = await fixture(t, { legacy: true, user: { provider: 'qq', user: USER, password: PASSWORD } });
  assert.equal(legacyMeta.version, '0.11.0');
  assert.equal(Object.hasOwn(f.scope.get(), 'receiveEnabled'), false);
  assert.equal(Object.hasOwn(f.scope.get(), 'sendEnabled'), false);
  const state = f.account.status(), before = clone(f.storage.document);
  snapshot(state); assert.equal(state.supported, true); assert.equal(state.configured, true);
  assert.equal(state.compatible, false); assert.equal(state.receiveEnabled, true); assert.equal(state.sendEnabled, true);
  assert.equal(f.resolved().smtp.host, 'smtp.qq.com');
  assert.equal(f.resolved().imap.host, 'imap.qq.com');
  assert.match(state.message, /仅可查看/);
  await rejects(() => f.account.save(body(f.account)), 409);
  await rejects(async () => f.account.binding(state.revision), 409);
  assert.deepEqual(f.storage.document, before); assert.equal(f.mutateCalls.length, 0);
  f.provider.writable = false;
  snapshot(f.account.status()); assert.equal(f.account.status().supported, true);
  assert.equal(f.provider.persisted.length, 0);
});

test('真实 HTTP 原版账号可读但不允许提交新权限', options, async t => {
  const f = await apiFixture(t, { legacy: true, user: { provider: 'qq', user: USER, password: PASSWORD } });
  const response = await f.request();
  assert.equal(response.status, 200); snapshot(response.data);
  assert.equal(response.data.compatible, false); assert.equal(response.data.sendEnabled, true);
  assert.equal((await f.post(body(f.account))).status, 409);
  assert.equal(f.provider.persisted.length, 0);
});

test('包版本虽为兼容版但仍加载原版 schema 时拒绝，不能伪造新默认', options, async t => {
  const f = await fixture(t, { legacy: true });
  f.plugin.version = mailMeta.version;
  await closed(f);
});

test('配置判定必须同时有账号和授权码，读取及重建实例绝不自动写入或清凭据', options, async t => {
  for (const user of [{}, { user: USER }, { password: PASSWORD }, { user: USER, password: PASSWORD }]) {
    const f = await fixture(t, { user }), before = clone(f.storage.document);
    const state = f.account.status(); snapshot(state);
    assert.equal(state.configured, Boolean(user.user && user.password));
    snapshot(f.reopen().status());
    assert.deepEqual(f.storage.document, before); assert.equal(f.mutateCalls.length, 0);
    assert.equal(f.provider.persisted.length, 0);
  }
});

test('四种收发权限单次 CAS 原子 set/unset，真实解析不补齐禁用协议，重建回读一致', options, async t => {
  const endpoints = { imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true } };
  for (const receiveEnabled of [true, false]) for (const sendEnabled of [false, true]) {
    const user = { provider: 'qq', user: USER, password: PASSWORD, ...endpoints, receiveEnabled: !receiveEnabled, sendEnabled: !sendEnabled, sendApproval: false, inboxFolder: 'INBOX', maxBodyChars: 13000 };
    const f = await fixture(t, { user }), before = clone(f.storage.document), revision = f.descriptor().revision;
    t.mock.method(f.provider, 'update', () => assert.fail('桥接不得分两次 merge 写入'));
    t.mock.method(f.provider, 'replace', () => assert.fail('桥接不得替换整个用户层'));
    const persisted = [];
    f.provider.beforePersist = (ns, section) => { persisted.push(clone(section)); assert.equal(ns, NS); };
    const result = await f.account.save(body(f.account, { password: '', receiveEnabled, sendEnabled }));
    snapshot(result); assert.equal(result.receiveEnabled, receiveEnabled); assert.equal(result.sendEnabled, sendEnabled);
    assert.equal(result.configured, true); assert.equal(f.mutateCalls.length, 1);
    assert.equal(f.mutateCalls[0][2], revision); assert.equal(f.descriptor().revision, revision + 1);
    assert.equal(f.provider.persisted.length, 1); assert.deepEqual(persisted, [f.storage.document[NS]]);
    assert.equal(f.scope.get().sendApproval, true); assert.equal(f.storage.document[NS].password, PASSWORD);
    assert.equal(f.storage.document[NS].maxBodyChars, 13000);
    assert.deepEqual(f.storage.document['other-plugin'], before['other-plugin']);
    clean(f.mutateCalls);
    const resolved = f.resolved();
    for (const [kind, enabled] of [['imap', receiveEnabled], ['smtp', sendEnabled]]) {
      assert.equal(Object.hasOwn(f.storage.document[NS], kind), enabled);
      assert.equal(Object.hasOwn(resolved, kind), enabled, '底层 resolved 禁用协议必须没有对应键');
      assert.equal(f.mutateCalls[0][1].find(op => op.path[0] === kind).op, enabled ? 'set' : 'unset');
      if (enabled) {
        assert.deepEqual(f.storage.document[NS][kind], endpoints[kind]);
        for (const key of ['host', 'port', 'secure']) assert.equal(resolved[kind][key], endpoints[kind][key]);
      }
    }
    const reopened = await fixture(t, { storage: f.storage });
    const reloaded = reopened.account.status(); snapshot(reloaded);
    assert.equal(reloaded.receiveEnabled, receiveEnabled); assert.equal(reloaded.sendEnabled, sendEnabled);
    assert.equal(Object.hasOwn(reopened.resolved(), 'imap'), receiveEnabled);
    assert.equal(Object.hasOwn(reopened.resolved(), 'smtp'), sendEnabled);
    assert.equal(reopened.provider.persisted.length, 0);
  }
});

test('禁用协议清理用户层，保留 row/base 标准残留且明确提示运行解析忽略', options, async t => {
  const endpoints = { imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true } };
  const row = { provider: 'qq', user: USER, password: PASSWORD, ...endpoints };
  const f = await fixture(t, { row, user: { ...endpoints } }), before = clone(f.entry.fiber.config), base = clone(f.descriptor().base);
  const initial = f.account.status();
  assert.match(initial.message, /存储层残留/); assert.equal(f.provider.persisted.length, 0);
  const saved = await f.account.save(body(f.account, { password: '', receiveEnabled: false, sendEnabled: false }));
  assert.match(saved.message, /运行解析不会使用/); assert.match(saved.message, /不重写 profile/);
  assert.deepEqual(f.entry.fiber.config, before); assert.deepEqual(f.descriptor().base, base);
  for (const kind of ['imap', 'smtp']) {
    assert.equal(Object.hasOwn(f.storage.document[NS], kind), false);
    assert.equal(Object.hasOwn(f.resolved(), kind), false);
    assert.equal(f.descriptor().base[kind].host, endpoints[kind].host);
  }
  assert.equal(f.scope.get().password, PASSWORD); assert.equal(f.provider.persisted.length, 1);
});

test('相同配置重复保存可以无 revision 变化，授权码不复制到用户层', options, async t => {
  const f = await fixture(t, { row: { provider: 'qq', user: USER, password: PASSWORD } });
  const first = await f.account.save(body(f.account, { password: '' }));
  const revision = f.descriptor().revision;
  const second = await f.account.save(body(f.account, { password: '' }));
  assert.deepEqual(second, first); assert.equal(f.descriptor().revision, revision);
  assert.equal(Object.hasOwn(f.storage.document[NS], 'password'), false);
  assert.equal(f.mutateCalls.length, 2); clean(f.mutateCalls);
});

test('权限/审批/密码/endpoint/row 回读漂移和假成功不得报告已保存', options, async t => {
  for (const change of ['receiveEnabled', 'sendEnabled', 'sendApproval', 'password', 'imap', 'smtp', 'row', 'base', 'version', 'no-write']) {
    const f = await fixture(t, { user: { provider: 'qq', user: USER, password: PASSWORD } });
    const original = f.provider.mutate;
    t.mock.method(f.provider, 'mutate', async function (...args) {
      if (change === 'no-write') return;
      await original.apply(this, args);
      if (change === 'row') f.entry.fiber.config.maxBodyChars = 17000;
      else if (change === 'version') f.plugin.version = '0.11.0';
      else {
        const describe = f.provider.describe;
        t.mock.method(f.provider, 'describe', function (...args) {
          const ds = describe.apply(this, args), d = ds.find(d => d.ns === NS);
          if (change === 'base') d.base.maxBodyChars = 17000;
          if (change === 'receiveEnabled') d.value.receiveEnabled = false;
          if (change === 'sendEnabled') d.value.sendEnabled = true;
          if (change === 'sendApproval') d.value.sendApproval = false;
          if (change === 'password') d.value.password = NEXT_PASSWORD;
          if (change === 'imap') d.value.imap.host = '';
          if (change === 'smtp') d.user.smtp = { host: 'smtp.qq.com', port: 465, secure: true };
          return ds;
        });
      }
    });
    await rejects(() => f.account.save(body(f.account, { password: '' })), 503);
    assert.equal(f.provider.persisted.length, change === 'no-write' ? 0 : 1);
    assert.equal(f.account.writing, false);
  }
});

test('binding 仅提供可信安全 snapshot 与 INBOX，拒绝无账号、禁收、旧 token、其它文件夹和保存中', options, async t => {
  const f = await fixture(t, { user: { provider: 'qq', user: USER, password: PASSWORD } });
  const revision = f.account.status().revision, bound = f.account.binding(revision);
  assert.deepEqual(Object.keys(bound).sort(), ['folder', 'snapshot']); assert.equal(bound.folder, 'INBOX');
  snapshot(bound.snapshot); clean(bound); assert.deepEqual(bound.snapshot, f.account.status());
  for (const token of [undefined, null, 1, '', '0'.repeat(64), f.reopen().status().revision]) await rejects(async () => f.account.binding(token), 409);
  f.account.writing = true;
  await rejects(async () => f.account.binding(revision), 409);
  f.account.writing = false;
  await f.account.save(body(f.account, { password: '', receiveEnabled: false }));
  await rejects(async () => f.account.binding(f.account.status().revision), 409);
  for (const user of [{}, { user: USER }, { provider: 'qq', user: USER, password: PASSWORD, inboxFolder: 'Archive' }]) {
    const g = await fixture(t, { user }); await rejects(async () => g.account.binding(g.account.status().revision), 409);
    assert.equal(g.provider.persisted.length, 0);
  }
  f.account.getSettings = () => { throw poisoned(400); };
  await rejects(async () => f.account.binding(revision), 503);
});

// 23
test('真实 HTTP 缺服务/不可读快照/忙状态安全失败，恢复后仍可保存', options, async t => {
  const missing = await apiFixture(t, { missing: true });
  const state = await missing.request(); snapshot(state.data); assert.equal(state.data.supported, false);
  assert.equal((await missing.post(body(missing.account))).status, 503);
  const f = await apiFixture(t), valid = body(f.account), getSettings = f.account.getSettings;
  f.account.getSettings = () => { throw poisoned(400); };
  const unreadable = await f.request(); snapshot(unreadable.data); assert.equal(unreadable.data.supported, false);
  assert.equal((await f.post(valid)).status, 503);
  f.account.getSettings = getSettings;
  f.flags.busy = true; assert.equal((await f.post(valid)).status, 409); assert.equal(f.mutateCalls.length, 0);
  f.flags.busy = false; assert.equal((await f.post(valid)).status, 200);
  clean(f.logCalls); clean(f.logger.recent());
});
