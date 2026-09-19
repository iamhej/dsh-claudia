import { createHash, randomUUID } from 'node:crypto';
import {
  constants, lstatSync, mkdirSync, realpathSync, openSync, closeSync, fstatSync,
  fchmodSync, readSync, writeFileSync, fsyncSync, renameSync, linkSync, unlinkSync, opendirSync,
} from 'node:fs';
import { resolve, dirname, basename, join, parse } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateRoutine, DEFAULT_ROUTINE } from './routine-schema.mjs';

export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_PROFILE_CHARS = 12000;
export const PROFILE_DEFAULTS = Object.freeze({
  soul: '温暖地回应，也坦诚地表达判断。认真听懂对方，但不一味附和；有不同看法时，说明理由，把选择留给对方。\n\n少说教，不替人下定义，不急着把每个情绪变成建议。需要建议时，给出具体、可行的一两步。\n\n只依据已知信息回答。不编造事实、经历、记忆或已经完成的操作；不知道就说明，不确定就区分事实与推测。',
  system: '默认用中文，表达简洁自然，少套话。先回答用户当前的问题，再按需要补充理由或步骤；信息不足时只问必要的问题。\n\n区分事实、推测与建议，不编造来源或执行结果。不把历史记录里的每句话都当作当前请求。\n\nJournal 用于保存随手记录，不需要逐条回复。只有用户主动请求讨论、整理或回顾时，才围绕所选内容回应；不要擅自改写记录或用户信息。',
});
const LOCK_FORMAT = 'dsh-claudia-records-lock-v1';
const activeLocks = new Map();
export const BOOLEAN_SETTINGS = ['allowContext', 'activityEnabled', 'reflectionEnabled', 'autoUpdateEnabled', 'memorySuggestionsEnabled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const DIRECTORIES = ['journal', 'reflections', 'conversations', 'migration'];
const FIXED_FILES = ['todo.md', 'memory.md', 'soul.md', 'user.md', 'system.md', 'settings.md', 'routines.md'];
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const conflict = () => fail('Markdown 已发生变化，请重新读取 revision 后重试', 409);
const json = value => JSON.stringify(value).replace(/[<>&]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const header = kind => `<!-- dsh-claudia ${kind} v1：UTF-8；保留元数据及记录边界；正文按原文保存，可外部编辑。 -->\n`;
const collectionHeader = kind => header(kind) + '<!-- 每条记录由 dsh-record JSON 元数据及匹配的结束边界包围；id 不变。todo 使用 [ ] 待办、[x] 完成、[-] 忽略。memory 为确认记忆，candidate 为待审核/已接受/已拒绝建议。边界前的一次换行为格式分隔，不属于正文。 -->\n';
const requireText = value => { if (typeof value !== 'string' || !value.isWellFormed()) throw fail('正文必须是有效的 Unicode 字符串'); return value; };
const requireUUID = id => { if (typeof id !== 'string' || !UUID.test(id)) throw fail('记录 ID 必须是 UUID'); return id; };
const requireId = id => { if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw fail('记录 ID 格式无效'); return id; };
const timestamp = value => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail('时间必须是有效的日期字符串'); return value; };
const statOrNull = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export function validateAssistantName(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 40 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw fail('助手名字最多 40 个 UTF-16 码元，不能包含控制字符');
  return value.trim() || 'Claudia';
}

// 只接受平面 frontmatter；值支持 JSON 字符串、单引号字符串和普通单行文本。
// 不解析 YAML 标签、对象或别名，其他 frontmatter 行始终原样保留。
function frontmatter(text) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw fail('缺少有效的 Markdown frontmatter');
  const values = new Map();
  const base = match[0].indexOf('\n') + 1;
  const regex = /^([A-Za-z][A-Za-z0-9]*):[ \t]*(.*?)(\r?)$/gm;
  for (const field of match[1].matchAll(regex)) {
    if (values.has(field[1])) throw fail(`frontmatter 字段重复：${field[1]}`);
    const raw = field[2];
    let value = raw;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { throw fail(`frontmatter 字符串无效：${field[1]}`); }
    } else if (raw.startsWith("'")) {
      if (!raw.endsWith("'")) throw fail(`frontmatter 字符串无效：${field[1]}`);
      value = raw.slice(1, -1).replace(/''/g, "'");
    }
    values.set(field[1], { value, raw, start: base + field.index, end: base + field.index + field[0].length - field[3].length });
  }
  return { values, end: match[0].length, insert: base };
}
function profileBudget(name, text) {
  requireText(text);
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw fail('Markdown 文件超过 8 MiB 限制', 413);
  if (text.length > MAX_PROFILE_CHARS) throw fail(`${name}.md 设定最多 ${MAX_PROFILE_CHARS} 字符（UTF-16，包含 frontmatter），请缩短文件后重试`);
}
function nameInSoul(text) {
  profileBudget('soul', text);
  const field = frontmatter(text).values.get('assistantName');
  if (!field) throw fail('soul.md frontmatter 必须有且仅有一个 assistantName');
  return validateAssistantName(field.value);
}
function document(kind, metadata, text) {
  return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${json(value)}`).join('\n')}\n---\n${kind === 'soul' ? '' : header(kind)}${requireText(text)}`;
}
function stripProfileHeader(name, text) {
  // 只识别开头完整的旧机器说明行，不吞掉用户注释或其他空白。
  const line = header(name).slice(0, -1);
  if (!text.startsWith(line)) return text;
  const newline = /^(?:\r?\n|$)/.exec(text.slice(line.length));
  return newline ? text.slice(line.length + newline[0].length) : text;
}
function profilePrefix(name, text) {
  if (name === 'soul') return text.slice(0, frontmatter(text).end);
  return text.startsWith('\uFEFF') ? '\uFEFF' : '';
}
function profileBody(name, text) {
  return text ? stripProfileHeader(name, text.slice(profilePrefix(name, text).length)) : '';
}
function withProfileBody(name, current, body) {
  let prefix = current === null && name === 'soul' ? document('soul', { assistantName: 'Claudia' }, '') : profilePrefix(name, current ?? '');
  // 外部文件可在 frontmatter 结束边界处直接 EOF；仅在追加正文时补换行。
  if (name === 'soul' && !prefix.endsWith('\n') && body) prefix += prefix.includes('\r\n') ? '\r\n' : '\n';
  return prefix + body;
}
function withFields(text, values) {
  const meta = frontmatter(text), edits = [];
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let missing = '';
  for (const [key, value] of Object.entries(values)) {
    const field = meta.values.get(key), line = `${key}: ${json(value)}`;
    if (field) edits.push({ start: field.start, end: field.end, text: line });
    else missing += line + newline;
  }
  if (missing) edits.push({ start: meta.insert, end: meta.insert, text: missing });
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
function booleanSettings(text) {
  if (text === null) return {};
  const values = {};
  for (const [key, field] of frontmatter(text).values) {
    if (!BOOLEAN_SETTINGS.includes(key)) throw fail('settings.md 只允许非敏感行为配置');
    if (!['true', 'false'].includes(field.raw)) throw fail('settings.md 行为配置只能是 true 或 false');
    values[key] = field.raw === 'true';
  }
  return values;
}
function batchObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('批量设置包含未知字段或无效对象，不接受密钥、端点或路径');
}
function batchRevision(value) {
  if (value !== null && (typeof value !== 'string' || !DIGEST.test(value))) throw fail('revision 必须是完整文件摘要或 null');
}
function batchWriteError(error) {
  if (error.status === 409) return '写入期间 Markdown 已变化，已停止后续写入，请重新读取后重试';
  const reason = { EACCES: '没有文件写入权限', EPERM: '没有文件写入权限', ENOSPC: '磁盘空间不足', EIO: '磁盘读写失败', EROFS: '文件系统只读' }[error.code];
  return `${reason || '本机文件保存失败'}，已停止后续写入；请重新读取并检查本机文件状态`;
}
function bodyOffset(kind, text, meta) {
  let offset = meta.end;
  if (text.slice(offset).startsWith(`<!-- dsh-claudia ${kind} v1`)) {
    const end = text.indexOf('-->', offset);
    if (end === -1) throw fail('Markdown 格式注释未闭合');
    offset = end + 3;
    offset += /^\r?\n/.exec(text.slice(offset))?.[0].length ?? 0;
  }
  return offset;
}
function parseDocument(kind, text) {
  const meta = frontmatter(text);
  return { ...Object.fromEntries([...meta.values].map(([key, field]) => [key, field.value])), text: text.slice(bodyOffset(kind, text, meta)) };
}
function updateDocument(kind, current, metadata, text) {
  const meta = frontmatter(current);
  const edits = [{ start: bodyOffset(kind, current, meta), end: current.length, text }];
  let missing = '';
  for (const [key, value] of Object.entries(metadata)) {
    const field = meta.values.get(key), line = `${key}: ${json(value)}`;
    if (field) edits.push({ start: field.start, end: field.end, text: line });
    else missing += line + '\n';
  }
  if (missing) edits.push({ start: meta.insert, end: meta.insert, text: missing });
  for (const edit of edits.sort((a, b) => b.start - a.start)) current = current.slice(0, edit.start) + edit.text + current.slice(edit.end);
  return current;
}
function block(metadata, text) {
  requireText(text);
  let boundary;
  do { boundary = randomUUID(); } while (text.includes(`<!-- /dsh-record ${boundary} -->`));
  return `<!-- dsh-record ${json({ ...metadata, boundary })} -->\n${text}\n<!-- /dsh-record ${boundary} -->\n`;
}
function blocks(text) {
  const result = [], seen = new Set();
  const regex = /^<!-- dsh-record (.+) -->\r?\n/gm;
  let match;
  while ((match = regex.exec(text))) {
    let meta;
    try { meta = JSON.parse(match[1]); } catch { throw fail('记录元数据不是有效 JSON'); }
    if (!meta || !UUID.test(meta.boundary) || !UUID.test(meta.id) || !['todo', 'memory', 'candidate', 'message', 'routine'].includes(meta.type)) throw fail('记录元数据无效');
    const key = `${meta.type}:${meta.id}`;
    if (seen.has(key)) throw fail('Markdown 包含重复的记录 ID');
    seen.add(key);
    const bodyStart = regex.lastIndex;
    const ending = new RegExp(`\\n<!-- /dsh-record ${meta.boundary} -->(?:\\r?\\n|$)`, 'g');
    ending.lastIndex = bodyStart;
    const end = ending.exec(text);
    if (!end) throw fail('记录边界不完整，请先修复 Markdown', 409);
    result.push({ meta, text: text.slice(bodyStart, end.index), start: match.index, bodyStart, end: ending.lastIndex });
    regex.lastIndex = ending.lastIndex;
  }
  return result;
}
function sameLock(a, b) {
  return a && b && a.stat.ino === b.stat.ino && a.stat.dev === b.stat.dev && a.revision === b.revision;
}
function lockSnapshot(path) {
  const stat = statOrNull(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink) || stat.size > 4096) throw fail('写锁不是可识别的普通 owner 文件，请人工检查；不会自动删除', 409);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile() || opened.nlink !== stat.nlink) throw fail('写锁已被替换，请重试', 409);
    const buffer = Buffer.alloc(4097);
    let size = 0, count;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    const after = fstatSync(fd), current = statOrNull(path);
    if (size > 4096 || !current || current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== opened.nlink || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw fail('写锁读取期间发生变化，请重试', 409);
    const bytes = buffer.subarray(0, size);
    return { stat: after, text: bytes.toString('utf8'), revision: hash(bytes) };
  } finally { closeSync(fd); }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function append(text, addition) { return text + (text && !text.endsWith('\n') ? '\n' : '') + addition; }
function replaceBlock(text, entry, replacement) { return text.slice(0, entry.start) + replacement + text.slice(entry.end); }
function todo(entry, revision) {
  const check = /^- \[([ xX-])\] /.exec(entry.text);
  if (!check) throw fail('todo 记录必须以 - [ ]、- [x] 或 - [-] 开始');
  return { id: entry.meta.id, text: entry.text.slice(check[0].length), status: check[1] === ' ' ? 'todo' : check[1] === '-' ? 'dismissed' : 'done', createdAt: entry.meta.createdAt, updatedAt: entry.meta.updatedAt ?? entry.meta.createdAt, revision };
}
function candidate(entry) {
  const { id, source, status, createdAt, decidedAt, memoryId } = entry.meta;
  if (!['pending', 'accepted', 'rejected'].includes(status)) throw fail('记忆建议状态无效');
  return { id, text: entry.text, source, status, createdAt, ...(decidedAt ? { decidedAt } : {}), ...(memoryId ? { memoryId } : {}) };
}

function routineTime(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value)) || new Date(`${match[1]}T00:00:00.000Z`).toISOString().slice(0, 10) !== match[1]) throw fail('Routine 时间必须是有效的 ISO 日期时间');
  return value;
}
function routineFields({ name, prompt, schedule, allowNetwork, delivery, enabled }) {
  return { name, prompt, schedule, allowNetwork, delivery, enabled };
}
function routineEntries(text) {
  const entries = blocks(text ?? '').filter(entry => entry.meta.type === 'routine');
  if (entries.length > 100) throw fail('Routine 最多允许 100 个任务');
  return entries.map(entry => {
    const input = validateRoutine(routineFields({ ...entry.meta, prompt: entry.text }));
    const { id, createdAt, updatedAt, enabledAt, version } = entry.meta;
    if (!Number.isSafeInteger(version) || version < 1) throw fail('Routine version 必须是正整数');
    if (input.enabled ? enabledAt === null : enabledAt !== null) throw fail('Routine enabledAt 必须与启用状态一致');
    const job = { id: requireUUID(id), ...input, createdAt: routineTime(createdAt), updatedAt: routineTime(updatedAt), enabledAt: input.enabled ? routineTime(enabledAt) : null, version };
    return { entry, job };
  });
}
function routineBlock(job, previous = {}) {
  const { prompt, ...metadata } = { ...previous, ...job };
  return block({ ...metadata, type: 'routine' }, prompt);
}

export class Records {
  constructor(root) {
    // macOS 的 /var 与 /tmp 是系统别名；其余祖先和数据目录均不得为符号链接。
    let current = parse(resolve(root)).root;
    for (const part of resolve(root).slice(current.length).split('/').filter(Boolean)) {
      current = join(current, part);
      let stat = statOrNull(current);
      if (stat?.isSymbolicLink() && process.platform === 'darwin' && ['/var', '/tmp'].includes(current)) {
        current = realpathSync(current); stat = lstatSync(current);
      }
      if (!stat) { mkdirSync(current, { mode: 0o700 }); stat = lstatSync(current); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('数据目录不得为符号链接或非目录', 400);
    }
    this.root = current;
    this.rootIdentity = lstatSync(this.root);
    this.directory(this.root);
    for (const name of DIRECTORIES) {
      const path = join(this.root, name);
      if (!statOrNull(path)) mkdirSync(path, { mode: 0o700 });
      this.directory(path);
    }
  }
  directory(path) {
    if (this.closed) throw new Error('Store 已关闭 (closed)');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('拒绝符号链接或非目录', 400);
    if (path === this.root && (stat.ino !== this.rootIdentity.ino || stat.dev !== this.rootIdentity.dev || realpathSync(path) !== path)) throw fail('数据目录已被替换', 409);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { if ((fstatSync(fd).mode & 0o777) !== 0o700) fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  }
  path(name) {
    if (!FIXED_FILES.includes(name)) {
      const parts = name.split('/');
      if (parts.length !== 2 || !DIRECTORIES.includes(parts[0]) || !parts[1].endsWith('.md') || !(UUID.test(parts[1].slice(0, -3)) || DIGEST.test(parts[1].slice(0, -3)))) throw fail('不允许访问此记录路径');
    }
    this.directory(this.root);
    const path = join(this.root, name);
    if (dirname(path) !== this.root) this.directory(dirname(path));
    return path;
  }
  // SQLite 的主文件及 sidecar 也必须位于同一个安全目录，且不是链接。
  databasePath(file) {
    const path = join(this.root, basename(file));
    for (const target of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      const stat = statOrNull(target);
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw fail('拒绝链接或非普通 SQLite 文件');
      if (stat) {
        const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = fstatSync(fd);
          if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw conflict();
          if ((opened.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
        } finally { closeSync(fd); }
      }
    }
    return path;
  }
  read(name) {
    const path = this.path(name);
    const stat = statOrNull(path);
    if (!stat) return { text: null, revision: null };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('拒绝符号链接、硬链接或非普通记录文件');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw conflict();
      if (opened.size > MAX_RECORD_BYTES) throw fail('Markdown 文件超过 8 MiB 限制', 413);
      if ((opened.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
      const stable = fstatSync(fd);
      const chunks = [];
      let size = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_RECORD_BYTES + 1 - size));
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (!count) break;
        size += count;
        if (size > MAX_RECORD_BYTES) throw fail('Markdown 文件超过 8 MiB 限制', 413);
        chunks.push(chunk.subarray(0, count));
      }
      const after = fstatSync(fd), current = statOrNull(path);
      if (!current || current.isSymbolicLink() || current.ino !== stable.ino || current.dev !== stable.dev || current.nlink !== 1 || after.size !== stable.size || after.mtimeMs !== stable.mtimeMs || after.ctimeMs !== stable.ctimeMs) throw conflict();
      const bytes = Buffer.concat(chunks);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail('Markdown 文件不是有效的 UTF-8'); }
      return { text, revision: hash(bytes) };
    } finally { closeSync(fd); }
  }
  recoverLock(path) {
    const original = lockSnapshot(path);
    if (!original) return;
    let owner;
    try { owner = JSON.parse(original.text); } catch {}
    if (owner?.format !== LOCK_FORMAT || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647 || typeof owner.ownerToken !== 'string' || !UUID.test(owner.ownerToken) || typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt))) throw fail('未知或空的旧写锁缺少有效 PID、owner token 或开始时间，请人工检查；不会自动删除', 409);
    // link 发布后、临时名移除前退出会留下两个链接；只认可本协议的精确临时名。
    if (original.stat.nlink === 2 && !sameLock(original, lockSnapshot(join(this.root, `.record-${owner.ownerToken}.tmp`)))) throw fail('写锁包含未知硬链接，拒绝自动恢复', 409);
    if (owner.pid === process.pid) {
      const owned = activeLocks.get(path) === owner.ownerToken;
      throw fail(owned ? '当前进程正在写入记录，请重试' : '写锁 PID 与当前进程相同但 owner token 不匹配，拒绝自动恢复', 409);
    }
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw fail('无法确认写锁进程已退出（可能无权限），拒绝自动恢复', 409);
      // 不按年龄清理；移动前重新核对原 inode 和内容，保留死亡进程的锁作审计。
      this.directory(join(this.root, 'migration'));
      if (!sameLock(original, lockSnapshot(path))) throw fail('写锁已被替换或修改，拒绝恢复', 409);
      const orphan = join(this.root, 'migration', `.records-lock-${owner.ownerToken}-${randomUUID()}.orphan`);
      try { renameSync(path, orphan); }
      catch (moveError) { if (moveError.code === 'ENOENT') throw fail('写锁已被其他进程恢复，请重试', 409); throw moveError; }
      let moved;
      try { moved = lockSnapshot(orphan); } catch {}
      if (!sameLock(original, moved)) {
        // 移动的最后窗口仍可能有外部替换；无法验证时也保留现场，只恢复空位。
        try { linkSync(orphan, path); } catch (restoreError) { if (restoreError.code !== 'EEXIST') throw restoreError; }
        syncDirectory(join(this.root, 'migration'));
        syncDirectory(this.root);
        throw fail('写锁移动期间发生变化，已保留 orphan，拒绝写入', 409);
      }
      syncDirectory(join(this.root, 'migration'));
      syncDirectory(this.root);
      return;
    }
    throw fail('写锁所属进程仍存活，记录正在写入，请重试', 409);
  }
  locked(fn) {
    this.directory(this.root);
    const path = join(this.root, '.records.lock');
    const owner = { format: LOCK_FORMAT, pid: process.pid, ownerToken: randomUUID(), startedAt: new Date().toISOString() };
    const temporary = join(this.root, `.record-${owner.ownerToken}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let identity;
    try {
      try { writeFileSync(fd, JSON.stringify(owner) + '\n', 'utf8'); fsyncSync(fd); identity = fstatSync(fd); }
      finally { closeSync(fd); }
      // 完整 owner 文件原子发布，崩溃不会留下应用自己创建的空锁。
      try { linkSync(temporary, path); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        this.recoverLock(path);
        try { linkSync(temporary, path); }
        catch (retryError) { if (retryError.code === 'EEXIST') throw fail('记录正在写入，请重试', 409); throw retryError; }
      }
    } finally { unlinkSync(temporary); }
    const expected = { stat: identity, revision: hash(JSON.stringify(owner) + '\n') };
    activeLocks.set(path, owner.ownerToken);
    try { syncDirectory(this.root); return fn(); }
    finally {
      if (activeLocks.get(path) === owner.ownerToken) activeLocks.delete(path);
      let current;
      try { current = lockSnapshot(path); } catch (error) { if (error.status !== 409) throw error; }
      if (sameLock(expected, current)) { unlinkSync(path); syncDirectory(this.root); }
    }
  }
  write(name, text, expectedRevision) {
    requireText(text);
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw fail('Markdown 文件超过 8 MiB 限制', 413);
    const path = this.path(name);
    if (this.read(name).revision !== expectedRevision) throw conflict();
    const temporary = join(dirname(path), `.record-${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      if (this.read(name).revision !== expectedRevision) throw conflict();
      if (expectedRevision === null) {
        try { linkSync(temporary, path); } catch (error) { if (error.code === 'EEXIST') throw conflict(); throw error; }
        unlinkSync(temporary);
      } else renameSync(temporary, path);
      const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { if (statOrNull(temporary)) unlinkSync(temporary); }
    return { text, revision: hash(text) };
  }
  edit(name, fn, expectedRevision) {
    return this.locked(() => {
      const current = this.read(name);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw conflict();
      const next = fn(current.text, current.revision);
      return next === current.text ? current : this.write(name, next, current.revision);
    });
  }
  files(directory) {
    if (!DIRECTORIES.includes(directory)) throw fail('不允许访问此记录目录');
    this.directory(this.root);
    const path = join(this.root, directory);
    this.directory(path);
    const dir = opendirSync(path), names = [];
    let count = 0;
    try {
      let entry;
      while ((entry = dir.readSync())) {
        if (++count > 10000) throw fail('记录目录超过 10000 项读取限制', 413);
        if (entry.name.endsWith('.md') && (UUID.test(entry.name.slice(0, -3)) || DIGEST.test(entry.name.slice(0, -3)))) names.push(`${directory}/${entry.name}`);
      }
    } finally { dir.closeSync(); }
    return names.sort();
  }
  migrate({ journal, memories, messages, settings }) {
    this.locked(() => {
      const create = (name, text, backup = true) => {
        const current = this.read(name);
        if (current.text === null) this.write(name, text, null);
        else if (backup && current.text !== text) {
          // 冲突旧数据另存只读语义的迁移副本，不替换或合并用户当前 MD。
          const archive = `migration/${hash(name + '\0' + text)}.md`;
          if (this.read(archive).text === null) this.write(archive, header('sqlite-migration') + text, null);
        }
      };
      for (const entry of journal) create(`journal/${requireUUID(entry.id)}.md`, document('journal', entryWithoutText(entry), entry.text));
      const memoryText = collectionHeader('memory') + memories.map(entry => block({ type: 'memory', ...entryWithoutText(entry) }, entry.text)).join('');
      if (this.read('memory.md').text === null) create('memory.md', memoryText);
      else for (const entry of memories) create(`migration/${hash('memory:' + entry.id)}.md`, document('memory', entryWithoutText(entry), entry.text), false);
      create('todo.md', collectionHeader('todo'), false);
      create('soul.md', document('soul', { assistantName: validateAssistantName(settings.assistantName ?? 'Claudia') }, ''), settings.assistantName !== undefined);
      create('user.md', '', false);
      create('system.md', '', false);
      const bools = Object.fromEntries(BOOLEAN_SETTINGS.map(key => [key, typeof settings[key] === 'boolean' ? settings[key] : false]));
      create('settings.md', document('settings', bools, '<!-- 只接受上述非敏感 bool 配置，不得在此保存密钥。 -->\n'), BOOLEAN_SETTINGS.some(key => settings[key] !== undefined));
      const sessions = new Map();
      for (const entry of messages) {
        if (!sessions.has(entry.sessionId)) sessions.set(entry.sessionId, []);
        sessions.get(entry.sessionId).push(entry);
      }
      for (const [sessionId, entries] of sessions) create(this.conversationFile(sessionId), this.conversationHeader(sessionId) + entries.map(entry => this.messageBlock(entry)).join(''));
    });
  }
  journal() {
    return this.files('journal').map(name => {
      const entry = parseDocument('journal', this.read(name).text);
      if (entry.id !== basename(name, '.md')) throw fail('journal ID 必须与 UUID 文件名一致');
      return { id: requireUUID(entry.id), text: entry.text, occurredAt: timestamp(entry.occurredAt), createdAt: timestamp(entry.createdAt) };
    }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt));
  }
  addJournal(text, occurredAt = new Date().toISOString()) {
    const entry = { id: randomUUID(), text: requireText(text), occurredAt: timestamp(occurredAt), createdAt: new Date().toISOString() };
    this.edit(`journal/${entry.id}.md`, () => document('journal', entryWithoutText(entry), text), null);
    return entry;
  }
  deleteJournal(id, expectedRevision) {
    const name = `journal/${requireUUID(id)}.md`;
    return this.locked(() => {
      const current = this.read(name);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw conflict();
      if (current.text === null) return false;
      if (this.read(name).revision !== current.revision) throw conflict();
      const path = this.path(name);
      unlinkSync(path);
      const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      return true;
    });
  }
  todos() {
    const { text, revision } = this.read('todo.md');
    return blocks(text ?? '').filter(entry => entry.meta.type === 'todo').map(entry => todo(entry, revision));
  }
  addTodo(text) {
    requireText(text);
    const createdAt = new Date().toISOString();
    const meta = { type: 'todo', id: randomUUID(), createdAt, updatedAt: createdAt };
    const saved = this.edit('todo.md', current => {
      blocks(current ?? '');
      return append(current ?? collectionHeader('todo'), block(meta, '- [ ] ' + text));
    });
    return { id: meta.id, text, status: 'todo', createdAt: meta.createdAt, updatedAt: meta.updatedAt, revision: saved.revision };
  }
  updateTodo(id, status, expectedRevision) {
    requireUUID(id);
    if (!['todo', 'done', 'dismissed'].includes(status)) throw fail('todo 状态必须是 todo、done 或 dismissed');
    let result;
    const saved = this.edit('todo.md', current => {
      const entry = blocks(current ?? '').find(entry => entry.meta.type === 'todo' && entry.meta.id === id);
      if (!entry) throw fail('待办不存在', 404);
      result = todo(entry);
      if (result.status === status) return current;
      result = { ...result, status, updatedAt: new Date().toISOString() };
      const metadata = current.slice(entry.start, entry.bodyStart).replace(/^<!-- dsh-record .+ -->/, () => `<!-- dsh-record ${json({ ...entry.meta, updatedAt: result.updatedAt })} -->`);
      const offset = entry.bodyStart + 3;
      return current.slice(0, entry.start) + metadata + current.slice(entry.bodyStart, offset) + ({ todo: ' ', done: 'x', dismissed: '-' }[status]) + current.slice(offset + 1);
    }, expectedRevision);
    return { ...result, revision: saved.revision };
  }
  memories() {
    return blocks(this.read('memory.md').text ?? '').filter(entry => entry.meta.type === 'memory').map(entry => ({ id: entry.meta.id, text: entry.text, createdAt: entry.meta.createdAt })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  addMemory(text) {
    const entry = { id: randomUUID(), text: requireText(text), createdAt: new Date().toISOString() };
    this.edit('memory.md', current => {
      blocks(current ?? '');
      return append(current ?? collectionHeader('memory'), block({ type: 'memory', ...entryWithoutText(entry) }, text));
    });
    return entry;
  }
  deleteMemory(id, expectedRevision) {
    requireUUID(id);
    let removed = false;
    this.edit('memory.md', current => {
      const entry = blocks(current ?? '').find(entry => entry.meta.type === 'memory' && entry.meta.id === id);
      if (!entry) return current;
      removed = true;
      return replaceBlock(current, entry, '');
    }, expectedRevision);
    return removed;
  }
  routines() {
    const { text, revision } = this.read('routines.md');
    return { jobs: routineEntries(text).map(({ job }) => job), revision };
  }
  saveRoutine(input, expectedRevision, id = null, now = new Date()) {
    if (expectedRevision === undefined) throw conflict();
    const fields = validateRoutine(input);
    if (id !== null) requireUUID(id);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw fail('Routine now 必须是有效日期');
    const time = routineTime(now.toISOString());
    let result;
    const saved = this.edit('routines.md', current => {
      const entries = routineEntries(current);
      const old = id === null ? null : entries.find(({ job }) => job.id === id);
      if (id !== null && !old) throw fail('Routine 不存在', 404);
      if (old && isDeepStrictEqual(routineFields(old.job), fields)) { result = old.job; return current; }
      if (!old && entries.length >= 100) throw fail('Routine 最多允许 100 个任务');
      if (old?.job.version === Number.MAX_SAFE_INTEGER) throw fail('Routine version 超过安全整数范围');
      result = { id: old?.job.id ?? randomUUID(), ...fields, createdAt: old?.job.createdAt ?? time, updatedAt: time, enabledAt: fields.enabled ? time : null, version: (old?.job.version ?? 0) + 1 };
      const replacement = routineBlock(result, old?.entry.meta);
      return old ? replaceBlock(current, old.entry, replacement) : append(current ?? collectionHeader('routine'), replacement);
    }, expectedRevision);
    return { ...result, revision: saved.revision };
  }
  deleteRoutine(id, revision) {
    if (revision === undefined) throw conflict();
    requireUUID(id);
    let removed = false;
    this.edit('routines.md', current => {
      const target = routineEntries(current).find(({ job }) => job.id === id);
      if (!target) return current;
      removed = true;
      return replaceBlock(current, target.entry, '');
    }, revision);
    return removed;
  }
  // Store 持有 records 锁；迁移标记写入 SQLite 后，删除默认任务不会被重新填充。
  migrateRoutines() {
    const current = this.read('routines.md');
    if (current.text !== null) return;
    const fields = validateRoutine(DEFAULT_ROUTINE), time = new Date().toISOString();
    const job = { id: randomUUID(), ...fields, createdAt: time, updatedAt: time, enabledAt: fields.enabled ? time : null, version: 1 };
    this.write('routines.md', collectionHeader('routine') + routineBlock(job), null);
  }
  profiles() {
    return Object.fromEntries(['soul', 'user', 'system'].map(name => {
      const profile = this.read(`${name}.md`);
      if (profile.text !== null) {
        profileBudget(name, profile.text);
        if (name === 'soul') nameInSoul(profile.text);
      }
      return [name, { text: profile.text ?? '', revision: profile.revision, body: profileBody(name, profile.text ?? '') }];
    }));
  }
  saveProfile(name, text, revision) {
    if (!['soul', 'user', 'system'].includes(name)) throw fail('不允许的 profile 名称');
    profileBudget(name, text);
    if (revision === undefined) throw conflict();
    if (name === 'soul') nameInSoul(text);
    return this.edit(`${name}.md`, () => text, revision);
  }
  saveProfileBody(name, body, revision) {
    if (!['soul', 'user', 'system'].includes(name)) throw fail('不允许的 profile 名称');
    profileBudget(name, body);
    if (revision === undefined) throw conflict();
    const saved = this.edit(`${name}.md`, current => {
      const next = withProfileBody(name, current, body);
      profileBudget(name, next);
      if (name === 'soul') nameInSoul(next);
      return next;
    }, revision);
    return { ...saved, body: profileBody(name, saved.text) };
  }
  // 调用方 Store 持有同一个 records 锁，并在全部写入成功后记迁移版本。
  migrateProfileDefaults() {
    for (const [name, body] of Object.entries(PROFILE_DEFAULTS)) {
      const current = this.read(`${name}.md`);
      if (current.text === null) continue;
      const oldBody = current.text.slice(profilePrefix(name, current.text).length).trim();
      if (oldBody && oldBody !== header(name).trim()) continue;
      const next = withProfileBody(name, current.text, body);
      profileBudget(name, next);
      if (name === 'soul') nameInSoul(next);
      this.write(`${name}.md`, next, current.revision);
    }
  }
  saveSettingsBatch(data) {
    batchObject(data, ['settings', 'profiles', 'settingsRevision', 'soulRevision']);
    const settings = Object.hasOwn(data, 'settings') ? data.settings : {};
    const profiles = Object.hasOwn(data, 'profiles') ? data.profiles : {};
    batchObject(settings, ['assistantName', ...BOOLEAN_SETTINGS]);
    batchObject(profiles, ['soul', 'user', 'system']);
    const hasName = Object.hasOwn(settings, 'assistantName');
    const name = hasName ? validateAssistantName(settings.assistantName) : null;
    for (const key of BOOLEAN_SETTINGS) if (Object.hasOwn(settings, key) && typeof settings[key] !== 'boolean') throw fail('开关必须是布尔值');
    for (const key of ['settingsRevision', 'soulRevision']) if (Object.hasOwn(data, key)) batchRevision(data[key]);
    for (const [key, value] of Object.entries(profiles)) {
      batchObject(value, ['body', 'revision']);
      profileBudget(key, value.body);
      if (!Object.hasOwn(value, 'revision')) throw conflict();
      batchRevision(value.revision);
    }
    const result = { saved: [], errors: {} };
    let writing = false, attempted;
    try {
      return this.locked(() => {
        const currentSettings = this.read('settings.md'), oldSettings = booleanSettings(currentSettings.text);
        const currentProfiles = this.profiles();
        const bools = Object.fromEntries(BOOLEAN_SETTINGS.filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
        if (Object.keys(bools).length && currentSettings.revision !== data.settingsRevision) throw conflict();
        if (hasName && currentProfiles.soul.revision !== data.soulRevision) throw conflict();
        const changes = [];
        const changedBools = Object.fromEntries(Object.entries(bools).filter(([key, value]) => value !== (oldSettings[key] ?? false)));
        if (Object.keys(changedBools).length) {
          const next = currentSettings.text === null ? document('settings', changedBools, '') : withFields(currentSettings.text, changedBools);
          requireText(next);
          if (Buffer.byteLength(next) > MAX_RECORD_BYTES) throw fail('Markdown 文件超过 8 MiB 限制');
          booleanSettings(next);
          changes.push({ key: 'settings', text: next, revision: currentSettings.revision });
        }
        for (const key of ['soul', 'user', 'system']) {
          const current = currentProfiles[key];
          if (Object.hasOwn(profiles, key) && current.revision !== profiles[key].revision) throw conflict();
          if (!Object.hasOwn(profiles, key) && !(key === 'soul' && hasName)) continue;
          const original = current.revision === null ? null : current.text;
          let next = Object.hasOwn(profiles, key) ? withProfileBody(key, original, profiles[key].body) : original;
          if (key === 'soul' && hasName) {
            if (next === null) next = document('soul', { assistantName: name }, '');
            else if (validateAssistantName(frontmatter(next).values.get('assistantName')?.value) !== name) next = withFields(next, { assistantName: name });
          }
          profileBudget(key, next);
          if (key === 'soul') nameInSoul(next);
          if (next !== original) changes.push({ key, text: next, revision: current.revision });
        }
        // locked 不可重入：准备阶段不调用 edit/saveProfileBody/setBoolean，全部预检通过才直接原子写。
        for (const change of changes) {
          attempted = change.key;
          writing = true;
          try { this.write(`${change.key}.md`, change.text, change.revision); result.saved.push(change.key); }
          catch (error) {
            // rename 后目录 fsync 也可能失败；回读确认可见的写入，不谎称文件未保存。
            try { if (this.read(`${change.key}.md`).revision === hash(change.text)) result.saved.push(change.key); } catch {}
            result.errors[change.key] = batchWriteError(error);
            break;
          }
        }
        return result;
      });
    } catch (error) {
      if (!writing) throw error;
      result.errors[attempted] = batchWriteError(error);
      return result;
    }
  }
  assistantName(fallback = null) {
    const { text } = this.read('soul.md');
    return text === null ? fallback : nameInSoul(text);
  }
  setAssistantName(value) {
    const name = validateAssistantName(value);
    this.edit('soul.md', text => {
      if (text === null) return document('soul', { assistantName: name }, '');
      nameInSoul(text);
      const field = frontmatter(text).values.get('assistantName');
      const next = text.slice(0, field.start) + `assistantName: ${json(name)}` + text.slice(field.end);
      nameInSoul(next);
      return next;
    });
  }
  settings() { return booleanSettings(this.read('settings.md').text); }
  setBoolean(key, value) {
    if (!BOOLEAN_SETTINGS.includes(key) || typeof value !== 'boolean') throw fail('行为配置必须是 bool');
    this.edit('settings.md', text => {
      if (text === null) return document('settings', { [key]: value }, '');
      this.settings();
      const meta = frontmatter(text), field = meta.values.get(key);
      const line = `${key}: ${value}`;
      return field ? text.slice(0, field.start) + line + text.slice(field.end) : text.slice(0, meta.insert) + line + '\n' + text.slice(meta.insert);
    });
  }
  reflections() {
    return this.files('reflections').map(name => {
      const { text, revision } = this.read(name);
      const entry = parseDocument('reflection', text);
      if (name !== `reflections/${hash(requireId(entry.id))}.md`) throw fail('reflection ID 与文件名不一致');
      return { id: entry.id, text: entry.text, start: timestamp(entry.start), end: timestamp(entry.end), createdAt: timestamp(entry.createdAt), revision };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  saveReflection({ id, text, start, end, createdAt }, expectedRevision) {
    requireId(id); requireText(text); timestamp(start); timestamp(end);
    if (Date.parse(start) > Date.parse(end)) throw fail('reflection 开始时间不得晚于结束时间');
    let entry;
    const saved = this.edit(`reflections/${hash(id)}.md`, current => {
      const old = current === null ? null : parseDocument('reflection', current);
      if (old && old.id !== id) throw fail('reflection ID 与文件名不一致');
      entry = { id, text, start, end, createdAt: timestamp(createdAt ?? old?.createdAt ?? new Date().toISOString()) };
      return current === null ? document('reflection', entryWithoutText(entry), text) : updateDocument('reflection', current, entryWithoutText(entry), text);
    }, expectedRevision ?? null);
    return { ...entry, revision: saved.revision };
  }
  memoryCandidates() {
    return blocks(this.read('memory.md').text ?? '').filter(entry => entry.meta.type === 'candidate').map(candidate);
  }
  addMemoryCandidates(entries) {
    if (!Array.isArray(entries)) throw fail('记忆建议必须是数组');
    const candidates = entries.map(entry => {
      if (!entry || typeof entry !== 'object') throw fail('记忆建议必须包含 text 与 source');
      const { text, source } = entry;
      requireText(text);
      if (source === undefined) throw fail('记忆建议必须包含 source');
      let copied;
      try { copied = JSON.parse(JSON.stringify(source)); } catch { throw fail('source 必须可以序列化为 JSON'); }
      return { id: randomUUID(), text, source: copied, status: 'pending', createdAt: new Date().toISOString() };
    });
    if (!candidates.length) return [];
    this.edit('memory.md', current => {
      blocks(current ?? '');
      return append(current ?? collectionHeader('memory'), candidates.map(entry => block({ type: 'candidate', ...entryWithoutText(entry) }, entry.text)).join(''));
    });
    return candidates;
  }
  decideCandidate(id, accept) {
    requireUUID(id);
    if (typeof accept !== 'boolean') throw fail('accept 必须是 bool');
    let result;
    this.edit('memory.md', current => {
      const entries = blocks(current ?? '');
      const entry = entries.find(entry => entry.meta.type === 'candidate' && entry.meta.id === id);
      if (!entry) throw fail('记忆建议不存在', 404);
      const old = candidate(entry), status = accept ? 'accepted' : 'rejected';
      if (old.status !== 'pending') {
        if (old.status !== status) throw conflict();
        result = old;
        return current;
      }
      result = { ...old, status, decidedAt: new Date().toISOString(), ...(accept ? { memoryId: randomUUID() } : {}) };
      let next = replaceBlock(current, entry, block({ ...entry.meta, type: 'candidate', ...entryWithoutText(result) }, entry.text));
      if (accept) next = append(next, block({ type: 'memory', id: result.memoryId, createdAt: result.decidedAt, source: old.source, candidateId: id }, entry.text));
      return next;
    });
    return result;
  }
  conversationFile(sessionId) { return `conversations/${UUID.test(sessionId) ? sessionId : hash(String(sessionId))}.md`; }
  conversationHeader(sessionId) { return document('conversation', { sessionId }, collectionHeader('messages')); }
  messageBlock(entry) {
    const { id, role, createdAt, status } = entry;
    return block({ type: 'message', id, role, createdAt, status }, entry.content);
  }
  // 调用者持有 records 锁；只准备副本，SQLite COMMIT 成功后才执行返回的写操作。
  prepareConversation(sessionId, previous, next) {
    const name = this.conversationFile(sessionId), current = this.read(name);
    if (current.text === null && next.length === 0) return () => {};
    let parsed = [];
    try { parsed = blocks(current.text ?? ''); }
    catch (error) { if (![400, 409].includes(error.status)) throw error; parsed = null; }
    const matches = parsed?.length === previous.length && parsed.every((entry, i) => {
      const old = previous[i];
      return entry.meta.type === 'message' && entry.meta.id === old.id && entry.meta.role === old.role && entry.meta.createdAt === old.createdAt && entry.meta.status === old.status && entry.text === old.content;
    });
    let text;
    if (matches) {
      text = current.text ?? this.conversationHeader(sessionId);
      const byId = new Map(next.map(entry => [entry.id, entry]));
      for (const entry of [...parsed].reverse()) {
        const value = byId.get(entry.meta.id);
        if (!value) text = replaceBlock(text, entry, '');
        else if (entry.text !== value.content || entry.meta.status !== value.status || entry.meta.role !== value.role || entry.meta.createdAt !== value.createdAt) {
          text = replaceBlock(text, entry, block({ ...entry.meta, role: value.role, createdAt: value.createdAt, status: value.status }, value.content));
        }
      }
      const ids = new Set(parsed.map(entry => entry.meta.id));
      for (const entry of next) if (!ids.has(entry.id)) text = append(text, this.messageBlock(entry));
    } else text = this.conversationHeader(sessionId) + next.map(entry => this.messageBlock(entry)).join('');
    requireText(text);
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw fail('Markdown 文件超过 8 MiB 限制', 413);
    return () => {
      if (text === current.text) return;
      if (!matches && current.text !== null) {
        // 不把会话 MD 回灌 SQLite；任何冲突或旧版双写遗留都先逐字保存再重建。
        const archive = `migration/${hash('conversation-conflict\0' + name + '\0' + current.revision)}.md`;
        const backup = this.read(archive);
        if (backup.text === null) this.write(archive, current.text, null);
        else if (backup.text !== current.text) throw conflict();
      }
      this.write(name, text, current.revision);
    };
  }
  addMessage(sessionId, entry) {
    this.edit(this.conversationFile(sessionId), current => {
      const entries = blocks(current ?? '');
      if (entries.some(item => item.meta.id === entry.id)) throw conflict();
      return append(current ?? this.conversationHeader(sessionId), this.messageBlock(entry));
    });
  }
  updateMessage(sessionId, previous, next) {
    this.edit(this.conversationFile(sessionId), current => {
      const entry = blocks(current ?? '').find(entry => entry.meta.type === 'message' && entry.meta.id === previous.id);
      if (!entry || entry.text !== previous.content || entry.meta.status !== previous.status || entry.meta.role !== previous.role) throw conflict();
      return replaceBlock(current, entry, block({ ...entry.meta, role: next.role, createdAt: next.createdAt, status: next.status }, next.content));
    });
  }
}
function entryWithoutText({ text, ...metadata }) { return metadata; }
