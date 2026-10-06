// Match results: turning a finished FACEIT match into the scoreboard the group sees. Split from
// handlers.ts because it changes for entirely different reasons — FACEIT's API shape rather than
// Telegram UX — and shares no state with the event lifecycle.

import { getFaceitMembers, hasPostedMatch, markMatchPosted } from "../adapters/db.ts";
import { getRecentMatches, getMatchStats, getMatchDetails, getAvatar, matchRoomUrl } from "../adapters/faceit.ts";
import { buildMatchResult } from "./match-result.ts";
import { renderCard, bundledMap } from "../adapters/card.ts";
import { cardCaption, eloArrow, eloPairText, formatKast, formatRating, formatSwing } from "../view/card.ts";
import { t } from "../view/i18n.ts";
import { InputFile, type Api } from "grammy";
import type { RichText, RichBlockTableCell } from "@grammyjs/types";
import type { ResultRow, MatchResult } from "../types.ts";

// The exact block-array type sendRichMessage accepts, so buildResultBlocks stays in sync with grammy.
type RichBlocks = NonNullable<NonNullable<Parameters<Api["sendRichMessage"]>[1]>["blocks"]>;

// Non-breaking spaces keep "1234 Elo ↑25" on one line, so the narrow player cell never wraps past two.
const eloLine = (after: number, change: number | null): string =>
  `${after}\u00a0Elo${change !== null ? `\u00a0${eloArrow(change)}` : ""}`;

// Rich rendering of a match result: header, scoreboard table, FACEIT footer.
function buildResultBlocks(result: MatchResult): RichBlocks {
  const { won, ourScore, theirScore, elo, matchId, rows } = result;
  const H = (text: RichText, align: RichBlockTableCell["align"] = "center"): RichBlockTableCell => ({ text, is_header: true, align, valign: "middle" });
  const C = (text: RichText, align: RichBlockTableCell["align"] = "center"): RichBlockTableCell => ({ text, align, valign: "middle" });
  // Two values per cell under a two-line header: three columns is what a phone fits unwrapped.
  // A failed scoreboard fetch drops the Rating column rather than filling it with "?".
  const rated = rows.some(p => p.rating !== null);
  // KAST shares ADR's line rather than spending a fourth column.
  const kasted = rows.some(p => p.kast !== null);
  const kast = (p: ResultRow): string => kasted ? ` · ${p.kast !== null ? formatKast(p.kast) : "?"}` : "";
  const cells: RichBlockTableCell[][] = [
    [H(t("scorePlayer")), ...(rated ? [H("Rating\nSwing")] : []), H(`K/D/A\nADR${kasted ? " · KAST" : ""}`)],
    ...rows.map(p => [
      C([{ type: "bold", text: p.nickname }, ...(p.eloAfter !== null ? [`\n${eloLine(p.eloAfter, p.eloChange)}`] : [])], "left"),
      ...(rated ? [C(`${p.rating !== null ? formatRating(p.rating) : "?"}\n${p.swing !== null ? formatSwing(p.swing) : "?"}`)] : []),
      C(`${p.kda}\n${p.adr}${kast(p)}`),
    ]),
  ];

  // The map is never named here: the card shows it, and the rich fallback goes without.
  const header: RichText[] = [`${won ? "🍌" : "❌"} `, { type: "bold", text: `${ourScore}:${theirScore}` }];
  if (elo) header.push(" ", eloPairText(elo));

  const blocks: RichBlocks = [];
  blocks.push({ type: "paragraph", text: header });
  // Compact: smaller cell padding, for the same phone width.
  blocks.push({ type: "table", is_striped: true, is_bordered: true, is_compact: true, cells });
  blocks.push({ type: "footer", text: [`🔗 ${t("viewOnFaceit")} `, { type: "url", text: "FACEIT", url: matchRoomUrl(matchId) }] });
  return blocks;
}

// The card as a photo; the rich table when rendering fails, so a post is never lost to it.
async function sendResult(api: Api, chatId: number | string, result: MatchResult): Promise<void> {
  const [map, avatars] = await Promise.all([bundledMap(result.mapId), Promise.all(result.rows.map(r => getAvatar(r.avatar)))]);
  const png = await renderCard(result, map, avatars);
  if (!png) {
    await api.sendRichMessage(chatId, { blocks: buildResultBlocks(result) });
    return;
  }
  await api.sendPhoto(chatId, new InputFile(png, "result.png"), { caption: cardCaption(matchRoomUrl(result.matchId)), parse_mode: "HTML" });
}

export async function autoPostResult(api: Api, chatId: number | string): Promise<void> {
  const members = getFaceitMembers(chatId);
  if (!members.length) return;

  const now = Math.floor(Date.now() / 1000);

  // Fetch last 5 matches per member in parallel
  const results = await Promise.allSettled(
    members.map(m => getRecentMatches(m.faceit_player_id, 5))
  );

  // Candidates: finished, within 24h, not already posted — by match id, with when it finished.
  const candidates = new Map<string, number>();
  let historyFailed = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      historyFailed++;
      continue;
    }
    for (const match of result.value ?? []) {
      if (match.status !== "finished") continue;
      if (now - match.finished_at > 24 * 60 * 60) continue;
      if (hasPostedMatch(chatId, match.match_id)) continue;
      candidates.set(match.match_id, match.finished_at);
    }
  }

  if (historyFailed) console.error(`[faceit] poll: ${historyFailed}/${members.length} history calls failed`);
  if (!candidates.size) return;

  const registeredIds = new Set(members.map(m => m.faceit_player_id));

  // Oldest first, so several matches from one session post in the order they were played.
  const sortedMatches = [...candidates.entries()].sort((a, b) => a[1] - b[1]);

  for (const [matchId, finishedAt] of sortedMatches) {
    let result: MatchResult | null;
    try {
      const stats = await getMatchStats(matchId);
      if (!stats) {
        // The details tell a voided match, or one missing stats >30 min, from one still processing.
        const details = await getMatchDetails(matchId);
        if (!details || details.status !== "FINISHED" || now - finishedAt > 30 * 60) markMatchPosted(chatId, matchId);
        continue;
      }
      result = await buildMatchResult(stats, registeredIds, matchId);
    } catch (err) {
      console.error("[faceit] poll fetch failed:", (err as Error).message);
      continue;
    }
    // Too few of us, or no details: never posted, so marked done.
    if (!result) {
      markMatchPosted(chatId, matchId);
      continue;
    }

    // Not marked posted on failure, so the next poll retries.
    try {
      await sendResult(api, chatId, result);
    } catch (err) {
      console.error("[faceit] poll send failed:", (err as Error).message);
      continue;
    }
    markMatchPosted(chatId, matchId);
    console.log("[faceit] auto-posted result");
  }
}
