// Run inside the built image by CI: proves the result card renders there — resvg is a native module
// with a glibc build, and the fonts come from assets/. Offline: no map, so no network is needed.
Promise.all([import("../../src/adapters/card.ts"), import("../../src/view/card.ts")]).then(async ([{ renderCard }, { cardMarkup }]) => {
  const row = { nickname: "smoke", kda: "20/15/5", adr: "90.0", rating: 1.2, swing: 1, eloAfter: 2000, eloChange: 25 };
  const result = { won: true, ourScore: "13", theirScore: "9", elo: null, mapImage: null, matchId: "1-smoke", rows: [row, { ...row, nickname: "other" }] };
  const png = await renderCard(cardMarkup(result, false), null);
  const ok = png && png[0] === 0x89 && png[1] === 0x50 && png.length > 10_000;
  console.log(ok ? `card ok: ${png.length} B` : "card failed to render");
  process.exit(ok ? 0 : 1);
});
