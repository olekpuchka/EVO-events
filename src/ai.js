import Groq from "groq-sdk";
import { t, LANG } from "./i18n.js";

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const FALLBACK_HYPE = t("fallbackHype");
const FALLBACK_WIN = t("fallbackWin");
const FALLBACK_LOSS = t("fallbackLoss");

const LANGUAGE_INSTRUCTION = LANG === "UA" ? " Respond in Ukrainian." : "";

const ELO_MENTION = /(?<![\p{L}\p{N}])(elo|ело)(?![\p{L}\p{N}])/iu;

async function generate(prompt, fallback, { allowElo = true } = {}) {
  if (!groq) return fallback();
  try {
    const chat = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt + LANGUAGE_INSTRUCTION }],
      max_tokens: 150,
      temperature: 0.8,
    });
    const text = chat.choices[0]?.message?.content?.trim();
    if (!text) return fallback();
    let result = text
      .replace(/["'"']/g, "").replace(/@(?=\w)/g, "")
      .replace(/[*_`#~|]/g, "")
      .replace(/<(?!\/?(?:b|i)>)[^>]*>/g, "")
      .replace(/(?<![\p{L}\p{N}])\p{Lu}{2,}(?![\p{L}\p{N}])/gu, w => w.toLowerCase())
      .replace(/\badr\b/gi, "ADR")
      .replace(/(?<![\p{L}\p{N}])ело(?![\p{L}\p{N}])/giu, "Elo")
      .replace(/<\/\d+>/g, "")
      .replace(/^<i>(.*)<\/i>$/, (_, inner) => inner.includes("</i>") ? `<i>${inner}</i>` : inner)
      .replace(/<b>(?![^<]*<\/b>)/g, "").replace(/<i>(?![^<]*<\/i>)/g, "")
      .replace(/<\/b>/g, (m, off, s) => s.slice(0, off).includes("<b>") ? m : "")
      .replace(/<\/i>/g, (m, off, s) => s.slice(0, off).includes("<i>") ? m : "");
    if (!allowElo && ELO_MENTION.test(result)) return fallback();
    const emojis = [...(result?.matchAll(/\p{Emoji_Presentation}/gu) ?? [])];
    if (emojis.length > 1) {
      const lastIdx = emojis[emojis.length - 1].index;
      result = result.replace(/\p{Emoji_Presentation}/gu, (m, off) => off === lastIdx ? m : "");
    }
    return result || fallback();
  } catch (err) {
    console.error("[ai] generation failed:", err.message);
    return fallback();
  }
}

export async function generateHypePhrase(eventName) {
  const context = eventName ? `for an event called "${eventName}"` : "for a CS2 session";
  return generate(
    `You are a hype bot for a casual CS2 gaming group chat.` +
    ` A squad just filled up ${context}.` +
    ` Write ONE hype message to fire them up. You MUST end the message with exactly 1 emoji — never omit it. Rules: max 15 words, funny and energetic, no uppercase words, no quotes, and do NOT repeat the event name or start time — they are already shown above your message.` +
    ` Use <b>bold</b> or <i>italic</i> Telegram HTML tags sparingly to emphasize specific words only. No other HTML tags. No markdown whatsoever. Output only the message, nothing else.`,
    () => FALLBACK_HYPE
  );
}

export async function generateMatchPhrase(won, score, { map, elo, players } = {}) {
  const topPlayers = players?.filter(p => p.adr >= 90) ?? [];
  const playerStr = topPlayers.length
    ? topPlayers.map(p => `${p.nickname} (${p.adr} ADR)`).join(", ")
    : null;

  const upsetWin = elo && elo.theirs - elo.ours >= 75;
  const upsetLoss = elo && elo.ours - elo.theirs >= 75;

  const context = [
    score,
    map ? `on ${map}` : null,
    upsetWin ? `(upset win — our team was ${elo.ours} Elo but beat a higher-rated ${elo.theirs} Elo enemy)` : null,
    upsetLoss ? `(lost to a lower-rated team: our team was ${elo.ours} Elo but lost to a ${elo.theirs} Elo enemy)` : null,
    !upsetWin && !upsetLoss && won ? `(normal win)` : null,
    !upsetWin && !upsetLoss && !won ? `(normal loss)` : null,
  ].filter(Boolean).join(" ");

  if (won) {
    const playerInstruction = playerStr
      ? `Exactly these players had 90+ ADR: ${playerStr}. You may mention one or more of them. NEVER invent player names or ADR values — if you mention a player name or ADR number, it must come verbatim from this list and nowhere else. Keep every player nickname in English exactly as written — never translate or transliterate it (e.g. never write "Transend" as "Трансенд").`
      : `Do not mention any player names or statistics.`;
    return generate(
      `You are a hype bot for a casual CS2 gaming group chat.` +
      ` The squad just WON ${context}.` +
      ` Write ONE short funny celebratory message. You MUST end the message with exactly 1 emoji — never omit it. ${playerInstruction} ${upsetWin ? "Hype the upset angle." : "Do NOT use the word upset."} Mention the map name naturally if it fits — keep it in English exactly as given, never translate or transliterate it (e.g. never write "Inferno" as "Інферно"). Only mention Elo ratings if they are explicitly provided in the context — never invent Elo numbers. If you do mention Elo, always write it as X Elo, never as Xs or shorthand, and always spell "Elo" in English — never translate or transliterate it (e.g. never write "ело"). Rules: max 25 words, positive and triumphant tone, no uppercase words, do NOT mention losing or anything negative, no quotes.` +
      ` Use <b>bold</b> or <i>italic</i> Telegram HTML tags sparingly to emphasize specific words only. No other HTML tags. No markdown whatsoever. Output only the message, nothing else.`,
      () => FALLBACK_WIN,
      { allowElo: Boolean(upsetWin) }
    );
  }
  return generate(
    `You are a hype bot for a casual CS2 gaming group chat.` +
    ` The squad just LOST ${context}.` +
    ` Write ONE short funny sarcastic message. You MUST end the message with exactly 1 emoji — never omit it. Pick ONE angle: either mock the enemy's suspiciously perfect aim (spinbots, wallhacks, 97% HS rate) OR blame FACEIT anticheat for being asleep on the job. If they lost to a lower-rated team, make the cheater accusation even more dramatic. Mention the map name naturally if it fits — keep it in English exactly as given, never translate or transliterate it (e.g. never write "Inferno" as "Інферно"). Keep it punchy, never blame the team. Only mention Elo ratings if they are explicitly provided in the context — never invent Elo numbers. If you do mention Elo, always write it as X Elo, never as Xs or shorthand, and always spell "Elo" in English — never translate or transliterate it (e.g. never write "ело"). Rules: max 20 words, no uppercase words, no quotes.` +
    ` Use <b>bold</b> or <i>italic</i> Telegram HTML tags sparingly to emphasize specific words only. No other HTML tags. No markdown whatsoever. Output only the message, nothing else.`,
    () => FALLBACK_LOSS,
    { allowElo: Boolean(upsetLoss) }
  );
}
