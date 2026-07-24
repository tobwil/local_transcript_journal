const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('workshopDesktop', {
  isDesktop: true,
  platform: process.platform,
  getStatus: () => ipcRenderer.invoke('desktop:get-status'),
  requestMicrophonePermission: () => ipcRenderer.invoke('desktop:request-microphone'),
  listCaptureSources: () => ipcRenderer.invoke('capture:list-sources'),
  selectCaptureSource: (sourceId) => ipcRenderer.invoke('capture:select-source', sourceId),
  createSession: (input) => ipcRenderer.invoke('workshop:create', input),
  appendAudio: (sessionId, track, chunk, mimeType) => ipcRenderer.invoke('workshop:append-audio', {
    sessionId,
    track,
    chunk,
    mimeType
  }),
  saveScreenshot: (sessionId, png, metadata) => ipcRenderer.invoke('workshop:screenshot', {
    sessionId,
    png,
    metadata
  }),
  stopSession: (sessionId, input) => ipcRenderer.invoke('workshop:stop', { sessionId, input }),
  transcribeSession: (sessionId) => ipcRenderer.invoke('workshop:transcribe', sessionId),
  recoverSession: (sessionId) => ipcRenderer.invoke('workshop:recover', sessionId),
  downloadModel: () => ipcRenderer.invoke('transcription:download-model'),
  setRecordingActive: (sessionId, active) => ipcRenderer.invoke('workshop:set-active', { sessionId, active }),
  onProgress: (callback) => on('workshop:progress', callback),
  onScreenshotShortcut: (callback) => on('workshop:screenshot-shortcut', callback),
  onForceStop: (callback) => on('workshop:force-stop', callback),
  onRecoverableSessions: (callback) => on('workshop:recoverable', callback)
});
