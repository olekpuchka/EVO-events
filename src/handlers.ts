import { trackMember, getMembers, setNotifications, getNotificationsStatus, saveEvent, saveRsvp, getRsvps, getUserRsvpStatus, getEventBaseText, scheduleUnpin, scheduleReminder, getActiveEvents, deleteEventData, getReminderMessageId, setFaceitAccount, setFaceitElo, getFaceitAccount, clearFaceitAccount, getFaceitMembers, hasPostedMatch, markMatchPosted } from "./db.ts";
import { buildMention, escapeHtml, escapeAiHtml, stripAiHtml, sendEphemeral, deleteTrigger } from "./helpers.ts";
import type { Mentionable } from "./helpers.ts";
import { getPlayer, getPlayerById, searchPlayers, getRecentMatches, getMatchStats, getMatchDetails, getMapName, getMapImage, matchRoomUrl } from "./faceit.ts";
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
  ActiveEventRow,
  RsvpRow,
  EventRow,
  FaceitPlayer,
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
const EU_TZ = 'CET';
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
function decorateEventTime(escapedMessage: string, eventTime: number): string {
  const token = matchEventTimeToken(escapedMessage);
  if (!token) return escapedMessage;
  const bothZones = `🇺🇦 ${formatTimeIn(eventTime, DEFAULT_TZ)} (🇪🇺 ${formatTimeIn(eventTime, EU_TZ)})`;
  return escapedMessage.slice(0, token.start) + bothZones + escapedMessage.slice(token.end);
}

const MAX_PLAYERS = 5;
// A solo event isn't a game. Named because sendReminder tests it twice and the two must not drift.
const MIN_JOINING_FOR_REMINDER = 2;

// base_text is always `<a …>poster</a>: event`. Split on the closing tag, not the first ": " —
// a display name containing ": " would cut mid-mention and leave a stray </a> Telegram rejects.
const POSTER_SEP = "</a>: ";

function extractEventName(baseText: string): string | null {
  const firstLine = baseText.split("\n")[0];
  const sep = firstLine.indexOf(POSTER_SEP);
  return sep === -1 ? null : firstLine.slice(sep + POSTER_SEP.length).trim();
}


// Both keyed by eventKey() — hold AI hype phrases frozen per event so RSVP edits reuse them
// instead of regenerating. reminderPhraseCache is frozen when the reminder fires; fullPhraseCache
// is frozen once the squad first fills (and cleared if it drops below full, so a re-fill re-hypes).
// Both are torn down by endEvent when the event ends.
const reminderPhraseCache = new Map<string, string>();
const fullPhraseCache = new Map<string, string>();

// Identifies one event — the same (chat_id, message_id) pair the DB is keyed on.
const eventKey = (chatId: number | string, messageId: number): string => `${chatId}:${messageId}`;

// Pins the bot made for an @all event — only these get their "pinned a message" notice deleted,
// never a member's pin. Keyed per event, not per chat: two can be pinned seconds apart.
const pendingPinDeletion = new Set<string>();

// Was this pin the bot's own? Claims it at the same time, so one notice is deleted once.
export function claimBotPin(chatId: number | string, messageId: number): boolean {
  return pendingPinDeletion.delete(eventKey(chatId, messageId));
}

// Return the cached hype phrase for this key, or generate one and freeze it in the cache.
async function cachedHypePhrase(cache: Map<string, string>, key: string, eventName: string | null): Promise<string> {
  const phrase = cache.get(key) ?? await generateHypePhrase(eventName);
  cache.set(key, phrase);
  return phrase;
}

// Everything an event owns, released in one call: DB rows, cached phrases, and any pin notice
// still waiting on it. Both ends of life — the scheduled unpin and /cancel — come through here.
// Returns the name it removed, so each caller can log the ending in its own words.
export function endEvent(chatId: number | string, messageId: number): string {
  const key = eventKey(chatId, messageId);
  const name = extractEventName(getEventBaseText(chatId, messageId)?.base_text ?? "") ?? "";
  deleteEventData(chatId, messageId);
  reminderPhraseCache.delete(key);
  fullPhraseCache.delete(key);
  pendingPinDeletion.delete(key);
  return name;
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

// "1735 Elo", or the unranked label when FACEIT has no Elo for the account.
const eloLabel = (elo: number | null | undefined): string => elo ? `${elo} Elo` : t("unranked");

// Members who haven't answered either way — "not joining" counts as answered. Shared by the event's
// "Mentioned:" block and the reminder's nudge, so the two can't disagree on who's still undecided.
function pendingMembers(mentionedUsers: Mentionable[], rsvps: { id: number }[]): Mentionable[] {
  const responded = new Set(rsvps.map(r => r.id));
  return mentionedUsers.filter(u => !responded.has(u.id));
}

// Renders the undecided list — responders already show in the Joining/Not joining sections.
// Returns "" when nobody's left, so the block disappears instead of leaving an empty header.
function buildMentionedBlock(pending: Mentionable[]): string {
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
  // Flag the event time inline — 🇺🇦 Kyiv with the 🇪🇺 equivalent in parens,
  // e.g. "CS 🇺🇦 23:30 (🇪🇺 22:30)". No time = message unchanged.
  const escaped = escapeHtml(message);
  const messageLine = `${poster}: ${eventTime ? decorateEventTime(escaped, eventTime) : escaped}`;
  const mentionedUsers = rows.filter(r => r.id !== from.id);

  let lastSent: Message | null = null;

  if (eventTime) {
    // Build the full initial text with RSVP section (poster auto-joined) before sending,
    // so the message is delivered to all clients with the keyboard already attached —
    // avoiding the send-then-edit race condition that caused buttons to not appear.
    // The poster is the only RSVP and is already out of mentionedUsers, so everyone there is pending.
    const initialRsvps: RsvpLike[] = [{ ...from, status: "join" }];
    const initialText = messageLine + buildMentionedBlock(mentionedUsers) + buildRsvpSection(initialRsvps);
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

    // Schedule before pinning, never inside its try: the unpin is what deletes the event row, so
    // a failed pin would otherwise strand the row forever. Pinning is decoration, not lifecycle.
    scheduleUnpin(ctx.chat.id, lastSent.message_id, eventTime);
    const reminderAt = eventTime - 10 * 60;
    if (reminderAt > Math.floor(Date.now() / 1000)) {
      scheduleReminder(ctx.chat.id, lastSent.message_id, reminderAt);
    }
    console.log(`[event] created "${message}"`);

    const pinKey = eventKey(ctx.chat.id, lastSent.message_id);
    try {
      pendingPinDeletion.add(pinKey);
      await ctx.pinChatMessage(lastSent.message_id, { disable_notification: true });
    } catch (err) {
      pendingPinDeletion.delete(pinKey);
      console.error("[event] pin failed:", (err as Error).message);
    }
  } else {
    // Nobody has answered a mention-only post, so every mentioned member is still pending.
    const fullText = messageLine + buildMentionedBlock(mentionedUsers);
    lastSent = await ctx.api.sendMessage(ctx.chat.id, fullText, { parse_mode: "HTML" });
    console.log(`[mention] "${message}"`);
  }

  await deleteTrigger(ctx);
}

// Unpin an event that is over, whether it ended or was cancelled. "not found" just means someone
// unpinned it by hand, so only anything else is logged. Never throws: callers have cleanup to run
// after this (buttons, reminder, rows) and nothing retries once the scheduled row is gone.
export async function unpinEventMessage(api: Api, chatId: number | string, messageId: number): Promise<void> {
  try {
    await api.unpinChatMessage(chatId, messageId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("message to unpin not found")) {
      console.error("[unpin] failed:", message);
    }
  }
}

// Deep link to a message. t.me/c/ wants the bare peer ID, without the supergroup -100 prefix.
function messageLink(chatId: number | string, messageId: number): string {
  const chatIdStr = String(chatId);
  const peerId = chatIdStr.startsWith("-100") ? chatIdStr.slice(4) : chatIdStr.replace("-", "");
  return `https://t.me/c/${peerId}/${messageId}`;
}

// One line of the "which event?" list. base_text is already HTML-escaped, so the name is safe to
// nest in the link — and always present, since every stored base_text carries the poster mention.
function eventPickerLine(chatId: number | string, event: ActiveEventRow): string {
  const label = extractEventName(event.base_text) ?? "?";
  return `• <a href="${messageLink(chatId, event.message_id)}">${label}</a>`;
}

export async function cancelEvent(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type === "private") { await ctx.reply(t("groupOnly")); return; }
  if (!ctx.from) return; // anonymous admins / channel posts have no sender

  const active = getActiveEvents(ctx.chat.id);
  if (active.length === 0) {
    await sendEphemeral(ctx, t("noActiveEvent"));
    return;
  }

  // /cancel is scoped by replying to the event you mean. Telegram auto-attaches a reply in two
  // cases that mean nothing — a forum topic's start message, and a discussion group's forwarded
  // channel post — so both read as "no reply". Not message_thread_id: that is set for ordinary
  // supergroup reply threads too, and would throw away a deliberate reply to the event itself.
  const reply = ctx.message?.reply_to_message;
  const autoAttached = reply?.forum_topic_created !== undefined || reply?.is_automatic_forward === true;
  const repliedTo = reply && !autoAttached ? reply.message_id : undefined;

  let target: ActiveEventRow | undefined;
  if (repliedTo !== undefined) {
    // Never redirect a deliberate reply. An ended event's message stays in the history, so
    // falling back to "the only live one" would cancel something the user didn't point at.
    target = active.find(e => e.message_id === repliedTo);
    if (!target) {
      await sendEphemeral(ctx, t("replyNotAnEvent"), { parse_mode: "HTML" });
      return;
    }
  } else if (active.length === 1) {
    target = active[0];
  } else {
    const list = active.map(e => eventPickerLine(ctx.chat.id, e)).join("\n");
    await sendEphemeral(ctx, t("pickEventToCancel", list), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  const { message_id, base_text } = target;
  const reminderMessageId = getReminderMessageId(ctx.chat.id, message_id);
  const rsvps = getRsvps(ctx.chat.id, message_id);

  await unpinEventMessage(ctx.api, ctx.chat.id, message_id);

  const cancelledText = base_text + buildRsvpSection(rsvps) + `\n\n⛔ <b>${t("cancelledBy", buildMention(ctx.from))}</b>`;
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
  console.log(`[event] cancelled "${endEvent(ctx.chat.id, message_id)}"`);
  await deleteTrigger(ctx);
}

// The only place `@all` is documented in-app: it isn't a slash command, so it can never appear in
// Telegram's command menu.
export async function showHelp(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type === "private") { await ctx.reply(t("groupOnly")); return; }
  if (!ctx.from) return; // anonymous admins / channel posts have no sender — nobody to reply privately to
  await sendEphemeral(ctx, t("helpBody"), { parse_mode: "HTML" });
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

// A callback query ID expires (~15s), so a tap replayed after a restart can no longer be
// answered. Losing the toast is fine; losing the bookkeeping that follows it is not.
async function ack(ctx: CallbackQueryContext<Context>, text: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text });
  } catch (err) {
    console.warn("[rsvp] ack failed:", (err as Error).message);
  }
}

export async function handleRsvp(ctx: CallbackQueryContext<Context>): Promise<void> {
  const status = ctx.callbackQuery.data; // "join" or "not_join"
  // A callback query always originates from a message in a chat here (our inline keyboards).
  const chatId = ctx.chat!.id;
  if (!ctx.from) return; // every callback query carries a sender, but the type allows undefined

  // Several events can be live, so the tapped message is what identifies this RSVP's event.
  const messageId = ctx.callbackQuery.message?.message_id;
  if (messageId === undefined) {
    await ack(ctx, t("eventEnded")); // too old for Telegram to attach — nothing to resolve
    return;
  }

  // Rows are deleted when an event ends, so a missing row is just a stale keyboard — expected.
  const row = getEventBaseText(chatId, messageId);
  if (!row) {
    await ack(ctx, t("eventEnded"));
    return;
  }

  const currentStatus = getUserRsvpStatus(chatId, messageId, ctx.from.id);
  if (currentStatus === status) {
    await ack(ctx, status === "join" ? t("alreadyJoining") : t("alreadyNotJoining"));
    return;
  }

  // Enforce the squad cap server-side: the "Joining" button is removed at 5/5,
  // but a stale client may still show it. Reject the join instead of going 6/5.
  if (status === "join") {
    const joiningNow = getRsvps(chatId, messageId).filter(r => r.status === "join");
    if (joiningNow.length >= MAX_PLAYERS) {
      console.log("[rsvp] rejected — squad full");
      await ack(ctx, t("squadFull", MAX_PLAYERS));
      return;
    }
  }

  saveRsvp(chatId, messageId, ctx.from, status);

  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  const notJoining = rsvps.filter(r => r.status === "not_join");
  const isFull = joining.length >= MAX_PLAYERS;
  const eventName = extractEventName(row.base_text);
  console.log(`[rsvp] ${status === "join" ? "joined" : "not joining"} "${eventName ?? ""}" (🍌 ${joining.length}/${MAX_PLAYERS}, ❌ ${notJoining.length})${isFull ? " — squad full" : ""}`);

  // Answer the callback first — the toast is uniform (same for the 1st or 5th joiner)
  // and needs no AI, so the button stops spinning immediately instead of waiting on
  // the hype generation and edit round-trips below.
  await ack(ctx, status === "join" ? t("joining") : t("notJoining"));

  // Generate the full-squad hype phrase for the message body only (not the toast).
  // Freeze it on first fill so later edits (a non-player tapping "not going" while still
  // 5/5) reuse it instead of generating a new line; drop it if the squad is no longer full.
  const key = eventKey(chatId, messageId);
  let fullPhrase = "";
  if (isFull) {
    fullPhrase = await cachedHypePhrase(fullPhraseCache, key, eventName);
  } else {
    fullPhraseCache.delete(key);
  }

  // Both the "Mentioned:" block and the reminder's nudge want whoever hasn't answered, so it's
  // filtered once. A locked squad recruits for nothing, so it skips the read and both fall away.
  const pending = isFull ? [] : pendingMembers(getMembers(chatId), rsvps);
  const mentioned = buildMentionedBlock(pending);
  const lockedBanner = isFull
    ? `\n\n<blockquote>🔥 <i>${escapeAiHtml(fullPhrase)}</i> (${MAX_PLAYERS}/${MAX_PLAYERS}) 🔒</blockquote>`
    : "";

  const newText = row.base_text + mentioned + buildRsvpSection(rsvps) + lockedBanner;
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

  // If the reminder is already out, refresh its joining list and nudge — both shrink as people
  // answer. Done after the ack so a cache-miss AI call doesn't block the response.
  const reminderMessageId = getReminderMessageId(chatId, messageId);
  if (reminderMessageId) {
    const phrase = await cachedHypePhrase(reminderPhraseCache, key, eventName);
    const updatedReminderText = buildReminderText(row, joining, phrase, pending);
    await ctx.api.editMessageText(chatId, reminderMessageId, updatedReminderText, {
      parse_mode: "HTML",
      reply_markup: buildEventLinkKeyboard(chatId, messageId),
    })
      .catch(err => {
        if (!err.message?.includes("message is not modified")) {
          console.error("[reminder] edit failed:", err.message);
        }
      });
  }
}

// Deep link to the pinned event, where the RSVP buttons live. Re-sent on every reminder edit:
// omitting reply_markup on an edit strips the keyboard.
function buildEventLinkKeyboard(chatId: number | string, messageId: number): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: t("openEvent"), url: messageLink(chatId, messageId) }]] };
}

function buildReminderText(row: EventRow, joining: RsvpRow[], phrase: string, pending: Mentionable[]): string {
  const eventName = extractEventName(row.base_text);
  // Last call for the open seats, aimed at whoever hasn't answered either way. Gone once the squad
  // locks — nothing left to recruit for — or once everyone has answered.
  const seatsLeft = MAX_PLAYERS - joining.length;
  const nudge = seatsLeft > 0 && pending.length > 0
    ? `\n\n${t("seatsLeft", seatsLeft, pending.map(buildMention).join(", "))}`
    : "";
  return (
    t("reminderHeader") +
    (eventName ? `\n\n${eventName}` : "") +
    `\n\n${t("joiningHeader", joining.length)}\n${joining.map(buildMention).join(", ")}` +
    nudge +
    `\n\n<blockquote><i>${escapeAiHtml(phrase)}</i></blockquote>`
  );
}

// `/faceit` with no nickname: report the link you already have. Only the player id is stored, so
// the nickname is read live — which also keeps up with a FACEIT rename.
async function showFaceitStatus(ctx: CommandContext<Context>, userId: number): Promise<void> {
  const account = getFaceitAccount(ctx.chat.id, userId);
  if (!account) {
    await sendEphemeral(ctx, t("faceitNotLinked"), { parse_mode: "HTML" });
    return;
  }

  let player: FaceitPlayer | null = null;
  try {
    // No retries — the fallback headline already covers a miss, so answering now beats backing off.
    player = await getPlayerById(account.faceit_player_id, { retries: 0 });
  } catch (err) {
    console.warn("[faceit] status lookup failed:", (err as Error).message);
  }

  // An unreachable API and a deleted FACEIT account both land here; neither can name the account,
  // so both get the same headline. The relink hint is the way out of either.
  const headline = player
    ? t("faceitStatus", escapeHtml(player.nickname), eloLabel(player.games?.cs2?.faceit_elo))
    : t("faceitStatusUnavailable");
  await sendEphemeral(ctx, `${headline}\n\n${t("faceitLinkHelp")}`, { parse_mode: "HTML" });
}

export async function registerFaceit(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type === "private") { await ctx.reply(t("groupOnly")); return; }
  if (!ctx.from) return; // anonymous admins / channel posts have no sender
  const nickname = ctx.match?.trim();
  if (!nickname) {
    await showFaceitStatus(ctx, ctx.from.id);
    return;
  }

  // `off` unlinks — an argument rather than its own command, so it costs no menu row. The command
  // is lowercased upstream but its argument isn't; a player really nicknamed "off" can't link.
  if (nickname.toLowerCase() === "off") {
    if (!getFaceitAccount(ctx.chat.id, ctx.from.id)) {
      await sendEphemeral(ctx, t("faceitNotLinked"), { parse_mode: "HTML" });
      return;
    }
    clearFaceitAccount(ctx.chat.id, ctx.from.id);
    console.log("[faceit] unlinked");
    await sendEphemeral(ctx, t("faceitUnlinked"), { parse_mode: "HTML" });
    return;
  }

  let player: FaceitPlayer | null;
  try {
    player = await getPlayer(nickname);
  } catch (err) {
    console.error("[faceit] API error:", (err as Error).message);
    await sendEphemeral(ctx, t("faceitUnavailable"));
    return;
  }

  if (!player) {
    // /players matches case-exactly, so a miss is often just a typo; search is fuzzy and ranks the
    // exact match first. Hits go out as <code> commands, which Telegram copies on tap. The catch
    // keeps a failed search reading "not found" rather than "FACEIT is unavailable".
    const suggestions = await searchPlayers(nickname).catch(err => {
      console.warn("[faceit] search failed:", (err as Error).message);
      return [];
    });
    const list = suggestions.map(p => `• <code>/faceit ${escapeHtml(p.nickname)}</code>`).join("\n");
    const notFound = t("faceitNotFound", escapeHtml(nickname));
    await sendEphemeral(ctx, list ? `${notFound} ${t("didYouMean", list)}` : notFound, { parse_mode: "HTML" });
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
    t("faceitLinked", escapeHtml(player.nickname), eloLabel(cs2.faceit_elo)),
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
      // Non-breaking spaces keep the whole "1234 Elo ↑0" on one line so the cell
      // never wraps past two lines (nickname + elo) in the narrow scoreboard column.
      const deltaStr = delta ? ` ${delta >= 0 ? "↑" : "↓"}${Math.abs(delta)}` : "";
      return {
        nickname: p.nickname,
        kda: `${s.Kills ?? "?"}/${s.Deaths ?? "?"}/${s.Assists ?? "?"}`,
        adr: s.ADR ?? "?",
        elo: postElo ? `${postElo} Elo${deltaStr}` : "? Elo",
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
    `\n\n<blockquote><i>${escapeAiHtml(phrase)}</i></blockquote>` +
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
      C(p.kda),
      C(p.adr),
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
    { type: "blockquote", blocks: [{ type: "paragraph", text: { type: "italic", text: stripAiHtml(phrase) } }] },
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
      const entry = registeredIds.get(pid)!;
      if (entry.postElo !== null) {
        setFaceitElo(chatId, entry.userId, pid, entry.postElo);
        // Advance the baseline so a member's next match this poll shows delta 0
        // instead of repeating the same swing — postElo is live Elo, one value per batch.
        entry.preElo = entry.postElo;
      }
    }
    console.log("[faceit] auto-posted result");
  }
}

export async function sendReminder(api: Api, chatId: number | string, messageId: number): Promise<Message | undefined> {
  const row = getEventBaseText(chatId, messageId);
  if (!row) return;

  // Cheap gate first, so a solo event never pays for a phrase it won't use.
  if (getRsvps(chatId, messageId).filter(r => r.status === "join").length < MIN_JOINING_FOR_REMINDER) return;

  const eventName = extractEventName(row.base_text);
  const phrase = await generateHypePhrase(eventName);
  reminderPhraseCache.set(eventKey(chatId, messageId), phrase);

  // Read the roster after the phrase call, not before: it takes seconds and fires at the peak RSVP
  // moment, so a stale snapshot would under-count joiners and @-mention a fresh one as undecided —
  // which their own tap can't fix, having run before reminder_message_id was saved.
  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  if (joining.length < MIN_JOINING_FOR_REMINDER) return; // they dropped out while the phrase generated
  // This send is the one that notifies, so the nudge is a real last call; later edits are silent.
  const pending = pendingMembers(getMembers(chatId), rsvps);
  const text = buildReminderText(row, joining, phrase, pending);
  const sent = await api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: buildEventLinkKeyboard(chatId, messageId),
  });
  console.log(`[reminder] sent "${eventName ?? ""}" — ${joining.length} joining, ${pending.length} undecided`);
  return sent;
}
