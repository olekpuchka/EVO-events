// The only module that constructs an LLM client. Everything about *what* is said
// lives in view/prompt.ts, and everything about judging the reply in
// view/phrase.ts — this file is the call, the retry and the fallback.

import OpenAI from "openai";
import { t } from "../view/i18n.ts";
import { hypePrompt, matchPrompt, remember, retryAsk, SYSTEM_PROMPT } from "../view/prompt.ts";
import { finalizePhrase } from "../view/phrase.ts";
import { DEEPSEEK_API_KEY } from "../config.ts";
import type { HypeContext, Kind, MatchPhraseContext, PhraseChecks, PhraseVerdict } from "../types.ts";

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

const FALLBACK_HYPE = t("fallbackHype");
const FALLBACK_WIN = t("fallbackWin");
const FALLBACK_LOSS = t("fallbackLoss");

// One attempt. A rejection carries its reason so the retry can name it; a thrown error is the
// API failing. Both log — a silent fallback looks exactly like the API being down.
async function generateOnce(
  kind: Kind,
  prompt: string,
  checks: PhraseChecks
): Promise<PhraseVerdict> {
  const chat = await ai!.chat.completions.create({
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    // The only bound on a runaway answer. Measured: 35 Ukrainian words is 86–131 tokens,
    // so `MAX_WORDS` in view/prompt.ts has room to move before this matters.
    max_tokens: 512,
    temperature: 0.8,
    // `thinking` is a DeepSeek extension absent from the OpenAI SDK types; spread
    // it in so the request carries it without a type error. Disabled deliberately —
    // 10x the latency for no accuracy gain, and its chain can eat max_tokens and
    // return an empty `content`. Don't re-enable it; see **The AI call** in CLAUDE.md.
    ...({ thinking: { type: "disabled" } } as object),
  });
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

async function generate(
  kind: Kind,
  prompt: string,
  checks: PhraseChecks,
  fallback: string
): Promise<string> {
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
  return generate("hype", prompt, checks, FALLBACK_HYPE);
}

export async function generateMatchPhrase(
  won: boolean,
  score: string,
  context: MatchPhraseContext = {}
): Promise<string> {
  const { prompt, checks } = matchPrompt(won, score, context);
  return generate(won ? "win" : "loss", prompt, checks, won ? FALLBACK_WIN : FALLBACK_LOSS);
}
