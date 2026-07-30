import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureStore, publicEntry, readState, updateState } from './lib/store.js';
import { extractParticipants, summarize } from './lib/summarize.js';
import { syncTeamsWithUserToken } from './lib/teams.js';
import { chooseLocalFolder } from './lib/folder-dialog.js';
import {
  detectOneDriveFolders,
  scanTranscriptFolder,
  startFolderWatcher,
  stopFolderWatcher,
  supportedTranscriptExtensions,
  validateFolder
} from './lib/folder-watch.js';
import {
  applyPersistedSettings,
  publicOpenAISettings,
  testOpenAIConnection,
  updateOpenAISettings
} from './lib/settings.js';
import {
  deleteWorkshopSession,
  updateWorkshopTitle,
  workshopAssetPath
} from './lib/workshop-store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

async function loadEnv() {
  try {
    const raw = await readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || match[2].startsWith('#')) continue;
      const value = match[2].replace(/^['"]|['"]$/g, '');
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw Object.assign(new Error('Upload ist größer als 12 MB.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Ungültige JSON-Daten.'), { status: 400 });
  }
}

function safePath(urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  return resolved.startsWith(PUBLIC_DIR) ? resolved : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

async function serveStatic(req, res, pathname) {
  const file = safePath(pathname);
  if (!file) return false;
  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function createEntry(payload) {
  const transcript = String(payload.transcript || '').trim();
  if (!transcript) throw Object.assign(new Error('Bitte füge ein Transkript ein.'), { status: 400 });
  const analysis = await summarize(transcript);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    externalId: null,
    source: payload.source === 'upload' ? 'upload' : 'manual',
    title: String(payload.title || '').trim() || 'Neuer Journal-Eintrag',
    occurredAt: payload.occurredAt ? new Date(payload.occurredAt).toISOString() : now,
    createdAt: now,
    updatedAt: now,
    participants: Array.isArray(payload.participants) && payload.participants.length
      ? payload.participants.map(String)
      : extractParticipants(transcript),
    notes: String(payload.notes || ''),
    transcript,
    ...analysis
  };
}

async function runSync(accessToken) {
  let result;
  try {
    await updateState((state) => {
      state.sync.lastAttemptAt = new Date().toISOString();
      state.sync.lastError = null;
      return state;
    });
    const state = await readState();
    result = await syncTeamsWithUserToken(state, accessToken);
    await updateState(() => {
      result.state.sync.lastSuccessAt = new Date().toISOString();
      result.state.sync.lastError = null;
      result.state.sync.importedCount = (result.state.sync.importedCount || 0) + result.imported;
      return result.state;
    });
    return { imported: result.imported, found: result.found, meetings: result.meetings, warnings: result.warnings };
  } catch (error) {
    await updateState((state) => {
      state.sync.lastError = error.message;
      return state;
    });
    throw error;
  }
}

let folderScanPromise = null;

async function runFolderScan() {
  if (folderScanPromise) return folderScanPromise;
  folderScanPromise = (async () => {
    let result;
    try {
      await updateState(async (state) => {
        const config = state.integrations.oneDrive;
        if (!config.enabled || !config.folderPath) throw Object.assign(new Error('Die OneDrive-Ordnerüberwachung ist nicht aktiviert.'), { status: 400 });
        result = await scanTranscriptFolder(state, config.folderPath);
        config.folderPath = result.root;
        config.lastScanAt = new Date().toISOString();
        config.lastError = null;
        config.importedCount = (config.importedCount || 0) + result.imported;
        return state;
      });
      return {
        imported: result.imported,
        updated: result.updated,
        found: result.found,
        warnings: result.warnings
      };
    } catch (error) {
      await updateState((state) => {
        state.integrations.oneDrive.lastError = error.message;
        state.integrations.oneDrive.lastScanAt = new Date().toISOString();
        return state;
      });
      throw error;
    } finally {
      folderScanPromise = null;
    }
  })();
  return folderScanPromise;
}

async function activateFolderWatcher() {
  stopFolderWatcher();
  const state = await readState();
  const config = state.integrations.oneDrive;
  if (!config.enabled || !config.folderPath) return;
  try {
    const folderPath = await validateFolder(config.folderPath);
    startFolderWatcher(folderPath, runFolderScan);
  } catch (error) {
    await updateState((next) => {
      next.integrations.oneDrive.lastError = error.message;
      return next;
    });
  }
}

async function api(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/state') {
    const state = await readState();
    return json(res, 200, {
      entries: state.entries.map((entry) => publicEntry(entry)),
      sync: state.sync,
      integrations: state.integrations,
      config: {
        teamsLogin: true,
        openai: Boolean(process.env.OPENAI_API_KEY),
        summaryProvider: process.env.OPENAI_API_KEY ? 'OpenAI' : 'Lokal'
      }
    });
  }

  if (req.method === 'GET' && pathname === '/api/settings') {
    return json(res, 200, { openai: publicOpenAISettings() });
  }

  const workshopDownloadMatch = pathname.match(/^\/api\/workshops\/([0-9a-f-]{36})\/download\/(recap|transcript)\.md$/i);
  if (req.method === 'GET' && workshopDownloadMatch) {
    const fileName = `${workshopDownloadMatch[2].toLowerCase()}.md`;
    const filePath = await workshopAssetPath(workshopDownloadMatch[1], fileName);
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': content.length,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store'
    });
    res.end(content);
    return;
  }

  const workshopAssetMatch = pathname.match(/^\/api\/workshops\/([0-9a-f-]{36})\/assets\/(.+)$/i);
  if (req.method === 'GET' && workshopAssetMatch) {
    const filePath = await workshopAssetPath(workshopAssetMatch[1], decodeURIComponent(workshopAssetMatch[2]));
    const extension = path.extname(filePath).toLowerCase();
    const mime = extension === '.png' ? 'image/png'
      : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : 'application/octet-stream';
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': content.length,
      'Cache-Control': 'private, max-age=31536000, immutable'
    });
    res.end(content);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/settings/openai') {
    return json(res, 200, await updateOpenAISettings(await bodyJson(req)));
  }

  if (req.method === 'POST' && pathname === '/api/settings/openai/test') {
    return json(res, 200, await testOpenAIConnection());
  }

  if (req.method === 'GET' && pathname.startsWith('/api/entries/')) {
    const id = pathname.split('/')[3];
    const state = await readState();
    const entry = state.entries.find((item) => item.id === id);
    return entry ? json(res, 200, entry) : json(res, 404, { error: 'Eintrag nicht gefunden.' });
  }

  if (req.method === 'POST' && pathname === '/api/entries') {
    const entry = await createEntry(await bodyJson(req));
    await updateState((state) => {
      state.entries.unshift(entry);
      return state;
    });
    return json(res, 201, entry);
  }

  const todoMatch = pathname.match(/^\/api\/entries\/([^/]+)\/todos\/([^/]+)$/);
  if (req.method === 'PATCH' && todoMatch) {
    const [, entryId, todoId] = todoMatch;
    let changed;
    await updateState((state) => {
      const entry = state.entries.find((item) => item.id === entryId);
      const todo = entry?.todos?.find((item) => item.id === todoId);
      if (!todo) throw Object.assign(new Error('Aufgabe nicht gefunden.'), { status: 404 });
      todo.done = !todo.done;
      entry.updatedAt = new Date().toISOString();
      changed = todo;
      return state;
    });
    return json(res, 200, changed);
  }

  const entryMatch = pathname.match(/^\/api\/entries\/([^/]+)$/);
  if (req.method === 'PATCH' && entryMatch) {
    const payload = await bodyJson(req);
    const currentState = await readState();
    const currentEntry = currentState.entries.find((item) => item.id === entryMatch[1]);
    if (!currentEntry) return json(res, 404, { error: 'Eintrag nicht gefunden.' });
    if (typeof payload.title === 'string') {
      payload.title = payload.title.trim().slice(0, 200);
      if (!payload.title) throw Object.assign(new Error('Der Titel darf nicht leer sein.'), { status: 400 });
      if (currentEntry.workshopId) await updateWorkshopTitle(currentEntry.workshopId, payload.title);
    }
    let changed;
    await updateState((state) => {
      const entry = state.entries.find((item) => item.id === entryMatch[1]);
      if (!entry) throw Object.assign(new Error('Eintrag nicht gefunden.'), { status: 404 });
      for (const field of ['title', 'notes', 'summary']) {
        if (typeof payload[field] === 'string') entry[field] = payload[field];
      }
      entry.updatedAt = new Date().toISOString();
      changed = entry;
      return state;
    });
    return json(res, 200, changed);
  }

  if (req.method === 'DELETE' && entryMatch) {
    let removed;
    await updateState((state) => {
      const before = state.entries.length;
      removed = state.entries.find((item) => item.id === entryMatch[1]);
      state.entries = state.entries.filter((item) => item.id !== entryMatch[1]);
      if (state.entries.length === before) throw Object.assign(new Error('Eintrag nicht gefunden.'), { status: 404 });
      return state;
    });
    if (removed?.workshopId) await deleteWorkshopSession(removed.workshopId).catch((error) => {
      console.warn(`Workshop-Dateien konnten nicht gelöscht werden: ${error.message}`);
    });
    return json(res, 200, { ok: true });
  }

  const summarizeMatch = pathname.match(/^\/api\/entries\/([^/]+)\/summarize$/);
  if (req.method === 'POST' && summarizeMatch) {
    let updated;
    await updateState(async (state) => {
      const entry = state.entries.find((item) => item.id === summarizeMatch[1]);
      if (!entry) throw Object.assign(new Error('Eintrag nicht gefunden.'), { status: 404 });
      const analysis = await summarize(entry.transcript);
      Object.assign(entry, analysis, { updatedAt: new Date().toISOString() });
      updated = entry;
      return state;
    });
    return json(res, 200, updated);
  }

  if (req.method === 'POST' && pathname === '/api/sync') {
    const payload = await bodyJson(req);
    const result = await runSync(String(payload.accessToken || ''));
    return json(res, 200, result);
  }

  if (req.method === 'GET' && pathname === '/api/onedrive/detect') {
    return json(res, 200, {
      candidates: await detectOneDriveFolders(),
      supportedExtensions: supportedTranscriptExtensions
    });
  }

  if (req.method === 'POST' && pathname === '/api/onedrive/select-folder') {
    const selection = await chooseLocalFolder();
    if (selection.cancelled) return json(res, 200, selection);
    return json(res, 200, {
      cancelled: false,
      folderPath: await validateFolder(selection.folderPath)
    });
  }

  if (req.method === 'POST' && pathname === '/api/onedrive/config') {
    const payload = await bodyJson(req);
    const enabled = Boolean(payload.enabled);
    const folderPath = enabled ? await validateFolder(String(payload.folderPath || '')) : String(payload.folderPath || '');
    await updateState((state) => {
      state.integrations.oneDrive.enabled = enabled;
      state.integrations.oneDrive.folderPath = folderPath;
      state.integrations.oneDrive.lastError = null;
      return state;
    });
    await activateFolderWatcher();
    const result = enabled ? await runFolderScan() : { imported: 0, updated: 0, found: 0, warnings: [] };
    const state = await readState();
    return json(res, 200, { config: state.integrations.oneDrive, ...result });
  }

  if (req.method === 'POST' && pathname === '/api/onedrive/scan') {
    return json(res, 200, await runFolderScan());
  }

  return json(res, 404, { error: 'API-Endpunkt nicht gefunden.' });
}

let initialized = false;

export async function startJournalServer({ port = Number(process.env.PORT || 4173), quiet = false } = {}) {
  if (!initialized) {
    await loadEnv();
    await applyPersistedSettings();
    await ensureStore();
    await activateFolderWatcher();
    initialized = true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) return await api(req, res, pathname);
      if (!(await serveStatic(req, res, pathname))) json(res, 404, { error: 'Nicht gefunden.' });
    } catch (error) {
      console.error(error);
      json(res, error.status || 500, { error: error.message || 'Interner Fehler.' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}`;
  if (!quiet) {
    console.log(`Workshop Journal läuft auf ${url}`);
    console.log('Teams-Sync: Anmeldung erfolgt in der App');
  }
  return { server, port: actualPort, url };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await startJournalServer();
