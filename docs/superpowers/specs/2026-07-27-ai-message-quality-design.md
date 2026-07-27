# AI message quality — design

Date: 2026-07-27
Scope: `src/ai.ts`, `src/voice.ts` (new), `src/db.ts`, `src/types.ts`,
`scripts/ai-preview.ts` (new), `package.json`, `.env.example`, `README.md`

## Problem

Match-result and hype lines posted to the squad chat are repetitive and recognisably
templated. Six weeks of production output shows the same ~15 jokes cycling, sometimes
twice in one evening.

### Root cause: the angles are finished jokes

`HYPE_ANGLES` / `WIN_ANGLES` / `LOSS_ANGLES` are Ukrainian imperatives that already
contain the punchline. The model is therefore a paraphraser, not a writer:

| Angle in `src/ai.ts` | Posted to chat |
|---|---|
| `подай перемогу як суху бухгалтерію: +25 у скарбничку, рахунок закрито, банк наш` | «+25 в скарбничку, рахунок закрито. Банк наш — чистий прибуток.» |
| `оформи ворожі промахи як офіційний звіт: постріли 1-5 — явно повз, 6-9 — віддача` | «офіційний звіт: постріли 1-5 — повз, 6-9 — віддача» (3× in 3 days) |
| `подай суперників як п'ять decoy-гранат: стоять, шумлять, фрагів не приносять` | «Суперники — як п'ять decoy-гранат: стоять, шумлять, а фрагів нуль.» |

Confirmed empirically: four generations from one Ukrainian angle produced four near-identical
outputs; four generations from an English situational premise produced four distinct ones.

### Contributing causes

1. **Anti-repeat state is in RAM.** `recentAngles` (ai.ts:108) and `recentPhrases` (ai.ts:126)
   reset on every container restart, so the bot re-tells a joke it "remembers" telling.
2. **Stat dumps.** `playerFacts` emits the full statline and the prompt says "quoting its
   numbers exactly", producing «Winfle: 16/8/8, 117.9 ADR, 56% HS, 318 utility damage» — the
   same numbers already rendered in the table attached to the message.
3. **One syntactic shape.** Almost every message is `<clause> — <clause>`, inherited from the
   angles' own shape and from compressing setup+punchline into 25 words.
4. **Acronyms are destroyed.** The ALL-CAPS lowercasing rule (ai.ts:185) runs before the
   restoration list, so OT, LAN, MVP, FPS, CS2 ship lowercase («на lan відповімо», «22:19 в ot»).
   Cyrillic transliterations (авп, фейсіт) are not covered at all.
5. **Score echoed and contradicted.** Header shows `❌ 11:13`; the line says «виграли 13:11».
   The score and map are already in the header and on the screenshot.
6. **Silent truncation → static fallback.** Measured on `deepseek-v4-pro`: with
   `max_tokens: 2048`, 1 in 10 requests returns `finish_reason: "length"` with an empty
   message because the reasoning chain consumed the whole budget. A 4096 probe measured 0/10
   (peak reasoning 1798 tokens), but a later run truncated there too, so the sample was simply
   too small to see the tail. Omitting the `thinking` parameter does **not**
   disable reasoning on this model — a 600-token cap produced 8/10 empty responses with 600
   reasoning tokens each. `max_tokens` is the only effective lever.

## Design

### 1. Model

`deepseek-v4-flash` → `deepseek-v4-pro`, overridable with `DEEPSEEK_MODEL`. `max_tokens`
2048 → 8192 (see cause 6 — a correctness fix, not tuning; 4096 still truncated occasionally in
testing, and the cap is free until it bites). `thinking` stays enabled.

`temperature` stays at 0.9. It was raised to 1.15 first, on the usual "creative writing wants
a high temperature" reasoning, and measured against 0.9 on identical scenarios: variety was
indistinguishable — the rolled axes were already supplying it — while coherence visibly
degraded, producing «Вручили нам -rep-медалі Winfle за 318 утіліті отримав шорт на Dust2
байдуже». Variety is a code concern in this design, not a sampling one, so the temperature can
sit where the grammar holds.

### 2. Composition axes

Replace the single angle axis with three, all rolled in code — the same rationale as the
existing angle roulette (ai.ts:40): an LLM asked to choose converges on the most probable
option, so the choice must not be the model's.

- **Premise** (~24 per kind) — *what* the joke is about. Rewritten as English situations
  carrying no finished punchline. English is a mechanical anti-paraphrase device: output must
  be Ukrainian, so the wording cannot be copied and has to be invented.
- **Register** (~8, filtered per kind) — *how* it is said: deadpan, fake HLTV analyst,
  performative indifference, bureaucratic, absurdist, overheard enemy comms, and so on. The
  same premise reads differently per register, so variety multiplies without new premises.
- **Form** (6, applied 60% of the time) — the shape: a question, a one-word verdict then the
  explanation, two sentences, a single short sentence, "no dash or colon anywhere", or "begin
  with a verb". Kills the `A — B` template in code rather than hoping the model complies. Each
  form carries an escape hatch — drop the shape rather than the grammar — because the first
  version included "no commas and no dashes", which Ukrainian syntax cannot honour cleanly.

24 × 8 × 6 replaces 15 single-axis angles.

Premises become `{ id, emoji, text }` so history can key on the id, and live in their own module
(`src/voice.ts`) so tuning the humour never means touching the generator.

A premise must not carry a voice instruction ("in the tone of a tired clerk"): the register
axis owns the voice, and a premise that also dictates one overrides it and collapses the
variety the second axis exists to provide.

### 3. Reference glossary

The premises lean on scene references — s1mple, ZywOo, donk, Stockholm 2021, Boston 2018,
aim_botz, Zeus x27, subtick, VAC. The model knows the tokens but not reliably what they mean,
so it used them as decoration: «Гайда на сервер, s1mple-і — там і визначиться ZywOo» names two
players and says nothing.

`GLOSSARY` in `src/voice.ts` explains each reference — who the person is, why the event matters,
what makes the term a joke — and is concatenated into the static system prompt, where DeepSeek's
context caching makes it nearly free per call. It sits beside the premises so the two are edited
together: a premise leaning on something unexplained is a missing glossary line.

The same failure had a second cause. The model was compressing the setup out of the joke to fit
the word budget, leaving the punchline unsupported. Two changes address that: an explicit rule
that the reader never sees the premise, so a reference that needs a setup gets one; and a word
budget raised from 22 to 26 to pay for it.

### 4. Emoji

One emoji is appended in code after generation, keeping it out of the model's hands. It was
drawn at random from a per-kind bag, which is why a bureaucratic joke about a filed appeal could
ship with 🚀. It now lives on the premise itself (`Premise.emoji`), so it comments on the
specific joke, stays deterministic, and is edited on the same line as the text it belongs to.
The per-kind `EMOJIS` bags are gone; the static i18n fallbacks carry their own emoji already.

### 5. Content rules

- The score is never printed as digits. The prompt receives the *shape* of the result
  (comfortable win, nail-biter, overtime, comeback) instead of the numbers.
- The map name is mentioned only when the joke is genuinely about the map; never as a label
  prefix («Mirage: …»).
- At most **one** player fact reaches the prompt — the single most notable one — instead of the
  full statline. Stats still drive the joke; they are no longer recited. The fact is phrased as
  a full clause ("took the opening kill in 5 rounds"), not a scoreboard label ("5 entry
  frags"), because the label form was misread into «п'ятим фрагом» — the fifth kill.

### 6. Persistent anti-repeat

New SQLite table:

```sql
CREATE TABLE IF NOT EXISTS ai_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,          -- hype | win | loss
  premise_id TEXT NOT NULL,
  register_id TEXT NOT NULL,
  phrase     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Per kind, reads back the last 8 premise ids, 3 register ids and 4 phrases; everything beyond
the newest 40 rows of that kind is pruned on write. Survives redeploys, which the current
in-memory version does not. Phrases are stored without the trailing emoji, since they are fed
back to the model as "differ from these" and examples carrying emoji invite it to add its own.

### 7. Sanitizer

- ALL-CAPS lowercasing gains an allowlist of real gaming acronyms (OT, LAN, VAC, MVP, CS2,
  FPS, GG, HLTV, ADR, AWP, HS, KD, EVO, ACE) so only genuine shouting is lowered.
- Cyrillic → Latin restoration for авп→AWP, фейсіт→FACEIT, хс→HS, лан→LAN, овертайм kept as
  the Ukrainian word.
- One retry when a guard rejects the output (empty, `finish_reason: "length"`, over-length,
  hallucinated player code, disallowed Elo mention, Russian orthography) before falling back to
  the static phrase. The retry carries a corrective hint naming what went wrong.
- Russian leakage is caught by testing for ё, ы, э and ъ — none of which exist in Ukrainian.
  «смёрф-вердикт» shipped in testing before this guard was added.
- Echoing the score is a *soft* rejection: it retries once, then ships anyway. A slightly off
  message beats the same canned fallback every time.
- Rejections log their reason, so guard tuning stops being guesswork.

### 8. Verification

`scripts/ai-preview.ts`, run via `npm run ai:preview`, generates N samples of each kind against
the live API and prints them. Used to validate this change and to tune prompts later without
deploying.

## Out of scope

FACEIT polling and parsing, the result card and table renderers, RSVP flow, timezone handling,
i18n keys other than the three fallback phrases.
