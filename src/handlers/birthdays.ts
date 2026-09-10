// Birthdays: the `/birthday` command and the daily sweep that greets whoever has one today.
// Split from events.ts for the same reason results.ts is — it shares no state with the event
// lifecycle and changes for its own reasons (a calendar, not an RSVP).

import { trackMember, setBirthday, clearBirthday, getBirthday, getDueBirthdays, markBirthdayGreeted } from "../adapters/db.ts";
import { generateBirthdayPhrase } from "../adapters/ai.ts";
import { buildMention, escapeAiHtml } from "../view/html.ts";
import { sendEphemeral, groupOnly } from "./guards.ts";
import { t } from "../view/i18n.ts";
import { parseBirthday, formatBirthday, ageToday, isDueOn, todayInGroupTz, dueMonthDays } from "../view/birthday.ts";
import { GrammyError } from "grammy";
import type { Context, Api, CommandContext } from "grammy";
import type { DueBirthdayRow } from "../types.ts";

// The same three-way shape as `/faceit`: no argument reports, `off` removes, anything else is a
// value to store. An argument rather than three commands, so it costs one menu row — see
// **Command menu** in CLAUDE.md.
export const registerBirthday = groupOnly(async (ctx: CommandContext<Context>, from) => {
  const { iso: today } = todayInGroupTz();
  const arg = ctx.match?.trim();

  if (!arg) {
    const row = getBirthday(ctx.chat.id, from.id);
    const headline = row
      ? t("birthdayStatus", formatBirthday(row.birth_date), ageToday(row.birth_date, today))
      : t("birthdayNotSet");
    await sendEphemeral(ctx, `${headline}\n\n${t(row ? "birthdayChangeHelp" : "birthdayUsage")}`, { parse_mode: "HTML" });
    return;
  }

  // Lowercased here and not upstream: bot.ts normalises the command, never its argument.
  if (arg.toLowerCase() === "off") {
    if (!getBirthday(ctx.chat.id, from.id)) {
      await sendEphemeral(ctx, `${t("birthdayNotSet")}\n\n${t("birthdayUsage")}`, { parse_mode: "HTML" });
      return;
    }
    clearBirthday(ctx.chat.id, from.id);
    console.log("[birthday] removed");
    await sendEphemeral(ctx, t("birthdayRemoved"), { parse_mode: "HTML" });
    return;
  }

  const birthDate = parseBirthday(arg, today);
  if (!birthDate) {
    // The typed date is never echoed back: it failed to parse, so it is arbitrary user text and
    // saying "25-08-19900 is not a date" adds nothing the format line doesn't.
    await sendEphemeral(ctx, t("birthdayUsage"), { parse_mode: "HTML" });
    return;
  }

  // The sweep joins on `members` for the name, so the row has to exist. Like `/faceit`, this
  // opts a never-tracked member into `@all` — a fresh row defaults to notifications on.
  trackMember(ctx.chat.id, from);
  setBirthday(ctx.chat.id, from.id, birthDate);
  console.log("[birthday] saved");
  await sendEphemeral(
    ctx,
    t("birthdaySaved", formatBirthday(birthDate), ageToday(birthDate, today)),
    { parse_mode: "HTML" }
  );
});

// A transient send failure retries forever, so the *cost* is bounded instead of the retry: the
// toast is written once and a retry pays for the send alone. In memory, like the event caches in
// events.ts. See **Birthdays** in CLAUDE.md.
const phraseCache = new Map<string, string>();

// Never cached — holding it would keep shipping the canned toast after the API recovered.
const FALLBACK_BIRTHDAY = t("fallbackBirthday");

// Keyed on everything the toast is written from, so a corrected year or a rename misses the cache
// rather than shipping text that outlived its facts.
const phraseKey = (m: DueBirthdayRow, today: string): string =>
  `${m.chat_id}:${m.user_id}:${today}:${m.birth_date}:${m.first_name}`;

// 09:00 Kyiv. Hardcoded rather than configured: one group, one timezone, and a config var for it
// was a knob with one setting plus a Dockerfile ENV to keep in sync.
const GREET_FROM_HOUR = 9;

// Every birthday due today, across every chat. Runs on every scheduler tick and returns on the
// hour check long before touching the database. `>=`, not equality: a missed tick or a redeploy
// must not cost a whole year. `greeted_on` is what stops it repeating.
export async function postBirthdayGreetings(api: Api): Promise<void> {
  const { iso: today, hour } = todayInGroupTz();
  if (hour < GREET_FROM_HOUR) return;

  const due = getDueBirthdays(dueMonthDays(today), today);

  // Entries settle with their member, so one still failing at Kyiv midnight would never be
  // collected — it drops out of the due list and nothing comes back for it.
  const live = new Set(due.map(m => phraseKey(m, today)));
  for (const k of phraseCache.keys()) if (!live.has(k)) phraseCache.delete(k);

  for (const member of due) {
    // Everything the sweep sees is due today by construction, so this is the age being turned.
    const age = ageToday(member.birth_date, today);
    let greeted = false;
    const key = phraseKey(member, today);
    try {
      // First, because it is the cheapest reason to skip and the AI call below is the expensive
      // one. Nothing deletes a member's rows when they leave, so without this a departed member is
      // toasted publicly every year. `restricted` counts as gone only when `is_member` is false.
      // An errored check counts as still here — a blip shouldn't cost a greeting.
      const membership = await api.getChatMember(member.chat_id, member.user_id).catch(() => null);
      if (membership !== null && (
        membership.status === "left" ||
        membership.status === "kicked" ||
        (membership.status === "restricted" && !membership.is_member)
      )) {
        // Skips the tick, doesn't settle the day: one reading is a fact about this minute, and
        // someone removed and back within the hour would otherwise lose their year silently.
        console.log(`[birthday] skipped this tick — not in the chat (${membership.status})`);
        continue;
      }

      // Sequential on purpose — two birthdays in a day is rare and nothing waits on this.
      let phrase = phraseCache.get(key);
      if (phrase === undefined) {
        phrase = await generateBirthdayPhrase(member.first_name, { age });
        if (phrase !== FALLBACK_BIRTHDAY) phraseCache.set(key, phrase);
      }

      // The roster is a snapshot and the call above took seconds. "Still due today", not merely
      // "still on": a date moved mid-write would otherwise be greeted on the wrong day *and* mark
      // the year spent. Same hazard `setFaceitElo`'s `WHERE faceit_player_id = ?` closes.
      const current = getBirthday(member.chat_id, member.user_id);
      if (!current || !isDueOn(current.birth_date, today)) {
        console.log(`[birthday] skipped — ${current ? "date moved" : "turned off"} while the greeting was being written`);
        phraseCache.delete(key);
        continue;
      }
      // A corrected year keeps the day but changes the age, which is inside the toast as well as
      // the header. Rewrite next tick rather than ship the two disagreeing.
      if (ageToday(current.birth_date, today) !== age) {
        console.log("[birthday] age changed while the greeting was being written — rewriting next tick");
        phraseCache.delete(key);
        continue;
      }

      // `id`, because buildMention speaks the grammy User shape — the rename getMembers does in SQL.
      const header = t("birthdayGreeting", buildMention({ ...member, id: member.user_id }), age);
      // escapeAiHtml keeps the <b>/<i> the prompt allows and escapes the substituted name with
      // everything else.
      await api.sendMessage(member.chat_id, `${header}\n\n${escapeAiHtml(phrase)}`, { parse_mode: "HTML" });
      greeted = true;
    } catch (err) {
      // Transient (429, 5xx, network) retries next tick; a birthday is worth retrying. Permanent
      // settles the day anyway — an unreachable chat would otherwise be retried every 60s until
      // midnight for a member who is never greeted either way. Same split as `transientFail`.
      const permanent = err instanceof GrammyError && err.error_code !== 429
        && err.error_code >= 400 && err.error_code < 500;
      console.error(`[birthday] greeting failed${permanent ? " (permanent, giving up)" : ""}:`, (err as Error).message);
      if (!permanent) continue;
    }
    // One write, two meanings — greeted, or gave up on this chat — so the log says which.
    // Guarded on its own: the toast is already out, and a throw here would unwind the sweep and
    // re-post it every 60s. It can't be made to succeed, so contain it and say so.
    try {
      markBirthdayGreeted(member.chat_id, member.user_id, today);
    } catch (err) {
      console.error("[birthday] could not record the greeting — it may repeat:", (err as Error).message);
    }
    phraseCache.delete(key);
    console.log(greeted ? `[birthday] greeted (${age})` : "[birthday] gave up — chat unreachable");
  }
}
