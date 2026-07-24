const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

const desktop = window.workshopDesktop;
const runtime = {
  selectedSource: null,
  session: null,
  displayStream: null,
  microphoneStream: null,
  audioContext: null,
  recorders: [],
  writeChains: new Map(),
  startedAt: 0,
  timer: null,
  screenshotCount: 0,
  warnings: [],
  stopping: false,
  recoverable: []
};

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function stopMedia() {
  for (const stream of [runtime.displayStream, runtime.microphoneStream]) {
    for (const track of stream?.getTracks?.() || []) track.stop();
  }
  runtime.displayStream = null;
  runtime.microphoneStream = null;
  $('#capturePreview').srcObject = null;
  runtime.audioContext?.close().catch(() => {});
  runtime.audioContext = null;
}

function supportedMimeType() {
  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'video/webm;codecs=opus',
    'video/webm'
  ].find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function createDiskRecorder(trackName, stream) {
  if (!stream?.getAudioTracks().length) return null;
  const mimeType = supportedMimeType();
  const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), mimeType ? {
    mimeType,
    audioBitsPerSecond: 128000
  } : undefined);
  runtime.writeChains.set(trackName, Promise.resolve());
  recorder.addEventListener('dataavailable', (event) => {
    if (!event.data?.size) return;
    const next = runtime.writeChains.get(trackName)
      .then(async () => {
        const chunk = await event.data.arrayBuffer();
        await desktop.appendAudio(runtime.session.id, trackName, chunk, recorder.mimeType);
      });
    runtime.writeChains.set(trackName, next);
    next.catch((error) => {
      runtime.warnings.push(`Audiospur ${trackName}: ${error.message}`);
    });
  });
  recorder.start(5000);
  return recorder;
}

async function stopRecorder(recorder) {
  if (!recorder || recorder.state === 'inactive') return;
  await new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
    try {
      recorder.requestData();
      recorder.stop();
    } catch {
      resolve();
    }
  });
}

function updateTimer() {
  $('#recordingTimer').textContent = formatDuration(performance.now() - runtime.startedAt);
}

function progress(payload) {
  const dialog = $('#processingDialog');
  $('#processingMessage').textContent = payload.message || 'Verarbeitung läuft …';
  const value = Math.max(0, Math.min(100, Number(payload.progress) || 0));
  $('#processingProgress').style.width = `${value}%`;
  $('#processingPercent').textContent = `${Math.round(value)} %`;
  if (!dialog.open) dialog.showModal();
}

function preflightItem(ok, title, detail) {
  return `<div class="preflight-item ${ok ? '' : 'warning'}">
    <span class="preflight-icon">${ok ? '✓' : '!'}</span>
    <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span>
  </div>`;
}

async function refreshStatus() {
  const status = await desktop.getStatus();
  const microphoneOk = ['granted', 'not-determined', 'unknown'].includes(status.permissions.microphone);
  const screenOk = ['granted', 'not-determined', 'unknown'].includes(status.permissions.screen);
  const modelOk = status.transcription.ready;
  $('#workshopPreflight').innerHTML = [
    preflightItem(microphoneOk, 'Mikrofon', status.permissions.microphone === 'granted' ? 'Zugriff erteilt' : status.permissions.microphone === 'denied' ? 'In Systemeinstellungen gesperrt' : 'Wird beim Start angefragt'),
    preflightItem(screenOk, 'Fensteraufnahme', status.permissions.screen === 'granted' ? 'Zugriff erteilt' : status.permissions.screen === 'denied' ? 'In Systemeinstellungen gesperrt' : 'Wird bei der Fensterwahl angefragt'),
    preflightItem(modelOk, 'Lokales Whisper', modelOk ? 'Metal-beschleunigt bereit' : 'Modell muss einmal geladen werden')
  ].join('');
  $('#modelSetupBox').classList.toggle('hidden', modelOk);
  $('#startWorkshopButton').disabled = !modelOk;
  return status;
}

async function openWorkshopDialog() {
  if (!desktop) return;
  const form = $('#workshopForm');
  form.reset();
  form.elements.microphone.checked = true;
  form.elements.system.checked = true;
  form.elements.window.checked = true;
  form.elements.language.value = 'de';
  form.elements.title.value = `Workshop ${new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date())}`;
  runtime.selectedSource = null;
  $('#selectedWindowName').textContent = 'Noch kein Fenster ausgewählt';
  $('#workshopError').textContent = '';
  await refreshStatus();
  $('#workshopDialog').showModal();
}

async function chooseSource() {
  $('#sourceError').textContent = '';
  $('#sourceGrid').innerHTML = '<p class="none-note">Verfügbare Fenster werden geladen …</p>';
  $('#sourceDialog').showModal();
  try {
    const sources = await desktop.listCaptureSources();
    if (!sources.length) throw new Error('Keine erfassbaren Fenster gefunden. Prüfe die Berechtigung „Bildschirm- & Systemaudioaufnahme“.');
    $('#sourceGrid').innerHTML = sources.map((source) => `
      <button class="source-option" type="button" data-source-id="${escapeHtml(source.id)}">
        ${source.thumbnail ? `<img src="${source.thumbnail}" alt="" />` : '<span class="source-placeholder">Keine Vorschau</span>'}
        <span>${source.appIcon ? `<img src="${source.appIcon}" alt="" />` : ''}${escapeHtml(source.name)}</span>
      </button>`).join('');
    $$('[data-source-id]', $('#sourceGrid')).forEach((button) => button.addEventListener('click', async () => {
      try {
        runtime.selectedSource = await desktop.selectCaptureSource(button.dataset.sourceId);
        $('#selectedWindowName').textContent = runtime.selectedSource.name;
        $('#sourceDialog').close();
        await refreshStatus();
      } catch (error) {
        $('#sourceError').textContent = error.message;
      }
    }));
  } catch (error) {
    $('#sourceError').textContent = error.message;
  }
}

async function acquireStreams(config) {
  let displayStream = null;
  let microphoneStream = null;
  try {
    if (config.window || config.system) {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 8, max: 12 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: config.system
      });
      if (!displayStream.getVideoTracks().length) throw new Error('Das ausgewählte Fenster konnte nicht erfasst werden.');
      if (config.system && !displayStream.getAudioTracks().length) {
        throw new Error('macOS hat keine Systemaudiospur bereitgestellt. Erlaube „Bildschirm- & Systemaudioaufnahme“ für Workshop Journal und starte die App danach neu.');
      }
    }
    if (config.microphone) {
      const allowed = await desktop.requestMicrophonePermission();
      if (!allowed) throw new Error('Der Mikrofonzugriff wurde nicht erteilt.');
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });
      if (!microphoneStream.getAudioTracks().length) throw new Error('Kein Mikrofon-Audiokanal verfügbar.');
    }
    return { displayStream, microphoneStream };
  } catch (error) {
    for (const stream of [displayStream, microphoneStream]) {
      for (const track of stream?.getTracks?.() || []) track.stop();
    }
    throw error;
  }
}

async function buildMixedStream(streams) {
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  await context.resume();
  const destination = context.createMediaStreamDestination();
  let connected = 0;
  for (const stream of streams) {
    if (!stream?.getAudioTracks().length) continue;
    const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const gain = context.createGain();
    gain.gain.value = 1;
    source.connect(gain).connect(destination);
    connected += 1;
  }
  if (!connected) {
    await context.close();
    throw new Error('Es wurde keine Audiospur ausgewählt.');
  }
  runtime.audioContext = context;
  return destination.stream;
}

async function startWorkshop(event) {
  event.preventDefault();
  if (runtime.session || runtime.stopping) return;
  const form = event.currentTarget;
  const config = {
    microphone: form.elements.microphone.checked,
    system: form.elements.system.checked,
    window: form.elements.window.checked
  };
  $('#workshopError').textContent = '';
  if (!config.microphone && !config.system) {
    $('#workshopError').textContent = 'Wähle mindestens Mikrofon oder Systemaudio aus.';
    return;
  }
  if ((config.window || config.system) && !runtime.selectedSource) {
    $('#workshopError').textContent = 'Bitte wähle zuerst das Workshop-Fenster aus.';
    return;
  }
  const button = $('#startWorkshopButton');
  button.disabled = true;
  button.textContent = 'Berechtigungen werden geprüft …';
  try {
    const streams = await acquireStreams(config);
    runtime.displayStream = streams.displayStream;
    runtime.microphoneStream = streams.microphoneStream;
    if (runtime.displayStream) {
      const preview = $('#capturePreview');
      preview.srcObject = runtime.displayStream;
      await preview.play();
    }
    const mixedStream = await buildMixedStream([runtime.displayStream, runtime.microphoneStream]);
    runtime.session = await desktop.createSession({
      title: form.elements.title.value,
      participants: form.elements.participants.value.split(',').map((item) => item.trim()).filter(Boolean),
      notes: form.elements.notes.value,
      language: form.elements.language.value,
      captureMode: config,
      source: runtime.selectedSource
    });
    runtime.recorders = [
      createDiskRecorder('mixed', mixedStream),
      createDiskRecorder('microphone', runtime.microphoneStream),
      createDiskRecorder('system', runtime.displayStream)
    ].filter(Boolean);
    runtime.startedAt = performance.now();
    runtime.screenshotCount = 0;
    runtime.warnings = [];
    runtime.stopping = false;
    runtime.displayStream?.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (!runtime.stopping && runtime.session) stopWorkshop({ reason: 'Fensterfreigabe wurde beendet.' });
    });
    await desktop.setRecordingActive(runtime.session.id, true);
    $('#workshopDialog').close();
    $('#recordingWindowName').textContent = runtime.selectedSource?.name || 'Nur Mikrofon';
    $('#screenshotCount').textContent = '0 Screenshots';
    $('#takeScreenshotButton').disabled = !config.window;
    $('#recordingBar').classList.remove('hidden');
    updateTimer();
    runtime.timer = setInterval(updateTimer, 500);
  } catch (error) {
    stopMedia();
    runtime.session = null;
    $('#workshopError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = '<span class="record-dot"></span>Aufnahme starten';
  }
}

async function screenshotBlob() {
  const video = $('#capturePreview');
  if (!runtime.displayStream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
    throw new Error('Vom ausgewählten Fenster ist noch kein Bild verfügbar.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Screenshot konnte nicht erzeugt werden.')),
    'image/png'
  ));
}

async function takeScreenshot() {
  if (!runtime.session || runtime.stopping) return;
  const button = $('#takeScreenshotButton');
  button.disabled = true;
  try {
    const blob = await screenshotBlob();
    const png = await blob.arrayBuffer();
    await desktop.saveScreenshot(runtime.session.id, png, {
      offsetMs: performance.now() - runtime.startedAt,
      windowName: runtime.selectedSource?.name || 'Workshop-Fenster',
      width: $('#capturePreview').videoWidth,
      height: $('#capturePreview').videoHeight
    });
    runtime.screenshotCount += 1;
    $('#screenshotCount').textContent = `${runtime.screenshotCount} ${runtime.screenshotCount === 1 ? 'Screenshot' : 'Screenshots'}`;
    const bar = $('#recordingBar');
    bar.classList.remove('flash');
    requestAnimationFrame(() => bar.classList.add('flash'));
  } catch (error) {
    window.dispatchEvent(new CustomEvent('workshop-error', { detail: error.message }));
  } finally {
    button.disabled = false;
  }
}

async function stopWorkshop({ reason = '' } = {}) {
  if (!runtime.session || runtime.stopping) return;
  runtime.stopping = true;
  const sessionId = runtime.session.id;
  clearInterval(runtime.timer);
  $('#stopWorkshopButton').disabled = true;
  $('#takeScreenshotButton').disabled = true;
  const durationMs = performance.now() - runtime.startedAt;
  if (reason) runtime.warnings.push(reason);
  try {
    await Promise.all(runtime.recorders.map(stopRecorder));
    await Promise.all([...runtime.writeChains.values()]);
    await desktop.setRecordingActive(sessionId, false);
    stopMedia();
    await desktop.stopSession(sessionId, { durationMs, warnings: runtime.warnings });
    $('#recordingBar').classList.add('hidden');
    runtime.session = null;
    runtime.recorders = [];
    runtime.writeChains.clear();
    $('#processingTitle').textContent = 'Workshop wird transkribiert';
    progress({ progress: 1, message: 'Audiodateien werden sicher abgeschlossen …' });
    const result = await desktop.transcribeSession(sessionId);
    $('#processingDialog').close();
    window.dispatchEvent(new CustomEvent('workshop-complete', { detail: result }));
  } catch (error) {
    if ($('#processingDialog').open) $('#processingDialog').close();
    window.dispatchEvent(new CustomEvent('workshop-error', { detail: error.message }));
  } finally {
    await desktop.setRecordingActive(sessionId, false).catch(() => {});
    stopMedia();
    $('#recordingBar').classList.add('hidden');
    runtime.session = null;
    runtime.recorders = [];
    runtime.writeChains.clear();
    runtime.stopping = false;
    $('#stopWorkshopButton').disabled = false;
  }
}

async function downloadModel() {
  const button = $('#downloadModelButton');
  button.disabled = true;
  button.textContent = 'Download läuft …';
  $('#processingTitle').textContent = 'Transkriptionsmodell wird geladen';
  progress({ progress: 0, message: 'Download wird gestartet …' });
  try {
    await desktop.downloadModel();
    $('#processingDialog').close();
    await refreshStatus();
  } catch (error) {
    if ($('#processingDialog').open) $('#processingDialog').close();
    $('#workshopError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Modell laden';
  }
}

function showRecovery(sessions) {
  runtime.recoverable = sessions.filter((session) => session.status !== 'complete');
  const session = runtime.recoverable[0];
  if (!session || $('#recoveryDialog').open) return;
  const started = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.startedAt));
  $('#recoveryMessage').textContent = `„${session.title}“ vom ${started} wurde nicht vollständig verarbeitet. Die gespeicherte Audiodatei kann jetzt transkribiert werden.`;
  $('#recoveryDialog').showModal();
}

async function recoverWorkshop() {
  const session = runtime.recoverable.shift();
  if (!session) return;
  $('#recoveryDialog').close();
  $('#processingTitle').textContent = 'Aufnahme wird wiederhergestellt';
  progress({ progress: 1, message: 'Gespeicherte Audiodaten werden geprüft …' });
  try {
    const result = await desktop.recoverSession(session.id);
    $('#processingDialog').close();
    window.dispatchEvent(new CustomEvent('workshop-complete', { detail: result }));
  } catch (error) {
    if ($('#processingDialog').open) $('#processingDialog').close();
    window.dispatchEvent(new CustomEvent('workshop-error', { detail: error.message }));
  }
}

export function initWorkshopRecorder() {
  if (!desktop) {
    $('#recordWorkshopButton')?.classList.add('hidden');
    $$('[data-record-workshop]').forEach((button) => button.classList.add('hidden'));
    return;
  }
  $('#recordWorkshopButton').addEventListener('click', openWorkshopDialog);
  $$('[data-record-workshop]').forEach((button) => button.addEventListener('click', openWorkshopDialog));
  $('#chooseWindowButton').addEventListener('click', chooseSource);
  $('#workshopForm').addEventListener('submit', startWorkshop);
  $('#downloadModelButton').addEventListener('click', downloadModel);
  $('#takeScreenshotButton').addEventListener('click', takeScreenshot);
  $('#stopWorkshopButton').addEventListener('click', () => stopWorkshop());
  $('#recoverWorkshopButton').addEventListener('click', recoverWorkshop);
  $('#dismissRecoveryButton').addEventListener('click', () => $('#recoveryDialog').close());
  const updateWindowRequirement = () => {
    const form = $('#workshopForm');
    $('#windowSelection').classList.toggle('hidden', !(form.elements.window.checked || form.elements.system.checked));
  };
  $('#workshopForm').elements.window.addEventListener('change', updateWindowRequirement);
  $('#workshopForm').elements.system.addEventListener('change', updateWindowRequirement);
  desktop.onProgress(progress);
  desktop.onScreenshotShortcut(takeScreenshot);
  desktop.onForceStop((payload) => stopWorkshop({ reason: payload?.reason === 'system-suspend' ? 'Der Mac wurde in den Ruhezustand versetzt.' : 'Die Aufnahme wurde beim Schließen beendet.' }));
  desktop.onRecoverableSessions(showRecovery);
  desktop.getStatus().then((status) => {
    if (status.recoverable?.length) showRecovery(status.recoverable);
  }).catch(() => {});
}
