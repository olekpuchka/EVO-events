// Birthday dates: parsing what a member types, turning a stored date back into their format,
// and answering "what day is it in the group's zone". Pure — no Telegram, no database, no
// network. The clock is the only thing it reads.
//
// Two formats, deliberately: members type and read `dd-mm-yyyy`, the database stores ISO
// `YYYY-MM-DD`. ISO sorts, and its last five characters are the `MM-DD` the daily sweep
// matches on — `substr(birth_date, 6)` in db.ts is that slice.

import { DEFAULT_TZ } from "./eventtime.ts";

// The only bound on the year. No minimum age: this is one private group of adults, and a floor
// there refused nothing real — it only ever caught a slipped year, and only one landing inside
// the last few. A mistyped current year is accepted and reads as "turning 0"; that is the cost.
const EARLIEST_YEAR = 1900;

// Unpadded day and month allowed — `5-3-1990` is what people type. Stored padded either way.
const TYPED = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;

// The stored form of a typed date, or null. `today` is passed in, not read, to keep this pure.
export function parseBirthday(input: string, today: string): string | null {
  const m = TYPED.exec(input.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  // Round-trip is the real-calendar check: 31-02 normalises to 03-03 and stops matching. UTC,
  // so the host's zone can't shift the day.
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  if (Number(yyyy) < EARLIEST_YEAR || iso > today) return null;
  return iso;
}

// Back to the format the member typed, for every message that shows it to them.
export const formatBirthday = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
};

// Whether a stored birthday falls on `today`, stand-in included — what the sweep asks in SQL.
export const isDueOn = (iso: string, today: string): boolean =>
  dueMonthDays(today).includes(monthDay(iso));

// The `MM-DD` a birthday is matched on. db.ts does the same slice as `substr(birth_date, 6)`.
const monthDay = (iso: string): string => iso.slice(5);

// Whole years completed. Internal — callers want `ageToday`.
function ageOn(iso: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(iso.slice(0, 4));
  return monthDay(today) < monthDay(iso) ? years - 1 : years;
}

// The age being *turned*. Internal — the day having arrived is the whole answer, so no MM-DD
// comparison, which is what read a 29 February member greeted on the 28th a year young.
const ageTurning = (iso: string, year: number): number => year - Number(iso.slice(0, 4));

// The only age function anything outside this module calls. Three call sites answering it
// separately had `/birthday` confirm one age, report a second and greet with a third.
export const ageToday = (iso: string, today: string): number =>
  isDueOn(iso, today) ? ageTurning(iso, Number(today.slice(0, 4))) : ageOn(iso, today);

// Built once — constructing a formatter is the expensive part, and todayInGroupTz runs on every
// scheduler tick. Same pattern as log.ts. `en-CA` is already the stored shape; `hourCycle: "h23"`
// rather than `hour12: false`, which renders midnight as "24" in some ICU builds.
const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const HOUR_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: DEFAULT_TZ,
  hour: "2-digit",
  hourCycle: "h23",
});

// The one clock read in this module.
export function todayInGroupTz(now: Date = new Date()): { iso: string; hour: number } {
  return { iso: DAY_FORMAT.format(now), hour: Number(HOUR_FORMAT.format(now)) };
}

// Which stored `MM-DD` values count as "today". A 29 February birthday exists three years in
// four, so it is greeted on the 28th instead — without this those members are skipped silently.
export function dueMonthDays(today: string): [string, string] {
  const mine = monthDay(today);
  const year = Number(today.slice(0, 4));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  // Always two, so db.ts needs one statement: a day with no stand-in passes its value twice.
  return mine === "02-28" && !leap ? ["02-28", "02-29"] : [mine, mine];
}
