# EVO Events Bot

## Layout

```
bot.ts              composition root — config checks, handler registration, scheduler, shutdown
src/config.ts       every process.env read in the project
src/log.ts          timestamps on console
src/types.ts        shared row + API shapes
src/adapters/       one module per external system: db (SQLite), faceit (HTTP, open API + faceit.com), ai (DeepSeek)
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
retry and the fallback — no wording in it at all. Adding an angle touches `prompt.ts` alone.

That keeps `view/` importable on its own, which matters because `adapters/db.ts` opens the file and
creates tables **at import time** — importing it, directly or not, creates a database as a side
effect. Keep pure logic in `view/`.

## Comments

Code comments are tidy, clean and to the point: one line, two at most, stating the fact and at
most one trap. The *why*, the history and the failure modes belong in the matching section of this
file, not inline — a comment running past two lines is the signal it has moved here.

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
take.

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
and everything else stays on the retry side.
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

The **only AI message** the bot sends. Hype, win and loss phrases were removed: the match post is a
scoreboard, and the event reminder and the 5/5 lock carry no quote. With one kind left there is no
`Kind` to key anything on — `adapters/ai.ts` has one system prompt, one budget and one fallback —
and `sanitize` always keeps paragraph breaks, which the one-liner kinds used to collapse.

The budget is 512 tokens and a 30s timeout. The two move together: a completion cut off at
`max_tokens` comes back truncated, one past the timeout not at all. The clock is roomy because
nobody waits on this call, and the timeout is per attempt, so `maxRetries: 0` still stands.

The budget is sized off the **ask**, not the average: 70 words is ~260 tokens at this project's
measured 2.5–3.7 per Ukrainian word, so it sits near double. Nothing inspects `finish_reason`, so an
overshoot ships truncated with no check able to catch it — headroom is the only defence. `MAX_WORDS`
is a number actually sent to the model; it once held one the ask never used. **Both were far larger
when the ask was 400–500 words** — they follow it down as well as up.

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
«17 років у грі» ships where an invented figure of 847 is rejected. Here the small numbers are the
dangerous ones, and only the prompt stands behind them.

The member reaches the model only as `P1`, which keeps a Latin username away from its
transliteration reflex, and any other code is rejected as invented. The swap in `phrase.ts`
**strips `<` and `>` from the name it substitutes**, because it runs *after* `sanitize` and
`balanceTags` — nothing checks it again, and `escapeAiHtml` turns `&lt;/i&gt;` back into a real tag.
A Telegram first name is arbitrary user text: a member named `</i>` shipped an unmatched tag, and
the sweep read the resulting 400 as a dead chat.

`P1` **takes no Ukrainian case ending** and the swap puts a bare nominative in its place —
«в P1 день народження» shipped as «в Олег день народження». The prompt therefore says to build every
sentence around P1 in the nominative and rephrase rather than decline it. Nothing can fix it
afterwards: the code carries no case to restore.

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

The word ceiling is **enforced** (`maxWords`), not just asked for: nobody waits on this call, so a
rejection costs only a second request.

`balanceTags` in `view/phrase.ts` is what keeps several bold fragments sendable. It replaced a pair
of per-tag regexes that could only see one tag at a time and read «`<b>a <i>b</i> c</b>`» as an
unclosed `<b>` — dropping the bold outright, or worse, dropping the open tag while an earlier `<b>`
in the message kept its `</b>` alive. Telegram rejects an unmatched close tag with a 400, and a
birthday message is invited to use several fragments.

There is **no recent-phrase memory**: a toast fires once per member per year, so there is nothing to
repeat within, and stored toasts would only be prepended to every later prompt. The angle and the
register are still rolled in code, through `rollFresh`, with a short freshness memory each.

There is **no callout or scoreline check** either: nothing has been played, so «точку B» is a
running joke about our plans, not a claim about a round, and no score is ever in play.

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
stored.

The database is deliberately never closed. SQLite auto-checkpoints the WAL every 1000 pages, so it
self-caps near 4MB unaided; closing on shutdown would race the FACEIT poll and the scheduler tick,
which both outlive `bot.stop()` and would then throw on a finalized statement mid-write. An
unclosed WAL is replayed on the next open — a half-written one is not.

## The AI call

Only the birthday toast calls the model — see **Birthday phrases**.

A DeepSeek call takes **2–3 seconds** on `deepseek-v4-pro` with `thinking` **disabled** — measured,
not guessed. Thinking is off deliberately: it cost 10x the latency (26s median, 40s max) for no
accuracy gain, over-applied `<b>`, and could outgrow `max_tokens` with its chain and return an empty
`content` — a silent fallback. It had been switched back on once already before anyone noticed,
precisely because an empty response just looks like a fallback. Re-enabling it means paying all of
that again.

`maxRetries: 0` is about **transport**: a failed call isn't worth repeating, and since `timeout` is
per attempt, retrying would double the ceiling rather than improve the odds. The timeout is not a
hard guarantee either — back when thinking was on, calls of 20–40s completed instead of aborting, so
the SDK's `timeout` evidently doesn't cover the response body.

A **check rejection is retried once** — a different case from a failed call, since the API worked and
the model merely broke a rule. `generateBirthdayPhrase` calls `generateOnce` twice, spelled out
rather than looped because the two asks differ: the second is `retryAsk(prompt, reason)`, the same
ask plus one sentence naming the rule that was broken. It takes the prompt and returns the whole
second one, so `view/prompt.ts` stays the only module that composes what the model reads. A blind
re-roll at temperature 0.8 was enough only when the mistake was incidental; when the *angle itself*
invited it, the model made the same mistake twice and fell back. The reason is free: the retry was
already happening, and `finalizePhrase` already returns why.

`RejectReason` and `PhraseVerdict` both live in `src/types.ts` for the same reason: phrase.ts
returns the verdict, ai.ts forwards it untouched, and the `"phrase" in result` narrowing on both
sides has to agree.

The correction wording lives in `view/prompt.ts`, like every other word sent to the model, and is
phrased as a correction rather than a restatement of the rule — repeating a rule the model has just
demonstrated it will skim past changes nothing.

Which is why **every rejection is logged** with its reason (`[ai] birthday rejected (elo): …`) and
an empty reply logged separately. Without that, a check misfiring and the API being down look
identical from the outside — the exact trap that let `thinking` sit switched on unnoticed.

**Fallbacks are for having no AI result, not for policing output.** `MAX_CHARS` in `view/phrase.ts`
is a transport bound rather than a style one — Telegram refuses a `sendMessage` over 4096 characters
outright, and `handlers/birthdays.ts` reads that 400 as a chat it can no longer post to, costing the
member their greeting for a year, silently. It sits well clear of any real toast: a backstop against
a runaway completion, so it does not move with the ask. The word ceiling shares its `too-long`
reason but is a separate check. The checks that do reject — a number we didn't supply, a `P`-code
we never issued, any Elo, English in a UA message — each catch something that would read as fact or
as broken text in the group, and each gets that second attempt first.

Terms that must come out in Latin with exact casing live in **one table**, `TERM_FIX` in
`view/phrase.ts`, alongside the Cyrillic spellings the model reaches for — map names included, since
de-transliterating «інферно» and re-casing `faceit` are the same operation. It replaced a
replace-per-term chain that had already drifted. Add new terms there, not as another `.replace`.
`Cache` is Latin-only on purpose — its transliteration «кеш» is also the Ukrainian for *cash*.

One thing is **stripped rather than rejected**: a leading preamble. A reply opened «Звісно, ось
повідомлення в заданому стилі: …» and shipped it. The message after the colon was fine, and a
rejection would spend the one retry, so `PREAMBLE` cuts it.

That strip is **silent** — no rejection, no log, no retry — so a false positive deletes a joke's
opening clause and nothing says so. It therefore matches only a bare handover: nothing between the
deictic (ось / here's) and the noun (повідомлення / message), and after it only a style-or-request
marker. Every looser version bit — bare stems matched «запит» inside «запитання», then «текст» ate
«Ось текст нашого заповіту:», then free text before the noun ate «Ось офіційне повідомлення
прес-служби:». A stray preamble shipping is the cheaper failure.

## Posting a result

A match is posted only if **`MIN_PLAYERS` (2) or more** linked members were on our team. Solo queue is one
member's business, and the scoreboard renders as a one-row table.

Gated in **one** place: `registered` in `buildMatchResult`, our team alone, before the scoreboard
fetch. Two of us queued onto opposite sides counts as one.

The count comes from the **match stats**, never from `candidates` in the history sweep. That
tally is built from each member's own recent-match history, and a failed history call — already
counted in `historyFailed` — would read a real squad game as solo and bury it permanently.

**Elo comes from the scoreboard alone**, so a skipped solo game is `markMatchPosted` and nothing
else. There used to be a stored baseline: live Elo from `getPlayerById`, diffed against the last
value saved per member. It was approximate — matches finished inside one poll shared one live value,
so the first posted carried the whole swing — and it needed a save rule for every path: posted,
skipped solo, held on a failed fetch, and pending behind another match. The scoreboard's exact
per-match change made all of it redundant, and it was removed rather than kept as a fallback. The
`faceit_elo` column it lived in stays in the `CREATE` — see **Schema** — but nothing reads or
writes it.

Matches post **oldest first**. They were sorted by member count first, but only so that the squad
match would own a swing it shared with a solo game — a question exact per-match Elo no longer asks.

The table is **three columns** — player with Elo, rating with swing, K/D/A with ADR — each cell
holding two lines under a header naming both. Four and five columns wrapped every cell on a phone,
headers included, and Telegram's rich table has no width control; `is_compact` (smaller padding) is
the only lever it offers, and is on. Rows sort by rating, ADR breaking ties.

`buildResultBlocks` is the **only** renderer. A plain-HTML version shipped alongside it as a
fallback from the day the rich card arrived, and was removed once the rich send had proved reliable
in the group: it cost two places to edit for every change to the post, and had never needed a change
itself.

The consequence to know is on the failure path. A rejected send is **not** `markMatchPosted`, so the
poll retries that match every `FACEIT_POLL_MINUTES` for 24 hours, re-fetching its stats and
scoreboard each time for a post nobody sees. If it ever starts biting, the fix is the
transient/permanent split `handlers/birthdays.ts` already makes — give up on a permanent 4xx, keep
retrying a 429 — not a second renderer. The likeliest rejection is the `photo` block: `mapImage` is
a FACEIT CDN URL that Telegram fetches server-side.

## Rating and swing

The open API has no FACEIT rating or swing; only faceit.com's own
`/api/statistics/v1/cs2/matches/{id}/match-rounds/1/scoreboard-summary` does, and it sits behind
Cloudflare. Plain `fetch` is challenged, so `adapters/faceit.ts` goes through `node-tls-client`
with the **chrome_131** profile and navigation headers (`sec-fetch-mode: navigate`) — 120/124 get
a challenge, `cors` gets a 403. No cookies or key. The match-wide `/scoreboard-summary` 403s
anonymous callers with `err_f0`; the per-map one does not, and it is what the site itself calls.
Only map 1 is read, matching `rounds[0]` on the open API side.

It is **best-effort by design**. A failed fetch logs `[faceit] scoreboard fetch failed` and the post
ships without the Rating column and without Elo lines, never held back: nothing says a Cloudflare
rejection clears by the next poll. The anonymous limit is **5 requests per
30s per IP**, and a catch-up poll of ten matches hit it on the sixth. A 429 therefore waits out the
`Ratelimit-Retry-After` it carries (plus a second, capped at 30s) and tries again, up to three
times — the poll runs in the background, and since the baseline was removed this is the only
source of per-player Elo. The fetch also runs **after** the `MIN_PLAYERS` gate, so a solo match
spends nothing from it. Swing is shown in percentage points; both it and rating are rounded to two places.

Not every match is readable anonymously: one freshly finished match in thirteen sampled answered
`403 err_f0` and kept doing so, while matches Cloudflare had never cached (`MISS`) served fine.
The cause is unknown, which is one more reason the fetch never holds a post back.

The same scoreboard carries **match-time Elo**, and is the only source of it: `elo` is Elo *going
into* the match — checked across three consecutive matches, where each `elo + elo_delta` was the
next one's `elo` — and `elo_delta` is that match's exact change. The post shows `elo + elo_delta`
with the change as the arrow; a player the scoreboard has no Elo for gets no Elo line.

The library loads a Go shared object through koffi. On Linux x64 it looks for
`os.tmpdir()/tls-client-x64.so` and, if missing, downloads the glibc build from
bogdanfinn/tls-client's *latest* release — unpinned. The Dockerfile therefore bakes that same
**ubuntu-amd64** build, pinned by version and sha256, at that exact path. Bump both args together.
On a dev machine the download is left to happen once.

**The image is Debian (`node:24-slim`), not Alpine, because of this library.** 1.15.0 shipped on
`node:24-alpine` with upstream's *alpine* build, and it would not load: `Error relocating …
tls-client-x64.so: free: initial-exec TLS resolves to dynamic definition`. A Go library built for
musl can't be `dlopen`ed into Node that way, whatever the file is called. The slim image has no
`wget`, `curl` or `pgrep`, so the Dockerfile fetches with Node and the healthcheck is `kill -0 1`.

`botuser` is created with **uid 100 / gid 101** explicitly — what `adduser -S` / `addgroup -S` gave
it on Alpine. The files already on the `/app/data` volume belong to those ids; a Debian-assigned
pair would boot unable to write `members.db`. CI builds both and fails if they differ.

That failed load also **crashed the process**, and not through the request. The pool starts several
workers up front; the one given the request failed it, which `getMatchScoreboard`'s caller caught
and logged — but the idle ones have no request to fail, so the pool emits `'error'`, and an
EventEmitter with no listener throws. `siteSession` therefore listens on the pool: a library that
won't load now logs `[faceit] tls worker failed` once per worker and costs the scoreboard only.

On a failed download the library calls **`process.exit(1)`** from inside `initTLS`, where no
`.catch` can reach it. `ensureNativeLibrary` runs the same check and download itself first, so a
failure throws instead and the post just loses Rating and Elo. The library creates the file
before downloading and keeps it on an HTTP error, so a failure also deletes it — left behind, every
later check would trust an empty library. That guard and the pool listener reach three internals,
typed by hand in `src/node-tls-client.d.ts` — re-check them on a `node-tls-client` bump.

## FACEIT links

**One writer**: `setFaceitAccount`, called only from `/faceit`, where it expresses a user's explicit
intent. The poll writes nothing to `members` at all. Keep it that way: its roster is a snapshot from
poll start, so any write back could resurrect a link that `/faceit off` removed mid-poll. There were
two writers while the poll saved an Elo baseline, and a `WHERE faceit_player_id = ?` guard on that
second one was all that stopped it.

## Dependencies

`@types/node` is pinned to the **24.x** line on purpose — its major tracks the Node runtime major,
and Node 24 is pinned in three places (`.nvmrc`, `engines` in `package.json`, `node:24-slim` in
the Dockerfile). `npm outdated` will keep offering 26.x; taking it would typecheck against APIs the
runtime doesn't have, and `node:sqlite` is exactly the kind of still-moving API where that bites.
Bump it only when all three Node pins move, and move them together.

## CI

`.github/workflows/ci.yml` runs two jobs on every PR into `main`. `typecheck` is the code gate —
there are no tests — and Deploy typechecks again before shipping, so a red one means the merge
would fail to deploy too.

`image` builds the real Docker image, because typecheck can't see inside it: 1.15.0 passed CI with
a native library that couldn't load in production. It checks that `botuser` still has the uid/gid
the Alpine image gave it, then runs `.github/ci/image-smoke.cjs` inside the container, which fails
if the TLS library won't load in the request worker or in any idle one. A 403 or 429 from
faceit.com still passes: the runner's IP may be challenged, but a status code means the library
worked.

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
