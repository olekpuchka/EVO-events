# EVO Events Telegram Bot

A Telegram group bot for organizing gaming events. Mention everyone with `@all`, collect RSVPs, send reminders, and auto-unpin after the event.

Built with [grammY](https://grammy.dev/) and Node.js (SQLite for persistence).

## Features

- Mention all group members with `@all`
- Attach an event name and time: `@all CS 22:00` or `@all CS 22-00`
- **RSVP buttons** — 🍌 Joining / ❌ Not joining, live-updated on the pinned message (only for timed events); tapping the same button twice is a no-op — message is only edited when the status actually changes
- **Poster auto-joins** — the person who posts the event is automatically RSVPed as joining; they are excluded from the "Mentioned:" list since they're already the sender
- **"Mentioned:" list shows who hasn't replied yet** — on timed events, tapping 🍌 or ❌ removes you from the "Mentioned:" list (you now show under Joining / Not joining instead). Once everyone has replied, the list disappears. Muted members are never listed
- **Priority notifications** — both the `@all` message and the 10-minute reminder use `text_mention` entities, so they trigger iOS priority notifications even when the group is muted
- **Squad cap at 5** — the 🍌 Joining button is removed and the event is locked with a random hype message when 5 people join; the cap is enforced server-side, so a tap on a stale (not-yet-synced) join button can't push the squad past 5
- **Drop out when full** — the ❌ Not joining button stays visible at 5/5 so a locked-in player who can no longer make it can free their seat; dropping out takes the count back below the cap, which removes the lock/hype message and restores the 🍌 Joining button for everyone else
- **AI-generated hype phrases** — generated via DeepSeek (`deepseek-v4-flash`) using the event name as context; shown in the pinned event message when the squad fills up and in the 10-minute reminder (the RSVP tap confirmation toast stays a plain join/not-joining acknowledgment, so re-fills don't repeat the hype); the pinned-message phrase is frozen the moment the squad first fills, so later RSVP edits while still 5/5 (e.g. a non-player tapping "not joining") reuse it instead of generating a new line — it only re-hypes if the squad drops below 5 and refills; the reminder phrase is likewise frozen when the reminder fires; falls back to a built-in pool if `DEEPSEEK_API_KEY` is not set
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
| *(auto)* | Match results are posted automatically — the bot polls FACEIT every 20 minutes and posts any new finished match showing all registered group members who played, sorted by ADR, with K/D/A, ADR, per-player Elo with ↑/↓ delta, and team Elo; per-player Elo is fetched only for members who actually played the match; each result includes an AI-generated win/loss phrase (context-aware: map, Elo gap, standout ADR players); deduplication records are pruned after 30 days |

All slash commands (`/mute`, `/unmute`, `/cancel`, `/faceit`) are **case-insensitive** — e.g. `/FACEIT`, `/Cancel`, and `/MUTE` all work (a middleware lowercases the command before matching; arguments keep their original casing).

## Event lifecycle

1. `@all CS 22:00` → bot posts pinned message with RSVP buttons, auto-RSVPs poster as 🍌 joining, deletes trigger message
2. Members tap 🍌 / ❌ — names and counts update live, and each person who replies drops off the "Mentioned:" list (which disappears once everyone has replied)
3. At 5 joiners → 🍌 Joining button removed, squad locked 🔒 with a random hype message (further joins from stale clients are rejected); ❌ Not joining stays available so a joined player can drop out and reopen a seat — doing so clears the lock and restores the join button
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
   - `FACEIT_POLL_MINUTES` = how often to auto-check for new matches (default: `20`, minimum: `5`)
   - `DEEPSEEK_API_KEY` = *(optional)* DeepSeek API key for AI-generated hype and match phrases — bot works without it, falling back to built-in phrases (get one at [platform.deepseek.com](https://platform.deepseek.com))
   - `LANGUAGE` = *(optional)* `EN` or `UA` — sets the language for all bot messages, button labels, and AI-generated phrases (default: `EN`)
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
│   ├── faceit.js      # FACEIT API client — player lookup, match history, stats, map images (retries rate-limits/5xx with backoff)
│   ├── handlers.js    # mentionAll, handleRsvp, cancelEvent, mute/unmute, sendReminder, registerFaceit, autoPostResult
│   ├── helpers.js     # buildMention, escapeHtml, splitIntoChunks, autoDelete
│   └── i18n.js        # Centralized labels (EN/UA), selected via LANGUAGE env var
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
