import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanTranscriptFolder, validateFolder } from '../lib/folder-watch.js';

test('importiert und aktualisiert Transkripte aus einem überwachten Ordner', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meeting-journal-test-'));
  const transcriptPath = path.join(directory, 'Roadmap Meeting.vtt');
  const state = { entries: [] };
  try {
    await writeFile(transcriptPath, `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Anna Schmidt>Wir haben entschieden, am Freitag zu starten.</v>

00:00:05.000 --> 00:00:08.000
<v Boris Klein>Ich übernehme die Prüfung bis Donnerstag.</v>`);
    const first = await scanTranscriptFolder(state, directory, {});
    assert.equal(first.imported, 1);
    assert.equal(state.entries[0].source, 'onedrive');
    assert.equal(state.entries[0].title, 'Roadmap Meeting');

    const unchanged = await scanTranscriptFolder(state, directory, {});
    assert.equal(unchanged.imported, 0);
    assert.equal(unchanged.updated, 0);

    await writeFile(transcriptPath, `${state.entries[0].transcript}\nAnna Schmidt: Bitte sende die Freigabe an Marketing.`);
    const changed = await scanTranscriptFolder(state, directory, {});
    assert.equal(changed.updated, 1);
    assert.equal(state.entries.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('weist unbekannte Ordner verständlich zurück', async () => {
  await assert.rejects(() => validateFolder(path.join(os.tmpdir(), 'meeting-journal-nicht-vorhanden')), /nicht gefunden/);
});
