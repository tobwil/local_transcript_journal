import { initWorkshopRecorder } from './recorder.js';

const state = {
  entries: [],
  selectedId: null,
  filter: 'all',
  query: '',
  config: {},
  sync: {},
  integrations: {},
  microsoft: { profile: null }
};

const AUTH_CONFIG_KEY = 'meeting-journal.microsoft.config';
const AUTH_TOKEN_KEY = 'meeting-journal.microsoft.tokens';
const AUTH_REQUEST_KEY = 'meeting-journal.microsoft.oauth-request';
const GRAPH_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'User.Read',
  'Calendars.Read',
  'OnlineMeetings.Read',
  'OnlineMeetingTranscript.Read.All'
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const formatDate = (value, style = 'medium') => new Intl.DateTimeFormat('de-DE', style === 'full'
  ? { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }
  : { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Fehler ${response.status}`);
  return payload;
}

function readLocalJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function randomValue(byteLength = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function pkceChallenge(verifier) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

function redirectUri() {
  return `${location.origin}${location.pathname}`;
}

function microsoftConfig() {
  return readLocalJson(AUTH_CONFIG_KEY);
}

function microsoftTokens() {
  return readLocalJson(AUTH_TOKEN_KEY);
}

function isMicrosoftConnected() {
  return Boolean(microsoftTokens()?.accessToken);
}

function storeTokens(payload, previous = {}) {
  const tokens = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || previous.refreshToken || '',
    expiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 3600)) * 1000,
    profile: previous.profile || null
  };
  localStorage.setItem(AUTH_TOKEN_KEY, JSON.stringify(tokens));
  return tokens;
}

async function tokenRequest(config, parameters) {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, ...parameters })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.error || 'Microsoft-Anmeldung fehlgeschlagen.');
  return payload;
}

async function loadMicrosoftProfile(accessToken) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error('Microsoft-Profil konnte nicht geladen werden.');
  const profile = await response.json();
  const tokens = microsoftTokens();
  if (tokens) localStorage.setItem(AUTH_TOKEN_KEY, JSON.stringify({ ...tokens, profile }));
  state.microsoft.profile = profile;
  return profile;
}

async function getAccessToken() {
  const config = microsoftConfig();
  const tokens = microsoftTokens();
  if (!config || !tokens) throw new Error('Bitte zuerst mit Microsoft anmelden.');
  if (tokens.expiresAt > Date.now() + 120000) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error('Die Microsoft-Sitzung ist abgelaufen. Bitte erneut anmelden.');
  const refreshed = await tokenRequest(config, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    redirect_uri: redirectUri(),
    scope: GRAPH_SCOPES.join(' ')
  });
  return storeTokens(refreshed, tokens).accessToken;
}

async function beginMicrosoftLogin(config) {
  const verifier = randomValue(64);
  const oauthState = randomValue(24);
  localStorage.setItem(AUTH_CONFIG_KEY, JSON.stringify(config));
  localStorage.setItem(AUTH_REQUEST_KEY, JSON.stringify({ verifier, oauthState, createdAt: Date.now() }));
  const authorize = new URL(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/authorize`);
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri());
  authorize.searchParams.set('response_mode', 'query');
  authorize.searchParams.set('scope', GRAPH_SCOPES.join(' '));
  authorize.searchParams.set('state', oauthState);
  authorize.searchParams.set('code_challenge', await pkceChallenge(verifier));
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('prompt', 'select_account');
  location.assign(authorize.toString());
}

async function handleMicrosoftCallback() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return false;
  const request = readLocalJson(AUTH_REQUEST_KEY);
  const config = microsoftConfig();
  history.replaceState({}, '', redirectUri());
  if (params.has('error')) throw new Error(params.get('error_description') || params.get('error'));
  if (!request || !config || request.oauthState !== params.get('state')) throw new Error('Microsoft-Anmeldung konnte nicht sicher bestätigt werden. Bitte erneut versuchen.');
  if (Date.now() - request.createdAt > 15 * 60000) throw new Error('Die Microsoft-Anmeldung ist abgelaufen. Bitte erneut versuchen.');
  const payload = await tokenRequest(config, {
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: redirectUri(),
    code_verifier: request.verifier,
    scope: GRAPH_SCOPES.join(' ')
  });
  localStorage.removeItem(AUTH_REQUEST_KEY);
  const tokens = storeTokens(payload);
  await loadMicrosoftProfile(tokens.accessToken);
  return true;
}

function populateTeamsSettings() {
  const config = microsoftConfig() || { clientId: '', tenantId: 'organizations' };
  const form = $('#loginForm');
  form.elements.clientId.value = config.clientId || '';
  form.elements.tenantId.value = config.tenantId || 'organizations';
  $('#redirectUriField').value = redirectUri();
  $('#loginError').textContent = '';
  const connected = isMicrosoftConnected();
  $('#teamsConnectedCard').classList.toggle('hidden', !connected);
  $('#settingsTeamsSignOutButton').classList.toggle('hidden', !connected);
  $('#settingsTeamsSyncButton').classList.toggle('hidden', !connected);
  $('#microsoftLoginSubmitButton').classList.toggle('hidden', connected);
  $('#teamsConnectedName').textContent = state.microsoft.profile?.displayName || 'Microsoft verbunden';
}

function signOutMicrosoft() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  state.microsoft.profile = null;
  state.sync.lastError = null;
  renderAll();
  toast('Microsoft-Konto getrennt.');
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 3400);
}

function sourceLabel(source) {
  return source === 'teams' ? 'Microsoft Teams'
    : source === 'onedrive' ? 'OneDrive-Ordner'
      : source === 'workshop' ? 'Workshop-Aufnahme'
        : source === 'upload' ? 'Datei-Import' : 'Manuell';
}

function filteredEntries() {
  return state.entries.filter((entry) => {
    const sourceMatches = state.filter === 'all'
      || (state.filter === 'manual' && ['manual', 'upload'].includes(entry.source))
      || entry.source === state.filter;
    const haystack = `${entry.title} ${entry.summary} ${(entry.participants || []).join(' ')} ${(entry.todos || []).map((t) => t.text).join(' ')}`.toLowerCase();
    return sourceMatches && haystack.includes(state.query.toLowerCase());
  });
}

function renderStats() {
  const openTodos = state.entries.flatMap((entry) => entry.todos || []).filter((todo) => !todo.done).length;
  $('#openTodoCount').textContent = openTodos;
  $('.stat-label').textContent = openTodos === 1 ? 'offene Aufgabe' : 'offene Aufgaben';
  $('#meetingCount').textContent = state.entries.length === 1 ? '1 Gespräch im Journal' : `${state.entries.length} Gespräche im Journal`;
  $('#entryCount').textContent = `${state.entries.length} ${state.entries.length === 1 ? 'Eintrag' : 'Einträge'}`;
  const status = $('#syncStatus');
  const oneDrive = state.integrations?.oneDrive;
  const tokens = microsoftTokens();
  state.microsoft.profile = tokens?.profile || state.microsoft.profile;
  if (tokens && state.sync.lastError) {
    status.className = 'sync-status error';
    status.querySelector('span').textContent = 'Sync-Fehler';
  } else if (tokens) {
    status.className = 'sync-status connected';
    status.querySelector('span').textContent = state.microsoft.profile?.displayName || 'Microsoft verbunden';
  } else if (oneDrive?.enabled && oneDrive.lastError) {
    status.className = 'sync-status error';
    status.querySelector('span').textContent = 'Ordner-Fehler';
  } else if (oneDrive?.enabled) {
    status.className = 'sync-status connected';
    status.querySelector('span').textContent = 'OneDrive aktiv';
  } else if (state.config.openai) {
    status.className = 'sync-status connected';
    status.querySelector('span').textContent = 'OpenAI aktiv';
  } else {
    status.className = 'sync-status';
    status.querySelector('span').textContent = 'Nur lokal';
  }
  populateTeamsSettings();
}

function renderList() {
  const entries = filteredEntries();
  const list = $('#entryList');
  if (!entries.length) {
    list.innerHTML = '<div class="empty-state" style="min-height:220px;padding:25px"><p>Keine passenden Einträge.</p></div>';
    return;
  }
  list.innerHTML = entries.map((entry) => {
    const open = (entry.todos || []).filter((todo) => !todo.done).length;
    return `<button class="entry-card ${entry.id === state.selectedId ? 'active' : ''}" data-entry-id="${entry.id}">
      <div class="card-meta"><span class="source-chip ${entry.source}">${sourceLabel(entry.source)}</span><span>${formatDate(entry.occurredAt)}</span></div>
      <h3>${escapeHtml(entry.title)}</h3>
      <p>${escapeHtml(entry.summary || 'Noch keine Zusammenfassung.')}</p>
      ${open ? `<div class="todo-mini">○ ${open} ${open === 1 ? 'offene Aufgabe' : 'offene Aufgaben'}</div>` : ''}
    </button>`;
  }).join('');
  $$('[data-entry-id]', list).forEach((button) => button.addEventListener('click', () => selectEntry(button.dataset.entryId)));
}

async function selectEntry(id) {
  state.selectedId = id;
  renderList();
  $('#emptyState').classList.add('hidden');
  const detail = $('#entryDetail');
  detail.classList.remove('hidden');
  detail.innerHTML = '<p class="none-note">Eintrag wird geladen …</p>';
  try {
    const entry = await api(`/api/entries/${id}`);
    if (state.selectedId !== id) return;
    renderDetail(entry);
  } catch (error) {
    toast(error.message, true);
  }
}

function renderDetail(entry) {
  const todos = (entry.todos || []).map((todo) => `<label class="todo-item">
    <input class="todo-check" type="checkbox" ${todo.done ? 'checked' : ''} data-todo-id="${todo.id}" />
    <span><span class="todo-text">${escapeHtml(todo.text)}</span>${todo.owner || todo.due ? `<span class="todo-meta">${escapeHtml([todo.owner, todo.due].filter(Boolean).join(' · '))}</span>` : ''}</span>
  </label>`).join('');
  const decisions = (entry.decisions || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const participants = (entry.participants || []).map((name) => `<span class="participant">${escapeHtml(name)}</span>`).join('');
  const topics = (entry.topics || []).map((topic) => `<span class="topic">${escapeHtml(topic)}</span>`).join('');
  const duration = entry.recording?.durationMs
    ? new Date(entry.recording.durationMs).toISOString().slice(11, 19)
    : '';
  const workshopMeta = entry.source === 'workshop' ? `<div class="workshop-meta">
    ${duration ? `<span>◷ ${duration} Aufnahme</span>` : ''}
    ${entry.recording?.captureMode?.microphone ? '<span>⌁ Mikrofon</span>' : ''}
    ${entry.recording?.captureMode?.system ? '<span>◉ Systemaudio</span>' : ''}
    ${entry.recording?.sourceName ? `<span>▣ ${escapeHtml(entry.recording.sourceName)}</span>` : ''}
  </div>` : '';
  const screenshots = (entry.screenshots || []).map((item) => {
    const stamp = new Date(item.offsetMs || 0).toISOString().slice(11, 19);
    return `<a class="screenshot-card" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
      <img src="${escapeHtml(item.url)}" alt="Screenshot aus ${escapeHtml(item.windowName)} bei ${stamp}" loading="lazy" />
      <span><b>${escapeHtml(item.windowName)}</b><time>${stamp}</time></span>
    </a>`;
  }).join('');
  $('#entryDetail').innerHTML = `
    <div class="detail-top">
      <div><div class="detail-date">${formatDate(entry.occurredAt, 'full')} · ${sourceLabel(entry.source)}</div><h2>${escapeHtml(entry.title)}</h2><div class="participants">${participants || '<span>Keine Teilnehmenden erkannt</span>'}</div>${workshopMeta}</div>
    </div>
    <div class="detail-grid">
      <div>
        <div class="section-label">Kurzfassung</div>
        <p class="summary-text">${escapeHtml(entry.summary)}</p>
        ${topics ? `<div class="topics">${topics}</div>` : ''}
        <p class="provider-note">Zusammengefasst mit ${entry.summaryProvider === 'openai' ? 'OpenAI' : 'lokaler Analyse'}${entry.summaryError ? ' · KI nicht erreichbar, lokaler Ersatz verwendet' : ''}</p>
        ${decisions ? `<div class="decisions-card"><div class="section-label">Entscheidungen</div><ul class="decision-list">${decisions}</ul></div>` : ''}
        ${entry.notes ? `<div class="notes-card"><div class="section-label">Eigene Notiz</div><p>${escapeHtml(entry.notes)}</p></div>` : ''}
      </div>
      <aside class="todo-box"><div class="section-label">Nächste Schritte</div>${todos || '<p class="none-note">Keine konkreten Aufgaben erkannt.</p>'}</aside>
    </div>
    ${screenshots ? `<section class="screenshot-section"><div class="section-label">Workshop-Screenshots · ${entry.screenshots.length}</div><div class="screenshot-gallery">${screenshots}</div></section>` : ''}
    <details class="transcript-block"><summary>Original-Transkript anzeigen</summary><div class="transcript-content">${escapeHtml(entry.transcript)}</div></details>
    <div class="detail-actions">
      <button class="button button-ghost" data-resummarize>Neu zusammenfassen</button>
      <button class="button button-ghost danger" data-delete>Löschen</button>
    </div>`;
  $$('[data-todo-id]').forEach((input) => input.addEventListener('change', async () => {
    try {
      const changed = await api(`/api/entries/${entry.id}/todos/${input.dataset.todoId}`, { method: 'PATCH' });
      const summaryEntry = state.entries.find((item) => item.id === entry.id);
      const target = summaryEntry?.todos?.find((todo) => todo.id === changed.id);
      if (target) target.done = changed.done;
      renderStats();
      renderList();
    } catch (error) { input.checked = !input.checked; toast(error.message, true); }
  }));
  $('[data-resummarize]').addEventListener('click', () => resummarize(entry.id));
  $('[data-delete]').addEventListener('click', () => deleteEntry(entry));
}

async function resummarize(id) {
  const button = $('[data-resummarize]');
  button.disabled = true;
  button.textContent = 'Analysiere …';
  try {
    const entry = await api(`/api/entries/${id}/summarize`, { method: 'POST' });
    const index = state.entries.findIndex((item) => item.id === id);
    state.entries[index] = { ...state.entries[index], ...entry, transcript: undefined };
    renderStats(); renderList(); renderDetail(entry);
    toast('Zusammenfassung aktualisiert.');
  } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = 'Neu zusammenfassen'; }
}

async function deleteEntry(entry) {
  const detail = entry.source === 'workshop'
    ? ' Dabei werden auch die lokale Audioaufnahme, das Transkript und alle Screenshots gelöscht.'
    : '';
  if (!confirm(`„${entry.title}“ wirklich aus dem lokalen Journal löschen?${detail}`)) return;
  try {
    await api(`/api/entries/${entry.id}`, { method: 'DELETE' });
    state.entries = state.entries.filter((item) => item.id !== entry.id);
    state.selectedId = null;
    $('#entryDetail').classList.add('hidden');
    $('#emptyState').classList.remove('hidden');
    renderAll();
    toast('Eintrag gelöscht.');
  } catch (error) { toast(error.message, true); }
}

function renderAll() { renderStats(); renderList(); }

async function load() {
  const payload = await api('/api/state');
  Object.assign(state, payload);
  renderAll();
  if (state.entries.length) selectEntry(state.entries[0].id);
}

function openDialog() {
  const form = $('#entryForm');
  form.reset();
  form.elements.occurredAt.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0,16);
  $('#formError').textContent = '';
  $('#fileName').textContent = '';
  $('#entryDialog').showModal();
}

async function populateOneDriveSettings() {
  const form = $('#oneDriveForm');
  const config = state.integrations?.oneDrive || {};
  form.elements.folderPath.value = config.folderPath || '';
  $('#selectedFolderPath').textContent = config.folderPath || 'Noch kein Ordner ausgewählt';
  form.elements.enabled.checked = config.folderPath ? Boolean(config.enabled) : true;
  $('#oneDriveError').textContent = '';
  $('#oneDriveStatusText').textContent = config.lastScanAt
    ? `Zuletzt geprüft: ${new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(config.lastScanAt))}${config.importedCount ? ` · ${config.importedCount} importiert` : ''}`
    : 'Noch nicht geprüft.';
  try {
    const detection = await api('/api/onedrive/detect');
    if (!form.elements.folderPath.value && detection.candidates.length) {
      form.elements.folderPath.value = detection.candidates[0];
      $('#selectedFolderPath').textContent = detection.candidates[0];
      $('#oneDriveStatusText').textContent = 'Ein lokaler OneDrive-Ordner wurde automatisch erkannt.';
    } else if (!detection.candidates.length && !config.folderPath) {
      $('#oneDriveStatusText').textContent = 'Noch kein OneDrive-Ordner erkannt. Bitte über „Ordner auswählen …“ festlegen.';
    }
  } catch (error) {
    $('#oneDriveError').textContent = error.message;
  }
}

function switchSettingsTab(tabName) {
  $$('.settings-tab').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tabName));
  $$('[data-settings-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.settingsPanel !== tabName));
}

async function populateOpenAISettings() {
  const settings = await api('/api/settings');
  const form = $('#openAISettingsForm');
  form.elements.apiKey.value = '';
  form.elements.removeKey.checked = false;
  form.elements.model.value = settings.openai.model;
  $('#openAIKeyHint').textContent = settings.openai.configured
    ? `API-Key gespeichert: ${settings.openai.keyHint}`
    : 'Kein API-Key gespeichert – lokale Analyse ist aktiv.';
  $('#removeApiKeyRow').classList.toggle('hidden', !settings.openai.configured);
  $('#testOpenAIButton').disabled = !settings.openai.configured;
  $('#openAIError').textContent = '';
}

async function openSettings(tabName = 'openai') {
  switchSettingsTab(tabName);
  if (!$('#settingsDialog').open) $('#settingsDialog').showModal();
  populateTeamsSettings();
  await Promise.allSettled([populateOpenAISettings(), populateOneDriveSettings()]);
}

$('#newEntryButton').addEventListener('click', openDialog);
$('#settingsButton').addEventListener('click', () => openSettings());
$$('.settings-tab').forEach((button) => button.addEventListener('click', () => switchSettingsTab(button.dataset.settingsTab)));
$$('[data-open-modal]').forEach((button) => button.addEventListener('click', openDialog));
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => {
  document.getElementById(button.dataset.closeDialog)?.close();
}));
$('#searchInput').addEventListener('input', (event) => { state.query = event.target.value; renderList(); });
$$('.filter').forEach((button) => button.addEventListener('click', () => {
  $$('.filter').forEach((item) => item.classList.remove('active'));
  button.classList.add('active'); state.filter = button.dataset.filter; renderList();
}));

let inputMode = 'paste';
$$('.tab').forEach((button) => button.addEventListener('click', () => {
  inputMode = button.dataset.mode;
  $$('.tab').forEach((item) => item.classList.toggle('active', item === button));
  $('#pastePane').classList.toggle('hidden', inputMode !== 'paste');
  $('#uploadPane').classList.toggle('hidden', inputMode !== 'upload');
}));
$('#fileInput').addEventListener('change', (event) => { $('#fileName').textContent = event.target.files[0]?.name || ''; });

$('#chooseFolderButton').addEventListener('click', async () => {
  const button = $('#chooseFolderButton');
  const form = $('#oneDriveForm');
  $('#oneDriveError').textContent = '';
  button.disabled = true;
  button.textContent = 'Auswahl läuft …';
  try {
    const selection = await api('/api/onedrive/select-folder', { method: 'POST' });
    if (selection.cancelled) {
      $('#oneDriveStatusText').textContent = 'Ordnerauswahl abgebrochen.';
      return;
    }
    form.elements.folderPath.value = selection.folderPath;
    $('#selectedFolderPath').textContent = selection.folderPath;
    $('#oneDriveStatusText').textContent = 'Ordner ausgewählt. Mit „Speichern & überwachen“ wird die Überwachung aktiviert.';
  } catch (error) {
    $('#oneDriveError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Ordner auswählen …';
  }
});

$('#oneDriveForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#saveOneDriveButton');
  $('#oneDriveError').textContent = '';
  button.disabled = true;
  button.textContent = 'Ordner wird geprüft …';
  try {
    const result = await api('/api/onedrive/config', {
      method: 'POST',
      body: JSON.stringify({
        folderPath: form.elements.folderPath.value.trim(),
        enabled: form.elements.enabled.checked
      })
    });
    await load();
    await populateOneDriveSettings();
    toast(result.imported || result.updated
      ? `${result.imported} neue und ${result.updated} geänderte Transkripte übernommen.`
      : 'Ordnerüberwachung gespeichert. Keine neuen Transkripte gefunden.');
  } catch (error) {
    $('#oneDriveError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Speichern & überwachen';
  }
});

async function scanOneDrive(button, { fromMain = false } = {}) {
  $('#oneDriveError').textContent = '';
  if (!state.integrations?.oneDrive?.enabled) {
    await openSettings('onedrive');
    $('#oneDriveError').textContent = 'Bitte zuerst einen Ordner auswählen und die Überwachung aktivieren.';
    return;
  }
  button.disabled = true;
  const originalContent = button.innerHTML;
  if (fromMain) button.querySelector('.main-scan-label').textContent = 'Prüfe …';
  else button.textContent = 'Prüfe …';
  try {
    const result = await api('/api/onedrive/scan', { method: 'POST' });
    await load();
    $('#oneDriveStatusText').textContent = `${result.found} passende Dateien geprüft · ${result.imported} neu · ${result.updated} aktualisiert`;
    toast(result.imported || result.updated
      ? `${result.imported} neue und ${result.updated} geänderte Transkripte übernommen.`
      : `Ordner geprüft: ${result.found} passende Dateien, keine Änderungen.`);
  } catch (error) {
    if ($('#settingsDialog').open) $('#oneDriveError').textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalContent;
  }
}

$('#scanFolderButton').addEventListener('click', () => scanOneDrive($('#scanFolderButton')));
$('#mainScanButton').addEventListener('click', () => scanOneDrive($('#mainScanButton'), { fromMain: true }));

$('#openAISettingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#saveOpenAIButton');
  $('#openAIError').textContent = '';
  button.disabled = true;
  button.textContent = 'Speichere …';
  try {
    const result = await api('/api/settings/openai', {
      method: 'POST',
      body: JSON.stringify({
        apiKey: form.elements.apiKey.value.trim(),
        model: form.elements.model.value,
        removeKey: form.elements.removeKey.checked
      })
    });
    await load();
    await populateOpenAISettings();
    toast(result.configured ? 'OpenAI ist für neue Zusammenfassungen aktiviert.' : 'OpenAI-Key entfernt. Lokale Analyse ist aktiv.');
  } catch (error) {
    $('#openAIError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'KI-Einstellungen speichern';
  }
});

$('#testOpenAIButton').addEventListener('click', async () => {
  const button = $('#testOpenAIButton');
  $('#openAIError').textContent = '';
  button.disabled = true;
  button.textContent = 'Teste …';
  try {
    const result = await api('/api/settings/openai/test', { method: 'POST' });
    toast(`OpenAI-Verbindung erfolgreich · ${result.model}`);
  } catch (error) {
    $('#openAIError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Verbindung testen';
  }
});

$('#toggleApiKeyButton').addEventListener('click', () => {
  const input = $('#openAISettingsForm').elements.apiKey;
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#toggleApiKeyButton').textContent = input.type === 'password' ? '◉' : '◌';
});

$('#entryForm').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') {
    event.preventDefault();
    $('#entryDialog').close();
    return;
  }
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#saveEntryButton');
  $('#formError').textContent = '';
  try {
    let transcript = form.elements.transcript.value;
    let source = 'manual';
    if (inputMode === 'upload') {
      const file = $('#fileInput').files[0];
      if (!file) throw new Error('Bitte wähle eine Datei aus.');
      if (file.size > 12 * 1024 * 1024) throw new Error('Die Datei ist größer als 12 MB.');
      transcript = await file.text();
      source = 'upload';
    }
    if (!transcript.trim()) throw new Error('Bitte füge ein Transkript ein.');
    button.disabled = true; button.textContent = 'Analysiere …';
    const entry = await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({
        title: form.elements.title.value,
        occurredAt: form.elements.occurredAt.value,
        participants: form.elements.participants.value.split(',').map((item) => item.trim()).filter(Boolean),
        notes: form.elements.notes.value,
        transcript,
        source
      })
    });
    state.entries.unshift({ ...entry, transcript: undefined });
    $('#entryDialog').close();
    renderAll(); selectEntry(entry.id);
    toast('Eintrag gespeichert und analysiert.');
  } catch (error) {
    $('#formError').textContent = error.message;
  } finally {
    button.disabled = false; button.textContent = 'Analysieren & speichern';
  }
});

async function performTeamsSync({ silent = false } = {}) {
  if (!isMicrosoftConnected()) {
    await openSettings('teams');
    return;
  }
  const button = $('#settingsTeamsSyncButton');
  button.disabled = true; button.textContent = 'Synchronisiere …';
  try {
    const accessToken = await getAccessToken();
    const result = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ accessToken })
    });
    await load();
    if (!silent || result.imported) {
      const warning = result.warnings?.length ? ` ${result.warnings.length} Meeting(s) konnten nicht gelesen werden.` : '';
      toast(result.imported ? `${result.imported} neue Transkripte importiert.${warning}` : `Alles ist auf dem neuesten Stand.${warning}`);
    }
  } catch (error) {
    if (/abgelaufen|erneut anmelden|401|invalid_grant/i.test(error.message)) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      state.microsoft.profile = null;
      renderAll();
    }
    if (!silent) toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Jetzt abgleichen';
    renderStats();
  }
}

$('#settingsTeamsSyncButton').addEventListener('click', () => performTeamsSync());

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const clientId = form.elements.clientId.value.trim();
  const tenantId = form.elements.tenantId.value.trim();
  $('#loginError').textContent = '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    $('#loginError').textContent = 'Bitte eine gültige Application (Client) ID eintragen.';
    return;
  }
  if (!/^[a-z0-9.-]+$/i.test(tenantId)) {
    $('#loginError').textContent = 'Bitte „organizations“ oder eine gültige Tenant-ID eintragen.';
    return;
  }
  try { await beginMicrosoftLogin({ clientId, tenantId }); }
  catch (error) { $('#loginError').textContent = error.message; }
});

$('#settingsTeamsSignOutButton').addEventListener('click', () => {
  const name = state.microsoft.profile?.displayName || 'Microsoft';
  if (confirm(`${name} ist verbunden. Microsoft-Konto von diesem Journal trennen?`)) {
    signOutMicrosoft();
    populateTeamsSettings();
  }
});

$('#todayLabel').textContent = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: 'long' }).format(new Date());

async function bootstrap() {
  let signedInNow = false;
  try { signedInNow = await handleMicrosoftCallback(); }
  catch (error) { toast(error.message, true); }
  await load();
  const tokens = microsoftTokens();
  if (tokens?.accessToken && !tokens.profile) {
    try { await loadMicrosoftProfile(await getAccessToken()); renderStats(); }
    catch { localStorage.removeItem(AUTH_TOKEN_KEY); renderStats(); }
  }
  if (signedInNow) {
    toast('Microsoft-Konto verbunden. Teams-Meetings werden abgeglichen.');
    setTimeout(() => performTeamsSync({ silent: true }), 600);
  } else if (isMicrosoftConnected()) {
    setTimeout(() => performTeamsSync({ silent: true }), 1200);
  }
}

setInterval(() => {
  if (isMicrosoftConnected() && document.visibilityState === 'visible') performTeamsSync({ silent: true });
}, 15 * 60000);

window.addEventListener('workshop-complete', async (event) => {
  await load();
  if (event.detail?.entry?.id) await selectEntry(event.detail.entry.id);
  toast('Workshop wurde transkribiert und als Recap gespeichert.');
});
window.addEventListener('workshop-error', (event) => toast(event.detail || 'Workshop-Aufnahme fehlgeschlagen.', true));
initWorkshopRecorder();

bootstrap().catch((error) => toast(error.message, true));
