import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { Logger, dayKey, observeProcess, redact } from '../logger.mjs';

// 日志功能本身要真实删除文件（过期清理），临时目录放系统 tmp 而不是项目 tests/，
// 既能自清理、不往仓库里堆 data-* 目录，也避免受项目目录的写入限制影响。
const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-logger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const at = text => new Date(text);

test('只写事件与标量字段，对象数组和控制字符不会进入日志', t => {
  const dir = fixture(t);
  const log = new Logger(dir, { now: () => at('2026-09-17T03:08:55.687') });
  log.info('host.ready', { port: 4318, version: '0.3.2-local.1', ok: true });
  log.info('drop.fields', { nested: { a: 1 }, list: [1, 2], fn: () => {}, blank: '' });
  log.warn('flatten', { note: 'line one\nline two\ttab' });
  log.info('bad name', { a: 1 });
  log.event('trace', 'host.ready', {});
  log.close();
  const lines = readFileSync(join(dir, 'logs', '2026-09-17.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^2026-09-17T03:08:55\.687\+\d{2}:\d{2} INFO {2}host\.ready +port=4318 version=0\.3\.2-local\.1 ok=true$/);
  // 非标量字段整体丢弃，事件名保留，便于看出“发生过但无附加字段”。
  assert.match(lines[1], /INFO {2}drop\.fields$/);
  assert.doesNotMatch(lines[1], /nested|list|fn|blank/);
  // 一个事件恒为一行，换行与制表符必须被压平。
  assert.match(lines[2], /WARN {2}flatten +note="line one line two tab"$/);
  assert.equal(lines.filter(line => line.includes('\n')).length, 0);
});

test('凭据样式在写入前被掩码', t => {
  const dir = fixture(t);
  const log = new Logger(dir, { now: () => at('2026-09-17T04:00:00.000') });
  const secret = 'sk-' + 'A1b2C3d4E5f6G7h8';
  const opaque = 'zzTOKENvalue123';
  log.error('model.call', { error: new Error(`rejected ${secret}`) });
  log.error('http.call', { detail: `Authorization: Bearer ${opaque}` });
  log.error('cfg.read', { detail: `api_key=${secret} password="${opaque}"` });
  log.close();
  const text = readFileSync(join(dir, 'logs', '2026-09-17.log'), 'utf8');
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(opaque), false);
  assert.equal((text.match(/\*\*\*/g) ?? []).length >= 3, true);
  // 事件本身仍要可读，掩码不能把整行吃掉。
  assert.match(text, /ERROR model\.call/);
  // SHA256 之类的非机密十六进制不应被误伤。
  assert.equal(redact('sha=b049e705e1b0f23e4a82cce2af488d551d61f304'), 'sha=b049e705e1b0f23e4a82cce2af488d551d61f304');
});

test('达到单日上限后停止写入并留下一条说明', t => {
  const dir = fixture(t);
  const log = new Logger(dir, { maxBytesPerDay: 260, now: () => at('2026-09-17T05:00:00.000') });
  for (let i = 0; i < 20; i++) log.info('bulk.event', { index: i });
  log.close();
  const lines = readFileSync(join(dir, 'logs', '2026-09-17.log'), 'utf8').trim().split('\n');
  assert.equal(lines.filter(line => line.includes('logger.capped')).length, 1);
  assert.equal(lines.at(-1).includes('logger.capped'), true);
  assert.equal(log.status().capped, true);
  // 上限之后的事件确实被丢弃，而不是继续无限增长。
  assert.equal(lines.filter(line => line.includes('bulk.event')).length < 20, true);
});

test('保留期清理只删除精确命名的过期日志', t => {
  const dir = fixture(t);
  const logs = join(dir, 'logs');
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  for (const name of ['2026-09-01.log', '2026-09-16.log', 'notes.txt', '2026-09-02.log.bak', 'activity.jsonl']) writeFileSync(join(logs, name), 'x');
  const log = new Logger(dir, { retainDays: 3, now: () => at('2026-09-17T06:00:00.000') });
  log.info('sweep.trigger', {});
  log.close();
  const remaining = readdirSync(logs).sort();
  assert.equal(remaining.includes('2026-09-01.log'), false);
  assert.deepEqual(remaining, ['2026-09-02.log.bak', '2026-09-16.log', '2026-09-17.log', 'activity.jsonl', 'notes.txt']);
});

test('recent 跨昨天与今天读回并限制行数', t => {
  const dir = fixture(t);
  let clock = at('2026-09-16T23:59:00.000');
  const log = new Logger(dir, { now: () => clock });
  log.info('yesterday.one', {}); log.info('yesterday.two', {});
  clock = at('2026-09-17T00:01:00.000');
  log.info('today.one', {});
  log.close();
  // 跨日必须换文件，而不是继续写进前一天。
  assert.deepEqual(readdirSync(join(dir, 'logs')).sort(), ['2026-09-16.log', '2026-09-17.log']);
  const recent = log.recent(10);
  assert.equal(recent.length, 3);
  assert.match(recent[0], /yesterday\.one/);
  assert.match(recent.at(-1), /today\.one/);
  assert.equal(log.recent(1).length, 1);
  assert.match(log.recent(1)[0], /today\.one/);
});

test('写入失败不抛错，只记录在状态里', t => {
  const dir = fixture(t);
  // 把 logs 占成普通文件，令建目录失败。
  writeFileSync(join(dir, 'logs'), 'occupied');
  const log = new Logger(dir, { now: () => at('2026-09-17T07:00:00.000') });
  assert.equal(log.info('host.ready', { port: 4318 }), false);
  assert.equal(log.status().error === '', false);
  assert.doesNotThrow(() => log.warn('still.safe', {}));
  log.close();
});

test('recent 跳过被替换成 symlink 的日志文件', t => {
  const dir = fixture(t);
  const logs = join(dir, 'logs');
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, 'secret-outside-content\n');
  symlinkSync(outside, join(logs, `${dayKey(at('2026-09-16T00:00:00.000'))}.log`));
  const log = new Logger(dir, { now: () => at('2026-09-17T08:00:00.000') });
  log.info('today.only', {});
  log.close();
  const recent = log.recent(50);
  assert.equal(recent.some(line => line.includes('secret-outside-content')), false);
  assert.equal(recent.length, 1);
  assert.match(recent[0], /today\.only/);
});

// 用替身 proc 验证信号语义：Node 一旦有同名监听就接管默认终止行为，
// 所以“唯一监听者”必须摘掉自己并重新发信号，否则宿主会变得杀不掉。
const fakeProc = () => {
  const emitter = new EventEmitter();
  const proc = {
    pid: 4242, killed: [],
    on: (...a) => emitter.on(...a), off: (...a) => emitter.off(...a),
    removeListener: (...a) => emitter.removeListener(...a),
    listenerCount: name => emitter.listenerCount(name),
    kill(pid, signal) { proc.killed.push({ pid, signal }); emitter.emit(signal); },
    emit: (...a) => emitter.emit(...a),
  };
  return proc;
};
const recorder = () => {
  const seen = [];
  const push = level => (name, fields) => { seen.push({ level, name, fields }); return true; };
  return { seen, info: push('info'), warn: push('warn'), error: push('error'), event: () => true };
};

test('唯一监听者收到信号后摘掉自己并重新发信号，把终止语义还回去', () => {
  const proc = fakeProc(), logger = recorder();
  observeProcess({ logger, proc, uptimeSec: () => 7 });
  assert.equal(proc.listenerCount('SIGTERM'), 1);
  proc.emit('SIGTERM');
  assert.deepEqual(logger.seen.map(e => [e.level, e.name]), [['warn', 'host.signal']]);
  assert.equal(logger.seen[0].fields.signal, 'SIGTERM');
  assert.equal(logger.seen[0].fields.uptimeSec, 7);
  // 摘掉自己后重新 kill，且不再因为自己的重发而二次记录。
  assert.deepEqual(proc.killed, [{ pid: 4242, signal: 'SIGTERM' }]);
  assert.equal(proc.listenerCount('SIGTERM'), 0);
  assert.equal(logger.seen.length, 1);
});

test('宿主已有同名监听时只旁观，不重新发信号也不摘除宿主监听', () => {
  const proc = fakeProc(), logger = recorder();
  let hostHandled = 0;
  proc.on('SIGTERM', () => { hostHandled++; });
  observeProcess({ logger, proc });
  assert.equal(proc.listenerCount('SIGTERM'), 2);
  proc.emit('SIGTERM');
  assert.equal(hostHandled, 1);
  assert.deepEqual(proc.killed, [], '宿主已接管时不得重新发信号');
  assert.equal(proc.listenerCount('SIGTERM'), 2, '不得摘除宿主的监听');
  assert.equal(logger.seen.length, 1);
});

test('解除函数摘掉全部监听，之后信号与退出都不再记录', () => {
  const proc = fakeProc(), logger = recorder();
  const detach = observeProcess({ logger, proc });
  detach();
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit', 'uncaughtExceptionMonitor']) {
    assert.equal(proc.listenerCount(name), 0, name);
  }
  proc.emit('SIGTERM'); proc.emit('exit', 0);
  assert.deepEqual(logger.seen, []);
});

test('真实子进程：SIGTERM 会落下 host.signal 且进程确实退出', { timeout: 20_000 }, async t => {
  const dir = fixture(t);
  const script = join(dir, 'child.mjs');
  const loggerUrl = new URL('../logger.mjs', import.meta.url).href;
  writeFileSync(script, `
import { Logger, observeProcess } from ${JSON.stringify(loggerUrl)};
const logger = new Logger(${JSON.stringify(dir)});
observeProcess({ logger });
logger.info('child.ready', {});
setInterval(() => {}, 1000);
`);
  const child = execFile(process.execPath, [script]);
  const logPath = join(dir, 'logs', `${dayKey(new Date())}.log`);
  // 等子进程把 ready 写进日志，再发信号，避免竞态。
  for (let i = 0; i < 100; i++) {
    try { if (readFileSync(logPath, 'utf8').includes('child.ready')) break; } catch { /* 还没创建 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const result = await exited;
  const text = readFileSync(logPath, 'utf8');
  assert.match(text, /WARN {2}host\.signal +signal=SIGTERM/, text);
  // 关键：重新发信号后进程真的死了，而不是变成杀不掉的僵持状态。
  assert.equal(result.signal, 'SIGTERM', JSON.stringify(result));
});
