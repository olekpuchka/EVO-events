import { trackMember, getMembers, setNotifications, getNotificationsStatus, saveEvent, saveRsvp, getRsvps, getUserRsvpStatus, getEventBaseText, scheduleUnpin, scheduleReminder, getActiveEvents, deleteEventData, getReminderMessageId, setFaceitAccount, getFaceitAccount, clearFaceitAccount } from "../adapters/db.ts";
import { buildMention, escapeHtml, escapeAiHtml } from "../view/html.ts";
import { sendEphemeral, deleteTrigger, groupOnly } from "./guards.ts";
import { getPlayer, getPlayerById, searchPlayers } from "../adapters/faceit.ts";
import { generateHypePhrase } from "../adapters/ai.ts";
import type { HypeContext } from "../types.ts";
import { t } from "../view/i18n.ts";
import { parseEventTime, decorateEventTime, timezoneForUser } from "../view/eventtime.ts";
import {
  MAX_PLAYERS,
  isSquadFull,
  extractEventName,
  eventPickerLine,
  buildKeyboard,
  buildLeaveOnlyKeyboard,
  buildEventLinkKeyboard,
  eloLabel,
  pendingMembers,
  buildMentionedBlock,
  buildRsvpSection,
  buildReminderText,
} from "../view/render.ts";
import type { RsvpLike } from "../view/render.ts";
import type {
  Context,
  Api,
  HearsContext,
  CommandContext,
  CallbackQueryContext,
} from "grammy";
import type { Message } from "@grammyjs/types";
import type { ActiveEventRow, FaceitPlayer } from "../types.ts";

// A solo event isn't a game. Named because sendReminder tests it twice and the two must not drift.
const MIN_JOINING_FOR_REMINDER = 2;

// Both keyed by eventKey() — hold AI hype phrases frozen per event so RSVP edits reuse them
// instead of regenerating. reminderPhraseCache is frozen when the reminder fires; fullPhraseCache
// once the squad first fills, and stays frozen through a drop-out and re-fill.
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

// The one real fact a hype message gets. Null when the event has no time; negative once it
// has started, which the prompt buckets as "right now".
const minutesToStart = (eventTime: number | null): number | null =>
  eventTime == null ? null : Math.round((eventTime - Date.now() / 1000) / 60);

// Return the cached hype phrase for this key, or generate one and freeze it in the cache.
async function cachedHypePhrase(
  cache: Map<string, string>,
  key: string,
  eventName: string | null,
  context: HypeContext
): Promise<string> {
  const phrase = cache.get(key) ?? await generateHypePhrase(eventName, context);
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

export const mentionAll = groupOnly(async (ctx: HearsContext<Context>, from, message: string) => {
  const rows = getMembers(ctx.chat.id);

  if (rows.length === 0) {
    await sendEphemeral(ctx, t("noMembers"), { parse_mode: "HTML" });
    return;
  }

  if (!message) {
    await sendEphemeral(ctx, t("usageAll"), { parse_mode: "HTML" });
    return;
  }

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
    const initialText = messageLine + buildRsvpSection(initialRsvps) + buildMentionedBlock(mentionedUsers);
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
});

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

export const cancelEvent = groupOnly(async (ctx: CommandContext<Context>, from) => {
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

  const cancelledText = base_text + buildRsvpSection(rsvps) + `\n\n⛔ <b>${t("cancelledBy", buildMention(from))}</b>`;
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
});

// The only place `@all` is documented in-app: it isn't a slash command, so it can never appear in
// Telegram's command menu.
export const showHelp = groupOnly(async (ctx: CommandContext<Context>) => {
  await sendEphemeral(ctx, t("helpBody"), { parse_mode: "HTML" });
});

export const muteNotifications = groupOnly(async (ctx: CommandContext<Context>, from) => {
  const current = getNotificationsStatus(ctx.chat.id, from.id);
  if (current === false) {
    await sendEphemeral(ctx, t("alreadyMuted"));
    return;
  }
  trackMember(ctx.chat.id, from);
  setNotifications(ctx.chat.id, from.id, false);
  console.log("[mute] muted");
  await sendEphemeral(ctx, t("mutedSuccess"));
});

export const unmuteNotifications = groupOnly(async (ctx: CommandContext<Context>, from) => {
  const current = getNotificationsStatus(ctx.chat.id, from.id);
  if (current === true) {
    await sendEphemeral(ctx, t("alreadyUnmuted"));
    return;
  }
  trackMember(ctx.chat.id, from);
  setNotifications(ctx.chat.id, from.id, true);
  console.log("[unmute] unmuted");
  await sendEphemeral(ctx, t("unmutedSuccess"));
});

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
    if (isSquadFull(joiningNow)) {
      console.log("[rsvp] rejected — squad full");
      await ack(ctx, t("squadFull", MAX_PLAYERS));
      return;
    }
  }

  saveRsvp(chatId, messageId, ctx.from, status);

  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  const notJoining = rsvps.filter(r => r.status === "not_join");
  const isFull = isSquadFull(joining);
  const eventName = extractEventName(row.base_text);
  console.log(`[rsvp] ${status === "join" ? "joined" : "not joining"} "${eventName ?? ""}" (🍌 ${joining.length}/${MAX_PLAYERS}, ❌ ${notJoining.length})${isFull ? " — squad full" : ""}`);

  // Answer the callback first — the toast is uniform (same for the 1st or 5th joiner)
  // and needs no AI, so the button stops spinning immediately instead of waiting on
  // the hype generation and edit round-trips below.
  await ack(ctx, status === "join" ? t("joining") : t("notJoining"));

  // Body only — the toast needs no AI. A re-fill reuses the frozen phrase instead of paying again.
  const key = eventKey(chatId, messageId);
  const fullPhrase = isFull
    ? await cachedHypePhrase(fullPhraseCache, key, eventName, { startsIn: minutesToStart(row.event_time), squadFull: true })
    : "";

  // Both the "Mentioned:" block and the reminder's nudge want whoever hasn't answered, so it's
  // filtered once. A locked squad recruits for nothing, so it skips the read and both fall away.
  const pending = isFull ? [] : pendingMembers(getMembers(chatId), rsvps);
  const mentioned = buildMentionedBlock(pending);
  const lockedBanner = isFull
    ? `\n\n<blockquote>🔥 <i>${escapeAiHtml(fullPhrase)}</i> (${MAX_PLAYERS}/${MAX_PLAYERS}) 🔒</blockquote>`
    : "";

  // Squad first, then the ask — the roster holds a fixed spot while the "Mentioned" list shrinks.
  const newText = row.base_text + buildRsvpSection(rsvps) + mentioned + lockedBanner;
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
    const phrase = await cachedHypePhrase(reminderPhraseCache, key, eventName, {
      startsIn: minutesToStart(row.event_time),
      squadFull: isFull,
    });
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

export const registerFaceit = groupOnly(async (ctx: CommandContext<Context>, from) => {
  const nickname = ctx.match?.trim();
  if (!nickname) {
    await showFaceitStatus(ctx, from.id);
    return;
  }

  // `off` unlinks — an argument rather than its own command, so it costs no menu row. The command
  // is lowercased upstream but its argument isn't; a player really nicknamed "off" can't link.
  if (nickname.toLowerCase() === "off") {
    if (!getFaceitAccount(ctx.chat.id, from.id)) {
      await sendEphemeral(ctx, t("faceitNotLinked"), { parse_mode: "HTML" });
      return;
    }
    clearFaceitAccount(ctx.chat.id, from.id);
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

  trackMember(ctx.chat.id, from);
  setFaceitAccount(ctx.chat.id, from.id, player.player_id, cs2.faceit_elo ?? null);
  console.log(`[faceit] registered "${player.nickname}"`);

  await sendEphemeral(
    ctx,
    t("faceitLinked", escapeHtml(player.nickname), eloLabel(cs2.faceit_elo)),
    { parse_mode: "HTML" }
  );
});

export async function sendReminder(api: Api, chatId: number | string, messageId: number): Promise<Message | undefined> {
  const row = getEventBaseText(chatId, messageId);
  if (!row) return;

  // Cheap gate first, so a solo event never pays for a phrase it won't use.
  if (getRsvps(chatId, messageId).filter(r => r.status === "join").length < MIN_JOINING_FOR_REMINDER) return;

  const eventName = extractEventName(row.base_text);
  // No roster read before this call — see the note below on why the snapshot must come after.
  const phrase = await generateHypePhrase(eventName, { startsIn: minutesToStart(row.event_time) });
  reminderPhraseCache.set(eventKey(chatId, messageId), phrase);

  // Read the roster after the phrase call, not before: it takes seconds and fires at the peak RSVP
  // moment, so a stale snapshot would under-count joiners and @-mention a fresh one as undecided —
  // which their own tap can't fix, having run before reminder_message_id was saved.
  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  if (joining.length < MIN_JOINING_FOR_REMINDER) return; // they dropped out while the phrase generated
  // This send is the one that notifies, so the nudge is a real last call; later edits are silent.
  // A locked squad recruits for nothing, so it skips the read — and the log, which would otherwise
  // count people nobody is waiting on.
  const isFull = isSquadFull(joining);
  const pending = isFull ? [] : pendingMembers(getMembers(chatId), rsvps);
  const text = buildReminderText(row, joining, phrase, pending);
  const sent = await api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: buildEventLinkKeyboard(chatId, messageId),
  });
  const roster = isFull ? `${joining.length} joining — squad full` : `${joining.length} joining, ${pending.length} undecided`;
  console.log(`[reminder] sent "${eventName ?? ""}" — ${roster}`);
  return sent;
}
