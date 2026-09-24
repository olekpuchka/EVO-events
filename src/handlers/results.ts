// Match results: turning a finished FACEIT match into the scoreboard the group sees. Split from
// handlers.ts because it changes for entirely different reasons — FACEIT's API shape rather than
// Telegram UX — and shares no state with the event lifecycle.

import { getFaceitMembers, hasPostedMatch, markMatchPosted } from "../adapters/db.ts";
import { getRecentMatches, getMatchStats, getMatchDetails, getMatchScoreboard, getMapImage, fetchMapImage, matchRoomUrl } from "../adapters/faceit.ts";
import { renderCard } from "../adapters/card.ts";
import { cardMarkup, cardCaption } from "../view/card.ts";
import { t } from "../view/i18n.ts";
import { InputFile, type Api } from "grammy";
import type { RichText, RichBlockTableCell } from "@grammyjs/types";
import type {
  FaceitMatchStats,
  FaceitMatchDetails,
  FaceitStatPlayer,
  EloPair,
  ResultRow,
  MatchResult,
} from "../types.ts";

// The exact block-array type sendRichMessage accepts, so buildResultBlocks stays in sync with grammy.
type RichBlocks = NonNullable<NonNullable<Parameters<Api["sendRichMessage"]>[1]>["blocks"]>;

// A match posts only if this many of us were on our team.
const MIN_PLAYERS = 2;

// Rounded to 2 places; toFixed alone takes 1.005 to "1.00".
const round2 = (n: number): string => (Math.round(Number((n * 100).toPrecision(12))) / 100).toFixed(2);

async function buildMatchResult(
  stats: FaceitMatchStats,
  registeredIds: Set<string>,
  matchId: string,
  matchDetails: FaceitMatchDetails
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

  // Counted from the stats: a failed history call would undercount. Gated before the scoreboard
  // fetch, so a solo game spends none of faceit.com's anonymous rate limit.
  if (registered.length < MIN_PLAYERS) return null;

  // Best-effort: a scoreboard Cloudflare turned away drops Rating and Elo, never the post.
  const board = await getMatchScoreboard(matchId).catch(err => {
    console.error("[faceit] scoreboard fetch failed:", (err as Error).message);
    return null;
  });

  // Display rows, by rating desc. Unrated players sink; ADR breaks ties, and orders all when unrated.
  const ratingOf = (p: FaceitStatPlayer): number => board?.get(p.player_id)?.rating ?? -Infinity;
  const adrOf = (p: FaceitStatPlayer): number => Number(p.player_stats?.ADR ?? 0);
  const resultRows: ResultRow[] = registered
    .sort((a, b) => ratingOf(b) - ratingOf(a) || adrOf(b) - adrOf(a))
    .map(p => {
      const s = p.player_stats ?? {};
      const r = board?.get(p.player_id);
      const change = r?.elo?.change;
      // Non-breaking spaces keep the whole "1234 Elo ↑0" on one line so the cell
      // never wraps past two lines (nickname + elo) in the narrow scoreboard column.
      const deltaStr = change ? ` ${change >= 0 ? "↑" : "↓"}${Math.abs(change)}` : "";
      return {
        nickname: p.nickname,
        kda: `${s.Kills ?? "?"}/${s.Deaths ?? "?"}/${s.Assists ?? "?"}`,
        adr: s.ADR ?? "?",
        elo: r?.elo ? `${r.elo.after} Elo${deltaStr}` : null,
        rating: r ? round2(r.rating) : null,
        swing: r ? `${r.swing >= 0 ? "+" : ""}${round2(r.swing * 100)}%` : null,
        eloAfter: r?.elo?.after ?? null,
        eloChange: r?.elo?.change ?? null,
      };
    });

  const mapImage = getMapImage(matchDetails, round.round_stats?.Map ?? "");

  const factions = Object.values(matchDetails.teams ?? {});
  const ourFaction = factions.find(f => f.roster?.some(p => registeredIds.has(p.player_id)));
  const theirFaction = factions.find(f => f !== ourFaction);
  const ourRating = ourFaction?.stats?.rating;
  const theirRating = theirFaction?.stats?.rating;
  const elo: EloPair | null = ourRating && theirRating ? { ours: ourRating, theirs: theirRating } : null;

  return { won, ourScore, theirScore, elo, mapImage, matchId, rows: resultRows };
}

// Rich rendering of a match result: header, scoreboard table, FACEIT footer.
function buildResultBlocks(result: MatchResult): RichBlocks {
  const { won, ourScore, theirScore, elo, matchId, rows, mapImage } = result;
  const H = (text: RichText, align: RichBlockTableCell["align"] = "center"): RichBlockTableCell => ({ text, is_header: true, align, valign: "middle" });
  const C = (text: RichText, align: RichBlockTableCell["align"] = "center"): RichBlockTableCell => ({ text, align, valign: "middle" });
  // Two values per cell under a two-line header: three columns is what a phone fits unwrapped.
  // A failed scoreboard fetch drops the Rating column rather than filling it with "?".
  const rated = rows.some(p => p.rating !== null);
  const cells: RichBlockTableCell[][] = [
    [H(t("scorePlayer")), ...(rated ? [H("Rating\nSwing")] : []), H("K/D/A\nADR")],
    ...rows.map(p => [
      C([{ type: "bold", text: p.nickname }, ...(p.elo ? [`\n${p.elo}`] : [])], "left"),
      ...(rated ? [C(`${p.rating ?? "?"}\n${p.swing ?? "?"}`)] : []),
      C(`${p.kda}\n${p.adr}`),
    ]),
  ];

  // The map is never named here — it shows only as the card's image below the header.
  const header: RichText[] = [`${won ? "🍌" : "❌"} `, { type: "bold", text: `${ourScore}:${theirScore}` }];
  if (elo) header.push(" ", `(${elo.ours} Elo vs ${elo.theirs} Elo)`);

  const blocks: RichBlocks = [];
  // Header first, with the map image below it.
  blocks.push({ type: "paragraph", text: header });
  if (mapImage) blocks.push({ type: "photo", photo: { type: "photo", media: mapImage } });
  // Compact: smaller cell padding, for the same phone width.
  blocks.push({ type: "table", is_striped: true, is_bordered: true, is_compact: true, cells });
  blocks.push({ type: "footer", text: [`🔗 ${t("viewOnFaceit")} `, { type: "url", text: "FACEIT", url: matchRoomUrl(matchId) }] });
  return blocks;
}

// The card as a photo; the rich table when rendering fails, so a post is never lost to it.
async function sendResult(api: Api, chatId: number | string, result: MatchResult): Promise<void> {
  const map = result.mapImage ? await fetchMapImage(result.mapImage) : null;
  const png = await renderCard(cardMarkup(result, map !== null), map);
  if (!png) {
    await api.sendRichMessage(chatId, { blocks: buildResultBlocks(result) });
    return;
  }
  await api.sendPhoto(chatId, new InputFile(png, "result.png"), { caption: cardCaption(matchRoomUrl(result.matchId)), parse_mode: "HTML" });
}

export async function autoPostResult(api: Api, chatId: number | string): Promise<void> {
  const members = getFaceitMembers(chatId);
  if (!members.length) return;

  const now = Math.floor(Date.now() / 1000);

  // Fetch last 5 matches per member in parallel
  const results = await Promise.allSettled(
    members.map(m => getRecentMatches(m.faceit_player_id, 5))
  );

  // Candidates: finished, within 24h, not already posted — by match id, with when it finished.
  const candidates = new Map<string, number>();
  let historyFailed = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      historyFailed++;
      continue;
    }
    for (const match of result.value ?? []) {
      if (match.status !== "finished") continue;
      if (now - match.finished_at > 24 * 60 * 60) continue;
      if (hasPostedMatch(chatId, match.match_id)) continue;
      candidates.set(match.match_id, match.finished_at);
    }
  }

  if (historyFailed) console.error(`[faceit] poll: ${historyFailed}/${members.length} history calls failed`);
  if (!candidates.size) return;

  const registeredIds = new Set(members.map(m => m.faceit_player_id));

  // Oldest first, so several matches from one session post in the order they were played.
  const sortedMatches = [...candidates.entries()].sort((a, b) => a[1] - b[1]);

  for (const [matchId, finishedAt] of sortedMatches) {
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
      if (!matchDetails || matchDetails.status !== "FINISHED" || now - finishedAt > 30 * 60) {
        markMatchPosted(chatId, matchId);
      }
      // else: FINISHED but stats not ready yet — retry next poll
      continue;
    }

    const result = await buildMatchResult(stats, registeredIds, matchId, matchDetails);
    // Too few of us: never posted, so marked done.
    if (!result) {
      markMatchPosted(chatId, matchId);
      continue;
    }

    // Not marked posted on failure, so the next poll retries.
    try {
      await sendResult(api, chatId, result);
    } catch (err) {
      console.error("[faceit] poll send failed:", (err as Error).message);
      continue;
    }
    markMatchPosted(chatId, matchId);
    console.log("[faceit] auto-posted result");
  }
}
