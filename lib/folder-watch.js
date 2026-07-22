import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mammoth from 'mammoth';
import { extractParticipants, summarize } from './summarize.js';

const SUPPORTED = new Set(['.txt', '.md', '.vtt', '.srt', '.json', '.docx']);
const MAX_FILES = 5000;

function cleanTitle(filePath) {
  return path.basename(filePath, path.extname(filePath))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'OneDrive-Transkript';
}

async function isDirectory(candidate) {
  try { return (await stat(candidate)).isDirectory(); }
  catch { return false; }
}

async function addIfDirectory(results, candidate) {
  if (!candidate || !(await isDirectory(candidate))) return;
  const resolved = await realpath(candidate).catch(() => path.resolve(candidate));
  if (!results.includes(resolved)) results.push(resolved);
  const recordings = path.join(resolved, 'Recordings');
  if (await isDirectory(recordings)) results.unshift(await realpath(recordings).catch(() => recordings));
  const aufzeichnungen = path.join(resolved, 'Aufzeichnungen');
  if (await isDirectory(aufzeichnungen)) results.unshift(await realpath(aufzeichnungen).catch(() => aufzeichnungen));
}

export async function detectOneDriveFolders(env = process.env) {
  const results = [];
  for (const candidate of [env.OneDriveCommercial, env.OneDriveConsumer, env.OneDrive]) {
    await addIfDirectory(results, candidate);
  }

  const home = os.homedir();
  const likelyRoots = [home, path.join(home, 'Library', 'CloudStorage')];
  for (const root of likelyRoots) {
    let entries = [];
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && /^OneDrive(?:\s|$|-)/i.test(entry.name)) {
        await addIfDirectory(results, path.join(root, entry.name));
      }
    }
  }
  return [...new Set(results)];
}

export async function validateFolder(folderPath) {
  if (!folderPath || typeof folderPath !== 'string') throw Object.assign(new Error('Bitte einen lokalen OneDrive-Ordner angeben.'), { status: 400 });
  const resolved = await realpath(path.resolve(folderPath)).catch(() => null);
  if (!resolved || !(await isDirectory(resolved))) throw Object.assign(new Error('Der angegebene Ordner wurde nicht gefunden.'), { status: 400 });
  await access(resolved);
  return resolved;
}

async function listTranscriptFiles(root) {
  const files = [];
  const queue = [root];
  while (queue.length && files.length < MAX_FILES) {
    const current = queue.shift();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) files.push(target);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}

async function readTranscript(filePath) {
  if (path.extname(filePath).toLowerCase() === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value.trim();
  }
  const text = await readFile(filePath, 'utf8');
  if (path.extname(filePath).toLowerCase() !== '.json') return text.trim();
  try {
    const parsed = JSON.parse(text);
    return String(parsed.transcript || parsed.content || parsed.text || text).trim();
  } catch { return text.trim(); }
}

function fingerprint(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function scanTranscriptFolder(state, folderPath, env = process.env) {
  const root = await validateFolder(folderPath);
  const files = await listTranscriptFiles(root);
  const fingerprints = new Set(state.entries.map((entry) => entry.fileFingerprint).filter(Boolean));
  let imported = 0;
  let updated = 0;
  const warnings = [];

  for (const filePath of files) {
    try {
      const transcript = await readTranscript(filePath);
      if (transcript.length < 20) continue;
      const digest = fingerprint(transcript);
      const canonicalPath = await realpath(filePath).catch(() => filePath);
      const externalId = `folder:${canonicalPath}`;
      const existing = state.entries.find((entry) => entry.externalId === externalId);
      if (existing?.fileFingerprint === digest || (!existing && fingerprints.has(digest))) continue;
      const fileInfo = await stat(filePath);
      const analysis = await summarize(transcript, env);
      const values = {
        externalId,
        source: 'onedrive',
        title: cleanTitle(filePath),
        occurredAt: fileInfo.mtime.toISOString(),
        updatedAt: new Date().toISOString(),
        participants: extractParticipants(transcript),
        transcript,
        filePath: canonicalPath,
        fileFingerprint: digest,
        ...analysis
      };

      if (existing) {
        Object.assign(existing, values);
        updated += 1;
      } else {
        state.entries.unshift({
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          notes: '',
          ...values
        });
        imported += 1;
      }
      fingerprints.add(digest);
    } catch (error) {
      warnings.push(`${path.basename(filePath)}: ${error.message}`);
    }
  }
  return { state, imported, updated, found: files.length, warnings: warnings.slice(0, 8), root };
}

let activeWatcher = null;
let pollingTimer = null;
let debounceTimer = null;

export function stopFolderWatcher() {
  activeWatcher?.close();
  activeWatcher = null;
  clearInterval(pollingTimer);
  clearTimeout(debounceTimer);
  pollingTimer = null;
  debounceTimer = null;
}

export function startFolderWatcher(folderPath, onChange) {
  stopFolderWatcher();
  const schedule = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onChange().catch((error) => console.error('Ordner-Sync:', error.message)), 1400);
  };
  try {
    activeWatcher = watch(folderPath, { recursive: true }, schedule);
    activeWatcher.on('error', (error) => console.error('Ordnerüberwachung:', error.message));
  } catch (error) {
    console.warn(`Native Ordnerüberwachung nicht verfügbar: ${error.message}`);
  }
  pollingTimer = setInterval(schedule, 60000);
}

export const supportedTranscriptExtensions = [...SUPPORTED];
