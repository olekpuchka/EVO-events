# EVO Events

A Telegram bot that organizes CS2 sessions for a group of friends: it mentions everyone, collects
RSVPs on a pinned message, reminds the squad before the match, and posts the FACEIT scoreboard
afterwards — rating, swing and the Elo each player won or lost.

Built for one group of about five players, and every decision assumes that: no admin panel, one
SQLite file on one volume.

Interface language is **Ukrainian**. Code and comments are English.

**Stack:** TypeScript on Node 24 (run directly, no build step — Node strips the types),
[grammY](https://grammy.dev/) for Telegram, built-in `node:sqlite` for storage,
[node-tls-client](https://github.com/Sahil1337/node-tls-client) for faceit.com's own scoreboard, and
DeepSeek for birthday toasts, and [satori](https://github.com/vercel/satori) with
[resvg](https://github.com/thx/resvg-js) to draw the result card.

## What it does

**Events.** `@all CS 22:00` mentions everyone on the list, pins a message with 🍌 Joining / ❌ Not
joining buttons, and schedules the rest. RSVPs update the pinned message in place, and a "Mentioned:"
block names whoever hasn't answered yet. The squad caps at five — the Joining button disappears at
5/5, and dropping out reopens the seat. Ten minutes before start, a reminder
goes out — only if at least two people are in — naming whoever is still undecided. At start time the
event unpins and the buttons come off. Several events can be live at once, each with its own RSVPs
and schedule.

`@all CS` with no time just mentions people. Nothing is pinned, nothing is scheduled.

**Match results.** Finished matches post automatically as a picture: the score across the map, both
teams' Elo, and a table sorted by FACEIT rating — each player with their Elo and that match's change
(↑25 / ↓23 / ±0), their rating (gold from 1.80, green from 1.30, white from 0.90, red below) and
swing, and their K/D/A and ADR. On a win the top rating gets a gold MVP star and is the only bold
row. The FACEIT link rides in the caption. If the picture can't be drawn, the same result posts as
Telegram's own rich table. Only matches **two or more** linked members played in — solo queue stays
off the group's feed.

Rating, swing and the exact per-match Elo change come from faceit.com's own scoreboard, which the
open FACEIT API doesn't carry. That fetch is **best-effort**: when it fails, the post still goes out,
without the Rating column and without the Elo lines.

**Birthdays.** Members add their own date with `/birthday 25-08-1990`, and on the day the bot posts
a short toast written for them — 70 words at most, and the only AI-written message the bot sends.
The model is told only the age they're turning; the name reaches it as a placeholder and is swapped
in afterwards. It's told at length to invent nothing else: no remembered clutch, no stat, no match
that never happened. Greetings go out from 09:00 🇺🇦 Kyiv, and a 29 February birthday is greeted on
the 28th in a non-leap year.

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
| `/birthday <dd-mm-yyyy>` | Save your birthday, so the group gets a toast on the day. `5-3-1990` works too |
| `/birthday` | Show the date you saved |
| `/birthday off` | Remove it |
| `/help` | The `@all` syntax — the one thing the `/` menu can't list, since `@all` isn't a command — plus every command and where a newcomer starts. Shown only to you, as a rich message with a tappable command table |
| *someone joins* | A welcome naming them and the group, pointing at `/help`. Joining alone doesn't opt anyone into `@all` — that stays `/unmute` |

Commands work in groups only and are case-insensitive. The `/` menu is published on every boot and
**overwrites whatever is in BotFather**. `/help` prints its list from that same registry, so the
two can't disagree.

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

The SQLite file is created at `app/data/` on first run (gitignored). The first match post also
downloads `node-tls-client`'s native library into your temp directory; the Docker image ships it
pre-installed instead. `npm run dev` restarts on change; `npm run typecheck` is the
check. `npm run card:preview` draws a sample result card into `card-preview/` (`card.html` and
`card.png`); add `-- --send=<chat id>` with `BOT_TOKEN` set to post it to a chat.

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
| `DEEPSEEK_API_KEY` | Optional, for birthday toasts. Unset means a built-in toast instead of an AI one |

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
  adapters/         one module per external system — db, faceit (open API + faceit.com), ai
  view/             data → strings; no I/O, no Telegram context
  handlers/         Telegram entry points — events, results, birthdays, guards
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

Branch, open a PR against `main`, let [CI](.github/workflows/ci.yml) typecheck it. Merging
deploys to production, so keep `main` green — run `npm run typecheck` before you push.

Since the merge is the release, fold the version bump into the change's own commit rather than a
separate `chore: release`:

```bash
npm version <patch|minor|major> --no-git-tag-version   # bumps package.json + lock, no commit, no tag
git commit -am "feat: ..."                             # change and bump together
```

[CLAUDE.md](CLAUDE.md) documents the decisions behind the non-obvious parts, and the traps worth
knowing before you change them: there are no schema migrations (which is why birthdays live in a
table of their own), the birthday prompt and its output checks are deliberately split across three modules,
and several behaviours that read as bugs are intentional.

## License

[MIT](LICENSE)
