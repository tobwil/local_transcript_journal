import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { chromium } from 'playwright-core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const userData = await mkdtemp(path.join(os.tmpdir(), 'workshop-journal-electron-'));
const port = 10000 + (process.pid % 40000);
const packagedExecutable = path.join(root, 'dist', 'mac-arm64', 'Workshop Journal.app', 'Contents', 'MacOS', 'Workshop Journal');
const executable = process.env.TEST_PACKAGED === '1' ? packagedExecutable : electronPath;
const executableArgs = process.env.TEST_PACKAGED === '1'
  ? [`--remote-debugging-port=${port}`]
  : ['.', `--remote-debugging-port=${port}`];
const child = spawn(executable, executableArgs, {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_DEV: '1',
    ELECTRON_DEBUG_PORT: String(port),
    ELECTRON_TEST_USER_DATA: userData
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const childExit = new Promise((resolve) => child.once('exit', resolve));
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

async function connect() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron wurde vorzeitig beendet:\n${output}`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Electron-Debugschnittstelle wurde nicht erreichbar:\n${output}`);
}

let browser;
try {
  browser = await connect();
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('http://127.0.0.1:'));
  assert.ok(page, 'Journal-Fenster fehlt');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#recordWorkshopButton').waitFor({ state: 'visible' });
  assert.equal(await page.title(), 'Workshop Journal');
  assert.equal(await page.evaluate(() => Boolean(window.workshopDesktop?.isDesktop)), true);
  assert.equal(await page.evaluate(() => typeof window.workshopDesktop?.openWorkshopFolder), 'function');

  const status = await page.evaluate(() => window.workshopDesktop.getStatus());
  assert.equal(status.transcription.ffmpeg.available, true);
  assert.equal(status.transcription.runtime.available, true, status.transcription.runtime.error);
  const sources = await page.evaluate(() => window.workshopDesktop.listCaptureSources());
  assert.ok(sources.length > 0, 'Es wurden keine fensterbezogenen Aufnahmequellen gefunden');
  assert.ok(sources.some((source) => source.thumbnail.startsWith('data:image/')), 'Fenstervorschauen fehlen');

  await page.locator('#recordWorkshopButton').click();
  await page.locator('#workshopDialog[open]').waitFor();
  assert.match(await page.locator('#workshopDialog h2').textContent(), /Workshop aufnehmen/);
  assert.equal(await page.locator('#workshopPreflight .preflight-item').count(), 3);
  const artifactDirectory = path.join(root, 'data', 'test-artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({ path: path.join(artifactDirectory, 'electron-workshop-dialog.png'), fullPage: true });

  const stored = await page.evaluate(async () => {
    const session = await window.workshopDesktop.createSession({
      title: 'Electron Smoke Test',
      captureMode: { microphone: true, system: false, window: true },
      source: { id: 'window:test', name: 'Testfenster' }
    });
    await window.workshopDesktop.appendAudio(
      session.id,
      'mixed',
      new TextEncoder().encode('test-webm-data').buffer,
      'audio/webm'
    );
    await window.workshopDesktop.saveScreenshot(
      session.id,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      { offsetMs: 1000, windowName: 'Testfenster', width: 100, height: 80 }
    );
    return window.workshopDesktop.stopSession(session.id, { durationMs: 1200 });
  });
  assert.equal(stored.status, 'recorded');
  const sessionFile = path.join(userData, 'data', 'workshops', stored.id, 'session.json');
  const session = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.equal(session.tracks.mixed.bytes, 14);
  assert.equal(session.screenshots.length, 1);
  assert.equal((await stat(path.join(userData, 'data', 'workshops', stored.id, session.screenshots[0].file))).size, 4);
  assert.deepEqual(pageErrors, []);
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      childExit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000))
    ]);
    if (!exited && child.exitCode === null) {
      child.kill('SIGKILL');
      await childExit;
    }
  }
}
