import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('bearbeitet Workshop-Titel und liefert Markdown-Dateien als Download', async () => {
  const previous = process.env.MEETING_JOURNAL_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'workshop-journal-server-'));
  process.env.MEETING_JOURNAL_DATA_DIR = root;
  const { createWorkshopSession, sessionDirectory, stopWorkshopSession } = await import('../lib/workshop-store.js');
  const { updateState } = await import('../lib/store.js');
  const { startJournalServer } = await import('../server.js');
  let server;
  try {
    const session = await createWorkshopSession({ title: 'Alter Titel' });
    await stopWorkshopSession(session.id, { durationMs: 1000 });
    await writeFile(path.join(sessionDirectory(session.id), 'recap.md'), '# Alter Titel\n\nRecap-Inhalt\n');
    await writeFile(path.join(sessionDirectory(session.id), 'transcript.md'), '[00:00:00] Transkript-Inhalt\n');
    await updateState((state) => {
      state.entries.push({
        id: 'entry-test',
        workshopId: session.id,
        source: 'workshop',
        title: 'Alter Titel',
        transcript: 'Transkript-Inhalt',
        occurredAt: new Date().toISOString(),
        todos: [],
        decisions: []
      });
      return state;
    });
    ({ server } = await startJournalServer({ port: 0, quiet: true }));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;

    const updateResponse = await fetch(`${base}/api/entries/entry-test`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Neuer Titel' })
    });
    assert.equal(updateResponse.status, 200);
    assert.equal((await updateResponse.json()).title, 'Neuer Titel');
    assert.match(await readFile(path.join(sessionDirectory(session.id), 'recap.md'), 'utf8'), /^# Neuer Titel/);

    for (const name of ['recap', 'transcript']) {
      const response = await fetch(`${base}/api/workshops/${session.id}/download/${name}.md`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
      assert.match(response.headers.get('content-disposition'), new RegExp(`filename="${name}\\.md"`));
      assert.match(await response.text(), name === 'recap' ? /Neuer Titel/ : /Transkript-Inhalt/);
    }
  } finally {
    await new Promise((resolve) => server?.close(resolve) || resolve());
    if (previous === undefined) delete process.env.MEETING_JOURNAL_DATA_DIR;
    else process.env.MEETING_JOURNAL_DATA_DIR = previous;
  }
});
