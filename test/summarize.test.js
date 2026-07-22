import test from 'node:test';
import assert from 'node:assert/strict';
import { extractParticipants, normalizeText, summarize } from '../lib/summarize.js';

const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Anna Schmidt>Wir haben entschieden, den Launch auf Freitag zu legen.</v>

00:00:05.000 --> 00:00:08.000
<v Boris Klein>Ich übernehme die finale Prüfung bis Donnerstag.</v>`;

test('bereinigt VTT-Markup', () => {
  const text = normalizeText(vtt);
  assert.match(text, /Anna Schmidt:/);
  assert.doesNotMatch(text, /WEBVTT|-->/);
});

test('erkennt Teilnehmende', () => {
  assert.deepEqual(extractParticipants(vtt), ['Anna Schmidt', 'Boris Klein']);
});

test('erzeugt lokale Entscheidungen und Todos', async () => {
  const result = await summarize(vtt, {});
  assert.equal(result.summaryProvider, 'local');
  assert.equal(result.decisions.length, 1);
  assert.equal(result.todos.length, 1);
  assert.equal(result.todos[0].owner, 'Boris Klein');
});
