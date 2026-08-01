// Context plumbing shared by every handler: replying privately, cleaning up the trigger, and the
// group-only guard each entry point opens with. Lives beside the handlers rather than in view/
// because all of it needs a grammy Context — it acts on an update, it doesn't render one.

import type { Context } from "grammy";
import type { User } from "@grammyjs/types";
import { t } from "../view/i18n.ts";

type ReplyOptions = NonNullable<Parameters<Context["reply"]>[1]>;

// Fallback for sendEphemeral: post a reply and delete it, plus the trigger, after 10s.
function autoDelete(ctx: Context, reply: { message_id: number }): void {
  setTimeout(async () => {
    await deleteTrigger(ctx);
    // autoDelete only runs after a reply succeeded in this chat, so ctx.chat is present.
    await ctx.api.deleteMessage(ctx.chat!.id, reply.message_id).catch(() => {});
  }, 10_000);
}

// Remove the message that triggered this handler. Skipped when it arrived ephemeral (an
// is_ephemeral command): nobody but its sender ever saw it, and it carries message_id 0, which
// deleteMessage rejects. Still runs for a plainly-sent trigger — @all, or a client ignoring the flag.
export async function deleteTrigger(ctx: Context): Promise<void> {
  if (ctx.msg?.ephemeral_message_id !== undefined) return;
  await ctx.deleteMessage().catch(() => {});
}

// Reply visible only to the invoking user, so transient feedback never clutters the group.
// Group chats only; falls back to send-then-delete in private chats or if the send fails.
export async function sendEphemeral(ctx: Context, text: string, opts: ReplyOptions = {}): Promise<void> {
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  if (isGroup && ctx.from?.id) {
    try {
      await ctx.reply(text, { ...opts, receiver_user_id: ctx.from.id });
      // The reply is private, but the message that triggered it isn't always — remove it.
      await deleteTrigger(ctx);
      return;
    } catch (err) {
      console.warn("[ephemeral] send failed, falling back to auto-delete:", (err as Error).message);
    }
  }
  const reply = await ctx.reply(text, opts);
  autoDelete(ctx, reply);
}

// Any context that has resolved a chat — every command and text trigger the bot registers.
type ChattyContext = Context & { chat: NonNullable<Context["chat"]> };

// The two guards every command opens with: group chats only, and a real sender. A DM gets the
// one-line explanation; an anonymous admin or channel post is dropped, having nobody to answer
// privately. Wrapped rather than repeated because the cleared `default` command scope leans on it
// — see CLAUDE.md. `from` comes through narrowed, so handlers never re-check it.
export function groupOnly<C extends ChattyContext, A extends unknown[]>(
  handler: (ctx: C, from: User, ...args: A) => Promise<void>,
): (ctx: C, ...args: A) => Promise<void> {
  return async (ctx, ...args) => {
    if (ctx.chat.type === "private") {
      await ctx.reply(t("groupOnly"));
      return;
    }
    if (!ctx.from) return;
    await handler(ctx, ctx.from, ...args);
  };
}
