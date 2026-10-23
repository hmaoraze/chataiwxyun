const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  status: null,
  config: null,
  required: null,
  security: null,
  chat: { userId: '', sessionId: '', busy: false },
};

const KIND_LABEL = {
  fact: '事实',
  preference: '偏好',
  goal: '目标',
  constraint: '约束',
  event: '事件',
};

const REQUIRED_ORDER = [
  'deepseekApiKey',
  'systemPrompt',
  'storage',
  'serviceToken',
  'wechatBotToken',
  'wechatBaseUrl',
  'wechatIlinkIds',
];

/* ---------------- 基础工具 ---------------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cookie(name) {
  const prefix = `${name}=`;
  for (const part of (document.cookie || '').split(';')) {
    const item = part.trim();
    if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
  }
  return '';
}

function fmtTime(value) {
  if (!value) return '—';
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function b64uBytes(value) {
  const text = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64uEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const csrf = cookie('cb_csrf');
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(
      payload?.error?.message || `请求失败（HTTP ${response.status}）`
    );
    error.code = payload?.error?.code || 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

let toastTimer = 0;
function toast(message, kind = '') {
  const element = $('toast');
  element.textContent = message;
  element.className = `toast${kind ? ` is-${kind}` : ''}`;
  element.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.add('hidden'), 3600);
}

function show(viewId) {
  for (const view of $$('.view')) view.classList.add('hidden');
  $(viewId).classList.remove('hidden');
}

function setBusy(button, busy, text) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = text || '处理中…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function setNotice(element, message, kind = '') {
  if (!element) return;
  if (!message) {
    element.classList.add('hidden');
    element.textContent = '';
    return;
  }
  element.textContent = message;
  element.className = `notice${kind ? ` notice-${kind}` : ''}`;
  element.classList.remove('hidden');
}

/* ---------------- 配置表单 ---------------- */

function setPath(object, path, value) {
  let current = object;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!current[path[i]] || typeof current[path[i]] !== 'object') current[path[i]] = {};
    current = current[path[i]];
  }
  current[path[path.length - 1]] = value;
}

function getPath(object, path) {
  return path.reduce((current, key) => (current == null ? undefined : current[key]), object);
}

function readForm(form) {
  const out = {};
  for (const element of $$('[data-path]', form)) {
    const path = element.dataset.path.split('.');
    let value;
    if (element.type === 'checkbox') {
      value = element.checked;
    } else if (element.type === 'number') {
      if (element.value === '') continue;
      value = Number(element.value);
    } else {
      value = element.value;
    }
    setPath(out, path, value);
  }
  return out;
}

function writeForm(form, config) {
  for (const element of $$('[data-path]', form)) {
    const value = getPath(config, element.dataset.path.split('.'));
    if (element.type === 'checkbox') {
      element.checked = Boolean(value);
    } else {
      element.value = value === undefined || value === null ? '' : value;
    }
  }
}

function applyConfig(config, required) {
  state.config = config;
  if (required) state.required = required;
  for (const form of $$('form.form')) writeForm(form, config);

  const secrets = config.secretStatus || {};
  for (const hint of $$('[data-hint]')) {
    const path = hint.dataset.hint;
    const status = secrets[path];
    if (status?.has) {
      hint.textContent = `已保存：${status.hint}（留空保持不变）`;
      hint.classList.add('is-ok');
    } else {
      hint.textContent = '尚未配置';
      hint.classList.remove('is-ok');
    }
  }
  if (required) applyRequired(required);
}

function applyRequired(required) {
  const list = $('required-list');
  if (list) {
    list.innerHTML = REQUIRED_ORDER.map((key) => {
      const done = Boolean(required.items[key]);
      return `<li><span class="dot ${done ? 'ok' : 'bad'}">${done ? '✓' : '!'}</span>
        <span>${escapeHtml(required.labels[key] || key)}</span>
        <span class="tag ${done ? 'ok' : 'bad'}">${done ? '已完成' : '必填'}</span></li>`;
    }).join('');
  }
  const missing = required.missing || [];
  const banner = $('required-banner');
  if (banner) {
    if (missing.length) {
      banner.innerHTML = `<span>还有 ${missing.length} 项必填配置未完成：${escapeHtml(
        missing.map((key) => required.labels[key] || key).join('、')
      )}</span><button class="btn btn-primary" data-tab-link="required" type="button">去配置</button>`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }
  const progress = $('required-progress');
  if (progress) {
    const done = REQUIRED_ORDER.filter((key) => required.items[key]).length;
    progress.textContent = `${done}/${REQUIRED_ORDER.length} 已完成`;
    progress.className = `badge${required.complete ? ' is-ok' : ''}`;
  }
}

async function saveForm(form) {
  const button = form.querySelector('button[type="submit"]');
  const saveState = form.querySelector('.save-state');
  const body = { config: readForm(form) };
  const clears = $$('[data-clear]:checked', form).map((item) => item.dataset.clear);
  if (clears.length) body.clearSecrets = clears;
  if (form.dataset.rotate === '1') body.rotate_service_token = true;

  setBusy(button, true, '保存中…');
  if (saveState) saveState.textContent = '正在保存并校验存储…';
  try {
    const result = await api('/api/admin/config', { method: 'PUT', body });
    form.dataset.rotate = '';
    for (const item of $$('[data-clear]', form)) item.checked = false;
    applyConfig(result.config, result.required);
    if (result.service_token_once) {
      const box = $('token-once');
      box.innerHTML = `<span class="secret-label">新的服务访问令牌（仅显示一次，请立即保存）</span>
        <code id="token-once-value">${escapeHtml(result.service_token_once)}</code>
        <div class="row" style="margin-top:8px">
          <button class="btn btn-ghost" data-copy="token-once-value" type="button">复制令牌</button>
        </div>`;
      box.classList.remove('hidden');
    }
    if (saveState) saveState.textContent = '已保存';
    toast('配置已保存', 'ok');
    loadOverview().catch(() => {});
  } catch (error) {
    if (saveState) saveState.textContent = '';
    toast(error.message, 'danger');
  } finally {
    setBusy(button, false);
  }
}

/* ---------------- Passkey ---------------- */

function webauthnSupported() {
  return Boolean(window.PublicKeyCredential && navigator.credentials);
}

function serializeCredential(credential) {
  const response = credential.response || {};
  const out = {
    id: credential.id,
    type: credential.type,
    response: {},
  };
  if (response.clientDataJSON) out.response.clientDataJSON = b64uEncode(response.clientDataJSON);
  if (response.attestationObject) {
    out.response.attestationObject = b64uEncode(response.attestationObject);
  }
  if (response.authenticatorData) {
    out.response.authenticatorData = b64uEncode(response.authenticatorData);
  }
  if (response.signature) out.response.signature = b64uEncode(response.signature);
  if (response.userHandle) out.response.userHandle = b64uEncode(response.userHandle);
  if (typeof response.getTransports === 'function') {
    try {
      out.response.transports = response.getTransports();
    } catch {
      out.response.transports = [];
    }
  }
  return out;
}

async function createCredential(publicKey) {
  const options = {
    ...publicKey,
    challenge: b64uBytes(publicKey.challenge),
    user: { ...publicKey.user, id: b64uBytes(publicKey.user.id) },
    excludeCredentials: (publicKey.excludeCredentials || []).map((item) => ({
      ...item,
      id: b64uBytes(item.id),
    })),
  };
  return navigator.credentials.create({ publicKey: options });
}

async function getAssertion(publicKey) {
  const options = {
    ...publicKey,
    challenge: b64uBytes(publicKey.challenge),
    allowCredentials: (publicKey.allowCredentials || []).map((item) => ({
      ...item,
      id: b64uBytes(item.id),
    })),
  };
  return navigator.credentials.get({ publicKey: options });
}

function webauthnError(error) {
  if (!error) return '认证失败';
  if (error.name === 'NotAllowedError') return '操作已取消，或安全密钥验证未通过';
  if (error.name === 'SecurityError') return '当前页面不满足安全上下文要求（需 HTTPS 或 localhost）';
  if (error.name === 'InvalidStateError') return '该安全密钥已注册，请换一个设备或密钥';
  return error.message || '认证失败';
}

async function login() {
  const button = $('btn-login');
  const notice = $('auth-notice');
  if (!webauthnSupported()) {
    setNotice(notice, '当前浏览器不支持 WebAuthn，请使用较新的 Chrome、Edge 或 Safari。', 'danger');
    return;
  }
  setBusy(button, true, '等待验证…');
  setNotice(notice, '');
  try {
    const begin = await api('/api/admin/auth', {
      method: 'POST',
      body: { action: 'login_begin' },
    });
    const credential = await getAssertion(begin.public_key);
    await api('/api/admin/auth', {
      method: 'POST',
      body: { action: 'login_finish', credential: serializeCredential(credential) },
    });
    await enterApp();
  } catch (error) {
    setNotice(notice, webauthnError(error), 'danger');
  } finally {
    setBusy(button, false);
  }
}

function setupLog(message) {
  const list = $('setup-log');
  const item = document.createElement('li');
  item.textContent = message;
  list.appendChild(item);
}

async function startSetup(token) {
  show('view-setup');
  $('setup-log').innerHTML = '';
  $('setup-error').classList.add('hidden');
  $('btn-setup-register').disabled = true;
  setupLog('正在校验安全链接…');
  try {
    const result = await api('/api/admin/auth', {
      method: 'POST',
      body: { action: 'bootstrap_verify', token },
    });
    setupLog(`链接有效，即将在 ${result.origin} 注册安全密钥`);
    $('btn-setup-register').disabled = false;
    $('btn-setup-register').dataset.token = token;
  } catch (error) {
    setupLog('校验失败');
    setNotice($('setup-error'), error.message, 'danger');
  }
}

async function finishSetup() {
  const button = $('btn-setup-register');
  const notice = $('setup-error');
  const label = $('setup-label').value.trim() || '主安全密钥';
  if (!webauthnSupported()) {
    setNotice(notice, '当前浏览器不支持 WebAuthn，无法注册安全密钥。', 'danger');
    return;
  }
  setBusy(button, true, '等待注册…');
  setNotice(notice, '');
  try {
    setupLog('请在弹出的系统窗口中完成指纹、面容或安全密钥验证');
    const begin = await api('/api/admin/auth', {
      method: 'POST',
      body: { action: 'register_begin', label },
    });
    const credential = await createCredential(begin.public_key);
    setupLog('已获取凭证，正在提交校验…');
    await api('/api/admin/auth', {
      method: 'POST',
      body: { action: 'register_finish', credential: serializeCredential(credential), label },
    });
    setupLog('注册成功，安全链接已失效');
    window.history.replaceState({}, '', '/');
    await enterApp();
  } catch (error) {
    setNotice(notice, webauthnError(error), 'danger');
    setupLog('注册未完成');
  } finally {
    setBusy(button, false);
  }
}

async function addPasskey() {
  const label = $('passkey-label').value.trim() || '备用安全密钥';
  if (!webauthnSupported()) {
    toast('当前浏览器不支持 WebAuthn', 'danger');
    return;
  }
  try {
    const begin = await api('/api/admin/auth', {
      method: 'POST',
      body: { action: 'register_begin', label },
    });
    const credential = await createCredential(begin.public_key);
    await api('/api/admin/auth', {
      method: 'POST',
      body: { action: 'register_finish', credential: serializeCredential(credential), label },
    });
    $('passkey-label').value = '';
    toast('安全密钥已添加', 'ok');
    await loadSecurity();
  } catch (error) {
    toast(webauthnError(error), 'danger');
  }
}

/* ---------------- 应用主流程 ---------------- */

async function enterApp() {
  state.status = await api('/api/admin/status');
  if (!state.status.authenticated) {
    show('view-auth');
    return;
  }
  show('view-app');
  $('btn-logout').classList.remove('hidden');
  $('status-pill').textContent = '已登录';
  $('status-pill').className = 'pill is-ok';

  const [configResult] = await Promise.all([
    api('/api/admin/config'),
    loadOverview().catch(() => {}),
  ]);
  applyConfig(configResult.config, configResult.required);
  renderMeta();
  if (!state.chat.userId) state.chat.userId = 'demo-user';
  $('chat-user').value = state.chat.userId;
  activateTab(location.hash ? location.hash.slice(1) : 'overview');
}

function renderMeta() {
  const meta = $('sidebar-meta');
  if (!meta || !state.config) return;
  const config = state.config;
  meta.innerHTML = `存储：${escapeHtml(config.storage.driver)} · 前缀 ${escapeHtml(
    config.storage.keyPrefix
  )}<br />模型：${escapeHtml(config.deepseek.model)}`;
}

function activateTab(name) {
  const target = $(`panel-${name}`) ? name : 'overview';
  for (const tab of $$('.tab')) tab.classList.toggle('is-active', tab.dataset.tab === target);
  for (const panel of $$('.panel')) panel.classList.add('hidden');
  $(`panel-${target}`).classList.remove('hidden');
  window.history.replaceState({}, '', `#${target}`);

  if (target === 'overview') loadOverview().catch((error) => toast(error.message, 'danger'));
  if (target === 'security') loadSecurity().catch((error) => toast(error.message, 'danger'));
  if (target === 'memories' && state.chat.userId) {
    $('memory-user').value = $('memory-user').value || state.chat.userId;
    loadMemories().catch(() => {});
  }
  if (target === 'sessions') loadSessions().catch((error) => toast(error.message, 'danger'));
}

async function loadOverview() {
  const data = await api('/api/admin/overview');
  const cards = [
    { label: '活跃会话', value: data.sessions.active, sub: `总数 ${data.sessions.total} · 24h 新增 ${data.sessions.last_24h}` },
    { label: '已结束会话', value: data.sessions.ended, sub: `待超时清理 ${data.sessions.expired_pending}` },
    { label: '记忆条目', value: data.memories.total, sub: `单用户上限 ${data.memories.limit_per_user}` },
    { label: '有活跃会话的用户', value: data.users.active_sessions, sub: `累计对话轮次 ${data.sessions.turns}` },
  ];
  $('overview-cards').innerHTML = cards
    .map(
      (card) => `<div class="stat"><div class="label">${escapeHtml(card.label)}</div>
        <div class="value">${escapeHtml(card.value)}</div>
        <div class="sub">${escapeHtml(card.sub)}</div></div>`
    )
    .join('');

  const rows = [
    ['存储模式', `${data.storage.mode}（驱动 ${data.storage.driver}）${data.storage.available ? '' : ' · 不可用'}`],
    ['业务键前缀', data.storage.binding || '—'],
    ['配置存储', `${data.config_store.mode}${data.config_store.available ? '' : ' · 不可用'}`],
    ['主密钥来源', data.master_key_source],
    ['最后活跃', fmtTime(data.sessions.latest_updated_at)],
    ['版本', data.version],
  ];
  $('overview-meta').innerHTML = rows
    .map(
      ([key, value]) =>
        `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`
    )
    .join('');

  applyRequired(data.required);
  state.required = data.required;
}

function renderTestResults(items) {
  const list = $('test-results');
  list.innerHTML = items
    .map((item) => {
      const ok = item.ok === true;
      const detail = ok
        ? `${item.latencyMs !== undefined ? `${item.latencyMs}ms` : ''} ${item.message || item.sample || ''}`.trim()
        : item.error || '失败';
      return `<li><div class="item-main"><div class="item-title">${
        item.target === 'storage' ? '存储' : item.target === 'deepseek' ? 'DeepSeek' : '微信 iLink'
      } <span class="tag ${ok ? 'ok' : 'bad'}">${ok ? '正常' : '异常'}</span></div>
        <div class="item-sub">${escapeHtml(detail || '—')}</div></div></li>`;
    })
    .join('');
}

async function testAll() {
  const button = $$('[data-action="test-all"]')[0];
  setBusy(button, true, '测试中…');
  try {
    const result = await api('/api/admin/test', { method: 'POST', body: { target: 'all' } });
    renderTestResults(result.results || []);
    toast(result.all_ok ? '全部连通正常' : '存在异常项，请查看结果', result.all_ok ? 'ok' : 'danger');
  } catch (error) {
    toast(error.message, 'danger');
  } finally {
    setBusy(button, false);
  }
}

/* ---------------- 安全密钥 ---------------- */

async function loadSecurity() {
  const data = await api('/api/admin/security');
  state.security = data;
  $('security-meta').textContent = `RP ID：${data.rp_id} · 来源：${data.public_origin} · 已注册 ${data.passkeys.length}/${data.passkey_limit}`;

  const passkeys = $('passkey-list');
  passkeys.innerHTML = data.passkeys.length
    ? data.passkeys
        .map(
          (item) => `<li><div class="item-main">
            <div class="item-title">${escapeHtml(item.label)} <span class="tag">${
              item.algorithm === -7 ? 'ES256' : 'RS256'
            }</span></div>
            <div class="item-sub">创建 ${fmtTime(item.created_at)} · 最近使用 ${fmtTime(
              item.last_used_at
            )} · 计数器 ${item.counter}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-danger" data-action="delete-passkey" data-id="${escapeHtml(
              item.id
            )}" type="button">删除</button>
          </div></li>`
        )
        .join('')
    : '<li class="empty">尚未注册安全密钥</li>';

  const links = $('link-list');
  links.innerHTML = data.setup_links.length
    ? data.setup_links
        .map(
          (item) => `<li><div class="item-main">
            <div class="item-title">${escapeHtml(item.label)} <span class="tag warn">一次性</span></div>
            <div class="item-sub">${escapeHtml(item.short_id)} · 创建 ${fmtTime(
              item.created_at
            )} · 过期 ${fmtTime(item.expires_at)}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-danger" data-action="revoke-link" data-id="${escapeHtml(
              item.token_id
            )}" type="button">撤销</button>
          </div></li>`
        )
        .join('')
    : '<li class="empty">当前没有有效的配置链接</li>';
}

async function createSetupLink() {
  const button = $$('[data-action="create-link"]')[0];
  setBusy(button, true, '生成中…');
  try {
    const data = await api('/api/admin/security', {
      method: 'POST',
      body: {
        action: 'create_setup_link',
        label: $('link-label').value.trim() || '配置链接',
        ttl_minutes: Number($('link-ttl').value) || 30,
      },
    });
    const box = $('link-result');
    box.innerHTML = `<span class="secret-label">一次性安全链接（仅显示一次）</span>
      <code id="link-once-value">${escapeHtml(data.url)}</code>
      <div class="row" style="margin-top:8px">
        <button class="btn btn-ghost" data-copy="link-once-value" type="button">复制链接</button>
      </div>
      <p class="small muted" style="margin-top:8px">${escapeHtml(data.note || '')}</p>`;
    box.classList.remove('hidden');
    await loadSecurity();
    toast('安全链接已生成', 'ok');
  } catch (error) {
    toast(error.message, 'danger');
  } finally {
    setBusy(button, false);
  }
}

/* ---------------- 记忆库 ---------------- */

async function loadMemories() {
  const userId = $('memory-user').value.trim();
  if (!userId) {
    toast('请填写 user_id', 'danger');
    return;
  }
  const query = $('memory-query').value.trim();
  const data = await api(
    `/api/memory?user_id=${encodeURIComponent(userId)}&q=${encodeURIComponent(query)}&limit=100`
  );
  const list = $('memory-list');
  list.innerHTML = data.memories.length
    ? data.memories
        .map(
          (memory) => `<li><div class="item-main">
            <div class="item-title">${escapeHtml(memory.content)}</div>
            <div class="item-sub"><span class="tag">${escapeHtml(
              KIND_LABEL[memory.kind] || memory.kind
            )}</span> 重要度 ${memory.importance} · 命中 ${memory.hits} · 评分 ${memory.score} · 更新 ${fmtTime(
              memory.updatedAt
            )}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-danger" data-action="delete-memory" data-id="${escapeHtml(
              memory.id
            )}" type="button">删除</button>
          </div></li>`
        )
        .join('')
    : '<li class="empty">该用户暂无记忆</li>';
  toast(`共 ${data.total} 条记忆`);
}

async function addMemory() {
  const userId = $('memory-user').value.trim();
  const content = $('memory-content').value.trim();
  if (!userId || !content) {
    toast('请填写 user_id 与记忆内容', 'danger');
    return;
  }
  try {
    const result = await api('/api/memory', {
      method: 'POST',
      body: {
        user_id: userId,
        content,
        kind: $('memory-kind').value,
        importance: Number($('memory-importance').value) || 3,
      },
    });
    $('memory-content').value = '';
    toast(result.action === 'merged' ? '已合并到相似记忆' : '记忆已保存', 'ok');
    await loadMemories();
  } catch (error) {
    toast(error.message, 'danger');
  }
}

/* ---------------- 会话 ---------------- */

function sessionTag(status) {
  if (status === 'active') return '<span class="tag ok">活跃</span>';
  if (status === 'ended') return '<span class="tag">已结束</span>';
  return '<span class="tag warn">已超时</span>';
}

async function loadSessions() {
  const userId = $('session-user').value.trim();
  const body = { action: 'list', limit: 50 };
  if (userId) body.user_id = userId;
  const data = await api('/api/session', { method: 'POST', body });
  const list = $('session-list');
  list.innerHTML = data.sessions.length
    ? data.sessions
        .map(
          (session) => `<li><div class="item-main">
            <div class="item-title">${sessionTag(session.status)} ${escapeHtml(
              session.title || session.session_id
            )}</div>
            <div class="item-sub">${escapeHtml(session.session_id)} · 用户 ${escapeHtml(
              session.user_id
            )} · ${session.turn_count} 轮 · 更新 ${fmtTime(session.updated_at)}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-ghost" data-action="view-session" data-id="${escapeHtml(
              session.session_id
            )}" type="button">查看</button>
          </div></li>`
        )
        .join('')
    : '<li class="empty">没有符合条件的会话</li>';
}

async function viewSession(sessionId) {
  const detail = $('session-detail');
  detail.innerHTML = '<p class="muted">加载中…</p>';
  detail.classList.remove('hidden');
  try {
    const data = await api('/api/session', {
      method: 'POST',
      body: { action: 'get', session_id: sessionId },
    });
    const messages = data.messages
      .map(
        (message) => `<div class="message ${escapeHtml(message.role)}">
          <span class="who">${
            message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : escapeHtml(message.role)
          } · ${fmtTime(message.created_at)}</span>
          <span class="body">${escapeHtml(message.content)}</span>
        </div>`
      )
      .join('');
    detail.innerHTML = `<h3>${escapeHtml(data.session.session_id)}</h3>
      <p class="muted small">记忆摘要：${
        data.session.memory_count
      } 条 · 会话结束原因：${escapeHtml(data.session.end_reason || '进行中')}</p>
      ${messages || '<p class="muted">暂无消息</p>'}`;
  } catch (error) {
    detail.innerHTML = `<p class="notice notice-danger">${escapeHtml(error.message)}</p>`;
  }
}

/* ---------------- 对话测试 ---------------- */

function chatBubble(role, text, meta = '') {
  const log = $('chat-log');
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  if (meta) {
    const span = document.createElement('span');
    span.className = 'meta';
    span.textContent = meta;
    bubble.appendChild(span);
  }
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

async function sendChat(event) {
  event.preventDefault();
  if (state.chat.busy) return;
  const input = $('chat-input');
  const content = input.value.trim();
  const userId = $('chat-user').value.trim();
  if (!content) return;
  if (!userId) {
    toast('请填写 user_id', 'danger');
    return;
  }
  state.chat.userId = userId;
  state.chat.busy = true;
  input.value = '';
  chatBubble('user', content);
  const placeholder = chatBubble('assistant', '思考中…');

  const payload = {
    action: 'message',
    user_id: userId,
    content,
  };
  if (state.chat.sessionId) payload.session_id = state.chat.sessionId;

  try {
    if ($('chat-stream').checked && supportsStream()) {
      payload.stream = true;
      let text = '';
      await streamChat(payload, (event2, data) => {
        if (event2 === 'delta') {
          text += data.content || '';
          placeholder.textContent = text;
          $('chat-log').scrollTop = $('chat-log').scrollHeight;
        }
        if (event2 === 'done') {
          state.chat.sessionId = data.session_id || state.chat.sessionId;
          $('chat-session').textContent = state.chat.sessionId
            ? `会话 ${state.chat.sessionId.slice(0, 10)}…`
            : '未开始';
          if (!text) placeholder.textContent = data.reply || '（无回复）';
          const meta = `${data.memories_saved || 0} 条记忆 · ${
            data.usage?.total_tokens ? `${data.usage.total_tokens} tokens` : 'usage 未返回'
          }`;
          const span = document.createElement('span');
          span.className = 'meta';
          span.textContent = meta;
          placeholder.appendChild(span);
        }
        if (event2 === 'error') {
          throw new Error(data.message || '生成失败');
        }
      });
    } else {
      const data = await api('/api/session', { method: 'POST', body: payload });
      state.chat.sessionId = data.session_id;
      $('chat-session').textContent = `会话 ${data.session_id.slice(0, 10)}…`;
      placeholder.textContent = data.reply || '（无回复）';
      const span = document.createElement('span');
      span.className = 'meta';
      span.textContent = `${data.memories_saved || 0} 条记忆${
        data.usage?.total_tokens ? ` · ${data.usage.total_tokens} tokens` : ''
      }`;
      placeholder.appendChild(span);
    }
    if (!state.chat.sessionId) {
      state.chat.sessionId = '';
    }
  } catch (error) {
    placeholder.remove();
    chatBubble('system', error.message, '');
  } finally {
    state.chat.busy = false;
  }
}

function supportsStream() {
  return typeof ReadableStream !== 'undefined' && Boolean(window.fetch);
}

async function streamChat(payload, onEvent) {
  const headers = { 'Content-Type': 'application/json' };
  const csrf = cookie('cb_csrf');
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const response = await fetch('/api/session', {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !type.includes('text/event-stream')) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) {
        let data = {};
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          data = { raw: dataLines.join('\n') };
        }
        try {
          onEvent(event, data);
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
}

async function endChat() {
  const userId = $('chat-user').value.trim();
  if (!state.chat.sessionId) {
    toast('当前没有进行中的会话');
    return;
  }
  try {
    const data = await api('/api/session', {
      method: 'POST',
      body: { action: 'end', user_id: userId, session_id: state.chat.sessionId },
    });
    chatBubble(
      'system',
      `会话已结束，提炼记忆 ${data.memories_saved || 0} 条（状态 ${data.session.status}）`
    );
    state.chat.sessionId = '';
    $('chat-session').textContent = '未开始';
  } catch (error) {
    toast(error.message, 'danger');
  }
}

function newChat() {
  state.chat.sessionId = '';
  $('chat-session').textContent = '未开始';
  $('chat-log').innerHTML = '';
  chatBubble('system', '已开启新对话，历史记忆将在首轮请求时注入');
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('btn-login').addEventListener('click', login);
  $('btn-setup-register').addEventListener('click', finishSetup);
  $('btn-logout').addEventListener('click', async () => {
    await api('/api/admin/auth', { method: 'POST', body: { action: 'logout' } }).catch(() => {});
    window.location.replace('/');
  });

  document.addEventListener('click', async (event) => {
    const tab = event.target.closest('.tab');
    if (tab) {
      activateTab(tab.dataset.tab);
      return;
    }
    const tabLink = event.target.closest('[data-tab-link]');
    if (tabLink) {
      activateTab(tabLink.dataset.tabLink);
      return;
    }
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
      const source = $(copyButton.dataset.copy);
      if (source) {
        const text = source.textContent || '';
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制到剪贴板', 'ok');
        } catch {
          toast('复制失败，请手动选择文本', 'danger');
        }
      }
      return;
    }

    const action = event.target.closest('[data-action]');
    if (!action) return;
    const name = action.dataset.action;

    if (name === 'rotate-token') {
      const form = action.closest('form');
      form.dataset.rotate = '1';
      const input = form.querySelector('[data-path="api.serviceToken"]');
      if (input) input.value = '';
      const saveState = form.querySelector('.save-state');
      if (saveState) saveState.textContent = '保存后将生成新令牌并立即生效';
      return;
    }
    if (name === 'refresh-overview') loadOverview().catch((e) => toast(e.message, 'danger'));
    if (name === 'test-all') testAll();
    if (name === 'refresh-security') loadSecurity().catch((e) => toast(e.message, 'danger'));
    if (name === 'add-passkey') addPasskey();
    if (name === 'create-link') createSetupLink();
    if (name === 'load-memories') loadMemories().catch((e) => toast(e.message, 'danger'));
    if (name === 'add-memory') addMemory();
    if (name === 'load-sessions') loadSessions().catch((e) => toast(e.message, 'danger'));
    if (name === 'chat-new') newChat();
    if (name === 'chat-end') endChat();
    if (name === 'test-wechat') {
      setNotice($('wechat-test'), '正在测试…');
      api('/api/admin/test', { method: 'POST', body: { target: 'wechat' } })
        .then((data) => {
          setNotice(
            $('wechat-test'),
            data.ok ? data.message || '微信接口正常' : data.error || '微信接口异常',
            data.ok ? 'ok' : 'danger'
          );
        })
        .catch((error) => setNotice($('wechat-test'), error.message, 'danger'));
    }
    if (name === 'delete-passkey') {
      if (!window.confirm('确认删除该安全密钥？')) return;
      api('/api/admin/security', {
        method: 'POST',
        body: { action: 'delete_passkey', id: action.dataset.id },
      })
        .then(() => {
          toast('安全密钥已删除', 'ok');
          loadSecurity().catch(() => {});
        })
        .catch((error) => toast(error.message, 'danger'));
    }
    if (name === 'revoke-link') {
      api('/api/admin/security', {
        method: 'POST',
        body: { action: 'revoke_setup_link', token_id: action.dataset.id },
      })
        .then(() => {
          toast('配置链接已撤销', 'ok');
          loadSecurity().catch(() => {});
        })
        .catch((error) => toast(error.message, 'danger'));
    }
    if (name === 'delete-memory') {
      const userId = $('memory-user').value.trim();
      if (!userId) return;
      api(`/api/memory?user_id=${encodeURIComponent(userId)}&id=${encodeURIComponent(action.dataset.id)}`, {
        method: 'DELETE',
      })
        .then(() => {
          toast('记忆已删除', 'ok');
          loadMemories().catch(() => {});
        })
        .catch((error) => toast(error.message, 'danger'));
    }
    if (name === 'view-session') viewSession(action.dataset.id);
  });

  for (const form of $$('form.form')) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveForm(form);
    });
  }

  $('chat-form').addEventListener('submit', sendChat);
  $('chat-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('chat-form').requestSubmit();
    }
  });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  bindEvents();
  try {
    const status = await api('/api/admin/status');
    state.status = status;
    $('status-pill').textContent = status.authenticated ? '已登录' : '未登录';
    $('status-pill').className = `pill ${status.authenticated ? 'is-ok' : ''}`;

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      await startSetup(token);
      return;
    }

    if (status.authenticated) {
      await enterApp();
      return;
    }

    show('view-auth');
    if (!status.initialized) {
      setNotice(
        $('auth-notice'),
        '该系统尚未初始化。请使用环境变量 BOOTSTRAP_TOKEN 生成的安全链接访问 /setup?token=… 完成首次配置。'
      );
    }
  } catch (error) {
    show('view-auth');
    setNotice($('auth-notice'), `无法连接服务：${error.message}`, 'danger');
  }
}

boot();
