import { trackMember, getMembers, setNotifications, getNotificationsStatus, saveEvent, saveRsvp, getRsvps, getUserRsvpStatus, getEventBaseText, scheduleUnpin, scheduleReminder, getActiveEvent, deleteEventData, getReminderMessageId } from "./db.js";
import { buildMention, escapeHtml, splitIntoChunks, autoDelete } from "./helpers.js";

// Parse HH:MM from a message string. Interprets the time as Kyiv (Europe/Kyiv) timezone.
// Returns Unix timestamp (today or tomorrow Kyiv time) or null.
function parseEventTime(text) {
  const match = text.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  const now = new Date();
  // Get current Kyiv wall-clock time (values are correct, JS treats it as system-local)
  const kyivNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const candidate = new Date(kyivNow);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate <= kyivNow) candidate.setDate(candidate.getDate() + 1);

  // Convert back to real UTC: offset = (kyivNow - now) is the Kyiv tz offset
  const utcMs = candidate.getTime() + (now.getTime() - kyivNow.getTime());
  return Math.floor(utcMs / 1000);
}


const MAX_PLAYERS = 5;

const HYPE_PHRASES = [
  "Squad locked in! Let's GOOOOOOO! 🚀",
  "Lock and load, legends! 🎮",
  "Let's run it! No excuses! 🏃💨",
  "Time to lock in! 🔒",
  "GG already incoming! 🏆",
  "They don't know what's coming! 😤",
  "Banana squad, rise up! 🍌",
  "It's go time! Let's get this W! 🔥",
  "No mercy! Let's dominate! 💪",
  "Game on! Let's make it count! 🎯"
];

function pickHypePhrase() {
  return HYPE_PHRASES[Math.floor(Math.random() * HYPE_PHRASES.length)];
}


// Keyed by `${chatId}:${messageId}` — frozen when reminder fires, reused on RSVP edits.
const reminderPhraseCache = new Map();

export function clearReminderPhrase(chatId, messageId) {
  reminderPhraseCache.delete(`${chatId}:${messageId}`);
}


function buildKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🍌 Joining", callback_data: "join", style: "success" },
      { text: "🚫 Not joining", callback_data: "not_join", style: "danger" }
    ]]
  };
}

function buildRsvpSection(rsvps) {
  const joining = [];
  const notJoining = [];
  for (const r of rsvps) {
    if (r.status === "join") joining.push(r);
    else notJoining.push(r);
  }
  let section = "";
  if (joining.length > 0)
    section += `\n\n🍌 <b>Joining (${joining.length}):</b>\n${joining.map(buildMention).join(", ")}`;
  if (notJoining.length > 0)
    section += `\n\n🚫 <b>Not joining (${notJoining.length}):</b>\n${notJoining.map(buildMention).join(", ")}`;
  return section;
}

export async function mentionAll(ctx, message = "") {
  if (ctx.chat.type === "private") {
    await ctx.reply("This command only works in group chats.");
    return;
  }

  const rows = getMembers(ctx.chat.id);

  if (rows.length === 0) {
    const reply = await ctx.reply(
      "No members registered yet.\n\nMembers need to use <code>/mute</code> or <code>/unmute</code> to be added to the mention list.",
      { parse_mode: "HTML" }
    );
    autoDelete(ctx, reply);
    return;
  }

  if (!message) {
    const reply = await ctx.reply(
      "Please include an event name and time, e.g.:\n<code>@all CS 22:00</code>",
      { parse_mode: "HTML" }
    );
    autoDelete(ctx, reply);
    return;
  }

  const mentions = rows.map(buildMention);
  const mentionBlock = `<b>Mentioned:</b> ${mentions.join(", ")}`;
  const poster = buildMention(ctx.from);
  const fullText = `${poster}: ${escapeHtml(message)}\n\n${mentionBlock}`;

  const eventTime = parseEventTime(message);

  if (eventTime) {
    const activeEvent = getActiveEvent(ctx.chat.id);
    if (activeEvent) {
      const chatIdStr = String(ctx.chat.id);
      const peerId = chatIdStr.startsWith("-100") ? chatIdStr.slice(4) : chatIdStr.replace("-", "");
      const link = `https://t.me/c/${peerId}/${activeEvent.message_id}`;
      const notice = await ctx.reply(
        `There is already <a href="${link}">an active event</a>. It will be unpinned automatically when it ends.`,
        { parse_mode: "HTML" }
      );
      autoDelete(ctx, notice);
      return;
    }
  }
  let lastSent = null;

  if (eventTime) {
    // Build the full initial text with RSVP section (poster auto-joined) before sending,
    // so the message is delivered to all clients with the keyboard already attached —
    // avoiding the send-then-edit race condition that caused buttons to not appear.
    const initialRsvps = [{ ...ctx.from, status: "join" }];
    const initialText = fullText + buildRsvpSection(initialRsvps);
    const keyboard = buildKeyboard();

    const chunks = splitIntoChunks(initialText);
    for (let i = 0; i < chunks.length; i++) {
      lastSent = await ctx.reply(chunks[i], {
        parse_mode: "HTML",
        ...(i === chunks.length - 1 ? { reply_markup: keyboard } : {})
      });
    }

    try {
      saveEvent(ctx.chat.id, lastSent.message_id, fullText, eventTime);
    } catch (err) {
      console.error("[event] save failed:", err.message);
    }
    saveRsvp(ctx.chat.id, lastSent.message_id, ctx.from, "join");

    try {
      await ctx.pinChatMessage(lastSent.message_id, { disable_notification: true });
      scheduleUnpin(ctx.chat.id, lastSent.message_id, eventTime);
      const reminderAt = eventTime - 10 * 60;
      if (reminderAt > Math.floor(Date.now() / 1000)) {
        scheduleReminder(ctx.chat.id, lastSent.message_id, reminderAt);
      }
      console.log(`[event] created "${message}"`);
    } catch (err) {
      console.error("[event] pin failed:", err.message);
    }
  } else {
    const chunks = splitIntoChunks(fullText);
    for (const chunk of chunks) {
      lastSent = await ctx.reply(chunk, { parse_mode: "HTML" });
    }
    console.log(`[mention] "${message}"`);
  }

  try {
    await ctx.deleteMessage();
  } catch (err) {
    console.error("[event] delete trigger failed:", err.message);
  }
}

export async function cancelEvent(ctx) {
  if (ctx.chat.type === "private") return;

  const activeEvent = getActiveEvent(ctx.chat.id);
  if (!activeEvent) {
    const reply = await ctx.reply("There is no active event to cancel.");
    autoDelete(ctx, reply);
    return;
  }

  const { message_id } = activeEvent;
  const reminderMessageId = getReminderMessageId(ctx.chat.id, message_id);
  await ctx.api.unpinChatMessage(ctx.chat.id, { message_id }).catch(() => {});
  await ctx.api.deleteMessage(ctx.chat.id, message_id).catch(() => {});
  if (reminderMessageId) {
    await ctx.api.deleteMessage(ctx.chat.id, reminderMessageId).catch(() => {});
  }
  deleteEventData(ctx.chat.id, message_id);
  clearReminderPhrase(ctx.chat.id, message_id);
  console.log("[cancel] done");

  try { await ctx.deleteMessage(); } catch {}
}

export async function muteNotifications(ctx) {
  if (ctx.chat.type === "private") { await ctx.reply("This command only works in group chats."); return; }
  const current = getNotificationsStatus(ctx.chat.id, ctx.from.id);
  if (current === false) {
    const reply = await ctx.reply("You are already muted — @all won't mention you.");
    autoDelete(ctx, reply);
    return;
  }
  trackMember(ctx.chat.id, ctx.from);
  setNotifications(ctx.chat.id, ctx.from.id, false);
  console.log("[mute] done");
  const reply = await ctx.reply("You've been muted. You won't be mentioned by @all in this group.\nUse /unmute to re-enable.");
  autoDelete(ctx, reply);
}

export async function unmuteNotifications(ctx) {
  if (ctx.chat.type === "private") { await ctx.reply("This command only works in group chats."); return; }
  const current = getNotificationsStatus(ctx.chat.id, ctx.from.id);
  if (current === true) {
    const reply = await ctx.reply("You are already unmuted and will be mentioned by @all.");
    autoDelete(ctx, reply);
    return;
  }
  trackMember(ctx.chat.id, ctx.from);
  setNotifications(ctx.chat.id, ctx.from.id, true);
  console.log("[unmute] done");
  const reply = await ctx.reply("You've been added to the mention list. You'll be mentioned by @all in this group.");
  autoDelete(ctx, reply);
}

export async function handleRsvp(ctx) {
  const status = ctx.callbackQuery.data; // "join" or "not_join"
  const chatId = ctx.chat.id;

  const activeEvent = getActiveEvent(chatId);
  if (!activeEvent) {
    await ctx.answerCallbackQuery({ text: "This event has already ended." });
    return;
  }
  const messageId = activeEvent.message_id;

  // The tapped button may live on a stale message on a not-yet-synced client
  // (e.g. an older, already-ended event). Only accept taps on the message that
  // is actually the current active event.
  const clickedMessageId = ctx.callbackQuery.message?.message_id;
  if (clickedMessageId && clickedMessageId !== messageId) {
    await ctx.answerCallbackQuery({ text: "This event has already ended." });
    return;
  }

  const row = getEventBaseText(chatId, messageId);
  if (!row) {
    console.error("[rsvp] no active event found");
    await ctx.answerCallbackQuery({ text: "This event has already ended." });
    return;
  }

  const currentStatus = getUserRsvpStatus(chatId, messageId, ctx.from.id);
  if (currentStatus === status) {
    const toastText = status === "join" ? "🍌 You're already joining!" : "🚫 You're already not joining!";
    await ctx.answerCallbackQuery({ text: toastText });
    return;
  }

  // Enforce the squad cap server-side: buttons are hidden at 5/5, but a stale
  // client may still show "Joining". Reject the join instead of going 6/5.
  if (status === "join") {
    const joiningNow = getRsvps(chatId, messageId).filter(r => r.status === "join");
    if (joiningNow.length >= MAX_PLAYERS) {
      console.log("[rsvp] rejected — squad full");
      await ctx.answerCallbackQuery({ text: `🔒 Squad's already full (${MAX_PLAYERS}/${MAX_PLAYERS})!` });
      return;
    }
  }

  saveRsvp(chatId, messageId, ctx.from, status);

  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  const isFull = joining.length >= MAX_PLAYERS;
  const fullPhrase = isFull ? pickHypePhrase() : "";
  console.log(`[rsvp] ${status === "join" ? "joined" : "not joining"} (${joining.length}/${MAX_PLAYERS})${isFull ? " — squad full" : ""}`);
  const newText = row.base_text + buildRsvpSection(rsvps) + (isFull ? `\n\n🔥 <b>${fullPhrase} (${MAX_PLAYERS}/${MAX_PLAYERS})</b> 🔒` : "");
  const keyboard = isFull ? { inline_keyboard: [] } : buildKeyboard();

  try {
    await ctx.api.editMessageText(chatId, messageId, newText, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  } catch (err) {
    if (!err.message?.includes("message is not modified")) {
      console.error("[rsvp] edit failed:", err.message);
    }
  }

  // If the reminder has already been sent, update its joining list too.
  const reminderMessageId = getReminderMessageId(chatId, messageId);
  if (reminderMessageId) {
    const phrase = reminderPhraseCache.get(`${chatId}:${messageId}`) ?? pickHypePhrase();
    const updatedReminderText = buildReminderText(row, joining, phrase);
    await ctx.api.editMessageText(chatId, reminderMessageId, updatedReminderText, { parse_mode: "HTML" })
      .catch(err => {
        if (!err.message?.includes("message is not modified")) {
          console.error("[reminder] edit failed:", err.message);
        }
      });
  }

  const toastText = status === "join"
    ? (isFull ? `🔥 You're in! ${fullPhrase} (${MAX_PLAYERS}/${MAX_PLAYERS}) 🔒` : "🍌 You're joining!")
    : "🚫 You aren't joining!";
  await ctx.answerCallbackQuery({ text: toastText });
}

function buildReminderText(row, joining, phrase) {
  const timeStr = row.event_time
    ? new Date(row.event_time * 1000).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" })
    : "soon";
  const firstLine = row.base_text.split("\n")[0];
  const colonIdx = firstLine.indexOf(": ");
  const eventName = colonIdx !== -1 ? firstLine.slice(colonIdx + 2).trim() : null;
  return (
    `🔔 <b>Reminder!</b> Event starts in <b>10 minutes</b> (at ${timeStr}) 🎮` +
    (eventName ? `\n\n${eventName}` : "") +
    `\n\n🍌 <b>Joining (${joining.length}):</b>\n${joining.map(buildMention).join(", ")}` +
    `\n\n🔥 <b>${phrase}</b>`
  );
}

export async function sendReminder(api, chatId, messageId) {
  const row = getEventBaseText(chatId, messageId);
  if (!row) return;

  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  if (joining.length <= 1) {
    console.log(`[reminder] skipped — ${joining.length} joining`);
    return;
  }

  const phrase = pickHypePhrase();
  reminderPhraseCache.set(`${chatId}:${messageId}`, phrase);
  const text = buildReminderText(row, joining, phrase);
  const sent = await api.sendMessage(chatId, text, { parse_mode: "HTML" });
  console.log(`[reminder] sent — ${joining.length} joining`);
  return sent;
}
