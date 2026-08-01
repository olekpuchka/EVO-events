// Turning values into the HTML Telegram renders. No context, no I/O — pure string work.

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

export function buildMention(user: Mentionable): string {
  const name = user.username
    ? `@${user.username}`
    : [user.first_name, user.last_name].filter(Boolean).join(" ");
  return `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>`;
}
