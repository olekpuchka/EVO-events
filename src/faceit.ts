import type {
  FaceitPlayer,
  FaceitHistoryItem,
  FaceitMatchStats,
  FaceitMatchDetails,
} from "./types.ts";

const BASE = "https://open.faceit.com/data/v4";

// Public scoreboard URL for a match room.
export const matchRoomUrl = (matchId: string): string =>
  `https://www.faceit.com/en/cs2/room/${matchId}/scoreboard`;

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.FACEIT_API_KEY}` };
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function faceitGet<T>(url: string, { retries = 2 }: { retries?: number } = {}): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: authHeader() });
    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as T;
    // Retry rate-limits and transient server errors with backoff; a single 429 otherwise
    // silently degrades a player's line to "? Elo" and the match is never retried.
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      // Cap the honored Retry-After so a large value can't stall the whole poll.
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 300 * 2 ** attempt);
      continue;
    }
    throw new Error(`FACEIT ${res.status}`);
  }
}

export function getPlayer(nickname: string): Promise<FaceitPlayer | null> {
  return faceitGet<FaceitPlayer>(`${BASE}/players?nickname=${encodeURIComponent(nickname)}`);
}

export function getPlayerById(playerId: string): Promise<FaceitPlayer | null> {
  return faceitGet<FaceitPlayer>(`${BASE}/players/${playerId}`);
}

export async function getRecentMatches(playerId: string, limit = 5): Promise<FaceitHistoryItem[]> {
  const data = await faceitGet<{ items?: FaceitHistoryItem[] }>(
    `${BASE}/players/${playerId}/history?game=cs2&limit=${limit}`
  );
  return data?.items ?? [];
}

export function getMatchStats(matchId: string): Promise<FaceitMatchStats | null> {
  return faceitGet<FaceitMatchStats>(`${BASE}/matches/${matchId}/stats`);
}

export function getMatchDetails(matchId: string): Promise<FaceitMatchDetails | null> {
  return faceitGet<FaceitMatchDetails>(`${BASE}/matches/${matchId}`);
}

// The FACEIT map-vote entity for the played map, or undefined if not in the pool.
function mapEntity(matchDetails: FaceitMatchDetails | null, mapId: string) {
  return (matchDetails?.voting?.map?.entities ?? []).find(e => e.game_map_id === mapId);
}

// FACEIT's official display name for a played map (e.g. "Cache"), or null if not in the pool.
export function getMapName(matchDetails: FaceitMatchDetails | null, mapId: string): string | null {
  return mapEntity(matchDetails, mapId)?.name ?? null;
}

// FACEIT's large map image URL for the played map, or null if not in the pool.
export function getMapImage(matchDetails: FaceitMatchDetails | null, mapId: string): string | null {
  return mapEntity(matchDetails, mapId)?.image_lg ?? null;
}
