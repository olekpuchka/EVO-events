import OpenAI from "openai";
import { t, LANG } from "../view/i18n.ts";
import { DEEPSEEK_API_KEY } from "../config.ts";
import type { MatchPlayer, EloPair, MatchFlow } from "../types.ts";

type Kind = "hype" | "win" | "loss";

// Both callers block on this: handleRsvp before the 5/5 edit, sendReminder after the scheduler
// already claimed the row. The SDK applies `timeout` per attempt, so no retries — 15s is then a
// hard bound, against a measured 4–9s. A miss costs a fallback phrase, which is what they're for.
const ai = DEEPSEEK_API_KEY
  ? new OpenAI({
      apiKey: DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
      timeout: 15_000,
      maxRetries: 0,
    })
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
  " Tone reference — match the vibe, but NEVER reuse the wording, structure or jokes:" +
  " «вони зайшли з full buy і надією, а вийшли з exit-фрагами і skill issue»," +
  " «сабтік порадився з пінгом і вирішив, що ти помер ще за стіною — дякуємо, Valve»," +
  " «п'ятірка в зборі, план геніальний: стрілочки, фейки — і все одно rush B».";

const SYSTEM_PROMPT =
  "You write ONE short message at a time for a casual CS2 squad's private Telegram group chat." +
  " Output only the message text — no preamble, no quotes, no markdown, no emoji (one emoji is appended programmatically later)." +
  " No words in ALL CAPS." +
  " Map names and gaming terms (ADR, Elo, HS, AWP, FACEIT) always stay in Latin letters exactly as given — never translate or transliterate them into Cyrillic." +
  " Players are referenced by codes like P1 or P2: if you mention a player, write the code verbatim — it is replaced with the real nickname later." +
  " Never output a player code you were not given, never invent players or stats, and copy every number exactly as provided (ADR, Elo, HS%, K/D/A, scores)." +
  " Mention Elo only if Elo numbers are explicitly given, and write them as X Elo." +
  " You may use Telegram HTML <b> or <i> sparingly to stress a word or two; no other tags." +
  (LANG === "UA" ? UA_STYLE : " Write in casual, punchy English.");

/* ------------------------------------------------------------------ *
 * Angle roulette. The old prompt listed every angle and asked the
 * model to "pick a fresh one" — an LLM then converges on the most
 * probable option every time (майстер-клас / faceit античіт).
 * Picking the angle in code guarantees uniform variety; a small
 * in-memory history avoids back-to-back repeats. State resets on
 * cold start, which is fine — stateless randomness alone already
 * kills ~90% of the repetition. Persist to Supabase (one jsonb row)
 * only if you want strict rotation across restarts.
 * ------------------------------------------------------------------ */

const HYPE_ANGLES = [
  "затверди єдиний тактичний план на вечір: rush B, не зупиняємось і не думаємо",
  "оформи збір як BREAKING-новину HLTV: склад укомплектовано, аналітики вже бояться",
  "подай звичайну вечірню катку з серйозністю гранд-фіналу мажора: тактичні паузи, джерсі, рукостискання",
  "оголоси, що п'ятеро незнайомців щойно підписали дарчу на свої -25 Elo, просто ще про це не знають",
  "подай майбутніх суперників як мішені з aim botz, які навчилися ходити",
  "постав ціль вечора: грати так, щоб суперники тиждень крутили нашу demo на 0.25x і строчили репорти",
  "пообіцяй комусь із суперників фраг ножем — з поваги до економії патронів",
  "подай це як «одну катку», після якої всі як завжди розійдуться о четвертій ранку",
  "порівняй збір із комп'ютерним клубом 2007-го, тільки тепер адмін не вижене через годину",
  "оголоси свято: повний стак, нуль рандомів, кожен фейл сьогодні буде рідним",
  "оголоси, що в лоббі зібрались п'ять s1mple, а хто з них ZywOo — з'ясуєте в овертаймі",
  "подай геніальний план капітана зі стрілочками і фейками, який все одно закінчиться рашем на B",
  "уяви себе коментатором, що зриває голос перед стартовим свистком",
  "оголоси штормове попередження: насувається наш сквад",
  "оголоси відкриття сезону полювання",
];

const WIN_ANGLES = [
  "подай навіть найпотнішу перемогу в овертаймі як ізі катку — з абсолютно серйозним обличчям",
  "подай перемогу як суху бухгалтерію: +25 у скарбничку, рахунок закрито, банк наш",
  "повідом, що суперники вже гуглять системні вимоги Valorant",
  "порівняй перемогу зі Стокгольмом-2021: чисто, по-українськи, s1mple десь схвально кивнув",
  "подай це як економічну катастрофу суперників: їхній full buy програв нашим пістолетам",
  "оголоси максимальну неповагу: таких суперників треба було закривати з Zeus x27",
  "підсумуй ворожий перформанс самотнім знаком питання в all-chat",
  "подай суперників як п'ять decoy-гранат: стоять, шумлять, фрагів не приносять",
  "оформи ворожі промахи як офіційний звіт: постріли 1-5 — явно повз, 6-9 — віддача",
  "пожартуй, що в суперників сьогодні срібла більше, ніж у бабусиній шухляді з ложками",
  "подай найкращий момент вечора як ноускоуп s1mple у Кельні — час малювати графіті на мапі",
  "подай перемогу як пограбування: зайшли тихіше за ninja defuse, винесли раунди, зникли",
  "подай ворожі репорти і -rep у профілях як головний трофей: настільки чисто, що нам не вірять",
  "подай криву некрасиву перемогу формулою NaVi-фольклору: красиво не вийшло, зате не злив",
  "потролль суперників, у яких не було жодного шансу",
];
const WIN_ANGLE_CLOSE = "відсвяткуй камбек-трилер, який довів чат до інфаркту: десь один клан знову заплакав, як у Бостоні-2018";
const WIN_ANGLE_STOMP = "оголоси суху беззаперечну домінацію: суперникам залишалось хіба фармити exit-фраги";

const LOSS_ANGLES = [
  "звинувать netcode CS2: ми стріляли перші, але сабтік порадився з пінгом і вирішив інакше",
  "побажай суперникам гарних VACацій — до ранкової бан-хвилі їхні +25 не доживуть",
  "звинувать смурфів: акаунту три дні, а aim як у donk — талановита молодь, нічого не скажеш",
  "зачитай бінго відмазок одним списком: лаги, нова мишка, fps просів, сонце світило в монітор",
  "звинувать меблі: суперники не кращі, просто їхні крісла геймерськіші за наші",
  "подай поразку як грамотний save: зброю зберегли, гідність зберегли, рейтинг — не встигли",
  "знецінь ворожого топ-фрагера: половина його фрагів — exit-фраги проти наших пістолетів",
  "натякни, що їхній тренер знову літав над мапою — coach bug наче ж пофіксили",
  "подай закриті Steam-профілі й аніме-аватарки суперників як неспростовний доказ — суду все зрозуміло",
  "звинувать алгоритм faceit: він вирішив, що ми забагато перемагали — планове балансування",
  "звинувать one-way смоки і піксельні кути: Женевська конвенція проти, Valve — ні",
  "звинувать роутер і сервер десь у Гренландії: наші кулі досі летять поштою",
  "подай поразку як недорозминку: матч закінчився раніше, ніж ми встигли розігрітись",
  "подай це як маскування рівня tier-1: справжні страти бережемо на мажор",
  "назви переможців типовими онлайнерами і пообіцяй розправу на LAN, якого ніколи не буде",
  "поскаржся на підозріло ідеальний аім суперників: спінбот, вх, нереальний відсоток хедшотів",
];

const recentAngles: Record<Kind, string[]> = { hype: [], win: [], loss: [] };

function pickAngle(kind: Kind, pool: string[]): string {
  const recent = recentAngles[kind];
  const fresh = pool.filter(a => !recent.includes(a));
  const src = fresh.length ? fresh : pool;
  const angle = src[Math.floor(Math.random() * src.length)];
  recent.push(angle);
  while (recent.length > Math.min(3, pool.length - 1)) recent.shift();
  return angle;
}

/* ------------------------------------------------------------------ *
 * Recent-phrase memory: the last 3 sent messages per kind are fed
 * back as "write something clearly different". In-memory, same
 * cold-start caveat as above.
 * ------------------------------------------------------------------ */

const recentPhrases: Record<Kind, string[]> = { hype: [], win: [], loss: [] };

function remember(kind: Kind, text: string): void {
  const arr = recentPhrases[kind];
  arr.push(text);
  while (arr.length > 3) arr.shift();
}

function recentBlock(kind: Kind): string {
  if (!recentPhrases[kind].length) return "";
  return (
    " Recent messages of this type — yours must differ clearly in wording, structure and opening: " +
    recentPhrases[kind].map(m => `«${m}»`).join(" ")
  );
}

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
 * Sanitizing. Mostly the original chain, plus: strip ALL emoji the
 * model sneaks in (we append our own), de-transliterate known map
 * names and restore the canonical map casing.
 * ------------------------------------------------------------------ */

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    .replace(/\badr\b/gi, "ADR")
    .replace(/(?<![\p{L}\p{N}])адр(?![\p{L}\p{N}])/giu, "ADR")
    .replace(/(?<![\p{L}\p{N}])(?:ело|elo)(?![\p{L}\p{N}])/giu, "Elo")
    .replace(/(?<![\p{L}\p{N}])hltv(?![\p{L}\p{N}])/giu, "HLTV")
    .replace(/(?<![\p{L}\p{N}])hs(?![\p{L}\p{N}])/giu, "HS")
    .replace(/(?<![\p{L}\p{N}])awp(?![\p{L}\p{N}])/giu, "AWP")
    .replace(/<\/\d+>/g, "")
    .replace(/^<i>(.*)<\/i>$/, (_, inner) => (inner.includes("</i>") ? `<i>${inner}</i>` : inner))
    .replace(/<b>(?![^<]*<\/b>)/g, "")
    .replace(/<i>(?![^<]*<\/i>)/g, "")
    .replace(/<\/b>/g, (m, off, s) => (s.slice(0, off).includes("<b>") ? m : ""))
    .replace(/<\/i>/g, (m, off, s) => (s.slice(0, off).includes("<i>") ? m : ""));

  // strip any emoji the model added — one is appended in code instead
  r = r.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, "");

  for (const [rx, canon] of MAP_FIX) r = r.replace(rx, canon);
  if (map) {
    r = r.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRx(map)}(?![\\p{L}\\p{N}])`, "giu"), map);
  }

  return r.replace(/\s{2,}/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Player placeholders. Instructions alone don't stop transliteration
 * (Фулгрем, трансенд, зенді), so the model only ever sees codes
 * P1/P2/... and we swap the real nicknames back in afterwards. This
 * also protects nicknames like "_zandy" from the markdown stripper,
 * and lets us fall back cleanly if a code we never issued shows up.
 * ------------------------------------------------------------------ */

// Situational highlights the top player can earn, ordered most-impressive
// first. `min` is the "notable" bar — set so a stat only shows when it stands
// out, not for a routine game (e.g. utility damage regularly clears 100, so
// the bar sits higher). NaN (missing stat) never passes `>= min`.
const HIGHLIGHTS: { min: number; get: (p: MatchPlayer) => number; label: (n: number) => string }[] = [
  { min: 1, get: p => p.clutches, label: n => (n > 1 ? `${n} 1v2 clutches` : "a 1v2 clutch") },
  { min: 5, get: p => p.awp, label: n => `${n} AWP kills` },
  { min: 5, get: p => p.entries, label: n => `${n} entry frags` },
  { min: 200, get: p => p.util, label: n => `${n} utility damage` },
  { min: 10, get: p => p.flashes, label: n => `${n} enemies flashed` },
];

// Only the top player (full=true) gets the dense line (K/D/A, ADR, HS%) and the
// situational HIGHLIGHTS; the rest get ADR plus the rarest highlight (ace/quad)
// only. The flair list is capped, so the block stays a curated hook rather than
// a wall of numbers the model can misquote or converge on — see the
// never-firehose rationale on the angle roulette above.
function playerFacts(p: MatchPlayer, full = true): string {
  const parts: string[] = [];
  if (full && [p.kills, p.deaths, p.assists].every(Number.isFinite)) {
    parts.push(`${p.kills}/${p.deaths}/${p.assists} K/D/A`);
  }
  parts.push(`${p.adr} ADR`);
  if (full && Number.isFinite(p.hs)) parts.push(`${p.hs}% HS`);
  const flair: string[] = [];
  if (p.aces > 0) flair.push(p.aces > 1 ? `${p.aces} aces` : "an ace");
  else if (p.quadros > 0) flair.push(p.quadros > 1 ? `${p.quadros} quad-kills` : "a quad-kill");
  if (full) {
    for (const h of HIGHLIGHTS) {
      const v = h.get(p);
      if (v >= h.min) flair.push(h.label(v));
    }
  }
  const shown = flair.slice(0, 3); // cap: at most the 3 top highlights
  return parts.join(", ") + (shown.length ? `, ${shown.join(" & ")}` : "");
}

function buildPlayerBlock(players: MatchPlayer[] | undefined): { line: string; codes: Map<string, string> } {
  const top = (players ?? [])
    .filter(p => Number.isFinite(p.adr) && p.adr >= 100)
    .sort((a, b) => b.adr - a.adr);
  const none = { line: "Do not mention any player names or stats.", codes: new Map<string, string>() };
  if (!top.length) return none;

  const roll = Math.random();
  if (roll < 0.25) return none; // sometimes skip players entirely for variety

  const codes = new Map(top.map((p, i) => [`P${i + 1}`, p.nickname]));
  const list = top.map((p, i) => `P${i + 1} (${playerFacts(p, i === 0)})`).join("; ");
  const line =
    roll < 0.6
      ? `Standout players — ${list}. Build the message around a shoutout to P1, quoting its numbers exactly.`
      : `Standout players — ${list}. You may mention at most one of them, quoting codes and numbers exactly.`;
  return { line, codes };
}

function mapLine(map: string | null | undefined): string {
  if (!map) return "Do not mention any map.";
  return Math.random() < 0.55
    ? `The map was ${map} — mention it only if it fits the angle naturally, keeping the name exactly as written.`
    : "Do not mention the map name in this message.";
}

function scoreDiff(score: string | undefined): number | null {
  const m = /(\d+)\D+(\d+)/.exec(score ?? "");
  return m ? Math.abs(Number(m[1]) - Number(m[2])) : null;
}

/* ------------------------------------------------------------------ *
 * Match-flow narrative. Like the upset/close signals, the story is
 * computed in code and handed to the model as one ready hook rather
 * than raw half-scores. Only blame-safe angles are surfaced: a
 * comeback win, or an overtime finish either way — never a "we led
 * and threw it" collapse, which would break the never-blame-our-team
 * rule on losses.
 * ------------------------------------------------------------------ */

function flowNote(won: boolean, flow: MatchFlow | null | undefined): string | null {
  if (!flow) return null;
  const { ourFirst, theirFirst, ourOt, theirOt } = flow;
  if (!Number.isFinite(ourFirst) || !Number.isFinite(theirFirst)) return null;
  const ot = (Number(ourOt) || 0) + (Number(theirOt) || 0) > 0;
  if (won && theirFirst - ourFirst >= 3) {
    return `we were down ${ourFirst}:${theirFirst} at the half and still won${ot ? " in overtime" : ""}`;
  }
  if (ot) return won ? "we won it in overtime" : "we lost it in overtime";
  return null;
}

/* ------------------------------------------------------------------ */

const ELO_MENTION = /(?<![\p{L}\p{N}])(elo|ело)(?![\p{L}\p{N}])/iu;
const LEFTOVER_CODE = /(?<![\p{L}\p{N}])[PpРр]\d(?![\p{L}\p{N}])/u;

interface GenerateOptions {
  allowElo?: boolean;
  codes?: Map<string, string>;
  map?: string | null;
}

async function generate(
  kind: Kind,
  userPrompt: string,
  fallback: () => string,
  { allowElo = true, codes = new Map<string, string>(), map = null }: GenerateOptions = {}
): Promise<string> {
  if (!ai) return fallback();
  try {
    const chat = await ai.chat.completions.create({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      // thinking mode's reasoning_content shares this budget with the final
      // message, so keep enough headroom that a longer reasoning chain can't
      // truncate the reply (the model stops early, so the higher cap is free).
      max_tokens: 2048,
      temperature: 0.8,
      // `thinking` is a DeepSeek extension absent from the OpenAI SDK types;
      // spread it in so the request carries it without a type error.
      ...({ thinking: { type: "enabled" } } as object),
    });
    const text = chat.choices[0]?.message?.content?.trim();
    if (!text) return fallback();

    let result = sanitize(text, map);

    // swap player codes back to real nicknames (immune to transliteration)
    for (const [code, nick] of codes) {
      const rx = new RegExp(`(?<![\\p{L}\\p{N}])[PpРр]${code.slice(1)}(?![\\p{L}\\p{N}])`, "gu");
      result = result.replace(rx, nick);
    }
    // a code we never issued survived → model hallucinated, don't ship it
    if (LEFTOVER_CODE.test(result)) return fallback();

    if (!allowElo && ELO_MENTION.test(result)) return fallback();
    if (!result || result.length > 280) return fallback();

    result = `${result} ${pickEmoji(kind)}`;
    remember(kind, result);
    return result;
  } catch (err) {
    console.error("[ai] generation failed:", (err as Error).message);
    return fallback();
  }
}

/* ------------------------------------------------------------------ */

export async function generateHypePhrase(eventName: string | null): Promise<string> {
  const angle = pickAngle("hype", HYPE_ANGLES);
  const prompt =
    `A squad just filled up ${eventName ? `for an event called "${eventName}"` : "for a CS2 session"}.` +
    ` Write ONE funny, energetic hype message to fire them up.` +
    ` Angle — commit to it fully: ${angle}.` +
    ` Max 25 words. Do not repeat the event name or start time — they are already shown above your message.` +
    recentBlock("hype");
  return generate("hype", prompt, () => FALLBACK_HYPE);
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
  const diff = scoreDiff(score);
  const close = diff !== null && diff <= 3;
  const flow = flowNote(won, matchFlow);

  const context = [
    score,
    map ? `on ${map}` : null,
    upsetWin ? `(upset win: our ${elo!.ours} Elo beat their ${elo!.theirs} Elo)` : null,
    upsetLoss ? `(lost to a lower-rated team: our ${elo!.ours} Elo vs their ${elo!.theirs} Elo)` : null,
  ].filter(Boolean).join(" ");

  if (won) {
    const angle = pickAngle("win", [...WIN_ANGLES, close ? WIN_ANGLE_CLOSE : WIN_ANGLE_STOMP]);
    const { line: playerLine, codes } = buildPlayerBlock(players);
    const prompt =
      `The squad just WON ${context}. Write ONE short funny celebratory message.` +
      ` Angle — commit to it fully: ${angle}.` +
      ` ${playerLine}` +
      ` ${mapLine(map)}` +
      (upsetWin ? " Our team was rated lower and still won — make that part of the joke." : "") +
      (flow ? ` Extra angle you can lean into: ${flow}.` : "") +
      ` Max 25 words. Triumphant, never mention losing or anything negative.` +
      recentBlock("win");
    return generate("win", prompt, () => FALLBACK_WIN, { allowElo: Boolean(upsetWin), codes, map });
  }

  const angle = pickAngle("loss", LOSS_ANGLES);
  const prompt =
    `The squad just LOST ${context}. Write ONE short funny sarcastic excuse message.` +
    ` Angle — commit to it fully: ${angle}.` +
    ` ${mapLine(map)}` +
    (upsetLoss ? " They were rated lower than us — squeeze maximum drama out of that." : "") +
    (flow ? ` Extra angle you can lean into: ${flow}.` : "") +
    ` Max 25 words. Punchy; never blame our own team.` +
    recentBlock("loss");
  return generate("loss", prompt, () => FALLBACK_LOSS, { allowElo: Boolean(upsetLoss), map });
}
