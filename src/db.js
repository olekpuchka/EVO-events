import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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

export function trackMember(chatId, user) {
  if (!user || user.is_bot) return;
  stmtUpsert.run(String(chatId), user.id, user.username ?? null, user.first_name, user.last_name ?? null);
}

export function getMembers(chatId) {
  return stmtGetMembers.all(String(chatId));
}

export function setNotifications(chatId, userId, enabled) {
  stmtSetNotifications.run(enabled ? 1 : 0, String(chatId), userId);
}

export function getNotificationsStatus(chatId, userId) {
  const row = stmtGetNotifications.get(String(chatId), userId);
  return row ? Boolean(row.notifications_enabled) : null;
}

export function saveEvent(chatId, messageId, baseText, eventTime = null) {
  stmtSaveEvent.run(String(chatId), messageId, baseText, eventTime);
}

export function getEventBaseText(chatId, messageId) {
  return stmtGetEventBaseText.get(String(chatId), messageId) ?? null;
}

export function saveRsvp(chatId, messageId, user, status) {
  stmtUpsertRsvp.run(String(chatId), messageId, user.id, user.first_name, user.last_name ?? null, user.username ?? null, status);
}

export function getRsvps(chatId, messageId) {
  return stmtGetRsvps.all(String(chatId), messageId);
}

export function getUserRsvpStatus(chatId, messageId, userId) {
  return stmtGetUserRsvp.get(String(chatId), messageId, userId)?.status ?? null;
}

export function scheduleUnpin(chatId, messageId, unpinAt) {
  stmtInsertUnpin.run(String(chatId), messageId, unpinAt);
}

export function getDueUnpins(nowTs) {
  return stmtGetDueUnpins.all(nowTs);
}

export function getReminderMessageId(chatId, messageId) {
  return stmtGetReminderMessageId.get(String(chatId), messageId)?.reminder_message_id ?? null;
}


export function saveReminderMessageId(chatId, messageId, reminderMessageId) {
  stmtUpdateUnpinReminderId.run(reminderMessageId, String(chatId), messageId);
}

export function scheduleReminder(chatId, messageId, remindAt) {
  stmtInsertReminder.run(String(chatId), messageId, remindAt);
}

export function getDueReminders(nowTs) {
  return stmtGetDueReminders.all(nowTs);
}

export function deleteScheduledReminder(chatId, messageId) {
  stmtDeleteReminder.run(String(chatId), messageId);
}

export function getActiveEvent(chatId) {
  return stmtGetActiveEvent.get(String(chatId)) ?? null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id TEXT PRIMARY KEY,
    last_result_match_id TEXT
  )
`);

const stmtSetFaceit = db.prepare(`UPDATE members SET faceit_player_id = ?, faceit_elo = ? WHERE chat_id = ? AND user_id = ?`);
const stmtGetFaceitMembers = db.prepare(`
  SELECT user_id, faceit_player_id, faceit_elo
  FROM members WHERE chat_id = ? AND faceit_player_id IS NOT NULL
`);

export function setFaceitAccount(chatId, userId, playerId, elo) {
  stmtSetFaceit.run(playerId, elo, String(chatId), userId);
}

export function getFaceitMembers(chatId) {
  return stmtGetFaceitMembers.all(String(chatId));
}

db.exec(`
  CREATE TABLE IF NOT EXISTS posted_matches (
    chat_id  TEXT NOT NULL,
    match_id TEXT NOT NULL,
    PRIMARY KEY (chat_id, match_id)
  )
`);

// Migrate existing last_result_match_id into posted_matches
db.exec(`
  INSERT OR IGNORE INTO posted_matches (chat_id, match_id)
  SELECT chat_id, last_result_match_id FROM chat_settings
  WHERE last_result_match_id IS NOT NULL
`);

const stmtHasPostedMatch = db.prepare(`SELECT 1 FROM posted_matches WHERE chat_id = ? AND match_id = ?`);
const stmtMarkMatchPosted = db.prepare(`INSERT OR IGNORE INTO posted_matches (chat_id, match_id) VALUES (?, ?)`);

export function hasPostedMatch(chatId, matchId) {
  return !!stmtHasPostedMatch.get(String(chatId), matchId);
}

export function markMatchPosted(chatId, matchId) {
  stmtMarkMatchPosted.run(String(chatId), matchId);
}

const stmtGetFaceitChats = db.prepare(`SELECT DISTINCT chat_id FROM members WHERE faceit_player_id IS NOT NULL`);

export function getAllFaceitChats() {
  return stmtGetFaceitChats.all().map(r => r.chat_id);
}

export function deleteEventData(chatId, messageId) {
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
