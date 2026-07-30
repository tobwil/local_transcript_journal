import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { initWhisper, loadWhisperModule } from '@fugood/whisper.node';
import { modelsDirectory } from './data-paths.js';
import {
  deleteWorkshopAudio,
  readWorkshopSession,
  sessionDirectory,
  updateWorkshopSession
} from './workshop-store.js';
import { extractParticipants, summarize } from './summarize.js';
import { updateState } from './store.js';

export const TRANSCRIPTION_MODEL = {
  id: 'large-v3-turbo-q5_0',
  fileName: 'ggml-large-v3-turbo-q5_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  bytes: 574041195,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
};

function ffmpegPath() {
  const unpacked = ffmpegStatic?.replace('app.asar', 'app.asar.unpacked');
  return unpacked || ffmpegStatic;
}

export function transcriptionModelPath() {
  return path.join(modelsDirectory(), TRANSCRIPTION_MODEL.fileName);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getTranscriptionStatus() {
  const modelPath = transcriptionModelPath();
  const modelInfo = await stat(modelPath).catch(() => null);
  const ffmpeg = ffmpegPath();
  let runtimeError = null;
  try {
    await loadWhisperModule();
  } catch (error) {
    runtimeError = error.message;
  }
  const runtimeAvailable = !runtimeError;
  return {
    ready: Boolean(runtimeAvailable && modelInfo?.isFile() && modelInfo.size === TRANSCRIPTION_MODEL.bytes && ffmpeg && await exists(ffmpeg)),
    runtime: {
      available: runtimeAvailable,
      error: runtimeError
    },
    model: {
      ...TRANSCRIPTION_MODEL,
      path: modelPath,
      installed: Boolean(modelInfo?.isFile() && modelInfo.size === TRANSCRIPTION_MODEL.bytes),
      installedBytes: modelInfo?.size || 0
    },
    ffmpeg: {
      path: ffmpeg,
      available: Boolean(ffmpeg && await exists(ffmpeg))
    }
  };
}

function report(onProgress, phase, progress, message) {
  onProgress?.({ phase, progress: Math.max(0, Math.min(100, Math.round(progress))), message });
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadTranscriptionModel(onProgress) {
  await mkdir(modelsDirectory(), { recursive: true });
  const target = transcriptionModelPath();
  const partial = `${target}.part`;
  let existing = (await stat(partial).catch(() => null))?.size || 0;
  if (existing === TRANSCRIPTION_MODEL.bytes) {
    report(onProgress, 'model-verify', 99, 'Vorhandener Download wird verifiziert …');
    if (await sha256(partial) === TRANSCRIPTION_MODEL.sha256) {
      await rename(partial, target);
      report(onProgress, 'model', 100, 'Transkriptionsmodell ist einsatzbereit.');
      return getTranscriptionStatus();
    }
    await unlink(partial).catch(() => {});
    existing = 0;
  } else if (existing > TRANSCRIPTION_MODEL.bytes) {
    await unlink(partial).catch(() => {});
    existing = 0;
  }
  const headers = existing ? { Range: `bytes=${existing}-` } : {};
  report(onProgress, 'model', existing / TRANSCRIPTION_MODEL.bytes * 100, 'Transkriptionsmodell wird geladen …');
  const response = await fetch(TRANSCRIPTION_MODEL.url, { headers, redirect: 'follow' });
  if (!response.ok && response.status !== 206) throw new Error(`Modelldownload fehlgeschlagen (${response.status}).`);
  const append = existing > 0 && response.status === 206;
  const stream = createWriteStream(partial, { flags: append ? 'a' : 'w' });
  let received = append ? existing : 0;
  let lastReportedAt = 0;
  let lastReportedPercent = -1;
  try {
    for await (const chunk of response.body) {
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
      received += chunk.length;
      const percent = Math.floor(received / TRANSCRIPTION_MODEL.bytes * 100);
      if (Date.now() - lastReportedAt >= 180 || percent !== lastReportedPercent) {
        report(onProgress, 'model', percent, `Transkriptionsmodell: ${Math.min(received, TRANSCRIPTION_MODEL.bytes).toLocaleString('de-DE')} von ${TRANSCRIPTION_MODEL.bytes.toLocaleString('de-DE')} Bytes`);
        lastReportedAt = Date.now();
        lastReportedPercent = percent;
      }
    }
    await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
  } catch (error) {
    stream.destroy();
    throw error;
  }
  const info = await stat(partial);
  if (info.size !== TRANSCRIPTION_MODEL.bytes) {
    throw new Error(`Modelldownload unvollständig (${info.size} statt ${TRANSCRIPTION_MODEL.bytes} Bytes).`);
  }
  report(onProgress, 'model-verify', 99, 'Modell wird verifiziert …');
  const digest = await sha256(partial);
  if (digest !== TRANSCRIPTION_MODEL.sha256) {
    await unlink(partial).catch(() => {});
    throw new Error('Die Prüfsumme des Transkriptionsmodells stimmt nicht. Bitte erneut laden.');
  }
  await rename(partial, target);
  report(onProgress, 'model', 100, 'Transkriptionsmodell ist einsatzbereit.');
  return getTranscriptionStatus();
}

function runProcess(command, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errorText = `${errorText}${chunk}`.slice(-8000);
      const match = chunk.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (match) report(onProgress, 'audio', 10, 'Audio wird für die Transkription vorbereitet …');
    });
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`Audiokonvertierung fehlgeschlagen (${code}): ${errorText.trim().slice(-1000)}`)));
  });
}

function formatTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':');
}

function transcriptMarkdown(segments) {
  return segments
    .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text.trim()}`)
    .join('\n\n');
}

function recapMarkdown(session, analysis, transcript, screenshots) {
  const todos = (analysis.todos || []).map((todo) => `- [ ] ${todo.text}${todo.owner ? ` — ${todo.owner}` : ''}`).join('\n') || '- Keine konkreten Aufgaben erkannt.';
  const decisions = (analysis.decisions || []).map((decision) => `- ${decision}`).join('\n') || '- Keine expliziten Entscheidungen erkannt.';
  const visuals = screenshots.map((item) => `- ${formatTimestamp(item.offsetMs / 1000)} — ![${item.windowName}](${item.file})`).join('\n') || '- Keine Screenshots aufgenommen.';
  return `# ${session.title}

${analysis.summary}

## Entscheidungen

${decisions}

## Aufgaben

${todos}

## Screenshots

${visuals}

## Transkript

${transcript}
`;
}

function bestAudioTrack(session) {
  for (const name of ['mixed', 'microphone', 'system']) {
    const track = session.tracks?.[name];
    if (track?.bytes > 1000 && track.file) return path.join(sessionDirectory(session.id), track.file);
  }
  return null;
}

export async function transcribeWorkshop(sessionId, onProgress) {
  const status = await getTranscriptionStatus();
  if (!status.ready) throw new Error('Die lokale Transkription ist noch nicht eingerichtet. Bitte zuerst das Modell laden.');
  let session = await updateWorkshopSession(sessionId, (next) => {
    next.status = 'processing';
    next.error = null;
    return next;
  });
  const audioInput = bestAudioTrack(session);
  if (!audioInput) throw new Error('Für diesen Workshop wurde keine verwertbare Audiospur gespeichert.');
  const root = sessionDirectory(sessionId);
  const wavFile = path.join(root, 'audio', 'transcription.wav');
  try {
    report(onProgress, 'audio', 2, 'Audio wird vorbereitet …');
    await runProcess(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'warning', '-y',
      '-i', audioInput,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      wavFile
    ], onProgress);
    report(onProgress, 'transcription', 12, 'Whisper-Modell wird geladen …');
    const context = await initWhisper({
      filePath: transcriptionModelPath(),
      useGpu: process.platform === 'darwin',
      useFlashAttn: true
    });
    let raw;
    try {
      const task = context.transcribeFile(wavFile, {
        language: session.language || 'de',
        temperature: 0,
        maxThreads: Math.max(2, Math.min(8, os.cpus().length - 2)),
        tokenTimestamps: true,
        onProgress(progress) {
          report(onProgress, 'transcription', 12 + progress * 0.72, `Transkription läuft … ${Math.round(progress)} %`);
        }
      });
      raw = await task.promise;
    } finally {
      await context.release();
    }
    if (raw.isAborted) throw new Error('Die Transkription wurde abgebrochen.');
    const segments = (raw.segments || []).map((segment) => ({
      start: Number(segment.t0 || 0) / 1000,
      end: Number(segment.t1 || 0) / 1000,
      text: String(segment.text || '').trim()
    })).filter((segment) => segment.text);
    const transcript = transcriptMarkdown(segments) || String(raw.result || '').trim();
    if (transcript.length < 10) throw new Error('In der Aufnahme konnte keine verständliche Sprache erkannt werden.');
    report(onProgress, 'summary', 86, 'Recap und Aufgaben werden erzeugt …');
    const analysis = await summarize(transcript);
    const participants = session.participants?.length ? session.participants : extractParticipants(transcript);
    const now = new Date().toISOString();
    const entryId = randomUUID();
    const screenshots = (session.screenshots || []).map((item) => ({
      ...item,
      url: `/api/workshops/${session.id}/assets/${item.file.split('/').map(encodeURIComponent).join('/')}`
    }));
    const entry = {
      id: entryId,
      externalId: `workshop:${session.id}`,
      workshopId: session.id,
      source: 'workshop',
      title: session.title,
      occurredAt: session.startedAt,
      createdAt: now,
      updatedAt: now,
      participants,
      notes: session.notes || '',
      transcript,
      transcriptSegments: segments,
      screenshots,
      recording: {
        durationMs: session.durationMs,
        captureMode: session.captureMode,
        sourceName: session.source?.name || '',
        warnings: session.warnings || [],
        audioRetention: 'deleted-after-transcription'
      },
      ...analysis
    };
    await Promise.all([
      writeFile(path.join(root, 'transcript.json'), JSON.stringify({ language: raw.language || session.language, segments, transcript }, null, 2)),
      writeFile(path.join(root, 'transcript.md'), `${transcript}\n`),
      writeFile(path.join(root, 'recap.md'), recapMarkdown(session, analysis, transcript, screenshots))
    ]);
    await updateState((state) => {
      const existing = state.entries.findIndex((item) => item.externalId === entry.externalId);
      if (existing >= 0) state.entries[existing] = { ...state.entries[existing], ...entry, id: state.entries[existing].id };
      else state.entries.unshift(entry);
      return state;
    });
    report(onProgress, 'cleanup', 98, 'Temporäre Audiodateien werden gelöscht …');
    session = await deleteWorkshopAudio(sessionId, { complete: true, entryId });
    report(onProgress, 'complete', 100, 'Workshop-Recap ist fertig.');
    return { session, entry };
  } catch (error) {
    await updateWorkshopSession(sessionId, (next) => {
      next.status = 'error';
      next.error = error.message;
      return next;
    }).catch(() => {});
    throw error;
  }
}
