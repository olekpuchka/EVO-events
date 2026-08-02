// Match results: turning a finished FACEIT match into the scoreboard the group sees. Split from
// handlers.ts because it changes for entirely different reasons — FACEIT's API shape rather than
// Telegram UX — and shares no state with the event lifecycle.

import { getFaceitMembers, setFaceitElo, hasPostedMatch, markMatchPosted } from "../adapters/db.ts";
import { escapeHtml, escapeAiHtml, stripAiHtml } from "../view/html.ts";
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

  // Display rows (sorted by ADR desc), structured so the table and HTML fallback share one source.
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

  if (!resultRows.length) return null;

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

// Header pieces shared by both renderers so they never drift: win/loss emoji, score, and
// team Elo when present. The map shows only as the rich card's image below the header
// (never a name here); it still feeds the AI phrase, and the HTML fallback shows no map.
function resultHeader({ won, ourScore, theirScore, elo }: MatchResult): { emoji: string; score: string; elo: string | null } {
  return {
    emoji: won ? "🍌" : "❌",
    score: `${ourScore}:${theirScore}`,
    elo: elo ? `(${elo.ours} Elo vs ${elo.theirs} Elo)` : null,
  };
}

// HTML rendering of a match result — the fallback when a rich message can't be sent.
function renderResultHtml(result: MatchResult): string {
  const { matchId, rows, phrase } = result;
  const htmlRows = rows.map(p =>
    `· <b>${escapeHtml(p.nickname)}</b> (${p.elo}) — ${p.kda} · ${p.adr} ADR`
  );
  const { emoji, score, elo } = resultHeader(result);
  const header = `${emoji} <b>${escapeHtml(score)}</b>` + (elo ? ` ${escapeHtml(elo)}` : "");
  const matchLink = matchId
    ? `\n\n🔗 ${t("viewOnFaceit")} <a href="${matchRoomUrl(matchId)}">FACEIT</a>`
    : "";
  return (
    header + "\n\n" +
    htmlRows.join("\n") +
    `\n\n<blockquote><i>${escapeAiHtml(phrase)}</i></blockquote>` +
    matchLink
  );
}

// Rich rendering of a match result: header, scoreboard table, AI-commentary blockquote, FACEIT footer.
function buildResultBlocks(result: MatchResult): RichBlocks {
  const { matchId, rows, phrase, mapImage } = result;
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

  const { emoji, score, elo } = resultHeader(result);
  const header: RichText[] = [`${emoji} `, { type: "bold", text: score }];
  if (elo) header.push(" ", elo);

  const blocks: RichBlocks = [];
  // Header first, with the map image below it.
  blocks.push({ type: "paragraph", text: header });
  if (mapImage) blocks.push({ type: "photo", photo: { type: "photo", media: mapImage } });
  blocks.push(
    { type: "table", is_striped: true, is_bordered: true, cells },
    { type: "blockquote", blocks: [{ type: "paragraph", text: { type: "italic", text: stripAiHtml(phrase) } }] },
  );
  if (matchId) {
    blocks.push({ type: "footer", text: [`🔗 ${t("viewOnFaceit")} `, { type: "url", text: "FACEIT", url: matchRoomUrl(matchId) }] });
  }
  return blocks;
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
  const matchCounts = new Map<string, { count: number; finished_at: number }>();
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
  const registeredIds = new Map<string, RegEntry>(
    members.map(m => [m.faceit_player_id, { userId: m.user_id, preElo: m.faceit_elo, postElo: null }])
  );

  // Sort by member count desc, then oldest first so multiple sessions post in chronological order
  const sortedMatches = [...matchCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].finished_at - b[1].finished_at);

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
    if (!result) {
      markMatchPosted(chatId, matchId);
      continue;
    }

    // Prefer the rich scoreboard; fall back to plain HTML if the rich send is rejected.
    try {
      await api.sendRichMessage(chatId, { blocks: buildResultBlocks(result) });
    } catch (err) {
      console.warn("[faceit] rich post failed, falling back to HTML:", (err as Error).message);
      try {
        await api.sendMessage(chatId, renderResultHtml(result), { parse_mode: "HTML" });
      } catch (e) {
        console.error("[faceit] poll send failed:", (e as Error).message);
        continue;
      }
    }
    markMatchPosted(chatId, matchId);
    // Lock in the new Elo baseline now that the delta has been posted, so the next match
    // measures its delta from here. Only this match's participants — committing all of
    // registeredIds would persist Elo fetched for a different (possibly held-back) match.
    // Skip members whose profile fetch failed (postElo null).
    for (const pid of participantIds) {
      const entry = registeredIds.get(pid)!;
      if (entry.postElo !== null) {
        setFaceitElo(chatId, entry.userId, pid, entry.postElo);
        // Advance the baseline so a member's next match this poll shows delta 0
        // instead of repeating the same swing — postElo is live Elo, one value per batch.
        entry.preElo = entry.postElo;
      }
    }
    console.log("[faceit] auto-posted result");
  }
}
