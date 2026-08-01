import "./src/log.ts"; // first — ESM runs imports in order, so startup warnings are stamped too
import { Bot } from "grammy";
import type { BotCommand } from "@grammyjs/types";
import { mentionAll, muteNotifications, unmuteNotifications, handleRsvp, sendReminder, cancelEvent, endEvent, registerFaceit, claimBotPin, unpinEventMessage, showHelp } from "./src/handlers/events.ts";
import { autoPostResult } from "./src/handlers/results.ts";
import { getDueUnpins, getDueReminders, deleteScheduledReminder, saveReminderMessageId, getAllFaceitChats, pruneOldPostedMatches } from "./src/adapters/db.ts";
import { t } from "./src/view/i18n.ts";
import { BOT_TOKEN, FACEIT_API_KEY, DEEPSEEK_API_KEY, FACEIT_POLL_MINUTES } from "./src/config.ts";

// State the config up front — a missing FACEIT key otherwise just 401s forever, silently.
if (!BOT_TOKEN) {
  console.error("[config] BOT_TOKEN is not set — cannot start.");
  process.exit(1);
}
if (!FACEIT_API_KEY) {
  console.warn("[config] FACEIT_API_KEY is not set — /faceit and auto match results will fail (every poll 401s).");
}
if (!DEEPSEEK_API_KEY) {
  console.log("[config] DEEPSEEK_API_KEY is not set — using built-in phrases instead of AI.");
}

const bot = new Bot(BOT_TOKEN);

// ─── Normalize command case (grammy matches /command exactly, case-sensitive) ─

// Only `message`: grammy resolves a command from `ctx.message ?? ctx.channelPost`, but
// `allowed_updates` below no longer admits a channel post — and every handler dropped one anyway,
// having no `from` to answer.
bot.use((ctx, next) => {
  const msg = ctx.message;
  const entity = msg?.entities?.find(e => e.type === "bot_command" && e.offset === 0);
  if (entity && msg?.text) {
    const cmd = msg.text.slice(0, entity.length);
    msg.text = cmd.toLowerCase() + msg.text.slice(entity.length);
  }
  return next();
});

// ─── Commands ────────────────────────────────────────────────────────────────

bot.command("mute", muteNotifications);
bot.command("unmute", unmuteNotifications);
bot.command("cancel", cancelEvent);
bot.command("faceit", registerFaceit);
bot.command("help", showHelp);

// ─── Command menu ─────────────────────────────────────────────────────────────
// Telegram's command registry lives here rather than in BotFather, so descriptions follow
// LANGUAGE and ship with the deploy. Group scope only: every command returns early in a DM.

// is_ephemeral has clients hide the invoking "/command" from everyone but its sender, so it never
// reaches the group at all — better than posting it and deleting it a moment later. Telegram's
// reply restrictions on ephemeral messages (15s window, reply must itself be ephemeral) apply to
// replying *to* one, so /cancel's "reply to the event you mean" scoping is unaffected.
const GROUP_COMMANDS: BotCommand[] = [
  { command: "cancel", description: t("cmdCancel"), is_ephemeral: true },
  { command: "mute", description: t("cmdMute"), is_ephemeral: true },
  { command: "unmute", description: t("cmdUnmute"), is_ephemeral: true },
  { command: "faceit", description: t("cmdFaceit"), is_ephemeral: true },
  { command: "help", description: t("cmdHelp"), is_ephemeral: true },
];

// Re-published on every boot: idempotent, and it makes the registry a deploy artifact.
// Each scope is settled on its own so a flood-wait on one still lets the other land.
async function publishCommands(): Promise<void> {
  const results = await Promise.allSettled([
    bot.api.setMyCommands(GROUP_COMMANDS, { scope: { type: "all_group_chats" } }),
    // Telegram falls back to the default scope wherever a narrower one is unset, so clearing it
    // both drops anything BotFather left behind and leaves DMs with no menu at all.
    bot.api.setMyCommands([], { scope: { type: "default" } }),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[commands] publish failed:", result.reason?.message ?? result.reason);
    }
  }
}

// ─── Text trigger: @all <optional message> ────────────────────────────────────
// Works when the bot has privacy mode disabled (set via BotFather → /setprivacy → Disable).

bot.hears(/^@all(?:\s+([\s\S]*))?$/i, async (ctx) => {
  const message = (ctx.match[1] ?? "").trim();
  await mentionAll(ctx, message);
});

// ─── Callback queries: joining buttons ───────────────────────────────────────

bot.callbackQuery(/^(join|not_join)$/, handleRsvp);

// ─── Unpin + reminder scheduler: check every minute ──────────────────────────

const FACEIT_POLL_INTERVAL = FACEIT_POLL_MINUTES * 60;
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
      console.log(`[event] ended "${endEvent(chat_id, message_id)}"`);
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
  // Not ours (a member pinned something) → leave the notice alone.
  const pinned = ctx.message.pinned_message?.message_id;
  if (pinned === undefined || !claimBotPin(ctx.chat.id, pinned)) return;
  try { await ctx.deleteMessage(); } catch {}
});

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  const { error } = err;
  const msg = error instanceof Error ? error.message : String(error);
  console.error("[error]", msg);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

// Both signals land here; the container sends SIGTERM on every redeploy.
//
// The database is deliberately left open. SQLite auto-checkpoints the WAL every 1000 pages, so it
// self-caps near 4MB unaided, and closing here would race the FACEIT poll and the scheduler tick —
// both outlive bot.stop() and would throw on a finalized statement mid-write. An unclosed WAL is
// replayed on the next open; a half-written one is not.
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, stopping bot…`);
  clearInterval(schedulerInterval);
  await bot.stop();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

// ─── Start ────────────────────────────────────────────────────────────────────

bot.start({
  // Only the two update types anything here handles: `message` carries @all, every command and the
  // pinned-message notice; `callback_query` carries the RSVP taps. Left unset, Telegram also sends
  // edited messages, channel posts and business messages — all fetched, parsed and dropped.
  allowed_updates: ["message", "callback_query"],
  onStart: ({ username }) => {
    console.log(`@${username} is running (Node ${process.version}).`);
    // Unawaited — the menu is decoration; a slow registry call must not delay answering updates.
    void publishCommands();
  },
});
