const $ = id => document.getElementById(id);
const ui = {
  history: $('messages'), welcome: $('welcome'), input: $('message-input'), form: $('chat-form'),
  send: $('send-button'), thinking: $('thinking'), thinkMain: $('thinking-main'), thinkSub: $('thinking-sub'),
  toast: $('toasts'), settingsModal: $('settings-modal'), trace: $('trace')
};
let settings = null;
let status = null;
let busy = false;
let messages = [];

async function api(url, payload) {
  const response = await fetch(url, payload === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Aegis-Local': '1' },
    body: JSON.stringify(payload), cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function richText(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
function friendlyTime(raw) {
  try { return new Date(raw || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
function formatDuration(value) {
  if (!Number.isFinite(value)) return '';
  return value > 999 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function addMessage(message) {
  ui.welcome.classList.add('hidden');
  const isUser = message.role === 'user';
  const el = document.createElement('article');
  el.className = `message ${isUser ? 'user' : 'assistant'}`;
  const tag = message.action ? escapeHtml(message.action.replace(/_/g, ' ').toUpperCase()) : (isUser ? 'COMMAND' : 'RESPONSE');
  el.innerHTML = `<div class="message-avatar">${isUser ? 'U' : 'Λ'}</div><div class="message-body"><div class="message-meta"><strong>${isUser ? 'You' : 'Aegis'}</strong><span class="message-mode">${tag}</span><span class="message-timestamp">${friendlyTime(message.at)}</span></div><div class="message-content">${richText(message.content)}</div>${message.elapsedMs ? `<div class="message-trace"><span><svg><use href="#i-check"/></svg> ${formatDuration(message.elapsedMs)} total</span><span>${escapeHtml(message.model || 'local')}</span>${message.probability != null ? `<span>Kev choice ${Math.round(message.probability * 100)}%</span>` : ''}</div>` : ''}</div>`;
  ui.history.append(el);
  scrollToBottom();
}
function scrollToBottom() {
  const conversation = $('conversation');
  requestAnimationFrame(() => conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' }));
}
function toast(text, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = text;
  ui.toast.append(el);
  setTimeout(() => el.remove(), 5500);
}
function setBusy(flag, label) {
  busy = flag;
  ui.send.disabled = flag;
  ui.input.disabled = flag;
  ui.thinking.classList.toggle('hidden', !flag);
  ui.thinkMain.textContent = label || 'Kev is deciding...';
  ui.thinkSub.textContent = flag ? 'Routing locally through Ollama' : '';
  if (flag) scrollToBottom();
  else ui.input.focus();
}
async function sendCommand(text) {
  if (busy || !text.trim()) return;
  const command = text.trim();
  ui.input.value = '';
  ui.input.style.height = 'auto';
  addMessage({ role: 'user', content: command, at: new Date().toISOString() });
  setBusy(true);
  const hold = setTimeout(() => {
    ui.thinkMain.textContent = 'Working through the model handoff...';
    ui.thinkSub.textContent = 'Longer requests may need to load the text model';
  }, 4200);
  try {
    const response = await api('/api/chat', { message: command });
    messages.push({ role: 'user', content: command });
    messages.push({ role: 'assistant', content: response.response });
    addMessage({ role: 'assistant', content: response.response, action: response.action, model: response.model, elapsedMs: response.elapsedMs, probability: response.classification?.probability, at: new Date().toISOString() });
    updateTrace(response);
    if (response.warning) toast(`Kev warning: ${response.warning}`, true);
    await refreshStatus();
  } catch (err) {
    addMessage({ role: 'assistant', action: 'error', content: `**Could not complete:** ${err.message}\n\nOpen Configuration to check your model tags, and confirm Ollama is running.`, at: new Date().toISOString() });
    toast(err.message, true);
    await refreshStatus();
  } finally {
    clearTimeout(hold);
    setBusy(false);
  }
}

function updateTrace(result) {
  const steps = result.steps || [];
  if (!steps.length) return;
  ui.trace.innerHTML = '';
  for (const step of steps.slice(-8)) {
    const node = document.createElement('div');
    node.className = `trace-item ${step.state === 'warning' ? 'warning' : ''}`;
    node.innerHTML = `<strong>${escapeHtml(step.label)}</strong><span>${friendlyTime(step.at)}</span>`;
    ui.trace.append(node);
  }
}

function updateStatus(data) {
  status = data;
  const chip = $('connection-chip');
  chip.classList.toggle('offline', !data.connected);
  $('connection-label').textContent = data.connected ? 'OLLAMA ONLINE' : 'OLLAMA OFFLINE';
  if (!settings) return;
  $('kev-name').textContent = settings.kevModel;
  $('llm-name').textContent = settings.llmModel;
  const loaded = new Set((data.loaded || []).map(m => m.name));
  const installed = new Set(data.installed || []);
  function card(prefix, name) {
    const isLoaded = loaded.has(name);
    const isInstalled = installed.has(name);
    const element = $(`${prefix}-card`);
    element.classList.toggle('active', isLoaded);
    $(`${prefix}-tag`).textContent = isLoaded ? 'IN MEMORY' : !data.connected ? 'OFFLINE' : isInstalled ? 'STANDBY' : 'NOT FOUND';
    $(`${prefix}-loaded`).textContent = isLoaded ? 'ACTIVE' : isInstalled ? 'READY' : 'MISSING';
    $(`${prefix}-bar`).style.width = isLoaded ? '100%' : '0%';
  }
  card('kev', settings.kevModel);
  card('llm', settings.llmModel);
  $('memory-label').textContent = settings.autoUnload
    ? `Exclusive switching ON · Reload Kev ${settings.autoReloadKev ? 'ON' : 'OFF'}`
    : 'Auto unload OFF · Both models may remain loaded';
  if (data.installed?.length) {
    $('available-models').innerHTML = '';
    for (const name of data.installed) {
      const option = document.createElement('option');
      option.value = name;
      $('available-models').append(option);
    }
  }
}
async function refreshStatus() {
  try { updateStatus(await api('/api/status')); }
  catch { updateStatus({ connected: false, loaded: [], installed: [] }); }
}
function fillSettings() {
  if (!settings) return;
  $('kev-model').value = settings.kevModel;
  $('llm-model').value = settings.llmModel;
  $('ollama-url').value = settings.ollamaUrl;
  $('auto-unload').checked = settings.autoUnload;
  $('auto-reload').checked = settings.autoReloadKev;
  $('context-tokens').value = settings.contextTokens;
  $('threshold').value = settings.confidenceThreshold;
  $('notes-folder').value = settings.notesFolder;
  $('search-roots').value = settings.searchRoots.join('\n');
}
function openSettings() {
  fillSettings();
  ui.settingsModal.classList.remove('hidden');
  $('llm-model').focus();
}
function closeSettings() { ui.settingsModal.classList.add('hidden'); ui.input.focus(); }

ui.form.addEventListener('submit', event => { event.preventDefault(); sendCommand(ui.input.value); });
ui.input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); sendCommand(ui.input.value);
  }
});
ui.input.addEventListener('input', () => { ui.input.style.height = 'auto'; ui.input.style.height = Math.min(ui.input.scrollHeight, 150) + 'px'; });
for (const item of document.querySelectorAll('[data-prompt]')) item.addEventListener('click', () => sendCommand(item.dataset.prompt));
for (const id of ['nav-settings', 'mobile-settings']) $(id).addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
$('cancel-settings').addEventListener('click', closeSettings);
ui.settingsModal.addEventListener('click', event => { if (event.target === ui.settingsModal) closeSettings(); });
$('nav-chat').addEventListener('click', () => ui.input.focus());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !ui.settingsModal.classList.contains('hidden')) closeSettings();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); ui.input.focus(); }
  if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); openSettings(); }
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = {
    kevModel: $('kev-model').value.trim(), llmModel: $('llm-model').value.trim(),
    ollamaUrl: $('ollama-url').value.trim(), autoUnload: $('auto-unload').checked,
    autoReloadKev: $('auto-reload').checked,
    contextTokens: Number($('context-tokens').value), confidenceThreshold: Number($('threshold').value),
    notesFolder: $('notes-folder').value.trim(),
    searchRoots: $('search-roots').value.split('\n').map(x => x.trim()).filter(Boolean)
  };
  $('save-settings').disabled = true;
  try {
    const response = await api('/api/settings', payload);
    settings = response.settings;
    closeSettings();
    toast('Configuration saved locally.');
    await refreshStatus();
  } catch (e) { toast(e.message, true); }
  finally { $('save-settings').disabled = false; }
});
$('refresh-button').addEventListener('click', async () => { await refreshStatus(); toast('Runtime status refreshed.'); });
$('warm-button').addEventListener('click', async () => {
  if (busy) return;
  $('warm-button').disabled = true;
  try { await api('/api/warm', {}); toast('Kev is loaded and ready.'); await refreshStatus(); }
  catch (e) { toast(e.message, true); }
  finally { $('warm-button').disabled = false; }
});
$('clear-button').addEventListener('click', async () => {
  if (busy || !window.confirm('Clear the saved conversation history? Notes on disk will not be deleted.')) return;
  try {
    await api('/api/clear', {});
    ui.history.innerHTML = '';
    ui.welcome.classList.remove('hidden');
    ui.trace.innerHTML = '<div class="trace-empty">The execution trace will appear here after your first command.</div>';
    messages = [];
    toast('Conversation history cleared.');
  } catch (e) { toast(e.message, true); }
});

async function boot() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 30000);
  try {
    const bootstrap = await api('/api/bootstrap');
    settings = bootstrap.settings;
    messages = bootstrap.history;
    for (const m of messages) addMessage(m);
    fillSettings();
    await refreshStatus();
    if (!status?.connected) toast('Ollama is offline. Start it, then press Refresh.', true);
    else if (!status.installed.includes(settings.kevModel)) toast(`Kev not installed. Run: ollama pull ${settings.kevModel}`, true);
    ui.input.focus();
  } catch (e) { toast(`Startup error: ${e.message}`, true); }
  setInterval(() => { if (!busy && document.visibilityState === 'visible') refreshStatus(); }, 8000);
}
boot();
