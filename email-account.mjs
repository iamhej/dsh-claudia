import { createHmac, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const NS = 'dsh-email';
const COMPATIBLE = '0.11.0-claudia.2';
const QQ = /^[a-z0-9][a-z0-9._-]{0,99}@(qq\.com|foxmail\.com)$/i;
const fields = new Set(['provider', 'user', 'password', 'receiveEnabled', 'sendEnabled', 'inboxFolder', 'sendApproval', 'maxBodyChars', 'downloadDir', 'serverPresets', 'imap', 'smtp', 'accountsYaml']);
const endpoints = { imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true } };
const safeErrors = new WeakSet();
const fail = (message, status = 409) => { const error = Object.assign(new Error(message), { status }); safeErrors.add(error); return error; };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const present = value => value !== undefined && value !== null && value !== '';

// 仅使用已注册的命名空间，不另建邮件运行时、不读取凭据文件、不调用邮箱工具。
export class EmailAccount {
  constructor({ getSettings, getEntries, getPlugins }) {
    this.getSettings = getSettings;
    this.getEntries = getEntries;
    this.getPlugins = getPlugins;
    this.key = randomBytes(32); // 随机密钥 HMAC，避免产生可复用的密码摘要。
    this.writing = false;
  }
  input() {
    const settings = this.getSettings();
    const packages = this.getPlugins()?.packages?.filter(p => p.name === NS) ?? [];
    if (packages.length !== 1 || !['0.11.0', COMPATIBLE].includes(packages[0].version) || packages[0].installed !== true)
      throw fail('此简易表单仅支持已安装的 dsh-email 0.11.0 或 0.11.0-claudia.2；未改动邮箱配置。');
    const compatible = packages[0].version === COMPATIBLE;
    const rows = [...(this.getEntries() ?? [])].filter(e => e.options?.name === NS);
    const entry = rows[0];
    if (rows.length !== 1 || entry.options?.group || entry.disabled !== false || entry.fiber?.state !== 2 || !plain(entry.fiber.config))
      throw fail('请先启用邮件扩展并重启，待其加载完成后刷新邮箱配置。');
    if (!settings || typeof settings.describe !== 'function' ||
        (compatible && (settings.writable !== true || typeof settings.mutate !== 'function')))
      throw fail('当前宿主未提供可用的邮箱设置接口或原子写入能力。');
    const descriptors = settings.describe().filter(d => d.ns === NS);
    const descriptor = descriptors[0];
    if (descriptors.length !== 1 || descriptor.applies !== 'live' || !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0 || !plain(descriptor.value))
      throw fail('未能核对邮件配置状态，请刷新后再试。');
    const row = entry.fiber.config;
    // row 中的命名账号不会进入 settings base，必须逐层拒绝，不能扁平化覆盖。
    for (const layer of [row, descriptor.base, descriptor.user, descriptor.value]) {
      if (layer === undefined) continue;
      if (!plain(layer) || Object.keys(layer).some(k => !fields.has(k)) || present(layer.accountsYaml) || present(layer.serverPresets))
        throw fail('检测到多账号或高级邮件配置；简易表单不会覆盖，请使用宿主高级配置。');
      if (present(layer.provider) && layer.provider !== 'qq')
        throw fail('当前不是 QQ 单账号配置；简易表单不会替换其它邮箱。');
      for (const key of ['receiveEnabled', 'sendEnabled']) {
        if (layer[key] !== undefined && typeof layer[key] !== 'boolean')
          throw fail('邮箱收发权限格式不可识别；未改动已有配置。');
      }
      for (const kind of ['imap', 'smtp']) {
        const endpoint = layer[kind];
        if (endpoint === undefined) continue;
        if (!plain(endpoint) || Object.keys(endpoint).some(k => !['host', 'port', 'secure'].includes(k)) ||
            Object.entries(endpoint).some(([k, v]) => present(v) && v !== endpoints[kind][k]))
          throw fail('检测到自定义邮件服务器；简易表单不会覆盖。');
      }
    }
    const value = descriptor.value;
    if (typeof value.user !== 'string' || (value.user !== '' && !QQ.test(value.user)) || typeof value.password !== 'string')
      throw fail('现有账号不是可安全编辑的 QQ 单账号配置。');
    if (compatible && (typeof value.receiveEnabled !== 'boolean' || typeof value.sendEnabled !== 'boolean'))
      throw fail('邮件扩展尚未加载兼容版权限配置，请重启后刷新；未改动已有账号。');
    const revision = createHmac('sha256', this.key).update(JSON.stringify([descriptor.revision, row, descriptor.base, descriptor.user, descriptor.value])).digest('hex');
    return { settings, descriptor, revision, entry, row: structuredClone(row), compatible };
  }
  project(input) {
    const value = input.descriptor.value;
    // 原版没有协议开关，不能把兼容版的默认禁发显示成原版的实际权限。
    const receiveEnabled = input.compatible ? value.receiveEnabled : true;
    const sendEnabled = input.compatible ? value.sendEnabled : true;
    const residual = input.compatible && [['imap', receiveEnabled], ['smtp', sendEnabled]].some(([kind, enabled]) =>
      !enabled && [input.entry.fiber.config, input.descriptor.base, input.descriptor.user].some(layer => layer?.[kind] !== undefined));
    return { supported: true, compatible: input.compatible, revision: input.revision, user: value.user,
      configured: value.user.length > 0 && value.password.length > 0, passwordSet: value.password.length > 0,
      receiveEnabled, sendEnabled, applies: 'live',
      message: input.compatible
        ? '仅在勾选确认并保存时修改配置，dsh-email 实时使用，无需重启；已保存不等于已验证邮箱连接。' +
          (residual ? '已关闭协议的服务器配置仍有存储层残留，兼容版运行解析不会使用；此表单不重写 profile。' : '')
        : '原版 0.11.0 具备收发能力，QQ 预设包含 SMTP，不能保证禁发；当前仅可查看，安装并加载兼容版后才能保存权限或分析邮件。' };
  }
  status() {
    try { return this.project(this.input()); }
    catch (error) {
      return { supported: false, compatible: false, configured: false, revision: null, user: '', passwordSet: false,
        receiveEnabled: false, sendEnabled: false, applies: 'live',
        message: safeErrors.has(error) ? error.message : '邮箱配置暂不可读；未改动已有账号，请稍后刷新。' };
    }
  }
  binding(expectedRevision) {
    try {
      if (this.writing) throw fail('邮箱配置正在保存，请等待读回结果。');
      const input = this.input(), snapshot = this.project(input);
      if (!input.compatible || !snapshot.configured || !snapshot.receiveEnabled)
        throw fail('请先加载兼容邮件扩展、配置账号并启用收取邮件，再发起分析。');
      if (typeof expectedRevision !== 'string' || expectedRevision !== input.revision)
        throw fail('邮箱配置已变化，请重新载入并确认分析范围。');
      if (input.descriptor.value.inboxFolder !== 'INBOX')
        throw fail('邮件分析仅支持 INBOX；当前文件夹配置不受支持。');
      return { snapshot, folder: 'INBOX' };
    } catch (error) {
      if (safeErrors.has(error)) throw error;
      throw fail('邮箱配置暂不可用，请重新载入核对。', 503);
    }
  }
  async save(data) {
    if (!plain(data) || Object.keys(data).sort().join(',') !== 'confirmHostStorage,password,receiveEnabled,revision,sendEnabled,user' || data.confirmHostStorage !== true)
      throw fail('请先确认授权码将保存到本机 Harness 设置，并提交完整的收发权限。', 400);
    if (typeof data.receiveEnabled !== 'boolean' || typeof data.sendEnabled !== 'boolean')
      throw fail('收取邮件与发送邮件权限必须明确选择。', 400);
    if (typeof data.user !== 'string' || !QQ.test(data.user.trim()) || typeof data.password !== 'string' ||
        (data.password.trim() !== '' && !/^[a-zA-Z]{16}$/.test(data.password.trim())) || typeof data.revision !== 'string' || !/^[a-f0-9]{64}$/.test(data.revision))
      throw fail('请输入 QQ / foxmail 邮箱地址和 16 位英文字母授权码；不要使用 QQ 登录密码。', 400);
    if (this.writing) throw fail('邮箱配置正在保存，请等待读回结果。');
    this.writing = true;
    try {
      const input = this.input();
      if (!input.compatible) throw fail('原版邮件扩展不支持严格收发权限；请先安装并加载兼容版，未改动已有配置。');
      if (input.revision !== data.revision) throw fail('邮箱配置已变化，请重新载入并核对；未覆盖其它改动。');
      const user = data.user.trim(), password = data.password.trim();
      if (!password && (!input.descriptor.value.password || user !== input.descriptor.value.user))
        throw fail('首次配置或更换邮箱地址时，请填写新的授权码。', 400);
      const patch = { provider: 'qq', user, receiveEnabled: data.receiveEnabled, sendEnabled: data.sendEnabled,
        sendApproval: true, ...(password ? { password } : {}) };
      const ops = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value }));
      const expectedUser = { ...input.descriptor.user, ...patch };
      for (const [kind, enabled] of [['imap', data.receiveEnabled], ['smtp', data.sendEnabled]]) {
        if (enabled) {
          expectedUser[kind] = { ...endpoints[kind] };
          ops.push({ op: 'set', path: [kind], value: { ...endpoints[kind] } });
        } else {
          delete expectedUser[kind];
          ops.push({ op: 'unset', path: [kind] });
        }
      }
      // 宿主正式路径操作：同一次 CAS 内 set/unset，保留其它字段与命名空间。
      // unset 只清用户层；base/row 残留由兼容版解析忽略，不改写 profile。
      try { await input.settings.mutate(NS, ops, input.descriptor.revision); }
      catch (error) {
        if (error?.code === 'SETTINGS_CONFLICT') throw fail('邮箱配置已被其它页面修改，请重新载入后核对。');
        // 不把提供方 message/stack/cause 传给 HTTP 或 Claudia 日志。
        throw fail('宿主未确认邮箱配置保存结果，请重新载入核对；不会自动重试。', 503);
      }
      const next = this.input();
      const expectedRevision = input.descriptor.revision + (isDeepStrictEqual(input.descriptor.user, expectedUser) ? 0 : 1);
      if (next.settings !== input.settings || next.entry !== input.entry || !next.compatible ||
          next.descriptor.revision !== expectedRevision || !isDeepStrictEqual(next.row, input.row) ||
          !isDeepStrictEqual(next.descriptor.base, input.descriptor.base) || !isDeepStrictEqual(next.descriptor.user, expectedUser) ||
          next.descriptor.value.password !== (password || input.descriptor.value.password) ||
          Object.entries(patch).some(([key, value]) => next.descriptor.value[key] !== value) ||
          [['imap', data.receiveEnabled], ['smtp', data.sendEnabled]].some(([kind, enabled]) =>
            enabled && !isDeepStrictEqual(next.descriptor.value[kind], endpoints[kind])))
        throw fail('保存后配置又发生变化，请重新载入核对；不会自动重试。', 503);
      return this.project(next);
    } catch (error) {
      if (safeErrors.has(error)) throw error;
      throw fail('邮箱配置暂不可用，请重新载入核对；不会自动重试。', 503);
    } finally { this.writing = false; }
  }
}
