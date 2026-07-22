import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const DATA_FILE = path.join(DATA_DIR, 'journal.json');

const EMPTY_STATE = {
  version: 1,
  entries: [],
  sync: {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    importedCount: 0
  },
  integrations: {
    oneDrive: {
      enabled: false,
      folderPath: '',
      lastScanAt: null,
      lastError: null,
      importedCount: 0
    }
  }
};

let writeQueue = Promise.resolve();

export async function ensureStore() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await readFile(DATA_FILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(DATA_FILE, JSON.stringify(EMPTY_STATE, null, 2));
  }
}

export async function readState() {
  await ensureStore();
  const raw = await readFile(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    ...structuredClone(EMPTY_STATE),
    ...parsed,
    sync: { ...EMPTY_STATE.sync, ...(parsed.sync || {}) },
    integrations: {
      ...EMPTY_STATE.integrations,
      ...(parsed.integrations || {}),
      oneDrive: { ...EMPTY_STATE.integrations.oneDrive, ...(parsed.integrations?.oneDrive || {}) }
    },
    entries: Array.isArray(parsed.entries) ? parsed.entries : []
  };
}

export function updateState(updater) {
  writeQueue = writeQueue.then(async () => {
    const state = await readState();
    const next = await updater(structuredClone(state));
    const tempFile = `${DATA_FILE}.tmp`;
    await writeFile(tempFile, JSON.stringify(next, null, 2));
    await rename(tempFile, DATA_FILE);
    return next;
  });
  return writeQueue;
}

export function publicEntry(entry, includeTranscript = false) {
  const result = { ...entry };
  if (!includeTranscript) delete result.transcript;
  return result;
}
