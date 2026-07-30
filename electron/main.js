import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  powerMonitor,
  session,
  shell,
  systemPreferences
} from 'electron';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.env.ELECTRON_DEV === '1') {
  app.setPath('userData', process.env.ELECTRON_TEST_USER_DATA || path.join(ROOT, 'data', 'desktop-user-data'));
  app.commandLine.appendSwitch('remote-debugging-port', process.env.ELECTRON_DEBUG_PORT || '9223');
}
let mainWindow;
let journalServer;
let selectedCaptureSourceId = null;
let activeRecording = null;
let modelDownload = null;
let processing = null;
let allowClose = false;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function permissionStatus() {
  if (process.platform !== 'darwin') return { microphone: 'unknown', screen: 'unknown' };
  return {
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen')
  };
}

async function captureSources() {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 480, height: 300 },
    fetchWindowIcons: true
  });
  return sources
    .filter((source) => !source.name.startsWith('Workshop Journal'))
    .map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.isEmpty() === false ? source.appIcon.toDataURL() : ''
    }));
}

async function resolveSelectedSource() {
  if (!selectedCaptureSourceId) return null;
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  return sources.find((source) => source.id === selectedCaptureSourceId) || null;
}

function configurePermissions() {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    const local = requestingOrigin.startsWith('http://127.0.0.1:');
    return local && ['media', 'display-capture', 'fullscreen'].includes(permission);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const local = webContents.getURL().startsWith('http://127.0.0.1:');
    callback(local && ['media', 'display-capture', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const source = await resolveSelectedSource();
      if (!source) return callback({});
      callback({ video: source, audio: 'loopback' });
    } catch (error) {
      console.error('Fensterfreigabe:', error);
      callback({});
    }
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    title: 'Workshop Journal',
    backgroundColor: '#f5f1e8',
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', async (event) => {
    if (allowClose || !activeRecording) return;
    event.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Aufnahme läuft',
      message: 'Der Workshop wird gerade aufgezeichnet.',
      detail: 'Beende die Aufnahme in der App, damit alle Audiodaten sicher geschrieben und transkribiert werden.',
      buttons: ['Zur Aufnahme zurück', 'Aufnahme jetzt beenden'],
      defaultId: 0,
      cancelId: 0
    });
    if (result.response === 1) send('workshop:force-stop', { reason: 'window-close' });
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadURL(journalServer.url);
  const { listRecoverableWorkshops } = await import('../lib/workshop-store.js');
  const recoverable = await listRecoverableWorkshops();
  if (recoverable.length) send('workshop:recoverable', recoverable);
}

function registerIpc() {
  ipcMain.handle('desktop:get-status', async () => {
    const { getTranscriptionStatus } = await import('../lib/transcription.js');
    const { listRecoverableWorkshops } = await import('../lib/workshop-store.js');
    return {
      permissions: permissionStatus(),
      transcription: await getTranscriptionStatus(),
      activeRecording,
      recoverable: await listRecoverableWorkshops(),
      version: app.getVersion()
    };
  });

  ipcMain.handle('desktop:request-microphone', async () => {
    if (process.platform !== 'darwin') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });

  ipcMain.handle('capture:list-sources', captureSources);
  ipcMain.handle('capture:select-source', async (_event, sourceId) => {
    const sources = await captureSources();
    const source = sources.find((item) => item.id === sourceId);
    if (!source) throw new Error('Das ausgewählte Fenster ist nicht mehr verfügbar.');
    selectedCaptureSourceId = source.id;
    return source;
  });

  ipcMain.handle('workshop:create', async (_event, input) => {
    const { createWorkshopSession } = await import('../lib/workshop-store.js');
    return createWorkshopSession(input);
  });

  ipcMain.handle('workshop:append-audio', async (_event, payload) => {
    const { appendWorkshopAudio } = await import('../lib/workshop-store.js');
    return appendWorkshopAudio(
      payload.sessionId,
      payload.track,
      Buffer.from(new Uint8Array(payload.chunk)),
      payload.mimeType
    );
  });

  ipcMain.handle('workshop:screenshot', async (_event, payload) => {
    const { saveWorkshopScreenshot } = await import('../lib/workshop-store.js');
    return saveWorkshopScreenshot(
      payload.sessionId,
      Buffer.from(new Uint8Array(payload.png)),
      payload.metadata
    );
  });

  ipcMain.handle('workshop:stop', async (_event, payload) => {
    const { stopWorkshopSession } = await import('../lib/workshop-store.js');
    const result = await stopWorkshopSession(payload.sessionId, payload.input);
    if (activeRecording?.sessionId === payload.sessionId) activeRecording = null;
    return result;
  });

  ipcMain.handle('workshop:set-active', (_event, payload) => {
    if (payload.active) {
      activeRecording = { sessionId: payload.sessionId, startedAt: new Date().toISOString() };
      if (!globalShortcut.isRegistered('CommandOrControl+Shift+S')) {
        globalShortcut.register('CommandOrControl+Shift+S', () => send('workshop:screenshot-shortcut'));
      }
    } else {
      if (activeRecording?.sessionId === payload.sessionId) activeRecording = null;
      globalShortcut.unregister('CommandOrControl+Shift+S');
    }
    return activeRecording;
  });

  ipcMain.handle('transcription:download-model', async () => {
    if (modelDownload) return modelDownload;
    const { downloadTranscriptionModel } = await import('../lib/transcription.js');
    modelDownload = downloadTranscriptionModel((progress) => send('workshop:progress', progress))
      .finally(() => { modelDownload = null; });
    return modelDownload;
  });

  const transcribe = async (sessionId) => {
    if (processing) throw new Error('Es wird bereits ein Workshop transkribiert.');
    const { transcribeWorkshop } = await import('../lib/transcription.js');
    processing = transcribeWorkshop(sessionId, (progress) => send('workshop:progress', progress))
      .finally(() => { processing = null; });
    return processing;
  };
  ipcMain.handle('workshop:transcribe', (_event, sessionId) => transcribe(sessionId));
  ipcMain.handle('workshop:recover', async (_event, sessionId) => {
    const { readWorkshopSession, stopWorkshopSession } = await import('../lib/workshop-store.js');
    const current = await readWorkshopSession(sessionId);
    if (current.status === 'recording') {
      await stopWorkshopSession(sessionId, {
        durationMs: Math.max(0, Date.parse(current.updatedAt) - Date.parse(current.startedAt)),
        warnings: ['Die Anwendung wurde während der Aufnahme beendet. Die Audiodatei wurde soweit möglich wiederhergestellt.']
      });
    }
    return transcribe(sessionId);
  });
  ipcMain.handle('workshop:open-folder', async (_event, sessionId) => {
    const { readWorkshopSession, sessionDirectory } = await import('../lib/workshop-store.js');
    await readWorkshopSession(sessionId);
    const error = await shell.openPath(sessionDirectory(sessionId));
    if (error) throw new Error(`Der Ablageordner konnte nicht geöffnet werden: ${error}`);
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  const userDataRoot = app.getPath('userData');
  process.env.MEETING_JOURNAL_DATA_DIR = path.join(userDataRoot, 'data');
  await mkdir(process.env.MEETING_JOURNAL_DATA_DIR, { recursive: true });
  const { startJournalServer } = await import('../server.js');
  journalServer = await startJournalServer({ port: 0, quiet: true });
  configurePermissions();
  registerIpc();
  powerMonitor.on('suspend', () => {
    if (activeRecording) send('workshop:force-stop', { reason: 'system-suspend' });
  });
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error(error);
  dialog.showErrorBox('Workshop Journal konnte nicht gestartet werden', error.stack || error.message);
  app.exit(1);
});

app.on('before-quit', () => {
  allowClose = true;
  globalShortcut.unregisterAll();
  journalServer?.server.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
