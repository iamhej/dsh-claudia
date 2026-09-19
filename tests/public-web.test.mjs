import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { fetchPublic, publicAddress, publicURL } from '../public-web.mjs';

const URL = 'https://example.com/article?q=hello';
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const MAX_BYTES = 512 * 1024;
const tick = () => new Promise(resolve => setImmediate(resolve));
function safe(message) {
  return error => {
    assert.ok(error instanceof Error);
    assert.equal(error.routineSafe, true);
    assert.match(error.message, message);
    assert.ok(!error.message.includes('secret'));
    assert.equal(error.cause, undefined);
    return true;
  };
}

// 两个 HTTP 模块和 DNS 均替换；任何分支都不能意外访问真实网络。
function fixture(t, config = {}) {
  const calls = [], resolutions = [];
  let resolveRequest, resolveResponse, resolveDNS;
  const requestReady = new Promise(resolve => { resolveRequest = resolve; });
  const responseReady = new Promise(resolve => { resolveResponse = resolve; });
  const dnsReady = new Promise(resolve => { resolveDNS = resolve; });
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    resolutions.push({ hostname, options, callback });
    resolveDNS();
    if (config.dnsThrow) throw new Error('secret-dns-error');
    if (!config.holdDNS) queueMicrotask(() => callback(config.dnsError, Object.hasOwn(config, 'records') ? config.records : PUBLIC));
  });
  function send(call, overrides = {}) {
    const settings = { ...config, ...overrides };
    const response = new PassThrough();
    response.statusCode = settings.status ?? 200;
    response.headers = settings.headers ?? { 'content-type': 'text/html; charset=utf-8' };
    call.response = response;
    call.onResponse(response);
    resolveResponse(call);
    if (response.destroyed) return response;
    if (settings.holdBody) return response;
    for (const chunk of settings.chunks ?? [Buffer.from(settings.body ?? '<p>公开正文</p>')]) {
      if (response.destroyed) break;
      response.write(chunk);
    }
    if (!response.destroyed) response.end();
    return response;
  }
  for (const [protocol, module] of [['http:', http], ['https:', https]]) {
    t.mock.method(module, 'request', (options, onResponse) => {
      if (config.requestThrow) throw new Error('secret-request-error');
      const request = new EventEmitter();
      request.destroyed = false;
      request.destroy = () => {
        if (!request.destroyed) {
          request.destroyed = true;
          queueMicrotask(() => request.emit('close'));
        }
        return request;
      };
      const call = { protocol, options, request, onResponse, endArgs: null };
      request.end = (...args) => {
        call.endArgs = args;
        if (!config.holdRequest) queueMicrotask(() => {
          if (config.requestError) request.emit('error', new Error('secret-transport-error'));
          else if (!request.destroyed) send(call);
        });
      };
      calls.push(call);
      resolveRequest(call);
      return request;
    });
  }
  return { calls, resolutions, requestReady, responseReady, dnsReady, send };
}

const acceptedURLs = [
  ['HTTPS://Example.COM:443/a/../b#section', 'https://example.com/b'],
  ['http://example.com:80', 'http://example.com/'],
  ['https://example.com./x?a=1&b=2#secret', 'https://example.com/x?a=1&b=2'],
  ['https://例子.com/文章', 'https://xn--fsqu00a.com/%E6%96%87%E7%AB%A0'],
];
for (const [input, expected] of acceptedURLs) test(`URL 规范化：${input}`, () => assert.equal(publicURL(input), expected));

test('URL 拒绝协议、凭据、特殊域、全类 IP literal 和非默认端口', () => {
  const invalid = [
    null, {}, 42, '', '/relative', '//example.com', 'file:///etc/passwd', 'ftp://example.com',
    'https://user:secret@example.com', 'https://user@example.com', 'https://@example.com', 'https://:@example.com',
    'http://localhost', 'http://localhost.', 'http://intranet', 'http://a.local', 'http://a.internal',
    'http://a.localhost', 'http://a.test', 'http://a.invalid', 'http://a.local.', 'http://LOCALHOST.',
    'https://127.0.0.1', 'https://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
    'https://8.8.8.8', 'https://[::1]', 'https://[2606:4700:4700::1111]', 'https://[::ffff:127.0.0.1]',
    'http://example.com:443', 'https://example.com:80', 'https://example.com:8443',
    'https://a..com', 'https://-a.com', 'https://a_.com', `https://${'a'.repeat(64)}.com`,
    ' https://example.com', 'https://example.com\n', 'https://example.com\\@localhost',
    'https://example.com/%0a\r', 'https://example.com/' + 'a'.repeat(2048),
    'https://example.com/' + '中'.repeat(300),
  ];
  for (const input of invalid) assert.throws(() => publicURL(input), safe(/网页地址不符合公开网页安全要求/), String(input));
});

test('URL 长度上限同时应用于输入和规范化结果', () => {
  const value = 'https://example.com/' + 'a'.repeat(2048 - 'https://example.com/'.length);
  assert.equal(publicURL(value).length, 2048);
  assert.throws(() => publicURL(value + 'a'), safe(/地址/));
});

test('IPv4 拒绝全部特殊网段及两端边界', () => {
  const ranges = [
    ['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'],
    ['100.64.0.0', '100.127.255.255'], ['127.0.0.0', '127.255.255.255'],
    ['169.254.0.0', '169.254.255.255'], ['172.16.0.0', '172.31.255.255'],
    ['192.0.0.0', '192.0.0.255'], ['192.0.2.0', '192.0.2.255'],
    ['192.31.196.0', '192.31.196.255'], ['192.52.193.0', '192.52.193.255'],
    ['192.88.99.0', '192.88.99.255'], ['192.168.0.0', '192.168.255.255'],
    ['192.175.48.0', '192.175.48.255'], ['198.18.0.0', '198.19.255.255'],
    ['198.51.100.0', '198.51.100.255'], ['203.0.113.0', '203.0.113.255'],
    ['224.0.0.0', '239.255.255.255'], ['240.0.0.0', '255.255.255.255'],
  ];
  for (const address of ranges.flat()) assert.equal(publicAddress(address), false, address);
});

test('IPv6 拒绝特殊用途、文档、隧道和非全球单播地址', () => {
  for (const address of [
    '::', '::1', '::ffff:8.8.8.8', '::ffff:808:808', '::ffff:0:808:808', '::8.8.8.8',
    '64:ff9b::808:808', '64:ff9b:1::1', '100::1', 'fc00::1', 'fdff::1', 'fe80::1', 'fec0::1', 'ff02::1',
    '2001::1', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:2::1', '2001:10::1', '2001:20::1',
    '2001:db8::1', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', '2002:808:808::1', '2002:ffff:ffff::1',
    '2620:4f:8000::1', '3ffe::1', '3fff::1', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:4860::5efe:7f00:1', '2001:4860::200:5efe:7f00:1', '2001:4860::5efe:127.0.0.1',
    '4000::1', '5f00::1', '2606:4700::1%en0',
  ]) assert.equal(publicAddress(address), false, address);
});

test('公开 IPv4/IPv6 允许，畸形地址始终关闭', () => {
  for (const address of [
    '1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.0',
    '172.15.255.255', '172.32.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255',
    '2001:4860:4860::8888', '2606:4700:4700::1111', '2400:3200::1', '2a00:1450::1',
    '2001:200::1', '2001:0db9::1', '2606:4700:4700:0000:0000:0000:0000:1111',
  ]) assert.equal(publicAddress(address), true, address);
  for (const address of [null, {}, '', 'example.com', '8.8.8', '08.8.8.8', '256.1.1.1', '8.8.8.8 ', '[::1]', '2001:::1']) {
    assert.equal(publicAddress(address), false, String(address));
  }
});

test('非法 URL 在 DNS 和 HTTP 前拒绝', async t => {
  const f = fixture(t);
  await assert.rejects(fetchPublic('http://127.0.0.1'), safe(/地址/));
  assert.equal(f.resolutions.length, 0);
  assert.equal(f.calls.length, 0);
});

for (const records of [
  [], [{ address: '127.0.0.1', family: 4 }], [...PUBLIC, { address: '10.0.0.1', family: 4 }],
  [...PUBLIC, { address: '::ffff:8.8.8.8', family: 6 }], [...PUBLIC, { address: '2001:db8::1', family: 6 }],
  [{ address: '8.8.8.8', family: 6 }], [{ address: 'secret-invalid', family: 4 }], [null], {}, null,
]) test(`全量 DNS 校验拒绝：${JSON.stringify(records)}`, async t => {
  const f = fixture(t, { records });
  await assert.rejects(fetchPublic(URL), safe(/非公开或无效地址/));
  assert.equal(f.resolutions.length, 1);
  assert.deepEqual(f.resolutions[0].options, { all: true, verbatim: true });
  assert.equal(f.calls.length, 0);
});

for (const records of [PUBLIC, [{ address: '2606:4700:4700::1111', family: 6 }, ...PUBLIC]]) {
  test(`连接 lookup 固定已验证 IPv${records[0].family}，不再做 DNS 解析`, async t => {
    const mutable = records.map(record => ({ ...record }));
    const original = { ...mutable[0] };
    const f = fixture(t, { records: mutable, holdRequest: true });
    const pending = fetchPublic(URL);
    const call = await f.requestReady;
    assert.equal(call.options.hostname, 'example.com');
    assert.equal(call.options.family, original.family);
    assert.equal(call.options.autoSelectFamily, false);
    mutable[0].address = '127.0.0.1';
    mutable.push({ address: '10.0.0.1', family: 4 });
    const lookup = call.options.lookup;
    const pinned = await new Promise((resolve, reject) => lookup('example.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
    assert.deepEqual(pinned, original);
    assert.deepEqual(await new Promise((resolve, reject) => lookup('example.com', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))), [original]);
    assert.deepEqual(await new Promise((resolve, reject) => lookup('example.com', (error, address, family) => error ? reject(error) : resolve({ address, family }))), original);
    await assert.rejects(new Promise((resolve, reject) => lookup('other.example.com', {}, error => error ? reject(error) : resolve())), safe(/地址/));
    assert.equal(f.resolutions.length, 1);
    f.send(call);
    assert.equal((await pending).text, '公开正文');
  });
}

test('匿名 HTTPS 保留原 hostname 验证证书，不带凭据、不用代理或共享 agent', async t => {
  const env = { HTTPS_PROXY: 'http://secret-proxy:8080', HTTP_PROXY: 'http://secret-proxy:8080', ALL_PROXY: 'http://secret-proxy:8080', NODE_TLS_REJECT_UNAUTHORIZED: '0', secret: 'secret-env-token' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const f = fixture(t);
  const result = await fetchPublic(URL + '#secret-fragment', {
    headers: { authorization: 'secret-auth', cookie: 'secret-cookie' },
    lookup: () => { throw Error('secret-injected'); },
    request: () => { throw Error('secret-injected'); },
  });
  const { options, endArgs, protocol, request } = f.calls[0];
  assert.equal(result.url, URL);
  assert.equal(protocol, 'https:');
  assert.equal(options.hostname, 'example.com');
  assert.equal(options.servername, 'example.com');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.checkServerIdentity, checkServerIdentity);
  assert.equal(options.agent, false);
  assert.equal(options.port, 443);
  assert.equal(options.path, '/article?q=hello');
  assert.equal(options.method, 'GET');
  assert.equal(options.maxHeaderSize, 16 * 1024);
  assert.deepEqual(options.headers, { accept: 'text/html, text/plain, application/xhtml+xml', 'accept-encoding': 'identity', 'user-agent': 'Claudia-PublicWeb/1.0', connection: 'close' });
  assert.deepEqual(endArgs, []);
  assert.equal(options.auth, undefined);
  assert.ok(!JSON.stringify(options).includes('secret'));
  assert.equal(request.destroyed, true);
});

test('HTTP 只使用端口 80 的直连 GET', async t => {
  const f = fixture(t, { headers: { 'content-type': 'text/plain' }, body: '正文 <script>只是文本</script>' });
  assert.deepEqual(await fetchPublic('http://example.com:80'), { url: 'http://example.com/', text: '正文 <script>只是文本</script>', publishedAt: null });
  assert.equal(f.calls[0].protocol, 'http:');
  assert.equal(f.calls[0].options.port, 80);
  assert.equal(f.calls[0].options.servername, undefined);
});

for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) test(`HTTP ${status} 明确拒绝重定向且销毁连接`, async t => {
  const f = fixture(t, { status, headers: { location: 'http://secret@127.0.0.1/admin', 'set-cookie': 'secret-cookie' } });
  await assert.rejects(fetchPublic(URL), safe(/^不允许抓取重定向网页，请重新搜索目标地址。$/));
  assert.equal(f.calls.length, 1);
  assert.equal(f.resolutions.length, 1);
  assert.equal(f.calls[0].request.destroyed, true);
  assert.equal(f.calls[0].response.destroyed, true);
});

for (const status of [401, 403, 404, 500]) test(`HTTP ${status} 不暴露错误正文`, async t => {
  fixture(t, { status, body: 'secret-error-body' });
  await assert.rejects(fetchPublic(URL), safe(/^网页未返回成功响应。$/));
});

for (const headers of [
  {}, { 'content-type': 'application/json' }, { 'content-type': 'image/svg+xml' },
  { 'content-type': ['text/html', 'text/plain'] }, { 'content-type': 'text/html-secret' },
]) test(`拒绝不支持的内容类型：${JSON.stringify(headers)}`, async t => {
  const f = fixture(t, { headers });
  await assert.rejects(fetchPublic(URL), safe(/内容类型不受支持/));
  assert.equal(f.calls[0].response.destroyed, true);
});

for (const encoding of ['gzip', 'br', 'deflate', 'identity, gzip', '', ['identity']]) test(`拒绝内容编码：${JSON.stringify(encoding)}`, async t => {
  fixture(t, { headers: { 'content-type': 'text/html', 'content-encoding': encoding } });
  await assert.rejects(fetchPublic(URL), safe(/内容编码不受支持/));
});

for (const charset of ['gbk', 'utf-16', 'iso-8859-1', 'utf-8; charset=utf-8', 'utf-8; broken']) test(`拒绝不支持或歧义字符集：${charset}`, async t => {
  fixture(t, { headers: { 'content-type': 'text/html; charset=' + charset } });
  await assert.rejects(fetchPublic(URL), safe(/内容编码不受支持/));
});

test('允许 XHTML、大小写与引号 charset、identity', async t => {
  fixture(t, { headers: { 'content-type': 'Application/XHTML+XML; charset="UTF-8"', 'content-encoding': 'identity' }, body: '<p>可读内容</p>' });
  assert.equal((await fetchPublic(URL)).text, '可读内容');
});

test('UTF-8 跨 chunk 正确解码', async t => {
  const bytes = Buffer.from('<p>中文</p>');
  fixture(t, { chunks: [bytes.subarray(0, 4), bytes.subarray(4, 6), bytes.subarray(6)] });
  assert.equal((await fetchPublic(URL)).text, '中文');
});

test('非法 UTF-8 和伪装 ASCII 被拒绝', async t => {
  fixture(t, { chunks: [Buffer.from([0xff, 0xfe, 0x61, 0x00])] });
  await assert.rejects(fetchPublic(URL), safe(/内容编码不受支持/));
});

test('声明 ASCII 时拒绝非 ASCII 字节', async t => {
  fixture(t, { headers: { 'content-type': 'text/plain; charset=us-ascii' }, body: '中文' });
  await assert.rejects(fetchPublic(URL), safe(/内容编码不受支持/));
});

test('声明超大 Content-Length 在读取正文前拒绝', async t => {
  const f = fixture(t, { headers: { 'content-type': 'text/plain', 'content-length': String(MAX_BYTES + 1) }, holdBody: true });
  await assert.rejects(fetchPublic(URL), safe(/超过大小限制/));
  assert.equal(f.calls[0].response.destroyed, true);
});

for (const chunks of [[Buffer.alloc(MAX_BYTES + 1)], [Buffer.alloc(MAX_BYTES), Buffer.alloc(1)], Array.from({ length: 9 }, () => Buffer.alloc(64 * 1024))]) {
  test(`流式字节上限：${chunks.length} 个 chunk 超限立即销毁`, async t => {
    const f = fixture(t, { chunks, headers: { 'content-type': 'text/plain' } });
    await assert.rejects(fetchPublic(URL), safe(/超过大小限制/));
    assert.equal(f.calls[0].request.destroyed, true);
    assert.equal(f.calls[0].response.destroyed, true);
  });
}

test('精确 512KB 允许，但文本最多 12000 字符', async t => {
  fixture(t, { chunks: [Buffer.alloc(MAX_BYTES, 'a')], headers: { 'content-type': 'text/plain', 'content-length': String(MAX_BYTES) } });
  assert.equal((await fetchPublic(URL)).text, 'a'.repeat(12_000));
});

test('限制按字节而不是字符计算', async t => {
  fixture(t, { body: '中'.repeat(Math.ceil(MAX_BYTES / 3)), headers: { 'content-type': 'text/plain' } });
  await assert.rejects(fetchPublic(URL), safe(/超过大小限制/));
});

test('预先 abort 不发 DNS，不透传取消 reason', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('secret-abort-reason'));
  await assert.rejects(fetchPublic(URL, { signal: controller.signal }), safe(/^网页读取已取消。$/));
  assert.equal(f.resolutions.length, 0);
});

test('DNS 期间 abort 立即结束，迟到 DNS 回调不能启动请求', async t => {
  const f = fixture(t, { holdDNS: true });
  const controller = new AbortController();
  const pending = fetchPublic(URL, { signal: controller.signal });
  const rejected = assert.rejects(pending, safe(/已取消/));
  await f.dnsReady;
  controller.abort('secret-reason');
  await rejected;
  f.resolutions[0].callback(null, PUBLIC);
  await tick();
  assert.equal(f.calls.length, 0);
});

test('连接期间 abort 销毁 request，迟到 response 也销毁', async t => {
  const f = fixture(t, { holdRequest: true });
  const controller = new AbortController();
  const pending = fetchPublic(URL, { signal: controller.signal });
  const rejected = assert.rejects(pending, safe(/已取消/));
  const call = await f.requestReady;
  controller.abort();
  await rejected;
  assert.equal(call.request.destroyed, true);
  const response = f.send(call);
  assert.equal(response.destroyed, true);
  call.request.emit('error', Error('secret-late-error'));
  response.emit('error', Error('secret-late-error'));
});

test('正文流期间 abort 销毁双端并停止后续数据', async t => {
  const f = fixture(t, { holdBody: true });
  const controller = new AbortController();
  const pending = fetchPublic(URL, { signal: controller.signal });
  const rejected = assert.rejects(pending, safe(/已取消/));
  const call = await f.responseReady;
  call.response.write(Buffer.from('<p>部分正文'));
  controller.abort(new Error('secret-abort'));
  await rejected;
  assert.equal(call.request.destroyed, true);
  assert.equal(call.response.destroyed, true);
  call.response.emit('data', Buffer.alloc(MAX_BYTES + 1));
  call.response.emit('end');
});

for (const phase of ['DNS', '连接', '正文']) test(`总超时涵盖${phase}且不因进度延长`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { holdDNS: phase === 'DNS', holdRequest: phase === '连接', holdBody: phase === '正文' });
  const pending = fetchPublic(URL);
  const rejected = assert.rejects(pending, safe(/^网页读取超时。$/));
  if (phase === 'DNS') await f.dnsReady;
  else if (phase === '连接') await f.requestReady;
  else await f.responseReady;
  t.mock.timers.tick(14_999);
  if (phase === '正文') f.calls[0].response.write(Buffer.from('仍在传输'));
  t.mock.timers.tick(1);
  await rejected;
  if (phase === 'DNS') { f.resolutions[0].callback(null, PUBLIC); assert.equal(f.calls.length, 0); }
  else assert.equal(f.calls[0].request.destroyed, true);
  if (phase === '正文') assert.equal(f.calls[0].response.destroyed, true);
});

for (const config of [{ dnsError: new Error('secret-dns') }, { dnsThrow: true }, { requestThrow: true }, { requestError: true }]) {
  test(`底层异常固定脱敏：${Object.keys(config)[0]}`, async t => {
    fixture(t, config);
    await assert.rejects(fetchPublic(URL), safe(/^(?:网页域名解析失败|网页读取失败)。$/));
  });
}

for (const event of ['error', 'aborted', 'close']) test(`响应流 ${event} 提前结束时拒绝残缺正文`, async t => {
  const f = fixture(t, { holdBody: true });
  const pending = fetchPublic(URL);
  const rejected = assert.rejects(pending, safe(/^网页读取失败。$/));
  const call = await f.responseReady;
  call.response.write(Buffer.from('<p>不完整'));
  call.response.emit(event, new Error('secret-response-error'));
  await rejected;
  assert.equal(call.response.destroyed, true);
  assert.equal(call.request.destroyed, true);
});

test('HTML 剔除 script/style/嵌套 nav/注释，解码实体且不执行脚本', async t => {
  fixture(t, { body: '<style>秘密样式</style><nav>菜单<nav>二级</nav>仍是菜单</nav><script>throw Error("secret");</script><!--秘密注释--><h1>标题</h1><p>A &amp; B &#x4E2D; &#25991; &nbsp; 正文</p>' });
  assert.deepEqual(await fetchPublic(URL), { url: URL, text: '标题 A & B 中 文 正文', publishedAt: null });
});

test('HTML 不闭合脚本不泄露脚本正文，长文本和恶意标签处理有界', async t => {
  const f = fixture(t, { holdRequest: true });
  for (const [body, expected] of [
    ['<p>正文</p><script>secret', '正文'],
    ['<p>' + '文'.repeat(20_000) + '</p>', '文'.repeat(12_000)],
    ['<script "'.repeat(30_000), null],
  ]) {
    const pending = fetchPublic(URL);
    await tick();
    f.send(f.calls.at(-1), { body, holdRequest: false });
    const result = await pending;
    assert.ok(result.text.length <= 12_000);
    if (expected !== null) assert.equal(result.text, expected);
  }
});

const metadataCases = [
  ['article meta', '<meta property="article:published_time" content="2026-09-18T09:30:00+08:00">', '2026-09-18T01:30:00.000Z'],
  ['meta 属性顺序和单引号', "<META content='2026-09-18' property='article:published_time'>", '2026-09-18T00:00:00.000Z'],
  ['meta 微数据', '<meta itemprop="datePublished" content="2026-09-17">', '2026-09-17T00:00:00.000Z'],
  ['命名 meta', '<meta name="datePublished" content="2026-09-17">', '2026-09-17T00:00:00.000Z'],
  ['JSON-LD', '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-09-18T01:30:00Z"}</script>', '2026-09-18T01:30:00.000Z'],
  ['JSON-LD 图', '<script type="application/ld+json">{"@graph":[{"@type":"Organization","datePublished":"2000-01-01"},{"@type":"Article","datePublished":"2026-09-18"}]}</script>', '2026-09-18T00:00:00.000Z'],
  ['JSON-LD 主体', '<script type="application/ld+json">{"@type":"WebPage","mainEntity":{"@type":"BlogPosting","datePublished":"2026-09-18"}}</script>', '2026-09-18T00:00:00.000Z'],
  ['无类型 JSON-LD', '<script type="application/ld+json">{"datePublished":"2026-09-18"}</script>', '2026-09-18T00:00:00.000Z'],
  ['time 微数据', '<article><time itemprop="datePublished" datetime="2026-09-18T10:00:00+08:00">发布</time></article>', '2026-09-18T02:00:00.000Z'],
  ['time pubdate', '<time pubdate datetime="2026-09-18">发布</time>', '2026-09-18T00:00:00.000Z'],
  ['过去日期交给主代理过滤', '<meta property="article:published_time" content="2000-01-01">', '2000-01-01T00:00:00.000Z'],
  ['缺少元数据', '<p>2026-09-18 是正文中的日期</p>', null],
  ['仅修改时间', '<meta property="article:modified_time" content="2026-09-18"><script type="application/ld+json">{"dateModified":"2026-09-18"}</script>', null],
  ['无明确语义的 time', '<article><time datetime="2026-09-18">活动时间</time></article>', null],
  ['无时区时间', '<meta property="article:published_time" content="2026-09-18T12:00:00">', null],
  ['不可能日期', '<meta property="article:published_time" content="2026-02-30">', null],
  ['非法时区', '<meta property="article:published_time" content="2026-09-18T12:00:00+14:30">', null],
  ['坏 JSON', '<script type="application/ld+json">{"datePublished":</script>', null],
  ['普通 JS', '<script>var data={"datePublished":"2026-09-18"};</script>', null],
  ['事件并非文章', '<script type="application/ld+json">{"@type":"Event","datePublished":"2026-09-18"}</script>', null],
  ['任意嵌套评论', '<script type="application/ld+json">{"comments":[{"datePublished":"2026-09-18"}]}</script>', null],
  ['导航元数据', '<nav><meta property="article:published_time" content="2026-09-18"></nav>', null],
  ['注释元数据', '<!-- <meta property="article:published_time" content="2026-09-18"> -->', null],
  ['重复属性', '<meta property="article:published_time" content="2026-09-18" content="2026-09-17">', null],
  ['冲突日期不猜测', '<meta property="article:published_time" content="2026-09-18"><meta itemprop="datePublished" content="2026-09-17">', null],
  ['一致日期去重', '<meta property="article:published_time" content="2026-09-18T08:00:00+08:00"><meta itemprop="datePublished" content="2026-09-18T00:00:00Z">', '2026-09-18T00:00:00.000Z'],
];
for (const [name, body, expected] of metadataCases) test(`发布时间：${name}`, async t => {
  fixture(t, { body: body + '<p>正文</p>', headers: { 'content-type': 'text/html', 'last-modified': 'Fri, 18 Sep 2026 00:00:00 GMT', date: 'Fri, 18 Sep 2026 00:00:00 GMT' } });
  assert.equal((await fetchPublic(URL)).publishedAt, expected);
});

for (const length of ['-1', '1e6', '1, 2', ['1'], '9007199254740993']) test(`畸形或超大 Content-Length：${JSON.stringify(length)}`, async t => {
  fixture(t, { headers: { 'content-type': 'text/plain', 'content-length': length } });
  await assert.rejects(fetchPublic(URL), safe(/超过大小限制/));
});

test('DNS、连接和正文共用同一个 15 秒 deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { holdDNS: true, holdRequest: true, holdBody: true });
  const pending = fetchPublic(URL);
  const rejected = assert.rejects(pending, safe(/读取超时/));
  t.mock.timers.tick(5000);
  f.resolutions[0].callback(null, PUBLIC);
  const call = await f.requestReady;
  t.mock.timers.tick(5000);
  f.send(call);
  t.mock.timers.tick(4999);
  call.response.write(Buffer.from('持续输入'));
  assert.equal(call.request.destroyed, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(call.request.destroyed, true);
  assert.equal(call.response.destroyed, true);
});

test('成功后和失败后均移除 abort 监听器', async t => {
  const f = fixture(t, { holdRequest: true });
  const controller = new AbortController();
  for (const status of [200, 302]) {
    const pending = fetchPublic(URL, { signal: controller.signal });
    const result = status === 200 ? pending : assert.rejects(pending, safe(/重定向/));
    await tick();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    f.send(f.calls.at(-1), { status });
    await result;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  controller.abort(new Error('secret-late-abort'));
});

test('连接未返回 response 就关闭时立即失败', async t => {
  const f = fixture(t, { holdRequest: true });
  const pending = fetchPublic(URL);
  const rejected = assert.rejects(pending, safe(/^网页读取失败。$/));
  const call = await f.requestReady;
  call.request.emit('close');
  await rejected;
  assert.equal(call.request.destroyed, true);
});

test('发布时间 JSON 大小受限，深嵌套不递归溢出', async t => {
  const f = fixture(t, { holdRequest: true });
  for (const json of [
    JSON.stringify({ datePublished: '2026-09-18', filler: 'x'.repeat(64 * 1024) }),
    '{"mainEntity":'.repeat(4000) + '{"datePublished":"2026-09-18"}' + '}'.repeat(4000),
  ]) {
    const pending = fetchPublic(URL);
    await tick();
    f.send(f.calls.at(-1), { body: '<script type="application/ld+json">' + json + '</script><p>正文</p>' });
    assert.deepEqual(await pending, { url: URL, text: '正文', publishedAt: null });
  }
});

test('纯文本里的伪元数据及响应头不能作为发布时间', async t => {
  fixture(t, { body: '<meta property="article:published_time" content="2026-09-18">', headers: { 'content-type': 'text/plain', 'last-modified': 'Fri, 18 Sep 2026 00:00:00 GMT' } });
  assert.equal((await fetchPublic(URL)).publishedAt, null);
});
