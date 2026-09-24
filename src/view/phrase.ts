// Everything done *to* the model's reply before it can be sent: sanitizing, the
// checks that reject a phrase, swapping P1 back to the member's name, and the
// emoji. Pure, and the mirror of prompt.ts — that module decides what to ask for
// and what the answer will be judged against, this one applies the verdict.
//
// `finalizePhrase` returns a verdict: the phrase, or why it can't ship. The caller retries
// once before falling back; see **The AI call** in CLAUDE.md.

import type { PhraseChecks, PhraseVerdict } from "../types.ts";

/* ------------------------------------------------------------------ *
 * Emoji are picked in code and appended after generation — one less
 * rule for the model to fail, and guaranteed variety.
 * ------------------------------------------------------------------ */

const EMOJIS = ["🎂", "🎉", "🥳", "🎁", "🍰", "🥂", "🎈", "🍾"];

const pickEmoji = (): string => EMOJIS[Math.floor(Math.random() * EMOJIS.length)];

/* ------------------------------------------------------------------ *
 * Sanitizing: strip the markup and quoting the model adds, restore the
 * casing of terms it lowercased, de-transliterate map names, and remove
 * every emoji so the one picked in code is the only one.
 * ------------------------------------------------------------------ */

// Every token that must come out in Latin with exact casing, and the spellings the
// model reaches for instead — its own lowercasing of ALL-CAPS words is what breaks
// most of these. One table rather than a replace-per-term chain, which had drifted.
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
  // Maps keep their English names. Cache is Latin-only: «кеш» is also Ukrainian for *cash*.
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

// «Звісно, ось повідомлення в заданому стилі: …» shipped once. Stripped, not rejected — silently,
// so it matches only a bare handover; see **The AI call** in CLAUDE.md for why it is this narrow.
const PREAMBLE =
  /^(?:звісно|гаразд|окей|добре|sure|okay|of course)?[,\s]*(?:ось|here'?s|here is)\s+(?:the\s+|твоє\s+|ваше\s+)?(?:повідомленн\p{L}*|message)(?:\s+(?:в|у)\s+заданому\s+\p{L}+|\s+(?:as|you)\s+\p{L}+(?:\s+\p{L}+)?)?\s*:\s+/iu;

// Drop every <b>/<i> tag not part of a properly nested pair, so what ships always parses. A stack,
// because the per-tag regexes this replaces saw one tag at a time: «<b>a <i>b</i> c</b>» read as
// an unclosed <b> and lost the bold, and with an earlier <b> in the message it kept the orphaned
// </b> — which Telegram rejects with a 400. A close that doesn't match the innermost open is
// dropped, not paired: crossed tags are rejected just as hard.
const TAG = /<(\/?)([bi])>/g;

function balanceTags(text: string): string {
  const open: { tag: string; index: number }[] = [];
  const drop = new Set<number>();
  for (let m: RegExpExecArray | null; (m = TAG.exec(text)) !== null; ) {
    if (!m[1]) {
      open.push({ tag: m[2], index: m.index });
    } else if (open.at(-1)?.tag === m[2]) {
      open.pop();
    } else {
      drop.add(m.index); // closes nothing, or closes across another tag
    }
  }
  for (const { index } of open) drop.add(index); // opened and never closed
  if (!drop.size) return text;
  return text.replace(TAG, (whole, _slash, _tag, offset: number) => (drop.has(offset) ? "" : whole));
}

function sanitize(text: string): string {
  let r = text
    // Quotes first: the preamble strip is anchored, and a reply wrapped in «…» hid it behind them.
    .replace(/["«»„“”‘‚]/g, "")
    .replace(PREAMBLE, "")
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
    .replace(/^<i>(.*)<\/i>$/, (_, inner) => (inner.includes("</i>") ? `<i>${inner}</i>` : inner));

  r = balanceTags(r);

  // strip any emoji the model added — one is appended in code instead
  r = r.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, "");

  for (const [rx, canon] of TERM_RX) r = r.replace(rx, canon);

  // Spaces collapse, but a paragraph break normalises to one blank line — what Telegram
  // renders as a paragraph.
  return r.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ------------------------------------------------------------------ *
 * Checks. Each rejects a phrase that would read as fact, or as broken
 * text, in the group. A rejection is not an error — the caller asks
 * again, and only falls back if the second reply fails too.
 * ------------------------------------------------------------------ */

// Telegram refuses a sendMessage over 4096 characters, and the sweep reads that 400 as a dead
// chat. A transport backstop against a runaway completion, not a length policy.
const MAX_CHARS = 3500;

const ELO_MENTION = /(?<![\p{L}\p{N}])(elo|ело)(?![\p{L}\p{N}])/iu;

// One pattern for a player code, digit captured, so the scan and the swap agree on what a code is.
const CODE = /(?<![\p{L}\p{N}])[PpРр](\d+)(?![\p{L}\p{N}])/gu;

const STAT_NUM = /\d+(?:\.\d+)?/g;

// Which figures read as a stat: 19xx/20xx is a year, and small counts collide with anything a joke
// counts — leaving decimals of 10 and up, and three-plus-digit totals.
const attributable = (n: string): boolean => {
  if (/^(19|20)\d\d$/.test(n)) return false;
  return n.includes(".") ? Number(n) >= 10 : n.length >= 3;
};

// A stat-shaped figure may only ship if the prompt supplied it. Compared as numbers: «36.0» and
// «36» are one figure spelled two ways.
function unsourcedStat(text: string, safe: Set<string>): boolean {
  const sourced = new Set([...safe].map(Number));
  return (text.match(STAT_NUM) ?? [])
    .filter(attributable)
    .some(n => !sourced.has(Number(n)));
}

// English function words are the tell: never Ukrainian, never a gaming term. Counting Latin
// characters would flag names and gaming terms that are legitimately Latin.
const ENGLISH_TELL =
  /(?<![\p{L}\p{N}])(the|and|that|this|with|from|was|were|have|has|been|just|after|before|nothing|they|them|their|threw|still|only|about|into|than|then|when|what|because|would|could|should)(?![\p{L}\p{N}])/giu;

function wrongLanguage(text: string): boolean {
  return (text.match(ENGLISH_TELL)?.length ?? 0) >= 2;
}

/* ------------------------------------------------------------------ */

// The model's raw reply → a sendable phrase, or why it can't ship. The caller logs
// the reason and asks again: a rejection that starts firing on every call would
// otherwise look exactly like the API being down.
export function finalizePhrase(text: string, { name, safeNumbers, maxWords }: PhraseChecks): PhraseVerdict {
  let result = sanitize(text);

  // Cheapest first, and all before the swap: a name could itself contain "elo", a digit or an
  // English word. Only the code check needs substitution to have happened.
  if (!result) return { rejected: "empty" };
  if (result.length > MAX_CHARS) return { rejected: "too-long" };
  // Counted before the emoji, so the budget is all message. Shares `too-long` with the cap above.
  if (result.split(/\s+/).length > maxWords) return { rejected: "too-long" };
  if (ELO_MENTION.test(result)) return { rejected: "elo" };
  if (wrongLanguage(result)) return { rejected: "language" };
  if (unsourcedStat(result, safeNumbers)) return { rejected: "unsourced-stat" };

  // P1 back to the name in one pass; any other code was never issued, so it's hallucinated.
  let unknownCode = false;
  result = result.replace(CODE, (whole, digits) => {
    // `<`/`>` stripped: this runs after sanitize and balanceTags, and a first name is arbitrary text.
    if (Number(digits) === 1) return name.replace(/[<>]/g, "");
    unknownCode = true;
    return whole;
  });
  if (unknownCode) return { rejected: "unknown-code" };

  return { phrase: `${result} ${pickEmoji()}` };
}
