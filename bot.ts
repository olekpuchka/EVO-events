import { Bot } from "grammy";
import { mentionAll, muteNotifications, unmuteNotifications, handleRsvp, sendReminder, cancelEvent, clearEventPhrases, registerFaceit, autoPostResult, pendingPinDeletion, unpinEventMessage } from "./src/handlers.ts";
import { getDueUnpins, getDueReminders, deleteScheduledReminder, deleteEventData, saveReminderMessageId, getAllFaceitChats, pruneOldPostedMatches } from "./src/db.ts";

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set.");
}
if (!process.env.FACEIT_API_KEY) {
  console.warn("FACEIT_API_KEY is not set — /faceit command will fail.");
}

const bot = new Bot(process.env.BOT_TOKEN);

// ─── Normalize command case (grammy matches /command exactly, case-sensitive) ─

bot.use((ctx, next) => {
  const msg = ctx.message ?? ctx.channelPost;
  const entity = msg?.entities?.find(e => e.type === "bot_command" && e.offset === 0);
  if (entity && msg?.text) {
    const cmd = msg.text.slice(0, entity.length);
    msg.text = cmd.toLowerCase() + msg.text.slice(entity.length);
  }
  return next();
});

// ─── Commands: /mute, /unmute, /cancel ───────────────────────────────────────

bot.command("mute", muteNotifications);
bot.command("unmute", unmuteNotifications);
bot.command("cancel", cancelEvent);
bot.command("faceit", registerFaceit);

// ─── Text trigger: @all <optional message> ────────────────────────────────────
// Works when the bot has privacy mode disabled (set via BotFather → /setprivacy → Disable).

bot.hears(/^@all(?:\s+([\s\S]*))?$/i, async (ctx) => {
  const message = (ctx.match[1] ?? "").trim();
  await mentionAll(ctx, message);
});

// ─── Callback queries: joining buttons ───────────────────────────────────────

bot.callbackQuery(/^(join|not_join)$/, handleRsvp);

// ─── Unpin + reminder scheduler: check every minute ──────────────────────────

const FACEIT_POLL_INTERVAL = Math.max(5, Number(process.env.FACEIT_POLL_MINUTES) || 20) * 60;
const PRUNE_INTERVAL = 24 * 60 * 60;
let lastFaceitPoll = 0;
// Seeded with the boot time, a prune needed 24h of unbroken uptime — with regular redeploys
// it never ran at all.
let lastPrune = 0;

async function pollFaceit(): Promise<void> {
  try {
    await Promise.allSettled(
      getAllFaceitChats().map(chatId =>
        autoPostResult(bot.api, chatId).catch(err => console.error("[faceit] chat failed:", err.message)))
    );
  } catch (err) {
    console.error("[faceit] poll failed:", (err as Error).message);
  }
}

async function processSchedules(now: number): Promise<void> {
  const reminderJobs = getDueReminders(now).map(async ({ chat_id, message_id }) => {
    // Claim the row before the send, not after: sending awaits an AI phrase, and a tick that
    // starts meanwhile must not find the same row and send the reminder twice. Claiming early
    // loses nothing — a failed send was never retried either.
    deleteScheduledReminder(chat_id, message_id);
    try {
      const sent = await sendReminder(bot.api, chat_id, message_id);
      if (sent) saveReminderMessageId(chat_id, message_id, sent.message_id);
    } catch (err) {
      console.error("[reminder] send failed:", (err as Error).message);
    }
  });

  await Promise.allSettled(reminderJobs);

  const unpinJobs = getDueUnpins(now).map(async ({ chat_id, message_id, reminder_message_id }) => {
    try {
      await unpinEventMessage(bot.api, chat_id, message_id);
      await bot.api.editMessageReplyMarkup(chat_id, message_id, { reply_markup: { inline_keyboard: [] } })
        .catch(() => {});
      if (reminder_message_id) {
        await bot.api.deleteMessage(chat_id, reminder_message_id).catch(() => {});
      }
    } finally {
      deleteEventData(chat_id, message_id);
      clearEventPhrases(chat_id, message_id);
    }
  });

  await Promise.allSettled(unpinJobs);
}

// A poll is guarded because it is not idempotent: autoPostResult marks a match posted only after
// sending it, so two overlapping polls can post the same result twice. Left unawaited so no
// reminder or unpin waits on it — safe to skip a turn, since fetch bounds a stuck poll at ~5 min.
let pollingFaceit = false;
const schedulerInterval = setInterval(async () => {
  const now = Math.floor(Date.now() / 1000);

  if (now - lastFaceitPoll >= FACEIT_POLL_INTERVAL && !pollingFaceit) {
    lastFaceitPoll = now;
    pollingFaceit = true;
    void pollFaceit().finally(() => { pollingFaceit = false; });
  }

  if (now - lastPrune >= PRUNE_INTERVAL) {
    lastPrune = now;
    try { pruneOldPostedMatches(); } catch (err) { console.error("[prune] failed:", (err as Error).message); }
  }

  // Not serialized: reminder jobs claim their row before the slow send, and repeating an unpin is
  // idempotent. A lock here would let one stalled AI phrase hold up every other chat's reminder.
  await processSchedules(now).catch(err => console.error("[scheduler] failed:", (err as Error).message));
}, 60_000);

// ─── Delete "pinned a message" service notifications (only for @all pins) ────

bot.on("message:pinned_message", async (ctx) => {
  const expected = pendingPinDeletion.get(ctx.chat.id);
  if (expected !== ctx.message.pinned_message?.message_id) return;
  pendingPinDeletion.delete(ctx.chat.id);
  try { await ctx.deleteMessage(); } catch {}
});

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  const { error } = err;
  const msg = error instanceof Error ? error.message : String(error);
  console.error("[error]", msg);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

process.once("SIGTERM", () => {
  console.log("SIGTERM received, stopping bot…");
  clearInterval(schedulerInterval);
  bot.stop();
});

process.once("SIGINT", () => {
  console.log("SIGINT received, stopping bot…");
  clearInterval(schedulerInterval);
  bot.stop();
});

// ─── Start ────────────────────────────────────────────────────────────────────

bot.start({
  onStart: ({ username }) => console.log(`@${username} is running (Node ${process.version}).`),
});
