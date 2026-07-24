import type { Context } from "grammy";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, c => HTML_ESCAPES[c]);
}

// AI phrases are generated as Telegram HTML: the prompt and sanitize() together
// guarantee the only tags present are balanced <b>/<i>. Fully escaping them would
// show the tags as literal text, so escape everything then restore just those two.
export function escapeAiHtml(text: string): string {
  return escapeHtml(text).replace(/&lt;(\/?[bi])&gt;/g, "<$1>");
}

// Rich-message blocks take literal text, not HTML, so the <b>/<i> tags an AI phrase
// carries would render as visible tags. The blockquote is already styled italic, so
// drop the tags entirely rather than leave them showing.
export function stripAiHtml(text: string): string {
  return text.replace(/<\/?[bi]>/g, "");
}

// The minimal shape buildMention needs — satisfied by both a grammy `User`
// (ctx.from) and the member/RSVP rows read from SQLite.
export interface Mentionable {
  id: number;
  username?: string | null;
  first_name: string;
  last_name?: string | null;
}

type ReplyOptions = NonNullable<Parameters<Context["reply"]>[1]>;

// Fallback for sendEphemeral: post a reply and delete it (plus the command) after 10s.
function autoDelete(ctx: Context, reply: { message_id: number }): void {
  setTimeout(async () => {
    await ctx.deleteMessage().catch(() => {});
    // autoDelete only runs after a reply succeeded in this chat, so ctx.chat is present.
    await ctx.api.deleteMessage(ctx.chat!.id, reply.message_id).catch(() => {});
  }, 10_000);
}

// Reply visible only to the invoking user, so transient feedback never clutters the group.
// Group chats only; falls back to send-then-delete in private chats or if the send fails.
export async function sendEphemeral(ctx: Context, text: string, opts: ReplyOptions = {}): Promise<void> {
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  if (isGroup && ctx.from?.id) {
    try {
      await ctx.reply(text, { ...opts, receiver_user_id: ctx.from.id });
      // Reply is private, but the triggering command is still public — remove it.
      await ctx.deleteMessage().catch(() => {});
      return;
    } catch (err) {
      console.warn("[ephemeral] send failed, falling back to auto-delete:", (err as Error).message);
    }
  }
  const reply = await ctx.reply(text, opts);
  autoDelete(ctx, reply);
}

export function buildMention(user: Mentionable): string {
  const name = user.username
    ? `@${user.username}`
    : [user.first_name, user.last_name].filter(Boolean).join(" ");
  return `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>`;
}
