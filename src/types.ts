// Shared type definitions: SQLite row shapes, FACEIT API responses, and the
// match/player structures passed from the FACEIT layer into the AI layer.
// Everything here is type-only — it erases completely at runtime.

/* ── SQLite row shapes ──────────────────────────────────────────────────────
 * Mirror the SELECT column lists in db.ts (including AS aliases); db.ts casts
 * each untyped query result to one of these. Keep them in sync with the SELECTs. */

export interface MemberRow {
  id: number; // user_id AS id
  username: string | null;
  first_name: string;
  last_name: string | null;
}

export interface RsvpRow {
  id: number; // user_id AS id
  first_name: string;
  last_name: string | null;
  username: string | null;
  status: string; // "join" | "not_join"
}

export interface EventRow {
  base_text: string;
  event_time: number | null;
}

// An EventRow plus the id that identifies it — what getActiveEvents selects.
export interface ActiveEventRow extends EventRow {
  message_id: number;
}

export interface FaceitMemberRow {
  user_id: number;
  faceit_player_id: string;
  faceit_elo: number | null;
}

export interface DueUnpinRow {
  chat_id: string;
  message_id: number;
  reminder_message_id: number | null;
}

export interface DueReminderRow {
  chat_id: string;
  message_id: number;
}

/* ── FACEIT API responses (only the fields this bot reads) ─────────────────── */

export interface FaceitPlayer {
  player_id: string;
  nickname: string;
  games?: { cs2?: { faceit_elo?: number | null } };
}

// A hit from /search/players — narrower than FaceitPlayer on purpose: that response shapes `games`
// as an array rather than the keyed object /players returns, so only the shared fields are declared.
export interface FaceitSearchItem {
  player_id: string;
  nickname: string;
}

export interface FaceitHistoryItem {
  status: string;
  finished_at: number;
  match_id: string;
}

export interface FaceitStatPlayer {
  player_id: string;
  nickname: string;
  player_stats?: Record<string, string>;
}

export interface FaceitTeam {
  players: FaceitStatPlayer[];
  team_stats?: Record<string, string>;
}

export interface FaceitRound {
  teams?: FaceitTeam[];
  round_stats?: Record<string, string>;
}

export interface FaceitMatchStats {
  rounds?: FaceitRound[];
}

export interface FaceitFaction {
  roster?: { player_id: string }[];
  stats?: { rating?: number | string };
}

export interface FaceitMatchDetails {
  status?: string;
  voting?: { map?: { entities?: { game_map_id: string; name: string; image_lg?: string }[] } };
  teams?: Record<string, FaceitFaction>;
}

/* ── AI phrases ─────────────────────────────────────────────────────────────
 * Shared by the three modules a phrase passes through: view/prompt.ts builds the
 * text, adapters/ai.ts sends it, view/phrase.ts checks what comes back. */

export type Kind = "hype" | "win" | "loss";

// One of our players as the model sees them. Position is the code it was given —
// index 0 is P1 — so the nickname and the stat line it may quote can't drift apart.
export interface PromptPlayer {
  nickname: string;
  facts: string;
}

// The players named in one prompt, and the instruction line describing them.
export interface PlayerBlock {
  line: string;
  players: PromptPlayer[];
}

// A prompt and what the reply to it will be judged against — the pair every
// generate call needs, so neither can be built without the other.
export interface PhraseRequest {
  prompt: string;
  checks: PhraseChecks;
}

// Why a phrase can't ship. Here rather than in view/phrase.ts because all three modules
// handle one: phrase.ts decides it, ai.ts logs and retries, prompt.ts corrects.
export type RejectReason =
  | "empty" | "elo" | "language" | "scoreline" | "unsourced-stat" | "unknown-code" | "callout";

// A judged reply. Named here because view/phrase.ts returns it and adapters/ai.ts
// forwards it untouched — the `"phrase" in result` narrowing on both sides must agree.
export type PhraseVerdict = { phrase: string } | { rejected: RejectReason };

// What a generated phrase is checked against, decided while building the prompt.
export interface PhraseChecks {
  allowElo: boolean;
  // Hype may name a place: «rush B» is one of its angles and no round has been played.
  // A match message never may. Set in prompt.ts, where the angles that need it live.
  allowCallouts: boolean;
  players: PromptPlayer[];
  safeNumbers: Set<string>;
  // Scorelines the prompt supplied itself, e.g. the half-time score behind a comeback
  // hook — any other one is the final score we banned, or invented. `null` where no
  // score is in play at all (a hype message), so a clock time isn't read as one.
  allowedScorelines: string[] | null;
  map: string | null;
}

// All a hype message knows besides the event name — it gets no stats.
export interface HypeContext {
  startsIn?: number | null; // minutes until kick-off, null when the event has no time
  squadFull?: boolean;
}

export interface MatchPhraseContext {
  map?: string | null;
  elo?: EloPair | null;
  players?: MatchPlayer[];
  matchFlow?: MatchFlow | null;
  opponents?: Opponents;
}

/* ── Structures handed from the FACEIT layer to the AI layer ───────────────── */

export interface EloPair {
  ours: number | string;
  theirs: number | string;
}

// The other team, anonymised: everyone with stats, minus the nickname — they're outside the
// group. The numbers are real because the suspicious-aim angles are built on them.
export type Opponents = Omit<MatchPlayer, "nickname">[];

export interface MatchFlow {
  ourFirst: number;
  theirFirst: number;
  ourOt: number;
  theirOt: number;
}

// FACEIT's per-round and per-match rate fields are deliberately absent: they're
// derived from these raw counts, so they cost prompt length and buy nothing.
export interface MatchPlayer {
  nickname: string;
  kills: number;
  deaths: number;
  assists: number;
  kd: number;
  adr: number;
  damage: number;
  hs: number;
  mvps: number;
  doubles: number;
  triples: number;
  quadros: number;
  aces: number;
  firstKills: number;
  entries: number; // won, out of entryCount attempted
  entryCount: number;
  onevoneWins: number;
  onevoneCount: number;
  clutches: number; // 1v2 won, out of clutchCount attempted
  clutchCount: number;
  clutchKills: number;
  awp: number;
  pistol: number;
  knife: number;
  zeus: number;
  util: number; // damage dealt with utility, not utility thrown
  utilEnemies: number;
  utilCount: number; // thrown
  flashes: number; // enemies blinded, not flashes thrown
  flashSuccesses: number;
  flashCount: number; // thrown
}

/* ── Rendered match result (built in handlers, consumed by both renderers) ─── */

export interface ResultRow {
  nickname: string;
  kda: string;
  adr: string;
  elo: string;
}

export interface MatchResult {
  won: boolean;
  ourScore: string;
  theirScore: string;
  elo: EloPair | null;
  mapImage: string | null;
  matchId: string | null;
  rows: ResultRow[];
  phrase: string;
}
