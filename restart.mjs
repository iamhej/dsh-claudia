import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { absolutePath, installedPackage, profileName, readSafe, safePath, satisfies, writePrivate } from './lifecycle.mjs';
import { noopLogger } from './logger.mjs';

const PROTOCOL = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pid = value => Number.isInteger(value) && value > 1 && value <= 0x7fffffff;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const version = value => { try { return typeof value === 'string' && satisfies(value, value); } catch { return false; } };
const identity = value => JSON.stringify(value);
function readRecord(path) {
  safePath(path, { missing: true });
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || process.getuid && stat.uid !== process.getuid()) throw new Error('重启记录必须为当前用户的私有普通文件');
    const value = JSON.parse(readSafe(path, 4096).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('重启记录必须为 JSON 对象');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function alive(value) {
  if (!pid(value)) return false;
  try { process.kill(value, 0); return true; } catch { return false; }
}
function paths({ dataDir, home, profile }) {
  home = absolutePath(home); dataDir = absolutePath(dataDir); profile = profileName(profile);
  return { home, dataDir, profile, heartbeat: join(dataDir, '.runtime', 'supervisor-state.json'), request: join(dataDir, '.runtime', 'manual-restart.json'), result: join(dataDir, '.runtime', 'manual-restart-result.json'), lock: join(home, '.claudia-supervisor.lock') };
}
function readRequest(o) {
  const value = readRecord(o.request);
  if (value === null) return null;
  if (!value || !UUID.test(value.id) || !pid(value.expectedPid) || !version(value.desiredVersion) || !timestamp(value.requestedAt)
    || Date.parse(value.requestedAt) > Date.now() || value.home !== o.home || value.profile !== o.profile
    || !UUID.test(value.supervisorToken) || !['pending', 'restarting', 'error'].includes(value.phase)) throw new Error('手动重启请求无效或超出当前 home/profile');
  return value;
}
function readResult(o) {
  const value = readRecord(o.result);
  if (value === null) return null;
  if (!value || !UUID.test(value.id) || value.home !== o.home || value.profile !== o.profile || !version(value.desiredVersion)
    || !['idle', 'error'].includes(value.state) || !timestamp(value.completedAt)) throw new Error('手动重启结果无效或超出当前 home/profile');
  return value;
}
function busyState(callback) {
  try {
    const value = callback();
    if (typeof value === 'boolean') return value;
    if (value && typeof value.busy === 'boolean') {
      const other = value.otherAgents ?? false;
      return value.busy || (typeof other === 'boolean' ? other : typeof other === 'number' ? other !== 0 : Array.isArray(other) ? other.length !== 0 : true);
    }
  } catch {}
  return true;
}

export class RestartControl {
  constructor({ dataDir, home, profile = 'web', runningVersion, supervised = process.env.CLAUDIA_SUPERVISED === '1', isBusy = () => false, logger = noopLogger }) {
    this.o = paths({ dataDir, home, profile });
    if (!version(runningVersion)) throw new Error('运行版本无效');
    this.runningVersion = runningVersion; this.supervised = supervised === true; this.isBusy = isBusy; this.logger = logger;
  }
  heartbeat() {
    if (!this.supervised) return null;
    const o = this.o, value = readRecord(o.heartbeat), lock = readRecord(o.lock);
    // 环境标志本身不是授权：必须是当前宿主的直接父进程，且仍持有同 home 的锁。
    if (!value || value.protocol !== PROTOCOL || value.version !== this.runningVersion || !UUID.test(value.token)
      || value.pid !== process.ppid || value.hostPid !== process.pid || value.home !== o.home || value.profile !== o.profile || value.dataDir !== o.dataDir
      || !timestamp(value.updatedAt) || Date.now() - Date.parse(value.updatedAt) >= 10000 || Date.parse(value.updatedAt) > Date.now()
      || lock?.pid !== value.pid || lock.token !== value.token || lock.home !== o.home || !alive(value.pid)) return null;
    return value;
  }
  status() {
    const busy = busyState(this.isBusy);
    let heartbeat, installedVersion = null, request, result, error;
    try { heartbeat = this.heartbeat(); } catch { error = ['unsafe-supervisor', '无法安全验证 supervisor 心跳']; }
    try { installedVersion = installedPackage(this.o.home, this.o.profile).manifest.version; } catch { error = ['invalid-installation', '无法安全读取当前 profile 中的 dsh-claudia 安装版本']; }
    try {
      request = readRequest(this.o); result = readResult(this.o);
      if (request && heartbeat && (request.supervisorToken !== heartbeat.token || request.phase === 'pending' && request.expectedPid !== process.pid)) throw new Error();
    } catch { error = ['unsafe-request', '重启记录无效或不属于当前受控宿主']; }
    const pending = installedVersion !== null && installedVersion !== this.runningVersion || !!request;
    let state = pending ? 'pending' : 'idle', reason = pending ? 'pending-restart' : 'up-to-date';
    let message = pending ? '已安装版本或重启请求等待宿主重启生效' : '当前运行版本已生效';
    if (pending && typeof heartbeat?.message === 'string' && heartbeat.message.length <= 500 && heartbeat.message) message = heartbeat.message;
    if (request?.phase === 'restarting') { state = 'restarting'; reason = 'verifying'; message = '正在重启，等待 appReady 与实际版本健康检查'; }
    if (busy) { reason = 'busy'; message = pending ? '宿主或其他 agent 忙碌，等待空闲后安全重启' : '宿主或其他 agent 忙碌，暂时不能重启'; }
    if (!heartbeat) { reason = 'unsupported'; message = '没有有效且存活的自有 supervisor；请使用启动入口启动'; }
    if (request?.phase === 'error' || !request && result?.state === 'error' && result.desiredVersion === installedVersion) error = ['restart-failed', '手动重启失败，已停止自动重试；未回滚未备份的安装代码'];
    if (error) { state = 'error'; [reason, message] = error; }
    return { supported: !!heartbeat, pending: !!pending, state, reason, message, busy, runningVersion: this.runningVersion, installedVersion };
  }
  request() {
    const state = this.status();
    const reject = (status, message) => { this.logger.warn('restart.reject', { status, reason: state.reason, message }); throw Object.assign(new Error(message), { status, statusCode: status }); };
    if (!state.supported) reject(503, state.message);
    if (state.busy) reject(409, '宿主或其他 agent 忙碌，请等待任务结束后重启');
    if (state.state === 'error' || !state.installedVersion) reject(503, state.message);
    try {
      const current = readRequest(this.o);
      if (current) return state;
      const heartbeat = this.heartbeat();
      if (!heartbeat) reject(503, 'supervisor 心跳已失效');
      writePrivate(this.o.request, JSON.stringify({ id: randomUUID(), requestedAt: new Date().toISOString(), expectedPid: process.pid, desiredVersion: state.installedVersion, home: this.o.home, profile: this.o.profile, supervisorToken: heartbeat.token, phase: 'pending' }));
      this.logger.info('restart.request', { from: this.runningVersion, to: state.installedVersion, hostPid: process.pid });
    } catch (error) { if (error.status) throw error; reject(503, '无法安全写入手动重启请求'); }
    return this.status();
  }
}

// 仅由持有锁的 supervisor 使用；停止目标始终由 bin 中的 ChildProcess 对象决定。
export class SupervisorRestart {
  constructor(options, token) {
    this.o = paths(options); this.token = token; this.current = null; this.consumed = new Set(); this.published = false;
  }
  publish({ hostPid, version, busy = false, state = 'idle', message = '' }) {
    const lock = readRecord(this.o.lock), previous = readRecord(this.o.heartbeat);
    if (lock?.pid !== process.pid || lock.token !== this.token || lock.home !== this.o.home) throw new Error('supervisor 已失去自有锁');
    if (previous && (previous.home !== this.o.home || previous.profile !== this.o.profile || previous.dataDir !== this.o.dataDir
      || previous.token === this.token && previous.pid !== process.pid
      || previous.token !== this.token && (this.published || alive(previous.pid)))) throw new Error('拒绝覆盖其他 supervisor 心跳');
    writePrivate(this.o.heartbeat, JSON.stringify({ pid: process.pid, hostPid, home: this.o.home, dataDir: this.o.dataDir, profile: this.o.profile, version, protocol: PROTOCOL, token: this.token, updatedAt: new Date().toISOString(), busy, state, message }));
    this.published = true;
  }
  clear() {
    const value = readRecord(this.o.heartbeat);
    if (value?.pid === process.pid && value.token === this.token && value.home === this.o.home && value.profile === this.o.profile && value.dataDir === this.o.dataDir) unlinkSync(this.o.heartbeat);
  }
  assertStartable() {
    if (this.current) return;
    const request = readRequest(this.o);
    if (request && ['restarting', 'error'].includes(request.phase)) throw new Error('上次手动重启未确认成功；停止自动启动，不回滚未备份代码');
  }
  pending(hostPid) {
    const request = readRequest(this.o);
    if (!request || request.phase !== 'pending' || request.expectedPid !== hostPid || request.supervisorToken !== this.token
      || this.consumed.has(request.id) || readResult(this.o)?.id === request.id) return null;
    return request;
  }
  start(request, hostPid) {
    if (this.current || identity(this.pending(hostPid)) !== identity(request)) throw new Error('手动重启请求已变化，拒绝消费');
    if (installedPackage(this.o.home, this.o.profile).manifest.version !== request.desiredVersion) throw new Error('手动重启目标版本已变化');
    const next = { ...request, phase: 'restarting', startedAt: new Date().toISOString(), supervisorPid: process.pid };
    writePrivate(this.o.request, JSON.stringify(next));
    this.current = next; this.consumed.add(next.id);
  }
  finish(health, message = '') {
    const request = this.current;
    if (!request) return;
    const success = !!health;
    if (success && (health.pid === request.expectedPid || health.version !== request.desiredVersion
      || health.home !== this.o.home || health.profile !== this.o.profile || installedPackage(this.o.home, this.o.profile).manifest.version !== request.desiredVersion)) throw new Error('手动重启后的实际版本或宿主身份不匹配');
    writePrivate(this.o.result, JSON.stringify({ ...request, state: success ? 'idle' : 'error', applied: success, pendingRestart: !success, runningVersion: health?.version ?? null, pid: health?.pid ?? null, message: success ? '手动重启已通过 appReady 和健康检查' : message, completedAt: new Date().toISOString() }));
    // 请求被替换时只记录本次结果，不删除或覆盖后来者。
    if (identity(readRequest(this.o)) === identity(request)) {
      if (success) unlinkSync(this.o.request);
      else writePrivate(this.o.request, JSON.stringify({ ...request, phase: 'error' }));
    }
    this.current = null;
  }
}
