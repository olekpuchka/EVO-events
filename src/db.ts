import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { User } from "@grammyjs/types";
import type {
  MemberRow,
  RsvpRow,
  EventRow,
  ActiveEventRow,
  FaceitMemberRow,
  DueUnpinRow,
  DueReminderRow,
  AiHistoryRow,
} from "./types.ts";

type ChatId = number | string;

// node:sqlite returns untyped rows; these isolate the one unavoidable cast to a
// single audited boundary, so callers just name the row type they expect.
const allRows = <T>(stmt: StatementSync, ...params: SQLInputValue[]): T[] =>
  stmt.all(...params) as unknown as T[];
const oneRow = <T>(stmt: StatementSync, ...params: SQLInputValue[]): T | undefined =>
  stmt.get(...params) as unknown as T | undefined;

const DATA_DIR = process.env.DATA_DIR ?? "./data";
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, "members.db"));

db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    chat_id   TEXT    NOT NULL,
    user_id   INTEGER NOT NULL,
    username  TEXT,
    first_name TEXT   NOT NULL,
    last_name TEXT,
    notifications_enabled INTEGER NOT NULL DEFAULT 1,
    faceit_player_id  TEXT,
    faceit_elo        INTEGER,
    PRIMARY KEY (chat_id, user_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    chat_id    TEXT    NOT NULL,
    message_id INTEGER NOT NULL,
    base_text  TEXT    NOT NULL,
    event_time INTEGER,
    PRIMARY KEY (chat_id, message_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS rsvps (
    chat_id    TEXT    NOT NULL,
    message_id INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    first_name TEXT    NOT NULL,
    last_name  TEXT,
    username   TEXT,
    status     TEXT    NOT NULL,
    PRIMARY KEY (chat_id, message_id, user_id)
  )
`);

const stmtUpsert = db.prepare(`
  INSERT INTO members (chat_id, user_id, username, first_name, last_name)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (chat_id, user_id) DO UPDATE SET
    username   = excluded.username,
    first_name = excluded.first_name,
    last_name  = excluded.last_name
`);

const stmtGetMembers = db.prepare(`
  SELECT user_id AS id, username, first_name, last_name
  FROM members
  WHERE chat_id = ? AND notifications_enabled = 1
`);

const stmtSetNotifications = db.prepare(`
  UPDATE members SET notifications_enabled = ? WHERE chat_id = ? AND user_id = ?
`);

const stmtGetNotifications = db.prepare(`
  SELECT notifications_enabled FROM members WHERE chat_id = ? AND user_id = ?
`);

const stmtSaveEvent = db.prepare(`
  INSERT OR REPLACE INTO events (chat_id, message_id, base_text, event_time) VALUES (?, ?, ?, ?)
`);

const stmtGetEventBaseText = db.prepare(`
  SELECT base_text, event_time FROM events WHERE chat_id = ? AND message_id = ?
`);

const stmtUpsertRsvp = db.prepare(`
  INSERT INTO rsvps (chat_id, message_id, user_id, first_name, last_name, username, status)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (chat_id, message_id, user_id) DO UPDATE SET
    first_name = excluded.first_name,
    last_name  = excluded.last_name,
    username   = excluded.username,
    status     = excluded.status
`);

const stmtGetRsvps = db.prepare(`
  SELECT user_id AS id, first_name, last_name, username, status
  FROM rsvps
  WHERE chat_id = ? AND message_id = ?
  ORDER BY rowid
`);

const stmtGetUserRsvp = db.prepare(`
  SELECT status FROM rsvps WHERE chat_id = ? AND message_id = ? AND user_id = ?
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_unpins (
    chat_id             TEXT    NOT NULL,
    message_id          INTEGER NOT NULL,
    unpin_at            INTEGER NOT NULL,
    reminder_message_id INTEGER,
    PRIMARY KEY (chat_id, message_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_reminders (
    chat_id      TEXT    NOT NULL,
    message_id   INTEGER NOT NULL,
    remind_at    INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_members_chat   ON members(chat_id, notifications_enabled)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_rsvps_event     ON rsvps(chat_id, message_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_unpins_due      ON scheduled_unpins(unpin_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_due   ON scheduled_reminders(remind_at)`);

const stmtGetActiveEvent = db.prepare(`
  SELECT message_id FROM events WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1
`);

const stmtInsertUnpin = db.prepare(`
  INSERT OR REPLACE INTO scheduled_unpins (chat_id, message_id, unpin_at) VALUES (?, ?, ?)
`);

const stmtGetDueUnpins = db.prepare(`
  SELECT chat_id, message_id, reminder_message_id FROM scheduled_unpins WHERE unpin_at <= ?
`);

const stmtUpdateUnpinReminderId = db.prepare(`
  UPDATE scheduled_unpins SET reminder_message_id = ? WHERE chat_id = ? AND message_id = ?
`);

const stmtGetReminderMessageId = db.prepare(`
  SELECT reminder_message_id FROM scheduled_unpins WHERE chat_id = ? AND message_id = ?
`);

const stmtDeleteUnpin = db.prepare(`
  DELETE FROM scheduled_unpins WHERE chat_id = ? AND message_id = ?
`);

const stmtInsertReminder = db.prepare(`
  INSERT OR REPLACE INTO scheduled_reminders (chat_id, message_id, remind_at) VALUES (?, ?, ?)
`);

const stmtGetDueReminders = db.prepare(`
  SELECT chat_id, message_id FROM scheduled_reminders WHERE remind_at <= ?
`);

const stmtDeleteReminder = db.prepare(`
  DELETE FROM scheduled_reminders WHERE chat_id = ? AND message_id = ?
`);

const stmtDeleteEvent = db.prepare(`DELETE FROM events WHERE chat_id = ? AND message_id = ?`);
const stmtDeleteRsvps = db.prepare(`DELETE FROM rsvps WHERE chat_id = ? AND message_id = ?`);

export function trackMember(chatId: ChatId, user: User | undefined): void {
  if (!user || user.is_bot) return;
  stmtUpsert.run(String(chatId), user.id, user.username ?? null, user.first_name, user.last_name ?? null);
}

export function getMembers(chatId: ChatId): MemberRow[] {
  return allRows<MemberRow>(stmtGetMembers, String(chatId));
}

export function setNotifications(chatId: ChatId, userId: number, enabled: boolean): void {
  stmtSetNotifications.run(enabled ? 1 : 0, String(chatId), userId);
}

export function getNotificationsStatus(chatId: ChatId, userId: number): boolean | null {
  const row = oneRow<{ notifications_enabled: number }>(stmtGetNotifications, String(chatId), userId);
  return row ? Boolean(row.notifications_enabled) : null;
}

export function saveEvent(chatId: ChatId, messageId: number, baseText: string, eventTime: number | null = null): void {
  stmtSaveEvent.run(String(chatId), messageId, baseText, eventTime);
}

export function getEventBaseText(chatId: ChatId, messageId: number): EventRow | null {
  return oneRow<EventRow>(stmtGetEventBaseText, String(chatId), messageId) ?? null;
}

export function saveRsvp(chatId: ChatId, messageId: number, user: User, status: string): void {
  stmtUpsertRsvp.run(String(chatId), messageId, user.id, user.first_name, user.last_name ?? null, user.username ?? null, status);
}

export function getRsvps(chatId: ChatId, messageId: number): RsvpRow[] {
  return allRows<RsvpRow>(stmtGetRsvps, String(chatId), messageId);
}

export function getUserRsvpStatus(chatId: ChatId, messageId: number, userId: number): string | null {
  return oneRow<{ status: string }>(stmtGetUserRsvp, String(chatId), messageId, userId)?.status ?? null;
}

export function scheduleUnpin(chatId: ChatId, messageId: number, unpinAt: number): void {
  stmtInsertUnpin.run(String(chatId), messageId, unpinAt);
}

export function getDueUnpins(nowTs: number): DueUnpinRow[] {
  return allRows<DueUnpinRow>(stmtGetDueUnpins, nowTs);
}

export function getReminderMessageId(chatId: ChatId, messageId: number): number | null {
  return oneRow<{ reminder_message_id: number | null }>(stmtGetReminderMessageId, String(chatId), messageId)?.reminder_message_id ?? null;
}


export function saveReminderMessageId(chatId: ChatId, messageId: number, reminderMessageId: number): void {
  stmtUpdateUnpinReminderId.run(reminderMessageId, String(chatId), messageId);
}

export function scheduleReminder(chatId: ChatId, messageId: number, remindAt: number): void {
  stmtInsertReminder.run(String(chatId), messageId, remindAt);
}

export function getDueReminders(nowTs: number): DueReminderRow[] {
  return allRows<DueReminderRow>(stmtGetDueReminders, nowTs);
}

export function deleteScheduledReminder(chatId: ChatId, messageId: number): void {
  stmtDeleteReminder.run(String(chatId), messageId);
}

export function getActiveEvent(chatId: ChatId): ActiveEventRow | null {
  return oneRow<ActiveEventRow>(stmtGetActiveEvent, String(chatId)) ?? null;
}

const stmtSetFaceit = db.prepare(`UPDATE members SET faceit_player_id = ?, faceit_elo = ? WHERE chat_id = ? AND user_id = ?`);
const stmtGetFaceitMembers = db.prepare(`
  SELECT user_id, faceit_player_id, faceit_elo
  FROM members WHERE chat_id = ? AND faceit_player_id IS NOT NULL
`);

export function setFaceitAccount(chatId: ChatId, userId: number, playerId: string, elo: number | null): void {
  stmtSetFaceit.run(playerId, elo, String(chatId), userId);
}

export function getFaceitMembers(chatId: ChatId): FaceitMemberRow[] {
  return allRows<FaceitMemberRow>(stmtGetFaceitMembers, String(chatId));
}

db.exec(`
  CREATE TABLE IF NOT EXISTS posted_matches (
    chat_id   TEXT NOT NULL,
    match_id  TEXT NOT NULL,
    posted_at TEXT,
    PRIMARY KEY (chat_id, match_id)
  )
`);

const stmtHasPostedMatch = db.prepare(`SELECT 1 FROM posted_matches WHERE chat_id = ? AND match_id = ?`);
const stmtMarkMatchPosted = db.prepare(`INSERT OR IGNORE INTO posted_matches (chat_id, match_id, posted_at) VALUES (?, ?, datetime('now'))`);
const stmtPrunePostedMatches = db.prepare(`DELETE FROM posted_matches WHERE posted_at < datetime('now', '-30 days')`);

export function hasPostedMatch(chatId: ChatId, matchId: string): boolean {
  return !!stmtHasPostedMatch.get(String(chatId), matchId);
}

export function markMatchPosted(chatId: ChatId, matchId: string): void {
  stmtMarkMatchPosted.run(String(chatId), matchId);
}

export function pruneOldPostedMatches(): void {
  stmtPrunePostedMatches.run();
}

/* ── AI phrase history ──────────────────────────────────────────────────────
 * The generator rolls a premise and a register in code and needs to know what
 * it used recently, or it repeats a joke the chat has just seen. This lived in
 * module-level arrays, which reset on every container restart — and the bot
 * restarts on every deploy, so in practice the memory was usually empty. Kept
 * here instead, it survives restarts. Deliberately not keyed by chat: the
 * squad is one chat, and a joke reused across chats is not the problem. */

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL,
    premise_id  TEXT    NOT NULL,
    register_id TEXT    NOT NULL,
    phrase      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_history_kind ON ai_history(kind, id DESC)`);

// Rows kept per kind. Only the newest handful is ever read; the rest is kept
// as a small cushion so pruning does not run against the read window.
const AI_HISTORY_KEEP = 40;

const stmtGetAiHistory = db.prepare(`
  SELECT premise_id, register_id, phrase
  FROM ai_history WHERE kind = ? ORDER BY id DESC LIMIT ?
`);
const stmtInsertAiHistory = db.prepare(`
  INSERT INTO ai_history (kind, premise_id, register_id, phrase, created_at)
  VALUES (?, ?, ?, ?, unixepoch())
`);
const stmtPruneAiHistory = db.prepare(`
  DELETE FROM ai_history
  WHERE kind = ?
    AND id NOT IN (SELECT id FROM ai_history WHERE kind = ? ORDER BY id DESC LIMIT ?)
`);

/** Most recent first. `limit` bounds the read; callers slice narrower windows. */
export function getAiHistory(kind: string, limit: number): AiHistoryRow[] {
  return allRows<AiHistoryRow>(stmtGetAiHistory, kind, limit);
}

export function recordAiPhrase(kind: string, premiseId: string, registerId: string, phrase: string): void {
  stmtInsertAiHistory.run(kind, premiseId, registerId, phrase);
  stmtPruneAiHistory.run(kind, kind, AI_HISTORY_KEEP);
}

const stmtGetFaceitChats = db.prepare(`SELECT DISTINCT chat_id FROM members WHERE faceit_player_id IS NOT NULL`);

export function getAllFaceitChats(): string[] {
  return allRows<{ chat_id: string }>(stmtGetFaceitChats).map(r => r.chat_id);
}

export function deleteEventData(chatId: ChatId, messageId: number): void {
  const cid = String(chatId);
  db.exec('BEGIN');
  try {
    stmtDeleteEvent.run(cid, messageId);
    stmtDeleteRsvps.run(cid, messageId);
    stmtDeleteReminder.run(cid, messageId);
    stmtDeleteUnpin.run(cid, messageId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
