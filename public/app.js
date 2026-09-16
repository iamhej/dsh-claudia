(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';
  const tabNames = ['today', 'journal', 'todo', 'memories', 'capabilities'];
  const profileNames = ['soul', 'user', 'system'];
  const settingFields = {
    allowContext: 'allow-context', activityEnabled: 'activity-enabled', reflectionEnabled: 'reflection-enabled',
    autoUpdateEnabled: 'auto-update-enabled', memorySuggestionsEnabled: 'memory-suggestions-enabled'
  };
  const defaultAssistantName = 'Claudia';
  const state = {
    journal: [], memories: [], messages: [], todos: [], reflections: [], memoryCandidates: [], profiles: {}, runtime: {},
    settings: { assistantName: defaultAssistantName, allowContext: false, provider: '', model: '' }, sessionId: '',
    dataDirectory: '', hostUrl: '', maintenance: {}, activity: {}, activitySummary: { apps: [], seconds: 0 },
    background: { enabled: false, supported: false }, features: {}, settingsEffect: {}, profileDefaults: {}, settingsRevision: undefined,
    restart: { supported: false, pending: false, state: 'idle' }, busy: false
  };
  const pending = new Set();
  const profileDrafts = new Map();
  const reflectionDrafts = new Map();
  let selectedReflectionId = '';
  let journalView = 'notes';
  let settingsNameRevision;
  let settingsBaselineRevision;
  let settingsDraft = null;
  let settingsClosing = false;
  let settingsCloseResolver = null;
  const settingsTabs = ['general', 'persona', 'automation', 'maintenance'];
  let settingsTab = 'general';
  let settingsBaseline = null;
  let settingsReceipt = null;
  let settingsReturnFocus = null;
  let settingsPollTimer;
  let settingsPolling = false;
  let restartInFlight = false;
  let restartConfirming = false;
  let todoComposing = false;
  let todoCompositionEndedAt = -Infinity;
  let statusRefreshing = false;
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
    let message = typeof supplied === 'string' && supplied.trim() ? supplied.slice(0, 800) : `本机服务未能完成请求（HTTP ${status}），请稍后重试。`;
    if (status === 401 || status === 403) message = '请求未获授权。请先重新加载页面以恢复本机安全校验；若模型请求仍失败，请回 Harness 的模型设置检查，无需在此填写密钥。';
    if (status === 409 || status === 412) message = `版本冲突或操作忙碌，未覆盖已有数据。${asText(supplied)}`;
    const error = new Error(message);
    error.status = status;
    return error;
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
    const timeout = window.setTimeout(() => controller.abort(), options.timeout || 20000);
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
      if (error.name === 'AbortError') {
        const timeoutError = new Error('本机服务响应超时。操作可能已完成，请先读取状态再决定是否重试。');
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      }
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
        if (type === 'todos') {
          if (!['todo', 'done', 'dismissed'].includes(item.status)) continue;
          entry.status = item.status;
        }
        if (type === 'reflections') Object.assign(entry, { start: asText(item.start), end: asText(item.end) });
        if (type === 'memoryCandidates') Object.assign(entry, { source: asText(item.source), status: asText(item.status) });
        entry.revision = item.revision;
      }
      unique.set(entry.id, entry);
    }
    return [...unique.values()];
  }

  function applySettingsSnapshot(payload) {
    const settings = payload.settings || {};
    // 只接收公开设置和纯正文；完整文件仍由后端保留。
    state.settings = {
      assistantName: asText(settings.assistantName).trim() || defaultAssistantName,
      provider: asText(payload.runtime?.provider ?? settings.provider ?? state.settings.provider),
      model: asText(payload.runtime?.model ?? settings.model ?? state.settings.model)
    };
    for (const field of Object.keys(settingFields)) state.settings[field] = settings[field] === true;
    state.settingsRevision = payload.settingsRevision;
    if (payload.profileDefaults) state.profileDefaults = {
      soul: payload.profileDefaults.soul, system: payload.profileDefaults.system
    };
    state.profiles = {};
    for (const name of profileNames) {
      const profile = payload.profiles?.[name];
      if (profile) state.profiles[name] = { text: typeof profile.body === 'string' ? profile.body : undefined, revision: profile.revision };
      syncDraft(profileDrafts.get(name), typeof state.profiles[name]?.text === 'string' ? state.profiles[name] : undefined);
    }
    syncSettingsDraft();
    reconcileSettingsReceipt();
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
      modelVerified: runtime.modelVerified === true, error: asText(runtime.error),
      fileAccess: { root: asText(runtime.fileAccess?.root), mode: asText(runtime.fileAccess?.mode), message: asText(runtime.fileAccess?.message) }
    };
    applySettingsSnapshot(payload);
    state.features = {
      todos: Array.isArray(payload.todos), reflections: Array.isArray(payload.reflections),
      memoryCandidates: Array.isArray(payload.memoryCandidates), automation: Boolean(payload.maintenance),
      background: Boolean(payload.background)
    };
    state.todos = entriesFrom(payload.todos, 'todos');
    state.reflections = entriesFrom(payload.reflections, 'reflections');
    state.memoryCandidates = entriesFrom(payload.memoryCandidates, 'memoryCandidates');
    for (const [id, draft] of reflectionDrafts) syncDraft(draft, state.reflections.find((entry) => entry.id === id));
    state.dataDirectory = asText(payload.dataDirectory);
    state.hostUrl = asText(payload.hostUrl);
    state.maintenance = payload.maintenance || {};
    state.activity = payload.activity || {};
    state.settingsEffect = {
      state: asText(payload.settingsEffect?.state), message: asText(payload.settingsEffect?.message),
      restartRequired: payload.settingsEffect?.restartRequired
    };
    state.restart = {
      supported: payload.restart?.supported === true, pending: payload.restart?.pending === true,
      state: asText(payload.restart?.state), reason: asText(payload.restart?.reason), message: asText(payload.restart?.message),
      runningVersion: asText(payload.restart?.runningVersion), installedVersion: asText(payload.restart?.installedVersion)
    };
    state.busy = payload.busy === true || runtime.busy === true;
    const summary = payload.activitySummary || {};
    state.activitySummary = {
      seconds: Number.isFinite(summary.seconds) ? Math.max(0, summary.seconds) : 0,
      apps: Array.isArray(summary.apps) ? summary.apps.filter((app) => typeof app?.name === 'string' && Number.isFinite(app.seconds)) : []
    };
    state.background = {
      enabled: payload.background?.enabled === true, supported: payload.background?.supported === true,
      error: asText(payload.background?.error)
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
    renderTodos();
    renderCandidates();
    renderServices();
    updateControls();
  }

  async function refreshState(options = {}) {
    const sequence = ++refreshSequence;
    try {
      const payload = await api('/api/state', { timeout: options.timeout });
      if (sequence !== refreshSequence) return false;
      applyState(payload);
      hasState = true;
      offline = false;
      $('connection-notice').hidden = true;
      if (options.quiet) {
        renderIdentity();
        renderRuntime();
        renderServices();
        updateControls();
      } else renderAll();
      return true;
    } catch (error) {
      if (sequence === refreshSequence) showConnectionError(error);
      throw error;
    }
  }

  async function bootstrap() {
    if (booting || activeRun || restartInFlight) return;
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

  function canMutate() { return hasState && !offline && !booting && !restartInFlight && state.restart.state !== 'restarting' && Boolean(csrfToken); }
  function validRevision(revision) { return typeof revision === 'string' && revision.length > 0 || typeof revision === 'number' && Number.isFinite(revision); }
  function profileBusy() { return [...profileDrafts.values()].some((draft) => draft.saving || draft.awaiting); }
  function newDraft(entry) {
    return { text: entry?.text || '', baseline: entry?.text || '', revision: entry?.revision, dirty: false, conflict: false, saving: false, awaiting: false, editing: false };
  }
  function syncDraft(draft, entry) {
    if (!draft || draft.saving && !draft.awaiting) return;
    if (draft.dirty && !draft.awaiting) {
      draft.conflict = !entry || entry.revision !== draft.revision;
      return;
    }
    if (!entry) { draft.conflict = true; return; }
    Object.assign(draft, { text: entry.text, baseline: entry.text, revision: entry.revision, dirty: false, conflict: false, awaiting: false });
  }

  function renderTodos() {
    const groups = { todo: $('todo-list'), done: $('todo-done-list'), dismissed: $('todo-dismissed-list') };
    for (const list of Object.values(groups)) list.replaceChildren();
    const count = (status) => state.todos.filter((entry) => entry.status === status).length;
    $('todo-count').textContent = hasState ? `${count('todo')} 件待办` : '尚未读取';
    $('todo-done-summary').textContent = `已完成 · ${count('done')}（保留记录）`;
    $('todo-dismissed-summary').textContent = `已忽略 · ${count('dismissed')}（保留记录）`;
    if (!hasState) { groups.todo.append(loadingState('check')); return; }
    if (!state.features.todos) { groups.todo.append(emptyState('宿主尚未提供 Todo', '请更新宿主后重新加载，当前不会尝试写入。', 'check')); return; }
    for (const entry of [...state.todos].sort((a, b) => (dateValue(b.createdAt)?.getTime() || 0) - (dateValue(a.createdAt)?.getTime() || 0))) {
      const row = element('article', `todo-row${entry.status === 'done' ? ' is-done' : ''}`);
      const label = element('label', 'todo-label');
      const check = element('input');
      check.type = 'checkbox';
      check.checked = entry.status === 'done';
      check.dataset.todoId = entry.id;
      check.setAttribute('aria-label', `${check.checked ? '撤销完成' : '标记完成'}：${excerpt(entry.text, 50)}`);
      check.disabled = !canMutate() || pending.has(`todo:${entry.id}`) || entry.status === 'dismissed';
      const content = element('span');
      content.append(element('span', 'todo-text', entry.text), element('time', 'todo-time', dateLabel(entry.createdAt)));
      label.append(check, content);
      row.append(label);
      const button = entry.status === 'dismissed'
        ? actionButton('恢复待办', 'todo-restore', entry.id)
        : actionButton('忽略', 'todo-dismiss', entry.id);
      button.disabled = !canMutate() || pending.has(`todo:${entry.id}`);
      row.append(button);
      groups[entry.status].append(row);
    }
    if (!count('todo')) groups.todo.append(emptyState('先留下一件想做的事', '输入一行文字，按 Enter 添加；无需连接模型。', 'check'));
    if (!count('done')) groups.done.append(element('p', 'field-help', '还没有已完成的事项。'));
    if (!count('dismissed')) groups.dismissed.append(element('p', 'field-help', '还没有忽略的事项。'));
  }

  function sortedReflections() {
    return [...state.reflections].sort((a, b) => (dateValue(b.createdAt || b.end)?.getTime() || 0) - (dateValue(a.createdAt || a.end)?.getTime() || 0));
  }
  function localDateKey(value) {
    const date = dateValue(value);
    if (!date) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function renderTodayReflection() {
    const target = $('today-reflection');
    target.replaceChildren();
    const latest = sortedReflections()[0];
    if (!hasState) target.append(loadingState('sun'));
    else if (!latest) target.append(emptyState('还没有每日回顾', '可在 Journal 的「每日回顾」中手动生成；自动回顾默认关闭。', 'sun'));
    else {
      target.append(element('p', 'field-help', `${dateLabel(latest.start)} — ${dateLabel(latest.end)}`), element('p', 'entry-text', excerpt(latest.text, 220)));
    }
  }
  function renderReflections() {
    const date = $('reflection-date').value;
    const entries = sortedReflections().filter((entry) => !date || localDateKey(entry.end || entry.createdAt) === date);
    if (!entries.some((entry) => entry.id === selectedReflectionId)) selectedReflectionId = entries[0]?.id || '';
    const select = $('reflection-select');
    select.replaceChildren();
    if (!entries.length) select.append(element('option', '', '暂无回顾'));
    for (const entry of entries) {
      const option = element('option', '', `${dateLabel(entry.end || entry.createdAt, true)} · ${excerpt(entry.text.replace(/\s+/g, ' '), 35)}`);
      option.value = entry.id;
      select.append(option);
    }
    select.value = selectedReflectionId;
    select.disabled = !entries.length;
    const empty = $('reflection-empty');
    empty.replaceChildren();
    empty.hidden = Boolean(selectedReflectionId);
    $('reflection-detail').hidden = !selectedReflectionId;
    if (!selectedReflectionId) {
      empty.append(!hasState ? loadingState('sun') : emptyState('这一天，尚未留下回顾', !state.features.reflections ? '宿主尚未提供回顾接口，请更新后重载。' : date ? '换一个日期，或查看全部日期。' : '生成会调用模型并收费，你可以先继续随手记录。', 'sun'));
      return;
    }
    const entry = entries.find((item) => item.id === selectedReflectionId);
    if (!reflectionDrafts.has(entry.id)) reflectionDrafts.set(entry.id, newDraft(entry));
    const draft = reflectionDrafts.get(entry.id);
    $('reflection-meta').textContent = `${dateLabel(entry.start, true)} — ${dateLabel(entry.end, true)} · 生成于 ${dateLabel(entry.createdAt, true)} · revision ${asId(entry.revision) || '未提供'}`;
    $('reflection-body').textContent = entry.text;
    $('reflection-body').hidden = draft.editing;
    $('reflection-edit').hidden = draft.editing;
    $('reflection-form').hidden = !draft.editing;
    if ($('reflection-input').value !== draft.text) $('reflection-input').value = draft.text;
    $('reflection-input').disabled = draft.saving || draft.awaiting;
    feedback('reflection-conflict', draft.conflict ? '检测到其他地方修改了这篇回顾。草稿仍保留；请复制需要的内容，再载入最新版本合并。' : !validRevision(draft.revision) ? '宿主未提供 revision，暂不能安全保存；请刷新版本。' : '', true);
    $('reflection-save').disabled = !canMutate() || draft.saving || draft.awaiting || draft.conflict || !validRevision(draft.revision) || !draft.dirty || !draft.text.trim();
    $('reflection-save').textContent = draft.saving ? '保存中…' : draft.awaiting ? '等待同步版本' : '保存回顾';
    $('reflection-reload').disabled = !canMutate() || draft.saving;
    $('reflection-edit').disabled = !canMutate() || !validRevision(draft.revision);
  }

  function buildProfileEditors() {
    for (const name of profileNames) {
      const details = element('details', 'profile-editor');
      details.id = `profile-${name}`;
      const summary = element('summary', '', `${name} · ${name === 'soul' ? '人格' : name === 'user' ? '关于你' : '交流偏好'}`);
      const form = element('form');
      form.id = `profile-${name}-form`;
      const label = element('label', 'field-label', `${name} 正文`);
      label.htmlFor = `profile-${name}-input`;
      const input = element('textarea', 'note-input profile-input');
      input.id = `profile-${name}-input`;
      input.rows = 9;
      input.spellcheck = false;
      input.setAttribute('aria-describedby', `profile-${name}-status`);
      const status = element('p', 'field-help');
      status.id = `profile-${name}-status`;
      status.setAttribute('role', 'status');
      const actions = element('div', 'form-actions');
      const restore = name === 'user' ? null : element('button', 'secondary-button', '恢复默认');
      if (restore) {
        restore.id = `profile-${name}-restore`;
        restore.type = 'button';
      }
      const reload = element('button', 'secondary-button', '载入最新版本');
      reload.id = `profile-${name}-reload`;
      reload.type = 'button';
      if (restore) actions.append(restore);
      const message = element('p', 'form-feedback');
      message.id = `profile-${name}-feedback`;
      message.setAttribute('role', 'status');
      message.hidden = true;
      actions.append(reload);
      form.append(label, input, status, actions, message);
      details.append(summary, form);
      $('profile-editors').append(details);
      input.addEventListener('input', () => {
        const draft = profileDrafts.get(name);
        if (!draft) return;
        draft.text = input.value;
        draft.dirty = draft.text !== draft.baseline;
        feedback(message.id);
        renderProfiles();
        updateControls();
      });
      form.addEventListener('submit', (event) => { event.preventDefault(); void saveSettings(); });
      reload.addEventListener('click', () => void reloadRevision('profile', name));
      restore?.addEventListener('click', async () => {
        const draft = profileDrafts.get(name);
        const body = state.profileDefaults[name];
        if (!draft || restore.disabled || typeof body !== 'string') return;
        const before = { text: draft.text, revision: draft.revision };
        if (draft.text.trim() && draft.text !== body && !await confirmAction(`${name} · 恢复默认？`, '默认正文会替换当前编辑框中的自定义内容。这里只修改草稿，点击下方保存设置才会写入文件。请先复制仍需保留的内容。', '替换为默认正文', '保留当前正文')) {
          restore.focus({ preventScroll: true });
          return;
        }
        if (restore.disabled || draft !== profileDrafts.get(name) || draft.text !== before.text || draft.revision !== before.revision) {
          feedback(message.id, '正文状态已变化，未替换草稿，请重新操作。', true);
          return;
        }
        draft.text = body;
        draft.dirty = draft.text !== draft.baseline;
        feedback(message.id, '已将默认正文填入草稿，修改后点击下方保存设置。');
        updateControls();
        input.focus({ preventScroll: true });
      });
    }
  }
  function renderProfiles() {
    for (const name of profileNames) {
      const source = state.profiles[name];
      const hasBody = typeof source?.text === 'string';
      if (!profileDrafts.has(name) && hasBody) profileDrafts.set(name, newDraft(source));
      const draft = profileDrafts.get(name);
      const input = $(`profile-${name}-input`);
      const status = $(`profile-${name}-status`);
      const restore = $(`profile-${name}-restore`);
      if (!draft) {
        input.disabled = true;
        status.textContent = hasState ? '未能读取纯正文，已暂停安全编辑。请刷新。' : '正在读取本地正文…';
        if (restore) restore.disabled = true;
        $(`profile-${name}-reload`).disabled = !canMutate() || settingsSaving || settingsReceipt?.uncertain;
        continue;
      }
      if (input.value !== draft.text) input.value = draft.text;
      input.disabled = !hasBody || settingsSaving || restartInFlight || Boolean(settingsReceipt?.uncertain);
      status.textContent = !hasBody ? '未能读取纯正文，已暂停安全编辑；现有草稿保留。'
        : draft.conflict ? '冲突 · 草稿保留，请复制需要的内容后载入最新版合并。'
          : !validRevision(draft.revision) ? '未能核对文件版本，已暂停保存。'
            : draft.dirty ? '有未保存的更改 · 修改后点击下方保存设置' : '已保存 · 修改后点击下方保存设置';
      status.classList.toggle('is-error', draft.conflict || !hasBody);
      if (restore) restore.disabled = input.disabled || !canMutate() || Boolean(activeRun) || resetting || typeof state.profileDefaults[name] !== 'string';
      $(`profile-${name}-reload`).disabled = !canMutate() || settingsSaving || Boolean(settingsReceipt?.uncertain);
    }
  }

  function renderCandidates() {
    $('memory-suggestions-status').textContent = !hasState ? '正在读取记忆候选状态' : state.settings.memorySuggestionsEnabled ? '记忆候选已启用 · 仍需逐条人工接受' : '记忆候选已关闭 · 已有候选仍需人工确认';
    const entries = state.memoryCandidates.filter((entry) => !['accepted', 'rejected', 'dismissed'].includes(entry.status));
    $('memory-candidate-count').textContent = `${entries.length} 条待查看`;
    const list = $('memory-candidate-list');
    list.replaceChildren();
    if (!hasState) { list.append(loadingState('memory')); return; }
    if (!entries.length) { list.append(emptyState('没有待确认候选', '候选不会自动成为记忆；也可以在下方手动添加。', 'memory')); return; }
    for (const entry of entries) {
      const card = element('div', 'candidate-entry');
      const actions = element('div', 'form-actions');
      const ready = ['', 'pending', 'candidate', 'proposed'].includes(entry.status);
      for (const [label, action] of [['忽略', 'candidate-reject'], ['接受为记忆', 'candidate-accept']]) {
        const button = actionButton(label, action, entry.id, action === 'candidate-accept' ? 'secondary-button' : 'text-button');
        button.disabled = !canMutate() || !ready || pending.has(`candidate:${entry.id}`);
        actions.append(button);
      }
      card.append(element('p', 'entry-text', entry.text), element('p', 'field-help', `来源：${entry.source || '未提供'}${ready ? '' : ` · 状态：${entry.status}`}`), actions);
      list.append(card);
    }
  }

  function taskStatus(task) {
    if (!task || typeof task !== 'object') return '';
    const labels = { running: '执行中', error: '运行异常', success: '已完成', completed: '已完成', ok: '已完成', skipped: '已跳过', pending: '等待执行', 'pending-restart': '等待重启' };
    const pieces = [];
    if (task.running === true) pieces.push('执行中');
    else if (labels[task.state]) pieces.push(labels[task.state]);
    else if (task.state && !['idle', 'disabled'].includes(task.state)) pieces.push(asText(task.state));
    const error = asText(task.error) || asText(task.lastError);
    if (error) pieces.push(`错误：${error}`);
    if (task.message) pieces.push(asText(task.message));
    if (dateValue(task.lastRunAt)) pieces.push(`最近：${dateLabel(task.lastRunAt)}`);
    if (dateValue(task.nextRunAt)) pieces.push(`下次：${dateLabel(task.nextRunAt)}`);
    return pieces.filter(Boolean).join(' · ');
  }
  function duration(seconds) {
    const value = Math.max(0, Math.round(seconds || 0));
    return value < 60 ? `${value} 秒` : `${Math.floor(value / 3600) ? `${Math.floor(value / 3600)} 小时 ` : ''}${Math.floor(value % 3600 / 60)} 分钟`;
  }
  function renderServices() {
    $('data-directory').textContent = state.dataDirectory || (hasState ? '宿主未提供数据路径' : '尚未读取');
    $('host-open-hint').textContent = state.hostUrl ? '由本机服务打开实际宿主已认证地址；进入后使用宿主模型齿轮或连接器配置，不在此构造深链。' : '宿主未提供可展示地址；可点击尝试由本机服务打开。若失败，请使用你启动 Harness 时获得的原始地址。';
    $('background-state').textContent = pending.has('background') ? '正在处理请求' : !hasState ? '尚未读取' : offline ? '状态待核对' : !state.features.background ? '宿主未提供' : !state.background.supported ? '此宿主不支持' : state.background.error ? '状态异常' : state.background.enabled ? '已启用（服务返回）' : '未启用';
    $('background-toggle').textContent = pending.has('background') ? '正在处理…' : state.background.enabled ? '停用' : '启用';
    feedback('background-error', state.background.error, true);
    $('reflection-status').textContent = [state.settings.reflectionEnabled ? '自动回顾已开启 · 本地 05:00' : '自动回顾未开启', taskStatus(state.maintenance.reflection)].filter(Boolean).join(' · ');
    const results = state.maintenance.running === true ? ['有自动任务正在执行。'] : [];
    for (const [key, label] of [['reflection', '回顾'], ['update', '更新'], ['memory', '记忆候选']]) {
      const result = taskStatus(state.maintenance[key]);
      if (result) results.push(`${label}：${result}`);
    }
    $('maintenance-status').textContent = results.join('\n');
    $('maintenance-details').hidden = !results.length;
    const activity = state.activity;
    $('activity-badge').textContent = !hasState ? '尚未读取' : typeof activity.enabled !== 'boolean' ? '宿主未提供' : activity.enabled ? '已开启' : '已关闭';
    $('activity-enabled-state').textContent = typeof activity.enabled !== 'boolean' ? '未报告' : activity.enabled ? '开' : '关';
    const activityLabels = { disabled: '已关闭', starting: '正在准备时长组件', running: '正在采集', stopping: '正在停止时长组件', error: '时长组件运行失败' };
    const activityStatus = offline ? '无法获取最新状态' : activityLabels[activity.state] || (typeof activity.running !== 'boolean' ? '未报告' : activity.running ? '正在采集' : '未在采集');
    $('activity-running-state').textContent = activityStatus;
    $('settings-activity-status').textContent = activity.state === 'error' ? `时长组件异常，开关保存值不受影响。${asText(activity.error)}` : '';
    $('settings-activity-status').hidden = activity.state !== 'error';
    $('settings-activity-details').hidden = activity.state !== 'error';
    $('settings-activity-status').classList.toggle('is-error', activity.state === 'error');
    $('activity-source').textContent = asText(activity.source) || '宿主未提供';
    $('activity-total').textContent = hasState ? duration(state.activitySummary.seconds) : '—';
    feedback('activity-error', asText(activity.error), true);
    const apps = $('activity-apps');
    apps.replaceChildren();
    for (const app of state.activitySummary.apps) {
      const row = element('div', 'capability-line');
      row.append(element('span', '', app.name), element('span', '', duration(app.seconds)));
      apps.append(row);
    }
    if (!state.activitySummary.apps.length) apps.append(element('p', 'field-help', '暂无应用时长汇总；不会填入示例。'));
    else apps.append(element('p', 'field-help', '以上为宿主返回的已记录汇总，不代表当前正在采集。'));
  }

  function renderRuntime() {
    $('file-access-root').textContent = state.runtime.fileAccess?.root || '尚未确认 Harness 目录';
    $('file-access-summary').textContent = state.runtime.fileAccess?.mode === 'denied'
      ? '对话目前不能读写文件或执行命令。权限上限仅为上述 Harness 目录；目录内的凭据、程序与启动配置也不授权。页面保存和后台服务需单独操作。'
      : '当前宿主未报告文件权限边界，不据此授予电脑操作权限。';
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
          ? '已继承 Harness 的有效模型路由，不代表网络或凭据已经验证。更换模型请回宿主设置；保存名字与正文本身不调用模型，但开启自动功能后宿主可能按计划调用并收费。'
          : '宿主尚未配置有效模型路由，请回 Harness 的模型设置处理。仍可保存名字与偏好，无需复制 Key；自动生成内容需要可用的模型路由。';
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
    renderTodos();
    renderCandidates();
    renderTodayReflection();
    renderProfiles();
    renderReflections();
    renderServices();
    renderRuntime();
    renderChat();
    renderAttachments();
    updateControls();
  }

  function updateControls() {
    const usable = canMutate();
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
    $('settings-save').disabled = !usable || settingsSaving || busy || resetting || Boolean(settingsReceipt?.uncertain) || !hasSettingsDrafts();
    $('settings-save').textContent = settingsSaving ? '保存中…' : '保存设置';
    $('reset-session').disabled = !usable || busy || settingsSaving || resetting;
    $('reset-session').textContent = resetting ? '重置中…' : '重置对话';
    for (const id of ['journal-input', 'journal-time']) $(id).disabled = journalSaving;
    for (const id of ['memory-input', 'memory-confirm']) $(id).disabled = memorySaving;
    for (const id of ['assistant-name-input', 'allow-context']) $(id).disabled = !usable || settingsSaving || busy || resetting;
    const profileSaving = profileBusy();
    const configurationBusy = settingsSaving || busy || resetting || profileSaving || pending.has('background');
    $('send-button').disabled ||= profileSaving;
    $('settings-save').disabled ||= profileSaving || pending.has('background');
    $('reset-session').disabled ||= profileSaving;
    for (const id of ['assistant-name-input', ...Object.values(settingFields)]) {
      $(id).disabled = !usable || configurationBusy || Boolean(settingsReceipt?.uncertain) || (id !== 'assistant-name-input' && id !== 'allow-context' && !state.features.automation);
    }
    $('todo-add').disabled = !usable || !state.features.todos || pending.has('todo-add') || !$('todo-input').value.trim() || todoComposing;
    $('todo-add').textContent = pending.has('todo-add') ? '添加中…' : '添加';
    $('todo-input').disabled = pending.has('todo-add');
    $('reflection-run').disabled = !usable || !state.features.reflections || state.runtime.configured !== true || busy || settingsSaving || pending.has('reflection-run') || state.maintenance.reflection?.running === true;
    $('reflection-run').textContent = pending.has('reflection-run') || state.maintenance.reflection?.running === true ? '正在生成…' : '生成一次回顾';
    const reflectionSaving = [...reflectionDrafts.values()].some((draft) => draft.saving);
    $('reflection-date').disabled = reflectionSaving;
    $('reflection-date-clear').disabled = reflectionSaving;
    $('reflection-select').disabled = reflectionSaving || !selectedReflectionId;
    for (const [id, key] of [['open-harness', 'open-harness'], ['open-folder', 'open-folder']]) $(id).disabled = !usable || pending.has(key);
    $('open-folder').disabled ||= !state.dataDirectory;
    $('background-toggle').disabled = !usable || !state.background.supported || pending.has('background') || configurationBusy;
    $('profiles-refresh').disabled = booting || busy || settingsSaving || [...profileDrafts.values()].some((draft) => draft.saving);
    $('reflections-refresh').disabled = booting || busy || reflectionSaving || pending.has('reflection-run');
    $('retry-load').disabled = booting || busy || restartInFlight;
    $('settings-open-harness').disabled = !usable || pending.has('open-harness');
    renderSettingsEffect();
    renderRestart();
    renderProfiles();
    renderReflections();
    $('reflection-select').disabled ||= reflectionSaving;
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

  function settingsChanges() {
    if (!settingsBaseline || !settingsDraft) return {};
    const values = { ...settingsDraft, assistantName: settingsDraft.assistantName.trim() || defaultAssistantName };
    return Object.fromEntries(Object.entries(values).filter(([field, value]) => value !== settingsBaseline[field]));
  }

  function hasSettingsDrafts() {
    return Object.keys(settingsChanges()).length > 0 || [...profileDrafts.values()].some((draft) => draft.dirty);
  }

  function syncSettingsDraft() {
    const changes = settingsChanges();
    if (!settingsDraft) { settingsDraft = {}; settingsBaseline = {}; }
    for (const field of ['assistantName', ...Object.keys(settingFields)]) {
      if (Object.hasOwn(changes, field)) continue;
      settingsDraft[field] = state.settings[field];
      settingsBaseline[field] = state.settings[field];
    }
    // 保留整组设置的草稿版本；轮询不能替 dirty 草稿偷偷换成新基线。
    if (!Object.keys(changes).length) settingsBaselineRevision = state.settingsRevision;
    if (!Object.hasOwn(changes, 'assistantName')) settingsNameRevision = state.profiles.soul?.revision;
    if ($('assistant-name-input').value !== settingsDraft.assistantName) $('assistant-name-input').value = settingsDraft.assistantName;
    for (const [field, id] of Object.entries(settingFields)) $(id).checked = settingsDraft[field];
  }

  function reconcileSettingsReceipt() {
    const receipt = settingsReceipt;
    if (!receipt?.sent || receipt.settled) return;
    for (const field of [...receipt.remainingSettings]) {
      const value = receipt.body.settings[field];
      const savedFile = field === 'assistantName' ? 'soul' : 'settings';
      if (state.settings[field] !== value || receipt.accepted && !receipt.accepted.has(savedFile) && receipt.errors[savedFile]) continue;
      receipt.remainingSettings.delete(field);
      receipt.saved.add(field);
      if ((field === 'assistantName' ? settingsDraft[field].trim() || defaultAssistantName : settingsDraft[field]) === value) {
        settingsDraft[field] = value;
        settingsBaseline[field] = value;
      }
    }
    for (const name of [...receipt.remainingProfiles]) {
      const source = state.profiles[name];
      const submitted = receipt.body.profiles[name];
      if (source?.text !== submitted.body || !validRevision(source?.revision) || receipt.accepted && !receipt.accepted.has(name) && receipt.errors[name]) continue;
      receipt.remainingProfiles.delete(name);
      receipt.saved.add(name);
      const draft = profileDrafts.get(name);
      if (draft?.text === submitted.body) Object.assign(draft, newDraft(source));
    }
    const remaining = receipt.remainingSettings.size + receipt.remainingProfiles.size;
    // 不匹配的 GET 不能证明超时 POST 已结束；仅确认逐项匹配的内容，绝不重发。
    receipt.uncertain = !receipt.accepted && !receipt.rejected && remaining > 0;
    receipt.settled = !receipt.uncertain;
    if (receipt.accepted && remaining) {
      if (receipt.remainingSettings.size && !receipt.errors.settings) receipt.errors.settings = '未确认保存，草稿保留。';
      for (const name of receipt.remainingProfiles) receipt.errors[name] ||= '未确认保存，草稿保留。';
    }
    syncSettingsDraft();
  }

  function renderSettingsEffect() {
    const receipt = settingsReceipt;
    const labels = { assistantName: '名字', allowContext: '附带个人记录', activityEnabled: '应用使用时长', reflectionEnabled: '每日回顾', autoUpdateEnabled: '自动更新', memorySuggestionsEnabled: '记忆候选', settings: '设置', batch: '批量保存' };
    const parts = [];
    let isError = false;
    if (receipt?.sent) {
      if (receipt.saved.size) parts.push(`已确认保存：${[...receipt.saved].map((item) => labels[item] || item).join('、')}。`);
      if (receipt.uncertain) {
        const remaining = [...receipt.remainingSettings, ...receipt.remainingProfiles].map((item) => labels[item] || item);
        parts.push(`仍待核对：${remaining.join('、')}。草稿保留，请重新检查状态；不会重复提交。`);
      }
      for (const [item, message] of Object.entries(receipt.errors)) {
        parts.push(`${labels[item] || item}：${message}`);
        isError = true;
      }
    }
    const changes = settingsChanges();
    const conflict = Object.keys(changes).length > 0 && settingsBaselineRevision !== state.settingsRevision
      || Object.hasOwn(changes, 'assistantName') && settingsNameRevision !== state.profiles.soul?.revision;
    if (conflict) { parts.push('设置版本已变化，草稿仍保留；请先复制需要的内容，再载入最新设置合并。'); isError = true; }
    if (state.settingsEffect.state === 'applying') parts.push('设置正在应用，无需重启。');
    if (state.settingsEffect.state === 'error') { parts.push(`设置应用异常，不等于保存失败。${state.settingsEffect.message || '请查看运行详情。'}`); isError = true; }
    feedback('settings-effect', parts.join('\n'), isError);
    $('settings-effect').dataset.state = receipt?.uncertain ? 'unknown' : isError ? 'error' : 'saved';
    let needsRecheck = Boolean(receipt?.uncertain || offline || ['applying', 'error'].includes(state.settingsEffect.state));
    for (const [field, id] of Object.entries(settingFields)) {
      const input = $(id);
      const status = $(`${id}-status`);
      input.checked = settingsDraft?.[field] === true;
      const dirty = Object.hasOwn(changes, field);
      const task = state.maintenance[{ reflectionEnabled: 'reflection', autoUpdateEnabled: 'update', memorySuggestionsEnabled: 'memory' }[field]];
      const error = field === 'activityEnabled' ? state.activity.state === 'error' : state.settings[field] && (task?.error || task?.lastError || task?.state === 'error');
      const preparing = field === 'activityEnabled' && ['starting', 'stopping'].includes(state.activity.state);
      let label = state.settings[field] ? '已开启' : '已关闭';
      if (!hasState) label = '正在读取…';
      else if (dirty) label = input.checked ? '待开启未保存' : '待关闭未保存';
      else if (offline) label = '状态待核对';
      else if (field !== 'allowContext' && !state.features.automation) label = '当前不可用';
      else if (error) label = '运行异常';
      else if (preparing) label = '正在准备';
      status.textContent = label;
      status.classList.toggle('is-error', Boolean(error && !dirty));
      status.title = `已保存：${state.settings[field] ? '开启' : '关闭'}${dirty ? '；当前开关为未保存草稿' : ''}`;
      input.dataset.saved = String(state.settings[field] === true);
      input.setAttribute('aria-busy', String(settingsSaving || Boolean(receipt?.uncertain && receipt.remainingSettings.has(field))));
      needsRecheck ||= Boolean(error || preparing);
    }
    $('settings-recheck').hidden = !needsRecheck;
    $('settings-recheck').disabled = settingsSaving || settingsPolling || statusRefreshing || restartInFlight || booting;
    $('settings-reload').hidden = !conflict;
    $('settings-reload').disabled = !canMutate() || settingsSaving || Boolean(receipt?.uncertain);
    $('settings-draft-status').textContent = !hasState ? '正在读取设置' : hasSettingsDrafts() || receipt?.uncertain ? '有未保存的更改' : '所有更改已保存';
  }

  function switchSettingsTab(name, focus = false) {
    if (!settingsTabs.includes(name)) return;
    settingsTab = name;
    for (const value of settingsTabs) {
      const selected = value === name;
      const tab = $(`settings-tab-${value}`);
      tab.setAttribute('aria-selected', String(selected));
      tab.classList.toggle('active', selected);
      tab.tabIndex = selected ? 0 : -1;
      $(`settings-panel-${value}`).hidden = !selected;
    }
    $('settings-content').scrollTop = 0;
    if (focus) {
      const tab = $(`settings-tab-${name}`);
      tab.focus({ preventScroll: true });
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function scheduleSettingsPoll() {
    window.clearTimeout(settingsPollTimer);
    if (!$('settings-dialog').open) return;
    settingsPollTimer = window.setTimeout(async () => {
      if (!$('settings-dialog').open) return;
      if (!document.hidden && !settingsSaving && !restartInFlight && !booting && !activeRun && !profileBusy() && !pending.size && !statusRefreshing) await pollSettings();
      scheduleSettingsPoll();
    }, 2000);
  }

  async function pollSettings() {
    if (settingsPolling || restartInFlight || settingsSaving || booting) return;
    settingsPolling = true;
    updateControls();
    try { await refreshState({ quiet: true, timeout: 6000 }); }
    catch { /* 保留草稿；连接提示与保存对账状态会显示读取失败。 */ }
    finally { settingsPolling = false; updateControls(); }
  }

  function openSettings() {
    if ($('settings-dialog').open) return;
    settingsReturnFocus = document.activeElement;
    renderRuntime();
    updateControls();
    $('settings-dialog').showModal();
    switchSettingsTab(settingsTab, true);
    scheduleSettingsPoll();
  }

  function settleSettingsClose(choice) {
    const resolve = settingsCloseResolver;
    settingsCloseResolver = null;
    $('settings-close-dialog').close();
    resolve?.(choice);
  }

  async function closeSettings() {
    if (settingsClosing || !$('settings-dialog').open) return;
    if (settingsSaving) { feedback('settings-feedback', '正在保存或等待确认，请先完成当前操作。'); return; }
    if (!hasSettingsDrafts() && !settingsReceipt?.uncertain) { $('settings-dialog').close(); return; }
    settingsClosing = true;
    const returnFocus = document.activeElement;
    try {
      $('settings-close-description').textContent = settingsReceipt?.uncertain
        ? '上次保存结果仍待核对。“放弃草稿”只放弃本页编辑，不能撤销可能已写入的内容；重新打开设置后仍可核对。取消会继续保留草稿。'
        : '有未保存的更改。保存设置将提交所有标签中的名字、开关和正文；放弃草稿不会写入，取消则返回继续编辑。';
      $('settings-close-save').disabled = $('settings-save').disabled;
      const choice = await new Promise((resolve) => {
        settingsCloseResolver = resolve;
        $('settings-close-dialog').showModal();
        $('settings-close-cancel').focus();
      });
      if (choice === 'save') {
        if (await saveSettings()) $('settings-dialog').close();
      } else if (choice === 'discard') {
        settingsDraft = null;
        settingsBaseline = null;
        profileDrafts.clear();
        syncSettingsDraft();
        for (const name of profileNames) feedback(`profile-${name}-feedback`);
        feedback('settings-feedback');
        if (!settingsReceipt?.uncertain) settingsReceipt = null;
        updateControls();
        $('settings-dialog').close();
      }
    } finally {
      settingsClosing = false;
      if ($('settings-dialog').open && returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true });
    }
  }

  function hasUnsavedDrafts() {
    return Object.keys(settingsChanges()).length > 0
      || [...profileDrafts.values(), ...reflectionDrafts.values()].some((draft) => draft.dirty || draft.awaiting)
      || ['chat-input', 'journal-input', 'todo-input', 'memory-input'].some((id) => $(id).value.trim())
      || attachments.size > 0;
  }

  function restartBusy() {
    return Boolean(activeRun) || settingsSaving || resetting || journalSaving || memorySaving || profileBusy()
      || pending.size > 0 || deleting.size > 0 || [...reflectionDrafts.values()].some((draft) => draft.saving)
      || state.busy || state.restart.state === 'restarting' || state.settingsEffect.state === 'applying'
      || ['starting', 'stopping'].includes(state.activity.state)
      || ['reflection', 'update', 'memory'].some((key) => state.maintenance[key]?.running === true);
  }

  function restartBlocked() {
    if (!state.restart.supported) return '当前启动方式不支持在此重启服务，请使用支持重启的启动脚本。';
    if (restartInFlight || restartConfirming) return '正在处理重启，请勿重复操作。';
    if (!canMutate()) return '请先恢复本机连接并完成安全校验。';
    if (settingsReceipt?.uncertain) return '请先核对上次保存结果，再重启。';
    if (restartBusy()) return '宿主或页面任务忙碌，请等待任务结束后重启。';
    if (hasUnsavedDrafts()) return '有未保存草稿，请先保存或处理设置、人格、回顾及输入框中的草稿。';
    return '';
  }

  function renderRestart() {
    const restart = state.restart;
    const pendingRestart = restart.pending || restart.state === 'pending';
    const label = restartInFlight ? '正在重启' : !hasState ? '尚未读取' : !restart.supported ? '不支持页面重启'
      : offline ? '状态待核对' : restart.state === 'error' ? '重启异常' : restart.state === 'restarting' ? '正在重启' : pendingRestart ? '待重启' : '可手动重启';
    $('restart-state').textContent = label;
    $('restart-state').dataset.state = restartInFlight ? 'restarting' : pendingRestart ? 'pending' : restart.state;
    $('restart-running-version').textContent = restart.runningVersion || '宿主未提供';
    $('restart-installed-version').textContent = restart.installedVersion || '宿主未提供';
    $('restart-description').textContent = [pendingRestart ? '更新已安装，重启后应用。' : '普通设置无需重启；必要时可重启承载 Claudia 的 Harness 服务。', restart.message || restart.reason].filter(Boolean).join('\n');
    const blocked = restartBlocked();
    const buttonLabel = restartInFlight || restart.state === 'restarting' ? '正在重启…' : pendingRestart ? '重启以应用更新' : '重启服务';
    $('restart-hint').textContent = blocked;
    $('restart-hint').hidden = !blocked;
    $('restart-button').disabled = Boolean(blocked);
    $('restart-button').title = blocked || buttonLabel;
    $('restart-button').setAttribute('aria-label', buttonLabel);
    $('restart-button').classList.toggle('is-pending', pendingRestart);
    $('restart-button-label').textContent = buttonLabel;
  }

  async function restartHost() {
    if (restartBlocked()) return;
    restartConfirming = true;
    updateControls();
    const approved = await confirmAction('重启承载 Claudia 的 Harness？', '将重启承载 Claudia 的 Harness 服务，期间会短暂断开连接，已有对话与本地记录保留。\n\n存在未保存草稿或忙碌任务时不会发起重启。只提交一次请求，不会因网络超时重复发送。', '确认重启服务', '暂不重启');
    restartConfirming = false;
    if (!approved) { updateControls(); return; }
    const blocked = restartBlocked();
    if (blocked) { feedback('restart-feedback', blocked, true); updateControls(); return; }
    restartInFlight = true;
    window.clearTimeout(settingsPollTimer);
    ++refreshSequence;
    updateControls();
    feedback('restart-feedback', '正在核对宿主空闲状态和当前进程…');
    const deadline = performance.now() + 45000;
    const remaining = (limit) => {
      const ms = Math.min(limit, deadline - performance.now());
      if (ms <= 0) throw new Error('重启核对已达到 45 秒上限。');
      return ms;
    };
    let sent = false;
    try {
      const refreshed = await refreshState({ quiet: true, timeout: remaining(4000) });
      if (!refreshed || !state.restart.supported || restartBusy() || hasUnsavedDrafts() || settingsReceipt?.uncertain) throw new Error('当前状态不允许重启：请检查重启支持、忙碌任务及草稿。');
      const before = await api('/api/health', { timeout: remaining(4000) });
      if (before?.ok !== true || before.busy !== false || !Number.isSafeInteger(before.pid) || before.pid <= 0 || !asText(before.version)) throw new Error('宿主忙碌或未提供可核验的 health PID / version，未发起重启。');
      const expectedVersion = state.restart.installedVersion || state.restart.runningVersion || before.version;
      if (restartBusy() || hasUnsavedDrafts()) throw new Error('检测到新任务或草稿，未发起重启。');
      feedback('restart-feedback', '正在提交一次重启请求…');
      sent = true;
      try {
        const result = await api('/api/restart', { method: 'POST', body: {}, timeout: remaining(5000) });
        if (result?.restart) state.restart = { ...state.restart, ...result.restart };
        if (result?.restart?.state === 'error') {
          const rejected = new Error(result.restart.message || result.restart.reason || '宿主拒绝重启。');
          rejected.restartRejected = true;
          throw rejected;
        }
      } catch (error) {
        if (error.status || error.restartRejected) { sent = false; throw error; }
        // 连接断开可能代表宿主已经重启：只观察 health，不重发 POST。
      }
      csrfToken = '';
      feedback('restart-feedback', '已提交重启请求，正在等待 PID 变化并核对版本；不会重复提交。');
      let lastCheck = performance.now();
      let observation = '尚未观察到新的宿主进程';
      while (performance.now() < deadline) {
        const wait = Math.min(Math.max(0, 1000 - (performance.now() - lastCheck)), deadline - performance.now());
        if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
        if (performance.now() >= deadline) break;
        lastCheck = performance.now();
        try {
          const health = await api('/api/health', { timeout: remaining(1000) });
          if (health?.ok !== true || !Number.isSafeInteger(health.pid) || health.pid <= 0 || health.pid === before.pid) continue;
          if (health.version !== expectedVersion) { observation = `新进程版本为 ${asText(health.version) || '未知'}，预期 ${expectedVersion}`; continue; }
          const bootstrapPayload = await api('/api/bootstrap', { timeout: remaining(2000) });
          if (!asText(bootstrapPayload?.csrfToken).trim()) { observation = '新进程的安全校验尚未就绪'; continue; }
          csrfToken = bootstrapPayload.csrfToken;
          const ready = await refreshState({ quiet: true, timeout: remaining(2000) });
          if (!ready || state.restart.state === 'restarting' || state.restart.pending || state.restart.state === 'pending'
            || state.restart.state === 'error' || state.restart.runningVersion !== expectedVersion) {
            observation = 'PID 与 health 版本已变化，运行状态仍待核对';
            continue;
          }
          feedback('restart-feedback', `重启已完成 · PID ${before.pid} → ${health.pid} · 版本 ${health.version}。安全校验和本地状态已重新读取。`);
          renderAll();
          return;
        } catch { /* 启动期间只继续读取；到截止时间即停止，不自动重复重启。 */ }
      }
      throw new Error(`45 秒内未能确认重启完成：${observation}。请求不会重发，请检查启动脚本后重新加载状态。`);
    } catch (error) {
      feedback('restart-feedback', errorText(error), true);
      if (sent) {
        csrfToken = '';
        showConnectionError(new Error('重启结果尚未确认，请重新加载状态；不要重复提交重启请求。'));
      }
    } finally {
      restartInFlight = false;
      updateControls();
      scheduleSettingsPoll();
    }
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
    if (journalSaving || !canMutate()) return;
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
    if (memorySaving || !canMutate()) return;
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
    if (deleting.has(key) || !canMutate()) return;
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
    event?.preventDefault();
    if (settingsSaving || activeRun || resetting || profileBusy() || pending.has('background') || !canMutate() || settingsReceipt?.uncertain) return false;
    const settings = settingsChanges();
    const profiles = Object.fromEntries([...profileDrafts].filter(([, draft]) => draft.dirty).map(([name, draft]) => [name, { body: draft.text, revision: draft.revision }]));
    if (!Object.keys(settings).length && !Object.keys(profiles).length) return true;
    if (Object.hasOwn(settings, 'assistantName') && (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(settingsDraft.assistantName) || settings.assistantName.length > 40)) {
      feedback('settings-feedback', '名字最多 40 字符，不能包含控制字符或换行；留空可恢复默认名字。', true);
      return false;
    }
    if (!validRevision(settingsBaselineRevision) || !validRevision(settingsNameRevision) || Object.values(profiles).some((profile) => !validRevision(profile.revision))) {
      feedback('settings-feedback', '缺少保存所需的基线版本，请刷新或载入最新版本；草稿保留。', true);
      return false;
    }
    const body = { settings, profiles, settingsRevision: settingsBaselineRevision, soulRevision: settingsNameRevision };
    const warnings = [];
    if (settings.allowContext) warnings.push('以后主动发送对话时，会向 Harness 配置的模型服务自动发送最多各 10 条最近日志、确认记忆和未完成待办的原文，总计不超过 14000 字符，可能增加模型费用。关闭不会撤回已发送的内容。');
    if (settings.activityEnabled) warnings.push('在本机记录应用名称与前台时长，不采集窗口标题、网页、屏幕、键盘或正文；开启每日回顾后，可用时长会随回顾内容外发。');
    if (settings.reflectionEnabled) warnings.push('每天本地 05:00，将过去 24 小时的 Journal、Todo 和可选应用时长发送给模型生成回顾，会产生费用。');
    if (settings.autoUpdateEnabled) warnings.push('每天本地 06:00 检查并安装稳定版，可能重启 Harness、短暂断开连接。');
    if (settings.memorySuggestionsEnabled) warnings.push('允许模型处理内容并生成记忆候选，可能产生费用；不会自动写入长期记忆，仍需你逐条接受。');
    if (Object.keys(profiles).length || Object.hasOwn(settings, 'assistantName')) warnings.push('名字及 soul / user / system 正文会在后续对话中作为上下文发送给模型服务，可能增加费用，不受“附带个人记录”开关限制。请勿填写密钥或不愿外发的隐私。保存正文和名字本身不调用模型。');
    const returnFocus = document.activeElement;
    settingsSaving = true;
    window.clearTimeout(settingsPollTimer);
    ++refreshSequence;
    updateControls();
    feedback('settings-feedback');
    try {
      if (warnings.length && !await confirmAction('保存设置前确认外发与费用', `${warnings.join('\n\n')}\n\n本次统一保存全部已修改的名字、开关和正文；不会启停系统后台服务或执行手动重启。`, '确认保存设置', '取消')) return false;
      if (!canMutate()) { feedback('settings-feedback', '连接状态已变化，未提交更改；草稿保留。', true); return false; }
      const receipt = settingsReceipt = {
        body, sent: false, saved: new Set(), errors: {}, accepted: null, rejected: false, uncertain: true, settled: false,
        remainingSettings: new Set(Object.keys(settings)), remainingProfiles: new Set(Object.keys(profiles))
      };
      updateControls();
      try {
        const result = await api('/api/settings/batch', { method: 'POST', body });
        if (!Array.isArray(result?.saved) || !result.errors || !result.settings || !result.profiles || !validRevision(result.settingsRevision)) throw new Error('保存回执不完整，需要读取状态核对。');
        receipt.accepted = new Set(result.saved);
        receipt.errors = { ...result.errors };
        receipt.sent = true;
        applySettingsSnapshot(result);
        if (result.settingsEffect) state.settingsEffect = result.settingsEffect;
        if (result.restart) state.restart = { ...state.restart, ...result.restart };
      } catch (error) {
        receipt.sent = true;
        // 契约保证 400/409 全不写；其他失败（包括 5xx）均先只读对账。
        if ([400, 409].includes(error.status)) {
          receipt.rejected = true;
          receipt.accepted = new Set();
          receipt.errors.batch = `${errorText(error)} 本次全部未写入，草稿保留。`;
          receipt.uncertain = false;
          receipt.settled = true;
        } else feedback('settings-feedback', `${errorText(error)} 正在逐项核对，不会重发请求。`, true);
      }
      try { await refreshState({ timeout: 6000 }); }
      catch { /* 使用有效回执确认已保存项；其余草稿和原始版本保留。 */ }
      if (receipt.settled && !receipt.remainingSettings.size && !receipt.remainingProfiles.size && !Object.keys(receipt.errors).length) feedback('settings-feedback');
      return receipt.settled && !receipt.remainingSettings.size && !receipt.remainingProfiles.size && !Object.keys(receipt.errors).length && !hasSettingsDrafts();
    } finally {
      settingsSaving = false;
      renderIdentity();
      updateControls();
      if ($('settings-dialog').open && returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true });
      scheduleSettingsPoll();
    }
  }

  async function resetSession() {
    if (activeRun || resetting || settingsSaving || profileBusy() || !canMutate()) return;
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

  async function mutate(key, path, body, feedbackId, success, options = {}) {
    if (!canMutate() || pending.has(key)) return false;
    pending.add(key);
    updateControls();
    renderTodos();
    renderCandidates();
    renderServices();
    let saved = false;
    try {
      if (options.confirm && !await confirmAction(...options.confirm)) return false;
      feedback(feedbackId);
      await api(path, { method: 'POST', body, timeout: options.timeout });
      saved = true;
      options.afterSaved?.();
      if (options.refresh !== false) await refreshState();
      feedback(feedbackId, success);
      return true;
    } catch (error) {
      feedback(feedbackId, saved ? '操作已完成，但最新状态读取失败。请刷新，不要重复提交。' : errorText(error), true);
      if (!saved && key.startsWith('todo:') && [409, 412].includes(error.status)) {
        try { await refreshState(); } catch { /* 连接错误由 refreshState 展示，保留冲突提示。 */ }
      }
      return false;
    } finally {
      pending.delete(key);
      renderTodos();
      renderCandidates();
      renderServices();
      updateControls();
    }
  }

  function saveTodo(event) {
    event.preventDefault();
    if (todoComposing || performance.now() - todoCompositionEndedAt < 80) return;
    const text = $('todo-input').value.trim();
    if (!text || !state.features.todos) return;
    void mutate('todo-add', '/api/todos', { text }, 'todo-feedback', '已添加到本地 Todo。', {
      afterSaved: () => { $('todo-input').value = ''; }
    });
  }
  function changeTodo(id, status) {
    const entry = state.todos.find((item) => item.id === id);
    if (!entry) return;
    if (!validRevision(entry.revision)) { feedback('todo-feedback', '宿主未提供 revision，请重新加载后再修改待办。', true); return; }
    void mutate(`todo:${id}`, `/api/todos/${encodeURIComponent(id)}`, { status, revision: entry.revision }, 'todo-feedback', status === 'done' ? '已完成并折叠保留，可取消勾选恢复。' : status === 'dismissed' ? '已单独忽略并保留，不计为完成。' : '已恢复为待办。');
  }
  function decideCandidate(id, accept) {
    const entry = state.memoryCandidates.find((item) => item.id === id);
    if (!entry || !['', 'pending', 'candidate', 'proposed'].includes(entry.status)) return;
    void mutate(`candidate:${id}`, `/api/memory-candidates/${encodeURIComponent(id)}`, { accept }, 'memory-candidate-feedback', accept ? '已由你确认接受为长期记忆。' : '已忽略这条候选，未接受为记忆。');
  }
  function runReflection() {
    if (!state.features.reflections || state.runtime.configured !== true || activeRun || state.maintenance.reflection?.running === true) return;
    void mutate('reflection-run', '/api/reflections/run', {}, 'reflection-run-feedback', '生成请求已完成；回顾与任务状态已刷新。如果宿主仍在执行，请稍后刷新查看。', {
      timeout: 180000,
      confirm: ['生成过去 24 小时的回顾？', '将把过去 24 小时的 Journal、Todo，以及已开启采集时可用的应用时长发送给 Harness 配置的模型服务。模型会产生费用。\n\n这次手动生成不会开启每日自动回顾。', '确认生成并付费', '暂不生成']
    });
  }
  function toggleBackground() {
    if (!state.background.supported) return;
    const enabled = !state.background.enabled;
    void mutate('background', '/api/background', { enabled }, 'background-feedback', enabled ? '启用请求已完成，以上方宿主返回的后台状态为准。' : '停用请求已完成，以上方宿主返回的后台状态为准。', {
      timeout: 120000,
      confirm: enabled
        ? ['启用 macOS 登录后台服务？', '确认后将请求安装并启用 macOS 系统后台服务，用于脱离终端运行 Harness，并在登录后自动启动。关闭浏览器本来就不会关闭正在运行的服务；启用结果以上方返回状态为准，不代表当前进程已被接管。\n\n此操作不改变其他功能开关。已开启的回顾和记忆候选可能调用付费模型，自动更新可能重启宿主；关机或休眠期间不保证执行。', '确认启用系统服务', '暂不启用']
        : ['停用登录后台服务？', '将请求停用 macOS 系统后台服务和登录自启，可能中断当前 Harness 连接。停用结果以返回状态为准，已有记录保留。\n\n定时任务仍需 Harness 运行；关闭浏览器与停用服务不是同一操作。', '确认停用', '保持启用']
    });
  }
  function openHost() {
    void mutate('open-harness', '/api/open-harness', {}, $('settings-dialog').open ? 'settings-host-feedback' : 'host-open-feedback', '已请求本机打开实际 Harness 宿主地址。请在宿主中使用模型齿轮或连接器配置。', { refresh: false });
  }

  async function saveRevision(kind, id) {
    if (kind === 'profile') return saveSettings();
    const draft = reflectionDrafts.get(id);
    const feedbackId = 'reflection-feedback';
    if (!canMutate() || !draft || draft.saving || draft.awaiting || draft.conflict || !draft.dirty || !validRevision(draft.revision)) return;
    if (!draft.text.trim()) return;
    draft.saving = true;
    updateControls();
    renderProfiles();
    renderReflections();
    feedback(feedbackId);
    let saved = false;
    try {
      await api(`/api/reflections/${encodeURIComponent(id)}`, { method: 'POST', body: { text: draft.text, revision: draft.revision } });
      saved = true;
      draft.awaiting = true;
      await refreshState();
      feedback(feedbackId, '已保存，并重新读取本地版本；没有调用模型。');
    } catch (error) {
      if (!saved && (error.status === 409 || error.status === 412)) {
        draft.conflict = true;
        try { await refreshState(); } catch { /* 保留草稿及原 revision，不自动重试保存。 */ }
      }
      feedback(feedbackId, saved ? '已保存，但最新版本尚未同步。草稿已保留，请刷新，不要重复保存。' : `${errorText(error)} 草稿已保留。`, true);
    } finally {
      draft.saving = false;
      renderProfiles();
      renderReflections();
      updateControls();
    }
  }
  async function reloadRevision(kind, id) {
    const isProfile = kind === 'profile';
    const drafts = isProfile ? profileDrafts : reflectionDrafts;
    const draft = drafts.get(id);
    const feedbackId = isProfile ? `profile-${id}-feedback` : 'reflection-feedback';
    if (draft?.saving || isProfile && (settingsSaving || settingsReceipt?.uncertain)) return;
    if (draft?.dirty && !draft.awaiting && !await confirmAction('用最新版本替换草稿？', '只替换这个编辑框的未保存草稿，不改动服务器文件。请先复制仍需保留的内容。', '载入最新版本', '保留草稿')) return;
    try {
      const refreshed = await refreshState();
      if (!refreshed) throw new Error('仍在同步状态，请稍后再载入最新版本。');
      const entry = isProfile ? state.profiles[id] : state.reflections.find((item) => item.id === id);
      if (!entry || isProfile && typeof entry.text !== 'string') throw new Error('未能读取可编辑正文；草稿未清除。');
      const next = newDraft(entry);
      next.editing = draft?.editing || false;
      drafts.set(id, next);
      if (isProfile && id === 'soul') {
        // 显式载入 soul 后采用新 revision，但不抹掉名字输入框中的草稿。
        settingsNameRevision = entry.revision;
      }
      feedback(feedbackId, '已载入最新版本，可以在此基础上编辑保存。');
      renderProfiles();
      renderReflections();
      updateControls();
    } catch (error) { feedback(feedbackId, errorText(error), true); }
  }
  async function reloadSettings() {
    if (settingsSaving || settingsReceipt?.uncertain || !canMutate()) return;
    if (!await confirmAction('载入最新设置？', '将替换未保存的名字和开关草稿；三个正文草稿仍保留。请先复制需要保留的名字。', '载入最新设置', '保留草稿')) return;
    try {
      if (!await refreshState()) return;
      settingsDraft = null;
      settingsBaseline = null;
      syncSettingsDraft();
      feedback('settings-feedback', '已载入最新名字和开关，可以重新修改。正文草稿保持不变。');
      updateControls();
    } catch (error) { feedback('settings-feedback', errorText(error), true); }
  }
  function switchJournalView(name, focus = false) {
    if (!['notes', 'reflections'].includes(name)) return;
    journalView = name;
    for (const view of ['notes', 'reflections']) {
      const tab = $(`journal-tab-${view}`);
      const selected = name === view;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`journal-${view}`).hidden = !selected;
    }
    if (focus) $(`journal-tab-${name}`).focus();
    if (name === 'reflections') renderReflections();
  }
  async function refreshStatus(manual = false, feedbackId = 'profiles-feedback') {
    if (statusRefreshing || settingsPolling || restartInFlight || booting || activeRun || settingsSaving || [...profileDrafts.values()].some((draft) => draft.saving) || pending.size || [...reflectionDrafts.values()].some((draft) => draft.saving)) return;
    if (!manual && (document.hidden || !hasState || offline || $('settings-dialog').open)) return;
    statusRefreshing = true;
    try {
      if (!csrfToken) await bootstrap();
      else await refreshState();
      if (manual && !offline) feedback(feedbackId, '已刷新最新状态；未保存草稿保持不变。');
    } catch (error) { if (manual) feedback(feedbackId, errorText(error), true); }
    finally { statusRefreshing = false; }
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
    if (activeRun || resetting || settingsSaving || profileBusy() || restartInFlight || state.restart.state === 'restarting') return;
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
    else if (target.dataset.action === 'todo-dismiss') changeTodo(id, 'dismissed');
    else if (target.dataset.action === 'todo-restore') changeTodo(id, 'todo');
    else if (target.dataset.action === 'candidate-accept') decideCandidate(id, true);
    else if (target.dataset.action === 'candidate-reject') decideCandidate(id, false);
  });

  $('runtime-button').addEventListener('click', () => switchTab('capabilities'));
  $('settings-open').addEventListener('click', openSettings);
  $('capabilities-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-form').addEventListener('submit', saveSettings);
  $('settings-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeSettings(); });
  $('settings-dialog').addEventListener('close', () => {
    window.clearTimeout(settingsPollTimer);
    if (settingsReturnFocus?.isConnected && !$('confirm-dialog').open) settingsReturnFocus.focus({ preventScroll: true });
  });
  document.querySelectorAll('[data-settings-tab]').forEach((tab) => {
    tab.addEventListener('click', () => switchSettingsTab(tab.dataset.settingsTab, true));
    tab.addEventListener('keydown', (event) => {
      const index = settingsTabs.indexOf(settingsTab);
      const next = event.key === 'ArrowRight' ? settingsTabs[(index + 1) % settingsTabs.length]
        : event.key === 'ArrowLeft' ? settingsTabs[(index + settingsTabs.length - 1) % settingsTabs.length]
          : event.key === 'Home' ? settingsTabs[0] : event.key === 'End' ? settingsTabs[settingsTabs.length - 1] : '';
      if (next) { event.preventDefault(); switchSettingsTab(next, true); }
    });
  });
  $('assistant-name-input').addEventListener('input', () => {
    if (settingsDraft) settingsDraft.assistantName = $('assistant-name-input').value;
    feedback('settings-feedback');
    updateControls();
  });
  for (const [field, id] of Object.entries(settingFields)) {
    $(id).addEventListener('change', () => {
      if (settingsDraft) settingsDraft[field] = $(id).checked;
      feedback('settings-feedback');
      updateControls();
    });
  }
  $('settings-reload').addEventListener('click', () => void reloadSettings());
  for (const choice of ['save', 'discard', 'cancel']) $('settings-close-' + choice).addEventListener('click', () => settleSettingsClose(choice));
  $('settings-close-dialog').addEventListener('cancel', (event) => { event.preventDefault(); settleSettingsClose('cancel'); });
  $('settings-close-dialog').addEventListener('close', () => {
    if (settingsCloseResolver) { const resolve = settingsCloseResolver; settingsCloseResolver = null; resolve('cancel'); }
  });
  $('settings-recheck').addEventListener('click', async () => { await pollSettings(); scheduleSettingsPoll(); });
  $('settings-open-harness').addEventListener('click', openHost);
  $('restart-button').addEventListener('click', () => void restartHost());
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderToday(); void refreshStatus(); } });
  window.addEventListener('resize', resizeComposer);

  $('todo-form').addEventListener('submit', saveTodo);
  $('todo-input').addEventListener('input', updateControls);
  $('todo-input').addEventListener('compositionstart', () => { todoComposing = true; updateControls(); });
  $('todo-input').addEventListener('compositionend', () => { todoComposing = false; todoCompositionEndedAt = performance.now(); updateControls(); });
  $('todo-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.isComposing || todoComposing || event.keyCode === 229 || performance.now() - todoCompositionEndedAt < 80) {
      todoCompositionEndedAt = performance.now();
      return;
    }
    event.preventDefault();
    $('todo-form').requestSubmit();
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.todoId && !target.disabled) changeTodo(target.dataset.todoId, target.checked ? 'done' : 'todo');
  });
  document.querySelectorAll('[data-journal-view]').forEach((tab) => {
    tab.addEventListener('click', () => switchJournalView(tab.dataset.journalView));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) next = journalView === 'notes' ? 'reflections' : 'notes';
      else if (event.key === 'Home') next = 'notes';
      else if (event.key === 'End') next = 'reflections';
      if (next) { event.preventDefault(); switchJournalView(next, true); }
    });
  });
  $('today-reflection-open').addEventListener('click', () => {
    $('reflection-date').value = '';
    selectedReflectionId = sortedReflections()[0]?.id || '';
    feedback('reflection-feedback');
    switchTab('journal');
    switchJournalView('reflections');
  });
  $('reflection-date').addEventListener('change', () => { feedback('reflection-feedback'); renderReflections(); });
  $('reflection-date-clear').addEventListener('click', () => { $('reflection-date').value = ''; renderReflections(); });
  $('reflection-select').addEventListener('change', () => {
    selectedReflectionId = $('reflection-select').value;
    feedback('reflection-feedback');
    renderReflections();
  });
  $('reflection-edit').addEventListener('click', () => {
    const draft = reflectionDrafts.get(selectedReflectionId);
    if (!draft) return;
    draft.editing = true;
    renderReflections();
    $('reflection-input').focus();
  });
  $('reflection-input').addEventListener('input', () => {
    const draft = reflectionDrafts.get(selectedReflectionId);
    if (!draft) return;
    draft.text = $('reflection-input').value;
    draft.dirty = draft.text !== draft.baseline;
    feedback('reflection-feedback');
    renderReflections();
  });
  $('reflection-form').addEventListener('submit', (event) => { event.preventDefault(); void saveRevision('reflection', selectedReflectionId); });
  $('reflection-reload').addEventListener('click', () => void reloadRevision('reflection', selectedReflectionId));
  $('reflection-run').addEventListener('click', runReflection);
  $('reflections-refresh').addEventListener('click', () => void refreshStatus(true, 'reflection-run-feedback'));
  $('profiles-refresh').addEventListener('click', () => void refreshStatus(true));
  $('open-folder').addEventListener('click', () => void mutate('open-folder', '/api/open-folder', {}, 'folder-feedback', '已请求本机打开数据文件夹。', { refresh: false }));
  $('open-harness').addEventListener('click', openHost);
  $('background-toggle').addEventListener('click', toggleBackground);
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedDrafts() && !settingsSaving && !settingsReceipt?.uncertain && !restartInFlight && ![...profileDrafts.values(), ...reflectionDrafts.values()].some((draft) => draft.saving || draft.awaiting)) return;
    event.preventDefault();
    event.returnValue = '';
  });
  // 仅刷新状态；定时任务和后台安装绝不由页面自动触发。
  window.setInterval(() => void refreshStatus(), 30000);
  buildProfileEditors();
  renderAll();
  void bootstrap();
})();
