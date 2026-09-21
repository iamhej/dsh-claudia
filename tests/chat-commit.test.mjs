import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

// 消息已写入 SQLite 但 Markdown 副本同步失败时，不能报成模型调用失败，
// 也不能把已经保存的回复标成 error：回复照常交付，只附一条警告。
// 不导入 index/maintenance/lifecycle，不加载宿主或真实模型。
const GENERIC = '模型调用或会话恢复失败，请在 Harness 检查模型、凭据与网络。原会话没有被清空。';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'claudia-chat-commit-'));
  const home = join(root, 'synthetic-home'), dataDir = join(home, 'claudia');
  let app, token;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  app = await startServer({
    dataDir, home, profile: 'synthetic-profile', port: 0,
    createRuntime: store => ({
      store,
      selection: () => ({ provider: 'synthetic', model: 'synthetic' }),
      status: async () => ({ installed: true, configured: true, connected: true, credentialSource: 'harness', modelVerified: true }),
      async prepare() {},
      async run(_sessionId, _text, { onDelta } = {}) { onDelta?.('纯测试回复'); return { text: '纯测试回复', reason: { kind: 'completed' } }; },
      async cancel() {}, async release() {}, async close() {},
    }),
    createServices: () => ({
      maintenance: { status: () => ({ running: false }), async close() {} },
      activity: { status: () => ({ enabled: false, running: false }), summary: () => ({ apps: [], seconds: 0 }), async setEnabled() {}, async close() {} },
    }),
  });
  const boot = await new Promise((resolve, reject) => {
    const client = httpRequest(new URL('/api/bootstrap', app.url), { agent: false }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    client.on('error', reject); client.end();
  });
  token = boot.csrfToken;
  const chat = () => new Promise((resolve, reject) => {
    const client = httpRequest(new URL('/api/chat', app.url), { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'x-claudia-token': token, connection: 'close' } }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, lines: raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }));
    });
    client.on('error', reject); client.end(JSON.stringify({ text: '纯测试提问' }));
  });
  return { app, chat };
}

test('已落库仅 Markdown 副本失败：照常交付回复并附警告，不标成失败', async t => {
  const { app, chat } = await fixture(t);
  const real = app.store.updateMessage.bind(app.store);
  let calls = 0;
  t.mock.method(app.store, 'updateMessage', (...args) => {
    if (++calls > 1) throw Object.assign(new Error('Markdown 副本同步失败：测试注入'), { committed: true });
    return real(...args);
  });
  const { lines } = await chat();
  const done = lines.find(line => line.type === 'done');
  assert.ok(done, JSON.stringify(lines));
  assert.equal(done.message.content, '纯测试回复');
  assert.match(done.warning, /Markdown 副本同步失败|已保存/);
  assert.equal(lines.some(line => line.type === 'error'), false);
});

test('落库失败发生在回复之前：给出明确文案，不谎称模型调用失败', async t => {
  const { app, chat } = await fixture(t);
  t.mock.method(app.store, 'addMessage', () => { throw Object.assign(new Error('Markdown 副本同步失败：测试注入'), { committed: true }); });
  const { lines } = await chat();
  const error = lines.find(line => line.type === 'error');
  assert.ok(error, JSON.stringify(lines));
  assert.doesNotMatch(error.error, /模型调用或会话恢复失败/);
  assert.match(error.error, /已保存|Markdown 副本/);
});

test('未落库的失败仍按模型或会话错误报告，不谎报成功', async t => {
  const { app, chat } = await fixture(t);
  t.mock.method(app.store, 'updateMessage', () => { throw new Error('存储不可用：测试注入'); });
  const { lines } = await chat();
  const error = lines.find(line => line.type === 'error');
  assert.ok(error, JSON.stringify(lines));
  assert.equal(error.error, GENERIC);
  assert.equal(lines.some(line => line.type === 'done'), false);
});
