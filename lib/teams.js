import { randomUUID } from 'node:crypto';
import { extractParticipants, summarize } from './summarize.js';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

async function graphResponse(url, token, accept = 'application/json') {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      Prefer: 'outlook.timezone="UTC"'
    }
  });
  if (!response.ok) {
    const payload = await response.text();
    let detail = payload;
    try {
      const parsed = JSON.parse(payload);
      detail = parsed.error?.message || parsed.error?.innerError?.code || payload;
    } catch {}
    throw new Error(`Microsoft Graph ${response.status}: ${String(detail).slice(0, 500)}`);
  }
  return response;
}

async function graphJson(url, token) {
  return (await graphResponse(url, token)).json();
}

async function graphText(url, token) {
  return (await graphResponse(
    url,
    token,
    'text/vtt, application/vnd.microsoft.graph.transcript+text;q=0.9, text/plain;q=0.8'
  )).text();
}

async function fetchAllPages(url, token) {
  const values = [];
  let next = url;
  while (next) {
    const page = await graphJson(next, token);
    values.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }
  return values;
}

function onlineMeetingLookupUrl(joinUrl) {
  const url = new URL(`${GRAPH_ROOT}/me/onlineMeetings`);
  url.searchParams.set('$filter', `JoinWebUrl eq '${String(joinUrl).replaceAll("'", "''")}'`);
  return url.toString();
}

function calendarViewUrl(days) {
  const start = new Date(Date.now() - days * 86400000).toISOString();
  const end = new Date(Date.now() + 86400000).toISOString();
  const url = new URL(`${GRAPH_ROOT}/me/calendarView`);
  url.searchParams.set('startDateTime', start);
  url.searchParams.set('endDateTime', end);
  url.searchParams.set('$select', 'id,subject,start,end,isOnlineMeeting,onlineMeeting,organizer,attendees');
  url.searchParams.set('$top', '100');
  return url.toString();
}

function eventParticipants(event, transcript) {
  const fromTranscript = extractParticipants(transcript);
  if (fromTranscript.length) return fromTranscript;
  const names = [
    event.organizer?.emailAddress?.name,
    ...(event.attendees || []).map((person) => person.emailAddress?.name)
  ].filter(Boolean);
  return [...new Set(names)].slice(0, 30);
}

export async function syncTeamsWithUserToken(state, accessToken, env = process.env) {
  if (!accessToken || accessToken.length < 40) throw Object.assign(new Error('Microsoft-Anmeldung fehlt oder ist abgelaufen.'), { status: 401 });

  const days = Math.max(1, Number(env.TEAMS_SYNC_LOOKBACK_DAYS || 90));
  const events = await fetchAllPages(calendarViewUrl(days), accessToken);
  const teamsEvents = events.filter((event) => event.isOnlineMeeting && event.onlineMeeting?.joinUrl);
  const known = new Set(state.entries.map((entry) => entry.externalId).filter(Boolean));
  let imported = 0;
  let found = 0;
  const warnings = [];

  for (const event of teamsEvents) {
    try {
      const meetingResult = await graphJson(onlineMeetingLookupUrl(event.onlineMeeting.joinUrl), accessToken);
      const meeting = meetingResult.value?.[0];
      if (!meeting?.id) continue;

      const transcripts = await fetchAllPages(
        `${GRAPH_ROOT}/me/onlineMeetings/${encodeURIComponent(meeting.id)}/transcripts`,
        accessToken
      );
      found += transcripts.length;

      for (const item of transcripts) {
        const externalId = `teams:${meeting.id}:${item.id}`;
        if (known.has(externalId)) continue;
        const contentUrl = item.transcriptContentUrl?.startsWith('http')
          ? item.transcriptContentUrl
          : `${GRAPH_ROOT}${item.transcriptContentUrl || ''}`;
        if (!item.transcriptContentUrl) continue;

        const transcript = await graphText(contentUrl, accessToken);
        if (!transcript.trim()) continue;
        const analysis = await summarize(transcript, env);
        const occurredAt = event.start?.dateTime || item.createdDateTime || new Date().toISOString();
        state.entries.unshift({
          id: randomUUID(),
          externalId,
          source: 'teams',
          title: event.subject || meeting.subject || 'Teams-Meeting',
          occurredAt: new Date(occurredAt).toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          participants: eventParticipants(event, transcript),
          notes: '',
          transcript,
          ...analysis
        });
        known.add(externalId);
        imported += 1;
      }
    } catch (error) {
      warnings.push(`${event.subject || 'Teams-Meeting'}: ${error.message}`);
    }
  }

  if (!found && warnings.length && warnings.every((warning) => /403|Forbidden|Authorization/i.test(warning))) {
    throw new Error(warnings[0]);
  }
  return { state, imported, found, meetings: teamsEvents.length, warnings: warnings.slice(0, 5) };
}
