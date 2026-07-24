import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.MEETING_JOURNAL_DATA_DIR ||= path.join(root, 'data', 'transcription-integration');
delete process.env.OPENAI_API_KEY;

const {
  downloadTranscriptionModel,
  getTranscriptionStatus,
  transcribeWorkshop
} = await import('../lib/transcription.js');
const {
  appendWorkshopAudio,
  createWorkshopSession,
  saveWorkshopScreenshot,
  stopWorkshopSession
} = await import('../lib/workshop-store.js');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${code}: ${stderr}`)));
  });
}

let status = await getTranscriptionStatus();
if (!status.ready) {
  status = await downloadTranscriptionModel((item) => {
    if (item.progress % 5 < 1 || item.progress >= 99) {
      process.stdout.write(`\r${item.message} ${item.progress}%   `);
    }
  });
  process.stdout.write('\n');
}
assert.equal(status.ready, true);

const work = path.join(process.env.MEETING_JOURNAL_DATA_DIR, 'integration-input');
await mkdir(work, { recursive: true });
const aiff = path.join(work, 'deutsch.aiff');
const webm = path.join(work, 'deutsch.webm');
await run('/usr/bin/say', [
  '-v', 'Anna',
  '-r', '165',
  '-o', aiff,
  'Willkommen zum Strategie Workshop. Wir haben entschieden, das neue Kundenportal am Freitag zu starten. Anna übernimmt die finale Prüfung bis Donnerstag. Bitte dokumentiert außerdem die offenen Risiken.'
]);
await run(ffmpegStatic, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', aiff,
  '-c:a', 'libopus',
  webm
]);

const session = await createWorkshopSession({
  title: 'Transkriptions-Integrationstest',
  participants: ['Anna'],
  language: 'de',
  captureMode: { microphone: true, system: false, window: true },
  source: { id: 'window:test', name: 'Test-Präsentation' }
});
await appendWorkshopAudio(session.id, 'mixed', await readFile(webm), 'audio/webm;codecs=opus');
await saveWorkshopScreenshot(
  session.id,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  { offsetMs: 2000, windowName: 'Test-Präsentation', width: 1, height: 1 }
);
await stopWorkshopSession(session.id, { durationMs: 12000 });
const result = await transcribeWorkshop(session.id, (item) => {
  process.stdout.write(`\r${item.message} ${item.progress}%   `);
});
process.stdout.write('\n');

assert.equal(result.session.status, 'complete');
assert.equal(result.entry.source, 'workshop');
assert.equal(result.entry.screenshots.length, 1);
assert.match(result.entry.transcript.toLowerCase(), /(strategie|workshop)/);
assert.match(result.entry.transcript.toLowerCase(), /(kundenportal|portal)/);
assert.ok(result.entry.transcriptSegments.length > 0);
assert.ok(result.entry.transcriptSegments.at(-1).end <= 14, 'Zeitstempel müssen in Sekunden zur Audiodauer passen');
await writeFile(path.join(work, 'result.json'), JSON.stringify(result, null, 2));
console.log(result.entry.transcript);
