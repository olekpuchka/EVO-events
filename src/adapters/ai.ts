// The only module that constructs an LLM client. Everything about *what* is said
// lives in view/prompt.ts, and everything about judging the reply in
// view/phrase.ts — this file is the call, the retry and the fallback.

import OpenAI from "openai";
import { t } from "../view/i18n.ts";
import { hypePrompt, matchPrompt, remember, SYSTEM_PROMPT } from "../view/prompt.ts";
import { finalizePhrase } from "../view/phrase.ts";
import { DEEPSEEK_API_KEY } from "../config.ts";
import type { Kind, MatchPhraseContext, PhraseChecks } from "../types.ts";

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

// One attempt: null means the reply broke a rule and the caller may ask again.
// A thrown error is the API failing, which retrying wouldn't fix. Both log why —
// a silent drop to the fallback is indistinguishable from the API being down, and
// that is exactly how a switched-back-on `thinking` went unnoticed once already.
async function generateOnce(kind: Kind, prompt: string, checks: PhraseChecks): Promise<string | null> {
  const chat = await ai!.chat.completions.create({
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    // Generous for a 25-word message, but nothing caps the reply's length any more —
    // this is the only bound on how much a runaway answer can cost.
    max_tokens: 512,
    temperature: 0.8,
    // `thinking` is a DeepSeek extension absent from the OpenAI SDK types; spread
    // it in so the request carries it without a type error. Disabled deliberately —
    // 10x the latency for no accuracy gain, and its chain can eat max_tokens and
    // return an empty `content`. Don't re-enable it; see **The AI call** in CLAUDE.md.
    ...({ thinking: { type: "disabled" } } as object),
  });
  const text = chat.choices[0]?.message?.content?.trim();
  if (!text) {
    console.warn(`[ai] ${kind}: empty reply`);
    return null;
  }
  const result = finalizePhrase(text, kind, checks);
  if ("phrase" in result) return result.phrase;
  console.warn(`[ai] ${kind} rejected (${result.rejected}): ${text}`);
  return null;
}

async function generate(
  kind: Kind,
  prompt: string,
  checks: PhraseChecks,
  fallback: string
): Promise<string> {
  if (!ai) return fallback;
  try {
    // A rejection means the model broke a rule, not that we have no AI — so at 2–3s
    // a call, ask once more rather than ship a canned phrase. Temperature 0.8 makes
    // the second take differ. See **The AI call** in CLAUDE.md.
    for (let attempt = 0; attempt < 2; attempt++) {
      const phrase = await generateOnce(kind, prompt, checks);
      if (phrase) {
        remember(kind, phrase);
        return phrase;
      }
    }
  } catch (err) {
    console.error("[ai] generation failed:", (err as Error).message);
  }
  return fallback;
}

export async function generateHypePhrase(eventName: string | null): Promise<string> {
  const { prompt, checks } = hypePrompt(eventName);
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
