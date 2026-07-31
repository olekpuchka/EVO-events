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
