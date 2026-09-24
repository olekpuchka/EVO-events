// Match result → the HTML satori renders into the result card, plus the photo's caption.
// Only the flexbox subset satori supports: every element with children is `display:flex`.

import { escapeHtml } from "./html.ts";
import { t } from "./i18n.ts";
import type { MatchResult, ResultRow } from "../types.ts";

export const CARD_WIDTH = 800;

// The map is a banner with the score across it, not a photo: the table is what people read.
const MAP_HEIGHT = 190;

// The map's `src` in the markup; the renderer swaps the image bytes in after parsing.
export const MAP_SRC = "map";

// The formats satori decodes, told by magic bytes — a file's name or Content-Type can lie. Anything
// else (WebP, AVIF) makes satori throw mid-render, so it must never reach the worker.
export function mapFormat(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

export const COLOR = {
  bg: "#111418", text: "#f4f6f7", muted: "#d3dcdf", head: "#262d36",
  rowA: "#181d23", rowB: "#20262e", line: "#353e49", best: "#f3b346", up: "#6ade43", down: "#ff2727",
};

// A body cell: extra style for its box, and what goes in it. `hot` is the MVP row, drawn bold.
type Cell = { style: string; body: string };
type Column = { head: string; flex: number; cell: (r: ResultRow, hot: boolean) => Cell };

// A plain figure, in a colour when it has one.
const plain = (text: string, color = "", hot = false): Cell => ({
  style: `${color ? `;color:${color}` : ""}${hot ? ";font-weight:700" : ""}`,
  body: `<div style="display:flex">${escapeHtml(text)}</div>`,
});

// Rating and Swing only when faceit.com's scoreboard answered — the same rule as the rich table.
function columns(rated: boolean): Column[] {
  return [
    ...(rated ? [
      { head: "Rating", flex: 1, cell: (r: ResultRow): Cell => {
        const rating = parseFloat(r.rating ?? "");
        return Number.isNaN(rating) ? plain(r.rating ?? "?") : { style: "", body: ratingChip(rating, r.rating!) };
      } },
      { head: "Swing", flex: 1.45, cell: (r: ResultRow, hot: boolean) => plain(r.swing ?? "?", swingColor(r.swing ?? "?"), hot) },
    ] : []),
    { head: "K/D/A", flex: 1.3, cell: (r, hot) => plain(r.kda, "", hot) },
    { head: "ADR", flex: 1, cell: (r, hot) => plain(r.adr, "", hot) },
  ];
}

const PLAYER_FLEX = 2.6;

// The table's inner width: the card less the table's margin and border either side.
const TABLE_WIDTH = CARD_WIDTH - 2 * 16 - 2;
const PLAYER_PADDING = 18;

// Room the nickname has: the player column's share of the table, less its padding. The column is
// wider without Rating and Swing, so this is worked out per table rather than fixed.
const nickRoom = (cols: Column[]): number =>
  Math.floor(TABLE_WIDTH * PLAYER_FLEX / (PLAYER_FLEX + cols.reduce((sum, c) => sum + c.flex, 0))) - 2 * PLAYER_PADDING;

// The room the MVP star takes from the nickname beside it.
const MVP_ROOM = 40;

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

// A colour mixed solid onto a base: a chip keeps one shade whichever row stripe it sits on.
function blend(hex: string, alpha: number, base: string = COLOR.rowA): string {
  const [c, b] = [rgb(hex), rgb(base)];
  return "#" + c.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

// FACEIT's rating chip: the figure bold in its tier's colour on a faint tint, over a bar filled from 0.6 to 1.6.
function ratingChip(rating: number, text: string): string {
  const tier = ratingPaint(rating);
  const chip = tier.map(c => blend(c, 0.16));
  const track = tier.map((c, i) => blend(c, 0.22, chip[i]));
  const fill = Math.round(Math.max(0.05, Math.min(1, rating - 0.6)) * 100);
  // A gradient figure is the gradient clipped to the text; a solid one is just its colour.
  const figure = tier.length === 1 ? `color:${tier[0]}` : `background-image:${paint(tier)};background-clip:text;color:transparent`;
  return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;padding:3px 5px 5px;border-radius:6px;` +
    `background:${paint(chip)}">` +
    `<div style="display:flex;font-size:26px;font-weight:700;${figure}">${escapeHtml(text)}</div>` +
    `<div style="display:flex;width:50px;height:4px;border-radius:2px;background:${paint(track)}">` +
    `<div style="display:flex;width:${fill}%;height:4px;border-radius:2px;background:${paint(tier)}"></div></div></div>`;
}

// Up green, down red, no change grey — for a swing and an Elo change alike.
const signColor = (n: number): string => n > 0 ? COLOR.up : n < 0 ? COLOR.down : COLOR.muted;

// A swing as printed, "+6.80%" / "-4.50%"; "?" gets no colour.
function swingColor(text: string): string {
  const value = parseFloat(text.replace("−", "-"));
  return Number.isNaN(value) ? "" : signColor(value);
}

// The banner: the score large across the map, green for a win and red for a loss, the team Elo
// pair small under it. Without a map it sits on a plain band of the same height.
function banner(result: MatchResult, withMap: boolean): string {
  const shadow = "text-shadow:0 3px 12px rgba(0,0,0,0.85)";
  const elo = result.elo ? `(${result.elo.ours} Elo vs ${result.elo.theirs} Elo)` : "";
  const overlay =
    `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;position:absolute;` +
    `top:0;left:0;width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px;background:${tint(COLOR.bg, withMap ? 0.45 : 0)}">` +
    `<div style="display:flex;font-size:92px;font-weight:700;letter-spacing:4px;color:${result.won ? COLOR.up : COLOR.down};${shadow}">` +
    `${escapeHtml(`${result.ourScore}:${result.theirScore}`)}</div>` +
    (elo ? `<div style="display:flex;font-size:22px;font-weight:700;color:${COLOR.text};${shadow}">${escapeHtml(elo)}</div>` : "") +
    `</div>`;
  const ground = withMap
    ? `<img src="${MAP_SRC}" style="width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px;object-fit:cover"/>`
    : `<div style="display:flex;width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px;background:${COLOR.head}"></div>`;
  return `<div style="display:flex;position:relative;width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px">${ground}${overlay}</div>`;
}

// The nickname in bold, with the MVP star beside it, and under it the Elo and this match's change.
function playerCell(row: ResultRow, mvp: boolean, width: number): string {
  const room = mvp ? width - MVP_ROOM : width;
  const nick = `<div style="display:flex;font-size:${nickSize(row.nickname, room)}px;font-weight:700;max-width:${room}px;` +
    `overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escapeHtml(row.nickname)}</div>`;
  const badge = mvp
    ? `<svg width="28" height="28" viewBox="0 0 24 24"><polygon points="${STAR}" fill="${COLOR.best}" ` +
      `stroke="${COLOR.best}" stroke-width="2.5" stroke-linejoin="round"/></svg>`
    : "";
  const change = row.eloChange;
  const arrow = change === null ? "" : change > 0 ? `↑${change}` : change < 0 ? `↓${-change}` : "±0";
  const eloLine = row.eloAfter === null ? "" :
    `<div style="display:flex;align-items:baseline;gap:12px">` +
    `<span style="font-size:22px;color:${COLOR.muted}">${row.eloAfter}</span>` +
    (arrow ? `<span style="font-size:20px;font-weight:700;color:${signColor(change!)}">${arrow}</span>` : "") +
    `</div>`;
  return `<div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px">` +
    `<div style="display:flex;align-items:center;gap:10px">${nick}${badge}</div>${eloLine}</div>`;
}

function table(result: MatchResult): string {
  const { rows } = result;
  const rated = rows.some(r => r.rating !== null);
  const cols = columns(rated);
  const ratings = rows.map(r => parseFloat(r.rating ?? ""));
  const top = Math.max(...ratings.filter(Number.isFinite));
  // A win's MVP is its highest rating, ties included; a loss has none.
  const mvp = new Set(result.won && rated ? ratings.flatMap((v, i) => v === top ? [i] : []) : []);
  const room = nickRoom(cols);

  const cellStyle = (flex: number, first: boolean, extra: string) =>
    `display:flex;align-items:center;justify-content:${first ? "flex-start" : "center"};flex:${flex};` +
    `padding:${first ? `14px ${PLAYER_PADDING}px` : "14px 4px"}${first ? "" : `;border-left:1px solid ${COLOR.line}`};${extra}`;

  const headCell = (flex: number, first: boolean, label: string) =>
    `<div style="${cellStyle(flex, first, `font-size:17px;font-weight:700;letter-spacing:1px;color:${COLOR.muted}`)}">` +
    `<div style="display:flex">${escapeHtml(label.toUpperCase())}</div></div>`;
  const head = `<div style="display:flex;background:${COLOR.head}">` +
    headCell(PLAYER_FLEX, true, t("scorePlayer")) + cols.map(c => headCell(c.flex, false, c.head)).join("") + `</div>`;

  const body = rows.map((row, i) => {
    const hot = mvp.has(i);
    const cells = cols.map(c => {
      const { style, body } = c.cell(row, hot);
      return `<div style="${cellStyle(c.flex, false, `font-size:26px${style}`)}">${body}</div>`;
    }).join("");
    return `<div style="display:flex;border-top:1px solid ${COLOR.line};background:${i % 2 ? COLOR.rowB : COLOR.rowA}">` +
      `<div style="${cellStyle(PLAYER_FLEX, true, "")}">${playerCell(row, hot, room)}</div>${cells}</div>`;
  }).join("");

  return `<div style="display:flex;flex-direction:column;margin:16px;border:1px solid ${COLOR.line};border-radius:10px">${head}${body}</div>`;
}

// The whole card. `withMap` is false when the map image could not be had — the banner goes plain.
export function cardMarkup(result: MatchResult, withMap: boolean): string {
  return `<div style="display:flex;flex-direction:column;width:${CARD_WIDTH}px;background:${COLOR.bg};color:${COLOR.text};` +
    `font-family:DejaVu;font-size:20px">${banner(result, withMap && result.mapImage !== null)}${table(result)}</div>`;
}

// Photo caption (parse_mode HTML): the tappable FACEIT link the card itself can't carry.
export const cardCaption = (roomUrl: string): string =>
  `🔗 ${t("viewOnFaceit")} <a href="${escapeHtml(roomUrl)}">FACEIT</a>`;
