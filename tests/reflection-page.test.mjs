import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

// 回顾真分页：状态接口只回最近一页并给出总数与是否还有更早的条目，
// 更早的按需由 /api/reflections 取。不导入 index/maintenance/lifecycle，不加载模型或宿主。
const COUNT = 20;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'claudia-reflection-page-'));
  const home = join(root, 'synthetic-home'), dataDir = join(home, 'claudia');
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  app = await startServer({
    dataDir, home, profile: 'synthetic-profile', port: 0,
    createRuntime: store => ({ store, selection: () => ({ provider: 'p', model: 'm' }), status: async () => ({ configured: true }), async run() { throw new Error('禁止模型调用'); }, async cancel() {}, async release() {}, async close() {} }),
    createServices: () => ({
      maintenance: { status: () => ({ running: false }), async close() {} },
      activity: { status: () => ({ enabled: false, running: false }), summary: () => ({ apps: [], seconds: 0 }), async setEnabled() {}, async close() {} },
    }),
  });
  const base = new Date('2026-09-01T00:00:00.000Z').getTime();
  for (let index = 0; index < COUNT; index++) {
    const day = new Date(base + index * 86400000).toISOString();
    app.store.saveReflection({ id: `reflection-${index}`, text: `第 ${index} 篇回顾`, start: day, end: day, createdAt: day });
  }
  const get = path => new Promise((resolve, reject) => {
    const client = httpRequest(new URL(path, app.url), { agent: false, headers: { connection: 'close' } }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    client.on('error', reject); client.end();
  });
  return { app, get };
}

test('状态接口只回最近一页，并给出总数与是否还有更早条目', async t => {
  const { get } = await fixture(t);
  const { status, data } = await get('/api/state');
  assert.equal(status, 200);
  assert.equal(data.reflections.length, 14);
  assert.equal(data.reflectionTotal, COUNT);
  assert.equal(data.reflectionHasMore, true);
  assert.equal(data.reflections[0].id, `reflection-${COUNT - 1}`);
  assert.equal(data.reflections.at(-1).id, `reflection-${COUNT - 14}`);
});

test('按游标取更早一页，不重复也不遗漏；取完后 hasMore 为 false', async t => {
  const { get } = await fixture(t);
  const first = await get('/api/reflections');
  assert.equal(first.data.reflections.length, 14); assert.equal(first.data.hasMore, true);
  const second = await get(`/api/reflections?after=${first.data.reflections.at(-1).id}`);
  assert.deepEqual(second.data.reflections.map(entry => entry.id), [5, 4, 3, 2, 1, 0].map(index => `reflection-${index}`));
  assert.equal(second.data.hasMore, false); assert.equal(second.data.total, COUNT);
  const all = await get('/api/reflections?limit=50');
  assert.equal(all.data.reflections.length, COUNT); assert.equal(all.data.hasMore, false);
  const ids = new Set([...first.data.reflections, ...second.data.reflections].map(entry => entry.id));
  assert.equal(ids.size, COUNT);
});

test('分页参数非法或游标不存在时明确报错，不回传全部', async t => {
  const { get } = await fixture(t);
  for (const query of ['?limit=0', '?limit=51', '?limit=abc', '?after=bad%20id', '?after=%20']) {
    const { status, data } = await get(`/api/reflections${query}`);
    assert.equal(status, 400, query); assert.equal(data.reflections, undefined);
  }
  const missing = await get('/api/reflections?after=reflection-not-exist');
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.data, { reflections: [], total: COUNT, hasMore: false });
});
