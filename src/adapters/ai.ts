// The only module that constructs an LLM client. Everything about *what* is said
// lives in view/prompt.ts, and everything about judging the reply in
// view/phrase.ts — this file is the call, the retry and the fallback.

import OpenAI from "openai";
import { t } from "../view/i18n.ts";
import { birthdayPrompt, hypePrompt, matchPrompt, remember, retryAsk, SYSTEM_PROMPTS } from "../view/prompt.ts";
import { finalizePhrase } from "../view/phrase.ts";
import { DEEPSEEK_API_KEY } from "../config.ts";
import type { BirthdayContext, HypeContext, Kind, MatchPhraseContext, PhraseChecks, PhraseVerdict } from "../types.ts";

// Both callers block on this: handleRsvp before the 5/5 edit, sendReminder after the scheduler
// already claimed the row. `maxRetries: 0` is about transport — a failed call is not worth
// repeating, and the SDK applies `timeout` per attempt, so retrying would double the ceiling
// instead of improving the odds. `generate` does retry once, but only when a check rejects an
// otherwise-successful call. Against a measured 2–3s, 15s is pure slack — and not a hard guarantee
// either: calls have run well past it without aborting, so it evidently doesn't cover the body.
const ai = DEEPSEEK_API_KEY
  ? new OpenAI({
      apiKey: DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
      timeout: 15_000,
      maxRetries: 0,
    })
  : null;

// One entry per kind so the two bounds can't drift: a completion cut off at maxTokens comes back
// truncated, one past timeoutMs not at all. Sized off the *ask*, not the average — 70 words is
// ~260 tokens at this project's measured 2.5–3.7 per Ukrainian word, and nothing inspects
// finish_reason, so headroom is the only defence. Birthday's roomier clock is because nobody
// waits on it.
const SHORT_LIMITS = { maxTokens: 512, timeoutMs: 15_000 };
const LIMITS: Record<Kind, { maxTokens: number; timeoutMs: number }> = {
  hype: SHORT_LIMITS,
  win: SHORT_LIMITS,
  loss: SHORT_LIMITS,
  birthday: { maxTokens: 512, timeoutMs: 30_000 },
};

// What ships with no AI result — no key, a failed call, or two rejected replies. Keyed so
// `generate` looks its own up rather than taking one a caller could mispair.
const FALLBACKS: Record<Kind, string> = {
  hype: t("fallbackHype"),
  win: t("fallbackWin"),
  loss: t("fallbackLoss"),
  birthday: t("fallbackBirthday"),
};

// One attempt. A rejection carries its reason so the retry can name it; a thrown error is the
// API failing. Both log — a silent fallback looks exactly like the API being down.
async function generateOnce(
  kind: Kind,
  prompt: string,
  checks: PhraseChecks
): Promise<PhraseVerdict> {
  const chat = await ai!.chat.completions.create(
    {
      model: "deepseek-v4-pro",
      // Per kind — a birthday toast speaks under different rules. prompt.ts owns every word.
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[kind] },
        { role: "user", content: prompt },
      ],
      // The only bound on a runaway answer. Measured: 35 Ukrainian words is 86–131 tokens,
      // so `MAX_WORDS` in view/prompt.ts has room to move before this matters.
      max_tokens: LIMITS[kind].maxTokens,
      temperature: 0.8,
      // `thinking` is a DeepSeek extension absent from the OpenAI SDK types; spread
      // it in so the request carries it without a type error. Disabled deliberately —
      // 10x the latency for no accuracy gain, and its chain can eat max_tokens and
      // return an empty `content`. Don't re-enable it; see **The AI call** in CLAUDE.md.
      ...({ thinking: { type: "disabled" } } as object),
    },
    // Per request, overriding the client's bound. Still per attempt, so `maxRetries: 0` stands.
    { timeout: LIMITS[kind].timeoutMs }
  );
  const text = chat.choices[0]?.message?.content?.trim();
  // Logged apart from a rejection — the API returned nothing, rather than the reply
  // breaking a rule — but naming the verdict stays view/phrase.ts's job.
  if (!text) console.warn(`[ai] ${kind}: empty reply`);
  const result = finalizePhrase(text ?? "", kind, checks);
  if ("phrase" in result) return result;
  // One line per failure: an empty reply already logged above, and repeating it here as
  // `(empty): undefined` blurs the distinction that line exists to draw.
  if (text) console.warn(`[ai] ${kind} rejected (${result.rejected}): ${text}`);
  return result;
}

async function generate(kind: Kind, prompt: string, checks: PhraseChecks): Promise<string> {
  const fallback = FALLBACKS[kind];
  if (!ai) return fallback;
  try {
    // A broken rule, not a broken API, so at 2–3s a call it's worth asking again. Not looped,
    // because the second ask names what was rejected — temperature alone re-rolled the mistake.
    const first = await generateOnce(kind, prompt, checks);
    const result = "phrase" in first
      ? first
      : await generateOnce(kind, retryAsk(prompt, first.rejected), checks);
    if ("phrase" in result) {
      remember(kind, result.phrase);
      return result.phrase;
    }
  } catch (err) {
    console.error("[ai] generation failed:", (err as Error).message);
  }
  return fallback;
}

export async function generateHypePhrase(eventName: string | null, context: HypeContext = {}): Promise<string> {
  const { prompt, checks } = hypePrompt(eventName, context);
  return generate("hype", prompt, checks);
}

export async function generateMatchPhrase(
  won: boolean,
  score: string,
  context: MatchPhraseContext = {}
): Promise<string> {
  const { prompt, checks } = matchPrompt(won, score, context);
  return generate(won ? "win" : "loss", prompt, checks);
}

// The member reaches the model only as P1; view/phrase.ts swaps `name` back in.
export async function generateBirthdayPhrase(name: string, context: BirthdayContext): Promise<string> {
  const { prompt, checks } = birthdayPrompt(name, context);
  return generate("birthday", prompt, checks);
}
