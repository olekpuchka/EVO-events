// Finished FACEIT match → the MatchResult both renderers draw. Apart from results.ts because it
// imports no database, so scripts/card-preview.ts can build a real match through it.

import { getMatchDetails, getMatchScoreboard, getPlayerById, ChallengeError } from "../adapters/faceit.ts";
import type { FaceitMatchStats, FaceitStatPlayer, EloPair, ResultRow, MatchResult } from "../types.ts";

// A match posts only if this many of us were on our team.
const MIN_PLAYERS = 2;

// Rounded to 2 places; toFixed alone takes 1.005 to "1.00".
const round2 = (n: number): number => Math.round(Number((n * 100).toPrecision(12))) / 100;

export async function buildMatchResult(
  stats: FaceitMatchStats,
  registeredIds: Set<string>,
  matchId: string
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

  // Details (roster avatars) only for a match that will post; unavailable, it is never posted.
  const matchDetails = await getMatchDetails(matchId);
  if (!matchDetails) return null;

  // Best-effort: a failed scoreboard drops Rating and Elo. A Cloudflare challenge is rethrown, so the poll retries.
  const board = await getMatchScoreboard(matchId).catch(err => {
    if (err instanceof ChallengeError) throw err;
    console.error("[faceit] scoreboard fetch failed:", (err as Error).message);
    return null;
  });

  // Display rows, by rating desc. Unrated players sink; ADR breaks ties, and orders all when unrated.
  const ratingOf = (p: FaceitStatPlayer): number => board?.get(p.player_id)?.rating ?? -Infinity;
  const adrOf = (p: FaceitStatPlayer): number => Number(p.player_stats?.ADR ?? 0);
  // The MVP is judged on the full team: a non-member topping it means no star on the card.
  const teamRatings = ourTeam.players.flatMap(p => { const r = board?.get(p.player_id); return r ? [round2(r.rating)] : []; });
  const mvpRating = won && teamRatings.length ? Math.max(...teamRatings) : null;
  const ourFaction = Object.values(matchDetails.teams ?? {}).find(f => f.roster?.some(p => registeredIds.has(p.player_id)));
  const avatarOf = new Map(ourFaction?.roster?.map(p => [p.player_id, p.avatar || null]));
  const resultRows: ResultRow[] = registered
    .sort((a, b) => ratingOf(b) - ratingOf(a) || adrOf(b) - adrOf(a))
    .map(p => {
      const s = p.player_stats ?? {};
      const r = board?.get(p.player_id);
      return {
        nickname: p.nickname,
        kda: `${s.Kills ?? "?"}/${s.Deaths ?? "?"}/${s.Assists ?? "?"}`,
        adr: s.ADR ?? "?",
        rating: r ? round2(r.rating) : null,
        swing: r ? round2(r.swing * 100) : null,
        kast: r?.kast != null ? Math.round(r.kast * 100) : null,
        eloAfter: r?.elo?.after ?? null,
        eloChange: r?.elo?.change ?? null,
        mvp: r !== undefined && round2(r.rating) === mvpRating,
        avatar: avatarOf.get(p.player_id) ?? null,
      };
    });

  const mapId = round.round_stats?.Map || null;

  // Elo going in, from the scoreboard; a calibrating player has none, so their profile's current one stands in.
  // undefined — no Elo and not calibrating — drops the pair; null — calibrating, none found — is skipped.
  const eloBeforeOf = async (p: FaceitStatPlayer): Promise<number | null | undefined> => {
    const line = board?.get(p.player_id);
    if (line?.elo) return line.elo.before;
    if (!line?.calibrating) return undefined;
    const player = await getPlayerById(p.player_id, { retries: 2 }).catch(err => {
      console.error(`[faceit] calibrating Elo fetch failed for ${p.nickname}:`, (err as Error).message);
      return null;
    });
    return player?.games?.cs2?.faceit_elo ?? null;
  };

  // Each team's average Elo going in.
  const teamElo = async (players: FaceitStatPlayer[] = []): Promise<number | null> => {
    const elos = await Promise.all(players.map(eloBeforeOf));
    if (elos.includes(undefined)) return null;
    const before = elos.filter((e): e is number => e != null);
    return before.length ? Math.round(before.reduce((a, b) => a + b) / before.length) : null;
  };
  const [ourElo, theirElo] = await Promise.all([teamElo(ourTeam.players), teamElo(theirTeam?.players)]);
  const elo: EloPair | null = ourElo !== null && theirElo !== null ? { ours: ourElo, theirs: theirElo } : null;

  return { won, ourScore, theirScore, elo, mapId, matchId, rows: resultRows };
}
