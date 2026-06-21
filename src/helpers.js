const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export function escapeHtml(text) {
  return text.replace(/[&<>]/g, c => HTML_ESCAPES[c]);
}

export function autoDelete(ctx, reply) {
  setTimeout(async () => {
    await ctx.deleteMessage().catch(() => {});
    await ctx.api.deleteMessage(ctx.chat.id, reply.message_id).catch(() => {});
  }, 10_000);
}

export function buildMention(user) {
  const name = user.username
    ? `@${user.username}`
    : [user.first_name, user.last_name].filter(Boolean).join(" ");
  return `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>`;
}

export function splitIntoChunks(text, maxLength = 4096) {
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
