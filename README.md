# EVO Events Telegram Bot

A Telegram group bot for organizing gaming events — mention everyone with `@all`, collect RSVPs, send reminders, and auto-post FACEIT match results.

Built with [grammY](https://grammy.dev/) in TypeScript on Node.js — run directly via native type-stripping (no build step), with built-in SQLite.

## Features

- **`@all <message>`** — pings everyone. Add a time (`@all CS 22:00`) to make it a pinned event with RSVPs.
- **Live RSVP buttons** — 🍌 Joining / ❌ Not joining, updated in place on the pinned message.
- **Squad capped at 5** — locks with a hype message when full; drop out to reopen a seat.
- **"Mentioned:" list** shows who hasn't replied yet, and shrinks as people RSVP.
- **Auto-pin / auto-unpin** at start time, with a **reminder 10 minutes before**.
- **Parallel events** — several can run at once (say 20:00 and 22:00), each with its own RSVPs, reminder and unpin. Joining one doesn't stop you joining another.
- **AI hype phrases** (DeepSeek, optional) when the squad fills and in the reminder.
- **Auto match results** — polls FACEIT and posts finished matches with K/D/A, ADR, per-player Elo ↑/↓ and team Elo, plus an AI win/loss line that reacts to the match stats (top fraggers, aces, clutches, comebacks, overtime).
- **Timezone** — event times show 🇺🇦 Kyiv and 🇪🇺 CET side by side. Posters default to Kyiv; those listed in `EU_TIMEZONE_MEMBERS` type in CET instead.
- **Quiet feedback** — usage hints, errors, and confirmations reply only to you and clear themselves, so they never clutter the group.
- **Language** — English or Ukrainian.

## Commands

| Trigger | Effect |
|---|---|
| `@all CS 22:00` | Mention all, pin event with RSVP buttons, schedule reminder & unpin |
| `@all CS` | Mention all only (no time = no event) |
| `/cancel` | Cancel an active event (any member can cancel). With more than one live, reply it to the event you mean |
| `/mute` / `/unmute` | Opt out / into `@all` mentions |
| `/faceit <nickname>` | Link your FACEIT account for match-result posts |

Slash commands are case-insensitive. Match results post automatically once members link FACEIT accounts.

## Setup

Requirements: **Node.js 24+**, a bot token from [@BotFather](https://t.me/BotFather), and privacy mode **disabled** (`/setprivacy` → your bot → Disable) so it can read `@all`.

The bot is configured entirely through environment variables.

**Secrets** — supply at runtime: JustRunMy.App → **Settings** in production, `.env` locally. Never put these in the Dockerfile; `ENV` is baked into the image and readable by anyone who has it.

| Variable | Notes |
|---|---|
| `BOT_TOKEN` | Telegram bot token — required, the bot exits at startup without it |
| `FACEIT_API_KEY` | FACEIT Data API key — [developers.faceit.com](https://developers.faceit.com). Required for match results; without it the bot still starts and every poll just 401s |
| `DEEPSEEK_API_KEY` | Optional — AI phrases; built-in phrases are used if unset |

**Everything else** is declared in the [Dockerfile](Dockerfile), so the bot runs unconfigured. Settings overrides any of them at runtime.

| Variable | Default | Notes |
|---|---|---|
| `DATA_DIR` | `/app/data` in the image, `app/data` locally | SQLite location — the mounted volume in production, inside the project for dev |
| `LANGUAGE` | `UA` | `EN` or `UA` |
| `FACEIT_POLL_MINUTES` | `20` | How often to check for finished matches (min `5`) |
| `EU_TIMEZONE_MEMBERS` | empty | Comma-separated user IDs whose typed times are read as 🇪🇺 CET instead of 🇺🇦 Kyiv |

> An `ENV` beats the fallback in `src/`, so changing a default in code alone won't reach the container — **change both**.

**Local dev:** copy [`.env.example`](.env.example) to `.env`, fill in `BOT_TOKEN`, then run `node --env-file=.env bot.ts`. Node 24 runs the TypeScript directly — no compile step; `npm run typecheck` checks types. The database is created at `app/data/` in the project (gitignored) — nothing to set up.

## Deployment

Hosted on [JustRunMy.App](https://justrunmy.app/telegram-bots) (always-on containers, free tier). Create an app → **Deploy from Git**, set `BOT_TOKEN` and `FACEIT_API_KEY` (plus `DEEPSEEK_API_KEY` for AI phrases), and mount a persistent volume at `/app/data`.

Any push to `main` deploys via the [Deploy Action](.github/workflows/deploy.yml), which typechecks first — so merging a PR is a release, and `main` is always what's live. Tags deliberately don't trigger it (the host rebuilds on every push, so a tag trigger deployed each release twice).

Fold the version bump into the change's own commit — `main` never accumulates a separate "chore: release" commit:

```bash
npm version minor --no-git-tag-version   # bump package.json + lock, no commit/tag
git commit -am "feat: ..."               # change + bump in one commit
# open a PR, let CI pass, merge — the merge deploys
```

Tagging is optional, for versions worth naming as rollback points:

```bash
git tag -a v2.5.0 -m v2.5.0              # annotated — --follow-tags only pushes annotated tags
git push --follow-tags
```

To roll back or re-deploy an old version, run Deploy manually from the **Actions** tab against that tag or SHA. See [CLAUDE.md](CLAUDE.md) for the full flow.

Requires one repo secret `JUSTRUNMY_DEPLOY_URL` = `https://<user>:<token>@justrunmy.app/git/<repo-id>`.

## Contributing

Branch, open a PR against `main`, and let [CI](.github/workflows/ci.yml) typecheck it. Merging deploys to production, so keep `main` green — run `npm run typecheck` before pushing.

## License

[MIT](LICENSE)
