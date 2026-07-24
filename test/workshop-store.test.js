import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendWorkshopAudio,
  createWorkshopSession,
  deleteWorkshopSession,
  listRecoverableWorkshops,
  readWorkshopSession,
  saveWorkshopScreenshot,
  stopWorkshopSession,
  workshopAssetPath
} from '../lib/workshop-store.js';

test('schreibt Audio, Screenshot und Session-Metadaten wiederherstellbar', async () => {
  const previous = process.env.MEETING_JOURNAL_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'workshop-journal-'));
  process.env.MEETING_JOURNAL_DATA_DIR = root;
  try {
    const session = await createWorkshopSession({
      title: 'Test Workshop',
      participants: ['Anna'],
      captureMode: { microphone: true, system: false, window: true },
      source: { id: 'window:1:0', name: 'Testfenster' }
    });
    await appendWorkshopAudio(session.id, 'mixed', Buffer.from('webm-audio-data'), 'audio/webm');
    const screenshot = await saveWorkshopScreenshot(
      session.id,
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      { offsetMs: 12500, windowName: 'Testfenster', width: 800, height: 600 }
    );
    await stopWorkshopSession(session.id, { durationMs: 15000 });

    const stored = await readWorkshopSession(session.id);
    assert.equal(stored.status, 'recorded');
    assert.equal(stored.durationMs, 15000);
    assert.equal(stored.tracks.mixed.bytes, 15);
    assert.equal(stored.screenshots[0].offsetMs, 12500);
    assert.match(stored.screenshots[0].file, /^screenshots\/001_00-00-12_/);

    const audio = await readFile(path.join(root, 'workshops', session.id, stored.tracks.mixed.file));
    assert.equal(audio.toString(), 'webm-audio-data');
    const asset = await workshopAssetPath(session.id, screenshot.file);
    assert.equal((await stat(asset)).size, 4);
    assert.deepEqual((await listRecoverableWorkshops()).map((item) => item.id), [session.id]);
    await deleteWorkshopSession(session.id);
    await assert.rejects(() => readWorkshopSession(session.id), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.MEETING_JOURNAL_DATA_DIR;
    else process.env.MEETING_JOURNAL_DATA_DIR = previous;
  }
});

test('blockiert Pfad-Ausbruch bei Workshop-Assets', async () => {
  const previous = process.env.MEETING_JOURNAL_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'workshop-journal-'));
  process.env.MEETING_JOURNAL_DATA_DIR = root;
  try {
    const session = await createWorkshopSession({ title: 'Sicher' });
    await assert.rejects(() => workshopAssetPath(session.id, '../../journal.json'), /Ungültiger Workshop-Dateipfad/);
  } finally {
    if (previous === undefined) delete process.env.MEETING_JOURNAL_DATA_DIR;
    else process.env.MEETING_JOURNAL_DATA_DIR = previous;
  }
});
