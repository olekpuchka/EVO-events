# EVO Events Telegram Bot

A Telegram group bot for organizing gaming events — mention everyone with `@all`, collect RSVPs, send reminders, and auto-post FACEIT match results.

Built with [grammY](https://grammy.dev/) and Node.js (built-in SQLite).

## Features

- **`@all <message>`** — pings everyone. Add a time (`@all CS 22:00`) to make it a pinned event with RSVPs.
- **Live RSVP buttons** — 🍌 Joining / ❌ Not joining, updated in place on the pinned message.
- **Squad capped at 5** — locks with a hype message when full; drop out to reopen a seat.
- **"Mentioned:" list** shows who hasn't replied yet, and shrinks as people RSVP.
- **Auto-pin / auto-unpin** at start time, with a **reminder 10 minutes before**.
- **AI hype phrases** (DeepSeek, optional) when the squad fills and in the reminder.
- **Auto match results** — polls FACEIT and posts finished matches with K/D/A, ADR, per-player Elo ↑/↓ and team Elo, plus an AI win/loss line that reacts to the match stats (top fraggers, aces, clutches, comebacks, overtime).
- **Timezone** — all event times parsed and shown in `Europe/Kyiv`.
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
| `FACEIT_POLL_MINUTES` | How often to check for new matches (default `20`, min `5`) |
| `LANGUAGE` | `EN` or `UA` (default `EN`) |
| `DATA_DIR` | SQLite location (`/app/data` in production) |

- **Production:** set these in your JustRunMy.App app's **Settings** tab (see [Deployment](#deployment)).
- **Local dev:** copy [`.env.example`](.env.example) to `.env`, then run `node --env-file=.env bot.js`.

## Deployment

Hosted on [JustRunMy.App](https://justrunmy.app/telegram-bots) (always-on containers, free tier). Create an app → **Deploy from Git**, set the env vars above, and mount a persistent volume at `/app/data`.

**Release** with `npm run release` — it bumps `package.json`, commits, tags, and pushes the tag, which triggers a [GitHub Action](.github/workflows/deploy.yml) that deploys and drafts the release notes:

```bash
npm run release         # patch: 2.3.7 -> 2.3.8
npm run release:minor   # 2.3.7 -> 2.4.0
npm run release:major   # 2.3.7 -> 3.0.0
```

The version is bumped in the same commit that gets tagged, so `master` never accumulates a trailing "sync version" commit.

Requires one repo secret `JUSTRUNMY_DEPLOY_URL` = `https://<user>:<token>@justrunmy.app/git/<repo-id>`.

### Manage from your editor (MCP, optional)

[`.mcp.json`](.mcp.json) connects the [JustRunMy.App MCP server](https://justrunmy.app/mcp) for managing the app (logs, env vars, deploy) from an MCP-capable editor.

1. Get your token from the [MCP tool config panel](https://justrunmy.app/panel/mcp-tool-config) and add it to `.env` as `JUSTRUNMYAPP_X_USER_IDENTITY`.
2. Load `.env` before launching your editor (MCP reads the shell environment, not `.env`): `set -a && source .env && set +a`.

## License

[MIT](LICENSE)
