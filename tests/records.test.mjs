import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync,
  mkdirSync, unlinkSync, symlinkSync, linkSync, truncateSync, existsSync, renameSync,
} from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, makeContext } from '../store.mjs';
import { BOOLEAN_SETTINGS, MAX_RECORD_BYTES, MAX_PROFILE_CHARS, PROFILE_DEFAULTS } from '../records.mjs';

const date = '2026-09-15T10:00:00.000Z';
const later = '2026-09-16T10:00:00.000Z';
const digest = text => createHash('sha256').update(text).digest('hex');
const isStatus = status => error => error.status === status;
function fixture(t, boot = true) {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-records-'));
  const file = join(dir, 'store.sqlite');
  const stores = new Set();
  const f = {
    dir, file,
    read(name) { return readFileSync(join(dir, name), 'utf8'); },
    write(name, text) { writeFileSync(join(dir, name), text, { mode: 0o600 }); },
    open() { const store = new Store(file); stores.add(store); return store; },
    close(store = f.store) { store.close(); stores.delete(store); },
    restart() { f.close(); f.store = f.open(); return f.store; },
  };
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  if (boot) f.store = f.open();
  return f;
}
const storeURL = new URL('../store.mjs', import.meta.url).href;
function crashStore(f, code) {
  f.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { Store } from ${JSON.stringify(storeURL)}; const store = new Store(${JSON.stringify(f.file)}); ${code}`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 73, child.stderr);
  assert.doesNotMatch(child.stdout, /虚假成功/);
  return child;
}
function archives(f) { return readdirSync(join(f.dir, 'migration')).filter(name => name.endsWith('.md')).map(name => f.read(`migration/${name}`)); }
function failMessageCommit(store) {
  // 延迟外键由 SQLite 引擎在真实 COMMIT 时检查，不用 mock 抛错冒充提交失败。
  store.db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE commit_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE commit_guard (parentId INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_update_commit AFTER UPDATE ON messages WHEN NEW.content='提交必失败'
      BEGIN INSERT INTO commit_guard VALUES (1); END;
    CREATE TRIGGER fail_insert_commit AFTER INSERT ON messages WHEN NEW.content='提交必失败'
      BEGIN INSERT INTO commit_guard VALUES (1); END;`);
}
// 使用独立旧 schema，避免以新版 Store 创建的数据冒充迁移测试。
function seedLegacy(f) {
  const db = new DatabaseSync(f.file);
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE journal (id TEXT PRIMARY KEY,text TEXT NOT NULL,occurredAt TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE memories (id TEXT PRIMARY KEY,text TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,createdAt TEXT NOT NULL,status TEXT NOT NULL);`);
  const journal = { id: randomUUID(), text: '旧 SQLite 日记\n保留原文与空行\n\n', occurredAt: date, createdAt: later };
  const memory = { id: randomUUID(), text: '旧记忆\n第二行', createdAt: date };
  const session = randomUUID(), previousSession = randomUUID();
  const messages = [
    { id: randomUUID(), sessionId: previousSession, role: 'user', content: '旧会话原文\n<原文>', createdAt: date, status: 'complete' },
    { id: randomUUID(), sessionId: session, role: 'assistant', content: '未完成的回答\n', createdAt: later, status: 'pending' },
  ];
  db.prepare('INSERT INTO journal VALUES (?,?,?,?)').run(journal.id, journal.text, journal.occurredAt, journal.createdAt);
  db.prepare('INSERT INTO memories VALUES (?,?,?)').run(memory.id, memory.text, memory.createdAt);
  for (const entry of messages) db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(entry.id, entry.sessionId, entry.role, entry.content, entry.createdAt, entry.status);
  for (const [key, value] of Object.entries({ sessionId: session, assistantName: '旧昵称', allowContext: true, activityEnabled: true, runtimeCursor: { position: 7 }, apiKey: 'SYNTHETIC_SECRET_DO_NOT_EXPORT' })) db.prepare('INSERT INTO settings VALUES (?,?)').run(key, JSON.stringify(value));
  db.close();
  return { journal, memory, session, previousSession, messages };
}

test('初始化固定 MD 与私有权限，配置默认不共享上下文', t => {
  const f = fixture(t);
  for (const name of ['todo.md', 'memory.md', 'soul.md', 'user.md', 'system.md', 'settings.md']) {
    if (['soul.md', 'user.md', 'system.md'].includes(name)) assert.doesNotMatch(f.read(name), /<!-- dsh-claudia/);
    else assert.match(f.read(name), /<!-- dsh-claudia/);
    assert.equal(statSync(join(f.dir, name)).mode & 0o777, 0o600);
  }
  for (const name of ['', 'journal', 'reflections', 'conversations', 'migration']) assert.equal(statSync(join(f.dir, name)).mode & 0o777, 0o700);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  for (const suffix of ['-wal', '-shm']) if (existsSync(f.file + suffix)) assert.equal(statSync(f.file + suffix).mode & 0o777, 0o600);
  assert.equal(f.store.get('assistantName'), 'Claudia');
  for (const name of ['soul', 'user', 'system']) {
    const body = name === 'user' ? '' : PROFILE_DEFAULTS[name];
    const text = (name === 'soul' ? '---\nassistantName: "Claudia"\n---\n' : '') + body;
    assert.deepEqual(f.store.profiles()[name], { text, revision: digest(text), body });
    assert.equal(f.read(`${name}.md`), text);
  }
  for (const key of BOOLEAN_SETTINGS) assert.equal(f.store.get(key), false);
  assert.equal(f.store.get('unknown', 'fallback'), 'fallback');
});

test('Journal 稳定 UUID、Unicode/多行/换行原文、外部编辑与重启', t => {
  const f = fixture(t);
  const text = '  汉字 e\u0301 ' + String.fromCodePoint(0x20000) + '\r\n\n# 标题\n---\n<!-- 元数据样例 -->\n末尾空白  \n\n';
  const entry = f.store.addJournal(text, date);
  const name = `journal/${entry.id}.md`;
  assert.equal(f.store.journal()[0].text, text);
  assert.ok(f.read(name).endsWith(text));
  f.write(name, f.read(name).replace(text, '外部修订\n\n原文'));
  assert.equal(f.store.journal()[0].text, '外部修订\n\n原文');
  assert.equal(f.store.journal()[0].id, entry.id);
  f.restart();
  assert.equal(f.store.journal()[0].text, '外部修订\n\n原文');
  assert.equal(f.store.deleteJournal(entry.id), true);
  assert.equal(f.store.deleteJournal(entry.id), false);
  f.restart();
  assert.deepEqual(f.store.journal(), []);
});

test('todo checkbox 状态、原文和外部备注保持，旧 revision 返回 409', t => {
  const f = fixture(t), store = f.store;
  const text = '  第一项\n- [x] 这是正文，不是第二条记录\n\n结尾  \n';
  const entry = store.addTodo(text);
  const other = store.addTodo('其他项目');
  assert.equal(store.todos().length, 2);
  assert.equal(store.todos()[0].text, text);
  assert.throws(() => store.updateTodo(entry.id, 'done', entry.revision), isStatus(409));
  f.write('todo.md', '手写前言\n' + f.read('todo.md').replace('第一项', '外部改名') + '\n手写后记\n');
  const before = f.read('todo.md');
  const done = store.updateTodo(entry.id, 'done');
  assert.equal(done.status, 'done');
  assert.equal(store.todos().find(item => item.id === entry.id).updatedAt, done.updatedAt);
  assert.equal(f.read('todo.md'), before.replace('- [ ]   外部改名', '- [x]   外部改名').replace(`"updatedAt":"${entry.updatedAt}"`, `"updatedAt":"${done.updatedAt}"`));
  assert.equal(store.updateTodo(entry.id, 'dismissed', done.revision).status, 'dismissed');
  assert.match(f.read('todo.md'), /- \[-\]   外部改名/);
  assert.throws(() => store.updateTodo(entry.id, 'deleted'), isStatus(400));
  assert.throws(() => store.updateTodo(randomUUID(), 'todo'), isStatus(404));
  f.restart();
  assert.equal(f.store.todos().find(item => item.id === entry.id).status, 'dismissed');
  assert.equal(f.store.todos().find(item => item.id === other.id).text, '其他项目');
  f.write('todo.md', f.read('todo.md').replace('- [-]', '- [ ]'));
  assert.equal(f.store.todos()[0].status, 'todo');
});

test('确认记忆从 MD 同步回读，增删不重写外部正文', t => {
  const f = fixture(t);
  const entry = f.store.addMemory('  喜欢茶\n\n保留缩进  \n');
  f.write('memory.md', '外部前言\n' + f.read('memory.md').replace('喜欢茶', '喜欢水') + '外部尾注\n');
  const before = f.read('memory.md');
  assert.equal(f.store.memories()[0].text, '  喜欢水\n\n保留缩进  \n');
  const other = f.store.addMemory('独立记忆');
  assert.ok(f.read('memory.md').startsWith(before));
  assert.equal(f.store.deleteMemory(entry.id), true);
  assert.equal(f.store.deleteMemory(entry.id), false);
  assert.match(f.read('memory.md'), /外部前言/);
  assert.match(f.read('memory.md'), /外部尾注/);
  f.restart();
  assert.deepEqual(f.store.memories(), [other]);
});

test('profiles 返回完整文档与 SHA-256，显式 revision 防止覆盖外部编辑', t => {
  const f = fixture(t);
  for (const name of ['user', 'system', 'soul']) {
    const previous = f.store.profiles()[name];
    assert.equal(previous.revision, digest(previous.text));
    const external = previous.text + '\n外部编辑\n';
    f.write(`${name}.md`, external);
    const read = f.store.profiles()[name];
    assert.deepEqual(read, { text: external, revision: digest(external), body: (name === 'user' ? '' : PROFILE_DEFAULTS[name]) + '\n外部编辑\n' });
    assert.throws(() => f.store.saveProfile(name, previous.text, previous.revision), isStatus(409));
    assert.throws(() => f.store.saveProfile(name, previous.text), isStatus(409));
    const text = external + '追加 Unicode：你好\n\n';
    assert.deepEqual(f.store.saveProfile(name, text, read.revision), { text, revision: digest(text) });
    assert.equal(f.read(`${name}.md`), text);
  }
  f.restart();
  assert.match(f.store.profiles().system.text, /追加 Unicode/);
  assert.throws(() => f.store.saveProfile('../settings', 'x', null), isStatus(400));
});

test('soul frontmatter 是昵称唯一权威；set 只修改昵称行', t => {
  const f = fixture(t);
  const text = '---\r\nassistantName: 小岚\r\ncustomField: 保留\r\n---\r\n# 人设\r\n正文 assistantName: 不是权威\r\n';
  const old = f.store.profiles().soul;
  f.store.saveProfile('soul', text, old.revision);
  assert.equal(f.store.get('assistantName'), '小岚');
  f.store.set('assistantName', '新名字');
  assert.equal(f.read('soul.md'), text.replace('assistantName: 小岚', 'assistantName: "新名字"'));
  f.write('soul.md', f.read('soul.md').replace('"新名字"', "'外部名字'"));
  assert.equal(f.store.get('assistantName'), '外部名字');
  f.store.db.prepare('INSERT INTO settings VALUES (?,?)').run('assistantName', '"不应成为权威"');
  assert.equal(f.store.get('assistantName'), '外部名字');
  f.restart();
  assert.equal(f.store.get('assistantName'), '外部名字');
  assert.equal(f.store.db.prepare('SELECT value FROM settings WHERE key=?').get('assistantName'), undefined);
});

test('昵称 UTF-16 长度、控制字符、重复和缺失 frontmatter 均验证', t => {
  const f = fixture(t);
  const astral = String.fromCodePoint(0x20000);
  f.store.set('assistantName', astral.repeat(20));
  assert.equal(f.store.get('assistantName').length, 40);
  const invalid = [astral.repeat(21), '字'.repeat(41), 'a\nb', 'a\u0000b', 'a\u0085b', 'a\u2028b', 'a\u202eb', 'a\u2069b', 'a\u200bb', 123, null];
  for (const value of invalid) assert.throws(() => f.store.set('assistantName', value), isStatus(400));
  const previous = f.store.profiles().soul;
  for (const text of ['无 frontmatter', '---\nother: x\n---\n', '---\nassistantName: a\nassistantName: b\n---\n', '---\nassistantName: "a\\nb"\n---\n']) assert.throws(() => f.store.saveProfile('soul', text, previous.revision), isStatus(400));
  assert.equal(f.store.profiles().soul.text, previous.text);
  f.store.set('assistantName', '   ');
  assert.equal(f.store.get('assistantName'), 'Claudia');
});

test('bool 设置同步回读并保留外部文字，runtime 元数据留 SQLite', t => {
  const f = fixture(t);
  f.write('settings.md', f.read('settings.md') + '\n外部说明\n');
  for (const key of BOOLEAN_SETTINGS) {
    f.store.set(key, true);
    assert.equal(f.store.get(key), true);
    for (const value of ['true', 1, null, {}]) assert.throws(() => f.store.set(key, value), isStatus(400));
  }
  assert.match(f.read('settings.md'), /外部说明/);
  f.write('settings.md', f.read('settings.md').replace('allowContext: true', 'allowContext: false'));
  assert.equal(f.store.get('allowContext'), false);
  f.store.set('runtimeCursor', { offset: 8 });
  assert.doesNotMatch(f.read('settings.md'), /runtimeCursor/);
  f.restart();
  assert.deepEqual(f.store.get('runtimeCursor'), { offset: 8 });
  assert.equal(f.store.get('reflectionEnabled'), true);
  f.write('settings.md', f.read('settings.md').replace('allowContext: false', 'allowContext: "true"'));
  assert.throws(() => f.store.get('allowContext'), isStatus(400));
});

test('reflection 创建、显式 revision 更新、外部编辑及重启不丢原文', t => {
  const f = fixture(t);
  const value = { id: '2026-09-15', text: '\n反思原文\n---\n多行  \n', start: date, end: later };
  const entry = f.store.saveReflection(value);
  assert.equal(entry.text, value.text);
  assert.match(entry.revision, /^[a-f0-9]{64}$/);
  assert.throws(() => f.store.saveReflection(value), isStatus(409));
  assert.throws(() => f.store.saveReflection(value, null), isStatus(409));
  const name = `reflections/${digest(value.id)}.md`;
  f.write(name, f.read(name).replace('反思原文', '外部反思'));
  assert.throws(() => f.store.saveReflection(value, entry.revision), isStatus(409));
  const current = f.store.reflections()[0];
  const saved = f.store.saveReflection({ ...value, text: current.text + '\n补充' }, current.revision);
  assert.equal(saved.createdAt, entry.createdAt);
  f.restart();
  assert.deepEqual(f.store.reflections(), [saved]);
  assert.throws(() => f.store.saveReflection({ ...value, id: '../escape' }), isStatus(400));
  assert.throws(() => f.store.saveReflection({ ...value, id: 'other', start: later, end: date }), isStatus(400));
});

test('记忆候选接受原文转 confirmed，拒绝保留状态，重复决定幂等', t => {
  const f = fixture(t);
  const source = { id: '来源 --> 不得关闭元数据注释', kind: 'reflection' };
  const text = '  候选原文\n\n- [ ] 正文\n';
  const [accept, reject] = f.store.addMemoryCandidates([{ text, source }, { text: '拒绝这条\n保留记录', source: '手写来源' }]);
  assert.equal(f.store.memories().length, 0);
  assert.deepEqual(f.store.memoryCandidates()[0].source, source);
  f.write('memory.md', f.read('memory.md').replace('候选原文', '外部修改的候选原文'));
  const accepted = f.store.decideCandidate(accept.id, true);
  assert.equal(accepted.status, 'accepted');
  assert.equal(f.store.memories()[0].text, text.replace('候选原文', '外部修改的候选原文'));
  assert.equal(f.store.memories()[0].id, accepted.memoryId);
  assert.deepEqual(f.store.decideCandidate(accept.id, true), accepted);
  assert.equal(f.store.memories().length, 1);
  assert.equal(f.store.decideCandidate(reject.id, false).status, 'rejected');
  assert.throws(() => f.store.decideCandidate(reject.id, true), isStatus(409));
  assert.throws(() => f.store.decideCandidate(randomUUID(), true), isStatus(404));
  f.restart();
  assert.deepEqual(f.store.memoryCandidates().map(item => item.status), ['accepted', 'rejected']);
  assert.equal(f.store.memoryCandidates()[1].text, '拒绝这条\n保留记录');
  assert.equal(f.store.memories().length, 1);
});

test('0.2.1 SQLite 首次完整迁移，保留全部 session 副本及 runtime 元数据', t => {
  const f = fixture(t, false), old = seedLegacy(f);
  f.store = f.open();
  assert.deepEqual(f.store.journal(), [old.journal]);
  assert.deepEqual(f.store.memories(), [old.memory]);
  assert.equal(f.store.get('assistantName'), '旧昵称');
  assert.equal(f.store.get('allowContext'), true);
  assert.deepEqual(f.store.get('runtimeCursor'), { position: 7 });
  assert.equal(f.store.get('sessionId'), old.session);
  for (const entry of old.messages) assert.ok(f.read(`conversations/${entry.sessionId}.md`).includes(entry.content));
  assert.equal(f.store.messages()[0].status, 'interrupted');
  assert.match(f.read(`conversations/${old.session}.md`), /"status":"interrupted"/);
  for (const name of ['soul.md', 'settings.md', 'memory.md']) assert.doesNotMatch(f.read(name), /SYNTHETIC_SECRET|apiKey/);
  f.store.deleteJournal(old.journal.id);
  f.store.deleteMemory(old.memory.id);
  f.restart();
  assert.deepEqual(f.store.journal(), []);
  assert.deepEqual(f.store.memories(), []);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM journal').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM record_migrations').get().n, 2);
  assert.deepEqual(f.store.db.prepare('SELECT version FROM record_migrations ORDER BY version').all().map(row => row.version), ['markdown-v1', 'profile-defaults-v1']);
});

test('迁移保留用户业务 MD，会话冲突原文与旧业务内容另存 migration', t => {
  const f = fixture(t, false), old = seedLegacy(f);
  mkdirSync(join(f.dir, 'journal'), { mode: 0o700 });
  mkdirSync(join(f.dir, 'conversations'), { mode: 0o700 });
  const files = {
    'soul.md': '---\nassistantName: 用户昵称\n---\n用户人设\n',
    'memory.md': '# 用户手写记忆\n此文件不可被覆盖\n',
    'settings.md': '---\nallowContext: false\n---\n用户配置说明\n',
    [`journal/${old.journal.id}.md`]: `---\nid: "${old.journal.id}"\noccurredAt: "${date}"\ncreatedAt: "${later}"\n---\n用户修订日记\n`,
    [`conversations/${old.previousSession}.md`]: '# 用户整理过的旧会话\n',
  };
  for (const [name, text] of Object.entries(files)) f.write(name, text);
  f.store = f.open();
  for (const [name, text] of Object.entries(files)) {
    if (name.startsWith('conversations/')) {
      assert.ok(readdirSync(join(f.dir, 'migration')).some(backup => f.read(`migration/${backup}`) === text));
      assert.ok(f.read(name).includes(old.messages[0].content));
    } else assert.equal(f.read(name), text);
  }
  assert.equal(f.store.journal()[0].text, '用户修订日记\n');
  assert.equal(f.store.get('assistantName'), '用户昵称');
  assert.equal(f.store.get('allowContext'), false);
  const backups = readdirSync(join(f.dir, 'migration')).map(name => f.read(`migration/${name}`)).join('\n');
  for (const text of [old.journal.text, old.memory.text, old.messages[0].content, '旧昵称']) assert.ok(backups.includes(text));
  assert.doesNotMatch(backups, /SYNTHETIC_SECRET|apiKey/);
  const names = readdirSync(join(f.dir, 'migration'));
  f.restart();
  assert.deepEqual(readdirSync(join(f.dir, 'migration')), names);
  for (const [name, text] of Object.entries(files)) {
    if (name.startsWith('conversations/')) {
      assert.ok(readdirSync(join(f.dir, 'migration')).some(backup => f.read(`migration/${backup}`) === text));
      assert.ok(f.read(name).includes(old.messages[0].content));
    } else assert.equal(f.read(name), text);
  }
});

test('手动删除已有 MD 后重启不从 SQLite 或默认值自动复活', t => {
  const f = fixture(t);
  f.store.addMemory('随后删除');
  unlinkSync(join(f.dir, 'memory.md'));
  unlinkSync(join(f.dir, 'user.md'));
  f.restart();
  assert.deepEqual(f.store.memories(), []);
  assert.deepEqual(f.store.profiles().user, { text: '', revision: null, body: '' });
  assert.equal(existsSync(join(f.dir, 'memory.md')), false);
  assert.equal(existsSync(join(f.dir, 'user.md')), false);
  assert.deepEqual(f.store.saveProfile('user', '用户显式重新创建', null), { text: '用户显式重新创建', revision: digest('用户显式重新创建') });
});

test('多个 Store 同步读取同一 MD，无关外部改动在追加时保留', t => {
  const f = fixture(t), second = f.open();
  const a = f.store.addTodo('实例一');
  const b = second.addTodo('实例二');
  assert.deepEqual(f.store.todos().map(item => item.id), [a.id, b.id]);
  assert.deepEqual(second.todos(), f.store.todos());
  const before = second.profiles().user;
  f.store.saveProfile('user', '实例一修改', before.revision);
  assert.throws(() => second.saveProfile('user', '过时内容', before.revision), isStatus(409));
  assert.equal(second.profiles().user.text, '实例一修改');
});

test('会话全量原文副本、更新状态与 reset 保留历史', t => {
  const f = fixture(t);
  const session = f.store.get('sessionId');
  const userText = '问题原文\n\n' + String.fromCodePoint(0x20000) + '\n';
  const user = f.store.addMessage('user', userText);
  const assistant = f.store.addMessage('assistant', '初始片段\n', 'pending');
  const name = `conversations/${session}.md`;
  assert.ok(f.read(name).includes(userText));
  assert.ok(f.read(name).includes(user.id));
  f.write(name, '# 外部会话备注\n' + f.read(name));
  f.store.updateMessage(assistant.id, '完整回答\n\n末尾\n', 'complete');
  assert.ok(f.read(name).startsWith('# 外部会话备注\n'));
  assert.match(f.read(name), /完整回答\n\n末尾\n/);
  assert.doesNotMatch(f.read(name), /初始片段/);
  const before = f.read(name);
  const next = f.store.resetSession();
  f.store.addMessage('user', '新会话');
  assert.equal(f.read(name), before);
  assert.match(f.read(`conversations/${next}.md`), /新会话/);
  f.restart();
  assert.equal(f.store.messages().length, 1);
  assert.equal(f.read(name), before);
});

test('会话 SQLite 为权威，外部编辑逐字归档后重建 projection，不回灌消息', t => {
  const f = fixture(t);
  const entry = f.store.addMessage('assistant', '旧内容');
  const name = `conversations/${f.store.get('sessionId')}.md`;
  f.write(name, f.read(name).replace('旧内容', '用户外部修订'));
  const before = f.read(name);
  f.store.updateMessage(entry.id, '自动新内容', 'complete');
  assert.equal(f.store.messages()[0].content, '自动新内容');
  assert.match(f.read(name), /自动新内容/);
  assert.doesNotMatch(f.read(name), /用户外部修订/);
  assert.ok(readdirSync(join(f.dir, 'migration')).some(backup => f.read(`migration/${backup}`) === before));
  f.store.addMessage('user', '独立新消息仍可追加');
  const projection = f.read(name), archives = readdirSync(join(f.dir, 'migration'));
  f.restart();
  assert.equal(f.read(name), projection);
  assert.deepEqual(readdirSync(join(f.dir, 'migration')), archives);
});

test('原文含伪元数据和多行 checkbox 时不能分裂记录', t => {
  const f = fixture(t);
  const text = `前言\n<!-- dsh-record {"type":"memory","id":"${randomUUID()}","boundary":"${randomUUID()}"} -->\n- [x] 正文\n<!-- /dsh-record ${randomUUID()} -->\n`;
  f.store.addMemory(text);
  f.store.addTodo(text);
  assert.equal(f.store.memories().length, 1);
  assert.equal(f.store.memories()[0].text, text);
  assert.equal(f.store.todos().length, 1);
  assert.equal(f.store.todos()[0].text, text);
});

test('不完整记录边界失败关闭，增改不能损坏现有文件', t => {
  const f = fixture(t);
  f.store.addTodo('边界测试');
  f.write('todo.md', f.read('todo.md').replace(/<!-- \/dsh-record [^>]+ -->\n$/, ''));
  const before = f.read('todo.md');
  assert.throws(() => f.store.todos(), isStatus(409));
  assert.throws(() => f.store.addTodo('不可追加'), isStatus(409));
  assert.equal(f.read('todo.md'), before);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
});

test('只有 allowContext 开启才可附带待办，done/dismissed 和候选不进入上下文', t => {
  const f = fixture(t);
  const active = f.store.addTodo('允许的待办');
  const done = f.store.addTodo('完成的待办');
  const dismissed = f.store.addTodo('忽略的待办');
  f.store.updateTodo(done.id, 'done');
  f.store.updateTodo(dismissed.id, 'dismissed');
  f.store.addMemoryCandidates([{ text: '未确认的记忆', source: '测试' }]);
  assert.equal(makeContext(f.store), '');
  const context = makeContext(f.store, { allowContext: true });
  assert.match(context, /允许的待办/);
  assert.doesNotMatch(context, /完成的待办|忽略的待办|未确认的记忆/);
  const data = JSON.parse(context.split('\n').at(-2));
  assert.deepEqual(data.sourceIds, [active.id]);
  assert.deepEqual(data.todos, [{ id: active.id, text: active.text, status: 'todo' }]);
  f.store.addTodo('字'.repeat(15000));
  assert.ok(makeContext(f.store, { allowContext: true }).length <= 14000);
});

test('拒绝文件 symlink 与硬链接，不能读取或写入目录外目标', t => {
  const f = fixture(t);
  const target = join(f.dir, 'outside.txt');
  writeFileSync(target, '外部目标保持原样');
  for (const name of ['todo.md', 'memory.md', 'soul.md', 'settings.md']) {
    const path = join(f.dir, name), original = f.read(name);
    unlinkSync(path);
    symlinkSync(target, path);
    const read = { 'todo.md': () => f.store.todos(), 'memory.md': () => f.store.memories(), 'soul.md': () => f.store.profiles(), 'settings.md': () => f.store.get('allowContext') }[name];
    assert.throws(read, /链接/);
    assert.throws(() => f.store.records.edit(name, () => '不得写入'), /链接/);
    assert.equal(readFileSync(target, 'utf8'), '外部目标保持原样');
    unlinkSync(path);
    writeFileSync(path, original);
  }
  unlinkSync(join(f.dir, 'todo.md'));
  linkSync(target, join(f.dir, 'todo.md'));
  assert.throws(() => f.store.todos(), /链接/);
});

test('拒绝目录、journal、reflection、会话、SQLite sidecar 的 symlink', t => {
  const f = fixture(t);
  const outside = join(f.dir, 'outside');
  mkdirSync(outside);
  const journal = f.store.addJournal('原日记', date);
  const path = join(f.dir, 'journal', `${journal.id}.md`);
  const target = join(outside, 'target.md');
  writeFileSync(target, '目录外原文');
  unlinkSync(path);
  symlinkSync(target, path);
  assert.throws(() => f.store.journal(), /链接/);
  assert.throws(() => f.store.deleteJournal(journal.id), /链接/);
  unlinkSync(path);
  rmSync(join(f.dir, 'journal'), { recursive: true });
  symlinkSync(outside, join(f.dir, 'journal'));
  assert.throws(() => f.store.addJournal('不得写入', date), /链接/);
  const reflection = 'external';
  symlinkSync(target, join(f.dir, 'reflections', `${digest(reflection)}.md`));
  assert.throws(() => f.store.saveReflection({ id: reflection, text: '不得写入', start: date, end: later }), /链接/);
  symlinkSync(target, join(f.dir, 'conversations', `${f.store.get('sessionId')}.md`));
  assert.throws(() => f.store.addMessage('user', '不得写入'), /链接/);
  assert.equal(f.store.messages().length, 0);
  assert.equal(readFileSync(target, 'utf8'), '目录外原文');
  const rootLink = join(outside, 'root-link');
  symlinkSync(outside, rootLink);
  assert.throws(() => new Store(join(rootLink, 'store.sqlite')), /链接/);
  const safeRoot = join(outside, 'safe');
  mkdirSync(safeRoot);
  symlinkSync(target, join(safeRoot, 'store.sqlite-wal'));
  assert.throws(() => new Store(join(safeRoot, 'store.sqlite')), /链接/);
});

test('文件尺寸限制有界读取与写入，失败不覆盖文件且清理写锁', t => {
  const f = fixture(t);
  const previous = f.store.profiles().user;
  assert.throws(() => f.store.saveProfile('user', 'a'.repeat(MAX_RECORD_BYTES + 1), previous.revision), isStatus(413));
  assert.equal(f.read('user.md'), previous.text);
  truncateSync(join(f.dir, 'user.md'), MAX_RECORD_BYTES + 1);
  assert.throws(() => f.store.profiles(), isStatus(413));
  assert.throws(() => f.store.saveProfile('user', '不能截断大文件', previous.revision), isStatus(413));
  assert.equal(statSync(join(f.dir, 'user.md')).size, MAX_RECORD_BYTES + 1);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
  assert.equal(readdirSync(f.dir).some(name => name.startsWith('.record-')), false);
});

test('固定文件名与非法 ID 不能用于路径穿越', t => {
  const f = fixture(t);
  for (const id of ['../escape', '/tmp/escape', 'journal/../soul', 'a\\b', '']) {
    assert.throws(() => f.store.deleteJournal(id), isStatus(400));
    assert.throws(() => f.store.deleteMemory(id), isStatus(400));
    assert.throws(() => f.store.updateTodo(id, 'done'), isStatus(400));
    assert.throws(() => f.store.saveReflection({ id, text: '', start: date, end: later }), isStatus(400));
  }
  assert.throws(() => f.store.records.read('../store.sqlite'), isStatus(400));
  assert.throws(() => f.store.records.files('../outside'), isStatus(400));
  const original = f.read('soul.md');
  assert.throws(() => f.store.saveProfile('soul.md', '破坏', null), isStatus(400));
  assert.equal(f.read('soul.md'), original);
});

test('外部写锁显式 409，不覆盖、不自行删除锁', t => {
  const f = fixture(t);
  const lock = join(f.dir, '.records.lock');
  writeFileSync(lock, '外部进程持有锁');
  const before = f.read('memory.md');
  assert.throws(() => f.store.addMemory('不可写入'), isStatus(409));
  assert.equal(f.read('memory.md'), before);
  assert.equal(readFileSync(lock, 'utf8'), '外部进程持有锁');
});

test('空正文、尾部 CR/LF、BOM 与组合 Unicode 不得被规范化', t => {
  const f = fixture(t);
  for (const text of ['', '\r', '\n', '\r\n', '\uFEFF开头\n结尾\r', 'e\u0301\n\u0000\n  ']) {
    const journal = f.store.addJournal(text, date);
    const memory = f.store.addMemory(text);
    const todo = f.store.addTodo(text);
    assert.equal(f.store.journal().find(item => item.id === journal.id).text, text);
    assert.equal(f.store.memories().find(item => item.id === memory.id).text, text);
    assert.equal(f.store.todos().find(item => item.id === todo.id).text, text);
  }
  assert.throws(() => f.store.addMemory('\ud800'), isStatus(400));
  assert.throws(() => f.store.set('assistantName', '\ud800'), isStatus(400));
});

test('reflection 修改正文保留外部 frontmatter 字段和注释', t => {
  const f = fixture(t);
  const initial = f.store.saveReflection({ id: 'custom-meta', text: '正文', start: date, end: later });
  const name = `reflections/${digest(initial.id)}.md`;
  const external = f.read(name).replace('---\n', '---\ncustomField: 用户原文\n# 元数据备注\n');
  f.write(name, external);
  const current = f.store.reflections()[0];
  f.store.saveReflection({ ...current, text: '新正文' }, current.revision);
  assert.equal(f.read(name), external.replace(/正文$/, '新正文'));
});

test('临时文件写好后发生外部编辑仍返回 409，保留外部文件并清理临时文件', t => {
  const f = fixture(t);
  const previous = f.store.profiles().user;
  const records = f.store.records, originalRead = records.read.bind(records);
  let count = 0;
  records.read = name => {
    if (name === 'user.md' && ++count === 3) f.write(name, '写入中途的外部编辑\n');
    return originalRead(name);
  };
  assert.throws(() => f.store.saveProfile('user', '不应覆盖', previous.revision), isStatus(409));
  records.read = originalRead;
  assert.equal(f.read('user.md'), '写入中途的外部编辑\n');
  assert.equal(readdirSync(f.dir).some(name => name.startsWith('.record-')), false);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
});

test('不合法 UTF-8 文件拒绝解码，不用替换字符覆盖原始字节', t => {
  const f = fixture(t);
  const bytes = Buffer.from([0xff, 0xfe, 0x80]);
  writeFileSync(join(f.dir, 'user.md'), bytes);
  assert.throws(() => f.store.profiles(), isStatus(400));
  assert.throws(() => f.store.saveProfile('user', '不得覆盖', null), isStatus(400));
  assert.deepEqual(readFileSync(join(f.dir, 'user.md')), bytes);
});

test('Todo 跨日完成保存 updatedAt，旧格式回退 createdAt，重复状态不改时间', t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: new Date(date) });
  const entry = f.store.addTodo('昨日创建今日完成');
  assert.equal(entry.updatedAt, date);
  f.write('todo.md', f.read('todo.md').replace(`,"updatedAt":"${date}"`, ''));
  const legacy = f.read('todo.md');
  assert.equal(f.store.todos()[0].updatedAt, date);
  assert.equal(f.read('todo.md'), legacy);
  t.mock.timers.setTime(new Date(later).getTime());
  const done = f.store.updateTodo(entry.id, 'done');
  assert.equal(done.createdAt, date);
  assert.equal(done.updatedAt, later);
  assert.match(f.read('todo.md'), new RegExp(`"updatedAt":"${later}"`));
  f.restart();
  assert.deepEqual(f.store.todos(), [done]);
  const nextDay = new Date(later).getTime() + 86400000;
  t.mock.timers.setTime(nextDay);
  const unchanged = f.store.updateTodo(entry.id, 'done', done.revision);
  assert.deepEqual(unchanged, done);
  const reopened = f.store.updateTodo(entry.id, 'todo');
  assert.equal(reopened.updatedAt, new Date(nextDay).toISOString());
  t.mock.timers.setTime(nextDay + 1000);
  const dismissed = f.store.updateTodo(entry.id, 'dismissed');
  assert.equal(dismissed.updatedAt, new Date(nextDay + 1000).toISOString());
  assert.equal(f.store.todos()[0].updatedAt, dismissed.updatedAt);
});

test('外部 soul 及所有设定按 server 的 12000 UTF-16 预算明确校验，文件原文保留', t => {
  const f = fixture(t);
  assert.equal(MAX_PROFILE_CHARS, 12000);
  for (const name of ['soul', 'user', 'system']) {
    const old = f.store.profiles()[name];
    const text = old.text + '字'.repeat(MAX_PROFILE_CHARS - old.text.length);
    const saved = f.store.saveProfile(name, text, old.revision);
    assert.equal(f.store.profiles()[name].text.length, 12000);
    const over = text + '多';
    assert.throws(() => f.store.saveProfile(name, over, saved.revision), error => error.status === 400 && error.message.includes(`${name}.md`) && /12000/.test(error.message));
    f.write(`${name}.md`, over);
    for (const read of [() => f.store.profiles(), () => makeContext(f.store)]) assert.throws(read, error => error.status === 400 && /12000/.test(error.message));
    if (name === 'soul') {
      assert.throws(() => f.store.get('assistantName'), /soul\.md.*12000/);
      assert.throws(() => f.store.set('assistantName', '更长名字'), /12000/);
    }
    assert.equal(f.read(`${name}.md`), over);
    f.store.saveProfile(name, old.text, digest(over));
  }
  const profile = f.store.profiles().soul;
  const astral = String.fromCodePoint(0x20000);
  const full = profile.text + '字'.repeat((12000 - profile.text.length) % 2) + astral.repeat(Math.floor((12000 - profile.text.length) / 2));
  f.store.saveProfile('soul', full, profile.revision);
  assert.equal(full.length, 12000);
  assert.throws(() => f.store.set('assistantName', '名字'.repeat(20)), /12000/);
  assert.equal(f.read('soul.md'), full);
});

for (const operation of ['add', 'update']) test(`真实 SQLite COMMIT 失败：${operation} 不写 MD、不返回成功并可重启`, t => {
  const f = fixture(t), entry = f.store.addMessage('assistant', '已提交原文', 'pending');
  const name = `conversations/${f.store.get('sessionId')}.md`, before = f.read(name);
  failMessageCommit(f.store);
  const exec = f.store.db.exec.bind(f.store.db);
  let commitFailure;
  t.mock.method(f.store.db, 'exec', sql => {
    try { return exec(sql); }
    catch (error) { if (sql === 'COMMIT') commitFailure = error; throw error; }
  });
  const action = operation === 'add' ? () => f.store.addMessage('user', '提交必失败') : () => f.store.updateMessage(entry.id, '提交必失败', 'complete');
  assert.throws(action, /FOREIGN KEY constraint failed/);
  assert.ok(commitFailure);
  assert.equal(commitFailure.code, 'ERR_SQLITE_ERROR');
  assert.equal(f.store.messages().length, 1);
  assert.equal(f.store.messages()[0].content, '已提交原文');
  assert.equal(f.store.messages()[0].status, 'pending');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM commit_guard').get().n, 0);
  assert.equal(f.read(name), before);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
  f.restart();
  assert.equal(f.store.messages()[0].status, 'interrupted');
  assert.match(f.read(name), /已提交原文/);
});

test('旧版 MD 已写后真实 COMMIT 失败：重启保留两份内容，不再永久 409', t => {
  const f = fixture(t), entry = f.store.addMessage('assistant', 'SQLite 旧片段', 'pending');
  const sessionId = f.store.get('sessionId'), name = `conversations/${sessionId}.md`;
  failMessageCommit(f.store);
  f.store.db.exec('BEGIN IMMEDIATE');
  f.store.db.prepare('UPDATE messages SET content=?,status=? WHERE id=?').run('提交必失败', 'complete', entry.id);
  f.store.records.updateMessage(sessionId, entry, { ...entry, content: '提交必失败', status: 'complete' });
  const divergent = f.read(name);
  assert.throws(() => f.store.db.exec('COMMIT'), /FOREIGN KEY constraint failed/);
  f.store.db.exec('ROLLBACK');
  assert.equal(f.store.messages()[0].content, 'SQLite 旧片段');
  f.restart();
  assert.equal(f.store.messages()[0].status, 'interrupted');
  assert.equal(f.store.messages()[0].content, 'SQLite 旧片段');
  assert.ok(archives(f).includes(divergent));
  assert.match(f.read(name), /SQLite 旧片段/);
  assert.doesNotMatch(f.read(name), /提交必失败/);
  const projection = f.read(name), backups = archives(f);
  f.restart();
  assert.equal(f.read(name), projection);
  assert.deepEqual(archives(f), backups);
});

test('旧版 MD 已写但事务未提交的真实退出窗口：恢复 pending 和死亡进程锁', t => {
  const f = fixture(t), sessionId = f.store.get('sessionId');
  const name = `conversations/${sessionId}.md`;
  crashStore(f, `
    const entry = store.addMessage('assistant', 'SQLite 已提交片段', 'pending');
    const originalWrite = store.records.write.bind(store.records);
    store.records.write = (name, ...args) => { const result = originalWrite(name, ...args); if (name.startsWith('conversations/')) process.exit(73); return result; };
    store.db.exec('BEGIN IMMEDIATE');
    store.db.prepare('UPDATE messages SET content=?,status=? WHERE id=?').run('崩溃时 MD 中的完整回答', 'complete', entry.id);
    store.records.updateMessage(store.get('sessionId'), entry, { ...entry, content: '崩溃时 MD 中的完整回答', status: 'complete' });
    console.log('虚假成功');
  `);
  const divergent = f.read(name), lock = f.read('.records.lock');
  assert.match(divergent, /崩溃时 MD 中的完整回答/);
  f.store = f.open();
  assert.equal(f.store.messages()[0].content, 'SQLite 已提交片段');
  assert.equal(f.store.messages()[0].status, 'interrupted');
  assert.ok(archives(f).includes(divergent));
  assert.match(f.read(name), /SQLite 已提交片段/);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
  const orphans = readdirSync(join(f.dir, 'migration')).filter(name => name.endsWith('.orphan'));
  assert.equal(orphans.length, 1);
  assert.equal(f.read(`migration/${orphans[0]}`), lock);
});

test('旧版新增消息 MD 已写但未提交：孤立副本归档，不向 SQLite 回灌幽灵消息', t => {
  const f = fixture(t), name = `conversations/${f.store.get('sessionId')}.md`;
  crashStore(f, `
    const entry = { id: '11111111-1111-4111-8111-111111111111', role: 'user', content: '未提交的孤立消息', createdAt: new Date().toISOString(), status: 'complete' };
    store.db.exec('BEGIN IMMEDIATE');
    store.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(entry.id, store.get('sessionId'), entry.role, entry.content, entry.createdAt, entry.status);
    store.records.addMessage(store.get('sessionId'), entry);
    process.exit(73);
  `);
  const divergent = f.read(name);
  f.store = f.open();
  assert.deepEqual(f.store.messages(), []);
  assert.ok(archives(f).includes(divergent));
  assert.doesNotMatch(f.read(name), /未提交的孤立消息/);
});

for (const window of ['before-commit', 'before-projection', 'after-projection']) test(`新协议真实退出窗口 ${window}：按 SQLite 恢复，保全已有 MD`, t => {
  const f = fixture(t), entry = f.store.addMessage('assistant', '原先完整回答');
  const name = `conversations/${f.store.get('sessionId')}.md`, before = f.read(name);
  crashStore(f, `
    if (${JSON.stringify(window)} === 'before-commit') {
      const exec = store.db.exec.bind(store.db);
      store.db.exec = sql => { if (sql === 'COMMIT') process.exit(73); return exec(sql); };
    } else {
      const prepare = store.records.prepareConversation.bind(store.records);
      store.records.prepareConversation = (...args) => { const project = prepare(...args); return () => {
        if (${JSON.stringify(window)} === 'before-projection') process.exit(73);
        project(); process.exit(73);
      }; };
    }
    store.updateMessage(${JSON.stringify(entry.id)}, '新提交完整回答', 'complete');
    console.log('虚假成功');
  `);
  const crashed = f.read(name);
  f.store = f.open();
  const expected = window === 'before-commit' ? '原先完整回答' : '新提交完整回答';
  assert.equal(f.store.messages()[0].content, expected);
  assert.ok(f.read(name).includes(expected));
  if (window === 'before-projection') { assert.equal(crashed, before); assert.ok(archives(f).includes(before)); }
  if (window === 'after-projection') assert.equal(f.read(name), crashed);
  if (window === 'before-commit') assert.equal(f.read(name), before);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
});

test('提交后副本写失败明确报告 committed，不伪造成功；外部再编辑后仍保全并恢复', t => {
  const f = fixture(t), entry = f.store.addMessage('assistant', '旧回复');
  const name = `conversations/${f.store.get('sessionId')}.md`;
  const write = f.store.records.write.bind(f.store.records);
  const mocked = t.mock.method(f.store.records, 'write', (file, ...args) => {
    if (file === name) throw Object.assign(new Error('磁盘写入失败'), { code: 'ENOSPC' });
    return write(file, ...args);
  });
  assert.throws(() => f.store.updateMessage(entry.id, 'SQLite 新回复', 'complete'), error => error.committed === true && error.status === 500 && /已提交.*副本同步失败/.test(error.message));
  assert.equal(f.store.messages()[0].content, 'SQLite 新回复');
  assert.match(f.read(name), /旧回复/);
  mocked.mock.restore();
  f.write(name, f.read(name).replace('旧回复', '用户在失败后补充的回复'));
  const external = f.read(name);
  f.restart();
  assert.equal(f.store.messages()[0].content, 'SQLite 新回复');
  assert.ok(archives(f).includes(external));
  assert.match(f.read(name), /SQLite 新回复/);
});

test('启动修复非 pending 会话的损坏边界，保留冲突原文并重建全部历史', t => {
  const f = fixture(t), entry = f.store.addMessage('assistant', '完整历史');
  const name = `conversations/${f.store.get('sessionId')}.md`;
  f.store.resetSession();
  const external = f.read(name).replace(/<!-- \/dsh-record [^>]+ -->\n$/, '') + '\n用户未完成的手写内容';
  f.write(name, external);
  f.restart();
  assert.ok(archives(f).includes(external));
  assert.match(f.read(name), /完整历史/);
  assert.ok(f.read(name).includes(entry.id));
  assert.deepEqual(f.store.messages(), []);
});

test('冲突归档期间外部再次修改：报错而不覆盖新编辑，重启保全两次原文', t => {
  const f = fixture(t), entry = f.store.addMessage('assistant', 'SQLite 原文');
  const name = `conversations/${f.store.get('sessionId')}.md`;
  f.write(name, f.read(name).replace('SQLite 原文', '第一次外部编辑'));
  const first = f.read(name), second = first.replace('第一次外部编辑', '归档期间第二次外部编辑');
  const write = f.store.records.write.bind(f.store.records);
  const mocked = t.mock.method(f.store.records, 'write', (file, ...args) => {
    const result = write(file, ...args);
    if (file.startsWith('migration/')) f.write(name, second);
    return result;
  });
  assert.throws(() => f.store.updateMessage(entry.id, 'SQLite 已提交新原文', 'complete'), error => error.status === 409 && error.committed === true);
  mocked.mock.restore();
  assert.equal(f.read(name), second);
  assert.ok(archives(f).includes(first));
  f.restart();
  assert.ok(archives(f).includes(first));
  assert.ok(archives(f).includes(second));
  assert.match(f.read(name), /SQLite 已提交新原文/);
});

test('应用锁包含 PID、唯一 owner token 和开始时间，同 PID 按 token 判断且不误删', t => {
  const f = fixture(t), tokens = [];
  f.store.records.locked(() => {
    const owner = JSON.parse(f.read('.records.lock'));
    tokens.push(owner.ownerToken);
    assert.equal(owner.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
    assert.match(owner.ownerToken, /^[a-f0-9-]{36}$/);
    assert.equal(statSync(join(f.dir, '.records.lock')).mode & 0o777, 0o600);
    assert.throws(() => f.store.addMemory('重入不得写'), /当前进程正在写入/);
    const changed = { ...owner, ownerToken: randomUUID() };
    f.write('.records.lock', JSON.stringify(changed));
    assert.throws(() => f.store.addMemory('不同 token 不得写'), /owner token 不匹配/);
  });
  assert.equal(existsSync(join(f.dir, '.records.lock')), true);
  assert.throws(() => f.store.addMemory('伪装本 PID 不得恢复'), /owner token 不匹配/);
  unlinkSync(join(f.dir, '.records.lock'));
  f.store.records.locked(() => tokens.push(JSON.parse(f.read('.records.lock')).ownerToken));
  assert.notEqual(tokens[0], tokens[1]);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
});

test('真实存活进程的锁无论年龄均 409，进程退出后才恢复并保留 orphan', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(storeURL)};
    const store = new Store(${JSON.stringify(f.file)});
    store.records.locked(() => { process.send('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(result => { throw new Error(`测试子进程提前退出：${result}`); })]);
  assert.equal(ready[0], 'locked');
  const owner = JSON.parse(f.read('.records.lock'));
  owner.startedAt = '2000-01-01T00:00:00.000Z';
  f.write('.records.lock', JSON.stringify(owner));
  const before = f.read('.records.lock');
  assert.equal(owner.pid, child.pid);
  assert.throws(() => f.store.addMemory('存活时不能偷锁'), /进程仍存活/);
  assert.equal(f.read('.records.lock'), before);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  f.store.addMemory('确认进程死亡后恢复');
  const orphans = readdirSync(join(f.dir, 'migration')).filter(name => name.endsWith('.orphan'));
  assert.equal(orphans.length, 1);
  assert.equal(f.read(`migration/${orphans[0]}`), before);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
  assert.equal(statSync(join(f.dir, 'migration', orphans[0])).mode & 0o777, 0o600);
});

test('EPERM 不能视为 PID 不存在，保留写锁和原数据', t => {
  const f = fixture(t);
  crashStore(f, `store.records.locked(() => process.exit(73));`);
  const lock = f.read('.records.lock'), owner = JSON.parse(lock);
  const killed = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, owner.pid);
    assert.equal(signal, 0);
    throw Object.assign(new Error('没有探测权限'), { code: 'EPERM' });
  });
  assert.throws(() => f.open(), error => error.status === 409 && /无法确认.*退出/.test(error.message));
  assert.equal(f.read('.records.lock'), lock);
  assert.equal(readdirSync(join(f.dir, 'migration')).length, 0);
  killed.mock.restore();
  f.store = f.open();
});

for (const change of ['inode', 'hash']) test(`恢复前 ${change} 改变时拒绝移动死亡进程锁`, t => {
  const f = fixture(t);
  crashStore(f, `store.records.locked(() => process.exit(73));`);
  const lock = join(f.dir, '.records.lock'), before = f.read('.records.lock'), original = statSync(lock);
  const owner = JSON.parse(before);
  const killed = t.mock.method(process, 'kill', () => {
    if (change === 'inode') { renameSync(lock, join(f.dir, 'previous.lock')); f.write('.records.lock', before); }
    else f.write('.records.lock', JSON.stringify({ ...owner, ownerToken: randomUUID() }));
    throw Object.assign(new Error('进程已经退出'), { code: 'ESRCH' });
  });
  assert.throws(() => f.open(), error => error.status === 409 && /替换或修改/.test(error.message));
  killed.mock.restore();
  assert.equal(readdirSync(join(f.dir, 'migration')).length, 0);
  if (change === 'inode') {
    assert.notEqual(statSync(lock).ino, original.ino);
    assert.equal(f.read('.records.lock'), before);
  } else {
    assert.equal(statSync(lock).ino, original.ino);
    assert.notEqual(f.read('.records.lock'), before);
  }
  f.store = f.open();
});

test('最终 move 窗口替换锁时核对移动结果，只恢复原路径空位并保全 orphan', t => {
  const f = fixture(t);
  crashStore(f, `store.records.locked(() => process.exit(73));`);
  const lock = join(f.store.records.root, '.records.lock'), before = f.read('.records.lock');
  const replacement = JSON.stringify({ ...JSON.parse(before), pid: process.pid, ownerToken: randomUUID() });
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (source, target) => {
    if (source === lock) {
      rename(lock, join(f.dir, 'previous.lock'));
      f.write('.records.lock', replacement);
    }
    return rename(source, target);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => f.open(), error => error.status === 409 && /移动期间发生变化/.test(error.message)); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(f.read('.records.lock'), replacement);
  assert.equal(f.read('previous.lock'), before);
  const orphans = readdirSync(join(f.dir, 'migration')).filter(name => name.endsWith('.orphan'));
  assert.equal(orphans.length, 1);
  assert.equal(f.read(`migration/${orphans[0]}`), replacement);
});

test('空锁、残缺 owner 和未知旧锁绝不自动删除或按年龄恢复', t => {
  const f = fixture(t), lock = join(f.dir, '.records.lock');
  for (const text of ['', '{}', JSON.stringify({ pid: 2147483647, startedAt: date }), '外部旧锁']) {
    f.write('.records.lock', text);
    assert.throws(() => f.store.addTodo('不得写入'), error => error.status === 409 && /未知或空.*人工检查/.test(error.message));
    assert.equal(f.read('.records.lock'), text);
    assert.equal(readdirSync(join(f.dir, 'migration')).length, 0);
    unlinkSync(lock);
  }
});

test('锁完整 owner 原子发布后、删除临时链接前崩溃，也可精确恢复', t => {
  const f = fixture(t);
  crashStore(f, `
    const fs = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const unlink = fs.default.unlinkSync;
    fs.default.unlinkSync = path => { if (String(path).includes('.record-') && fs.existsSync(store.records.root + '/.records.lock')) process.exit(73); return unlink(path); };
    syncBuiltinESMExports();
    store.records.locked(() => console.log('虚假成功'));
  `);
  const lock = f.read('.records.lock'), owner = JSON.parse(lock);
  assert.equal(statSync(join(f.dir, '.records.lock')).nlink, 2);
  assert.equal(f.read(`.record-${owner.ownerToken}.tmp`), lock);
  f.store = f.open();
  const orphans = readdirSync(join(f.dir, 'migration')).filter(name => name.endsWith('.orphan'));
  assert.equal(orphans.length, 1);
  assert.equal(f.read(`migration/${orphans[0]}`), lock);
  f.store.addTodo('锁发布崩溃后可继续写入');
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
});

test('消息双写仍拒绝无效 Unicode，不允许 SQLite 先替换原文再返回成功', t => {
  const f = fixture(t), entry = f.store.addMessage('assistant', '有效原文');
  for (const content of ['\ud800', 123, null]) {
    assert.throws(() => f.store.addMessage('user', content), isStatus(400));
    assert.throws(() => f.store.updateMessage(entry.id, content, 'complete'), isStatus(400));
  }
  assert.deepEqual(f.store.messages().map(item => item.content), ['有效原文']);
});

test('Todo 状态更新保留未知元数据中的美元替换字符及原边界', t => {
  const f = fixture(t), entry = f.store.addTodo('原文');
  const custom = '保留 $& $1 $$ $`';
  f.write('todo.md', f.read('todo.md').replace('"type":"todo"', () => '"type":"todo","custom":' + JSON.stringify(custom)));
  const before = /<!-- dsh-record (.+) -->/.exec(f.read('todo.md'));
  f.store.updateTodo(entry.id, 'done');
  const meta = JSON.parse(/<!-- dsh-record (.+) -->/.exec(f.read('todo.md'))[1]);
  assert.equal(meta.custom, custom);
  assert.equal(meta.boundary, JSON.parse(before[1]).boundary);
  assert.equal(f.store.todos()[0].text, '原文');
});

test('冲突副本归档后、projection 替换前真实退出，重启幂等续写且不丢任何原文', t => {
  const f = fixture(t), entry = f.store.addMessage('assistant', 'SQLite 旧原文');
  const name = `conversations/${f.store.get('sessionId')}.md`;
  crashStore(f, `
    const { writeFileSync, readFileSync } = await import('node:fs');
    const path = store.records.root + '/' + ${JSON.stringify(name)};
    writeFileSync(path, readFileSync(path, 'utf8').replace('SQLite 旧原文', '用户外部原文'));
    const write = store.records.write.bind(store.records);
    store.records.write = (file, ...args) => { const result = write(file, ...args); if (file.startsWith('migration/')) process.exit(73); return result; };
    store.updateMessage(${JSON.stringify(entry.id)}, 'SQLite 已提交新原文', 'complete');
    console.log('虚假成功');
  `);
  const external = f.read(name), before = archives(f);
  assert.match(external, /用户外部原文/);
  assert.ok(before.includes(external));
  f.store = f.open();
  assert.deepEqual(archives(f), before);
  assert.equal(f.store.messages()[0].content, 'SQLite 已提交新原文');
  assert.match(f.read(name), /SQLite 已提交新原文/);
});

test('Store 关闭后 Markdown 接口不能继续读写', t => {
  const f = fixture(t);
  const store = f.store;
  f.close();
  for (const action of [() => store.get('sessionId'), () => store.get('assistantName'), () => store.journal(), () => store.addMemory('不应写入'), () => store.profiles()]) assert.throws(action, /closed|not open/i);
});
