import OpenAI from "openai";
import { t, LANG } from "./i18n.ts";
import { getAiHistory, recordAiPhrase } from "./db.ts";
import {
  PREMISES,
  REGISTERS,
  FORMS,
  GLOSSARY,
  FORM_CHANCE,
  MAP_MENTION_CHANCE,
  PLAYER_SKIP_CHANCE,
  PLAYER_FOCUS_CHANCE,
} from "./voice.ts";
import type { MatchPlayer, EloPair, MatchFlow, PhraseKind, Premise, Register } from "./types.ts";

const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com" })
  : null;

const FALLBACK_HYPE = t("fallbackHype");
const FALLBACK_WIN = t("fallbackWin");
const FALLBACK_LOSS = t("fallbackLoss");

/* ------------------------------------------------------------------ *
 * Static system prompt. Identical on every call, so DeepSeek's
 * automatic context caching turns it into cheap cached prefix tokens
 * and the rules stick better than when buried in a wall of user text.
 * ------------------------------------------------------------------ */

const UA_STYLE =
  " Write in natural, grammatically correct, spoken Ukrainian — NEVER Russian" +
  " (що not что, зараз not сейчас, робимо not делаем) and avoid literal calques from English." +
  " The letters ё, ы, э and ъ do not exist in Ukrainian — never write them (смурф or smurf, never смёрф)." +
  " Tone reference — match the vibe, but NEVER reuse the wording, structure or jokes:" +
  " «вони зайшли з full buy і надією, а вийшли з exit-фрагами і skill issue»," +
  " «сабтік порадився з пінгом і вирішив, що ти помер ще за стіною — дякуємо, Valve»," +
  " «п'ятірка в зборі, план геніальний: стрілочки, фейки — і все одно rush B».";

const SYSTEM_PROMPT =
  "You write ONE short message at a time for a casual CS2 squad's private Telegram group chat." +
  " Output only the message text — no preamble, no quotes, no markdown, no emoji (one emoji is appended programmatically later)." +
  " No words in ALL CAPS." +
  // The line is posted directly beneath the result card, so anything restated
  // there is both redundant and a chance to contradict it.
  " Your message appears directly under a screenshot and a stats table that already show the score, the map and" +
  " every player's numbers. Never restate them: never write the match score, and use at most ONE number in the" +
  " whole message, and only when that number is itself the joke." +
  " Map names and gaming terms (ADR, Elo, HS, AWP, FACEIT, HLTV, LAN, OT, MVP, CS2) always stay in Latin letters" +
  " exactly as given — never translate or transliterate them into Cyrillic." +
  " Players are referenced by codes like P1: if you mention a player, write the code verbatim — it is replaced with" +
  " the real nickname later. Never output a player code you were not given, never invent players or stats, and copy" +
  " any number you are given exactly." +
  " Mention Elo only if Elo numbers are explicitly given, and write them as X Elo." +
  " You may use Telegram HTML <b> or <i> sparingly to stress a word or two; no other tags." +
  // Every observed message was "<clause> — <clause>", so the ban is explicit
  // and a rolled FORM (below) enforces variety independently of compliance.
  " Vary your sentence shape between messages. Do not build the message as two clauses joined by a dash, and never" +
  " open with a label followed by a colon." +
  // The premise is briefing, not shared knowledge: compressing it away left
  // «Гайда на сервер, s1mple-і — там і визначиться ZywOo», a punchline whose
  // setup never got written.
  " The reader never sees the premise you were given, only your sentence. If a joke needs a setup for its" +
  " reference to land, write the setup — never ship a punchline whose setup is missing, and never drop a name in" +
  " as decoration." +
  // High temperature buys variety and costs coherence; this is the counterweight.
  " Whatever else you are asked for, the message must be a grammatical, natural sentence that a person would" +
  " actually type. Never compress it into a word salad, and never drop the words that hold the grammar together." +
  GLOSSARY +
  (LANG === "UA" ? UA_STYLE : " Write in casual, punchy English.");

/* ------------------------------------------------------------------ *
 * Composition. Three axes, all rolled in code: an LLM asked to "pick
 * something fresh" converges on the most probable option every time —
 * that is what produced майстер-клас / faceit-античіт on repeat, and
 * why the choice must not be the model's.
 *
 *   premise  — WHAT the joke is about    (24 per kind, carries the emoji)
 *   register — HOW it is said            (8, filtered per kind)
 *   form     — the SHAPE of the sentence (6, rolled 60% of the time)
 *
 * History comes from SQLite so a redeploy no longer wipes it.
 * ------------------------------------------------------------------ */

const HISTORY_READ = 8;
const PREMISE_WINDOW = 8; // premises blocked from reuse
const REGISTER_WINDOW = 3;
const PHRASE_WINDOW = 4; // past messages fed back as "differ from these"

interface Recent {
  premises: string[];
  registers: string[];
  phrases: string[];
}

function loadRecent(kind: PhraseKind): Recent {
  const rows = getAiHistory(kind, HISTORY_READ);
  return {
    premises: rows.slice(0, PREMISE_WINDOW).map(r => r.premise_id),
    registers: rows.slice(0, REGISTER_WINDOW).map(r => r.register_id),
    phrases: rows.slice(0, PHRASE_WINDOW).map(r => r.phrase),
  };
}

/** Uniform pick that avoids anything used recently, falling back to the full
 *  pool if the block-list would leave nothing (small pools, long history). */
function pickFresh<T extends { id: string }>(pool: T[], blocked: string[]): T {
  const fresh = pool.filter(x => !blocked.includes(x.id));
  const src = fresh.length ? fresh : pool;
  return src[Math.floor(Math.random() * src.length)];
}

const pickOne = <T>(pool: T[]): T => pool[Math.floor(Math.random() * pool.length)];

const registersFor = (kind: PhraseKind): Register[] => REGISTERS.filter(r => r.fits.includes(kind));

/* ------------------------------------------------------------------ */

function recentBlock(phrases: string[]): string {
  if (!phrases.length) return "";
  return (
    " Recent messages of this type — yours must differ clearly in wording, structure and opening: " +
    phrases.map(m => `«${m}»`).join(" ")
  );
}

/* ------------------------------------------------------------------ *
 * Sanitizing. Strips every emoji the model sneaks in (we append our
 * own), de-transliterates gaming terms in both directions, and undoes
 * the label-prefix habit.
 * ------------------------------------------------------------------ */

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MAPS = ["Inferno", "Mirage", "Nuke", "Dust2", "Anubis", "Ancient", "Overpass", "Train", "Vertigo"];

// "Mirage: рахунок закрито" — the map is already in the header and on the
// screenshot, and the model reaches for this prefix constantly.
const MAP_PREFIX = new RegExp(`^(?:${MAPS.join("|")})\\s*[:,–—-]\\s*`, "iu");

// Cyrillic spellings the model falls back to despite the instruction.
const MAP_FIX: [RegExp, string][] = [
  [/(?<![\p{L}\p{N}])[іи]нферно(?![\p{L}\p{N}])/giu, "Inferno"],
  [/(?<![\p{L}\p{N}])м[іи]раж(?![\p{L}\p{N}])/giu, "Mirage"],
  [/(?<![\p{L}\p{N}])н['ьʼ]?юк(?![\p{L}\p{N}])/giu, "Nuke"],
  [/(?<![\p{L}\p{N}])д[ау]ст\s?2(?![\p{L}\p{N}])/giu, "Dust2"],
  [/(?<![\p{L}\p{N}])ану?біс(?![\p{L}\p{N}])/giu, "Anubis"],
  [/(?<![\p{L}\p{N}])(?:ейншент|анц[іи]єнт|енш[еє]нт)(?![\p{L}\p{N}])/giu, "Ancient"],
  [/(?<![\p{L}\p{N}])оверпас(?![\p{L}\p{N}])/giu, "Overpass"],
  [/(?<![\p{L}\p{N}])трейн(?![\p{L}\p{N}])/giu, "Train"],
  [/(?<![\p{L}\p{N}])верт[іи]го(?![\p{L}\p{N}])/giu, "Vertigo"],
];

// Same treatment for the jargon: «авп крізь усе», «на лані» and «фейсіт» all
// shipped to the chat in Cyrillic.
const TERM_FIX: [RegExp, string][] = [
  [/(?<![\p{L}\p{N}])адр(?![\p{L}\p{N}])/giu, "ADR"],
  [/(?<![\p{L}\p{N}])(?:ело|elo)(?![\p{L}\p{N}])/giu, "Elo"],
  [/(?<![\p{L}\p{N}])(?:hltv|хлтв)(?![\p{L}\p{N}])/giu, "HLTV"],
  [/(?<![\p{L}\p{N}])(?:hs|хс)(?![\p{L}\p{N}])/giu, "HS"],
  [/(?<![\p{L}\p{N}])(?:awp|авп)(?![\p{L}\p{N}])/giu, "AWP"],
  [/(?<![\p{L}\p{N}])(?:faceit|фейс[іи]т)(?![\p{L}\p{N}])/giu, "FACEIT"],
  [/(?<![\p{L}\p{N}])(?:mvp|мвп)(?![\p{L}\p{N}])/giu, "MVP"],
  [/(?<![\p{L}\p{N}])(?:fps|фпс)(?![\p{L}\p{N}])/giu, "FPS"],
  [/(?<![\p{L}\p{N}])(?:vac|вак)(?![\p{L}\p{N}])/giu, "VAC"],
  [/(?<![\p{L}\p{N}])lan(?![\p{L}\p{N}])/giu, "LAN"],
  [/(?<![\p{L}\p{N}])ot(?![\p{L}\p{N}])/gu, "OT"],
  [/(?<![\p{L}\p{N}])cs\s?2(?![\p{L}\p{N}])/giu, "CS2"],
  [/(?<![\p{L}\p{N}])navi(?![\p{L}\p{N}])/giu, "NaVi"],
  [/(?<![\p{L}\p{N}])cpu(?![\p{L}\p{N}])/giu, "CPU"],
  [/(?<![\p{L}\p{N}])gpu(?![\p{L}\p{N}])/giu, "GPU"],
];

// The ALL-CAPS rule below exists to kill shouting, but it also lowercased every
// real acronym the model wrote — «на lan відповімо», «22:19 в ot». Genuine
// acronyms are exempted; anything else still gets lowered.
const KEEP_CAPS = new Set([
  "ADR", "AWP", "CPU", "CS", "EU", "EVO", "FPS", "GG", "GPU", "HLTV", "HP", "HS",
  "IGL", "KD", "KDA", "LAN", "MM", "MVP", "NA", "OT", "RNG", "VAC", "WP",
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
    .replace(/(?<![\p{L}\p{N}])\p{Lu}{2,}(?![\p{L}\p{N}])/gu, w => (KEEP_CAPS.has(w) ? w : w.toLowerCase()))
    .replace(/<\/\d+>/g, "")
    .replace(/^<i>(.*)<\/i>$/, (_, inner) => (inner.includes("</i>") ? `<i>${inner}</i>` : inner))
    .replace(/<b>(?![^<]*<\/b>)/g, "")
    .replace(/<i>(?![^<]*<\/i>)/g, "")
    .replace(/<\/b>/g, (m, off, s) => (s.slice(0, off).includes("<b>") ? m : ""))
    .replace(/<\/i>/g, (m, off, s) => (s.slice(0, off).includes("<i>") ? m : ""));

  // strip any emoji the model added — one is appended in code instead
  r = r.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, "");

  for (const [rx, canon] of MAP_FIX) r = r.replace(rx, canon);
  for (const [rx, canon] of TERM_FIX) r = r.replace(rx, canon);
  if (map) {
    r = r.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRx(map)}(?![\\p{L}\\p{N}])`, "giu"), map);
  }
  r = r.replace(MAP_PREFIX, "");

  return r.replace(/\s{2,}/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Player facts. The table under the message already lists every
 * number, so the prompt gets exactly ONE fact about ONE player —
 * the most notable thing that happened — instead of a statline the
 * model used to recite verbatim («16/8/8, 117.9 ADR, 56% HS, 318
 * utility damage»). Ordered most-impressive first; `min` is the
 * "worth mentioning at all" bar. NaN (missing stat) never passes it.
 * ------------------------------------------------------------------ */

// Phrased as full clauses rather than scoreboard labels: fed "5 entry frags"
// the model produced «п'ятим фрагом» (the fifth kill), and "318 utility damage"
// came out as the barely-Ukrainian «318 утіліті». Spelling out what the number
// means leaves nothing to misread.
const FACTS: { min: number; get: (p: MatchPlayer) => number; label: (n: number) => string }[] = [
  { min: 1, get: p => p.aces, label: n => (n > 1 ? `landed ${n} aces` : "landed an ace") },
  { min: 1, get: p => p.clutches, label: n => (n > 1 ? `won ${n} separate 1v2 situations` : "won a 1v2") },
  { min: 1, get: p => p.quadros, label: n => (n > 1 ? `landed ${n} quad-kills` : "landed a quad-kill") },
  { min: 5, get: p => p.awp, label: n => `took ${n} kills with the AWP` },
  { min: 5, get: p => p.entries, label: n => `took the opening kill in ${n} rounds` },
  // The parenthetical earns its ugliness: without it this stat kept coming back
  // as «318 гранатними очками» / «з 318 гранатами» — the number re-attached to
  // the grenades instead of the damage.
  { min: 200, get: p => p.util, label: n => `dealt ${n} damage with grenades alone (that is damage, not a count of grenades)` },
  { min: 10, get: p => p.flashes, label: n => `blinded ${n} enemies with flashes` },
  { min: 60, get: p => p.hs, label: n => `landed ${n}% of the kills as headshots` },
  { min: 100, get: p => p.adr, label: n => `averaged ${n} ADR` },
];

function buildPlayerBlock(players: MatchPlayer[] | undefined): { line: string; codes: Map<string, string> } {
  const none = { line: "Do not mention any player names or stats.", codes: new Map<string, string>() };

  const best = (players ?? [])
    .filter(p => Number.isFinite(p.adr) && p.adr >= 100)
    .sort((a, b) => b.adr - a.adr)[0];
  if (!best) return none;

  // sometimes skip the player entirely, so not every message is a shoutout
  if (Math.random() < PLAYER_SKIP_CHANCE) return none;

  const fact = FACTS.find(f => f.get(best) >= f.min);
  if (!fact) return none;

  // Split between a required shoutout and an optional one: left entirely to the
  // model's discretion it stops mentioning anyone, and the point of feeding it
  // match stats is that the line reacts to what actually happened.
  const done = fact.label(fact.get(best));
  return {
    line:
      Math.random() < PLAYER_FOCUS_CHANCE
        ? `Build the message around P1, who ${done}. Quote that number exactly and use no other number.`
        : `One player is worth a nod: P1, who ${done}. Weave it in only if it serves the premise —` +
          ` quote that number exactly, and use no other number.`,
    codes: new Map([["P1", best.nickname]]),
  };
}

function mapLine(map: string | null | undefined): string {
  if (!map) return "Do not mention any map.";
  return Math.random() < MAP_MENTION_CHANCE
    ? `The map was ${map}. Name it only if the joke is genuinely about the map itself — a callout, a map-specific` +
        ` meme — written exactly like that, inside a sentence. Never as a prefix label.`
    : "Do not mention the map name.";
}

/* ------------------------------------------------------------------ *
 * Result shape. The model is never given the score, so it cannot
 * print it (the header already does, and it used to contradict it:
 * header «❌ 11:13», message «виграли 13:11»). It gets the shape of
 * the result instead, which is all the joke actually needs.
 *
 * Only blame-safe shapes are surfaced: a comeback win, or an overtime
 * finish either way — never a "we led and threw it" collapse, which
 * would break the never-blame-our-team rule on losses.
 * ------------------------------------------------------------------ */

function scoreDiff(score: string | undefined): number | null {
  const m = /(\d+)\D+(\d+)/.exec(score ?? "");
  return m ? Math.abs(Number(m[1]) - Number(m[2])) : null;
}

function resultShape(won: boolean, score: string, flow: MatchFlow | null | undefined): string {
  const diff = scoreDiff(score);
  const ot = !!flow && (Number(flow.ourOt) || 0) + (Number(flow.theirOt) || 0) > 0;
  const comeback =
    won &&
    !!flow &&
    Number.isFinite(flow.ourFirst) &&
    Number.isFinite(flow.theirFirst) &&
    flow.theirFirst - flow.ourFirst >= 3;

  if (won) {
    if (comeback) return ot ? "we were losing at the half and took it in overtime" : "we were losing at the half and turned it around";
    if (ot) return "we scraped it in overtime";
    if (diff !== null && diff <= 3) return "we won it by a hair";
    if (diff !== null && diff >= 8) return "we ran them over without breaking a sweat";
    return "a comfortable win";
  }
  if (ot) return "we lost it in overtime";
  if (diff !== null && diff <= 3) return "we lost it by a hair";
  if (diff !== null && diff >= 8) return "we got run over";
  return "a clear loss";
}

/* ------------------------------------------------------------------ *
 * Generation. Guards are split by severity: a hard failure falls back
 * to the static phrase, a soft one ships anyway on the retry — a
 * slightly off message still beats the same canned line every time.
 * ------------------------------------------------------------------ */

// None of these letters exist in Ukrainian, so one appearing means Russian
// leaked in — «смёрф-вердикт» shipped before this guard existed.
const RUSSIAN_LETTERS = /[ёыэъ]/iu;
const ELO_MENTION = /(?<![\p{L}\p{N}])(elo|ело)(?![\p{L}\p{N}])/iu;
const LEFTOVER_CODE = /(?<![\p{L}\p{N}])[PpРр]\d(?![\p{L}\p{N}])/u;
const SCORE_ECHO = /\d{1,2}\s*[:：]\s*\d{1,2}/u;
const MAX_LEN = 280;
const ATTEMPTS = 2;

interface Guard {
  reason: string;
  hint: string;
  hard: boolean;
}

interface GenerateOptions {
  allowElo?: boolean;
  codes?: Map<string, string>;
  map?: string | null;
}

interface Composition {
  premise: Premise;
  register: Register;
}

async function generate(
  kind: PhraseKind,
  { premise, register }: Composition,
  userPrompt: string,
  fallback: () => string,
  { allowElo = true, codes = new Map<string, string>(), map = null }: GenerateOptions = {}
): Promise<string> {
  if (!ai) return fallback();

  let hint = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const last = attempt === ATTEMPTS;
    try {
      const chat = await ai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt + hint },
        ],
        // Reasoning shares this budget with the reply, and on this model it is
        // not optional — omitting `thinking` does not disable it. At 2048 about
        // one call in ten came back empty with finish_reason "length", the
        // reasoning chain having eaten the whole allowance; 4096 still truncated
        // occasionally. The cap costs nothing until it bites — billing follows
        // the tokens actually produced, and the model stops on its own long
        // before this — so it is set well clear of the worst case observed.
        max_tokens: 8192,
        // Measured against 1.15 on identical scenarios: the higher setting
        // bought no extra variety the rolled axes were not already providing,
        // and cost coherence — «Вручили нам -rep-медалі Winfle за 318 утіліті
        // отримав шорт» came out of it. Variety is a code concern here, not a
        // sampling one, so the temperature can stay where the grammar holds.
        temperature: 0.9,
        // `thinking` is a DeepSeek extension absent from the OpenAI SDK types;
        // spread it in so the request carries it without a type error.
        ...({ thinking: { type: "enabled" } } as object),
      });

      const choice = chat.choices[0];
      const text = choice?.message?.content?.trim();

      let guard: Guard | null = null;
      let result = "";

      if (!text) {
        guard = {
          reason: choice?.finish_reason === "length" ? "empty reply (reasoning hit max_tokens)" : "empty reply",
          hint: " Answer immediately with the message itself; keep your reasoning short.",
          hard: true,
        };
      } else {
        result = sanitize(text, map);

        // swap player codes back to real nicknames (immune to transliteration)
        for (const [code, nick] of codes) {
          const rx = new RegExp(`(?<![\\p{L}\\p{N}])[PpРр]${code.slice(1)}(?![\\p{L}\\p{N}])`, "gu");
          result = result.replace(rx, nick);
        }

        if (!result) {
          guard = { reason: "empty after sanitizing", hint: "", hard: true };
        } else if (LEFTOVER_CODE.test(result)) {
          // a code we never issued survived → the model invented a player
          guard = { reason: "hallucinated player code", hint: " Do not mention any player at all.", hard: true };
        } else if (LANG === "UA" && RUSSIAN_LETTERS.test(result)) {
          guard = {
            reason: "Russian orthography leaked in",
            hint: " Write pure Ukrainian — never the letters ё, ы, э or ъ.",
            hard: true,
          };
        } else if (!allowElo && ELO_MENTION.test(result)) {
          guard = { reason: "Elo mentioned without Elo data", hint: " Do not mention Elo or ratings.", hard: true };
        } else if (result.length > MAX_LEN) {
          guard = { reason: `too long (${result.length} chars)`, hint: " Make it much shorter — one short sentence.", hard: true };
        } else if (SCORE_ECHO.test(result)) {
          guard = { reason: "echoed the score", hint: " Do not write the score or any two numbers separated by a colon.", hard: false };
        }
      }

      if (guard && (guard.hard || !last)) {
        console.warn(`[ai] ${kind} attempt ${attempt}/${ATTEMPTS} rejected: ${guard.reason}`);
        if (last) return fallback();
        hint = guard.hint;
        continue;
      }
      if (guard) console.warn(`[ai] ${kind} shipping despite: ${guard.reason}`);

      // stored without the emoji: the history is fed back to the model as
      // "differ from these", and examples carrying emoji invite it to add its own
      recordAiPhrase(kind, premise.id, register.id, result);
      return `${result} ${premise.emoji}`;
    } catch (err) {
      console.error(`[ai] ${kind} attempt ${attempt}/${ATTEMPTS} failed:`, (err as Error).message);
      if (last) return fallback();
    }
  }
  return fallback();
}

/** Shared opening of every user prompt: the two rolled axes, plus the rolled
 *  sentence shape that keeps the syntax from collapsing into one template. */
function composeBrief({ premise, register }: Composition): string {
  const form = Math.random() < FORM_CHANCE
    ? ` ${pickOne(FORMS)} If that shape would force ungrammatical Ukrainian, drop the shape, not the grammar.`
    : "";
  return (
    ` COMEDIC PREMISE — this is the idea, never a draft: ${premise.text}.` +
    ` Commit to it fully, but invent your own wording, imagery and punchline;` +
    ` do not reuse any phrase longer than two words from that line.` +
    ` REGISTER — commit to it fully: ${register.text}.` +
    form
  );
}

function compose(kind: PhraseKind): { composition: Composition; recent: Recent } {
  const recent = loadRecent(kind);
  return {
    composition: {
      premise: pickFresh(PREMISES[kind], recent.premises),
      register: pickFresh(registersFor(kind), recent.registers),
    },
    recent,
  };
}

/* ------------------------------------------------------------------ */

export async function generateHypePhrase(eventName: string | null): Promise<string> {
  const { composition, recent } = compose("hype");
  const prompt =
    `A CS2 squad just filled up${eventName ? ` for an event called "${eventName}"` : ""}, and the match has not` +
    ` started yet. Write ONE funny, energetic message to fire them up.` +
    composeBrief(composition) +
    ` Max 26 words. Do not repeat the event name or start time — they are already shown above your message.` +
    recentBlock(recent.phrases);
  return generate("hype", composition, prompt, () => FALLBACK_HYPE);
}

interface MatchPhraseContext {
  map?: string | null;
  elo?: EloPair | null;
  players?: MatchPlayer[];
  matchFlow?: MatchFlow | null;
}

export async function generateMatchPhrase(
  won: boolean,
  score: string,
  { map, elo, players, matchFlow }: MatchPhraseContext = {}
): Promise<string> {
  const upsetWin = won && !!elo && Number(elo.theirs) - Number(elo.ours) >= 75;
  const upsetLoss = !won && !!elo && Number(elo.ours) - Number(elo.theirs) >= 75;
  const shape = resultShape(won, score, matchFlow);

  if (won) {
    const { composition, recent } = compose("win");
    const { line: playerLine, codes } = buildPlayerBlock(players);
    const prompt =
      `The squad just WON a CS2 match — ${shape}. Write ONE short funny celebratory message.` +
      composeBrief(composition) +
      ` ${playerLine}` +
      ` ${mapLine(map)}` +
      (upsetWin
        ? ` We were rated lower and still won — our ${elo!.ours} Elo against their ${elo!.theirs} Elo.` +
          ` You may work that gap into the joke; if you name a number at all, name only one.`
        : "") +
      ` Max 26 words. Triumphant, never mention losing or anything negative.` +
      recentBlock(recent.phrases);
    return generate("win", composition, prompt, () => FALLBACK_WIN, { allowElo: Boolean(upsetWin), codes, map });
  }

  const { composition, recent } = compose("loss");
  const prompt =
    `The squad just LOST a CS2 match — ${shape}. Write ONE short funny sarcastic excuse message.` +
    composeBrief(composition) +
    ` ${mapLine(map)}` +
    (upsetLoss
      ? ` They were rated lower than us — our ${elo!.ours} Elo against their ${elo!.theirs} Elo.` +
        ` Squeeze drama out of that gap; if you name a number at all, name only one.`
      : "") +
    ` Max 26 words. Punchy; never blame our own team.` +
    recentBlock(recent.phrases);
  return generate("loss", composition, prompt, () => FALLBACK_LOSS, { allowElo: Boolean(upsetLoss), map });
}
