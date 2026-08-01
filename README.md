# EVO Events Telegram Bot

A Telegram group bot for organizing gaming sessions — mention everyone with `@all`, collect RSVPs on a pinned message, send reminders, and auto-post FACEIT match results.

Built with [grammY](https://grammy.dev/) in TypeScript, storing everything in built-in SQLite. Node 24 runs the source directly via native type-stripping, so there is no build step.

## Features

- **`@all <message>`** pings everyone. Add a time (`@all CS 22:00`) and it becomes a pinned event with RSVP buttons.
- **Live RSVPs** — 🍌 Joining / ❌ Not joining, updated in place on the pinned message.
- **Squad capped at 5** — locks with a hype line when full; drop out to reopen a seat.
- **"Mentioned:" list** names who hasn't answered yet and shrinks as they do.
- **Reminder 10 minutes before** start, once at least two people are in, with a last call naming whoever is still undecided. Auto-unpins at start time.
- **Parallel events** — 20:00 and 22:00 can run at once, each with its own RSVPs, reminder and unpin.
- **FACEIT results** post automatically: K/D/A, ADR, per-player Elo ↑/↓, team Elo, and an AI line that reacts to the actual match. A win picks its own shoutout from every player's full stat line, so it can land on a knife kill, 606 utility damage or a lone Zeus rather than only the top fragger. A loss turns outward instead — it never names our own players, and roasts the opponents' suspiciously good aim using their real numbers.
- **AI hype phrases** (DeepSeek, optional) when the squad fills and in the reminder — one per event, so a drop-out and re-fill keeps the same line.
- **Two timezones** — event times show 🇺🇦 Kyiv and 🇪🇺 CET side by side.
- **Quiet by default** — slash commands are hidden from everyone but the sender, and hints, errors and confirmations reply privately.
- **English or Ukrainian.**

## Commands

| Trigger | Effect |
|---|---|
| `@all CS 22:00` | Mention everyone, pin an event with RSVP buttons, schedule the reminder and unpin |
| `@all CS` | Mention everyone only — no time, no event |
| `/cancel` | Cancel an active event. With more than one live, reply it to the event you mean |
| `/mute` · `/unmute` | Opt out of / into `@all` mentions |
| `/faceit <nickname>` | Link your FACEIT account so you appear in match results. A typo comes back as tap-to-copy suggestions |
| `/faceit` | Show which account you're linked to |
| `/faceit off` | Unlink |
| `/help` | The `@all` syntax — the one thing the `/` menu can't list, since `@all` isn't a slash command |

Commands are case-insensitive and work in groups only. The `/` menu is published from [bot.ts](bot.ts) at startup and overwrites anything set in BotFather.

## Quick start

Requires **Node.js 24+**, a token from [@BotFather](https://t.me/BotFather), and privacy mode **disabled** (`/setprivacy` → your bot → Disable) so the bot can see `@all`.

```bash
git clone https://github.com/olekpuchka/EVO-events.git
cd EVO-events
npm install
cp .env.example .env          # fill in BOT_TOKEN
node --env-file=.env bot.ts
```

The database is created at `app/data/` inside the project (gitignored) — nothing to set up.

## Configuration

Everything is configured through environment variables. All of them are read in one place, [`src/config.ts`](src/config.ts).

**Secrets** — supply at runtime: JustRunMy.App → **Settings** in production, `.env` locally. Never put these in the Dockerfile; `ENV` is baked into the image and readable by anyone who has it.

| Variable | Notes |
|---|---|
| `BOT_TOKEN` | Required — the bot exits at startup without it |
| `FACEIT_API_KEY` | Required for match results, from [developers.faceit.com](https://developers.faceit.com). Without it the bot still starts and every poll 401s |
| `DEEPSEEK_API_KEY` | Optional — AI phrases. Built-in phrases are used if unset |

**Everything else** has a default in the [Dockerfile](Dockerfile), so the bot runs unconfigured.

| Variable | Default | Notes |
|---|---|---|
| `DATA_DIR` | `/app/data` in the image, `app/data` locally | SQLite location |
| `LANGUAGE` | `UA` | `EN` or `UA` |
| `FACEIT_POLL_MINUTES` | `20` | How often to check for finished matches (minimum `5`) |
| `EU_TIMEZONE_MEMBERS` | empty | Comma-separated user IDs whose typed times mean 🇪🇺 CET rather than 🇺🇦 Kyiv |

> A Dockerfile `ENV` beats the fallback in `src/config.ts`, so changing a default in code alone won't reach the container — **change both**.

## Project structure

```
bot.ts              composition root — config, handler registration, scheduler, shutdown
src/
  config.ts         every process.env read in the project
  log.ts            timestamps on console output
  types.ts          shared SQLite row and FACEIT response shapes
  adapters/         one module per external system
    db.ts             SQLite
    faceit.ts         FACEIT Data API
    ai.ts             DeepSeek call, retry, fallback (deepseek-v4-pro, thinking off)
  view/             data → strings; no I/O, no Telegram context
    html.ts           escaping and mentions
    i18n.ts           EN/UA copy
    render.ts         event text, reminders, keyboards
    eventtime.ts      parsing "22:00", rendering both timezones
    prompt.ts         system prompt, angle roulette, match facts → prompt text
    phrase.ts         sanitizing, the checks a reply must pass, emoji
  handlers/         Telegram entry points
    events.ts         @all, RSVP, /cancel, /mute, /faceit, reminders
    results.ts        FACEIT poll → scoreboard
    guards.ts         group-only wrapper, private replies, trigger cleanup
```

One rule holds it together: **exactly one module talks to each external system.** Nothing outside `adapters/faceit.ts` calls `fetch`, nothing outside `adapters/db.ts` imports `node:sqlite`, nothing outside `adapters/ai.ts` builds an LLM client. Nothing points back up either — `view/` imports no adapter and no handler. The sideways edges all run `adapters/ai.ts` → `view/`: `i18n.ts` for fallback phrases, `prompt.ts` for what to ask, `phrase.ts` for judging the reply.

That keeps `view/` importable on its own, which matters because `adapters/db.ts` opens the database and creates tables **at import time** — importing it, directly or not, creates a SQLite file as a side effect. Pure logic belongs in `view/`.

## Deployment

Hosted on [JustRunMy.App](https://justrunmy.app/telegram-bots) (always-on containers, free tier). Create an app → **Deploy from Git**, set `BOT_TOKEN` and `FACEIT_API_KEY`, and mount a persistent volume at `/app/data`. Add `DEEPSEEK_API_KEY` too unless you want the built-in phrases — without it the bot starts fine and posts the same three canned lines forever.

Any push to `main` deploys via the [Deploy workflow](.github/workflows/deploy.yml), which typechecks first — so merging a PR is a release, and `main` is always what's live. Tags deliberately don't trigger it: the host rebuilds on every push, so a tag trigger deployed each release twice.

Fold the version bump into the change's own commit, so `main` never collects a separate "chore: release":

```bash
npm version minor --no-git-tag-version   # bump package.json + lock, no commit or tag
git commit -am "feat: ..."               # change and bump in one commit
# open a PR, let CI pass, merge — the merge deploys
```

To roll back, run Deploy manually from the **Actions** tab against the commit SHA you want. Requires one repo secret, `JUSTRUNMY_DEPLOY_URL` = `https://<user>:<token>@justrunmy.app/git/<repo-id>`.

## Contributing

Branch, open a PR against `main`, and let [CI](.github/workflows/ci.yml) typecheck it. Merging deploys to production, so keep `main` green — run `npm run typecheck` before pushing. There is no test suite; typecheck is the whole gate.

`@types/node` is pinned to **24.x** on purpose — its major tracks the Node runtime major, so `npm outdated`'s offer of 26.x would typecheck against APIs the runtime doesn't have.

[CLAUDE.md](CLAUDE.md) documents the decisions behind the non-obvious parts.

## License

[MIT](LICENSE)
