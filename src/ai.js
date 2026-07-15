import OpenAI from "openai";
import { t, LANG } from "./i18n.js";

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
  " Tone reference — match the vibe, but NEVER reuse the wording, structure or jokes:" +
  " «поки вони малювали стрілочки на A, ми вже винесли B і забрали ключі від сервера»," +
  " «сервер лагав, Меркурій ретроградний, а в кота тіммейта був важливий дзвінок»," +
  " «п'ятірка в зборі — комусь зараз буде дуже незручно».";

const SYSTEM_PROMPT =
  "You write ONE short message at a time for a casual CS2 squad's private Telegram group chat." +
  " Output only the message text — no preamble, no quotes, no markdown, no emoji (one emoji is appended programmatically later)." +
  " No words in ALL CAPS." +
  " Map names and gaming terms (ADR, Elo, HS, FACEIT) always stay in Latin letters exactly as given — never translate or transliterate them into Cyrillic." +
  " Players are referenced by codes like P1 or P2: if you mention a player, write the code verbatim — it is replaced with the real nickname later." +
  " Never output a player code you were not given, never invent players or stats, and copy every ADR/Elo number exactly as provided." +
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
  "скликай сквад як епічну армію, що збирається на битву",
  "потролль суперників, які ще не підозрюють, що на них насувається",
  "подай це як збір крю для пограбування століття",
  "уяви себе коментатором, що зриває голос перед стартовим свистком",
  "пообіцяй славу, клатчі та хайлайти на весь Telegram",
  "пожартуй, що серверам краще пристебнутись",
  "оголоси штормове попередження: насувається наш сквад",
  "подай це як секретну операцію, що переходить у фінальну фазу",
  "оголоси відкриття сезону полювання",
];

const WIN_ANGLES = [
  "коронуй сквад як королів сервера",
  "потролль суперників, у яких не було жодного шансу",
  "подай перемогу як бездоганний майстер-клас",
  "оголоси це виступом рівня хайлайт-рілу",
  "пожартуй, що суперникам час видаляти гру або просити реванш, якого не буде",
  "подай це як пограбування: зайшли, винесли раунди, зникли",
  "розкажи це як документалку про хижаків і здобич",
  "подай як закриту бізнес-угоду — акції сквада стрімко вгору",
  "подай як історичну подію, про яку писатимуть підручники",
];
const WIN_ANGLE_CLOSE = "відсвяткуй нервовий клатч-камбек, який довів чат до інфаркту";
const WIN_ANGLE_STOMP = "оголоси суху беззаперечну домінацію без жодного шансу для суперника";

const LOSS_ANGLES = [
  "поскаржся на підозріло ідеальний аім суперників: спінбот, вх, нереальний відсоток хедшотів",
  "звинувать faceit античіт, що знову проспав матч",
  "звинувать лаг, сервери або роутер, який вирішив оновитися посеред раунду",
  "оголоси матч розвідкою боєм перед тактичним реваншем",
  "звинувать ретроградний Меркурій, карму або богів геймінгу",
  "подай поразку як моральну перемогу і безкоштовний коучинг для суперників",
  "пожартуй про критичний брак кави, сну чи перекуру",
  "прикинься, що це був навмисний сандбег, щоб приспати пильність",
  "звинувать кота тіммейта, раптовий тихий час або похід за снеками",
  "пожартуй, що суперникам після такої гри час оформлювати пенсію",
];

const recentAngles = { hype: [], win: [], loss: [] };

function pickAngle(kind, pool) {
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

const recentPhrases = { hype: [], win: [], loss: [] };

function remember(kind, text) {
  const arr = recentPhrases[kind];
  arr.push(text);
  while (arr.length > 3) arr.shift();
}

function recentBlock(kind) {
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

const EMOJIS = {
  hype: ["🔥", "⚔️", "😈", "🚀", "💣", "👊", "🍿", "🎮", "🫡"],
  win: ["🏆", "👑", "🔥", "😎", "💪", "🥂", "🚀", "📈", "🥇", "🎉"],
  loss: ["🤡", "💀", "🤷", "😴", "🫠", "📉", "🕯️", "🧘", "☕", "😮‍💨"],
};

const pickEmoji = kind => EMOJIS[kind][Math.floor(Math.random() * EMOJIS[kind].length)];

/* ------------------------------------------------------------------ *
 * Sanitizing. Mostly the original chain, plus: strip ALL emoji the
 * model sneaks in (we append our own), de-transliterate known map
 * names and restore the canonical map casing.
 * ------------------------------------------------------------------ */

const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MAP_FIX = [
  [/(?<![\p{L}\p{N}])[іи]нферно(?![\p{L}\p{N}])/giu, "Inferno"],
  [/(?<![\p{L}\p{N}])м[іи]раж(?![\p{L}\p{N}])/giu, "Mirage"],
  [/(?<![\p{L}\p{N}])н['ьʼ]?юк(?![\p{L}\p{N}])/giu, "Nuke"],
  [/(?<![\p{L}\p{N}])д[ау]ст\s?2(?![\p{L}\p{N}])/giu, "Dust2"],
  [/(?<![\p{L}\p{N}])анубіс(?![\p{L}\p{N}])/giu, "Anubis"],
  [/(?<![\p{L}\p{N}])(?:ейншент|анц[іи]єнт|енш[еє]нт)(?![\p{L}\p{N}])/giu, "Ancient"],
  [/(?<![\p{L}\p{N}])оверпас(?![\p{L}\p{N}])/giu, "Overpass"],
  [/(?<![\p{L}\p{N}])трейн(?![\p{L}\p{N}])/giu, "Train"],
  [/(?<![\p{L}\p{N}])верт[іи]го(?![\p{L}\p{N}])/giu, "Vertigo"],
];

function sanitize(text, map) {
  let r = text
    .replace(/["'"'«»„"]/g, "")
    .replace(/@(?=\w)/g, "")
    .replace(/[*_`#~|]/g, "")
    .replace(/<(?!\/?(?:b|i)>)[^>]*>/g, "")
    .replace(/(?<![\p{L}\p{N}])\p{Lu}{2,}(?![\p{L}\p{N}])/gu, w => w.toLowerCase())
    .replace(/\badr\b/gi, "ADR")
    .replace(/(?<![\p{L}\p{N}])адр(?![\p{L}\p{N}])/giu, "ADR")
    .replace(/(?<![\p{L}\p{N}])(?:ело|elo)(?![\p{L}\p{N}])/giu, "Elo")
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

function buildPlayerBlock(players) {
  const top = (players ?? []).filter(p => p.adr >= 100).sort((a, b) => b.adr - a.adr);
  const none = { line: "Do not mention any player names or stats.", codes: new Map() };
  if (!top.length) return none;

  const roll = Math.random();
  if (roll < 0.25) return none; // sometimes skip players entirely for variety

  const codes = new Map(top.map((p, i) => [`P${i + 1}`, p.nickname]));
  const list = top.map((p, i) => `P${i + 1} (${p.adr} ADR)`).join(", ");
  const line =
    roll < 0.6
      ? `Players who dropped 100+ ADR: ${list}. Build the message around a shoutout to P1, quoting the ADR number exactly.`
      : `Players who dropped 100+ ADR: ${list}. You may mention at most one of them, quoting codes and numbers exactly.`;
  return { line, codes };
}

function mapLine(map) {
  if (!map) return "Do not mention any map.";
  return Math.random() < 0.55
    ? `The map was ${map} — mention it only if it fits the angle naturally, keeping the name exactly as written.`
    : "Do not mention the map name in this message.";
}

function scoreDiff(score) {
  const m = /(\d+)\D+(\d+)/.exec(score ?? "");
  return m ? Math.abs(Number(m[1]) - Number(m[2])) : null;
}

/* ------------------------------------------------------------------ */

const ELO_MENTION = /(?<![\p{L}\p{N}])(elo|ело)(?![\p{L}\p{N}])/iu;
const LEFTOVER_CODE = /(?<![\p{L}\p{N}])[PpРр]\d(?![\p{L}\p{N}])/u;

async function generate(kind, userPrompt, fallback, { allowElo = true, codes = new Map(), map = null } = {}) {
  if (!ai) return fallback();
  try {
    const chat = await ai.chat.completions.create({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      thinking: { type: "enabled" },
      // thinking mode's reasoning_content shares this budget with the final
      // message, so keep enough headroom that a longer reasoning chain can't
      // truncate the reply (the model stops early, so the higher cap is free).
      max_tokens: 2048,
      temperature: 0.8,
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
    console.error("[ai] generation failed:", err.message);
    return fallback();
  }
}

/* ------------------------------------------------------------------ */

export async function generateHypePhrase(eventName) {
  const angle = pickAngle("hype", HYPE_ANGLES);
  const prompt =
    `A squad just filled up ${eventName ? `for an event called "${eventName}"` : "for a CS2 session"}.` +
    ` Write ONE funny, energetic hype message to fire them up.` +
    ` Angle — commit to it fully: ${angle}.` +
    ` Max 15 words. Do not repeat the event name or start time — they are already shown above your message.` +
    recentBlock("hype");
  return generate("hype", prompt, () => FALLBACK_HYPE);
}

export async function generateMatchPhrase(won, score, { map, elo, players } = {}) {
  const upsetWin = won && elo && elo.theirs - elo.ours >= 75;
  const upsetLoss = !won && elo && elo.ours - elo.theirs >= 75;
  const diff = scoreDiff(score);
  const close = diff !== null && diff <= 3;

  const context = [
    score,
    map ? `on ${map}` : null,
    upsetWin ? `(upset win: our ${elo.ours} Elo beat their ${elo.theirs} Elo)` : null,
    upsetLoss ? `(lost to a lower-rated team: our ${elo.ours} Elo vs their ${elo.theirs} Elo)` : null,
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
    ` Max 20 words. Punchy; never blame our own team.` +
    recentBlock("loss");
  return generate("loss", prompt, () => FALLBACK_LOSS, { allowElo: Boolean(upsetLoss), map });
}