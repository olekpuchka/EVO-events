import Groq from "groq-sdk";

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const FALLBACK_HYPE = "Banana squad, rise up! 🍌";
const FALLBACK_WIN = "WE ARE SO BACK 🍌🍌🍌";
const FALLBACK_LOSS = "Their VAC-clean accounts played suspiciously well 🤔";

async function generate(prompt, fallback) {
  if (!groq) return fallback();
  try {
    const chat = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0.9,
    });
    const text = chat.choices[0]?.message?.content?.trim();
    if (!text) return fallback();
    let result = text
      .replace(/["'"']/g, "").replace(/@(?=\w)/g, "")
      .replace(/[*_`#~|]/g, "")
      .replace(/<(?!\/?(?:b|i)>)[^>]*>/g, "")
      .replace(/\b[A-Z]{2,}\b/g, w => w === "ADR" ? w : w.toLowerCase())
      .replace(/<\/\d+>/g, "")
      .replace(/^<i>(.*)<\/i>$/, (_, inner) => inner.includes("</i>") ? `<i>${inner}</i>` : inner)
      .replace(/<b>(?![^<]*<\/b>)/g, "").replace(/<i>(?![^<]*<\/i>)/g, "")
      .replace(/<\/b>/g, (m, off, s) => s.slice(0, off).includes("<b>") ? m : "")
      .replace(/<\/i>/g, (m, off, s) => s.slice(0, off).includes("<i>") ? m : "");
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
    ` Write ONE hype message to fire them up. Rules: max 15 words, exactly 1 emoji placed at the end, funny and energetic, no uppercase words, no quotes.` +
    ` Use <b>bold</b> or <i>italic</i> Telegram HTML tags sparingly to emphasize specific words only. No other HTML tags. No markdown whatsoever. Output only the message, nothing else.`,
    () => FALLBACK_HYPE
  );
}

export async function generateMatchPhrase(won, score, { map, elo, players } = {}) {
  const topPlayers = players?.filter(p => p.adr >= 90) ?? [];
  const playerStr = topPlayers.length
    ? topPlayers.map(p => `${p.nickname} (${p.adr} ADR)`).join(", ")
    : null;

  const upsetWin = elo && elo.theirs > elo.ours;
  const upsetLoss = elo && elo.theirs < elo.ours;

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
      ? `Some players had 90+ ADR: ${playerStr} — you may mention any of them, but only use names and ADR numbers from this list.`
      : `Do not mention any player names or statistics.`;
    return generate(
      `You are a hype bot for a casual CS2 gaming group chat.` +
      ` The squad just WON ${context}.` +
      ` Write ONE short funny celebratory message. ${playerInstruction} ${upsetWin ? "Hype the upset angle." : "Do NOT use the word upset."} Mention the map name naturally if it fits. If you mention Elo ratings, always write them as X Elo, never as Xs or shorthand. Rules: max 25 words, exactly 1 emoji placed at the end, positive and triumphant tone, no uppercase words, do NOT mention losing or anything negative, no quotes.` +
      ` Use <b>bold</b> or <i>italic</i> Telegram HTML tags sparingly to emphasize specific words only. No other HTML tags. No markdown whatsoever. Output only the message, nothing else.`,
      () => FALLBACK_WIN
    );
  }
  return generate(
    `You are a hype bot for a casual CS2 gaming group chat.` +
    ` The squad just LOST ${context}.` +
    ` Write ONE short funny sarcastic message. Pick ONE angle: either mock the enemy's suspiciously perfect aim (spinbots, wallhacks, 97% HS rate) OR blame FACEIT anticheat for being asleep on the job. If they lost to a lower-rated team, make the cheater accusation even more dramatic. Mention the map name naturally if it fits. Keep it punchy, never blame the team. Only mention Elo ratings if they are explicitly provided in the context — never invent Elo numbers. If you do mention Elo, always write it as X Elo, never as Xs or shorthand. Rules: max 20 words, exactly 1 emoji placed at the end, no uppercase words, no quotes.` +
    ` Use <b>bold</b> or <i>italic</i> Telegram HTML tags sparingly to emphasize specific words only. No other HTML tags. No markdown whatsoever. Output only the message, nothing else.`,
    () => FALLBACK_LOSS
  );
}
