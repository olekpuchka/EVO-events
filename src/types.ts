// Shared type definitions: SQLite row shapes, FACEIT API responses, birthday phrases,
// and the rendered match result.
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
  faceit_player_id: string;
}

// One member's stored birthday. `birth_date` is ISO `YYYY-MM-DD` — sortable, and its last five
// characters are the MM-DD the daily sweep matches on. The table's `greeted_on` and `active`
// columns are deliberately absent: both are written and filtered on in SQL and never read back off
// a row, so selecting them would be fields to keep in sync for nothing.
export interface BirthdayRow {
  user_id: number;
  birth_date: string;
}

// A birthday due today, joined with the member row the greeting needs to @-mention them.
export interface DueBirthdayRow extends BirthdayRow {
  chat_id: string;
  username: string | null;
  first_name: string;
  last_name: string | null;
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
  voting?: { map?: { entities?: { game_map_id: string; image_lg?: string }[] } };
  teams?: Record<string, FaceitFaction>;
}

// faceit.com's own per-map scoreboard, not the open API — the only source of rating and swing.
export interface FaceitScoreboard {
  payload?: {
    cs2?: {
      teams?: {
        players?: {
          player_id: string;
          elo?: number | null;
          elo_delta?: number | null;
          stats?: { faceit_rating?: number; faceit_rating_swing?: number };
        }[];
      }[];
    };
  };
}

// One player's line from that scoreboard. Swing is a fraction, not percentage points; `elo` is
// null when the scoreboard carries no Elo for them.
export interface ScoreboardLine {
  rating: number;
  swing: number;
  elo: { after: number; change: number } | null;
}

/* ── Birthday phrases ───────────────────────────────────────────────────────
 * Shared by the three modules a phrase passes through: view/prompt.ts builds the
 * text, adapters/ai.ts sends it, view/phrase.ts checks what comes back. */

// A prompt and what the reply to it will be judged against — built together, so neither
// can exist without the other.
export interface PhraseRequest {
  prompt: string;
  checks: PhraseChecks;
}

// Why a phrase can't ship. Here rather than in view/phrase.ts because all three modules
// handle one: phrase.ts decides it, ai.ts logs and retries, prompt.ts corrects.
export type RejectReason = "empty" | "too-long" | "elo" | "language" | "unsourced-stat" | "unknown-code";

// A judged reply. Named here because view/phrase.ts returns it and adapters/ai.ts
// forwards it untouched — the `"phrase" in result` narrowing on both sides must agree.
export type PhraseVerdict = { phrase: string } | { rejected: RejectReason };

// What a generated phrase is checked against, decided while building the prompt.
export interface PhraseChecks {
  // Swapped back in for P1; any other code is invented.
  name: string;
  // The only figures the message may carry.
  safeNumbers: Set<string>;
  // The word ceiling the prompt stated, enforced.
  maxWords: number;
}

/* ── Rendered match result (built and sent by handlers/results.ts) ─────────── */

export interface EloPair {
  ours: number | string;
  theirs: number | string;
}

export interface ResultRow {
  nickname: string;
  kda: string;
  adr: string;
  // Null when faceit.com had no line for the player: no Elo line, and on every row no Rating column.
  // Rating and swing (in percentage points) are rounded to 2 places once, where the row is built.
  rating: number | null;
  swing: number | null;
  // Elo after the match, and the match's change.
  eloAfter: number | null;
  eloChange: number | null;
}

export interface MatchResult {
  won: boolean;
  ourScore: string;
  theirScore: string;
  elo: EloPair | null;
  mapImage: string | null;
  matchId: string;
  rows: ResultRow[];
}
