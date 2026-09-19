import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { startServer } from '../server.mjs';
import { Store } from '../store.mjs';
import { Logger } from '../logger.mjs';

// 仅测试 fake review 与真实 server/Store 的 HTTP 契约，不导入邮箱/模型运行时。
// 保留自有测试目录供检查；不替换 Records 锁/写入实现，不绕过环境删除守卫。
const project = fileURLToPath(new URL('../', import.meta.url));
const root = join(project, '.tools', `email-review-api-${randomUUID()}`);
const envKeys = ['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DSH_EMAIL_PASSWORD'];
const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
for (const key of envKeys) process.env[key] = key === 'DSH_EMAIL_PASSWORD' ? '' : join(root, key.toLowerCase());
let forbiddenHome = 0, forbiddenNetwork = 0;
const dailyHomes = [...new Set([env.HOME && join(env.HOME, '.dsh')].filter(Boolean))];
function guardPath(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return;
  const path = resolve(value);
  if (dailyHomes.some(home => path === home || path.startsWith(home + '/'))) {
    forbiddenHome++;
    throw Error('测试禁止访问日常 Harness 目录');
  }
}
for (const api of [fs, fsp]) for (const name of ['access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lstat', 'link', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'symlink', 'truncate', 'unlink', 'utimes', 'watch', 'watchFile', 'writeFile', 'createReadStream', 'createWriteStream']) {
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
const ports = new Set(), connect = net.Socket.prototype.connect;
mock.method(net.Socket.prototype, 'connect', function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof normalized[0] === 'object' ? normalized[0] : { port: normalized[0], host: normalized[1] };
  if (options.path || !['127.0.0.1', 'localhost'].includes(options.host) || !ports.has(Number(options.port))) {
    forbiddenNetwork++;
    throw Error('测试仅允许自有 HTTP 回环连接');
  }
  return connect.apply(this, args);
});
mock.method(tls, 'connect', () => { forbiddenNetwork++; throw Error('测试禁止 TLS/邮箱连接'); });
mock.method(globalThis, 'fetch', () => { forbiddenNetwork++; throw Error('测试禁止外部 fetch'); });
syncBuiltinESMExports();
const sources = ['server.mjs', 'store.mjs', 'records.mjs'].map(name => join(project, name));
const hash = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const hashes = sources.map(hash);
after(t => {
  try {
    assert.equal(forbiddenHome, 0); assert.equal(forbiddenNetwork, 0);
    assert.deepEqual(sources.map(hash), hashes, 'API 测试不得改写生产文件');
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    if (fs.existsSync(root)) t.diagnostic(`测试目录保留，未执行清理：${root}`);
  }
});

const SECRET = 'SYNTHETIC_REVIEW_PRIVATE_ERROR';
const PASSWORD = 'abcdefghijklmnop';
const RAW_BODY = 'SYNTHETIC_RAW_MAIL_BODY_ONLY_IN_MEMORY';
const SUMMARY = '合成摘要：有一项待核对的安排，尚未执行任何操作。';
const REQUEST_TEXT = '帮我看看最近一周的邮件标题里，有哪些值得我看一下';
const CLAIM = 'synthetic-email-review-request:';
const revision = 'b'.repeat(64);
const selection = { provider: 'synthetic-provider', model: 'synthetic-model', reasoningEffort: 'low' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clone = x => structuredClone(x);
const tick = () => new Promise(resolve => setImmediate(resolve));
const poison = status => Object.assign(Error(`${SECRET} ${PASSWORD} ${RAW_BODY}`), { status, cause: Error(SECRET) });
function safe(value, persisted = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [SECRET, PASSWORD, ...(persisted ? [RAW_BODY] : [])]) assert.equal(text.includes(secret), false, '未知错误、授权码或原始正文不得泄漏');
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`等待测试事件超时：${label}`)), 3000); })]); }
  finally { clearTimeout(timer); }
}
const input = patch => ({ revision, selection: clone(selection), confirmDataSharing: true, requestId: randomUUID(), days: 7, prompt: REQUEST_TEXT, ...patch });

// 此 fake 仅定义接线合同：真实严格校验/跨实例防重放由 EmailReview 自身测试负责。
class FakeReview {
  constructor(store, events) {
    this.store = store; this.events = events; this.previews = 0; this.validations = []; this.runs = []; this.tasks = new Set();
    this.behavior = async (_data, { onStatus, onDelta }) => {
      onStatus('正在处理合成数据');
      onDelta(RAW_BODY); // 故意提供不应写入历史的中间内容，核对服务端仅保存最终摘要。
      return { text: SUMMARY, reason: { kind: 'completed' }, excerpts: [{ text: RAW_BODY }] };
    };
  }
  preview(days = 7) {
    this.previews++;
    return { supported: true, revision, selection: clone(selection), window: { days, since: '2026-09-13', until: '2026-09-19' },
      reading: { fields: ['subject', 'from'], pageSize: 100, maxMessages: null, readsBodies: false, readsAttachments: false }, message: '合成预览；不读取邮箱。' };
  }
  validate(data) {
    this.validations.push(clone(data));
    if (Object.keys(data).sort().join(',') !== 'confirmDataSharing,days,prompt,requestId,revision,selection' || data.confirmDataSharing !== true ||
        data.revision !== revision || ![7, 30, 365].includes(data.days) || typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 500 ||
        !uuid.test(data.requestId) || !data.selection || JSON.stringify(data.selection) !== JSON.stringify(selection) ||
        this.store.get(CLAIM + data.requestId.toLowerCase()) !== null) throw poison(400);
    this.validated = { ...clone(data), requestId: data.requestId.toLowerCase() };
    return this.validated;
  }
  run(data, options) {
    assert.equal(data, this.validated, '服务端须传递 validate 返回的对象，不得重新使用原始 body');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(this.store.get(CLAIM + data.requestId), null);
    this.store.set(CLAIM + data.requestId, { requestId: data.requestId, status: 'claimed' });
    this.runs.push({ data: clone(data), signal: options.signal });
    const behavior = this.behavior;
    const task = Promise.resolve().then(() => behavior(data, options)).finally(() => this.tasks.delete(task));
    this.tasks.add(task); this.lastTask = task;
    return task;
  }
  close() {
    this.events.push('review.close.begin');
    return Promise.allSettled([...this.tasks]).then(() => { this.events.push('review.close.end'); });
  }
}

async function fixture(t) {
  fs.mkdirSync(root, { mode: 0o700 });
  const home = join(root, 'isolated-home'); fs.mkdirSync(home, { mode: 0o700 });
  const logger = new Logger(root), logs = [], events = [], runtimeCalls = { run: 0, cancel: 0, close: 0 }, flags = { busy: false };
  for (const method of ['info', 'warn', 'error']) {
    const original = logger[method];
    t.mock.method(logger, method, function (...args) { logs.push(args); return original.apply(this, args); });
  }
  let review, app, closePromise, token;
  const streams = new Set();
  t.after(async () => {
    try {
      for (const stream of streams) stream.abort();
      await close();
      assert.equal(runtimeCalls.run, 0, '不得调用普通聊天模型');
    } finally { logger.close(); }
  });
  // 保持真正 Store 初始化；若环境阻断锁文件释放，直接失败，不伪造初始化成功。
  app = await startServer({ dataDir: root, home, port: 0, logger,
    createRuntime: () => ({ selection: () => clone(selection), status: async () => ({ configured: true }),
      async run() { runtimeCalls.run++; throw Error('禁止模型调用'); },
      async cancel() { runtimeCalls.cancel++; events.push('runtime.cancel'); },
      async close() { runtimeCalls.close++; events.push('runtime.close'); },
    }),
    createServices: ({ store }) => {
      review = new FakeReview(store, events);
      return { emailReview: review, maintenance: { status: () => ({ running: flags.busy }), async close() { events.push('maintenance.close'); } } };
    },
  });
  assert.ok(app.store instanceof Store);
  const port = Number(new URL(app.url).port); ports.add(port);
  function close() {
    if (!app) return Promise.resolve();
    return closePromise ??= app.close().finally(() => ports.delete(port));
  }
  function open(path, { method = 'GET', body, raw, headers = {} } = {}) {
    const done = Promise.withResolvers(), started = Promise.withResolvers();
    done.promise.catch(() => {}); started.promise.catch(() => {});
    let response, text = '', pending = '', events = [];
    const requestHeaders = { connection: 'close', ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-claudia-token': token }), ...headers };
    for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
    const req = httpRequest(new URL(path, app.url), { method, headers: requestHeaders, agent: false }, res => {
      response = res; res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (!res.headers['content-type']?.includes('ndjson')) return;
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line) continue;
          try { const event = JSON.parse(line); events.push(event); if (event.type === 'start') started.resolve(event); }
          catch (error) { done.reject(error); }
        }
      });
      res.on('error', error => { done.reject(error); started.reject(error); });
      res.on('end', () => {
        try {
          const data = res.headers['content-type']?.includes('ndjson') ? null : text ? JSON.parse(text) : null;
          done.resolve({ status: res.statusCode, headers: res.headers, raw: text, data, events });
        } catch (error) { done.reject(error); }
      });
    });
    req.on('error', error => { done.reject(error); started.reject(error); });
    req.setTimeout(3000, () => req.destroy(Error('测试 HTTP 超时')));
    const stream = { done: done.promise, started: started.promise, abort() { response?.destroy(); req.destroy(); } };
    streams.add(stream);
    done.promise.then(() => streams.delete(stream), () => streams.delete(stream));
    req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
    return stream;
  }
  async function request(path, options) { return bounded(open(path, options).done, path); }
  token = (await request('/api/bootstrap')).data.csrfToken;
  return { app, review, flags, events, logs, logger, runtimeCalls, close, open, request,
    post: (body, options = {}) => request('/api/email/review', { method: 'POST', body, ...options }),
    messages: () => app.store.messages(),
  };
}
function hold(f) {
  const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), release = Promise.withResolvers();
  const state = { entered: entered.promise, aborted: aborted.promise, release: () => release.resolve(), aborts: 0 };
  f.review.behavior = async (_input, { signal, onDelta }) => {
    const onAbort = () => { state.aborts++; aborted.resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    entered.resolve(signal); onDelta(RAW_BODY);
    try { await release.promise; if (signal.aborted) throw poison(503); return { text: SUMMARY, reason: { kind: 'completed' } }; }
    finally { signal.removeEventListener('abort', onAbort); }
  };
  return state;
}
function scanStored() {
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path); else safe(fs.readFileSync(path).toString('utf8'), true);
    }
  }
  visit(root);
}

// 共用一次真实 Store 初始化；初始化失败时不反复制造目录或将后续子测试报为通过。
test('邮件分析 API：自有 loopback、fake review 与真实 server/Store', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  await t.test('预览只调用 preview，不 validate/run、不写消息或登记请求', async () => {
    const before = f.messages();
    for (const [path, days] of [['/api/email/review/preview', 7], ['/api/email/review/preview?days=365', 365]]) {
      const response = await f.request(path);
      assert.equal(response.status, 200); assert.equal(response.data.revision, revision); assert.equal(response.data.window.days, days); safe(response.raw, true);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(f.review.previews, 2); assert.equal(f.review.validations.length, 0); assert.equal(f.review.runs.length, 0);
    assert.deepEqual(f.messages(), before);
    assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM settings WHERE key LIKE ?').get(CLAIM + '%').n, 0);
  });
  await t.test('CSRF、Origin、Host、跨站标记和方法在 validate/run 之前拒绝', async () => {
    const count = f.review.validations.length;
    for (const headers of [{ 'x-claudia-token': undefined }, { 'x-claudia-token': 'wrong' }, { 'content-type': undefined }, { 'content-type': 'text/plain' }, { origin: 'http://localhost:1' }, { origin: 'null' }, { host: 'invalid.local' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await f.post(input(), { headers }); assert.equal(response.status, 403); safe(response.raw, true);
    }
    assert.equal((await f.request('/api/email/review/preview', { headers: { origin: 'http://localhost:1' } })).status, 403);
    assert.equal((await f.request('/api/email/review', { method: 'PUT', body: input() })).status, 405);
    assert.equal(f.review.validations.length, count); assert.equal(f.review.runs.length, 0); assert.equal(f.messages().length, 0);
  });
  await t.test('严格校验委托完整 body，畸形 JSON/超长正文直接拒绝，不允许高级字段或缺少确认', async () => {
    const valid = input(), invalid = [];
    for (const key of Object.keys(valid)) { const data = clone(valid); delete data[key]; invalid.push(data); }
    for (const key of ['folder', 'endpoint', 'smtp', 'body', 'uids', 'sendEnabled', 'extra']) invalid.push({ ...valid, [key]: SECRET });
    for (const patch of [{ confirmDataSharing: false }, { confirmDataSharing: 'true' }, { revision: 'stale' }, { days: 8 }, { prompt: '' }, { prompt: 'x'.repeat(501) },
      { requestId: 1 }, { requestId: 'invalid' }, { selection: { ...selection, model: 'other' } }, { selection: { ...selection, endpoint: SECRET } }]) invalid.push({ ...valid, ...patch });
    for (const data of invalid) { const response = await f.post(data); assert.equal(response.status, 409); safe(response.raw, true); assert.deepEqual(f.review.validations.at(-1), data); }
    const before = f.review.validations.length;
    for (const raw of ['{', 'null', '[]', 'true', JSON.stringify({ ...valid, body: 'x'.repeat(4096) })]) {
      const response = await f.post(undefined, { raw }); assert.equal(response.status, raw.length > 4096 ? 413 : 400); safe(response.raw, true);
    }
    assert.equal(f.review.validations.length, before); assert.equal(f.review.runs.length, 0); assert.equal(f.messages().length, 0);
  });
  await t.test('忙状态不登记请求，执行中阻止新分析/聊天/配置/重置，未完成正文不落盘', async () => {
    f.flags.busy = true;
    const before = f.review.validations.length, body = input();
    try { assert.equal((await f.post(body)).status, 409); assert.equal(f.review.validations.length, before); }
    finally { f.flags.busy = false; }
    const gate = hold(f), stream = f.open('/api/email/review', { method: 'POST', body });
    try {
      await bounded(stream.started, 'start'); await bounded(gate.entered, 'review.run');
      assert.equal((await f.request('/api/health')).data.busy, true);
      assert.equal((await f.post(input())).status, 409);
      for (const [path, body] of [['/api/chat', { text: '不要开始普通聊天' }], ['/api/session/reset', {}], ['/api/email/account', {}], ['/api/settings', {}]]) {
        assert.equal((await f.request(path, { method: 'POST', body })).status, 409);
      }
      const current = f.messages().at(-1); assert.equal(current.status, 'pending'); assert.equal(current.content, '');
      safe((await f.request('/api/state')).raw, true); scanStored();
    } finally { gate.release(); }
    const response = await bounded(stream.done, 'done');
    assert.equal(response.status, 200); assert.ok(response.events.some(event => event.type === 'done'));
    assert.equal(f.messages().at(-1).content, SUMMARY); assert.equal((await f.request('/api/health')).data.busy, false);
  });
  await t.test('成功流与历史持久化 source，run 接收规范化对象，重放不再调用也不重复历史', async () => {
    const customPrompt = '从最近一年的标题和发件人判断值得查看、疑似广告、欺诈风险或疑似官方的邮件';
    const body = input({ requestId: randomUUID().toUpperCase(), days: 365, prompt: customPrompt }), before = f.messages().length;
    f.review.behavior = async (_data, { onStatus, onDelta }) => { onStatus('合成分析'); onDelta(RAW_BODY); return { text: SUMMARY, reason: { kind: 'completed' }, body: RAW_BODY }; };
    const response = await f.post(body, { headers: { origin: f.app.url } });
    assert.equal(response.status, 200); assert.match(response.headers['content-type'], /application\/x-ndjson/);
    const start = response.events.find(event => event.type === 'start'), done = response.events.find(event => event.type === 'done');
    assert.equal(response.events[0].type, 'start'); assert.equal(response.events.at(-1).type, 'done');
    assert.ok(response.events.some(event => event.type === 'status' && event.runId === start.runId && event.text === '合成分析'));
    assert.ok(response.events.some(event => event.type === 'delta' && event.text === RAW_BODY));
    assert.equal(response.events.some(event => event.type === 'error'), false); safe(response.raw);
    assert.equal(start.user.source, 'email-review'); assert.equal(start.assistant.source, 'email-review'); assert.equal(done.message.source, 'email-review');
    assert.equal(done.message.content, SUMMARY); assert.equal(f.review.runs.at(-1).data.requestId, body.requestId.toLowerCase());
    assert.equal(f.messages().length, before + 2);
    const pair = (await f.request('/api/state')).data.messages.slice(-2);
    assert.deepEqual(pair.map(message => [message.role, message.content, message.source, message.status]), [['user', customPrompt, 'email-review', 'complete'], ['assistant', SUMMARY, 'email-review', 'complete']]);
    safe(pair, true); scanStored();
    const calls = f.review.runs.length;
    assert.equal((await f.post(body)).status, 409); assert.equal(f.review.runs.length, calls); assert.equal(f.messages().length, before + 2);
  });
  await t.test('common cancel 绑定 runId、只中止邮件 signal，排空前仍忙，取消后不能重放', async () => {
    const gate = hold(f), body = input(), stream = f.open('/api/email/review', { method: 'POST', body });
    let start;
    try {
      start = await bounded(stream.started, 'cancel start'); await bounded(gate.entered, 'cancel run');
      const cancel = (runId, headers) => f.request('/api/cancel', { method: 'POST', body: { runId }, headers });
      assert.equal((await cancel(randomUUID())).status, 409);
      assert.equal((await cancel(start.runId, { 'x-claudia-token': 'wrong' })).status, 403);
      assert.equal(gate.aborts, 0);
      assert.equal((await cancel(start.runId)).status, 200); await bounded(gate.aborted, 'cancel abort');
      assert.equal((await cancel(start.runId)).status, 200); assert.equal(gate.aborts, 1);
      assert.equal(f.runtimeCalls.cancel, 0); assert.equal((await f.request('/api/health')).data.busy, true);
      assert.equal((await f.post(input())).status, 409);
    } finally { gate.release(); }
    const result = await bounded(stream.done, 'cancel drain'); safe(result.raw);
    assert.ok(result.events.some(event => event.type === 'error')); assert.equal(result.events.some(event => event.type === 'done'), false);
    assert.equal(f.messages().at(-1).status, 'cancelled'); assert.equal(f.messages().at(-1).content, '');
    assert.equal((await f.request('/api/health')).data.busy, false);
    assert.equal((await f.request('/api/cancel', { method: 'POST', body: { runId: start.runId } })).status, 409);
    const count = f.review.runs.length; assert.equal((await f.post(body)).status, 409); assert.equal(f.review.runs.length, count);
  });
  await t.test('客户端断线中止邮件 signal，不回放、不遗留 pending 或正文', async () => {
    const gate = hold(f), body = input(), stream = f.open('/api/email/review', { method: 'POST', body });
    try {
      await bounded(stream.started, 'disconnect start'); await bounded(gate.entered, 'disconnect run');
      stream.abort(); await bounded(gate.aborted, 'disconnect abort');
      assert.equal(gate.aborts, 1); assert.equal(f.runtimeCalls.cancel, 0);
    } finally { gate.release(); }
    await bounded(f.review.lastTask.catch(() => {}), 'disconnect drain'); await tick();
    assert.equal((await f.request('/api/health')).data.busy, false);
    assert.equal(f.messages().at(-1).status, 'cancelled'); assert.equal(f.messages().at(-1).content, '');
    safe((await f.request('/api/state')).raw, true);
    const calls = f.review.runs.length, messages = f.messages().length;
    assert.equal((await f.post(body)).status, 409);
    assert.equal(f.review.runs.length, calls); assert.equal(f.messages().length, messages); scanStored();
  });
  await t.test('preview/validate/run 未知异常不信任 status、不回显 secret、不进入日志，失败不重放', async () => {
    const originalPreview = f.review.preview, originalValidate = f.review.validate;
    try {
      f.review.preview = () => { throw poison(418); };
      const result = await f.request('/api/email/review/preview'); assert.equal(result.status, 503); safe(result.raw, true);
      f.review.validate = () => { throw poison(400); };
      const invalid = await f.post(input()); assert.equal(invalid.status, 409); safe(invalid.raw, true);
    } finally { f.review.preview = originalPreview; f.review.validate = originalValidate; }
    for (const status of [400, 409, 503]) {
      const body = input(); f.review.behavior = async () => { throw poison(status); };
      const result = await f.post(body); assert.equal(result.status, 200); safe(result.raw, true);
      assert.ok(result.events.some(event => event.type === 'error')); assert.equal(result.events.some(event => event.type === 'done'), false);
      assert.equal(f.messages().at(-1).status, 'error'); assert.equal(f.messages().at(-1).content, '');
      const count = f.review.runs.length; assert.equal((await f.post(body)).status, 409); assert.equal(f.review.runs.length, count);
    }
    f.review.behavior = async () => ({ text: RAW_BODY, reason: { kind: 'max-tokens' } });
    assert.ok((await f.post(input())).events.some(event => event.type === 'error'));
    assert.equal(f.messages().at(-1).content, '');
    safe(f.logs, true); safe(f.logger.recent(), true); safe((await f.request('/api/logs')).raw, true); scanStored();
    assert.equal(f.logs.some(([event]) => event === 'http.error'), false);
  });
  await t.test('服务关闭先取消邮件并等待排空，再关闭 runtime/HTTP/Store；重建 Store 保留 source', async () => {
    const gate = hold(f), stream = f.open('/api/email/review', { method: 'POST', body: input() });
    let closing, closed = false;
    try {
      await bounded(stream.started, 'close start'); const signal = await bounded(gate.entered, 'close run');
      closing = f.close().then(() => { closed = true; });
      await bounded(gate.aborted, 'close abort'); await tick();
      assert.equal(signal.aborted, true); assert.equal(closed, false);
      assert.ok(f.events.includes('review.close.begin')); assert.equal(f.events.includes('runtime.close'), false);
      assert.equal(f.runtimeCalls.cancel, 0);
    } finally { gate.release(); }
    await bounded(closing, 'server close');
    const result = await bounded(stream.done, 'close response'); safe(result.raw);
    assert.equal(f.app.server.listening, false); assert.equal(f.runtimeCalls.close, 1);
    assert.ok(f.events.indexOf('review.close.end') < f.events.indexOf('runtime.close'));
    assert.throws(() => f.app.store.messages(), /closed|关闭|open/i);
    const reopened = new Store(join(root, 'claudia.sqlite'));
    try {
      const messages = reopened.messages(); assert.ok(messages.length > 0);
      assert.equal(messages.every(message => message.source === 'email-review'), true);
      assert.equal(messages.some(message => message.status === 'pending'), false);
      assert.equal(messages.at(-1).status, 'cancelled'); assert.equal(messages.at(-1).content, '');
      safe(messages, true);
    } finally { reopened.close(); }
    scanStored();
  });
});
