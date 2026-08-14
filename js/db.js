// db.js — storage layer + date/week math shared by both pages.
//
// Loaded on both index.html (the daily log) and chart.html (the trend view)
// before their page-specific script (log.js / chart.js), so everything
// defined here — the `db` object and every function below — is available
// as a global to those scripts. There is no build step or module system;
// this is plain browser JS loaded via <script> tags in order.
//
// Data model: one row per day that has a logged weight, keyed by an
// ISO date string ('YYYY-MM-DD'). There is no "week" table — weekly
// summaries are computed on the fly from the daily rows every time
// they're needed (see computeWeeklySummaries below).

// Dexie is a thin wrapper around the browser's IndexedDB. This creates/opens
// a local database named 'waypointWeightTracker' with one object store,
// 'entries', whose primary key is the `date` field on each record.
const db = new Dexie('waypointWeightTracker');
db.version(1).stores({
  entries: 'date' // date is an ISO string 'YYYY-MM-DD', primary key
});

// Display labels indexed by Date's getDay() (0=Sun..6=Sat) and
// getMonth() (0=Jan..11=Dec), used by the formatting helpers below.
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Date <-> string helpers.
// A plain JS Date is used for calendar math (adding days, finding the
// start of a week, etc.), but everything stored in IndexedDB and used
// as a lookup key is the 'YYYY-MM-DD' string form, since Dates aren't
// safe/stable to use directly as object keys or database keys.

// Converts a Date to its local-timezone 'YYYY-MM-DD' string.
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Converts a 'YYYY-MM-DD' string back to a local-timezone Date
// (midnight on that day).
function fromISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Today's date as an ISO string. Used to tell "logged" days apart from
// "future" days that shouldn't be editable yet.
function todayISO() {
  return toISODate(new Date());
}

// Sunday of the week containing this date (weeks run Sun–Sat throughout
// the app — see computeWeeklySummaries).
function weekStart(d) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - copy.getDay());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

// Saturday of the week containing this date (i.e. weekStart + 6 days).
function weekEnd(d) {
  const start = weekStart(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return end;
}

// Returns a new Date that is `n` days after `d` (n can be negative).
// Used throughout for simple calendar arithmetic without mutating the
// Date that was passed in.
function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

// Short display form, e.g. "Aug 10". Used for row dates, week-divider
// labels, and chart axis labels.
function formatShort(d) {
  return `${MONTH_LABELS[d.getMonth()]} ${d.getDate()}`;
}

// Full weekday name, e.g. "Mon". Used for the "Today" header and each
// day row in the log.
function formatWeekdayFull(d) {
  return WEEKDAY_LABELS[d.getDay()];
}

// The log intentionally starts on a fixed date (Aug 10, 2026) rather than
// Jan 1 or the date the app happens to be opened, so the 365-day log
// generated in log.js always begins on the same day regardless of when
// someone installs/opens the app. Update this if the tracked year should
// change.
const LOG_START_DATE = new Date(2026, 7, 10); // August 10, 2026 (month is 0-indexed, so 7 = August)

// Builds an array of `count` consecutive Date objects starting at `start`
// (inclusive). This is what generates the full scrollable day list on the
// log page — see log.js's use of daysFrom(LOG_START_DATE, 365).
function daysFrom(start, count) {
  const days = [];
  const cursor = new Date(start);
  for (let i = 0; i < count; i++) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

// Loads every saved entry from IndexedDB and returns them as a
// Map<dateISO, weight> for fast in-memory lookups while rendering the
// log (avoids awaiting the database on every single row).
async function getAllEntriesMap() {
  const rows = await db.entries.toArray();
  const map = new Map();
  rows.forEach(r => map.set(r.date, r.weight));
  return map;
}

// Saves (or clears) the weight for one date.
// - An empty/null/undefined value deletes any existing entry for that
//   date, so clearing an input removes the day from the log entirely
//   rather than storing a zero or blank.
// - Non-numeric input is silently ignored (no-op) rather than saving
//   garbage — the input is type="number" so this mainly guards against
//   edge cases like a lone "-" or "." while typing.
async function setEntry(dateISO, weight) {
  if (weight === null || weight === undefined || weight === '') {
    await db.entries.delete(dateISO);
    return;
  }
  const num = Number(weight);
  if (Number.isNaN(num)) return;
  await db.entries.put({ date: dateISO, weight: num, updatedAt: Date.now() });
}

// Groups all saved entries into Sun–Sat weeks and computes each week's
// average weight, plus the change (`delta`) versus the previous week
// that has data. This is the core aggregation both pages rely on:
// log.js uses it for the week-divider averages/deltas, and chart.js
// uses it to draw the trend line and the weekly history list.
//
// Weeks are keyed by the ISO date of their Sunday so entries naturally
// group even if some days in a week have no logged weight.
async function computeWeeklySummaries() {
  const rows = await db.entries.orderBy('date').toArray();
  if (rows.length === 0) return [];

  const weeks = new Map(); // key: ISO date of week's Sunday -> {sum, count, start, end}
  rows.forEach(({ date, weight }) => {
    const d = fromISODate(date);
    const start = weekStart(d);
    const key = toISODate(start);
    if (!weeks.has(key)) {
      weeks.set(key, { start, end: weekEnd(d), sum: 0, count: 0 });
    }
    const w = weeks.get(key);
    w.sum += weight;
    w.count += 1;
  });

  // Sort chronologically first so `prevAvg` below always refers to the
  // week immediately before the current one in time.
  const sortedKeys = Array.from(weeks.keys()).sort();
  const summaries = [];
  let prevAvg = null;
  sortedKeys.forEach(key => {
    const w = weeks.get(key);
    const avg = w.sum / w.count;
    // First week with data has no prior week to compare to, so its
    // delta is null (rendered as "—" by both pages).
    const delta = prevAvg === null ? null : avg - prevAvg;
    summaries.push({
      key,
      start: w.start,
      end: w.end,
      count: w.count,
      avg,
      delta
    });
    prevAvg = avg;
  });

  // Callers (log.js, chart.js) generally want most-recent-first, so the
  // chronological list built above is reversed before returning.
  return summaries.reverse(); // most recent week first
}
