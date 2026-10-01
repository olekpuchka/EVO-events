// Run inside the built image by CI: proves the result card renders there — resvg is a native module
// with a glibc build, and the fonts come from assets/. Offline: a bundled map stands in for one avatar,
// the other row gets the letter disc.
const { readFileSync } = require("node:fs");
import("../../src/adapters/card.ts").then(async ({ renderCard }) => {
  const avatar = readFileSync(require.resolve("../../assets/maps/de_mirage.jpg"));
  const row = { nickname: "smoke", kda: "20/15/5", adr: "90.0", rating: 1.2, swing: 1, eloAfter: 2000, eloChange: 25, mvp: true, avatar: null };
  const result = { won: true, ourScore: "13", theirScore: "9", elo: null, mapId: null, matchId: "1-smoke", rows: [row, { ...row, nickname: "other", mvp: false }] };
  // renderCard hides a failed avatar behind its retry and a bad one behind a drop; either fails the smoke.
  let degraded = "";
  const logError = console.error;
  console.error = (...args) => { degraded ||= args.join(" "); logError(...args); };
  const png = await renderCard(result, null, [avatar, null]);
  const ok = !degraded && png && png[0] === 0x89 && png[1] === 0x50 && png.length > 10_000;
  console.log(ok ? `card ok: ${png.length} B` : `card failed to render${degraded ? ` cleanly: ${degraded}` : ""}`);
  process.exit(ok ? 0 : 1);
});
