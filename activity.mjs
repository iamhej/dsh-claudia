import {
  constants, lstatSync, realpathSync, mkdirSync, openSync, closeSync, fstatSync,
  fchmodSync, readFileSync, readSync, writeFileSync, fsyncSync, renameSync, unlinkSync,
} from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { noopLogger } from './logger.mjs';

const SOURCE = 'local-foreground';
const DAY = 86400000;
const owners = new Map();
const statOrNull = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

// 两个模块共用的私有文件边界；构造不访问磁盘，默认关闭时不创建目录。
export class PrivateFiles {
  constructor(dataDir, scope) {
    if (typeof dataDir !== 'string' || !dataDir || !['activity', '.runtime', '.updates'].includes(scope)) throw new Error('无效的私有数据目录');
    this.root = resolve(dataDir); this.scope = scope; this.identities = new Map();
    if (this.root === parse(this.root).root) throw new Error('不能使用文件系统根目录作为数据目录');
  }
  directory(create = true) {
    let current = parse(this.root).root;
    for (const part of this.root.slice(current.length).split('/').filter(Boolean)) {
      current = join(current, part);
      let st = statOrNull(current);
      // 只规范化 macOS 自带的两个系统别名，绝不接受用户目录中的链接。
      if (st?.isSymbolicLink() && process.platform === 'darwin' && ['/tmp', '/var'].includes(current)) {
        current = realpathSync(current); st = lstatSync(current);
      }
      if (!st && create) { mkdirSync(current, { mode: 0o700 }); st = lstatSync(current); }
      if (!st) return null;
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('拒绝符号链接或非目录');
    }
    this.root = current;
    const targets = [this.root, join(this.root, this.scope)];
    for (const path of targets) {
      let st = statOrNull(path);
      if (!st && create) { mkdirSync(path, { mode: 0o700 }); st = lstatSync(path); }
      if (!st) return null;
      if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path || st.uid !== process.getuid()) throw new Error('私有目录不安全');
      const known = this.identities.get(path);
      if (known && !same(known, st)) throw new Error('私有目录已被替换');
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!same(st, fstatSync(fd))) throw new Error('私有目录已被替换');
        if ((st.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
      } finally { closeSync(fd); }
      this.identities.set(path, st);
    }
    return targets[1];
  }
  path(name, create = true) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(name) || name.includes('..')) throw new Error('无效的私有文件名');
    const dir = this.directory(create);
    return dir ? join(dir, name) : null;
  }
  guard(path) {
    const st = statOrNull(path);
    if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid())) throw new Error('拒绝符号链接、硬链接或非普通文件');
    return st;
  }
  open(name, flags, mode = 0o600) {
    const path = this.path(name), before = this.guard(path);
    const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (before && !same(before, st))) throw new Error('私有文件已被替换');
      this.directory();
      if (!same(st, this.guard(path))) throw new Error('私有文件已被替换');
      fchmodSync(fd, mode);
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  read(name, max = 8 * 1024 * 1024) {
    const path = this.path(name, false);
    if (!path || !this.guard(path)) return null;
    const fd = this.open(name, constants.O_RDONLY);
    try {
      if (fstatSync(fd).size > max) throw new Error('私有文件超过大小限制');
      const chunks = []; let total = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(65536, max + 1 - total));
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (!count) break;
        total += count;
        if (total > max) throw new Error('私有文件超过大小限制');
        chunks.push(chunk.subarray(0, count));
      }
      return Buffer.concat(chunks);
    } finally { closeSync(fd); }
  }
  replace(name, content) {
    const path = this.path(name), before = this.guard(path);
    const temp = `tmp-${randomUUID()}`;
    const fd = this.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      this.directory();
      const after = this.guard(path);
      if (!!before !== !!after || (before && !same(before, after))) throw new Error('私有文件已被替换');
      renameSync(this.path(temp), path);
    } finally { this.remove(temp); }
  }
  remove(name) {
    const path = this.path(name, false);
    if (path && this.guard(path)) unlinkSync(path);
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('时长时间必须为 UTC ISO 字符串');
  return Date.parse(value);
}
function segment(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'bundleId,end,name,seconds,start') throw new Error('时长事件字段无效');
  for (const key of ['name', 'bundleId']) if (typeof value[key] !== 'string' || value[key].length > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value[key])) throw new Error('应用标识无效');
  if (!value.name) throw new Error('缺少应用名称');
  const start = timestamp(value.start), end = timestamp(value.end);
  if (!Number.isFinite(value.seconds) || value.seconds <= 0 || value.seconds > 10 || end <= start || Math.abs(value.seconds - (end - start) / 1000) > 0.002) throw new Error('时长 heartbeat 无效或间隔过长');
  return value;
}
function aggregate(entries, start, end) {
  const apps = new Map(); let cursor = start, seconds = 0;
  for (const entry of entries.sort((a, b) => a.start.localeCompare(b.start))) {
    const left = Math.max(start, cursor, Date.parse(entry.start)), right = Math.min(end, Date.parse(entry.end));
    if (right <= left) continue;
    const duration = (right - left) / 1000, key = JSON.stringify([entry.name, entry.bundleId]);
    const app = apps.get(key) ?? { name: entry.name, bundleId: entry.bundleId, seconds: 0 };
    app.seconds += duration; seconds += duration; cursor = right; apps.set(key, app);
  }
  return { apps: [...apps.values()].sort((a, b) => b.seconds - a.seconds), seconds, coverageSeconds: seconds, source: SOURCE };
}
const mdCell = value => value.replace(/[&<>|`\\]/g, char => `&#${char.codePointAt(0)};`);

export class ActivityTracker {
  constructor(dataDir, { logger = noopLogger } = {}) {
    this.dataDir = resolve(dataDir); this.files = new PrivateFiles(dataDir, 'activity'); this.runtimeFiles = new PrivateFiles(dataDir, '.runtime');
    this.enabled = false; this.running = false; this.error = ''; this.closed = false; this.state='disabled'; this.generation=0;
    this.child = null; this.queue = Promise.resolve(); this.stopTask = null; this.watchdog = null;
    this.lastEnd = 0; this.daily = null; this.logger = logger;
  }
  status() { return { enabled: this.enabled, running: this.running, state:this.error?'error':this.running?'running':this.state, error: this.error, source: SOURCE }; }
  setEnabled(value) {
    if (typeof value !== 'boolean') return Promise.reject(new TypeError('enabled 必须为布尔值'));
    if (this.closed && value) return Promise.reject(new Error('ActivityTracker 已关闭'));
    this.enabled = value;this.error='';const generation=++this.generation;
    this.state=value?(this.running?'running':'starting'):'stopping';
    this.queue = this.queue.catch(() => {}).then(async () => {
      if(generation!==this.generation)return this.status();
      if (!this.enabled || this.closed) await this._stop();
      else if (!this.running) {
        await this._stop();
        try { await this._start(); } catch (error) { this.error = error.message; this.running = false; await this._stop(); }
      }
      if(generation===this.generation)this.state=this.error?'error':this.running?'running':this.enabled?'starting':'disabled';
      // 只记录采集开关与组件运行状态，不记录任何应用名或时间段明细。
      if(generation===this.generation)this.logger.event(this.error?'warn':'info',value?'activity.enable':'activity.disable',{running:this.running,state:this.state,error:this.error||undefined});
      return this.status();
    });
    return this.queue;
  }
  async close() { this.closed = true; await this.setEnabled(false); }
  _spawn(command, args, options) { return spawn(command, args, options); }
  async _command(command, args, timeout = 120000) {
    return new Promise((done, reject) => {
      const child = this._spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
      child.stderr.resume();
      let failure, output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 4096) { failure = new Error('Swift binary 检测输出超过限制'); child.kill('SIGKILL'); }
      });
      const timer = setTimeout(() => { failure = new Error('Swift 编译或 binary 检测超时'); child.kill('SIGKILL'); }, timeout);
      child.once('error', () => { failure = new Error('无法执行 xcrun / Swift binary；请手动安装或修复 Command Line Tools'); });
      child.once('close', code => { clearTimeout(timer); code === 0 && !failure ? done(output) : reject(failure ?? new Error('Swift 编译或 binary 检测失败；需要可用的 Xcode Command Line Tools，不会自动安装')); });
    });
  }
  async _binary(compile) {
    if (process.platform !== 'darwin') throw new Error('前台时长仅支持 macOS');
    const source = fileURLToPath(new URL('./native/activity.swift', import.meta.url));
    const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
    const name = `foreground-${hash}-${process.arch}`;
    const path = this.runtimeFiles.path(name, compile);
    if (!path) return null;
    if (!this.runtimeFiles.guard(path)) {
      if (!compile) return null;
      const temporary = `compile-${randomUUID()}`;
      const target = this.runtimeFiles.path(temporary);
      // cache 放在同一受限目录，避免写入用户的 Swift 模块缓存。
      const cache = join(this.runtimeFiles.directory(), 'swift-cache');
      if (!statOrNull(cache)) mkdirSync(cache, { mode: 0o700 });
      const cacheStat = lstatSync(cache);
      if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || cacheStat.uid !== process.getuid() || (cacheStat.mode & 0o077)) throw new Error('Swift cache 目录不安全');
      try {
        await this._command('/usr/bin/xcrun', ['swiftc', '-module-cache-path', cache, source, '-o', target]);
        const fd = this.runtimeFiles.open(temporary, constants.O_RDONLY, 0o700); closeSync(fd);
        this.runtimeFiles.directory();
        if (this.runtimeFiles.guard(path)) this.runtimeFiles.remove(temporary);
        else renameSync(target, path);
      } finally { this.runtimeFiles.remove(temporary); }
    }
    const fd = this.runtimeFiles.open(name, constants.O_RDONLY, 0o700); closeSync(fd);
    const checked = await this._command(path, ['--check'], 5000);
    let report;
    try { report = JSON.parse(checked); } catch { throw new Error('Swift binary 检测协议无效'); }
    if (report.protocol !== 1 || report.source !== SOURCE || report.check !== true) throw new Error('Swift binary 检测协议不匹配');
    return path;
  }
  // 仅检查已存在的 binary；--check 不初始化 workspace、idle API 或通知。
  async checkBinary() {
    try { return { available: !!await this._binary(false), error: '' }; }
    catch (error) { return { available: false, error: error.message }; }
  }
  async _start() {
    const directory = this.runtimeFiles.directory();
    const owner = owners.get(directory);
    if (owner && owner !== this) throw new Error('已有前台时长采集器运行');
    owners.set(directory, this); this.ownerKey = directory; this.error = '';
    const binary = await this._binary(true);
    if (!this.enabled || this.closed) return;
    // 跨进程锁由 Swift flock 持有；stdin EOF 保证宿主退出后不会留下采集器。
    const lockName = 'foreground.lock';
    const fd = this.runtimeFiles.open(lockName, constants.O_RDWR | constants.O_CREAT); closeSync(fd);
    const child = this._spawn(binary, ['--collect', '--lock', this.runtimeFiles.path(lockName)], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    this.child = child; this.running = false; this.lastFrame = Date.now();
    child.stderr.resume(); child.stdin.on('error', () => {});
    this.exitTask = new Promise(resolveExit => child.once('close', () => {
      if (this.child === child) {
        this.running = false; clearInterval(this.watchdog); this.watchdog = null;
        if (this.ownerKey && owners.get(this.ownerKey) === this) owners.delete(this.ownerKey);
        if (this.enabled && !this.stopping && !this.error) this.error = '前台时长采集进程意外退出';
      }
      resolveExit();
    }));
    await new Promise((ready, reject) => {
      let buffer = '', settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : ready(); };
      const fail = message => {
        this.error = message; this.running = false; finish(new Error(message));
        void this._stop().catch(() => { this.error = '无法停止前台时长采集进程'; });
      };
      const timer = setTimeout(() => fail('前台时长采集启动超时'), 5000);
      child.once('error', () => fail('前台时长采集进程启动失败'));
      child.once('close', () => finish(new Error(this.error || '前台时长采集进程已退出')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (this.child !== child || this.stopping) return;
        buffer += chunk;
        if (buffer.length > 32768) return fail('前台时长输出超过限制');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const frame = JSON.parse(line); this.lastFrame = Date.now();
            if (frame.type === 'ready' && frame.protocol === 1 && !settled) { this.running = true; finish(); }
            else if (frame.type === 'heartbeat' && this.running) { /* 不将 heartbeat 间隔补成应用时长。 */ }
            else if (frame.type === 'segment' && this.running) { if(this.enabled&&!this.closed)this._record(frame.event); }
            else if (frame.type === 'error') throw new Error(frame.code === 'idle-unavailable' ? 'idle 时长 API 不可用；未请求权限，采集已停止' : frame.code === 'locked' ? '已有前台时长采集进程运行' : '本地采集器不可用，采集已停止');
            else throw new Error('前台时长协议无效');
          } catch (error) { fail(error.message); break; }
        }
      });
    });
    if (!this.enabled || this.closed) { await this._stop(); return; }
    if (!this.running) throw new Error(this.error || '前台时长采集进程已退出');
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastFrame > 20000) {
        this.error = '前台时长 heartbeat 中断，采集已停止'; this.running = false;
        void this._stop().catch(() => {});
      }
    }, 5000);
    this.watchdog.unref();
  }
  async _stop() {
    if (this.stopTask) return this.stopTask;
    this.running = false; clearInterval(this.watchdog); this.watchdog = null;
    this.stopTask = (async () => {
      const child = this.child;
      if (child) {
        this.stopping = true; child.stdin.end();
        const terminate = setTimeout(() => child.kill('SIGTERM'), 1500);
        const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await this.exitTask; } finally { clearTimeout(terminate); clearTimeout(kill); }
        if (this.child === child) this.child = null;
      }
      this.stopping = false;
      if (this.ownerKey && owners.get(this.ownerKey) === this) owners.delete(this.ownerKey);
      this.ownerKey = null;
    })();
    try { await this.stopTask; } finally { this.stopTask = null; }
  }
  _record(raw) {
    const entry = segment(raw), start = Date.parse(entry.start), end = Date.parse(entry.end);
    if (start < this.lastEnd) throw new Error('时长事件重叠或时钟回退');
    this.lastEnd = end;
    // 跨 UTC 日拆段，JSONL 只持久化应用名、bundleId、起止时间和秒数。
    for (let left = start; left < end;) {
      const right = Math.min(end, (Math.floor(left / DAY) + 1) * DAY);
      const event = { name: entry.name, bundleId: entry.bundleId, start: new Date(left).toISOString(), end: new Date(right).toISOString(), seconds: (right - left) / 1000 };
      const date = event.start.slice(0, 10);
      if (this.daily?.date !== date) this.daily = { date, entries: this._readDay(date) };
      const fd = this.files.open(`${date}.jsonl`, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
      try {
        if (fstatSync(fd).size > 8 * 1024 * 1024) throw new Error('单日时长记录超过大小限制');
        writeFileSync(fd, JSON.stringify(event) + '\n'); fsyncSync(fd);
      } finally { closeSync(fd); }
      this.daily.entries.push(event);
      const total = aggregate([...this.daily.entries], Date.parse(`${date}T00:00:00.000Z`), Date.parse(`${date}T00:00:00.000Z`) + DAY);
      const rows = total.apps.map(app => `| ${mdCell(app.name)} | ${mdCell(app.bundleId)} | ${app.seconds.toFixed(3)} |`).join('\n');
      this.files.replace(`${date}.md`, `# ${date} 前台时长（UTC）\n\n来源：${SOURCE}。仅记录已观察到的非 idle 前台区间，不代表使用内容；睡眠、锁屏、停顿和未开启时段不补算。\n\n| 应用 | bundleId | 秒 |\n| --- | --- | ---: |\n${rows}\n\n合计：${total.seconds.toFixed(3)} 秒。\n`);
      left = right;
    }
  }
  _readDay(date) {
    const raw = this.files.read(`${date}.jsonl`);
    if (!raw) return [];
    const text = raw.toString('utf8');
    if (text && !text.endsWith('\n')) throw new Error('时长 JSONL 不完整，请手动检查；不会覆盖原文');
    return text.split('\n').filter(Boolean).map(line => {
      const event = segment(JSON.parse(line));
      if (event.start.slice(0, 10) !== date || Date.parse(event.end) > Date.parse(`${date}T00:00:00.000Z`) + DAY) throw new Error('时长事件日期不匹配');
      return event;
    });
  }
  summary(startISO, endISO) {
    const start = timestamp(startISO), end = timestamp(endISO);
    if (end < start || end - start > 366 * DAY) throw new Error('汇总范围必须为 0—366 天');
    const entries = [];
    for (let day = Math.floor(start / DAY) * DAY; day < end; day += DAY) entries.push(...this._readDay(new Date(day).toISOString().slice(0, 10)));
    return aggregate(entries, start, end);
  }
}
