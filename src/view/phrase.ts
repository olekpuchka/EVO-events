// Everything done *to* the model's reply before it can be sent: sanitizing, the
// checks that reject a phrase, swapping player codes back to nicknames, and the
// emoji. Pure, and the mirror of prompt.ts — that module decides what to ask for
// and what the answer will be judged against, this one applies the verdict.
//
// `finalizePhrase` returns null for a phrase that must not ship. The caller retries
// once before falling back; see **The AI call** in CLAUDE.md.

import type { Kind, PhraseChecks, PhraseVerdict, PromptPlayer } from "../types.ts";

/* ------------------------------------------------------------------ *
 * Emoji are picked in code and appended after generation — one less
 * rule for the model to fail, and guaranteed variety.
 * ------------------------------------------------------------------ */

const EMOJIS: Record<Kind, string[]> = {
  hype: ["🔥", "⚔️", "😈", "🚀", "💣", "👊", "🍿", "🎮", "🫡"],
  win: ["🏆", "👑", "🔥", "😎", "💪", "🥂", "🚀", "📈", "🥇", "🎉"],
  loss: ["🤡", "💀", "🤷", "😴", "🫠", "📉", "🕯️", "🧘", "☕", "😮‍💨"],
  birthday: ["🎂", "🎉", "🥳", "🎁", "🍰", "🥂", "🎈", "🍾"],
};

// Which kinds keep their line breaks. In a one-liner a stray newline is padding, not structure,
// so the collapse below flattens it — but it turned a birthday toast into a single block.
const MULTILINE: Record<Kind, boolean> = { hype: false, win: false, loss: false, birthday: true };

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

// «Звісно, ось повідомлення в заданому стилі: …» shipped once. Stripped, not rejected — a
// rejection costs the one retry. Nothing may sit between the deictic and the noun: looser
// versions ate «Ось текст нашого заповіту:» and «Ось офіційне повідомлення прес-служби:», both
// openings the angles invite by name, and the strip is silent so nothing reports it.
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

function sanitize(text: string, map: string | null, multiline: boolean): string {
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
  if (map) {
    r = r.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRx(map)}(?![\\p{L}\\p{N}])`, "giu"), map);
  }

  // Spaces collapse either way; on a multiline kind a paragraph break normalises to one blank
  // line, which is what Telegram renders as a paragraph.
  return multiline
    ? r.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    : r.replace(/\s{2,}/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Checks. Each rejects a phrase that would read as fact, or as broken
 * text, in the group. A rejection is not an error — the caller asks
 * again, and only falls back if the second reply fails too.
 * ------------------------------------------------------------------ */

// Telegram refuses a sendMessage over 4096 characters, and the birthday sweep reads that 400 as a
// dead chat — costing a greeting for a year. A transport bound, not the length policing CLAUDE.md
// rules out, so it doesn't move with the word ask: a backstop against a runaway completion, well
// clear of any real message and leaving room for the header and for entity expansion.
const MAX_CHARS = 3500;

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
//
// Compared as numbers: «36.0» and «36» are one figure spelled two ways, and a string match
// rejected the second spelling of a number the prompt had itself supplied.
function unsourcedStat(text: string, players: PromptPlayer[], safe: Set<string>): boolean {
  const named = new Set([...text.matchAll(CODE)].map(m => Number(m[1])));
  const sourced = new Set(
    [
      ...players.flatMap((p, i) => (named.has(i + 1) ? p.facts.match(STAT_NUM) ?? [] : [])),
      ...safe,
    ].map(Number)
  );
  return (text.match(STAT_NUM) ?? [])
    .filter(attributable)
    .some(n => !sourced.has(Number(n)));
}

// The map is given, the position never is, so a callout is always invented — it put their coach
// «над Banana». `allowCallouts` decides who is judged. Every entry has to survive being an
// ordinary word in a joke: no «піт» (sweat), «вікно», «палац» or ninja (`ninja defuse` is an
// angle), «мід» takes no case ending, and Cyrillic «банан» needs a place preposition.
const CALLOUT =
  /(?<![\p{L}\p{N}])(?:(?:на|в|у|через|біля|під)\s+банан\p{L}{0,2}|banana|mid|мід|ramp|рамп\p{L}{0,2}|long|лонг|short|шорт|connector|конектор|коннектор|catwalk|катвок|heaven|хевен|jungle|джангл|[AB][\s-]?site)(?![\p{L}\p{N}])/iu;

// Instructions alone don't hold the language either — a UA run came back as two English
// sentences with one Ukrainian clause. Counting Latin characters is the wrong test, since
// nicknames, ADR, MVP and "full buy" are legitimately Latin. English function words are the
// tell: never Ukrainian, never a gaming term.
const ENGLISH_TELL =
  /(?<![\p{L}\p{N}])(the|and|that|this|with|from|was|were|have|has|been|just|after|before|nothing|they|them|their|threw|still|only|about|into|than|then|when|what|because|would|could|should)(?![\p{L}\p{N}])/giu;

function wrongLanguage(text: string): boolean {
  return (text.match(ENGLISH_TELL)?.length ?? 0) >= 2;
}

/* ------------------------------------------------------------------ */

// The model's raw reply → a sendable phrase, or why it can't ship. The caller logs
// the reason and asks again: a rejection that starts firing on every call would
// otherwise look exactly like the API being down.
export function finalizePhrase(
  text: string,
  kind: Kind,
  { allowElo, allowCallouts, players, safeNumbers, allowedScorelines, map, maxWords }: PhraseChecks
): PhraseVerdict {
  let result = sanitize(text, map, MULTILINE[kind]);

  // Cheapest first, and all of these read better before the swap: a nickname could
  // itself contain "elo", a digit pair, or an English word that trips the language
  // count. Only the code checks need substitution to have happened.
  if (!result) return { rejected: "empty" };
  if (result.length > MAX_CHARS) return { rejected: "too-long" };
  // Counted before the emoji, so the budget is all message. Shares `too-long` with the cap above.
  if (maxWords !== null && result.split(/\s+/).length > maxWords) return { rejected: "too-long" };
  if (!allowElo && ELO_MENTION.test(result)) return { rejected: "elo" };
  if (wrongLanguage(result)) return { rejected: "language" };
  if (badScoreline(result, allowedScorelines)) return { rejected: "scoreline" };
  if (!allowCallouts && CALLOUT.test(result)) return { rejected: "callout" };
  if (unsourcedStat(result, players, safeNumbers)) return { rejected: "unsourced-stat" };

  // Codes back to nicknames in one pass (immune to transliteration). Doing it per
  // code in sequence could rewrite a code that a nickname just introduced, and
  // scanning for leftovers afterwards flagged a nickname that merely contains one.
  let unknownCode = false;
  result = result.replace(CODE, (whole, digits) => {
    const nick = players[Number(digits) - 1]?.nickname;
    // Stripped because this runs *after* sanitize and balanceTags — nothing checks it again, and
    // escapeAiHtml turns `&lt;/i&gt;` back into a real tag. A FACEIT nickname can't contain one; a
    // birthday swaps in a Telegram first name, which is arbitrary user text.
    if (nick) return nick.replace(/[<>]/g, "");
    unknownCode = true; // a code we never issued → hallucinated, don't ship it
    return whole;
  });
  if (unknownCode) return { rejected: "unknown-code" };

  return { phrase: `${result} ${pickEmoji(kind)}` };
}
