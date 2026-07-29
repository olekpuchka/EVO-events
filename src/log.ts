// Stamps every console line — container stdout has no timestamps of its own.
const LOG_TZ = "CET"; // the 🇪🇺 half of every event time; the host runs UTC

// sv-SE gives "2026-07-29 19:04:12".
const FORMAT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: LOG_TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

for (const level of ["log", "warn", "error"] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => write(`[${FORMAT.format(new Date())}]`, ...args);
}
