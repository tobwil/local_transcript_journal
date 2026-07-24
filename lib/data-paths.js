import path from 'node:path';

export function dataDirectory(env = process.env) {
  return path.resolve(env.MEETING_JOURNAL_DATA_DIR || 'data');
}

export function journalFile(env = process.env) {
  return path.join(dataDirectory(env), 'journal.json');
}

export function settingsFile(env = process.env) {
  return path.join(dataDirectory(env), 'settings.json');
}

export function workshopsDirectory(env = process.env) {
  return path.join(dataDirectory(env), 'workshops');
}

export function modelsDirectory(env = process.env) {
  return path.join(dataDirectory(env), 'models');
}
