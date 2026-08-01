// Everything done *to* the model's reply before it can be sent: sanitizing, the
// checks that reject a phrase, swapping player codes back to nicknames, and the
// emoji. Pure, and the mirror of prompt.ts — that module decides what to ask for
// and what the answer will be judged against, this one applies the verdict.
//
// `finalizePhrase` returns null for a phrase that must not ship. The caller retries
// once before falling back; see **The AI call** in CLAUDE.md.

import type { Kind, PhraseChecks, PromptPlayer } from "../types.ts";

/* ------------------------------------------------------------------ *
 * Emoji are picked in code and appended after generation — one less
 * rule for the model to fail, and guaranteed variety.
 * ------------------------------------------------------------------ */

const EMOJIS: Record<Kind, string[]> = {
  hype: ["🔥", "⚔️", "😈", "🚀", "💣", "👊", "🍿", "🎮", "🫡"],
  win: ["🏆", "👑", "🔥", "😎", "💪", "🥂", "🚀", "📈", "🥇", "🎉"],
  loss: ["🤡", "💀", "🤷", "😴", "🫠", "📉", "🕯️", "🧘", "☕", "😮‍💨"],
};

const pickEmoji = (kind: Kind): string => EMOJIS[kind][Math.floor(Math.random() * EMOJIS[kind].length)];

/* ------------------------------------------------------------------ *
 * Sanitizing: strip the markup and quoting the model adds, restore the
 * casing of terms it lowercased, de-transliterate map names, and remove
 * every emoji so the one picked in code is the only one.
 * ------------------------------------------------------------------ */

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every token that must come out in Latin with exact casing, and the spellings the
// model reaches for instead — its own lowercasing of ALL-CAPS words is what breaks
// most of these. One table rather than a replace-per-term chain, because that chain
// had already drifted: HLTV was restored but K/D wasn't, and LAN/VAC were written
// into the angle pools then silently lowercased with nothing to restore them.
const TERM_FIX: [canonical: string, spellings: string][] = [
  ["ADR", "adr|адр"],
  ["Elo", "elo|ело"],
  ["HS", "hs"],
  ["K/D", "k/d"],
  ["AWP", "awp"],
  ["HLTV", "hltv"],
  ["FACEIT", "faceit|фейс[іи]т"],
  ["LAN", "lan"],
  ["VAC", "vac"],
  // Maps keep their original English names — these are the Cyrillic spellings the
  // model reaches for, mapped back. Cache is Latin-only on purpose: its
  // transliteration «кеш» is also the Ukrainian for *cash*, which the accountancy
  // and bank-heist angles use constantly, so matching it would mangle those jokes.
  ["Inferno", "[іи]нферно"],
  ["Mirage", "м[іи]раж"],
  ["Nuke", "н['ьʼ]?юк"],
  ["Dust2", "д[ау]ст\\s?2"],
  ["Anubis", "ану?біс"],
  ["Ancient", "ейншент|анц[іи]єнт|енш[еє]нт"],
  ["Overpass", "оверпас"],
  ["Train", "трейн"],
  ["Vertigo", "верт[іи]го"],
  ["Cache", "cache"],
];

const TERM_RX: [RegExp, string][] = TERM_FIX.map(([canon, spellings]) => [
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${spellings})(?![\\p{L}\\p{N}])`, "giu"),
  canon,
]);

function sanitize(text: string, map: string | null): string {
  let r = text
    .replace(/["«»„“”‘‚]/g, "")
    // strip apostrophe-like chars only OUTSIDE words, so quoting is gone but
    // Ukrainian intra-word apostrophes (зв'язки, п'ятірка) survive
    .replace(/(?<!\p{L})['’ʼ]/gu, "")
    .replace(/['’ʼ](?!\p{L})/gu, "")
    .replace(/@(?=\w)/g, "")
    .replace(/[*_`#~|]/g, "")
    .replace(/<(?!\/?(?:b|i)>)[^>]*>/g, "")
    .replace(/(?<![\p{L}\p{N}])\p{Lu}{2,}(?![\p{L}\p{N}])/gu, w => w.toLowerCase())
    // the one term with a plural, kept lowercase: "MVPs", never "MVPS"
    .replace(/(?<![\p{L}\p{N}])mvp(s?)(?![\p{L}\p{N}])/giu, (_, s) => `MVP${s ? "s" : ""}`)
    .replace(/<\/\d+>/g, "")
    .replace(/^<i>(.*)<\/i>$/, (_, inner) => (inner.includes("</i>") ? `<i>${inner}</i>` : inner))
    .replace(/<b>(?![^<]*<\/b>)/g, "")
    .replace(/<i>(?![^<]*<\/i>)/g, "")
    .replace(/<\/b>/g, (m, off, s) => (s.slice(0, off).includes("<b>") ? m : ""))
    .replace(/<\/i>/g, (m, off, s) => (s.slice(0, off).includes("<i>") ? m : ""));

  // strip any emoji the model added — one is appended in code instead
  r = r.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, "");

  for (const [rx, canon] of TERM_RX) r = r.replace(rx, canon);
  if (map) {
    r = r.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRx(map)}(?![\\p{L}\\p{N}])`, "giu"), map);
  }

  return r.replace(/\s{2,}/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Checks. Each rejects a phrase that would read as fact, or as broken
 * text, in the group. A rejection is not an error — the caller asks
 * again, and only falls back if the second reply fails too.
 * ------------------------------------------------------------------ */

const ELO_MENTION = /(?<![\p{L}\p{N}])(elo|ело)(?![\p{L}\p{N}])/iu;

// One pattern for a player code, with the digit captured, so the naming scan and the
// nickname swap are each a single pass and neither can disagree with the other about
// what a code looks like.
const CODE = /(?<![\p{L}\p{N}])[PpРр](\d+)(?![\p{L}\p{N}])/gu;

// A scoreline must be one we supplied. Asking the model not to write the final score
// wasn't enough — it printed 19:15 for a 19:16 match, a wrong score that passed every
// number check because two-digit values aren't `attributable`. Banning all of them
// then rejected the half-time score the comeback hook hands over on purpose.
const SCORELINE = /\d+\s*[:：]\s*\d+/gu;
const flatten = (s: string): string => s.replace(/\s/g, "").replace(/：/g, ":");

function badScoreline(text: string, allowed: string[] | null): boolean {
  if (!allowed) return false; // no score in this message to protect
  const ok = new Set(allowed.map(flatten));
  return (text.match(SCORELINE) ?? []).some(s => !ok.has(flatten(s)));
}

const STAT_NUM = /\d+(?:\.\d+)?/g;

// Which values can be pinned on one player. A decimal under 10 is ambiguous with a
// K/D, 19xx/20xx reads as a year, and small counts collide with anything a joke
// counts — leaving ADR-shaped decimals and three-plus-digit totals.
const attributable = (n: string): boolean => {
  if (/^(19|20)\d\d$/.test(n)) return false;
  return n.includes(".") ? Number(n) >= 10 : n.length >= 3;
};

// A stat-shaped figure may only ship if it came from the player the message names,
// or from the score / Elo / opponent numbers we supplied — catching both a figure
// invented outright and a real one lifted off a teammate's line. Judging *every*
// number was too blunt and binned good messages over "15 хвилин" and over an ADR
// rounded from 47.3 to 47, so `attributable` keeps a joke's own counts out of it.
function unsourcedStat(text: string, players: PromptPlayer[], safe: Set<string>): boolean {
  const named = new Set([...text.matchAll(CODE)].map(m => Number(m[1])));
  const mine = new Set(
    players.flatMap((p, i) => (named.has(i + 1) ? p.facts.match(STAT_NUM) ?? [] : []))
  );
  return (text.match(STAT_NUM) ?? [])
    .filter(attributable)
    .some(n => !mine.has(n) && !safe.has(n));
}

// Instructions alone don't hold the language either — a UA run came back as two
// English sentences with one Ukrainian clause. Counting Latin characters is the
// wrong test, since nicknames, ADR, MVP and "full buy" are all legitimately Latin.
// English function words are the tell: never Ukrainian, never a gaming term.
const ENGLISH_TELL =
  /(?<![\p{L}\p{N}])(the|and|that|this|with|from|was|were|have|has|been|just|after|before|nothing|they|them|their|threw|still|only|about|into|than|then|when|what|because|would|could|should)(?![\p{L}\p{N}])/giu;

function wrongLanguage(text: string): boolean {
  return (text.match(ENGLISH_TELL)?.length ?? 0) >= 2;
}

/* ------------------------------------------------------------------ */

export type RejectReason = "empty" | "elo" | "language" | "scoreline" | "unsourced-stat" | "unknown-code";

// The model's raw reply → a sendable phrase, or why it can't ship. The caller logs
// the reason and asks again: a rejection that starts firing on every call would
// otherwise look exactly like the API being down.
export function finalizePhrase(
  text: string,
  kind: Kind,
  { allowElo, players, safeNumbers, allowedScorelines, map }: PhraseChecks
): { phrase: string } | { rejected: RejectReason } {
  let result = sanitize(text, map);

  // Cheapest first, and all of these read better before the swap: a nickname could
  // itself contain "elo", a digit pair, or an English word that trips the language
  // count. Only the code checks need substitution to have happened.
  if (!result) return { rejected: "empty" };
  if (!allowElo && ELO_MENTION.test(result)) return { rejected: "elo" };
  if (wrongLanguage(result)) return { rejected: "language" };
  if (badScoreline(result, allowedScorelines)) return { rejected: "scoreline" };
  if (unsourcedStat(result, players, safeNumbers)) return { rejected: "unsourced-stat" };

  // Codes back to nicknames in one pass (immune to transliteration). Doing it per
  // code in sequence could rewrite a code that a nickname just introduced, and
  // scanning for leftovers afterwards flagged a nickname that merely contains one.
  let unknownCode = false;
  result = result.replace(CODE, (whole, digits) => {
    const nick = players[Number(digits) - 1]?.nickname;
    if (nick) return nick;
    unknownCode = true; // a code we never issued → hallucinated, don't ship it
    return whole;
  });
  if (unknownCode) return { rejected: "unknown-code" };

  return { phrase: `${result} ${pickEmoji(kind)}` };
}
