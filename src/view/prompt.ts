// Everything said *to* the model for a birthday toast: the system prompt, the angle and register
// roulette, and the retry correction. Pure — it builds strings and the checks the reply is judged
// against, but never calls anything. See **Birthday phrases** in CLAUDE.md.

import type { PhraseRequest, RejectReason } from "../types.ts";

const UA_STYLE =
  " Write in natural, grammatically correct, spoken Ukrainian — NEVER Russian" +
  " (що not что, зараз not сейчас, робимо not делаем) and avoid literal calques from English." +
  " So: «шкоди» or «дамагу», never «total damage»; «утилітою» or «гранатами», never «utility damage»" +
  " or «grenades thrown»; «засліпив» or «флешок», never «flashes thrown»; «тріпл-кіл» or «трійник»," +
  " never «triple kills»; «відкрив раунд», never «opening kill»." +
  " Tone reference — match the vibe, but NEVER reuse the wording, structure or jokes:" +
  " «вони зайшли з full buy і надією, а вийшли з exit-фрагами і skill issue»," +
  " «сабтік порадився з пінгом і вирішив, що ти помер ще за стіною — дякуємо, Valve»," +
  " «п'ятірка в зборі, план геніальний: стрілочки, фейки — і все одно rush B».";

// The danger is a wrong *memory*, not a wrong number: asked to be warm and specific, the model
// recalls a clutch that never happened and no check catches it — so it is said three ways below.
export const SYSTEM_PROMPT =
  "You write ONE birthday message for a member of a casual CS2 squad's private Telegram group chat." +
  " Output only the message text — no preamble, no quotes, no markdown, no subject line, no signature." +
  // The exact shape is stated once, in the ask — a latitude granted here and refused there drifts.
  " It is short and tight — a joke and a genuine wish, nothing else — laid out in the exact shape" +
  " the request below asks for. Every line has to earn its place: cut the setup, never the wish." +
  " No words in ALL CAPS, and no profanity, and no emoji (one is appended programmatically later)." +
  " The person is referred to by the code P1: write P1 verbatim wherever you name them — it is" +
  " replaced with their real name before the message is sent. Never write any other player code," +
  " and never invent a nickname for them or for anyone else." +
  // The swap puts back a bare nominative: «в P1 день народження» shipped as «в Олег день народження».
  " P1 is a placeholder and takes no Ukrainian case ending, so build every sentence around it in" +
  " the nominative — as the subject, or as a direct address set off by a comma. Never place P1" +
  " where the grammar would require any other case; rephrase the sentence instead." +
  " You know two things about this person: that code, and how old they are turning. Nothing else." +
  " So never recall a specific match, round, clutch, map, score or evening as though it happened —" +
  " you were not there and it would be invented. Never quote a stat, a rank or an Elo figure, and" +
  " never write any number other than the age you are given." +
  " Joke about the things the whole squad shares — the «одну катку» that ends at four in the morning," +
  " the mic, the plan nobody follows, the ranked ladder — never about this person's skill, and never" +
  " with contempt. Tease like a close friend at a table, and mean the last paragraph." +
  " Gaming terms (ADR, HS, AWP, K/D, MVP, FACEIT, CS2) stay in Latin letters exactly as given." +
  " You may use Telegram HTML <b> or <i> on a few short fragments — never on a whole paragraph. No other tags." +
  UA_STYLE;

// No dated events, no named pros, and no angle may ask for a memory — that invites the invented
// match the system prompt bans. Every one is a format to fill in or a running squad joke.
const BIRTHDAY_ANGLES: string[] = [
  "оформи привітання як патчноут: гравця оновлено до нової версії, старі баги не пофіксили, зате додали контенту",
  "оголоси, що сьогодні йому не можна відмовити в грі — навіть о четвертій ранку, навіть на його улюбленій мапі",
  "склади список побажань у форматі закупу: здоров'я — full buy, нерви — броня і шолом, терпіння — повна утиліта",
  "подай його як єдиного, хто щиро вірить у «одну катку», і за це його й люблять",
  "оформи це як нагородження на сцені мажора: світло, конфеті, овації — а він у капцях і з чаєм",
  "зачитай офіційну заяву від імені всього скваду: сьогодні всі фраги, всі MVP і весь лут дарують імениннику",
  "подай минулий рік як сезон: рейтинг качало, але моменти були золоті, і контракт продовжено ще на один",
  "оголоси, що з сьогодні його ранг у житті підвищено адміністрацією без апеляції та без калібрування",
  "порівняй його з мапою, яку всі люблять і ніхто ніколи не банить у вето",
  "уяви себе коментатором, який вітає гравця прямо в ефірі, поки той третю хвилину не може зайти в лоббі",
  "оформи тост від людини, яка вже трохи святкує і тому каже все чесніше, ніж збиралася",
  "подай його як живий доказ того, що анти-чит існує: так грати без нього неможливо",
  "оголоси його персональним святом усього чату — з вихідним, розкладом і обов'язковою вечірньою каткою",
  "оформи привітання як опис персонажа: характеристики, пасивні здібності й один недолік, який усі вважають фішкою",
  "подай це як щорічне технічне обслуговування: рік нальоту, деталі оригінальні, гарантію продовжено",
];

// Rolled in code: asked to choose, the model writes the same greeting-card toast every time.
const BIRTHDAY_REGISTERS = [
  " Voice: an old friend giving a toast at the table — unhurried, a little sentimental, entirely sincere under the jokes.",
  " Voice: a commentator calling the day live as if it were a grand final — escalating, breathless, treating an ordinary birthday as the event of the year.",
  " Voice: a deliberately dry official document — clauses, sections, procedure — that keeps slipping into real warmth and pretending it didn't.",
];

// A number actually sent to the model, and enforced by `maxWords` — see CLAUDE.md for calibration.
const MAX_WORDS = 70;

// Prefer what hasn't been out lately, fall back to the full pool once everything is stale.
// In memory, so a restart forgets — fine at one toast per member per year.
function rollFresh(pool: string[], recent: string[], keep: number): string {
  const fresh = pool.filter(item => !recent.includes(item));
  const src = fresh.length ? fresh : pool;
  const picked = src[Math.floor(Math.random() * src.length)];
  recent.push(picked);
  while (recent.length > keep) recent.shift();
  return picked;
}

const recentAngles: string[] = [];
const recentRegisters: string[] = [];

/* ------------------------------------------------------------------ *
 * What the second attempt is told. A blind re-roll repeated the same
 * mistake whenever the angle invited it, so this names the broken rule
 * — as a correction, not as the rule restated.
 * ------------------------------------------------------------------ */

// A Record so a new RejectReason fails typecheck instead of shipping a silent retry.
const RETRY_FIX: Record<RejectReason, string> = {
  elo: "you mentioned Elo. Do not write the word Elo, and do not give any rating figure — say «рейтинг» or nothing.",
  "unsourced-stat":
    "you used a number that was never given to you. Quote only the figures written above, attached to whoever" +
    " they belong to, or write no numbers at all.",
  "unknown-code":
    "you used a player code that was never given to you. Write only a code this prompt listed;" +
    " if it listed none, name nobody at all.",
  language: "it was not in Ukrainian. Write every word of the message in natural spoken Ukrainian.",
  empty: "it came back empty. Answer with the message text itself and nothing else.",
  "too-long": "it was far too long to send. Write a considerably shorter one, comfortably inside the word limit you were given.",
};

// Returns the whole second ask, so this module stays the only place that composes what the
// model reads — where the correction goes is a prompt decision, not the adapter's.
export const retryAsk = (prompt: string, reason: RejectReason): string =>
  `${prompt} Your previous attempt was rejected because ${RETRY_FIX[reason]}` +
  ` Write a different message that avoids this.`;

// The member reaches the model only as P1, keeping a Latin username away from its transliteration
// reflex; phrase.ts swaps `name` back in. The age is all it knows — the squad tracks no stats or
// history, and inventing either is exactly what the prompt forbids.
export function birthdayPrompt(name: string, age: number): PhraseRequest {
  const angle = rollFresh(BIRTHDAY_ANGLES, recentAngles, Math.min(3, BIRTHDAY_ANGLES.length - 1));
  const register = rollFresh(BIRTHDAY_REGISTERS, recentRegisters, 1);
  return {
    prompt:
      `Someone in the squad is having a birthday today. They are referred to as P1 and they are turning ${age}.` +
      ` Write ONE short, funny, warm birthday message to them, for the whole group to read.` +
      ` Angle — commit to it fully: ${angle}.` +
      register +
      // Sentences, not words, are what the model can count; `maxWords` below enforces the ceiling.
      ` Exactly two short paragraphs separated by a blank line — the joke, then the wish — ONE` +
      ` sentence each, so TWO sentences in the whole message, and never more than` +
      ` ${MAX_WORDS} words. Keep both sentences short: say one thing well and stop.` +
      ` Address P1 directly, and use the code P1 rather than «ти» at least twice so it reads as` +
      ` addressed to them by name.` +
      // Only the prompt can say this: `attributable` ignores 1–2 digit integers.
      ` The number ${age} is the only number you may write anywhere in the message.` +
      ` Do not open with «З днем народження» — that line is printed above your message already.` +
      ` End on a real wish, not a punchline.`,
    checks: {
      name,
      maxWords: MAX_WORDS,
      safeNumbers: new Set([String(age)]),
    },
  };
}
