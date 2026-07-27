import type { PhraseKind, Premise, Register } from "./types.ts";

/* ------------------------------------------------------------------ *
 * The voice of the bot: everything the generator composes a message
 * from. Tuning the humour means editing this file and nothing else.
 *
 * WHY THE PREMISES ARE IN ENGLISH
 * They used to be Ukrainian imperatives that already contained the
 * punchline — «подай перемогу як суху бухгалтерію: +25 у скарбничку,
 * рахунок закрито, банк наш» — so the model had nothing left to write
 * and shipped a paraphrase: «+25 в скарбничку, рахунок закрито. Банк
 * наш». The same fifteen jokes cycled for months.
 *
 * Measured on the live API: four generations from one Ukrainian angle
 * produced four near-identical lines; four from an English premise
 * produced four genuinely different ones. The output must be
 * Ukrainian, so an English premise cannot be copied — the model is
 * forced to invent its own wording. Keep it that way.
 *
 * RULES FOR EDITING
 * - English, and a SITUATION rather than a finished joke. If a premise
 *   could be pasted into the chat as-is and be funny, it is wrong.
 * - Specific beats vague. "the enemy was bad" produces limp output;
 *   name a concrete target and a concrete frame.
 * - No voice instructions ("in the tone of a tired clerk"). The voice
 *   is the REGISTERS axis, and a premise that also dictates one fights
 *   it and collapses the variety it exists to provide.
 * - LOSS premises never blame our own squad — the blame lands on
 *   netcode, hardware, the matchmaker or the opponents' legitimacy.
 * - Every premise carries the emoji its message ships with, and any
 *   reference it leans on needs a line in the GLOSSARY below.
 * ------------------------------------------------------------------ */

/** How often a sentence shape is imposed on top of premise x register. */
export const FORM_CHANCE = 0.6;
/** How often the map name is even offered to the model. */
export const MAP_MENTION_CHANCE = 0.3;
/** How often a standout player is withheld, so not every line is a shoutout. */
export const PLAYER_SKIP_CHANCE = 0.25;
/** Of the messages that do get a player, how often the shoutout is mandatory. */
export const PLAYER_FOCUS_CHANCE = 0.45;

/* ------------------------------------------------------------------ *
 * What the references actually MEAN. Without this the model treated
 * the names as decoration and shipped «Гайда на сервер, s1mple-і —
 * там і визначиться ZywOo», which says nothing to anyone: it had the
 * tokens but not the idea that the joke is about who is best.
 *
 * Goes into the static system prompt, so it is a cached prefix and
 * costs almost nothing per call. Add a line here whenever a premise
 * starts leaning on a reference that is not already explained.
 * ------------------------------------------------------------------ */

export const GLOSSARY =
  " What the references mean — a name must never appear as decoration; the sentence has to carry its meaning:" +
  " s1mple is Oleksandr Kostyliev, the Ukrainian AWPer who spent years as the consensus best player alive and is a" +
  " point of local pride;" +
  " ZywOo is the French player who contested that title through the same years, so «which of you is ZywOo» means" +
  " «which of you is actually the better one»;" +
  " donk is a Russian teenager whose aim was so far past his age that his name became shorthand for aim good enough" +
  " to look suspicious;" +
  " NaVi is Natus Vincere, the Ukrainian organisation s1mple played for;" +
  " Stockholm 2021 is the Major NaVi won, the cleanest result in the scene's memory and a Ukrainian high point;" +
  " Boston 2018 is the Major final FaZe Clan lost from a winning position — the reference for a collapse, and the" +
  " reason «a certain clan cried again» is a joke at all;" +
  " Cologne is the arena where s1mple hit the jumping no-scope people still quote;" +
  " HLTV is the sport's main news and statistics site, and its yearly top-20 player ranking is the nearest thing to" +
  " an official verdict on who was good;" +
  " FACEIT is the third-party platform this squad queues on — Elo, levels, an anti-cheat client and a matchmaking" +
  " queue;" +
  " aim_botz is a training map full of bots that stand still, so calling opponents aim_botz targets says they cannot" +
  " aim at a moving target;" +
  " a Zeus x27 is the taser: one shot, melee range, and killing someone with it is pure humiliation;" +
  " a decoy is the grenade that only makes fake gunfire noise and does no damage;" +
  " an exit frag is a kill taken once the round is already decided, so it is worth nothing;" +
  " subtick is the CS2 timing system everyone blames for deaths that looked like they happened safely behind cover;" +
  " a one-way smoke is one you can shoot out of but not into;" +
  " VAC is Valve's anti-cheat, and its bans land in waves long after the match;" +
  " a smurf is a strong player on a fresh low-rated account;" +
  " silver means the bottom ranks, used as an insult;" +
  " eco, full buy and save are the rounds where a team spends nothing, spends everything, or deliberately keeps its" +
  " guns for later.";

/* ------------------------------------------------------------------ *
 * HOW it is said. Voice only — never subject matter, which is the
 * premise's job. `fits` is honest about range: deadpan and
 * indifference cannot carry a hype message, whose whole purpose is to
 * fire the squad up.
 * ------------------------------------------------------------------ */

export const REGISTERS: Register[] = [
  { id: "deadpan-flat", fits: ["win", "loss"], text: "Deadpan understatement: state it in the flattest possible way, no exclamation, no hype words, let the calm carry the damage" },
  { id: "broadcast-analyst", fits: ["win", "loss"], text: "Straight-faced professional analyst voice: clinical broadcast vocabulary, measured pacing, technical assessment delivered with total seriousness and zero emotion" },
  { id: "barely-bothered", fits: ["win", "loss"], text: "Performative indifference: you can barely be bothered to speak, minimum effort, half a shrug, and you stop before finishing the thought" },
  { id: "caster-meltdown", fits: ["hype", "win", "loss"], text: "Overwrought esports caster at full volume: breathless crescendo, escalating superlatives, voice cracking, narrating as if to a packed arena" },
  { id: "dream-logic", fits: ["hype", "win", "loss"], text: "Absurdist logic: reason from impossible causality with total confidence, stating surreal conclusions in the same tone as an ordinary everyday fact" },
  { id: "whisper-theory", fits: ["hype", "win", "loss"], text: "Conspiratorial whisper: lowered voice, insider certainty, connecting dots nobody asked for, implying the real explanation is being deliberately kept quiet" },
  { id: "locker-room-order", fits: ["hype", "win", "loss"], text: "Locker-room command voice: speak straight at the squad in clipped second-person imperatives, short barking sentences, no hedging, no politeness" },
  { id: "ceremonial-oration", fits: ["hype", "win", "loss"], text: "Grand ceremonial oration: elevated archaic diction, slow solemn cadence, delivered like a formal proclamation read aloud before an assembled hall" },
];

/* ------------------------------------------------------------------ *
 * The SHAPE of the sentence. Every observed message was "<clause> —
 * <clause>", inherited from the old angles' own shape. Rolling a form
 * in code breaks the template regardless of whether the model heeds
 * the instruction not to use it.
 * ------------------------------------------------------------------ */

export const FORMS: string[] = [
  "Structure: make the entire message a question.",
  "Structure: open with a one-word verdict, then a full stop, then one sentence that earns it.",
  "Structure: exactly two sentences, the second much shorter than the first.",
  "Structure: a single short sentence, and nothing after it.",
  "Structure: do not use a dash or a colon anywhere in the message.",
  "Structure: begin with a verb.",
];

/* ------------------------------------------------------------------ *
 * WHAT the joke is about.
 * ------------------------------------------------------------------ */

export const PREMISES: Record<PhraseKind, Premise[]> = {
  hype: [
    { id: "rush-b-doctrine", emoji: "💣", text: "rush B holds the status of ratified squad doctrine tonight, and any alternative opening call is an amendment nobody in the lobby will second" },
    { id: "major-grand-final", emoji: "🏟️", text: "an ordinary weeknight FACEIT queue is getting the full Major grand-final production: jerseys, handshakes on stage, tactical timeouts and an analyst desk at the break" },
    { id: "elo-deed", emoji: "✍️", text: "five strangers are clicking accept right now, unaware that they have already signed their Elo over to this squad in a notarised deed" },
    { id: "aim-botz-walking", emoji: "🎯", text: "tonight's opponents are aim_botz targets that somehow learned to walk, buy utility and click accept in the FACEIT queue" },
    { id: "demo-quarter-speed", emoji: "🎞️", text: "the aim tonight is a performance the enemy re-watches frame by frame at 0.25x speed, hunting for evidence solid enough to attach to a report" },
    { id: "knife-trophy", emoji: "🔪", text: "one opponent tonight is getting knifed, and that frag belongs in a hunting trophy collection rather than anywhere on the scoreboard" },
    { id: "one-more-game-unit", emoji: "⏰", text: "someone has promised just one more game tonight, using it as a unit of time no calendar recognises and that has never yet measured one game" },
    { id: "club-2007", emoji: "🕹️", text: "the evening has the shape of a 2007 computer club night, except no admin can switch the machines off or throw anyone out at closing time" },
    { id: "no-random-scapegoat", emoji: "🤝", text: "a full five-man stack means there is no random fifth in the lobby tonight, which quietly removes the squad's most reliable explanation for a bad evening" },
    { id: "five-s1mples", emoji: "👑", text: "each of the five in this lobby privately rates himself the best player present, the way s1mple was the best in the world, and the server is about to settle the argument" },
    { id: "launch-countdown", emoji: "🚀", text: "the last five minutes before queue are a launch countdown — kettle, toilet, headset, water within reach — and after ignition nobody leaves the chair" },
    { id: "veto-confession", emoji: "🙊", text: "the map veto turns into a public confession, because every ban names a weakness the person banning would rather nobody said out loud" },
    { id: "accept-reflex", emoji: "⚡", text: "the match-accept button draws the fastest reaction anyone in this stack produces all evening, a reflex that belongs in a sports-science laboratory" },
    { id: "anticheat-customs", emoji: "🛃", text: "the FACEIT anti-cheat client and a driver update stand between the squad and the queue like a customs desk that has found a problem with the paperwork" },
    { id: "profile-dossier", emoji: "🕵️", text: "the enemy nicknames and locked Steam profiles are being processed like an intelligence file, and the smurf verdict arrives before the first pistol round" },
    { id: "youtube-lineups", emoji: "📺", text: "someone is learning smoke lineups off a YouTube tutorial twenty minutes before queue, the way a whole term gets learned on the morning of the exam" },
    { id: "doping-control", emoji: "☕", text: "an energy drink, coffee after eleven at night and sunflower seeds make up tonight's performance programme, and esports doping control has never knocked on this door" },
    { id: "comms-agreement", emoji: "🎙️", text: "the squad has once again agreed tonight's comms rules — short callouts, no screaming, no dying and then narrating — an agreement with the shelf life of a new-year resolution" },
    { id: "top-fragger-odds", emoji: "🎲", text: "quiet betting on tonight's top fragger is open before a single round is played, and the odds have already shortened on the usual candidate" },
    { id: "summoning-the-fifth", emoji: "🕯️", text: "the fifth player answered after forty minutes of «го» in the chat, which counts less as messaging and more as a completed summoning ritual" },
    { id: "lucky-setup", emoji: "🍀", text: "the same chair, the same crosshair colour and the same lucky skin are non-negotiable tonight, since last week's win is credited entirely to them" },
    { id: "level-plateau", emoji: "📈", text: "the next FACEIT level is one good evening away, a distance it has stubbornly kept for several months of good evenings" },
    { id: "awp-custody", emoji: "🔫", text: "there is one AWP and five people convinced they should be holding it, which makes every full buy a negotiation over a shared family car" },
    { id: "dinner-at-keyboard", emoji: "🍽️", text: "one player joins the lobby with a plate of dinner in front of the keyboard and an assurance that it has never once affected his aim" },
  ],
  win: [
    { id: "elo-ledger-entry", emoji: "🧾", text: "frame the Elo gain as a routine entry in a ledger, accounting paperwork so ordinary that nobody in the office looks up from it" },
    { id: "valorant-migration", emoji: "🧳", text: "picture the enemy team's browser history right after the match, quietly opening Valorant system requirements, and treat that as a documented change of career" },
    { id: "stockholm-major-bracket", emoji: "🏆", text: "place this result in the same historical bracket as Stockholm 2021, letting an ordinary FACEIT lobby stand in for a Major final" },
    { id: "full-buy-delivery", emoji: "📦", text: "the enemy bought a full loadout and then dropped every rifle at our feet; view their economy as a delivery service paying for our shopping" },
    { id: "zeus-ammunition-audit", emoji: "⚡", text: "audit the rifle ammunition spent on opponents of this caliber and argue that a single Zeus x27 was the economically justified purchase" },
    { id: "incident-report-misses", emoji: "📋", text: "the enemy's misses were systematic enough to deserve an official incident report, with a case number, an assigned inspector and a diagram of the corridor" },
    { id: "silver-cutlery-drawer", emoji: "🥄", text: "measure the amount of silver on the enemy team against the amount of silver in a Ukrainian grandmother's cutlery drawer" },
    { id: "noscope-graffiti-monument", emoji: "🎨", text: "the play of the night was an s1mple-grade noscope that deserves permanent commemoration, sprayed as graffiti on the wall where it actually happened" },
    { id: "reports-as-medals", emoji: "🎖️", text: "read the wave of reports and -rep landing on our profiles as an award ceremony where the losing side hands out the medals personally" },
    { id: "comeback-cardiogram", emoji: "🫀", text: "the comeback belongs in a cardiology file: the heart-rate chart of everyone who sat through the closing rounds now qualifies as a diagnosis" },
    { id: "exit-frag-charity", emoji: "🎁", text: "the enemy's whole highlight reel consists of exit frags taken after rounds were already decided; treat those kills as charity we allowed them to keep" },
    { id: "unused-utility-thrift", emoji: "🍽️", text: "the enemy finished the match with smokes and flashes unthrown, like the good dishes a family saves for guests who never arrive" },
    { id: "night-shift-awper", emoji: "💤", text: "frame the enemy AWPer who held one angle all match as a night-shift security guard who saw nothing, heard nothing, and still signed the logbook" },
    { id: "cheat-accusation-reference", emoji: "📄", text: "the enemy's accusations that we are smurfs or cheating deserve to be printed out and kept in a folder like a letter of recommendation" },
    { id: "lan-handshake-cope", emoji: "🤝", text: "answer the eternal cope that online does not count by insisting this exact result would repeat on LAN, with jerseys, a crowd and handshakes" },
    { id: "household-justification", emoji: "🔧", text: "weigh tonight's hours at the computer against the shelf that has been waiting to be fixed since spring, and let the win settle that argument" },
    { id: "instant-lobby-exit", emoji: "🏃", text: "nobody on the losing side stayed to admire the scoreboard; measure that departure speed against a tenant moving out overnight to avoid the rent" },
    { id: "clutch-spectator-cabin", emoji: "✈️", text: "the clutch happened while the rest of the squad already sat spectating in silence, like passengers watching the pilot land through fog" },
    { id: "their-own-map-cope", emoji: "🏠", text: "the losing side will spend tonight explaining that this map was never their pick, a housewarming where the hosts got escorted out of their own apartment" },
    { id: "shorter-than-the-queue", emoji: "⏱️", text: "the queue took longer than the match it produced; log the whole evening as a scheduling inconvenience rather than a contest" },
    { id: "hltv-top20-nomination", emoji: "📰", text: "on the strength of this single match, submit the squad for the HLTV top-20 ranking, complete with a press release and a highlight package" },
    { id: "gg-ez-promissory", emoji: "💸", text: "the losing side's confidence peaked somewhere early on; treat that swagger as a promissory note that came due before the match ended" },
    { id: "one-at-a-time-angle", emoji: "🚶", text: "the enemy walked into the same angle one player at a time all match, so treat the sequence as an orderly queue where everyone waited their turn" },
    { id: "neighbours-through-wall", emoji: "🧱", text: "the only witnesses to the celebration were the neighbours behind the wall, who by now know our callouts and rotations better than the enemy did" },
  ],
  loss: [
    { id: "subtick-verdict", emoji: "🧾", text: "Blame CS2 subtick for the deaths that happened a full second behind cover, a wrongly issued fine to be contested at the counter with a printout" },
    { id: "vac-holiday", emoji: "🏖️", text: "Wish the winners a long restful holiday whose return date is already fixed by the next VAC ban wave" },
    { id: "smurf-prodigy", emoji: "👶", text: "Treat the enemy account registered three days ago with donk-grade aim as a youth-academy discovery: raw prodigy found, scouts notified, bright career ahead" },
    { id: "excuse-bingo", emoji: "🎰", text: "Run through the household excuse card — a new mouse, a cat on the keyboard, sunlight on the monitor — as a bingo sheet filled to the last square" },
    { id: "save-round-reframe", emoji: "🏦", text: "Reframe the entire defeat as one correctly played save round — weapons kept, economy preserved, the actual buy postponed until the next queue" },
    { id: "exit-frag-audit", emoji: "🔍", text: "Put the enemy top-fragger's kills through a line-by-line audit: exit frags, save rounds, and cleanups after his own teammates did all the damage" },
    { id: "profile-evidence", emoji: "🕵️", text: "Enter the winners' private Steam profiles, anime avatars and hidden match history into evidence as a case file that needs no further investigation" },
    { id: "algorithm-rebalance", emoji: "⚖️", text: "Blame the FACEIT matchmaking algorithm for deciding the squad's rating needed correcting — scheduled maintenance performed on us with no notification and no downtime window" },
    { id: "oneway-convention", emoji: "📜", text: "Denounce one-way smokes and pixel-perfect angles as weapons banned by an international convention that Valve has quietly declined to sign" },
    { id: "greenland-router", emoji: "📦", text: "Blame the ping and a game server routed somewhere past Greenland, making this a shipping problem with tracking numbers, customs delays and no delivery date" },
    { id: "onliner-lan-challenge", emoji: "📅", text: "Call the winners onliners and demand a LAN rematch — an invitation with no venue, no date and nobody planning to book one" },
    { id: "impossible-aim", emoji: "🧪", text: "Put the opponents' headshot percentage on a lab report where the measured value sits outside the range that occurs anywhere in nature" },
    { id: "haunted-audio", emoji: "👻", text: "Blame CS2 audio for footsteps that arrive from directions the map geometry does not contain — something is walking inside the walls" },
    { id: "flashbang-bugreport", emoji: "🐛", text: "File the flashbang that clipped an invisible ledge and blinded nobody as a formal bug report, complete with reproduction steps and attached demo" },
    { id: "magnetic-storms", emoji: "🔮", text: "Blame magnetic storms, Mercury retrograde and the lunar phase for the aim, an astrological forecast that predicted this outcome for our star sign" },
    { id: "gg-complaint", emoji: "📝", text: "Treat the winners' polite gg in all-chat as a hostile act deserving a formal written complaint filed with the building management" },
    { id: "hltv-audition", emoji: "🎬", text: "Mock how seriously the winners played a random weekday queue — this demo is going straight to HLTV as an audition tape for a tier-3 org" },
    { id: "result-under-appeal", emoji: "🗂️", text: "Announce that the result has been sent for official review: an appeal filed, stamped, assigned a case number, and never scheduled for a hearing" },
    { id: "elo-market-correction", emoji: "📉", text: "Describe the lost Elo as a short-term correction inside a long-term portfolio, with the asset's fundamentals unchanged and the position worth holding" },
    { id: "comms-leak", emoji: "🔐", text: "Suggest the opponents rotated before the call even finished — a leak in the voice channel, and now everyone changes the Discord password" },
    { id: "lineup-homework", emoji: "📚", text: "Point out that the winners' smokes and molotovs came straight off a YouTube lineup tutorial, homework copied from the video without understanding it" },
    { id: "faceit-ac-cpu", emoji: "🖥️", text: "Blame the FACEIT anti-cheat client for eating the CPU all evening while doing nothing whatsoever about the person it was installed to find" },
    { id: "awp-pension", emoji: "🪑", text: "Aim at the enemy AWPer who held one angle from first round to last, a comfortable post occupied until retirement age" },
    { id: "invisible-stats", emoji: "🏅", text: "Claim the categories that never reach the scoreboard — utility damage, flash assists, trades, opening duels — as a separate awards ceremony nobody broadcasts" },
  ],
};

/* The emoji lives on the premise (see the `emoji` field above) rather
 * than in a per-kind bag drawn from at random. Random was cheap but
 * dumb: a bureaucratic joke about a filed appeal could ship with 🚀.
 * Tied to the premise it comments on the joke, stays out of the
 * model's hands, and gets edited right next to the line it belongs
 * to. */
