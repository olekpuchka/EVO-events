// Event times: finding "22:00" in an @all message, resolving it to a timestamp in the poster's
// zone, and writing both zones back into the pinned text. Touches only the clock — no Telegram,
// no database, no network.

import { EU_TIMEZONE_MEMBERS } from "../config.ts";

// Poster timezones. Everyone defaults to Kyiv; the members listed in EU_TIMEZONE_MEMBERS
// (comma-separated Telegram user IDs) type their event times in Central European Time instead.
const DEFAULT_TZ = 'Europe/Kyiv';
const EU_TZ = 'CET';

const euTimezoneMembers = new Set(
  EU_TIMEZONE_MEMBERS
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(id => {
      // Warn instead of silently dropping — a typo'd or non-numeric entry (e.g. a @username)
      // never matches a real user ID, so the member would stay on Kyiv with no signal why.
      if (/^\d+$/.test(id)) return true;
      console.warn(`[tz] Ignoring invalid EU_TIMEZONE_MEMBERS entry "${id}" — expected a numeric Telegram user ID.`);
      return false;
    })
);

// The IANA zone a poster's typed time should be interpreted in.
export function timezoneForUser(userId: number | string): string {
  return euTimezoneMembers.has(String(userId)) ? EU_TZ : DEFAULT_TZ;
}

interface EventTimeToken {
  hours: number;
  minutes: number;
  start: number;
  end: number;
}

// First HH:MM / HH-MM in `text` that is a valid clock time and not glued to other digits — so
// scores ("de_dust2 16:99"), version/phone numbers and out-of-range values are skipped rather than
// spawning a phantom event. Returns { hours, minutes, start, end } (indices into `text`) or null.
// Shared by parseEventTime and decorateEventTime so both agree on which token is the event time.
function matchEventTimeToken(text: string): EventTimeToken | null {
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[:-](\d{2})(?!\d)/g)) {
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (hours <= 23 && minutes <= 59) {
      const start = m.index ?? 0;
      return { hours, minutes, start, end: start + m[0].length };
    }
  }
  return null;
}

// Parse the event time from a message, interpreting it in the given IANA zone (default Kyiv).
// Returns Unix timestamp (today or tomorrow in that zone) or null.
export function parseEventTime(text: string, timeZone = DEFAULT_TZ): number | null {
  const token = matchEventTimeToken(text);
  if (!token) return null;
  const { hours, minutes } = token;

  const now = new Date();
  // Get current wall-clock time in the poster's zone (values are correct, JS treats it as system-local)
  const zoneNow = new Date(now.toLocaleString('en-US', { timeZone }));
  const candidate = new Date(zoneNow);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate <= zoneNow) candidate.setDate(candidate.getDate() + 1);

  // Convert back to real UTC: offset = (zoneNow - now) is that zone's tz offset
  const utcMs = candidate.getTime() + (now.getTime() - zoneNow.getTime());
  return Math.floor(utcMs / 1000);
}

// An event's Unix timestamp as HH:MM wall-clock time in the given zone.
function formatTimeIn(unixSeconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  return `${get('hour')}:${get('minute')}`;
}

// Rewrite the time token in an (HTML-escaped) message: "CS 23:30" → "CS 🇺🇦 23:30 (🇪🇺 22:30)". Both
// times read off the resolved timestamp, so an EU poster's typed time still shows right under each
// flag. escapeHtml only rewrites & < >, so matchEventTimeToken's indices stay valid here.
export function decorateEventTime(escapedMessage: string, eventTime: number): string {
  const token = matchEventTimeToken(escapedMessage);
  if (!token) return escapedMessage;
  const bothZones = `🇺🇦 ${formatTimeIn(eventTime, DEFAULT_TZ)} (🇪🇺 ${formatTimeIn(eventTime, EU_TZ)})`;
  return escapedMessage.slice(0, token.start) + bothZones + escapedMessage.slice(token.end);
}
