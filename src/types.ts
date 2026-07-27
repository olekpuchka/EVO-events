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

export interface ActiveEventRow {
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

export interface AiHistoryRow {
  premise_id: string;
  register_id: string;
  phrase: string;
}

/* ── AI voice: the pools the generator composes a message from ─────────────── */

export type PhraseKind = "hype" | "win" | "loss";

/** What the joke is about. English on purpose — see the header of voice.ts.
 *  `emoji` is the one appended to the finished message: chosen per premise so
 *  it comments on the joke rather than landing at random. */
export interface Premise {
  id: string;
  emoji: string;
  text: string;
}

/** How it is said. Voice only, never subject matter — that is the premise's job. */
export interface Register {
  id: string;
  text: string;
  fits: PhraseKind[];
}

/* ── FACEIT API responses (only the fields this bot reads) ─────────────────── */

export interface FaceitPlayer {
  player_id: string;
  nickname: string;
  games?: { cs2?: { faceit_elo?: number | null } };
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

/* ── Structures handed from the FACEIT layer to the AI layer ───────────────── */

export interface EloPair {
  ours: number | string;
  theirs: number | string;
}

export interface MatchFlow {
  ourFirst: number;
  theirFirst: number;
  ourOt: number;
  theirOt: number;
}

export interface MatchPlayer {
  nickname: string;
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
  hs: number;
  aces: number;
  quadros: number;
  clutches: number;
  awp: number;
  entries: number;
  util: number;
  flashes: number;
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
