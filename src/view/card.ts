// Match result → the HTML satori renders into the result card, plus the photo's caption.
// Only the flexbox subset satori supports: every element with children is `display:flex`.

import { escapeHtml } from "./html.ts";
import { t } from "./i18n.ts";
import type { EloPair, MatchResult, ResultRow } from "../types.ts";

export const CARD_WIDTH = 800;

// The map is a banner with the score across it, not a photo: the table is what people read.
const MAP_HEIGHT = 190;

// The map's and each row's avatar `src` in the markup; the renderer swaps the image bytes in after parsing.
export const MAP_SRC = "map";
export const avatarSrc = (row: number): string => `avatar${row}`;

// Whether the renderer has the image for a `src`; without it the map band goes plain and an avatar becomes a letter.
export type HasImage = (src: string) => boolean;

// FACEIT's neutral greys and orange, not a blue-grey: the card should read as their scoreboard.
export const COLOR = {
  bg: "#121212", text: "#ffffff", muted: "#a3a3a3", head: "#dcdcdc", panel: "#1c1c1c", side: "#242424",
  strip: "#3a3a3a",
  line: "#2b2b2b", accent: "#ff5500", best: "#f3b346", up: "#6ade43", down: "#ff2727",
};

// A body cell: extra style for its box, and what goes in it.
type Cell = { style: string; body: string };
type Column = { head: string; flex: number; cell: (r: ResultRow) => Cell };

// A plain figure, in a colour when it has one.
const plain = (text: string, color = ""): Cell => ({
  style: color ? `;color:${color}` : "",
  body: `<div style="display:flex">${escapeHtml(text)}</div>`,
});

// Rating and Swing only when faceit.com's scoreboard answered — the same rule as the rich table.
function columns(rated: boolean): Column[] {
  return [
    ...(rated ? [
      { head: "Rating", flex: 1, cell: (r: ResultRow): Cell => r.rating === null ? plain("?") : { style: "", body: ratingChip(r.rating) } },
      { head: "Swing", flex: 1.45, cell: (r: ResultRow) =>
        r.swing === null ? plain("?") : plain(formatSwing(r.swing), signColor(r.swing)) },
    ] : []),
    { head: "K/D/A", flex: 1.3, cell: r => plain(r.kda) },
    { head: "ADR", flex: 1, cell: r => plain(r.adr) },
  ];
}

const PLAYER_FLEX = 2.6;

// The gap splitting the player column from the figures, as FACEIT splits its scoreboard.
const SPLIT = 4;

// The width the columns share: the card less the panel's margin either side and the split.
const TABLE_WIDTH = CARD_WIDTH - 2 * 16 - SPLIT;
const PLAYER_PADDING = 18;

// Room the nickname has: the player column's share of the table, less its padding. The column is
// wider without Rating and Swing, so this is worked out per table rather than fixed.
const nickRoom = (cols: Column[]): number =>
  Math.floor(TABLE_WIDTH * PLAYER_FLEX / (PLAYER_FLEX + cols.reduce((sum, c) => sum + c.flex, 0))) - 2 * PLAYER_PADDING;

// The room the MVP star takes from the nickname beside it.
const MVP_ROOM = 40;

// The avatar circle before the nickname, and the gap after it.
export const AVATAR = 56;
const AVATAR_GAP = 14;

// FACEIT's MVP star: filled, its points rounded by a same-colour stroke.
const STAR = "12,2.8 14.8,8.7 21.2,9.4 16.4,13.8 17.7,20.2 12,17 6.3,20.2 7.6,13.8 2.8,9.4 9.2,8.7";

// A nickname's size: 25px while it fits, shrinking to 15px for a long one. Widths are DejaVu Sans
// Bold's by class of letter, tuned on real nicknames; the ellipsis catches what this misjudges.
function nickSize(nick: string, room: number): number {
  const em = [...nick].reduce((w, c) =>
    w + (/[WMШЩЖЮmwжшщю@]/.test(c) ? 1.05 : /[iljtfrI.,:;'!|]/.test(c) ? 0.38 : /[A-ZА-ЯІЇЄҐ0-9]/.test(c) ? 0.78 : 0.68), 0);
  return Math.max(15, Math.min(25, Math.floor(room / em)));
}

// A rating's paint: gold from 1.80 as FACEIT's orange-to-yellow, green from 1.30, white from 0.90, red below.
function ratingPaint(rating: number): string[] {
  return rating >= 1.8 ? ["#ff7601", "#fcd529"] : rating >= 1.3 ? [COLOR.up] : rating >= 0.9 ? [COLOR.text] : [COLOR.down];
}

// One colour stays a colour; two become a left-to-right gradient.
const paint = (p: string[]): string => p.length === 1 ? p[0]! : `linear-gradient(90deg, ${p.join(", ")})`;

const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

// A hex colour at the given opacity, for the dimming over the map photo.
function tint(hex: string, alpha: number): string {
  return `rgba(${rgb(hex).join(",")},${alpha})`;
}

// A colour mixed solid onto a base: a chip keeps one shade whatever sits behind it.
function blend(hex: string, alpha: number, base: string = COLOR.panel): string {
  const [c, b] = [rgb(hex), rgb(base)];
  return "#" + c.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

// FACEIT's rating chip: the figure bold in its tier's colour on a faint tint, over a bar filled from 0.6 to 1.6.
function ratingChip(rating: number): string {
  const tier = ratingPaint(rating);
  const chip = tier.map(c => blend(c, 0.16));
  const track = tier.map((c, i) => blend(c, 0.22, chip[i]));
  const fill = Math.round(Math.max(0.05, Math.min(1, rating - 0.6)) * 100);
  // A gradient figure is the gradient clipped to the text; a solid one is just its colour.
  const figure = tier.length === 1 ? `color:${tier[0]}` : `background-image:${paint(tier)};background-clip:text;color:transparent`;
  return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;padding:3px 5px 5px;border-radius:6px;` +
    `background:${paint(chip)}">` +
    `<div style="display:flex;font-size:26px;font-weight:700;${figure}">${formatRating(rating)}</div>` +
    `<div style="display:flex;width:50px;height:4px;border-radius:2px;background:${paint(track)}">` +
    `<div style="display:flex;width:${fill}%;height:4px;border-radius:2px;background:${paint(tier)}"></div></div></div>`;
}

// The figures as both renderers print them: "1.62", "+6.80%", "↑25" / "↓23" / "±0".
export const formatRating = (rating: number): string => rating.toFixed(2);
// A true minus, as wide as the plus, so a column of swings lines up.
export const formatSwing = (swing: number): string => `${swing >= 0 ? "+" : "−"}${Math.abs(swing).toFixed(2)}%`;
export const eloArrow = (change: number): string => change > 0 ? `↑${change}` : change < 0 ? `↓${-change}` : "±0";
export const eloPairText = (elo: EloPair): string => `${elo.ours} Elo vs ${elo.theirs} Elo`;

// Up green, down red, no change grey — for a swing and an Elo change alike.
const signColor = (n: number): string => n > 0 ? COLOR.up : n < 0 ? COLOR.down : COLOR.muted;

// The banner: the score large across the map, green for a win and red for a loss, the team Elo
// pair small under it. Without a map it sits on a plain band of the same height.
function banner(result: MatchResult, withMap: boolean): string {
  const shadow = "text-shadow:0 3px 12px rgba(0,0,0,0.85)";
  const elo = result.elo ? eloPairText(result.elo) : "";
  const overlay =
    `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;position:absolute;` +
    `top:0;left:0;width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px;background:${tint(COLOR.bg, withMap ? 0.45 : 0)}">` +
    `<div style="display:flex;font-size:92px;font-weight:700;letter-spacing:4px;color:${result.won ? COLOR.up : COLOR.down};${shadow}">` +
    `${escapeHtml(`${result.ourScore}:${result.theirScore}`)}</div>` +
    (elo ? `<div style="display:flex;font-size:20px;font-weight:700;letter-spacing:1px;color:${COLOR.text};${shadow}">${escapeHtml(elo)}</div>` : "") +
    `</div>`;
  const ground = withMap
    ? `<img src="${MAP_SRC}" style="width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px;object-fit:cover"/>`
    : `<div style="display:flex;width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px;background:${COLOR.panel}"></div>`;
  // FACEIT's orange edge under the banner.
  const edge = `<div style="display:flex;position:absolute;left:0;bottom:0;width:${CARD_WIDTH}px;height:4px;background:${COLOR.accent}"></div>`;
  return `<div style="display:flex;position:relative;width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px">${ground}${overlay}${edge}</div>`;
}

// The avatar, or the nickname's first letter on a grey disc when there is none.
function avatar(row: ResultRow, src: string | null): string {
  const circle = `width:${AVATAR}px;height:${AVATAR}px;border-radius:50%`;
  if (src) return `<img src="${src}" style="${circle};object-fit:cover"/>`;
  const letter = [...row.nickname].find(c => /[\p{L}\p{N}]/u.test(c))?.toUpperCase() ?? "?";
  return `<div style="display:flex;align-items:center;justify-content:center;${circle};background:${COLOR.strip};` +
    `font-size:24px;font-weight:700;color:${COLOR.muted}">${escapeHtml(letter)}</div>`;
}

// The avatar, then the nickname in bold with the MVP star beside it, and under it the Elo and this match's change.
function playerCell(row: ResultRow, mvp: boolean, width: number, src: string | null): string {
  const nickWidth = width - AVATAR - AVATAR_GAP;
  const room = mvp ? nickWidth - MVP_ROOM : nickWidth;
  const nick = `<div style="display:flex;font-size:${nickSize(row.nickname, room)}px;font-weight:700;max-width:${room}px;` +
    `overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escapeHtml(row.nickname)}</div>`;
  const badge = mvp
    ? `<svg width="28" height="28" viewBox="0 0 24 24"><polygon points="${STAR}" fill="${COLOR.best}" ` +
      `stroke="${COLOR.best}" stroke-width="2.5" stroke-linejoin="round"/></svg>`
    : "";
  const change = row.eloChange;
  const arrow = change === null ? "" : eloArrow(change);
  const eloLine = row.eloAfter === null ? "" :
    `<div style="display:flex;align-items:center;gap:12px">` +
    `<span style="font-size:22px;color:${COLOR.muted}">${row.eloAfter}</span>` +
    (arrow ? `<span style="font-size:22px;color:${signColor(change!)}">${arrow}</span>` : "") +
    `</div>`;
  return `<div style="display:flex;align-items:center;gap:${AVATAR_GAP}px">${avatar(row, src)}` +
    `<div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px">` +
    `<div style="display:flex;align-items:center;gap:10px">${nick}${badge}</div>${eloLine}</div></div>`;
}

function table(result: MatchResult, has: HasImage): string {
  const { rows } = result;
  const rated = rows.some(r => r.rating !== null);
  const cols = columns(rated);
  const room = nickRoom(cols);

  const cellStyle = (flex: number, first: boolean, extra: string) =>
    `display:flex;align-items:center;justify-content:${first ? "flex-start" : "center"};flex:${flex};` +
    `padding:${first ? `14px ${PLAYER_PADDING}px` : "14px 4px"};${extra}`;

  const headCell = (flex: number, first: boolean, label: string) =>
    `<div style="${cellStyle(flex, first, `font-size:18px;font-weight:700;color:${COLOR.head};padding-top:13px;padding-bottom:13px`)}">` +
    `<div style="display:flex">${escapeHtml(label)}</div></div>`;
  // A row is the tinted player block, the split, then the figures; the rule stops at the split.
  const statFlex = cols.reduce((sum, c) => sum + c.flex, 0);
  const rule = (ruled: boolean) => ruled ? `;border-top:1px solid ${COLOR.line}` : "";
  const line = (player: string, figures: string, ruled: boolean, strip = false) =>
    `<div style="display:flex">` +
    `<div style="display:flex;flex:${PLAYER_FLEX};background:${strip ? COLOR.strip : COLOR.side}${rule(ruled)}">${player}</div>` +
    `<div style="display:flex;width:${SPLIT}px;background:${COLOR.bg}"></div>` +
    `<div style="display:flex;flex:${statFlex};background:${strip ? COLOR.strip : COLOR.panel}${rule(ruled)}">${figures}</div></div>`;

  // The header is a strip of its own, split from the rows by the same gap as the columns.
  const head = line(headCell(1, true, t("scorePlayer")), cols.map(c => headCell(c.flex, false, c.head)).join(""), false, true) +
    `<div style="display:flex;height:${SPLIT}px;background:${COLOR.bg}"></div>`;

  const body = rows.map((row, i) => {
    const cells = cols.map(c => {
      const { style, body } = c.cell(row);
      return `<div style="${cellStyle(c.flex, false, `font-size:26px${style}`)}">${body}</div>`;
    }).join("");
    return line(`<div style="${cellStyle(1, true, "")}">${playerCell(row, row.mvp, room, has(avatarSrc(i)) ? avatarSrc(i) : null)}</div>`, cells, i > 0);
  }).join("");

  return `<div style="display:flex;flex-direction:column;margin:16px;background:${COLOR.panel};border-radius:8px;overflow:hidden">${head}${body}</div>`;
}

// The whole card, drawn around the images the renderer has.
export function cardMarkup(result: MatchResult, has: HasImage): string {
  return `<div style="display:flex;flex-direction:column;width:${CARD_WIDTH}px;background:${COLOR.bg};color:${COLOR.text};` +
    `font-family:DejaVu;font-size:20px">${banner(result, has(MAP_SRC))}${table(result, has)}</div>`;
}

// Photo caption (parse_mode HTML): the tappable FACEIT link the card itself can't carry.
export const cardCaption = (roomUrl: string): string =>
  `🔗 ${t("viewOnFaceit")} <a href="${escapeHtml(roomUrl)}">FACEIT</a>`;
