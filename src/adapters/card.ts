// Result card rendering: runs card-worker.ts in a child process and returns its PNG.
// A child per card keeps the renderer's memory out of the bot — see **Result card** in CLAUDE.md.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cardMarkup, MAP_SRC, avatarSrc } from "../view/card.ts";
import type { MatchResult } from "../types.ts";

const WORKER = fileURLToPath(new URL("./card-worker.ts", import.meta.url));
const MAPS = new URL("../../assets/maps/", import.meta.url);

// The bundled banner for a map id, pre-cut to 1600×380; null for a map we don't ship.
export async function bundledMap(mapId: string | null): Promise<Uint8Array | null> {
  if (!mapId || !/^[a-z0-9_]+$/.test(mapId)) return null;
  return readFile(new URL(`${mapId}.jpg`, MAPS)).catch(() => null);
}

// A 4x card with five avatars is ~3s of CPU; nobody waits on the post, so the rest is headroom.
const TIMEOUT_MS = 60_000;

// Renders run one at a time: chats are polled in parallel, and two children at once would double
// the memory the 250 MB budget was measured against.
let queue: Promise<unknown> = Promise.resolve();

// The image as a data URI, or null unless it is JPEG or PNG — the only two satori decodes.
export function dataUri(bytes: Uint8Array): string | null {
  const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpeg" : bytes[0] === 0x89 && bytes[1] === 0x50 ? "png" : null;
  return type && `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

// PNG bytes, or null on any failure — the caller falls back to the rich message. `avatars` follows `result.rows`.
export function renderCard(result: MatchResult, map: Uint8Array | null, avatars: (Uint8Array | null)[]): Promise<Uint8Array | null> {
  const images: Record<string, string> = {};
  for (const [src, bytes] of [[MAP_SRC, map] as const, ...avatars.map((a, i) => [avatarSrc(i), a] as const)]) {
    if (!bytes) continue;
    const uri = dataUri(bytes);
    if (uri) images[src] = uri;
    else console.error(`[card] ${src} dropped: not JPEG or PNG`);
  }
  const run = queue.then(async () => {
    const png = await renderOnce(cardMarkup(result, src => src in images), images);
    if (png || Object.keys(images).every(src => src === MAP_SRC)) return png;
    // A corrupt avatar or a memory spike from them fails the whole card; one retry without them keeps it.
    console.error("[card] retrying without avatars");
    const mapOnly: Record<string, string> = MAP_SRC in images ? { [MAP_SRC]: images[MAP_SRC]! } : {};
    return renderOnce(cardMarkup(result, src => src in mapOnly), mapOnly);
  });
  queue = run;
  return run;
}

function renderOnce(markup: string, images: Record<string, string>): Promise<Uint8Array | null> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "pipe"], timeout: TIMEOUT_MS });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => { err += c; });
    child.on("error", e => {
      console.error("[card] spawn failed:", e.message);
      resolve(null);
    });
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(Buffer.concat(out));
      // Node ends a crash with its version line; the error itself is the last line naming one.
      const cause = err.split("\n").reverse().find(l => /^\w*Error\b/.test(l.trim())) ?? err.trim().split("\n").at(-1);
      console.error(`[card] render failed (${signal ?? code}):`, cause?.trim() ?? "");
      resolve(null);
    });
    // A child that dies before reading its job raises EPIPE here; unheard, that kills the bot.
    child.stdin.on("error", e => console.error("[card] job write failed:", e.message));
    child.stdin.end(JSON.stringify({ markup, images }));
  });
}
