import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync, symlinkSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { MAX_PROFILE_CHARS, MAX_RECORD_BYTES, PROFILE_DEFAULTS } from '../records.mjs';
import { startServer } from '../server.mjs';

const names = ['soul', 'user', 'system'];
const digest = text => createHash('sha256').update(text).digest('hex');
const isStatus = status => error => error.status === status;
const legacyHeader = name => `<!-- dsh-claudia ${name} v1：UTF-8；保留元数据及记录边界；正文按原文保存，可外部编辑。 -->\n`;
const soulPrefix = '---\nassistantName: "小岚"\ncustomField: 用户字段\n---\n';

function fixture(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-profile-body-'));
  let store;
  t.after(() => { try { store?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  const write = (name, text) => writeFileSync(join(dir, name), text, { mode: 0o600 });
  for (const [name, text] of Object.entries(files)) write(name, text);
  store = new Store(join(dir, 'store.sqlite'));
  return {
    dir, write,
    read: name => readFileSync(join(dir, name), 'utf8'),
    get store() { return store; },
    restart() { store.close(); store = undefined; store = new Store(join(dir, 'store.sqlite')); },
  };
}

test('新 profile 迁移填入 soul/system 默认正文，user 为空，其他记录仍保留说明及元数据', t => {
  const f = fixture(t);
  assert.equal(f.read('soul.md'), '---\nassistantName: "Claudia"\n---\n' + PROFILE_DEFAULTS.soul);
  for (const name of names) {
    const body = name === 'user' ? '' : PROFILE_DEFAULTS[name];
    const text = (name === 'soul' ? '---\nassistantName: "Claudia"\n---\n' : '') + body;
    assert.deepEqual(f.store.profiles()[name], { text, revision: digest(text), body });
    assert.doesNotMatch(f.read(`${name}.md`), /<!-- dsh-claudia/);
    if (name !== 'soul') assert.equal(f.read(`${name}.md`), body);
  }
  const todo = f.store.addTodo('保留待办元数据');
  const journal = f.store.addJournal('保留日记元数据');
  assert.match(f.read('todo.md'), /<!-- dsh-claudia todo/);
  assert.match(f.read('todo.md'), /<!-- dsh-record .*"type":"todo"/);
  assert.ok(f.read('todo.md').includes(todo.id));
  assert.match(f.read(`journal/${journal.id}.md`), /^---\nid:/);
  assert.match(f.read(`journal/${journal.id}.md`), /<!-- dsh-claudia journal/);
  assert.match(f.read('memory.md'), /<!-- dsh-claudia memory/);
  assert.match(f.read('settings.md'), /<!-- dsh-claudia settings/);
  unlinkSync(join(f.dir, 'soul.md'));
  f.store.set('assistantName', '显式新建名字');
  assert.equal(f.read('soul.md'), '---\nassistantName: "显式新建名字"\n---\n');
});

test('已有自定义 profile 在首次默认迁移、读取和重启时不被覆盖', t => {
  const files = Object.fromEntries(names.map(name => [`${name}.md`, (name === 'soul' ? soulPrefix : '') + legacyHeader(name) + '<!-- 用户说明 -->\n']));
  const f = fixture(t, files);
  const migrations = readdirSync(join(f.dir, 'migration'));
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const name of names) {
      const text = files[`${name}.md`];
      assert.deepEqual(f.store.profiles()[name], { text, revision: digest(text), body: '<!-- 用户说明 -->\n' });
      assert.equal(f.read(`${name}.md`), text);
    }
    assert.deepEqual(readdirSync(join(f.dir, 'migration')), migrations);
    f.restart();
  }
  for (const name of names) unlinkSync(join(f.dir, `${name}.md`));
  f.restart();
  for (const name of names) {
    assert.deepEqual(f.store.profiles()[name], { text: '', revision: null, body: '' });
    assert.equal(existsSync(join(f.dir, `${name}.md`)), false);
    const saved = f.store.saveProfileBody(name, '', null);
    assert.equal(saved.body, '');
    assert.doesNotMatch(saved.text, /<!-- dsh-claudia/);
    if (name === 'soul') assert.equal(f.store.get('assistantName'), 'Claudia');
    else assert.equal(saved.text, '');
  }
});

test('旧说明行只在开头隐藏，保存时移除；LF、CRLF、BOM 和正文原文保持', t => {
  const f = fixture(t);
  for (const newline of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) for (const name of names) {
    const prefix = bom + (name === 'soul' ? soulPrefix.replaceAll('\n', newline) : '');
    const header = legacyHeader(name).replaceAll('\n', newline);
    const body = `<!-- 用户注释 -->${newline}${newline}  正文 e\u0301  ${newline}${header}正文中的说明行也保留${newline}${newline}`;
    const original = prefix + header + body;
    f.write(`${name}.md`, original);
    const profile = f.store.profiles()[name];
    assert.deepEqual(profile, { text: original, revision: digest(original), body });
    assert.equal(f.read(`${name}.md`), original);
    const saved = f.store.saveProfileBody(name, profile.body, profile.revision);
    assert.deepEqual(saved, { text: prefix + body, revision: digest(prefix + body), body });
    assert.equal(f.read(`${name}.md`), prefix + body);
    assert.deepEqual(f.store.profiles()[name], saved);
    assert.deepEqual(f.store.saveProfileBody(name, saved.body, saved.revision), saved);
  }
});

test('任意用户注释、相似说明、空行后的旧说明和未闭合注释不被剥离', t => {
  const f = fixture(t);
  for (const name of names) {
    const prefix = name === 'soul' ? soulPrefix : '';
    const header = legacyHeader(name);
    for (const body of [
      '<!-- 用户自己的注释 -->\n正文\n',
      `<!-- dsh-claudia ${name} v1 用户自定义说明 -->\n正文`,
      header.trimEnd() + '同一行用户文字\n正文',
      header.replace('v1：', 'v2：') + '正文',
      '<!-- 尚未闭合的用户注释',
      '\n' + header + '正文',
      ' ' + header + '正文',
      '<!-- 用户说明 -->\n' + header + '正文',
    ]) {
      f.write(`${name}.md`, prefix + body);
      const before = f.store.profiles()[name];
      assert.equal(before.body, body);
      const saved = f.store.saveProfileBody(name, body, before.revision);
      assert.equal(saved.text, prefix + body);
      assert.equal(saved.revision, before.revision);
    }
    f.write(`${name}.md`, prefix + header.trimEnd());
    assert.equal(f.store.profiles()[name].body, '');
    const saved = f.store.saveProfileBody(name, '', f.store.profiles()[name].revision);
    assert.equal(saved.text, prefix);
    f.write(`${name}.md`, prefix + header + header + '第二行说明属于正文');
    const repeated = f.store.profiles()[name];
    assert.equal(repeated.body, header + '第二行说明属于正文');
    assert.equal(f.store.saveProfileBody(name, repeated.body, repeated.revision).text, prefix + repeated.body);
  }
});

test('soul 保存完整 frontmatter 的名字、自定义字段、注释、缩进和换行，不从正文改名', t => {
  const f = fixture(t);
  const prefix = '\uFEFF---\r\n# 用户 frontmatter 注释\r\nassistantName: \'小岚\'\r\ncustomField: "自定义"\r\npreferences:\r\n  - 保持缩进\r\ncustom-key: 其他字段\r\n\r\n---\r\n';
  f.write('soul.md', prefix + legacyHeader('soul').replaceAll('\n', '\r\n') + '旧正文');
  const body = '<!-- 正文注释 -->\r\n---\r\nassistantName: 正文不是元数据\r\n---\r\n  新正文  \r\n';
  const saved = f.store.saveProfileBody('soul', body, f.store.profiles().soul.revision);
  assert.equal(saved.text, prefix + body);
  assert.equal(saved.body, body);
  assert.equal(f.store.get('assistantName'), '小岚');
  f.restart();
  assert.deepEqual(f.store.profiles().soul, saved);
  assert.equal(f.read('soul.md'), prefix + body);
});

test('soul frontmatter 的结束边界可直接 EOF，显式追加正文才补同风格换行', t => {
  const f = fixture(t);
  for (const newline of ['\n', '\r\n']) {
    const prefix = '\uFEFF' + soulPrefix.replaceAll('\n', newline).slice(0, -newline.length);
    f.write('soul.md', prefix);
    assert.equal(f.store.profiles().soul.body, '');
    const empty = f.store.saveProfileBody('soul', '', digest(prefix));
    assert.equal(empty.text, prefix);
    const saved = f.store.saveProfileBody('soul', '正文', empty.revision);
    assert.equal(saved.text, prefix + newline + '正文');
    assert.equal(saved.body, '正文');
  }
});

test('user/system 不要求也不隐藏用户自写 frontmatter，空正文和空白按原文保存', t => {
  const f = fixture(t);
  for (const name of ['user', 'system']) for (const body of ['---\n任意字段: 无需解析\n---\n正文\n', '没有 frontmatter', '  \r\n\r\n', '']) {
    const saved = f.store.saveProfileBody(name, body, f.store.profiles()[name].revision);
    assert.deepEqual(saved, { text: body, revision: digest(body), body });
    assert.deepEqual(f.store.profiles()[name], saved);
  }
});

test('revision 校验全文件，包括隐藏说明和 soul 元数据；冲突不得覆盖或移除旧说明', t => {
  const f = fixture(t);
  for (const name of names) {
    const prefix = name === 'soul' ? soulPrefix : '';
    const original = prefix + legacyHeader(name) + '正文';
    f.write(`${name}.md`, original);
    const before = f.store.profiles()[name];
    for (const revision of [undefined, null, digest(before.body), '错误 revision']) {
      assert.throws(() => f.store.saveProfileBody(name, '不得覆盖', revision), isStatus(409));
      assert.equal(f.read(`${name}.md`), original);
    }
    const external = name === 'soul' ? original.replace('用户字段', '外部新字段') : prefix + '正文';
    f.write(`${name}.md`, external);
    assert.equal(f.store.profiles()[name].body, before.body);
    assert.throws(() => f.store.saveProfileBody(name, '不得覆盖', before.revision), isStatus(409));
    assert.equal(f.read(`${name}.md`), external);
  }
});

test('正文写入中途的外部变更仍返回 409 并清理临时锁', t => {
  const f = fixture(t), before = f.store.profiles().soul;
  const records = f.store.records, originalRead = records.read.bind(records);
  const external = before.text.replace('Claudia', '外部名字');
  let count = 0;
  records.read = name => {
    if (name === 'soul.md' && ++count === 3) f.write(name, external);
    return originalRead(name);
  };
  try { assert.throws(() => f.store.saveProfileBody('soul', '不得覆盖', before.revision), isStatus(409)); }
  finally { records.read = originalRead; }
  assert.equal(f.read('soul.md'), external);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
  assert.equal(readdirSync(f.dir).some(name => name.startsWith('.record-')), false);
});

test('正文预算包含保存后的 frontmatter 与 BOM，继续拒绝无效 Unicode、名字及文件链接', t => {
  const f = fixture(t), before = f.store.profiles().soul;
  for (const body of [null, true, 1, {}, [], '\ud800', '字'.repeat(MAX_PROFILE_CHARS)]) {
    assert.throws(() => f.store.saveProfileBody('soul', body, before.revision), isStatus(400));
    assert.equal(f.read('soul.md'), before.text);
  }
  assert.throws(() => f.store.saveProfileBody('user', 'x'.repeat(MAX_RECORD_BYTES + 1), f.store.profiles().user.revision), isStatus(413));
  for (const name of ['../user', 'user.md', 'settings', 'USER']) assert.throws(() => f.store.saveProfileBody(name, '', null), isStatus(400));
  const prefix = '---\nassistantName: "Claudia"\n---\n';
  const fullBody = '字'.repeat(MAX_PROFILE_CHARS - prefix.length);
  const full = f.store.saveProfileBody('soul', fullBody, before.revision);
  assert.equal(full.text.length, MAX_PROFILE_CHARS);
  assert.deepEqual(full, { text: prefix + fullBody, revision: digest(prefix + fullBody), body: fullBody });
  f.write('user.md', '\uFEFF');
  assert.throws(() => f.store.saveProfileBody('user', '字'.repeat(MAX_PROFILE_CHARS), digest('\uFEFF')), isStatus(400));
  assert.equal(f.store.saveProfileBody('user', '字'.repeat(MAX_PROFILE_CHARS - 1), digest('\uFEFF')).text.length, MAX_PROFILE_CHARS);
  const outside = join(f.dir, 'outside.md');
  f.write('outside.md', '不能覆盖的链接目标');
  unlinkSync(join(f.dir, 'system.md'));
  symlinkSync(outside, join(f.dir, 'system.md'));
  assert.throws(() => f.store.saveProfileBody('system', '不得写入', null), isStatus(400));
  assert.equal(f.read('outside.md'), '不能覆盖的链接目标');
});

test('正文接口不能修复或覆盖 soul 非法 frontmatter 和非法名字', t => {
  const f = fixture(t);
  for (const text of ['', '无 frontmatter', '---\nother: x\n---\n', '---\nassistantName: 甲\nassistantName: 乙\n---\n', '---\nassistantName: "非法\\n名字"\n---\n']) {
    f.write('soul.md', text);
    assert.throws(() => f.store.saveProfileBody('soul', soulPrefix + '不得伪造 frontmatter', digest(text)), isStatus(400));
    assert.equal(f.read('soul.md'), text);
  }
});

test('旧 saveProfile 原样保存完整 text，返回结构不变，runtime 使用的 text 不受 body 投影影响', t => {
  const f = fixture(t);
  for (const name of names) {
    const text = (name === 'soul' ? soulPrefix : '') + legacyHeader(name) + '<!-- 原文注释 -->\n正文\n';
    const saved = f.store.saveProfile(name, text, f.store.profiles()[name].revision);
    assert.deepEqual(saved, { text, revision: digest(text) });
    assert.equal(f.read(`${name}.md`), text);
    assert.equal(f.store.profiles()[name].text, text);
    assert.equal(f.store.profiles()[name].body, '<!-- 原文注释 -->\n正文\n');
  }
});

// 仅导入 server/store，使用临时数据目录和 runtime 替身，不加载 Harness 或用户目录。
async function apiFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-profile-body-api-'));
  let app, token;
  const controls = { busy: false };
  t.after(async () => { try { await app?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  app = await startServer({
    dataDir: dir, home: join(dir, 'synthetic-home'), port: 0,
    createRuntime: store => ({
      selection: () => ({ provider: 'synthetic', model: 'synthetic' }),
      status: async () => ({ configured: true }),
      profiles: () => Object.fromEntries(names.map(name => [name, store.profiles()[name].text])),
      close: async () => {},
    }),
    createServices: () => ({ maintenance: { status: () => ({ running: controls.busy }), close: async () => {} } }),
  });
  function request(path, data, headers = {}) {
    const method = data === undefined ? 'GET' : 'POST';
    const requestHeaders = { connection: 'close', ...(method === 'POST' ? { 'content-type': 'application/json', 'x-claudia-token': token } : {}), ...headers };
    for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
    return new Promise((resolve, reject) => {
      const client = httpRequest(new URL(path, app.url), { method, headers: requestHeaders, agent: false }, response => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { raw += chunk; });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('测试响应被中断')));
        response.on('end', () => {
          try { resolve({ status: response.statusCode, data: JSON.parse(raw) }); }
          catch (error) { reject(error); }
        });
      });
      client.on('error', reject);
      client.setTimeout(5000, () => client.destroy(new Error('测试请求超时')));
      client.end(data === undefined ? undefined : JSON.stringify(data));
    });
  }
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  token = bootstrap.data.csrfToken;
  return { app, controls, request, read: name => readFileSync(join(dir, name), 'utf8') };
}

test('HTTP body/text 接口均工作：state 新增 body、旧 text 返回格式及 runtime 原文保持兼容', { timeout: 15000 }, async t => {
  const f = await apiFixture(t);
  for (const name of names) {
    const prefix = name === 'soul' ? soulPrefix : '';
    const text = prefix + legacyHeader(name) + '旧正文';
    const old = await f.request(`/api/profiles/${name}`, { text, revision: f.app.store.profiles()[name].revision });
    assert.equal(old.status, 200);
    assert.deepEqual(old.data, { text, revision: digest(text) });
    assert.equal(f.app.runtime.profiles()[name], text);
    const state = await f.request('/api/state');
    assert.equal(state.status, 200);
    assert.deepEqual(state.data.profiles[name], { ...old.data, body: '旧正文' });
    const body = '<!-- 用户注释 -->\n  正文原样  \n';
    const saved = await f.request(`/api/profiles/${name}`, { body, revision: old.data.revision });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data, { text: prefix + body, revision: digest(prefix + body), body });
    assert.equal(f.read(`${name}.md`), prefix + body);
    assert.equal(f.app.runtime.profiles()[name], prefix + body);
    for (const revision of [undefined, null, old.data.revision]) assert.equal((await f.request(`/api/profiles/${name}`, { body: '冲突内容', revision })).status, 409);
    assert.equal(f.read(`${name}.md`), prefix + body);
    assert.equal((await f.request(`/api/profiles/${name}`, { body: '', revision: saved.data.revision })).status, 200);
    assert.equal(f.read(`${name}.md`), prefix);
  }
});

test('HTTP body/text 互斥，保留 CSRF、Origin、Host、busy、长度和 Unicode 校验', { timeout: 15000 }, async t => {
  const f = await apiFixture(t), before = f.app.store.profiles();
  for (const body of [{ body: '', text: '' }, { body: null, text: '' }, { body: '', text: null }, { body: '甲', text: '乙' }]) {
    assert.equal((await f.request('/api/profiles/user', { ...body, revision: before.user.revision })).status, 400);
  }
  for (const headers of [
    { 'x-claudia-token': undefined }, { 'x-claudia-token': 'invalid' },
    { 'content-type': 'text/plain' }, { origin: 'https://invalid.example' },
    { host: 'invalid.example' }, { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal((await f.request('/api/profiles/user', { body: '不得覆盖', revision: before.user.revision }, headers)).status, 403);
  for (const name of ['settings', 'user.md', '..%2Fsoul', 'USER']) assert.equal((await f.request(`/api/profiles/${name}`, { body: '', revision: null })).status, 400);
  for (const body of [undefined, null, {}, [], 1, true, '\ud800', '字'.repeat(MAX_PROFILE_CHARS + 1)]) assert.equal((await f.request('/api/profiles/user', { body, revision: before.user.revision })).status, 400);
  assert.equal((await f.request('/api/profiles/soul', { body: '字'.repeat(MAX_PROFILE_CHARS), revision: before.soul.revision })).status, 400);
  assert.equal((await f.request('/api/profiles/user', { body: 'x'.repeat(65536), revision: before.user.revision })).status, 413);
  f.controls.busy = true;
  assert.equal((await f.request('/api/profiles/user', { body: '', revision: before.user.revision })).status, 409);
  assert.equal((await f.request('/api/profiles/user', { body: '', text: '', revision: before.user.revision })).status, 400);
  f.controls.busy = false;
  assert.deepEqual(f.app.store.profiles(), before);
  const full = await f.request('/api/profiles/user', { body: '字'.repeat(MAX_PROFILE_CHARS), revision: before.user.revision });
  assert.equal(full.status, 200);
  assert.equal(full.data.text.length, MAX_PROFILE_CHARS);
});
