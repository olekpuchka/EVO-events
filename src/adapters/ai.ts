// The only module that constructs an LLM client. Everything about *what* is said
// lives in view/prompt.ts, and everything about judging the reply in
// view/phrase.ts — this file is the call, the retry and the fallback.

import OpenAI from "openai";
import { t } from "../view/i18n.ts";
import { birthdayPrompt, retryAsk, SYSTEM_PROMPT } from "../view/prompt.ts";
import { finalizePhrase } from "../view/phrase.ts";
import { DEEPSEEK_API_KEY } from "../config.ts";
import type { PhraseChecks, PhraseVerdict } from "../types.ts";

// `maxRetries: 0` is about transport: `timeout` applies per attempt, so a retry doubles the
// ceiling instead of improving the odds. Nobody waits on a birthday toast, hence the roomy 30s.
const ai = DEEPSEEK_API_KEY
  ? new OpenAI({
      apiKey: DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
      timeout: 30_000,
      maxRetries: 0,
    })
  : null;

// Sized off the ask, not the average: 70 words is ~260 tokens at the measured 2.5–3.7 per
// Ukrainian word, and nothing inspects finish_reason, so headroom is the only defence.
const MAX_TOKENS = 512;

// What ships with no AI result — no key, a failed call, or two rejected replies.
const FALLBACK = t("fallbackBirthday");

// One attempt. A rejection carries its reason so the retry can name it; a thrown error is the
// API failing. Both log — a silent fallback looks exactly like the API being down.
async function generateOnce(prompt: string, checks: PhraseChecks): Promise<PhraseVerdict> {
  const chat = await ai!.chat.completions.create({
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0.8,
    // A DeepSeek extension absent from the SDK types, spread in. Disabled deliberately —
    // see **The AI call** in CLAUDE.md before re-enabling it.
    ...({ thinking: { type: "disabled" } } as object),
  });
  const text = chat.choices[0]?.message?.content?.trim();
  // Logged apart from a rejection: the API returned nothing, rather than the reply breaking a rule.
  if (!text) console.warn("[ai] birthday: empty reply");
  const result = finalizePhrase(text ?? "", checks);
  if ("phrase" in result) return result;
  // An empty reply already logged above; `(empty): undefined` would blur that distinction.
  if (text) console.warn(`[ai] birthday rejected (${result.rejected}): ${text}`);
  return result;
}

// The member reaches the model only as P1; view/phrase.ts swaps `name` back in.
export async function generateBirthdayPhrase(name: string, age: number): Promise<string> {
  if (!ai) return FALLBACK;
  const { prompt, checks } = birthdayPrompt(name, age);
  try {
    // A broken rule, not a broken API, so it's worth asking again. Not looped, because the second
    // ask names what was rejected — temperature alone re-rolled the mistake.
    const first = await generateOnce(prompt, checks);
    const result = "phrase" in first ? first : await generateOnce(retryAsk(prompt, first.rejected), checks);
    if ("phrase" in result) return result.phrase;
  } catch (err) {
    console.error("[ai] generation failed:", (err as Error).message);
  }
  return FALLBACK;
}
