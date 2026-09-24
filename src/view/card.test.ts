// A match result → the markup satori renders, and the caption that carries the link.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardMarkup, cardCaption, mapFormat, MAP_SRC } from "./card.ts";
import type { MatchResult, ResultRow } from "../types.ts";

const row = (nickname: string, rating: string | null, swing: string | null, adr: string, after: number | null, change: number | null): ResultRow =>
  ({ nickname, kda: "20/15/5", adr, elo: null, rating, swing, eloAfter: after, eloChange: change });

const RESULT: MatchResult = {
  won: true,
  ourScore: "13",
  theirScore: "9",
  elo: { ours: 1778, theirs: 1650 },
  mapImage: "https://example.test/mirage.jpg",
  matchId: "1-abc",
  rows: [
    row("<b>olek</b>", "1.31", "+6.80%", "112.8", 2035, 25),
    row("sanya", "1.20", "-4.50%", "63.2", 1318, -22),
  ],
};
const markup = cardMarkup(RESULT, true);
const with_ = (patch: Partial<MatchResult>) => cardMarkup({ ...RESULT, ...patch }, true);

test("the map is a placeholder the worker swaps, never the CDN URL", () => {
  assert.ok(markup.includes(`<img src="${MAP_SRC}"`));
  assert.ok(!markup.includes(RESULT.mapImage!));
});

test("no map, the score still has its band", () => {
  for (const bare of [cardMarkup(RESULT, false), with_({ mapImage: null })]) {
    assert.ok(!bare.includes("<img"));
    assert.match(bare, /">13:9</);
  }
});

test("the link stays out of the image and goes to the caption", () => {
  assert.ok(!markup.includes("FACEIT"));
  assert.equal(cardCaption("https://x.test/room"), `🔗 Дивитись на <a href="https://x.test/room">FACEIT</a>`);
});

test("the score sits over the map, green for a win, red for a loss", () => {
  assert.match(markup, /position:relative[^>]*><img src="map"[^]*color:#4ade80;[^"]*">13:9/);
  assert.match(with_({ won: false, ourScore: "9", theirScore: "13" }), /color:#f87171;[^"]*">9:13/);
  assert.equal(markup.split("(1778 Elo vs 1650 Elo)").length, 2, "the team Elo pair, once");
});

test("the Elo change is an arrow, green up, red down", () => {
  assert.match(markup, /2035<\/span><span[^>]*color:#4ade80">↑25/);
  assert.match(markup, /1318<\/span><span[^>]*color:#f87171">↓22/);
  assert.match(with_({ rows: [row("a", "1.0", "+0%", "80", 1500, 0)] }), />±0</);
});

test("no Elo, no Elo line", () => {
  assert.doesNotMatch(with_({ rows: [row("a", "1.0", "+0%", "80", null, null)] }), /±0|↑|↓/);
});

test("a swing is coloured by its sign", () => {
  assert.match(markup, /color:#4ade80"><div style="display:flex">\+6\.80%/);
  assert.match(markup, /color:#f87171"><div style="display:flex">-4\.50%/);
});

test("a rating is gold from 1.40, green from 1.10, grey below", () => {
  const tiers = with_({ rows: [row("a", "1.40", "+1%", "90", 1, 1), row("b", "1.10", "+1%", "80", 1, 1), row("c", "1.09", "+1%", "70", 1, 1)] });
  assert.match(tiers, /color:#ffc53d"><div style="display:flex">1\.40/);
  assert.match(tiers, /color:#4ade80"><div style="display:flex">1\.10/);
  assert.match(tiers, /color:#aeb9bc"><div style="display:flex">1\.09/);
});

test("a rating of 1.5 or more makes the row bold", () => {
  const hot = with_({ rows: [row("a", "1.50", "+1%", "90", 1, 1), row("b", "1.49", "+1%", "80", 1, 1)] });
  assert.match(hot, /font-weight:700"><div style="display:flex">1\.50/);
  assert.doesNotMatch(hot, /font-weight:700"><div style="display:flex">1\.49/);
});

test("a win gives the highest rating the MVP badge; a tie shares it; a loss has none", () => {
  assert.equal(markup.split(">MVP<").length, 2);
  assert.match(markup, /&lt;b&gt;olek&lt;\/b&gt;<\/div><div[^>]*>MVP</);
  assert.equal(with_({ rows: [row("a", "1.31", "+1%", "90", 1, 1), row("b", "1.31", "+1%", "80", 1, 1)] }).split(">MVP<").length, 3);
  assert.ok(!with_({ won: false }).includes(">MVP<"));
});

test("no rating from faceit.com: no Rating or Swing column, no MVP", () => {
  const unrated = with_({ rows: RESULT.rows.map(r => ({ ...r, rating: null, swing: null })) });
  assert.doesNotMatch(unrated, /RATING|SWING|>MVP</);
  assert.match(unrated, /K\/D\/A/);
});

test("the top ADR is marked by colour alone", () => {
  assert.match(markup, /color:#ffc53d"><div style="display:flex">112\.8/);
  assert.doesNotMatch(markup, /font-size:26px[^"]*font-weight:700/, "no figure is bold below 1.5");
});

test("a nickname is escaped, not parsed as markup", () => {
  assert.ok(markup.includes("&lt;b&gt;olek&lt;/b&gt;"));
  assert.ok(!markup.includes("<b>olek"));
});

test("a long nickname shrinks, and is clipped with an ellipsis rather than spilling", () => {
  const size = (m: string, nick: string) => Number(new RegExp(`font-size:(\\d+)px;font-weight:700;max-width:\\d+px;[^>]*>${nick}<`).exec(m)?.[1]);
  const long = with_({ won: false, rows: [row("Oleksandr_Kravets", "1.0", "+1%", "80", 1, 1)] });
  assert.ok(size(long, "Oleksandr_Kravets") < size(markup, "sanya"), "long name is smaller");
  assert.ok(size(long, "Oleksandr_Kravets") >= 15, "but never below 15px");
  assert.match(long, /text-overflow:ellipsis">Oleksandr_Kravets/);
});

test("only PNG and JPEG pass as a map, judged by bytes", () => {
  assert.equal(mapFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "png");
  assert.equal(mapFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(mapFormat(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), null, "WebP");
  assert.equal(mapFormat(new Uint8Array([])), null);
});

test("every element with children is a flex box, as satori requires", () => {
  const divs = markup.match(/<div style="[^"]*"/g) ?? [];
  assert.ok(divs.length > 0);
  for (const div of divs) assert.ok(div.includes("display:flex"), div);
});
