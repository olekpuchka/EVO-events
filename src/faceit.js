const BASE = "https://open.faceit.com/data/v4";

function authHeader() {
  return { Authorization: `Bearer ${process.env.FACEIT_API_KEY}` };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function faceitGet(url, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: authHeader() });
    if (res.status === 404) return null;
    if (res.ok) return res.json();
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

export function getPlayer(nickname) {
  return faceitGet(`${BASE}/players?nickname=${encodeURIComponent(nickname)}`);
}

export function getPlayerById(playerId) {
  return faceitGet(`${BASE}/players/${playerId}`);
}

export async function getRecentMatches(playerId, limit = 5) {
  const data = await faceitGet(`${BASE}/players/${playerId}/history?game=cs2&limit=${limit}`);
  return data?.items ?? [];
}

export function getMatchStats(matchId) {
  return faceitGet(`${BASE}/matches/${matchId}/stats`);
}

export function getMatchDetails(matchId) {
  return faceitGet(`${BASE}/matches/${matchId}`);
}

export function getMapImageUrl(matchDetails, mapId) {
  const entities = matchDetails.voting?.map?.entities ?? [];
  return entities.find(e => e.game_map_id === mapId)?.image_lg ?? null;
}
