import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, realpathSync, openSync, closeSync, writeFileSync, fsyncSync, unlinkSync, lstatSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readSafe, writePrivate, safePath, privateDirectory } from './lifecycle.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const START = '# claudia-email-toggle:start';
const END = '# claudia-email-toggle:end';

export function emailPatch(text, enabled) {
  const block = `${START}\n- id: tool-email\n  name: dsh-email\n  disabled: ${!enabled}\n${END}`;
  const starts = text.split(START).length - 1, ends = text.split(END).length - 1;
  if (starts || ends) {
    if (starts !== 1 || ends !== 1) throw fail(409, '邮件开关配置标记冲突，请在宿主检查配置');
    const re = /^# claudia-email-toggle:start\r?\n- id: tool-email\r?\n  name: dsh-email\r?\n  disabled: (?:true|false)\r?\n# claudia-email-toggle:end(?=\r?\n|$)/m;
    if (!re.test(text)) throw fail(409, '邮件开关配置已被外部修改，请在宿主检查配置');
    return text.replace(re, block);
  }
  // 只移除空数组本身，保留用户层的注释与空白；不重排其它 YAML。
  const meaningful = text.replace(/^\s*#.*$/gm, '').trim();
  if (meaningful === '[]' || !meaningful) {
    const prefix = text.replace(/^([ \t]*)\[\]([ \t]*)(?=\r?$)/m, '$1$2');
    return prefix + (prefix.endsWith('\n') ? '' : '\n') + block + '\n';
  }
  if (!/^\s*-\s/m.test(meaningful) || /^\s*(?:---|\.\.\.|\[)/m.test(meaningful)) throw fail(409, '当前配置格式不支持安全追加开关，请在 Harness 中配置');
  return text + (text.endsWith('\n') ? '\n' : '\n\n') + block + '\n';
}

function emailRow(rows) {
  const emails = [];
  let ids = 0;
  function visit(entries, nested = false) {
    for (const row of entries) {
      if (row.id === 'tool-email') ids++;
      if (row.name === 'dsh-email') {
        if (nested || row.group) throw fail(409, 'group 内的邮件插件请在 Harness 中管理');
        if (row.disabled !== undefined && row.disabled !== null && typeof row.disabled !== 'boolean') throw fail(409, '动态启停配置请在 Harness 中管理');
        emails.push(row);
      }
      if (row.group) {
        if (!Array.isArray(row.config)) throw fail(409, '无法安全检查 group 配置，请在 Harness 中管理');
        visit(row.config, true);
      }
    }
  }
  visit(rows);
  if (emails.length !== 1 || emails[0].id !== 'tool-email' || ids !== 1) throw fail(409, '没有唯一可管理的邮件插件条目');
  return emails[0];
}

export class EmailControl {
  constructor({ home, profile = 'web', dataDir, hostAnchor = process.argv[1], getPlugins, boot }) {
    if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw Error('Invalid profile');
    this.dir = join(home, 'profiles', profile); this.home = home; this.dataDir = dataDir; this.getPlugins = getPlugins;
    this.path = join(this.dir, 'cordis.patch.yml'); this.homePath = join(home, 'cordis.patch.yml');
    try { this.anchor = realpathSync(hostAnchor); this.boot = boot ?? createRequire(this.anchor)('@deepseek-ai/dsh-app-boot'); } catch { this.boot = boot; }
  }
  input() {
    if (!this.boot) throw fail(503, '当前宿主未提供安全配置接口');
    const read = path => { safePath(path, { missing: true }); return existsSync(path) ? readSafe(path, 256 * 1024).toString('utf8') : ''; };
    const text = read(this.path), homeText = read(this.homePath), manifest = read(join(this.dir, 'package.json'));
    const profile = this.boot.loadProfileDirectory('dsh', this.dir, this.anchor);
    if (profile.patchReload !== 'startup') throw fail(409, '当前 profile 使用实时重载，请在 Harness 中管理邮件开关');
    const homePatches = this.boot.loadOptionalPatches('dsh', this.homePath) || [];
    const rows = this.boot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, homePatches]);
    const row = emailRow(rows);
    // revision 同时覆盖 profile 清单及正式解析后的 Bundle 层，不能只比较两个用户补丁。
    return { text, homeText, profile, homePatches, rows, savedEnabled: row.disabled !== true, revision: hash(JSON.stringify([text, homeText, manifest, profile])) };
  }
  status() {
    const result = { supported: false, revision: null, savedEnabled: null, enabled: null, phase: null, needsRestart: false, message: '' };
    try {
      const matches = this.getPlugins().packages.filter(p => p.name === 'dsh-email');
      const plugin = matches.length === 1 ? matches[0] : null;
      if (plugin?.installed !== true) throw fail(409, '尚未确认唯一已安装的 dsh-email');
      const input = this.input();
      const enabled = typeof plugin.enabled === 'boolean' ? plugin.enabled : null;
      Object.assign(result, { supported: true, revision: input.revision, savedEnabled: input.savedEnabled, enabled, phase: plugin.phase ?? null });
      result.needsRestart = enabled !== null && input.savedEnabled !== enabled;
      result.message = result.needsRestart ? '邮件开关已保存，重启后生效' : plugin.phase === 'active' ? '邮件插件已加载；账号配置和连接状态请在 Harness 查看' : input.savedEnabled ? '邮件已设为开启，等待宿主加载；可重启后检查' : '邮件插件已关闭';
    } catch (error) { result.message = error.status ? error.message : '无法安全读取邮件开关，请在 Harness 检查'; }
    return result;
  }
  setEnabled(enabled, revision) {
    if (typeof enabled !== 'boolean' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw fail(400, '邮件开关需要有效状态与版本');
    const before = this.status();
    if (!before.supported) throw fail(409, before.message);
    const lock = join(this.dir, '.claudia-email.lock');
    let fd, candidate;
    try {
      safePath(this.dir); safePath(lock, { missing: true });
      fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch { throw fail(409, '邮件设置正在修改或有未处理的锁，请稍后核对；不会自动清锁'); }
    const owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
    const ownsLock = () => {
      try {
        const held = fstatSync(fd), current = lstatSync(lock);
        return !current.isSymbolicLink() && held.ino === current.ino && held.dev === current.dev && readSafe(lock, 4096).toString('utf8') === owner;
      } catch { return false; }
    };
    try {
      writeFileSync(fd, owner); fsyncSync(fd);
      const input = this.input();
      if (input.revision !== revision) throw fail(409, '宿主配置已变化，请刷新邮件状态后重试');
      if (input.savedEnabled === enabled) return this.status();
      const text = emailPatch(input.text, enabled);
      // 候选与最终文件必须同目录，否则宿主会把其它插件的相对路径解析到错误位置。
      const id = randomUUID(); candidate = join(this.dir, `.claudia-email-${id}.candidate.yml`);
      writePrivate(candidate, text);
      const patches = this.boot.loadOptionalPatches('dsh', candidate);
      const rows = this.boot.composeEntries([...input.profile.layers.map(layer => layer.patches), patches, input.homePatches]);
      const row = emailRow(rows);
      if (row.disabled !== !enabled) throw fail(409, '其他宿主配置覆盖了邮件开关，请到 Harness 检查');
      const expected = structuredClone(input.rows);
      emailRow(expected).disabled = !enabled;
      if (!isDeepStrictEqual(rows, expected)) throw fail(409, '候选配置影响了其它插件，未保存邮件开关');
      const dir = privateDirectory(join(this.dataDir, '.runtime', 'email-config'));
      writePrivate(join(dir, `${id}.backup.yml`), input.text);
      if (this.input().revision !== revision) throw fail(409, '宿主配置已变化，未覆盖');
      if (!ownsLock()) throw fail(409, '邮件设置锁已变化，未覆盖配置；请在宿主核对');
      writePrivate(this.path, text);
      return this.status();
    } catch (error) { if (error.status) throw error; throw fail(500, '邮件开关保存未确认，请刷新状态核对，不要重复提交'); }
    finally {
      try { if (candidate) unlinkSync(candidate); }
      catch (error) { if (error.code !== 'ENOENT') throw fail(500, '邮件开关临时文件清理未确认，请刷新状态核对'); }
      finally {
        try { if (ownsLock()) unlinkSync(lock); }
        catch { throw fail(500, '邮件开关锁清理未确认，请刷新状态核对；不会自动清锁'); }
        finally { closeSync(fd); }
      }
    }
  }
}
