import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

const testOptions = { timeout: 15_000 };

// 只模拟原生接口，不加载 Harness、native-runtime 或任何模型凭据。
function createStubRuntime(store, options = {}) {
  const calls = { prepare: [], run: [], cancel: [], release: [], close: 0 };
  const handles = new Map();
  const pending = new Set();
  const selection = { provider: 'harness-provider', model: 'harness-model', reasoningEffort: 'high' };
  const status = {
    installed: true,
    version: '测试宿主版本',
    configured: true,
    connected: true,
    credentialSource: 'harness',
    modelVerified: false,
    ...options.status,
  };
  const deltas = options.deltas ?? ['你好，', '这是完整回复。'];
  const resultText = options.resultText ?? deltas.join('');
  const reasonKind = options.reasonKind ?? 'completed';
  const runtime = {
    store, calls, handles, pending, hostSelection: selection, hostStatus: status,
    closed: false,
    error: '',
    selection() { return { ...selection }; },
    async status() { return { ...status, connected: !runtime.closed && status.connected, error: runtime.error }; },
    async prepare(sessionId) {
      assert.equal(runtime.closed, false);
      calls.prepare.push(sessionId);
      if (!handles.has(sessionId)) handles.set(sessionId, { sessionId });
      return handles.get(sessionId);
    },
    async run(sessionId, text, { onDelta = () => {} } = {}) {
      assert.ok(handles.has(sessionId), '调用 run 前必须 prepare');
      calls.run.push({ sessionId, text });
      const completion = Promise.withResolvers();
      const record = { sessionId, finish: completion.resolve };
      pending.add(record);
      try {
        for (const delta of deltas) onDelta(delta);
        if (!options.holdRun) record.finish({ text: resultText, reason: { kind: reasonKind } });
        const result = await completion.promise;
        if (result.reason.kind === 'completed' && result.text) status.modelVerified = true;
        return result;
      } finally {
        pending.delete(record);
      }
    },
    complete() {
      for (const record of pending) record.finish({ text: resultText, reason: { kind: reasonKind } });
    },
    async cancel(sessionId) {
      calls.cancel.push(sessionId);
      for (const record of pending) {
        if (record.sessionId === sessionId) record.finish({ text: deltas.join(''), reason: { kind: 'aborted' } });
      }
    },
    async release(sessionId) {
      calls.release.push(sessionId);
      handles.delete(sessionId);
    },
    async close() {
      calls.close += 1;
      runtime.closed = true;
      for (const record of pending) record.finish({ text: deltas.join(''), reason: { kind: 'aborted' } });
      handles.clear();
    },
  };
  return runtime;
}

async function fixture(t, runtimeOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'claudia-native-api-'));
  const liveApps = new Set();
  const clients = new Set();
  const requests = new Set();
  let app;
  let token;

  async function shutdown(instance) {
    await instance.close();
    liveApps.delete(instance);
    assert.equal(instance.server.listening, false, 'HTTP 必须停止监听');
    assert.equal(instance.runtime.calls.close, 1, 'runtime 必须且只能关闭一次');
    assert.equal(instance.runtime.pending.size, 0, '不得遗留运行中的回复');
    assert.equal(instance.runtime.handles.size, 0, '不得遗留 runtime 会话');
    assert.throws(() => instance.store.get('sessionId'), /not open|closed/i, 'SQLite 必须已关闭');
  }

  t.after(async () => {
    try {
      for (const instance of liveApps) await shutdown(instance);
    } finally {
      for (const client of clients) client.destroy();
      await Promise.allSettled([...requests]);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  function request(path, { method = 'GET', body, headers = {}, onEvent } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders = { connection: 'close' };
    if (method !== 'GET') {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['x-claudia-token'] = token;
    }
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) delete requestHeaders[key];
      else requestHeaders[key] = value;
    }
    const result = new Promise((resolve, reject) => {
      const client = httpRequest(new URL(path, app.url), { method, headers: requestHeaders, agent: false }, response => {
        response.setEncoding('utf8');
        const streaming = response.headers['content-type']?.startsWith('application/x-ndjson');
        const events = [];
        let raw = '';
        let buffered = '';
        response.on('data', chunk => {
          raw += chunk;
          if (!streaming) return;
          buffered += chunk;
          try {
            let newline;
            while ((newline = buffered.indexOf('\n')) !== -1) {
              const line = buffered.slice(0, newline);
              buffered = buffered.slice(newline + 1);
              if (!line) continue;
              const event = JSON.parse(line);
              events.push(event);
              onEvent?.(event);
            }
          } catch (error) {
            response.destroy(error);
            reject(error);
          }
        });
        response.on('end', () => {
          try {
            if (streaming) assert.equal(buffered, '', 'NDJSON 事件必须完整结束');
            resolve({ status: response.statusCode, headers: response.headers, data: streaming ? events : JSON.parse(raw), raw });
          } catch (error) { reject(error); }
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('HTTP 响应意外中断')));
      });
      clients.add(client);
      client.once('close', () => clients.delete(client));
      client.on('error', reject);
      client.setTimeout(5_000, () => client.destroy(new Error('测试 HTTP 请求超时')));
      client.end(payload);
    });
    requests.add(result);
    result.then(() => requests.delete(result), () => requests.delete(result));
    return result;
  }

  async function boot() {
    app = await startServer({ dataDir, port: 0, createRuntime: store => createStubRuntime(store, runtimeOptions) });
    liveApps.add(app);
    const bootstrap = await request('/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.match(bootstrap.data.csrfToken, /^[a-f0-9]{64}$/);
    token = bootstrap.data.csrfToken;
  }

  await boot();
  return {
    get app() { return app; },
    get runtime() { return app.runtime; },
    get token() { return token; },
    request,
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    async state() {
      const response = await request('/api/state');
      assert.equal(response.status, 200);
      return response.data;
    },
    async restart() { await shutdown(app); await boot(); },
    async close() { await shutdown(app); },
  };
}

function assertNoCredentialFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['apiKey', 'baseUrl'].includes(key), `公开 API 不得包含 ${key}`);
    assertNoCredentialFields(child);
  }
}

function attachedContext(prompt, text) {
  assert.ok(prompt.startsWith(`${text}\n\n<local_context_untrusted>\n`));
  assert.ok(prompt.endsWith('\n</local_context_untrusted>'));
  const lines = prompt.split('\n');
  return JSON.parse(lines.at(-2));
}

test('默认昵称 Claudia，默认不分享上下文，Store 由 createRuntime 注入', testOptions, async t => {
  const f = await fixture(t);
  const state = await f.state();
  assert.equal(state.settings.assistantName, 'Claudia');
  assert.equal(state.settings.allowContext, false);
  assert.equal(f.runtime.store, f.app.store);
  assert.deepEqual(state.journal, []);
  assert.deepEqual(state.messages, []);
  assert.equal(typeof state.sessionId, 'string');
  assertNoCredentialFields(state);
});

test('中文自定义昵称保存并在关闭 HTTP、Store 后重启保留', testOptions, async t => {
  const f = await fixture(t);
  const sessionId = (await f.state()).sessionId;
  const response = await f.post('/api/settings', { assistantName: '  小克劳迪娅  ', allowContext: true });
  assert.equal(response.status, 200);
  assert.equal(response.data.settings.assistantName, '小克劳迪娅');
  const oldApp = f.app;
  const oldToken = f.token;
  await f.restart();
  const state = await f.state();
  assert.notEqual(f.app, oldApp);
  assert.notEqual(f.token, oldToken);
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.settings.assistantName, '小克劳迪娅');
  assert.equal(state.settings.allowContext, true);
  assert.equal((await f.post('/api/settings', {}, { headers: { 'x-claudia-token': oldToken } })).status, 403);
});

test('空字符串和纯空格昵称恢复 Claudia，省略昵称不覆盖自定义名称', testOptions, async t => {
  const f = await fixture(t);
  for (const assistantName of ['', '   ', '\u3000\u00a0']) {
    assert.equal((await f.post('/api/settings', { assistantName: '自定义' })).status, 200);
    const response = await f.post('/api/settings', { assistantName });
    assert.equal(response.status, 200);
    assert.equal(response.data.settings.assistantName, 'Claudia');
  }
  await f.post('/api/settings', { assistantName: '中文助手' });
  const response = await f.post('/api/settings', { allowContext: true });
  assert.equal(response.status, 200);
  assert.equal(response.data.settings.assistantName, '中文助手');
});

test('昵称允许 40 字，超过 40 字拒绝且不覆盖原值', testOptions, async t => {
  const f = await fixture(t);
  const accepted = '名'.repeat(40);
  assert.equal((await f.post('/api/settings', { assistantName: accepted })).status, 200);
  for (const assistantName of ['名'.repeat(41), 'a'.repeat(41)]) {
    assert.equal((await f.post('/api/settings', { assistantName })).status, 400);
    assert.equal((await f.state()).settings.assistantName, accepted);
  }
});

test('昵称拒绝控制字符、换行、方向控制符及非字符串', testOptions, async t => {
  const f = await fixture(t);
  const controls = [
    ...Array.from({ length: 32 }, (_, index) => index),
    ...Array.from({ length: 33 }, (_, index) => 0x7f + index),
    0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];
  for (const code of controls) {
    const response = await f.post('/api/settings', { assistantName: `名${String.fromCodePoint(code)}字`, allowContext: true });
    assert.equal(response.status, 400, `必须拒绝 U+${code.toString(16).toUpperCase()}`);
  }
  for (const assistantName of [null, true, false, 123, {}, []]) {
    assert.equal((await f.post('/api/settings', { assistantName })).status, 400);
  }
  const state = await f.state();
  assert.equal(state.settings.assistantName, 'Claudia');
  assert.equal(state.settings.allowContext, false);
});

test('设置 API 拒绝 apiKey、baseUrl 和宿主模型字段，公开响应不暴露凭据字段', testOptions, async t => {
  const f = await fixture(t);
  for (const [key, value] of Object.entries({ apiKey: '仅供测试的假密钥', baseUrl: 'https://provider.invalid', provider: '其他供应商', model: '其他模型', reasoningEffort: 'low' })) {
    const response = await f.post('/api/settings', { assistantName: '不应保存', allowContext: true, [key]: value });
    assert.equal(response.status, 400, `${key} 不应由插件配置`);
    assert.equal(response.raw.includes(value), false);
    assert.equal(f.app.store.get(key), null);
    assertNoCredentialFields(response.data);
  }
  for (const path of ['/api/bootstrap', '/api/state', '/api/health']) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assertNoCredentialFields(response.data);
  }
  const state = await f.state();
  assert.equal(state.settings.assistantName, 'Claudia');
  assert.equal(state.settings.allowContext, false);
});

test('state 和 health 原样继承 Harness 状态及 modelVerified 的 true/false', testOptions, async t => {
  const f = await fixture(t);
  for (const [configured, modelVerified] of [[true, false], [true, true], [false, false]]) {
    Object.assign(f.runtime.hostStatus, { configured, modelVerified });
    const state = await f.state();
    const health = await f.request('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    assert.deepEqual(state.runtime, await f.runtime.status());
    assert.deepEqual(health.data.runtime, state.runtime);
    assert.equal(state.runtime.credentialSource, 'harness');
    assert.equal(state.runtime.configured, configured);
    assert.equal(state.runtime.modelVerified, modelVerified);
    assert.equal(typeof state.runtime.modelVerified, 'boolean');
    assert.equal(state.runtime.installed, true);
    assert.equal(state.runtime.connected, true);
    assert.equal(state.runtime.version, '测试宿主版本');
    assert.equal(state.settings.provider, 'harness-provider');
    assert.equal(state.settings.model, 'harness-model');
    assert.equal(state.settings.reasoningEffort, 'high');
  }
  Object.assign(f.runtime.hostSelection, { provider: '新宿主供应商', model: '新宿主模型' });
  const state = await f.state();
  assert.equal(state.settings.provider, '新宿主供应商');
  assert.equal(state.settings.model, '新宿主模型');
});

test('allowContext 仅接受 true/false，拒绝其他类型且配置写入原子化', testOptions, async t => {
  const f = await fixture(t);
  for (const allowContext of [true, false]) {
    const response = await f.post('/api/settings', { allowContext });
    assert.equal(response.status, 200);
    assert.equal(response.data.settings.allowContext, allowContext);
    assert.equal((await f.state()).settings.allowContext, allowContext);
  }
  for (const allowContext of ['true', 'false', 1, 0, null, [], {}]) {
    const response = await f.post('/api/settings', { assistantName: '不应保存', allowContext });
    assert.equal(response.status, 400);
  }
  const state = await f.state();
  assert.equal(state.settings.allowContext, false);
  assert.equal(state.settings.assistantName, 'Claudia');
});

test('Host 与 Origin 只接受当前本机端口，拒绝 cross-site', testOptions, async t => {
  const f = await fixture(t);
  const port = new URL(f.app.url).port;
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const response = await f.request('/api/state', { headers: { host, origin: `http://${host}` } });
    assert.equal(response.status, 200);
  }
  for (const headers of [
    { host: `attacker.invalid:${port}` },
    { host: 'localhost:1' },
    { host: `127.0.0.1:${port}.attacker.invalid` },
    { origin: 'https://attacker.invalid' },
    { origin: 'null' },
    { origin: `https://127.0.0.1:${port}` },
    { origin: 'http://localhost:1' },
    { origin: f.app.url, 'sec-fetch-site': 'cross-site' },
  ]) {
    assert.equal((await f.request('/api/state', { headers })).status, 403);
    assert.equal((await f.post('/api/journal', { text: '不得写入' }, { headers })).status, 403);
  }
  assert.deepEqual((await f.state()).journal, []);
});

test('POST 和 DELETE 需要正确 CSRF token 与 JSON 类型', testOptions, async t => {
  const f = await fixture(t);
  const entry = await f.post('/api/journal', { text: '保留的记录' });
  assert.equal(entry.status, 201);
  const invalidHeaders = [
    { 'x-claudia-token': undefined },
    { 'x-claudia-token': 'invalid-token' },
    { 'x-claudia-token': '0'.repeat(64) },
    { 'x-claudia-token': `${f.token}0` },
    { 'content-type': undefined },
    { 'content-type': 'text/plain' },
  ];
  for (const headers of invalidHeaders) {
    assert.equal((await f.post('/api/settings', { assistantName: '不得写入' }, { headers })).status, 403);
    const response = await f.request(`/api/journal/${entry.data.id}`, { method: 'DELETE', body: {}, headers });
    assert.equal(response.status, 403);
  }
  const accepted = await f.post('/api/settings', { assistantName: '安全助手' }, { headers: { origin: f.app.url, 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(accepted.status, 200);
  assert.equal((await f.state()).journal.length, 1);
  assert.equal((await f.request(`/api/journal/${entry.data.id}`, { method: 'DELETE', body: {} })).status, 200);
  assert.deepEqual((await f.state()).journal, []);
});

test('未配置模型返回 428，不 prepare、不运行、不写入消息，恢复配置后可发送', testOptions, async t => {
  const f = await fixture(t, { status: { configured: false } });
  assert.equal((await f.post('/api/chat', { text: '你好' })).status, 428);
  assert.deepEqual(f.runtime.calls.prepare, []);
  assert.deepEqual(f.runtime.calls.run, []);
  assert.deepEqual((await f.state()).messages, []);
  f.runtime.hostStatus.configured = true;
  assert.equal((await f.post('/api/chat', { text: '恢复后发送' })).status, 200);
  assert.equal(f.runtime.calls.run.length, 1);
});

test('run 模拟 delta 和 completion，完整回复与消息状态保存到 SQLite', testOptions, async t => {
  const f = await fixture(t, { deltas: ['流式', '片段'], resultText: '最终完整回答' });
  assert.equal((await f.state()).runtime.modelVerified, false);
  const response = await f.post('/api/chat', { text: '  你好  ' });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/x-ndjson/);
  assert.deepEqual(response.data.map(event => event.type), ['status', 'start', 'delta', 'delta', 'done']);
  const [status, start, first, second, done] = response.data;
  assert.equal(start.runId, status.runId);
  assert.match(status.runId, /^[a-f0-9-]{36}$/);
  assert.equal(first.text + second.text, '流式片段');
  assert.equal(done.message.id, start.id);
  assert.equal(done.message.content, '最终完整回答');
  assert.equal(done.message.status, 'complete');
  const state = await f.state();
  assert.deepEqual(f.runtime.calls.prepare, [state.sessionId]);
  assert.deepEqual(f.runtime.calls.run, [{ sessionId: state.sessionId, text: '你好' }]);
  assert.deepEqual(state.messages.map(({ role, content, status }) => ({ role, content, status })), [
    { role: 'user', content: '你好', status: 'complete' },
    { role: 'assistant', content: '最终完整回答', status: 'complete' },
  ]);
  assert.equal(state.runtime.modelVerified, true);
  await f.restart();
  assert.deepEqual((await f.state()).messages, state.messages);
});

for (const [reasonKind, expectedStatus, terminalType] of [
  ['max-tokens', 'truncated', 'done'],
  ['aborted', 'cancelled', 'done'],
  ['error', 'error', 'error'],
  ['unknown', 'error', 'error'],
]) {
  test(`运行终态 ${reasonKind} 不得误报 complete`, testOptions, async t => {
    const f = await fixture(t, { reasonKind });
    const response = await f.post('/api/chat', { text: '检查终态' });
    assert.equal(response.status, 200);
    assert.equal(response.data.at(-1).type, terminalType);
    const state = await f.state();
    assert.equal(state.messages.at(-1).status, expectedStatus);
    assert.equal(state.messages.at(-1).content, '你好，这是完整回复。');
    assert.equal(state.runtime.modelVerified, false);
  });
}

test('Journal 默认不发送，只把显式选择的 attachment 附在本次提示词', testOptions, async t => {
  const f = await fixture(t);
  const occurredAt = '2026-09-14T10:20:00.000Z';
  const selected = await f.post('/api/journal', { text: '  今天读了三页书  ', occurredAt });
  const excluded = await f.post('/api/journal', { text: '未选择的私密日记' });
  const memory = await f.post('/api/memories', { text: '未授权自动发送的记忆' });
  assert.equal(selected.status, 201);
  assert.equal(excluded.status, 201);
  assert.equal(memory.status, 201);
  assert.equal(selected.data.text, '今天读了三页书');
  assert.equal(selected.data.occurredAt, occurredAt);
  assert.ok(Number.isFinite(Date.parse(selected.data.createdAt)));
  assert.equal((await f.state()).journal.length, 2);
  assert.equal((await f.post('/api/chat', { text: '不带附件' })).status, 200);
  assert.equal(f.runtime.calls.run.at(-1).text, '不带附件');
  assert.equal((await f.post('/api/chat', { text: '看看附件', contextIds: [selected.data.id, selected.data.id] })).status, 200);
  const prompt = f.runtime.calls.run.at(-1).text;
  const context = attachedContext(prompt, '看看附件');
  assert.deepEqual(context.journal, [selected.data]);
  assert.deepEqual(context.sourceIds, [selected.data.id]);
  assert.deepEqual(context.confirmedMemories, []);
  assert.equal(prompt.includes(excluded.data.text), false);
  assert.equal(prompt.includes(memory.data.text), false);
  assert.equal((await f.state()).messages.at(-2).content, '看看附件');
  assert.equal((await f.post('/api/chat', { text: '下一轮不选择附件' })).status, 200);
  assert.equal(f.runtime.calls.run.at(-1).text, '下一轮不选择附件');
});

test('allowContext true 才附带未选 Journal 和确认记忆，切回 false 停止附带', testOptions, async t => {
  const f = await fixture(t);
  const journal = (await f.post('/api/journal', { text: '用于授权测试的日记' })).data;
  const memory = (await f.post('/api/memories', { text: '偏好简短回复' })).data;
  assert.equal((await f.post('/api/settings', { allowContext: true })).status, 200);
  assert.equal((await f.post('/api/chat', { text: '允许附带上下文' })).status, 200);
  const context = attachedContext(f.runtime.calls.run.at(-1).text, '允许附带上下文');
  assert.deepEqual(context.journal, [journal]);
  assert.deepEqual(context.confirmedMemories, [{ id: memory.id, text: memory.text }]);
  assert.deepEqual(context.sourceIds, [journal.id, memory.id]);
  assert.equal((await f.post('/api/settings', { allowContext: false })).status, 200);
  assert.equal((await f.post('/api/chat', { text: '停止附带上下文' })).status, 200);
  assert.equal(f.runtime.calls.run.at(-1).text, '停止附带上下文');
});

test('无效、已删除及超预算附件拒绝发送，不写消息且释放聊天锁', testOptions, async t => {
  const f = await fixture(t);
  const entry = (await f.post('/api/journal', { text: '随后删除的附件' })).data;
  assert.equal((await f.request(`/api/journal/${entry.id}`, { method: 'DELETE', body: {} })).status, 200);
  for (const contextIds of ['错误类型', null, [123], Array(31).fill('不存在'), [entry.id]]) {
    assert.equal((await f.post('/api/chat', { text: '无效附件', contextIds })).status, 400);
  }
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await f.post('/api/journal', { text: '字'.repeat(5000) });
    assert.equal(response.status, 201);
    ids.push(response.data.id);
  }
  assert.equal((await f.post('/api/chat', { text: '附件超预算', contextIds: ids })).status, 400);
  assert.equal(f.runtime.calls.run.length, 0);
  assert.equal(f.runtime.calls.prepare.length, 0);
  assert.deepEqual((await f.state()).messages, []);
  assert.equal((await f.post('/api/chat', { text: '后续正常发送' })).status, 200);
});

test('reset 释放旧 runtime 会话并清空当前聊天视图，保留 Journal、记忆与昵称', testOptions, async t => {
  const f = await fixture(t);
  await f.post('/api/settings', { assistantName: '小助手' });
  await f.post('/api/journal', { text: '重置后应保留的日记' });
  await f.post('/api/memories', { text: '重置后应保留的记忆' });
  await f.post('/api/chat', { text: '旧会话消息' });
  const before = await f.state();
  assert.equal(before.messages.length, 2);
  const reset = await f.post('/api/session/reset', {});
  assert.equal(reset.status, 200);
  assert.notEqual(reset.data.sessionId, before.sessionId);
  assert.deepEqual(f.runtime.calls.release, [before.sessionId]);
  assert.equal(f.runtime.handles.has(before.sessionId), false);
  const after = await f.state();
  assert.equal(after.sessionId, reset.data.sessionId);
  assert.deepEqual(after.messages, []);
  assert.deepEqual(after.journal, before.journal);
  assert.deepEqual(after.memories, before.memories);
  assert.equal(after.settings.assistantName, '小助手');
  await f.restart();
  const restarted = await f.state();
  assert.equal(restarted.sessionId, after.sessionId);
  assert.deepEqual(restarted.journal, before.journal);
  assert.deepEqual(restarted.messages, []);
  assert.equal((await f.post('/api/chat', { text: '新会话消息' })).status, 200);
  assert.equal(f.runtime.calls.run[0].sessionId, after.sessionId);
});

test('取消绑定 runId：错误、缺失及过期 ID 不影响运行，正确 ID 保存 cancelled', testOptions, async t => {
  const f = await fixture(t, { holdRun: true });
  const started = Promise.withResolvers();
  let runId;
  const chat = f.post('/api/chat', { text: '等待取消' }, { onEvent(event) {
    if (event.type === 'status') runId = event.runId;
    if (event.type === 'delta') started.resolve();
  } });
  await started.promise;
  assert.match(runId, /^[a-f0-9-]{36}$/);
  assert.equal((await f.post('/api/cancel', {})).status, 400);
  assert.equal((await f.post('/api/cancel', { runId: '错误的运行标识' })).status, 409);
  assert.deepEqual(f.runtime.calls.cancel, []);
  assert.equal((await f.state()).messages.at(-1).status, 'pending');
  const cancelled = await f.post('/api/cancel', { runId });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.data, { ok: true });
  const response = await chat;
  assert.equal(response.status, 200);
  assert.equal(response.data.at(-1).type, 'done');
  assert.equal(response.data.at(-1).message.status, 'cancelled');
  const state = await f.state();
  assert.equal(state.messages.at(-1).status, 'cancelled');
  assert.equal(state.messages.at(-1).content, '你好，这是完整回复。');
  assert.deepEqual(f.runtime.calls.cancel, [state.sessionId]);
  assert.equal(state.runtime.modelVerified, false);
  assert.equal((await f.post('/api/cancel', { runId })).status, 409);

  const nextStarted = Promise.withResolvers();
  let nextRunId;
  const next = f.post('/api/chat', { text: '另一次运行' }, { onEvent(event) {
    if (event.type === 'status') nextRunId = event.runId;
    if (event.type === 'delta') nextStarted.resolve();
  } });
  await nextStarted.promise;
  assert.notEqual(nextRunId, runId);
  assert.equal((await f.post('/api/cancel', { runId })).status, 409);
  assert.equal(f.runtime.calls.cancel.length, 1);
  f.runtime.complete();
  assert.equal((await next).data.at(-1).message.status, 'complete');
});

test('两个 chat 并发只有一个运行、另一个 409；运行期间 settings/reset 也返回 409', testOptions, async t => {
  const f = await fixture(t, { holdRun: true });
  const sessionId = (await f.state()).sessionId;
  const first = f.post('/api/chat', { text: '并发问题甲' });
  const second = f.post('/api/chat', { text: '并发问题乙' });
  const rejected = await Promise.race([first, second]);
  assert.equal(rejected.status, 409);
  assert.equal(f.runtime.calls.run.length, 1);
  assert.equal(f.runtime.calls.prepare.length, 1);
  assert.equal((await f.post('/api/settings', { assistantName: '不应写入' })).status, 409);
  assert.equal((await f.post('/api/session/reset', {})).status, 409);
  assert.deepEqual(f.runtime.calls.release, []);
  assert.equal((await f.state()).sessionId, sessionId);
  f.runtime.complete();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const state = await f.state();
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages.at(-1).status, 'complete');
  assert.equal(state.messages[0].content, f.runtime.calls.run[0].text);
  assert.equal(state.settings.assistantName, 'Claudia');
  assert.equal((await f.post('/api/settings', { assistantName: '运行结束后可写入' })).status, 200);
});

test('关闭服务器会取消未完成回复并关闭 HTTP、runtime 与 SQLite', testOptions, async t => {
  const f = await fixture(t, { holdRun: true });
  const started = Promise.withResolvers();
  const chat = f.post('/api/chat', { text: '关闭时仍在回复' }, { onEvent(event) {
    if (event.type === 'delta') started.resolve();
  } });
  await started.promise;
  const runtime = f.runtime;
  const sessionId = (await f.state()).sessionId;
  await f.close();
  const response = await chat;
  assert.equal(response.status, 200);
  assert.equal(response.data.at(-1).message.status, 'cancelled');
  assert.deepEqual(runtime.calls.cancel, [sessionId]);
  assert.equal(runtime.closed, true);
});
