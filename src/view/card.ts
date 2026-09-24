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

const COLOR = {
  bg: "#111418", text: "#f4f6f7", muted: "#aeb9bc", head: "#262d36", headText: "#d3dcdf",
  rowA: "#181d23", rowB: "#20262e", line: "#353e49", best: "#ffc53d", up: "#4ade80", down: "#f87171",
};

// A FACEIT rating from here up is a standout game, as FACEIT itself marks it: the row goes bold.
const HOT_RATING = 1.5;

type Column = { head: string; flex: number; value: (r: ResultRow) => string };

// Rating and Swing only when faceit.com's scoreboard answered — the same rule as the rich table.
function columns(rated: boolean): Column[] {
  return [
    ...(rated ? [
      { head: "Rating", flex: 1, value: (r: ResultRow) => r.rating ?? "?" },
      { head: "Swing", flex: 1.45, value: (r: ResultRow) => r.swing ?? "?" },
    ] : []),
    { head: "K/D/A", flex: 1.3, value: r => r.kda },
    { head: "ADR", flex: 1, value: r => r.adr },
  ];
}

const PLAYER_FLEX = 2.6;

// Room the nickname has: the player column less its padding — the Elo line sits underneath.
const NICK_ROOM = 250;

// The MVP badge and the room it takes from the nickname beside it.
const MVP_ROOM = 72;

// A nickname's size: 25px while it fits, shrinking to 15px for a long one. Widths are DejaVu Sans
// Bold's by class of letter, tuned on real nicknames; the ellipsis catches what this misjudges.
function nickSize(nick: string, room: number): number {
  const em = [...nick].reduce((w, c) =>
    w + (/[WMШЩЖЮmwжшщю@]/.test(c) ? 1.05 : /[iljtfrI.,:;'!|]/.test(c) ? 0.38 : /[A-ZА-ЯІЇЄҐ0-9]/.test(c) ? 0.78 : 0.68), 0);
  return Math.max(15, Math.min(25, Math.floor(room / em)));
}

// Gold from 1.40, green from 1.10 (FACEIT's platform average), grey below — by the figure, not the rank.
function ratingColor(text: string): string {
  const rating = parseFloat(text);
  if (Number.isNaN(rating)) return "";
  return rating >= 1.4 ? COLOR.best : rating >= 1.1 ? COLOR.up : COLOR.muted;
}

// Up green, down red: "+6.80%" / "-4.50%" for a swing.
const signColor = (text: string): string => /^\+/.test(text) ? COLOR.up : /^[-−]/.test(text) ? COLOR.down : "";

// The banner: the score large across the map, green for a win and red for a loss, the team Elo
// pair small under it. Without a map it sits on a plain band of the same height.
function banner(result: MatchResult, withMap: boolean): string {
  const shadow = "text-shadow:0 3px 12px rgba(0,0,0,0.85)";
  const elo = result.elo ? `(${result.elo.ours} Elo vs ${result.elo.theirs} Elo)` : "";
  const overlay =
    `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;position:absolute;` +
    `top:0;left:0;width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px;background:rgba(10,12,15,${withMap ? 0.45 : 0})">` +
    `<div style="display:flex;font-size:92px;font-weight:700;letter-spacing:4px;color:${result.won ? COLOR.up : COLOR.down};${shadow}">` +
    `${escapeHtml(`${result.ourScore}:${result.theirScore}`)}</div>` +
    (elo ? `<div style="display:flex;font-size:22px;color:${COLOR.text};${shadow}">${escapeHtml(elo)}</div>` : "") +
    `</div>`;
  const ground = withMap
    ? `<img src="${MAP_SRC}" style="width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px;object-fit:cover"/>`
    : `<div style="display:flex;width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px;background:${COLOR.head}"></div>`;
  return `<div style="display:flex;position:relative;width:${CARD_WIDTH}px;height:${MAP_HEIGHT}px">${ground}${overlay}</div>`;
}

// The nickname in bold, with the MVP badge beside it, and under it the Elo and this match's change.
function playerCell(row: ResultRow, mvp: boolean): string {
  const room = mvp ? NICK_ROOM - MVP_ROOM : NICK_ROOM;
  const nick = `<div style="display:flex;font-size:${nickSize(row.nickname, room)}px;font-weight:700;max-width:${room}px;` +
    `overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escapeHtml(row.nickname)}</div>`;
  const badge = mvp
    ? `<div style="display:flex;padding:2px 8px;border-radius:6px;background:${COLOR.best};color:${COLOR.bg};` +
      `font-size:15px;font-weight:700;letter-spacing:1px">MVP</div>`
    : "";
  const change = row.eloChange;
  const arrow = change === null ? "" : change > 0 ? `↑${change}` : change < 0 ? `↓${-change}` : "±0";
  const eloLine = row.eloAfter === null ? "" :
    `<div style="display:flex;align-items:baseline;gap:12px">` +
    `<span style="font-size:22px;color:${COLOR.headText}">${row.eloAfter}</span>` +
    (arrow ? `<span style="font-size:20px;font-weight:700;color:${change! > 0 ? COLOR.up : change! < 0 ? COLOR.down : COLOR.muted}">${arrow}</span>` : "") +
    `</div>`;
  return `<div style="display:flex;flex-direction:column;align-items:flex-start;gap:4px">` +
    `<div style="display:flex;align-items:center;gap:10px">${nick}${badge}</div>${eloLine}</div>`;
}

// Where each column's top value is: only ADR marks one — rating has its own tiers.
function topAdr(rows: ResultRow[]): Set<number> {
  const values = rows.map(r => parseFloat(r.adr));
  if (rows.length < 2 || values.some(Number.isNaN)) return new Set();
  const max = Math.max(...values);
  if (values.every(v => v === max)) return new Set();
  return new Set(values.flatMap((v, i) => v === max ? [i] : []));
}

function table(result: MatchResult): string {
  const { rows } = result;
  const rated = rows.some(r => r.rating !== null);
  const cols = columns(rated);
  const ratings = rows.map(r => parseFloat(r.rating ?? ""));
  const top = Math.max(...ratings.filter(Number.isFinite));
  // A win's MVP is its highest rating, ties included; a loss has none.
  const mvp = new Set(result.won && rated ? ratings.flatMap((v, i) => v === top ? [i] : []) : []);
  const bestAdr = topAdr(rows);

  const cellStyle = (flex: number, first: boolean, extra: string) =>
    `display:flex;align-items:center;justify-content:${first ? "flex-start" : "center"};flex:${flex};` +
    `padding:${first ? "14px 18px" : "14px 4px"}${first ? "" : `;border-left:1px solid ${COLOR.line}`};${extra}`;

  const head = `<div style="display:flex;background:${COLOR.head}">` +
    `<div style="${cellStyle(PLAYER_FLEX, true, `font-size:17px;font-weight:700;letter-spacing:1px;color:${COLOR.headText}`)}">` +
    `<div style="display:flex">${escapeHtml(t("scorePlayer").toUpperCase())}</div></div>` +
    cols.map(c => `<div style="${cellStyle(c.flex, false, `font-size:17px;font-weight:700;letter-spacing:1px;color:${COLOR.headText}`)}">` +
      `<div style="display:flex">${escapeHtml(c.head.toUpperCase())}</div></div>`).join("") +
    `</div>`;

  const body = rows.map((row, i) => {
    const hot = ratings[i]! >= HOT_RATING;
    const cells = cols.map(c => {
      const text = c.value(row);
      const color = c.head === "Rating" ? ratingColor(text)
        : c.head === "Swing" ? signColor(text)
        : c.head === "ADR" && bestAdr.has(i) ? COLOR.best : "";
      return `<div style="${cellStyle(c.flex, false, `font-size:26px${color ? `;color:${color}` : ""}${hot ? ";font-weight:700" : ""}`)}">` +
        `<div style="display:flex">${escapeHtml(text)}</div></div>`;
    }).join("");
    return `<div style="display:flex;border-top:1px solid ${COLOR.line};background:${i % 2 ? COLOR.rowB : COLOR.rowA}">` +
      `<div style="${cellStyle(PLAYER_FLEX, true, hot ? "font-weight:700" : "")}">${playerCell(row, mvp.has(i))}</div>${cells}</div>`;
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
