// Renders a sample result card: card-preview/card.html for a browser, card-preview/card.png as posted.
// `npm run card:preview -- [--loss] [--unrated] [--nicks=a,b] [--map=<url>] [--send=<chat id>]`
// Needs network for the map image; --send also needs BOT_TOKEN in the environment.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Api, InputFile } from "grammy";
import { cardMarkup, cardCaption, MAP_SRC } from "../src/view/card.ts";
import { fetchMapImage, matchRoomUrl } from "../src/adapters/faceit.ts";
import { renderCard } from "../src/adapters/card.ts";
import { BOT_TOKEN } from "../src/config.ts";
import type { MatchResult, ResultRow } from "../src/types.ts";

const MIRAGE = "https://assets.faceit-cdn.net/third_party/games/ce652bd4-0abb-4c90-9936-1133965ca38b/assets/votables/7fb7d725-e44d-4e3c-b557-e1d19b260ab8_1695819144685.jpeg";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const nicks = option("nicks")?.split(",").filter(Boolean) ?? [];
const loss = flag("loss");
const rated = !flag("unrated");

// Sorted by rating, as buildMatchResult sorts them.
const row = (i: number, nickname: string, rating: number, swing: number, kda: string, adr: string, after: number, change: number): ResultRow => ({
  nickname: nicks[i] ?? nickname,
  kda,
  adr,
  elo: `${after} Elo ${change >= 0 ? "↑" : "↓"}${Math.abs(change)}`,
  rating: rated ? rating.toFixed(2) : null,
  swing: rated ? `${swing >= 0 ? "+" : ""}${swing.toFixed(2)}%` : null,
  eloAfter: after,
  eloChange: loss ? -Math.abs(change) : change,
});

const result: MatchResult = {
  won: !loss,
  ourScore: loss ? "9" : "13",
  theirScore: loss ? "13" : "9",
  elo: { ours: 1778, theirs: 1650 },
  mapImage: option("map") ?? MIRAGE,
  matchId: "1-sample",
  rows: [
    row(0, "winfle", 1.62, 6.8, "24/13/4", "112.8", 2035, 25),
    row(1, "kolya_awp", 1.53, 3.1, "21/14/3", "98.6", 1679, 24),
    row(2, "banana_king", 1.24, 0.4, "19/15/9", "94.1", 1802, 23),
    row(3, "olek", 0.86, -2.7, "14/17/6", "71.3", 1497, -23),
    row(4, "sanya.exe", 0.71, -4.5, "11/18/8", "63.2", 1318, -22),
  ],
};

const map = await fetchMapImage(result.mapImage!);
const markup = cardMarkup(result, map !== null);
const out = resolve("card-preview");
mkdirSync(out, { recursive: true });

// The browser gets the same markup and fonts, with the caption under the card.
const fonts = resolve("assets/fonts");
const mapSrc = map ? `data:image/jpeg;base64,${Buffer.from(map).toString("base64")}` : "";
writeFileSync(resolve(out, "card.html"), `<!doctype html><meta charset="utf-8"><title>Result card</title>
<style>
@font-face{font-family:DejaVu;font-weight:400;src:url("file://${fonts}/DejaVuSans.ttf")}
@font-face{font-family:DejaVu;font-weight:700;src:url("file://${fonts}/DejaVuSans-Bold.ttf")}
body{margin:24px;background:#0e1116;color:#e8e8e8;font-family:DejaVu,sans-serif}
p{font-size:14px}a{color:#ff5500}
</style>
${markup.replace(`src="${MAP_SRC}"`, `src="${mapSrc}"`)}
<p>${cardCaption(matchRoomUrl(result.matchId))}</p>
`);

const png = await renderCard(markup, map);
if (!png) process.exit(1);
writeFileSync(resolve(out, "card.png"), png);
console.log(`${out}/card.html\n${out}/card.png (${png.length} B)${map ? "" : " — no map: the image fetch failed"}`);

const to = option("send");
if (to) {
  await new Api(BOT_TOKEN).sendPhoto(to, new InputFile(png, "result.png"), { caption: cardCaption(matchRoomUrl(result.matchId)), parse_mode: "HTML" });
  console.log(`sent to ${to}`);
}
