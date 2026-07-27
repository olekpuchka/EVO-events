# EVO Events Telegram Bot

A Telegram group bot for organizing gaming events — mention everyone with `@all`, collect RSVPs, send reminders, and auto-post FACEIT match results.

Built with [grammY](https://grammy.dev/) in TypeScript on Node.js — run directly via native type-stripping (no build step), with built-in SQLite.

## Features

- **`@all <message>`** — pings everyone. Add a time (`@all CS 22:00`) to make it a pinned event with RSVPs.
- **Live RSVP buttons** — 🍌 Joining / ❌ Not joining, updated in place on the pinned message.
- **Squad capped at 5** — locks with a hype message when full; drop out to reopen a seat.
- **"Mentioned:" list** shows who hasn't replied yet, and shrinks as people RSVP.
- **Auto-pin / auto-unpin** at start time, with a **reminder 10 minutes before**.
- **AI hype phrases** (DeepSeek, optional) when the squad fills and in the reminder.
- **Auto match results** — polls FACEIT and posts finished matches with K/D/A, ADR, per-player Elo ↑/↓ and team Elo, plus an AI win/loss line that reacts to the match stats (top fraggers, aces, clutches, comebacks, overtime).
- **Non-repeating AI voice** — each line is composed from a rolled premise × register × sentence shape ([`src/voice.ts`](src/voice.ts)), with the recent history kept in SQLite so a redeploy doesn't make the bot retell a joke. Preview any prompt change before shipping with `npm run ai:preview`.
- **Timezone** — event times show 🇺🇦 Kyiv and 🇪🇺 CET side by side. Posters default to Kyiv; those listed in `EU_TIMEZONE_MEMBERS` type in CET instead.
- **Quiet feedback** — usage hints, errors, and confirmations reply only to you and clear themselves, so they never clutter the group.
- **Language** — English or Ukrainian.

## Commands

| Trigger | Effect |
|---|---|
| `@all CS 22:00` | Mention all, pin event with RSVP buttons, schedule reminder & unpin |
| `@all CS` | Mention all only (no time = no event) |
| `/cancel` | Cancel the active event (any member can cancel) |
| `/mute` / `/unmute` | Opt out / into `@all` mentions |
| `/faceit <nickname>` | Link your FACEIT account for match-result posts |

Slash commands are case-insensitive. Match results post automatically once members link FACEIT accounts.

## Setup

Requirements: **Node.js 24+**, a bot token from [@BotFather](https://t.me/BotFather), and privacy mode **disabled** (`/setprivacy` → your bot → Disable) so it can read `@all`.

The bot is configured entirely through environment variables:

| Variable | Notes |
|---|---|
| `BOT_TOKEN` | Telegram bot token (required) |
| `FACEIT_API_KEY` | FACEIT Data API key — [developers.faceit.com](https://developers.faceit.com) (required for match results) |
| `DEEPSEEK_API_KEY` | Optional — AI phrases; falls back to built-ins if unset |
| `DEEPSEEK_MODEL` | Optional — defaults to `deepseek-v4-pro`; `deepseek-v4-flash` is cheaper but blander |
| `FACEIT_POLL_MINUTES` | How often to check for new matches (default `20`, min `5`) |
| `LANGUAGE` | `EN` or `UA` (default `EN`) |
| `EU_TIMEZONE_MEMBERS` | Optional — comma-separated user IDs whose typed times are read as 🇪🇺 CET instead of 🇺🇦 Kyiv (default: all Kyiv) |
| `DATA_DIR` | SQLite location (`/app/data` in production) |

- **Production:** set these in your JustRunMy.App app's **Settings** tab (see [Deployment](#deployment)).
- **Local dev:** copy [`.env.example`](.env.example) to `.env`, then run `node --env-file=.env bot.ts`. Node 24 runs the TypeScript directly — no compile step. Use `npm run typecheck` to check types.

## Deployment

Hosted on [JustRunMy.App](https://justrunmy.app/telegram-bots) (always-on containers, free tier). Create an app → **Deploy from Git**, set the env vars above, and mount a persistent volume at `/app/data`.

The [Deploy Action](.github/workflows/deploy.yml) ships on **either** trigger: a push to `main` (so every PR merge deploys) or a `v*` tag (to re-deploy a known version). `main` is always what's live. Both triggers typecheck first and share a `concurrency: deploy` group, so pushing a commit and its tag together can't start two racing deploys.

Fold the version bump into the change's own commit — `main` never accumulates a separate "chore: release" commit:

```bash
npm version minor --no-git-tag-version   # bump package.json + lock, no commit/tag
git commit -am "feat: ..."               # change + bump in one commit
git tag -a v2.5.0 -m v2.5.0              # annotated — --follow-tags only pushes annotated tags
git push --follow-tags
```

See [CLAUDE.md](CLAUDE.md) for the full flow.

Requires one repo secret `JUSTRUNMY_DEPLOY_URL` = `https://<user>:<token>@justrunmy.app/git/<repo-id>`.

## Contributing

Branch, open a PR against `main`, and let [CI](.github/workflows/ci.yml) typecheck it. Merging deploys to production, so keep `main` green — run `npm run typecheck` before pushing, and preview any AI prompt change with `npm run ai:preview`.

## License

[MIT](LICENSE)
