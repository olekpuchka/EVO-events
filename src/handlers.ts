import { trackMember, getMembers, setNotifications, getNotificationsStatus, saveEvent, saveRsvp, getRsvps, getUserRsvpStatus, getEventBaseText, scheduleUnpin, scheduleReminder, getActiveEvent, deleteEventData, getReminderMessageId, setFaceitAccount, getFaceitMembers, hasPostedMatch, markMatchPosted } from "./db.ts";
import { buildMention, escapeHtml, sendEphemeral } from "./helpers.ts";
import type { Mentionable } from "./helpers.ts";
import { getPlayer, getPlayerById, getRecentMatches, getMatchStats, getMatchDetails, getMapName, getMapImage, matchRoomUrl } from "./faceit.ts";
import { generateHypePhrase, generateMatchPhrase } from "./ai.ts";
import { t } from "./i18n.ts";
import type {
  Context,
  Api,
  HearsContext,
  CommandContext,
  CallbackQueryContext,
} from "grammy";
import type {
  Message,
  InlineKeyboardMarkup,
  RichText,
  RichBlockTableCell,
} from "@grammyjs/types";
import type {
  RsvpRow,
  EventRow,
  FaceitMatchStats,
  FaceitMatchDetails,
  EloPair,
  MatchFlow,
  MatchPlayer,
  ResultRow,
  MatchResult,
} from "./types.ts";

// Anything with a status that can also be mentioned — covers both RSVP rows and
// the poster's synthetic "auto-join" entry ({ ...ctx.from, status: "join" }).
type RsvpLike = Mentionable & { status: string };

// Per-member Elo tracking during a poll (see autoPostResult).
interface RegEntry {
  userId: number;
  preElo: number | null;
  postElo: number | null;
}

// The exact block-array type sendRichMessage accepts, so buildResultBlocks stays in sync with grammy.
type RichBlocks = NonNullable<NonNullable<Parameters<Api["sendRichMessage"]>[1]>["blocks"]>;

// Poster timezones. Everyone defaults to Kyiv; the members listed in EU_TIMEZONE_MEMBERS
// (comma-separated Telegram user IDs) type their event times in Central European Time instead.
const DEFAULT_TZ = 'Europe/Kyiv';
const EU_TZ = 'CET'; // Central European Time — DST-aware (CET in winter, CEST in summer)
const euTimezoneMembers = new Set(
  (process.env.EU_TIMEZONE_MEMBERS ?? "")
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
function timezoneForUser(userId: number | string): string {
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
function parseEventTime(text: string, timeZone = DEFAULT_TZ): number | null {
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

// Format an event's Unix timestamp as HH:MM wall-clock time in the given IANA zone (DST-aware).
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

// Rewrite the event-time token in an (HTML-escaped) message to its Kyiv value flagged 🇺🇦 plus the
// CET/CEST equivalent flagged 🇪🇺 — e.g. "23:30" → "🇺🇦 23:30 (🇪🇺 22:30)". Both come from the
// resolved timestamp, so an EU poster's typed CET time still shows correctly under each flag.
// escapeHtml only rewrites & < >, so matchEventTimeToken's indices stay valid on the escaped string.
function decorateEventTime(escapedMessage: string, eventTime: number): string {
  const token = matchEventTimeToken(escapedMessage);
  if (!token) return escapedMessage;
  const kyiv = formatTimeIn(eventTime, DEFAULT_TZ);
  const eu = formatTimeIn(eventTime, EU_TZ);
  return escapedMessage.slice(0, token.start) + `🇺🇦 ${kyiv} (🇪🇺 ${eu})` + escapedMessage.slice(token.end);
}

const MAX_PLAYERS = 5;

function extractEventName(baseText: string): string | null {
  const firstLine = baseText.split("\n")[0];
  const colonIdx = firstLine.indexOf(": ");
  return colonIdx !== -1 ? firstLine.slice(colonIdx + 2).trim() : null;
}


// Both keyed by phraseKey() — hold AI hype phrases frozen per event so RSVP edits reuse them
// instead of regenerating. reminderPhraseCache is frozen when the reminder fires; fullPhraseCache
// is frozen once the squad first fills (and cleared if it drops below full, so a re-fill re-hypes).
// Both are torn down together in clearEventPhrases when the event ends.
const reminderPhraseCache = new Map<string, string>();
const fullPhraseCache = new Map<string, string>();

// chatId → messageId for pins triggered by @all — lets bot.ts delete only those service messages.
export const pendingPinDeletion = new Map<number, number>();

const phraseKey = (chatId: number | string, messageId: number): string => `${chatId}:${messageId}`;

// Return the cached hype phrase for this key, or generate one and freeze it in the cache.
async function cachedHypePhrase(cache: Map<string, string>, key: string, eventName: string | null): Promise<string> {
  const phrase = cache.get(key) ?? await generateHypePhrase(eventName);
  cache.set(key, phrase);
  return phrase;
}

export function clearEventPhrases(chatId: number | string, messageId: number): void {
  const key = phraseKey(chatId, messageId);
  reminderPhraseCache.delete(key);
  fullPhraseCache.delete(key);
}


function buildKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: t("joinButton"), callback_data: "join", style: "success" },
      { text: t("notJoinButton"), callback_data: "not_join", style: "danger" }
    ]]
  };
}

// When the squad is full we drop the "Joining" button but keep "Not joining",
// so a locked-in player who can no longer make it can free up their seat.
// Dropping out takes the count back below the cap, which restores buildKeyboard().
function buildLeaveOnlyKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: t("notJoinButton"), callback_data: "not_join", style: "danger" }
    ]]
  };
}

// Lists only members who haven't RSVP'd yet — responders already show in the
// Joining/Not joining sections. Returns "" when nobody's left, so the block
// disappears instead of leaving an empty header.
function buildMentionedBlock(mentionedUsers: Mentionable[], rsvps: { id: number }[]): string {
  const responded = new Set(rsvps.map(r => r.id));
  const pending = mentionedUsers.filter(u => !responded.has(u.id));
  if (pending.length === 0) return "";
  return `\n\n<b>${t("mentioned")}</b> ${pending.map(buildMention).join(", ")}`;
}

function buildRsvpSection(rsvps: RsvpLike[]): string {
  const joining: RsvpLike[] = [];
  const notJoining: RsvpLike[] = [];
  for (const r of rsvps) {
    if (r.status === "join") joining.push(r);
    else notJoining.push(r);
  }
  let section = "";
  if (joining.length > 0)
    section += `\n\n${t("joiningHeader", joining.length)}\n${joining.map(buildMention).join(", ")}`;
  if (notJoining.length > 0)
    section += `\n\n${t("notJoiningHeader", notJoining.length)}\n${notJoining.map(buildMention).join(", ")}`;
  return section;
}

export async function mentionAll(ctx: HearsContext<Context>, message = ""): Promise<void> {
  if (ctx.chat.type === "private") {
    await ctx.reply(t("groupOnly"));
    return;
  }

  const rows = getMembers(ctx.chat.id);

  if (rows.length === 0) {
    await sendEphemeral(ctx, t("noMembers"), { parse_mode: "HTML" });
    return;
  }

  if (!message) {
    await sendEphemeral(ctx, t("usageAll"), { parse_mode: "HTML" });
    return;
  }

  const from = ctx.from;
  if (!from) return; // anonymous admins / channel posts have no sender

  const poster = buildMention(from);
  const eventTime = parseEventTime(message, timezoneForUser(from.id));
  // Flag the event time inline — 🇺🇦 Kyiv with the 🇪🇺 (CET/CEST) equivalent in parens,
  // e.g. "CS 🇺🇦 23:30 (🇪🇺 22:30)". No time = message unchanged.
  const escaped = escapeHtml(message);
  const messageLine = `${poster}: ${eventTime ? decorateEventTime(escaped, eventTime) : escaped}`;
  const mentionedUsers = rows.filter(r => r.id !== from.id);

  if (eventTime) {
    const activeEvent = getActiveEvent(ctx.chat.id);
    if (activeEvent) {
      const chatIdStr = String(ctx.chat.id);
      const peerId = chatIdStr.startsWith("-100") ? chatIdStr.slice(4) : chatIdStr.replace("-", "");
      const link = `https://t.me/c/${peerId}/${activeEvent.message_id}`;
      await sendEphemeral(ctx, t("activeEventExists", link), { parse_mode: "HTML" });
      return;
    }
  }
  let lastSent: Message | null = null;

  if (eventTime) {
    // Build the full initial text with RSVP section (poster auto-joined) before sending,
    // so the message is delivered to all clients with the keyboard already attached —
    // avoiding the send-then-edit race condition that caused buttons to not appear.
    const initialRsvps: RsvpLike[] = [{ ...from, status: "join" }];
    const initialText = messageLine + buildMentionedBlock(mentionedUsers, initialRsvps) + buildRsvpSection(initialRsvps);
    const keyboard = buildKeyboard();

    lastSent = await ctx.api.sendMessage(ctx.chat.id, initialText, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });

    try {
      saveEvent(ctx.chat.id, lastSent.message_id, messageLine, eventTime);
    } catch (err) {
      console.error("[event] save failed:", (err as Error).message);
    }
    saveRsvp(ctx.chat.id, lastSent.message_id, from, "join");

    try {
      pendingPinDeletion.set(ctx.chat.id, lastSent.message_id);
      await ctx.pinChatMessage(lastSent.message_id, { disable_notification: true });
      scheduleUnpin(ctx.chat.id, lastSent.message_id, eventTime);
      const reminderAt = eventTime - 10 * 60;
      if (reminderAt > Math.floor(Date.now() / 1000)) {
        scheduleReminder(ctx.chat.id, lastSent.message_id, reminderAt);
      }
      console.log(`[event] created "${message}"`);
    } catch (err) {
      pendingPinDeletion.delete(ctx.chat.id);
      console.error("[event] pin failed:", (err as Error).message);
    }
  } else {
    const fullText = messageLine + buildMentionedBlock(mentionedUsers, []);
    lastSent = await ctx.api.sendMessage(ctx.chat.id, fullText, { parse_mode: "HTML" });
    console.log(`[mention] "${message}"`);
  }

  try { await ctx.deleteMessage(); } catch {}
}

export async function cancelEvent(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type === "private") return;
  if (!ctx.from) return; // anonymous admins / channel posts have no sender

  const activeEvent = getActiveEvent(ctx.chat.id);
  if (!activeEvent) {
    await sendEphemeral(ctx, t("noActiveEvent"));
    return;
  }

  const { message_id } = activeEvent;
  const reminderMessageId = getReminderMessageId(ctx.chat.id, message_id);
  const row = getEventBaseText(ctx.chat.id, message_id);
  const rsvps = getRsvps(ctx.chat.id, message_id);

  await ctx.api.unpinChatMessage(ctx.chat.id, message_id).catch(() => {});

  const cancelledText = (row?.base_text ?? "") + buildRsvpSection(rsvps) + `\n\n⛔ <b>${t("cancelledBy", buildMention(ctx.from))}</b>`;
  try {
    await ctx.api.editMessageText(ctx.chat.id, message_id, cancelledText, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
  } catch (err) {
    console.error("[cancel] edit failed:", (err as Error).message);
  }

  if (reminderMessageId) {
    await ctx.api.deleteMessage(ctx.chat.id, reminderMessageId).catch(() => {});
  }
  deleteEventData(ctx.chat.id, message_id);
  clearEventPhrases(ctx.chat.id, message_id);
  console.log("[cancel] event cancelled");
  try { await ctx.deleteMessage(); } catch {}
}

export async function muteNotifications(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type === "private") { await ctx.reply(t("groupOnly")); return; }
  if (!ctx.from) return; // anonymous admins / channel posts have no sender
  const current = getNotificationsStatus(ctx.chat.id, ctx.from.id);
  if (current === false) {
    await sendEphemeral(ctx, t("alreadyMuted"));
    return;
  }
  trackMember(ctx.chat.id, ctx.from);
  setNotifications(ctx.chat.id, ctx.from.id, false);
  console.log("[mute] muted");
  await sendEphemeral(ctx, t("mutedSuccess"));
}

export async function unmuteNotifications(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type === "private") { await ctx.reply(t("groupOnly")); return; }
  if (!ctx.from) return; // anonymous admins / channel posts have no sender
  const current = getNotificationsStatus(ctx.chat.id, ctx.from.id);
  if (current === true) {
    await sendEphemeral(ctx, t("alreadyUnmuted"));
    return;
  }
  trackMember(ctx.chat.id, ctx.from);
  setNotifications(ctx.chat.id, ctx.from.id, true);
  console.log("[unmute] unmuted");
  await sendEphemeral(ctx, t("unmutedSuccess"));
}

export async function handleRsvp(ctx: CallbackQueryContext<Context>): Promise<void> {
  const status = ctx.callbackQuery.data; // "join" or "not_join"
  // A callback query always originates from a message in a chat here (our inline keyboards).
  const chatId = ctx.chat!.id;
  if (!ctx.from) return; // every callback query carries a sender, but the type allows undefined

  const activeEvent = getActiveEvent(chatId);
  if (!activeEvent) {
    await ctx.answerCallbackQuery({ text: t("eventEnded") });
    return;
  }
  const messageId = activeEvent.message_id;

  // The tapped button may live on a stale message on a not-yet-synced client
  // (e.g. an older, already-ended event). Only accept taps on the message that
  // is actually the current active event.
  const clickedMessageId = ctx.callbackQuery.message?.message_id;
  if (clickedMessageId && clickedMessageId !== messageId) {
    await ctx.answerCallbackQuery({ text: t("eventEnded") });
    return;
  }

  const row = getEventBaseText(chatId, messageId);
  if (!row) {
    console.error("[rsvp] no active event found");
    await ctx.answerCallbackQuery({ text: t("eventEnded") });
    return;
  }

  const currentStatus = getUserRsvpStatus(chatId, messageId, ctx.from.id);
  if (currentStatus === status) {
    const toastText = status === "join" ? t("alreadyJoining") : t("alreadyNotJoining");
    await ctx.answerCallbackQuery({ text: toastText });
    return;
  }

  // Enforce the squad cap server-side: the "Joining" button is removed at 5/5,
  // but a stale client may still show it. Reject the join instead of going 6/5.
  if (status === "join") {
    const joiningNow = getRsvps(chatId, messageId).filter(r => r.status === "join");
    if (joiningNow.length >= MAX_PLAYERS) {
      console.log("[rsvp] rejected — squad full");
      await ctx.answerCallbackQuery({ text: t("squadFull", MAX_PLAYERS) });
      return;
    }
  }

  saveRsvp(chatId, messageId, ctx.from, status);

  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  const notJoining = rsvps.filter(r => r.status === "not_join");
  const isFull = joining.length >= MAX_PLAYERS;
  const eventName = extractEventName(row.base_text);
  console.log(`[rsvp] ${status === "join" ? "joined" : "not joining"} (🍌 ${joining.length}/${MAX_PLAYERS}, ❌ ${notJoining.length})${isFull ? " — squad full" : ""}`);

  // Answer the callback first — the toast is uniform (same for the 1st or 5th joiner)
  // and needs no AI, so the button stops spinning immediately instead of waiting on
  // the hype generation and edit round-trips below.
  const toastText = status === "join" ? t("joining") : t("notJoining");
  await ctx.answerCallbackQuery({ text: toastText });

  // Generate the full-squad hype phrase for the message body only (not the toast).
  // Freeze it on first fill so later edits (a non-player tapping "not going" while still
  // 5/5) reuse it instead of generating a new line; drop it if the squad is no longer full.
  const key = phraseKey(chatId, messageId);
  let fullPhrase = "";
  if (isFull) {
    fullPhrase = await cachedHypePhrase(fullPhraseCache, key, eventName);
  } else {
    fullPhraseCache.delete(key);
  }

  const newText = row.base_text + buildMentionedBlock(getMembers(chatId), rsvps) + buildRsvpSection(rsvps) + (isFull ? `\n\n<blockquote>🔥 <i>${escapeHtml(fullPhrase)}</i> (${MAX_PLAYERS}/${MAX_PLAYERS}) 🔒</blockquote>` : "");
  const keyboard = isFull ? buildLeaveOnlyKeyboard() : buildKeyboard();

  try {
    await ctx.api.editMessageText(chatId, messageId, newText, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  } catch (err) {
    if (!(err as Error).message?.includes("message is not modified")) {
      console.error("[rsvp] edit failed:", (err as Error).message);
    }
  }

  // If the reminder has already been sent, update its joining list too.
  // Done after answerCallbackQuery so a cache-miss AI call doesn't block the response.
  const reminderMessageId = getReminderMessageId(chatId, messageId);
  if (reminderMessageId) {
    const phrase = await cachedHypePhrase(reminderPhraseCache, key, eventName);
    const updatedReminderText = buildReminderText(row, joining, phrase);
    await ctx.api.editMessageText(chatId, reminderMessageId, updatedReminderText, { parse_mode: "HTML" })
      .catch(err => {
        if (!err.message?.includes("message is not modified")) {
          console.error("[reminder] edit failed:", err.message);
        }
      });
  }
}

function buildReminderText(row: EventRow, joining: RsvpRow[], phrase: string): string {
  const eventName = extractEventName(row.base_text);
  return (
    t("reminderHeader") +
    (eventName ? `\n\n${eventName}` : "") +
    `\n\n${t("joiningHeader", joining.length)}\n${joining.map(buildMention).join(", ")}` +
    `\n\n<blockquote><i>${escapeHtml(phrase)}</i></blockquote>`
  );
}

export async function registerFaceit(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type === "private") return;
  if (!ctx.from) return; // anonymous admins / channel posts have no sender
  const nickname = ctx.match?.trim();
  if (!nickname) {
    await sendEphemeral(ctx, t("faceitUsage"), { parse_mode: "HTML" });
    return;
  }

  let player;
  try {
    player = await getPlayer(nickname);
  } catch (err) {
    console.error("[faceit] API error:", (err as Error).message);
    await sendEphemeral(ctx, t("faceitUnavailable"));
    return;
  }

  if (!player) {
    await sendEphemeral(ctx, t("faceitNotFound", escapeHtml(nickname)), { parse_mode: "HTML" });
    return;
  }

  const cs2 = player.games?.cs2;
  if (!cs2) {
    await sendEphemeral(ctx, t("faceitNoStats", escapeHtml(player.nickname)), { parse_mode: "HTML" });
    return;
  }

  trackMember(ctx.chat.id, ctx.from);
  setFaceitAccount(ctx.chat.id, ctx.from.id, player.player_id, cs2.faceit_elo ?? null);
  console.log(`[faceit] registered "${player.nickname}"`);

  await sendEphemeral(
    ctx,
    t("faceitLinked", escapeHtml(player.nickname), cs2.faceit_elo ? `${cs2.faceit_elo} Elo` : t("unranked")),
    { parse_mode: "HTML" }
  );
}

async function buildMatchResult(
  stats: FaceitMatchStats,
  registeredIds: Map<string, RegEntry>,
  elo: EloPair | null = null,
  matchId: string | null = null,
  matchDetails: FaceitMatchDetails | null = null
): Promise<MatchResult | null> {
  const round = stats.rounds?.[0];
  if (!round) return null;
  let ourTeam = null, theirTeam = null;

  for (const team of round.teams ?? []) {
    if (team.players.some(p => registeredIds.has(p.player_id))) ourTeam = team;
    else theirTeam = team;
  }
  if (!ourTeam) return null;

  const theirScore = theirTeam?.team_stats?.["Final Score"] ?? "?";

  const won = ourTeam.team_stats?.["Team Win"] === "1";
  const ourScore = ourTeam.team_stats?.["Final Score"] ?? "?";

  const registered = ourTeam.players.filter(p => registeredIds.has(p.player_id));

  // Display rows (sorted by ADR desc), structured so the table and HTML fallback share one source.
  const resultRows: ResultRow[] = registered
    .sort((a, b) => Number(b.player_stats?.ADR ?? 0) - Number(a.player_stats?.ADR ?? 0))
    .map(p => {
      const s = p.player_stats ?? {};
      const entry = registeredIds.get(p.player_id);
      const preElo = entry?.preElo ?? null;
      const postElo = entry?.postElo ?? null;
      const delta = preElo && postElo ? postElo - preElo : null;
      const deltaStr = delta != null ? ` ${delta >= 0 ? "↑" : "↓"}${Math.abs(delta)}` : "";
      return {
        nickname: p.nickname,
        kda: `${s.Kills ?? "?"}/${s.Deaths ?? "?"}/${s.Assists ?? "?"}`,
        adr: s.ADR ?? "?",
        elo: postElo ? `${postElo} Elo${deltaStr}` : "? Elo",
      };
    });

  if (!resultRows.length) return null;

  const rawMap = round.round_stats?.Map ?? "";
  // Prefer FACEIT's official map name; fall back to cleaning the raw id if it's not in the pool.
  const map = getMapName(matchDetails, rawMap)
    || rawMap.replace(/^de_/, "").replace(/^cs_/, "").replace(/^\w/, c => c.toUpperCase())
    || null;
  const mapImage = getMapImage(matchDetails, rawMap);
  const players: MatchPlayer[] = registered.map(p => {
    const s = p.player_stats ?? {};
    return {
      nickname: p.nickname,
      kills: Number(s.Kills),
      deaths: Number(s.Deaths),
      assists: Number(s.Assists),
      adr: Number(s.ADR),
      hs: Number(s["Headshots %"]),
      aces: Number(s["Penta Kills"]),
      quadros: Number(s["Quadro Kills"]),
      clutches: Number(s["1v2Wins"]),
      awp: Number(s["Sniper Kills"]),
      entries: Number(s["Entry Wins"]),
      util: Number(s["Utility Damage"]),
      flashes: Number(s["Enemies Flashed"]),
    };
  });
  const matchFlow: MatchFlow | null = theirTeam
    ? {
        ourFirst: Number(ourTeam.team_stats?.["First Half Score"]),
        theirFirst: Number(theirTeam.team_stats?.["First Half Score"]),
        ourOt: Number(ourTeam.team_stats?.["Overtime score"]),
        theirOt: Number(theirTeam.team_stats?.["Overtime score"]),
      }
    : null;
  const phrase = await generateMatchPhrase(won, `${ourScore}:${theirScore}`, { map, elo, players, matchFlow });

  return { won, ourScore, theirScore, elo, mapImage, matchId, rows: resultRows, phrase };
}

// Header pieces shared by both renderers so they never drift: win/loss emoji, score, and
// team Elo when present. The map shows only as the rich card's image below the header
// (never a name here); it still feeds the AI phrase, and the HTML fallback shows no map.
function resultHeader({ won, ourScore, theirScore, elo }: MatchResult): { emoji: string; score: string; elo: string | null } {
  return {
    emoji: won ? "🍌" : "❌",
    score: `${ourScore}:${theirScore}`,
    elo: elo ? `(${elo.ours} Elo vs ${elo.theirs} Elo)` : null,
  };
}

// HTML rendering of a match result — the fallback when a rich message can't be sent.
function renderResultHtml(result: MatchResult): string {
  const { matchId, rows, phrase } = result;
  const htmlRows = rows.map(p =>
    `· <b>${escapeHtml(p.nickname)}</b> (${p.elo}) — ${p.kda} · ${p.adr} ADR`
  );
  const { emoji, score, elo } = resultHeader(result);
  const header = `${emoji} <b>${escapeHtml(score)}</b>` + (elo ? ` ${escapeHtml(elo)}` : "");
  const matchLink = matchId
    ? `\n\n🔗 ${t("viewOnFaceit")} <a href="${matchRoomUrl(matchId)}">FACEIT</a>`
    : "";
  return (
    header + "\n\n" +
    htmlRows.join("\n") +
    `\n\n<blockquote><i>${escapeHtml(phrase)}</i></blockquote>` +
    matchLink
  );
}

// Rich rendering of a match result: header, scoreboard table, AI-commentary blockquote, FACEIT footer.
function buildResultBlocks(result: MatchResult): RichBlocks {
  const { matchId, rows, phrase, mapImage } = result;
  const H = (text: RichText, align: RichBlockTableCell["align"] = "center"): RichBlockTableCell => ({ text, is_header: true, align, valign: "middle" });
  const C = (text: RichText, align: RichBlockTableCell["align"] = "center"): RichBlockTableCell => ({ text, align, valign: "middle" });
  const cells: RichBlockTableCell[][] = [
    [H(t("scorePlayer")), H("K/D/A"), H("ADR")],
    ...rows.map(p => [
      C([{ type: "bold", text: p.nickname }, `\n${p.elo}`], "left"),
      C({ type: "code", text: p.kda }),
      C({ type: "code", text: p.adr }),
    ]),
  ];

  const { emoji, score, elo } = resultHeader(result);
  const header: RichText[] = [`${emoji} `, { type: "bold", text: score }];
  if (elo) header.push(" ", elo);

  const blocks: RichBlocks = [];
  // Header first, with the map image below it.
  blocks.push({ type: "paragraph", text: header });
  if (mapImage) blocks.push({ type: "photo", photo: { type: "photo", media: mapImage } });
  blocks.push(
    { type: "table", is_striped: true, is_bordered: true, cells },
    { type: "blockquote", blocks: [{ type: "paragraph", text: { type: "italic", text: phrase } }] },
  );
  if (matchId) {
    blocks.push({ type: "footer", text: [`🔗 ${t("viewOnFaceit")} `, { type: "url", text: "FACEIT", url: matchRoomUrl(matchId) }] });
  }
  return blocks;
}

export async function autoPostResult(api: Api, chatId: number | string): Promise<void> {
  const members = getFaceitMembers(chatId);
  if (!members.length) return;

  const now = Math.floor(Date.now() / 1000);

  // Fetch last 5 matches per member in parallel
  const results = await Promise.allSettled(
    members.map(m => getRecentMatches(m.faceit_player_id, 5))
  );

  // Collect candidates: finished, within 24h, not already posted
  const matchCounts = new Map<string, { count: number; finished_at: number }>();
  let historyErrors = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      historyErrors++;
      continue;
    }
    for (const match of result.value ?? []) {
      if (match.status !== "finished") continue;
      if (now - match.finished_at > 24 * 60 * 60) continue;
      if (hasPostedMatch(chatId, match.match_id)) continue;
      const existing = matchCounts.get(match.match_id);
      if (existing) existing.count++;
      else matchCounts.set(match.match_id, { count: 1, finished_at: match.finished_at });
    }
  }

  if (historyErrors) console.error(`[faceit] poll: ${historyErrors}/${members.length} history calls failed`);
  if (!matchCounts.size) return;

  // Map our members → { preElo (DB baseline for the delta), postElo (filled in per match below,
  // only for members who actually played) }. postElo is NOT persisted until the post succeeds:
  // if sending fails (e.g. FACEIT 429), preElo must stay the pre-match value or the delta collapses.
  const registeredIds = new Map<string, RegEntry>(
    members.map(m => [m.faceit_player_id, { userId: m.user_id, preElo: m.faceit_elo, postElo: null }])
  );

  // Sort by member count desc, then oldest first so multiple sessions post in chronological order
  const sortedMatches = [...matchCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].finished_at - b[1].finished_at);

  for (const [matchId, meta] of sortedMatches) {
    let stats: FaceitMatchStats | null = null;
    let matchDetails: FaceitMatchDetails | null = null;
    try {
      [stats, matchDetails] = await Promise.all([getMatchStats(matchId), getMatchDetails(matchId)]);
    } catch (err) {
      console.error("[faceit] poll stats fetch failed:", (err as Error).message);
      continue;
    }
    if (!stats || !matchDetails) {
      // Skip permanently if: voided/cancelled, stats missing >30 min, or match details unavailable >30 min
      if (!matchDetails || matchDetails.status !== "FINISHED" || now - meta.finished_at > 30 * 60) {
        markMatchPosted(chatId, matchId);
      }
      // else: FINISHED but stats not ready yet — retry next poll
      continue;
    }

    // Fetch current Elo only for our members who actually played this match — not the whole
    // roster. Fetching sit-out members buys nothing for the post and just burns rate limit.
    const participantIds = new Set<string>();
    for (const round of stats.rounds ?? []) {
      for (const team of round.teams ?? []) {
        for (const p of team.players ?? []) {
          if (registeredIds.has(p.player_id)) participantIds.add(p.player_id);
        }
      }
    }
    const transientFail = new Set<string>();
    await Promise.allSettled(
      [...participantIds]
        .filter(pid => registeredIds.get(pid)!.postElo === null)
        .map(async pid => {
          let profile;
          try {
            profile = await getPlayerById(pid);
          } catch {
            transientFail.add(pid); // 429/5xx/network after retries — worth retrying next poll
            return;
          }
          if (!profile) return; // 404 profile — permanent, accept "? Elo"
          registeredIds.get(pid)!.postElo = profile.games?.cs2?.faceit_elo ?? null; // null = unranked
        })
    );

    // Hold the whole match back rather than post partial "? Elo" when a fetch failed transiently —
    // don't markMatchPosted, so the next poll retries with complete info. Only while it's still
    // fresh: past the 30-min grace window, fall through and post best-effort so it never sticks.
    // (Unranked players / 404s aren't in transientFail, so they never block the post.)
    if (transientFail.size && now - meta.finished_at < 30 * 60) continue;

    const factions = Object.values(matchDetails.teams ?? {});
    const ourFaction = factions.find(f => f.roster?.some(p => registeredIds.has(p.player_id)));
    const theirFaction = factions.find(f => f !== ourFaction);
    const ourRating = ourFaction?.stats?.rating;
    const theirRating = theirFaction?.stats?.rating;
    const elo: EloPair | null = ourRating && theirRating
      ? { ours: ourRating, theirs: theirRating }
      : null;

    const result = await buildMatchResult(stats, registeredIds, elo, matchId, matchDetails);
    if (!result) {
      markMatchPosted(chatId, matchId);
      continue;
    }

    // Prefer the rich scoreboard; fall back to plain HTML if the rich send is rejected.
    try {
      await api.sendRichMessage(chatId, { blocks: buildResultBlocks(result) });
    } catch (err) {
      console.warn("[faceit] rich post failed, falling back to HTML:", (err as Error).message);
      try {
        await api.sendMessage(chatId, renderResultHtml(result), { parse_mode: "HTML" });
      } catch (e) {
        console.error("[faceit] poll send failed:", (e as Error).message);
        continue;
      }
    }
    markMatchPosted(chatId, matchId);
    // Lock in the new Elo baseline now that the delta has been posted, so the next match
    // measures its delta from here. Only this match's participants — committing all of
    // registeredIds would persist Elo fetched for a different (possibly held-back) match.
    // Skip members whose profile fetch failed (postElo null).
    for (const pid of participantIds) {
      const { userId, postElo } = registeredIds.get(pid)!;
      if (postElo !== null) setFaceitAccount(chatId, userId, pid, postElo);
    }
    console.log("[faceit] auto-posted result");
  }
}

export async function sendReminder(api: Api, chatId: number | string, messageId: number): Promise<Message | undefined> {
  const row = getEventBaseText(chatId, messageId);
  if (!row) return;

  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  if (joining.length <= 1) return;

  const phrase = await generateHypePhrase(extractEventName(row.base_text));
  reminderPhraseCache.set(phraseKey(chatId, messageId), phrase);
  const text = buildReminderText(row, joining, phrase);
  const sent = await api.sendMessage(chatId, text, { parse_mode: "HTML" });
  console.log(`[reminder] sent — ${joining.length} joining`);
  return sent;
}
