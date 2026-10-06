// Renders a sample result card: card-preview/card.html for a browser, card-preview/card.png as posted.
// `npm run card:preview -- [--loss] [--unrated] [--nicks=a,b] [--map-id=de_nuke] [--avatars] [--send=<chat id>]`
// `--match=<id or room URL> [--players=a,b]` builds a real match instead; --players names our linked members.
// --avatars and --match need FACEIT_API_KEY; --send needs BOT_TOKEN.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Api, InputFile } from "grammy";
import { cardMarkup, cardCaption, COLOR, MAP_SRC } from "../src/view/card.ts";
import { matchRoomUrl, getPlayer, getAvatar, getMatchStats } from "../src/adapters/faceit.ts";
import { renderCard, bundledMap, dataUri } from "../src/adapters/card.ts";
import { buildMatchResult } from "../src/handlers/match-result.ts";
import { BOT_TOKEN } from "../src/config.ts";
import type { MatchResult, ResultRow } from "../src/types.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const nicks = option("nicks")?.split(",").filter(Boolean) ?? [];
const loss = flag("loss");
const rated = !flag("unrated");

// Sorted by rating, as buildMatchResult sorts them.
const row = (i: number, nickname: string, rating: number, swing: number, kda: string, adr: string, kast: number, after: number, change: number): ResultRow => ({
  nickname: nicks[i] ?? nickname,
  kda,
  adr,
  rating: rated ? rating : null,
  swing: rated ? swing : null,
  kast: rated ? kast : null,
  eloAfter: after,
  eloChange: loss ? -Math.abs(change) : change,
  mvp: rated && !loss && i === 0,
  avatar: null,
});

// A real match through the bot's own builder; without --players, the first team stands in as ours.
async function realMatch(ref: string): Promise<MatchResult> {
  const matchId = ref.match(/room\/([^/?#]+)/)?.[1] ?? ref;
  const stats = await getMatchStats(matchId);
  const teams = stats?.rounds?.[0]?.teams;
  if (!stats || !teams?.length) throw new Error(`no stats for ${matchId}`);
  const named = new Set(option("players")?.split(",").map(n => n.toLowerCase()));
  const ours = named.size ? teams.flatMap(t => t.players).filter(p => named.has(p.nickname.toLowerCase())) : teams[0]!.players;
  const built = await buildMatchResult(stats, new Set(ours.map(p => p.player_id)), matchId);
  if (!built) throw new Error("not postable: fewer than two of --players on one team");
  return built;
}

const match = option("match");
const result: MatchResult = match ? await realMatch(match) : {
  won: !loss,
  ourScore: loss ? "9" : "13",
  theirScore: loss ? "13" : "9",
  elo: { ours: 1778, theirs: 1650 },
  mapId: option("map-id") ?? "de_mirage",
  matchId: "1-sample",
  rows: [
    row(0, "prox", 1.62, 6.8, "24/13/4", "112.8", 83, 2035, 25),
    row(1, "Transend", 1.53, 3.1, "21/14/3", "98.6", 79, 1679, 24),
    row(2, "kiko", 1.24, 0.4, "19/15/9", "94.1", 75, 1802, 23),
    row(3, "Booyaaa", 0.86, -2.7, "14/17/6", "71.3", 63, 1497, -23),
    row(4, "Zandy", 0.71, -4.5, "11/18/8", "63.2", 54, 1318, -22),
  ],
};

const map = await bundledMap(result.mapId);
const mapSrc = map ? dataUri(map) ?? "" : "";
const markup = cardMarkup(result, src => src === MAP_SRC && mapSrc !== "");
const out = resolve("card-preview");
mkdirSync(out, { recursive: true });

// The browser gets the same markup and fonts, with the caption under the card.
const fonts = resolve("assets/fonts");
writeFileSync(resolve(out, "card.html"), `<!doctype html><meta charset="utf-8"><title>Result card</title>
<style>
@font-face{font-family:DejaVu;font-weight:400;src:url("file://${fonts}/DejaVuSans.ttf")}
@font-face{font-family:DejaVu;font-weight:700;src:url("file://${fonts}/DejaVuSans-Bold.ttf")}
body{margin:24px;background:${COLOR.bg};color:${COLOR.text};font-family:DejaVu,sans-serif}
p{font-size:14px}a{color:${COLOR.muted}}
</style>
${markup.replace(`src="${MAP_SRC}"`, `src="${mapSrc}"`)}
<p>${cardCaption(matchRoomUrl(result.matchId))}</p>
`);

// Online only on request; otherwise every row gets its letter disc.
const avatars = match
  ? await Promise.all(result.rows.map(r => getAvatar(r.avatar)))
  : flag("avatars")
  ? await Promise.all(result.rows.map(async r => getAvatar((await getPlayer(r.nickname))?.avatar ?? null)))
  : result.rows.map(() => null);
const png = await renderCard(result, map, avatars);
if (!png) process.exit(1);
writeFileSync(resolve(out, "card.png"), png);
console.log(`${out}/card.html\n${out}/card.png (${png.length} B)${map ? "" : ` — no map: nothing bundled for ${result.mapId}`}`);

const to = option("send");
if (to) {
  await new Api(BOT_TOKEN).sendPhoto(to, new InputFile(png, "result.png"), { caption: cardCaption(matchRoomUrl(result.matchId)), parse_mode: "HTML" });
  console.log(`sent to ${to}`);
}
