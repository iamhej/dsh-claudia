import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

// 邮件分析失败的文案边界：只透传本模块用 fail() 登记的受控中文文案，
// 宿主、邮箱或 provider 的原始异常（可能含账号、路径、凭据片段）一律通用化，不回显也不落日志。
// 不导入 index/native-runtime/maintenance/lifecycle，不加载宿主、模型或系统命令。
const SAFE_TEXT = '邮箱、模型设置、会话或本地日期范围已变化，请重新预览并确认；不会自动重试。';
const GENERIC = '邮件连接、读取或分析未完成。请核对兼容版、账号授权及模型；失败不等于没有邮件，不会自动重试。';
const RAW = 'IMAP 鉴权失败 user=someone@qq.com password=SECRET123 /Users/someone/.dsh';

async function fixture(t, kind) {
  const root = await mkdtemp(join(tmpdir(), 'claudia-email-error-'));
  const home = join(root, 'synthetic-home'), dataDir = join(home, 'claudia');
  let app, token;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  app = await startServer({
    dataDir, home, profile: 'synthetic-profile', port: 0,
    createRuntime: store => ({ store, selection: () => ({ provider: 'p', model: 'm' }), status: async () => ({ configured: true }), async run() { throw new Error('禁止模型调用'); }, async cancel() {}, async release() {}, async close() {} }),
    createServices: () => ({
      maintenance: { status: () => ({ running: false }), async close() {} },
      activity: { status: () => ({ enabled: false, running: false }), summary: () => ({ apps: [], seconds: 0 }), async setEnabled() {}, async close() {} },
      emailReview: {
        validate: () => ({ prompt: '纯测试分析要求' }),
        run: async () => {
          if (kind === 'safe') throw Object.assign(new Error(SAFE_TEXT), { code: 'EMAIL_REVIEW_STALE', status: 409, emailReviewSafe: true });
          throw new Error(RAW);
        },
        async close() {},
      },
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
  const post = () => new Promise((resolve, reject) => {
    const client = httpRequest(new URL('/api/email/review', app.url), { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'x-claudia-token': token, connection: 'close' } }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, raw, lines: raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }));
    });
    client.on('error', reject); client.end('{}');
  });
  return { app, post };
}

test('受控邮件分析错误透传固定文案', async t => {
  const { post } = await fixture(t, 'safe');
  const { status, lines, raw } = await post();
  assert.equal(status, 200);
  assert.equal(lines.at(-1).type, 'error');
  assert.equal(lines.at(-1).error, SAFE_TEXT);
  assert.equal(raw.includes(GENERIC), false);
});

test('未登记的宿主或邮箱异常只给通用文案，不回显原文片段', async t => {
  const { post } = await fixture(t, 'raw');
  const { status, lines, raw } = await post();
  assert.equal(status, 200);
  assert.equal(lines.at(-1).type, 'error');
  assert.equal(lines.at(-1).error, GENERIC);
  for (const secret of ['SECRET123', 'someone@qq.com', '/.dsh', 'IMAP']) assert.equal(raw.includes(secret), false, secret);
});
