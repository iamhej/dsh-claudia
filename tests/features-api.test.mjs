import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { PROFILE_DEFAULTS } from '../records.mjs';
import { Logger } from '../logger.mjs';

const testOptions = { timeout: 15_000 };
const featureBools = ['activityEnabled', 'reflectionEnabled', 'autoUpdateEnabled', 'memorySuggestionsEnabled'];
const boolKeys = ['allowContext', ...featureBools];
const start = '2026-09-14T00:00:00.000Z';
const end = '2026-09-15T00:00:00.000Z';
const digest = text => createHash('sha256').update(text).digest('hex');

// IME composition/Enter 防误提交属于浏览器事件测试；本文件只验证提交后的 HTTP 数据。
// 不导入 index/native-runtime/activity/maintenance/lifecycle，不加载宿主、模型或系统命令。
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claudia-features-api-'));
  const home = join(root, 'synthetic-home');
  const dataDir = join(home, 'claudia');
  const profile = 'synthetic-profile';
  const clients = new Set(), requests = new Set(), liveApps = new Set();
  const calls = { createServices: [], openFolder: [], openHarness: [], activity: [], summary: [], background: [], reflection: [], prepare: [], run: [], cancel: [], release: [], closed: [] };
  const controls = { maintenanceRunning: false, activityEnabled: false, backgroundEnabled: false, holdChat: false, holdBackground: false, failRuntimeStatus: false };
  const chatStarted = Promise.withResolvers(), chatFinished = Promise.withResolvers();
  const backgroundStarted = Promise.withResolvers(), backgroundFinished = Promise.withResolvers();
  let app, token;

  async function shutdown(instance) {
    await instance.close();
    liveApps.delete(instance);
    assert.equal(instance.server.listening, false);
    assert.throws(() => instance.store.get('sessionId'), /not open|closed/i);
  }
  t.after(async () => {
    // 先释放测试自己的异步门闩，断言失败时也不能遗留 HTTP 或 SQLite。
    chatFinished.resolve();
    backgroundFinished.resolve();
    try {
      await Promise.allSettled([...requests]);
      for (const instance of liveApps) await shutdown(instance);
      assert.deepEqual(calls.closed, Array.from({ length: calls.createServices.length }, () => ['maintenance', 'activity', 'runtime']).flat());
    } finally {
      for (const client of clients) client.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  function request(path, { method = 'GET', body, headers = {} } = {}) {
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
            resolve({ status: response.statusCode, data, raw });
          } catch (error) { reject(error); }
        });
      });
      clients.add(client);
      client.once('close', () => clients.delete(client));
      client.on('error', reject);
      client.setTimeout(5_000, () => client.destroy(new Error('测试 HTTP 请求超时')));
      client.end(body === undefined ? undefined : JSON.stringify(body));
    });
    requests.add(result);
    result.then(() => requests.delete(result), () => requests.delete(result));
    return result;
  }

  async function boot() {
    controls.backgroundEnabled = false;
    app = await startServer({
      dataDir, home, profile, port: 0,
      ...options.withLogger ? { logger: new Logger(dataDir) } : {},
      getHostUrl: () => `http://127.0.0.1:${app.server.address().port}/synthetic-harness`,
      openFolder: options.withOpenCallbacks === false ? undefined : async (...args) => { calls.openFolder.push(args); },
      openHarness: options.withOpenCallbacks === false ? undefined : async (...args) => { calls.openHarness.push(args); },
      createRuntime: store => ({
        store,
        selection: () => ({ provider: 'synthetic-provider', model: 'synthetic-model' }),
        status: async () => { if (controls.failRuntimeStatus) throw new Error('synthetic runtime status failure'); return { installed: true, configured: true, connected: true, credentialSource: 'harness', modelVerified: false }; },
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
      createServices(context) {
        calls.createServices.push(context);
        const activity = {
          status: () => ({ enabled: controls.activityEnabled, running: controls.activityEnabled, source: 'synthetic', error: '' }),
          summary(from, to) { calls.summary.push({ from, to }); return { apps: [], seconds: 0 }; },
          async setEnabled(enabled) { calls.activity.push(enabled); controls.activityEnabled = enabled; return activity.status(); },
          async close() { calls.closed.push('activity'); },
        };
        const maintenance = {
          status: () => ({ running: controls.maintenanceRunning, closed: false, reflection: { state: 'synthetic' } }),
          // 故意不检查开关：关闭开关的 HTTP 断言必须由 server 自己阻止，不能靠替身掩盖。
          async runReflection() {
            calls.reflection.push([]);
            context.store.saveReflection({ id: `synthetic-reflection-${calls.reflection.length}`, text: '纯测试回顾', start, end, createdAt: end });
            return maintenance.status();
          },
          async close() { calls.closed.push('maintenance'); },
        };
        const background = {
          status: () => ({ enabled: controls.backgroundEnabled, supported: true, running: controls.backgroundEnabled }),
          async setEnabled(enabled) {
            calls.background.push(enabled);
            backgroundStarted.resolve();
            if (controls.holdBackground) await backgroundFinished.promise;
            controls.backgroundEnabled = enabled;
            return background.status();
          },
        };
        return { activity, maintenance, ...(options.withBackground === false ? {} : { background }) };
      },
    });
    liveApps.add(app);
    const bootstrap = await request('/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.match(bootstrap.data.csrfToken, /^[a-f0-9]{64}$/);
    token = bootstrap.data.csrfToken;
  }

  await boot();
  return {
    root, home, dataDir, profile, calls, controls, chatStarted, chatFinished, backgroundStarted, backgroundFinished,
    get app() { return app; },
    request,
    post: (path, body = {}, options = {}) => request(path, { ...options, method: 'POST', body }),
    async state() { const response = await request('/api/state'); assert.equal(response.status, 200, response.raw); return response.data; },
    async health() { const response = await request('/api/health'); assert.equal(response.status, 200, response.raw); return response.data; },
    read: name => readFile(join(dataDir, name), 'utf8'),
    write: (name, text) => writeFile(join(dataDir, name), text, { mode: 0o600 }),
    async restart() { await shutdown(app); await boot(); },
  };
}

function assertStatus(response, status) {
  assert.equal(response.status, status, response.raw);
  if (status >= 400) assert.equal(typeof response.data.error, 'string');
  return response.data;
}

function assertNoSecretFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['apiKey', 'key', 'baseUrl', 'endpoint', 'credentials'].includes(key), `公开响应不得携带 ${key}`);
    assertNoSecretFields(child);
  }
}

test('createServices 注入真实临时 Store、替身 runtime、动态 isBusy 与监听端口；默认四开关关闭', testOptions, async t => {
  const f = await fixture(t), state = await f.state();
  assert.equal(f.calls.createServices.length, 1);
  const injected = f.calls.createServices[0];
  assert.equal(injected.store, f.app.store);
  assert.equal(injected.runtime, f.app.runtime);
  assert.equal(injected.runtime.store, f.app.store);
  assert.equal(injected.pluginPort, f.app.server.address().port);
  assert.equal(injected.isBusy(), false);
  for (const key of boolKeys) assert.equal(state.settings[key], false, key);
  for (const key of ['todos', 'reflections', 'memoryCandidates', 'journal', 'memories', 'messages']) assert.deepEqual(state[key], []);
  assert.deepEqual(Object.keys(state.profiles).sort(), ['soul', 'system', 'user']);
  assert.deepEqual(state.profileDefaults, PROFILE_DEFAULTS);
  for (const name of ['soul', 'user', 'system']) {
    const body = name === 'user' ? '' : PROFILE_DEFAULTS[name];
    const text = (name === 'soul' ? '---\nassistantName: "Claudia"\n---\n' : '') + body;
    assert.deepEqual(state.profiles[name], { text, revision: digest(text), body });
    assert.equal(await f.read(`${name}.md`), text);
  }
  assert.equal(state.dataDirectory, f.dataDir);
  assert.equal(state.hostUrl, `${f.app.url}/synthetic-harness`);
  assert.deepEqual(state.activity, f.app.services.activity.status());
  assert.deepEqual(state.maintenance, f.app.services.maintenance.status());
  assert.deepEqual(state.background, f.app.services.background.status());
  assert.deepEqual(state.activitySummary, { apps: [], seconds: 0 });
  assert.equal(f.calls.summary.length, 1);
  assert.equal(Date.parse(f.calls.summary[0].to) - Date.parse(f.calls.summary[0].from), 86_400_000);
  for (const key of ['activity', 'background', 'reflection', 'prepare', 'run', 'openFolder', 'openHarness']) assert.deepEqual(f.calls[key], [], key);
  const health = await f.health();
  assert.equal(health.ok, true);
  assert.equal(health.plugin, 'dsh-claudia');
  assert.equal(health.home, f.home);
  assert.equal(health.profile, f.profile);
  assert.equal(health.busy, false);
  assert.equal(health.pid, process.pid);
  assert.deepEqual(health.runtime, state.runtime);
  assertNoSecretFields(state);
  assertNoSecretFields(health);
});

test('Todo 创建、读取、完成、恢复和 dismissed 状态持久化；中文多行是普通 HTTP 正文而非 IME 验证', testOptions, async t => {
  const f = await fixture(t);
  const text = '中文待办\n第二行 e\u0301';
  let entry = assertStatus(await f.post('/api/todos', { text: `  ${text}  ` }), 201);
  assert.equal(entry.text, text);
  assert.equal(entry.status, 'todo');
  assert.match(entry.id, /^[a-f0-9-]{36}$/);
  assert.match(entry.revision, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
  assert.deepEqual((await f.state()).todos, [entry]);
  for (const status of ['done', 'todo', 'dismissed']) {
    const previous = entry;
    entry = assertStatus(await f.post(`/api/todos/${entry.id}`, { status, revision: entry.revision }), 200);
    assert.equal(entry.status, status);
    assert.equal(entry.id, previous.id);
    assert.equal(entry.text, text);
    assert.equal(entry.createdAt, previous.createdAt);
    assert.notEqual(entry.revision, previous.revision);
    assert.deepEqual((await f.state()).todos, [entry]);
  }
  assert.match(await f.read('todo.md'), /- \[-\] 中文待办/);
  await f.restart();
  assert.deepEqual((await f.state()).todos, [entry]);
});

test('Todo 不提供永久删除入口，忽略仍保留记录', testOptions, async t => {
  const f = await fixture(t);
  const entry = assertStatus(await f.post('/api/todos', { text: '保留的测试项' }), 201);
  assertStatus(await f.request(`/api/todos/${entry.id}`, { method: 'DELETE', body: { revision: entry.revision } }), 404);
  assert.deepEqual((await f.state()).todos, [entry]);
  await f.restart();
  assert.deepEqual((await f.state()).todos, [entry]);
});

test('Todo 拒绝空白、非字符串、超长、非法状态和未知 ID；旧 revision 不覆盖已更新状态', testOptions, async t => {
  const f = await fixture(t);
  for (const text of ['', ' \n ', null, true, 123, [], {}, '字'.repeat(2001)]) assertStatus(await f.post('/api/todos', { text }), 400);
  assert.deepEqual((await f.state()).todos, []);
  const entry = assertStatus(await f.post('/api/todos', { text: '字'.repeat(2000) }), 201);
  for (const status of [undefined, null, true, 0, {}, [], 'deleted', 'DONE', '']) assertStatus(await f.post(`/api/todos/${entry.id}`, { status, revision: entry.revision }), 400);
  assertStatus(await f.post(`/api/todos/${randomUUID()}`, { status: 'done' }), 404);
  assertStatus(await f.post('/api/todos/not-a-uuid', { status: 'done' }), 400);
  const done = assertStatus(await f.post(`/api/todos/${entry.id}`, { status: 'done', revision: entry.revision }), 200);
  assertStatus(await f.post(`/api/todos/${entry.id}`, { status: 'dismissed', revision: entry.revision }), 409);
  assert.deepEqual((await f.state()).todos, [done]);
});

test('三个 profile 保存完整 MD 和 revision，拒绝过期、缺失及 null revision 并保留原文', testOptions, async t => {
  const f = await fixture(t);
  for (const name of ['soul', 'user', 'system']) {
    const before = (await f.state()).profiles[name];
    assert.equal(before.revision, digest(before.text));
    const text = before.text + '\n# 测试设定\n保留空行\n\n';
    const saved = assertStatus(await f.post(`/api/profiles/${name}`, { text, revision: before.revision }), 200);
    assert.deepEqual(saved, { text, revision: digest(text) });
    for (const revision of [before.revision, undefined, null]) assertStatus(await f.post(`/api/profiles/${name}`, { text: before.text, revision }), 409);
    assert.equal(await f.read(`${name}.md`), text);
    assert.deepEqual((await f.state()).profiles[name], { ...saved, body: (name === 'user' ? '' : PROFILE_DEFAULTS[name]) + '\n# 测试设定\n保留空行\n\n' });
  }
  const profiles = (await f.state()).profiles;
  await f.restart();
  assert.deepEqual((await f.state()).profiles, profiles);
});

test('profile 仅允许固定名称和字符串正文，不接受文件名、编码路径或超长正文', testOptions, async t => {
  const f = await fixture(t), before = (await f.state()).profiles;
  for (const name of ['settings', 'unknown', 'soul.md', '..%2Fsoul', '%2Ftmp%2Fsoul', 'SOUL']) assertStatus(await f.post(`/api/profiles/${name}`, { text: '不得写入', revision: null }), 400);
  for (const text of [null, true, 12, {}, [], '字'.repeat(12001)]) assertStatus(await f.post('/api/profiles/user', { text, revision: before.user.revision }), 400);
  assert.deepEqual((await f.state()).profiles, before);
  const text = '字'.repeat(12000);
  assert.equal(assertStatus(await f.post('/api/profiles/user', { text, revision: before.user.revision }), 200).text, text);
});

test('soul profile 拒绝非法昵称和错误 frontmatter；合法中文与模板括号按原文保存', testOptions, async t => {
  const f = await fixture(t), before = (await f.state()).profiles.soul;
  // frontmatter 的未引号标量按普通文本解析；非字符串名字通过 JSON 设置接口验证。
  for (const assistantName of [null, true, 123, {}, []]) assertStatus(await f.post('/api/settings', { assistantName }), 400);
  const invalid = ['字'.repeat(41), '名\n字', '名\u0000字', '名\u0085字', '名\u2028字', '名\u202e字', '名\u2069字', '名\u200b字', '\ud800'];
  for (const name of invalid) {
    const text = `---\nassistantName: ${JSON.stringify(name)}\n---\n不可覆盖\n`;
    assertStatus(await f.post('/api/profiles/soul', { text, revision: before.revision }), 400);
  }
  for (const text of ['没有 frontmatter', '---\nother: x\n---\n', '---\nassistantName: 甲\nassistantName: 乙\n---\n']) assertStatus(await f.post('/api/profiles/soul', { text, revision: before.revision }), 400);
  assert.deepEqual((await f.state()).profiles.soul, before);
  assert.equal((await f.state()).settings.assistantName, 'Claudia');
  const text = '---\nassistantName: "小岚 {{literal}}"\n---\n正文\n';
  assertStatus(await f.post('/api/profiles/soul', { text, revision: before.revision }), 200);
  assert.equal((await f.state()).settings.assistantName, '小岚 {{literal}}');
  assert.equal(await f.read('soul.md'), text);
});

test('外部编辑 journal、todo 和 memory MD 在下一次 state 回读；Todo 旧 revision 不能覆盖外部修改', testOptions, async t => {
  const f = await fixture(t);
  const journal = assertStatus(await f.post('/api/journal', { text: '原始日记', occurredAt: start }), 201);
  const todo = assertStatus(await f.post('/api/todos', { text: '原始待办' }), 201);
  const memory = assertStatus(await f.post('/api/memories', { text: '原始记忆' }), 201);
  await f.write(`journal/${journal.id}.md`, (await f.read(`journal/${journal.id}.md`)).replace('原始日记', '外部日记\n保留第二行'));
  await f.write('todo.md', (await f.read('todo.md')).replace('- [ ] 原始待办', '- [x] 外部待办'));
  await f.write('memory.md', (await f.read('memory.md')).replace('原始记忆', '外部记忆'));
  const state = await f.state();
  assert.equal(state.journal[0].id, journal.id);
  assert.equal(state.journal[0].text, '外部日记\n保留第二行');
  assert.equal(state.todos[0].id, todo.id);
  assert.equal(state.todos[0].text, '外部待办');
  assert.equal(state.todos[0].status, 'done');
  assert.notEqual(state.todos[0].revision, todo.revision);
  assert.equal(state.memories[0].id, memory.id);
  assert.equal(state.memories[0].text, '外部记忆');
  assertStatus(await f.post(`/api/todos/${todo.id}`, { status: 'todo', revision: todo.revision }), 409);
  await f.restart();
  const restarted = await f.state();
  for (const key of ['journal', 'todos', 'memories']) assert.deepEqual(restarted[key], state[key]);
  assert.deepEqual(f.calls.run, []);
});

test('外部 profile 与四 bool MD 修改立即回读，不隐式启用后台或运行模型', testOptions, async t => {
  const f = await fixture(t), before = await f.state();
  for (const name of ['soul', 'user', 'system']) {
    let text = before.profiles[name].text + '\n外部追加的设定\n';
    if (name === 'soul') text = text.replace('"Claudia"', '"外部昵称"');
    await f.write(`${name}.md`, text);
    assert.deepEqual((await f.state()).profiles[name], { text, revision: digest(text), body: (name === 'user' ? '' : PROFILE_DEFAULTS[name]) + '\n外部追加的设定\n' });
    assertStatus(await f.post(`/api/profiles/${name}`, { text: before.profiles[name].text, revision: before.profiles[name].revision }), 409);
  }
  let settings = await f.read('settings.md');
  for (const key of featureBools) settings = settings.replace(`${key}: false`, `${key}: true`);
  await f.write('settings.md', settings + '\n外部说明\n');
  const state = await f.state();
  assert.equal(state.settings.assistantName, '外部昵称');
  for (const key of featureBools) assert.equal(state.settings[key], true, key);
  assert.equal(state.settings.allowContext, false);
  for (const key of ['activity', 'background', 'reflection', 'run']) assert.deepEqual(f.calls[key], [], key);
  await f.restart();
  const restarted = await f.state();
  assert.deepEqual(restarted.profiles, state.profiles);
  assert.deepEqual(restarted.settings, state.settings);
});

test('四 bool 仅接受真正布尔值，非法值不产生部分保存；activity 仅由显式设置调用', testOptions, async t => {
  const f = await fixture(t), settingsBefore = await f.read('settings.md'), soulBefore = await f.read('soul.md');
  for (const key of boolKeys) {
    for (const value of ['true', 'false', 0, 1, null, {}, []]) assertStatus(await f.post('/api/settings', { assistantName: '不得部分保存', [key]: value }), 400);
  }
  assert.equal(await f.read('settings.md'), settingsBefore);
  assert.equal(await f.read('soul.md'), soulBefore);
  assert.deepEqual(f.calls.activity, []);
  for (const enabled of [true, false]) {
    const values = Object.fromEntries(boolKeys.map(key => [key, enabled]));
    const result = assertStatus(await f.post('/api/settings', values), 200);
    for (const key of boolKeys) assert.equal(result.settings[key], enabled, key);
    assert.equal((await f.state()).activity.enabled, enabled);
    assert.deepEqual(f.app.store.get('reflectionSources'), enabled ? ['journal', 'todos', 'activity'] : ['journal', 'todos']);
  }
  assert.deepEqual(f.calls.activity, [true, false]);
  assert.deepEqual(f.calls.background, []);
  assert.deepEqual(f.calls.reflection, []);
  assert.deepEqual(f.calls.run, []);
});

test('settings 拒绝 key、API key、模型配置和未知字段，既不持久化也不泄漏输入值', testOptions, async t => {
  const f = await fixture(t), before = await f.state();
  const settingsBefore = await f.read('settings.md'), soulBefore = await f.read('soul.md');
  for (const key of ['key', 'apiKey', 'baseUrl', 'endpoint', 'provider', 'model', 'credentials', 'unknown', 'backgroundEnabled', 'path', '__proto__']) {
    const value = `SYNTHETIC_REJECTED_${key}`;
    const response = await f.post('/api/settings', { assistantName: '不可保存', activityEnabled: true, [key]: value });
    assertStatus(response, 400);
    assert.equal(response.raw.includes(value), false);
    assert.equal(f.app.store.get(key), null);
    assertNoSecretFields(response.data);
  }
  assert.equal(await f.read('settings.md'), settingsBefore);
  assert.equal(await f.read('soul.md'), soulBefore);
  assert.deepEqual((await f.state()).settings, before.settings);
  assert.deepEqual(f.calls.activity, []);
  assert.deepEqual(f.calls.background, []);
  assertNoSecretFields(await f.state());
  assertNoSecretFields(await f.health());
});

test('open-folder 仅 POST 调用固定 dataDir，GET 和 URL 中路径不能替换实际回调参数', testOptions, async t => {
  const f = await fixture(t);
  assertStatus(await f.request('/api/open-folder'), 404);
  assert.deepEqual(f.calls.openFolder, []);
  assert.deepEqual(assertStatus(await f.post('/api/open-folder'), 200), { ok: true });
  assert.deepEqual(f.calls.openFolder, [[f.dataDir]]);
  const response = await f.post(`/api/open-folder?path=${encodeURIComponent(join(f.root, 'not-the-data-directory'))}`);
  assert.ok([200, 400].includes(response.status), response.raw);
  assert.ok(f.calls.openFolder.every(args => args.length === 1 && args[0] === f.dataDir));
});

test('open-folder 必须拒绝用户提供的路径字段且不调用打开回调，而非静默忽略', testOptions, async t => {
  const f = await fixture(t), observed = [];
  for (const body of [{ path: join(f.root, 'untrusted') }, { dataDir: join(f.root, 'other') }, { directory: '../outside' }, { target: 'file:///untrusted' }]) {
    const response = await f.post('/api/open-folder', body);
    observed.push({ status: response.status, calls: f.calls.openFolder.length });
  }
  assert.deepEqual(observed, Array(4).fill({ status: 400, calls: 0 }), '用户路径必须拒绝，不能返回成功并打开文件夹');
});

test('open-harness 仅调用注入的无参数回调，缺少系统回调时明确返回 501', testOptions, async t => {
  const f = await fixture(t);
  assertStatus(await f.request('/api/open-harness'), 404);
  assert.deepEqual(f.calls.openHarness, []);
  assert.deepEqual(assertStatus(await f.post('/api/open-harness'), 200), { ok: true });
  assert.deepEqual(f.calls.openHarness, [[]]);
  assert.deepEqual(f.calls.openFolder, []);
  const unavailable = await fixture(t, { withOpenCallbacks: false });
  assertStatus(await unavailable.post('/api/open-folder'), 501);
  assertStatus(await unavailable.post('/api/open-harness'), 501);
  assert.deepEqual(unavailable.calls.openFolder, []);
  assert.deepEqual(unavailable.calls.openHarness, []);
});

test('background 默认关闭，state、health、GET 和设置其他开关不启用；只有合法 POST 调用 setEnabled', testOptions, async t => {
  const f = await fixture(t);
  assert.equal((await f.state()).background.enabled, false);
  await f.health();
  assertStatus(await f.request('/api/background'), 404);
  assertStatus(await f.post('/api/settings', { autoUpdateEnabled: true, memorySuggestionsEnabled: true }), 200);
  assert.equal((await f.state()).background.enabled, false);
  for (const enabled of [undefined, null, 'true', 'false', 1, 0, {}, []]) assertStatus(await f.post('/api/background', { enabled }), 400);
  assert.deepEqual(f.calls.background, []);
  for (const enabled of [true, false]) {
    assert.deepEqual(assertStatus(await f.post('/api/background', { enabled }), 200), { enabled, supported: true, running: enabled });
    assert.equal((await f.state()).background.enabled, enabled);
  }
  assert.deepEqual(f.calls.background, [true, false]);
  assert.deepEqual(f.calls.run, []);
  const unavailable = await fixture(t, { withBackground: false });
  assert.deepEqual((await unavailable.state()).background, { enabled: false, supported: false });
  assertStatus(await unavailable.post('/api/background', { enabled: true }), 501);
  assert.deepEqual(unavailable.calls.background, []);
});

test('maintenance busy 阻止 chat/settings/profile/reset/background/reflection；health 实时报告 home/profile/busy', testOptions, async t => {
  const f = await fixture(t);
  assertStatus(await f.post('/api/settings', { reflectionEnabled: true }), 200);
  const before = await f.state();
  assert.equal((await f.health()).busy, false);
  f.controls.maintenanceRunning = true;
  assert.equal(f.calls.createServices[0].isBusy(), false, '注入 isBusy 只代表前台/配置/关闭，避免 maintenance 自锁');
  const health = await f.health();
  assert.equal(health.busy, true);
  assert.equal(health.home, f.home);
  assert.equal(health.profile, f.profile);
  assert.equal((await f.state()).maintenance.running, true);
  for (const [path, body] of [
    ['/api/chat', { text: '不得调用模型' }],
    ['/api/settings', { assistantName: '不得保存', activityEnabled: true }],
    ['/api/profiles/user', { text: '不得保存', revision: before.profiles.user.revision }],
    ['/api/session/reset', {}], ['/api/background', { enabled: true }], ['/api/reflections/run', {}],
  ]) assertStatus(await f.post(path, body), 409);
  const after = await f.state();
  for (const key of ['settings', 'profiles', 'messages', 'sessionId']) assert.deepEqual(after[key], before[key]);
  for (const key of ['prepare', 'run', 'activity', 'release', 'background', 'reflection']) assert.deepEqual(f.calls[key], [], key);
  f.controls.maintenanceRunning = false;
  assert.equal((await f.health()).busy, false);
  assertStatus(await f.post('/api/settings', { assistantName: '空闲后保存' }), 200);
  assert.equal(assertStatus(await f.post('/api/chat', { text: '纯模拟回复' }), 200).at(-1).message.status, 'complete');
});

test('前台 chat 期间 health 与注入 isBusy 为 true，维护和 settings 被拒绝，结束后释放锁', testOptions, async t => {
  const f = await fixture(t);
  assertStatus(await f.post('/api/settings', { reflectionEnabled: true }), 200);
  f.controls.holdChat = true;
  const chat = f.post('/api/chat', { text: '等待测试门闩' });
  await f.chatStarted.promise;
  assert.equal((await f.health()).busy, true);
  assert.equal(f.calls.createServices[0].isBusy(), true);
  assertStatus(await f.post('/api/reflections/run'), 409);
  assertStatus(await f.post('/api/settings', { assistantName: '不得写入' }), 409);
  assertStatus(await f.post('/api/background', { enabled: true }), 409);
  assert.deepEqual(f.calls.reflection, []);
  f.chatFinished.resolve();
  assert.equal(assertStatus(await chat, 200).at(-1).message.status, 'complete');
  assert.equal((await f.health()).busy, false);
  assert.equal(f.calls.createServices[0].isBusy(), false);
});

test('background 配置回调未完成时 health/isBusy 置忙并阻止 chat/settings，完成后解锁', testOptions, async t => {
  const f = await fixture(t);
  f.controls.holdBackground = true;
  const background = f.post('/api/background', { enabled: true });
  await f.backgroundStarted.promise;
  assert.equal((await f.health()).busy, true);
  assert.equal(f.calls.createServices[0].isBusy(), true);
  assertStatus(await f.post('/api/chat', { text: '不能并发' }), 409);
  assertStatus(await f.post('/api/settings', { activityEnabled: true }), 409);
  assertStatus(await f.post('/api/background', { enabled: false }), 409);
  assert.deepEqual(f.calls.background, [true]);
  assert.deepEqual(f.calls.run, []);
  f.backgroundFinished.resolve();
  assertStatus(await background, 200);
  assert.equal((await f.health()).busy, false);
  assert.equal(f.calls.createServices[0].isBusy(), false);
});

test('reflection 默认关闭及再次关闭后都不能 run；开启本身不运行，显式 POST 才调用维护替身', testOptions, async t => {
  const f = await fixture(t);
  assertStatus(await f.post('/api/reflections/run'), 400);
  assert.deepEqual(f.calls.reflection, []);
  assertStatus(await f.post('/api/settings', { reflectionEnabled: true }), 200);
  assert.deepEqual(f.calls.reflection, []);
  assertStatus(await f.request('/api/reflections/run'), 404);
  const response = assertStatus(await f.post('/api/reflections/run'), 200);
  assert.deepEqual(response, f.app.services.maintenance.status());
  assert.deepEqual(f.calls.reflection, [[]]);
  const reflections = (await f.state()).reflections;
  assert.equal(reflections.length, 1);
  assert.equal(reflections[0].text, '纯测试回顾');
  assertStatus(await f.post('/api/settings', { reflectionEnabled: false }), 200);
  assertStatus(await f.post('/api/reflections/run'), 400);
  assert.deepEqual(f.calls.reflection, [[]]);
  assert.deepEqual((await f.state()).reflections, reflections);
  assert.deepEqual(f.calls.prepare, []);
  assert.deepEqual(f.calls.run, []);
});

test('reflection 列表按时间排序，保存需 revision，外部 MD 回读与冲突保护；关闭开关仍可手工编辑', testOptions, async t => {
  const f = await fixture(t);
  const older = f.app.store.saveReflection({ id: 'older', text: '旧回顾', start, end, createdAt: start });
  const entry = f.app.store.saveReflection({ id: 'newer', text: '待修订回顾', start, end, createdAt: end });
  assert.deepEqual((await f.state()).reflections, [entry, older]);
  const path = `/api/reflections/${entry.id}`;
  for (const revision of [undefined, null, '0'.repeat(64)]) assertStatus(await f.post(path, { text: '不得覆盖', revision }), 409);
  for (const text of ['', '  ', null, true, {}, [], '字'.repeat(12001)]) assertStatus(await f.post(path, { text, revision: entry.revision }), 400);
  assertStatus(await f.post('/api/reflections/missing', { text: '没有这条回顾' }), 404);
  const saved = assertStatus(await f.post(path, { text: '  人工修订\n第二行  ', revision: entry.revision }), 200);
  assert.equal(saved.text, '人工修订\n第二行');
  assert.equal(saved.createdAt, entry.createdAt);
  assert.equal(saved.start, start);
  assert.equal(saved.end, end);
  assert.notEqual(saved.revision, entry.revision);
  assertStatus(await f.post(path, { text: '旧版本覆盖', revision: entry.revision }), 409);
  const filename = `reflections/${digest(entry.id)}.md`;
  await f.write(filename, (await f.read(filename)).replace('人工修订', '外部修订'));
  const external = (await f.state()).reflections[0];
  assert.equal(external.text, '外部修订\n第二行');
  assert.notEqual(external.revision, saved.revision);
  assertStatus(await f.post(path, { text: '过期覆盖', revision: saved.revision }), 409);
  assert.deepEqual((await f.state()).reflections, [external, older]);
  assert.equal((await f.state()).settings.reflectionEnabled, false);
  await f.restart();
  assert.deepEqual((await f.state()).reflections, [external, older]);
  assert.deepEqual(f.calls.reflection, []);
});

test('候选 accept 生成一次确认记忆，reject 保留记录不生成记忆；重复决定幂等，反向决定冲突', testOptions, async t => {
  const f = await fixture(t), source = { kind: 'reflection', id: 'synthetic-source' };
  const [accept, reject] = f.app.store.addMemoryCandidates([{ text: '原始建议', source }, { text: '不接受的建议', source }]);
  assert.deepEqual((await f.state()).memoryCandidates, [accept, reject]);
  assert.deepEqual((await f.state()).memories, []);
  await f.write('memory.md', (await f.read('memory.md')).replace('原始建议', '外部修订建议'));
  const accepted = assertStatus(await f.post(`/api/memory-candidates/${accept.id}`, { accept: true }), 200);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.text, '外部修订建议');
  assert.deepEqual(accepted.source, source);
  assert.match(accepted.memoryId, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(accepted.decidedAt)));
  assert.deepEqual(assertStatus(await f.post(`/api/memory-candidates/${accept.id}`, { accept: true }), 200), accepted);
  const rejected = assertStatus(await f.post(`/api/memory-candidates/${reject.id}`, { accept: false }), 200);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.text, reject.text);
  assert.equal(Object.hasOwn(rejected, 'memoryId'), false);
  assert.deepEqual(assertStatus(await f.post(`/api/memory-candidates/${reject.id}`, { accept: false }), 200), rejected);
  assertStatus(await f.post(`/api/memory-candidates/${accept.id}`, { accept: false }), 409);
  assertStatus(await f.post(`/api/memory-candidates/${reject.id}`, { accept: true }), 409);
  const state = await f.state();
  assert.deepEqual(state.memoryCandidates, [accepted, rejected]);
  assert.equal(state.memories.length, 1);
  assert.equal(state.memories[0].id, accepted.memoryId);
  assert.equal(state.memories[0].text, accepted.text);
  await f.restart();
  assert.deepEqual((await f.state()).memoryCandidates, state.memoryCandidates);
  assert.deepEqual((await f.state()).memories, state.memories);
  assert.deepEqual(f.calls.run, []);
});

test('候选决定拒绝非 bool、错误及不存在的 ID，不生成记忆或改变 pending', testOptions, async t => {
  const f = await fixture(t);
  const [entry] = f.app.store.addMemoryCandidates([{ text: '保持待审核', source: 'synthetic' }]);
  for (const accept of [undefined, null, 'true', 'false', 0, 1, {}, []]) assertStatus(await f.post(`/api/memory-candidates/${entry.id}`, { accept }), 400);
  assertStatus(await f.post(`/api/memory-candidates/${randomUUID()}`, { accept: true }), 404);
  assertStatus(await f.post('/api/memory-candidates/not-a-uuid', { accept: false }), 400);
  assert.deepEqual((await f.state()).memoryCandidates, [entry]);
  assert.deepEqual((await f.state()).memories, []);
});

test('新增写接口统一要求 CSRF 与 JSON，未授权请求不能修改记录或触发系统替身', testOptions, async t => {
  const f = await fixture(t);
  const todo = f.app.store.addTodo('受保护待办');
  const reflection = f.app.store.saveReflection({ id: 'protected', text: '受保护回顾', start, end });
  const [candidate] = f.app.store.addMemoryCandidates([{ text: '受保护候选', source: 'synthetic' }]);
  const before = await f.state();
  const routes = [
    ['/api/todos', { text: '不应创建' }],
    [`/api/todos/${todo.id}`, { status: 'done', revision: todo.revision }],
    ['/api/profiles/user', { text: '不应修改', revision: before.profiles.user.revision }],
    [`/api/reflections/${reflection.id}`, { text: '不应修改', revision: reflection.revision }],
    ['/api/reflections/run', {}],
    [`/api/memory-candidates/${candidate.id}`, { accept: true }],
    ['/api/open-folder', {}], ['/api/open-harness', {}], ['/api/background', { enabled: true }],
    ['/api/settings', { activityEnabled: true }],
  ];
  for (const [path, body] of routes) {
    for (const headers of [{ 'x-claudia-token': undefined }, { 'x-claudia-token': 'invalid' }, { 'content-type': 'text/plain' }]) assertStatus(await f.post(path, body, { headers }), 403);
  }
  const after = await f.state();
  for (const key of ['todos', 'profiles', 'reflections', 'memoryCandidates', 'memories', 'settings']) assert.deepEqual(after[key], before[key]);
  for (const key of ['openFolder', 'openHarness', 'background', 'activity', 'reflection', 'run']) assert.deepEqual(f.calls[key], [], key);
});

test('未注入 logger 时日志接口可用但为空，open-logs 明确 501 且不调用打开回调', testOptions, async t => {
  const f = await fixture(t);
  const payload = assertStatus(await f.request('/api/logs'), 200);
  assert.deepEqual(payload.lines, []);
  assert.equal(payload.status.dir, '');
  assert.deepEqual((await f.state()).logs, payload.status);
  assertStatus(await f.post('/api/open-logs'), 501);
  assert.deepEqual(f.calls.openFolder, []);
});

test('注入 logger 后日志接口返回真实事件，open-logs 只打开日志目录', testOptions, async t => {
  const f = await fixture(t, { withLogger: true });
  // 触发一次 5xx：runtime.status 抛错会让 /api/health 走 500 分支并记录 http.error。
  f.controls.failRuntimeStatus = true;
  await f.request('/api/health');
  f.controls.failRuntimeStatus = false;
  const payload = assertStatus(await f.request('/api/logs'), 200);
  assert.ok(payload.status.dir.endsWith(join('claudia', 'logs')), payload.status.dir);
  assert.ok(payload.lines.some(line => line.includes('http.error')), payload.lines.join('\n'));
  // 日志只记录方法、路径与状态，不得出现请求体或对话内容。
  assert.ok(payload.lines.every(line => !line.includes('synthetic-provider')));
  assertStatus(await f.post('/api/open-logs'), 200);
  assert.deepEqual(f.calls.openFolder, [[payload.status.dir]]);
  // limit 只接受正整数，非法值回落默认值而不是报错或读取全部。
  assert.equal(assertStatus(await f.request('/api/logs?limit=abc'), 200).lines.length <= 200, true);
  assert.equal(assertStatus(await f.request('/api/logs?limit=1'), 200).lines.length, 1);
});

test('日志接口拒绝写方法、外部路径与缺少凭证的请求', testOptions, async t => {
  const f = await fixture(t, { withLogger: true });
  assertStatus(await f.post('/api/logs'), 404);
  for (const body of [{ path: join(f.root, 'untrusted') }, { dir: '../outside' }, { limit: 10 }]) {
    assertStatus(await f.post('/api/open-logs', body), 400);
  }
  for (const headers of [{ 'x-claudia-token': undefined }, { 'x-claudia-token': 'invalid' }, { 'content-type': 'text/plain' }]) {
    assertStatus(await f.post('/api/open-logs', {}, { headers }), 403);
  }
  assert.deepEqual(f.calls.openFolder, []);
});

test('日志目录尚未创建时 open-logs 返回 409 而不是 500', testOptions, async t => {
  const f = await fixture(t, { withLogger: true });
  // 刚启动还没有任何事件落盘，目录不存在；此时不能把它当成本机操作失败。
  assert.equal((await f.state()).logs.day, '');
  assertStatus(await f.post('/api/open-logs'), 409);
  assert.deepEqual(f.calls.openFolder, [], '目录不存在时不得调用打开回调');
  // 产生一条事件后目录出现，同一个按钮就应该可用。
  f.controls.failRuntimeStatus = true;
  await f.request('/api/health');
  f.controls.failRuntimeStatus = false;
  assertStatus(await f.post('/api/open-logs'), 200);
  assert.equal(f.calls.openFolder.length, 1);
});
