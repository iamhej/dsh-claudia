import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;
const messages = Object.freeze({
  url: '网页地址不符合公开网页安全要求。',
  dns: '网页域名解析失败。',
  address: '网页域名包含非公开或无效地址。',
  redirect: '不允许抓取重定向网页，请重新搜索目标地址。',
  status: '网页未返回成功响应。',
  type: '网页内容类型不受支持。',
  encoding: '网页内容编码不受支持。',
  size: '网页内容超过大小限制。',
  abort: '网页读取已取消。',
  timeout: '网页读取超时。',
  network: '网页读取失败。',
});
class PublicWebError extends Error {
  constructor(kind) { super(messages[kind]); this.kind = kind; this.routineSafe = true; }
}

export function publicURL(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048 ||
        !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value)) throw 0;
    const url = new URL(value);
    // URL 会规范化空 userinfo、数字式 IPv4 和默认端口；同时检查原始 authority。
    const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/, 1)[0];
    if (authority.includes('@') || url.username || url.password || url.port ||
        !['http:', 'https:'].includes(url.protocol)) throw 0;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (isIP(host) || host.includes(':') || host.includes('[') || host.length > 253 ||
        !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
        !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw 0;
    url.hostname = host;
    url.hash = '';
    if (url.href.length > 2048) throw 0;
    return url.href;
  } catch { throw new PublicWebError('url'); }
}

function ipv4Number(address) {
  return address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}
const blockedV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([address, bits]) => [ipv4Number(address), 2 ** (32 - bits)]);

function ipv6Number(address) {
  const [left, right] = address.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const words = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  return BigInt('0x' + words.map(word => word.padStart(4, '0')).join(''));
}
const blockedV6 = [
  ['2001::', 23], // IETF 特殊用途，包括 Teredo、基准测试和 ORCHID。
  ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3ffe::', 16], ['3fff::', 20],
].map(([address, bits]) => [ipv6Number(address), BigInt(128 - bits)]);

export function publicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const n = ipv4Number(address);
    return !blockedV4.some(([base, size]) => Math.floor(n / size) === Math.floor(base / size));
  }
  // 仅接受全球单播 2000::/3；映射、NAT64、兼容地址及其他特殊前缀均关闭。
  if (family !== 6 || address.includes('.')) return false;
  const n = ipv6Number(address);
  const interfacePrefix = Number((n >> 32n) & 0xffffffffn);
  if (interfacePrefix === 0x00005efe || interfacePrefix === 0x02005efe) return false;
  return n >> 125n === 1n && !blockedV6.some(([base, shift]) => n >> shift === base >> shift);
}

function entities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    const key = entity.toLowerCase();
    if (key[0] !== '#') return named[key];
    const n = key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
  });
}

function publicationDate(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const date = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2}))?$/i.exec(date);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() ||
      Number(hour || 0) > 23 || Number(minute || 0) > 59 || Number(second || 0) > 59) return null;
  if (zone && zone.toUpperCase() !== 'Z') {
    const offset = zone.slice(1).replace(':', '');
    if (Number(offset.slice(0, 2)) > 14 || Number(offset.slice(2)) > 59 ||
        (Number(offset.slice(0, 2)) === 14 && Number(offset.slice(2)) !== 0)) return null;
  }
  const timestamp = Date.parse(date.replace(' ', 'T'));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function attributes(source) {
  const result = Object.create(null);
  const pattern = /([^\s=<>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const key = match[1].toLowerCase();
    // 重复属性存在歧义，不让它成为发布时间证据。
    if (Object.hasOwn(result, key)) result[key] = null;
    else result[key] = entities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function jsonDates(source, add) {
  if (source.length > 64 * 1024) return;
  let root;
  try { root = JSON.parse(source); } catch { return; }
  const queue = [root];
  for (let i = 0; i < queue.length && i < 256; i++) {
    const item = queue[i];
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { queue.push(...item.slice(0, 256)); continue; }
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    if (!item['@type'] || types.some(type => typeof type === 'string' && /^(?:Article|NewsArticle|BlogPosting|ScholarlyArticle|TechArticle)$/.test(type))) {
      add(item.datePublished);
    }
    // 只走明确的页面主体和 JSON-LD 图，不从评论、事件或任意嵌套示例猜日期。
    if (item['@graph']) queue.push(item['@graph']);
    if (item.mainEntity) queue.push(item.mainEntity);
  }
}

function htmlText(source) {
  const parts = [], dates = new Set();
  const add = value => { const date = publicationDate(value); if (date) dates.add(date); };
  let pos = 0, navDepth = 0;
  while (pos < source.length) {
    const start = source.indexOf('<', pos);
    if (start < 0) { if (!navDepth) parts.push(source.slice(pos)); break; }
    if (!navDepth) parts.push(source.slice(pos, start));
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      pos = end < 0 ? source.length : end + 3;
      continue;
    }
    if (!/^<\/?[a-z!]/i.test(source.slice(start, start + 3))) {
      if (!navDepth) parts.push('<');
      pos = start + 1;
      continue;
    }
    // 单调前进，单标签最多扫描 4096 字符，避免恶意未闭合标签的回溯。
    let end = start + 1, quote = '';
    const limit = Math.min(source.length, start + 4096);
    for (; end < limit; end++) {
      const ch = source[end];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    pos = end < limit ? end + 1 : limit;
    if (end === limit) continue;
    const tag = /^<(\/?)([a-z][a-z0-9:-]*)\b([\s\S]*)>$/i.exec(source.slice(start, pos));
    if (!tag) continue;
    const closing = Boolean(tag[1]), name = tag[2].toLowerCase();
    if (!closing && (name === 'script' || name === 'style')) {
      const close = new RegExp('</' + name + '\\s*>', 'ig');
      close.lastIndex = pos;
      const match = close.exec(source);
      if (name === 'script' && !navDepth && match &&
          attributes(tag[3]).type?.toLowerCase() === 'application/ld+json') jsonDates(source.slice(pos, match.index), add);
      pos = match ? close.lastIndex : source.length;
      continue;
    }
    if (name === 'nav') { navDepth = Math.max(0, navDepth + (closing ? -1 : 1)); continue; }
    if (navDepth || closing) continue;
    if (name === 'meta' || name === 'time') {
      const attrs = attributes(tag[3]);
      const published = (attrs.itemprop || '').toLowerCase().split(/\s+/).includes('datepublished');
      if (name === 'meta' && (published ||
          [attrs.property, attrs.name].some(value => ['article:published_time', 'datepublished'].includes(value?.toLowerCase())))) add(attrs.content);
      if (name === 'time' && (published || attrs.pubdate === '')) add(attrs.datetime);
    }
  }
  return {
    text: entities(parts.join(' ')).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12_000),
    publishedAt: dates.size === 1 ? [...dates][0] : null,
  };
}

function responseType(headers) {
  const encoding = headers['content-encoding'];
  if (encoding !== undefined && (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'identity')) throw new PublicWebError('encoding');
  if (typeof headers['content-type'] !== 'string') throw new PublicWebError('type');
  const [type, ...params] = headers['content-type'].split(';');
  const mime = type.trim().toLowerCase();
  if (!['text/html', 'text/plain', 'application/xhtml+xml'].includes(mime)) throw new PublicWebError('type');
  let charset;
  for (const param of params) {
    const match = /^\s*([a-z0-9!#$&^_.+-]+)\s*=\s*(?:"([^"]*)"|([^\s;"]+))\s*$/i.exec(param);
    if (!match) throw new PublicWebError('encoding');
    if (match[1].toLowerCase() === 'charset') {
      if (charset !== undefined) throw new PublicWebError('encoding');
      charset = (match[2] ?? match[3]).toLowerCase();
      if (!['utf-8', 'utf8', 'us-ascii'].includes(charset)) throw new PublicWebError('encoding');
    }
  }
  const length = headers['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new PublicWebError('size');
  return { mime, charset };
}

// 仅宿主 Node 模块可调用；公开入口不接收 lookup、request、headers 或代理配置。
// 搜索结果 URL 白名单和七日过滤属于主代理，不在这个底层读取器中猜测。
export async function fetchPublic(value, options = {}) {
  try {
    const href = publicURL(value), target = new URL(href);
    const { signal } = options;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new PublicWebError('abort');
    if (signal?.aborted) throw new PublicWebError('abort');
    return await new Promise((resolve, reject) => {
      let settled = false, request, response, ended = false, received = 0;
      const chunks = [];
      const finish = (kind, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        response?.destroy();
        request?.destroy();
        chunks.length = 0;
        if (kind) reject(new PublicWebError(kind));
        else resolve(result);
      };
      const abort = () => finish('abort');
      const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      const onResponse = incoming => {
        incoming.on('error', () => finish('network'));
        if (settled) { incoming.destroy(); return; }
        response = incoming;
        incoming.on('aborted', () => finish('network'));
        incoming.on('close', () => { if (!ended) finish('network'); });
        if (incoming.statusCode >= 300 && incoming.statusCode < 400) { finish('redirect'); return; }
        if (!(incoming.statusCode >= 200 && incoming.statusCode < 300)) { finish('status'); return; }
        let type;
        try { type = responseType(incoming.headers); }
        catch (error) { finish(error instanceof PublicWebError ? error.kind : 'network'); return; }
        incoming.on('data', chunk => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk)) { finish('network'); return; }
          if (chunk.length > MAX_BYTES - received) { finish('size'); return; }
          received += chunk.length;
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (settled) return;
          ended = true;
          let text;
          try {
            const bytes = Buffer.concat(chunks, received);
            if (type.charset === 'us-ascii' && bytes.some(byte => byte > 127)) throw 0;
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch { finish('encoding'); return; }
          try {
            const content = type.mime === 'text/plain' ? { text: text.slice(0, 12_000), publishedAt: null } : htmlText(text);
            finish(null, { url: href, ...content });
          } catch { finish('network'); }
        });
      };
      try {
        dns.lookup(target.hostname, { all: true, verbatim: true }, (error, records) => {
          if (settled) return;
          if (error) { finish('dns'); return; }
          if (!Array.isArray(records) || !records.length || records.length > 64 ||
              !records.every(record => record && publicAddress(record.address) && isIP(record.address) === record.family)) { finish('address'); return; }
          // 复制已验证值；后续 lookup 永不重新解析，杜绝检查和连接之间的 DNS rebinding。
          const { address, family } = records[0];
          const lookup = (hostname, opts, callback) => {
            if (typeof opts === 'function') { callback = opts; opts = {}; }
            queueMicrotask(() => {
              if (hostname !== target.hostname || settled) { callback(new PublicWebError('address')); return; }
              if (opts?.all) callback(null, [{ address, family }]);
              else callback(null, address, family);
            });
          };
          const secure = target.protocol === 'https:';
          try {
            request = (secure ? https : http).request({
              protocol: target.protocol,
              hostname: target.hostname,
              port: secure ? 443 : 80,
              path: target.pathname + target.search,
              method: 'GET',
              agent: false,
              family,
              autoSelectFamily: false,
              lookup,
              maxHeaderSize: 16 * 1024,
              insecureHTTPParser: false,
              headers: {
                accept: 'text/html, text/plain, application/xhtml+xml',
                'accept-encoding': 'identity',
                'user-agent': 'Claudia-PublicWeb/1.0',
                connection: 'close',
              },
              ...(secure ? { servername: target.hostname, rejectUnauthorized: true, checkServerIdentity } : {}),
            }, onResponse);
            request.on('error', () => finish('network'));
            request.on('close', () => { if (!ended) finish('network'); });
            if (settled) { request.destroy(); return; }
            request.end();
          } catch { finish('network'); }
        });
      } catch { finish('dns'); }
    });
  } catch (error) {
    if (error instanceof PublicWebError) throw error;
    throw new PublicWebError('network');
  }
}
