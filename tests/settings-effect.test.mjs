import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server.mjs';

const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const testOptions = { timeout: 15_000 };
const settingsDeadline = 1_500;
const boolKeys = ['allowContext', 'activityEnabled', 'reflectionEnabled', 'autoUpdateEnabled', 'memorySuggestionsEnabled', 'profileEnabled'];

// 只导入 server 及其本地存储依赖；不加载真实 runtime、activity、restart 或宿主凭据。
async function fixture(t, { withRestart = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claudia-settings-effect-'));
  const home = join(root, 'synthetic-home'), dataDir = join(home, 'claudia');
  const clients = new Set(), requests = new Set(), activityGates = [];
  const chatStarted = Promise.withResolvers(), chatFinished = Promise.withResolvers();
  const backgroundStarted = Promise.withResolvers(), backgroundFinished = Promise.withResolvers();
  const calls = { activity: [], restartRequest: [], prepare: [], run: [], cancel: [], release: [], background: [], closed: [] };
  const controls = {
    activityMode: 'deferred', activityEnabled: false, activityState: 'idle', activityError: '',
    maintenanceRunning: false, otherAgents: false, hostThrows: false, holdChat: false,
    restartSupported: true, restartPending: false,
  };
  let app, token, context;

  t.after(async () => {
    // 失败时也释放所有测试门闩，避免 close() 等待 activityApply 或 HTTP 而挂住。
    controls.activityMode = 'sync';
    for (const gate of activityGates) gate.resolve();
    chatFinished.resolve();
    backgroundFinished.resolve();
    try {
      await Promise.allSettled([...requests]);
      if (app) {
        await app.close();
        assert.equal(app.server.listening, false);
        assert.throws(() => app.store.get('sessionId'), /not open|closed/i);
        assert.deepEqual(calls.closed, ['maintenance', 'activity', 'runtime']);
      }
    } finally {
      for (const client of clients) client.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  function request(path, { method = 'GET', body, rawBody, headers = {}, timeoutMs = 5_000 } = {}) {
    const started = performance.now();
    const requestHeaders = { connection: 'close' };
    if (method !== 'GET') Object.assign(requestHeaders, { 'content-type': 'application/json', 'x-claudia-token': token });
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) delete requestHeaders[key];
      else requestHeaders[key] = value;
    }
    const result = new Promise((resolve, reject) => {
      const client = httpRequest(new URL(path, app.url), { method, headers: requestHeaders, agent: false }, response => {
        response.setEncoding('utf8');
        let raw = '';
        response.on('data', chunk => { raw += chunk; });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('测试 HTTP 响应被中断')));
        response.on('end', () => {
          try {
            const streaming = response.headers['content-type']?.startsWith('application/x-ndjson');
            if (streaming) assert.ok(raw.endsWith('\n'), 'NDJSON 必须完整结束');
            const data = streaming ? raw.trim().split('\n').map(line => JSON.parse(line)) : JSON.parse(raw);
            resolve({ status: response.statusCode, data, raw, elapsedMs: performance.now() - started });
          } catch (error) { reject(error); }
        });
      });
      clients.add(client);
      // 使用整次请求的期限，而非可被数据重置的 socket 空闲超时。
      const timer = setTimeout(() => client.destroy(new Error(`测试 HTTP 请求超过 ${timeoutMs}ms`)), timeoutMs);
      client.once('close', () => { clearTimeout(timer); clients.delete(client); });
      client.on('error', reject);
      client.end(rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body));
    });
    requests.add(result);
    result.then(() => requests.delete(result), () => requests.delete(result));
    return result;
  }

  app = await startServer({
    home, dataDir, profile: 'synthetic-profile', port: 0,
    hasOtherAgents(runtime) {
      assert.equal(runtime, app.runtime);
      if (controls.hostThrows) throw new Error('测试宿主状态不可用');
      return controls.otherAgents;
    },
    createRuntime: store => ({
      store,
      selection: () => ({ provider: 'synthetic-provider', model: 'synthetic-model' }),
      status: () => ({ installed: true, configured: true, connected: true }),
      async prepare(sessionId) { calls.prepare.push(sessionId); },
      async run(sessionId, text, { onDelta }) {
        calls.run.push({ sessionId, text });
        chatStarted.resolve();
        if (controls.holdChat) await chatFinished.promise;
        onDelta('纯测试回复');
        return { text: '纯测试回复', reason: { kind: 'completed' } };
      },
      async cancel(sessionId) { calls.cancel.push(sessionId); chatFinished.resolve(); },
      async release(sessionId) { calls.release.push(sessionId); },
      async close() { calls.closed.push('runtime'); chatFinished.resolve(); },
    }),
    createServices(injected) {
      context = injected;
      const activity = {
        // 默认保持 idle 且无 error，防止替身状态掩盖 server 自身的 applying/error 跟踪。
        status: () => ({ enabled: controls.activityEnabled, running: controls.activityEnabled, state: controls.activityState, error: controls.activityError }),
        summary: () => ({ apps: [], seconds: 0 }),
        setEnabled(enabled) {
          calls.activity.push(enabled);
          controls.activityEnabled = enabled;
          if (controls.activityMode === 'throw') throw new Error('SYNTHETIC_PRIVATE_ACTIVITY_FAILURE');
          if (controls.activityMode === 'sync') return activity.status();
          const gate = Promise.withResolvers();
          activityGates.push(gate);
          return gate.promise;
        },
        async close() { calls.closed.push('activity'); },
      };
      const restart = {
        status: () => ({ supported: controls.restartSupported, pending: controls.restartPending, state: controls.restartPending ? 'pending' : 'idle', message: '纯测试重启状态', runningVersion: packageVersion, installedVersion: packageVersion }),
        // 与真实接口一致同步返回/抛错；不检查 busy，忙请求必须由 server 阻止。
        request(...args) {
          calls.restartRequest.push(args);
          if (!controls.restartSupported) throw Object.assign(new Error('纯测试环境不支持重启'), { status: 503 });
          controls.restartPending = true;
          return restart.status();
        },
      };
      return {
        activity,
        maintenance: {
          status: () => ({ running: controls.maintenanceRunning }),
          async close() { calls.closed.push('maintenance'); },
        },
        background: {
          status: () => ({ supported: true, enabled: false }),
          async setEnabled(enabled) {
            calls.background.push(enabled);
            backgroundStarted.resolve();
            await backgroundFinished.promise;
            return { supported: true, enabled };
          },
        },
        ...(withRestart ? { restart } : {}),
      };
    },
  });
  const bootstrap = await request('/api/bootstrap');
  assertStatus(bootstrap, 200);
  token = bootstrap.data.csrfToken;
  assert.match(token, /^[a-f0-9]{64}$/);
  return {
    app, home, dataDir, context, token, controls, calls, activityGates,
    chatStarted, chatFinished, backgroundStarted, backgroundFinished, request,
    // 省略 body 必须发送零字节，不能默认替换成 {}，否则测不到空请求解析。
    post: (path, body, options = {}) => request(path, { ...options, method: 'POST', body }),
    async settings(body) {
      const response = await request('/api/settings', { method: 'POST', body, timeoutMs: settingsDeadline });
      assertStatus(response, 200);
      assert.ok(response.elapsedMs <= settingsDeadline, `保存耗时 ${response.elapsedMs}ms，必须 <= ${settingsDeadline}ms`);
      return response.data;
    },
    async state() { return assertStatus(await request('/api/state'), 200); },
    async health() { return assertStatus(await request('/api/health'), 200); },
    read: name => readFile(join(dataDir, name), 'utf8'),
  };
}

function assertStatus(response, expected) {
  assert.equal(response.status, expected, response.raw);
  if (expected >= 400) assert.equal(typeof response.data.error, 'string');
  return response.data;
}

function assertEffect(value, state) {
  assert.equal(value.settingsEffect.state, state);
  assert.equal(value.settingsEffect.restartRequired, false, '保存成功不代表必须重启');
  assert.equal(typeof value.settingsEffect.message, 'string');
  assert.ok(value.settingsEffect.message.length > 0);
}

async function assertPersisted(f, values) {
  // 从磁盘正文及独立只读 SQLite 连接验证，不以 HTTP 回显或同一 Store 缓存充当持久化证据。
  const settings = await f.read('settings.md');
  for (const key of boolKeys) if (Object.hasOwn(values, key)) assert.match(settings, new RegExp(`^${key}: ${values[key]}$`, 'm'));
  if (Object.hasOwn(values, 'assistantName')) assert.ok((await f.read('soul.md')).includes(`assistantName: ${JSON.stringify(values.assistantName)}`));
  if (Object.hasOwn(values, 'activityEnabled')) {
    const db = new DatabaseSync(join(f.dataDir, 'claudia.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key=?').get('reflectionSources');
      assert.deepEqual(JSON.parse(row.value), ['journal', 'todos', 'messages', ...(values.activityEnabled ? ['activity'] : [])]);
    } finally { db.close(); }
  }
}

test('deferred 长时间不 resolve：settings 在 <=1500ms 返回 200、applying 且已落盘，resolve 后 applied', testOptions, async t => {
  const f = await fixture(t);
  assert.equal(f.context.store, f.app.store);
  assert.equal(f.context.runtime, f.app.runtime);
  assert.equal(f.context.pluginPort, f.app.server.address().port);
  assertEffect(await f.state(), 'applied');
  const values = { assistantName: '长任务测试助手', ...Object.fromEntries(boolKeys.map(key => [key, true])) };
  const result = await f.settings(values);
  assertEffect(result, 'applying');
  for (const [key, value] of Object.entries(values)) assert.equal(result.settings[key], value);
  assert.deepEqual(f.calls.activity, [true]);
  assert.equal(f.app.services.activity.status().state, 'idle');
  await assertPersisted(f, values);
  assert.equal(f.context.isBusy(), false);
  assert.equal(f.context.restartBusy(), true);
  const health = await f.health();
  assert.equal(health.busy, false);
  assert.equal(health.version, packageVersion);
  assert.equal(health.home, f.home);
  assert.deepEqual(result.restart, f.app.services.restart.status());
  // 实际跨过保存期限仍不释放，不用即时完成的 Promise 假装测试慢组件。
  await delay(settingsDeadline + 100);
  const pending = await f.state();
  assertEffect(pending, 'applying');
  assert.deepEqual(pending.settings, result.settings);
  await assertPersisted(f, values);
  f.activityGates[0].resolve();
  const applied = await f.state();
  assertEffect(applied, 'applied');
  assert.deepEqual(applied.settings, result.settings);
  assert.equal(f.context.restartBusy(), false);
  assert.deepEqual(f.calls.restartRequest, []);
  assert.deepEqual(f.calls.closed, []);
});

test('deferred reject 后 error 但不撤销已保存配置；同值显式重试恢复 applied', testOptions, async t => {
  const f = await fixture(t);
  const result = await f.settings({ activityEnabled: true, assistantName: '失败仍保存' });
  assertEffect(result, 'applying');
  await assertPersisted(f, { activityEnabled: true, assistantName: '失败仍保存' });
  f.activityGates[0].reject(new Error('SYNTHETIC_PRIVATE_ACTIVITY_FAILURE'));
  const failed = await f.state();
  assertEffect(failed, 'error');
  assert.equal(f.app.services.activity.status().error, '');
  assert.equal(JSON.stringify(failed).includes('SYNTHETIC_PRIVATE_ACTIVITY_FAILURE'), false);
  assert.deepEqual(failed.settings, result.settings);
  assert.equal(f.context.restartBusy(), false);
  await assertPersisted(f, { activityEnabled: true, assistantName: '失败仍保存' });
  assertEffect(await f.settings(), 'error');
  assertEffect(await f.settings({ assistantName: '错误中改名' }), 'error');
  assert.deepEqual(f.calls.activity, [true], '空请求和改名不能隐式重试 activity');
  assertEffect(await f.settings({ activityEnabled: true }), 'applying');
  assert.deepEqual(f.calls.activity, [true, true], '出错后的同值提交应允许重试');
  f.activityGates[1].resolve();
  assertEffect(await f.state(), 'applied');
  assert.deepEqual(f.calls.restartRequest, []);
});

test('activity 正常时同值不重复 setEnabled；仅改名、其他开关和空 body 不触发 activity', testOptions, async t => {
  const f = await fixture(t);
  const initial = await f.state(), before = await f.read('settings.md');
  assertEffect(await f.settings(), 'applied');
  assert.deepEqual((await f.state()).settings, initial.settings);
  assert.equal(await f.read('settings.md'), before);
  assertEffect(await f.settings({ activityEnabled: false }), 'applied');
  assertEffect(await f.settings({ assistantName: '仅改名字', reflectionEnabled: true }), 'applied');
  assert.deepEqual(f.calls.activity, []);
  assertEffect(await f.settings({ activityEnabled: true }), 'applying');
  for (const body of [{ activityEnabled: true }, { assistantName: '应用期间改名' }, { memorySuggestionsEnabled: true }, {}, undefined]) assertEffect(await f.settings(body), 'applying');
  assert.deepEqual(f.calls.activity, [true]);
  f.activityGates[0].resolve();
  assertEffect(await f.state(), 'applied');
  assertEffect(await f.settings({ activityEnabled: true }), 'applied');
  assertEffect(await f.settings({ assistantName: '应用后改名' }), 'applied');
  assert.deepEqual(f.calls.activity, [true]);
  await assertPersisted(f, { activityEnabled: true, assistantName: '应用后改名', reflectionEnabled: true, memorySuggestionsEnabled: true });
});

for (const outcome of ['resolve', 'reject']) {
  for (const oldFirst of [true, false]) {
    test(`pending 中 disable 立即持久化；旧 enable ${oldFirst ? '先' : '后'} ${outcome} 不覆盖新效果`, testOptions, async t => {
      const f = await fixture(t);
      assertEffect(await f.settings({ activityEnabled: true }), 'applying');
      const disabled = await f.settings({ activityEnabled: false });
      assertEffect(disabled, 'applying');
      assert.equal(disabled.settings.activityEnabled, false);
      assert.deepEqual(f.calls.activity, [true, false]);
      await assertPersisted(f, { activityEnabled: false });
      const settleOld = () => f.activityGates[0][outcome](outcome === 'reject' ? new Error('SYNTHETIC_STALE_FAILURE') : undefined);
      if (oldFirst) {
        settleOld();
        assertEffect(await f.state(), 'applying');
        assert.equal(f.context.restartBusy(), true, '旧 finally 不能清除新 activityApply');
        assertStatus(await f.post('/api/restart'), 409);
      }
      f.activityGates[1].resolve();
      assertEffect(await f.state(), 'applied');
      if (!oldFirst) settleOld();
      const state = await f.state();
      assertEffect(state, 'applied');
      assert.equal(state.settings.activityEnabled, false);
      assert.equal(f.context.restartBusy(), false);
      await assertPersisted(f, { activityEnabled: false });
      assertEffect(await f.settings({ activityEnabled: false }), 'applied');
      assert.deepEqual(f.calls.activity, [true, false]);
      assert.deepEqual(f.calls.restartRequest, []);
    });
  }
}

test('同步 setEnabled 返回或抛错均不阻塞保存；服务上报 error 时同值可重新应用', testOptions, async t => {
  const f = await fixture(t);
  f.controls.activityMode = 'sync';
  const saved = await f.settings({ activityEnabled: true });
  assert.equal(saved.settingsEffect.restartRequired, false);
  assertEffect(await f.state(), 'applied');
  f.controls.activityMode = 'throw';
  assertEffect(await f.settings({ activityEnabled: false }), 'error');
  await assertPersisted(f, { activityEnabled: false });
  f.controls.activityMode = 'sync';
  await f.settings({ activityEnabled: false });
  assertEffect(await f.state(), 'applied');
  f.controls.activityError = '纯测试服务错误';
  assertEffect(await f.state(), 'error');
  f.controls.activityMode = 'deferred';
  await f.settings({ activityEnabled: false });
  assert.deepEqual(f.calls.activity, [true, false, false, false]);
  f.controls.activityError = '';
  assertEffect(await f.state(), 'applying');
  f.activityGates[0].resolve();
  assertEffect(await f.state(), 'applied');
});

test('activity applying 不阻塞 chat/settings；真正 chat 活跃时拒绝并发 chat/settings/restart', testOptions, async t => {
  const f = await fixture(t);
  assertEffect(await f.settings({ activityEnabled: true }), 'applying');
  assertEffect(await f.settings({ assistantName: '允许保存' }), 'applying');
  assertStatus(await f.post('/api/restart'), 409);
  f.controls.holdChat = true;
  const chat = f.post('/api/chat', { text: '组件仍在准备也可聊天' });
  await f.chatStarted.promise;
  assert.equal(f.context.isBusy(), true);
  assert.equal(f.context.restartBusy(), true);
  assert.equal((await f.health()).busy, true);
  const before = await f.read('settings.md'), soulBefore = await f.read('soul.md');
  assertStatus(await f.post('/api/chat', { text: '不能并发' }), 409);
  assertStatus(await f.post('/api/settings', { assistantName: '不能覆盖', activityEnabled: false }), 409);
  assertStatus(await f.post('/api/settings'), 409);
  assertStatus(await f.post('/api/restart'), 409);
  assert.equal(await f.read('settings.md'), before);
  assert.equal(await f.read('soul.md'), soulBefore);
  assert.equal(f.calls.run.length, 1);
  assert.deepEqual(f.calls.activity, [true]);
  assert.deepEqual(f.calls.restartRequest, []);
  f.chatFinished.resolve();
  assert.equal(assertStatus(await chat, 200).at(-1).message.status, 'complete');
  assert.equal(f.context.isBusy(), false);
  assert.equal((await f.health()).busy, false);
  assertEffect(await f.settings({ assistantName: '聊天结束后保存' }), 'applying');
  f.activityGates[0].resolve();
  assertEffect(await f.state(), 'applied');
  assert.equal(f.context.restartBusy(), false);
});

test('maintenance 忙拒绝 chat/settings/restart，且不能把重启判断委托给 request 替身', testOptions, async t => {
  const f = await fixture(t), before = await f.state();
  f.controls.maintenanceRunning = true;
  assert.equal(f.context.isBusy(), false, 'maintenance 不通过 isBusy 自锁');
  assert.equal(f.context.restartBusy(), true);
  assert.equal((await f.health()).busy, true);
  assertStatus(await f.post('/api/chat', { text: '维护中不能运行' }), 409);
  assertStatus(await f.post('/api/settings', { activityEnabled: true }), 409);
  assertStatus(await f.post('/api/restart'), 409);
  assert.deepEqual((await f.state()).settings, before.settings);
  assert.deepEqual(f.calls.activity, []);
  assert.deepEqual(f.calls.run, []);
  assert.deepEqual(f.calls.restartRequest, []);
  f.controls.maintenanceRunning = false;
  assert.equal(f.context.restartBusy(), false);
  assertEffect(await f.settings({ assistantName: '维护结束后保存' }), 'applied');
  assertStatus(await f.post('/api/restart'), 202);
  assert.deepEqual(f.calls.restartRequest, [[]]);
});

test('background configuring 期间 chat/settings/restart 返回 409，完成后释放锁', testOptions, async t => {
  const f = await fixture(t), before = await f.state();
  const background = f.post('/api/background', { enabled: true });
  await f.backgroundStarted.promise;
  assert.equal(f.context.isBusy(), true);
  assert.equal(f.context.restartBusy(), true);
  assert.equal((await f.health()).busy, true);
  assertStatus(await f.post('/api/chat', { text: '配置期间拒绝' }), 409);
  assertStatus(await f.post('/api/settings', { activityEnabled: true }), 409);
  assertStatus(await f.post('/api/restart'), 409);
  assert.deepEqual((await f.state()).settings, before.settings);
  assert.deepEqual(f.calls.activity, []);
  assert.deepEqual(f.calls.run, []);
  assert.deepEqual(f.calls.restartRequest, []);
  f.backgroundFinished.resolve();
  assertStatus(await background, 200);
  assert.equal(f.context.isBusy(), false);
  assert.equal(f.context.restartBusy(), false);
  assertEffect(await f.settings({ assistantName: '配置结束后保存' }), 'applied');
});

for (const hostThrows of [false, true]) {
  test(`hasOtherAgents ${hostThrows ? '抛错时按忙处理' : '为 true'}：restart 409，但不占用本插件 chat/settings 锁`, testOptions, async t => {
    const f = await fixture(t);
    f.controls.otherAgents = true;
    f.controls.hostThrows = hostThrows;
    assert.equal(f.context.isBusy(), false);
    assert.equal(f.context.restartBusy(), true);
    assert.equal((await f.health()).busy, true);
    assertStatus(await f.post('/api/restart'), 409);
    assert.deepEqual(f.calls.restartRequest, []);
    assertEffect(await f.settings({ assistantName: '只修改本插件' }), 'applied');
    assert.equal(assertStatus(await f.post('/api/chat', { text: '本插件仍可聊天' }), 200).at(-1).message.status, 'complete');
    f.controls.otherAgents = false;
    f.controls.hostThrows = false;
    assert.equal(f.context.restartBusy(), false);
    assertStatus(await f.post('/api/restart'), 202);
    assert.deepEqual(f.calls.restartRequest, [[]]);
  });
}

test('prepare-restart draining 期间 chat/settings/restart 都返回 409，不调用 request', testOptions, async t => {
  const f = await fixture(t);
  assert.deepEqual(assertStatus(await f.post('/api/prepare-restart'), 200), { ok: true, draining: true });
  assert.equal(f.context.isBusy(), true);
  assert.equal(f.context.restartBusy(), true);
  assertStatus(await f.post('/api/chat', { text: '等待关闭' }), 409);
  assertStatus(await f.post('/api/settings'), 409);
  assertStatus(await f.post('/api/restart'), 409);
  assert.deepEqual(f.calls.activity, []);
  assert.deepEqual(f.calls.run, []);
  assert.deepEqual(f.calls.restartRequest, []);
});

test('restart 要求 CSRF 与 JSON，跨站和缺凭证即使空 body 也返回 403；GET 不触发重启', testOptions, async t => {
  const f = await fixture(t);
  const wrongToken = (f.token[0] === '0' ? '1' : '0') + f.token.slice(1);
  for (const headers of [
    { 'x-claudia-token': undefined }, { 'x-claudia-token': '' }, { 'x-claudia-token': 'invalid' },
    { 'x-claudia-token': wrongToken }, { 'x-claudia-token': `${f.token}0` },
    { 'content-type': undefined }, { 'content-type': 'text/plain' },
    { origin: 'null' }, { 'sec-fetch-site': 'cross-site' },
  ]) {
    assertStatus(await f.post('/api/restart', undefined, { headers }), 403);
    assertStatus(await f.post('/api/restart', {}, { headers }), 403);
  }
  assertStatus(await f.request('/api/restart'), 404);
  assert.deepEqual(f.calls.restartRequest, []);
  assert.equal((await f.state()).restart.pending, false);
});

test('restart 拒绝额外参数、非对象或损坏 JSON；无效请求不调用 request', testOptions, async t => {
  const f = await fixture(t);
  for (const body of [
    { pid: process.pid }, { expectedPid: process.pid }, { signal: 'SIGTERM' },
    { home: f.home }, { path: f.dataDir }, { profile: 'other' }, { force: true },
    { desiredVersion: packageVersion }, { unknown: null }, { ['__proto__']: {} },
    null, [], true, false, 0, 'restart',
  ]) assertStatus(await f.post('/api/restart', body), 400);
  for (const rawBody of ['{', ' ', '{"force":', '{}{}']) assertStatus(await f.post('/api/restart', undefined, { rawBody }), 400);
  assert.deepEqual(f.calls.restartRequest, []);
  assert.equal((await f.state()).restart.pending, false);
});

test('未注入 restart 时 state 提供动态版本与 unsupported，空 body/空对象 POST 都为 503', testOptions, async t => {
  const f = await fixture(t, { withRestart: false });
  const state = await f.state();
  assert.equal(state.restart.supported, false);
  assert.equal(state.restart.pending, false);
  assert.equal(state.restart.state, 'idle');
  assert.equal(state.restart.runningVersion, packageVersion);
  assert.equal(state.restart.installedVersion, packageVersion);
  assert.equal((await f.health()).version, packageVersion);
  assertEffect(await f.settings({ assistantName: '无需重启也能保存' }), 'applied');
  for (const body of [undefined, {}]) assertStatus(await f.post('/api/restart', body), 503);
  assertStatus(await f.post('/api/restart', { force: true }), 400);
  assert.deepEqual(f.calls.restartRequest, []);
});

test('restart 服务不支持时同步 request 抛出的 503 被原样映射，不误报 202', testOptions, async t => {
  const f = await fixture(t);
  f.controls.restartSupported = false;
  assert.equal((await f.state()).restart.supported, false);
  for (const body of [undefined, {}]) assertStatus(await f.post('/api/restart', body), 503);
  assert.deepEqual(f.calls.restartRequest, [[], []]);
  assert.equal((await f.state()).restart.pending, false);
  assert.equal(f.app.server.listening, true);
});

test('支持 restart 时空 body/空对象返回同步状态与 202，仅委托 request，不直接 kill/exit 或关闭宿主', testOptions, async t => {
  const f = await fixture(t);
  const kill = t.mock.method(process, 'kill', () => { throw new Error('测试禁止发送进程信号'); });
  const exit = t.mock.method(process, 'exit', () => { throw new Error('测试禁止退出进程'); });
  const abort = t.mock.method(process, 'abort', () => { throw new Error('测试禁止终止进程'); });
  const initial = await f.state();
  assert.deepEqual(initial.restart, f.app.services.restart.status());
  for (const body of [undefined, {}]) {
    const response = assertStatus(await f.post('/api/restart', body, { headers: { origin: f.app.url, 'content-type': 'application/json; charset=utf-8' } }), 202);
    assert.deepEqual(response, { restart: f.app.services.restart.status() });
    assert.equal(response.restart.supported, true);
    assert.equal(response.restart.pending, true);
    assert.equal(response.restart.state, 'pending');
    assert.equal(response.restart.runningVersion, packageVersion);
    assert.equal(response.restart.installedVersion, packageVersion);
  }
  assert.deepEqual(f.calls.restartRequest, [[], []], '只允许无参数委托');
  const state = await f.state(), health = await f.health();
  assert.equal(state.sessionId, initial.sessionId);
  assert.deepEqual(state.settings, initial.settings);
  assert.deepEqual(state.restart, f.app.services.restart.status());
  assertEffect(state, 'applied');
  assert.equal(health.pid, process.pid);
  assert.equal(health.version, packageVersion);
  assert.equal(f.app.server.listening, true);
  assert.deepEqual(f.calls.cancel, []);
  assert.deepEqual(f.calls.release, []);
  assert.deepEqual(f.calls.closed, []);
  for (const fn of [kill, exit, abort]) assert.equal(fn.mock.callCount(), 0);
});
