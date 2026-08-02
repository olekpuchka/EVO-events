// Everything said *to* the model: the system prompt, the angle roulette, and the
// match facts turned into prompt text. Pure — it builds strings and returns the
// checks the reply will be judged against, but never calls anything.
//
// Split from adapters/ai.ts because it changes for entirely different reasons:
// jokes, tone and what counts as an interesting stat, rather than how the API is
// spoken to. See **The AI call** and **Match phrases** in CLAUDE.md.

import type {
  Kind,
  MatchFlow,
  MatchPhraseContext,
  MatchPlayer,
  Opponents,
  HypeContext,
  PhraseRequest,
  PlayerBlock,
  PromptPlayer,
  RejectReason,
} from "../types.ts";

/* ------------------------------------------------------------------ *
 * Static system prompt. Identical on every call, so DeepSeek's
 * automatic context caching turns it into cheap cached prefix tokens
 * and the rules stick better than when buried in a wall of user text.
 * ------------------------------------------------------------------ */

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

export const SYSTEM_PROMPT =
  "You write ONE short message at a time for a casual CS2 squad's private Telegram group chat." +
  " Output only the message text — no preamble, no quotes, no markdown, no emoji (one emoji is appended programmatically later)." +
  " No words in ALL CAPS, and no profanity." +
  " One or two sentences, never three, and name at most two players — a message that lists everyone" +
  " stops being a joke." +
  " Map names and gaming terms (ADR, Elo, HS, AWP, K/D, MVP, FACEIT) always stay in Latin letters exactly as given — never translate or transliterate them into Cyrillic." +
  " Everything else about a stat is described to you in English only so you understand it — say it in" +
  " your own words in Ukrainian, and never paste the English wording into the" +
  " message. Copy the number, not the label." +
  " Players are referenced by codes like P1 or P2: if you mention a player, write the code verbatim — it is replaced with the real nickname later." +
  " Never output a player code you were not given, never invent players or stats, and copy every number exactly as provided (ADR, Elo, HS%, K/D/A, scores)." +
  " Never write a number that was not given to you — no rounding, no estimating, no filling a gap with a plausible figure." +
  " You are told the map but never where anything happened, so never name a position or callout" +
  " (banana, A site, mid, ramp) — you would be inventing it." +
  " Mention Elo only if Elo numbers are explicitly given, and write them as X Elo." +
  " The squad are close friends, so a player you name can be teased as well as praised." +
  " Keep it warm — the kind of jab a mate makes and everyone laughs at, including the target." +
  " Tease the moment, the bad luck or the one round, never the person, and never with contempt" +
  " or as a verdict on how good someone is." +
  " You may use Telegram HTML <b> or <i> on at most ONE short fragment in the whole message, and" +
  " never around a bare number — bolding every stat reads as a scoreboard, not a joke. No other tags." +
  UA_STYLE;

/* ------------------------------------------------------------------ *
 * Angle roulette. The old prompt listed every angle and asked the
 * model to "pick a fresh one" — an LLM then converges on the most
 * probable option every time (майстер-клас / faceit античіт).
 * Picking the angle in code guarantees uniform variety; a small
 * in-memory history avoids back-to-back repeats. State resets on
 * cold start, which is fine — stateless randomness alone already
 * kills ~90% of the repetition. Persist to Supabase (one jsonb row)
 * only if you want strict rotation across restarts.
 *
 * A loss angle can name the stat it is built around (`needs`) and
 * turn the joke on us rather than the opposition (`self`).
 * ------------------------------------------------------------------ */
type Angle = string | { text: string; needs?: readonly FactId[]; self?: true };

const angleText = (a: Angle): string => (typeof a === "string" ? a : a.text);
const angleNeeds = (a: Angle): readonly FactId[] => (typeof a === "string" ? [] : a.needs ?? []);
const angleIsSelf = (a: Angle): boolean => typeof a !== "string" && a.self === true;

// Annotated `string[]`, not inferred: `needs` and `self` are read only on the loss
// branch, so an object here would be accepted and quietly ignored.
const HYPE_ANGLES: string[] = [
  "затверди єдиний тактичний план на вечір: rush B, не зупиняємось і не думаємо",
  "оформи збір як BREAKING-новину HLTV: склад укомплектовано, аналітики вже бояться",
  "подай звичайну вечірню катку з серйозністю гранд-фіналу мажора: тактичні паузи, джерсі, рукостискання",
  // «фраги», not «рейтинг»: that came back as «Elo», which the hype check bans outright.
  // An angle must not point at the one word its own message may not say.
  "оголоси, що п'ятеро незнайомців щойно підписали дарчу на свої фраги, просто ще про це не знають",
  "подай майбутніх суперників як мішені з aim botz, які навчилися ходити",
  "постав ціль вечора: грати так, щоб суперники тиждень крутили нашу demo на 0.25x і строчили репорти",
  "пообіцяй комусь із суперників фраг ножем — з поваги до економії патронів",
  "подай це як «одну катку», після якої всі як завжди розійдуться о четвертій ранку",
  "порівняй збір із комп'ютерним клубом нашого дитинства, тільки тепер адмін не вижене через годину",
  "оголоси свято: повний стак, нуль рандомів, кожен фейл сьогодні буде рідним",
  "оголоси, що в лоббі зібралися п'ятеро майбутніх легенд, чиї ніки HLTV поки що пише з помилками",
  "подай геніальний план капітана зі стрілочками і фейками, який все одно закінчиться рашем на B",
  "уяви себе коментатором, що зриває голос перед стартовим свистком",
  "оголоси штормове попередження: насувається наш сквад",
  "оголоси відкриття сезону полювання",
];

const WIN_ANGLES: string[] = [
  "подай навіть найпотнішу перемогу в овертаймі як ізі катку — з абсолютно серйозним обличчям",
  "подай перемогу як суху бухгалтерію: рейтинг зараховано, рахунок закрито, банк наш",
  "повідом, що суперники вже гуглять системні вимоги Valorant",
  "подай перемогу як фінал мажора: чисто, по-українськи, і десь у студії аналітик мовчки знімає окуляри",
  "подай це як економічну катастрофу суперників: їхній full buy програв нашим пістолетам",
  "оголоси максимальну неповагу: таких суперників треба було закривати з Zeus x27",
  "підсумуй ворожий перформанс самотнім знаком питання в all-chat",
  "подай суперників як п'ять decoy-гранат: стоять, шумлять, фрагів не приносять",
  "оформи ворожі промахи як офіційний звіт: постріли 1-5 — явно повз, 6-9 — віддача",
  "пожартуй, що в суперників сьогодні срібла більше, ніж у бабусиній шухляді з ложками",
  "подай найкращий момент вечора як ноускоуп, гідний власного графіті на мапі і восьми повторів поспіль",
  "подай перемогу як пограбування: зайшли тихіше за ninja defuse, винесли раунди, зникли",
  "подай ворожі репорти і -rep у профілях як головний трофей: настільки чисто, що нам не вірять",
  "подай криву некрасиву перемогу формулою NaVi-фольклору: красиво не вийшло, зате не злив",
  "потролль суперників, у яких не було жодного шансу",
];
const WIN_ANGLE_CLOSE = "відсвяткуй трилер, який довів чат до інфаркту: десь один клан знову заплакав, як після програного фіналу мажора";
const WIN_ANGLE_STOMP = "оголоси суху беззаперечну домінацію: суперникам залишалось хіба фармити exit-фраги";

const LOSS_ANGLES: Angle[] = [
  "звинувать netcode CS2: ми стріляли перші, але сабтік порадився з пінгом і вирішив інакше",
  { text: "побажай суперникам гарних VACацій — до ранкової бан-хвилі їхній свіжий рейтинг не доживе", needs: ["hs", "kd"] },
  { text: "звинувать смурфів: акаунту три дні, а рухи як у людини з десятьма тисячами годин — талановита молодь, нічого не скажеш", needs: ["kd", "hs", "kills"] },
  "зачитай бінго відмазок одним списком: лаги, нова мишка, fps просів, сонце світило в монітор",
  "звинувать меблі: суперники не кращі, просто їхні крісла геймерськіші за наші",
  "подай поразку як грамотний save: зброю зберегли, гідність зберегли, рейтинг — не встигли",
  { text: "знецінь ворожого топ-фрагера: половина його фрагів — exit-фраги проти наших пістолетів", needs: ["kills", "adr"] },
  "натякни, що їхній тренер знову літав над мапою — coach bug наче ж пофіксили",
  "подай закриті Steam-профілі й аніме-аватарки суперників як неспростовний доказ — суду все зрозуміло",
  "звинувать алгоритм faceit: він вирішив, що ми забагато перемагали — планове балансування",
  "звинувать one-way смоки і піксельні кути: Женевська конвенція проти, Valve — ні",
  "звинувать роутер і сервер десь у Гренландії: наші кулі досі летять поштою",
  "подай поразку як недорозминку: матч закінчився раніше, ніж ми встигли розігрітись",
  "подай це як маскування рівня tier-1: справжні страти бережемо на мажор",
  "назви переможців типовими онлайнерами і пообіцяй розправу на LAN, якого ніколи не буде",
  { text: "поскаржся на підозріло ідеальний аім суперників: спінбот, вх, нереальний відсоток хедшотів", needs: ["hs"] },
  { text: "звинувать їхнього AWPера, який тримав один кут увесь матч і вважає це грою", needs: ["awp"] },
  { text: "звинувать їхню утиліту: нас засліпили стільки разів, що ми грали на слух", needs: ["flashes", "util"] },
  // Angles with a register of their own, not one more thing to blame: a form to fill in,
  // a verdict to read out, a funeral to hold. A flat premise gives nowhere to escalate.
  "оголоси хвилину мовчання за нашим рейтингом: вінок, свічка і сльоза по клавіатурі",
  "зачитай офіційну заяву прес-служби: обставини склалися, склад не винен, розслідування триває",
  "винеси вирок серверу: винен за всіма пунктами, апеляція відхилена, тікрейт конфісковано",
  "оформи поразку як страховий випадок: заповнюємо форму, чекаємо виплату за моральну шкоду",
  "зачитай патчноут CS2: наш приціл визнано не багом, а фічею, фікс — колись у наступному оновленні",
  "подай це як фінал драматичного серіалу: всі ридали, продовження — наступна катка",
  "оголоси день жалоби в чаті: аватарки з чорною стрічкою до наступної перемоги",
  "склади заповіт: рейтинг лишаємо суперникам, гідність ділимо між собою",
  // Self-roast: a bot that can never take an L is one note. Collective «ми» only — the
  // roster isn't sent on a loss, so nobody can be singled out even under this angle.
  { text: "визнай, що ми зіграли як п'ятеро незнайомців, які вперше побачили одне одного в лоббі", self: true },
  { text: "зізнайся, що наш мікрофон працював краще за наш аім: говорили ми значно більше, ніж стріляли", self: true },
  { text: "визнай, що весь наш тактичний план був «якось воно буде» — і воно якось таки було", self: true },
  { text: "оголоси, що ми колективно подарували суперникам рейтинг і навіть квитанцію не попросили", self: true },
  { text: "подай наш склад як навчальний матеріал для дітей: дивіться уважно і ніколи так не робіть", self: true },
  { text: "визнай, що ми грали так, наче вперше бачимо цю мапу, одне одного і саму гру", self: true },
];
const LOSS_ANGLE_CLOSE = "поскаржся, що до перемоги забракло одного раунду — і саме в ньому сервер вирішив подумати";
const LOSS_ANGLE_STOMP = "оголоси, що цю катку ми віддали як благодійність — сили бережемо на наступну";

// Per-kind so one register can be loosened alone; 25 across the board left a loss all setup
// and no punchline. Only the model enforces it — the hard bound is `max_tokens` in ai.ts.
const MAX_WORDS: Record<Kind, number> = { hype: 35, win: 35, loss: 35 };

const recentAngles: Record<Kind, string[]> = { hype: [], win: [], loss: [] };

// One roll, one policy, used by both roulettes here: prefer what hasn't been out lately,
// fall back to the full pool once everything is stale, remember what went.
function rollFresh<T>(pool: T[], recent: string[], key: (item: T) => string, keep: number): T | undefined {
  const fresh = pool.filter(item => !recent.includes(key(item)));
  const src = fresh.length ? fresh : pool;
  const picked = src[Math.floor(Math.random() * src.length)];
  return picked === undefined ? undefined : noteUsed(picked, recent, key(picked), keep);
}

// Everything handed out is recorded, however it was chosen — a pick that skips this is
// invisible to the next roll, and a stat named by an angle is the likeliest to repeat.
function noteUsed<T>(picked: T, recent: string[], key: string, keep: number): T {
  recent.push(key);
  while (recent.length > keep) recent.shift();
  return picked;
}

// A pool is never empty here: every caller appends a close/stomp angle to it.
const pickAngle = <T extends Angle>(kind: Kind, pool: T[]): T =>
  rollFresh(pool, recentAngles[kind], angleText, Math.min(3, pool.length - 1))!;

/* ------------------------------------------------------------------ *
 * What the second attempt is told. A blind re-roll repeated the same
 * mistake whenever the angle invited it, so this names the broken rule
 * — as a correction, not as the rule restated.
 * ------------------------------------------------------------------ */

// A Record so a new RejectReason fails typecheck instead of shipping a silent retry.
const RETRY_FIX: Record<RejectReason, string> = {
  // Only the final score: a comeback hook supplies the half-time one on purpose.
  scoreline:
    "you wrote a scoreline you were not given. The final score must never appear in any form —" +
    " say it in words or leave it out. The only score you may write is one this prompt handed you.",
  elo: "you mentioned Elo. Do not write the word Elo, and do not give any rating figure — say «рейтинг» or nothing.",
  "unsourced-stat":
    "you used a number that was never given to you. Quote only the figures written above, attached to whoever" +
    " they belong to, or write no numbers at all.",
  // Never "use only the codes above": hype lists none, and implying otherwise is the bug.
  "unknown-code":
    "you used a player code that was never given to you. Write only a code this prompt listed;" +
    " if it listed none, name nobody at all.",
  callout:
    "you named a position on the map. You are never told where anything happened, so any callout —" +
    " banana, mid, ramp, a bombsite — is invented. Say what happened without saying where.",
  language: "it was not in Ukrainian. Write every word of the message in natural spoken Ukrainian.",
  empty: "it came back empty. Answer with the message text itself and nothing else.",
};

// Returns the whole second ask, so this module stays the only place that composes what the
// model reads — where the correction goes is a prompt decision, not the adapter's.
export const retryAsk = (prompt: string, reason: RejectReason): string =>
  `${prompt} Your previous attempt was rejected because ${RETRY_FIX[reason]}` +
  ` Write a different message that avoids this.`;

/* ------------------------------------------------------------------ *
 * Recent-phrase memory: the last 3 sent messages per kind are fed
 * back as "write something clearly different". In-memory, same
 * cold-start caveat as above.
 * ------------------------------------------------------------------ */

const recentPhrases: Record<Kind, string[]> = { hype: [], win: [], loss: [] };

export function remember(kind: Kind, text: string): void {
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
 * Players. Instructions alone don't stop the model transliterating a
 * Latin nickname into Cyrillic, so it only ever sees codes P1/P2/...
 * and the real nicknames are swapped back in afterwards. That also
 * keeps punctuation-heavy nicknames away from the markdown stripper,
 * and lets us fall back cleanly if a code we never issued shows up.
 *
 * Who gets mentioned is the model's call: every player with stats is
 * sent with everything they did, and there is deliberately no ADR floor
 * or per-stat threshold deciding it first — that silenced a whole
 * roster. Zeros are dropped so "0 knife kills" can't be quoted as if it
 * happened. See **Match phrases** in CLAUDE.md.
 * ------------------------------------------------------------------ */

const has = (n: number): boolean => Number.isFinite(n) && n > 0;

// Number-first ("1 ace", "3 aces"), so every fact has one shape to copy verbatim.
const plural = (n: number, one: string, more = `${one}s`): string => `${n} ${n === 1 ? one : more}`;
const count = (n: number, one: string, more = `${one}s`): string | null =>
  has(n) ? plural(n, one, more) : null;
// A duel stat means nothing without its denominator: "2/4 entry duels won". Both
// halves are checked — a Count key without its Wins key would otherwise interpolate
// a literal NaN, and the prompt tells the model to copy numbers exactly.
const duels = (won: number, total: number, label: string): string | null =>
  has(total) && Number.isFinite(won) ? `${won}/${total} ${label} won` : null;

// No stat label here may be one UA_STYLE bans: it gets pasted through untranslated, as
// "utility damage" did — «367 утиліті-шкоди».
const FACTS: ((p: MatchPlayer) => string | null)[] = [
  p => ([p.kills, p.deaths, p.assists].every(Number.isFinite) ? `${p.kills}/${p.deaths}/${p.assists} K/D/A` : null),
  p => (Number.isFinite(p.kd) ? `${p.kd} K/D` : null),
  p => (Number.isFinite(p.adr) ? `${p.adr} ADR` : null),
  p => (Number.isFinite(p.damage) ? `${p.damage} damage dealt` : null),
  p => (Number.isFinite(p.hs) ? `${p.hs}% HS` : null),
  p => count(p.aces, "ace"),
  p => count(p.quadros, "quad-kill"),
  p => count(p.triples, "triple kill"),
  p => count(p.doubles, "double kill"),
  p => duels(p.clutches, p.clutchCount, "1v2 clutches"),
  p => duels(p.onevoneWins, p.onevoneCount, "1v1 clutches"),
  p => count(p.clutchKills, "kill with the team already dead", "kills with the team already dead"),
  p => count(p.firstKills, "round opened with the first kill", "rounds opened with the first kill"),
  p => duels(p.entries, p.entryCount, "entry duels"),
  p => count(p.awp, "AWP kill"),
  p => count(p.pistol, "pistol kill"),
  p => count(p.knife, "knife kill"),
  p => count(p.zeus, "Zeus kill"),
  p => (has(p.util) ? `${p.util} damage with grenades` : null),
  p => count(p.utilEnemies, "enemy damaged by utility", "enemies damaged by utility"),
  p => count(p.utilCount, "grenade used", "grenades used"),
  p => count(p.flashes, "enemy flashed", "enemies flashed"),
  // "flash assist" is the term players use; the literal "flash that led to a kill"
  // came back translated word-for-word and clumsy, and crowded out other facts.
  p => count(p.flashSuccesses, "flash assist"),
  p => count(p.flashCount, "flash used", "flashes used"),
  p => count(p.mvps, "MVP"),
];

const playerFacts = (p: MatchPlayer): string => FACTS.map(f => f(p)).filter(Boolean).join(", ");

const noPlayers = (line: string): PlayerBlock => ({ line, players: [] });

// A loss never names our own, so it takes the same shape as the two refusals below. `self`
// changes only *why* — the wrong reason made a self-roast drift back to deflection.
function buildPlayerBlock(players: MatchPlayer[] | undefined, won: boolean, self: boolean): PlayerBlock {
  if (!won) {
    return noPlayers(
      self
        ? "Do not name any individual player or quote anyone's stats — the joke is about all of us together as «ми», never about one of us."
        : "Do not mention our own players, their names or their stats at all — the joke is about the opponents."
    );
  }
  // No ADR means no stats at all — about having data, not deserving a mention. Shuffled
  // because "order means nothing" only half-worked: it still leaned on whoever came first.
  const roster = (players ?? [])
    .filter(p => Number.isFinite(p.adr))
    .map(p => ({ p, k: Math.random() }))
    .sort((a, b) => a.k - b.k)
    .map(({ p }) => p);
  // sometimes skip players entirely for variety
  if (!roster.length || Math.random() < 0.2) {
    return noPlayers("Do not mention any player names or stats.");
  }

  const named: PromptPlayer[] = roster.map(p => ({ nickname: p.nickname, facts: playerFacts(p) }));
  // The only place a dig is invited, and rolled rather than left to the model: allowed always
  // it fixated on the lowest ADR, banned it stopped teasing. See **Match phrases** in CLAUDE.md.
  const tease = Math.random() < 0.35
    ? ` One of them had a quieter game — a warm aside about it is welcome, the kind that still credits` +
      ` them for something. Never the register of "he was carried", "he's a bot" or "that was a boost",` +
      ` and if the recent messages below already teased someone, pick someone else.`
    : ` Credit whoever you name and leave anyone's weak line alone this time.`;
  // One player per line. Run together on a single line, the model pulled a number
  // off a neighbouring player and credited it to the one it was talking about.
  const list = named.map((p, i) => `\nP${i + 1}: ${p.facts}`).join("");
  return {
    line:
      `OUR OWN squad, one player per line, and everything they did this match:${list}\n` +
      `These codes are our teammates, never the opposition.` +
      ` Listed in no particular order. Who to highlight is entirely your call — pick whoever gives` +
      ` the funniest angle, name one or two of them or none at all, and don't assume the biggest` +
      ` number is the best joke: a knife kill, one Zeus or a single point of grenade damage often` +
      ` beats the top fragger.${tease}` +
      ` Every number you quote must come from the line of the player you name — never borrow one` +
      ` from another line, and quote codes and numbers exactly as given.`,
    players: named,
  };
}

/* ------------------------------------------------------------------ *
 * The opposing team: their numbers, never their names — without real
 * figures the model invented them.
 *
 * One stat ships per message, so *which* one is rolled here over
 * everything their team did. The same three every time made every
 * loss the same recital.
 * ------------------------------------------------------------------ */

// What a builder produces. The id comes from the key it is filed under below, so a
// stat's rotation key can't drift from its name.
interface Fact {
  text: string;
  numbers: number[];
}

// Keyed by the stat, not its value, so the history dedupes across matches.
type OppFact = Fact & { id: FactId };

type OppPlayer = Opponents[number];

// Every fact is about an anonymous "one of them" — the team's best HS% is usually not the top
// fragger, and with no named subject there is nothing to mis-attribute.
function topBy(team: Opponents, of: (p: OppPlayer) => number): OppPlayer | null {
  let top: OppPlayer | null = null;
  let best = 0;
  for (const p of team) {
    const v = of(p);
    if (!has(v) || (top && v <= best)) continue;
    top = p;
    best = v;
  }
  return top;
}

// A team high, phrased from the value alone.
function peak(team: Opponents, of: (p: OppPlayer) => number, say: (n: number) => string): Fact | null {
  const p = topBy(team, of);
  if (!p) return null;
  const v = of(p);
  return { text: say(v), numbers: [v] };
}

// Both halves off the same player: a denominator from someone else is a number we never saw.
// Ranked by wins, not attempts — «виграв аж нуль із одного клатчів» is not a stat.
function peakDuel(
  team: Opponents,
  won: (p: OppPlayer) => number,
  total: (p: OppPlayer) => number,
  say: (w: number, t: number) => string
): Fact | null {
  // Filtered before the pick: ranking first let one player at 1-of-1 hide the team's duel fact.
  // `isFinite` catches a Wins key with no Count key, which shipped «3 of NaN entry duels».
  const contested = team.filter(x => Number.isFinite(total(x)) && total(x) >= 2);
  const p = topBy(contested, won);
  if (!p) return null;
  return { text: say(won(p), total(p)), numbers: [won(p), total(p)] };
}

const OPPONENT_FACTS = {
  kills: (t: Opponents) => peak(t, p => p.kills, n => `Their top fragger got ${n} kills.`),
  adr: (t: Opponents) => peak(t, p => p.adr, n => `One of them put up ${n} ADR, the highest on their side.`),
  hs: (t: Opponents) => peak(t, p => p.hs, n => `One of them hit ${n}% HS, the highest on their side.`),
  kd: (t: Opponents) => peak(t, p => p.kd, n => `One of them finished the match on ${n} K/D.`),
  damage: (t: Opponents) => peak(t, p => p.damage, n => `One of them dealt ${n} damage across the match.`),
  // Same reason: «5 AWP kills» shipped verbatim. The other weapon facts stay labels only
  // because Ukrainian has the slang («тріпл-кіл», «ейс», «ножем»); this one doesn't.
  awp: (t: Opponents) => peak(t, p => p.awp, n => `One of them killed ${n} of us with the AWP.`),
  // An action, not a label: "opening kills" got pasted in untranslated and "drew first
  // blood" came back as «2 фірстблади». "separate" stops «три раунди поспіль».
  opening: (t: Opponents) => peak(t, p => p.firstKills, n => `One of them opened ${plural(n, "separate round")} with the first kill.`),
  // Never the word "clutch": it kept coming back as «вісьмома клатчами», which claims
  // eight rounds won rather than eight kills. Spelled out, there is nothing to compress.
  clutchKills: (t: Opponents) =>
    peak(t, p => p.clutchKills, n => `One of them killed ${n} of us after his own team was already dead.`),
  ace: (t: Opponents) => peak(t, p => p.aces, n => `One of them hit ${plural(n, "ace")}.`),
  quad: (t: Opponents) => peak(t, p => p.quadros, n => `One of them hit ${plural(n, "quad-kill")}.`),
  triple: (t: Opponents) => peak(t, p => p.triples, n => `One of them hit ${plural(n, "triple kill")}.`),
  // "pistol kills" came back as «пістолетних вбивств за раунд» — a unit it never had.
  pistol: (t: Opponents) => peak(t, p => p.pistol, n => `One of them killed ${n} of us with a pistol across the whole match.`),
  knife: (t: Opponents) => peak(t, p => p.knife, n => `One of them got ${plural(n, "knife kill")} on us.`),
  zeus: (t: Opponents) => peak(t, p => p.zeus, n => `One of them got ${plural(n, "Zeus kill")} on us.`),
  mvp: (t: Opponents) => peak(t, p => p.mvps, n => `One of them took ${plural(n, "MVP")}.`),
  // "utility damage" is a label too, and it came back as «156 утиліті-шкоди» — the calque
  // UA_STYLE bans. Said as an action, the model reaches for «гранатами» instead.
  util: (t: Opponents) => peak(t, p => p.util, n => `One of them did ${n} damage with grenades alone.`),
  flashes: (t: Opponents) => peak(t, p => p.flashes, n => `One of them blinded us ${plural(n, "time")}.`),
  // No flash-assist fact: three wordings in, it still collapsed into «засліпили N разів»
  // — the enemies-blinded fact above, with the wrong number attached.
  clutch: (t: Opponents) => peakDuel(t, p => p.clutches, p => p.clutchCount, (w, c) => `One of them won ${w} of ${c} 1v2 clutches.`),
  onevone: (t: Opponents) => peakDuel(t, p => p.onevoneWins, p => p.onevoneCount, (w, c) => `One of them won ${w} of ${c} 1v1 clutches.`),
  entry: (t: Opponents) => peakDuel(t, p => p.entries, p => p.entryCount, (w, c) => `One of them won ${w} of ${c} entry duels.`),
  // `satisfies`, so `FactId` is exactly the ids that exist and an angle can't name one that
  // doesn't — a typo dropped that angle from the pool forever, silently. As with `LABELS`.
} satisfies Record<string, (t: Opponents) => Fact | null>;

type FactId = keyof typeof OPPONENT_FACTS;

const oppFacts = (team: Opponents): OppFact[] =>
  Object.entries(OPPONENT_FACTS).flatMap(([id, build]) => {
    const fact = build(team);
    return fact ? [{ id: id as FactId, ...fact }] : [];
  });

// Same cold-start caveat as the angle history: a few ids back, so ADR can't repeat.
const recentFacts: FactId[] = [];

// An angle built around one stat gets it; anything else is rolled. Either way it's recorded.
const pickFact = (pool: OppFact[], needs: readonly FactId[]): OppFact | undefined => {
  const wanted = needs.map(id => pool.find(f => f.id === id)).find(Boolean);
  return wanted
    ? noteUsed(wanted, recentFacts, wanted.id, 4)
    : rollFresh(pool, recentFacts, f => f.id, 4);
};

// Whose numbers these are is spelled out: the model has credited them to us before.
function opponentsLine(pool: OppFact[], subject: Subject, needs: readonly FactId[]): { line: string; numbers: number[] } {
  // Exactly one, win or loss: two got merged into one imaginary opponent — «їхній гравець з
  // 4 MVP і 13 флешкових асистів» was two players.
  const fact = pickFact(pool, needs);
  if (!fact) return { line: "", numbers: [] };
  // The subject decides what their number is *for*: contrast on a self-roast, punchline
  // otherwise. Both at once is the split register that drifts back to deflection.
  const use = {
    us: "Use their number only if the angle needs it, exactly as given — the win is still about us.",
    them: "That is the only opponent stat you have — use it as the punchline if the angle needs it, exactly as given, and never reach for a number you were not given. The excuse carries the joke.",
    squad: "Their one number is there for contrast only, exactly as given if you use it at all — they are not the joke and not to blame, we are.",
  }[subject];
  // Exactly what this line interpolated, so the safe-list can't drift from it.
  return {
    line:
      ` From the OPPOSING team: ${fact.text} ${use}` +
      ` These are their numbers, not ours — never attribute them to us or to a player code.` +
      ` Never name anyone on their team and never invent a name for them.`,
    numbers: fact.numbers,
  };
}

function mapLine(map: string | null | undefined): string {
  if (!map) return "Do not mention any map.";
  return Math.random() < 0.55
    ? `The map was ${map} — mention it only if it fits the angle naturally, keeping the name exactly as written.`
    : "Do not mention the map name in this message.";
}

// One parser for "13:9", used both for how close the match was and for which numbers
// the phrase may legitimately carry.
const scoreNumbers = (score: string): string[] => score.match(/\d+/g) ?? [];

function scoreDiff(score: string): number | null {
  const [ours, theirs] = scoreNumbers(score);
  return ours && theirs ? Math.abs(Number(ours) - Number(theirs)) : null;
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

/* ------------------------------------------------------------------ *
 * The closing register — a named segment like mapLine and
 * opponentsLine, not nested ternaries in the template. Melodrama is
 * fixed on a loss; the angle decides only who wears it.
 * ------------------------------------------------------------------ */

type Subject = "us" | "them" | "squad";

// A self-roast asks for a confession, not an excuse: «визнай, що ми грали як п'ятеро
// незнайомців» is an admission, and the two words pull in opposite directions.
const MESSAGE_KIND: Record<Subject, string> = {
  us: "short funny celebratory",
  them: "funny, theatrically over-dramatic excuse",
  squad: "funny, theatrically over-dramatic confession",
};

function closingInstruction(subject: Subject): string {
  if (subject === "us") {
    return (
      " Never mention losing, and the win stays the point." +
      " Build to the punchline instead of opening with it." +
      // Rolled for the same reason the angle is: asked to choose, the model takes the loudest.
      // "Triumphant" belongs to this half only — standing, it cancelled the deadpan roll.
      (Math.random() < 0.5
        ? " Deliver it deadpan — barely impressed, as if this were a routine evening and you hardly looked up." +
          " The humour is in how little you are celebrating, so no exclamations and no gloating."
        : " Loud, triumphant and shameless — milk it, gloat, treat one ranked match as a career-defining triumph.")
    );
  }
  return (
    " Play it completely straight and utterly devastated, as if a routine match were the end of an era — the" +
    " humour is in how seriously you take it. Build to the punchline instead of opening with it, and go one" +
    " step further than the angle strictly needs." +
    // "Go one step further" found «сервер засуджений за зраду Батьківщині». Banned is the
    // *reference*, not the funeral register — several angles hold a wake for our own rating.
    " Everything mourned, buried or put on trial must be part of the match itself — our rating, the server," +
    " our aim. Never reach for a real war, real politics or a real person's death as the comparison." +
    (subject === "squad"
      // Collective only: a name on a loss is blame, and the round we threw is a fact we
      // never had. Neither is catchable by a check, so both are spelled out.
      ? " This one is on us: mock the whole squad as «ми», the way friends who all played badly laugh at" +
        " themselves together. Never single anyone out, never invent a specific round, call or play, and never" +
        " suggest anyone is actually bad at the game — we are ridiculous tonight, not untalented."
      : " Never blame our own team: the villain is fate, the hardware, Valve, the server or the opposition.")
  );
}

/* ------------------------------------------------------------------ *
 * Hype's register and its one fact. Handed no stats, it read flat
 * beside the match phrases — every message the angle in a new hat.
 * ------------------------------------------------------------------ */

const HYPE_REGISTERS = [
  " Deliver it as a flat tactical briefing — clipped and procedural, like an operations order read aloud.",
  " Deliver it as a commentator losing his voice before the whistle — breathless, escalating, one long build.",
  " Deliver it quietly ominous, like someone who already knows exactly how the evening ends.",
];

const recentRegisters: string[] = [];

// Bucketed into words, never a number: a hype message has an empty safe-list, so «за 20
// хвилин» would be an unsourced stat.
function startsInLine(minutes: number | null | undefined): string {
  if (minutes == null) return "";
  if (minutes <= 5) return " It starts right now — people are loading in as you write.";
  if (minutes <= 30) return " It starts within the half hour.";
  if (minutes <= 90) return " It starts within the hour.";
  if (minutes <= 300) return " It is still a few hours off.";
  // No "tonight": a time already past today is rolled to tomorrow, so this bucket can be a day out.
  return " It is a long way off yet.";
}

/* ------------------------------------------------------------------ */

// Nothing to check against: no players named, no stats quoted, Elo unrestricted.
export function hypePrompt(eventName: string | null, { startsIn, squadFull }: HypeContext = {}): PhraseRequest {
  const angle = pickAngle("hype", HYPE_ANGLES);
  return {
    prompt:
      `A squad just filled up ${eventName ? `for an event called "${eventName}"` : "for a CS2 session"}.` +
      ` Write ONE funny, energetic hype message to fire them up.` +
      ` Angle — commit to it fully: ${angle}.` +
      startsInLine(startsIn) +
      (startsIn == null
        ? ""
        // Invited without this, it converted the bucket into figures it was never given —
        // «за сорок хвилин» for forty-five, and «опів на дванадцяту» out of nothing at all.
        : " Lean on that timing if it gives you a joke, but only in words — never a number of" +
          " minutes and never a clock time, both of which are already shown above your message.") +
      (squadFull ? " All five are in and the squad is locked — this is the last word before the match, not a recruitment call." : "") +
      rollFresh(HYPE_REGISTERS, recentRegisters, r => r, 1) +
      ` Build to the punchline instead of opening with it.` +
      // No roster is sent, so a P-code here is always invented — caught, but only after a
      // wasted call and a retry.
      ` Nobody is named in this message: never write a player code like P1 and never invent a nickname.` +
      ` Max ${MAX_WORDS.hype} words. Do not repeat the event name or start time — they are already shown above your message.` +
      recentBlock("hype"),
    // No numbers are handed over, so every check is on — there is nothing to quote from.
    checks: {
      allowElo: false,
      // Nothing is played yet, so «rush B» names a plan, not a place.
      allowCallouts: true,
      players: [],
      safeNumbers: new Set(),
      allowedScorelines: null,
      map: null,
    },
  };
}

export function matchPrompt(
  won: boolean,
  score: string,
  { map, elo, players, matchFlow, opponents }: MatchPhraseContext = {}
): PhraseRequest {
  const kind: Kind = won ? "win" : "loss";
  // The only case allowed to quote Elo, which is what `allowElo` gates.
  const upset = !!elo && (won
    ? Number(elo.theirs) - Number(elo.ours) >= 75
    : Number(elo.ours) - Number(elo.theirs) >= 75);
  const diff = scoreDiff(score);
  const close = diff !== null && diff <= 3;
  const flow = flowNote(won, matchFlow);

  // No map here — it reaches the model only through mapLine(). Naming it in both
  // places contradicted mapLine's own "do not mention the map" branch, and the
  // name leaked into messages that had banned it.
  const context = [
    score,
    !upset ? null : won
      ? `(upset: our ${elo!.ours} Elo beat their ${elo!.theirs} Elo)`
      : `(lost to a lower-rated team: our ${elo!.ours} Elo vs their ${elo!.theirs} Elo)`,
  ].filter(Boolean).join(" ");

  // Facts first: an angle built on a stat is only worth picking if their team produced it —
  // "blame their AWPer" with no AWP kill is an excuse about something that never happened.
  const pool = oppFacts(opponents ?? []);
  const ids = new Set(pool.map(f => f.id));
  const grounded = (a: Angle): boolean => {
    const wants = angleNeeds(a);
    return !wants.length || wants.some(id => ids.has(id));
  };
  const angle: Angle = won
    ? pickAngle("win", [...WIN_ANGLES, close ? WIN_ANGLE_CLOSE : WIN_ANGLE_STOMP])
    : pickAngle("loss", [...LOSS_ANGLES.filter(grounded), close ? LOSS_ANGLE_CLOSE : LOSS_ANGLE_STOMP]);
  // A win highlights us, a loss highlights them, so a loss sends no roster. Resolved once: two
  // reads of one flag are how a prompt said both "about the opponents" and "on us".
  const subject: Subject = won ? "us" : angleIsSelf(angle) ? "squad" : "them";
  const { line: playerLine, players: named } = buildPlayerBlock(players, won, subject === "squad");
  const theirs = opponentsLine(pool, subject, angleNeeds(angle));
  const prompt =
    `The squad just ${won ? "WON" : "LOST"} ${context}.` +
    ` Write ONE ${MESSAGE_KIND[subject]} message.` +
    ` Angle — commit to it fully: ${angleText(angle)}.` +
    ` ${playerLine}` +
    theirs.line +
    ` ${mapLine(map)}` +
    (upset ? won
      ? " Our team was rated lower and still won — make that part of the joke."
      : " They were rated lower than us — squeeze maximum drama out of that." : "") +
    (flow ? ` Extra angle you can lean into: ${flow}.` : "") +
    // The scoreboard sits above, so restating the score spends the budget twice; quoting the
    // banned string outright is what made it stick. `elo &&` because FACEIT often omits ratings.
    ` The scoreboard above your message already shows the score${elo && !upset ? " and both teams' Elo" : ""} — read it for tone, but never write "${score}" or any form of it in your message, and never close with a score-and-map summary.` +
    ` Max ${MAX_WORDS[kind]} words.` +
    closingInstruction(subject) +
    recentBlock(kind);
  return {
    prompt,
    checks: {
      allowElo: upset,
      allowCallouts: false,
      players: named,
      // Legitimate even though they also appear in players' lines — not borrowed.
      safeNumbers: new Set([
        ...scoreNumbers(score),
        ...(elo ? [String(elo.ours), String(elo.theirs)] : []),
        ...theirs.numbers.map(String),
      ]),
      // Only the half-time score a comeback hook supplied; the final score is banned
      // in the prompt above and everything else would be invented.
      allowedScorelines: flow?.match(/\d+\s*:\s*\d+/g) ?? [],
      map: map ?? null,
    },
  };
}
