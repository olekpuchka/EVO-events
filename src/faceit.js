const BASE = "https://open.faceit.com/data/v4";

function authHeader() {
  return { Authorization: `Bearer ${process.env.FACEIT_API_KEY}` };
}

async function faceitGet(url) {
  const res = await fetch(url, { headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FACEIT ${res.status}`);
  return res.json();
}

export function getPlayer(nickname) {
  return faceitGet(`${BASE}/players?nickname=${encodeURIComponent(nickname)}`);
}

export function getPlayerById(playerId) {
  return faceitGet(`${BASE}/players/${playerId}`);
}

export async function getRecentMatches(playerId, limit = 5) {
  const res = await fetch(
    `${BASE}/players/${playerId}/history?game=cs2&limit=${limit}`,
    { headers: authHeader() }
  );
  if (!res.ok) throw new Error(`FACEIT ${res.status}`);
  return (await res.json()).items ?? [];
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
