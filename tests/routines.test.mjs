import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store } from '../store.mjs';
import { Routines } from '../routines.mjs';
import { Maintenance } from '../maintenance.mjs';
import { routineOccurrence } from '../routine-schema.mjs';
import { startServer } from '../server.mjs';
const definition = { name: '本地测试', prompt: '帮我整理有依据的线索', schedule: { type: 'daily', time: '11:00' }, allowNetwork: false, delivery: 'both', enabled: true };
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claudia-routine-'))), store = new Store(join(dir, 'test.sqlite'));
  const calls = [], runtime = { running: false, async prepare() {}, async cancel() {}, async release() {}, async run(id, prompt) {
    calls.push(prompt); const sources = JSON.parse(prompt.split('<routine_data_untrusted>')[1].split('</routine_data_untrusted>')[0]);
    return { reason: { kind: 'completed' }, text: JSON.stringify({ status: 'success', summary: '有一条值得回看的记录。', reason: '', sourceIds: [sources[0].sourceId] }) };
  } };
  const routines = new Routines({ store, runtime });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const save = (fields = {}, now = new Date(Date.now() - 2 * 86400000), id = null) => {
    const result = store.saveRoutine({ ...definition, ...fields }, store.routines().revision, id, now);
    return store.routines().jobs.find(j => j.id === result.id);
  };
  const add = () => store.addJournal('我想继续整理那个增长实验。', new Date(Date.now() - 3600000).toISOString());
  return { store, runtime, calls, routines, save, add };
}
test('每日分钟、每周选择、首次启用不追赶和最新窗口', () => {
  const job = { ...definition, enabledAt: new Date(2026, 8, 18, 11, 1).toISOString() };
  assert.equal(routineOccurrence(job, new Date(2026, 8, 18, 12)), null);
  assert.equal(routineOccurrence(job, new Date(2026, 8, 18, 12), 'next'), new Date(2026, 8, 19, 11).toISOString());
  job.schedule = { type: 'weekly', days: [1, 3, 5], time: '09:35' }; job.enabledAt = new Date(2026, 8, 1).toISOString();
  assert.equal(routineOccurrence(job, new Date(2026, 8, 20, 12)), new Date(2026, 8, 18, 9, 35).toISOString());
  assert.equal(routineOccurrence(job, new Date(2026, 8, 20, 12), 'next'), new Date(2026, 8, 21, 9, 35).toISOString());
});
test('间隔锚点以启用时间为准，错过只取最新', () => {
  const job = { ...definition, schedule: { type: 'interval', hours: 6 }, enabledAt: '2026-09-18T01:20:00.000Z' };
  assert.equal(routineOccurrence(job, '2026-09-18T07:19:59.000Z'), null);
  assert.equal(routineOccurrence(job, '2026-09-19T08:00:00.000Z'), '2026-09-19T07:20:00.000Z');
  assert.equal(routineOccurrence(job, '2026-09-19T08:00:00.000Z', 'next'), '2026-09-19T13:20:00.000Z');
});
test('DST 跳过时刻顺延、回拨重复时刻只取第一次', () => {
  const module = new URL('../routine-schema.mjs', import.meta.url).href;
  const code = `import assert from 'node:assert/strict';import {routineOccurrence as o} from ${JSON.stringify(module)};
  const j={enabled:true,enabledAt:'2026-01-01T00:00:00.000Z',schedule:{type:'daily',time:'02:30'}};
  assert.equal(o(j,new Date('2026-03-08T07:31:00Z')),'2026-03-08T07:30:00.000Z');
  j.schedule.time='01:30';assert.equal(o(j,new Date('2026-11-01T06:45:00Z')),'2026-11-01T05:30:00.000Z');
  assert.equal(o(j,new Date('2026-11-01T06:45:00Z'),'next'),'2026-11-02T06:30:00.000Z');`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: 'America/New_York' } });
});
test('默认资讯停用且不执行，空窗口无需模型', async t => {
  const f = fixture(t); await f.routines.tick(new Date()); assert.equal(f.calls.length, 0);
  const job = f.save({ enabled: false }); await f.routines.manual(job, randomUUID());
  assert.equal(f.calls.length, 0); assert.equal(f.store.routineRuns(job.id)[0].status, 'no-data');
  await assert.rejects(f.routines.manual(f.store.routines().jobs[0], randomUUID()), /联网/);
});
test('成功有证据、手动幂等、消息历史不伪造投递', async t => {
  const f = fixture(t); const source = f.add(), job = f.save({ enabled: false }), request = randomUUID();
  await f.routines.manual(job, request); await f.routines.manual(job, request);
  const run = f.store.routineRuns(job.id)[0]; assert.equal(f.calls.length, 1); assert.equal(run.status, 'success');
  assert.equal(run.sources[0].id, source.id); assert.ok(run.deliveredAt); assert.equal(run.delivery, 'both'); assert.deepEqual(f.store.messages(), []);
});
test('每个计划窗口只跑一次，截止使用原定时间', async t => {
  const f = fixture(t); const now = new Date(), anchor = new Date(now.getTime() - 5 * 3600000);
  f.store.addJournal('窗口中的记录', new Date(now.getTime() - 3 * 3600000).toISOString());
  const job = f.save({ schedule: { type: 'interval', hours: 2 } }, anchor);
  await f.routines.tick(now); await f.routines.tick(now);
  assert.equal(f.calls.length, 1); assert.equal(f.store.routineRuns(job.id)[0].end, new Date(anchor.getTime() + 4 * 3600000).toISOString());
});
test('输入总量受限，窗口外旧数据不发给模型', async t => {
  const f = fixture(t); f.store.addJournal('旧记录绝不发送', '2000-01-01T00:00:00Z');
  for (let i = 0; i < 18; i++) f.store.addJournal('摘录'.repeat(1000), new Date(Date.now() - 1000).toISOString());
  const job = f.save(); await f.routines.manual(job, randomUUID());
  assert.ok(!f.calls[0].includes('旧记录绝不发送')); assert.ok(f.calls[0].length < 18000);
});
for (const action of ['disable', 'delete', 'edit', 'source']) test(`生成期间 ${action} 后不投递`, async t => {
  const f = fixture(t); const source = f.add(), job = f.save();
  const original = f.runtime.run;
  f.runtime.run = async (...args) => {
    if (action === 'disable') f.save({ enabled: false }, new Date(), job.id);
    if (action === 'delete') f.store.deleteRoutine(job.id, f.store.routines().revision);
    if (action === 'edit') f.save({ prompt: '任务改变了' }, new Date(), job.id);
    if (action === 'source') f.store.deleteJournal(source.id);
    return original(...args);
  };
  await f.routines.manual(job, randomUUID()); const run = f.store.routineRuns(job.id)[0];
  assert.equal(run.status, 'cancelled'); assert.equal(run.deliveredAt, null);
});
test('静默、无效证据、截断与提供商错误分开记录，不泄漏错误正文', async t => {
  const f = fixture(t); f.add(); const job = f.save();
  const results = [
    { reason: { kind: 'completed' }, text: JSON.stringify({ status: 'silent', summary: '', reason: '没有值得提醒的内容', sourceIds: [] }) },
    { reason: { kind: 'completed' }, text: JSON.stringify({ status: 'success', summary: '幻觉', reason: '', sourceIds: ['fake'] }) },
    { reason: { kind: 'max-tokens' }, text: '截断' },
  ];
  for (const result of results) { f.runtime.run = async () => result; await f.routines.manual(job, randomUUID()); }
  f.runtime.run = async () => { throw Error('secret-api-token-do-not-expose'); }; await f.routines.manual(job, randomUUID());
  const runs = f.store.routineRuns(job.id); assert.equal(runs.filter(r => r.status === 'silent').length, 1); assert.equal(runs.filter(r => r.status === 'failed').length, 3);
  assert.ok(runs.every(r => !r.deliveredAt)); assert.ok(!JSON.stringify(runs).includes('secret-api-token'));
});
test('准备期间取消，不在延迟准备完成后又调用模型', async t => {
  const f = fixture(t); f.add(); const job = f.save();
  f.runtime.prepare = async () => { f.routines.cancel('取消准备'); };
  await f.routines.manual(job, randomUUID()); assert.equal(f.calls.length, 0); assert.equal(f.store.routineRuns(job.id)[0].status, 'cancelled');
});
test('超时取消只取消自己的会话，释放后不投递', async t => {
  const f = fixture(t); f.add(); const job = f.save(); f.routines.timeoutMs = 15;
  let resolve, cancelledId; f.runtime.run = () => new Promise(r => { resolve = r; });
  f.runtime.cancel = async id => { cancelledId = id; resolve?.({ reason: { kind: 'aborted' } }); };
  const keep = setTimeout(() => {}, 1000);
  try { await f.routines.manual(job, randomUUID()); } finally { clearTimeout(keep); }
  assert.ok(cancelledId); assert.notEqual(cancelledId, f.store.get('sessionId')); assert.equal(f.store.routineRuns(job.id)[0].status, 'cancelled');
});
test('共享维护锁覆盖手动Routine，忙碌时不启动', async t => {
  const f = fixture(t); f.add(); const job = f.save(), m = new Maintenance({ store: f.store, runtime: f.runtime });
  let done, started; const ready = new Promise(r => { started = r; }); const orig = f.runtime.run;
  f.runtime.run = async (...args) => { started(); await new Promise(r => { done = r; }); return orig(...args); };
  const first = m.runRoutine(job, randomUUID()); await ready; assert.equal(m.status().running, true);
  await m.runRoutine(job, randomUUID()); done(); await first; assert.equal(f.calls.length, 1); await m.close();
});
test('真实API：revision、同意、联网拒绝、异步受理、CRUD和历史', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claudia-routine-api-')));
  const runtime = { selection: () => ({}), status: async () => ({ configured: true }), close: async () => {}, release: async () => {}, cancel: async () => {}, run: async () => { throw Error('无数据不应调用'); } };
  const app = await startServer({ dataDir: dir, port: 0, createRuntime: () => runtime, createServices: ({ store, runtime, isBusy }) => ({ maintenance: new Maintenance({ store, runtime, isBusy }) }) });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const token = (await (await fetch(app.url + '/api/bootstrap')).json()).csrfToken;
  const request = (path, body, method = 'POST') => fetch(app.url + path, { method, headers: { 'content-type': 'application/json', 'x-claudia-token': token }, body: JSON.stringify(body) });
  let snapshot = app.store.routines();
  assert.equal((await request('/api/routines', { job: definition, revision: snapshot.revision })).status, 400);
  assert.equal((await request('/api/routines', { job: { ...definition, allowNetwork: true }, revision: snapshot.revision, confirmDataSharing: true })).status, 409);
  let response = await request('/api/routines', { job: { ...definition, enabled: false }, revision: snapshot.revision }); assert.equal(response.status, 201);
  snapshot = await response.json(); const job = snapshot.jobs.at(-1), path = '/api/routines/' + job.id;
  assert.equal((await request(path, { job: definition, revision: 'bad', confirmDataSharing: true })).status, 409);
  const runBody = { revision: snapshot.revision, requestId: randomUUID(), confirmDataSharing: true };
  response = await request(path + '/run', runBody); assert.equal(response.status, 202); await app.services.maintenance.operation;
  response = await request(path + '/run', runBody); assert.equal(response.status, 202); await app.services.maintenance.operation;
  const history = await (await fetch(app.url + path + '/history')).json(); assert.equal(history.runs.length, 1); assert.equal(history.runs[0].status, 'no-data');
  assert.equal((await request(path, {} ,'DELETE')).status, 409);
  assert.equal((await request(path, { revision: snapshot.revision }, 'DELETE')).status, 200);
  const state = await (await fetch(app.url + '/api/state')).json(); assert.equal(state.routineCapability.network, false); assert.ok(state.routineRuns.length);
});
