// Everything said *to* the model: the system prompt, the angle roulette, and the
// match facts turned into prompt text. Pure — it builds strings and returns the
// checks the reply will be judged against, but never calls anything.
//
// Split from adapters/ai.ts because it changes for entirely different reasons:
// jokes, tone and what counts as an interesting stat, rather than how the API is
// spoken to. See **The AI call** and **Match phrases** in CLAUDE.md.

import { LANG } from "./i18n.ts";
import type {
  Kind,
  MatchFlow,
  MatchPhraseContext,
  MatchPlayer,
  Opponents,
  PhraseRequest,
  PlayerBlock,
  PromptPlayer,
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
  " your own words in the language you are writing, and never paste the English wording into the" +
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
  "оголоси, що п'ятеро незнайомців щойно підписали дарчу на свій рейтинг, просто ще про це не знають",
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
  "подай перемогу як суху бухгалтерію: рейтинг зараховано, рахунок закрито, банк наш",
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
  "побажай суперникам гарних VACацій — до ранкової бан-хвилі їхній свіжий рейтинг не доживе",
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
const LOSS_ANGLE_CLOSE = "поскаржся, що до перемоги забракло одного раунду — і саме в ньому сервер вирішив подумати";
const LOSS_ANGLE_STOMP = "оголоси, що цю катку ми віддали як благодійність — сили бережемо на наступну";

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
const count = (n: number, one: string, more = `${one}s`): string | null =>
  has(n) ? `${n} ${n === 1 ? one : more}` : null;
// A duel stat means nothing without its denominator: "2/4 entry duels won". Both
// halves are checked — a Count key without its Wins key would otherwise interpolate
// a literal NaN, and the prompt tells the model to copy numbers exactly.
const duels = (won: number, total: number, label: string): string | null =>
  has(total) && Number.isFinite(won) ? `${won}/${total} ${label} won` : null;

const FACTS: ((p: MatchPlayer) => string | null)[] = [
  p => ([p.kills, p.deaths, p.assists].every(Number.isFinite) ? `${p.kills}/${p.deaths}/${p.assists} K/D/A` : null),
  p => (Number.isFinite(p.kd) ? `${p.kd} K/D` : null),
  p => (Number.isFinite(p.adr) ? `${p.adr} ADR` : null),
  p => (Number.isFinite(p.damage) ? `${p.damage} total damage` : null),
  p => (Number.isFinite(p.hs) ? `${p.hs}% HS` : null),
  p => count(p.aces, "ace"),
  p => count(p.quadros, "quad-kill"),
  p => count(p.triples, "triple kill"),
  p => count(p.doubles, "double kill"),
  p => duels(p.clutches, p.clutchCount, "1v2 clutches"),
  p => duels(p.onevoneWins, p.onevoneCount, "1v1 clutches"),
  p => count(p.clutchKills, "clutch kill"),
  p => count(p.firstKills, "opening kill"),
  p => duels(p.entries, p.entryCount, "entry duels"),
  p => count(p.awp, "AWP kill"),
  p => count(p.pistol, "pistol kill"),
  p => count(p.knife, "knife kill"),
  p => count(p.zeus, "Zeus kill"),
  p => (has(p.util) ? `${p.util} utility damage` : null),
  p => count(p.utilEnemies, "enemy damaged by utility", "enemies damaged by utility"),
  p => count(p.utilCount, "grenade thrown", "grenades thrown"),
  p => count(p.flashes, "enemy flashed", "enemies flashed"),
  // "flash assist" is the term players use; the literal "flash that led to a kill"
  // came back translated word-for-word and clumsy, and crowded out other facts.
  p => count(p.flashSuccesses, "flash assist"),
  p => count(p.flashCount, "flash thrown", "flashes thrown"),
  p => count(p.mvps, "MVP"),
];

const playerFacts = (p: MatchPlayer): string => FACTS.map(f => f(p)).filter(Boolean).join(", ");

const noPlayers = (line: string): PlayerBlock => ({ line, players: [] });

// A loss never names our own, so it takes the same shape as the two refusals below
// rather than a parallel branch at the call site.
function buildPlayerBlock(players: MatchPlayer[] | undefined, won: boolean): PlayerBlock {
  if (!won) {
    return noPlayers("Do not mention our own players, their names or their stats at all — the joke is about the opponents.");
  }
  // No ADR means no stats came back at all — the one exclusion left, and it's about
  // having data rather than deserving a mention. Then shuffled, because telling the
  // model the order means nothing only half-worked: it still leaned on whoever came
  // first, which is the removed bar sneaking back in as anchoring.
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
  // Whether a dig at one of our own is invited is decided here, not left to the model
  // — the same reason the angle is. Allowed always it fixated on the lowest ADR;
  // banned it stopped teasing at all. See **Match phrases** in CLAUDE.md.
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
      ` number is the best joke: a knife kill, one Zeus or a single point of utility damage often` +
      ` beats the top fragger.${tease}` +
      ` Every number you quote must come from the line of the player you name — never borrow one` +
      ` from another line, and quote codes and numbers exactly as given.`,
    players: named,
  };
}

// Their numbers, never their names. On a loss they are the subject, so this carries
// what the suspicious-aim, smurf and exit-frag angles need — without it the model
// invented a figure or stayed vague. Anonymous keeps people outside the group
// unidentified, and skips the P-code machinery that exists for nicknames we print.
//
// Whose numbers these are is spelled out because the model has credited them to us
// and has dropped one of our own into a joke about "their five".
function opponentsLine(o: Opponents | null | undefined, won: boolean): { line: string; numbers: number[] } {
  if (!o || !Number.isFinite(o.topKills)) return { line: "", numbers: [] };
  // `bestHs` is the highest anyone on their team hit, which is often a *different*
  // player from the top fragger — so it gets its own clause. Listing it inside the
  // fragger's line asserted one player had all three, which is simply false, and the
  // prompt then tells the model to quote numbers exactly. Keeping the two clauses
  // separate is safe now only because of the one-number cap below: sending both
  // percentages unlabelled is what made it recite «44% HS і 56% HS».
  const shown = [o.topKills, o.topAdr, o.bestHs].filter(Number.isFinite);
  const fragger = [`${o.topKills} kills`, Number.isFinite(o.topAdr) ? `${o.topAdr} ADR` : null]
    .filter(Boolean)
    .join(" and ");
  const teamHs = Number.isFinite(o.bestHs)
    ? ` Separately, the highest HS% anyone on their team managed was ${o.bestHs}% — that is a team high, not his.`
    : "";
  // One number, not all of them — a loss has only these three, so "build around their
  // numbers" made every message open with the same spreadsheet.
  const use = won
    ? "Use their numbers only if the angle needs them, exactly as given."
    : "They are the subject, but quote at most ONE of these numbers — whichever the angle needs, exactly as given. The excuse carries the joke; the stat is just the punchline.";
  // `numbers` is what this line actually interpolated, so the safe-list can't come to
  // whitelist a figure the model was never shown, or miss one it was.
  return {
    line:
      ` The OPPOSING team's best fragger managed ${fragger}.${teamHs} ${use}` +
      ` These are their numbers, not ours — never attribute them to us or to a player code.` +
      ` Never name anyone on their team and never invent a name for them.`,
    numbers: shown,
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

/* ------------------------------------------------------------------ */

// Nothing to check against: no players named, no stats quoted, Elo unrestricted.
export function hypePrompt(eventName: string | null): PhraseRequest {
  const angle = pickAngle("hype", HYPE_ANGLES);
  return {
    prompt:
      `A squad just filled up ${eventName ? `for an event called "${eventName}"` : "for a CS2 session"}.` +
      ` Write ONE funny, energetic hype message to fire them up.` +
      ` Angle — commit to it fully: ${angle}.` +
      ` Max 25 words. Do not repeat the event name or start time — they are already shown above your message.` +
      recentBlock("hype"),
    // A hype message is handed no numbers at all, so every check is on: nothing here
    // may quote Elo or a stat, because there is nothing it could be quoting from.
    checks: {
      allowElo: false,
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

  const angle = won
    ? pickAngle("win", [...WIN_ANGLES, close ? WIN_ANGLE_CLOSE : WIN_ANGLE_STOMP])
    : pickAngle("loss", [...LOSS_ANGLES, close ? LOSS_ANGLE_CLOSE : LOSS_ANGLE_STOMP]);
  // A win highlights us, a loss highlights them. Crediting our own numbers while
  // losing reads as self-congratulation, and using them to explain the defeat
  // reads as blame — so on a loss our roster never reaches the model at all,
  // which also means an invented number about us can't survive the checks.
  const { line: playerLine, players: named } = buildPlayerBlock(players, won);
  const theirs = opponentsLine(opponents, won);
  const prompt =
    `The squad just ${won ? "WON" : "LOST"} ${context}.` +
    ` Write ONE short funny ${won ? "celebratory" : "sarcastic excuse"} message.` +
    ` Angle — commit to it fully: ${angle}.` +
    ` ${playerLine}` +
    theirs.line +
    ` ${mapLine(map)}` +
    (upset ? won
      ? " Our team was rated lower and still won — make that part of the joke."
      : " They were rated lower than us — squeeze maximum drama out of that." : "") +
    (flow ? ` Extra angle you can lean into: ${flow}.` : "") +
    // The scoreboard sits directly above, so restating the score spends the 25
    // words on what the reader already sees. Quoting the forbidden string outright
    // is what made this stick — "don't restate it" alone was ignored a third of the
    // time. Elo stays allowed when an upset is the joke.
    ` The scoreboard above your message already shows the score${upset ? "" : " and both teams' Elo"} — read it for tone, but never write "${score}" or any form of it in your message, and never close with a score-and-map summary.` +
    ` Max 25 words.` +
    (won
      ? " Triumphant — never mention losing. A friendly dig at one of our own is welcome, but the win stays the point."
      : " Punchy; never blame our own team.") +
    recentBlock(kind);
  return {
    prompt,
    checks: {
      allowElo: upset,
      players: named,
      // Legitimate in the text even though they also turn up in players' stat lines,
      // so unsourcedStat must not read them as borrowed.
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
