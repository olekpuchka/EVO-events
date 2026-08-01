// Every environment read in the project, in one place. Imports nothing, so any module can pull it
// in without dragging along a database or a network client. Values are coerced and clamped here
// but never rejected — bot.ts owns the "refuse to start" decision.
//
// A default here is half of a pair: the Dockerfile carries an `ENV` for the same variable and wins
// at runtime, so changing one alone never reaches the container. See CLAUDE.md.
//
// `||` not `??` throughout: an empty `VAR=` left in a .env reads as unset, not as "".

// Required — bot.ts exits without it.
export const BOT_TOKEN = process.env.BOT_TOKEN || "";

// Required for /faceit and match results; every request 401s without it.
export const FACEIT_API_KEY = process.env.FACEIT_API_KEY || "";

// Optional. Unset means built-in phrases instead of AI.
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";

// app/data inside the project; the image overrides this with the absolute /app/data volume mount.
// The deliberate exception to the keep-in-sync rule above — the two values differ on purpose.
export const DATA_DIR = process.env.DATA_DIR || "./app/data";

// Floored at 5 so a typo can't turn the poll into a hammer.
export const FACEIT_POLL_MINUTES = Math.max(5, Number(process.env.FACEIT_POLL_MINUTES) || 20);

// Comma-separated Telegram user IDs whose typed event times mean CET, not Kyiv. Parsed by
// eventtime.ts, which warns about entries that aren't user IDs.
export const EU_TIMEZONE_MEMBERS = process.env.EU_TIMEZONE_MEMBERS || "";
