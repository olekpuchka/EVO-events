# EVO Events Bot

## Layout

```
bot.ts              composition root — config checks, handler registration, scheduler, shutdown
src/config.ts       every process.env read in the project
src/log.ts          timestamps on console
src/types.ts        shared row + API shapes
src/adapters/       one module per external system: db (SQLite), faceit (HTTP), ai (DeepSeek)
src/view/           data → strings: html, i18n, render, eventtime, prompt, phrase
src/handlers/       Telegram entry points: events, results, guards
```

**Exactly one module talks to each external system**: nothing outside `adapters/faceit.ts` calls
`fetch`, nothing outside `adapters/db.ts` imports `node:sqlite`, nothing outside `adapters/ai.ts`
constructs an LLM client. Nothing points back up either — `view/` imports no adapter and no
handler. The sideways edges all run `adapters/ai.ts` → `view/`: `i18n.ts` for the fallback phrases,
`prompt.ts` for what to ask, `phrase.ts` for judging the reply.

A phrase therefore crosses three modules, split by what makes each one change: `view/prompt.ts` is
jokes and tone, `view/phrase.ts` is what may not ship, and `adapters/ai.ts` is only the call, the
retry and the fallback — no wording in it at all. Adding an angle or a stat touches `prompt.ts`
alone.

That keeps `view/` importable on its own, which matters because `adapters/db.ts` opens the file and
creates tables **at import time** — importing it, directly or not, creates a database as a side
effect. Keep pure logic in `view/`.

## Config defaults

Every `process.env` read lives in `src/config.ts` — nothing else reaches for the environment.
Optional vars are defaulted in **two** places: that file and an `ENV` line in the Dockerfile. An
`ENV` wins at runtime, so changing a code default alone never reaches the container — **change
both**. Nothing enforces this; it was judged not worth a CI check at this size.

`DATA_DIR` is the deliberate exception: `/app/data` in the image (the volume mount), `app/data`
inside the project locally.

## Command menu

Telegram's command registry is published from `bot.ts` on every boot. BotFather is **not** the
source of truth — anything set there is overwritten on the next deploy.

A command lives in **two** places: its `bot.command(...)` handler and the `GROUP_COMMANDS` list.
Adding or renaming one means changing both, plus a `cmd*` key in `src/view/i18n.ts`. `LABELS` is
declared with `satisfies`, not an annotation, so `t()` takes `keyof typeof LABELS` — a missing or
misspelled key fails typecheck instead of reaching the group.

That cost is why a secondary action is an **argument**, not a command: `/faceit off` unlinks, and
`/faceit` with no argument reports the current link. Both live inside the one handler, so neither
spends a menu row or a second pair of descriptions. Reach for an argument first.

Only `all_group_chats` is published; the `default` scope is cleared alongside it. That is what
leaves DMs with no menu, and it's deliberate — every command returns early in a private chat.
Don't restore it.

`groupOnly()` in `src/handlers/guards.ts` is what guarantees that early return: it answers a DM,
drops an update carrying no `from`, and hands the handler a narrowed sender. Every command and
`@all` goes through it. `handleRsvp` is the exception — a callback query has no guaranteed `chat`,
so it checks inline.

Every command is published `is_ephemeral`, so Telegram hides the invoking `/command` from everyone
but its sender. Such a message arrives with **`message_id: 0`**, which `ctx.deleteMessage()`
rejects — a handler must never delete its own trigger directly. Use `deleteTrigger()` from the
same file: it skips an ephemeral trigger and still removes a plainly-sent one (`@all`, which can
never be ephemeral, or a client ignoring the flag).

## Rich messages

`sendRichMessage` takes real headings, lists and tables — but it has **no `receiver_user_id`**, so
a rich message can't be sent privately the way `sendEphemeral()` sends everything else. That rules
it out for anything personal: help, usage hints, errors, confirmations. Use it only for output the
whole group is meant to see, which today means the match scoreboard. `/help` was tried as a rich
table and reverted for exactly this reason.

The payload nests: `rich_message: { blocks: [...] }`. grammY's `sendRichMessage(chatId, { blocks })`
passes that object as the second positional argument, so the `{ blocks }` shape at the call site is
already correct — a raw HTTP call putting `blocks` at the top level gets "rich message must be
non-empty".

## Schema

`src/adapters/db.ts` creates tables with `CREATE TABLE IF NOT EXISTS` and nothing else — there is
no migration step. Adding a column to an existing table therefore does **not** reach the
`members.db` on the mounted volume, and every `db.prepare` naming it throws at boot. A new column
needs a migration guard written first. This is why the FACEIT nickname is fetched live rather than
stored, and why hype phrases stay in memory.

The database is deliberately never closed. SQLite auto-checkpoints the WAL every 1000 pages, so it
self-caps near 4MB unaided; closing on shutdown would race the FACEIT poll and the scheduler tick,
which both outlive `bot.stop()` and would then throw on a finalized statement mid-write. An
unclosed WAL is replayed on the next open — a half-written one is not.

## The AI call

Applies to all three phrase kinds — hype, win and loss.

A DeepSeek call takes **2–3 seconds** on `deepseek-v4-pro` with `thinking` **disabled** — measured,
not guessed. Thinking is off deliberately: one 25-word joke from facts computed in code has nothing
to reason about, and it cost 10x the latency (26s median, 40s max) for no accuracy gain, over-applied
`<b>`, and could outgrow `max_tokens` with its chain and return an empty `content` — a silent
fallback. It had been switched back on once already before anyone noticed, precisely because an empty
response just looks like a fallback. Re-enabling it means paying all of that again.

`maxRetries: 0` is about **transport**: a failed call isn't worth repeating, and since `timeout` is
per attempt, retrying would double the ceiling rather than improve the odds. At 2–3s the 15s bound is
pure slack — though not a hard guarantee either, since back when thinking was on, calls of 20–40s
completed instead of aborting, so the SDK's `timeout` evidently doesn't cover the response body. Even
so, never `await` a call before a user-visible update: `sendReminder` reads its roster *after* the
phrase for exactly this reason, and the locked-squad edit in `handleRsvp` pays the delay before the
message shows 5/5 — twice over if the reply is rejected and retried, so that path's worst case is
~6s. If that ever matters, retry only the match phrases, which nobody is waiting on.

A **check rejection is retried once** — a different case from a failed call, since the API worked and
the model merely broke a rule. `generate` loops twice over `generateOnce`, and the same prompt at
temperature 0.8 usually gives a different take. Usually, not always: on a 19:16 overtime win the
model wanted to restate that score badly enough to be rejected twice in a row and fall back, so a
check that starts firing on every call for one match is a real shape to expect.

Which is why **every rejection is logged** with its reason (`[ai] win rejected (scoreline): …`) and
an empty reply logged separately. Without that, a check misfiring and the API being down look
identical from the outside — the exact trap that let `thinking` sit switched on unnoticed.

**Fallbacks are for having no AI result, not for policing output.** That's why a phrase has no length
limit: a good long message ships, and `max_tokens` is the only bound on how long. The checks that do
reject — an invented or borrowed stat, a scoreline we didn't supply, a `P`-code we never issued, Elo
when no Elo numbers were given, English in a UA message — each catch something that would read as
fact or as broken text in the group, and each gets that second attempt first.

## Hype phrases

A phrase is frozen per event and deliberately **not** regenerated when a squad drops below full and
refills — same event, same squad, and a re-hype costs another call plus that delay. `endEvent` is
the only thing that clears it; don't add a delete on the not-full branch. Both caches are in-memory,
so a redeploy mid-event re-hypes on the next tap. Persisting them would need a new column, which
the schema can't take — see **Schema**.

## Match phrases

Who gets a shoutout is the **model's** call, not the code's. There used to be an ADR floor of 100
plus per-stat thresholds deciding it, and on a real squad match that silenced the whole roster —
nobody cleared 100. Every player with stats is now sent with every stat that could carry a joke, and
zero/missing values are dropped so the model can't quote "0 knife kills" as if it happened. Don't add
a performance bar back; if a line is too noisy, cut a *fact* from `FACTS`, not a player.

FACEIT's per-round and per-match **rate** fields (`Match Entry Rate`, `Sniper Kill Rate per Round`, …)
are deliberately not sent — they're derived from the raw counts already there and only cost prompt
length.

The roster is **shuffled**, not sorted by ADR. Telling the model the order means nothing only
half-worked — it still leaned on whoever came first, which is the bar reintroduced by anchoring. The
map reaches the model **only** through `mapLine()`: naming it in the context string as well
contradicted `mapLine`'s own "do not mention the map" branch, and the name leaked into messages that
had banned it.

**Teasing our own players on a win is deliberate**, and reads as a bug if you don't know that. The
squad are friends and judged an affectionate dig at a quiet game funnier than relentless praise. The
line it must not cross is contempt or a verdict on someone's skill — warm, about the moment, never
about the person. Don't "fix" this back to praise-only. It applies to **wins only**: on a loss the
same joke is blame.

Whether a dig is invited is a **coin toss in code** (~1 in 3), not a standing permission, for the
same reason the angle is picked in code. Allowed on every call, the model went for the lowest ADR
every single time and kept landing on the same player — four of six messages about one teammate,
in the register of "he was carried" and "he's a bot". Banned outright, it stopped teasing at all.
Rolling it keeps the dig a surprise and spreads who wears it.

**A win highlights us, a loss highlights them.** That rule is enforced by the data, not the prompt:
on a loss our roster never reaches the model at all, so it cannot land on a teammate even if asked
to. The opponents become the subject instead, which is why `opponentsLine` takes
`won`: their top fragger's kills and ADR plus the team's best HS% are what the suspicious-aim, smurf
and exit-frag angles were always reaching for, and without real figures the model invented them.
Opponents are never named — they're outside the group, and anonymous carries the joke anyway.

A loss may quote only **one** of their numbers — inviting it to build around all of them made every
loss open with the same three-stat recital. That cap is also what makes the HS figure safe to send at
all: `bestHs` is the highest anyone on their team hit, usually a **different player** from the top
fragger, so it gets its own clause saying so. Bundling it into the fragger's line asserted one player
had all three, which is false, while sending both percentages unlabelled made the model recite
«44% HS і 56% HS» — once as «чийсь 56% HS», visibly unsure whose it was.

Terms that must come out in Latin with exact casing live in **one table**, `TERM_FIX` in
`view/phrase.ts`, alongside the Cyrillic spellings the model reaches for — map names included, since
de-transliterating «інферно» and re-casing `faceit` are the same operation. It replaced a
replace-per-term chain that had already drifted: `HLTV` was restored while `K/D` wasn't, and `LAN`
/`VAC` were written into the angle pools then lowercased with nothing to put them back. Add new terms
there, not as another `.replace`. `Cache` is Latin-only on purpose — its transliteration «кеш» is also
the Ukrainian for *cash*, which the accountancy and bank-heist angles lean on constantly.

## FACEIT links

Two writers, deliberately not one. `setFaceitAccount` sets the link and expresses a user's explicit
intent; `setFaceitElo` only advances the Elo delta baseline, and its `WHERE faceit_player_id = ?`
is what stops the 20-minute poll from resurrecting a link that `/faceit off` removed mid-poll. The
poll must never call the former — its roster is a snapshot from poll start, so it would write back
an id the user has since cleared. Nothing enforces this but the names.

## Dependencies

`@types/node` is pinned to the **24.x** line on purpose — its major tracks the Node runtime major,
and Node 24 is pinned in three places (`.nvmrc`, `engines` in `package.json`, `node:24-alpine` in
the Dockerfile). `npm outdated` will keep offering 26.x; taking it would typecheck against APIs the
runtime doesn't have, and `node:sqlite` is exactly the kind of still-moving API where that bites.
Bump it only when all three Node pins move, and move them together.

## CI

`.github/workflows/ci.yml` typechecks every PR into `main`. Deploy typechecks again before
shipping, so a red CI means the merge would fail to deploy too. There are no tests — typecheck is
the whole gate.

## Releasing

**Any push to `main` deploys** (`.github/workflows/deploy.yml`) — the only automatic trigger, so
`main` is always exactly what's live. Merging a PR is a release.

Tags do **not** trigger anything. JustRunMy.App rebuilds and restarts on every push to its remote
and never fast-forwards, so a `v*` trigger meant `git push --follow-tags` deployed the same commit
twice and restarted the bot twice. Don't add one back.

To release — never as a separate `chore: release` commit:

1. `npm version <patch|minor|major> --no-git-tag-version` — bumps `package.json` +
   `package-lock.json` without committing or tagging.
2. Commit the change and the bump together, on a branch.
3. Open a PR, let CI pass, merge — the merge deploys.

We don't tag releases: `package.json` plus the merge commit on `main` is the whole record.

**To roll back or re-deploy an old version:** run the Deploy workflow manually from the Actions tab
(`workflow_dispatch`) against the commit SHA you want.
