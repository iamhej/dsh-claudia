import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Records, PROFILE_DEFAULTS, MAX_PROFILE_CHARS } from '../records.mjs';
import { Store } from '../store.mjs';
import { startServer } from '../server.mjs';

const options = { timeout: 15_000 };
const keys = ['settings', 'soul', 'user', 'system'];
const bools = ['allowContext', 'activityEnabled', 'reflectionEnabled', 'autoUpdateEnabled', 'memorySuggestionsEnabled'];
const legacy = name => `<!-- dsh-claudia ${name} v1：UTF-8；保留元数据及记录边界；正文按原文保存，可外部编辑。 -->`;
const prefix = '\uFEFF---\r\n# 用户元数据注释\r\nassistantName: "旧名字"\r\ncustom: \'保持原样\'\r\nextra: "{{literal}}"\r\n---\r\n';
const digest = value => assert.match(value, /^[a-f0-9]{64}$/);

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'claudia-settings-batch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function disk(dir) {
  return Object.fromEntries(keys.map(key => [key, readFileSync(join(dir, `${key}.md`), 'utf8')]));
}
function payload(state, settings = {}, profiles = {}) {
  return {
    settings, profiles: Object.fromEntries(Object.entries(profiles).map(([name, body]) => [name, { body, revision: state.profiles[name].revision }])),
    settingsRevision: state.settingsRevision, soulRevision: state.profiles.soul.revision,
  };
}
function ok(response, status = 200) {
  assert.equal(response.status, status, response.raw);
  return response.data;
}
function marker(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return !!db.prepare('SELECT version FROM record_migrations WHERE version=?').get('profile-defaults-v1'); }
  finally { db.close(); }
}
function oldStore(t, files = {}) {
  const root = directory(t), file = join(root, 'claudia.sqlite');
  new Records(root).migrate({ journal: [], memories: [], messages: [], settings: {} });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE record_migrations (version TEXT PRIMARY KEY); INSERT INTO record_migrations VALUES ('markdown-v1')");
  db.close();
  for (const [name, text] of Object.entries(files)) {
    if (text === null) unlinkSync(join(root, `${name}.md`));
    else writeFileSync(join(root, `${name}.md`), text);
  }
  return { root, file };
}

// 仅注入内存 runtime/services，所有存储在独立临时目录，不加载宿主和真实凭据。
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'claudia-settings-batch-')), gates = [], activityCalls = [];
  const backgroundStarted = Promise.withResolvers(), backgroundDone = Promise.withResolvers();
  const controls = { slow: false, enabled: false, maintenance: false };
  let context;
  const app = await startServer({
    dataDir: root, home: join(root, 'synthetic-home'), port: 0,
    createRuntime: () => ({
      selection: () => ({ provider: 'synthetic', model: 'synthetic-model' }),
      status: () => ({ configured: true }),
      async release() {}, async close() {}, async cancel() {},
    }),
    createServices(injected) {
      context = injected;
      return {
        activity: {
          status: () => ({ enabled: controls.enabled, running: controls.enabled, state: 'idle' }),
          summary: () => ({ apps: [], seconds: 0 }),
          setEnabled(value) {
            assert.equal(context.isBusy(), true, '保存及应用发起阶段仍持有 configuring');
            activityCalls.push(value); controls.enabled = value;
            if (controls.slow) { const gate = Promise.withResolvers(); gates.push(gate); return gate.promise; }
          },
          async close() {},
        },
        maintenance: { status: () => ({ running: controls.maintenance }), async close() {} },
        background: {
          status: () => ({ supported: true }),
          async setEnabled() { backgroundStarted.resolve(); await backgroundDone.promise; return { enabled: true }; },
        },
      };
    },
  });
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    backgroundDone.resolve();
    try { await app.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const bootstrap = await fetch(`${app.url}/api/bootstrap`);
  const { csrfToken } = await bootstrap.json();
  async function request(path, value, { raw, token = csrfToken, timeout = 3_000 } = {}) {
    const post = value !== undefined || raw !== undefined;
    const response = await fetch(`${app.url}${path}`, {
      method: post ? 'POST' : 'GET',
      headers: post ? { 'content-type': 'application/json', 'x-claudia-token': token } : {},
      body: raw !== undefined ? raw : post ? JSON.stringify(value) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    return { status: response.status, data: JSON.parse(text), raw: text };
  }
  return {
    root, app, request, controls, context, gates, activityCalls, backgroundStarted, backgroundDone,
    state: async () => ok(await request('/api/state')),
    batch: (value, opts) => request('/api/settings/batch', value, opts),
  };
}

function watchWrites(t, records) {
  const original = records.write, calls = [];
  t.mock.method(records, 'write', function (name, text, revision) {
    assert.equal(existsSync(join(this.root, '.records.lock')), true);
    calls.push(name);
    return original.call(this, name, text, revision);
  });
  return calls;
}

test('state 暴露默认正文和全文件 revision，空设置不写入，原 profile/settings API 保留', options, async t => {
  const f = await fixture(t), state = await f.state();
  assert.deepEqual(state.profileDefaults, PROFILE_DEFAULTS);
  assert.deepEqual(Object.keys(state.profileDefaults).sort(), ['soul', 'system']);
  assert.equal(state.profiles.soul.body, PROFILE_DEFAULTS.soul);
  assert.equal(state.profiles.system.body, PROFILE_DEFAULTS.system);
  assert.equal(state.profiles.user.body, '');
  digest(state.settingsRevision);
  assert.equal(state.settingsRevision, f.app.store.records.read('settings.md').revision);
  for (const name of ['soul', 'user', 'system']) {
    assert.deepEqual(Object.keys(state.profiles[name]).sort(), ['body', 'revision', 'text']);
    digest(state.profiles[name].revision);
  }
  const writes = watchWrites(t, f.app.store.records);
  const noOp = ok(await f.batch(payload(state)));
  assert.deepEqual(Object.keys(noOp).sort(), ['errors', 'profiles', 'restart', 'saved', 'settings', 'settingsEffect', 'settingsRevision']);
  assert.deepEqual(noOp.saved, []); assert.deepEqual(noOp.errors, {});
  assert.deepEqual(noOp.profiles, state.profiles);
  assert.equal(noOp.settingsRevision, state.settingsRevision);
  assert.deepEqual(writes, []);
  ok(await f.request('/api/profiles/user', { body: '原正文接口', revision: state.profiles.user.revision }));
  const current = await f.state();
  ok(await f.request('/api/profiles/system', { text: '原全文接口', revision: current.profiles.system.revision }));
  ok(await f.request('/api/settings', { assistantName: '兼容旧接口' }));
  assert.equal((await f.state()).settings.assistantName, '兼容旧接口');
});

test('统一改名与 soul 合并一次写入，保留 BOM、CRLF、自定义元数据及名字单独修改的正文', options, async t => {
  const f = await fixture(t);
  writeFileSync(join(f.root, 'soul.md'), prefix + '原正文');
  const state = await f.state(), writes = watchWrites(t, f.app.store.records);
  const result = ok(await f.batch(payload(state, { assistantName: '新{{名字}}' }, { soul: '新正文\n<!-- 用户注释 -->' })));
  assert.deepEqual(result.saved, ['soul']); assert.deepEqual(result.errors, {});
  assert.deepEqual(writes, ['soul.md']);
  assert.equal(result.profiles.soul.text, prefix.replace('"旧名字"', '"新{{名字}}"') + '新正文\n<!-- 用户注释 -->');
  assert.equal(result.settings.assistantName, '新{{名字}}');
  assert.equal(result.settingsRevision, state.settingsRevision);
  const renamed = ok(await f.batch(payload(result, { assistantName: '仅改名' })));
  assert.deepEqual(renamed.saved, ['soul']);
  assert.equal(renamed.profiles.soul.body, result.profiles.soul.body);
  assert.deepEqual(writes, ['soul.md', 'soul.md']);
  assert.deepEqual(f.activityCalls, []);
});

test('五个 bool 一次 settings 写入加两个 profiles，响应和磁盘一致，同值保存不写入不重复应用', options, async t => {
  const f = await fixture(t), state = await f.state(), writes = watchWrites(t, f.app.store.records);
  const values = Object.fromEntries(bools.map(key => [key, true]));
  const result = ok(await f.batch(payload(state, values, { user: '用户自愿填写', system: '系统正文' })));
  assert.deepEqual(result.saved, ['settings', 'user', 'system']); assert.deepEqual(result.errors, {});
  assert.deepEqual(writes, ['settings.md', 'user.md', 'system.md']);
  for (const key of bools) assert.equal(result.settings[key], true);
  assert.deepEqual(result.profiles, f.app.store.profiles());
  assert.equal(result.settingsRevision, f.app.store.records.read('settings.md').revision);
  assert.notEqual(result.settingsRevision, state.settingsRevision);
  assert.deepEqual(f.activityCalls, [true]);
  const db = new DatabaseSync(join(f.root, 'claudia.sqlite'), { readOnly: true });
  try { assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='reflectionSources'").get().value), ['journal', 'todos', 'activity']); }
  finally { db.close(); }
  const again = ok(await f.batch(payload(result, values, { user: '用户自愿填写', system: '系统正文' })));
  assert.deepEqual(again.saved, []);
  assert.deepEqual(writes, ['settings.md', 'user.md', 'system.md']);
  assert.deepEqual(f.activityCalls, [true]);
});

test('settings、soul 名字、各 profile 的 revision 冲突均在任何写入前返回 409', options, async t => {
  const f = await fixture(t), state = await f.state(), before = disk(f.root);
  const writes = watchWrites(t, f.app.store.records);
  for (const field of ['settingsRevision', 'soulRevision', 'soul', 'user', 'system']) {
    const value = payload(state, { assistantName: '不应保存', activityEnabled: true }, { soul: '新 soul', user: '新 user', system: '新 system' });
    if (field.endsWith('Revision')) value[field] = '0'.repeat(64);
    else value.profiles[field].revision = '0'.repeat(64);
    ok(await f.batch(value), 409);
    assert.deepEqual(disk(f.root), before);
  }
  writeFileSync(join(f.root, 'soul.md'), state.profiles.soul.text + '\n外部修改');
  const external = disk(f.root);
  ok(await f.batch(payload(state, { assistantName: '仅名字也需检测冲突' })), 409);
  assert.deepEqual(disk(f.root), external);
  assert.deepEqual(writes, []); assert.deepEqual(f.activityCalls, []);
});

test('严格拒绝未知字段、密钥、端点、路径、错误类型、无效 Unicode 和请求总长，全部不落盘', options, async t => {
  const f = await fixture(t), state = await f.state(), before = disk(f.root), writes = watchWrites(t, f.app.store.records);
  const bad = [
    { key: 'SYNTHETIC_PRIVATE_KEY' }, { endpoint: 'SYNTHETIC_ENDPOINT' }, { path: '../user.md' }, { ['__proto__']: {} },
    { settings: null }, { settings: [] }, { profiles: [] }, { profiles: null },
    { settings: { key: 'SYNTHETIC_PRIVATE_KEY' } }, { settings: { endpoint: 'SYNTHETIC_ENDPOINT' } },
    { settings: { assistantName: null } }, { settings: { assistantName: '\ud800' } }, { settings: { assistantName: 'x'.repeat(41) } },
    { settings: { activityEnabled: 1 } }, { settings: { allowContext: 'false' } },
    { profiles: { '../soul': { body: '', revision: null } } }, { profiles: { constructor: {} } },
    { profiles: { soul: { body: '', revision: state.profiles.soul.revision, text: '不能同时提供' } } },
    { profiles: { user: { body: 1, revision: state.profiles.user.revision } } },
    { profiles: { user: { body: '\ud800', revision: state.profiles.user.revision } } },
    { profiles: { user: { body: '', revision: 1 } } }, { settingsRevision: {} }, { soulRevision: '' },
  ];
  for (const change of bad) {
    const response = await f.batch({ ...payload(state), ...change });
    ok(response, 400);
    assert.doesNotMatch(response.raw, /SYNTHETIC_PRIVATE_KEY|SYNTHETIC_ENDPOINT/);
  }
  for (const raw of ['[]', 'null', 'false', '{', '{"settings":{}}' + ' '.repeat(256 * 1024)]) ok(await f.batch({}, { raw }), 400);
  const missing = payload(state, { activityEnabled: true }); delete missing.settingsRevision;
  ok(await f.batch(missing), 409);
  const missingNameRevision = payload(state, { assistantName: '没有版本' }); delete missingNameRevision.soulRevision;
  ok(await f.batch(missingNameRevision), 409);
  assert.deepEqual(disk(f.root), before); assert.deepEqual(writes, []);
  assert.deepEqual(f.activityCalls, []);
});

test('预检含 frontmatter 的完整 profile 总长及 settings 内容，合法大正文可统一提交', options, async t => {
  const f = await fixture(t), state = await f.state(), before = disk(f.root), writes = watchWrites(t, f.app.store.records);
  ok(await f.batch(payload(state, { activityEnabled: true }, { soul: '字'.repeat(MAX_PROFILE_CHARS), user: '不能先保存' })), 400);
  ok(await f.batch(payload(state, { activityEnabled: true }, { system: 'x'.repeat(MAX_PROFILE_CHARS + 1) })), 400);
  assert.deepEqual(disk(f.root), before); assert.deepEqual(writes, []);
  writeFileSync(join(f.root, 'settings.md'), before.settings.replace('activityEnabled: false', 'activityEnabled: invalid'));
  const invalid = disk(f.root);
  ok(await f.batch(payload(state, {}, { user: '不能绕过损坏的设置' })), 400);
  assert.deepEqual(disk(f.root), invalid); assert.deepEqual(writes, []);
  writeFileSync(join(f.root, 'settings.md'), before.settings);
  const value = payload(state, {}, { soul: '字'.repeat(MAX_PROFILE_CHARS - (state.profiles.soul.text.length - state.profiles.soul.body.length)), user: '字'.repeat(MAX_PROFILE_CHARS), system: '字'.repeat(MAX_PROFILE_CHARS) });
  const result = ok(await f.batch(value));
  assert.deepEqual(result.saved, ['soul', 'user', 'system']);
  for (const name of ['soul', 'user', 'system']) assert.equal(result.profiles[name].text.length, MAX_PROFILE_CHARS);
});

test('defaults 迁移只替换空白或精确旧说明，保留自定义正文和 soul 元数据', options, t => {
  for (const contents of [
    { soul: ' \r\n\t', system: ' \n' },
    { soul: legacy('soul') + '\r\n', system: ' \n' + legacy('system') + '\n ' },
    { soul: '<!-- 用户自定义注释 -->', system: '已有自定义正文' },
    { soul: legacy('soul') + '\n保留正文', system: legacy('system') + ' 修改过的说明' },
    { soul: legacy('soul') + '\n' + legacy('soul'), system: legacy('system') + '\n' + legacy('system') },
  ]) {
    const { root, file } = oldStore(t, { soul: prefix + contents.soul, system: contents.system });
    const store = new Store(file);
    try {
      const replace = !contents.soul.trim() || contents.soul.trim() === legacy('soul');
      assert.equal(readFileSync(join(root, 'soul.md'), 'utf8'), prefix + (replace ? PROFILE_DEFAULTS.soul : contents.soul));
      assert.equal(readFileSync(join(root, 'system.md'), 'utf8'), replace ? PROFILE_DEFAULTS.system : contents.system);
      assert.equal(store.get('assistantName'), '旧名字');
      assert.equal(store.profiles().user.body, '');
      assert.equal(marker(file), true);
    } finally { store.close(); }
  }
});

test('迁移不复活已删除文件，完成后再次清空或删除的默认正文永不重填', options, t => {
  const { root, file } = oldStore(t, { soul: null, system: null });
  let store = new Store(file);
  assert.equal(marker(file), true);
  assert.equal(existsSync(join(root, 'soul.md')), false);
  assert.equal(existsSync(join(root, 'system.md')), false);
  store.close();
  store = new Store(file);
  try { assert.equal(store.profiles().soul.revision, null); assert.equal(store.profiles().system.revision, null); }
  finally { store.close(); }
  const other = oldStore(t);
  store = new Store(other.file);
  let profiles = store.profiles();
  store.saveProfileBody('soul', '', profiles.soul.revision);
  store.saveProfileBody('system', '', profiles.system.revision);
  store.close();
  store = new Store(other.file);
  try { profiles = store.profiles(); assert.equal(profiles.soul.body, ''); assert.equal(profiles.system.body, ''); }
  finally { store.close(); }
  unlinkSync(join(other.root, 'system.md'));
  store = new Store(other.file);
  try { assert.equal(store.profiles().system.revision, null); assert.equal(store.profiles().soul.body, ''); }
  finally { store.close(); }
});

test('defaults 中断不记迁移成功，重试保留已写入后用户修改的 soul 并补完 system', options, t => {
  const { root, file } = oldStore(t, { soul: prefix, system: legacy('system') });
  const original = Records.prototype.write, writes = [];
  const mock = t.mock.method(Records.prototype, 'write', function (name, text, revision) {
    writes.push(name);
    if (name === 'system.md') throw Object.assign(new Error('纯测试中断'), { code: 'EIO' });
    return original.call(this, name, text, revision);
  });
  assert.throws(() => new Store(file), /纯测试中断/);
  assert.equal(marker(file), false);
  assert.deepEqual(writes, ['soul.md', 'system.md']);
  assert.equal(readFileSync(join(root, 'soul.md'), 'utf8'), prefix + PROFILE_DEFAULTS.soul);
  assert.equal(existsSync(join(root, '.records.lock')), false);
  mock.mock.restore();
  writeFileSync(join(root, 'soul.md'), prefix + '中断后用户自定义');
  const store = new Store(file);
  try {
    assert.equal(store.profiles().soul.body, '中断后用户自定义');
    assert.equal(store.profiles().system.body, PROFILE_DEFAULTS.system);
    assert.equal(marker(file), true);
  } finally { store.close(); }
});

test('运行时 I/O 失败返回 200 已保存项与安全错误并停止后续文件，rename 后失败也准确报告', options, async t => {
  for (const failure of [
    { key: 'settings', saved: [] }, { key: 'soul', saved: ['settings'] },
    { key: 'user', saved: ['settings', 'soul'] }, { key: 'settings', saved: ['settings'], after: true },
  ]) {
    const f = await fixture(t), state = await f.state(), before = disk(f.root), writes = [];
    const original = f.app.store.records.write;
    t.mock.method(f.app.store.records, 'write', function (name, text, revision) {
      writes.push(name);
      if (name === `${failure.key}.md`) {
        if (failure.after) original.call(this, name, text, revision);
        throw Object.assign(new Error('SYNTHETIC_PRIVATE_KEY /private/arbitrary-path'), { code: 'EIO' });
      }
      return original.call(this, name, text, revision);
    });
    const result = ok(await f.batch(payload(state, { assistantName: '部分保存', activityEnabled: true }, { soul: '新 soul', user: '新 user', system: '新 system' })));
    assert.deepEqual(result.saved, failure.saved);
    assert.deepEqual(Object.keys(result.errors), [failure.key]);
    assert.match(result.errors[failure.key], /磁盘读写失败/);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_KEY|arbitrary-path/);
    assert.deepEqual(writes, keys.slice(0, keys.indexOf(failure.key) + 1).map(name => `${name}.md`));
    const after = disk(f.root);
    for (const name of keys) {
      if (failure.saved.includes(name)) assert.notEqual(after[name], before[name]);
      else assert.equal(after[name], before[name]);
    }
    assert.deepEqual(result.profiles, f.app.store.profiles());
    assert.equal(result.settingsRevision, f.app.store.records.read('settings.md').revision);
    assert.deepEqual(f.activityCalls, failure.saved.includes('settings') ? [true] : []);
    if (failure.saved.includes('settings')) assert.deepEqual(f.app.store.get('reflectionSources'), ['journal', 'todos', 'activity']);
    assert.equal(f.context.isBusy(), false);
  }
});

test('慢 activity 初始化不阻塞 200，后续关闭立即保存且旧失败不覆盖新状态', options, async t => {
  const f = await fixture(t), state = await f.state(); f.controls.slow = true;
  const started = performance.now();
  const enabled = ok(await f.batch(payload(state, { activityEnabled: true }), { timeout: 1_500 }));
  assert.ok(performance.now() - started < 1_500);
  assert.equal(enabled.settingsEffect.state, 'applying'); assert.equal(enabled.settingsEffect.restartRequired, false);
  assert.equal(f.gates.length, 1); assert.equal(f.context.isBusy(), false);
  assert.equal((await f.state()).settings.activityEnabled, true);
  const unrelated = ok(await f.batch(payload(enabled, {}, { user: '慢初始化期间仍可保存' })));
  assert.equal(unrelated.settingsEffect.state, 'applying'); assert.deepEqual(f.activityCalls, [true]);
  const disabled = ok(await f.batch(payload(unrelated, { activityEnabled: false })));
  assert.equal(disabled.settings.activityEnabled, false);
  assert.deepEqual(f.app.store.get('reflectionSources'), ['journal', 'todos']);
  assert.deepEqual(f.activityCalls, [true, false]);
  f.gates[1].resolve();
  assert.equal((await f.state()).settingsEffect.state, 'applied');
  f.gates[0].reject(new Error('SYNTHETIC_PRIVATE_ACTIVITY_FAILURE'));
  const settled = await f.state();
  assert.equal(settled.settingsEffect.state, 'applied'); assert.equal(settled.settings.activityEnabled, false);
});

test('batch 遵循 configuring、maintenance busy、CSRF 和既有非重入 records 锁，不死锁不写入', options, async t => {
  const f = await fixture(t), state = await f.state(), value = payload(state, { activityEnabled: true }), before = disk(f.root);
  const writes = watchWrites(t, f.app.store.records);
  ok(await f.batch(value, { token: '' }), 403);
  f.controls.maintenance = true;
  ok(await f.batch(value), 409);
  f.controls.maintenance = false;
  const background = f.request('/api/background', { enabled: true });
  await f.backgroundStarted.promise;
  assert.equal(f.context.isBusy(), true);
  ok(await f.batch(value), 409);
  f.backgroundDone.resolve(); ok(await background);
  assert.equal(f.context.isBusy(), false);
  f.app.store.records.locked(() => assert.throws(() => f.app.store.saveSettingsBatch(value), error => error.status === 409));
  assert.equal(existsSync(join(f.root, '.records.lock')), false);
  assert.deepEqual(writes, []); assert.deepEqual(disk(f.root), before);
  ok(await f.batch(value));
  assert.deepEqual(writes, ['settings.md']);
});
