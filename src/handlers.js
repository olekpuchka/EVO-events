import { trackMember, getMembers, setNotifications, getNotificationsStatus, saveEvent, saveRsvp, getRsvps, getUserRsvpStatus, getEventBaseText, scheduleUnpin, scheduleReminder, getActiveEvent, deleteEventData, getReminderMessageId, setFaceitAccount, getFaceitMembers, hasPostedMatch, markMatchPosted } from "./db.js";
import { buildMention, escapeHtml, autoDelete } from "./helpers.js";
import { getPlayer, getPlayerById, getRecentMatches, getMatchStats, getMatchDetails, getMapImageUrl } from "./faceit.js";
import { generateHypePhrase, generateMatchPhrase } from "./ai.js";
import { t } from "./i18n.js";

// Poster timezones. Everyone defaults to Kyiv; the members listed in EU_TIMEZONE_MEMBERS
// (comma-separated Telegram user IDs) type their event times in Central European Time instead.
const DEFAULT_TZ = 'Europe/Kyiv';
const EU_TZ = 'CET'; // Central European Time — DST-aware (CET in winter, CEST in summer)
const euTimezoneMembers = new Set(
  (process.env.EU_TIMEZONE_MEMBERS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(id => {
      // Warn instead of silently dropping — a typo'd or non-numeric entry (e.g. a @username)
      // never matches a real user ID, so the member would stay on Kyiv with no signal why.
      if (/^\d+$/.test(id)) return true;
      console.warn(`[tz] Ignoring invalid EU_TIMEZONE_MEMBERS entry "${id}" — expected a numeric Telegram user ID.`);
      return false;
    })
);
// The IANA zone a poster's typed time should be interpreted in.
function timezoneForUser(userId) {
  return euTimezoneMembers.has(String(userId)) ? EU_TZ : DEFAULT_TZ;
}

// First HH:MM / HH-MM in `text` that is a valid clock time and not glued to other digits — so
// scores ("de_dust2 16:99"), version/phone numbers and out-of-range values are skipped rather than
// spawning a phantom event. Returns { hours, minutes, start, end } (indices into `text`) or null.
// Shared by parseEventTime and decorateEventTime so both agree on which token is the event time.
function matchEventTimeToken(text) {
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})[:-](\d{2})(?!\d)/g)) {
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (hours <= 23 && minutes <= 59) {
      return { hours, minutes, start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

// Parse the event time from a message, interpreting it in the given IANA zone (default Kyiv).
// Returns Unix timestamp (today or tomorrow in that zone) or null.
function parseEventTime(text, timeZone = DEFAULT_TZ) {
  const token = matchEventTimeToken(text);
  if (!token) return null;
  const { hours, minutes } = token;

  const now = new Date();
  // Get current wall-clock time in the poster's zone (values are correct, JS treats it as system-local)
  const zoneNow = new Date(now.toLocaleString('en-US', { timeZone }));
  const candidate = new Date(zoneNow);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate <= zoneNow) candidate.setDate(candidate.getDate() + 1);

  // Convert back to real UTC: offset = (zoneNow - now) is that zone's tz offset
  const utcMs = candidate.getTime() + (now.getTime() - zoneNow.getTime());
  return Math.floor(utcMs / 1000);
}

// Format an event's Unix timestamp as HH:MM wall-clock time in the given IANA zone (DST-aware).
function formatTimeIn(unixSeconds, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('hour')}:${get('minute')}`;
}

// Rewrite the event-time token in an (HTML-escaped) message to its Kyiv value flagged 🇺🇦 plus the
// CET/CEST equivalent flagged 🇪🇺 — e.g. "23:30" → "🇺🇦 23:30 (🇪🇺 22:30)". Both come from the
// resolved timestamp, so an EU poster's typed CET time still shows correctly under each flag.
// escapeHtml only rewrites & < >, so matchEventTimeToken's indices stay valid on the escaped string.
function decorateEventTime(escapedMessage, eventTime) {
  const token = matchEventTimeToken(escapedMessage);
  if (!token) return escapedMessage;
  const kyiv = formatTimeIn(eventTime, DEFAULT_TZ);
  const eu = formatTimeIn(eventTime, EU_TZ);
  return escapedMessage.slice(0, token.start) + `🇺🇦 ${kyiv} (🇪🇺 ${eu})` + escapedMessage.slice(token.end);
}

const MAX_PLAYERS = 5;

function extractEventName(baseText) {
  const firstLine = baseText.split("\n")[0];
  const colonIdx = firstLine.indexOf(": ");
  return colonIdx !== -1 ? firstLine.slice(colonIdx + 2).trim() : null;
}


// Both keyed by phraseKey() — hold AI hype phrases frozen per event so RSVP edits reuse them
// instead of regenerating. reminderPhraseCache is frozen when the reminder fires; fullPhraseCache
// is frozen once the squad first fills (and cleared if it drops below full, so a re-fill re-hypes).
// Both are torn down together in clearEventPhrases when the event ends.
const reminderPhraseCache = new Map();
const fullPhraseCache = new Map();

// chatId → messageId for pins triggered by @all — lets bot.js delete only those service messages.
export const pendingPinDeletion = new Map();

const phraseKey = (chatId, messageId) => `${chatId}:${messageId}`;

// Return the cached hype phrase for this key, or generate one and freeze it in the cache.
async function cachedHypePhrase(cache, key, eventName) {
  const phrase = cache.get(key) ?? await generateHypePhrase(eventName);
  cache.set(key, phrase);
  return phrase;
}

export function clearEventPhrases(chatId, messageId) {
  const key = phraseKey(chatId, messageId);
  reminderPhraseCache.delete(key);
  fullPhraseCache.delete(key);
}


function buildKeyboard() {
  return {
    inline_keyboard: [[
      { text: t("joinButton"), callback_data: "join", style: "success" },
      { text: t("notJoinButton"), callback_data: "not_join", style: "danger" }
    ]]
  };
}

// When the squad is full we drop the "Joining" button but keep "Not joining",
// so a locked-in player who can no longer make it can free up their seat.
// Dropping out takes the count back below the cap, which restores buildKeyboard().
function buildLeaveOnlyKeyboard() {
  return {
    inline_keyboard: [[
      { text: t("notJoinButton"), callback_data: "not_join", style: "danger" }
    ]]
  };
}

// Lists only members who haven't RSVP'd yet — responders already show in the
// Joining/Not joining sections. Returns "" when nobody's left, so the block
// disappears instead of leaving an empty header.
function buildMentionedBlock(mentionedUsers, rsvps) {
  const responded = new Set(rsvps.map(r => r.id));
  const pending = mentionedUsers.filter(u => !responded.has(u.id));
  if (pending.length === 0) return "";
  return `\n\n<b>${t("mentioned")}</b> ${pending.map(buildMention).join(", ")}`;
}

function buildRsvpSection(rsvps) {
  const joining = [];
  const notJoining = [];
  for (const r of rsvps) {
    if (r.status === "join") joining.push(r);
    else notJoining.push(r);
  }
  let section = "";
  if (joining.length > 0)
    section += `\n\n${t("joiningHeader", joining.length)}\n${joining.map(buildMention).join(", ")}`;
  if (notJoining.length > 0)
    section += `\n\n${t("notJoiningHeader", notJoining.length)}\n${notJoining.map(buildMention).join(", ")}`;
  return section;
}

export async function mentionAll(ctx, message = "") {
  if (ctx.chat.type === "private") {
    await ctx.reply(t("groupOnly"));
    return;
  }

  const rows = getMembers(ctx.chat.id);

  if (rows.length === 0) {
    const reply = await ctx.reply(t("noMembers"), { parse_mode: "HTML" });
    autoDelete(ctx, reply);
    return;
  }

  if (!message) {
    const reply = await ctx.reply(t("usageAll"), { parse_mode: "HTML" });
    autoDelete(ctx, reply);
    return;
  }

  const poster = buildMention(ctx.from);
  const eventTime = parseEventTime(message, timezoneForUser(ctx.from.id));
  // Flag the event time inline — 🇺🇦 Kyiv with the 🇪🇺 (CET/CEST) equivalent in parens,
  // e.g. "CS 🇺🇦 23:30 (🇪🇺 22:30)". No time = message unchanged.
  const escaped = escapeHtml(message);
  const messageLine = `${poster}: ${eventTime ? decorateEventTime(escaped, eventTime) : escaped}`;
  const mentionedUsers = rows.filter(r => r.id !== ctx.from.id);

  if (eventTime) {
    const activeEvent = getActiveEvent(ctx.chat.id);
    if (activeEvent) {
      const chatIdStr = String(ctx.chat.id);
      const peerId = chatIdStr.startsWith("-100") ? chatIdStr.slice(4) : chatIdStr.replace("-", "");
      const link = `https://t.me/c/${peerId}/${activeEvent.message_id}`;
      const notice = await ctx.reply(t("activeEventExists", link), { parse_mode: "HTML" });
      autoDelete(ctx, notice);
      return;
    }
  }
  let lastSent = null;

  if (eventTime) {
    // Build the full initial text with RSVP section (poster auto-joined) before sending,
    // so the message is delivered to all clients with the keyboard already attached —
    // avoiding the send-then-edit race condition that caused buttons to not appear.
    const initialRsvps = [{ ...ctx.from, status: "join" }];
    const initialText = messageLine + buildMentionedBlock(mentionedUsers, initialRsvps) + buildRsvpSection(initialRsvps);
    const keyboard = buildKeyboard();

    lastSent = await ctx.api.sendMessage(ctx.chat.id, initialText, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });

    try {
      saveEvent(ctx.chat.id, lastSent.message_id, messageLine, eventTime);
    } catch (err) {
      console.error("[event] save failed:", err.message);
    }
    saveRsvp(ctx.chat.id, lastSent.message_id, ctx.from, "join");

    try {
      pendingPinDeletion.set(ctx.chat.id, lastSent.message_id);
      await ctx.pinChatMessage(lastSent.message_id, { disable_notification: true });
      scheduleUnpin(ctx.chat.id, lastSent.message_id, eventTime);
      const reminderAt = eventTime - 10 * 60;
      if (reminderAt > Math.floor(Date.now() / 1000)) {
        scheduleReminder(ctx.chat.id, lastSent.message_id, reminderAt);
      }
      console.log(`[event] created "${message}"`);
    } catch (err) {
      pendingPinDeletion.delete(ctx.chat.id);
      console.error("[event] pin failed:", err.message);
    }
  } else {
    const fullText = messageLine + buildMentionedBlock(mentionedUsers, []);
    lastSent = await ctx.api.sendMessage(ctx.chat.id, fullText, { parse_mode: "HTML" });
    console.log(`[mention] "${message}"`);
  }

  try { await ctx.deleteMessage(); } catch {}
}

export async function cancelEvent(ctx) {
  if (ctx.chat.type === "private") return;

  const activeEvent = getActiveEvent(ctx.chat.id);
  if (!activeEvent) {
    const reply = await ctx.reply(t("noActiveEvent"));
    autoDelete(ctx, reply);
    return;
  }

  const { message_id } = activeEvent;
  const reminderMessageId = getReminderMessageId(ctx.chat.id, message_id);
  const row = getEventBaseText(ctx.chat.id, message_id);
  const rsvps = getRsvps(ctx.chat.id, message_id);

  await ctx.api.unpinChatMessage(ctx.chat.id, { message_id }).catch(() => {});

  const cancelledText = row.base_text + buildRsvpSection(rsvps) + `\n\n⛔ <b>${t("cancelledBy", buildMention(ctx.from))}</b>`;
  try {
    await ctx.api.editMessageText(ctx.chat.id, message_id, cancelledText, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
  } catch (err) {
    console.error("[cancel] edit failed:", err.message);
  }

  if (reminderMessageId) {
    await ctx.api.deleteMessage(ctx.chat.id, reminderMessageId).catch(() => {});
  }
  deleteEventData(ctx.chat.id, message_id);
  clearEventPhrases(ctx.chat.id, message_id);
  console.log("[cancel] event cancelled");
  try { await ctx.deleteMessage(); } catch {}
}

export async function muteNotifications(ctx) {
  if (ctx.chat.type === "private") { await ctx.reply(t("groupOnly")); return; }
  const current = getNotificationsStatus(ctx.chat.id, ctx.from.id);
  if (current === false) {
    const reply = await ctx.reply(t("alreadyMuted"));
    autoDelete(ctx, reply);
    return;
  }
  trackMember(ctx.chat.id, ctx.from);
  setNotifications(ctx.chat.id, ctx.from.id, false);
  console.log("[mute] muted");
  const reply = await ctx.reply(t("mutedSuccess"));
  autoDelete(ctx, reply);
}

export async function unmuteNotifications(ctx) {
  if (ctx.chat.type === "private") { await ctx.reply(t("groupOnly")); return; }
  const current = getNotificationsStatus(ctx.chat.id, ctx.from.id);
  if (current === true) {
    const reply = await ctx.reply(t("alreadyUnmuted"));
    autoDelete(ctx, reply);
    return;
  }
  trackMember(ctx.chat.id, ctx.from);
  setNotifications(ctx.chat.id, ctx.from.id, true);
  console.log("[unmute] unmuted");
  const reply = await ctx.reply(t("unmutedSuccess"));
  autoDelete(ctx, reply);
}

export async function handleRsvp(ctx) {
  const status = ctx.callbackQuery.data; // "join" or "not_join"
  const chatId = ctx.chat.id;

  const activeEvent = getActiveEvent(chatId);
  if (!activeEvent) {
    await ctx.answerCallbackQuery({ text: t("eventEnded") });
    return;
  }
  const messageId = activeEvent.message_id;

  // The tapped button may live on a stale message on a not-yet-synced client
  // (e.g. an older, already-ended event). Only accept taps on the message that
  // is actually the current active event.
  const clickedMessageId = ctx.callbackQuery.message?.message_id;
  if (clickedMessageId && clickedMessageId !== messageId) {
    await ctx.answerCallbackQuery({ text: t("eventEnded") });
    return;
  }

  const row = getEventBaseText(chatId, messageId);
  if (!row) {
    console.error("[rsvp] no active event found");
    await ctx.answerCallbackQuery({ text: t("eventEnded") });
    return;
  }

  const currentStatus = getUserRsvpStatus(chatId, messageId, ctx.from.id);
  if (currentStatus === status) {
    const toastText = status === "join" ? t("alreadyJoining") : t("alreadyNotJoining");
    await ctx.answerCallbackQuery({ text: toastText });
    return;
  }

  // Enforce the squad cap server-side: the "Joining" button is removed at 5/5,
  // but a stale client may still show it. Reject the join instead of going 6/5.
  if (status === "join") {
    const joiningNow = getRsvps(chatId, messageId).filter(r => r.status === "join");
    if (joiningNow.length >= MAX_PLAYERS) {
      console.log("[rsvp] rejected — squad full");
      await ctx.answerCallbackQuery({ text: t("squadFull", MAX_PLAYERS) });
      return;
    }
  }

  saveRsvp(chatId, messageId, ctx.from, status);

  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  const notJoining = rsvps.filter(r => r.status === "not_join");
  const isFull = joining.length >= MAX_PLAYERS;
  const eventName = extractEventName(row.base_text);
  console.log(`[rsvp] ${status === "join" ? "joined" : "not joining"} (🍌 ${joining.length}/${MAX_PLAYERS}, ❌ ${notJoining.length})${isFull ? " — squad full" : ""}`);

  // Answer the callback first — the toast is uniform (same for the 1st or 5th joiner)
  // and needs no AI, so the button stops spinning immediately instead of waiting on
  // the hype generation and edit round-trips below.
  const toastText = status === "join" ? t("joining") : t("notJoining");
  await ctx.answerCallbackQuery({ text: toastText });

  // Generate the full-squad hype phrase for the message body only (not the toast).
  // Freeze it on first fill so later edits (a non-player tapping "not going" while still
  // 5/5) reuse it instead of generating a new line; drop it if the squad is no longer full.
  const key = phraseKey(chatId, messageId);
  let fullPhrase = "";
  if (isFull) {
    fullPhrase = await cachedHypePhrase(fullPhraseCache, key, eventName);
  } else {
    fullPhraseCache.delete(key);
  }

  const newText = row.base_text + buildMentionedBlock(getMembers(chatId), rsvps) + buildRsvpSection(rsvps) + (isFull ? `\n\n🔥 <b>${fullPhrase} (${MAX_PLAYERS}/${MAX_PLAYERS})</b> 🔒` : "");
  const keyboard = isFull ? buildLeaveOnlyKeyboard() : buildKeyboard();

  try {
    await ctx.api.editMessageText(chatId, messageId, newText, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  } catch (err) {
    if (!err.message?.includes("message is not modified")) {
      console.error("[rsvp] edit failed:", err.message);
    }
  }

  // If the reminder has already been sent, update its joining list too.
  // Done after answerCallbackQuery so a cache-miss AI call doesn't block the response.
  const reminderMessageId = getReminderMessageId(chatId, messageId);
  if (reminderMessageId) {
    const phrase = await cachedHypePhrase(reminderPhraseCache, key, eventName);
    const updatedReminderText = buildReminderText(row, joining, phrase);
    await ctx.api.editMessageText(chatId, reminderMessageId, updatedReminderText, { parse_mode: "HTML" })
      .catch(err => {
        if (!err.message?.includes("message is not modified")) {
          console.error("[reminder] edit failed:", err.message);
        }
      });
  }
}

function buildReminderText(row, joining, phrase) {
  const eventName = extractEventName(row.base_text);
  return (
    t("reminderHeader") +
    (eventName ? `\n\n${eventName}` : "") +
    `\n\n${t("joiningHeader", joining.length)}\n${joining.map(buildMention).join(", ")}` +
    `\n\n<i>${phrase}</i>`
  );
}

export async function registerFaceit(ctx) {
  if (ctx.chat.type === "private") return;
  const nickname = ctx.match?.trim();
  if (!nickname) {
    const reply = await ctx.reply(t("faceitUsage"), { parse_mode: "HTML" });
    autoDelete(ctx, reply);
    return;
  }

  let player;
  try {
    player = await getPlayer(nickname);
  } catch (err) {
    console.error("[faceit] API error:", err.message);
    const reply = await ctx.reply(t("faceitUnavailable"));
    autoDelete(ctx, reply);
    return;
  }

  if (!player) {
    const reply = await ctx.reply(t("faceitNotFound", escapeHtml(nickname)), { parse_mode: "HTML" });
    autoDelete(ctx, reply);
    return;
  }

  const cs2 = player.games?.cs2;
  if (!cs2) {
    const reply = await ctx.reply(t("faceitNoStats", escapeHtml(player.nickname)), { parse_mode: "HTML" });
    autoDelete(ctx, reply);
    return;
  }

  trackMember(ctx.chat.id, ctx.from);
  setFaceitAccount(ctx.chat.id, ctx.from.id, player.player_id, cs2.faceit_elo);
  console.log(`[faceit] registered "${player.nickname}"`);

  const reply = await ctx.reply(
    t("faceitLinked", escapeHtml(player.nickname), cs2.faceit_elo ? `${cs2.faceit_elo} Elo` : t("unranked")),
    { parse_mode: "HTML" }
  );
  autoDelete(ctx, reply);
  try { await ctx.deleteMessage(); } catch {}
}

async function formatMatchResult(stats, registeredIds, elo = null, matchId = null) {
  const round = stats.rounds?.[0];
  if (!round) return null;
  let ourTeam = null, theirTeam = null;

  for (const team of round.teams ?? []) {
    if (team.players.some(p => registeredIds.has(p.player_id))) ourTeam = team;
    else theirTeam = team;
  }
  if (!ourTeam) return null;

  const theirScore = theirTeam?.team_stats?.["Final Score"] ?? "?";

  const won = ourTeam.team_stats?.["Team Win"] === "1";
  const ourScore = ourTeam.team_stats?.["Final Score"] ?? "?";

  const registered = ourTeam.players.filter(p => registeredIds.has(p.player_id));

  const rows = registered
    .sort((a, b) => Number(b.player_stats?.ADR ?? 0) - Number(a.player_stats?.ADR ?? 0))
    .map(p => {
      const s = p.player_stats ?? {};
      const { preElo, postElo } = registeredIds.get(p.player_id) ?? {};
      const delta = preElo && postElo ? postElo - preElo : null;
      const deltaStr = delta !== null ? `, ${delta >= 0 ? "↑" : "↓"}${Math.abs(delta)}` : "";
      const eloStr = postElo ? `${postElo} Elo${deltaStr}` : "? Elo";
      return `· <b>${escapeHtml(p.nickname)}</b> (${eloStr}) — ${s.Kills ?? "?"}/${s.Deaths ?? "?"}/${s.Assists ?? "?"} · ${s.ADR ?? "?"} ADR`;
    });

  if (!rows.length) return null;

  const rawMap = round.round_stats?.Map ?? "";
  const map = rawMap.replace(/^de_/, "").replace(/^cs_/, "").replace(/^\w/, c => c.toUpperCase()) || null;
  const players = registered.map(p => {
    const s = p.player_stats ?? {};
    return {
      nickname: p.nickname,
      kills: Number(s.Kills),
      deaths: Number(s.Deaths),
      assists: Number(s.Assists),
      adr: Number(s.ADR),
      hs: Number(s["Headshots %"]),
      aces: Number(s["Penta Kills"]),
      quadros: Number(s["Quadro Kills"]),
      clutches: Number(s["1v2Wins"]),
      awp: Number(s["Sniper Kills"]),
      entries: Number(s["Entry Wins"]),
      util: Number(s["Utility Damage"]),
      flashes: Number(s["Enemies Flashed"]),
    };
  });
  const matchFlow = theirTeam
    ? {
        ourFirst: Number(ourTeam.team_stats?.["First Half Score"]),
        theirFirst: Number(theirTeam.team_stats?.["First Half Score"]),
        ourOt: Number(ourTeam.team_stats?.["Overtime score"]),
        theirOt: Number(theirTeam.team_stats?.["Overtime score"]),
      }
    : null;
  const phrase = await generateMatchPhrase(won, `${ourScore}:${theirScore}`, { map, elo, players, matchFlow });

  const eloStr = elo ? ` (${elo.ours} Elo vs ${elo.theirs} Elo)` : "";

  const matchLink = matchId
    ? `\n\n🔗 ${t("viewOnFaceit")} <a href="https://www.faceit.com/en/cs2/room/${matchId}/scoreboard">FACEIT</a>`
    : "";

  return (
    `${won ? "🍌" : "❌"} <b>${ourScore}:${theirScore}</b>${eloStr}\n\n` +
    rows.join("\n") +
    `\n\n<i>${phrase}</i>` +
    matchLink
  );
}

export async function autoPostResult(api, chatId) {
  const members = getFaceitMembers(chatId);
  if (!members.length) return;

  const now = Math.floor(Date.now() / 1000);

  // Fetch last 5 matches per member in parallel
  const results = await Promise.allSettled(
    members.map(m => getRecentMatches(m.faceit_player_id, 5))
  );

  // Collect candidates: finished, within 24h, not already posted
  const matchCounts = new Map();
  let historyErrors = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      historyErrors++;
      continue;
    }
    for (const match of result.value ?? []) {
      if (match.status !== "finished") continue;
      if (now - match.finished_at > 24 * 60 * 60) continue;
      if (hasPostedMatch(chatId, match.match_id)) continue;
      const existing = matchCounts.get(match.match_id);
      if (existing) existing.count++;
      else matchCounts.set(match.match_id, { count: 1, finished_at: match.finished_at });
    }
  }

  if (historyErrors) console.error(`[faceit] poll: ${historyErrors}/${members.length} history calls failed`);
  if (!matchCounts.size) return;

  // Map our members → { preElo (DB baseline for the delta), postElo (filled in per match below,
  // only for members who actually played) }. postElo is NOT persisted until the post succeeds:
  // if sending fails (e.g. FACEIT 429), preElo must stay the pre-match value or the delta collapses.
  const registeredIds = new Map(members.map(m => [m.faceit_player_id, { userId: m.user_id, preElo: m.faceit_elo, postElo: null }]));

  // Sort by member count desc, then oldest first so multiple sessions post in chronological order
  const sortedMatches = [...matchCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].finished_at - b[1].finished_at);

  for (const [matchId, meta] of sortedMatches) {
    let stats, matchDetails;
    try {
      [stats, matchDetails] = await Promise.all([getMatchStats(matchId), getMatchDetails(matchId)]);
    } catch (err) {
      console.error("[faceit] poll stats fetch failed:", err.message);
      continue;
    }
    if (!stats || !matchDetails) {
      // Skip permanently if: voided/cancelled, stats missing >30 min, or match details unavailable >30 min
      if (!matchDetails || matchDetails.status !== "FINISHED" || now - meta.finished_at > 30 * 60) {
        markMatchPosted(chatId, matchId);
      }
      // else: FINISHED but stats not ready yet — retry next poll
      continue;
    }

    // Fetch current Elo only for our members who actually played this match — not the whole
    // roster. Fetching sit-out members buys nothing for the post and just burns rate limit.
    const participantIds = new Set();
    for (const round of stats.rounds ?? []) {
      for (const team of round.teams ?? []) {
        for (const p of team.players ?? []) {
          if (registeredIds.has(p.player_id)) participantIds.add(p.player_id);
        }
      }
    }
    const transientFail = new Set();
    await Promise.allSettled(
      [...participantIds]
        .filter(pid => registeredIds.get(pid).postElo === null)
        .map(async pid => {
          let profile;
          try {
            profile = await getPlayerById(pid);
          } catch {
            transientFail.add(pid); // 429/5xx/network after retries — worth retrying next poll
            return;
          }
          if (!profile) return; // 404 profile — permanent, accept "? Elo"
          registeredIds.get(pid).postElo = profile.games?.cs2?.faceit_elo ?? null; // null = unranked
        })
    );

    // Hold the whole match back rather than post partial "? Elo" when a fetch failed transiently —
    // don't markMatchPosted, so the next poll retries with complete info. Only while it's still
    // fresh: past the 30-min grace window, fall through and post best-effort so it never sticks.
    // (Unranked players / 404s aren't in transientFail, so they never block the post.)
    if (transientFail.size && now - meta.finished_at < 30 * 60) continue;

    const mapId = stats.rounds?.[0]?.round_stats?.Map;
    const imageUrl = getMapImageUrl(matchDetails, mapId);

    const factions = Object.values(matchDetails.teams ?? {});
    const ourFaction = factions.find(f => f.roster?.some(p => registeredIds.has(p.player_id)));
    const theirFaction = factions.find(f => f !== ourFaction);
    const elo = ourFaction?.stats?.rating && theirFaction?.stats?.rating
      ? { ours: ourFaction.stats.rating, theirs: theirFaction.stats.rating }
      : null;

    const text = await formatMatchResult(stats, registeredIds, elo, matchId);
    if (!text) {
      markMatchPosted(chatId, matchId);
      continue;
    }

    let sent = false;
    try {
      if (imageUrl) {
        await api.sendPhoto(chatId, imageUrl, { caption: text, parse_mode: "HTML" });
      } else {
        await api.sendMessage(chatId, text, { parse_mode: "HTML" });
      }
      sent = true;
    } catch (err) {
      if (!imageUrl) {
        console.error("[faceit] poll send failed:", err.message);
      } else {
        await api.sendMessage(chatId, text, { parse_mode: "HTML" })
          .then(() => { sent = true; })
          .catch(e => console.error("[faceit] poll send failed:", e.message));
      }
    }
    if (!sent) continue;
    markMatchPosted(chatId, matchId);
    // Lock in the new Elo baseline now that the delta has been posted, so the next match
    // measures its delta from here. Only this match's participants — committing all of
    // registeredIds would persist Elo fetched for a different (possibly held-back) match.
    // Skip members whose profile fetch failed (postElo null).
    for (const pid of participantIds) {
      const { userId, postElo } = registeredIds.get(pid);
      if (postElo !== null) setFaceitAccount(chatId, userId, pid, postElo);
    }
    console.log("[faceit] auto-posted result");
  }
}

export async function sendReminder(api, chatId, messageId) {
  const row = getEventBaseText(chatId, messageId);
  if (!row) return;

  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  if (joining.length <= 1) return;

  const phrase = await generateHypePhrase(extractEventName(row.base_text));
  reminderPhraseCache.set(phraseKey(chatId, messageId), phrase);
  const text = buildReminderText(row, joining, phrase);
  const sent = await api.sendMessage(chatId, text, { parse_mode: "HTML" });
  console.log(`[reminder] sent — ${joining.length} joining`);
  return sent;
}
