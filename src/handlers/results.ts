// Match results: turning a finished FACEIT match into the scoreboard the group sees. Split from
// handlers.ts because it changes for entirely different reasons — FACEIT's API shape rather than
// Telegram UX — and shares no state with the event lifecycle.

import { getFaceitMembers, setFaceitElo, hasPostedMatch, markMatchPosted } from "../adapters/db.ts";
import { stripAiHtml } from "../view/html.ts";
import { getPlayerById, getRecentMatches, getMatchStats, getMatchDetails, getMapName, getMapImage, matchRoomUrl } from "../adapters/faceit.ts";
import { generateMatchPhrase } from "../adapters/ai.ts";
import { t } from "../view/i18n.ts";
import type { Api } from "grammy";
import type { RichText, RichBlockTableCell } from "@grammyjs/types";
import type {
  FaceitMatchStats,
  FaceitMatchDetails,
  FaceitStatPlayer,
  EloPair,
  MatchFlow,
  MatchPlayer,
  Opponents,
  ResultRow,
  MatchResult,
} from "../types.ts";

// Per-member Elo tracking during a poll (see autoPostResult).
interface RegEntry {
  userId: number;
  preElo: number | null;
  postElo: number | null;
}

// The exact block-array type sendRichMessage accepts, so buildResultBlocks stays in sync with grammy.
type RichBlocks = NonNullable<NonNullable<Parameters<Api["sendRichMessage"]>[1]>["blocks"]>;

// A match posts only if this many of us were on our team.
const MIN_PLAYERS = 2;

// The only place FACEIT's stat key spellings appear. Run for our roster and for the
// opposing one, so both read the same keys through the same coercion.
function toMatchPlayer(p: FaceitStatPlayer): MatchPlayer {
  const s = p.player_stats ?? {};
  return {
    nickname: p.nickname,
    kills: Number(s.Kills),
    deaths: Number(s.Deaths),
    assists: Number(s.Assists),
    kd: Number(s["K/D Ratio"]),
    adr: Number(s.ADR),
    damage: Number(s.Damage),
    hs: Number(s["Headshots %"]),
    mvps: Number(s.MVPs),
    doubles: Number(s["Double Kills"]),
    triples: Number(s["Triple Kills"]),
    quadros: Number(s["Quadro Kills"]),
    aces: Number(s["Penta Kills"]),
    firstKills: Number(s["First Kills"]),
    entries: Number(s["Entry Wins"]),
    entryCount: Number(s["Entry Count"]),
    onevoneWins: Number(s["1v1Wins"]),
    onevoneCount: Number(s["1v1Count"]),
    clutches: Number(s["1v2Wins"]),
    clutchCount: Number(s["1v2Count"]),
    clutchKills: Number(s["Clutch Kills"]),
    awp: Number(s["Sniper Kills"]),
    pistol: Number(s["Pistol Kills"]),
    knife: Number(s["Knife Kills"]),
    zeus: Number(s["Zeus Kills"]),
    util: Number(s["Utility Damage"]),
    utilEnemies: Number(s["Utility Enemies"]),
    utilCount: Number(s["Utility Count"]),
    flashes: Number(s["Enemies Flashed"]),
    flashSuccesses: Number(s["Flash Successes"]),
    flashCount: Number(s["Flash Count"]),
  };
}

async function buildMatchResult(
  stats: FaceitMatchStats,
  registeredIds: Map<string, RegEntry>,
  elo: EloPair | null = null,
  matchId: string | null = null,
  matchDetails: FaceitMatchDetails | null = null
): Promise<MatchResult | null> {
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

  // Display rows, sorted by ADR desc.
  const resultRows: ResultRow[] = registered
    .sort((a, b) => Number(b.player_stats?.ADR ?? 0) - Number(a.player_stats?.ADR ?? 0))
    .map(p => {
      const s = p.player_stats ?? {};
      const entry = registeredIds.get(p.player_id);
      const preElo = entry?.preElo ?? null;
      const postElo = entry?.postElo ?? null;
      const delta = preElo && postElo ? postElo - preElo : null;
      // Non-breaking spaces keep the whole "1234 Elo ↑0" on one line so the cell
      // never wraps past two lines (nickname + elo) in the narrow scoreboard column.
      const deltaStr = delta ? ` ${delta >= 0 ? "↑" : "↓"}${Math.abs(delta)}` : "";
      return {
        nickname: p.nickname,
        kda: `${s.Kills ?? "?"}/${s.Deaths ?? "?"}/${s.Assists ?? "?"}`,
        adr: s.ADR ?? "?",
        elo: postElo ? `${postElo} Elo${deltaStr}` : "? Elo",
      };
    });

  // Counted from the stats: a failed history call would undercount.
  if (resultRows.length < MIN_PLAYERS) return null;

  const rawMap = round.round_stats?.Map ?? "";
  // Prefer FACEIT's official map name; fall back to cleaning the raw id if it's not in the pool.
  const map = getMapName(matchDetails, rawMap)
    || rawMap.replace(/^de_/, "").replace(/^cs_/, "").replace(/^\w/, c => c.toUpperCase())
    || null;
  const mapImage = getMapImage(matchDetails, rawMap);
  const players: MatchPlayer[] = registered.map(toMatchPlayer);
  // Raw, because which stat is worth a joke is a prompt decision. Players without stats lose
  // every comparison the picker makes, and the nickname is deleted — `Omit` erases at runtime.
  const opponents: Opponents = (theirTeam?.players ?? [])
    .map(toMatchPlayer)
    .filter(p => Number.isFinite(p.kills))
    .map(({ nickname: _drop, ...stats }) => stats);
  const matchFlow: MatchFlow | null = theirTeam
    ? {
        ourFirst: Number(ourTeam.team_stats?.["First Half Score"]),
        theirFirst: Number(theirTeam.team_stats?.["First Half Score"]),
        ourOt: Number(ourTeam.team_stats?.["Overtime score"]),
        theirOt: Number(theirTeam.team_stats?.["Overtime score"]),
      }
    : null;
  const phrase = await generateMatchPhrase(won, `${ourScore}:${theirScore}`, { map, elo, players, matchFlow, opponents });

  return { won, ourScore, theirScore, elo, mapImage, matchId, rows: resultRows, phrase };
}

// Rich rendering of a match result: header, scoreboard table, FACEIT footer.
function buildResultBlocks(result: MatchResult): RichBlocks {
  const { won, ourScore, theirScore, elo, matchId, rows, phrase, mapImage } = result;
  const H = (text: RichText, align: RichBlockTableCell["align"] = "center"): RichBlockTableCell => ({ text, is_header: true, align, valign: "middle" });
  const C = (text: RichText, align: RichBlockTableCell["align"] = "center"): RichBlockTableCell => ({ text, align, valign: "middle" });
  const cells: RichBlockTableCell[][] = [
    [H(t("scorePlayer")), H("K/D/A"), H("ADR")],
    ...rows.map(p => [
      C([{ type: "bold", text: p.nickname }, `\n${p.elo}`], "left"),
      C(p.kda),
      C(p.adr),
    ]),
  ];

  // The map is never named here — it shows only as the card's image below the header,
  // and still feeds the AI phrase.
  const header: RichText[] = [`${won ? "🍌" : "❌"} `, { type: "bold", text: `${ourScore}:${theirScore}` }];
  if (elo) header.push(" ", `(${elo.ours} Elo vs ${elo.theirs} Elo)`);

  const blocks: RichBlocks = [];
  // Header first, with the map image below it.
  blocks.push({ type: "paragraph", text: header });
  if (mapImage) blocks.push({ type: "photo", photo: { type: "photo", media: mapImage } });
  blocks.push({ type: "table", is_striped: true, is_bordered: true, cells });
  // TEMP: AI line hidden — uncomment to restore. The phrase is still generated either way.
  // blocks.push({ type: "blockquote", blocks: [{ type: "paragraph", text: { type: "italic", text: stripAiHtml(phrase) } }] });
  if (matchId) {
    blocks.push({ type: "footer", text: [`🔗 ${t("viewOnFaceit")} `, { type: "url", text: "FACEIT", url: matchRoomUrl(matchId) }] });
  }
  return blocks;
}

// Saves fetched Elo as the baseline for the next delta.
function commitElo(
  chatId: number | string,
  playerIds: Iterable<string>,
  registeredIds: Map<string, RegEntry>
): void {
  for (const pid of playerIds) {
    const entry = registeredIds.get(pid)!;
    if (entry.postElo !== null && entry.postElo !== entry.preElo) {
      setFaceitElo(chatId, entry.userId, pid, entry.postElo);
      // Live Elo: a second match this poll shows delta 0, not the same swing.
      entry.preElo = entry.postElo;
    }
  }
}

export async function autoPostResult(api: Api, chatId: number | string): Promise<void> {
  const members = getFaceitMembers(chatId);
  if (!members.length) return;

  const now = Math.floor(Date.now() / 1000);

  // Fetch last 5 matches per member in parallel
  const results = await Promise.allSettled(
    members.map(m => getRecentMatches(m.faceit_player_id, 5))
  );

  // Collect candidates: finished, within 24h, not already posted
  const candidates = new Map<string, { players: Set<string>; finished_at: number }>();
  const historyFailed: string[] = [];
  for (const [i, result] of results.entries()) {
    const pid = members[i].faceit_player_id;
    if (result.status !== "fulfilled") {
      historyFailed.push(pid);
      continue;
    }
    for (const match of result.value ?? []) {
      if (match.status !== "finished") continue;
      if (now - match.finished_at > 24 * 60 * 60) continue;
      if (hasPostedMatch(chatId, match.match_id)) continue;
      const existing = candidates.get(match.match_id);
      if (existing) existing.players.add(pid);
      else candidates.set(match.match_id, { players: new Set([pid]), finished_at: match.finished_at });
    }
  }

  if (historyFailed.length) console.error(`[faceit] poll: ${historyFailed.length}/${members.length} history calls failed`);
  if (!candidates.size) return;

  // Map our members → { preElo (DB baseline for the delta), postElo (filled in per match below,
  // only for members who actually played) }. Persisted only once the match is settled, or a
  // failed send would collapse the delta.
  const registeredIds = new Map<string, RegEntry>(
    members.map(m => [m.faceit_player_id, { userId: m.user_id, preElo: m.faceit_elo, postElo: null }])
  );

  // Players of skipped matches; their Elo is saved after the loop.
  const skipped = new Set<string>();

  // Sort by member count desc, then oldest first so multiple sessions post in chronological order
  const sortedMatches = [...candidates.entries()]
    .sort((a, b) => b[1].players.size - a[1].players.size || a[1].finished_at - b[1].finished_at);

  for (const [matchId, meta] of sortedMatches) {
    let stats: FaceitMatchStats | null = null;
    let matchDetails: FaceitMatchDetails | null = null;
    try {
      [stats, matchDetails] = await Promise.all([getMatchStats(matchId), getMatchDetails(matchId)]);
    } catch (err) {
      console.error("[faceit] poll stats fetch failed:", (err as Error).message);
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
    const participantIds = new Set<string>();
    for (const round of stats.rounds ?? []) {
      for (const team of round.teams ?? []) {
        for (const p of team.players ?? []) {
          if (registeredIds.has(p.player_id)) participantIds.add(p.player_id);
        }
      }
    }
    // Lets the pending check see players missing from their own history.
    for (const pid of participantIds) meta.players.add(pid);
    const transientFail = new Set<string>();
    await Promise.allSettled(
      [...participantIds]
        .filter(pid => registeredIds.get(pid)!.postElo === null)
        .map(async pid => {
          let profile;
          try {
            profile = await getPlayerById(pid);
          } catch {
            transientFail.add(pid); // 429/5xx/network after retries — worth retrying next poll
            return;
          }
          if (!profile) return; // 404 profile — permanent, accept "? Elo"
          registeredIds.get(pid)!.postElo = profile.games?.cs2?.faceit_elo ?? null; // null = unranked
        })
    );

    // Hold the whole match back rather than post partial "? Elo" when a fetch failed transiently —
    // don't markMatchPosted, so the next poll retries with complete info. Only while it's still
    // fresh: past the 30-min grace window, fall through and post best-effort so it never sticks.
    // (Unranked players / 404s aren't in transientFail, so they never block the post.)
    if (transientFail.size && now - meta.finished_at < 30 * 60) continue;

    const factions = Object.values(matchDetails.teams ?? {});
    const ourFaction = factions.find(f => f.roster?.some(p => registeredIds.has(p.player_id)));
    const theirFaction = factions.find(f => f !== ourFaction);
    const ourRating = ourFaction?.stats?.rating;
    const theirRating = theirFaction?.stats?.rating;
    const elo: EloPair | null = ourRating && theirRating
      ? { ours: ourRating, theirs: theirRating }
      : null;

    const result = await buildMatchResult(stats, registeredIds, elo, matchId, matchDetails);
    // Too few of us: not posted, but the Elo still counts.
    if (!result) {
      markMatchPosted(chatId, matchId);
      for (const pid of participantIds) skipped.add(pid);
      continue;
    }

    // Not marked posted on failure, so the next poll retries — which regenerates the phrase.
    try {
      await api.sendRichMessage(chatId, { blocks: buildResultBlocks(result) });
    } catch (err) {
      console.error("[faceit] poll send failed:", (err as Error).message);
      continue;
    }
    markMatchPosted(chatId, matchId);
    // Saved now: the post has shown the swing.
    commitElo(chatId, participantIds, registeredIds);
    console.log("[faceit] auto-posted result");
  }

  // Skipped matches save last, skipping players with a match still unposted — it owns the swing.
  const pending = new Set(historyFailed);
  for (const [id, c] of candidates) {
    if (!hasPostedMatch(chatId, id)) for (const pid of c.players) pending.add(pid);
  }
  commitElo(chatId, [...skipped].filter(pid => !pending.has(pid)), registeredIds);
}
