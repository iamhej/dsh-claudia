import { constants, accessSync, closeSync, cpSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX = 64 * 1024 * 1024;
const NAME = 'dsh-claudia';
const CONFIG_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.yaml', 'cordis.patch.yml', 'cordis.patch.yaml'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const defaultHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
export const homeHash = home => hash(resolve(home)).slice(0, 16);

export function absolutePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) || path.split(sep).includes('..')) fail('必须提供不含上跳或控制字符的绝对路径');
  return resolve(path);
}
export function profileName(profile = 'web') {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile) || profile.toLowerCase() === 'desktop') fail('profile 无效；不支持由 Electron 管理的 desktop');
  return profile;
}
// 所有可写路径逐级 lstat；只在包管理器入口和可执行文件解析时显式处理受限链接。
export function safePath(path, { missing = false } = {}) {
  const full = absolutePath(path), root = parse(full).root;
  let current = root;
  const parts = relative(root, full).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (missing && error.code === 'ENOENT') return full; throw error; }
    if (stat.isSymbolicLink()) fail('拒绝可写路径中的 symlink');
    if (i < parts.length - 1 && !stat.isDirectory()) fail('路径的父级不是目录');
  }
  return full;
}
export function privateDirectory(path) {
  safePath(path, { missing: true });
  mkdirSync(path, { recursive: true, mode: 0o700 });
  safePath(path);
  if (!lstatSync(path).isDirectory()) fail('私有路径不是目录');
  return path;
}
export function readSafe(path, limit = MAX) {
  safePath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd), current = lstatSync(path);
    if (!stat.isFile() || stat.size > limit || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) fail('只允许大小受限且未被替换的普通文件');
    const chunks = []; let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > limit) fail('文件超过大小限制');
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, size);
  } finally { closeSync(fd); }
}
export function writePrivate(path, value) {
  safePath(path, { missing: true });
  privateDirectory(dirname(path));
  const temp = join(dirname(path), `.claudia-${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  try { safePath(path, { missing: true }); renameSync(temp, path); }
  catch (error) { unlinkSync(temp); throw error; }
}
function jsonFile(path) { return JSON.parse(readSafe(path, 1024 * 1024).toString('utf8')); }
function inside(root, path) { const rel = relative(root, path); return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel); }

export function resolveExecutable(value, name, pathEnv = process.env.PATH || '') {
  const candidates = value ? [absolutePath(value)] : pathEnv.split(delimiter).filter(p => isAbsolute(p)).map(p => join(p, name));
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      safePath(real);
      if (!lstatSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
      return real;
    } catch (error) { if (value) throw new Error(`${name} 路径无效或不可执行`, { cause: error }); }
  }
  fail(`找不到 ${name}；请将它加入 PATH 或显式配置 ${name === 'pnpm' ? 'pnpmPath' : `${name}Bin`} 的绝对路径`);
}
function executablePrefix(path) {
  safePath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), bytes = Buffer.alloc(160);
  try { if (!fstatSync(fd).isFile()) fail('可执行入口不是普通文件'); return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8'); }
  finally { closeSync(fd); }
}
export function resolveDsh(value) {
  const path = resolveExecutable(value, 'dsh');
  const prefix = executablePrefix(path);
  if (!/\.(?:mjs|cjs|js)$/.test(path) && !/^#![^\n]*\bnode\b/.test(prefix)) fail('dshBin 必须为可由同一 Node 执行的官方 JS 入口，不能是 shell 包装器');
  return path;
}

function versionParts(version) {
  if (typeof version !== 'string' || version.length > 128) fail('无效 SemVer');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match || match[4]?.split('.').some(v => /^0\d+$/.test(v))) fail('无效 SemVer');
  const core = match.slice(1, 4).map(Number);
  if (core.some(v => !Number.isSafeInteger(v))) fail('版本数字过大');
  return { core, pre: match[4]?.split('.') || [] };
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i]);
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx !== ny) return nx ? -1 : 1;
    return (nx ? BigInt(x) > BigInt(y) : x > y) ? 1 : -1;
  }
  return 0;
}
// 覆盖本包使用的 npm SemVer 范围；不认识的语法直接拒绝，绝不猜测兼容。
export function satisfies(version, range) {
  const v = versionParts(version);
  if (typeof range !== 'string' || range.length > 512 || !range.trim()) fail('缺少或不支持的版本范围');
  return range.split('||').some(raw => {
    let text = raw.trim();
    text = text.replace(/(\d+\.\d+\.\d+(?:-[\w.-]+)?)\s+-\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)/g, '>=$1 <=$2').replace(/([<>]=?|[~^=])\s+/g, '$1');
    const bounds = [];
    for (const token of text.split(/\s+/)) {
      const m = /^(>=|<=|>|<|=|\^|~)?([0-9xX*]+)(?:\.([0-9xX*]+))?(?:\.([0-9xX*]+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(token);
      if (!m) fail('不支持的版本范围语法');
      const op = m[1] || '=', parts = m.slice(2, 5), first = parts.findIndex(p => p === undefined || /^[xX*]$/.test(p));
      const count = first < 0 ? 3 : first;
      if (parts.slice(count).some(p => p !== undefined && !/^[xX*]$/.test(p)) || m[5] && count !== 3) fail('无效版本范围');
      if (!count) { if (op !== '=') fail('不支持的通配比较'); continue; }
      const lower = versionParts(parts.slice(0, count).concat(Array(3 - count).fill('0')).join('.') + (m[5] || ''));
      if (op === '^' || op === '~' || count < 3) {
        if (!['^', '~', '='].includes(op)) fail('比较符必须指定完整版本');
        const upper = { core: [...lower.core], pre: ['0'] };
        const index = op === '^' ? (lower.core[0] > 0 || count === 1 ? 0 : lower.core[1] > 0 || count === 2 ? 1 : 2) : op === '~' ? (count === 1 ? 0 : 1) : count - 1;
        upper.core[index]++; for (let i = index + 1; i < 3; i++) upper.core[i] = 0;
        bounds.push(['>=', lower], ['<', upper]);
      } else bounds.push([op, lower]);
    }
    if (v.pre.length && !bounds.some(([, b]) => b.pre.length && b.core.every((n, i) => n === v.core[i]))) return false;
    return bounds.every(([op, b]) => { const c = compare(v, b); return op === '=' ? c === 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '<' ? c < 0 : c <= 0; });
  });
}

export function validateArchive(bytes, version) {
  versionParts(version);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX) fail('tgz 超过 64 MiB');
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX }); } catch { fail('gzip 无效或解压后超过 64 MiB'); }
  if (tar.length % 512) fail('tar 长度无效');
  const files = new Map(), types = new Map(), aliases = new Set();
  const text = buffer => {
    const nul = buffer.indexOf(0), end = nul < 0 ? buffer.length : nul;
    if (nul >= 0 && buffer.subarray(nul).some(v => v !== 0)) fail('tar 字段包含隐藏内容');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)); } catch { fail('tar 路径编码无效'); }
  };
  const octal = buffer => { const s = buffer.toString('ascii').replace(/\0.*$/, '').trim(); if (!/^[0-7]*$/.test(s) || buffer[0] & 128) fail('tar 数字字段无效'); const n = parseInt(s || '0', 8); if (!Number.isSafeInteger(n)) fail('tar 数字过大'); return n; };
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(v => v === 0)) {
      if (offset + 1024 > tar.length || tar.subarray(offset).some(v => v !== 0)) fail('tar 结束块或尾部数据无效');
      ended = true; break;
    }
    if (types.size >= 10000) fail('tar 条目过多');
    const checksum = octal(header.subarray(148, 156));
    const actual = header.reduce((sum, value, i) => sum + (i >= 148 && i < 156 ? 32 : value), 0);
    if (checksum !== actual) fail('tar header 校验失败');
    const magic = text(header.subarray(257, 263));
    if (magic !== 'ustar' && magic !== '') fail('只支持标准 ustar 普通文件和目录');
    const prefix = text(header.subarray(345, 500)), leaf = text(header.subarray(0, 100));
    const raw = prefix ? `${prefix}/${leaf}` : leaf;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (!['0', '5'].includes(type) || text(header.subarray(157, 257)) || octal(header.subarray(329, 337)) || octal(header.subarray(337, 345))) fail('tar 禁止 symlink、硬链接、设备及扩展条目');
    const name = type === '5' ? raw.replace(/\/$/, '') : raw;
    if (!name || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..') || name !== 'package' && !name.startsWith('package/') || name === 'package' && type !== '5') fail('tar 条目只能位于 package/，禁止绝对路径或上跳');
    const alias = name.normalize('NFC').toLowerCase();
    if (aliases.has(alias)) fail('tar 包含重复或大小写冲突路径');
    aliases.add(alias); types.set(name, type);
    const mode = octal(header.subarray(100, 108)), size = octal(header.subarray(124, 136));
    if (mode & 0o7000 || type === '5' && size !== 0) fail('tar 权限或目录大小无效');
    offset += 512;
    if (size > MAX || offset + Math.ceil(size / 512) * 512 > tar.length) fail('tar 文件被截断');
    if (type === '0') files.set(name.slice(8), tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) fail('tar 缺少结束块');
  for (const name of types.keys()) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (types.get(parts.join('/')) === '0') fail('tar 普通文件不能成为父目录'); parts.pop(); }
  }
  let manifest;
  try { const raw = files.get('package.json'); if (!raw || raw.length > 1024 * 1024) throw new Error(); manifest = JSON.parse(raw.toString('utf8')); } catch { fail('tgz 缺少有效 package/package.json'); }
  if (!object(manifest) || manifest.name !== NAME || manifest.version !== version) fail('安装包 name 或 version 不匹配');
  const entry = value => {
    if (typeof value !== 'string') fail('安装包入口必须为包内文件路径');
    const path = value.replace(/^\.\//, '');
    if (!path || /[\\:\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || !files.has(path)) fail('安装包入口缺失或路径越界');
    return path;
  };
  if (entry(manifest.main) !== 'index.mjs' || entry(typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.']) !== 'index.mjs') fail('安装包 main/exports 必须指向 index.mjs');
  if (entry(manifest.bin?.[NAME]) !== 'bin/claudia.mjs') fail('安装包 bin 必须指向 bin/claudia.mjs');
  entry(manifest.dsh?.bundle?.patch);
  const required = ['index.mjs', 'native-runtime.mjs', 'server.mjs', 'store.mjs', 'records.mjs', 'activity.mjs', 'maintenance.mjs', 'lifecycle.mjs', 'bin/claudia.mjs', 'public/index.html', 'public/app.js', 'public/style.css', 'native/activity.swift'];
  for (const file of required) if (!files.has(file)) fail(`安装包缺少关键文件 ${file}`);
  for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
    if (manifest[field] !== undefined && (!object(manifest[field]) && !Array.isArray(manifest[field]) || Object.keys(manifest[field]).length)) fail('自动更新禁止新增普通、可选或 bundled dependencies');
  }
  if (manifest.scripts !== undefined && !object(manifest.scripts)) fail('scripts 格式无效');
  if (['preinstall', 'install', 'postinstall', 'prepare'].some(key => Object.hasOwn(manifest.scripts || {}, key))) fail('自动更新禁止 preinstall/install/postinstall/prepare scripts');
  if (!object(manifest.engines) || typeof manifest.engines.node !== 'string' || !object(manifest.peerDependencies)) fail('安装包必须声明 Node engines 和 peerDependencies');
  if (Object.keys(manifest.engines).some(key => key !== 'node')) fail('无法验证非 Node engines；自动更新保守拒绝');
  return { manifest, files };
}

export function installedPackage(home, profile = 'web') {
  const modules = join(safePath(absolutePath(home)), 'profiles', profileName(profile), 'node_modules');
  safePath(modules);
  const slot = join(modules, NAME), stat = lstatSync(slot);
  let dir = slot;
  if (stat.isSymbolicLink()) {
    // pnpm 正常布局唯一允许的包入口链接；目标不得离开本 profile 的虚拟仓库。
    dir = realpathSync(slot);
    const store = join(modules, '.pnpm');
    if (!inside(store, dir) || !/^dsh-claudia@[^/]+\/node_modules\/dsh-claudia$/.test(relative(store, dir).split(sep).join('/'))) fail('插件链接不属于当前 profile 的 pnpm 目录');
  }
  safePath(dir);
  if (!lstatSync(dir).isDirectory()) fail('已安装插件不是目录');
  const manifest = jsonFile(join(dir, 'package.json'));
  if (manifest.name !== NAME) fail('已安装插件名称不匹配');
  versionParts(manifest.version);
  return { slot, dir, manifest };
}
function checkTree(dir, budget = { bytes: 0, count: 0 }) {
  safePath(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), stat = lstatSync(path);
    if (++budget.count > 20000) fail('插件备份条目过多');
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail('插件目录禁止 symlink 或特殊文件');
    if (stat.isDirectory()) checkTree(path, budget);
    else if ((budget.bytes += stat.size) > MAX) fail('插件目录超过备份上限');
  }
}
function peerManifest(name, anchors) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || name.includes('..')) fail('peer 包名无效');
  for (const anchor of anchors) {
    const req = createRequire(anchor);
    try {
      const path = realpathSync(req.resolve(`${name}/package.json`));
      const pkg = jsonFile(path); if (pkg.name === name) return pkg;
    } catch {}
    try {
      let dir = dirname(realpathSync(req.resolve(name)));
      for (let i = 0; i < 10; i++, dir = dirname(dir)) {
        if (existsSync(join(dir, 'package.json'))) { const pkg = jsonFile(join(dir, 'package.json')); if (pkg.name === name) return pkg; }
        if (dirname(dir) === dir) break;
      }
    } catch {}
  }
  fail(`无法证明已安装 peer ${name} 的版本兼容性`);
}
export function toolEnvironment({ dataDir, nodeBin, pnpmPath, home }) {
  const pnpm = resolveExecutable(pnpmPath, 'pnpm');
  const tools = privateDirectory(join(dataDir, '.runtime', 'tools', hash(`${nodeBin}\0${pnpm}`).slice(0, 20)));
  const shim = join(tools, 'pnpm');
  const prefix = executablePrefix(pnpm);
  const isNode = /\.(?:cjs|mjs|js)$/.test(pnpm) || /^#![^\n]*\bnode\b/.test(prefix);
  const program = isNode ? nodeBin : pnpm, args = isNode ? [pnpm] : [];
  // 官方 CLI 只按名字查找 pnpm；shim 精确绑定配置路径，避免 PATH 命中别的安装。
  const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
  writePrivate(shim, `#!/bin/sh\nexec ${[program, ...args].map(quote).join(' ')} "$@"\n`);
  const fd = openSync(shim, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  return { pnpmPath: pnpm, env: { ...process.env, DSH_HOME: home, PATH: [tools, dirname(nodeBin), dirname(pnpm), '/usr/bin', '/bin'].join(delimiter), npm_config_ignore_scripts: 'true', npm_config_offline: 'true', npm_config_auto_install_peers: 'false', COREPACK_ENABLE_NETWORK: '0' } };
}

export function rollbackInstall({ dataDir, home = defaultHome(), profile = 'web', backupDir, oldVersion }) {
  dataDir = absolutePath(dataDir); home = absolutePath(home); profile = profileName(profile);
  backupDir = absolutePath(backupDir); versionParts(oldVersion);
  const backups = join(dataDir, '.updates', 'backups');
  if (dirname(backupDir) !== backups) fail('backupDir 必须直接位于同一 dataDir/.updates/backups');
  safePath(backupDir);
  const snapshot = jsonFile(join(backupDir, 'complete.json'));
  if (snapshot.home !== home || snapshot.profile !== profile || snapshot.version !== oldVersion || !Array.isArray(snapshot.present) || !snapshot.present.includes('package.json') || snapshot.present.some(file => !CONFIG_FILES.includes(file)) || new Set(snapshot.present).size !== snapshot.present.length) fail('备份 home/profile/版本或配置清单不匹配');
  const plugin = join(backupDir, 'plugin'), root = join(home, 'profiles', profile), slot = join(root, 'node_modules', NAME);
  safePath(root); safePath(dirname(slot)); checkTree(plugin);
  const manifest = jsonFile(join(plugin, 'package.json'));
  if (manifest.name !== NAME || manifest.version !== oldVersion) fail('备份插件版本不匹配');
  // 全部读取及路径校验完成才改动 profile；业务 MD、数据库、其他插件不在恢复范围。
  const configs = new Map();
  for (const file of CONFIG_FILES) {
    const target = join(root, file); safePath(target, { missing: true });
    if (existsSync(target) && !lstatSync(target).isFile()) fail('恢复目标不是普通文件');
    if (snapshot.present.includes(file)) configs.set(file, readSafe(join(backupDir, file), 4 * 1024 * 1024));
  }
  // 独占且持久化的一次性标记；恢复中断时保留现场，不能再移动已恢复的旧插件。
  const marker = join(backupDir, 'rollback-started.json'); safePath(marker, { missing: true });
  const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify({ oldVersion, startedAt: new Date().toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
  for (const file of CONFIG_FILES) {
    const target = join(root, file);
    if (configs.has(file)) writePrivate(target, configs.get(file));
    else if (existsSync(target)) renameSync(target, join(backupDir, `failed-${file}`));
  }
  // 只移动本插件入口，不跟随 pnpm 链接，也不删除新旧虚拟仓库或其他插件。
  try { lstatSync(slot); renameSync(slot, join(backupDir, 'failed-plugin')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  cpSync(plugin, slot, { recursive: true, dereference: false, errorOnExist: true, force: false });
  checkTree(slot);
  if (installedPackage(home, profile).manifest.version !== oldVersion) fail('恢复后插件版本不匹配');
  writePrivate(join(backupDir, 'rollback-complete.json'), JSON.stringify({ oldVersion, completedAt: new Date().toISOString() }));
  return { rollbackComplete: true, installationUncertain: false, oldVersion, backupDir };
}

export function createInstaller({ dataDir, dshBin, nodeBin = process.execPath, profile = 'web', pnpmPath, home = defaultHome() }) {
  // 构造不创建目录、不探测进程、更不会安装；仅调用回调才产生副作用。
  dataDir = absolutePath(dataDir); home = absolutePath(home); profile = profileName(profile);
  let running = false;
  return async ({ version, path, sha256 }) => {
    if (running) throw Object.assign(new Error('安装正在进行'), { rollbackComplete: false, installationUncertain: true, installationStarted: false });
    running = true;
    let lock, backup, acquired = false, complete = false, attempted = false, restored = false, old;
    const lockId = randomUUID();
    try {
      versionParts(version);
      path = absolutePath(path);
      const updates = join(dataDir, '.updates');
      safePath(updates);
      const restartPath = join(dataDir, '.runtime', 'restart-request.json');
      safePath(restartPath, { missing: true });
      if (existsSync(restartPath)) throw Object.assign(new Error('已有更新等待重启确认；不能覆盖其回滚备份'), { installationUncertain: true });
      if (!inside(updates, path) || !path.endsWith('.tgz') || typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256)) fail('更新文件必须为同一 dataDir/.updates 内的 tgz 和有效 sha256');
      const bytes = readSafe(path);
      if (hash(bytes) !== sha256.toLowerCase()) fail('安装包 sha256 校验失败');
      const archive = validateArchive(bytes, version);
      const node = resolveExecutable(nodeBin, 'node'), dsh = resolveDsh(dshBin);
      const actualNode = (await exec(node, ['--version'], { timeout: 10000 })).stdout.trim().replace(/^v/, '');
      if (!satisfies(process.versions.node, archive.manifest.engines.node) || !satisfies(actualNode, archive.manifest.engines.node)) fail('安装包 engines 与当前或启动用 Node 不兼容');
      old = installedPackage(home, profile);
      for (const [name, range] of Object.entries(archive.manifest.peerDependencies)) {
        if (!Object.hasOwn(old.manifest.peerDependencies || {}, name)) fail('自动更新禁止新增未经验证的 peer');
        const pkg = peerManifest(name, [join(old.dir, 'package.json'), join(home, 'profiles', profile, 'package.json'), dsh]);
        if (!satisfies(pkg.version, range)) fail(`安装包 peer ${name} 与宿主版本不兼容`);
      }
      const tools = toolEnvironment({ dataDir, nodeBin: node, pnpmPath, home });
      lock = join(updates, 'install.lock');
      safePath(lock, { missing: true });
      const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      acquired = true;
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, id: lockId })); fsyncSync(fd); } finally { closeSync(fd); }
      const root = join(home, 'profiles', profile);
      safePath(root); checkTree(old.dir);
      backup = join(privateDirectory(join(updates, 'backups')), `${version}-${randomUUID()}`);
      privateDirectory(backup);
      const present = [];
      for (const file of CONFIG_FILES) {
        const source = join(root, file);
        safePath(source, { missing: true });
        if (existsSync(source)) { const content = readSafe(source, 4 * 1024 * 1024); writePrivate(join(backup, file), content); present.push(file); }
      }
      if (!present.includes('package.json')) fail('profile 缺少 package.json');
      cpSync(old.dir, join(backup, 'plugin'), { recursive: true, dereference: false, errorOnExist: true, force: false });
      checkTree(join(backup, 'plugin'));
      // 只有完整备份完成才允许安装及恢复；不复制 home 的 settings 或 credentials。
      writePrivate(join(backup, 'complete.json'), JSON.stringify({ version: old.manifest.version, home, profile, present }));
      complete = true;
      const verified = join(updates, `verified-${version}-${randomUUID()}.tgz`);
      writePrivate(verified, bytes);
      attempted = true;
      try {
        await exec(node, [dsh, 'plugin', '--profile', profile, 'add', verified, '--offline', '--ignore-scripts', '--config.auto-install-peers=false', '--config.manage-package-manager-versions=false'], { cwd: home, env: tools.env, timeout: 120000, maxBuffer: 1024 * 1024 });
      } catch { fail('官方 dsh plugin 离线安装失败；未执行安装脚本'); }
      const installed = installedPackage(home, profile);
      if (installed.manifest.version !== version) fail('pnpm 返回成功但安装版本未更新');
      checkTree(installed.dir);
      for (const [file, content] of archive.files) {
        if (hash(readSafe(join(installed.dir, file))) !== hash(content)) fail('已安装文件与校验过的 tgz 不一致');
      }
      writePrivate(restartPath, JSON.stringify({ version, verifiedVersion: version, oldVersion: old.manifest.version, backupDir: backup, phase: 'pending', id: randomUUID(), requestedAt: new Date().toISOString() }));
      return { state: 'pending-restart', installed: true, applied: false, pendingRestart: true, version, verifiedVersion: version, oldVersion: old.manifest.version, backupDir: backup };
    } catch (error) {
      if (complete && attempted) {
        try {
          rollbackInstall({ dataDir, home, profile, backupDir: backup, oldVersion: old.manifest.version });
          restored = true;
        } catch (restoreError) { throw Object.assign(new Error('安装失败且自动恢复未完成；完整备份已保留，请勿重试更新', { cause: restoreError }), { rollbackComplete: false, installationUncertain: true, installationStarted: true, backupDir: backup }); }
        throw Object.assign(new Error(`${error.message}；已恢复当前 profile 配置和旧插件`, { cause: error }), { rollbackComplete: true, installationUncertain: false, installationStarted: true, backupDir: backup });
      }
      throw Object.assign(error, { rollbackComplete: false, installationUncertain: error.installationUncertain === true, installationStarted: attempted });
    } finally {
      // 只有成功获得本次锁才清理，不能删除其他安装者持有的锁。
      try {
        if (acquired && existsSync(lock) && jsonFile(lock).id === lockId) { safePath(lock); unlinkSync(lock); }
      } catch (error) {
        throw Object.assign(error, { rollbackComplete: restored, installationUncertain: attempted && !restored, installationStarted: attempted, backupDir: backup });
      } finally { running = false; }
    }
  };
}

const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
export class BackgroundService {
  constructor({ dataDir, home = defaultHome(), dshBin, nodeBin = process.execPath, profile = 'web', hostPort = 3088, pluginPort = 4317, pnpmPath }, { platform = process.platform, userHome = homedir(), uid = process.getuid?.() ?? 0, query = args => spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }), run = args => exec('/bin/launchctl', args, { timeout: 15000, maxBuffer: 65536 }) } = {}) {
    this.platform = platform; this.query = query; this.run = run;
    this.options = { dataDir: absolutePath(dataDir), home: absolutePath(home), dshBin, nodeBin, profile: profileName(profile), hostPort, pluginPort, pnpmPath };
    this.label = `com.iamhej.dsh-claudia.${homeHash(home)}`;
    this.domain = `gui/${uid}`;
    this.plist = join(absolutePath(userHome), 'Library', 'LaunchAgents', `${this.label}.plist`);
    this.changing = false;
  }
  status() {
    if (this.platform !== 'darwin') return { enabled: false, supported: false, error: '后台常驻仅支持 macOS 用户 LaunchAgent' };
    const result = this.query(['print', `${this.domain}/${this.label}`]);
    if (result.error) return { enabled: false, supported: true, error: '无法查询 launchctl 的真实状态' };
    if (result.status === 0) return { enabled: true, supported: true, error: '' };
    if (/could not find service|service not found|no such process/i.test(`${result.stdout}\n${result.stderr}`)) return { enabled: false, supported: true, error: '' };
    return { enabled: false, supported: true, error: 'launchctl 查询失败，无法确认服务是否注册' };
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') fail('后台开关必须为布尔值');
    if (this.changing) fail('后台服务配置正在进行');
    this.changing = true;
    try {
      const before = this.status();
      if (!before.supported || before.error) fail(before.error);
      if (before.enabled && enabled) return before;
      if (!enabled && before.enabled && process.env.CLAUDIA_BACKGROUND_LABEL === this.label && process.env.CLAUDIA_SUPERVISED === '1') {
        writePrivate(join(this.options.dataDir, '.runtime', 'background-disable-request.json'), JSON.stringify({ id: randomUUID(), requestedAt: new Date().toISOString() }));
        return { ...before, pending: true, message: '关闭请求已提交；本次设置响应结束且宿主空闲后再停用，不将待处理请求报告为已停用' };
      }
      if (enabled) {
        const o = this.options;
        safePath(o.home); privateDirectory(o.dataDir);
        const installed = installedPackage(o.home, o.profile);
        safePath(join(installed.dir, 'bin', 'claudia.mjs'));
        const node = resolveExecutable(o.nodeBin, 'node'), dsh = resolveDsh(o.dshBin);
        const pnpm = o.pnpmPath ? resolveExecutable(o.pnpmPath, 'pnpm') : undefined;
        for (const port of [o.hostPort, o.pluginPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) fail('服务端口无效');
        // 使用 installed 稳定入口；每次启动均解析当前包，而不是开发目录或旧版本路径。
        const args = [node, join(installed.slot, 'bin', 'claudia.mjs'), 'start', '--dsh-bin', dsh, '--home', o.home, '--data-dir', o.dataDir, '--profile', o.profile, '--port', String(o.hostPort), '--plugin-port', String(o.pluginPort), '--background', '--no-open'];
        if (pnpm) args.push('--pnpm-path', pnpm);
        privateDirectory(dirname(this.plist));
        writePrivate(this.plist, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${xml(this.label)}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/><key>ExitTimeOut</key><integer>30</integer><key>WorkingDirectory</key><string>${xml(o.home)}</string><key>EnvironmentVariables</key><dict><key>DSH_HOME</key><string>${xml(o.home)}</string><key>PATH</key><string>${xml([dirname(node), ...(pnpm ? [dirname(pnpm)] : []), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter))}</string></dict></dict></plist>\n`);
        try { await this.run(['bootstrap', this.domain, this.plist]); }
        catch { fail('LaunchAgent 注册失败；不能将文件存在视为启用成功'); }
      } else {
        // 不发信号给健康检查返回的 PID；前台宿主不是该 label 的子进程。
        if (before.enabled) {
          try { await this.run(['bootout', `${this.domain}/${this.label}`]); }
          catch { fail('LaunchAgent 停用失败；未报告停用成功'); }
        }
        safePath(this.plist, { missing: true });
        if (existsSync(this.plist)) unlinkSync(this.plist);
      }
      const after = this.status();
      if (after.error || after.enabled !== enabled) fail('launchctl 操作尚未完成，真实状态与请求不一致');
      return { ...after, ...(enabled ? { message: '已启用后台 supervisor；已有同 home 前台宿主时等待其退出后接管，不重复启动' } : {}) };
    } finally { this.changing = false; }
  }
}
