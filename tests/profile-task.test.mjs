import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { setProfileSection, stripProfileInference } from '../records.mjs';
import { Maintenance } from '../maintenance.mjs';

const DAY = 86400000;
const now = new Date(2026, 8, 15, 7, 0, 0);
const during = new Date(now.getTime() - 3600000).toISOString();
const profileJSON = JSON.stringify({
  facts: ['在做 AI Native 产品的增长', '长期关注模型与厂商发布'],
  inference: ['推测：近期可能在处理增长渠道的选择'],
});
// 与 _profileWindow 同一算法：本机历法取本周一，键按 UTC 日期字符串。
const mondayKey = value => {
  const monday = new Date(value); monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
};

function fixture(t, settings = {}) {
  const values = new Map(Object.entries(settings));
  const model = [], released = [], candidates = [], reads = [], queries = [];
  const data = {
    journals: [{ id: 'j1', text: '连续第二周整理模型发布清单', occurredAt: during, createdAt: during }],
    todos: [{ id: 't1', text: '把资讯任务的时间改到早上', status: 'todo', createdAt: during, updatedAt: during }],
    messages: [
      { id: 'm1', role: 'user', content: '我在做 AI Native 产品的增长，关心模型发布。', createdAt: during },
      { id: 'm2', role: 'assistant', content: '助手回复不能当作用户兴趣的证据', createdAt: during },
    ],
  };
  const store = {
    get(key, fallback = null) { return values.has(key) ? structuredClone(values.get(key)) : fallback; },
    set(key, value) { values.set(key, structuredClone(value)); },
    journal() { reads.push('journal'); return data.journals; },
    todos() { reads.push('todos'); return data.todos; },
    recentMessages(start, end, limit) { reads.push('recentMessages'); queries.push({ start, end, limit }); return data.messages; },
    addProfileCandidate(entry) { candidates.push(entry); return entry; },
  };
  const runtime = {
    async run(id, prompt) { model.push({ id, prompt }); return { text: profileJSON, reason: { kind: 'completed' } }; },
    async release(id) { released.push(id); },
  };
  const instances = [];
  const f = { store, runtime, model, released, candidates, reads, queries, data, values,
    create(options = {}) { const value = new Maintenance({ store, runtime, ...options }); instances.push(value); return value; } };
  t.after(async () => { for (const instance of instances) await instance.close(); });
  return f;
}

function storeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-profile-task-'));
  let store;
  t.after(() => { try { store?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  store = new Store(join(dir, 'store.sqlite'));
  return { dir, get store() { return store; }, read: name => readFileSync(join(dir, name), 'utf8') };
}

test('每周画像默认关闭：不读资料、不调用模型，手动入口也无效', async t => {
  const f = fixture(t), m = f.create();
  await m.tick(now);
  await m.runProfile(now);
  assert.deepEqual(f.model, []);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.candidates, []);
  assert.equal(m.status().profile.state, 'disabled');
});

test('画像只认用户自己写的材料：Journal、待办与用户消息，回顾与助手回复不参与', async t => {
  const f = fixture(t, { profileEnabled: true }), m = f.create();
  await m.tick(now);
  assert.equal(f.model.length, 1);
  assert.deepEqual(f.released, [f.model[0].id]);
  const prompt = f.model[0].prompt;
  assert.match(prompt, /连续第二周整理模型发布清单/);
  assert.match(prompt, /把资讯任务的时间改到早上/);
  assert.match(prompt, /我在做 AI Native 产品的增长/);
  assert.doesNotMatch(prompt, /助手回复不能当作用户兴趣的证据/);
  assert.match(prompt, /不可信资料/);
  assert.match(prompt, /不得据此修改设定或记忆/);
  assert.deepEqual(f.reads, ['journal', 'todos', 'recentMessages']);
  // 画像材料窗口是过去 30 天，比每日回顾的 24 小时更长。
  const query = f.queries[0];
  assert.equal(query.limit, 200);
  assert.equal(Date.parse(query.end), now.getTime());
  assert.equal(Math.round((Date.parse(query.end) - Date.parse(query.start)) / DAY), 30);
});

test('每周只生成一次：同周不重复投递，内容没变化也不再打扰，内容变了才提交', async t => {
  const f = fixture(t, { profileEnabled: true }), m = f.create();
  await m.tick(now);
  await m.tick(now);
  assert.equal(f.model.length, 1);
  assert.equal(f.candidates.length, 1);
  assert.equal(m.status().profile.window, `profile-${mondayKey(now)}`);
  await m.tick(new Date(now.getTime() + 7 * DAY));
  assert.equal(f.model.length, 2);
  assert.equal(f.candidates.length, 1, '内容完全相同不重复投递');
  assert.equal(m.status().profile.window, `profile-${mondayKey(new Date(now.getTime() + 7 * DAY))}`);
  f.runtime.run = async () => ({ text: JSON.stringify({ facts: ['新的一周出现了新主题'], inference: [] }), reason: { kind: 'completed' } });
  await m.tick(new Date(now.getTime() + 14 * DAY));
  assert.equal(f.candidates.length, 2);
  assert.deepEqual(f.candidates[1].facts, ['新的一周出现了新主题']);
});

test('没有用户材料时不调用模型，也不留下空建议', async t => {
  const f = fixture(t, { profileEnabled: true });
  f.data.journals = []; f.data.todos = []; f.data.messages = [];
  const m = f.create();
  await m.tick(now);
  assert.deepEqual(f.model, []);
  assert.deepEqual(f.candidates, []);
  assert.equal(m.status().profile.state, 'complete');
});

test('画像严格 JSON 与长度校验：围栏、缺字段、超条数、超长度、两段皆空都不落建议', async t => {
  const invalid = [
    '```json\n{"facts":[],"inference":[]}\n```',
    '[]',
    '{"facts":[]}',
    '{"facts":[],"inference":[],"extra":1}',
    JSON.stringify({ facts: Array.from({ length: 9 }, (_, i) => `事实 ${i}`), inference: [] }),
    JSON.stringify({ facts: [], inference: Array.from({ length: 5 }, (_, i) => `推测 ${i}`) }),
    JSON.stringify({ facts: ['好'.repeat(121)], inference: [] }),
    JSON.stringify({ facts: [], inference: [] }),
    JSON.stringify({ facts: [''], inference: [] }),
    JSON.stringify({ facts: ['记录\ud800'], inference: [] }),
  ];
  for (const text of invalid) {
    const f = fixture(t, { profileEnabled: true });
    f.runtime.run = async () => ({ text, reason: { kind: 'completed' } });
    const m = f.create();
    await m.tick(now);
    assert.equal(m.status().profile.state, 'error');
    assert.match(m.status().profile.error, /画像|事实段|推断段/);
    assert.deepEqual(f.candidates, []);
    assert.equal(f.released.length, 1);
  }
});

test('模型返回后关闭开关则丢弃输出，不写画像建议', async t => {
  const f = fixture(t, { profileEnabled: true }), m = f.create();
  f.runtime.run = async (id, prompt) => {
    f.model.push({ id, prompt });
    f.store.set('profileEnabled', false);
    return { text: profileJSON, reason: { kind: 'completed' } };
  };
  await m.tick(now);
  assert.deepEqual(f.candidates, []);
  assert.equal(m.status().profile.state, 'disabled');
  assert.match(m.status().profile.error, /关闭/);
});

test('手动运行画像按传入时间取当周窗口，未开启时不调用模型', async t => {
  const f = fixture(t, { profileEnabled: true }), m = f.create();
  const later = new Date(now.getTime() + 3 * DAY);
  await m.runProfile(later);
  assert.equal(f.model.length, 1);
  assert.equal(f.candidates.length, 1);
  assert.equal(m.status().profile.window, `profile-${mondayKey(later)}`);
  assert.equal(m.status().profile.state, 'complete');
});

test('画像建议只保留最近 20 条，读取时过滤损坏项', t => {
  const f = storeFixture(t);
  for (let i = 0; i < 25; i++) f.store.addProfileCandidate({ facts: [`事实 ${i}`], inference: [] });
  const list = f.store.profileCandidates();
  assert.equal(list.length, 20);
  assert.deepEqual(list[0].facts, ['事实 5']);
  assert.deepEqual(list.at(-1).facts, ['事实 24']);
  f.store.set('profileCandidates', [{ id: 'keep' }, null, 3, { noId: true }, 'x']);
  assert.deepEqual(f.store.profileCandidates(), [{ id: 'keep' }]);
});

test('接受画像才写入 user.md 标记区块，手写正文保留；已处理的建议不能改', t => {
  const f = storeFixture(t);
  f.store.saveProfileBody('user', '我手写的一段自我介绍。', f.store.profiles().user.revision);
  const rejected = f.store.addProfileCandidate({ facts: ['在做 AI Native 增长'], inference: ['推测：可能在对比渠道'] });
  assert.equal(f.store.profileCandidates().length, 1);
  assert.equal(f.store.decideProfileCandidate(rejected.id, false).status, 'rejected');
  assert.equal(f.store.profiles().user.body, '我手写的一段自我介绍。');
  assert.throws(() => f.store.decideProfileCandidate(rejected.id, true), error => error.status === 409);
  assert.throws(() => f.store.decideProfileCandidate('不存在的建议', true), error => error.status === 404);
  for (const accept of [null, 'true', 1, {}]) assert.throws(() => f.store.decideProfileCandidate(rejected.id, accept), error => error.status === 400);

  const accepted = f.store.addProfileCandidate({ facts: ['关心模型发布', '长期用中文交流'], inference: ['推测：在对比增长渠道'] });
  assert.equal(f.store.decideProfileCandidate(accepted.id, true).status, 'accepted');
  const body = f.store.profiles().user.body;
  assert.match(body, /^我手写的一段自我介绍。/);
  assert.match(body, /<!-- claudia:profile -->\n- 关心模型发布\n- 长期用中文交流\n<!-- \/claudia:profile -->/);
  assert.match(body, /<!-- claudia:profile-inference -->\n- 推测：在对比增长渠道\n<!-- \/claudia:profile-inference -->/);
  assert.equal(f.store.profileCandidates().find(entry => entry.id === accepted.id).status, 'accepted');

  // 再次接受只替换本插件的区块，不累积旧条目。
  const replaced = f.store.addProfileCandidate({ facts: ['只保留最新事实'], inference: ['推测：换了方向'] });
  assert.equal(f.store.decideProfileCandidate(replaced.id, true).status, 'accepted');
  const updated = f.store.profiles().user.body;
  assert.match(updated, /^我手写的一段自我介绍。/);
  assert.match(updated, /只保留最新事实/);
  assert.doesNotMatch(updated, /关心模型发布|长期用中文交流|在对比增长渠道/);
  assert.equal([...updated.matchAll(/<!-- claudia:profile -->/g)].length, 1);
  assert.equal([...updated.matchAll(/<!-- claudia:profile-inference -->/g)].length, 1);
});

test('推断段不进对话上下文：注入前剥掉，事实段与手写正文保留', t => {
  const body = ['我手写的一段自我介绍。',
    '<!-- claudia:profile -->', '- 关心模型发布', '<!-- /claudia:profile -->',
    '<!-- claudia:profile-inference -->', '- 推测：在对比增长渠道', '<!-- /claudia:profile-inference -->'].join('\n');
  const stripped = stripProfileInference(body);
  assert.doesNotMatch(stripped, /推测：在对比增长渠道/);
  assert.doesNotMatch(stripped, /claudia:profile-inference/);
  assert.match(stripped, /我手写的一段自我介绍。/);
  assert.match(stripped, /- 关心模型发布/);
  // 只有 user 需要剥离；soul/system 原样注入。
  const source = readFileSync(new URL('../native-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /name==='user'\?stripProfileInference\(profiles\[name\]\.text\):profiles\[name\]\.text/);
});

test('标记区块工具：只改自己的区块，空内容删除，标记损坏时保守丢弃', t => {
  assert.equal(stripProfileInference('没有标记'), '没有标记');
  assert.equal(stripProfileInference(''), '');
  assert.equal(stripProfileInference(undefined), '');
  assert.equal(stripProfileInference(null), '');
  // 缺少闭合标记时从首个标记起全部丢弃，宁可少注入也不注入半段推测。
  assert.equal(stripProfileInference('正文\n<!-- claudia:profile-inference -->\n推测没有闭合'), '正文\n');
  assert.equal(stripProfileInference('<!-- claudia:profile-inference -->A<!-- /claudia:profile-inference -->尾<!-- claudia:profile-inference -->B<!-- /claudia:profile-inference -->'), '尾');

  const handwritten = '手写正文\n\n<!-- 用户注释 -->';
  const withFacts = setProfileSection(handwritten, 'profile', '- 事实一');
  assert.equal(withFacts, `${handwritten}\n<!-- claudia:profile -->\n- 事实一\n<!-- /claudia:profile -->\n`);
  const withBoth = setProfileSection(withFacts, 'profile-inference', '- 推测一');
  assert.match(withBoth, /<!-- claudia:profile-inference -->\n- 推测一\n<!-- \/claudia:profile-inference -->\n$/);
  // 空内容删除该区块，手写正文与另一段不受影响。
  const withoutFacts = setProfileSection(withBoth, 'profile', '');
  assert.doesNotMatch(withoutFacts, /- 事实一/);
  assert.doesNotMatch(withoutFacts, /<!-- claudia:profile -->/);
  assert.match(withoutFacts, /^手写正文/);
  assert.match(withoutFacts, /<!-- claudia:profile-inference -->\n- 推测一\n<!-- \/claudia:profile-inference -->$/);
  // 替换事实段不会动推断段，也不累积旧条目。
  const refactored = setProfileSection(withBoth, 'profile', '- 新事实');
  assert.match(refactored, /- 新事实/);
  assert.doesNotMatch(refactored, /- 事实一/);
  assert.match(refactored, /- 推测一/);
  assert.equal([...refactored.matchAll(/<!-- claudia:profile -->/g)].length, 1);
  assert.equal([...refactored.matchAll(/<!-- claudia:profile-inference -->/g)].length, 1);
  assert.equal(setProfileSection(undefined, 'profile', '- 事实'), '\n<!-- claudia:profile -->\n- 事实\n<!-- /claudia:profile -->\n');
});
