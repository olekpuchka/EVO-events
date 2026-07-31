# EVO Events Bot

## Config defaults

Optional env vars are defaulted in **two** places: the fallback in `src/` and an `ENV` line in the
Dockerfile. An `ENV` wins at runtime, so changing a code default alone never reaches the container
— **change both**. Nothing enforces this; it was judged not worth a CI check at this size.

`DATA_DIR` is the deliberate exception: `/app/data` in the image (the volume mount), `app/data`
inside the project locally.

## Command menu

Telegram's command registry is published from `bot.ts` on every boot. BotFather is **not** the
source of truth — anything set there is overwritten on the next deploy.

A command lives in **two** places: its `bot.command(...)` handler and the `GROUP_COMMANDS` list.
Adding or renaming one means changing both, plus a `cmd*` key in **both** languages in
`src/i18n.ts` — `t()` falls back to `EN` with only a console warning, so a missing `UA`
description ships English rather than failing.

That cost is why a secondary action is an **argument**, not a command: `/faceit off` unlinks, and
`/faceit` with no argument reports the current link. Both live inside the one handler, so neither
spends a menu row or a second pair of descriptions. Reach for an argument first.

Only `all_group_chats` is published; the `default` scope is cleared alongside it. That is what
leaves DMs with no menu, and it's deliberate — every command returns early in a private chat.
Don't restore it.

Every command is published `is_ephemeral`, so Telegram hides the invoking `/command` from everyone
but its sender. Such a message arrives with **`message_id: 0`**, which `ctx.deleteMessage()`
rejects — a handler must never delete its own trigger directly. Use `deleteTrigger()` from
`src/helpers.ts`: it skips an ephemeral trigger and still removes a plainly-sent one (`@all`, which
can never be ephemeral, or a client ignoring the flag).

## Rich messages

`sendRichMessage` takes real headings, lists and tables — but it has **no `receiver_user_id`**, so a
rich message can't be sent privately the way `sendEphemeral()` sends everything else. That rules it
out for anything personal: help, usage hints, errors, confirmations. Use it only for output the whole
group is meant to see, which today means the match scoreboard. `/help` was tried as a rich table and
reverted for exactly this reason.

The payload nests: `rich_message: { blocks: [...] }`. grammY's `sendRichMessage(chatId, { blocks })`
passes that object as the second positional argument, so the `{ blocks }` shape at the call site is
already correct — a raw HTTP call putting `blocks` at the top level gets "rich message must be
non-empty".

## Schema

`src/db.ts` creates tables with `CREATE TABLE IF NOT EXISTS` and nothing else — there is no
migration step. Adding a column to an existing table therefore does **not** reach the `members.db`
on the mounted volume, and every `db.prepare` naming it throws at boot. So a new column needs a
migration guard written first. This is why the FACEIT nickname is fetched live rather than stored,
and why hype phrases stay in memory.

## Hype phrases

A DeepSeek call takes **4–9 seconds** (thinking mode, no timeout) — measured, not guessed. Never
`await` one in front of a user-visible update: `sendReminder` reads its roster *after* the phrase
for exactly this reason, and the locked-squad edit in `handleRsvp` still pays the delay before the
message shows 5/5.

A phrase is frozen per event and deliberately **not** regenerated when a squad drops below full and
refills — same event, same squad, and a re-hype costs another call plus that delay. `endEvent` is
the only thing that clears it; don't add a delete on the not-full branch. Both caches are in-memory,
so a redeploy mid-event re-hypes on the next tap. Persisting them would need a new column, which
the schema can't take — see **Schema**.

## FACEIT links

Two writers, deliberately not one. `setFaceitAccount` sets the link and expresses a user's
explicit intent; `setFaceitElo` only advances the Elo delta baseline, and its `WHERE
faceit_player_id = ?` is what stops the 20-minute poll from resurrecting a link that `/faceit off`
removed mid-poll. The poll must never call the former — its roster is a snapshot from poll start,
so it would write back an id the user has since cleared. Nothing enforces this but the names.

## CI

`.github/workflows/ci.yml` typechecks every PR into `main`. Deploy typechecks again before
shipping, so a red CI means the merge would fail to deploy too.

## Releasing

**Any push to `main` deploys** (`.github/workflows/deploy.yml`) — that's the only automatic
trigger, so `main` is always exactly what's live. Merging a PR is a release.

Tags do **not** trigger anything. JustRunMy.App rebuilds and restarts on every push to its
remote and never fast-forwards, so a `v*` trigger meant `git push --follow-tags` deployed
the same commit twice and restarted the bot twice. Don't add one back.

To release: fold the version bump into the change's own commit (**never** a separate
`chore: release` commit), open a PR, let CI pass, merge. The merge deploys.

1. `npm version <patch|minor|major> --no-git-tag-version` — bumps `package.json` +
   `package-lock.json` without committing or tagging.
2. Commit the change + bump together, with a descriptive message, on a branch.
3. Open a PR, let CI pass, merge — the merge deploys.

We don't tag releases — `package.json` plus the merge commit on `main` is the whole record.

**To roll back or re-deploy an old version:** run the Deploy workflow manually from the
Actions tab (`workflow_dispatch`) against the commit SHA you want.
