import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NewsPolicy } from '../network-routine.mjs';

// 只替换宿主模块，不加载模型、网络或真实凭据，也不创建临时文件。
const modules = {
  '@deepseek-ai/dsh-llm': 'export const createUserMessage=x=>x;',
  '@deepseek-ai/dsh-agent': 'export const installModelSelection=(a,selection)=>{a.newsModelSelection=selection;};',
  '@deepseek-ai/dsh-system-prompt': 'export const PERSONA_PREFIX_SECTION="prefix", PERSONA_SUFFIX_SECTION="suffix";',
};
const hook = registerHooks({
  resolve(specifier, context, next) {
    return modules[specifier]
      ? { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true }
      : next(specifier, context);
  },
});
let NewsRuntime;
try { ({ NewsRuntime } = await import('../news-runtime.mjs')); }
finally { hook.deregister(); }

const secret = 'TEST_ONLY_SECRET_NEVER_ECHO';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const safe = error => {
  assert.equal(error.routineSafe, true);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.stack + JSON.stringify(error), new RegExp(secret));
  return true;
};
const schemaOf = ({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) });

function target(id = 'news') {
  const state = { mode: '', restrictions: [], guards: [], definitions: new Map(), sections: [], listeners: [], registrations: 0 };
  const inherited = [
    { name: 'shell', description: '继承命令', parameters: {} },
    { name: 'web_search', description: '继承的无预算搜索', parameters: { privateProfile: secret } },
    { name: 'web_fetch', description: '继承的无预算读取', parameters: { privateProfile: secret } },
  ];
  const ctx = {
    tools: {
      presentAs: mode => { state.mode = mode; },
      restrict: rule => { state.restrictions.push(rule); },
      guard: fn => { state.guards.push(fn); },
      register: definition => {
        assert.equal(state.definitions.has(definition.name), false);
        assert.equal(typeof definition.output.render, 'function');
        state.registrations++;
        state.definitions.set(definition.name, definition);
      },
    },
    systemPrompt: {
      section: section => { state.sections.push(section); },
      variable: () => { throw Error('不得注册个人变量'); },
      context: () => { throw Error('不得注册个人上下文'); },
    },
    on: (name, fn, options) => { state.listeners.push({ name, fn, options }); return () => {}; },
  };
  const agent = { session: { id }, ctx };
  const visible = () => {
    const inheritedVisible = inherited.filter(tool => state.restrictions.every(rule => rule.allow.includes(tool.name)));
    return [...new Map([...inheritedVisible, ...[...state.definitions.values()].map(schemaOf)].map(tool => [tool.name, tool])).values()];
  };
  const guard = name => state.guards.map(fn => fn({ name, agent })).find(reason => reason !== undefined);
  const assemble = async (next = async () => ({ tools: visible() })) => {
    const listener = state.listeners.find(item => item.name === 'system-prompt/assemble');
    assert.equal(listener.options.prepend, true);
    return listener.fn({}, { scope: agent }, next);
  };
  return { state, ctx, agent, visible, guard, assemble };
}

function fixture(t, { known = [], existing = [], web } = {}) {
  const data = new Map([['claudiaNewsSessionsV1', known], ['harnessSessions', ['ordinary-chat']]]);
  const events = new Map();
  const state = { scopes: [], followups: [], disposed: [], cancelled: [], options: [], beforeSetup: null, beforeTurn: null, onCancel: null, onDispose: null };
  const emit = (name, ...args) => { for (const fn of events.get(name) ?? []) fn(...args); };
  const ctx = {
    dshHomePath: name => join(tmpdir(), name),
    on: (name, fn) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(fn);
      return () => events.get(name).delete(fn);
    },
    agents: { list: () => existing.map(scope => scope.agent) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    llm: { resolveCallConfig: () => { throw Error('不得验证或读取真实模型配置'); } },
    web,
  };
  Object.defineProperty(ctx, 'key', { get() { throw Error('不得读取密钥'); } });
  const store = {
    get: (key, fallback) => { assert.ok(['claudiaNewsSessionsV1', 'harnessSessions'].includes(key)); return data.get(key) ?? fallback; },
    set: (key, value) => { data.set(key, value); },
    messages: () => [],
    profiles: () => { throw Error('不得读取个人资料'); },
  };
  const runtime = new NewsRuntime(ctx, store);
  t.after(() => runtime.close());
  const makeHandle = async options => {
    state.options.push(options);
    const id = options.sessionId ?? options.resumeSessionId;
    const scope = target(id);
    state.scopes.push(scope);
    let idle = Promise.resolve();
    let cancelled = false;
    scope.agent.followup = message => {
      state.followups.push(message);
      idle = (async () => {
        await state.beforeTurn?.(scope);
        emit('session/event', scope.agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"items":[]}' }] } } });
        emit('session/event', scope.agent.session, { type: 'turn/end', data: { reason: { kind: cancelled ? 'aborted' : 'completed' } } });
      })();
    };
    scope.agent.whenIdle = () => idle;
    scope.agent.cancel = () => { cancelled = true; state.cancelled.push(id); state.onCancel?.(scope); };
    const handle = { agent: scope.agent, dispose: async () => { state.disposed.push(id); await state.onDispose?.(scope); } };
    emit('agent/created', { agent: scope.agent });
    await state.beforeSetup?.(scope);
    options.setup(scope.ctx, scope.agent);
    return handle;
  };
  ctx.agents.resume = makeHandle;
  ctx.agents.create = makeHandle;
  return { runtime, ctx, data, state, events, emit };
}

function policy() {
  const controller = new AbortController();
  const state = { active: true, checks: 0, calls: [] };
  const value = {
    signal: controller.signal,
    assertActive() { state.checks++; if (!state.active) throw Error(secret); },
    async search(args, signal) { state.calls.push({ method: 'search', args, signal }); return { results: [] }; },
    async fetch(args, signal) { state.calls.push({ method: 'fetch', args, signal }); return { body: '公开资料' }; },
  };
  return { controller, state, value };
}

function scoped(t) {
  const f = fixture(t);
  const scope = target();
  const p = policy();
  f.runtime.policies.set('news', p.value);
  f.runtime.runtime.setup(scope.ctx, scope.agent);
  const execute = (name, args, signal = new AbortController().signal) => scope.state.definitions.get(name).execute(args, { name, agent: scope.agent, signal });
  return { ...f, scope, p, execute };
}

test('capability 仅探测搜索函数，不读取配置、密钥或个人资料', t => {
  const { runtime, ctx } = fixture(t);
  assert.deepEqual(runtime.capability(), { network: false, verified: false, message: '宿主尚未提供公共资料搜索能力。' });
  ctx.web = { search() { throw Error('探测不应执行搜索'); } };
  assert.equal(runtime.capability().network, true);
  assert.equal(runtime.capability().verified, false);
});

test('search 原样代理 request、signal 和宿主 this，成功后标记 verified', async t => {
  const request = { queries: ['公共技术资料'] };
  const signal = new AbortController().signal;
  const result = { sources: [] };
  const web = { async search(actual, actualSignal) { assert.equal(this, web); assert.equal(actual, request); assert.equal(actualSignal, signal); return result; } };
  const { runtime } = fixture(t, { web });
  assert.equal(await runtime.search(request, signal), result);
  assert.equal(runtime.capability().verified, true);
});

test('search 原始 provider 错误使用固定安全文案，失败不标记 verified', async t => {
  const { runtime } = fixture(t, { web: { search: async () => { throw Error(secret); } } });
  let first;
  await assert.rejects(runtime.search({}), error => { first = error.message; return safe(error); });
  await assert.rejects(runtime.search({}), error => { assert.equal(error.message, first); return safe(error); });
  assert.equal(runtime.capability().verified, false);
});

for (const [code, category] of [
  ['WEB_PROVIDER_CREDENTIAL_MISSING', '缺少所需凭据'],
  ['WEB_PROVIDER_CONFIGURED_MISSING', '配置指定的搜索提供方不存在'],
  ['WEB_PROVIDER_CONFIGURED_UNAVAILABLE', '配置指定的搜索提供方当前不可用'],
  ['WEB_PROVIDER_UNAVAILABLE', '当前没有可用的搜索提供方'],
  ['WEB_PROVIDER_AMBIGUOUS', '有多个搜索提供方'],
  ['WEB_PROVIDER_ERROR', '宿主未区分 HTTP、网络或其他服务错误'],
  ['WEB_ABORTED', '搜索请求已中止'],
]) test(`search 仅保留稳定 code 和固定安全文案：${code}`, async t => {
  let calls = 0, observed = 0;
  const { runtime } = fixture(t, { web: { async search() {
    calls++;
    throw Object.assign(Error(secret), { code, cause: Error(secret), endpoint: secret, key: secret, query: secret, routineSafe: true });
  } } });
  await assert.rejects(runtime.search({ query: secret }, undefined, () => { observed++; }), error => {
    assert.equal(error.code, code);
    assert.equal(error.name, code === 'WEB_ABORTED' ? 'AbortError' : 'Error');
    assert.ok(error.message.includes(category));
    assert.match(error.message, /请检查搜索服务配置/);
    assert.match(error.message, /聊天可用不代表搜索可用/);
    assert.doesNotMatch(error.message, /额外.*API key|第三方.*密钥/);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'routineSafe']);
    return safe(error);
  });
  assert.equal(calls, 1); assert.equal(observed, 1);
  assert.equal(runtime.capability().verified, false);
});

for (const code of [undefined, 'UNKNOWN_' + secret, 'SEARCH_UNAVAILABLE', 'toString', 'WEB_PROVIDER_ERROR ']) {
  test(`未知或伪装 code 不从原始错误推断分类：${String(code)}`, async t => {
    const accesses = [];
    const raw = { code };
    for (const field of ['message', 'stack', 'cause', 'endpoint', 'key', 'query']) Object.defineProperty(raw, field, {
      enumerable: true, get() { accesses.push(field); throw Error(secret); },
    });
    const { runtime } = fixture(t, { web: { async search() { throw raw; } } });
    await assert.rejects(runtime.search({}), error => { assert.equal(error.code, 'WEB_PROVIDER_ERROR'); return safe(error); });
    assert.deepEqual(accesses, []);
  });
}

for (const web of [undefined, {}, { search: null }]) test('缺失宿主 search 独立 unavailable，实际 provider 调用为零', async t => {
  let observed = 0;
  const { runtime } = fixture(t, { web });
  await assert.rejects(runtime.search({}, undefined, () => { observed++; }), error => {
    assert.equal(error.code, 'SEARCH_UNAVAILABLE');
    assert.match(error.message, /未完成有效搜索调用/);
    assert.match(error.message, /不能据此判断缺少凭据/);
    return safe(error);
  });
  assert.equal(observed, 0);
});

test('search 预先取消不调用宿主，也不回显取消原因', async t => {
  let calls = 0;
  const { runtime } = fixture(t, { web: { search: async () => { calls++; } } });
  const controller = new AbortController();
  controller.abort(Error(secret));
  await assert.rejects(runtime.search({}, controller.signal, () => assert.fail('预先取消不得通知实际调用')), error => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.code, 'WEB_ABORTED'); return safe(error);
  });
  assert.equal(calls, 0);
});

test('run 在 prepare 前注册策略；created 早于 setup 不会永久拒绝；只写新闻会话键', async t => {
  const { runtime, data, state, events } = fixture(t);
  const p = policy();
  state.beforeSetup = scope => {
    assert.equal(runtime.policies.get('news'), p.value);
    assert.equal(scope.guard('web_search'), undefined);
  };
  state.onDispose = () => { assert.equal(runtime.policies.get('news'), p.value); };
  const result = await runtime.run('news', '只查询公共资料', p.value);
  assert.equal(result.reason.kind, 'completed');
  assert.equal(result.text, '{"items":[]}');
  assert.deepEqual(data.get('claudiaNewsSessionsV1'), ['news']);
  assert.deepEqual(data.get('harnessSessions'), ['ordinary-chat']);
  assert.equal(runtime.handles, runtime.runtime.handles);
  assert.equal(runtime.handles.size, 0);
  assert.equal(runtime.policies.size, 0);
  assert.deepEqual(state.disposed, ['news']);
  assert.equal(state.scopes[0].state.registrations, 2);
  assert.equal(state.scopes[0].state.guards.length, 1);
  assert.equal(state.scopes[0].state.sections.length, 1);
  assert.deepEqual([...events.keys()].sort(), ['agent/assistant-stream', 'agent/created', 'session/event']);
});

test('created 和 setup 对同一上下文幂等，guard 动态响应策略登记和撤销', t => {
  const { runtime, emit } = fixture(t, { known: ['news'] });
  const scope = target();
  emit('agent/created', { agent: scope.agent });
  assert.equal(typeof scope.guard('web_search'), 'string');
  const p = policy();
  runtime.policies.set('news', p.value);
  runtime.runtime.setup(scope.ctx, scope.agent);
  emit('agent/created', { agent: scope.agent });
  runtime.runtime.setup(scope.ctx, scope.agent);
  assert.equal(scope.guard('web_search'), undefined);
  assert.equal(scope.guard('web_fetch'), undefined);
  assert.equal(scope.state.restrictions.length, 1);
  assert.equal(scope.state.registrations, 2);
  assert.equal(scope.state.listeners.length, 1);
  runtime.policies.delete('news');
  assert.equal(typeof scope.guard('web_search'), 'string');
});

test('外部恢复与构造时已有新闻会话无策略全部拒绝，普通聊天不受影响', t => {
  const existing = target();
  const { runtime, emit } = fixture(t, { known: ['news'], existing: [existing] });
  const restored = target();
  emit('agent/created', { agent: restored.agent });
  for (const scope of [existing, restored]) {
    assert.deepEqual(scope.state.restrictions, [{ allow: [] }]);
    for (const name of ['web_search', 'web_fetch', 'shell']) assert.equal(typeof scope.guard(name), 'string');
  }
  const ordinary = target('ordinary-chat');
  emit('agent/created', { agent: ordinary.agent });
  assert.equal(ordinary.state.restrictions.length, 0);
  assert.equal(runtime.policies.size, 0);
});

test('setup 使用 agent.session.id 而非上下文、最近会话或默认 id', t => {
  const { runtime } = fixture(t);
  const scope = target('second');
  scope.ctx.session = { id: 'wrong' };
  const first = policy(), second = policy();
  first.state.active = false;
  runtime.policies.set('wrong', first.value);
  runtime.policies.set('second', second.value);
  runtime.runtime.setup(scope.ctx, scope.agent);
  assert.equal(scope.guard('web_search'), undefined);
  assert.equal(first.state.checks, 0);
  assert.ok(second.state.checks > 0);
});

test('缺失 session id 时 fail closed，即使 undefined 键存在策略也拒绝', t => {
  const { runtime } = fixture(t);
  const scope = target();
  scope.agent.session = {};
  runtime.policies.set(undefined, policy().value);
  assert.throws(() => runtime.runtime.setup(scope.ctx, scope.agent), safe);
  assert.deepEqual(scope.state.restrictions, [{ allow: [] }]);
  assert.equal(typeof scope.guard('web_search'), 'string');
});

test('同一上下文不能换绑另一 session id，换绑失败后继续拒绝', t => {
  const { runtime, scope, p } = scoped(t);
  runtime.policies.set('other', p.value);
  assert.throws(() => runtime.runtime.setup(scope.ctx, { session: { id: 'other' } }), safe);
  assert.equal(typeof scope.guard('web_search'), 'string');
});

test('仅暴露本层两个工具；精确名称、调用会话、活跃性与取消均由 guard 检查', t => {
  const { scope, p } = scoped(t);
  assert.equal(scope.state.mode, 'native');
  assert.deepEqual(scope.visible().map(tool => tool.name), ['web_search', 'web_fetch']);
  for (const name of ['shell', 'tasks', 'read', 'run_code', 'mcp.web_search', 'WEB_SEARCH', 'web_search ', '', undefined]) {
    assert.equal(typeof scope.guard(name), 'string');
  }
  assert.equal(typeof scope.state.guards[0]({ name: 'web_search', agent: { session: { id: 'other' } } }), 'string');
  p.state.active = false;
  assert.equal(typeof scope.guard('web_fetch'), 'string');
  p.state.active = true;
  p.controller.abort();
  assert.equal(typeof scope.guard('web_search'), 'string');
});

test('本层 execute 只调用对应 policy 方法，传递原参数和合并信号', async t => {
  const { execute, p } = scoped(t);
  const signal = new AbortController().signal;
  for (const args of [{ queries: ['一条'] }, { queries: ['第一条', '第二条'] }]) {
    assert.deepEqual(await execute('web_search', args, signal), { results: [] });
    assert.equal(p.state.calls.at(-1).args, args);
  }
  const args = { url: 'https://example.test/public' };
  assert.deepEqual(await execute('web_fetch', args, signal), { body: '公开资料' });
  assert.deepEqual(p.state.calls.map(call => call.method), ['search', 'search', 'fetch']);
  assert.equal(p.state.calls.at(-1).args, args);
  assert.notEqual(p.state.calls[0].signal, signal);
  assert.equal(p.state.calls[0].signal.aborted, false);
});

test('搜索 schema 与执行均限制 1 至 2 条字符串查询且拒绝额外字段', async t => {
  const { execute, p, scope } = scoped(t);
  const schema = scope.state.definitions.get('web_search').parameters;
  assert.deepEqual(schema, { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 } }, required: ['queries'], additionalProperties: false });
  const invalid = [null, [], {}, { queries: [] }, { queries: ['a', 'b', 'c'] }, { queries: [1] }, { queries: 'a' }, { queries: Array(1) }, { queries: ['a'], key: secret }];
  for (const args of invalid) await assert.rejects(execute('web_search', args), safe);
  assert.equal(p.state.calls.length, 0);
});

test('参数层拒绝不伪称未尝试工具；策略只报告未提交有效查询', async t => {
  const { runtime, execute, p } = scoped(t);
  const actual = new NewsPolicy({ topics: ['产品增长'], window: { end: '2026-09-18T12:00:00.000Z' },
    signal: p.controller.signal, assertActive() {}, search: (...args) => runtime.search(...args) });
  runtime.policies.set('news', actual);
  await assert.rejects(execute('web_search', { queries: [1], key: secret }), safe);
  assert.deepEqual(actual.diagnostic, { code: 'SEARCH_NOT_CALLED', providerCalls: 0, successfulSearches: 0, searchAttempts: 0, rejectedSearches: 0 });
  assert.throws(() => actual.finish('{"status":"silent","reason":"无资讯","items":[]}'), error => {
    assert.match(error.message, /未提交有效查询/);
    assert.doesNotMatch(error.message, /没有工具调用|未尝试工具/);
    return safe(error);
  });
});

for (const available of [false, true]) test(`真实 runtime→policy 边界计数并保留工具安全分类：search 存在=${available}`, async t => {
  const { runtime, ctx, execute, p } = scoped(t);
  let calls = 0;
  ctx.web = available ? { search() { calls++; throw { code: 'WEB_PROVIDER_CONFIGURED_MISSING', message: secret }; } } : {};
  const actual = new NewsPolicy({ topics: ['产品增长', '开发工具'], window: { end: '2026-09-18T12:00:00.000Z' },
    signal: p.controller.signal, assertActive() {}, search: (...args) => runtime.search(...args) });
  runtime.policies.set('news', actual);
  const code = available ? 'WEB_PROVIDER_CONFIGURED_MISSING' : 'SEARCH_UNAVAILABLE';
  await assert.rejects(execute('web_search', { queries: actual.queries }), error => { assert.equal(error.code, code); return safe(error); });
  assert.equal(calls, Number(available)); assert.equal(actual.calls, 2);
  assert.deepEqual(actual.diagnostic, { code, providerCalls: Number(available), successfulSearches: 0, searchAttempts: 1, rejectedSearches: 0 });
  assert.throws(() => actual.finish('{"status":"silent","reason":"无资讯","items":[]}'), { code });
});

test('读取 schema 仅接受 url 字符串且拒绝额外字段', async t => {
  const { execute, p, scope } = scoped(t);
  assert.deepEqual(scope.state.definitions.get('web_fetch').parameters, { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false });
  for (const args of [null, [], {}, { url: 1 }, { url: null }, { url: 'https://example.test', key: secret }]) {
    await assert.rejects(execute('web_fetch', args), safe);
  }
  assert.equal(p.state.calls.length, 0);
});

test('每个工具提供开放 JSON object 输出 schema 和纯 JSON 文本 render', t => {
  const { scope } = scoped(t);
  const value = { arbitrary: { nested: [null, true, 2, '公开资料'] }, extra: {} };
  for (const tool of scope.state.definitions.values()) {
    assert.deepEqual(tool.output.schema, { type: 'object', additionalProperties: true });
    assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: JSON.stringify(value) }]);
  }
  assert.equal(scope.state.listeners.some(listener => listener.name === 'tools/result'), false);
});

test('authority assembly 等待 next 后重建完整 section，清空 profile/cwd 上下文及变量', async t => {
  const { scope } = scoped(t);
  const gate = deferred();
  let settled = false;
  const assembly = scope.assemble(async () => {
    await gate.promise;
    return {
      sections: [{ name: 'claudia:news-only', text: secret }, { name: 'soul', text: secret }],
      contexts: [{ name: 'promptContext:user', text: secret }, { name: 'cwd', text: '/private/user-path' }],
      variables: { user: secret },
      tools: [{ name: 'web_search', description: secret, parameters: { privateProfile: secret } }, { name: 'web_fetch' }],
      privateExtension: secret,
    };
  }).then(result => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  const result = await assembly;
  const section = scope.state.sections[0];
  assert.equal(section.name, 'claudia:news-only');
  assert.equal(section.order, 0);
  assert.equal(section.complete, true);
  assert.deepEqual(result.sections, [{ name: section.name, text: section.text }]);
  assert.deepEqual(result.contexts, []);
  assert.deepEqual(result.variables, {});
  assert.deepEqual(result.tools, [...scope.state.definitions.values()].map(schemaOf));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret + '|/private/user-path'));
  assert.equal(result.privateExtension, undefined);
});

test('assembly 遇到异常、近似或重复工具名称抛错，不静默放行', async t => {
  const { scope } = scoped(t);
  for (const tools of [[{ name: 'shell' }], [{ name: 'web_search ' }], [null], [{ name: 'web_search' }, { name: 'web_search' }]]) {
    await assert.rejects(scope.assemble(async () => ({ tools })), safe);
  }
});

test('assembly 的本地权威 schema 每次独立复制，外部修改不污染注册或后续组装', async t => {
  const { scope } = scoped(t);
  const first = await scope.assemble();
  first.tools[0].parameters.additionalProperties = true;
  first.tools[0].parameters.properties.queries.maxItems = 100;
  const next = await scope.assemble();
  assert.equal(next.tools[0].parameters.additionalProperties, false);
  assert.equal(next.tools[0].parameters.properties.queries.maxItems, 2);
  assert.equal(scope.state.definitions.get('web_search').parameters.properties.queries.maxItems, 2);
});

test('guard 通过后撤销策略，或最后一次 assertActive 失败，均不执行搜索', async t => {
  const { execute, scope, p, runtime } = scoped(t);
  assert.equal(scope.guard('web_search'), undefined);
  runtime.policies.delete('news');
  await assert.rejects(execute('web_search', { queries: ['资料'] }), safe);
  runtime.policies.set('news', p.value);
  let checks = 0;
  p.value.assertActive = () => { if (++checks === 2) throw Error(secret); };
  await assert.rejects(execute('web_search', { queries: ['资料'] }), safe);
  assert.equal(checks, 2);
  assert.equal(p.state.calls.length, 0);
});

for (const source of ['exec', 'policy']) {
  test(`${source} 信号中途取消传播至 policy，等待其结束且不泄露原始错误`, async t => {
    const { execute, p } = scoped(t);
    const exec = new AbortController();
    const started = deferred();
    let received;
    p.value.search = async (_args, signal) => {
      received = signal;
      started.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error(secret)), { once: true }));
    };
    const task = execute('web_search', { queries: ['资料'] }, exec.signal);
    const rejection = assert.rejects(task, error => { assert.equal(error.name, 'AbortError'); return safe(error); });
    await started.promise;
    (source === 'exec' ? exec : p.controller).abort(Error(secret));
    await rejection;
    assert.equal(received.aborted, true);
  });
}

test('任一信号预先取消时不执行 policy', async t => {
  const { execute, p } = scoped(t);
  const exec = new AbortController();
  exec.abort(Error(secret));
  await assert.rejects(execute('web_fetch', { url: 'https://example.test' }, exec.signal), safe);
  p.controller.abort(Error(secret));
  await assert.rejects(execute('web_search', { queries: ['资料'] }), safe);
  assert.equal(p.state.calls.length, 0);
});

test('两个 policy 方法的原始 provider 错误都脱敏', async t => {
  const { execute, p } = scoped(t);
  p.value.search = p.value.fetch = async () => { throw Object.assign(Error(secret), { key: secret }); };
  await assert.rejects(execute('web_search', { queries: ['资料'] }), safe);
  await assert.rejects(execute('web_fetch', { url: 'https://example.test' }), safe);
});

test('prepare 期间取消，prepare 完成后不提交模型并先释放 handle 再删除策略', async t => {
  const { runtime, state } = fixture(t);
  const p = policy();
  state.beforeSetup = () => { p.controller.abort(Error(secret)); };
  state.onDispose = () => { assert.equal(runtime.policies.get('news'), p.value); };
  await assert.rejects(runtime.run('news', '公开资料', p.value), error => { assert.equal(error.name, 'AbortError'); return safe(error); });
  assert.equal(state.followups.length, 0);
  assert.deepEqual(state.disposed, ['news']);
  assert.equal(runtime.policies.size, 0);
  assert.equal(runtime.handles.size, 0);
});

test('prepare 期间策略失效，完成后重新 assertActive 并拒绝调用模型', async t => {
  const { runtime, state } = fixture(t);
  const p = policy();
  state.beforeSetup = () => { p.state.active = false; };
  await assert.rejects(runtime.run('news', '公开资料', p.value), safe);
  assert.equal(state.followups.length, 0);
  assert.deepEqual(state.disposed, ['news']);
  assert.equal(runtime.policies.size, 0);
});

test('运行中 policy 取消会取消对应 NativeRuntime agent，清理完成才返回', async t => {
  const { runtime, state } = fixture(t);
  const p = policy();
  const started = deferred(), stopped = deferred();
  state.beforeTurn = async () => { started.resolve(); await stopped.promise; };
  state.onCancel = () => stopped.resolve();
  const task = runtime.run('news', '公开资料', p.value);
  const rejection = assert.rejects(task, error => { assert.equal(error.name, 'AbortError'); return safe(error); });
  await started.promise;
  p.controller.abort(Error(secret));
  await rejection;
  assert.deepEqual(state.cancelled, ['news']);
  assert.deepEqual(state.disposed, ['news']);
  assert.equal(runtime.handles.size, 0);
  assert.equal(runtime.policies.size, 0);
});

test('prepare、模型执行和 dispose 的原始错误均脱敏且策略总会删除', async t => {
  for (const phase of ['prepare', 'model', 'dispose']) {
    const { runtime, ctx, state } = fixture(t);
    if (phase === 'prepare') ctx.agents.resume = async () => { throw Error(secret); };
    if (phase === 'model') state.beforeTurn = async () => { throw Error(secret); };
    if (phase === 'dispose') state.onDispose = async () => { throw Error(secret); };
    await assert.rejects(runtime.run('news', '公开资料', policy().value), safe);
    assert.equal(runtime.policies.size, 0);
    assert.equal(runtime.handles.size, 0);
    assert.deepEqual(state.disposed, phase === 'prepare' ? [] : ['news']);
  }
});

test('同 id 并发运行不能覆盖或删除先前活跃策略', async t => {
  const { runtime, state } = fixture(t);
  const entered = deferred(), proceed = deferred();
  const first = policy();
  state.beforeSetup = async () => { entered.resolve(); await proceed.promise; };
  const task = runtime.run('news', '公开资料', first.value);
  await entered.promise;
  await assert.rejects(runtime.run('news', '另一请求', policy().value), safe);
  assert.equal(runtime.policies.get('news'), first.value);
  proceed.resolve();
  await task;
  assert.equal(runtime.policies.size, 0);
  assert.deepEqual(state.disposed, ['news']);
});

test('新建新闻会话 cwd 仅为 NativeRuntime metadata，联网 prompt 无私人路径', async t => {
  const { runtime, ctx, state } = fixture(t);
  ctx.agents.resume = async () => { throw Object.assign(Error('无记录'), { name: 'SessionPersistenceNotFoundError' }); };
  await runtime.run('news', '公开资料', policy().value);
  assert.equal(state.options[0].meta.cwd, runtime.runtime.fileRoot);
  const assembly = await state.scopes[0].assemble();
  assert.equal(JSON.stringify(assembly).includes(runtime.runtime.fileRoot), false);
  assert.equal(JSON.stringify(state.followups).includes(runtime.runtime.fileRoot), false);
});

test('cancel、release、close 直接代理；handles 返回原 Map', async t => {
  const { runtime } = fixture(t);
  const calls = [];
  for (const name of ['cancel', 'release', 'close']) {
    const original = runtime.runtime[name];
    const result = Promise.resolve(name);
    runtime.runtime[name] = (...args) => { calls.push([name, ...args]); return result; };
    assert.equal(runtime[name](...(name === 'close' ? [] : ['news'])), result);
    await result;
    runtime.runtime[name] = original;
  }
  assert.deepEqual(calls, [['cancel', 'news'], ['release', 'news'], ['close']]);
  assert.equal(runtime.handles, runtime.runtime.handles);
});

test('close 等待 pending prepare，迟到 handle 被释放，不调用模型或遗留策略', async t => {
  const { runtime, state, events } = fixture(t);
  const entered = deferred(), proceed = deferred();
  state.beforeSetup = async () => { entered.resolve(); await proceed.promise; };
  const task = runtime.run('news', '公开资料', policy().value);
  const rejection = assert.rejects(task, safe);
  await entered.promise;
  const closing = runtime.close();
  proceed.resolve();
  await Promise.all([closing, rejection]);
  assert.deepEqual(state.disposed, ['news']);
  assert.equal(state.followups.length, 0);
  assert.equal(runtime.handles.size, 0);
  assert.equal(runtime.policies.size, 0);
  assert.equal(events.get('agent/created').size, 0);
});
