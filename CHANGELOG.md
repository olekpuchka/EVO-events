# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions match the release tags.

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
