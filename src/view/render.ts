// Event data → the strings and keyboards Telegram shows. No database, no API calls, no context.
//
// The squad cap lives here because it decides what renders: which keyboard, whether the locked
// banner appears, how many seats the reminder advertises. handlers/events.ts imports it for the
// server-side cap, so the two can never disagree.

import { buildMention, escapeAiHtml } from "./html.ts";
import type { Mentionable } from "./html.ts";
import { t } from "./i18n.ts";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import type { ActiveEventRow, EventRow, RsvpRow } from "../types.ts";

export const MAX_PLAYERS = 5;

// The one place the cap is applied. Every "is this squad locked?" question goes through here.
export const isSquadFull = (joining: readonly unknown[]): boolean => joining.length >= MAX_PLAYERS;

// Anything with a status that can also be mentioned — covers both RSVP rows and
// the poster's synthetic "auto-join" entry ({ ...ctx.from, status: "join" }).
export type RsvpLike = Mentionable & { status: string };

// base_text is always `<a …>poster</a>: event`. Split on the closing tag, not the first ": " —
// a display name containing ": " would cut mid-mention and leave a stray </a> Telegram rejects.
const POSTER_SEP = "</a>: ";

export function extractEventName(baseText: string): string | null {
  const firstLine = baseText.split("\n")[0];
  const sep = firstLine.indexOf(POSTER_SEP);
  return sep === -1 ? null : firstLine.slice(sep + POSTER_SEP.length).trim();
}

// Deep link to a message. t.me/c/ wants the bare peer ID, without the supergroup -100 prefix.
function messageLink(chatId: number | string, messageId: number): string {
  const chatIdStr = String(chatId);
  const peerId = chatIdStr.startsWith("-100") ? chatIdStr.slice(4) : chatIdStr.replace("-", "");
  return `https://t.me/c/${peerId}/${messageId}`;
}

// One line of the "which event?" list. base_text is already HTML-escaped, so the name is safe to
// nest in the link — and always present, since every stored base_text carries the poster mention.
export function eventPickerLine(chatId: number | string, event: ActiveEventRow): string {
  const label = extractEventName(event.base_text) ?? "?";
  return `• <a href="${messageLink(chatId, event.message_id)}">${label}</a>`;
}

export function buildKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: t("joinButton"), callback_data: "join", style: "success" },
      { text: t("notJoinButton"), callback_data: "not_join", style: "danger" }
    ]]
  };
}

// When the squad is full we drop the "Joining" button but keep "Not joining",
// so a locked-in player who can no longer make it can free up their seat.
// Dropping out takes the count back below the cap, which restores buildKeyboard().
export function buildLeaveOnlyKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: t("notJoinButton"), callback_data: "not_join", style: "danger" }
    ]]
  };
}

// Deep link to the pinned event, where the RSVP buttons live. Re-sent on every reminder edit:
// omitting reply_markup on an edit strips the keyboard.
export function buildEventLinkKeyboard(chatId: number | string, messageId: number): InlineKeyboardMarkup {
  // primary (blue), not success — green is the join button's colour, and this only navigates.
  return { inline_keyboard: [[{ text: t("openEvent"), url: messageLink(chatId, messageId), style: "primary" }]] };
}

// "1735 Elo", or the unranked label when FACEIT has no Elo for the account.
export const eloLabel = (elo: number | null | undefined): string => elo ? `${elo} Elo` : t("unranked");

// Members who haven't answered either way — "not joining" counts as answered. Shared by the event's
// "Mentioned:" block and the reminder's nudge, so the two can't disagree on who's still undecided.
export function pendingMembers(mentionedUsers: Mentionable[], rsvps: { id: number }[]): Mentionable[] {
  const responded = new Set(rsvps.map(r => r.id));
  return mentionedUsers.filter(u => !responded.has(u.id));
}

// Renders the undecided list — responders already show in the Joining/Not joining sections.
// Returns "" when nobody's left, so the block disappears instead of leaving an empty header.
export function buildMentionedBlock(pending: Mentionable[]): string {
  if (pending.length === 0) return "";
  return `\n\n<b>${t("mentioned")}</b> ${pending.map(buildMention).join(", ")}`;
}

export function buildRsvpSection(rsvps: RsvpLike[]): string {
  const joining: RsvpLike[] = [];
  const notJoining: RsvpLike[] = [];
  for (const r of rsvps) {
    if (r.status === "join") joining.push(r);
    else notJoining.push(r);
  }
  let section = "";
  if (joining.length > 0)
    section += `\n\n${t("joiningHeader", joining.length)}\n${joining.map(buildMention).join(", ")}`;
  if (notJoining.length > 0)
    section += `\n\n${t("notJoiningHeader", notJoining.length)}\n${notJoining.map(buildMention).join(", ")}`;
  return section;
}

export function buildReminderText(row: EventRow, joining: RsvpRow[], phrase: string, pending: Mentionable[]): string {
  const eventName = extractEventName(row.base_text);
  // Last call for the open seats, aimed at whoever hasn't answered either way. Gone once the squad
  // locks — nothing left to recruit for — or once everyone has answered.
  const seatsLeft = MAX_PLAYERS - joining.length;
  const nudge = seatsLeft > 0 && pending.length > 0
    ? `\n\n${t("seatsLeft", seatsLeft, pending.map(buildMention).join(", "))}`
    : "";
  return (
    t("reminderHeader") +
    (eventName ? `\n\n${eventName}` : "") +
    `\n\n${t("joiningHeader", joining.length)}\n${joining.map(buildMention).join(", ")}` +
    nudge +
    `\n\n<blockquote><i>${escapeAiHtml(phrase)}</i></blockquote>`
  );
}
