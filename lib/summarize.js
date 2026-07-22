const ACTION_PATTERNS = [
  /\b(todo|to-do|action item|aufgabe|nächste[rn]? schritt)\b/i,
  /\b(ich|wir|du|ihr|[A-ZÄÖÜ][a-zäöüß-]+)\s+(übernehme|übernimmt|kümmere|kümmert|erstelle|erstellt|prüfe|prüft|kläre|klärt|schicke|schickt|sende|sendet|mache|macht|werde|werden)\b/i,
  /\b(muss|müssen|soll|sollen|bitte|bis\s+(montag|dienstag|mittwoch|donnerstag|freitag|morgen|nächste))\b/i
];

const DECISION_PATTERNS = [
  /\b(entschieden|beschlossen|wir machen|wir nehmen|wir nutzen|festgelegt|entscheidung|einigen uns)\b/i
];

function normalizeText(text = '') {
  return text
    .replace(/^WEBVTT.*$/gim, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->.*$/gm, '')
    .replace(/<v\s+([^>]+)>/gi, '$1: ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractParticipants(text = '') {
  const names = new Set();
  for (const match of text.matchAll(/<v\s+([^>]+)>/gi)) names.add(match[1].trim());
  for (const line of normalizeText(text).split('\n')) {
    const match = line.match(/^([A-ZÄÖÜ][\p{L} .'-]{1,50}):\s+/u);
    if (match) names.add(match[1].trim());
  }
  return [...names].slice(0, 20);
}

function sentenceCandidates(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25 && sentence.length <= 420);
}

function cleanSentence(sentence) {
  return sentence.replace(/^[-–—•*\s]+/, '').replace(/\s+/g, ' ').trim();
}

function parseOwner(sentence) {
  const speaker = sentence.match(/^([A-ZÄÖÜ][\p{L} .'-]{1,45}):/u)?.[1];
  const actor = sentence.match(/\b([A-ZÄÖÜ][a-zäöüß-]+)\s+(?:übernimmt|kümmert|erstellt|prüft|klärt|schickt|sendet|macht)\b/u)?.[1];
  return actor || speaker || '';
}

function localSummary(transcript) {
  const sentences = sentenceCandidates(transcript);
  const todos = sentences
    .filter((sentence) => ACTION_PATTERNS.some((pattern) => pattern.test(sentence)))
    .slice(0, 8)
    .map((sentence, index) => ({
      id: `todo-${Date.now()}-${index}`,
      text: cleanSentence(sentence),
      owner: parseOwner(sentence),
      due: '',
      done: false
    }));

  const decisions = sentences
    .filter((sentence) => DECISION_PATTERNS.some((pattern) => pattern.test(sentence)))
    .slice(0, 5)
    .map(cleanSentence);

  const ranked = sentences
    .map((sentence, index) => ({
      sentence: cleanSentence(sentence),
      score: (ACTION_PATTERNS.some((pattern) => pattern.test(sentence)) ? 3 : 0)
        + (DECISION_PATTERNS.some((pattern) => pattern.test(sentence)) ? 4 : 0)
        + (index < 8 ? 2 : 0)
        + Math.min(sentence.length / 160, 1)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .sort((a, b) => sentences.indexOf(a.sentence) - sentences.indexOf(b.sentence))
    .map(({ sentence }) => sentence);

  return {
    summary: ranked.length ? ranked.join(' ') : 'Für dieses Transkript konnte lokal noch keine belastbare Zusammenfassung erzeugt werden.',
    todos,
    decisions,
    topics: [],
    summaryProvider: 'local'
  };
}

function getOutputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text)
    .join('');
}

async function aiSummary(transcript, env) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      decisions: { type: 'array', items: { type: 'string' } },
      topics: { type: 'array', items: { type: 'string' } },
      todos: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            owner: { type: 'string' },
            due: { type: 'string' }
          },
          required: ['text', 'owner', 'due']
        }
      }
    },
    required: ['summary', 'decisions', 'topics', 'todos']
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5.6-luna',
      reasoning: { effort: 'low' },
      instructions: 'Du analysierst deutsch- oder englischsprachige Meeting-Transkripte. Fasse präzise auf Deutsch zusammen. Erfinde nichts. Extrahiere nur explizite Entscheidungen und Aufgaben. Wenn Verantwortliche oder Termine fehlen, nutze einen leeren String.',
      input: `MEETING-TRANSKRIPT:\n\n${normalizeText(transcript).slice(0, 120000)}`,
      text: {
        verbosity: 'low',
        format: { type: 'json_schema', name: 'meeting_summary', strict: true, schema }
      }
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${message.slice(0, 300)}`);
  }

  const payload = await response.json();
  const parsed = JSON.parse(getOutputText(payload));
  return {
    ...parsed,
    todos: parsed.todos.map((todo, index) => ({
      id: `todo-${Date.now()}-${index}`,
      ...todo,
      done: false
    })),
    summaryProvider: 'openai'
  };
}

export async function summarize(transcript, env = process.env) {
  if (env.OPENAI_API_KEY) {
    try {
      return await aiSummary(transcript, env);
    } catch (error) {
      return { ...localSummary(transcript), summaryError: error.message };
    }
  }
  return localSummary(transcript);
}

export { normalizeText };
