const BASE = "https://open.faceit.com/data/v4";

function authHeader() {
  return { Authorization: `Bearer ${process.env.FACEIT_API_KEY}` };
}

export async function getPlayer(nickname) {
  const res = await fetch(
    `${BASE}/players?nickname=${encodeURIComponent(nickname)}`,
    { headers: authHeader() }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FACEIT ${res.status}`);
  return res.json();
}

export async function getPlayerById(playerId) {
  const res = await fetch(`${BASE}/players/${playerId}`, { headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FACEIT ${res.status}`);
  return res.json();
}

export async function getRecentMatches(playerId, limit = 5) {
  const res = await fetch(
    `${BASE}/players/${playerId}/history?game=cs2&limit=${limit}`,
    { headers: authHeader() }
  );
  if (!res.ok) throw new Error(`FACEIT ${res.status}`);
  return (await res.json()).items ?? [];
}

export async function getMatchStats(matchId) {
  const res = await fetch(`${BASE}/matches/${matchId}/stats`, { headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FACEIT ${res.status}`);
  return res.json();
}

export async function getMatchDetails(matchId) {
  const res = await fetch(`${BASE}/matches/${matchId}`, { headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FACEIT ${res.status}`);
  return res.json();
}

export function getMapImageUrl(matchDetails, mapId) {
  const entities = matchDetails.voting?.map?.entities ?? [];
  return entities.find(e => e.game_map_id === mapId)?.image_lg ?? null;
}
