// 事件日志：只记录“发生了什么”，不记录任何用户正文。
// 对话内容、Journal/Todo/记忆正文、设定正文、模型返回一律不进入本文件；
// 错误信息在写入前做凭据样式掩码，避免宿主异常把 key 回显进日志。
// 仅依赖 node 内置模块，因此 lifecycle.mjs 可以安全引用而不产生循环依赖。
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

const FILE = /^(\d{4}-\d{2}-\d{2})\.log$/;
const NAME = /^[A-Za-z][A-Za-z0-9_.]{0,39}$/;
const LEVELS = new Set(['info', 'warn', 'error']);
const MAX_VALUE = 300;
const TAIL_BYTES = 256 * 1024;

const pad = value => String(value).padStart(2, '0');
export const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const stamp = date => {
  const offset = -date.getTimezoneOffset(), sign = offset < 0 ? '-' : '+', abs = Math.abs(offset);
  return `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};
const absolute = path => {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) || path.split(sep).includes('..')) throw new Error('日志目录必须是不含上跳或控制字符的绝对路径');
  return resolve(path);
};

// 掩码常见凭据样式。日志本就不写正文，这一层只防错误信息里夹带 key。
// 关键词规则额外吞掉可选的 Bearer 前缀，否则 `Authorization: Bearer <token>` 会把
// Bearer 当成值掩码掉，真正的 token 反而留在行内。
export function redact(text) {
  return String(text)
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***')
    .replace(/\b(api[-_]?key|authorization|bearer|token|secret|password|passwd|credential)\b(\s*[:=]\s*|\s+)(?:bearer\s+)?("?)[^\s"',;]+\3/gi, '$1$2***');
}

// 只接受标量与 Error；对象、数组等一律拒绝，防止整条记录被顺手塞进日志。
function format(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean' || typeof raw === 'number') return Number.isFinite(raw) || typeof raw === 'boolean' ? String(raw) : '';
  let text;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof Error) text = `${raw.name}: ${raw.message}`;
  else return '';
  text = redact(text).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length > MAX_VALUE) text = `${text.slice(0, MAX_VALUE)}…`;
  return /[\s"=]/.test(text) ? `"${text.replace(/"/g, "'")}"` : text;
}

function tail(path, bytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - bytes), length = Math.min(size, bytes);
    if (!length) return '';
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    // 截断起点可能落在行中间，丢弃这半行而不是展示残缺记录。
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { closeSync(fd); }
}

export class Logger {
  constructor(dataDir, { maxBytesPerDay = 2 * 1024 * 1024, retainDays = 14, now = () => new Date() } = {}) {
    this.root = join(absolute(dataDir), 'logs');
    this.max = maxBytesPerDay; this.retain = retainDays; this.now = now;
    this.day = ''; this.fd = null; this.size = 0; this.capped = false; this.lastError = '';
  }
  dir() { return this.root; }
  status() { return { dir: this.root, day: this.day, bytes: this.size, capped: this.capped, retainDays: this.retain, maxBytesPerDay: this.max, error: this.lastError }; }
  release() { if (this.fd !== null) { try { closeSync(this.fd); } catch { /* 关闭失败不影响调用方 */ } this.fd = null; } }
  close() { this.release(); }
  open() {
    const day = dayKey(this.now());
    if (this.fd !== null && this.day === day) return;
    this.release();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const fd = openSync(join(this.root, `${day}.log`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    this.fd = fd; this.day = day; this.size = fstatSync(fd).size; this.capped = this.size >= this.max;
    this.sweep();
  }
  // 只按精确的 YYYY-MM-DD.log 命名清理过期日志，绝不触碰目录内其他文件。
  sweep() {
    const limit = new Date(this.now().getTime());
    limit.setDate(limit.getDate() - this.retain);
    const oldest = dayKey(limit);
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      const match = FILE.exec(entry.name);
      if (!match || !entry.isFile() || match[1] >= oldest) continue;
      try { unlinkSync(join(this.root, entry.name)); } catch { /* 清理失败不影响写入 */ }
    }
  }
  // 写入失败只记录在 lastError，绝不向调用方抛错：日志不能拖垮被观测的功能。
  event(level, name, fields = {}) {
    if (!LEVELS.has(level) || !NAME.test(name)) return false;
    try {
      this.open();
      if (this.capped) return false;
      const parts = [];
      for (const [key, raw] of Object.entries(fields ?? {})) {
        if (!NAME.test(key)) continue;
        const text = format(raw);
        if (text !== '') parts.push(`${key}=${text}`);
      }
      const line = `${stamp(this.now())} ${level.toUpperCase().padEnd(5)} ${name.padEnd(26)} ${parts.join(' ')}`.trimEnd();
      const buffer = Buffer.from(`${line}\n`, 'utf8');
      writeSync(this.fd, buffer);
      this.size += buffer.length;
      if (this.size >= this.max && !this.capped) {
        this.capped = true;
        const notice = Buffer.from(`${stamp(this.now())} WARN  ${'logger.capped'.padEnd(26)} maxBytesPerDay=${this.max}\n`, 'utf8');
        writeSync(this.fd, notice); this.size += notice.length;
      }
      this.lastError = '';
      return true;
    } catch (error) {
      this.lastError = String(error?.message ?? error).slice(0, 200);
      this.release();
      return false;
    }
  }
  info(name, fields) { return this.event('info', name, fields); }
  warn(name, fields) { return this.event('warn', name, fields); }
  error(name, fields) { return this.event('error', name, fields); }
  // 读取最近若干行，用于设置页预览；不接受外部路径，只读自己的当日与前一日文件。
  recent(limit = 200) {
    const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
    const today = this.now(), previous = new Date(today.getTime());
    previous.setDate(previous.getDate() - 1);
    const lines = [];
    for (const day of [dayKey(previous), dayKey(today)]) {
      const path = join(this.root, `${day}.log`);
      try {
        if (!existsSync(path) || lstatSync(path).isSymbolicLink()) continue;
        for (const line of tail(path, TAIL_BYTES).split('\n')) if (line.trim()) lines.push(line);
      } catch { /* 单日读取失败不影响其余内容 */ }
    }
    return lines.slice(-count);
  }
}

// 供各服务默认注入，省去逐处判空；行为与 Logger 一致但不落盘。
export const noopLogger = {
  dir: () => '',
  status: () => ({ dir: '', day: '', bytes: 0, capped: false, retainDays: 0, maxBytesPerDay: 0, error: '' }),
  event: () => false, info: () => false, warn: () => false, error: () => false,
  recent: () => [], release() {}, close() {},
};

// 进程级观测集中在这里，返回一个解除函数。proc 可注入，便于用替身验证信号语义。
// 实测 Node 在被 SIGTERM/SIGINT/SIGHUP 终止时不会触发 exit 事件，而“终端被关掉”和
// “launchd 停止服务”正是最常见的消失原因，只靠 exit 会在最需要的场景下毫无记录。
// 安全前提：一旦存在任何同名监听，Node 的默认终止行为就被接管。若我们是唯一监听者，
// 必须摘掉自己再重新发同一个信号，把“该退出”的语义原样还回去，不能让宿主变得杀不掉。
// uncaughtExceptionMonitor 仅观测，不会像 uncaughtException 监听那样接管崩溃语义。
export function observeProcess({ logger, uptimeSec = () => 0, proc = process, signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] } = {}) {
  const onExit = code => { logger.info('host.exit', { code, uptimeSec: uptimeSec() }); };
  const onFatal = error => { logger.error('host.uncaught', { error }); };
  const onSignal = {};
  proc.on('exit', onExit);
  proc.on('uncaughtExceptionMonitor', onFatal);
  for (const signal of signals) {
    onSignal[signal] = () => {
      logger.warn('host.signal', { signal, uptimeSec: uptimeSec() });
      if (proc.listenerCount(signal) === 1) {
        proc.removeListener(signal, onSignal[signal]);
        proc.kill(proc.pid, signal);
      }
    };
    proc.on(signal, onSignal[signal]);
  }
  return () => {
    proc.off('exit', onExit);
    proc.off('uncaughtExceptionMonitor', onFatal);
    for (const signal of signals) proc.off(signal, onSignal[signal]);
  };
}
