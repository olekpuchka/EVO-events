// Result card rendering: runs card-worker.ts in a child process and returns its PNG.
// A child per card keeps the renderer's memory out of the bot — see **Result card** in CLAUDE.md.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./card-worker.ts", import.meta.url));

// ~2.5s measured at 0.25 CPU; the rest is headroom for a busy host.
const TIMEOUT_MS = 20_000;

// Renders run one at a time: chats are polled in parallel, and two children at once would double
// the memory the 250 MB budget was measured against.
let queue: Promise<unknown> = Promise.resolve();

// PNG bytes, or null on any failure — the caller falls back to the rich message.
export function renderCard(markup: string, map: Uint8Array | null): Promise<Uint8Array | null> {
  const run = queue.then(() => renderOnce(markup, map));
  queue = run;
  return run;
}

function renderOnce(markup: string, map: Uint8Array | null): Promise<Uint8Array | null> {
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
    child.stdin.end(JSON.stringify({ markup, map: map ? Buffer.from(map).toString("base64") : null }));
  });
}
