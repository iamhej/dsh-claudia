(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';
  const tabNames = ['today', 'journal', 'memories', 'capabilities'];
  const defaultAssistantName = 'Claudia';
  const state = {
    journal: [], memories: [], messages: [], runtime: {},
    settings: { assistantName: defaultAssistantName, allowContext: false, provider: '', model: '' }, sessionId: ''
  };
  const attachments = new Set();
  const deleting = new Set();
  const feedbackMessages = new Map();
  let toastMessage = '';
  let csrfToken = '';
  let hasState = false;
  let offline = false;
  let booting = false;
  let refreshSequence = 0;
  let currentTab = 'today';
  let activeRun = null;
  let journalSaving = false;
  let memorySaving = false;
  let settingsSaving = false;
  let resetting = false;
  let journalTimeDirty = false;
  let composing = false;
  let compositionEndedAt = -Infinity;
  let confirmResolver = null;
  let toastTimer;
  let localSequence = 0;

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }

  function icon(name) {
    const result = document.createElementNS(svgNS, 'svg');
    result.setAttribute('class', 'icon');
    result.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svgNS, 'use');
    use.setAttribute('href', `#i-${name}`);
    result.append(use);
    return result;
  }

  function actionButton(label, action, id, className = 'text-button', symbol) {
    const result = element('button', className);
    result.type = 'button';
    result.dataset.action = action;
    result.dataset.id = id;
    if (symbol) result.append(icon(symbol));
    result.append(element('span', '', label));
    return result;
  }

  function displayName() { return state.settings.assistantName; }
  function uiText(message) { return typeof message === 'function' ? message(displayName()) : message; }

  function notify(message) {
    window.clearTimeout(toastTimer);
    toastMessage = message;
    $('toast').textContent = uiText(message);
    $('toast').hidden = false;
    toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 5000);
  }

  function feedback(id, message = '', isError = false) {
    feedbackMessages.set(id, message);
    const target = $(id);
    const text = uiText(message);
    target.textContent = text;
    target.hidden = !text;
    target.classList.toggle('is-error', isError);
  }

  function renderIdentity() {
    const name = displayName();
    $('assistant-name').textContent = name;
    $('assistant-name').title = name;
    document.title = `${name} · 留一点空间给自己`;
    $('chat-pane').setAttribute('aria-label', `与 ${name} 的连续对话`);
    $('chat-input-label').textContent = `给 ${name} 发消息`;
    $('chat-input').setAttribute('aria-label', `给 ${name} 发消息`);
    $('chat-input').placeholder = `和 ${name} 聊聊…`;
    $('chat-input').title = `和 ${name} 聊聊`;
    $('settings-open').setAttribute('aria-label', `打开 ${name} 的设置`);
    $('settings-open').title = `${name} · 名字与设置`;
    $('assistant-name-input').placeholder = name;
    $('assistant-name-input').title = name;
    if (!$('settings-dialog').open && !settingsSaving) $('assistant-name-input').value = name;
    $('memory-input-label').textContent = `想让 ${name} 记住的一件事`;
    $('welcome-copy').textContent = `零散的念头、今天的小事，或一个还没想明白的问题，都可以和 ${name} 聊聊。`;
    $('settings-assistant-description').textContent = `${name} 作为同进程插件复用 Harness 的模型与凭据，无需复制 Key，也不会在此读取或回显密钥。`;
    // 保留文案生成方式，让尚在显示的提示随改名更新，不修改对话或记录原文。
    for (const [id, message] of feedbackMessages) $(id).textContent = uiText(message);
    $('toast').textContent = uiText(toastMessage);
  }

  function errorText(error) {
    if (error instanceof TypeError) return '暂时无法连接本机服务，请确认服务仍在运行后重试。';
    if (error?.name === 'AbortError') return '请求已中止。';
    return typeof error?.message === 'string' ? error.message.slice(0, 800) : '操作没有完成，请稍后重试。';
  }

  function apiError(payload, status) {
    const supplied = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
    if (status === 401 || status === 403) {
      return new Error('请求未获授权。请先重新加载页面以恢复本机安全校验；若模型请求仍失败，请回 Harness 的模型设置检查，无需在此填写密钥。');
    }
    if (typeof supplied === 'string' && supplied.trim()) return new Error(supplied.slice(0, 800));
    return new Error(`本机服务未能完成请求（HTTP ${status}），请稍后重试。`);
  }

  async function readJSON(response) {
    if (response.status === 204) return null;
    const body = await response.text();
    if (!body.trim()) return null;
    try { return JSON.parse(body); }
    catch { throw new Error('本机服务返回了无法识别的数据，请检查服务状态后重试。'); }
  }

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const mutation = method !== 'GET';
    if (mutation && !csrfToken) throw new Error('尚未完成本机安全校验，请重新加载页面。');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: mutation
          ? { 'Content-Type': 'application/json', 'X-Claudia-Token': csrfToken, Accept: 'application/json' }
          : { Accept: 'application/json' },
        ...(mutation ? { body: JSON.stringify(options.body || {}) } : {})
      });
      let payload;
      try { payload = await readJSON(response); }
      catch (error) {
        if (!response.ok) throw apiError(null, response.status);
        throw error;
      }
      if (!response.ok) throw apiError(payload, response.status);
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('本机服务响应超时。操作可能已完成，请先重新加载记录再决定是否重试。');
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function asText(value) { return typeof value === 'string' ? value : ''; }
  function asId(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }

  function entriesFrom(value, type) {
    if (!Array.isArray(value)) return [];
    const unique = new Map();
    for (const item of value) {
      if (!item || typeof item !== 'object' || !asId(item.id)) continue;
      const entry = { id: asId(item.id), createdAt: asText(item.createdAt) };
      if (type === 'messages') {
        if (!['user', 'assistant', 'system'].includes(item.role) || typeof item.content !== 'string') continue;
        Object.assign(entry, { role: item.role, content: item.content, status: asText(item.status) });
      } else {
        if (typeof item.text !== 'string') continue;
        entry.text = item.text;
        if (type === 'journal') entry.occurredAt = asText(item.occurredAt);
      }
      unique.set(entry.id, entry);
    }
    return [...unique.values()];
  }

  function applyState(payload) {
    if (!payload || !Array.isArray(payload.journal) || !Array.isArray(payload.memories) || !Array.isArray(payload.messages)) {
      throw new Error('本机状态数据不完整，暂时无法显示记录。');
    }
    state.journal = entriesFrom(payload.journal, 'journal');
    state.memories = entriesFrom(payload.memories, 'memories');
    state.messages = entriesFrom(payload.messages, 'messages');
    // 保存日志等侧栏操作也会刷新状态，不能让它覆盖仍在接收的流式消息。
    if (activeRun && activeRun.phase !== 'sync') {
      const run = activeRun;
      const savedUser = state.messages.find((message) => message.role === 'user' && !run.existingIds.has(message.id) && message.content === run.user.content);
      if (savedUser) run.user = savedUser;
      else state.messages.push(run.user);
      if (run.assistant) {
        state.messages = state.messages.filter((message) => message.id !== run.assistant.id);
        state.messages.push(run.assistant);
      }
    }
    const runtime = payload.runtime || {};
    state.runtime = {
      installed: runtime.installed === true, version: asText(runtime.version),
      configured: runtime.configured === true, connected: runtime.connected === true,
      credentialSource: runtime.credentialSource === 'harness' ? 'harness' : '',
      modelVerified: runtime.modelVerified === true, error: asText(runtime.error)
    };
    const settings = payload.settings || {};
    // 仅接收公开元数据；不读取凭据对象或任何密钥字段。
    state.settings = {
      assistantName: asText(settings.assistantName).trim() || defaultAssistantName,
      allowContext: settings.allowContext === true,
      provider: asText(settings.provider), model: asText(settings.model)
    };
    state.sessionId = asText(payload.sessionId);
    const validIds = new Set(state.journal.map((entry) => entry.id));
    let removed = false;
    for (const id of attachments) {
      if (!validIds.has(id)) { attachments.delete(id); removed = true; }
    }
    if (removed) notify('已移除不再存在的日志附件，之后不会再发送这些片段。');
  }

  function showConnectionError(error) {
    offline = true;
    $('connection-notice-text').textContent = `${errorText(error)}${hasState ? ' 当前显示上次读取的数据。' : ''}`;
    $('connection-notice').hidden = false;
    renderRuntime();
    updateControls();
  }

  async function refreshState() {
    const sequence = ++refreshSequence;
    try {
      const payload = await api('/api/state');
      if (sequence !== refreshSequence) return false;
      applyState(payload);
      hasState = true;
      offline = false;
      $('connection-notice').hidden = true;
      renderAll();
      return true;
    } catch (error) {
      if (sequence === refreshSequence) showConnectionError(error);
      throw error;
    }
  }

  async function bootstrap() {
    if (booting || activeRun) return;
    booting = true;
    offline = false;
    $('retry-load').disabled = true;
    renderRuntime();
    updateControls();
    try {
      const payload = await api('/api/bootstrap');
      if (!payload || typeof payload.csrfToken !== 'string' || !payload.csrfToken.trim()) {
        throw new Error('本机安全校验未就绪，请确认服务已正确启动。');
      }
      csrfToken = payload.csrfToken;
      await refreshState();
    } catch (error) {
      showConnectionError(error);
    } finally {
      booting = false;
      $('retry-load').disabled = false;
      renderAll();
    }
  }

  function dateValue(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function dateLabel(value, withYear = false) {
    const date = dateValue(value);
    if (!date) return '时间未提供';
    return new Intl.DateTimeFormat('zh-CN', {
      ...(withYear ? { year: 'numeric' } : {}), month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }

  function localDateTime() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  function journalDate(entry) { return entry.occurredAt || entry.createdAt; }
  function sortedJournal() { return [...state.journal].sort((a, b) => (dateValue(journalDate(b))?.getTime() || 0) - (dateValue(journalDate(a))?.getTime() || 0)); }
  function sortedMemories() { return [...state.memories].sort((a, b) => (dateValue(b.createdAt)?.getTime() || 0) - (dateValue(a.createdAt)?.getTime() || 0)); }
  function excerpt(text, limit = 140) { return text.length > limit ? `${text.slice(0, limit)}…` : text; }

  function emptyState(title, description, symbol = 'book') {
    const box = element('div', 'empty-state');
    const mark = element('span', 'empty-symbol');
    mark.append(icon(symbol));
    box.append(mark, element('h4', '', title), element('p', '', description));
    return box;
  }

  function loadingState(symbol) {
    return emptyState(offline ? '暂时还读不到记录' : '正在打开本地空间', offline ? '请确认本机服务可用，再点击左侧的重新加载。' : '正在读取真实数据，不会填入示例记录。', symbol);
  }

  function renderToday() {
    const now = new Date();
    const formatted = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now);
    $('today-date').textContent = `TODAY / ${formatted}`;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    let todayCount = 0;
    let weekCount = 0;
    for (const entry of state.journal) {
      const occurred = dateValue(journalDate(entry));
      if (!occurred) continue;
      if (occurred >= today && occurred < tomorrow) todayCount++;
      if (occurred >= weekStart && occurred < tomorrow) weekCount++;
    }
    $('stat-today').textContent = hasState ? String(todayCount) : '—';
    $('stat-week').textContent = hasState ? String(weekCount) : '—';
    $('stat-memories').textContent = hasState ? String(state.memories.length) : '—';
    $('today-heading').textContent = todayCount ? '今天的片段，已被好好收下。' : '给今天，留一点空白。';
    $('today-summary').textContent = !hasState
      ? (offline ? '连接本机服务后，这里会展示你的真实记录。' : '正在读取本机记录…')
      : todayCount ? `今天留下了 ${todayCount} 条记录。不急着总结，先看看发生了什么。`
        : '今天还没有记录。从一件小事开始，不必等到特别的时刻。';

    const recent = $('today-journal');
    recent.replaceChildren();
    if (!hasState) recent.append(loadingState('book'));
    else if (!state.journal.length) recent.append(emptyState('第一段日常，还在等你', '在 Journal 写下一句话，这里就会出现你的最近记录。'));
    else {
      for (const entry of sortedJournal().slice(0, 2)) {
        const card = element('div', 'recent-entry');
        const time = element('time', '', dateLabel(journalDate(entry)));
        if (dateValue(journalDate(entry))) time.dateTime = journalDate(entry);
        card.append(time, element('p', '', excerpt(entry.text)), actionButton('带入对话', 'attach', entry.id, 'text-button', 'chat'));
        recent.append(card);
      }
    }
    const memories = $('today-memories');
    memories.replaceChildren();
    if (!hasState) memories.append(loadingState('memory'));
    else if (!state.memories.length) memories.append(emptyState('慢慢认识，不急着定义', '你还没有确认过记忆。可以在「记忆」中手动添加。', 'memory'));
    else {
      for (const entry of sortedMemories().slice(0, 3)) {
        const row = element('div', 'memory-preview');
        const star = element('span', 'tiny-star');
        star.setAttribute('aria-hidden', 'true');
        row.append(star, element('p', '', excerpt(entry.text, 120)));
        memories.append(row);
      }
    }
  }

  function renderJournal() {
    const list = $('journal-list');
    list.replaceChildren();
    $('journal-count').textContent = hasState ? `${state.journal.length} 条记录 · 按发生时间排序` : '尚未读取';
    if (!hasState) { list.append(loadingState('book')); return; }
    if (!state.journal.length) { list.append(emptyState('这里还很安静', '在上方记下第一件小事。无需连接模型，也无需新建项目。')); return; }
    for (const entry of sortedJournal()) {
      const card = element('article', 'glass-card');
      const meta = element('div', 'entry-meta');
      const time = element('time', '', dateLabel(journalDate(entry), true));
      if (dateValue(journalDate(entry))) time.dateTime = journalDate(entry);
      const remove = actionButton('', 'delete-journal', entry.id, 'icon-button', 'trash');
      remove.setAttribute('aria-label', `删除记录：${excerpt(entry.text, 24)}`);
      remove.title = '删除这条记录';
      remove.disabled = deleting.has(`journal:${entry.id}`);
      meta.append(time, remove);
      const footer = element('div', 'entry-footer');
      footer.append(element('span', '', '保存在本地'), actionButton('带入对话', 'attach', entry.id, 'text-button', 'chat'));
      card.append(meta, element('p', 'entry-text', entry.text), footer);
      list.append(card);
    }
  }

  function renderMemories() {
    const list = $('memory-list');
    list.replaceChildren();
    $('memory-count').textContent = hasState ? `${state.memories.length} 条 · 均为手动确认` : '尚未读取';
    if (!hasState) { list.append(loadingState('memory')); return; }
    if (!state.memories.length) { list.append(emptyState('还没有需要长期记住的事', '只有你在上方手动确认的内容，才会出现在这里。', 'memory')); return; }
    for (const entry of sortedMemories()) {
      const card = element('article', 'glass-card');
      const meta = element('div', 'entry-meta');
      const time = element('time', '', dateLabel(entry.createdAt, true));
      if (dateValue(entry.createdAt)) time.dateTime = entry.createdAt;
      const remove = actionButton('', 'delete-memory', entry.id, 'icon-button', 'trash');
      remove.setAttribute('aria-label', `删除记忆：${excerpt(entry.text, 24)}`);
      remove.title = '删除这条记忆';
      remove.disabled = deleting.has(`memories:${entry.id}`);
      meta.append(time, remove);
      card.append(meta, element('p', 'entry-text', entry.text), element('span', 'quiet-tag', '已手动确认'));
      list.append(card);
    }
  }

  function renderRuntime() {
    const runtime = state.runtime;
    const verification = !hasState ? '尚未读取' : offline ? '无法获取最新状态'
      : runtime.modelVerified === true ? '已验证（宿主报告）' : '待首轮验证';
    const credentialSource = !hasState ? '尚未读取' : runtime.credentialSource === 'harness' ? 'Harness（继承，不读取密钥）' : '宿主未提供';
    let label = '正在读取状态';
    let kind = 'waiting';
    if (offline) { label = '本机服务暂不可用'; kind = 'error'; }
    else if (!hasState && !booting) label = '等待本机服务';
    else if (hasState) {
      if (runtime.configured !== true) label = '宿主未配置模型';
      else if (runtime.installed !== true || runtime.connected !== true) label = '等待 Harness 宿主';
      else if (runtime.error) { label = 'Harness · 请求需检查'; kind = 'error'; }
      else if (runtime.modelVerified === true) { label = '继承 Harness · 已验证'; kind = 'connected'; }
      else label = '继承 Harness · 待首轮验证';
    }
    $('runtime-label').textContent = label;
    $('runtime-button').dataset.state = kind;
    $('runtime-button').title = `${label} · 宿主连接不等于模型验证 · 查看运行状态`;
    $('runtime-button').setAttribute('aria-label', $('runtime-button').title);
    $('harness-badge').textContent = !hasState ? '尚未读取' : runtime.installed === true ? '同进程插件' : '宿主未就绪';
    $('harness-installed').textContent = !hasState ? '尚未读取' : runtime.installed === true ? '已安装 · 原生插件' : '宿主未就绪';
    $('harness-version').textContent = runtime.version || (hasState ? '宿主未提供' : '—');
    $('model-configured').textContent = !hasState ? '尚未读取' : runtime.configured === true ? '路由有效（不代表凭据已验证）' : '宿主未配置有效路由';
    $('model-connected').textContent = !hasState ? '尚未读取' : offline ? '无法获取最新状态' : runtime.connected === true ? '宿主已连接（非模型网络验证）' : '宿主尚未连接';
    $('model-verified').textContent = verification;
    $('credential-source').textContent = credentialSource;
    $('settings-credential-source').textContent = credentialSource;
    $('settings-model-verified').textContent = verification;
    for (const id of ['model-provider', 'settings-provider']) {
      $(id).textContent = state.settings.provider || (hasState ? 'Harness 尚未配置' : '—');
      $(id).title = $(id).textContent;
    }
    for (const id of ['model-name', 'settings-model']) {
      $(id).textContent = state.settings.model || (hasState ? 'Harness 尚未配置' : '—');
      $(id).title = $(id).textContent;
    }
    $('settings-host-hint').textContent = !hasState
      ? '正在读取宿主配置。模型设置由 Harness 管理，打开或保存此设置不会连接模型或发送消息。'
      : offline ? '暂时无法读取最新宿主配置；请重新加载。'
        : runtime.configured === true
          ? '已继承 Harness 的有效模型路由，不代表网络或凭据已经验证。更换模型请回 Harness 的模型设置；这里保存名字与隐私选项不会调用模型。'
          : '宿主尚未配置有效模型路由，请回 Harness 的模型设置处理。仍可单独保存名字与隐私选项，无需复制 Key。';
    $('welcome-connection').textContent = !hasState || offline
      ? '读取本机状态后再开始对话；不会自动连接模型或发送消息。无需在此复制 Key。'
      : runtime.configured === true
        ? `已继承 Harness 的模型路由。由你手动发送第一句话给 ${displayName()}，模型验证结果以宿主报告为准。Journal 和手动记忆也可独立使用。`
        : `与 ${displayName()} 对话前，请回 Harness 的模型设置配置有效路由，无需在此复制 Key。Journal、手动记忆与改名不受影响。`;
    feedback('runtime-error', runtime.error ? (name) => `${name} 的宿主报告：${runtime.error}；模型相关问题请回 Harness 的模型设置检查。` : '', true);
    const hint = state.settings.allowContext ? '自动附带最多 10 条最近日志及 10 条记忆原文 · 上下文限 14000 字符' : '默认不自动发送日志与记忆原文';
    $('context-hint').textContent = attachments.size ? `已附加 ${attachments.size} 条日志 · 发送时一并提供` : hint;
  }

  function nearChatBottom() {
    const scroll = $('chat-scroll');
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  }

  function scrollChat(force = false, wasNearBottom = true) {
    if (!force && !wasNearBottom) return;
    requestAnimationFrame(() => { $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight; });
  }

  function messageStatus(status) {
    const labels = {
      sending: '发送中', pending: '正在生成', streaming: '正在生成', cancelled: '已停止', canceled: '已停止',
      truncated: '达到输出上限，回复已截断', interrupted: '回复已中断，内容未完成', error: '请求未完成', failed: '请求未完成', partial: '回复未完成'
    };
    return labels[status] || '';
  }

  function renderChat(forceScroll = false) {
    const nearBottom = nearChatBottom();
    const list = $('message-list');
    list.replaceChildren();
    $('welcome').hidden = state.messages.length > 0;
    for (const message of state.messages) {
      const article = element('article', `message${message.role === 'user' ? ' is-user' : ''}`);
      const meta = element('div', 'message-meta');
      const name = message.role === 'user' ? '你' : message.role === 'assistant' ? displayName() : '系统消息';
      const nameLabel = element('span', 'display-name message-name', name);
      nameLabel.title = name;
      meta.append(nameLabel);
      if (dateValue(message.createdAt)) {
        const time = element('time', '', dateLabel(message.createdAt));
        time.dateTime = message.createdAt;
        meta.append(time);
      }
      const bubble = element('div', 'message-bubble', message.content);
      article.append(meta, bubble);
      const label = messageStatus(message.status);
      if (label) article.append(element('p', 'message-status', label));
      list.append(article);
      if (activeRun?.assistant === message) activeRun.contentElement = bubble;
    }
    scrollChat(forceScroll, nearBottom);
  }

  function renderAttachments() {
    const list = $('attachment-list');
    list.replaceChildren();
    for (const id of attachments) {
      const entry = state.journal.find((item) => item.id === id);
      if (!entry) continue;
      const chip = element('div', 'attachment-chip');
      chip.title = `待发送日志：${excerpt(entry.text, 200)}`;
      const remove = actionButton('', 'detach', id, '', 'close');
      remove.setAttribute('aria-label', `移除附件：${excerpt(entry.text, 24)}`);
      chip.append(icon('book'), element('span', '', excerpt(entry.text.replace(/\s+/g, ' '), 40)), remove);
      list.append(chip);
    }
    list.hidden = !attachments.size;
    renderRuntime();
  }

  function renderAll() {
    renderIdentity();
    renderToday();
    renderJournal();
    renderMemories();
    renderRuntime();
    renderChat();
    renderAttachments();
    updateControls();
  }

  function updateControls() {
    const usable = hasState && !offline && !booting && Boolean(csrfToken);
    const busy = Boolean(activeRun);
    $('send-button').hidden = busy;
    $('cancel-button').hidden = !busy;
    $('cancel-button').disabled = !busy || !activeRun.runId || activeRun.cancelRequested || activeRun.phase === 'sync';
    $('send-button').disabled = !usable || resetting || settingsSaving || state.runtime.configured !== true || !$('chat-input').value.trim();
    $('send-button').title = state.runtime.configured === true ? `发送给 ${displayName()}` : '宿主未配置模型，请回 Harness 的模型设置处理';
    $('send-button').setAttribute('aria-label', `发送给 ${displayName()}`);
    $('journal-save').disabled = !usable || journalSaving || !$('journal-input').value.trim();
    $('journal-save').textContent = journalSaving ? '保存中…' : '保存记录';
    $('memory-save').disabled = !usable || memorySaving || !$('memory-input').value.trim() || !$('memory-confirm').checked;
    $('memory-save').textContent = memorySaving ? '保存中…' : '确认保存';
    $('settings-save').disabled = !usable || settingsSaving || busy || resetting;
    $('settings-save').textContent = settingsSaving ? '保存中…' : '保存设置';
    $('reset-session').disabled = !usable || busy || settingsSaving || resetting;
    $('reset-session').textContent = resetting ? '重置中…' : '重置对话';
    for (const id of ['journal-input', 'journal-time']) $(id).disabled = journalSaving;
    for (const id of ['memory-input', 'memory-confirm']) $(id).disabled = memorySaving;
    for (const id of ['assistant-name-input', 'allow-context']) $(id).disabled = !usable || settingsSaving || busy || resetting;
    $('retry-load').disabled = booting || busy;
  }

  function switchTab(name, focus = false) {
    if (!tabNames.includes(name)) return;
    currentTab = name;
    for (const tabName of tabNames) {
      const selected = tabName === name;
      const tab = $(`tab-${tabName}`);
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`panel-${tabName}`).hidden = !selected;
    }
    $('space-scroll').scrollTop = 0;
    if (name === 'today') renderToday();
    if (name === 'journal' && !journalTimeDirty && !$('journal-input').value) $('journal-time').value = localDateTime();
    if (focus) $(`tab-${name}`).focus();
  }

  function resizeComposer() {
    const input = $('chat-input');
    input.style.height = 'auto';
    const maxHeight = parseFloat(getComputedStyle(input).maxHeight) || 160;
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  }

  function attachJournal(id) {
    if (!state.journal.some((entry) => entry.id === id)) { notify('这条日志已不存在，请刷新记录后再试。'); return; }
    if (attachments.has(id)) { notify('这条日志已在待发送附件中。'); return; }
    attachments.add(id);
    if (!$('chat-input').value.trim()) $('chat-input').value = '我想聊聊附加的记录。';
    renderAttachments();
    resizeComposer();
    updateControls();
    $('chat-input').focus();
    notify('已附加日志。只有你按下发送，片段才会提供给模型。');
  }

  function openSettings() {
    if ($('settings-dialog').open) return;
    $('assistant-name-input').value = displayName();
    $('allow-context').checked = state.settings.allowContext;
    feedback('settings-feedback', activeRun ? (name) => `正在与 ${name} 对话，请停止或等待结束后再修改设置。` : '');
    renderRuntime();
    updateControls();
    $('settings-dialog').showModal();
  }

  function closeSettings() {
    $('settings-dialog').close();
  }

  function confirmAction(title, description, accept, cancel = '保留') {
    if (confirmResolver) return Promise.resolve(false);
    $('confirm-title').textContent = title;
    $('confirm-description').textContent = description;
    $('confirm-accept').textContent = accept;
    $('confirm-cancel').textContent = cancel;
    return new Promise((resolve) => {
      confirmResolver = resolve;
      $('confirm-dialog').showModal();
      $('confirm-cancel').focus();
    });
  }

  function settleConfirm(accepted) {
    const resolve = confirmResolver;
    confirmResolver = null;
    $('confirm-dialog').close();
    if (resolve) resolve(accepted);
  }

  async function saveJournal(event) {
    event.preventDefault();
    if (journalSaving || !hasState || offline) return;
    const text = $('journal-input').value.trim();
    if (!text) { feedback('journal-feedback', '写下一点内容，再保存吧。', true); return; }
    if (!journalTimeDirty) $('journal-time').value = localDateTime();
    const selectedTime = $('journal-time').value;
    const occurred = selectedTime ? dateValue(selectedTime) : null;
    if (selectedTime && !occurred) { feedback('journal-feedback', '发生时间格式不正确，请重新选择。', true); return; }
    journalSaving = true;
    updateControls();
    feedback('journal-feedback');
    let saved = false;
    try {
      await api('/api/journal', { method: 'POST', body: { text, ...(occurred ? { occurredAt: occurred.toISOString() } : {}) } });
      saved = true;
      $('journal-input').value = '';
      journalTimeDirty = false;
      $('journal-time').value = localDateTime();
      await refreshState();
      feedback('journal-feedback', '已保存到本地 Journal，没有发送给模型。');
    } catch (error) {
      feedback('journal-feedback', saved ? '记录已保存，但列表刷新失败。请重新加载，不必重复保存。' : errorText(error), true);
    } finally {
      journalSaving = false;
      updateControls();
    }
  }

  async function saveMemory(event) {
    event.preventDefault();
    if (memorySaving || !hasState || offline) return;
    const text = $('memory-input').value.trim();
    if (!text || !$('memory-confirm').checked) { feedback('memory-feedback', '请填写内容，并手动确认保存这条记忆。', true); return; }
    memorySaving = true;
    updateControls();
    feedback('memory-feedback');
    let saved = false;
    try {
      await api('/api/memories', { method: 'POST', body: { text } });
      saved = true;
      $('memory-input').value = '';
      $('memory-confirm').checked = false;
      await refreshState();
      feedback('memory-feedback', '这条记忆已由你确认并保存在本地，没有自动发送给模型。');
    } catch (error) {
      feedback('memory-feedback', saved ? '记忆已保存，但列表刷新失败。请重新加载，不必重复保存。' : errorText(error), true);
    } finally {
      memorySaving = false;
      updateControls();
    }
  }

  async function deleteEntry(kind, id) {
    const key = `${kind}:${id}`;
    if (deleting.has(key) || !hasState || offline) return;
    const isJournal = kind === 'journal';
    const collection = isJournal ? state.journal : state.memories;
    if (!collection.some((entry) => entry.id === id)) return;
    const approved = await confirmAction(
      isJournal ? '删除这段记录？' : '确认删除这条记忆？',
      isJournal
        ? '这条记录将从本地 Journal 删除，之后不会再作为日志上下文发送。已进入过模型对话的内容可能仍留在先前的对话中；如需隔离，请在设置中重置模型上下文。\n\n此操作无法撤销。'
        : '这条手动确认的记忆将从本地删除，之后不会再作为记忆原文附带。已经发给模型的内容无法收回，可能仍保留在先前对话中。\n\n此操作无法撤销。',
      '确认删除'
    );
    if (!approved) return;
    deleting.add(key);
    renderJournal();
    renderMemories();
    let deleted = false;
    try {
      await api(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
      deleted = true;
      if (isJournal) {
        state.journal = state.journal.filter((entry) => entry.id !== id);
        attachments.delete(id);
      } else state.memories = state.memories.filter((entry) => entry.id !== id);
      renderAll();
      await refreshState();
      notify(isJournal ? '已删除记录，之后不会再作为日志上下文发送。' : '已删除这条记忆。');
    } catch (error) {
      notify(deleted ? '删除已完成，但列表刷新失败，请重新加载。' : errorText(error));
    } finally {
      deleting.delete(key);
      renderJournal();
      renderMemories();
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (settingsSaving || activeRun || resetting || !hasState || offline || booting || !csrfToken) return;
    const rawName = $('assistant-name-input').value;
    const assistantName = rawName.trim() || defaultAssistantName;
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(rawName) || assistantName.length > 40) {
      feedback('settings-feedback', '名字需为 1–40 字符，不能包含控制字符或换行；留空可恢复默认名字。', true);
      return;
    }
    settingsSaving = true;
    updateControls();
    feedback('settings-feedback');
    let saved = false;
    try {
      // 只提交插件偏好；由后端验证并持久化，不改动宿主模型或会话数据。
      await api('/api/settings', {
        method: 'POST',
        body: { assistantName, allowContext: $('allow-context').checked }
      });
      saved = true;
      const refreshed = await refreshState();
      if (!refreshed) {
        feedback('settings-feedback', '设置已保存，正在同步最新状态；如名字未更新，请重新加载查看。');
        return;
      }
      $('assistant-name-input').value = displayName();
      $('allow-context').checked = state.settings.allowContext;
      feedback('settings-feedback', (name) => `${name} 的设置已保存。对话、Journal 与记忆均保留，没有连接模型或发送消息。`);
      notify((name) => `已保存 ${name} 的设置。`);
    } catch (error) {
      feedback('settings-feedback', saved ? '设置已保存，但状态刷新失败。请重新加载查看，不必重复保存。' : errorText(error), true);
    } finally {
      settingsSaving = false;
      updateControls();
    }
  }

  async function resetSession() {
    if (activeRun || resetting || settingsSaving || !hasState || offline) return;
    const approved = await confirmAction('重新开始这段对话？', '将创建新的模型会话，并清空当前聊天视图。Journal、手动记忆和已有本地日志会保留。\n\n这不会撤回此前已经发送给模型的内容。', '确认重置', '继续当前对话');
    if (!approved) return;
    resetting = true;
    updateControls();
    let reset = false;
    try {
      await api('/api/session/reset', { method: 'POST', body: {} });
      reset = true;
      state.messages = [];
      attachments.clear();
      renderChat(true);
      renderAttachments();
      feedback('chat-feedback');
      await refreshState();
      closeSettings();
      notify('新的对话上下文已建立，本地记录与记忆仍然保留。');
    } catch (error) {
      feedback('settings-feedback', reset ? '对话已重置，但状态刷新失败，请重新加载。' : errorText(error), true);
    } finally {
      resetting = false;
      updateControls();
    }
  }

  function ensureAssistant(run) {
    if (run.assistant) return run.assistant;
    run.assistant = { id: run.messageId || `local-assistant-${++localSequence}`, role: 'assistant', content: '', createdAt: '', status: 'streaming' };
    state.messages.push(run.assistant);
    renderChat();
    return run.assistant;
  }

  function handleFrame(run, frame) {
    if (!frame || typeof frame !== 'object') throw new Error('对话流格式异常，已停止接收。');
    if ((frame.type === 'status' || frame.type === 'start') && asId(frame.runId)) {
      run.runId = asId(frame.runId);
      updateControls();
    }
    switch (frame.type) {
      case 'start':
        run.messageId = asId(frame.id);
        if (run.assistant && run.messageId) run.assistant.id = run.messageId;
        return false;
      case 'status':
        if (typeof frame.text === 'string' && !run.cancelRequested) feedback('chat-feedback', frame.text);
        return false;
      case 'delta': {
        if (typeof frame.text !== 'string') throw new Error('对话片段格式异常，请检查服务状态。');
        if (!frame.text) return false;
        const nearBottom = nearChatBottom();
        const firstDelta = !run.assistant;
        const assistant = ensureAssistant(run);
        assistant.content += frame.text;
        run.contentElement.textContent = assistant.content;
        if (firstDelta) feedback('chat-feedback', (name) => `正在接收 ${name} 的模型回复…`);
        scrollChat(false, nearBottom);
        return false;
      }
      case 'done': {
        const message = frame.message;
        if (!message || typeof message.content !== 'string' || !asId(message.id)) throw new Error('最终回复数据不完整，请刷新查看保存结果。');
        const assistant = ensureAssistant(run);
        Object.assign(assistant, { id: asId(message.id), role: 'assistant', content: message.content, createdAt: asText(message.createdAt), status: asText(message.status) });
        run.user.status = 'sent';
        run.done = true;
        renderChat();
        feedback('chat-feedback', (name) => assistant.status === 'complete' ? `${name} 的回复已完成。` : `${name}：${messageStatus(assistant.status) || '回复未完整结束'}，可继续交流；模型问题请回 Harness 的模型设置检查。`);
        return true;
      }
      case 'error':
        throw new Error(typeof frame.error === 'string' ? frame.error : asText(frame.error?.message) || '模型暂时没有完成回复，请回 Harness 的模型设置检查后重试。');
      default:
        if (frame.error) throw apiError(frame, 500);
        return false;
    }
  }

  async function consumeStream(response, run) {
    if (!response.body) throw new Error('浏览器无法读取流式回复，请使用支持流式请求的现代浏览器。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminal = false;
    let ended = false;
    function consumeLine(line) {
      if (!line.trim()) return false;
      let frame;
      try { frame = JSON.parse(line); }
      catch { throw new Error('对话连接返回了无法识别的片段，已停止接收。'); }
      return handleFrame(run, frame);
    }
    try {
      while (!terminal) {
        const chunk = await reader.read();
        ended = chunk.done;
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffer.length > 8 * 1024 * 1024) throw new Error('单个回复片段过大，已停止接收。');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          terminal = consumeLine(line);
          if (terminal) break;
        }
        if (chunk.done) {
          if (!terminal && buffer.trim()) terminal = consumeLine(buffer);
          break;
        }
      }
      if (!run.done && !run.cancelRequested) throw new Error('对话连接提前结束。已收到的内容可能不完整，请检查状态后再继续。');
    } finally {
      if (!ended) {
        try { await reader.cancel(); } catch { /* 流可能已随取消操作关闭。 */ }
      }
      reader.releaseLock();
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    if (activeRun || resetting || settingsSaving) return;
    if (!hasState || offline || !csrfToken) { feedback('chat-feedback', '请先连接本机服务，读取状态后再发送。', true); return; }
    const text = $('chat-input').value.trim();
    if (!text) return;
    if (state.runtime.configured !== true) {
      feedback('chat-feedback', (name) => `暂时无法给 ${name} 发送消息：宿主未配置有效模型路由，请回 Harness 的模型设置处理，无需在此填写密钥。`, true);
      return;
    }
    const contextIds = [...attachments].filter((id) => state.journal.some((entry) => entry.id === id));
    const run = {
      controller: new AbortController(), user: { id: `local-user-${++localSequence}`, role: 'user', content: text, createdAt: '', status: 'sending' },
      assistant: null, contentElement: null, messageId: '', runId: '', done: false, accepted: false,
      existingIds: new Set(state.messages.map((message) => message.id)),
      cancelRequested: false, cancelPromise: null, cancelError: '', phase: 'request'
    };
    activeRun = run;
    state.messages.push(run.user);
    $('chat-input').value = '';
    attachments.clear();
    renderAttachments();
    resizeComposer();
    updateControls();
    renderChat(true);
    feedback('chat-feedback', (name) => `请求已发送，正在等待 ${name} 的模型回复。`);
    let failure = '';
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: run.controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Claudia-Token': csrfToken, Accept: 'application/x-ndjson' },
        body: JSON.stringify({ text, ...(contextIds.length ? { contextIds } : {}) })
      });
      if (!response.ok) {
        let payload = null;
        try { payload = await readJSON(response); } catch { /* 非 JSON 错误使用 HTTP 状态说明。 */ }
        throw apiError(payload, response.status);
      }
      run.accepted = true;
      run.user.status = 'sent';
      run.phase = 'stream';
      await consumeStream(response, run);
    } catch (error) {
      if (!run.cancelRequested) {
        failure = errorText(error);
        feedback('chat-feedback', (name) => `${name} 暂未完成回复：${failure}`, true);
        if (!run.accepted && !$('chat-input').value) {
          $('chat-input').value = text;
          for (const id of contextIds) {
            if (state.journal.some((entry) => entry.id === id)) attachments.add(id);
          }
          renderAttachments();
          resizeComposer();
        }
      }
    } finally {
      run.phase = 'sync';
      updateControls();
      if (run.cancelPromise) await run.cancelPromise;
      if (!run.done) {
        run.user.status = run.accepted ? 'sent' : 'failed';
        if (run.assistant) run.assistant.status = run.cancelRequested ? 'cancelled' : 'interrupted';
      }
      renderChat();
      if (run.cancelRequested) {
        feedback('chat-feedback', run.cancelError ? `已停止接收回复，但服务端取消未确认：${run.cancelError}` : '已停止本次回复，正在同步本地记录。', Boolean(run.cancelError));
      }
      let refreshed = false;
      try { refreshed = await refreshState(); }
      catch { /* refreshState 会保留已收到的内容并显示重载入口。 */ }
      if (activeRun === run) activeRun = null;
      if (run.cancelRequested && !run.cancelError) {
        feedback('chat-feedback', refreshed ? '本次回复已停止，本地记录已同步。' : '已停止接收回复。当前无法刷新，请重新加载确认最终记录。', !refreshed);
      } else if (failure) feedback('chat-feedback', (name) => `${name} 暂未完成回复：${failure}`, true);
      updateControls();
    }
  }

  function cancelChat() {
    const run = activeRun;
    if (!run || !run.runId || run.cancelRequested || run.phase === 'sync') return;
    run.cancelRequested = true;
    feedback('chat-feedback', (name) => `正在停止 ${name} 的本次回复…`);
    updateControls();
    // 同时通知服务端和关闭浏览器接收；同步前等待取消 API 的结果。
    run.cancelPromise = api('/api/cancel', { method: 'POST', body: { runId: run.runId } }).catch((error) => { run.cancelError = errorText(error); });
    run.controller.abort();
  }

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const index = tabNames.indexOf(currentTab);
      let next;
      if (event.key === 'ArrowRight') next = tabNames[(index + 1) % tabNames.length];
      else if (event.key === 'ArrowLeft') next = tabNames[(index + tabNames.length - 1) % tabNames.length];
      else if (event.key === 'Home') next = tabNames[0];
      else if (event.key === 'End') next = tabNames[tabNames.length - 1];
      if (next) { event.preventDefault(); switchTab(next, true); }
    });
  });

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target || target.disabled) return;
    if (target.dataset.go) { switchTab(target.dataset.go); return; }
    if (target.dataset.prompt) {
      $('chat-input').value = target.dataset.prompt;
      resizeComposer();
      updateControls();
      $('chat-input').focus();
      return;
    }
    const id = target.dataset.id;
    if (target.dataset.action === 'attach') attachJournal(id);
    else if (target.dataset.action === 'detach') { attachments.delete(id); renderAttachments(); }
    else if (target.dataset.action === 'delete-journal') void deleteEntry('journal', id);
    else if (target.dataset.action === 'delete-memory') void deleteEntry('memories', id);
  });

  $('runtime-button').addEventListener('click', () => switchTab('capabilities'));
  $('settings-open').addEventListener('click', openSettings);
  $('capabilities-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-form').addEventListener('submit', saveSettings);
  $('reset-session').addEventListener('click', resetSession);
  $('confirm-accept').addEventListener('click', () => settleConfirm(true));
  $('confirm-cancel').addEventListener('click', () => settleConfirm(false));
  $('confirm-dialog').addEventListener('cancel', (event) => { event.preventDefault(); settleConfirm(false); });
  $('confirm-dialog').addEventListener('close', () => {
    if (confirmResolver) { const resolve = confirmResolver; confirmResolver = null; resolve(false); }
  });
  $('journal-form').addEventListener('submit', saveJournal);
  $('memory-form').addEventListener('submit', saveMemory);
  $('journal-time').value = localDateTime();
  $('journal-time').addEventListener('input', () => { journalTimeDirty = true; });
  for (const id of ['journal-input', 'memory-input', 'memory-confirm']) $(id).addEventListener('input', updateControls);
  $('chat-form').addEventListener('submit', sendChat);
  $('chat-input').addEventListener('input', () => { resizeComposer(); updateControls(); });
  $('chat-input').addEventListener('compositionstart', () => { composing = true; });
  $('chat-input').addEventListener('compositionend', () => { composing = false; compositionEndedAt = performance.now(); updateControls(); });
  $('chat-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.isComposing || composing || event.keyCode === 229 || performance.now() - compositionEndedAt < 80) return;
    event.preventDefault();
    if (!activeRun) $('chat-form').requestSubmit();
  });
  $('cancel-button').addEventListener('click', cancelChat);
  $('retry-load').addEventListener('click', bootstrap);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderToday(); });
  window.addEventListener('resize', resizeComposer);

  renderAll();
  void bootstrap();
})();
