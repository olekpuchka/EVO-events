const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export function escapeHtml(text) {
  return text.replace(/[&<>]/g, c => HTML_ESCAPES[c]);
}

// Fallback for sendEphemeral: post a reply and delete it (plus the command) after 10s.
function autoDelete(ctx, reply) {
  setTimeout(async () => {
    await ctx.deleteMessage().catch(() => {});
    await ctx.api.deleteMessage(ctx.chat.id, reply.message_id).catch(() => {});
  }, 10_000);
}

// Reply visible only to the invoking user, so transient feedback never clutters the group.
// Group chats only; falls back to send-then-delete in private chats or if the send fails.
export async function sendEphemeral(ctx, text, opts = {}) {
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  if (isGroup && ctx.from?.id) {
    try {
      await ctx.reply(text, { ...opts, receiver_user_id: ctx.from.id });
      // Reply is private, but the triggering command is still public — remove it.
      await ctx.deleteMessage().catch(() => {});
      return;
    } catch (err) {
      console.warn("[ephemeral] send failed, falling back to auto-delete:", err.message);
    }
  }
  const reply = await ctx.reply(text, opts);
  autoDelete(ctx, reply);
}

export function buildMention(user) {
  const name = user.username
    ? `@${user.username}`
    : [user.first_name, user.last_name].filter(Boolean).join(" ");
  return `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>`;
}
