import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  openaiApiKey: null,
  openaiModel: 'gpt-5.6-luna'
};

export async function readSettings() {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw error;
  }
}

export async function saveSettings(settings) {
  await mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${SETTINGS_FILE}.tmp`;
  await writeFile(tempFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(tempFile, SETTINGS_FILE);
  await chmod(SETTINGS_FILE, 0o600).catch(() => {});
  return settings;
}

export async function applyPersistedSettings(env = process.env) {
  const settings = await readSettings();
  if (typeof settings.openaiApiKey === 'string') {
    if (settings.openaiApiKey) env.OPENAI_API_KEY = settings.openaiApiKey;
    else delete env.OPENAI_API_KEY;
  }
  if (settings.openaiModel) env.OPENAI_MODEL = settings.openaiModel;
  return settings;
}

export function publicOpenAISettings(env = process.env) {
  const key = env.OPENAI_API_KEY || '';
  return {
    configured: Boolean(key),
    keyHint: key ? `••••••••${key.slice(-4)}` : '',
    model: env.OPENAI_MODEL || DEFAULT_SETTINGS.openaiModel
  };
}

export async function updateOpenAISettings({ apiKey, model, removeKey = false }, env = process.env) {
  const settings = await readSettings();
  const nextModel = String(model || settings.openaiModel || DEFAULT_SETTINGS.openaiModel).trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(nextModel)) {
    throw Object.assign(new Error('Bitte eine gültige OpenAI-Modell-ID eintragen.'), { status: 400 });
  }
  if (removeKey) {
    settings.openaiApiKey = '';
    delete env.OPENAI_API_KEY;
  } else if (typeof apiKey === 'string' && apiKey.trim()) {
    const cleanKey = apiKey.trim();
    if (!cleanKey.startsWith('sk-') || cleanKey.length < 20) {
      throw Object.assign(new Error('Der OpenAI API-Key scheint ungültig zu sein.'), { status: 400 });
    }
    settings.openaiApiKey = cleanKey;
    env.OPENAI_API_KEY = cleanKey;
  }
  settings.openaiModel = nextModel;
  env.OPENAI_MODEL = nextModel;
  await saveSettings(settings);
  return publicOpenAISettings(env);
}

export async function testOpenAIConnection(env = process.env) {
  if (!env.OPENAI_API_KEY) throw Object.assign(new Error('Bitte zuerst einen OpenAI API-Key speichern.'), { status: 400 });
  const model = env.OPENAI_MODEL || DEFAULT_SETTINGS.openaiModel;
  const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw Object.assign(new Error(payload.error?.message || `OpenAI-Verbindung fehlgeschlagen (${response.status}).`), { status: 400 });
  }
  return { ok: true, model };
}
