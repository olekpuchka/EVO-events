import "dotenv/config";
import { Bot } from "grammy";

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set. Please create a .env file with your bot token.");
}

const bot = new Bot(process.env.BOT_TOKEN);

/**
 * In-memory store for group members.
 * Structure: Map<chatId, Map<userId, User>>
 *
 * NOTE: This resets on every bot restart. For persistence, replace with a
 * database (e.g. SQLite, Redis) using the same interface.
 */
const memberStore = new Map();

/**
 * Save a user to the in-memory store for the given chat.
 * Bots are intentionally excluded from mentions.
 */
function trackMember(chatId, user) {
  if (!user || user.is_bot) return;
  const key = String(chatId);
  if (!memberStore.has(key)) {
    memberStore.set(key, new Map());
  }
  memberStore.get(key).set(user.id, user);
}

/**
 * Build a Telegram HTML mention for a user.
 * Uses @username when available, otherwise a text-mention link.
 */
function buildMention(user) {
  if (user.username) {
    return `@${user.username}`;
  }
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Split a long string into chunks that respect the Telegram 4096-char limit.
 * Tries to split on word boundaries.
 */
function splitIntoChunks(text, maxLength = 4096) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let current = "";

  for (const word of text.split(" ")) {
    if (current.length + 1 + word.length > maxLength) {
      chunks.push(current.trim());
      current = word;
    } else {
      current += (current ? " " : "") + word;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Core logic: mention all tracked members in the chat with an optional message.
 */
async function mentionAll(ctx, message = "") {
  if (ctx.chat.type === "private") {
    await ctx.reply("This command only works in group chats.");
    return;
  }

  const members = memberStore.get(String(ctx.chat.id));

  if (!members || members.size === 0) {
    await ctx.reply(
      "No members tracked yet.\n\nMembers are tracked as they send messages in this group. Once people start chatting, use <code>/all</code> or <code>@all</code> to mention everyone.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const mentions = [...members.values()].map(buildMention);
  const mentionBlock = mentions.join(" ");
  const fullText = message
    ? `${mentionBlock}\n\n${escapeHtml(message)}`
    : mentionBlock;

  for (const chunk of splitIntoChunks(fullText)) {
    await ctx.reply(chunk, { parse_mode: "HTML" });
  }
}

// ─── Middleware: track every message sender ───────────────────────────────────

bot.on("message", async (ctx, next) => {
  const type = ctx.chat?.type;
  if (type === "group" || type === "supergroup") {
    // Track the sender
    trackMember(ctx.chat.id, ctx.from);

    // Track users who are added to the group
    const newMembers = ctx.message.new_chat_members;
    if (newMembers) {
      for (const member of newMembers) {
        trackMember(ctx.chat.id, member);
      }
    }
  }
  await next();
});

// ─── Command: /all <optional message> ─────────────────────────────────────────

bot.command("all", async (ctx) => {
  await mentionAll(ctx, ctx.match);
});

// ─── Text trigger: @all <optional message> ────────────────────────────────────
// Works when the bot has privacy mode disabled (set via BotFather → /setprivacy → Disable).

bot.hears(/^@all(?:\s+([\s\S]*))?$/i, async (ctx) => {
  const message = (ctx.match[1] ?? "").trim();
  await mentionAll(ctx, message);
});

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  const { ctx, error } = err;
  console.error(`Error handling update ${ctx.update.update_id}:`, error);
});

// ─── Start ────────────────────────────────────────────────────────────────────

bot.start({
  onStart: ({ username }) => console.log(`@${username} is running. Press Ctrl+C to stop.`),
});
