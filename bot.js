import { Bot } from "grammy";
import { mentionAll, muteNotifications, unmuteNotifications, handleRsvp, sendReminder, cancelEvent, clearReminderPhrase } from "./src/handlers.js";
import { getDueUnpins, getDueReminders, deleteScheduledReminder, deleteEventData, saveReminderMessageId } from "./src/db.js";

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set.");
}

const bot = new Bot(process.env.BOT_TOKEN);

// ─── Commands: /mute, /unmute, /cancel ───────────────────────────────────────

bot.command("mute", muteNotifications);
bot.command("unmute", unmuteNotifications);
bot.command("cancel", cancelEvent);

// ─── Text trigger: @all <optional message> ────────────────────────────────────
// Works when the bot has privacy mode disabled (set via BotFather → /setprivacy → Disable).

bot.hears(/^@all(?:\s+([\s\S]*))?$/i, async (ctx) => {
  const message = (ctx.match[1] ?? "").trim();
  await mentionAll(ctx, message);
});

// ─── Callback queries: joining buttons ───────────────────────────────────────

bot.callbackQuery(/^(join|not_join)$/, handleRsvp);

// ─── Unpin + reminder scheduler: check every minute ──────────────────────────

const schedulerInterval = setInterval(async () => {
  const now = Math.floor(Date.now() / 1000);

  const reminderJobs = getDueReminders(now).map(({ chat_id, message_id }) =>
    sendReminder(bot.api, chat_id, message_id)
      .then(sent => {
        if (sent) saveReminderMessageId(chat_id, message_id, sent.message_id);
      }, err => console.error(`[reminder] send failed chat=${chat_id} message=${message_id}:`, err.message))
      .finally(() => deleteScheduledReminder(chat_id, message_id))
  );

  await Promise.allSettled(reminderJobs);

  const unpinJobs = getDueUnpins(now).map(({ chat_id, message_id, reminder_message_id }) => {
    let unpinOk = false;
    return bot.api.unpinChatMessage(chat_id, { message_id })
      .then(() => { unpinOk = true; })
      .catch(err => {
        if (err.message?.includes("message to unpin not found")) {
          unpinOk = true; // already unpinned manually — still clean up buttons
        } else {
          console.error(`[unpin] failed chat=${chat_id} message=${message_id}:`, err.message);
        }
      })
      .then(() => {
        if (!unpinOk) return;
        console.log(`[unpin] chat=${chat_id} message=${message_id}`);
        return Promise.all([
          bot.api.editMessageReplyMarkup(chat_id, message_id, { reply_markup: { inline_keyboard: [] } })
            .catch(() => {}),
          reminder_message_id
            ? bot.api.deleteMessage(chat_id, reminder_message_id).catch(() => {})
            : Promise.resolve()
        ]);
      })
      .finally(() => { deleteEventData(chat_id, message_id); clearReminderPhrase(chat_id, message_id); });
  });

  await Promise.allSettled(unpinJobs);
}, 60_000);

// ─── Delete "pinned a message" service notifications ─────────────────────────

bot.on("message:pinned_message", async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
});

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  const { ctx, error } = err;
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`Error handling update ${ctx.update.update_id}:`, msg);
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
