# EVO Events

A Telegram bot that organizes CS2 sessions for a group of friends: it mentions everyone, collects
RSVPs on a pinned message, reminds the squad before the match, and posts the FACEIT scoreboard
afterwards with an AI-written line about how it went.

Built for one group of about five players, and every decision assumes that: no admin panel, no test
suite, one SQLite file on one volume.

Interface language is **Ukrainian**. Code and comments are English.

**Stack:** TypeScript on Node 24 (run directly, no build step — Node strips the types),
[grammY](https://grammy.dev/) for Telegram, built-in `node:sqlite` for storage, DeepSeek for the
phrases. Two runtime dependencies total.

## What it does

**Events.** `@all CS 22:00` mentions everyone on the list, pins a message with 🍌 Joining / ❌ Not
joining buttons, and schedules the rest. RSVPs update the pinned message in place, and a "Mentioned:"
block names whoever hasn't answered yet. The squad caps at five — the Joining button disappears at
5/5 and a hype line locks it in; dropping out reopens the seat. Ten minutes before start, a reminder
goes out — only if at least two people are in — naming whoever is still undecided. At start time the
event unpins and the buttons come off. Several events can be live at once, each with its own RSVPs
and schedule.

`@all CS` with no time just mentions people. Nothing is pinned, nothing is scheduled.

**Match results.** Finished matches post automatically: scoreboard with K/D/A, ADR, per-player Elo
with the delta, team Elo, the map image, and one AI-written line about that match.

**The AI line** picks its own subject. On a win the model gets every player's full stat line, so the
shoutout can land on a knife kill, a pile of grenade damage or a lone Zeus rather than always the top
fragger, and roughly one call in three invites it to tease someone instead. On a loss our roster is
never sent at all: the subject is either the opposition — one real number of theirs, rolled from
everything their team did — or the squad as a whole, roasting itself. Never one of us by name.

**Its tone is rolled too**, not left to the model: a win comes out deadpan or shamelessly loud, a
loss is played as straight-faced melodrama, and a hype line is a tactical briefing, a commentator
losing his voice, or quiet menace. Hype also knows roughly how long until kick-off — in words, never
a number, since the real time is printed right above it.

Times display in both 🇺🇦 Kyiv and 🇪🇺 CET. Slash commands are hidden from the group by Telegram, and
every hint, error and confirmation is sent privately, so the chat stays clean.

## Commands

| Trigger | Effect |
|---|---|
| `@all CS 22:00` | Mention everyone, pin an event with RSVP buttons, schedule reminder and unpin |
| `@all CS` | Mention everyone only — no time, no event |
| `/cancel` | Cancel an active event. With more than one live, reply it to the event you mean |
| `/mute` · `/unmute` | Opt out of / into `@all` mentions |
| `/faceit <nickname>` | Link a FACEIT account. A typo comes back as tap-to-copy suggestions |
| `/faceit` | Show which account you're linked to |
| `/faceit off` | Unlink |
| `/help` | The `@all` syntax — the one thing the `/` menu can't list, since `@all` isn't a command |

Commands work in groups only and are case-insensitive. The `/` menu is published on every boot and
**overwrites whatever is in BotFather**.

## Running it

You need Node 24+, a bot token, and two settings on the bot itself:

- **Privacy mode off** — BotFather → `/setprivacy` → your bot → Disable. Without this the bot never
  sees `@all`, because Telegram only forwards commands to a privacy-mode bot.
- **Admin in the group**, with *Pin Messages* and *Delete Messages*.

```bash
git clone https://github.com/olekpuchka/EVO-events.git
cd EVO-events
npm install
cp .env.example .env          # fill in BOT_TOKEN
node --env-file=.env bot.ts
```

The SQLite file is created at `app/data/` on first run (gitignored). `npm run dev` restarts on
change; `npm run typecheck` is the only check there is.

**The mention list starts empty.** The Bot API cannot enumerate a group's members, so people add
themselves with `/unmute` — until someone does, `@all` has nobody to mention and says so.

## Configuration

Everything is set through environment variables, all read in one place,
[`src/config.ts`](src/config.ts).

**Secrets** — supply at runtime (`.env` locally, host settings in production), never as a Dockerfile
`ENV`: that is baked into the image and readable with `docker history`.

| Variable | Notes |
|---|---|
| `BOT_TOKEN` | Required. The process exits at startup without it |
| `FACEIT_API_KEY` | Required for match results ([developers.faceit.com](https://developers.faceit.com)). Without it the bot starts, warns, and every poll 401s |
| `DEEPSEEK_API_KEY` | Optional. Unset means built-in phrases instead of AI |

**Everything else** is defaulted, so the bot runs with no configuration at all.

| Variable | Default | Notes |
|---|---|---|
| `DATA_DIR` | `/app/data` in the image, `app/data` locally | Where `members.db` goes |
| `FACEIT_POLL_MINUTES` | `20` | How often to check for finished matches (minimum `5`) |
| `EU_TIMEZONE_MEMBERS` | empty | Comma-separated user IDs whose typed times mean CET rather than Kyiv |

> A Dockerfile `ENV` beats the default in `src/config.ts`, so changing one alone won't reach the
> container — change both.

## Project structure

```
bot.ts              composition root — config checks, handlers, scheduler, shutdown
src/
  config.ts         every process.env read in the project
  log.ts            timestamps on console output
  types.ts          shared SQLite row and FACEIT response shapes
  adapters/         one module per external system — db, faceit, ai
  view/             data → strings; no I/O, no Telegram context
  handlers/         Telegram entry points — events, results, guards
```

One rule holds it together: **exactly one module talks to each external system.** Nothing outside
`adapters/faceit.ts` calls `fetch`, nothing outside `adapters/db.ts` imports `node:sqlite`, nothing
outside `adapters/ai.ts` builds an LLM client. `view/` imports no adapter and no handler, which keeps
it importable on its own — `adapters/db.ts` creates the database at import time.

## Deploying

Hosted on [JustRunMy.App](https://justrunmy.app/telegram-bots) — always-on container, free tier.
Deploy from Git, set `BOT_TOKEN` and `FACEIT_API_KEY`, and mount a persistent volume at `/app/data`.
Deploying from CI needs one repo secret, `JUSTRUNMY_DEPLOY_URL` =
`https://<user>:<token>@justrunmy.app/git/<repo-id>`.

**Any push to `main` deploys**, via the [Deploy workflow](.github/workflows/deploy.yml), which
typechecks first. Merging a PR is the release, and `main` is always what's live. There are no tags
and no changelog — `package.json` plus the merge commit is the record. To roll back, run Deploy
manually from the Actions tab against the commit SHA you want.

## Contributing

Branch, open a PR against `main`, let [CI](.github/workflows/ci.yml) typecheck it. Merging deploys to
production, so keep `main` green — run `npm run typecheck` before you push.

Since the merge is the release, fold the version bump into the change's own commit rather than a
separate `chore: release`:

```bash
npm version <patch|minor|major> --no-git-tag-version   # bumps package.json + lock, no commit, no tag
git commit -am "feat: ..."                             # change and bump together
```

[CLAUDE.md](CLAUDE.md) documents the decisions behind the non-obvious parts, and the traps worth
knowing before you change them: there are no schema migrations, the AI prompt and its output checks
are deliberately split across three modules, and several behaviours that read as bugs are intentional.

## License

[MIT](LICENSE)
