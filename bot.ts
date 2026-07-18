import { Bot } from "grammy";
import { mentionAll, muteNotifications, unmuteNotifications, handleRsvp, sendReminder, cancelEvent, clearEventPhrases, registerFaceit, autoPostResult, pendingPinDeletion } from "./src/handlers.ts";
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
let lastPrune = Math.floor(Date.now() / 1000);

const schedulerInterval = setInterval(async () => {
  const now = Math.floor(Date.now() / 1000);

  if (now - lastFaceitPoll >= FACEIT_POLL_INTERVAL) {
    lastFaceitPoll = now;
    const chats = getAllFaceitChats();
    await Promise.allSettled(
      chats.map(chatId => autoPostResult(bot.api, chatId).catch(err => console.error("[faceit] poll failed:", err.message)))
    );
  }

  if (now - lastPrune >= PRUNE_INTERVAL) {
    lastPrune = now;
    try { pruneOldPostedMatches(); } catch (err) { console.error("[prune] failed:", (err as Error).message); }
  }

  const reminderJobs = getDueReminders(now).map(({ chat_id, message_id }) =>
    sendReminder(bot.api, chat_id, message_id)
      .then(sent => {
        if (sent) saveReminderMessageId(chat_id, message_id, sent.message_id);
      }, err => console.error("[reminder] send failed:", err.message))
      .finally(() => deleteScheduledReminder(chat_id, message_id))
  );

  await Promise.allSettled(reminderJobs);

  const unpinJobs = getDueUnpins(now).map(({ chat_id, message_id, reminder_message_id }) => {
    let unpinOk = false;
    return bot.api.unpinChatMessage(chat_id, message_id)
      .then(() => { unpinOk = true; })
      .catch(err => {
        if (err.message?.includes("message to unpin not found")) {
          unpinOk = true; // already unpinned manually — still clean up buttons
        } else {
          console.error("[unpin] failed:", err.message);
        }
      })
      .then(() => {
        if (!unpinOk) return;
        return Promise.all([
          bot.api.editMessageReplyMarkup(chat_id, message_id, { reply_markup: { inline_keyboard: [] } })
            .catch(() => {}),
          reminder_message_id
            ? bot.api.deleteMessage(chat_id, reminder_message_id).catch(() => {})
            : Promise.resolve()
        ]);
      })
      .finally(() => { deleteEventData(chat_id, message_id); clearEventPhrases(chat_id, message_id); });
  });

  await Promise.allSettled(unpinJobs);
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
