import { trackMember, getMembers, setNotifications, getNotificationsStatus, saveEvent, saveRsvp, getRsvps, getUserRsvpStatus, getEventBaseText, scheduleUnpin, scheduleReminder, getActiveEvent, deleteEventData, getReminderMessageId, setFaceitAccount, getFaceitMembers, hasPostedMatch, markMatchPosted } from "./db.js";
import { buildMention, escapeHtml, splitIntoChunks, autoDelete } from "./helpers.js";
import { getPlayer, getPlayerById, getRecentMatches, getMatchStats, getMatchDetails, getMapImageUrl } from "./faceit.js";
import { generateHypePhrase, generateMatchPhrase } from "./ai.js";

// Parse HH:MM from a message string. Interprets the time as Kyiv (Europe/Kyiv) timezone.
// Returns Unix timestamp (today or tomorrow Kyiv time) or null.
function parseEventTime(text) {
  const match = text.match(/(\d{1,2})[:-](\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  const now = new Date();
  // Get current Kyiv wall-clock time (values are correct, JS treats it as system-local)
  const kyivNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const candidate = new Date(kyivNow);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate <= kyivNow) candidate.setDate(candidate.getDate() + 1);

  // Convert back to real UTC: offset = (kyivNow - now) is the Kyiv tz offset
  const utcMs = candidate.getTime() + (now.getTime() - kyivNow.getTime());
  return Math.floor(utcMs / 1000);
}


const MAX_PLAYERS = 5;

function extractEventName(baseText) {
  const firstLine = baseText.split("\n")[0];
  const colonIdx = firstLine.indexOf(": ");
  return colonIdx !== -1 ? firstLine.slice(colonIdx + 2).trim() : null;
}


// Keyed by `${chatId}:${messageId}` — frozen when reminder fires, reused on RSVP edits.
const reminderPhraseCache = new Map();

// chatId → messageId for pins triggered by @all — lets bot.js delete only those service messages.
export const pendingPinDeletion = new Map();

export function clearReminderPhrase(chatId, messageId) {
  reminderPhraseCache.delete(`${chatId}:${messageId}`);
}


function buildKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🍌 Joining", callback_data: "join", style: "success" },
      { text: "❌ Not joining", callback_data: "not_join", style: "danger" }
    ]]
  };
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
    section += `\n\n🍌 <b>Joining (${joining.length}):</b>\n${joining.map(buildMention).join(", ")}`;
  if (notJoining.length > 0)
    section += `\n\n❌ <b>Not joining (${notJoining.length}):</b>\n${notJoining.map(buildMention).join(", ")}`;
  return section;
}

export async function mentionAll(ctx, message = "") {
  if (ctx.chat.type === "private") {
    await ctx.reply("This command only works in group chats.");
    return;
  }

  const rows = getMembers(ctx.chat.id);

  if (rows.length === 0) {
    const reply = await ctx.reply(
      "No members registered yet.\n\nMembers need to use <code>/mute</code> or <code>/unmute</code> to be added to the mention list.",
      { parse_mode: "HTML" }
    );
    autoDelete(ctx, reply);
    return;
  }

  if (!message) {
    const reply = await ctx.reply(
      "Please include an event name and time, e.g.:\n<code>@all CS 22:00</code>",
      { parse_mode: "HTML" }
    );
    autoDelete(ctx, reply);
    return;
  }

  const mentions = rows.filter(r => r.id !== ctx.from.id).map(buildMention);
  const mentionBlock = `<b>Mentioned:</b> ${mentions.join(", ")}`;
  const poster = buildMention(ctx.from);
  const fullText = `${poster}: ${escapeHtml(message)}\n\n${mentionBlock}`;

  const eventTime = parseEventTime(message);

  if (eventTime) {
    const activeEvent = getActiveEvent(ctx.chat.id);
    if (activeEvent) {
      const chatIdStr = String(ctx.chat.id);
      const peerId = chatIdStr.startsWith("-100") ? chatIdStr.slice(4) : chatIdStr.replace("-", "");
      const link = `https://t.me/c/${peerId}/${activeEvent.message_id}`;
      const notice = await ctx.reply(
        `There is already <a href="${link}">an active event</a>. It will be unpinned automatically when it ends.`,
        { parse_mode: "HTML" }
      );
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
    const initialText = fullText + buildRsvpSection(initialRsvps);
    const keyboard = buildKeyboard();

    const chunks = splitIntoChunks(initialText);
    for (let i = 0; i < chunks.length; i++) {
      lastSent = await ctx.api.sendMessage(ctx.chat.id, chunks[i], {
        parse_mode: "HTML",
        ...(i === chunks.length - 1 ? { reply_markup: keyboard } : {})
      });
    }

    try {
      saveEvent(ctx.chat.id, lastSent.message_id, fullText, eventTime);
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
    const chunks = splitIntoChunks(fullText);
    for (const chunk of chunks) {
      lastSent = await ctx.api.sendMessage(ctx.chat.id, chunk, { parse_mode: "HTML" });
    }
    console.log(`[mention] "${message}"`);
  }

  try { await ctx.deleteMessage(); } catch {}
}

export async function cancelEvent(ctx) {
  if (ctx.chat.type === "private") return;

  const activeEvent = getActiveEvent(ctx.chat.id);
  if (!activeEvent) {
    const reply = await ctx.reply("There is no active event to cancel.");
    autoDelete(ctx, reply);
    return;
  }

  const { message_id } = activeEvent;
  const reminderMessageId = getReminderMessageId(ctx.chat.id, message_id);
  await ctx.api.unpinChatMessage(ctx.chat.id, { message_id }).catch(() => {});
  await ctx.api.deleteMessage(ctx.chat.id, message_id).catch(() => {});
  if (reminderMessageId) {
    await ctx.api.deleteMessage(ctx.chat.id, reminderMessageId).catch(() => {});
  }
  deleteEventData(ctx.chat.id, message_id);
  clearReminderPhrase(ctx.chat.id, message_id);
  try { await ctx.deleteMessage(); } catch {}
}

export async function muteNotifications(ctx) {
  if (ctx.chat.type === "private") { await ctx.reply("This command only works in group chats."); return; }
  const current = getNotificationsStatus(ctx.chat.id, ctx.from.id);
  if (current === false) {
    const reply = await ctx.reply("You are already muted — @all won't mention you.");
    autoDelete(ctx, reply);
    return;
  }
  trackMember(ctx.chat.id, ctx.from);
  setNotifications(ctx.chat.id, ctx.from.id, false);
  const reply = await ctx.reply("You've been muted. You won't be mentioned by @all in this group.\nUse /unmute to re-enable.");
  autoDelete(ctx, reply);
}

export async function unmuteNotifications(ctx) {
  if (ctx.chat.type === "private") { await ctx.reply("This command only works in group chats."); return; }
  const current = getNotificationsStatus(ctx.chat.id, ctx.from.id);
  if (current === true) {
    const reply = await ctx.reply("You are already unmuted and will be mentioned by @all.");
    autoDelete(ctx, reply);
    return;
  }
  trackMember(ctx.chat.id, ctx.from);
  setNotifications(ctx.chat.id, ctx.from.id, true);
  const reply = await ctx.reply("You've been added to the mention list. You'll be mentioned by @all in this group.");
  autoDelete(ctx, reply);
}

export async function handleRsvp(ctx) {
  const status = ctx.callbackQuery.data; // "join" or "not_join"
  const chatId = ctx.chat.id;

  const activeEvent = getActiveEvent(chatId);
  if (!activeEvent) {
    await ctx.answerCallbackQuery({ text: "This event has already ended." });
    return;
  }
  const messageId = activeEvent.message_id;

  // The tapped button may live on a stale message on a not-yet-synced client
  // (e.g. an older, already-ended event). Only accept taps on the message that
  // is actually the current active event.
  const clickedMessageId = ctx.callbackQuery.message?.message_id;
  if (clickedMessageId && clickedMessageId !== messageId) {
    await ctx.answerCallbackQuery({ text: "This event has already ended." });
    return;
  }

  const row = getEventBaseText(chatId, messageId);
  if (!row) {
    console.error("[rsvp] no active event found");
    await ctx.answerCallbackQuery({ text: "This event has already ended." });
    return;
  }

  const currentStatus = getUserRsvpStatus(chatId, messageId, ctx.from.id);
  if (currentStatus === status) {
    const toastText = status === "join" ? "🍌 You're already joining!" : "❌ You're already not joining!";
    await ctx.answerCallbackQuery({ text: toastText });
    return;
  }

  // Enforce the squad cap server-side: buttons are hidden at 5/5, but a stale
  // client may still show "Joining". Reject the join instead of going 6/5.
  if (status === "join") {
    const joiningNow = getRsvps(chatId, messageId).filter(r => r.status === "join");
    if (joiningNow.length >= MAX_PLAYERS) {
      console.log("[rsvp] rejected — squad full");
      await ctx.answerCallbackQuery({ text: `🔒 Squad's already full (${MAX_PLAYERS}/${MAX_PLAYERS})!` });
      return;
    }
  }

  saveRsvp(chatId, messageId, ctx.from, status);

  const rsvps = getRsvps(chatId, messageId);
  const joining = rsvps.filter(r => r.status === "join");
  const notJoining = rsvps.filter(r => r.status === "not_join");
  const isFull = joining.length >= MAX_PLAYERS;
  const eventName = extractEventName(row.base_text);
  const fullPhrase = isFull ? await generateHypePhrase(eventName) : "";
  console.log(`[rsvp] ${status === "join" ? "joined" : "not joining"} (🍌 ${joining.length}/${MAX_PLAYERS}, ❌ ${notJoining.length})${isFull ? " — squad full" : ""}`);
  const newText = row.base_text + buildRsvpSection(rsvps) + (isFull ? `\n\n🔥 <b>${fullPhrase} (${MAX_PLAYERS}/${MAX_PLAYERS})</b> 🔒` : "");
  const keyboard = isFull ? { inline_keyboard: [] } : buildKeyboard();

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

  const toastText = status === "join"
    ? (isFull ? `🔥 You're in! ${fullPhrase} (${MAX_PLAYERS}/${MAX_PLAYERS}) 🔒` : "🍌 You're joining!")
    : "❌ You aren't joining!";
  await ctx.answerCallbackQuery({ text: toastText });

  // If the reminder has already been sent, update its joining list too.
  // Done after answerCallbackQuery so a cache-miss AI call doesn't block the response.
  const reminderMessageId = getReminderMessageId(chatId, messageId);
  if (reminderMessageId) {
    const phrase = reminderPhraseCache.get(`${chatId}:${messageId}`) ?? await generateHypePhrase(eventName);
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
  const timeStr = row.event_time
    ? new Date(row.event_time * 1000).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" })
    : "soon";
  const eventName = extractEventName(row.base_text);
  return (
    `🔔 <b>Reminder!</b> Event starts in <b>10 minutes</b> (at ${timeStr}) 🎮` +
    (eventName ? `\n\n${eventName}` : "") +
    `\n\n🍌 <b>Joining (${joining.length}):</b>\n${joining.map(buildMention).join(", ")}` +
    `\n\n<i>${phrase}</i>`
  );
}

export async function registerFaceit(ctx) {
  if (ctx.chat.type === "private") return;
  const nickname = ctx.match?.trim();
  if (!nickname) {
    const reply = await ctx.reply("Usage: /faceit &lt;your FACEIT nickname&gt;", { parse_mode: "HTML" });
    autoDelete(ctx, reply);
    return;
  }

  let player;
  try {
    player = await getPlayer(nickname);
  } catch (err) {
    console.error("[faceit] API error:", err.message);
    const reply = await ctx.reply("FACEIT API is unavailable, try again later.");
    autoDelete(ctx, reply);
    return;
  }

  if (!player) {
    const reply = await ctx.reply(`Player "${escapeHtml(nickname)}" not found on FACEIT.`, { parse_mode: "HTML" });
    autoDelete(ctx, reply);
    return;
  }

  const cs2 = player.games?.cs2;
  if (!cs2) {
    const reply = await ctx.reply(`"${escapeHtml(player.nickname)}" has no CS2 stats on FACEIT.`, { parse_mode: "HTML" });
    autoDelete(ctx, reply);
    return;
  }

  trackMember(ctx.chat.id, ctx.from);
  setFaceitAccount(ctx.chat.id, ctx.from.id, player.player_id, cs2.faceit_elo);
  console.log(`[faceit] registered "${player.nickname}"`);

  const reply = await ctx.reply(
    `Linked! <b>${escapeHtml(player.nickname)}</b> (${cs2.faceit_elo ? `${cs2.faceit_elo} Elo` : "Unranked"})`,
    { parse_mode: "HTML" }
  );
  autoDelete(ctx, reply);
  try { await ctx.deleteMessage(); } catch {}
}

async function formatMatchResult(stats, registeredIds, elo = null, matchId = null) {
  const round = stats.rounds?.[0];
  if (!round) return null;
  let ourTeam = null, theirScore = "?";

  for (const team of round.teams ?? []) {
    if (team.players.some(p => registeredIds.has(p.player_id))) ourTeam = team;
    else theirScore = team.team_stats?.["Final Score"] ?? "?";
  }
  if (!ourTeam) return null;

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
    const adr = Number(p.player_stats?.ADR);
    return { nickname: p.nickname, adr: adr >= 80 ? adr : null };
  });
  const phrase = await generateMatchPhrase(won, `${ourScore}:${theirScore}`, { map, elo, players });

  const eloStr = elo ? ` (${elo.ours} Elo vs ${elo.theirs} Elo)` : "";

  const matchLink = matchId
    ? `\n\n🔗 View on <a href="https://www.faceit.com/en/cs2/room/${matchId}/scoreboard">FACEIT</a>`
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

  // Fetch post-match Elo for all members; keep pre-match Elo from DB to calculate delta
  const registeredIds = new Map(members.map(m => [m.faceit_player_id, { preElo: m.faceit_elo, postElo: null }]));
  await Promise.allSettled(members.map(async m => {
    const profile = await getPlayerById(m.faceit_player_id).catch(() => null);
    if (!profile) return;
    const elo = profile.games?.cs2?.faceit_elo ?? null;
    registeredIds.get(m.faceit_player_id).postElo = elo;
    setFaceitAccount(chatId, m.user_id, m.faceit_player_id, elo);
  }));

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
  reminderPhraseCache.set(`${chatId}:${messageId}`, phrase);
  const text = buildReminderText(row, joining, phrase);
  const sent = await api.sendMessage(chatId, text, { parse_mode: "HTML" });
  console.log(`[reminder] sent — ${joining.length} joining`);
  return sent;
}
