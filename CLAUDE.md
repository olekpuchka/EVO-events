# EVO Events Bot

## Layout

```
bot.ts              composition root — config checks, handler registration, scheduler, shutdown
src/config.ts       every process.env read in the project
src/log.ts          timestamps on console
src/types.ts        shared row + API shapes
src/adapters/       one module per external system: db (SQLite), faceit (HTTP), ai (DeepSeek)
src/view/           data → strings: html, i18n, commands, render, eventtime, birthday, prompt, phrase
src/handlers/       Telegram entry points: events, results, birthdays, guards
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
spends a menu row or a second pair of descriptions. Reach for an argument first. `/birthday` is
built to the same three-way shape — no argument reports, `off` removes, anything else is a date —
and deliberately so: two commands with the same grammar are one thing to learn.

Only `all_group_chats` is published; the `default` scope is cleared alongside it. That is what
leaves DMs with no menu, and it's deliberate — every command returns early in a private chat.
Don't restore it.

`groupOnly()` in `src/handlers/guards.ts` is what guarantees that early return: it answers a DM,
drops an update carrying no `from`, and hands the handler a narrowed sender. Every command and
`@all` goes through it. `handleRsvp` is the exception — a callback query has no guaranteed `chat`,
so it checks inline.

The private reply itself is `ephemeral_message_parameters: { receiver_user_id }` on the send, built
in one place — `sendEphemeral()` in `src/handlers/guards.ts`. It was a flat `receiver_user_id`
before @grammyjs/types v5; if a send starts silently falling back to send-then-delete, that rename
is the first thing to check, because the failure logs as `[ephemeral] send failed` and otherwise
looks like nothing at all.

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

## Birthdays

`/birthday 25-08-1990` stores a date, `/birthday` reports it, `/birthday off` removes it. Members
type and read **dd-mm-yyyy**; the database stores ISO `YYYY-MM-DD`, because ISO sorts and its last
five characters are the `MM-DD` the daily sweep matches on — `substr(birth_date, 6)` in `db.ts` is
that slice. `view/birthday.ts` owns both directions and every other date question; it is pure, and
the clock is the only thing it reads. Day and month may be typed unpadded (`5-3-1990`) — the stored
form is always padded. A date is rejected unless it is a real calendar day, in the past, and after
1900.

There is deliberately **no minimum age**. One briefly existed, because "not in the future" alone
accepts *today* — a year typed as 2026 instead of 1996 stores fine and reads as turning 0. But this
is one private group of adults: a floor refused nothing real, and only caught a slipped year landing
inside the last few. The absurd-but-harmless output was judged cheaper than the validation.

**`ageToday` is the only age function anything outside this module calls.** `ageOn` and `ageTurning`
are internal halves of it. Three call sites answering "how old are they" separately is how
`/birthday` came to confirm one age, report a second and greet with a third — all on the same day,
for a 29 February member greeted on the 28th.

`/birthday` reports the age as a **check, not decoration**: with no minimum age left to validate
against, «зараз тобі 21» is the only thing that catches a year typed as 2004 instead of 1994. That
is also what keeps `ageOn`'s branch live — a member checking in June for a December birthday is not
due today.

The dates live in a **table of their own**, and that is the whole point. There is no migration step
here (see **Schema**), so two new columns on `members` would never reach the `members.db` already on
the volume and every statement naming them would throw at boot. `CREATE TABLE IF NOT EXISTS` adds a
*new* table to an old database perfectly well — it is the one shape of schema change this setup can
take, and it is why hype phrases are in memory but birthdays are not.

`/birthday <date>` calls `trackMember`, exactly as `/faceit` does: the greeting reads the name from
the `members` row, and the sweep's `JOIN` drops anyone without one. Unlike `welcomeJoiners`, this is
an explicit setup command, and `trackMember` leaves an existing `notifications_enabled` alone — so
it creates a row for a newcomer without un-muting anyone who chose to be muted.

**The sweep runs on every scheduler tick and gates on `hour >= GREET_FROM_HOUR`, not equality.** A tick
can be missed and the container restarts on every deploy; a greeting that silently skips a *year* is
the one failure worth engineering out. What stops it repeating is `greeted_on` on the row, written
only after the send lands — so a failed send retries for the rest of the day rather than waiting
twelve months.

That retry is bounded by kind of failure, and has to be: the AI call runs *before* the send, so a
chat the bot can no longer post to would regenerate a whole toast every 60s until midnight. A
permanent Telegram 4xx (kicked, chat gone, migrated) is marked greeted anyway and given up on; 429
and everything else stays on the retry side. Same split `results.ts` makes with `transientFail`.
`markBirthdayGreeted` therefore means two things — "greeted" and "gave up on this chat" — so the
log line says which; it used to print `greeted (36)` directly under `giving up`.

A **transient** failure retries forever by design, so the cost is bounded instead of the retry:
`phraseCache` holds the generated toast for the day, and a retry pays for the send alone. An hour
of Telegram trouble was ~60 DeepSeek completions for one member before that. The fallback is
deliberately *not* cached — pinning it would keep shipping the canned toast after the API recovered.

The AI call sits between the roster snapshot and the send, so three things are re-checked after it.

**Membership**, first, because it is the cheapest and the AI call is the expensive one. Nothing
removes a member's rows when they leave — no `left_chat_member` handler, no `DELETE` anywhere — so
a departed member would be toasted publicly every year and could never clear it themselves
(`/birthday off` is `groupOnly` and keyed on the sender). Gone means `left`, `kicked`, **or
`restricted` with `is_member: false`** — that last reads as present if you only compare the status
string. An errored check counts as still here. It **skips the tick, it does not settle the day**: one
reading is a fact about this minute, and someone removed and back within the hour would otherwise
lose their year silently.

**The row, and that it is still due *today*** — not merely still switched on. A date moved mid-write
would otherwise be greeted on the wrong day *and* mark the day spent, swallowing the real birthday.

**The age**, re-derived from that row. A corrected year keeps the day but changes the age, which is
inside the toast as well as the header; the phrase is dropped and rewritten next tick rather than
shipping the two disagreeing.

`phraseCache` is pruned against the live due list at the top of each sweep: an entry whose member is
still failing at Kyiv midnight drops out of the due list and would otherwise sit there until the
next redeploy.

**`greeted_on` records the day the last greeting went out, not the year, and an edit never touches
it.** That is the whole guard: the sweep knows what today is, so "have we greeted them for today?"
is a direct comparison no edit can confuse, and `setBirthday` is a plain upsert.

Storing a *year* and deciding at write time whether an edit invalidated it produced four separate
duplicate-toast bugs — re-saving the same date, a corrected year, the 29 February stand-in
(`02-28` and `02-29` are one day in a non-leap year), and finally editing away from today and back,
which cleared the year with nothing left to restore. **A write-time decision could not see enough.**
Recording the day removes the decision, and a genuine date move now correctly greets on the new
day, which the year-based rule refused.

`/birthday off` clears the **`active` flag rather than the row** — the only reason the column
exists. A `DELETE` takes `greeted_on` with it, so off-then-same-date-again came back with no memory
of the greeting.

Both columns took their final shape **before this table ever shipped**, which is the only reason
renaming one mid-work was free. Once this merges the no-migrations rule in **Schema** applies here
like everywhere else: `CREATE TABLE IF NOT EXISTS` does nothing for a table that exists in the
wrong shape, and every `db.prepare` naming the new column throws at boot before a handler
registers.

The sweep uses `ageToday` like everything else; everything it sees is due by construction, so the
branch inside resolves to the age being turned.

**29 February is greeted on the 28th** in a non-leap year. Without `dueMonthDays` those members are
skipped silently, three years in four. It returns two values always, so `db.ts` prepares one
statement with two placeholders and a day with no stand-in passes its own value twice.

The greeting is a bare `api.sendMessage` — the header line carries the `<a>` mention and the AI toast
sits under it. Not `sendRichMessage`: that would render the mention as literal text (see **Rich
messages**), and the mention is the point.

## Birthday phrases

The **one kind that is not a one-liner**, which is why `SYSTEM_PROMPTS` is keyed by `Kind` rather
than being the single `SYSTEM_PROMPT` it used to be. Every rule in the short-message prompt is about
brevity — one or two sentences, at most two names, one bold fragment — and a multi-paragraph toast
is the opposite shape. Adding a kind now forces a decision about which prompt it speaks under instead of
silently inheriting those rules.

`LIMITS` in `adapters/ai.ts` holds `maxTokens` and `timeoutMs` **in one entry per kind**, because
the two move together: a completion cut off at `maxTokens` comes back truncated, one past
`timeoutMs` not at all, and a kind must not get a budget while inheriting someone else's clock.
Birthday runs 512/30s against the short kinds' 512/15s — same budget, a roomier clock, since nobody
waits on that call. The timeout is per request, so `maxRetries: 0` still stands.

The budget is sized off the **ask**, not the average: 70 words is ~260 tokens at this project's
measured 2.5–3.7 per Ukrainian word, so it sits near double. Nothing inspects `finish_reason`, so an
overshoot ships truncated with no check able to catch it — headroom is the only defence. Every entry
in `MAX_WORDS` is a number actually sent to the model; `birthday` once held one the ask never used.
**Both were far larger when the ask was 400–500 words** — they follow it down as well as up.

`FALLBACKS` is keyed by kind for a smaller reason: `generate` looks its own up rather than taking
one as a fourth parameter, which is one fewer place a caller can pair a kind with the wrong
fallback.

The standing danger here is **not a wrong number but a wrong memory**. The squad stores nothing about
a person but a date, so asked to be warm and specific the model will happily recall a clutch that
never happened — and no check can catch that, since a fabricated round carries no digits. Hence the
rule stated three ways in the system prompt, and hence **no angle in `BIRTHDAY_ANGLES` asks for a
memory**: every one is a format to fill in or a running squad joke, never a story to recall. The age
is the only number on the safe list, so any other figure is an `unsourced-stat` rejection.

`unsourcedStat` compares those figures **as numbers, not strings**: «36.0» and «36» are one figure
spelled two ways, and a string match rejected the second spelling of a number the prompt had itself
supplied. It was briefly patched by putting `${age}.0` on the safe list *and* naming the allowed
spellings in the prompt — a sentence written to appease a regex is a sign the regex needs fixing.

Note what the checks **cannot** do: `attributable` ignores 1–2 digit integers, so an invented
«17 років у грі» ships where an invented ADR of 847 is rejected. On this kind the small numbers are
the dangerous ones, and only the prompt stands behind them.

The code swap in `phrase.ts` **strips `<` and `>` from whatever it substitutes**, because it runs
*after* `sanitize` and `balanceTags` — nothing checks it again, and `escapeAiHtml` turns
`&lt;/i&gt;` back into a real tag. Every other kind swaps in a FACEIT nickname, which cannot contain
one; a birthday swaps in a Telegram **first name**, which is arbitrary user text. A member named
`</i>` shipped an unmatched tag, and the sweep read the resulting 400 as a dead chat.

`P1` works as it does in a win message, but it **takes no Ukrainian case ending** and the swap puts
a bare nominative in its place — «в P1 день народження» shipped as «в Олег день народження». The
prompt therefore says to build every sentence around P1 in the nominative and rephrase rather than
decline it. Nothing can fix it afterwards: the code carries no case to restore.

**Words are not a unit the model can count. Sentences are.** It overshot every word figure it was
given — 78 median against a 70 ask, and 77 against a *lower* 55 ask, which moved nothing. Every real
gain came from the sentence dial: "two or three sentences" brought the median to 60, and *one
sentence per paragraph, two in the message* brought it to 58 with the spread closed to 50–70. That
last step also took the fallback rate from 8% to zero — asked for three, it wrote three long ones
and blew the budget twice in a row. Reach for the sentence count first, and keep the two consistent:
a word ceiling the sentence count cannot fit is what produces retries. Twelve runs at the current
ask: 50–70 words, median 58, two retries, **no fallbacks**.

At a 400–500 ask it behaved the opposite way, landing *under* whatever ceiling it was given. Don't
carry a calibration across a change — re-measure, and expect the direction of the error to flip.

`maxWords` is `null` for hype, win and loss on purpose. Those have never had a hard limit — see
**Match phrases** — and switching one on would start rejecting messages that ship fine today, on
paths a user is waiting for. Birthday can afford it: nobody waits on that call, so a rejection costs
only a second request.

`balanceTags` in `view/phrase.ts` is what keeps several bold fragments sendable. It replaced a pair
of per-tag regexes that could only see one tag at a time and read «`<b>a <i>b</i> c</b>`» as an
unclosed `<b>` — dropping the bold outright, or worse, dropping the open tag while an earlier `<b>`
in the message kept its `</b>` alive. Telegram rejects an unmatched close tag with a 400. Rare while
the short kinds are held to one bold fragment, reachable the moment a birthday message is invited to
use several.

`MULTILINE` in `view/phrase.ts` is what lets those paragraphs survive: `sanitize` collapses all
whitespace for a one-liner, where a stray newline is padding rather than structure, and a
multi-paragraph toast through that came out as one block. Blank-line-separated paragraphs are what Telegram renders as
paragraphs.

`recentPhrases` has **no birthday bucket**, and that absence *is* the policy — it fires once per
member per year, so there is nothing to repeat within, and three stored toasts would be prepended
to every later prompt. Said as a missing key rather than as `if (kind ===
"birthday") return` inside `remember()`: a guard naming a kind leaves an empty bucket four lines
above it that lies about being maintained, and the next kind opts in by being forgotten in an `if`.
`MULTILINE` in `phrase.ts` is the same idea done as an exhaustive table — both let a new kind fail
loudly rather than inherit a default.

Registers go through `pickRegister(kind, pool)`, mirroring `pickAngle`. The pool stays beside the
prompt that uses it; only the freshness memory is keyed, and buckets appear on first use, since win
and loss roll their register inside `closingInstruction` rather than from a pool. Birthday briefly
had a second module-level array next to hype's — two globals differing in nothing but name.

`allowCallouts` is `true`, the same as hype and for the same reason: nothing has been played, so
«точку B» is a running joke about our plans, not a claim about a round.

## Rich messages

`sendRichMessage` takes real headings, lists and tables. It used to have **no way to send
privately** — no `receiver_user_id` — which ruled it out for anything personal and is why `/help`
was tried as a rich table and reverted. **That constraint is gone**: since @grammyjs/types v5 the
private-send parameter is the nested `ephemeral_message_parameters` object, and `sendRichMessage`
accepts it like the other send methods. Nothing has been changed to take advantage of it, so the
scoreboard is still the only rich message — but the reason `/help` is plain HTML no longer holds,
and a revisit is now a design question rather than an API limit.

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

**Fallbacks are for having no AI result, not for policing output.** That's why a phrase has no
*stylistic* length limit: a good long message ships. The one length check that does exist,
`MAX_CHARS` in `view/phrase.ts`, is a transport bound rather than a style one (the birthday word
ceiling shares its `too-long` reason but is a separate, per-kind check — see **Birthday phrases**) — Telegram refuses a
`sendMessage` over 4096 characters outright, and `handlers/birthdays.ts` reads that 400 as a chat it
can no longer post to, costing the member their greeting for a year, silently. A phrase past the cap
cannot be delivered at all, which is a different thing from being merely long. It sits well clear of
the largest real message and is unreachable for every kind at the asks they carry today — it is a
backstop against a runaway completion, not a length policy, and so does not move with the ask. The checks that do
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

`MAX_WORDS` in `view/prompt.ts` is one object keyed by kind — 35 for all three match/hype kinds,
kept per-kind so one register can be loosened alone. Nothing enforces it for **these** kinds but the
model (birthday is the exception, and enforces it via `checks.maxWords`); `max_tokens: 512` in
`adapters/ai.ts` is the only hard bound here, and 35 Ukrainian words measures at **86–131 completion
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

## Posting a result

A match is posted only if **`MIN_PLAYERS` (2) or more** linked members were in it. Solo queue is one
member's business, the scoreboard renders as a one-row table, and the phrase says «ми» about four
strangers.

Gated in **two** places against one constant, because they count different things.
`participantIds` in `autoPostResult` spans both teams in the stats and runs *before* the Elo
fetches, so skipping is free; `resultRows` in `buildMatchResult` is our team alone and is what
actually renders. Two of us queued onto opposite sides passes the first and fails the second.

The count comes from the **match stats**, never from `matchCounts` in the candidate sweep. That
tally is built from each member's own recent-match history, and a failed history call — already
counted as `historyErrors` — would read a real squad game as solo and bury it permanently.

A skipped match is `markMatchPosted`, or its stats get re-fetched on every poll for 24 hours. That
means it also never reaches `setFaceitElo`, so the next posted match shows a delta spanning both.
That was already approximate: `getPlayerById` returns Elo at *poll* time, not at match time, so a
solo game between two squad matches always leaked into the next delta. Not worth a fetch to fix.

`buildResultBlocks` is the **only** renderer. A plain-HTML version shipped alongside it as a
fallback from the day the rich card arrived, and was removed once the rich send had proved reliable
in the group: it cost two places to edit for every change to the post, and had never needed a change
itself.

The consequence to know is on the failure path. A rejected send is **not** `markMatchPosted`, so the
poll retries that match every `FACEIT_POLL_MINUTES` for 24 hours — and `generateMatchPhrase` runs
inside `buildMatchResult`, *before* the send, so each retry buys another completion for a post
nobody sees. The fallback used to absorb that. If it ever starts biting, the fix is the
transient/permanent split `handlers/birthdays.ts` already makes — give up on a permanent 4xx, keep
retrying a 429 — not a second renderer. The likeliest rejection is the `photo` block: `mapImage` is
a FACEIT CDN URL that Telegram fetches server-side.

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
