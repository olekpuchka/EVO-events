import type {
  FaceitPlayer,
  FaceitSearchItem,
  FaceitHistoryItem,
  FaceitMatchStats,
  FaceitMatchDetails,
  FaceitScoreboard,
  ScoreboardLine,
} from "../types.ts";

import type { OutgoingHttpHeaders } from "node:http";
import { access, rm } from "node:fs/promises";
import { Session, ClientIdentifier, initTLS } from "node-tls-client";
import { LibraryHandler } from "node-tls-client/dist/utils/native.js";
import { LibraryDownloader } from "node-tls-client/dist/utils/download.js";
import { Client } from "node-tls-client/dist/lib/Client.js";
import { FACEIT_API_KEY } from "../config.ts";

const BASE = "https://open.faceit.com/data/v4";

// Public scoreboard URL for a match room.
export const matchRoomUrl = (matchId: string): string =>
  `https://www.faceit.com/en/cs2/room/${encodeURIComponent(matchId)}/scoreboard`;

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${FACEIT_API_KEY}` };
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// Per attempt, body included — undici's own default is ~5 min, and one hung call stalls every chat's poll.
const TIMEOUT_MS = 10_000;

async function faceitGet<T>(url: string, { retries = 2 }: { retries?: number } = {}): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: authHeader(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as T;
    // Retry rate-limits and transient server errors with backoff; without it, one 429 on a
    // history or stats call pushes that match back a whole poll interval.
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

// Fuzzy, case-insensitive nickname search — turns a failed exact /players lookup into suggestions
// instead of a dead end. No retries: "not found" is already decided, so backoff is just dead air.
export async function searchPlayers(nickname: string, limit = 5): Promise<FaceitSearchItem[]> {
  const data = await faceitGet<{ items?: FaceitSearchItem[] }>(
    `${BASE}/search/players?nickname=${encodeURIComponent(nickname)}&game=cs2&offset=0&limit=${limit}`,
    { retries: 0 }
  );
  return data?.items ?? [];
}

// No retries: only `/faceit` calls this, and backoff would be dead air for someone watching.
export function getPlayerById(playerId: string): Promise<FaceitPlayer | null> {
  return faceitGet<FaceitPlayer>(`${BASE}/players/${encodeURIComponent(playerId)}`, { retries: 0 });
}

export async function getRecentMatches(playerId: string, limit = 5): Promise<FaceitHistoryItem[]> {
  const data = await faceitGet<{ items?: FaceitHistoryItem[] }>(
    `${BASE}/players/${encodeURIComponent(playerId)}/history?game=cs2&limit=${limit}`
  );
  return data?.items ?? [];
}

export function getMatchStats(matchId: string): Promise<FaceitMatchStats | null> {
  return faceitGet<FaceitMatchStats>(`${BASE}/matches/${encodeURIComponent(matchId)}/stats`);
}

export function getMatchDetails(matchId: string): Promise<FaceitMatchDetails | null> {
  return faceitGet<FaceitMatchDetails>(`${BASE}/matches/${encodeURIComponent(matchId)}`);
}

// faceit.com's own API, for what the open one lacks. Cloudflare admits only the chrome_131
// fingerprint with navigation headers — see **Rating and swing** in CLAUDE.md.
const CHROME = 131;
const SITE_HEADERS = {
  "cache-control": "no-cache",
  pragma: "no-cache",
  "sec-ch-ua": `"Google Chrome";v="${CHROME}", "Chromium";v="${CHROME}", "Not_A Brand";v="24"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "upgrade-insecure-requests": "1",
  "user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME}.0.0.0 Safari/537.36`,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7",
  priority: "u=0, i",
};

// initTLS process.exit()s if its native library is missing and the download fails, so fetch it
// here first, where failing is an ordinary error.
async function ensureNativeLibrary(): Promise<void> {
  const file = LibraryHandler.path;
  if (await access(file).then(() => true, () => false)) return;
  if (!(await LibraryDownloader.retrieveLibrary(LibraryHandler.retrieveFileInfo(), file))) {
    // The library creates the file before downloading and leaves it on an HTTP error; left
    // there, the next check would take it for a real library.
    await rm(file, { force: true });
    throw new Error("tls-client native library unavailable");
  }
}

// The library hands header values back as arrays.
const firstHeader = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// Opened on first use; a failed init is dropped so the next poll tries again.
let site: Promise<Session> | null = null;
function siteSession(): Promise<Session> {
  site ??= ensureNativeLibrary()
    .then(() => initTLS())
    .then(() => {
      // An idle worker whose library won't load has no request to fail, so the pool emits 'error' —
      // unheard, that kills the process. Heard, a bad library costs only the scoreboard.
      Client.getInstance().pool.on("error", err => console.error("[faceit] tls worker failed:", (err as Error).message));
    })
    .then(() => new Session({
      clientIdentifier: ClientIdentifier.chrome_131,
      timeout: TIMEOUT_MS,
      headers: SITE_HEADERS,
      // Header names at runtime; the library's typings mistype it as an array of header objects.
      headerOrder: Object.keys(SITE_HEADERS) as unknown as OutgoingHttpHeaders[],
    }))
    .catch(err => { site = null; throw err; });
  return site;
}

// Rating, swing and match-time Elo by player id, first map only — the open API's stats read only
// rounds[0] too. The anonymous limit is 5 requests per 30s, so a 429 waits out the slot it names —
// the poll is in the background, and this is the only source of per-player Elo.
export async function getMatchScoreboard(matchId: string): Promise<Map<string, ScoreboardLine>> {
  const session = await siteSession();
  const url = `https://www.faceit.com/api/statistics/v1/cs2/matches/${encodeURIComponent(matchId)}/match-rounds/1/scoreboard-summary`;
  let res = await session.get(url);
  for (let retry = 0; res.status === 429 && retry < 3; retry++) {
    const wait = Number(firstHeader(res.headers["Ratelimit-Retry-After"])) || 10;
    await sleep(Math.min(wait + 1, 30) * 1000);
    res = await session.get(url);
  }
  // Status 0 is the library's own transport error, and its reason is only in the body.
  if (res.status !== 200) throw new Error(`faceit.com ${res.status}: ${res.body.slice(0, 160)}`);
  const data = await res.json<FaceitScoreboard>();
  const lines = new Map<string, ScoreboardLine>();
  for (const team of data.payload?.cs2?.teams ?? []) {
    for (const p of team.players ?? []) {
      const rating = p.stats?.faceit_rating, swing = p.stats?.faceit_rating_swing;
      if (typeof rating !== "number" || typeof swing !== "number") continue;
      // `elo` is from before the match, so after it is the sum.
      const elo = typeof p.elo === "number" && typeof p.elo_delta === "number"
        ? { after: p.elo + p.elo_delta, change: p.elo_delta }
        : null;
      lines.set(p.player_id, { rating, swing, elo });
    }
  }
  return lines;
}

// FACEIT's large map image URL for the played map, or null if not in the pool.
export function getMapImage(matchDetails: FaceitMatchDetails, mapId: string): string | null {
  return (matchDetails.voting?.map?.entities ?? []).find(e => e.game_map_id === mapId)?.image_lg ?? null;
}
