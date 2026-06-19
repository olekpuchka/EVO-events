# EVO Events Telegram Bot

A Telegram group bot for organizing gaming events. Mention everyone with `@all`, collect RSVPs, send reminders, and auto-unpin after the event.

Built with [grammY](https://grammy.dev/) and Node.js (SQLite for persistence).

## Features

- Mention all group members with `@all`
- Attach an event name and time: `@all CS 22:00` or `@all CS 22-00`
- **RSVP buttons** — 🍌 Joining / 🚫 Not joining, live-updated on the pinned message (only for timed events); tapping the same button twice is a no-op — message is only edited when the status actually changes
- **Poster auto-joins** — the person who posts the event is automatically RSVPed as joining
- **Squad cap at 5** — buttons hidden and event locked with a random hype message when 5 people join; the cap is enforced server-side, so a tap on a stale (not-yet-synced) join button can't push the squad past 5
- **Random hype phrases** — shared pool used both when the squad fills up and at the reminder; phrase is frozen when the reminder fires so it doesn't change on subsequent RSVP edits
- **Auto-pin** the event message (silently — no "pinned" push notification), **auto-unpin** exactly at event start time
- **One active event at a time** — posting while an event is active shows a temporary notice linking to it
- **Reminder** sent 10 minutes before the event (skipped if fewer than 2 people joined)
- **Reminder stays live** — if someone RSVPs after the reminder is sent, the reminder message is updated with the current joining list
- **Reminder auto-deleted** when the event ends or is cancelled
- **Cancel** any active event with `/cancel` — unpins, deletes the event message and the reminder if one was sent
- **Auto-deletes** the "pinned a message" service notification Telegram sends
- All times interpreted and displayed in **Kyiv (Europe/Kyiv) timezone**
- Opt-in/out with `/unmute` and `/mute` — bot replies auto-delete after 10 seconds
- Handles large groups by splitting long mention lists across multiple messages

## Commands

| Trigger | Effect |
|---|---|
| `@all CS 22:00` or `@all CS 22-00` | Mentions all, pins event with RSVP buttons, schedules reminder & unpin |
| `@all CS` | Mentions all without pinning or RSVP (no time = no event) |
| `/cancel` | Cancel the current active event (unpins + deletes event message + deletes reminder if sent) — **any group member can cancel**, no admin check |
| `/mute` | Opt out of @all mentions |
| `/unmute` | Opt into @all mentions |
| `/faceit <nickname>` | Link your FACEIT account — validates against the API and saves your Elo |
| *(auto)* | Match results are posted automatically — the bot polls FACEIT every 15 minutes and posts any new finished match showing all registered group members who played, sorted by ADR, with K/D/A, ADR and team Elo |

## Event lifecycle

1. `@all CS 22:00` → bot posts pinned message with RSVP buttons, auto-RSVPs poster as 🍌 joining, deletes trigger message
2. Members tap 🍌 / 🚫 — message updates live with names and counts
3. At 5 joiners → buttons hidden, squad locked 🔒 with a random hype message (further joins from stale clients are rejected)
4. **21:50 Kyiv** → reminder sent with joining list and a random hype phrase (skipped if fewer than 2 joined); any RSVP after this point also updates the reminder message (phrase stays frozen)
5. **22:00 Kyiv** → reminder deleted, message unpinned, buttons removed, DB cleaned up

If no time is given (`@all CS`), the bot mentions everyone but does not pin, track RSVPs, or lock the queue.

## Setup

### Requirements

- **Node.js 24+** (uses built-in `node:sqlite`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Privacy mode **disabled** so the bot can read `@all` messages

### Enabling `@all` text trigger

1. Open [@BotFather](https://t.me/BotFather)
2. Send `/setprivacy` → select your bot → choose **Disable**

## Deployment (JustRunMy.App)

[JustRunMy.App](https://justrunmy.app/telegram-bots) offers always-on container hosting with a free tier.

### Initial setup

1. Create a new app → **Deploy from Git**
2. In **Environment**, set:
   - `BOT_TOKEN` = your Telegram bot token
   - `DATA_DIR` = `/app/data`
   - `FACEIT_API_KEY` = your FACEIT API key (get one free at [developers.faceit.com](https://developers.faceit.com))
   - `FACEIT_POLL_MINUTES` = how often to auto-check for new matches (default: `15`, minimum: `5`)
3. Mount a persistent volume at `/app/data`

### Automated deploy via GitHub Actions

Pushing a `v*` tag triggers the [deploy workflow](.github/workflows/deploy.yml), which pushes to JustRunMy.App automatically.

**One-time GitHub setup** — add a repository secret:

| Secret | Value |
|---|---|
| `JUSTRUNMY_DEPLOY_URL` | `https://<user>:<token>@justrunmy.app/git/<repo-id>` |

Then release:

```bash
git tag v1.2.3
git push origin v1.2.3
```

### Manual deploy

```bash
git push --force <jrma-remote> HEAD:deploy
```

## Project Structure

```
EVO-events/
├── .github/
│   └── workflows/
│       └── deploy.yml # Auto-deploy to JustRunMy.App on v* tag push
├── src/
│   ├── db.js          # SQLite — members, events, RSVPs, scheduled jobs
│   ├── faceit.js      # FACEIT API client — player lookup, match history, stats, map images
│   ├── handlers.js    # mentionAll, handleRsvp, cancelEvent, mute/unmute, sendReminder, registerFaceit, autoPostResult
│   └── helpers.js     # buildMention, escapeHtml, splitIntoChunks, autoDelete
├── bot.js             # Entry point — commands, scheduler loop, graceful shutdown
├── Dockerfile
├── .dockerignore
├── package.json
├── .nvmrc
├── .gitignore
└── README.md
```

## Known limitations

- **`/cancel` is not admin-gated** — any group member can cancel the active event, not just admins. Suitable for trusted groups; add a `getChatMember` admin check if you need tighter control.
- **No rate limiting on `@all`** — any member can post events. Designed for small, trusted gaming groups.
- **Timezone is hard-coded to `Europe/Kyiv`** — event times are always parsed and displayed in that zone.
- **Single active event per chat** — a second `@all <time>` is blocked until the first event ends or is cancelled.

## License

[MIT](LICENSE)
