(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';
  const tabNames = ['today', 'journal', 'todo', 'routine', 'memories'];
  const profileNames = ['soul', 'user', 'system'];
  const settingFields = {
    allowContext: 'allow-context', activityEnabled: 'activity-enabled', reflectionEnabled: 'reflection-enabled',
    autoUpdateEnabled: 'auto-update-enabled', memorySuggestionsEnabled: 'memory-suggestions-enabled',
    profileEnabled: 'profile-enabled'
  };
  const defaultAssistantName = 'Claudia';
  const state = {
    journal: [], memories: [], messages: [], todos: [], reflections: [], memoryCandidates: [], profileCandidates: [], profiles: {}, runtime: {},
    settings: { assistantName: defaultAssistantName, allowContext: false, provider: '', model: '' }, sessionId: '',
    dataDirectory: '', hostUrl: '', maintenance: {}, activity: {}, activitySummary: { apps: [], seconds: 0 },
    background: { enabled: false, supported: false }, features: {}, settingsEffect: {}, profileDefaults: {}, settingsRevision: undefined,
    restart: { supported: false, pending: false, state: 'idle' }, busy: false,
    logs: { dir: '', day: '', bytes: 0, capped: false, retainDays: 0, error: '' }, logLines: [], logsLoaded: false,
    routines: null, routineRuns: [], routineCapability: { network: false, verified: false, message: '正在读取 Routine 联网能力…' },
    // 状态接口只回最近一页回顾；更早的按需分页取，两者合并后按时间倒序显示。
    reflectionTotal: 0, reflectionHasMore: false
  };
  const pending = new Set();
  const profileDrafts = new Map();
  const reflectionDrafts = new Map();
  const reflectionCards = new Map();
  let reflectionVisibleCount = 7;
  let reflectionReceipt = null;
  let reflectionPage = [];
  let reflectionExtra = [];
  let reflectionLoading = false;
  let emailSnapshot = null;
  let emailReading = false;
  let emailError = '';
  let emailBusy = false;
  // 只保存非敏感快照；授权码仅留在输入框和本次 POST 的临时请求中。
  let emailAccountSnapshot = null;
  let emailAccountReading = false;
  let emailAccountBusy = false;
  let emailAccountNeedsReadback = false;
  let emailAccountError = '';
  let emailAccountReadSequence = 0;
  let emailAccountEditing = false;
  let emailReviewPreparing = false;
  let emailReviewSequence = 0;
  const emailReviewMessageIds = new Set();
  const emailReviewRanges = new Map([[7, '最近一周'], [30, '最近 30 天'], [365, '最近一年']]);
  const defaultEmailReviewPrompt = days => `帮我看看${emailReviewRanges.get(days) || '所选范围'}的邮件标题和发件人，标出值得查看、疑似广告、欺诈风险或疑似官方的邮件，并简要说明依据。`;
  let inlineConfirm = false;
  let confirmReturnFocus = null;
  let journalView = 'notes';
  let settingsNameRevision;
  let settingsBaselineRevision;
  let settingsDraft = null;
  let settingsClosing = false;
  let settingsCloseResolver = null;
  const settingsTabs = ['general', 'persona', 'automation', 'maintenance', 'capabilities', 'plugins'];
  let settingsTab = 'general';
  let pluginsReadSequence = 0;
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
  let composing = false;
  let compositionEndedAt = -Infinity;
  let confirmResolver = null;
  let toastTimer;
  let localSequence = 0;
  const routineCards = new Map();
  const routineAwaiting = new Map();
  let routineDraftId = '';
  let routineDraftRevision;
  let routineDraftDirty = false;
  let routineDraftBlocked = false;
  let routineBusy = false;
  let routinePolling = false;
  let routineReadSequence = 0;
  let routineLastRead = 0;
  let routinePollError = '';
  let routineUncertain = false;
  const routineSharing = '最近 24 小时的本地记录（对话、Journal、待办及回顾）和你的设定会发送给模型处理，可能产生费用。';
  const routineNetworkSharing = '模型会从你的记录中推导话题关键词，只有关键词会用于搜索，原始记录不会发给搜索服务。搜索只读取公开网页，不登录、不携带个人信息。可能产生额外费用。';
  const routineStatusLabels = { running: '运行中', success: '成功', silent: '静默 · 未投递', 'no-data': '无数据 · 未投递', failed: '失败', cancelled: '已取消' };

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
    $('settings-assistant-description').textContent = `${name} 使用你已配置的模型，无需在这里填写密钥。`;
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
    if (status === 401 || status === 403) message = '请求未获授权，请重新加载页面。如果问题持续，请检查模型设置。';
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
      // 邮箱接口失败时不读取服务端错误正文，避免凭据进入通用错误反馈。
      if (!response.ok && path === '/api/email/account') throw apiError(null, response.status);
      let payload;
      try { payload = await readJSON(response); }
      catch (error) {
        if (!response.ok) throw apiError(null, response.status);
        throw error;
      }
      if (!response.ok) throw apiError(payload, response.status);
      return options.withStatus ? { status: response.status, payload } : payload;
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
        if (item.source === 'email-review' || emailReviewMessageIds.has(entry.id)) entry.source = 'email-review';
      } else if (type === 'profileCandidates') {
        Object.assign(entry, { status: asText(item.status), window: asText(item.window?.end),
          facts: Array.isArray(item.facts) ? item.facts.map(asText).filter(Boolean) : [],
          inference: Array.isArray(item.inference) ? item.inference.map(asText).filter(Boolean) : [] });
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
      const savedUser = state.messages.find((message) => message.id === run.user.id)
        || state.messages.find((message) => message.role === 'user' && (message.source || 'chat') === run.source && !run.existingIds.has(message.id) && message.content === run.user.content);
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
      memoryCandidates: Array.isArray(payload.memoryCandidates), profileCandidates: Array.isArray(payload.profileCandidates), automation: Boolean(payload.maintenance),
      background: Boolean(payload.background), logs: Boolean(payload.logs)
    };
    applyRoutineState(payload);
    state.todos = entriesFrom(payload.todos, 'todos');
    reflectionPage = entriesFrom(payload.reflections, 'reflections');
    state.reflectionTotal = Number.isFinite(payload.reflectionTotal) ? payload.reflectionTotal : reflectionPage.length;
    state.reflectionHasMore = payload.reflectionHasMore === true;
    syncReflections();
    state.memoryCandidates = entriesFrom(payload.memoryCandidates, 'memoryCandidates');
    state.profileCandidates = entriesFrom(payload.profileCandidates, 'profileCandidates');
    for (const [id, draft] of reflectionDrafts) syncDraft(draft, state.reflections.find((entry) => entry.id === id));
    state.dataDirectory = asText(payload.dataDirectory);
    state.hostUrl = asText(payload.hostUrl);
    state.maintenance = payload.maintenance || {};
    observeReflectionRun();
    state.activity = payload.activity || {};
    state.logs = {
      dir: asText(payload.logs?.dir), day: asText(payload.logs?.day),
      bytes: Number.isFinite(payload.logs?.bytes) ? payload.logs.bytes : 0,
      capped: payload.logs?.capped === true,
      retainDays: Number.isFinite(payload.logs?.retainDays) ? payload.logs.retainDays : 0,
      error: asText(payload.logs?.error)
    };
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
        renderRoutines();
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

  function routineRunsFrom(value) {
    return Array.isArray(value) ? value.filter((run) => run && asId(run.id) && Object.hasOwn(routineStatusLabels, run.status)).slice(0, 20) : [];
  }

  function applyRoutineSnapshot(snapshot) {
    state.routines = snapshot && Array.isArray(snapshot.jobs) && (snapshot.revision === null || typeof snapshot.revision === 'string')
      ? { jobs: snapshot.jobs.filter((job) => job && asId(job.id) && job.schedule), revision: snapshot.revision } : null;
    if (routineDraftRevision === undefined || !routineDraftDirty && !routineDraftId && !routineDraftBlocked) routineDraftRevision = state.routines?.revision;
  }

  function applyRoutineState(payload) {
    ++routineReadSequence;
    applyRoutineSnapshot(payload.routines);
    state.routineRuns = routineRunsFrom(payload.routineRuns);
    state.routineCapability = {
      network: payload.routineCapability?.network === true,
      verified: payload.routineCapability?.verified === true,
      message: asText(payload.routineCapability?.message) || (payload.routineCapability?.network === true
        ? '联网接线可用，不代表本次搜索请求成功。' : '当前服务未提供可用联网能力；联网任务可保存为停用定义。')
    };
    routineLastRead = Date.now();
    routinePollError = '';
    for (const [id, receipt] of routineAwaiting) {
      const job = state.routines?.jobs.find((item) => asId(item.id) === id);
      const seen = state.routineRuns.some((run) => asId(run.jobId) === id && !receipt.ids.has(asId(run.id))) || job?.lastRun && !receipt.ids.has(asId(job.lastRun.id));
      if (seen) routineAwaiting.delete(id);
      else if (Date.now() - receipt.at > 60000) {
        routineAwaiting.delete(id);
        routineUncertain = true;
        feedback('routine-feedback', '已受理，但尚未读到本次运行结果。请刷新状态核对，不要重复触发。', true);
      }
    }
  }

  function routineJob(id) { return state.routines?.jobs.find((job) => asId(job.id) === id); }
  function routineNetworkBlocked(job) { return job?.allowNetwork === true && !state.routineCapability.network; }
  function routineBlockedReason(job) {
    return asText(job?.blockedReason) || (routineNetworkBlocked(job) ? state.routineCapability.message : '');
  }
  function routineRunning(id) {
    return routineAwaiting.has(id) || routineJob(id)?.lastRun?.status === 'running' || state.routineRuns.some((run) => asId(run.jobId) === id && run.status === 'running');
  }
  function routineConflict() {
    return routineDraftBlocked || Boolean((routineDraftDirty || routineDraftId) && (routineDraftRevision !== state.routines?.revision || routineDraftId && !routineJob(routineDraftId)));
  }
  function routineDefinition(job) {
    return { name: job.name, prompt: job.prompt, schedule: job.schedule, allowNetwork: job.allowNetwork === true, delivery: job.delivery, enabled: job.enabled === true };
  }
  function routineScheduleLabel(schedule) {
    if (schedule.type === 'interval') return `每 ${schedule.hours} 小时`;
    if (schedule.type === 'weekly') return `每周 ${(schedule.days || []).map((day) => ['日', '一', '二', '三', '四', '五', '六'][day]).join('、')} · ${asText(schedule.time)}`;
    return `每日 ${asText(schedule.time)}`;
  }

  function updateRoutineControls() {
    const available = Boolean(state.routines);
    const locked = !canMutate() || !available || routineBusy || routineUncertain;
    $('routine-fields').disabled = routineBusy;
    $('routine-new').disabled = routineBusy;
    $('routine-cancel-edit').hidden = !routineDraftId && !routineDraftDirty && !routineDraftBlocked;
    $('routine-cancel-edit').disabled = routineBusy;
    const networkBlocked = routineNetworkBlocked({ allowNetwork: $('routine-network').checked });
    $('routine-enabled').disabled = networkBlocked && !$('routine-enabled').checked;
    $('routine-enabled').title = networkBlocked ? '当前联网能力不可用；可取消启用并保存停用定义。' : '';
    $('routine-save').disabled = locked || routineConflict() || !$('routine-name').value.trim() || !$('routine-prompt').value.trim() || networkBlocked && $('routine-enabled').checked;
    $('routine-save').textContent = routineBusy ? '处理中…' : routineDraftId ? '保存修改' : '保存任务';
    $('routine-recheck').disabled = routineBusy || routinePolling || booting || restartInFlight;
    $('routine-rebase').hidden = !routineConflict();
    $('routine-rebase').disabled = locked;
    $('routine-draft-status').textContent = !available ? '当前服务尚未提供 Routine，草稿可保留，暂不能保存。'
      : routineConflict() ? '版本有变或上次保存未确认；草稿保留。请核对任务卡后选择「核对后沿用草稿」。'
        : routineDraftDirty ? '有未保存的更改 · 刷新和切换标签不会覆盖草稿' : routineDraftId ? '正在编辑 · 轮询不会覆盖正文' : '新任务默认停用';
    for (const [id, view] of routineCards) {
      const job = routineJob(id);
      if (!job) continue;
      view.toggle.checked = job.enabled === true;
      view.toggle.disabled = locked || routineNetworkBlocked(job) && !job.enabled;
      view.toggle.title = !job.enabled && routineNetworkBlocked(job) ? routineBlockedReason(job) : '';
      view.toggle.setAttribute('aria-label', `${job.enabled ? '停用' : '启用'}：${asText(job.name)}`);
      view.switchText.textContent = job.enabled ? '已启用' : '已停用';
      view.edit.disabled = routineBusy;
      view.remove.disabled = locked;
      view.run.disabled = locked || routineNetworkBlocked(job) || routineRunning(id);
      view.run.querySelector('span').textContent = routineRunning(id) ? '运行中 / 待同步' : '手动运行';
      view.run.title = routineNetworkBlocked(job) ? routineBlockedReason(job) : job.allowNetwork
        ? '确认数据共享与联网后运行；无本地记录时可用兜底话题搜索' : '确认后，将本地记录摘录发送给模型处理';
    }
  }

  function syncRoutineSchedule() {
    const type = $('routine-type').value;
    $('routine-time-field').hidden = type === 'interval';
    $('routine-time').disabled = type === 'interval';
    $('routine-hours-field').hidden = type !== 'interval';
    $('routine-hours').disabled = type !== 'interval';
    $('routine-days').hidden = type !== 'weekly';
    $('routine-days').disabled = type !== 'weekly';
  }

  async function editRoutine(id = '', cancelling = false) {
    if (routineBusy) return;
    if (routineDraftDirty || routineDraftBlocked) {
      if (!await confirmAction(cancelling ? '取消编辑并放弃草稿？' : '替换当前草稿？', cancelling ? '只放弃当前 Routine 的未保存草稿，不修改已保存任务。请先复制需要的名称与正文；选择继续编辑会完整保留草稿。' : '未保存的 Routine 草稿将被替换，请先复制需要的内容。', cancelling ? '放弃草稿并取消编辑' : '替换草稿', '继续编辑')) return;
    }
    const job = id ? routineJob(id) : null;
    if (id && !job) { notify('这项任务已不存在，请刷新状态。'); return; }
    routineDraftId = id;
    routineDraftRevision = state.routines?.revision;
    routineDraftDirty = false;
    routineDraftBlocked = false;
    $('routine-form').reset();
    $('routine-form-title').textContent = id ? '编辑 Routine' : '新建 Routine';
    if (job) {
      $('routine-name').value = asText(job.name);
      $('routine-prompt').value = asText(job.prompt);
      $('routine-type').value = job.schedule.type;
      $('routine-time').value = job.schedule.time || '11:00';
      $('routine-hours').value = job.schedule.hours || 6;
      for (const check of $('routine-days').querySelectorAll('input')) check.checked = (job.schedule.days || []).includes(Number(check.value));
      $('routine-network').checked = job.allowNetwork === true;
      $('routine-enabled').checked = job.enabled === true;
      $('routine-delivery').value = job.delivery === 'both' ? 'both' : 'today';
    }
    syncRoutineSchedule();
    feedback('routine-feedback');
    updateRoutineControls();
    $('routine-name').focus();
  }

  function readRoutineForm() {
    const type = $('routine-type').value;
    const schedule = type === 'interval' ? { type, hours: Number($('routine-hours').value) } : { type, time: $('routine-time').value };
    if (type === 'interval' && (!Number.isInteger(schedule.hours) || schedule.hours < 1 || schedule.hours > 168)) throw new Error('间隔须为 1–168 的整数小时。');
    if (type === 'weekly') {
      schedule.days = [...$('routine-days').querySelectorAll('input:checked')].map((input) => Number(input.value));
      if (!schedule.days.length) throw new Error('每周执行至少选择一天。');
    }
    const job = { name: $('routine-name').value.trim(), prompt: $('routine-prompt').value.trim(), schedule, allowNetwork: $('routine-network').checked, delivery: $('routine-delivery').value, enabled: $('routine-enabled').checked };
    if (!job.name || !job.prompt) throw new Error('请填写名称和提示词。');
    if (routineNetworkBlocked(job) && job.enabled) throw new Error(`${routineBlockedReason(job)} 请取消启用后保存停用定义。`);
    return job;
  }

  async function saveRoutine(event) {
    event.preventDefault();
    if ($('routine-save').disabled || !$('routine-form').reportValidity()) return;
    try {
      const job = readRoutineForm();
      await mutateRoutine('save', routineDraftId, job, routineDraftRevision);
    } catch (error) { feedback('routine-feedback', errorText(error), true); }
  }

  async function mutateRoutine(action, id, definition, revision = state.routines?.revision) {
    if (!canMutate() || !state.routines || routineBusy || routineUncertain) return;
    const job = routineJob(id);
    if (action !== 'save' && !job) return;
    const target = action === 'save' ? definition : job;
    const requiresNetwork = action === 'run' || action === 'toggle' && !job.enabled || action === 'save' && definition.enabled;
    if (requiresNetwork && routineNetworkBlocked(target)) { notify(routineBlockedReason(target)); return; }
    if (action === 'run' && routineRunning(id)) return;
    routineBusy = true;
    ++routineReadSequence;
    updateRoutineControls();
    let sent = false;
    try {
      const body = { revision };
      if (action === 'save') body.job = definition;
      if (action === 'toggle') body.job = { ...routineDefinition(job), enabled: !job.enabled };
      if (action === 'delete') {
        if (!await confirmAction('删除这项 Routine？', `将删除「${asText(job.name)}」的任务定义；已发送给模型的内容无法撤回。`, '确认删除', '保留任务')) return;
      } else if (action === 'run' || action === 'save' && (definition.enabled || job?.enabled) || action === 'toggle' && body.job.enabled) {
        const networkConsent = target.allowNetwork === true || action === 'save' && job?.enabled === true && job.allowNetwork === true;
        const title = networkConsent ? '确认数据共享与独立联网？' : action === 'run' ? '手动运行这一次？' : '确认任务的数据使用？';
        const sharing = `${routineSharing}\n${networkConsent ? routineNetworkSharing : '本地摘要不读取外部网页；不允许文件、Shell 或任务管理工具。'}`;
        const effect = action === 'run' ? '本次运行不改变任务的启用状态。' : body.job.enabled ? '启用后将按计划重复处理上述内容。' : '保存后停用，不再定时执行。';
        if (!await confirmAction(title, `${sharing}\n${effect}`, action === 'run' ? '确认并运行' : '确认并保存', '取消')) return;
        body.confirmDataSharing = true;
        if (networkConsent) body.confirmNetwork = true;
      }
      if (!canMutate() || revision !== state.routines?.revision) throw new Error('状态已经变化，未提交请求。请核对最新任务后再操作。');
      if (requiresNetwork && routineNetworkBlocked(target)) throw new Error(routineBlockedReason(target));
      if (action === 'run') body.requestId = crypto.randomUUID();
      const previousIds = new Set(state.routineRuns.map((run) => asId(run.id)));
      if (job?.lastRun) previousIds.add(asId(job.lastRun.id));
      const path = `/api/routines${id ? `/${encodeURIComponent(id)}` : ''}${action === 'run' ? '/run' : ''}`;
      sent = true;
      const result = await api(path, { method: action === 'delete' ? 'DELETE' : 'POST', body });
      ++refreshSequence;
      ++routineReadSequence;
      if (action === 'run') {
        if (result?.accepted !== true) throw new Error('未收到明确受理结果，请刷新状态核对。');
        routineAwaiting.set(id, { at: Date.now(), ids: previousIds });
        notify('任务已受理，正在等待结果；不会重复提交。');
      } else {
        const snapshot = result?.routines || result;
        if (!Array.isArray(snapshot?.jobs) || !(snapshot.revision === null || typeof snapshot.revision === 'string')) throw new Error('保存结果未包含任务快照，请刷新状态核对。');
        applyRoutineSnapshot(snapshot);
        if (action === 'save') {
          routineDraftDirty = false;
          routineDraftBlocked = false;
          routineDraftId = '';
          routineDraftRevision = state.routines.revision;
          $('routine-form').reset();
          $('routine-form-title').textContent = '新建 Routine';
          syncRoutineSchedule();
        }
        notify(action === 'delete' ? '任务已删除。' : '任务已保存。');
      }
      feedback('routine-feedback', action === 'run' ? '已受理 · 结果通过状态刷新更新。' : '已更新任务列表。');
    } catch (error) {
      routineDraftBlocked ||= action === 'save';
      routineUncertain = sent && (error.name === 'TimeoutError' || error instanceof TypeError || !error.status || error.status >= 500);
      feedback('routine-feedback', `${errorText(error)} 草稿保留，仅刷新核对，不会自动重复提交。`, true);
      await readRoutineState(true);
    } finally {
      routineBusy = false;
      renderRoutines();
    }
  }

  function safeRoutineUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) return '';
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.split('/')[2].includes('@')) return '';
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      const labels = host.split('.');
      // URL 会将十六进制、整数及缩写 IPv4 规范化；数字顶级域与 IPv6 都不放行。
      if (host.length > 253 || labels.length < 2 || !/^[a-z][a-z0-9-]*$/i.test(labels.at(-1))) return '';
      if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return '';
      if (/(^|\.)(localhost|localdomain|local|internal|lan|home)$/.test(host)) return '';
      return url.href;
    } catch { return ''; }
  }

  function routineSourceLink(value) {
    const href = safeRoutineUrl(value);
    if (!href) return element('p', 'field-help', '原始链接不可用（仅支持公开 HTTP(S) 域名地址）');
    const link = element('a', 'routine-source-link', `原始链接：${asText(value)}`);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    return link;
  }

  // Compact links are only used by chat event cards; the right-hand history stays unchanged.
  function streamSourceLink(value, title = '', showLabel = false) {
    const href = safeRoutineUrl(value);
    if (!href) return element('span', 'stream-source-unavailable', '原文链接不可用');
    const link = element('a', 'stream-source-link');
    const host = new URL(href).hostname;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    link.title = `查看原文 · ${host}（新标签页）`;
    link.setAttribute('aria-label', `查看原文：${title || host}（新标签页打开）`);
    link.append(icon('link'));
    if (showLabel) link.append(element('span', '', '原文'));
    return link;
  }

  function streamEventNote() {
    const details = element('details', 'stream-event-note');
    details.append(element('summary', '', '关于这条观察'),
      element('p', '', '这是独立生成的观察，未进入模型历史；继续聊天时不会自动带上这段内容。'));
    return details;
  }

  function buildRoutineSources(runId, compact = false) {
    const details = element('details', `routine-sources${compact ? ' stream-sources' : ''}`);
    const sources = element('div', 'routine-source-list');
    const retry = element('button', 'text-button', '重新读取依据与来源');
    retry.type = 'button';
    retry.hidden = true;
    let loading = false;
    let loaded = false;
    async function load() {
      if (loading || loaded) return;
      loading = true;
      retry.hidden = true;
      sources.replaceChildren(element('p', 'field-help', '正在读取依据与来源…'));
      try {
        const detail = await api(`/api/routine-runs/${encodeURIComponent(runId)}`);
        if (!detail || asId(detail.id) !== runId || !Array.isArray(detail.sources)) throw new Error('本次运行的依据与来源尚未就绪。');
        sources.replaceChildren();
        for (const source of detail.sources) {
          if (!source || typeof source.text !== 'string' && source.kind !== 'web') continue;
          const item = element('div', 'routine-source');
          const kinds = { journal: 'Journal', todo: '待办', message: '对话', reflection: '回顾', web: '网页' };
          item.append(element('p', 'field-help', `${Object.hasOwn(kinds, source.kind) ? kinds[source.kind] : '本地记录'} · ${dateLabel(source.time, true)} · ${asId(source.sourceId) || asId(source.id)}`));
          if (source.kind === 'web') item.append(element('h5', '', asText(source.title) || '未提供标题'));
          if (source.text) item.append(element('p', 'entry-text', asText(source.text)));
          if (source.kind === 'web') item.append(compact ? streamSourceLink(source.url, asText(source.title), true) : routineSourceLink(source.url));
          sources.append(item);
        }
        if (!sources.childElementCount) sources.append(element('p', 'field-help', '没有保存的依据与来源。'));
        loaded = detail.status !== 'running';
        retry.hidden = loaded;
      } catch (error) {
        sources.replaceChildren(element('p', 'form-feedback is-error', errorText(error)));
        retry.hidden = false;
      } finally { loading = false; }
    }
    details.append(element('summary', '', compact ? '依据与来源' : '查看依据与来源'));
    if (compact) details.append(element('p', 'stream-event-boundary', '这是一条独立推送，未进入模型历史；继续聊天时不会自动带上这段内容。'));
    details.append(sources, retry);
    details.addEventListener('toggle', () => { if (details.open) void load(); });
    retry.addEventListener('click', () => void load());
    return details;
  }

  function buildRoutineRun(run) {
    const card = element('article', 'routine-run');
    card.dataset.runId = asId(run.id);
    const heading = element('h4');
    const meta = element('p', 'field-help');
    const windowLabel = element('p', 'field-help');
    const topics = element('p', 'field-help');
    const fallback = element('p', 'field-help');
    const outcome = element('p', 'field-help');
    const body = element('p', 'entry-text');
    const overview = element('details', 'routine-overview');
    overview.append(element('summary', '', '查看运行总摘要'));
    const items = element('div', 'routine-items');
    const reason = element('p', 'field-help');
    const details = buildRoutineSources(asId(run.id));
    card.append(heading, meta, windowLabel, topics, fallback, outcome, body, overview, items, reason, details);
    card.routineView = { heading, meta, windowLabel, topics, fallback, outcome, body, overview, items, reason };
    return card;
  }

  function syncRoutineRuns(list, runs) {
    const existing = new Map([...list.children].map((node) => [node.dataset.runId, node]));
    for (const [index, run] of runs.entries()) {
      const id = asId(run.id);
      const card = existing.get(id) || buildRoutineRun(run);
      existing.delete(id);
      const view = card.routineView;
      const signature = JSON.stringify(run);
      if (card.routineSignature !== signature) {
        view.heading.textContent = asText(run.jobName) || 'Routine';
        view.meta.textContent = `${routineStatusLabels[run.status]} · ${dateLabel(run.startedAt)} · 任务版本 ${run.jobVersion ?? '—'}${Number.isFinite(run.durationMs) ? ` · ${(run.durationMs / 1000).toFixed(1)} 秒` : ''}${run.deliveredAt ? ` · 投递于 ${dateLabel(run.deliveredAt)}` : ''}`;
        view.windowLabel.textContent = `时间窗口（本地时间）：${dateLabel(run.start, true)} — ${dateLabel(run.end, true)}`;
        const topics = Array.isArray(run.topics) ? run.topics.filter((topic) => typeof topic === 'string' && topic.trim()) : [];
        view.topics.textContent = topics.length ? `话题：${topics.join('、')}` : '';
        view.topics.hidden = !topics.length;
        view.fallback.textContent = run.topicFallback === true ? '本次使用兜底话题（如无可用本地记录），不代表搜索已成功。' : '';
        view.fallback.hidden = !view.fallback.textContent;
        const items = Array.isArray(run.items) ? run.items.filter((item) => item && typeof item === 'object') : [];
        view.outcome.textContent = run.status === 'silent' && Array.isArray(run.items) && !items.length && topics.length ? '搜索后无值得推荐的资讯 · 未投递' : '';
        view.outcome.hidden = !view.outcome.textContent;
        view.body.textContent = asText(run.summary);
        view.body.hidden = !view.body.textContent;
        view.overview.hidden = !items.length || !view.body.textContent;
        if (items.length) view.overview.append(view.body);
        else card.insertBefore(view.body, view.overview);
        view.items.replaceChildren();
        view.items.hidden = !items.length;
        for (const item of items) {
          const article = element('article', 'routine-item');
          article.append(element('h5', '', asText(item.title) || '未提供标题'),
            element('p', 'field-help', `发布时间：${dateLabel(item.publishedAt, true)}${asId(item.sourceId) ? ` · 来源 ${asId(item.sourceId)}` : ''}`),
            element('p', 'entry-text', asText(item.summary) || '未提供摘要'), routineSourceLink(item.url));
          view.items.append(article);
        }
        view.reason.textContent = [asText(run.reason), asText(run.error)].filter(Boolean).join(' · ');
        view.reason.hidden = !view.reason.textContent;
        card.dataset.status = run.status;
        card.routineSignature = signature;
      }
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    }
    for (const card of existing.values()) card.remove();
  }

  async function loadRoutineHistory(id, force = false) {
    const view = routineCards.get(id);
    if (!view || view.loading || !view.history.open) return;
    const job = routineJob(id);
    const signature = JSON.stringify([job?.lastRun, state.routineRuns.filter((run) => asId(run.jobId) === id)]);
    if (!force && view.historySignature === signature) return;
    view.loading = true;
    view.historyFeedback.textContent = '正在读取最近 20 次运行…';
    view.historyRetry.hidden = true;
    try {
      const result = await api(`/api/routines/${encodeURIComponent(id)}/history`);
      if (!Array.isArray(result?.runs)) throw new Error('未能读取运行历史。');
      const runs = routineRunsFrom(result.runs);
      syncRoutineRuns(view.historyList, runs);
      view.historyFeedback.textContent = runs.length ? `最近 ${runs.length} 次 · 每次可查看依据` : '还没有运行记录。';
      view.historySignature = signature;
    } catch (error) {
      view.historyFeedback.textContent = errorText(error);
      view.historyRetry.hidden = false;
      view.historySignature = signature;
    } finally { view.loading = false; }
  }

  function buildRoutineCard(job) {
    const id = asId(job.id);
    const card = element('article', 'glass-card routine-card');
    card.dataset.jobId = id;
    const header = element('div', 'routine-card-header');
    const title = element('h3');
    const switchLabel = element('label', 'routine-switch');
    const switchText = element('span');
    const toggle = element('input');
    toggle.type = 'checkbox';
    toggle.setAttribute('role', 'switch');
    toggle.dataset.action = 'routine-toggle';
    switchLabel.append(switchText, toggle);
    header.append(title, switchLabel);
    const schedule = element('p', 'field-help');
    const next = element('p', 'field-help');
    const last = element('p', 'field-help');
    const blocked = element('p', 'routine-blocked field-help');
    const actions = element('div', 'routine-actions');
    const edit = actionButton('编辑', 'routine-edit', id);
    const remove = actionButton('删除', 'routine-delete', id, 'text-button danger-text');
    const run = actionButton('手动运行', 'routine-run', id, 'secondary-button');
    actions.append(edit, remove, run);
    const history = element('details', 'archive-section routine-history');
    const historySummary = element('summary', '', '最近 20 次运行');
    const historyFeedback = element('p', 'field-help');
    const historyList = element('div', 'entry-list');
    const historyRetry = element('button', 'text-button', '重新读取历史');
    historyRetry.type = 'button';
    historyRetry.hidden = true;
    history.append(historySummary, historyFeedback, historyList, historyRetry);
    history.addEventListener('toggle', () => { if (history.open) void loadRoutineHistory(id, true); });
    historyRetry.addEventListener('click', () => void loadRoutineHistory(id, true));
    edit.addEventListener('click', () => void editRoutine(id));
    remove.addEventListener('click', () => void mutateRoutine('delete', id));
    run.addEventListener('click', () => void mutateRoutine('run', id));
    toggle.addEventListener('change', () => { toggle.checked = routineJob(id)?.enabled === true; void mutateRoutine('toggle', id); });
    card.append(header, schedule, next, last, blocked, actions, history);
    const view = { card, title, schedule, next, last, blocked, toggle, switchText, edit, remove, run, history, historyFeedback, historyList, historyRetry };
    routineCards.set(id, view);
    return view;
  }

  function renderRoutines() {
    const capability = state.routineCapability;
    $('routine-capability').textContent = `${capability.network ? '联网接线可用' : '联网接线不可用'} · ${capability.verified ? '曾成功搜索（宿主报告）' : '尚无成功搜索验证'}`;
    $('routine-capability-detail').textContent = `${capability.message} ${capability.network ? '接线可用不保证实际搜索成功；默认任务仍停用，由你确认后启用。' : '联网任务不能启用或手动运行，但可停用已有任务、保存停用定义；不会替换为本地摘要。'}`;
    $('routine-network-label').textContent = `允许联网 · ${capability.network ? '接线可用' : '当前不可用'}`;
    $('routine-network-help').textContent = `${capability.network ? '确认后可独立联网，无本地记录时可用兜底话题。' : '当前不支持联网，可勾选并保存但暂不启用。'} 只有话题关键词会发给搜索服务，可能额外收费。`;
    $('routine-status').textContent = routinePollError || (routineUncertain ? '上次请求结果尚未确认，请刷新状态核对后再操作。' : '时间按本机时区；电脑唤醒后最多补跑最近一次。');
    const jobs = state.routines?.jobs || [];
    const disabled = jobs.filter((job) => !job.enabled);
    $('routine-count').textContent = `${jobs.length - disabled.length} 项已启用`;
    $('routine-disabled-summary').textContent = `已停用 · ${disabled.length}${disabled.length ? `（${disabled.slice(0, 2).map((job) => asText(job.name)).join('、')}${disabled.length > 2 ? '…' : ''}）` : ''}${disabled.some((job) => job.allowNetwork) ? capability.network ? ' · 联网任务需自行启用' : ' · 联网能力不可用' : ''}`;
    const ids = new Set(jobs.map((job) => asId(job.id)));
    for (const [id, view] of routineCards) if (!ids.has(id)) { view.card.remove(); routineCards.delete(id); }
    for (const list of [$('routine-list'), $('routine-disabled-list')]) {
      for (const child of [...list.children]) if (!child.dataset.jobId) child.remove();
    }
    for (const job of jobs) {
      const id = asId(job.id);
      const view = routineCards.get(id) || buildRoutineCard(job);
      const signature = JSON.stringify([job, capability]);
      if (view.signature !== signature) {
        view.title.textContent = asText(job.name);
        view.schedule.textContent = `${routineScheduleLabel(job.schedule)} · ${job.delivery === 'both' ? 'Today + 对话独立事件' : 'Today'} · ${job.allowNetwork ? '独立联网' : '本地摘要'}`;
        // nextRun 为空时优先说明被什么挡住，而不是笼统的“等待宿主安排”。
    view.next.textContent = `下次：${!job.enabled ? '已停用，不定时执行' : job.nextRun ? dateLabel(job.nextRun, true) : routineBlockedReason(job) || '等待宿主安排'}`;
        view.last.textContent = job.lastRun ? `最近：${routineStatusLabels[job.lastRun.status] || '未知状态'} · ${dateLabel(job.lastRun.startedAt)}${job.lastRun.summary ? ` · ${excerpt(asText(job.lastRun.summary), 100)}` : ''}` : '最近：尚未运行';
        view.blocked.textContent = routineBlockedReason(job);
        view.blocked.hidden = !view.blocked.textContent;
        view.signature = signature;
      }
      const list = job.enabled ? $('routine-list') : $('routine-disabled-list');
      if (view.card.parentElement !== list) list.append(view.card);
      if (currentTab === 'routine' && !document.hidden && view.history.open) void loadRoutineHistory(id);
    }
    if (!$('routine-list').childElementCount) $('routine-list').append(!hasState ? loadingState('sun') : emptyState(state.routines ? '还没有启用的约定' : '当前服务尚未提供 Routine', state.routines ? '在上方保存任务，或展开下方已停用任务；默认资讯卡不会自动联网。' : '兼容旧版状态，不尝试写入；现有 Journal、Todo 和设置仍可使用。', 'sun'));
    if (!$('routine-disabled-list').childElementCount) $('routine-disabled-list').append(element('p', 'field-help', '暂无停用任务；这里只展示服务实际返回的定义。'));
    updateRoutineControls();
  }

  async function readRoutineState(force = false) {
    if (routinePolling || booting || restartInFlight || !hasState) return false;
    if (!force && (routineBusy || statusRefreshing || settingsPolling || Date.now() - routineLastRead < 4800)) return false;
    routinePolling = true;
    const sequence = ++routineReadSequence;
    updateRoutineControls();
    try {
      const payload = await api('/api/state');
      if (sequence !== routineReadSequence) return false;
      applyRoutineState(payload);
      renderRoutines();
      return true;
    } catch (error) {
      routinePollError = `刷新失败：${errorText(error)} 当前保留上次状态与草稿。`;
      $('routine-status').textContent = routinePollError;
      return false;
    } finally {
      routineLastRead = Date.now();
      routinePolling = false;
      updateRoutineControls();
    }
  }

  async function rebaseRoutineDraft() {
    if (routineBusy || routineUncertain) return;
    if (!await readRoutineState(true) || !state.routines) return;
    const revision = state.routines.revision;
    const deleted = routineDraftId && !routineJob(routineDraftId);
    if (!await confirmAction('沿用草稿并核对最新版本？', `草稿不会被覆盖，也不会自动提交。${deleted ? '原任务已删除，继续后草稿将作为新任务。' : '下次保存将以刚读取的版本为准，请先核对任务卡中的已保存内容。'}若上次请求超时，创建可能已经成功，请避免重复创建。`, '保留草稿继续编辑', '取消')) return;
    if (revision !== state.routines?.revision) { notify('版本再次变化，请重新核对。'); return; }
    if (deleted) { routineDraftId = ''; $('routine-form-title').textContent = '新建 Routine'; }
    routineDraftRevision = revision;
    routineDraftBlocked = false;
    updateRoutineControls();
  }

  function reflectionOrder(a, b) {
    return (dateValue(b.createdAt || b.end)?.getTime() || 0) - (dateValue(a.createdAt || a.end)?.getTime() || 0);
  }
  // 最近一页与按需取回的更早条目合并去重；总数变小时按总数截断，避免外部删除后仍留着本地副本。
  function syncReflections() {
    const merged = new Map();
    for (const entry of [...reflectionPage, ...reflectionExtra]) if (entry && entry.id && !merged.has(entry.id)) merged.set(entry.id, entry);
    const list = [...merged.values()].sort(reflectionOrder);
    state.reflections = Number.isFinite(state.reflectionTotal) && state.reflectionTotal >= 0 ? list.slice(0, state.reflectionTotal) : list;
  }
  function sortedReflections() {
    return [...state.reflections].sort(reflectionOrder);
  }
  async function showMoreReflections() {
    const entries = sortedReflections();
    if (reflectionVisibleCount < entries.length || !state.reflectionHasMore) { reflectionVisibleCount += 7; renderReflections(); return; }
    if (reflectionLoading) return;
    reflectionLoading = true; renderReflections();
    try {
      const cursor = entries.at(-1)?.id;
      const query = cursor ? `?after=${encodeURIComponent(cursor)}` : '';
      const page = await api(`/api/reflections${query}`);
      const loaded = entriesFrom(page.reflections, 'reflections');
      const seen = new Set(reflectionExtra.map((entry) => entry.id));
      for (const entry of loaded) if (!seen.has(entry.id)) reflectionExtra.push(entry);
      if (Number.isFinite(page.total)) state.reflectionTotal = page.total;
      state.reflectionHasMore = page.hasMore === true;
      syncReflections();
      reflectionVisibleCount += 7;
    } catch (error) {
      feedback('reflection-run-feedback', `未能载入更早的回顾：${errorText(error)}`, true);
    } finally {
      reflectionLoading = false; renderReflections();
    }
  }
  function localDateKey(value) {
    const date = dateValue(value);
    if (!date) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function buildReflectionCard(entry) {
    const card = element('article', 'glass-card reflection-card');
    const prefix = `reflection-card-${++localSequence}`;
    const heading = element('h3');
    const meta = element('p', 'field-help');
    const body = element('p', 'entry-text reflection-body');
    const edit = element('button', 'text-button', '编辑这篇回顾');
    edit.type = 'button';
    const form = element('form', 'reflection-form');
    const label = element('label', 'field-label', '回顾正文 · 本地 Markdown 原文');
    const input = element('textarea', 'note-input reflection-input');
    input.id = `${prefix}-input`;
    label.htmlFor = input.id;
    input.rows = 10;
    input.spellcheck = false;
    const conflict = element('p', 'form-feedback is-error');
    conflict.setAttribute('role', 'status');
    conflict.id = `${prefix}-conflict`;
    input.setAttribute('aria-describedby', conflict.id);
    const actions = element('div', 'form-actions');
    const reload = element('button', 'secondary-button', '载入最新版本');
    reload.type = 'button';
    const save = element('button', 'primary-button', '保存回顾');
    save.type = 'submit';
    const message = element('p', 'form-feedback');
    message.id = `${prefix}-feedback`;
    message.setAttribute('role', 'status');
    message.hidden = true;
    actions.append(reload, save);
    form.append(label, input, conflict, actions);
    card.append(heading, meta, body, edit, form, message);
    const view = { card, heading, meta, body, edit, form, input, conflict, reload, save, message, entry };
    edit.addEventListener('click', () => {
      reflectionDrafts.get(entry.id).editing = true;
      renderReflections();
      input.focus();
    });
    input.addEventListener('input', () => {
      const draft = reflectionDrafts.get(entry.id);
      draft.text = input.value;
      draft.dirty = draft.text !== draft.baseline;
      feedback(message.id);
      updateControls();
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); void saveRevision('reflection', entry.id); });
    reload.addEventListener('click', () => void reloadRevision('reflection', entry.id));
    return view;
  }

  function renderReflections() {
    const entries = sortedReflections();
    const visible = entries.slice(0, reflectionVisibleCount);
    // 新回顾插入或外部删除后，仍保留正在编辑的卡片及其原 revision。
    for (const [id, view] of reflectionCards) {
      const draft = reflectionDrafts.get(id);
      if (!visible.some((entry) => entry.id === id) && (draft.editing || draft.dirty || draft.awaiting || draft.saving)) visible.push(entries.find((entry) => entry.id === id) || view.entry);
    }
    visible.sort((a, b) => (dateValue(b.createdAt || b.end)?.getTime() || 0) - (dateValue(a.createdAt || a.end)?.getTime() || 0));
    const list = $('reflection-list');
    for (const [id, view] of reflectionCards) {
      if (visible.some((entry) => entry.id === id)) continue;
      view.card.remove();
      feedbackMessages.delete(view.message.id);
      reflectionCards.delete(id);
    }
    visible.forEach((entry, index) => {
      if (!reflectionDrafts.has(entry.id)) reflectionDrafts.set(entry.id, newDraft(entry));
      if (!reflectionCards.has(entry.id)) reflectionCards.set(entry.id, buildReflectionCard(entry));
      const view = reflectionCards.get(entry.id);
      const draft = reflectionDrafts.get(entry.id);
      view.entry = entry;
      if (list.children[index] !== view.card) list.insertBefore(view.card, list.children[index] || null);
      view.heading.textContent = `${dateLabel(entry.end || entry.createdAt, true)} · 每日回顾`;
      view.meta.textContent = `${dateLabel(entry.start, true)} — ${dateLabel(entry.end, true)} · 生成于 ${dateLabel(entry.createdAt, true)} · revision ${asId(entry.revision) || '未提供'}`;
      view.body.textContent = entry.text;
      view.body.hidden = draft.editing;
      view.edit.hidden = draft.editing;
      view.form.hidden = !draft.editing;
      if (view.input.value !== draft.text) view.input.value = draft.text;
      view.input.disabled = draft.saving || draft.awaiting;
      view.conflict.textContent = draft.conflict ? '这篇回顾已被外部修改或删除。草稿和原 revision 保留；请复制需要的内容，再载入最新版本合并。' : !validRevision(draft.revision) ? '宿主未提供 revision，暂不能安全保存；请刷新版本。' : '';
      view.conflict.hidden = !view.conflict.textContent;
      view.save.disabled = !canMutate() || draft.saving || draft.awaiting || draft.conflict || !validRevision(draft.revision) || !draft.dirty || !draft.text.trim();
      view.save.textContent = draft.saving ? '保存中…' : draft.awaiting ? '等待同步版本' : '保存回顾';
      view.reload.disabled = !canMutate() || draft.saving;
      view.edit.disabled = !canMutate() || !validRevision(draft.revision);
    });
    const empty = $('reflection-empty');
    empty.hidden = visible.length > 0;
    if (!visible.length) empty.replaceChildren(!hasState ? loadingState('sun') : emptyState('尚未留下回顾', !state.features.reflections ? '宿主尚未提供回顾接口，请更新后重载。' : '先保存并启用每日回顾，再等待自动执行或手动补跑。', 'sun'));
    const total = Number.isFinite(state.reflectionTotal) && state.reflectionTotal > 0 ? state.reflectionTotal : entries.length;
    const shown = Math.min(reflectionVisibleCount, entries.length);
    $('reflection-count').textContent = `已显示 ${shown} / ${total} 条${visible.length > shown ? ' · 另保留编辑卡片' : ''}`;
    const more = $('reflections-more');
    more.hidden = entries.length <= reflectionVisibleCount && !state.reflectionHasMore;
    more.disabled = reflectionLoading;
    more.textContent = reflectionLoading ? '载入更早…' : '再显示 7 条';
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
    renderProfileCandidates();
  }

  function renderProfileCandidates() {
    const entries = state.profileCandidates.filter((entry) => !['accepted', 'rejected'].includes(entry.status));
    $('profile-candidate-count').textContent = `${entries.length} 条待查看`;
    const list = $('profile-candidate-list');
    list.replaceChildren();
    if (!hasState) { list.append(loadingState('memory')); return; }
    if (!entries.length) { list.append(emptyState('没有待确认画像', '开启「每周画像」后每周生成一份草稿；只有你接受后才会写入 user 资料。', 'memory')); return; }
    for (const entry of entries) {
      const card = element('div', 'candidate-entry');
      const section = (title, items) => {
        if (!items.length) return;
        card.append(element('p', 'field-help', title));
        const items$ = element('ul', 'entry-list');
        for (const line of items) items$.append(element('li', 'entry-text', line));
        card.append(items$);
      };
      section('事实与偏好 · 依据记录，接受后写入 user 资料', entry.facts);
      section('推测 · 只用于资讯推演，不进对话上下文', entry.inference);
      const actions = element('div', 'form-actions');
      for (const [label, action, className] of [['忽略', 'profile-candidate-reject', 'text-button'], ['接受并写入 user 资料', 'profile-candidate-accept', 'secondary-button']]) {
        const button = actionButton(label, action, entry.id, className);
        button.disabled = !canMutate() || pending.has(`profile-candidate:${entry.id}`);
        actions.append(button);
      }
      card.append(actions);
      list.append(card);
    }
  }

  function decideProfileCandidate(id, accept) {
    void mutate(`profile-candidate:${id}`, `/api/profile-candidates/${encodeURIComponent(id)}`, { accept }, 'profile-candidate-feedback',
      accept ? '已写入 user 资料：事实段进入对话上下文，推测段只用于资讯推演。' : '已忽略这条画像，未写入 user 资料。');
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
    $('background-state').textContent = pending.has('background') ? '正在处理请求' : !hasState ? '尚未读取' : offline ? '状态待核对' : !state.features.background ? '宿主未提供' : !state.background.supported ? '此宿主不支持' : state.background.error ? '状态异常' : state.background.enabled ? '已启用（服务返回）' : '未启用';
    $('background-toggle').textContent = pending.has('background') ? '正在处理…' : state.background.enabled ? '停用' : '启用';
    feedback('background-error', state.background.error, true);
    const reflectionStatus = [!hasState ? '尚未读取每日回顾状态' : state.settings.reflectionEnabled ? '自动回顾已保存开启 · 本地 05:00' : '自动回顾未开启 · 需保存并启用后才能手动运行', offline ? '连接异常，当前为上次状态' : '', taskStatus(state.maintenance.reflection), reflectionReceipt?.waiting ? '手动请求最终结果待核对' : ''].filter(Boolean).join(' · ');
    $('reflection-status').textContent = reflectionStatus;
    $('settings-reflection-status').textContent = reflectionStatus;
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
    $('file-access-root').textContent = state.runtime.fileAccess?.root || '尚未确认数据目录';
    $('file-access-summary').textContent = state.runtime.fileAccess?.mode === 'denied'
      ? '对话不能读写文件或执行命令。数据目录内的凭据和程序文件也不授权。'
      : '尚未确认文件权限边界。';
    const runtime = state.runtime;
    const verification = !hasState ? '尚未读取' : offline ? '无法获取最新状态'
      : runtime.modelVerified === true ? '已验证（宿主报告）' : '待首轮验证';
    const credentialSource = !hasState ? '尚未读取' : runtime.credentialSource === 'harness' ? '继承主设置' : '未提供';
    let label = '正在读取状态';
    let kind = 'waiting';
    if (offline) { label = '暂时无法连接'; kind = 'error'; }
    else if (!hasState && !booting) label = '等待服务启动';
    else if (hasState) {
      if (runtime.configured !== true) label = '尚未配置模型';
      else if (runtime.installed !== true || runtime.connected !== true) label = '等待服务就绪';
      else if (runtime.error) { label = '需要检查配置'; kind = 'error'; }
      else if (runtime.modelVerified === true) { label = '已连接 · 已验证'; kind = 'connected'; }
      else label = '已连接 · 待验证';
    }
    $('runtime-label').textContent = label;
    $('runtime-button').dataset.state = kind;
    $('runtime-button').title = `${label} · 打开设置`;
    $('runtime-button').setAttribute('aria-label', $('runtime-button').title);
    $('harness-badge').textContent = !hasState ? '尚未读取' : runtime.installed === true ? '已就绪' : '未就绪';
    $('harness-installed').textContent = !hasState ? '尚未读取' : runtime.installed === true ? '已安装' : '未就绪';
    $('harness-version').textContent = runtime.version || (hasState ? '未提供' : '—');
    $('model-configured').textContent = !hasState ? '尚未读取' : runtime.configured === true ? '已配置' : '尚未配置';
    $('model-connected').textContent = !hasState ? '尚未读取' : offline ? '暂时无法获取' : runtime.connected === true ? '已连接' : '未连接';
    $('model-verified').textContent = verification;
    $('credential-source').textContent = credentialSource;
    $('model-provider').textContent = state.settings.provider || (hasState ? '尚未配置' : '—');
    $('model-provider').title = $('model-provider').textContent;
    $('model-name').textContent = state.settings.model || (hasState ? '尚未配置' : '—');
    $('model-name').title = $('model-name').textContent;
    $('settings-host-hint').textContent = !hasState
      ? '正在读取配置。打开或保存设置不会连接模型或发送消息。'
      : offline ? '暂时无法读取配置，请重新加载。'
        : runtime.configured === true
          ? '模型已配置。更换模型请到主设置；保存这里的设置不会调用模型，但开启自动功能后会按计划调用并可能产生费用。'
          : '尚未配置模型，请到主设置中配置。你仍然可以保存名字和偏好设定。';
    $('welcome-connection').textContent = !hasState || offline
      ? '读取状态后再开始对话。'
      : runtime.configured === true
        ? `模型已就绪。发送第一句话给 ${displayName()} 开始对话吧。Journal 和记忆也可以随时使用。`
        : `与 ${displayName()} 对话前，请先配置模型。Journal、记忆和改名不受影响。`;
    feedback('runtime-error', runtime.error ? (name) => `${name} 遇到了问题：${runtime.error}` : '', true);
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

  function renderAssistantContent(target, text) {
    if (window.ClaudiaMarkdown) window.ClaudiaMarkdown.render(target, text);
    else target.textContent = text;
  }

  // 已投递到对话流的卡片一直留在流里，按时间插在消息之间，靠后续新消息与新卡片自然往上顶。
  // 不再按“仅今天”过滤：跨天不应让已经出现过的卡片凭空消失。
  // 数量受服务端上限约束（运行记录最多 20 条、回顾按页返回），不会无限增长。
  function streamCards() {
    const cards = [];
    for (const run of state.routineRuns) {
      if (run.status !== 'success' || run.delivery !== 'both' || !run.deliveredAt) continue;
      const at = dateValue(run.deliveredAt);
      if (!at) continue;
      cards.push({ at: at.getTime(), kind: 'routine', run });
    }
    for (const entry of state.reflections) {
      const at = dateValue(entry.end || entry.createdAt);
      if (!at) continue;
      cards.push({ at: at.getTime(), kind: 'reflection', reflection: entry });
    }
    return cards.sort((a, b) => a.at - b.at);
  }

  function buildStreamCard(card) {
    if (card.kind === 'reflection') return buildReflectionStreamCard(card.reflection);
    const run = card.run;
    const article = element('article', 'message is-routine-card');
    const meta = element('div', 'message-meta');
    meta.append(element('span', 'display-name message-name', asText(run.jobName) || 'Routine'));
    if (dateValue(run.deliveredAt)) {
      const time = element('time', '', dateLabel(run.deliveredAt));
      time.dateTime = run.deliveredAt;
      meta.append(time);
    }
    const bubble = element('div', 'message-bubble routine-stream-card');
    const items = Array.isArray(run.items) ? run.items.filter((item) => item && typeof item === 'object') : [];
    if (items.length) {
      const list = element('div', 'routine-stream-items');
      for (const item of items) {
        const entry = element('div', 'routine-stream-item');
        const title = asText(item.title) || '未提供标题';
        const heading = element('div', 'routine-stream-heading');
        heading.append(element('h3', 'routine-stream-title', title));
        if (item.url) heading.append(streamSourceLink(item.url, title));
        entry.append(heading);
        const body = asText(item.summary);
        if (body) entry.append(element('p', 'entry-text', body));
        list.append(entry);
      }
      bubble.append(list);
    } else {
      bubble.append(element('p', 'entry-text', asText(run.summary) || '本次没有摘要内容。'));
    }
    bubble.append(buildRoutineSources(asId(run.id), true));
    article.append(meta, bubble);
    return article;
  }

  function buildReflectionStreamCard(entry) {
    const article = element('article', 'message is-reflection-card');
    const meta = element('div', 'message-meta');
    meta.append(element('span', 'display-name message-name', `${displayName()} 的观察`));
    if (dateValue(entry.end || entry.createdAt)) {
      const time = element('time', '', dateLabel(entry.end || entry.createdAt, true));
      time.dateTime = asText(entry.end || entry.createdAt);
      meta.append(time);
    }
    const bubble = element('div', 'message-bubble reflection-stream-card');
    renderAssistantContent(bubble, asText(entry.text) || '这一期没有留下正文。');
    article.append(meta, bubble, streamEventNote());
    return article;
  }


  function renderChat(forceScroll = false) {
    if (activeRun?.renderFrame) { cancelAnimationFrame(activeRun.renderFrame); activeRun.renderFrame = null; }
    const nearBottom = nearChatBottom();
    const list = $('message-list');
    list.replaceChildren();
    const cards = streamCards();
    $('welcome').hidden = state.messages.length > 0 || cards.length > 0;
    const entries = [
      ...state.messages.map((message) => ({ at: dateValue(message.createdAt)?.getTime() || 0, message })),
      ...cards.map((card) => ({ at: card.at, card })),
    ].sort((a, b) => a.at - b.at || (a.card ? -1 : 1));
    for (const entry of entries) {
      if (entry.card) { list.append(buildStreamCard(entry.card)); continue; }
      const message = entry.message;
      const isEmailReview = message.source === 'email-review';
      const article = element('article', `message${message.role === 'user' ? ' is-user' : ''}${isEmailReview ? ' is-email-review' : ''}`);
      const meta = element('div', 'message-meta');
      const name = message.role === 'user' ? '你' : message.role === 'assistant' ? displayName() : '系统消息';
      const nameLabel = element('span', 'display-name message-name', name);
      nameLabel.title = name;
      meta.append(nameLabel);
      if (isEmailReview) meta.append(element('span', 'email-review-tag', '独立邮件分析'));
      if (dateValue(message.createdAt)) {
        const time = element('time', '', dateLabel(message.createdAt));
        time.dateTime = message.createdAt;
        meta.append(time);
      }
      const bubble = element('div', 'message-bubble', message.content);
      if (message.role === 'assistant') renderAssistantContent(bubble, message.content);
      article.append(meta, bubble);
      if (isEmailReview && message.role === 'assistant') article.append(element('p', 'email-review-boundary', '独立标题与发件人分析结果 · 这些字段不自动带入普通后续会话；不读取正文或附件，不自动发信、不访问链接。'));
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
    renderRoutines();
    renderCandidates();
    renderProfiles();
    renderReflections();
    renderServices();
    renderRuntime();
    renderChat();
    renderAttachments();
    renderLogs();
    updateControls();
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function renderLogs() {
    if (!state.features.logs) {
      $('logs-state').textContent = '不可用';
      $('logs-summary').textContent = '当前宿主没有提供日志能力。';
      return;
    }
    const logs = state.logs;
    const failing = Boolean(logs.error);
    $('logs-state').textContent = failing ? '写入异常' : logs.capped ? '今日已达上限' : logs.day ? '记录中' : '待写入';
    $('logs-state').classList.toggle('is-warning', failing || logs.capped);
    $('logs-path').textContent = logs.dir || '尚未创建日志目录';
    const parts = [];
    if (logs.day) parts.push(`当前文件 ${logs.day}.log，${formatBytes(logs.bytes)}`);
    if (logs.retainDays) parts.push(`保留 ${logs.retainDays} 天`);
    if (logs.capped) parts.push('已达当日上限，后续事件不再写入，明天自动恢复');
    if (failing) parts.push(`写入失败：${logs.error}`);
    if (!logs.day && !failing) parts.push('本次启动还没有写入事件');
    $('logs-summary').textContent = parts.join('；');
    if (state.logsLoaded) {
      $('logs-view').textContent = state.logLines.length ? state.logLines.join('\n') : '最近两天没有记录到事件。';
    }
  }

  async function loadLogs() {
    if (!state.features.logs || pending.has('logs')) return false;
    pending.add('logs');
    updateControls();
    try {
      feedback('logs-feedback');
      const payload = await api('/api/logs?limit=200');
      // 只接受字符串行，避免任何非预期内容被当成 HTML 处理；textContent 本身也不解析标记。
      state.logLines = Array.isArray(payload?.lines) ? payload.lines.filter((line) => typeof line === 'string').slice(-200) : [];
      if (payload?.status) state.logs = {
        dir: asText(payload.status.dir), day: asText(payload.status.day),
        bytes: Number.isFinite(payload.status.bytes) ? payload.status.bytes : 0,
        capped: payload.status.capped === true,
        retainDays: Number.isFinite(payload.status.retainDays) ? payload.status.retainDays : 0,
        error: asText(payload.status.error)
      };
      state.logsLoaded = true;
      renderLogs();
      $('logs-view').scrollTop = $('logs-view').scrollHeight;
      return true;
    } catch (error) {
      feedback('logs-feedback', errorText(error), true);
      return false;
    } finally {
      pending.delete('logs');
      updateControls();
    }
  }

  function renderPlugins(payload) {
    const packages = payload.packages.filter((plugin) => !plugin.name.startsWith('@deepseek-ai/') && plugin.name !== 'dsh-claudia' && !plugin.name.endsWith('/dsh-claudia'));
    $('plugins-profile').textContent = payload.profile.trim() || '未知';
    $('plugins-runtime').textContent = payload.runtimeAvailable ? '可直接观测' : '不可直接观测（不代表插件未加载）';
    feedback('plugins-status', [payload.available ? `已读取正式 bundle 清单 · ${packages.length} 项非系统扩展` : '插件清单暂不可用', payload.message].filter(Boolean).join('。'), !payload.available);
    const list = $('plugins-list');
    list.replaceChildren();
    $('plugins-empty').hidden = payload.available && packages.length > 0;
    $('plugins-empty').textContent = payload.available ? '当前 profile 没有非系统扩展；系统扩展及 Claudia 自身不在此展示。' : '暂无法读取扩展清单，不能据此判断是否安装。请刷新后重试。';
    if (!payload.available) return;
    const phases = { pending: '宿主等待就绪', active: '宿主已加载', failed: '宿主插件失败', loading: '宿主加载中', unloading: '宿主卸载中' };
    for (const plugin of packages) {
      const item = element('li', 'plugin-item');
      const heading = element('div', 'plugin-heading');
      heading.append(element('h4', '', plugin.name), element('span', 'plugin-version', `版本：${plugin.version?.trim() || '未知'}`));
      const status = element('div', 'plugin-status');
      status.append(
        element('span', 'quiet-tag', plugin.installed ? '已安装' : '未确认安装'),
        element('span', 'quiet-tag', plugin.enabled === false ? '宿主已停用' : plugin.enabled === true ? '宿主已启用（不代表已加载）' : '宿主启停状态未知'),
        element('span', plugin.phase === 'failed' ? 'quiet-tag is-warning' : 'quiet-tag', plugin.phase === null ? '运行阶段未直接观测' : phases[plugin.phase])
      );
      item.append(heading, status);
      list.append(item);
    }
  }

  async function loadPlugins() {
    if (!$('settings-dialog').open || settingsTab !== 'plugins') return;
    const sequence = ++pluginsReadSequence;
    $('plugins-refresh').disabled = true;
    $('plugins-refresh').textContent = '读取中…';
    $('plugins-list').setAttribute('aria-busy', 'true');
    $('plugins-list').replaceChildren();
    $('plugins-empty').hidden = true;
    $('plugins-profile').textContent = '正在读取…';
    $('plugins-runtime').textContent = '正在读取…';
    feedback('plugins-status', '正在读取当前 profile 的正式 bundle 清单…');
    try {
      const payload = await api('/api/plugins');
      if (sequence !== pluginsReadSequence) return;
      if (!payload || typeof payload.available !== 'boolean' || typeof payload.profile !== 'string'
        || typeof payload.runtimeAvailable !== 'boolean' || typeof payload.message !== 'string' || !Array.isArray(payload.packages)
        || !payload.packages.every((plugin) => plugin && typeof plugin.name === 'string'
          && (plugin.version === null || typeof plugin.version === 'string') && typeof plugin.installed === 'boolean'
          && (plugin.enabled === null || typeof plugin.enabled === 'boolean')
          && [null, 'pending', 'active', 'failed', 'loading', 'unloading'].includes(plugin.phase))) {
        throw new Error('插件清单数据格式不完整，请检查服务版本后刷新。');
      }
      renderPlugins(payload);
    } catch (error) {
      if (sequence !== pluginsReadSequence) return;
      $('plugins-profile').textContent = '未能读取';
      $('plugins-runtime').textContent = '未能读取';
      feedback('plugins-status', error.name === 'TimeoutError' ? '读取插件清单超时，请手动刷新重试。' : `读取插件清单失败：${errorText(error)}`, true);
      $('plugins-empty').textContent = '未显示插件清单，不能据此判断是否安装。';
      $('plugins-empty').hidden = false;
    } finally {
      if (sequence === pluginsReadSequence) {
        $('plugins-refresh').disabled = false;
        $('plugins-refresh').textContent = '刷新插件';
        $('plugins-list').setAttribute('aria-busy', 'false');
      }
    }
  }

  function validateEmail(payload) {
    if (!payload || typeof payload.supported !== 'boolean' || !(payload.revision === null || typeof payload.revision === 'string')
      || !(payload.savedEnabled === null || typeof payload.savedEnabled === 'boolean')
      || !(payload.enabled === null || typeof payload.enabled === 'boolean')
      || !(payload.phase === null || typeof payload.phase === 'string')
      || typeof payload.needsRestart !== 'boolean' || typeof payload.message !== 'string') throw new Error('邮件状态格式不完整，请核对后端版本后刷新。');
    return payload;
  }

  function emailLoaded() { return ['active', 'loaded'].includes(emailSnapshot?.phase); }
  function emailCanToggle() {
    return canMutate() && !emailReviewPreparing && !emailBusy && !emailReading && !emailAccountBusy && !emailAccountReading && !emailError && emailSnapshot?.supported === true
      && typeof emailSnapshot.savedEnabled === 'boolean' && typeof emailSnapshot.enabled === 'boolean'
      && typeof emailSnapshot.revision === 'string' && emailSnapshot.revision.length > 0
      && !['failed', 'error'].includes(emailSnapshot.phase);
  }

  function renderEmail() {
    const snapshot = emailSnapshot;
    const known = !emailError && !emailReading && typeof snapshot?.savedEnabled === 'boolean';
    const input = $('email-enabled');
    input.checked = snapshot?.savedEnabled === true;
    input.indeterminate = !known;
    input.setAttribute('aria-checked', known ? String(input.checked) : 'mixed');
    input.disabled = !emailCanToggle();
    $('email-status').textContent = emailBusy ? '等待确认 / 保存中' : emailReading ? '正在读取…' : emailError ? '状态待核对'
      : !snapshot ? '尚未读取' : !snapshot.supported ? '当前不支持' : !known ? '保存状态未知' : snapshot.savedEnabled ? '已保存开启' : '已保存关闭';
    $('email-status').classList.toggle('is-error', Boolean(emailError));
    const enabled = typeof snapshot?.enabled === 'boolean' ? snapshot.enabled ? '已启用' : '已停用' : '未知';
    $('email-runtime').textContent = `宿主实际启停：${enabled}；加载阶段：${snapshot?.phase || '未直接观测'}${emailError || emailReading ? '（上次读取，待核对）' : ''}。启用不等于账号已连接。`;
    $('email-message').textContent = emailError || snapshot?.message || '';
    $('email-message').classList.toggle('is-error', Boolean(emailError));
    $('email-refresh').disabled = emailReading || emailBusy || emailAccountBusy || emailAccountReading || restartInFlight || emailReviewPreparing;
    $('email-restart-actions').hidden = snapshot?.needsRestart !== true;
    const blocked = restartBlocked();
    $('email-restart').disabled = Boolean(blocked);
    $('email-restart-hint').textContent = blocked || '已保存，重启后生效；点击后仍需确认，不会自动重启。';
    $('email-loaded-hint').textContent = '无需打开宿主即可使用上方账号表单。此入口仅供高级管理，打不开不影响在此填写；宿主页面可能检查已配置账号。'
      + (emailLoaded() && !emailError ? '邮件扩展已加载，不代表邮箱已连接。' : '尚未确认邮件扩展已加载，实际状态以上方 Loader 报告为准。');
    $('email-open-harness').disabled = !canMutate() || emailBusy || emailAccountBusy || pending.has('open-harness');
  }

  async function loadEmail() {
    if (!$('settings-dialog').open || settingsTab !== 'plugins' || emailReading || emailBusy || emailAccountBusy || restartInFlight || emailReviewPreparing) return;
    emailReading = true;
    renderEmail();
    try {
      emailSnapshot = validateEmail(await api('/api/email'));
      emailError = '';
    } catch (error) {
      emailError = `邮件状态读取失败：${errorText(error)} 不能据此判断开关已关闭；请刷新核对。`;
    } finally {
      emailReading = false;
      renderEmail();
    }
  }

  async function toggleEmail() {
    const enabled = $('email-enabled').checked;
    if (!emailCanToggle()) { renderEmail(); return; }
    const revision = emailSnapshot.revision;
    emailBusy = true;
    pending.add('email');
    updateControls();
    feedback('email-feedback');
    try {
      const approved = await confirmAction(enabled ? '在宿主中开启邮件扩展？' : '在宿主中关闭邮件扩展？',
        `${enabled ? '开启可能让宿主其他 Agent 获得邮件工具，并对已有账户自动检查邮件。' : '关闭会影响宿主邮件工具与已有账户自动检查。'}\nClaudia 普通聊天仍无邮件权限。本次不会替你配置邮箱。\n单独保存，重启生效；不提交其它设置草稿，也不会自动重启。`, enabled ? '确认单独开启' : '确认单独关闭', '取消');
      if (!approved) { feedback('email-feedback', '已取消，恢复原开关；未提交任何设置。'); return; }
      if (!canMutate() || emailSnapshot.revision !== revision) throw new Error('连接或邮件版本已变化，未提交；请刷新邮件状态。');
      emailSnapshot = validateEmail(await api('/api/email', { method: 'POST', body: { enabled, revision, confirmHostTools: true } }));
      emailError = '';
      feedback('email-feedback', emailSnapshot.savedEnabled === enabled ? `邮件开关已单独保存。${emailSnapshot.needsRestart ? '需重启生效，可使用下方重启按钮。' : '实际启停以宿主报告为准。'}其它设置草稿未提交。` : '服务已返回状态，但未确认保存为所选值。请核对状态后再操作。', emailSnapshot.savedEnabled !== enabled);
    } catch (error) {
      emailError = `${errorText(error)} 保存结果待核对，请刷新邮件状态；不会自动重试或冒充关闭。`;
      feedback('email-feedback', emailError, true);
    } finally {
      emailBusy = false;
      pending.delete('email');
      updateControls();
      if (!$('email-enabled').disabled) $('email-enabled').focus({ preventScroll: true });
    }
  }

  function validQQAddress(user) {
    return /^[a-z0-9][a-z0-9._-]{0,99}@(qq\.com|foxmail\.com)$/i.test(user);
  }

  function validateEmailAccount(payload) {
    if (!payload || typeof payload.supported !== 'boolean' || !(payload.revision === null || typeof payload.revision === 'string')
      || typeof payload.user !== 'string' || typeof payload.passwordSet !== 'boolean' || payload.applies !== 'live'
      || typeof payload.message !== 'string' || payload.supported && (payload.user && !validQQAddress(payload.user)
        || payload.passwordSet && !payload.user)) throw new Error('邮箱配置状态格式不完整。');
    const compatible = payload.compatible === true;
    if (compatible && (typeof payload.receiveEnabled !== 'boolean' || typeof payload.sendEnabled !== 'boolean'
      || typeof payload.configured !== 'boolean' || payload.supported && !asText(payload.revision))) throw new Error('邮箱权限状态格式不完整。');
    // 旧版权限保持未知，不将缺失字段解释为禁发；只投影非敏感字段。
    return { supported: payload.supported, revision: payload.supported ? payload.revision : null,
      user: payload.supported ? payload.user : '', passwordSet: payload.supported && payload.passwordSet,
      applies: 'live', message: payload.message, compatible,
      configured: typeof payload.configured === 'boolean' ? payload.configured : Boolean(payload.supported && payload.user && payload.passwordSet),
      receiveEnabled: compatible ? payload.receiveEnabled : null, sendEnabled: compatible ? payload.sendEnabled : null };
  }

  function hasEmailAccountDraft() {
    return $('email-account-user').value !== (emailAccountSnapshot?.user || '') || $('email-account-password').value.length > 0
      || emailAccountSnapshot?.compatible === true && ($('email-account-receive').checked !== emailAccountSnapshot.receiveEnabled
        || $('email-account-send').checked !== emailAccountSnapshot.sendEnabled);
  }

  function discardEmailAccountDraft() {
    $('email-account-password').value = '';
    $('email-account-user').value = emailAccountSnapshot?.user || '';
    $('email-account-receive').checked = emailAccountSnapshot?.compatible === true ? emailAccountSnapshot.receiveEnabled : true;
    $('email-account-send').checked = emailAccountSnapshot?.compatible === true ? emailAccountSnapshot.sendEnabled : false;
  }

  function applyEmailAccount(snapshot) {
    emailAccountSnapshot = snapshot;
    discardEmailAccountDraft();
    if (!snapshot.compatible) emailAccountEditing = false;
    emailAccountError = '';
  }

  function openEmailAccountEditor() {
    if ($('email-account-edit').disabled) return;
    emailAccountEditing = true;
    updateControls();
    $('email-account-user').focus();
  }

  function emailAccountCanSave() {
    return $('settings-dialog').open && canMutate() && !emailBusy && !emailAccountBusy && !emailAccountReading
      && !settingsSaving && !settingsClosing && !confirmResolver && !restartConfirming && !emailAccountNeedsReadback && !emailAccountError
      && !emailReviewPreparing && emailAccountEditing && emailAccountSnapshot?.supported === true
      && emailAccountSnapshot.compatible === true && hasEmailAccountDraft();
  }

  function renderEmailAccount() {
    const snapshot = emailAccountSnapshot;
    const blocked = emailAccountBusy || emailAccountReading || emailBusy || settingsSaving || settingsClosing || restartInFlight || emailReviewPreparing;
    const editable = snapshot?.supported === true && snapshot.compatible === true;
    const stale = Boolean(emailAccountError || emailAccountReading || emailAccountNeedsReadback);
    $('email-account-fields').disabled = blocked || !canMutate() || !editable || Boolean(emailAccountError) || emailAccountNeedsReadback;
    $('email-account-form').hidden = !emailAccountEditing;
    $('email-account-form').setAttribute('aria-busy', String(emailAccountBusy || emailAccountReading));
    $('email-account-edit').hidden = emailAccountEditing;
    $('email-account-edit').disabled = blocked || !canMutate() || !editable || Boolean(emailAccountError) || emailAccountNeedsReadback;
    $('email-account-edit').setAttribute('aria-expanded', String(emailAccountEditing));
    $('email-account-card').hidden = !snapshot?.user;
    $('email-account-card-title').textContent = stale ? '上次读取配置 · 待核对' : snapshot?.configured ? '已保存配置' : '已保存账号 · 配置未完整';
    $('email-account-card-user').textContent = snapshot?.user || '';
    $('email-account-card-receive').textContent = snapshot?.compatible !== true ? '未知 · 旧版不支持权限控制' : snapshot.receiveEnabled ? '已开启' : '已关闭';
    $('email-account-card-send').textContent = snapshot?.compatible !== true ? '未知 · 不能确认已禁发' : snapshot.sendEnabled ? '已开启（本操作不发信）' : '已关闭';
    $('email-account-save').disabled = !emailAccountCanSave();
    $('email-account-save').textContent = emailAccountBusy ? '等待确认 / 处理中…' : '保存邮箱配置';
    $('email-account-cancel').disabled = blocked || !emailAccountEditing;
    $('email-account-reload').disabled = blocked || booting;
    const reviewDisabled = !emailReviewCanStart() || emailReviewPreparing;
    $('email-review-days').disabled = blocked || !canMutate() || !editable || stale;
    $('email-review-prompt').disabled = blocked || !canMutate() || !editable || stale;
    $('email-review').disabled = reviewDisabled;
    $('email-review').setAttribute('aria-busy', String(emailReviewPreparing));
    $('email-review').title = !snapshot?.compatible ? '需升级 dsh-email 0.11.0-claudia.2 兼容版'
      : !snapshot.configured ? '请先单独保存完整邮箱配置' : !snapshot.receiveEnabled ? '请先编辑并保存开启收信权限'
        : stale ? '请先重新载入并核对邮箱配置' : '先预览范围与模型，人工确认后分析';
    $('email-account-status').textContent = emailAccountBusy ? '邮箱独立操作进行中，请等待。' : emailAccountReading ? '正在读取邮箱配置…'
      : emailAccountNeedsReadback ? '保存结果待核对：已清空授权码，保存已锁定，请确认后重新载入。'
        : emailAccountError ? '邮箱状态未确认，请重新载入。' : !snapshot ? '首次进入插件页后读取账号配置。'
          : !snapshot.supported ? '当前宿主不支持此账号表单。' : !snapshot.compatible ? '需升级 dsh-email 0.11.0-claudia.2 兼容版，才能保存收发权限或分析邮件。旧 0.11.0 仅展示账号，不能保证已禁发。'
            : hasEmailAccountDraft() ? '邮箱草稿未保存；不会随下方“保存设置”提交。'
              : snapshot.configured ? '已保存配置 · 连接未验证。点“编辑”修改，保存即生效，无需重启。' : '尚未完成邮箱配置。请点“编辑”填写并单独保存。';
    $('email-account-status').classList.toggle('is-error', Boolean(emailAccountError || emailAccountNeedsReadback));
    $('email-account-message').textContent = emailAccountError
      ? [emailAccountError, snapshot?.supported === false ? snapshot.message : ''].filter(Boolean).join(' ')
      : snapshot?.message || '';
    $('email-account-message').classList.toggle('is-error', Boolean(emailAccountError));
    $('email-account-secret-status').textContent = !snapshot || !snapshot.supported ? '授权码状态未知，不回填任何占位内容。'
      : `${emailAccountError || emailAccountReading || emailAccountNeedsReadback ? '上次读取：' : ''}${snapshot.passwordSet ? '已有授权码，永不回显；同一邮箱留空可保留。' : '尚无已保存的授权码，请填写新授权码。'}`;
  }

  async function loadEmailAccount(replaceDraft = false) {
    if (!$('settings-dialog').open || settingsTab !== 'plugins' || emailAccountReading || emailAccountBusy || emailBusy || restartInFlight || emailReviewPreparing) return;
    if (!replaceDraft && (hasEmailAccountDraft() || emailAccountNeedsReadback)) {
      feedback('email-account-feedback', emailAccountNeedsReadback
        ? '上次保存结果待核对，不会自动重试。请点击“重新载入”并确认后读回；不会依据地址相同认定授权码保存成功。'
        : '邮箱草稿及原保存基线已保留。刷新或再次进入不会覆盖；如需最新配置，请点击“重新载入”并确认放弃草稿。', emailAccountNeedsReadback);
      renderEmailAccount();
      return;
    }
    const sequence = ++emailAccountReadSequence;
    const wasUncertain = emailAccountNeedsReadback;
    emailAccountReading = true;
    updateControls();
    try {
      const snapshot = validateEmailAccount(await api('/api/email/account'));
      if (sequence !== emailAccountReadSequence || !$('settings-dialog').open) return;
      if (hasEmailAccountDraft()) {
        feedback('email-account-feedback', '读取期间检测到邮箱草稿，未覆盖输入或原保存基线。请明确确认后重新载入。');
        return;
      }
      applyEmailAccount(snapshot);
      emailAccountNeedsReadback = false;
      feedback('email-account-feedback', wasUncertain
        ? '已读回当前配置，但地址相同或“已有授权码”不能证明上次新授权码保存成功。如需确认替换，请重新输入授权码并主动保存；不会自动重试。'
        : snapshot.supported ? '已载入当前配置；授权码不会回显，未检查收件箱或发送测试邮件。' : '', wasUncertain);
    } catch {
      if (sequence !== emailAccountReadSequence) return;
      emailAccountError = '邮箱配置读取失败，请检查本机服务与接口版本后重新载入；不能据此判断账号或授权码不存在。';
    } finally {
      if (sequence === emailAccountReadSequence) { emailAccountReading = false; updateControls(); }
    }
  }

  async function editEmailAccount(reload = false) {
    if (emailAccountBusy || emailAccountReading || emailBusy || settingsSaving || settingsClosing || restartInFlight || confirmResolver || emailReviewPreparing) return;
    emailAccountBusy = true;
    pending.add('email-account-edit');
    updateControls();
    try {
      if (!await confirmAction(reload ? '重新载入邮箱配置？' : '放弃邮箱草稿？',
        `${reload ? '将清空输入的授权码、放弃邮箱草稿，并读取最新账号与保存基线。' : '只放弃本页邮箱草稿并清空授权码，不修改已保存配置。'}\n其它设置草稿不受影响。${emailAccountNeedsReadback ? '\n上次保存结果仍不确定，放弃草稿不能撤销可能已写入的内容；读回也不能凭地址相同确认新授权码保存成功。' : ''}`,
        reload ? '放弃草稿并重新载入' : '放弃邮箱草稿', '继续编辑')) return;
      discardEmailAccountDraft();
      emailAccountEditing = false;
      feedback('email-account-feedback', emailAccountNeedsReadback ? '邮箱草稿已放弃，上次保存仍待读回；请重新载入后再保存。' : '已取消邮箱编辑，没有写入配置。', emailAccountNeedsReadback);
    } finally {
      emailAccountBusy = false;
      pending.delete('email-account-edit');
      updateControls();
    }
    if (reload) await loadEmailAccount(true);
  }

  function validateEmailAccountDraft() {
    const user = $('email-account-user').value.trim().toLowerCase();
    if (!validQQAddress(user)) {
      feedback('email-account-feedback', '请填写完整的 qq.com 或 foxmail.com 邮箱地址。', true);
      return false;
    }
    if ($('email-account-password').value.trim()) {
      if (!/^[A-Za-z]{16}$/.test($('email-account-password').value.trim())) {
        feedback('email-account-feedback', '授权码必须是 16 位英文字母，不是 QQ 登录密码；允许前后空白。', true);
        return false;
      }
    } else if (!emailAccountSnapshot?.passwordSet || user !== emailAccountSnapshot.user.trim().toLowerCase()) {
      feedback('email-account-feedback', '新账号或更换邮箱必须填写授权码；只有同一邮箱已有授权码时才可留空保留。', true);
      return false;
    }
    return true;
  }

  async function saveEmailAccount(event) {
    event.preventDefault();
    if (!emailAccountCanSave() || !validateEmailAccountDraft()) return;
    const revision = emailAccountSnapshot.revision;
    const receiveEnabled = $('email-account-receive').checked;
    const sendEnabled = $('email-account-send').checked;
    emailAccountBusy = true;
    pending.add('email-account-save');
    updateControls();
    let submitted = false;
    try {
      if (!await confirmAction('单独保存邮箱配置？',
        `收信：${receiveEnabled ? '开启' : '关闭'}；发信：${sendEnabled ? '开启' : '关闭'}。勾选发信启用宿主发信能力，不等于左侧普通对话可发信；邮件分析始终无外发工具。兼容版仅支持经审批的纯文本新邮件，不支持附件、回复或转发。\n授权码将保存在本机设置文件中，不是系统钥匙串；此页面不使用浏览器持久存储。\n宿主邮件工具之后可使用该账号，宿主页面可能检查账号。\n本次不主动读信、不发送测试邮件、不开放 Claudia 普通聊天工具，也不改变 Loader 开关或提交其它 Settings 草稿。\n邮箱配置保存即生效（live），无需重启。`,
        '确认保存到本机设置文件', '继续编辑')) return;
      if (!canMutate() || emailAccountSnapshot.revision !== revision) {
        feedback('email-account-feedback', '连接或配置版本已变化，未提交邮箱配置；草稿保留，请重新载入核对。', true);
        return;
      }
      if (!validateEmailAccountDraft()) return;
      const user = $('email-account-user').value.trim().toLowerCase();
      submitted = true;
      const snapshot = validateEmailAccount(await api('/api/email/account', { method: 'POST',
        body: { user, password: $('email-account-password').value.trim(), revision, confirmHostStorage: true, receiveEnabled, sendEnabled } }));
      if (!snapshot.supported || !snapshot.compatible) throw new Error('账号权限表单当前不受支持。');
      if (snapshot.user.toLowerCase() !== user || !snapshot.passwordSet || !snapshot.configured
        || snapshot.receiveEnabled !== receiveEnabled || snapshot.sendEnabled !== sendEnabled) throw new Error('邮箱保存回执不完整。');
      applyEmailAccount(snapshot);
      emailAccountEditing = false;
      emailAccountNeedsReadback = false;
      feedback('email-account-feedback', '邮箱配置已单独保存并即时生效，无需重启；输入框中的授权码已清空。未读信、未发测试邮件，未开放 Claudia 聊天工具，其它设置草稿未提交。');
    } catch (error) {
      if (submitted) {
        $('email-account-password').value = '';
        emailAccountNeedsReadback = true;
        const message = error?.status === 400 ? '邮箱配置校验未通过。' : error?.status === 409 ? '邮箱配置版本冲突。'
          : error?.status === 503 ? '宿主未能确认邮箱配置保存结果。' : '邮箱配置保存未获有效确认，可能已写入。';
        emailAccountError = `${message} 已清空授权码并锁定保存，请确认后重新载入；不会自动重试，也不能凭地址相同判断新授权码保存成功。`;
        feedback('email-account-feedback', emailAccountError, true);
      } else feedback('email-account-feedback', '本次未提交邮箱配置，草稿仍保留。', true);
    } finally {
      emailAccountBusy = false;
      pending.delete('email-account-save');
      updateControls();
      if (!emailAccountEditing && !$('email-account-edit').disabled) $('email-account-edit').focus({ preventScroll: true });
    }
  }

  function emailReviewCanStart() {
    const days = Number($('email-review-days').value), prompt = $('email-review-prompt').value.trim();
    return canMutate() && emailReviewRanges.has(days) && Boolean(prompt) && prompt.length <= 500
      && emailAccountSnapshot?.supported === true && emailAccountSnapshot.compatible === true
      && emailAccountSnapshot.configured === true && emailAccountSnapshot.receiveEnabled === true
      && !emailAccountError && !emailAccountNeedsReadback && !emailAccountReading && !emailAccountBusy && !emailBusy && !emailReading
      && !activeRun && !state.busy && !settingsSaving && !settingsClosing && !resetting && !profileBusy() && !restartConfirming;
  }

  function validateEmailReviewPreview(preview, days) {
    if (!preview || typeof preview.supported !== 'boolean') throw new Error('邮件分析预览格式不完整，未连接邮箱。');
    if (!preview.supported) throw new Error(asText(preview.message) || '当前宿主不支持独立邮件分析，请检查兼容版与收信配置。');
    const reading = preview.reading;
    if (!asText(preview.revision) || !preview.selection || Array.isArray(preview.selection)
      || !asText(preview.selection.provider).trim() || !asText(preview.selection.model).trim()
      || preview.window?.days !== days || !asText(preview.window?.since) || !asText(preview.window?.until) || !asText(preview.window?.label)
      || !reading || JSON.stringify(reading.fields) !== '["subject","from"]' || reading.pageSize !== 100
      || reading.maxMessages !== null || reading.readsBodies !== false || reading.readsAttachments !== false) {
      throw new Error('邮件分析范围、模型或只读字段与当前界面契约不一致；未连接邮箱，请检查服务版本。');
    }
    return preview;
  }

  async function reviewEmail() {
    if (emailReviewPreparing || !emailReviewCanStart() || !$('settings-dialog').open || confirmResolver) return;
    const days = Number($('email-review-days').value);
    const prompt = $('email-review-prompt').value.trim();
    if (!emailReviewRanges.has(days)) { feedback('email-review-feedback', '请选择支持的邮件查看范围。', true); return; }
    if (!prompt || prompt.length > 500) { feedback('email-review-feedback', '请输入 1—500 字的分析要求。', true); return; }
    const sequence = ++emailReviewSequence;
    emailReviewPreparing = true;
    pending.add('email-review-preview');
    updateControls();
    feedback('email-review-feedback', '正在预览范围与当前模型；此步骤不连接邮箱。');
    try {
      const preview = validateEmailReviewPreview(await api(`/api/email/review/preview?days=${encodeURIComponent(days)}`), days);
      if (sequence !== emailReviewSequence || !$('settings-dialog').open) return;
      if (!emailReviewCanStart()) throw new Error('当前配置或运行状态已变化，请核对后重新预览；未启动分析。');
      const approved = await confirmAction('确认共享邮件标题与发件人并独立分析？',
        `只读 INBOX：${preview.window.label}。\n会分页读取该范围内全部邮件标题与发件人显示名/地址，不设置封数上限；不会读取正文、原始 MIME 或附件内容，也不会改变已读状态。\n分析要求：${prompt}\n标题与发件人字段将发送至当前所选模型：\nProvider：${preview.selection.provider}\nModel：${preview.selection.model}\n模型可能在云端；邮件较多时可能更慢、产生更多费用或受模型上下文限制。这些字段会在独立分析会话中持久记录，结果留在 Claudia 记录，不上传 Workbench。\n发件人字段可辅助判断疑似广告、欺诈风险或疑似官方邮件，但单凭 From 字段不能验证真实身份。\n不自动发信、不访问邮件链接。普通聊天继续零工具，邮件字段不自动带入普通后续会话。\n确认后先处理未保存的设置与邮箱草稿，再关闭设置，在左侧对话展示进度与结果，可点击“停止”。`,
        '确认共享并分析', '取消，不连接邮箱');
      if (!approved) { feedback('email-review-feedback', '已取消；未连接邮箱，未向模型发送邮件标题或发件人。'); return; }
      if (sequence !== emailReviewSequence || !emailReviewCanStart() || !$('settings-dialog').open) return;
      const requestId = crypto.randomUUID();
      // 必须沿用关闭保护；取消、保存失败或仍有待处理草稿时均不发起分析。
      await closeSettings();
      if ($('settings-dialog').open) {
        feedback('email-review-feedback', '未启动分析；请先处理或保留草稿，之后重新点击并确认。');
        return;
      }
      if (!emailReviewCanStart()) { feedback('chat-feedback', '运行状态已变化，未启动邮件分析。请重新打开设置预览并确认。', true); return; }
      await startChatRun('/api/email/review', { revision: preview.revision, selection: preview.selection,
        confirmDataSharing: true, requestId, days, prompt }, prompt, [], 'email-review');
    } catch (error) {
      if (sequence === emailReviewSequence && $('settings-dialog').open) feedback('email-review-feedback', errorText(error), true);
    } finally {
      emailReviewPreparing = false;
      pending.delete('email-review-preview');
      updateControls();
    }
  }

  function updateControls() {
    const usable = canMutate();
    const busy = Boolean(activeRun);
    $('send-button').hidden = busy;
    $('cancel-button').hidden = !busy;
    $('cancel-button').disabled = !busy || !activeRun.runId || activeRun.cancelRequested || activeRun.phase === 'sync';
    $('send-button').disabled = !usable || resetting || settingsSaving || state.runtime.configured !== true || !$('chat-input').value.trim();
    $('send-button').title = state.runtime.configured === true ? `发送给 ${displayName()}` : '宿主未配置模型，请在模型设置中检查';
    $('send-button').setAttribute('aria-label', `发送给 ${displayName()}`);
    $('journal-save').disabled = !usable || journalSaving || !$('journal-input').value.trim();
    $('journal-save').textContent = journalSaving ? '保存中…' : '保存记录';
    $('memory-save').disabled = !usable || memorySaving || !$('memory-input').value.trim() || !$('memory-confirm').checked;
    $('memory-save').textContent = memorySaving ? '保存中…' : '确认保存';
    $('settings-save').disabled = !usable || settingsSaving || busy || resetting || Boolean(settingsReceipt?.uncertain) || !hasSettingsDrafts();
    $('settings-save').textContent = settingsSaving ? '保存中…' : '保存设置';
    $('reset-session').disabled = !usable || busy || settingsSaving || resetting;
    $('reset-session').textContent = resetting ? '重置中…' : '重置对话';
    $('journal-input').disabled = journalSaving;
    for (const id of ['memory-input', 'memory-confirm']) $(id).disabled = memorySaving;
    for (const id of ['assistant-name-input', 'allow-context']) $(id).disabled = !usable || settingsSaving || busy || resetting;
    const profileSaving = profileBusy();
    const configurationBusy = settingsSaving || busy || resetting || profileSaving || pending.has('background');
    $('send-button').disabled ||= profileSaving || emailReviewPreparing;
    $('reset-session').disabled ||= emailReviewPreparing;
    $('settings-save').disabled ||= profileSaving || pending.has('background') || emailAccountBusy;
    $('settings-close').disabled = emailAccountBusy || emailBusy || settingsSaving || pending.has('reflection-run');
    $('reset-session').disabled ||= profileSaving;
    for (const id of ['assistant-name-input', ...Object.values(settingFields)]) {
      $(id).disabled = !usable || configurationBusy || Boolean(settingsReceipt?.uncertain) || (id !== 'assistant-name-input' && id !== 'allow-context' && !state.features.automation);
    }
    $('todo-add').disabled = !usable || !state.features.todos || pending.has('todo-add') || !$('todo-input').value.trim() || todoComposing;
    $('todo-add').textContent = pending.has('todo-add') ? '添加中…' : '添加';
    $('todo-input').disabled = pending.has('todo-add');
    for (const id of ['reflection-run', 'settings-reflection-run']) {
      $(id).disabled = !canRunReflection();
      $(id).textContent = pending.has('reflection-run') ? '等待确认 / 提交中…' : state.maintenance.reflection?.running === true ? '后台执行中…' : reflectionReceipt?.waiting ? '已受理 / 待核对' : '手动运行一次';
      $(id).title = !state.settings.reflectionEnabled || settingsDraft?.reflectionEnabled !== true ? '需要保存并启用每日回顾；开关关闭时不可运行' : '补跑最近本地 05:00 一期；已有结果不重复生成';
    }
    const reflectionSaving = [...reflectionDrafts.values()].some((draft) => draft.saving);
    $('open-folder').disabled = !usable || pending.has('open-folder');
    $('open-folder').disabled ||= !state.dataDirectory;
    $('logs-refresh').disabled = !usable || !state.features.logs || pending.has('logs');
    $('logs-refresh').textContent = pending.has('logs') ? '读取中…' : '刷新';
    $('open-logs').disabled = !usable || !state.features.logs || !state.logs.dir || pending.has('open-logs');
    $('background-toggle').disabled = !usable || !state.background.supported || pending.has('background') || configurationBusy;
    $('profiles-refresh').disabled = booting || busy || settingsSaving || [...profileDrafts.values()].some((draft) => draft.saving);
    $('reflections-refresh').disabled = booting || busy || reflectionSaving || pending.has('reflection-run');
    $('retry-load').disabled = booting || busy || restartInFlight;
    for (const id of ['settings-open-harness', 'plugins-open-harness']) $(id).disabled = !usable || pending.has('open-harness');
    renderSettingsEffect();
    renderRestart();
    renderProfiles();
    renderReflections();
    $('settings-reflection-refresh').disabled = booting || restartInFlight || settingsPolling || statusRefreshing || pending.has('reflection-run');
    renderEmail();
    renderEmailAccount();
    updateRoutineControls();
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
    if (focus) $(`tab-${name}`).focus();
    $(`tab-${name}`).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (name === 'routine') { renderRoutines(); void readRoutineState(); }
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
    const labels = { assistantName: '名字', allowContext: '附带个人记录', activityEnabled: '应用使用时长', reflectionEnabled: '每日回顾', autoUpdateEnabled: '自动更新', memorySuggestionsEnabled: '记忆候选', profileEnabled: '每周画像', settings: '设置', batch: '批量保存' };
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
      const task = state.maintenance[{ reflectionEnabled: 'reflection', autoUpdateEnabled: 'update', memorySuggestionsEnabled: 'memory', profileEnabled: 'profile' }[field]];
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
    $('settings-draft-status').textContent = !hasState ? '正在读取设置' : emailAccountBusy ? '邮箱独立操作进行中'
      : emailAccountNeedsReadback ? '邮箱保存结果待核对；请到插件页重新载入'
        : hasEmailAccountDraft() ? '邮箱草稿需单独保存；下方只保存其它设置'
          : hasSettingsDrafts() || receipt?.uncertain ? '有未保存的设置更改' : '无待保存的设置草稿';
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
    // 首次切到数据与维护才读日志：隐藏的页面不做轮询，也不在打开设置时白拉一次。
    if (name === 'maintenance' && !state.logsLoaded) void loadLogs();
    if (name === 'plugins') { void loadPlugins(); void loadEmail(); void loadEmailAccount(); }
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

  function openSettings(name = settingsTab) {
    if (!settingsTabs.includes(name)) return;
    if ($('settings-dialog').open) { switchSettingsTab(name, true); return; }
    settingsReturnFocus = document.activeElement;
    renderRuntime();
    updateControls();
    $('settings-dialog').showModal();
    switchSettingsTab(name, true);
    scheduleSettingsPoll();
  }

  function settleSettingsClose(choice) {
    const resolve = settingsCloseResolver;
    settingsCloseResolver = null;
    $('settings-close-dialog').close();
    resolve?.(choice);
  }

  function finishSettingsClose() {
    discardEmailAccountDraft();
    emailAccountEditing = false;
    ++emailAccountReadSequence;
    emailAccountReading = false;
    $('settings-dialog').close();
  }

  async function closeSettings() {
    if (settingsClosing || !$('settings-dialog').open) return;
    if (inlineConfirm) { settleConfirm(false); return; }
    if (emailBusy || emailAccountBusy || pending.has('reflection-run')) { feedback('settings-feedback', '独立操作正在提交，请等待读取结果；设置和邮箱草稿仍保留。'); return; }
    if (settingsSaving) { feedback('settings-feedback', '正在保存或等待确认，请先完成当前操作。'); return; }
    settingsClosing = true;
    const returnFocus = document.activeElement;
    try {
      if (hasEmailAccountDraft() || emailAccountNeedsReadback) {
        if (!await confirmAction('关闭前单独处理邮箱草稿',
          `邮箱配置不随“保存设置”提交。放弃将清空输入的授权码，只丢弃邮箱草稿；其它设置之后单独处理。${emailAccountNeedsReadback ? '\n上次保存结果仍待核对，放弃草稿不会撤销可能已写入的配置；下次仍需重新载入，不能凭地址相同确认新授权码保存成功。' : ''}\n若要保存邮箱，请继续编辑并使用“保存邮箱配置”。`,
          '放弃邮箱草稿', '继续编辑')) return;
        discardEmailAccountDraft();
      }
      if (!hasSettingsDrafts() && !settingsReceipt?.uncertain) { finishSettingsClose(); return; }
      $('settings-close-description').textContent = settingsReceipt?.uncertain
        ? '上次普通设置保存结果仍待核对。“放弃草稿”只放弃本页编辑，不能撤销可能已写入的内容；重新打开设置后仍可核对。取消会继续保留草稿。'
        : '有未保存的更改。保存设置只提交名字、普通开关和正文，不含邮箱；放弃草稿不会写入，取消则返回继续编辑。';
      $('settings-close-save').disabled = $('settings-save').disabled;
      const choice = await new Promise((resolve) => {
        settingsCloseResolver = resolve;
        $('settings-close-dialog').showModal();
        $('settings-close-cancel').focus();
      });
      if (choice === 'save') {
        if (await saveSettings()) finishSettingsClose();
      } else if (choice === 'discard') {
        settingsDraft = null;
        settingsBaseline = null;
        profileDrafts.clear();
        syncSettingsDraft();
        for (const name of profileNames) feedback(`profile-${name}-feedback`);
        feedback('settings-feedback');
        if (!settingsReceipt?.uncertain) settingsReceipt = null;
        updateControls();
        finishSettingsClose();
      }
    } finally {
      settingsClosing = false;
      updateControls();
      if ($('settings-dialog').open && returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true });
    }
  }

  function hasUnsavedDrafts() {
    return Object.keys(settingsChanges()).length > 0
      || [...profileDrafts.values(), ...reflectionDrafts.values()].some((draft) => draft.dirty || draft.awaiting)
      || ['chat-input', 'journal-input', 'todo-input', 'memory-input'].some((id) => $(id).value.trim())
      || attachments.size > 0 || routineDraftDirty || routineDraftBlocked
      || hasEmailAccountDraft() || emailAccountBusy || emailAccountNeedsReadback;
  }

  function restartBusy() {
    return Boolean(activeRun) || settingsSaving || resetting || journalSaving || memorySaving || profileBusy() || routineBusy || routineUncertain || emailBusy || emailAccountBusy || emailAccountReading || reflectionReceipt?.waiting
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
    if (emailAccountNeedsReadback) return '邮箱保存结果待核对，请先到插件页确认并重新载入，再重启。';
    if (restartBusy()) return '宿主或页面任务忙碌，请等待任务结束后重启。';
    if (hasUnsavedDrafts()) return '有未保存草稿，请先保存或处理邮箱、设置、人格、回顾及输入框中的草稿。';
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
    $('restart-description').textContent = [emailSnapshot?.needsRestart ? '邮件开关已单独保存，重启后生效。' : '', pendingRestart ? '更新已安装，重启后应用。' : '普通设置无需重启；必要时可重启 Claudia 的后台服务。', restart.message || restart.reason].filter(Boolean).join('\n');
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
    const approved = await confirmAction('重启 Claudia 的后台服务？', '将重启 Claudia 的后台服务，期间会短暂断开连接，已有对话与本地记录保留。\n\n存在未保存草稿或忙碌任务时不会发起重启。只提交一次请求，不会因网络超时重复发送。', '确认重启服务', '暂不重启');
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
      if (sent && emailSnapshot) emailError = '重启后邮件状态需要重新读取，请进入插件页或刷新邮件状态。';
      updateControls();
      if (sent) void loadEmail();
      scheduleSettingsPoll();
    }
  }

  function confirmAction(title, description, accept, cancel = '保留') {
    if (confirmResolver) return Promise.resolve(false);
    inlineConfirm = $('settings-dialog').open;
    confirmReturnFocus = document.activeElement;
    const prefix = inlineConfirm ? 'settings-action' : 'confirm';
    $(`${prefix}-title`).textContent = title;
    $(`${prefix}-description`).textContent = description;
    $(`${prefix}-accept`).textContent = accept;
    $(`${prefix}-cancel`).textContent = cancel;
    return new Promise((resolve) => {
      confirmResolver = resolve;
      if (inlineConfirm) {
        // 设置内使用同一 dialog 的确认区域，避免嵌套 modal 抢走 Escape。
        for (const node of $('settings-dialog').children) if (node !== $('settings-action-confirm')) node.inert = true;
        $('settings-action-confirm').hidden = false;
      } else $('confirm-dialog').showModal();
      $(`${prefix}-cancel`).focus();
    });
  }

  function settleConfirm(accepted) {
    const resolve = confirmResolver;
    confirmResolver = null;
    if (inlineConfirm) {
      $('settings-action-confirm').hidden = true;
      for (const node of $('settings-dialog').children) node.inert = false;
      inlineConfirm = false;
    } else $('confirm-dialog').close();
    if (confirmReturnFocus?.isConnected && !confirmReturnFocus.disabled) confirmReturnFocus.focus({ preventScroll: true });
    confirmReturnFocus = null;
    if (resolve) resolve(accepted);
  }

  async function saveJournal(event) {
    event.preventDefault();
    if (journalSaving || !canMutate()) return;
    const text = $('journal-input').value.trim();
    if (!text) { feedback('journal-feedback', '写下一点内容，再保存吧。', true); return; }
    journalSaving = true;
    updateControls();
    feedback('journal-feedback');
    let saved = false;
    try {
      await api('/api/journal', { method: 'POST', body: { text } });
      saved = true;
      $('journal-input').value = '';
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
    if (settingsSaving || emailAccountBusy || activeRun || resetting || profileBusy() || pending.has('background') || !canMutate() || settingsReceipt?.uncertain) return false;
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
    if (settings.allowContext) warnings.push('以后主动发送对话时，会向已配置的模型自动发送最多各 10 条最近日志、确认记忆和未完成待办的原文，总计不超过 14000 字符，可能增加模型费用。关闭不会撤回已发送的内容。');
    if (settings.activityEnabled) warnings.push('在本机记录应用名称与前台时长，不采集窗口标题、网页、屏幕、键盘或正文；开启每日回顾后，可用时长会随回顾内容外发。');
    if (settings.reflectionEnabled) warnings.push('每天本地 05:00，将过去 24 小时的 Journal、Todo、对话摘录和可选应用时长发送给模型生成回顾，会产生费用。');
    if (settings.autoUpdateEnabled) warnings.push('每天本地 06:00 检查并安装稳定版，可能重启服务、短暂断开连接。');
    if (settings.memorySuggestionsEnabled) warnings.push('允许模型处理内容并生成记忆候选，可能产生费用；不会自动写入长期记忆，仍需你逐条接受。');
    if (settings.profileEnabled) warnings.push('允许模型处理近 30 天的 Journal、Todo 与你发出的消息并生成画像草稿，可能产生费用；不会自动改写 user 资料，仍需你逐条接受。');
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
      const settledAll = receipt.settled && !receipt.remainingSettings.size && !receipt.remainingProfiles.size && !Object.keys(receipt.errors).length;
      if (settledAll) {
        // 设定正文不需要重启，但也不会改写当前这轮已经发出的上下文：明确说清从下一轮开始生效。
        const names = { soul: '人格 soul', user: '关于你 user', system: '交流偏好 system' };
        const savedProfiles = Object.keys(names).filter((name) => receipt.accepted?.has(name));
        if (savedProfiles.length) feedback('settings-feedback', `已保存 ${savedProfiles.map((name) => names[name]).join('、')}：无需重启，从下一轮对话开始生效，当前这轮不会变。`);
        else feedback('settings-feedback');
      }
      return settledAll && !hasSettingsDrafts();
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
  function canRunReflection(ignorePending = false) {
    return canMutate() && state.features.reflections && state.runtime.configured === true && state.settings.reflectionEnabled === true
      && settingsDraft?.reflectionEnabled === true && !activeRun && !settingsSaving && !resetting && !restartConfirming
      && (ignorePending || !pending.has('reflection-run')) && !reflectionReceipt?.waiting && state.maintenance.reflection?.running !== true;
  }

  function reflectionFeedback(message, isError = false) {
    feedback('reflection-run-feedback', message, isError);
    feedback('settings-reflection-run-feedback', message, isError);
  }

  function observeReflectionRun() {
    const receipt = reflectionReceipt;
    if (!receipt?.waiting) return;
    const task = state.maintenance.reflection || {};
    if (task.running === true || task.state === 'running') { receipt.sawRunning = true; return; }
    const result = state.reflections.find((entry) => dateValue(entry.end)?.getTime() === receipt.end || !receipt.ids.has(entry.id));
    const changed = JSON.stringify(task) !== receipt.task;
    const terminal = ['success', 'completed', 'ok', 'skipped', 'error', 'failed', 'cancelled', 'no-data'].includes(task.state);
    if (result) {
      receipt.waiting = false;
      reflectionFeedback(receipt.ids.has(result.id) ? '已核对到本期已保存回顾，可在 Journal 查看；已有结果不会重复生成。' : '已从状态中读取到保存的回顾，可在 Journal 查看；受理响应本身不算生成成功。');
    } else if ((changed || receipt.sawRunning) && (terminal || task.error || task.lastError)) {
      receipt.waiting = false;
      reflectionFeedback(`后台状态已更新：${taskStatus(task) || '未提供详细结果'}。尚未读取到本期回顾，请查看执行状态。`, Boolean(task.error || task.lastError || ['error', 'failed'].includes(task.state)));
    } else if (Date.now() - receipt.at > 60000) {
      reflectionFeedback('尚未核对到本次最终结果。保留状态轮询，不重复提交；请使用「查看执行状态」或刷新回顾核对。', true);
    }
  }

  async function runReflection() {
    if (!canRunReflection()) return;
    pending.add('reflection-run');
    updateControls();
    let sent = false;
    try {
      if (!await confirmAction('补跑最近本地 05:00 一期？', '需要已保存并启用每日回顾。补跑最近本地 05:00 一期，已有结果不重复生成。\n会把该期过去 24 小时的 Journal、Todo、对话摘录和可选应用时长发送给所选模型，可能产生费用。篇幅宁短勿长，只写值得回顾的事，不凑字数。\n不改变统计窗口或自动开关，也不提交其它设置草稿。', '确认共享并运行', '取消')) {
        reflectionFeedback('已取消，未提交运行请求；自动开关与其它草稿保持不变。');
        return;
      }
      if (!canRunReflection(true)) throw new Error('当前状态已变化，请先保存并启用每日回顾后核对运行状态。');
      const requestId = crypto.randomUUID();
      const end = new Date();
      end.setHours(5, 0, 0, 0);
      if (end.getTime() > Date.now()) end.setDate(end.getDate() - 1);
      reflectionReceipt = { requestId, waiting: true, at: Date.now(), end: end.getTime(), ids: new Set(state.reflections.map((entry) => entry.id)), task: JSON.stringify(state.maintenance.reflection || {}), sawRunning: false };
      sent = true;
      const result = await api('/api/reflections/run', { method: 'POST', body: { confirmDataSharing: true, requestId }, withStatus: true });
      if (result.status !== 202) throw new Error('未收到预期的后台受理响应，最终结果需要从状态核对。');
      reflectionFeedback('后台已受理（不是生成成功）；正在轮询执行状态。已有结果不重复生成，可查看执行状态或 Journal 回顾。');
      if ($('settings-dialog').open) $('settings-reflection-details').open = true;
    } catch (error) {
      if (sent && error.status && error.status < 500) reflectionReceipt = null;
      reflectionFeedback(`${errorText(error)}${sent ? ' 不会自动重发，请查看执行状态。' : ' 未提交运行请求。'}`, true);
    } finally {
      pending.delete('reflection-run');
      updateControls();
      if (sent) await refreshStatus(false);
    }
  }
  function toggleBackground() {
    if (!state.background.supported) return;
    const enabled = !state.background.enabled;
    void mutate('background', '/api/background', { enabled }, 'background-feedback', enabled ? '启用请求已完成，以上方宿主返回的后台状态为准。' : '停用请求已完成，以上方宿主返回的后台状态为准。', {
      timeout: 120000,
      confirm: enabled
        ? ['启用 macOS 登录后台服务？', '确认后将请求安装并启用 macOS 系统后台服务，用于在后台运行服务，并在登录后自动启动。关闭浏览器本来就不会关闭正在运行的服务；启用结果以上方返回状态为准，不代表当前进程已被接管。\n\n此操作不改变其他功能开关。已开启的回顾和记忆候选可能调用付费模型，自动更新可能重启宿主；关机或休眠期间不保证执行。', '确认启用系统服务', '暂不启用']
        : ['停用登录后台服务？', '将请求停用 macOS 系统后台服务和登录自启，可能中断当前服务连接。停用结果以返回状态为准，已有记录保留。\n\n定时任务仍需服务运行；关闭浏览器与停用服务不是同一操作。', '确认停用', '保持启用']
    });
  }
  function openHost(event) {
    const feedbackId = event.currentTarget.id === 'email-open-harness' ? 'email-host-feedback'
      : event.currentTarget.id === 'plugins-open-harness' ? 'plugins-host-feedback' : 'settings-host-feedback';
    if (emailAccountBusy) return;
    void mutate('open-harness', '/api/open-harness', {}, feedbackId, event.currentTarget.id === 'email-open-harness'
      ? '已请求打开可选宿主入口。即使宿主页面无法打开，也可直接在 Claudia 的邮箱表单中配置。'
      : '已请求本机打开宿主管理页面。可在其中配置模型与连接器。', { refresh: false });
  }

  async function saveRevision(kind, id) {
    if (kind === 'profile') return saveSettings();
    const draft = reflectionDrafts.get(id);
    const feedbackId = reflectionCards.get(id)?.message.id;
    if (!feedbackId) return;
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
    const feedbackId = isProfile ? `profile-${id}-feedback` : reflectionCards.get(id)?.message.id;
    if (!feedbackId) return;
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
    if (statusRefreshing || settingsPolling || routinePolling || routineBusy || restartInFlight || booting || activeRun || settingsSaving || [...profileDrafts.values()].some((draft) => draft.saving) || pending.size || [...reflectionDrafts.values()].some((draft) => draft.saving)) return;
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
    run.assistant = { id: run.messageId || `local-assistant-${++localSequence}`, role: 'assistant', content: '', createdAt: '', status: 'streaming', source: run.source };
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
      case 'start': {
        const user = entriesFrom([frame.user], 'messages')[0];
        const assistant = entriesFrom([frame.assistant], 'messages')[0];
        if (run.source === 'email-review' && (!user || user.role !== 'user' || !assistant || assistant.role !== 'assistant')) {
          throw new Error('邮件分析启动回执不完整，请核对记录；不会自动重试。');
        }
        if (user?.role === 'user') Object.assign(run.user, user, { source: run.source });
        run.messageId = assistant?.role === 'assistant' ? assistant.id : asId(frame.id);
        if (assistant?.role === 'assistant') Object.assign(ensureAssistant(run), assistant, { source: run.source });
        if (run.assistant && run.messageId) run.assistant.id = run.messageId;
        if (run.source === 'email-review') {
          emailReviewMessageIds.add(run.user.id);
          emailReviewMessageIds.add(run.messageId);
          feedback('chat-feedback', '独立邮件分析进行中：正在只读获取并整理限定范围的邮件，可点击“停止”。');
        }
        renderChat();
        return false;
      }
      case 'status':
        if (typeof frame.text === 'string' && !run.cancelRequested) feedback('chat-feedback', run.source === 'email-review' ? `独立邮件分析 · ${frame.text}` : frame.text);
        return false;
      case 'delta': {
        if (typeof frame.text !== 'string') throw new Error('对话片段格式异常，请检查服务状态。');
        if (!frame.text) return false;
        const firstDelta = !run.assistant?.content;
        const assistant = ensureAssistant(run);
        assistant.content += frame.text;
        if (!run.renderFrame) run.renderFrame = requestAnimationFrame(() => {
          run.renderFrame = null;
          if (activeRun !== run || !run.contentElement?.isConnected) return;
          const stickToBottom = nearChatBottom();
          renderAssistantContent(run.contentElement, assistant.content);
          scrollChat(false, stickToBottom);
        });
        if (firstDelta) feedback('chat-feedback', run.source === 'email-review' ? '正在接收独立邮件分析结果…' : (name) => `正在接收 ${name} 的模型回复…`);
        return false;
      }
      case 'done': {
        const message = frame.message;
        if (!message || typeof message.content !== 'string' || !asId(message.id)) throw new Error('最终回复数据不完整，请刷新查看保存结果。');
        const assistant = ensureAssistant(run);
        Object.assign(assistant, { id: asId(message.id), role: 'assistant', content: message.content, createdAt: asText(message.createdAt), status: asText(message.status), source: run.source });
        if (run.source === 'email-review') emailReviewMessageIds.add(assistant.id);
        run.user.status = 'sent';
        run.done = true;
        renderChat();
        // 已落库但 Markdown 副本同步失败时服务端仍按成功交付，只附一条警告。
        const warning = typeof frame.warning === 'string' ? frame.warning.trim() : '';
        feedback('chat-feedback', run.source === 'email-review'
          ? `独立邮件标题与发件人分析${assistant.status === 'complete' ? '已完成' : `：${messageStatus(assistant.status) || '未完整结束'}`}。这些邮件字段不自动带入普通后续会话。${warning ? ` ${warning}` : ''}`
          : (name) => `${assistant.status === 'complete' ? `${name} 的回复已完成。` : `${name}：${messageStatus(assistant.status) || '回复未完整结束'}，可继续交流；模型问题请在模型设置中检查。`}${warning ? ` ${warning}` : ''}`);
        if (warning) notify(warning);
        return true;
      }
      case 'error':
        throw new Error(typeof frame.error === 'string' ? frame.error : asText(frame.error?.message) || '模型暂时没有完成回复，请在模型设置中检查后重试。');
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
    if (activeRun || emailReviewPreparing || resetting || settingsSaving || profileBusy() || restartInFlight || state.restart.state === 'restarting') return;
    if (!hasState || offline || !csrfToken) { feedback('chat-feedback', '请先连接本机服务，读取状态后再发送。', true); return; }
    const text = $('chat-input').value.trim();
    if (!text) return;
    if (state.runtime.configured !== true) {
      feedback('chat-feedback', (name) => `暂时无法给 ${name} 发送消息：宿主未配置有效模型路由，请在模型设置中检查，无需在此填写密钥。`, true);
      return;
    }
    const contextIds = [...attachments].filter((id) => state.journal.some((entry) => entry.id === id));
    await startChatRun('/api/chat', { text, ...(contextIds.length ? { contextIds } : {}) }, text, contextIds);
  }

  async function startChatRun(path, body, text, contextIds = [], source = 'chat') {
    const isEmailReview = source === 'email-review';
    const run = {
      source, controller: new AbortController(), user: { id: `local-user-${++localSequence}`, role: 'user', content: text, createdAt: '', status: 'sending', source },
      assistant: null, contentElement: null, messageId: '', runId: '', done: false, accepted: false,
      existingIds: new Set(state.messages.map((message) => message.id)),
      cancelRequested: false, cancelPromise: null, cancelError: '', phase: 'request'
    };
    activeRun = run;
    state.messages.push(run.user);
    if (!isEmailReview) {
      $('chat-input').value = '';
      attachments.clear();
      renderAttachments();
      resizeComposer();
    }
    updateControls();
    renderChat(true);
    if (isEmailReview) $('chat-scroll').focus({ preventScroll: true });
    feedback('chat-feedback', isEmailReview ? '独立邮件分析已请求，正在等待只读邮件检查与分析进度；不会自动发信或访问链接。' : (name) => `请求已发送，正在等待 ${name} 的模型回复。`);
    let failure = '';
    try {
      const response = await fetch(path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: run.controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Claudia-Token': csrfToken, Accept: 'application/x-ndjson' },
        body: JSON.stringify(body)
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
        feedback('chat-feedback', isEmailReview ? `独立邮件分析未完成：${failure} 不会自动重试，请先核对记录。` : (name) => `${name} 暂未完成回复：${failure}`, true);
        if (!isEmailReview && !run.accepted && !$('chat-input').value) {
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
      } else if (failure) feedback('chat-feedback', isEmailReview ? `独立邮件分析未完成：${failure} 不会自动重试，请先核对记录。` : (name) => `${name} 暂未完成回复：${failure}`, true);
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
    else if (target.dataset.action === 'profile-candidate-accept') decideProfileCandidate(id, true);
    else if (target.dataset.action === 'profile-candidate-reject') decideProfileCandidate(id, false);
  });

  $('runtime-button').addEventListener('click', () => openSettings('maintenance'));
  $('settings-open').addEventListener('click', () => openSettings());
  $('runtime-settings').addEventListener('click', () => switchSettingsTab('general', true));
  $('plugins-refresh').addEventListener('click', () => { void loadPlugins(); void loadEmail(); void loadEmailAccount(); });
  $('plugins-open-harness').addEventListener('click', openHost);
  $('email-open-harness').addEventListener('click', openHost);
  $('email-refresh').addEventListener('click', () => { void loadEmail(); void loadEmailAccount(); });
  $('email-enabled').addEventListener('change', () => void toggleEmail());
  $('email-account-edit').addEventListener('click', openEmailAccountEditor);
  $('email-review').addEventListener('click', () => void reviewEmail());
  $('email-review-days').addEventListener('change', () => {
    const current = $('email-review-prompt').value.trim();
    if ([...emailReviewRanges.keys()].some(days => current === defaultEmailReviewPrompt(days))) {
      $('email-review-prompt').value = defaultEmailReviewPrompt(Number($('email-review-days').value));
    }
    feedback('email-review-feedback');
    updateControls();
  });
  $('email-review-prompt').addEventListener('input', () => { feedback('email-review-feedback'); updateControls(); });
  $('email-account-form').addEventListener('submit', saveEmailAccount);
  $('email-account-cancel').addEventListener('click', () => void editEmailAccount());
  $('email-account-reload').addEventListener('click', () => void editEmailAccount(true));
  for (const id of ['email-account-user', 'email-account-password', 'email-account-receive', 'email-account-send']) $(id).addEventListener('input', () => {
    feedback('email-account-feedback');
    updateControls();
  });
  $('email-restart').addEventListener('click', () => {
    if (restartBlocked()) { renderEmail(); return; }
    switchSettingsTab('maintenance', true);
    void restartHost();
  });
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-form').addEventListener('submit', saveSettings);
  $('settings-dialog').addEventListener('cancel', (event) => { event.preventDefault(); if (inlineConfirm) settleConfirm(false); else void closeSettings(); });
  $('settings-dialog').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && inlineConfirm) { event.preventDefault(); event.stopPropagation(); settleConfirm(false); }
  }, true);
  $('settings-action-cancel').addEventListener('click', () => settleConfirm(false));
  $('settings-action-accept').addEventListener('click', () => settleConfirm(true));
  $('settings-dialog').addEventListener('close', () => {
    if ($('settings-dialog').open) return;
    window.clearTimeout(settingsPollTimer);
    discardEmailAccountDraft();
    emailAccountEditing = false;
    ++emailReviewSequence;
    ++emailAccountReadSequence;
    emailAccountReading = false;
    updateControls();
    if (activeRun?.source === 'email-review') $('chat-scroll').focus({ preventScroll: true });
    else if (settingsReturnFocus?.isConnected && !$('confirm-dialog').open) settingsReturnFocus.focus({ preventScroll: true });
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

  $('routine-form').addEventListener('submit', saveRoutine);
  $('routine-fields').addEventListener('input', () => { routineDraftDirty = true; updateRoutineControls(); });
  $('routine-type').addEventListener('change', syncRoutineSchedule);
  $('routine-new').addEventListener('click', () => void editRoutine());
  $('routine-cancel-edit').addEventListener('click', () => void editRoutine('', true));
  $('routine-rebase').addEventListener('click', () => void rebaseRoutineDraft());
  $('routine-recheck').addEventListener('click', async () => {
    if (offline) { await bootstrap(); return; }
    if (await readRoutineState(true)) {
      routineUncertain = false;
      feedback('routine-feedback', '已刷新任务与历史；不取消编辑，不覆盖名称或正文草稿，也不会重发上次请求。');
      renderRoutines();
    }
  });
  window.setInterval(() => {
    if (document.hidden || !state.routines) return;
    if (currentTab === 'routine' || routineAwaiting.size || state.routineRuns.some((run) => run.status === 'running') || state.routines.jobs.some((job) => job.lastRun?.status === 'running')) void readRoutineState();
  }, 5000);

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
  $('reflections-more').addEventListener('click', () => void showMoreReflections());
  $('reflection-settings-open').addEventListener('click', () => openSettings('automation'));
  $('reflection-run').addEventListener('click', () => void runReflection());
  $('settings-reflection-run').addEventListener('click', () => void runReflection());
  $('settings-reflection-status-open').addEventListener('click', () => {
    $('settings-reflection-details').open = true;
    $('settings-reflection-details').scrollIntoView({ block: 'nearest' });
  });
  $('settings-reflection-refresh').addEventListener('click', async () => { await pollSettings(); scheduleSettingsPoll(); });
  $('reflections-refresh').addEventListener('click', () => void refreshStatus(true, 'reflection-run-feedback'));
  window.setInterval(() => {
    if (!document.hidden && (reflectionReceipt?.waiting || state.maintenance.reflection?.running === true)) void refreshStatus();
  }, 3000);
  $('profiles-refresh').addEventListener('click', () => void refreshStatus(true));
  $('open-folder').addEventListener('click', () => void mutate('open-folder', '/api/open-folder', {}, 'folder-feedback', '已请求本机打开数据文件夹。', { refresh: false }));
  $('logs-refresh').addEventListener('click', () => void loadLogs());
  $('open-logs').addEventListener('click', () => void mutate('open-logs', '/api/open-logs', {}, 'logs-feedback', '已请求本机打开日志文件夹。', { refresh: false }));
  $('background-toggle').addEventListener('click', toggleBackground);
  window.addEventListener('beforeunload', (event) => {
    if (activeRun?.source !== 'email-review' && !emailReviewPreparing && !routineDraftDirty && !routineDraftBlocked && !routineBusy && !routineUncertain && !hasUnsavedDrafts() && !emailBusy && !settingsSaving && !settingsReceipt?.uncertain && !restartInFlight && ![...profileDrafts.values(), ...reflectionDrafts.values()].some((draft) => draft.saving || draft.awaiting)) return;
    event.preventDefault();
    event.returnValue = '';
  });
  // 仅刷新状态；定时任务和后台安装绝不由页面自动触发。
  window.setInterval(() => void refreshStatus(), 30000);
  buildProfileEditors();
  renderAll();
  void bootstrap();
})();
