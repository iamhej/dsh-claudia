import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Records } from '../records.mjs';
import { Store } from '../store.mjs';
import { DEFAULT_ROUTINE } from '../routine-schema.mjs';

const first = '2026-09-18T01:00:00.000Z';
const second = '2026-09-19T02:00:00.000Z';
const digest = text => createHash('sha256').update(text).digest('hex');
const isStatus = status => error => error.status === status;
const fields = ({ name, prompt, schedule, allowNetwork, delivery, enabled }) => ({ name, prompt, schedule, allowNetwork, delivery, enabled });
const input = (patch = {}) => ({ name: '本地回顾', prompt: '整理本机已完成的对话，列出需要继续处理的事项。', schedule: { type: 'daily', time: '11:00' }, allowNetwork: false, delivery: 'today', enabled: false, ...patch });
const run = (patch = {}) => ({ id: randomUUID(), jobId: randomUUID(), windowKey: 'daily:2026-09-18', status: 'running', startedAt: first, jobName: '本地回顾', sourceIds: ['来源一'], snapshot: { allowNetwork: false }, ...patch });

function fixture(t, boot = false) {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-routine-records-'));
  const file = join(dir, 'store.sqlite'), stores = new Set();
  const f = {
    dir, file, records: new Records(dir),
    read: () => readFileSync(join(dir, 'routines.md'), 'utf8'),
    write: text => writeFileSync(join(dir, 'routines.md'), text, { mode: 0o600 }),
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
function rewriteMeta(text, patch) {
  return text.replace(/^<!-- dsh-record (.+) -->/m, (_, raw) => `<!-- dsh-record ${JSON.stringify({ ...JSON.parse(raw), ...patch })} -->`);
}
function rawBlock(text, id) {
  const match = [...text.matchAll(/^<!-- dsh-record (.+) -->\n/gm)].find(match => JSON.parse(match[1]).id === id);
  assert.ok(match);
  const ending = `<!-- /dsh-record ${JSON.parse(match[1]).boundary} -->\n`;
  return text.slice(match.index, text.indexOf(ending, match.index) + ending.length);
}

test('空文件读取 revision，创建与删除必须显式提供 revision', t => {
  const f = fixture(t), records = f.records;
  assert.deepEqual(records.routines(), { jobs: [], revision: null });
  for (const revision of [undefined, '', '错误摘要', '0'.repeat(64)]) {
    assert.throws(() => records.saveRoutine(input(), revision), isStatus(409));
    assert.throws(() => records.deleteRoutine(randomUUID(), revision), isStatus(409));
  }
  assert.equal(records.deleteRoutine(randomUUID(), null), false);
  assert.equal(existsSync(join(f.dir, 'routines.md')), false);
  const job = records.saveRoutine(input(), null, null, new Date(first));
  assert.match(job.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...job, revision: undefined }, { id: job.id, ...input(), createdAt: first, updatedAt: first, enabledAt: null, version: 1, revision: undefined });
  assert.equal(job.revision, digest(f.read()));
  assert.equal(statSync(join(f.dir, 'routines.md')).mode & 0o777, 0o600);
  assert.throws(() => records.saveRoutine(input(), null), isStatus(409));
});

test('多行 prompt 仅在正文保存，伪记录边界及 Unicode 不分裂任务', t => {
  const f = fixture(t);
  const prompt = `  提示 e\u0301\r\n\n<!-- dsh-record {"type":"routine","id":"${randomUUID()}","boundary":"${randomUUID()}"} -->\n正文\n<!-- /dsh-record ${randomUUID()} -->\n末尾  \n\n`;
  const saved = f.records.saveRoutine(input({ prompt, name: '名称 --> 保持注释安全' }), null, null, new Date(first));
  const metadata = JSON.parse(/^<!-- dsh-record (.+) -->/m.exec(f.read())[1]);
  assert.equal(Object.hasOwn(metadata, 'prompt'), false);
  assert.equal(metadata.type, 'routine');
  assert.equal(metadata.name, saved.name);
  assert.deepEqual(f.records.routines(), { jobs: [{ ...fields(saved), id: saved.id, createdAt: first, updatedAt: first, enabledAt: null, version: 1 }], revision: saved.revision });
  assert.equal(f.records.routines().jobs[0].prompt, prompt);
});

test('同文件不同任务的变更、无操作更新、外部备注都受完整 revision 保护', t => {
  const f = fixture(t), records = f.records;
  const a = records.saveRoutine(input(), null, null, new Date(first));
  const b = records.saveRoutine(input({ name: '第二项' }), a.revision, null, new Date(first));
  for (const revision of [undefined, null, a.revision]) {
    assert.throws(() => records.saveRoutine(input(), revision, a.id), isStatus(409));
    assert.throws(() => records.deleteRoutine(a.id, revision), isStatus(409));
  }
  f.write('手写前言\n' + f.read() + '\n手写后记\n');
  const external = f.read();
  assert.throws(() => records.saveRoutine(input({ name: '第三项' }), b.revision), isStatus(409));
  assert.throws(() => records.saveRoutine(input({ prompt: '不应覆盖' }), b.revision, a.id), isStatus(409));
  assert.throws(() => records.deleteRoutine(b.id, b.revision), isStatus(409));
  assert.throws(() => records.deleteRoutine(randomUUID(), b.revision), isStatus(409));
  assert.equal(f.read(), external);
  const fresh = records.routines();
  assert.equal(fresh.revision, digest(external));
  const other = new Records(f.dir);
  other.saveRoutine(input({ name: '第二实例修改' }), fresh.revision, a.id);
  assert.throws(() => records.deleteRoutine(b.id, fresh.revision), isStatus(409));
});

test('逐字段实质修改递增 version 并重新锚定，完全相同保存不改文件或时间', t => {
  const f = fixture(t), records = f.records;
  let value = input({ enabled: true });
  let saved = records.saveRoutine(value, null, null, new Date(first));
  assert.equal(saved.enabledAt, first);
  let tick = Date.parse(first);
  for (const patch of [
    { name: '新名字' }, { prompt: '新提示词' },
    { schedule: { type: 'weekly', time: '09:00', days: [0, 1, 3, 5] } },
    { schedule: { type: 'interval', hours: 6 } },
    { allowNetwork: true }, { delivery: 'both' }, { enabled: false },
    { prompt: '停用时也可以修改' }, { enabled: true },
    { schedule: { type: 'daily', time: '11:00' } },
  ]) {
    value = { ...value, ...patch };
    const previous = saved, now = new Date(tick += 3600000);
    saved = records.saveRoutine(value, saved.revision, saved.id, now);
    assert.equal(saved.version, previous.version + 1);
    assert.equal(saved.createdAt, first);
    assert.equal(saved.updatedAt, now.toISOString());
    assert.equal(saved.enabledAt, value.enabled ? now.toISOString() : null);
    assert.deepEqual(fields(saved), value);
    const original = f.read();
    const noChange = records.saveRoutine({ ...value, schedule: Object.fromEntries(Object.entries(value.schedule).reverse()) }, saved.revision, saved.id, new Date(second));
    assert.deepEqual(noChange, saved);
    assert.equal(f.read(), original);
  }
});

test('更新必须替换全部六字段，不允许字段缺失或非法类型', t => {
  const f = fixture(t), saved = f.records.saveRoutine(input(), null);
  const original = f.read();
  for (const key of Object.keys(input())) {
    const partial = input();
    delete partial[key];
    assert.throws(() => f.records.saveRoutine(partial, saved.revision, saved.id), isStatus(400), key);
  }
  const invalid = [null, [], {}, input({ unknown: true }), input({ name: '' }), input({ prompt: '' }), input({ name: 1 }), input({ prompt: '\ud800' }), input({ allowNetwork: 'false' }), input({ enabled: 1 }), input({ delivery: 'chat' })];
  for (const value of invalid) assert.throws(() => f.records.saveRoutine(value, saved.revision, saved.id), isStatus(400));
  for (const id of ['../escape', '', 123]) {
    assert.throws(() => f.records.saveRoutine(input(), saved.revision, id), isStatus(400));
    assert.throws(() => f.records.deleteRoutine(id, saved.revision), isStatus(400));
  }
  assert.throws(() => f.records.saveRoutine(input(), saved.revision, randomUUID()), isStatus(404));
  for (const now of [new Date(NaN), first, null]) assert.throws(() => f.records.saveRoutine(input(), saved.revision, saved.id, now), isStatus(400));
  assert.equal(f.read(), original);
});

test('调度严格校验 daily、weekly、interval，非法请求不写文件', t => {
  const f = fixture(t);
  for (const schedule of [
    null, {}, { type: 'monthly', time: '11:00' },
    { type: 'daily', time: '24:00' }, { type: 'daily', time: '9:00' }, { type: 'daily', time: '11:60' }, { type: 'daily', time: '11:00', hours: 6 },
    { type: 'weekly', time: '09:00', days: [] }, { type: 'weekly', time: '09:00', days: [1, 1] },
    { type: 'weekly', time: '09:00', days: [-1, 7] }, { type: 'weekly', time: '09:00', days: ['1'] },
    { type: 'interval', hours: 0 }, { type: 'interval', hours: -1 }, { type: 'interval', hours: 1.5 }, { type: 'interval', hours: '6' }, { type: 'interval', hours: Infinity },
  ]) assert.throws(() => f.records.saveRoutine(input({ schedule }), null), isStatus(400), JSON.stringify(schedule));
  assert.deepEqual(f.records.routines(), { jobs: [], revision: null });
});

test('外部正文和元数据立即读取，缺失字段、非法日期、版本和启用锚点读取失败', t => {
  const f = fixture(t), saved = f.records.saveRoutine(input({ enabled: true }), null, null, new Date(first));
  const original = f.read();
  f.write(rewriteMeta(original.replace(saved.prompt, '外部编辑的完整提示词'), { name: '外部名字', schedule: { type: 'interval', hours: 6 } }));
  assert.deepEqual(fields(f.records.routines().jobs[0]), input({ enabled: true, name: '外部名字', prompt: '外部编辑的完整提示词', schedule: { type: 'interval', hours: 6 } }));
  for (const patch of [
    { name: undefined }, { allowNetwork: 'false' }, { delivery: 'unknown' }, { enabled: 'true' },
    { schedule: { type: 'daily', time: '99:99' } }, { id: 'not-uuid' },
    { createdAt: null }, { updatedAt: undefined }, { createdAt: '2026-02-30T01:00:00.000Z' },
    { updatedAt: '2026-09-18' }, { updatedAt: '2026-09-18T25:00:00.000Z' },
    { enabledAt: null }, { enabledAt: '不是时间' }, { enabledAt: undefined },
    { enabled: false, enabledAt: first },
    { version: 0 }, { version: -1 }, { version: 1.5 }, { version: '1' }, { version: undefined }, { version: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const external = rewriteMeta(original, patch);
    f.write(external);
    assert.throws(() => f.records.routines(), isStatus(400), JSON.stringify(patch));
    assert.throws(() => f.records.saveRoutine(input(), digest(external)), isStatus(400));
    assert.throws(() => f.records.deleteRoutine(saved.id, digest(external)), isStatus(400));
    assert.equal(f.read(), external);
  }
  f.write(rewriteMeta(original, { createdAt: '2026-09-18T09:00:00+08:00', updatedAt: '2026-09-18T01:00:00Z' }));
  assert.equal(f.records.routines().jobs[0].createdAt, '2026-09-18T09:00:00+08:00');
});

test('版本上界拒绝溢出，重复 ID 与损坏边界不允许覆盖', t => {
  const f = fixture(t), saved = f.records.saveRoutine(input(), null);
  const original = f.read();
  f.write(rewriteMeta(original, { version: Number.MAX_SAFE_INTEGER }));
  const full = f.records.routines();
  assert.equal(f.records.saveRoutine(input(), full.revision, saved.id).version, Number.MAX_SAFE_INTEGER);
  assert.throws(() => f.records.saveRoutine(input({ name: '不能溢出' }), full.revision, saved.id), isStatus(400));
  f.write(original + rawBlock(original, saved.id));
  assert.throws(() => f.records.routines(), isStatus(400));
  f.write(original.replace(/<!-- \/dsh-record [^>]+ -->\n$/, ''));
  const broken = f.read();
  assert.throws(() => f.records.routines(), isStatus(409));
  assert.throws(() => f.records.saveRoutine(input(), digest(broken)), isStatus(409));
  assert.throws(() => f.records.deleteRoutine(saved.id, digest(broken)), isStatus(409));
  assert.equal(f.read(), broken);
});

test('删除只去掉目标块，保留手写内容、其他块和其他记录契约', t => {
  const f = fixture(t), records = f.records;
  const a = records.saveRoutine(input(), null), b = records.saveRoutine(input({ name: '第二项' }), a.revision);
  records.addMemory('普通记忆');
  const memory = records.read('memory.md').text;
  f.write('手写前言\n' + f.read() + '\n手写后记\n' + memory);
  const before = f.read(), secondBlock = rawBlock(before, b.id), removedBlock = rawBlock(before, a.id);
  assert.equal(records.deleteRoutine(a.id, records.routines().revision), true);
  assert.equal(f.read(), before.replace(removedBlock, ''));
  assert.ok(f.read().includes(secondBlock));
  assert.ok(f.read().includes(memory));
  assert.equal(records.deleteRoutine(a.id, records.routines().revision), false);
  assert.deepEqual(records.routines().jobs.map(job => job.id), [b.id]);
  assert.deepEqual(records.memories().map(entry => entry.text), ['普通记忆']);
});

test('空白的已有文件必须使用摘要而不是 null，读取和保存不隐式填默认任务', t => {
  const f = fixture(t);
  f.write('');
  assert.deepEqual(f.records.routines(), { jobs: [], revision: digest('') });
  assert.throws(() => f.records.saveRoutine(input(), null), isStatus(409));
  const saved = f.records.saveRoutine(input(), digest(''));
  assert.equal(f.records.routines().jobs.length, 1);
  assert.equal(f.records.routines().jobs[0].id, saved.id);
});

test('最多 100 个任务，已有任务仍可更新删除，外部超限也校验', t => {
  const f = fixture(t), records = f.records;
  let revision = null, last;
  for (let i = 0; i < 100; i++) { last = records.saveRoutine(input({ name: `任务 ${i}` }), revision); revision = last.revision; }
  const original = f.read();
  assert.equal(records.routines().jobs.length, 100);
  assert.throws(() => records.saveRoutine(input(), revision), /100/);
  assert.equal(f.read(), original);
  last = records.saveRoutine(input({ name: '修改第一百项' }), revision, last.id);
  assert.equal(last.version, 2);
  const block = rawBlock(f.read(), last.id);
  f.write(f.read() + rewriteMeta(block, { id: randomUUID() }));
  assert.throws(() => records.routines(), /100/);
  f.write(original);
  records.deleteRoutine(last.id, records.routines().revision);
  records.saveRoutine(input(), records.routines().revision);
  assert.equal(records.routines().jobs.length, 100);
});

for (const operation of ['create', 'update', 'delete']) test(`Routine ${operation} 写入中途外部编辑返回 409 并保全现场`, t => {
  const f = fixture(t), records = f.records;
  const job = records.saveRoutine(input(), null), before = f.read();
  const external = before + '\n外部并发新增备注\n';
  const read = records.read.bind(records);
  let reads = 0;
  const mocked = t.mock.method(records, 'read', name => {
    if (name === 'routines.md' && ++reads === 3) f.write(external);
    return read(name);
  });
  const action = operation === 'create' ? () => records.saveRoutine(input(), job.revision)
    : operation === 'update' ? () => records.saveRoutine(input({ prompt: '更新内容' }), job.revision, job.id)
      : () => records.deleteRoutine(job.id, job.revision);
  assert.throws(action, isStatus(409));
  mocked.mock.restore();
  assert.equal(f.read(), external);
  assert.equal(existsSync(join(f.dir, '.records.lock')), false);
  assert.equal(readdirSync(f.dir).some(name => name.startsWith('.record-')), false);
});

test('Store 默认任务迁移持锁且只执行一次，删除默认任务或文件后重开不复活', t => {
  const f = fixture(t), migrate = Records.prototype.migrateRoutines;
  let calls = 0;
  const mocked = t.mock.method(Records.prototype, 'migrateRoutines', function () {
    assert.equal(existsSync(join(this.root, '.records.lock')), true);
    calls++;
    return migrate.call(this);
  });
  f.store = f.open();
  const initial = f.store.routines();
  assert.equal(initial.jobs.length, 1);
  const job = initial.jobs[0];
  assert.deepEqual(fields(job), DEFAULT_ROUTINE);
  assert.equal(job.enabled, false);
  assert.equal(job.enabledAt, null);
  assert.equal(job.version, 1);
  assert.equal(new Date(job.createdAt).toISOString(), job.createdAt);
  assert.equal(job.updatedAt, job.createdAt);
  assert.deepEqual(f.store.db.prepare('SELECT version FROM record_migrations ORDER BY version').all().map(row => row.version), ['markdown-v1', 'profile-defaults-v1', 'routine-default-v1']);
  f.restart();
  assert.deepEqual(f.store.routines(), initial);
  assert.equal(f.store.deleteRoutine(job.id, initial.revision), true);
  f.restart();
  assert.deepEqual(f.store.routines().jobs, []);
  unlinkSync(join(f.dir, 'routines.md'));
  f.restart();
  assert.deepEqual(f.store.routines(), { jobs: [], revision: null });
  assert.equal(existsSync(join(f.dir, 'routines.md')), false);
  assert.equal(calls, 1);
  mocked.mock.restore();
  const manual = f.store.saveRoutine(input(), null, null, new Date(first));
  assert.equal(manual.createdAt, first);
});

for (const text of ['', '# 手写 Routine 文件\n', '<!-- dsh-record {损坏元数据} -->\n']) test(`已有 Routine 文件首次迁移也不覆盖：${text ? '非空 ' + text.length : '空文件'}`, t => {
  const f = fixture(t);
  f.write(text);
  f.store = f.open();
  assert.equal(f.read(), text);
  assert.ok(f.store.db.prepare('SELECT version FROM record_migrations WHERE version=?').get('routine-default-v1'));
  f.restart();
  assert.equal(f.read(), text);
});

test('迁移写文件后标记前失败，再次启动保留原任务 UUID，不生成重复默认任务', t => {
  const f = fixture(t), migrate = Records.prototype.migrateRoutines;
  const mocked = t.mock.method(Records.prototype, 'migrateRoutines', function () {
    migrate.call(this);
    throw new Error('模拟迁移标记前中断');
  });
  assert.throws(() => f.open(), /模拟迁移标记前中断/);
  mocked.mock.restore();
  const before = f.read(), initial = f.records.routines();
  f.store = f.open();
  assert.equal(f.read(), before);
  assert.deepEqual(f.store.routines(), initial);
  assert.equal(f.store.routines().jobs.length, 1);
});

test('已存在的自定义任务迁移不替换，Store 包装完整传递参数', t => {
  const f = fixture(t);
  const initial = f.records.saveRoutine(input({ enabled: true }), null, null, new Date(first));
  const before = f.read();
  f.store = f.open();
  assert.equal(f.read(), before);
  assert.equal(f.store.routines().jobs[0].id, initial.id);
  assert.throws(() => f.store.saveRoutine(input()), isStatus(409));
  assert.throws(() => f.store.deleteRoutine(initial.id), isStatus(409));
  const updated = f.store.saveRoutine(input(), initial.revision, initial.id, new Date(second));
  assert.equal(updated.version, 2);
  assert.equal(updated.updatedAt, second);
  assert.equal(updated.enabledAt, null);
  f.restart();
  assert.deepEqual(f.store.routines().jobs[0], { ...fields(updated), id: updated.id, createdAt: first, updatedAt: second, enabledAt: null, version: 2 });
});

test('routine_runs 建表及 startedAt 索引，完整 JSON 落盘和窗口唯一约束', t => {
  const f = fixture(t, true), store = f.store, other = f.open();
  assert.deepEqual(store.db.prepare('PRAGMA table_info(routine_runs)').all().map(column => column.name), ['id', 'jobId', 'windowKey', 'status', 'startedAt', 'data']);
  assert.ok(store.db.prepare('PRAGMA index_list(routine_runs)').all().some(index => index.name === 'routine_runs_startedAt'));
  const value = run();
  assert.deepEqual(store.startRoutineRun(value), value);
  value.snapshot.allowNetwork = true;
  assert.equal(store.routineRun(value.id).snapshot.allowNetwork, false);
  assert.equal(other.startRoutineRun({ ...value, id: randomUUID() }), null);
  assert.equal(other.startRoutineRun({ ...value, windowKey: '不同窗口但相同 ID' }), null);
  const next = run({ jobId: value.jobId, windowKey: 'daily:2026-09-19' });
  assert.deepEqual(other.startRoutineRun(next), next);
  assert.equal(store.routineRuns().length, 2);
  const row = store.db.prepare('SELECT * FROM routine_runs WHERE id=?').get(value.id);
  assert.equal(row.status, 'running');
  assert.deepEqual(JSON.parse(row.data), store.routineRun(value.id));
});

test('完成运行合并 JSON 并同步状态，不改身份字段；失败回滚、单条不存在返回 null', t => {
  const f = fixture(t, true), value = run();
  f.store.startRoutineRun(value);
  const patch = { status: 'completed', content: '仅本地测试结果', finishedAt: second, delivery: { today: true }, optional: null };
  const result = f.store.finishRoutineRun(value.id, patch);
  assert.deepEqual(result, { ...value, ...patch });
  assert.equal(f.store.db.prepare('SELECT status FROM routine_runs WHERE id=?').get(value.id).status, 'completed');
  assert.deepEqual(f.store.routineRun(value.id), result);
  assert.equal(f.store.routineRun('不存在'), null);
  assert.equal(f.store.finishRoutineRun('不存在', patch), null);
  assert.throws(() => f.store.finishRoutineRun(value.id, { status: null }), isStatus(400));
  assert.deepEqual(f.store.routineRun(value.id), result);
  const merged = f.store.finishRoutineRun(value.id, { note: '保留历史', id: '不同 ID', jobId: '不同任务', windowKey: '不同窗口', startedAt: second });
  assert.deepEqual(merged, { ...result, note: '保留历史' });
  f.restart();
  assert.deepEqual(f.store.routineRun(value.id), merged);
});

test('运行历史按时间倒序、相同时间按 rowid 倒序，过滤参数绑定且最多 100 条', t => {
  const f = fixture(t, true), jobId = randomUUID(), special = "job' OR 1=1 --";
  const all = [];
  for (let i = 0; i < 110; i++) {
    const value = run({ jobId: i === 3 ? special : jobId, windowKey: `window:${i}`, status: 'completed', startedAt: i < 50 ? second : first });
    f.store.startRoutineRun(value);
    all.push(value);
  }
  const ordered = [...all].reverse().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  assert.deepEqual(f.store.routineRuns(), ordered.slice(0, 20));
  assert.deepEqual(f.store.routineRuns(null, 1000), ordered.slice(0, 100));
  assert.deepEqual(f.store.routineRuns(jobId, 2), ordered.filter(item => item.jobId === jobId).slice(0, 2));
  assert.deepEqual(f.store.routineRuns(special, 100), [all[3]]);
  assert.deepEqual(f.store.routineRuns('不存在', 100), []);
  assert.deepEqual(f.store.routineRuns(null, -1), []);
  assert.deepEqual(f.store.routineRuns(null, 0), []);
  assert.equal(f.store.routineRuns(null, '1; DROP TABLE routine_runs;').length, 20);
  assert.equal(f.store.routineRuns(null, NaN).length, 20);
  assert.equal(f.store.routineRuns(null, Infinity).length, 20);
});

test('重开取消全部 running，不改完成记录，不重放不投递且 finishedAt 重启后稳定', t => {
  const f = fixture(t, true), a = run(), b = run(), done = run({ status: 'completed', finishedAt: second, content: '已完成' });
  const before = f.read();
  for (const value of [a, b, done]) f.store.startRoutineRun(value);
  f.restart();
  for (const value of [a, b]) {
    const cancelled = f.store.routineRun(value.id);
    assert.deepEqual(cancelled, { ...value, status: 'cancelled', reason: '宿主重启，中断的任务不会自动重放', finishedAt: cancelled.finishedAt });
    assert.equal(new Date(cancelled.finishedAt).toISOString(), cancelled.finishedAt);
    assert.equal(f.store.db.prepare('SELECT status FROM routine_runs WHERE id=?').get(value.id).status, 'cancelled');
    assert.equal(f.store.startRoutineRun({ ...value, id: randomUUID() }), null);
  }
  assert.deepEqual(f.store.routineRun(done.id), done);
  assert.deepEqual(f.store.messages(), []);
  assert.deepEqual(f.store.journal(), []);
  assert.equal(f.read(), before);
  const history = f.store.routineRuns();
  f.restart();
  assert.deepEqual(f.store.routineRuns(), history);
});

test('真实子进程异常退出后运行幂等键持久化，重开只取消不重放', t => {
  const f = fixture(t, true), value = run();
  f.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(new URL('../store.mjs', import.meta.url).href)};
    const store = new Store(${JSON.stringify(f.file)});
    store.startRoutineRun(${JSON.stringify(value)});
    process.exit(73);
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 73, child.stderr);
  f.store = f.open();
  assert.equal(f.store.routineRun(value.id).status, 'cancelled');
  assert.equal(f.store.startRoutineRun({ ...value, id: randomUUID() }), null);
  assert.equal(f.store.routineRuns(value.jobId).length, 1);
  assert.deepEqual(f.store.messages(), []);
});

test('无效运行对象不写库，独立窗口与不同任务不会被错误去重', t => {
  const f = fixture(t, true);
  for (const value of [null, {}, run({ id: null }), run({ jobId: '' }), run({ windowKey: null }), run({ status: null }), run({ startedAt: '无效时间' })]) assert.throws(() => f.store.startRoutineRun(value), isStatus(400));
  assert.deepEqual(f.store.routineRuns(), []);
  const a = run(), b = run({ windowKey: a.windowKey }), c = run({ jobId: a.jobId, windowKey: 'interval:第二个窗口' });
  for (const value of [a, b, c]) assert.deepEqual(f.store.startRoutineRun(value), value);
  assert.equal(f.store.routineRuns().length, 3);
});

test('recentMessages 跨会话只读 complete 用户和助手，起点包含终点排除且同时间倒序', t => {
  const f = fixture(t, true), store = f.store;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(first) - 1 });
  store.addMessage('user', '起点前，不应出现');
  t.mock.timers.setTime(Date.parse(first));
  const sessionA = store.get('sessionId'), a = store.addMessage('user', '起点原文');
  t.mock.timers.setTime(Date.parse(first) + 1000);
  const b = store.addMessage('assistant', '前一个会话的完整回答');
  const sessionB = store.resetSession(), c = store.addMessage('user', '当前会话完整问题');
  for (const status of ['pending', 'interrupted', 'cancelled', 'failed', 'running']) store.addMessage('assistant', `排除状态 ${status}`, status);
  for (const role of ['system', 'tool', 'status']) store.addMessage(role, `排除角色 ${role}`);
  t.mock.timers.setTime(Date.parse(second));
  store.addMessage('assistant', '终点原文，不应出现');
  const expected = [
    { id: c.id, role: c.role, content: c.content, createdAt: c.createdAt, sessionId: sessionB },
    { id: b.id, role: b.role, content: b.content, createdAt: b.createdAt, sessionId: sessionA },
    { id: a.id, role: a.role, content: a.content, createdAt: a.createdAt, sessionId: sessionA },
  ];
  const read = t.mock.method(store.records, 'read', () => { throw new Error('查询不得读取 Markdown 或 Harness 原始日志'); });
  const files = t.mock.method(store.records, 'files', () => { throw new Error('查询不得扫描日志目录'); });
  assert.deepEqual(store.recentMessages(first, second).map(row => ({ ...row })), expected);
  assert.deepEqual(store.recentMessages(first, second, 2).map(row => ({ ...row })), expected.slice(0, 2));
  assert.deepEqual(store.recentMessages(first, first), []);
  assert.deepEqual(store.recentMessages(second, first), []);
  read.mock.restore(); files.mock.restore();
  f.restart();
  assert.deepEqual(f.store.recentMessages(first, second).map(row => ({ ...row })), expected);
});

test('recentMessages 默认 80 条上限 100，参数有界且不会注入 SQL', t => {
  const f = fixture(t, true), store = f.store, sessionId = store.get('sessionId');
  const insert = store.db.prepare('INSERT INTO messages (id,sessionId,role,content,createdAt,status) VALUES (?,?,?,?,?,?)');
  const ids = [];
  for (let i = 0; i < 110; i++) {
    const id = randomUUID(); ids.push(id);
    insert.run(id, sessionId, i % 2 ? 'user' : 'assistant', `完整消息 ${i}`, first, 'complete');
  }
  assert.deepEqual(store.recentMessages(first, second).map(entry => entry.id), [...ids].reverse().slice(0, 80));
  assert.equal(store.recentMessages(first, second, 10000).length, 100);
  assert.deepEqual(store.recentMessages(first, second, -1), []);
  assert.deepEqual(store.recentMessages(first, second, 0), []);
  for (const limit of [NaN, Infinity, '1; DROP TABLE messages;']) assert.equal(store.recentMessages(first, second, limit).length, 80);
  for (const value of [null, undefined, "' OR 1=1 --"]) {
    assert.throws(() => store.recentMessages(value, second), isStatus(400));
    assert.throws(() => store.recentMessages(first, value), isStatus(400));
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages').get().n, 110);
});
