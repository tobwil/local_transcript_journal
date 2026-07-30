import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { workshopsDirectory } from './data-paths.js';

const SESSION_ID = /^[0-9a-f-]{36}$/i;
const TRACK_NAMES = new Set(['mixed', 'microphone', 'system']);
const writeQueues = new Map();

function cleanFilePart(value) {
  return String(value || 'Workshop')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80) || 'Workshop';
}

function assertSessionId(sessionId) {
  if (!SESSION_ID.test(String(sessionId || ''))) throw new Error('Ungültige Workshop-ID.');
  return sessionId;
}

export function sessionDirectory(sessionId) {
  return path.join(workshopsDirectory(), assertSessionId(sessionId));
}

export function sessionMetadataFile(sessionId) {
  return path.join(sessionDirectory(sessionId), 'session.json');
}

async function atomicJson(filePath, value) {
  const tempFile = `${filePath}.tmp`;
  await writeFile(tempFile, JSON.stringify(value, null, 2));
  await rename(tempFile, filePath);
}

export async function readWorkshopSession(sessionId) {
  return JSON.parse(await readFile(sessionMetadataFile(sessionId), 'utf8'));
}

export async function updateWorkshopSession(sessionId, updater) {
  const key = `session:${assertSessionId(sessionId)}`;
  const previous = writeQueues.get(key) || Promise.resolve();
  const queued = previous.then(async () => {
    const current = await readWorkshopSession(sessionId);
    const next = await updater(structuredClone(current));
    next.updatedAt = new Date().toISOString();
    await atomicJson(sessionMetadataFile(sessionId), next);
    return next;
  });
  writeQueues.set(key, queued.catch(() => {}));
  return queued;
}

export async function createWorkshopSession(input = {}) {
  const id = randomUUID();
  const now = new Date();
  const root = sessionDirectory(id);
  await Promise.all([
    mkdir(path.join(root, 'audio'), { recursive: true }),
    mkdir(path.join(root, 'screenshots'), { recursive: true })
  ]);
  const session = {
    id,
    version: 1,
    status: 'recording',
    title: String(input.title || '').trim() || `Workshop ${now.toLocaleDateString('de-DE')}`,
    participants: Array.isArray(input.participants) ? input.participants.map(String).filter(Boolean) : [],
    notes: String(input.notes || ''),
    language: String(input.language || 'de'),
    captureMode: {
      microphone: input.captureMode?.microphone !== false,
      system: input.captureMode?.system !== false,
      window: input.captureMode?.window !== false
    },
    source: input.source ? {
      id: String(input.source.id || ''),
      name: String(input.source.name || '')
    } : null,
    startedAt: now.toISOString(),
    stoppedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    durationMs: 0,
    tracks: {},
    screenshots: [],
    warnings: [],
    error: null,
    entryId: null
  };
  await atomicJson(sessionMetadataFile(id), session);
  return session;
}

export async function appendWorkshopAudio(sessionId, trackName, chunk, mimeType = '') {
  assertSessionId(sessionId);
  if (!TRACK_NAMES.has(trackName)) throw new Error('Unbekannte Audiospur.');
  const bytes = Buffer.from(chunk);
  if (!bytes.length) return { bytes: 0 };
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Audio-Chunk ist zu groß.');
  const fileName = `${trackName}.webm`;
  const filePath = path.join(sessionDirectory(sessionId), 'audio', fileName);
  const key = `audio:${sessionId}:${trackName}`;
  const previous = writeQueues.get(key) || Promise.resolve();
  const queued = previous.then(() => appendFile(filePath, bytes));
  writeQueues.set(key, queued.catch(() => {}));
  await queued;
  await updateWorkshopSession(sessionId, (session) => {
    const track = session.tracks[trackName] || { file: `audio/${fileName}`, bytes: 0, mimeType };
    track.bytes += bytes.length;
    track.mimeType ||= mimeType;
    session.tracks[trackName] = track;
    return session;
  });
  return { bytes: bytes.length };
}

export async function flushWorkshopWrites(sessionId) {
  const prefix = `audio:${assertSessionId(sessionId)}:`;
  const pending = [...writeQueues.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, promise]) => promise);
  await Promise.all(pending);
}

export async function saveWorkshopScreenshot(sessionId, pngData, input = {}) {
  const bytes = Buffer.from(pngData);
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('Ungültiger Screenshot.');
  const session = await readWorkshopSession(sessionId);
  const offsetMs = Math.max(0, Math.round(Number(input.offsetMs) || 0));
  const index = session.screenshots.length + 1;
  const timePart = new Date(offsetMs).toISOString().slice(11, 19).replaceAll(':', '-');
  const fileName = `${String(index).padStart(3, '0')}_${timePart}_${cleanFilePart(input.windowName || session.source?.name)}.png`;
  await writeFile(path.join(sessionDirectory(sessionId), 'screenshots', fileName), bytes);
  let screenshot;
  await updateWorkshopSession(sessionId, (next) => {
    screenshot = {
      id: randomUUID(),
      file: `screenshots/${fileName}`,
      capturedAt: new Date().toISOString(),
      offsetMs,
      windowName: String(input.windowName || next.source?.name || 'Ausgewähltes Fenster'),
      width: Math.max(0, Math.round(Number(input.width) || 0)),
      height: Math.max(0, Math.round(Number(input.height) || 0))
    };
    next.screenshots.push(screenshot);
    return next;
  });
  return screenshot;
}

export async function stopWorkshopSession(sessionId, input = {}) {
  await flushWorkshopWrites(sessionId);
  return updateWorkshopSession(sessionId, (session) => {
    session.status = 'recorded';
    session.stoppedAt = new Date().toISOString();
    session.durationMs = Math.max(0, Math.round(Number(input.durationMs) || Date.now() - Date.parse(session.startedAt)));
    for (const warning of input.warnings || []) {
      if (warning && !session.warnings.includes(warning)) session.warnings.push(String(warning));
    }
    return session;
  });
}

export async function updateWorkshopTitle(sessionId, title) {
  const nextTitle = String(title || '').trim().slice(0, 200);
  if (!nextTitle) throw new Error('Der Titel darf nicht leer sein.');
  const session = await updateWorkshopSession(sessionId, (next) => {
    next.title = nextTitle;
    return next;
  });
  const recapFile = path.join(sessionDirectory(sessionId), 'recap.md');
  try {
    const recap = await readFile(recapFile, 'utf8');
    const updated = recap.replace(/^# [^\n]*/u, `# ${nextTitle}`);
    if (updated !== recap) {
      const temporary = `${recapFile}.tmp`;
      await writeFile(temporary, updated);
      await rename(temporary, recapFile);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return session;
}

export async function deleteWorkshopAudio(sessionId, completion = {}) {
  await flushWorkshopWrites(sessionId);
  await rm(path.join(sessionDirectory(sessionId), 'audio'), { recursive: true, force: true });
  return updateWorkshopSession(sessionId, (session) => {
    session.tracks = {};
    session.audioDeletedAt = new Date().toISOString();
    session.audioRetention = 'deleted-after-transcription';
    if (completion.complete) {
      session.status = 'complete';
      session.entryId = completion.entryId || session.entryId;
      session.completedAt = new Date().toISOString();
    }
    return session;
  });
}

export async function listRecoverableWorkshops() {
  await mkdir(workshopsDirectory(), { recursive: true });
  const entries = await readdir(workshopsDirectory(), { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    try {
      const session = await readWorkshopSession(entry.name);
      if (['recording', 'recorded', 'processing', 'error'].includes(session.status)) sessions.push(session);
    } catch {
      // A partial directory without metadata cannot be recovered safely.
    }
  }
  return sessions.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export async function workshopAssetPath(sessionId, relativeFile) {
  const root = sessionDirectory(sessionId);
  const resolved = path.resolve(root, String(relativeFile || ''));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Ungültiger Workshop-Dateipfad.');
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('Workshop-Datei nicht gefunden.');
  return resolved;
}

export async function deleteWorkshopSession(sessionId) {
  const root = sessionDirectory(sessionId);
  await rm(root, { recursive: true, force: false });
}
