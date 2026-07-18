# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions match the release tags.

## [2.6.1]

### Changed

- **Reordered the match-result card.** The header (score and Elo) now shows first,
  with the map image below it — previously the image sat on top of the header.

## [2.6.0]

### Changed

- **Migrated the codebase to TypeScript.** Every source file is now `.ts`,
  type-checked with `tsc --noEmit` (`npm run typecheck`) and run directly on Node 24
  via native type-stripping — no build step, no bundler, and TypeScript stays a
  dev-only dependency. The conversion is behaviour-neutral; the deploy workflow
  type-checks before publishing.
- **Corrected the `unpinChatMessage` call** to grammY 1.45.1's argument form
  (a bare `message_id`, not `{ message_id }`), which the type-checker surfaced.
- **Refreshed the match-result card.** The played map now shows as an image on top
  of the scoreboard instead of a name in the header; the header is simplified to
  `SCORE (Elo vs Elo)`, and the divider above the AI commentary is removed. The map
  name still feeds the AI phrase.

### Fixed

- **Linking an unranked FACEIT account no longer fails.** A CS2 account with no
  Elo previously threw when saving; it now links cleanly as Unranked.

## [2.5.0]

### Added

- **Quiet feedback.** Usage hints, errors, and mute/FACEIT confirmations now reply
  only to the person who triggered them and clear themselves, instead of being posted
  to the group and deleted after 10s. Falls back to the old auto-delete behaviour
  where private replies aren't supported.
- **Scoreboard match results.** FACEIT results now post as a formatted scoreboard —
  a score · map · Elo header, an aligned table (player with Elo, K/D/A, ADR), the AI
  commentary as a quote, and a FACEIT link. The map name comes from FACEIT's official
  name field. Falls back to the previous text layout when needed.

### Changed

- **AI phrases as quotes.** The full-squad hype (`@all`), the reminder line, and the
  match-result commentary now render as italic quote blocks for a consistent voice.
- **Dependencies:** `grammy` 1.44.0 → 1.45.1, `openai` 6.45.0 → 6.48.0.

## [2.4.0]

### Added

- **Per-poster timezones via `EU_TIMEZONE_MEMBERS`.** Members listed in this env
  var (comma-separated Telegram user IDs) type their event times in 🇪🇺 CET
  instead of 🇺🇦 Kyiv. Everyone else stays on Kyiv — no change for existing users.

### Changed

- **`@all` event times now flag both zones inline** — e.g. `CS 🇺🇦 23:30
  (🇪🇺 22:30)`, where before only the CET equivalent was flagged. Both times are
  derived from the timestamp, so they stay DST- and midnight-correct, and the
  reminder inherits the same formatting.

## [2.3.8]

### Changed

- **Richer AI match commentary.** The DeepSeek phrase generator now gets far
  more of the FACEIT `/matches/{id}/stats` payload as context, so the win/loss
  line reacts to what actually happened instead of just the score:
  - **Per-player** — K/D/A, headshot %, aces/quad-kills, 1v2 clutches, AWP
    kills, entry frags, utility damage and enemies flashed. Only the top
    fragger gets the full line; situational stats appear only past a "notable"
    threshold and the list is capped — a curated hook, not a raw dump.
  - **Match flow** — a code-computed hook for comeback wins and overtime
    finishes, kept blame-safe on losses so the never-blame-our-team rule holds.
  - Players stay anonymized as `P1`/`P2` codes, and the "copy every number
    exactly, never invent stats" guardrails were widened to cover the new
    fields.
- **Generated phrases now cap at 25 words** across the board (was 15 for hype,
  20 for losses), giving the model room to use the richer context.

## [2.3.7]

### Added

- **CET/CEST (🇪🇺) time shown next to Kyiv time on `@all` events**, for
  teammates in Central-European time zones.

## [2.3.6]

### Changed

- **Deploy workflow auto-syncs `package.json` to the release tag** in CI,
  replacing the standalone npm release helper.

## [2.3.5]

### Changed

- **`getRecentMatches` now routes through `faceitGet`**, gaining the same
  retry/backoff on rate-limits and transient errors as the other FACEIT calls.

### Added

- **`npm run release` script** to keep the version bump and git tag in sync.

## [2.3.4]

### Changed

- **Simplified README** and removed dead message-splitting code; the MCP token
  is now read from the environment.

### Added

- **JustRunMy.App MCP server config template** (`.mcp.json`) for managing the
  app from an MCP-capable editor.

## [2.3.3]

### Fixed

- **Players intermittently showing `? Elo` in match results.** A rate-limited
  (`429`) or transient (`5xx`) FACEIT profile request used to be swallowed,
  permanently degrading that player's line to `? Elo` since posted matches are
  never retried. `faceitGet` now retries these with backoff (honoring the
  `Retry-After` header, capped so it can't stall the poll).
- **A match is now held back instead of posted with partial `? Elo`** when a
  player's Elo fetch fails transiently (429/5xx after retries). The match isn't
  marked posted, so the next poll retries with complete info. A 30-minute grace
  valve posts best-effort afterwards so a match never gets stuck, and genuinely
  unranked players (no `cs2` Elo) don't block the post.

### Changed

- **Post-match Elo is fetched only for members who actually played the match**,
  instead of every registered member on every poll. Fewer FACEIT API calls and
  a smaller request burst, which also reduces the rate-limiting that caused the
  `? Elo` bug above. Sit-out members' Elo baselines are left untouched.
- **Default match-poll interval raised from 15 to 20 minutes** (`FACEIT_POLL_MINUTES`).
