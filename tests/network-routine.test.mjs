import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Store } from '../store.mjs';
import { Maintenance } from '../maintenance.mjs';
import { NewsPolicy, normalizeTopics, safeSearchDiagnostic, searchFailure } from '../network-routine.mjs';
import { startServer } from '../server.mjs';

const DAY = 86400000;
const END = '2026-09-18T12:00:00.000Z';
const FALLBACK = '前沿 AI Native app 增长资讯';
const SECRET = 'TEST_ONLY_PRIVATE_RECORD_NEVER_SEND';
const definition = { name: '联网资讯测试', prompt: '从私人记录概括公开技术主题', schedule: { type: 'daily', time: '11:00' }, allowNetwork: true, enabled: true, delivery: 'both' };
const completed = value => ({ reason: { kind: 'completed' }, text: JSON.stringify(value) });
const item = (id = 1) => ({ sourceId: `web:${id}`, title: `公开文章 ${id}`, summary: '这条公开产品资讯值得回看。' });
const success = (count = 1) => ({ status: 'success', reason: '', items: Array.from({ length: count }, (_, i) => item(i + 1)) });
const silent = () => ({ status: 'silent', reason: '搜索后没有值得推荐的近期资讯', items: [] });
const sources = (end = END, count = 4) => Array.from({ length: count }, (_, i) => ({ url: `https://example.com/news/${i + 1}`, title: `公开来源 ${i + 1}`, snippet: `经过搜索返回的正文 ${i + 1}`, publishedAt: new Date(Date.parse(end) - DAY - i * 1000).toISOString() }));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const safe = error => {
  assert.equal(error.routineSafe, true);
  assert.doesNotMatch(error.message, new RegExp(SECRET));
  return true;
};

// 只允许测试自己启动的回环 API；抓页、DNS、宿主模型均不得接触真实服务。
const localOrigins = new Set();
beforeEach(t => {
  localOrigins.clear();
  const attempts = [];
  const deny = name => () => { attempts.push(name); throw Error(`测试禁止真实外部调用：${name}`); };
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!localOrigins.has(url.origin)) return deny('fetch')();
    return realFetch(input, { ...options, redirect: 'error' });
  });
  for (const module of [http, https]) {
    t.mock.method(module, 'request', deny('HTTP request'));
    t.mock.method(module, 'get', deny('HTTP get'));
  }
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    if (hostname !== '127.0.0.1') return deny('DNS lookup')();
    if (typeof options === 'function') { callback = options; options = {}; }
    queueMicrotask(() => options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4));
  });
  t.mock.method(dns.promises, 'lookup', deny('DNS promises.lookup'));
  t.after(() => assert.deepEqual(attempts, [], '不得尝试真实模型外发或外网请求'));
});

async function fixture(t, { api = false, network = true, now = END } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claudia-network-routine-')));
  const f = {
    dir, now: new Date(now), network, gates: [], events: [], topicCalls: [], newsCalls: [], searchCalls: [], fetchCalls: [],
    topicResult: completed(['AI Native', '产品增长']), searchResult: { sources: sources(new Date(now).toISOString()) },
    async topicTurn() { return f.topicResult; },
    async newsTurn(policy) { await policy.search({ queries: policy.queries }); return completed(success()); },
    async searchTurn() { return structuredClone(f.searchResult); },
    async fetchTurn(url) { return { url, text: '公开网页正文', publishedAt: new Date(f.now - DAY).toISOString() }; },
    hold() { const gate = deferred(); f.gates.push(gate); return gate; },
  };
  const runtime = {
    running: false, handles: new Map(), selection: () => ({ provider: 'fake', model: 'fake' }), status: async () => ({ configured: true }),
    async prepare(id) { f.events.push(['topic.prepare', id]); runtime.handles.set(id, {}); },
    async run(id, prompt) { f.topicCalls.push({ id, prompt }); f.events.push(['topic.run', id]); return f.topicTurn(prompt, id); },
    async cancel(id) { f.events.push(['topic.cancel', id]); },
    async release(id) { f.events.push(['topic.release', id]); runtime.handles.delete(id); },
    async close() { runtime.handles.clear(); },
  };
  const newsHandles = new Map();
  const news = {
    // 宿主忙碌检查可能读取 news.runtime.handles，不能因此构造真实 NewsRuntime。
    runtime: { handles: newsHandles }, handles: newsHandles,
    capability: () => ({ network: f.network, verified: false, message: f.network ? '' : '测试宿主没有搜索能力' }),
    async run(id, prompt, policy) {
      f.newsCalls.push({ id, prompt, policy }); f.events.push(['news.run', id]); newsHandles.set(id, {});
      return f.newsTurn(policy, prompt, id);
    },
    async search(request, signal, onProviderCall) { onProviderCall(); f.searchCalls.push({ request: structuredClone(request), signal }); return f.searchTurn(request, signal); },
    async cancel(id) { f.events.push(['news.cancel', id]); },
    async release(id) { f.events.push(['news.release', id]); newsHandles.delete(id); },
    async close() { newsHandles.clear(); },
  };
  for (const target of [runtime, news, news.runtime]) Object.defineProperty(target, 'key', { get() { assert.fail('不得读取真实凭据'); } });
  const fetchPage = async (url, options) => { f.fetchCalls.push({ url, options }); return f.fetchTurn(url, options); };
  Object.assign(f, { runtime, news, fetchPage });
  const services = store => {
    f.store = store;
    f.maintenance = new Maintenance({ store, runtime, news, fetchPage });
    f.routines = f.maintenance.routines;
    return { maintenance: f.maintenance, news };
  };
  let app;
  t.after(async () => {
    for (const gate of f.gates) gate.resolve();
    try {
      if (app) await app.close();
      else { await f.maintenance?.close(); f.store?.close(); }
    } finally { localOrigins.delete(app?.url); rmSync(dir, { recursive: true, force: true }); }
  });
  if (api) {
    app = await startServer({ dataDir: dir, port: 0, createRuntime: () => runtime, createServices: ({ store }) => services(store) });
    f.app = app;
    localOrigins.add(app.url);
    const bootstrap = await fetch(app.url + '/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    const { csrfToken } = await bootstrap.json();
    f.request = async (path, body, method = 'POST') => {
      const response = await fetch(app.url + path, {
        method, headers: { 'content-type': 'application/json', 'x-claudia-token': csrfToken },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, data: await response.json() };
    };
  } else services(new Store(join(dir, 'test.sqlite')));
  f.save = (fields = {}, id = null) => {
    const saved = f.store.saveRoutine({ ...definition, ...fields }, f.store.routines().revision, id, new Date(f.now - 2 * DAY));
    return f.store.routines().jobs.find(job => job.id === saved.id);
  };
  f.add = (text = SECRET) => f.store.addJournal(text, new Date(f.now - 3600000).toISOString());
  f.run = async (job, requestId = randomUUID()) => {
    await f.maintenance.runRoutine(job, requestId, f.now);
    return f.store.routineRuns(job.id)[0];
  };
  return f;
}

function policyFixture(options = {}) {
  const controller = new AbortController();
  const f = { controller, searches: [], fetches: [], active: true, response: { sources: sources(options.end ?? END) } };
  f.policy = new NewsPolicy({
    topics: options.topics ?? ['AI Native', '产品增长'],
    window: { start: new Date(Date.parse(options.end ?? END) - DAY).toISOString(), end: options.end ?? END },
    signal: controller.signal,
    assertActive() { if (!f.active) throw Object.assign(Error('测试任务已失效'), { routineSafe: true }); },
    async search(request, signal, onProviderCall) { onProviderCall(); f.searches.push({ request, signal }); return options.search ? options.search(request, signal) : structuredClone(f.response); },
    async fetchPage(url, params) { f.fetches.push({ url, ...params }); return options.fetchPage ? options.fetchPage(url, params) : { text: '公开正文', publishedAt: '2026-09-17T12:00:00.000Z' }; },
  });
  return f;
}
function noDelivery(run, status) {
  assert.equal(run.status, status);
  assert.equal(run.deliveredAt, null);
  assert.equal(run.summary, '');
  assert.deepEqual(run.sources, []);
  assert.ok(!run.items?.length);
  assert.doesNotMatch(JSON.stringify(run), new RegExp(SECRET));
}

for (const count of [1, 2, 3]) test(`两阶段成功 ${count} 条：仅真实搜索 URL、近七日日期与独立会话`, async t => {
  const f = await fixture(t);
  const source = f.add();
  const job = f.save({ prompt: `任务私有标记 ${SECRET}` });
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); return completed(success(count)); };
  const run = await f.run(job);
  assert.equal(run.status, 'success'); assert.ok(run.deliveredAt);
  assert.equal(run.items.length, count); assert.equal(run.sources.length, count);
  assert.equal(run.searchCalls, 2); assert.equal(run.pagesRead, 0); assert.equal(run.sourcesFound, 4);
  assert.equal(run.topicFallback, false); assert.deepEqual(run.topics, ['AI Native', '产品增长']);
  assert.equal(f.topicCalls.length, 1); assert.equal(f.newsCalls.length, 1);
  assert.match(f.topicCalls[0].prompt, new RegExp(SECRET));
  assert.ok(f.topicCalls[0].prompt.includes(source.id));
  const { prompt, id, policy } = f.newsCalls[0];
  const jsonLine = prompt.split('\n').map(line => line.trim()).find(line => line.startsWith('{') && line.endsWith('}'));
  const publicInput = JSON.parse(jsonLine);
  assert.deepEqual(publicInput, { queries: policy.queries, cutoff: END });
  assert.doesNotMatch(prompt, new RegExp(`${SECRET}|${source.id}|local_data_untrusted`));
  assert.notEqual(f.topicCalls[0].id, id); assert.notEqual(id, f.store.get('sessionId'));
  assert.deepEqual(f.events.map(([event]) => event), ['topic.prepare', 'topic.run', 'topic.release', 'news.run', 'news.release']);
  assert.equal(f.runtime.handles.size, 0); assert.equal(f.news.runtime.handles.size, 0);
  assert.deepEqual(f.searchCalls.map(call => call.request), policy.queries.map(query => ({ query, maxResults: 4 })));
  assert.doesNotMatch(JSON.stringify(f.searchCalls), new RegExp(SECRET));
  for (const [i, entry] of run.items.entries()) {
    assert.equal(entry.url, f.searchResult.sources[i].url);
    assert.equal(entry.publishedAt, f.searchResult.sources[i].publishedAt);
    assert.equal(entry.sourceId, `web:${i + 1}`);
    assert.ok(Date.parse(entry.publishedAt) >= Date.parse(END) - 7 * DAY);
    assert.ok(Date.parse(entry.publishedAt) < Date.parse(END));
  }
  assert.deepEqual(f.store.messages(), []);
});

test('近期已投递的条目不重复推送：重复标题与链接被剔除，只留新的', async t => {
  const f = await fixture(t);
  const job = f.save();
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); return completed(success(2)); };
  const first = await f.run(job);
  assert.equal(first.status, 'success');
  assert.deepEqual(first.items.map(entry => entry.title), ['公开文章 1', '公开文章 2']);
  assert.doesNotMatch(f.newsCalls[0].prompt, /"exclude"/);
  // 模型又挑回了第一条；去重在 finish 里硬性剔除，不依赖模型自觉。
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); return completed({ status: 'success', reason: '', items: [item(1), item(3)] }); };
  const second = await f.run(job);
  assert.equal(second.status, 'success'); assert.ok(second.deliveredAt);
  assert.deepEqual(second.items.map(entry => entry.title), ['公开文章 3']);
  assert.equal(second.sources.length, 1);
  assert.equal(second.items[0].url, 'https://example.com/news/3');
  assert.match(second.summary, /公开文章 3/);
  assert.doesNotMatch(second.summary, /公开文章 1/);
  const lines = f.newsCalls.at(-1).prompt.split('\n').map(line => line.trim());
  const excludeLine = lines.find(line => line.startsWith('{"exclude"'));
  const queriesLine = lines.find(line => line.startsWith('{"queries"'));
  assert.deepEqual(JSON.parse(excludeLine), { exclude: ['公开文章 1', '公开文章 2'] });
  assert.doesNotMatch(excludeLine, /example\.com|值得回看/);
  assert.deepEqual(JSON.parse(queriesLine), { queries: f.newsCalls.at(-1).policy.queries, cutoff: END });
  assert.doesNotMatch(f.newsCalls.at(-1).prompt, new RegExp(SECRET));
});

test('标题改写但链接相同仍判重复；候选全重复时沉默并写明原因', async t => {
  const f = await fixture(t); f.add();
  const job = f.save();
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); return completed(success(1)); };
  const first = await f.run(job);
  assert.equal(first.status, 'success');
  f.newsTurn = async policy => {
    await policy.search({ queries: policy.queries });
    return completed({ status: 'success', reason: '', items: [{ sourceId: 'web:1', title: '公开文章 1 更新版', summary: '换个标题再推一次。' }] });
  };
  const second = await f.run(job);
  noDelivery(second, 'silent');
  assert.match(second.reason, /已推送过/);
  assert.doesNotMatch(second.reason, /公开文章/);
  assert.equal(second.searchCalls, 2);
});

test('无历史时行为不变：无排除清单，成功照常投递', async t => {
  const f = policyFixture(), p = f.policy;
  await p.search({ queries: p.queries });
  const result = p.finish(JSON.stringify(success(2)));
  assert.equal(result.status, 'success');
  assert.equal(result.items.length, 2);
  assert.equal(result.sources.length, 2);
});

test('Journal、Todo 与用户消息进入 topic runtime；回顾与助手回复是模型产物，不参与推演', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(END) - 3600000 });
  const f = await fixture(t);
  const raw = ['私有日记甲', '私有待办乙', '私有对话丙', '私有回顾丁'].map(text => text + SECRET);
  f.add(raw[0]); f.store.addTodo(raw[1]); f.store.addMessage('user', raw[2]);
  f.store.saveReflection({ id: 'private-reflection', text: raw[3], start: '2026-09-17T11:00:00.000Z', end: '2026-09-18T11:00:00.000Z' });
  f.store.addMessage('assistant', '窗口内的助手回复' + SECRET);
  f.store.addJournal('窗口外的旧日记', '2000-01-01T00:00:00.000Z');
  f.store.addMessage('assistant', '未完成的对话', 'pending');
  const run = await f.run(f.save());
  assert.equal(run.status, 'success');
  const local = JSON.parse(f.topicCalls[0].prompt.split('<local_data_untrusted>')[1].split('</local_data_untrusted>')[0]);
  assert.deepEqual(new Set(local.map(source => source.kind)), new Set(['journal', 'todo', 'message']));
  for (const text of raw.slice(0, 3)) assert.ok(local.some(source => source.text === text));
  assert.deepEqual(new Set(local.filter(source => source.kind === 'message').map(source => source.role)), new Set(['user']));
  for (const text of [raw[3], '窗口内的助手回复' + SECRET]) assert.ok(!local.some(source => String(source.text).includes(text)), text);
  assert.doesNotMatch(f.topicCalls[0].prompt, /窗口外的旧日记|未完成的对话/);
  assert.doesNotMatch(JSON.stringify({ news: f.newsCalls.map(call => call.prompt), search: f.searchCalls, fetch: f.fetchCalls }), new RegExp(SECRET));
});

test('user.md 与已确认记忆是推演材料：没有当日记录时也推演，且不带入联网阶段', async t => {
  const f = await fixture(t);
  f.store.saveProfileBody('user', '我是元宝运营，长期关注大模型发布与厂商动向', f.store.profiles().user.revision);
  f.store.addMemory('不看的领域：macOS 系统更新、泛泛早报');
  const run = await f.run(f.save());
  assert.equal(run.status, 'success');
  assert.equal(run.topicFallback, false, '已审定画像足以推演，不该退回兜底话题');
  const local = JSON.parse(f.topicCalls[0].prompt.split('<local_data_untrusted>')[1].split('</local_data_untrusted>')[0]);
  assert.deepEqual(new Set(local.map(source => source.kind)), new Set(['profile', 'memory']));
  assert.match(local.find(source => source.kind === 'profile').text, /元宝运营/);
  assert.match(local.find(source => source.kind === 'memory').text, /泛泛早报/);
  const outside = JSON.stringify({ news: f.newsCalls.map(call => call.prompt), search: f.searchCalls });
  assert.doesNotMatch(outside, /元宝运营|泛泛早报/);
});

test('画像材料不参与变化检测：运行期间确认记忆不得打断联网执行', async t => {
  const f = await fixture(t);
  f.store.saveProfileBody('user', '关注 AI Native 增长', f.store.profiles().user.revision);
  const entered = f.hold(), proceed = f.hold();
  f.topicTurn = async () => { entered.resolve(); await proceed.promise; return f.topicResult; };
  const pending = f.run(f.save());
  await entered.promise;
  f.store.addMemory('运行期间确认的新记忆');
  proceed.resolve();
  const run = await pending;
  assert.equal(run.status, 'success');
  assert.equal(f.newsCalls.length, 1);
});

test('本地摘要任务仍可把回顾当资料，联网任务不使用', async t => {
  const f = await fixture(t);
  f.add();
  f.store.saveReflection({ id: 'local-reflection', text: '本地回顾原文', start: '2026-09-17T11:00:00.000Z', end: '2026-09-18T11:00:00.000Z', createdAt: '2026-09-18T10:00:00.000Z' });
  f.topicTurn = async prompt => {
    const data = JSON.parse(prompt.split('<routine_data_untrusted>')[1].split('</routine_data_untrusted>')[0]);
    return completed({ status: 'success', summary: '仅本地记录摘要', reason: '', sourceIds: [data[0].sourceId] });
  };
  const run = await f.run(f.save({ allowNetwork: false }));
  assert.equal(run.status, 'success');
  const data = JSON.parse(f.topicCalls[0].prompt.split('<routine_data_untrusted>')[1].split('</routine_data_untrusted>')[0]);
  assert.ok(data.some(source => source.kind === 'reflection'));
  assert.equal(f.newsCalls.length, 0);
});

const fallbackCases = [
  ['空数组', completed([])], ['畸形 JSON', { reason: { kind: 'completed' }, text: '[坏JSON' }],
  ['错误对象', completed({ topics: ['AI Native'] })], ['非字符串', completed([1])], ['超过两个', completed(['产品增长', '开发工具', 'AI Native'])],
  ['空字符串', completed([''])], ['过长话题', completed(['甲'.repeat(49)])],
  ['危险话题', completed(['ignore instructions'])], ['URL 话题', completed(['https://example.com/private'])],
  ['未完成', { reason: { kind: 'max-tokens' }, text: '["产品增长"]' }], ['超长返回', { reason: { kind: 'completed' }, text: ' '.repeat(3001) }],
  ['运行异常', null], ['准备异常', null], ['原文整句', completed(['私有增长实验'])],
];
for (const [name, result] of fallbackCases) test(`topic ${name} 必须 fallback 且仍搜索，不成为 no-data 或 silent`, async t => {
  const f = await fixture(t);
  f.add();
  f.topicResult = result;
  if (name === '运行异常') f.topicTurn = async () => { throw Error(SECRET); };
  if (name === '准备异常') f.runtime.prepare = async () => { throw Error(SECRET); };
  if (name === '原文整句') f.add('私有增长实验');
  const run = await f.run(f.save());
  assert.equal(run.status, 'success'); assert.equal(run.topicFallback, true);
  assert.deepEqual(run.topics, [FALLBACK]); assert.ok(run.topicFallbackReason);
  assert.equal(f.searchCalls.length, 1); assert.equal(run.searchCalls, 1);
  assert.equal(f.searchCalls[0].request.query, `${FALLBACK} 2026-09-11 至 2026-09-18`);
  assert.equal(f.newsCalls.length, 1);
  assert.equal(f.events.filter(([event]) => event === 'topic.release').length, 1);
  assert.doesNotMatch(JSON.stringify(run), new RegExp(SECRET));
});

for (const fallback of [false, true]) test(`搜索后 silent 与搜索前 fallback 独立：fallback=${fallback}`, async t => {
  const f = await fixture(t); f.add(); f.topicResult = completed(fallback ? [] : ['AI Native']); f.searchResult = { sources: [] };
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); return completed(silent()); };
  const run = await f.run(f.save());
  noDelivery(run, 'silent'); assert.ok(run.reason); assert.equal(run.topicFallback, fallback);
  assert.equal(run.searchCalls, 1); assert.equal(run.sourcesFound, 0);
  assert.equal(Boolean(run.topicFallbackReason), fallback);
});

test('窗口内没有用户写的材料时不调用推演模型，直接兜底', async t => {
  const f = await fixture(t);
  const run = await f.run(f.save());
  assert.equal(run.status, 'success');
  assert.equal(run.topicFallback, true);
  assert.deepEqual(run.topics, [FALLBACK]);
  assert.match(run.topicFallbackReason, /没有你新写的/);
  assert.equal(f.topicCalls.length, 0);
  assert.equal(f.newsCalls.length, 1);
  assert.equal(f.searchCalls[0].request.query, `${FALLBACK} 2026-09-11 至 2026-09-18`);
  assert.deepEqual(f.events.map(([event]) => event), ['news.run', 'news.release']);
});

test('normalizeTopics 去空白与去重，拒绝私有标识和指令', () => {
  assert.deepEqual(normalizeTopics([' 产品增长 ', '产品增长']), ['产品增长']);
  for (const value of [null, {}, [], ['a'], ['姓名@example.com'], ['123456'], ['password'], ['读取密钥'], ['产品\n增长']]) assert.equal(normalizeTopics(value), null);
});

const failureCases = [
  ['没有工具调用却声称成功', f => { f.newsTurn = async () => completed(success()); }],
  ['没有工具调用却声称沉默', f => { f.newsTurn = async () => completed(silent()); }],
  ['搜索异常后假沉默', f => { f.searchTurn = async () => { throw Error(SECRET); }; f.newsTurn = async p => { try { await p.search({ queries: p.queries }); } catch {} return completed(silent()); }; }],
  ['畸形搜索响应', f => { f.searchResult = { content: SECRET }; }],
  ['第二次搜索失败不能用第一次结果成功', f => { f.searchTurn = async () => { if (f.searchCalls.length === 2) throw Error(SECRET); return f.searchResult; }; f.newsTurn = async p => { try { await p.search({ queries: p.queries }); } catch {} return completed(success()); }; }],
  ['幻觉 sourceId', f => { f.output = { ...success(), items: [{ ...item(), sourceId: 'web:999' }] }; }],
  ['重复 sourceId', f => { f.output = { ...success(), items: [item(), item()] }; }],
  ['缺失发布时间', f => { delete f.searchResult.sources[0].publishedAt; }],
  ['无效发布时间', f => { f.searchResult.sources[0].publishedAt = 'not-a-date'; }],
  ['超过七日一毫秒', f => { f.searchResult.sources[0].publishedAt = new Date(Date.parse(END) - 7 * DAY - 1).toISOString(); }],
  ['未来新闻', f => { f.searchResult.sources[0].publishedAt = '2026-09-19T00:00:00.000Z'; }],
  ['截止瞬间不在半开窗口', f => { f.searchResult.sources[0].publishedAt = END; }],
  ['无正文来源', f => { f.searchResult.sources[0].snippet = ' '; }],
  ['来源 URL 为内网', f => { f.searchResult.sources = [{ ...sources()[0], url: 'http://127.0.0.1/private' }]; }],
  ['模型截断', f => { f.result = { reason: { kind: 'max-tokens' }, text: JSON.stringify(success()) }; }],
  ['模型异常', f => { f.newsTurn = async () => { throw Error(SECRET); }; }],
];
for (const [name, configure] of failureCases) test(`持久化 failed 且不投递：${name}`, async t => {
  const f = await fixture(t); f.add(); const job = f.save();
  f.output = success();
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); return f.result ?? completed(f.output); };
  configure(f);
  const run = await f.run(job);
  noDelivery(run, 'failed'); assert.ok(run.error);
  assert.equal(f.routines.active, null); assert.equal(f.news.handles.size, 0);
});

for (const rejected of [false, true]) test(`零次有效请求不推断缺凭据；策略拒绝=${rejected}`, async t => {
  const f = await fixture(t);
  f.newsTurn = async policy => {
    if (rejected) await assert.rejects(policy.search({ queries: ['未批准的话题'] }), safe);
    return completed(silent());
  };
  const run = await f.run(f.save());
  noDelivery(run, 'failed');
  assert.match(run.error, /未完成有效搜索调用.*未提交有效查询/);
  assert.match(run.error, /不能据此判断缺少凭据/);
  assert.deepEqual(run.searchDiagnostic, {
    code: 'SEARCH_NOT_CALLED', providerCalls: 0, successfulSearches: 0,
    searchAttempts: Number(rejected), rejectedSearches: Number(rejected),
  });
  assert.equal(run.searchCalls, 0); assert.equal(f.searchCalls.length, 0);
});

for (const code of [
  'WEB_PROVIDER_CREDENTIAL_MISSING', 'WEB_PROVIDER_CONFIGURED_MISSING', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
  'WEB_PROVIDER_UNAVAILABLE', 'WEB_PROVIDER_AMBIGUOUS', 'WEB_PROVIDER_ERROR', 'WEB_ABORTED',
]) for (const ending of ['completed', 'throws', 'truncated']) test(`SQLite 保留安全搜索分类：${code} / ${ending}`, async t => {
  const f = await fixture(t), logs = []; f.add();
  f.routines.logger = { info: (event, data) => logs.push({ event, data }) };
  f.searchTurn = async () => { throw Object.assign(Error(SECRET), {
    code, cause: Error(SECRET), endpoint: SECRET, key: SECRET, query: SECRET,
    routineSafe: true, providerCalls: 999, successfulSearches: 999, searchDiagnostic: { code: SECRET },
  }); };
  f.newsTurn = async policy => {
    await assert.rejects(policy.search({ queries: policy.queries }), error => { assert.equal(error.code, code); return safe(error); });
    if (ending === 'throws') throw Object.assign(Error(SECRET), { routineSafe: true, code: 'WEB_PROVIDER_AMBIGUOUS' });
    return ending === 'truncated' ? { reason: { kind: 'max-tokens' } } : completed(silent());
  };
  const run = await f.run(f.save());
  noDelivery(run, 'failed');
  assert.equal(run.error, searchFailure(code).message);
  assert.equal(run.searchCalls, 1); assert.equal(f.searchCalls.length, 1);
  assert.equal(f.newsCalls[0].policy.calls, 2, '整批预算保持预占，不能计为实际调用');
  assert.deepEqual(run.searchDiagnostic, { code, providerCalls: 1, successfulSearches: 0, searchAttempts: 1, rejectedSearches: 0 });
  assert.deepEqual(logs.find(entry => entry.event === 'routine.search').data, { code, providerCalls: 1, successfulSearches: 0 });
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET + '|query|endpoint|key'));
});

test('两次实际搜索中第二次失败，保留一次成功但不投递', async t => {
  const f = await fixture(t); f.add();
  f.searchTurn = async () => { if (f.searchCalls.length === 2) throw { code: 'WEB_PROVIDER_ERROR', message: SECRET }; return { sources: [] }; };
  f.newsTurn = async policy => { try { await policy.search({ queries: policy.queries }); } catch {} return completed(silent()); };
  const run = await f.run(f.save());
  noDelivery(run, 'failed');
  assert.deepEqual(run.searchDiagnostic, { code: 'WEB_PROVIDER_ERROR', providerCalls: 2, successfulSearches: 1, searchAttempts: 1, rejectedSearches: 0 });
  assert.equal(run.searchCalls, 2); assert.equal(f.searchCalls.length, 2);
});

test('失败后重复查询只记拒绝，另一话题成功不覆盖首个失败类别', async () => {
  const f = policyFixture({ search: async () => {
    if (f.searches.length === 1) throw { code: 'WEB_PROVIDER_CREDENTIAL_MISSING', message: SECRET };
    return { sources: [] };
  } }), p = f.policy;
  await assert.rejects(p.search({ queries: [p.queries[0]] }), safe);
  await assert.rejects(p.search({ queries: [p.queries[0]] }), safe);
  await p.search({ queries: [p.queries[1]] });
  assert.throws(() => p.finish(JSON.stringify(silent())), { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' });
  assert.deepEqual(p.diagnostic, { code: 'WEB_PROVIDER_CREDENTIAL_MISSING', providerCalls: 2, successfulSearches: 1, searchAttempts: 3, rejectedSearches: 1 });
  assert.equal(f.searches.length, 2);
});

test('适配器未进入宿主 search 时实际次数为零，缺函数独立 unavailable', async t => {
  const f = await fixture(t);
  f.news.search = async () => { throw searchFailure('SEARCH_UNAVAILABLE'); };
  const run = await f.run(f.save());
  noDelivery(run, 'failed');
  assert.deepEqual(run.searchDiagnostic, { code: 'SEARCH_UNAVAILABLE', providerCalls: 0, successfulSearches: 0, searchAttempts: 1, rejectedSearches: 0 });
  assert.match(run.error, /未完成有效搜索调用/);
  assert.equal(run.searchCalls, 0); assert.equal(f.searchCalls.length, 0);
});

test('成功搜索后畸形来源列表单独 failed，不作为无资讯', async t => {
  const f = await fixture(t); f.searchResult = { content: SECRET };
  const run = await f.run(f.save());
  noDelivery(run, 'failed');
  assert.deepEqual(run.searchDiagnostic, { code: 'SEARCH_INVALID_RESPONSE', providerCalls: 1, successfulSearches: 0, searchAttempts: 1, rejectedSearches: 0 });
});

test('搜索正常为空可 silent；随后模型原始错误不得伪装搜索缺凭据', async t => {
  const f = await fixture(t); f.add(); f.searchResult = { sources: [] };
  const job = f.save();
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); return completed(silent()); };
  const first = await f.run(job);
  noDelivery(first, 'silent');
  assert.deepEqual(first.searchDiagnostic, { code: null, providerCalls: 2, successfulSearches: 2, searchAttempts: 1, rejectedSearches: 0 });
  f.newsTurn = async policy => {
    await policy.search({ queries: policy.queries });
    throw Object.assign(Error(SECRET), { routineSafe: true, code: 'WEB_PROVIDER_CREDENTIAL_MISSING' });
  };
  const second = await f.run(job);
  noDelivery(second, 'failed');
  assert.equal(second.searchDiagnostic.code, null);
  assert.match(second.error, /资讯模型或处理失败/);
  assert.doesNotMatch(second.error, /缺少.*凭据/);
});

test('诊断严格构造白名单字段，不复制任意字段或序列化钩子', () => {
  const value = { code: 'WEB_PROVIDER_ERROR', providerCalls: 1, successfulSearches: 0, searchAttempts: 1, rejectedSearches: 0 };
  const raw = { ...value, query: SECRET, endpoint: SECRET, key: SECRET, stack: SECRET, cause: SECRET, toJSON() { assert.fail('不得调用原始序列化钩子'); } };
  assert.deepEqual(safeSearchDiagnostic(raw), value);
  assert.doesNotMatch(JSON.stringify(safeSearchDiagnostic(raw)), new RegExp(SECRET));
  assert.deepEqual(safeSearchDiagnostic({ code: SECRET, providerCalls: -1, successfulSearches: Infinity, searchAttempts: SECRET, rejectedSearches: NaN }), {
    code: null, providerCalls: 0, successfulSearches: 0, searchAttempts: 0, rejectedSearches: 0,
  });
});

test('诊断只写本轮 SQLite 记录，不追溯改写无证据的历史失败', async t => {
  const f = await fixture(t), job = f.save();
  const legacy = { id: randomUUID(), jobId: job.id, windowKey: 'legacy', startedAt: '2026-09-01T00:00:00.000Z', status: 'failed', error: '搜索未成功完成' };
  f.store.startRoutineRun(legacy);
  f.newsTurn = async () => completed(silent());
  const run = await f.run(job);
  assert.equal(run.searchDiagnostic.code, 'SEARCH_NOT_CALLED');
  assert.deepEqual(f.store.routineRun(legacy.id), legacy);
  assert.deepEqual(f.routines.snapshot(f.now).jobs.find(entry => entry.id === job.id).lastRun, run);
  assert.deepEqual(f.store.routineRun(legacy.id), legacy);
});

test('取消中的搜索计入实际次数，迟到结果不计成功且不泄露取消原因', async t => {
  const f = await fixture(t);
  f.searchTurn = async () => {
    f.routines.cancel('测试取消');
    throw Object.assign(Error(SECRET), { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' });
  };
  const run = await f.run(f.save());
  noDelivery(run, 'cancelled');
  assert.deepEqual(run.searchDiagnostic, { code: 'WEB_ABORTED', providerCalls: 1, successfulSearches: 0, searchAttempts: 1, rejectedSearches: 0 });
  assert.equal(f.searchCalls.length, 1);
});

const invalidResults = [
  ['不是 JSON', '正文'], ['JSON 围栏', '```json\n{}\n```'], ['null', 'null'], ['数组', '[]'],
  ['缺字段', JSON.stringify({ status: 'success', items: [item()] })],
  ['多字段', JSON.stringify({ ...success(), debug: true })], ['非法状态', JSON.stringify({ ...success(), status: 'done' })],
  ['reason 类型', JSON.stringify({ ...success(), reason: 1 })], ['reason 过长', JSON.stringify({ ...silent(), reason: '甲'.repeat(501) })],
  ['items 非数组', JSON.stringify({ ...success(), items: {} })], ['成功零条', JSON.stringify(success(0))], ['超过三条', JSON.stringify(success(4))],
  ['silent 有条目', JSON.stringify({ ...success(), status: 'silent' })], ['silent 空原因', JSON.stringify({ ...silent(), reason: ' ' })],
  ['条目 null', JSON.stringify({ ...success(), items: [null] })],
  ['条目缺字段', JSON.stringify({ ...success(), items: [{ sourceId: 'web:1', title: '标题' }] })],
  ['条目自造 URL', JSON.stringify({ ...success(), items: [{ ...item(), url: 'https://example.com/invented' }] })],
  ['条目自造日期', JSON.stringify({ ...success(), items: [{ ...item(), publishedAt: '2026-09-17' }] })],
  ...['title', 'summary'].flatMap(field => [
    [`${field} 非字符串`, JSON.stringify({ ...success(), items: [{ ...item(), [field]: 1 }] })],
    [`${field} 为空`, JSON.stringify({ ...success(), items: [{ ...item(), [field]: ' ' }] })],
    [`${field} 过长`, JSON.stringify({ ...success(), items: [{ ...item(), [field]: '甲'.repeat(field === 'title' ? 201 : 701) }] })],
  ]),
  ['summary 非法 Unicode', JSON.stringify({ ...success(), items: [{ ...item(), summary: '\ud800' }] })],
  ['输出超限', ' '.repeat(16001)],
];
for (const [name, text] of invalidResults) test(`invalid schema 必须 failed：${name}`, async t => {
  const f = await fixture(t);
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); return { reason: { kind: 'completed' }, text }; };
  noDelivery(await f.run(f.save()), 'failed');
});

test('JSON 被代码围栏包住时按结构照常接受，不因装饰整期失败', async () => {
  const f = policyFixture();
  await f.policy.search({ queries: f.policy.queries });
  for (const text of ['```json\n' + JSON.stringify(success()) + '\n```', '说明：\n' + JSON.stringify(success()) + '\n以上。']) {
    const result = f.policy.finish(text);
    assert.equal(result.status, 'success');
    assert.equal(result.items.length, 1);
  }
});

test('模型跳过搜索直接作答时只补跑一次，补跑成功则正常投递', async t => {
  const f = await fixture(t); f.add();
  let turns = 0;
  f.newsTurn = async policy => {
    turns += 1;
    if (turns === 1) return completed(silent());
    await policy.search({ queries: policy.queries });
    return completed(success());
  };
  const run = await f.run(f.save());
  assert.equal(run.status, 'success');
  assert.equal(f.newsCalls.length, 2, '必须只补跑一次');
  assert.equal(f.newsCalls[1].id, f.newsCalls[0].id, '补跑复用同一会话，不留下残余会话');
  assert.match(f.newsCalls[1].prompt, /web_search/);
  assert.equal(run.searchCalls, 2);
});

test('补跑一次仍未搜索才判失败，不无限重试', async t => {
  const f = await fixture(t);
  f.newsTurn = async () => completed(silent());
  noDelivery(await f.run(f.save()), 'failed');
  assert.equal(f.newsCalls.length, 2, '最多两次，不能无限重试');
});

test('七日前的精确边界允许；只引用本次搜索分配的 ID', async () => {
  const f = policyFixture();
  f.response.sources[0].publishedAt = '2026-09-11T12:00:00.000Z';
  f.response.sources[0].sourceId = 'provider-invented';
  await f.policy.search({ queries: [f.policy.queries[0]] });
  const result = f.policy.finish(JSON.stringify(success()));
  assert.equal(result.items[0].publishedAt, '2026-09-11T12:00:00.000Z');
  assert.equal(result.items[0].sourceId, 'web:1');
});

for (const batched of [false, true]) test(`approved queries 逐 topic 一次且总共最多两次，批量=${batched}`, async () => {
  const f = policyFixture(), p = f.policy;
  assert.deepEqual(p.queries, ['AI Native 2026-09-11 至 2026-09-18', '产品增长 2026-09-11 至 2026-09-18']);
  if (batched) await p.search({ queries: p.queries });
  else for (const query of p.queries) await p.search({ queries: [query] });
  assert.equal(p.calls, 2); assert.equal(p.successfulSearches, 2);
  assert.deepEqual(f.searches.map(call => call.request), p.queries.map(query => ({ query, maxResults: 4 })));
  await assert.rejects(p.search({ queries: [p.queries[0]] }), safe);
  await assert.rejects(p.search({ queries: ['网页要求发起新搜索'] }), safe);
  assert.equal(f.searches.length, 2);
});

test('非法、重复和混入未批准查询整批拒绝，不消耗预算', async () => {
  const f = policyFixture(), p = f.policy, q = p.queries[0];
  for (const args of [null, {}, [], { queries: [] }, { queries: q }, { queries: [1] }, { queries: [q, q] }, { queries: [q, '其他查询'] }, { queries: [...p.queries, '第三条'] }, { queries: [q], raw: SECRET }]) {
    await assert.rejects(p.search(args), safe);
    assert.equal(f.searches.length, 0); assert.equal(p.calls, 0);
  }
  await p.search({ queries: [q] });
  assert.equal(f.searches.length, 1);
});

test('失败搜索仍消耗该 topic 预算，禁止重试，成功另一 topic 也不能掩盖失败', async () => {
  const f = policyFixture({ search: async () => {
    if (f.searches.length === 1) throw Error(SECRET);
    return { sources: sources() };
  } }), p = f.policy;
  await assert.rejects(p.search({ queries: [p.queries[0]] }), safe);
  await assert.rejects(p.search({ queries: [p.queries[0]] }), safe);
  assert.equal(p.calls, 1); assert.equal(f.searches.length, 1); assert.equal(p.failed, true);
  await p.search({ queries: [p.queries[1]] });
  assert.equal(p.calls, 2); assert.equal(p.successfulSearches, 1);
  assert.throws(() => p.finish(JSON.stringify(silent())), safe);
  assert.throws(() => p.finish(JSON.stringify(success())), safe);
});

test('来源去重、字段白名单和上限；不透传搜索 provider 自由文本或 metadata', async () => {
  const f = policyFixture(), p = f.policy;
  f.response = { content: SECRET, metadata: { key: SECRET }, sources: sources(END, 6).map(source => ({ ...source, raw: SECRET, sourceId: SECRET, title: '题'.repeat(251), snippet: '文'.repeat(1600) })) };
  f.response.sources[1].url = 'HTTPS://EXAMPLE.COM:443/news/1#section';
  const result = await p.search({ queries: p.queries });
  assert.equal(result.sources.length, 3);
  for (const source of result.sources) {
    assert.deepEqual(Object.keys(source).sort(), ['fetched', 'id', 'kind', 'sourceId', 'text', 'time', 'title', 'url']);
    assert.equal(source.title.length, 250); assert.equal(source.text.length, 1500);
  }
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

test('web_fetch 只能读取搜索 URL，三个不同网页预算，正文补齐日期才允许成功', async t => {
  const f = await fixture(t); f.searchResult.sources.forEach(source => { delete source.publishedAt; });
  f.newsTurn = async policy => {
    await policy.search({ queries: policy.queries });
    for (const source of f.searchResult.sources.slice(0, 3)) await policy.fetch({ url: source.url });
    return completed(success(3));
  };
  const run = await f.run(f.save());
  assert.equal(run.status, 'success'); assert.equal(run.pagesRead, 3);
  assert.deepEqual(f.fetchCalls.map(call => call.url), f.searchResult.sources.slice(0, 3).map(source => source.url));
  assert.ok(f.fetchCalls.every(call => call.options.signal instanceof AbortSignal));
  assert.ok(run.sources.every(source => source.fetched && source.text === '公开网页正文'));
  assert.ok(run.items.every(entry => entry.publishedAt === '2026-09-17T12:00:00.000Z'));
});

test('web_fetch 搜索前、搜索外、额外字段、重复 URL 和第四页全部拒绝', async () => {
  const f = policyFixture(), p = f.policy, urls = sources().map(source => source.url);
  await assert.rejects(p.fetch({ url: urls[0] }), safe);
  await p.search({ queries: [p.queries[0]] });
  for (const args of [null, {}, { url: urls[0], headers: { cookie: SECRET } }, { url: 'https://example.com/not-searched' }]) await assert.rejects(p.fetch(args), safe);
  assert.equal(f.fetches.length, 0);
  await p.fetch({ url: 'HTTPS://EXAMPLE.COM:443/news/1#fragment' });
  await assert.rejects(p.fetch({ url: urls[0] }), safe);
  await p.fetch({ url: urls[1] }); await p.fetch({ url: urls[2] });
  await assert.rejects(p.fetch({ url: urls[3] }), safe);
  assert.equal(p.fetches, 3); assert.equal(f.fetches.length, 3);
});

test('恶意 search URL 不入白名单也不能 fetch；无真实 DNS 或 HTTP', async () => {
  const f = policyFixture(), p = f.policy;
  const urls = ['file:///private/key', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://169.254.169.254', 'https://user:pass@example.com', 'https://example.com:8443', 'https://host.internal', 'https://example.com\\@localhost'];
  for (const url of urls) await assert.rejects(p.fetch({ url }), safe);
  f.response.sources = urls.slice(0, 4).map(url => ({ ...sources()[0], url }));
  assert.deepEqual((await p.search({ queries: [p.queries[0]] })).sources, []);
  assert.equal(f.fetches.length, 0); assert.equal(p.fetches, 0);
  assert.throws(() => p.finish(JSON.stringify(success())), safe);
});

test('fetch 失败占用预算且不自动重试，无近期证据时不得以 silent 掩盖', async t => {
  const f = await fixture(t); f.searchResult.sources.forEach(source => { delete source.publishedAt; });
  f.fetchTurn = async () => { throw Error(SECRET); };
  f.newsTurn = async policy => {
    await policy.search({ queries: policy.queries });
    try { await policy.fetch({ url: f.searchResult.sources[0].url }); } catch {}
    try { await policy.fetch({ url: f.searchResult.sources[0].url }); } catch {}
    return completed(silent());
  };
  noDelivery(await f.run(f.save()), 'failed');
  assert.equal(f.fetchCalls.length, 1);
  assert.equal(f.newsCalls[0].policy.fetches, 1); assert.equal(f.newsCalls[0].policy.fetchFailures, 1);
});

for (const method of ['search', 'fetch']) test(`policy 自身预先 abort 拒绝 ${method}，不调用 provider`, async () => {
  const f = policyFixture(), p = f.policy;
  if (method === 'fetch') await p.search({ queries: [p.queries[0]] });
  const before = f.searches.length;
  f.controller.abort();
  await assert.rejects(method === 'search' ? p.search({ queries: [p.queries[0]] }) : p.fetch({ url: sources()[0].url }), { name: 'AbortError' });
  assert.equal(f.searches.length, before); assert.equal(f.fetches.length, 0);
  assert.throws(() => p.finish(JSON.stringify(success())), { name: 'AbortError' });
});

for (const method of ['search', 'fetch']) for (const origin of ['policy', 'tool']) test(`${method} 执行中 ${origin} abort 传播，迟到结果不接受`, async () => {
  const entered = deferred(), proceed = deferred(), tool = new AbortController();
  let received;
  const f = policyFixture({
    ...(method === 'search' ? { search: async (_request, signal) => { received = signal; entered.resolve(); await proceed.promise; return { sources: sources() }; } }
      : { fetchPage: async (_url, { signal }) => { received = signal; entered.resolve(); await proceed.promise; return { text: '迟到正文', publishedAt: '2026-09-17' }; } }),
  });
  const p = f.policy;
  if (method === 'fetch') await p.search({ queries: [p.queries[0]] });
  const pending = method === 'search' ? p.search({ queries: [p.queries[0]] }, tool.signal) : p.fetch({ url: sources()[0].url }, tool.signal);
  const rejected = assert.rejects(pending);
  await entered.promise;
  (origin === 'policy' ? f.controller : tool).abort();
  assert.equal(received.aborted, true);
  proceed.resolve();
  await rejected;
  if (method === 'search') { assert.equal(p.sources.size, 0); assert.equal(p.successfulSearches, 0); }
  else assert.equal(p.sources.get(sources()[0].url).fetched, false);
});

for (const method of ['search', 'fetch']) test(`tool 信号预先 abort 时 ${method} 不得调用 provider`, async () => {
  const f = policyFixture(), p = f.policy, tool = new AbortController();
  if (method === 'fetch') await p.search({ queries: [p.queries[0]] });
  const searches = f.searches.length;
  tool.abort();
  await assert.rejects(method === 'search' ? p.search({ queries: [p.queries[0]] }, tool.signal) : p.fetch({ url: sources()[0].url }, tool.signal));
  assert.equal(f.searches.length, searches); assert.equal(f.fetches.length, 0);
});

for (const action of ['source', 'disable', 'delete']) for (const phase of ['topic', 'news']) test(`${phase} 期间 ${action} 后 cancelled 且不投递`, async t => {
  const f = await fixture(t); const source = f.add(), job = f.save();
  const entered = f.hold(), proceed = f.hold();
  const mutate = () => {
    if (action === 'source') f.store.deleteJournal(source.id);
    if (action === 'disable') f.save({ enabled: false }, job.id);
    if (action === 'delete') f.store.deleteRoutine(job.id, f.store.routines().revision);
    f.routines.cancelChanged();
  };
  if (phase === 'topic') f.topicTurn = async () => { entered.resolve(); await proceed.promise; return f.topicResult; };
  else f.newsTurn = async p => { await p.search({ queries: p.queries }); entered.resolve(); await proceed.promise; return completed(success()); };
  const pending = f.run(job);
  await entered.promise; mutate(); proceed.resolve();
  const run = await pending;
  noDelivery(run, 'cancelled');
  if (action !== 'source') {
    assert.equal(f.events.filter(([event]) => event === `${phase}.cancel`).length, 1);
    if (phase === 'topic') assert.equal(f.newsCalls.length, 0);
    else assert.equal(f.newsCalls[0].policy.signal.aborted, true);
  }
  assert.equal(f.routines.active, null);
});

test('来源更新而非删除也取消输出，不伪造聊天投递', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(END) - 3600000 });
  const f = await fixture(t), todo = f.store.addTodo('生成中会完成的待办'), job = f.save();
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); f.store.updateTodo(todo.id, 'done', todo.revision); return completed(success()); };
  noDelivery(await f.run(job), 'cancelled');
  assert.deepEqual(f.store.messages(), []);
});

test('来源在 topic 期间变化应停止后续搜索，而非搜索完才取消投递', async t => {
  const f = await fixture(t), source = f.add(), job = f.save();
  f.topicTurn = async () => { f.store.deleteJournal(source.id); return completed(['AI Native']); };
  noDelivery(await f.run(job), 'cancelled');
  assert.equal(f.newsCalls.length, 0, '来源已失效后不得继续启动联网模型');
  assert.equal(f.searchCalls.length, 0);
});

test('topic 准备期间取消不能降级 fallback 再搜索', async t => {
  const f = await fixture(t); f.add(); const job = f.save();
  f.runtime.prepare = async () => { f.routines.cancel('测试取消'); };
  noDelivery(await f.run(job), 'cancelled');
  assert.equal(f.topicCalls.length, 0); assert.equal(f.newsCalls.length, 0); assert.equal(f.searchCalls.length, 0);
});

for (const scenario of [
  { name: '不存在的日历日期', end: '2026-03-03T12:00:00.000Z', date: '2026-02-30' },
  { name: '没有时区的时间戳', end: END, date: '2026-09-17T12:00:00' },
]) test(`来源日期必须可核验，拒绝${scenario.name}`, async t => {
  const f = await fixture(t, { now: scenario.end });
  f.searchResult.sources[0].publishedAt = scenario.date;
  noDelivery(await f.run(f.save()), 'failed');
});

for (const field of ['title', 'reason']) test(`invalid schema：${field} 非法 Unicode 必须 failed`, async t => {
  const f = await fixture(t);
  const output = field === 'title' ? { ...success(), items: [{ ...item(), title: '\ud800' }] } : { ...silent(), reason: '\ud800' };
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); return completed(output); };
  noDelivery(await f.run(f.save()), 'failed');
});

test('API 启用联网需两个严格 true 同意；停用保存无需同意；拒绝额外字段', async t => {
  const f = await fixture(t, { api: true }), revision = f.store.routines().revision;
  const base = { job: definition, revision, confirmDataSharing: true };
  for (const value of [undefined, false, 'true', 1, null]) {
    const result = await f.request('/api/routines', { ...base, ...(value === undefined ? {} : { confirmNetwork: value }) });
    assert.equal(result.status, 400); assert.equal(f.store.routines().revision, revision);
  }
  for (const value of [undefined, false, 'true']) {
    const result = await f.request('/api/routines', { job: definition, revision, confirmNetwork: true, ...(value === undefined ? {} : { confirmDataSharing: value }) });
    assert.equal(result.status, 400);
  }
  assert.equal((await f.request('/api/routines', { ...base, confirmNetwork: true, extra: true })).status, 400);
  const saved = await f.request('/api/routines', { job: { ...definition, enabled: false }, revision });
  assert.equal(saved.status, 201);
  const id = saved.data.jobs.at(-1).id, path = '/api/routines/' + id;
  const enable = { job: definition, revision: saved.data.revision, confirmDataSharing: true };
  assert.equal((await f.request(path, enable)).status, 400);
  const enabled = await f.request(path, { ...enable, confirmNetwork: true });
  assert.equal(enabled.status, 200); assert.equal(enabled.data.jobs.find(job => job.id === id).enabled, true);
  const create = await f.request('/api/routines', { ...base, revision: enabled.data.revision, confirmNetwork: true });
  assert.equal(create.status, 201);
  assert.equal(f.topicCalls.length, 0); assert.equal(f.newsCalls.length, 0); assert.equal(f.searchCalls.length, 0);
});

test('API 手动运行每次都需 confirmNetwork=true；202 在模型完成前返回，历史与幂等正确', async t => {
  const f = await fixture(t, { api: true, now: new Date() });
  f.add();
  const job = f.save({ enabled: false }), path = '/api/routines/' + job.id;
  const base = { revision: f.store.routines().revision, requestId: randomUUID(), confirmDataSharing: true };
  for (const value of [undefined, false, 'true', 1]) {
    assert.equal((await f.request(path + '/run', { ...base, ...(value === undefined ? {} : { confirmNetwork: value }) })).status, 400);
  }
  assert.equal((await f.request(path + '/run', { ...base, confirmNetwork: true, extra: true })).status, 400);
  assert.equal((await f.request(path + '/run', { ...base, confirmNetwork: true, confirmDataSharing: false })).status, 400);
  assert.equal((await f.request(path + '/run', { ...base, confirmNetwork: true, revision: 'stale' })).status, 409);
  assert.equal((await f.request(path + '/run', { ...base, confirmNetwork: true, requestId: 'invalid' })).status, 400);
  assert.equal(f.topicCalls.length, 0);
  const entered = f.hold(), proceed = f.hold();
  f.topicTurn = async () => { entered.resolve(); await proceed.promise; return f.topicResult; };
  const body = { ...base, confirmNetwork: true };
  const accepted = await f.request(path + '/run', body);
  assert.equal(accepted.status, 202); assert.deepEqual(accepted.data, { accepted: true });
  await entered.promise;
  assert.equal(f.maintenance.status().running, true);
  assert.equal(f.store.routineRuns(job.id)[0].status, 'running'); assert.equal(f.newsCalls.length, 0);
  assert.equal((await f.request(path + '/run', { ...body, requestId: randomUUID() })).status, 409);
  const operation = f.maintenance.operation;
  proceed.resolve(); await operation;
  const history = await f.request(path + '/history', undefined, 'GET');
  assert.equal(history.status, 200); assert.equal(history.data.runs.length, 1); assert.equal(history.data.runs[0].status, 'success');
  assert.equal((await f.request(path + '/run', body)).status, 202); await f.maintenance.operation;
  assert.equal(f.topicCalls.length, 1); assert.equal(f.newsCalls.length, 1); assert.equal(f.store.routineRuns(job.id).length, 1);
  const state = await f.request('/api/state', undefined, 'GET');
  assert.equal(state.data.routineCapability.network, true); assert.equal(state.data.routineRuns[0].items.length, 1);
});

for (const action of ['disable', 'delete']) test(`API 异步任务 ${action} 即时 cancel 正确新闻会话且不投递`, async t => {
  const f = await fixture(t, { api: true, now: new Date() }), job = f.save(), path = '/api/routines/' + job.id;
  const entered = f.hold(), proceed = f.hold();
  f.newsTurn = async policy => { await policy.search({ queries: policy.queries }); entered.resolve(); await proceed.promise; return completed(success()); };
  const revision = f.store.routines().revision;
  assert.equal((await f.request(path + '/run', { revision, requestId: randomUUID(), confirmDataSharing: true, confirmNetwork: true })).status, 202);
  await entered.promise;
  const operation = f.maintenance.operation;
  const result = action === 'delete' ? await f.request(path, { revision }, 'DELETE') : await f.request(path, { revision, job: { ...definition, enabled: false } });
  assert.equal(result.status, 200);
  assert.equal(f.newsCalls[0].policy.signal.aborted, true);
  assert.deepEqual(f.events.filter(([event]) => event === 'news.cancel'), [['news.cancel', f.newsCalls[0].id]]);
  proceed.resolve(); await operation;
  noDelivery(f.store.routineRuns(job.id)[0], 'cancelled');
});

test('capability=false 兼容 A：资讯停用可保存、启用和手动拒绝、本地摘要仍可运行', async t => {
  const f = await fixture(t, { api: true, network: false, now: new Date() });
  let revision = f.store.routines().revision;
  const consent = { confirmDataSharing: true, confirmNetwork: true };
  assert.equal((await f.request('/api/routines', { job: definition, revision, ...consent })).status, 409);
  const saved = await f.request('/api/routines', { job: { ...definition, enabled: false }, revision });
  assert.equal(saved.status, 201); revision = saved.data.revision;
  const id = saved.data.jobs.at(-1).id, path = '/api/routines/' + id;
  assert.equal((await f.request(path + '/run', { revision, requestId: randomUUID(), ...consent })).status, 409);
  const blocked = f.save();
  await f.routines.tick(f.now);
  assert.equal(f.topicCalls.length, 0); assert.equal(f.newsCalls.length, 0);
  const snapshot = f.routines.snapshot(f.now).jobs.find(job => job.id === blocked.id);
  assert.equal(snapshot.nextRun, null); assert.match(snapshot.blockedReason, /没有搜索能力/);
  f.add(); const local = f.save({ allowNetwork: false, enabled: false });
  f.topicTurn = async prompt => {
    const data = JSON.parse(prompt.split('<routine_data_untrusted>')[1].split('</routine_data_untrusted>')[0]);
    return completed({ status: 'success', summary: '仅本地记录摘要', reason: '', sourceIds: [data[0].sourceId] });
  };
  assert.equal((await f.request('/api/routines/' + local.id + '/run', { revision: f.store.routines().revision, requestId: randomUUID(), confirmDataSharing: true })).status, 202);
  await f.maintenance.operation;
  assert.equal(f.store.routineRuns(local.id)[0].status, 'success');
  assert.equal(f.topicCalls.length, 1); assert.equal(f.newsCalls.length, 0); assert.equal(f.searchCalls.length, 0);
  const state = await f.request('/api/state', undefined, 'GET');
  assert.equal(state.status, 200); assert.equal(state.data.routineCapability.network, false);
});
