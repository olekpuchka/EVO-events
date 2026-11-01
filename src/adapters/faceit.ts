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
import { FACEIT_API_KEY, FACEIT_COOKIE } from "../config.ts";

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

// No retries by default, for `/faceit`: backoff would be dead air for someone watching.
export function getPlayerById(playerId: string, { retries = 0 }: { retries?: number } = {}): Promise<FaceitPlayer | null> {
  return faceitGet<FaceitPlayer>(`${BASE}/players/${encodeURIComponent(playerId)}`, { retries });
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

// Beyond any avatar FACEIT serves; the largest seen was ~250 KB at 1080×1080.
const AVATAR_MAX_BYTES = 2_000_000;

// A player's avatar bytes for the card, or null on any failure; the renderer checks the format.
export async function getAvatar(url: string | null): Promise<Uint8Array | null> {
  if (!url?.startsWith("https://")) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Read in chunks and stop past the cap: content-length may be absent, and the bot has 250 MB.
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > AVATAR_MAX_BYTES) throw new Error(`over ${AVATAR_MAX_BYTES} B`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    console.error("[faceit] avatar fetch failed:", (err as Error).message);
    return null;
  }
}

// faceit.com's own API, for what the open one lacks. Cloudflare admits a current Chrome fingerprint
// with navigation headers — see **Rating and swing** in CLAUDE.md.
const CHROME = 152;
const SITE_HEADERS = {
  "cache-control": "no-cache",
  pragma: "no-cache",
  // Chrome's GREASE brand and order change with its version; this is 152's.
  "sec-ch-ua": `"Google Chrome";v="${CHROME}", "Not?A_Brand";v="24", "Chromium";v="${CHROME}"`,
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

// Loaded on first use; a failed init is dropped so the next poll tries again.
let tls: Promise<void> | null = null;
function tlsReady(): Promise<void> {
  tls ??= ensureNativeLibrary()
    .then(() => initTLS())
    .then(() => {
      // An idle worker whose library won't load has no request to fail, so the pool emits 'error' —
      // unheard, that kills the process. Heard, a bad library costs only the scoreboard.
      Client.getInstance().pool.on("error", err => console.error("[faceit] tls worker failed:", (err as Error).message));
    })
    .catch(err => { tls = null; throw err; });
  return tls;
}

function newSession(headers: Record<string, string>): Session {
  return new Session({
    // Newer than the wrapper's enum; the Go library knows it, and falls back silently on a name it doesn't.
    clientIdentifier: `chrome_${CHROME}` as ClientIdentifier,
    timeout: TIMEOUT_MS,
    headers,
    // Header names at runtime; the library's typings mistype it as an array of header objects.
    headerOrder: Object.keys(headers) as unknown as OutgoingHttpHeaders[],
  });
}

let anonymous: Session | null = null;
async function siteSession(): Promise<Session> {
  await tlsReady();
  return anonymous ??= newSession(SITE_HEADERS);
}

// Cloudflare's "Just a moment..." page rather than an answer from faceit.com.
export class ChallengeError extends Error {}

type SiteResponse = Awaited<ReturnType<Session["get"]>>;

// One GET, waiting out up to three 429s — the anonymous limit is 5 per 30s. A challenge throws.
async function siteGet(get: () => Promise<SiteResponse>): Promise<SiteResponse> {
  let res = await get();
  for (let retry = 0; res.status === 429 && retry < 3; retry++) {
    const wait = Number(firstHeader(res.headers["Ratelimit-Retry-After"])) || 10;
    await sleep(Math.min(wait + 1, 30) * 1000);
    res = await get();
  }
  if (firstHeader(res.headers["Cf-Mitigated"]) === "challenge" || res.body.includes("<title>Just a moment")) {
    throw new ChallengeError(`faceit.com ${res.status}: Cloudflare challenge`);
  }
  return res;
}

// Chrome sends the cookie between accept-language and priority; the header order is part of the fingerprint.
const { priority, ...headersBeforePriority } = SITE_HEADERS;
const SIGNED_IN_HEADERS = { ...headersBeforePriority, cookie: `__Host-FaceitGatewayAuthorization=${FACEIT_COOKIE}`, priority };

// The env var is read once, so a rejected token stays dead until a restart: tried, and logged, once.
let cookieRejected = false;

// A session per request, 429 retries included: a jar would replay a rotated token beside ours, and
// the anonymous session must never carry a signed-in cookie.
async function oneShotGet(url: string): Promise<SiteResponse> {
  const session = newSession(SIGNED_IN_HEADERS);
  try {
    return await session.get(url);
  } finally {
    await session.close().catch(() => {});
  }
}

// The `error` code of an OAuth-style JSON body (`{"error":"invalid_token",…}`), or undefined.
function oauthError(body: string): unknown {
  try { return (JSON.parse(body) as { error?: unknown }).error; } catch { return undefined; }
}

// The retry of a withheld board; every failure names FACEIT_COOKIE.
async function signedInGet(url: string): Promise<SiteResponse> {
  const res = await siteGet(() => oneShotGet(url))
    // The anonymous request just got through, so a challenge here is held like any other failure.
    .catch(err => { throw new Error(`FACEIT_COOKIE retry ${err instanceof ChallengeError ? "challenged" : "failed"}: ${(err as Error).message}`); });
  if (res.status === 200) return res;
  if ((res.status === 400 || res.status === 401) && oauthError(res.body) === "invalid_token") {
    // Polls of several chats can be in flight at once; the first to see it logs it.
    if (!cookieRejected) console.error(`[faceit] FACEIT_COOKIE rejected (${res.status} invalid_token): the login expired or was logged out — copy a fresh __Host-FaceitGatewayAuthorization from a signed-in browser and restart`);
    cookieRejected = true;
    throw new Error(`faceit.com ${res.status}: FACEIT_COOKIE rejected`);
  }
  throw new Error(`faceit.com ${res.status}: with FACEIT_COOKIE: ${res.body.slice(0, 160)}`);
}

// Rating, swing, KAST and match-time Elo by player id, first map only — the open API's stats read only
// rounds[0] too. Anonymous first; a withheld board is asked again with FACEIT_COOKIE when it is set.
export async function getMatchScoreboard(matchId: string): Promise<Map<string, ScoreboardLine>> {
  const url = `https://www.faceit.com/api/statistics/v1/cs2/matches/${encodeURIComponent(matchId)}/match-rounds/1/scoreboard-summary`;
  const session = await siteSession();
  let res = await siteGet(() => session.get(url));
  const withheldAnonymously = res.status === 403 && res.body.includes("err_f0");
  if (withheldAnonymously) {
    if (!FACEIT_COOKIE || cookieRejected) {
      throw new Error(`faceit.com 403: err_f0, and FACEIT_COOKIE is ${cookieRejected ? "rejected — set a fresh one and restart" : "not set"}`);
    }
    res = await signedInGet(url);
  }
  // Status 0 is the library's own transport error, and its reason is only in the body.
  if (res.status !== 200) throw new Error(`faceit.com ${res.status}: ${res.body.slice(0, 160)}`);
  const data = await res.json<FaceitScoreboard>();
  const lines = new Map<string, ScoreboardLine>();
  const teams = data.payload?.cs2?.teams ?? [];
  if (!teams.some(t => t.players?.length)) throw new Error("faceit.com 200: scoreboard has no players");
  for (const team of teams) {
    for (const p of team.players ?? []) {
      const rating = p.stats?.faceit_rating, swing = p.stats?.faceit_rating_swing;
      if (typeof rating !== "number" || typeof swing !== "number") continue;
      // `elo` is from before the match, so after it is the sum.
      const elo = typeof p.elo === "number" && typeof p.elo_delta === "number"
        ? { before: p.elo, after: p.elo + p.elo_delta, change: p.elo_delta }
        : null;
      const kast = typeof p.stats?.kast === "number" ? p.stats.kast : null;
      lines.set(p.player_id, { rating, swing, kast, elo, calibrating: p.is_calibrating === true });
    }
  }
  if (withheldAnonymously) console.log(`[faceit] scoreboard ${matchId} withheld anonymously, read with FACEIT_COOKIE`);
  return lines;
}
