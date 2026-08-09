# EVO Events Bot

## Layout

```
bot.ts              composition root — config checks, handler registration, scheduler, shutdown
src/config.ts       every process.env read in the project
src/log.ts          timestamps on console
src/types.ts        shared row + API shapes
src/adapters/       one module per external system: db (SQLite), faceit (HTTP), ai (DeepSeek)
src/view/           data → strings: html, i18n, commands, render, eventtime, prompt, phrase
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

A command lives in **two** places: its `bot.command(...)` handler and the `COMMANDS` list in
`src/view/commands.ts`. Adding or renaming one means changing both, plus a `cmd*` key in
`src/view/i18n.ts`. `LABELS` is declared with `satisfies`, not an annotation, so `t()` takes
`keyof typeof LABELS` — a missing or misspelled key fails typecheck instead of reaching the group,
and `COMMANDS` is checked against that same `LabelKey`.

`COMMANDS` feeds **both** the published menu and the command block in `/help`, which is why
`helpBody` is a function. A hand-written list would be a fourth place to update, and prose is
where typecheck can't reach — a renamed command would leave a stale line in `/help` with CI green.
Two consequences: `helpBody` is annotated `(): string` to break the inference cycle (`LABELS` →
`t` → `keyof typeof LABELS`), and `commands.ts` imports `LabelKey` as a **type only**, since
i18n.ts imports the list at runtime.

Commands print **unwrapped** there, not in `<code>` — Telegram only makes a bare `/command`
tappable.

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

## Welcome message

`welcomeJoiners` hooks `message:new_chat_members`, a **service message**, so it rides the `message`
update `allowed_updates` already admits — `chat_member` is the other way in, and Telegram withholds
it unless it's named there. No `groupOnly()`: the update's `from` is whoever did the adding, not
the joiner.

It deliberately does **not** `trackMember` the joiner. `notifications_enabled` defaults to 1, so
tracking someone *is* opting them into `@all` — joining the group stays separate from consenting
to be mentioned. Don't add the call as a convenience.

It sends with a bare `ctx.reply` like `mentionAll` and `sendReminder` do: an introduction is for
the group, and `sendEphemeral` would show it to the joiner alone. Telegram's own "X joined" notice
is left in place — judged not worth the surprise of deleting it.

The greeting names the group from `ctx.chat.title`, which rides the same update — no `getChat`
call. It's asserted non-null because grammY's filter narrows the *message*, not the chat, so TS
still admits a private chat a join can't arrive in. Escaped like any user-set text: whoever renames
the group isn't necessarily the person being welcomed.

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
the model merely broke a rule. `generate` calls `generateOnce` twice, spelled out rather than looped
because the two asks differ: the second is `retryAsk(prompt, reason)`, the same ask plus one sentence
naming the rule that was broken. It takes the prompt and returns the whole second one, so
`view/prompt.ts` stays the only module that composes what the model reads. A blind re-roll at
temperature 0.8 was enough only when the mistake was incidental. When the *angle itself* invited it, the model made
the same mistake twice and fell back — a 19:16 overtime win opened with the scoreline both times, a
hype angle about signing away your rating reached for «Elo» both times. The reason is free: the retry
was already happening, and `finalizePhrase` already returns why.

`RejectReason` and `PhraseVerdict` both live in `src/types.ts` for the same reason: phrase.ts
returns the verdict, ai.ts forwards it untouched, and the `"phrase" in result` narrowing on both
sides has to agree.

The correction wording lives in `view/prompt.ts`, like every other word sent to the model, and is
phrased as a correction rather than a restatement of the rule — repeating a rule the model has just
demonstrated it will skim past changes nothing.

Which is why **every rejection is logged** with its reason (`[ai] win rejected (scoreline): …`) and
an empty reply logged separately. Without that, a check misfiring and the API being down look
identical from the outside — the exact trap that let `thinking` sit switched on unnoticed.

**Fallbacks are for having no AI result, not for policing output.** That's why a phrase has no length
limit: a good long message ships, and `max_tokens` is the only bound on how long. The checks that do
reject — an invented or borrowed stat, a scoreline we didn't supply, a `P`-code we never issued, Elo
when no Elo numbers were given, English in a UA message, a **callout** — each catch something that
would read as fact or as broken text in the group, and each gets that second attempt first.

`CALLOUT` is the newest and the narrowest. The model is told the map but never where anything
happened, so «їхній тренер завис над Banana» is an invented position — and *banana* is the example
the system prompt itself lists, which is how much a stated rule is worth on its own.

Banana needed two passes. Matched bare, it hit the squad's own mascot — 🍌 runs through the bot down
to `fallbackHype` («Банан-сквад, підйом!»). Dropped from the Cyrillic side entirely, «односторонній
дим на банані» shipped. It now matches Latin `banana` plus Cyrillic **behind a place preposition**:
«на банані» is a position, «Банан-сквад» is us. The word list
stays short because every entry has to survive being an ordinary Ukrainian word in a joke: «піт»,
«вікно», «палац» and *ninja* (from the `ninja defuse` angle) are all left out, and «мід» takes no
case ending, because a real loss message wrote «мідною труною».

Whether a message may name a place is `allowCallouts` in `PhraseChecks`, alongside `allowElo` —
`true` only for hype, which has no round to invent a place in and whose angles include «rush B». It
is set in `prompt.ts` next to the angle pools because that is where the reason lives; a
`kind !== "hype"` test inside the checker put the rule and its reason in different modules.

One thing is **stripped rather than rejected**: a leading preamble. A reply opened «Звісно, ось
повідомлення в заданому стилі: …» and shipped it. The message after the colon was fine, and a
rejection would spend the one retry, so `PREAMBLE` cuts it.

That strip is **silent** — no rejection, no log, no retry — so a false positive deletes a joke's
opening clause and nothing says so. It therefore matches only a bare handover: nothing between the
deictic (ось / here's) and the noun (повідомлення / message), and after it only a style-or-request
marker. Every looser version bit — bare stems matched «запит» inside «запитання», then «текст» ate
«Ось текст нашого заповіту:», then free text before the noun ate «Ось офіційне повідомлення
прес-служби:». The заповіт, страховий випадок and прес-служба angles invite exactly those openings
by name. A stray preamble shipping is the cheaper failure.

## Hype phrases

Hype gets a **register roll** like a win does — flat tactical briefing, commentator losing his
voice, or quiet menace — because it was the one kind with no register at all, and every message
came out as the same pump-up announcement in a different hat.

Its one fact is **how long until kick-off**, bucketed into words by `startsInLine`. Never a number:
a hype message has an empty safe-list, so «за 20 хвилин» is an unsourced stat, and the prompt has
to say so out loud — invited to use the timing without that clause, the model turned the bucket
into «за сорок хвилин» for forty-five and invented «опів на дванадцяту» from nothing. The start
time is already printed above the message anyway. The far bucket says only "a long way off", never
"tonight": `parseEventTime` rolls a time already past to tomorrow, so it can be a day out.

`squadFull` is passed only from the 5/5 lock, never from the reminder: `sendReminder` reads its
roster *after* the phrase call on purpose (the 2–3s would make the count stale), so the reminder
path genuinely does not know yet.

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

**No dated events and no named pros in the angle pools.** Boston-2018, Stockholm-2021, s1mple,
ZywOo, donk and the 2007 computer club were all replaced with the generic version of the same joke
(«фінал мажора», «п'ятеро майбутніх легенд», «людина з десятьма тисячами годин», «клуб нашого
дитинства»). A named prodigy stales fastest of all, and a year on a major only recedes. `NaVi`
stays — an org, undated — as do platform and game references (Valve, HLTV, FACEIT, Zeus x27).

`HYPE_ANGLES` and `WIN_ANGLES` are annotated `string[]` rather than inferred, for the same reason
`FactId` exists: `needs` and `self` are read only on the loss branch, so an object in either pool
would be accepted and silently ignored.

**Teasing our own players on a win is deliberate**, and reads as a bug if you don't know that. The
squad are friends and judged an affectionate dig at a quiet game funnier than relentless praise. The
line it must not cross is contempt or a verdict on someone's skill — warm, about the moment, never
about the person. Don't "fix" this back to praise-only. Naming **one of us** applies to wins only:
on a loss, a dig with a name on it is blame.

The squad as a whole is a different matter. A loss angle carrying `self: true` turns the joke on
«ми» — the tactical plan was «якось воно буде», we played like five strangers — and swaps the
closing instruction, because "never blame our own team" and "we played like five strangers" can't
sit in the same prompt. The pool used to be pure deflection (the router, the chairs, Valve), and a
bot that can never take an L is one note. Collective is the whole distinction: nobody wears it
personally, and the roster still isn't sent on a loss, so the model **cannot** single anyone out
even under that instruction. The prompt also forbids inventing the round we threw — a specific
call or play would be a fact we never had, and no check catches an invented event, only an
invented number.

`subject` — `"us" | "them" | "squad"` — is resolved once per message and is what every part of the
prompt asks: the genre word (`MESSAGE_KIND`: a self-roast asks for a *confession*, not an excuse,
because «визнай, що ми грали як п'ятеро незнайомців» is an admission), the roster block, the
opponents' one number (contrast on a self-roast, punchline otherwise) and the closing register. Each
one it doesn't reach is a place the prompt contradicts itself, and the model splits the difference by
drifting back to deflection. `win + self` is unrepresentable by construction.

`buildPlayerBlock` takes the flag too, and only to change *why* the roster is withheld. Told "the
joke is about the opponents" in one line and "this one is on us" in the next, the model split the
difference and drifted back to deflection — the self-roast group quietly stopped working. Both
lines still withhold every name and stat; they differ in one clause.

The prompt tells the model the scoreboard above already shows the score — and the Elo **only when
there is Elo**. FACEIT omits faction ratings often enough that `elo` is null on real matches, and
the line was gated on `upset` alone, so it claimed an Elo the reader cannot see.

**Every kind has a register, and the register is rolled in code.** A loss is melodrama: play it
straight and devastated, build to the punchline, go one step past what the angle needs. A win rolls
a coin between deadpan (barely looked up) and loud gloating — asked to choose, the model takes the
loudest option every time, the same failure as letting it pick the angle. A win had no register at
all until this, which is why raising its word budget alone changed nothing about how it read. That instruction plus `MAX_WORDS` is what turned the
deflection jokes from one-liners into something with a setup. At 25 words the model spent the whole
budget on the setup and landed nothing.

Asking for one step further sends the model looking for the biggest stakes it can find, and it came
back with «сервер засуджений за зраду Батьківщині». Hence the clause: whatever is mourned, buried or
put on trial has to be part of the match — the rating, the server, our aim — and a real war, real
politics or a real person's death is never the comparison. What that clause does **not** ban is the
funeral register itself: «хвилину мовчання за нашим рейтингом», «день жалоби», «склади заповіт» are
angles in the pool, and a guard written wide enough to catch them would have contradicted the angle
it shipped with. "Commit to it fully" wins that argument every time, so the guard has to be narrower
than the joke. The same reasoning is why the tone line says "the end of an era" rather than naming a
tragedy — whatever the prompt reaches for as a comparison, the model will try to top.

`MAX_WORDS` in `view/prompt.ts` is one object keyed by kind — 35 across the board today, kept
per-kind so one register can be loosened alone. Nothing enforces it but the model; `max_tokens: 512`
in `adapters/ai.ts` is the only hard bound, and 35 Ukrainian words measures at **86–131 completion
tokens**, so there is room to raise this a long way before that ceiling matters.

The invitation lives **only** in that roll. A standing "a friendly dig is welcome" in the closing
line contradicted it on 72% of wins — the roster block had just said to leave everyone's weak line
alone. Same trap as the loss side: one idea stated in two places drifts apart.

Whether a dig is invited is a **coin toss in code** (~1 in 3), not a standing permission, for the
same reason the angle is picked in code. Allowed on every call, the model went for the lowest ADR
every single time and kept landing on the same player — four of six messages about one teammate,
in the register of "he was carried" and "he's a bot". Banned outright, it stopped teasing at all.
Rolling it keeps the dig a surprise and spreads who wears it.

**A win highlights us, a loss highlights them.** That rule is enforced by the data, not the prompt:
on a loss our roster never reaches the model at all, so it cannot land on a teammate even if asked
to. The opponents become the subject instead, which is why `opponentsLine` takes the `subject`:
real figures from their side are what the suspicious-aim, smurf and exit-frag angles were always
reaching for, and without them the model invented one.
Opponents are never named — they're outside the group, and anonymous carries the joke anyway.

Exactly **one** of their stats ships, win or loss — inviting the model to build around all of them
made every loss open with the same recital. A win used to carry two for contrast, and the model
merged them into one imaginary opponent: «їхній гравець з 4 MVP і 13 флешкових асистів» was two
different players, both figures real, nothing in the checks able to tell. One fact is also all a win
should spend on them, since the win is ours to be smug about. **Which** stat is rolled per match from
`OPPONENT_FACTS` — a table keyed by stat id, declared with `satisfies` so `FactId` is exactly the
set of ids that exist and an angle's `needs` can't name one that doesn't (a typo used to drop that
angle from the pool on every match, silently and forever). Rolled over everything their whole team
actually did: knife kills, an AWP tally, clutches won, a Zeus, a team-high HS%. Handing over the same three every time — the top fragger's kills, his ADR, the
team's best HS% — is what made nearly every loss come back quoting kills or ADR, since those were
the only interesting numbers on offer. Add a stat there, not to the line, and the results handler
stays out of it: it now passes their roster raw, because which number is funny is a prompt decision.

A duel fact needs **two real attempts**, and the filter runs *before* the pick, not after it — rank
the team by wins first and one player at 1-of-1 hides the whole team's duel fact, along with every
angle whose `needs` name it. The `Number.isFinite` half is a second hole: a Wins key whose Count key
is missing gives `NaN`, and every comparison against `NaN` is false, so «3 of NaN entry duels» went
into the prompt with "NaN" on the safe-number list. The floor itself is because "won 1 of 1 1v2 clutches" is true and reads as noise — the model tried to
make sense of it and produced «клатчем 1 на 1 в ситуації 1v2». There is
deliberately **no flash-assist fact** either: three wordings in, it still collapsed back into
«засліпили N разів», which is the enemies-blinded fact with the wrong number attached.

A fact is phrased as an **action**, not as a stat label: "opened 8 separate rounds with the first
kill", not "8 opening kills". Both halves of that wording are scar tissue — "drew first blood" came
back transliterated as «2 фірстблади», and without "separate" the count became «три раунди поспіль»,
a qualifier nobody supplied. Three more went the same way: «5 AWP kills» shipped as a raw English
label, and "utility damage" / "total damage" came back as «утиліті-шкоди». Said as actions — "killed
N of us with the AWP", "did N damage with grenades alone", "dealt N damage across the match" — they
return as «5 вбивств з AWP», «156 шкоди самою утилітою», «2400 шкоди».

The same rule binds `FACTS`, our own roster's list: it carried "total damage", "utility damage",
"grenades thrown", "flashes thrown" and "opening kill" — the exact phrases UA_STYLE bans — and the
model pasted them through as «367 утиліті-шкоди». They are now "damage dealt", "damage with
grenades", "grenades used", "flashes used" and "rounds opened with the first kill".

Clutch kills took three goes. "N clutch kills" and then "N kills while last man standing" both got
compressed back to «вісьмома клатчами» — which claims eight rounds *won*, not eight kills. It now
says "killed N of us after his own team was already dead": no word left to compress. The weapon
facts that *do* stay labels («тріпл-кіл», «ейс», «ножем», Zeus) get away with it only because
Ukrainian has the slang; `wrongLanguage` cannot catch any of them, since a pasted label carries no
English function words. A label gets pasted into the Ukrainian sentence untranslated — two English words
aren't enough for `wrongLanguage` to fire — or picks up a unit the number never had («5 пістолетних
вбивств **за раунд**», which was a match total). Neither is catchable by a check, since the digits
themselves are correct.

Every fact is about «one of them», never a named subject. That is what makes them safe to mix: the
team's best HS% usually belongs to a **different player** from the top fragger, and bundling the two
asserted one player had both, which is false — while sending both percentages unlabelled made the
model recite «44% HS і 56% HS», once as «чийсь 56% HS», visibly unsure whose it was.

A loss angle written around a specific stat declares it (`needs: ["hs"]`) and gets it instead of a
roll — the suspicious-aim joke needs an HS figure, not a knife kill. It's also **dropped from the
pool** when their team produced nothing of that kind: blaming their AWPer with no AWP kill on the
board is an excuse about something that never happened.

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
