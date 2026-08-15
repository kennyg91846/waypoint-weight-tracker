// log.js — renders the day list for the current year and handles saving.
//
// This is the script for index.html (the "Log" tab). It depends on the
// globals defined in db.js (loaded first): the `db` object, the date
// helpers (toISODate, weekStart, etc.), and computeWeeklySummaries().
//
// Page structure being built here:
//   - A "Today" card at the top with a single quick-entry input.
//   - A single long scrollable list (#day-list) covering a fixed
//     365-day range (see LOG_START_DATE in db.js), with a week-divider
//     row inserted before the first day of each new week showing that
//     week's running average and change vs. the prior week.
// Every day row (including today's) has its own input; editing the
// dedicated "Today" input and editing today's row in the list are kept
// in sync with each other (see the two-way sync in buildDayRow/init).

// Pending debounce timers for scheduleSave, keyed by date ISO string,
// so rapid keystrokes on the same day don't each trigger a separate
// database write.
let saveTimers = new Map();
// In-memory copy of all saved entries (Map<dateISO, weight>), loaded
// once in init() and kept up to date as edits are saved. Rendering
// reads from this instead of hitting IndexedDB per row.
let entriesCache = new Map();
const GOAL_STORAGE_KEY = 'waypointGoalWeight';
const YEAR_STORAGE_KEY = 'waypointSelectedLogYear';
const OUTLIER_LB_THRESHOLD = 8;
let currentGoalWeight = null;
let activeLogYear = new Date().getFullYear();

// Briefly shows a status message (e.g. "Saved") in the toast element
// at the bottom of the screen, auto-hiding after ~1.4s. Re-uses a
// single timer stashed on the function itself so repeated calls reset
// the hide delay instead of stacking up.
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('is-visible'), 1400);
}

function readGoalWeight() {
  const raw = localStorage.getItem(GOAL_STORAGE_KEY);
  if (raw === null || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function writeGoalWeight(value) {
  if (value === null || value === undefined || value === '') {
    localStorage.removeItem(GOAL_STORAGE_KEY);
    currentGoalWeight = null;
    return;
  }
  currentGoalWeight = value;
  localStorage.setItem(GOAL_STORAGE_KEY, String(value));
}

function formatSignedLb(value) {
  const abs = Math.abs(value).toFixed(1);
  if (value > 0) return `+${abs} lb`;
  if (value < 0) return `-${abs} lb`;
  return '0.0 lb';
}

function getEntriesChronological() {
  return Array.from(entriesCache.entries())
    .filter(([, weight]) => typeof weight === 'number' && Number.isFinite(weight))
    .sort(([a], [b]) => a.localeCompare(b));
}

function findPreviousLoggedWeight(dateISO) {
  let previous = null;
  getEntriesChronological().forEach(([iso, weight]) => {
    if (iso < dateISO) previous = weight;
  });
  return previous;
}

function shouldConfirmOutlier(dateISO, value) {
  const prev = findPreviousLoggedWeight(dateISO);
  if (prev === null) return false;
  return Math.abs(value - prev) >= OUTLIER_LB_THRESHOLD;
}

function updateGoalSnapshot() {
  const startEl = document.getElementById('goal-stat-start');
  const latestEl = document.getElementById('goal-stat-latest');
  const changeEl = document.getElementById('goal-stat-change');
  const toGoalEl = document.getElementById('goal-stat-to-goal');
  const hintEl = document.getElementById('goal-hint');
  const sorted = getEntriesChronological();

  if (sorted.length === 0) {
    startEl.textContent = '—';
    latestEl.textContent = '—';
    changeEl.textContent = '—';
    toGoalEl.textContent = '—';
    hintEl.textContent = 'Log your first weight to see progress stats.';
    return;
  }

  const startWeight = sorted[0][1];
  const latestWeight = sorted[sorted.length - 1][1];
  const change = latestWeight - startWeight;

  startEl.textContent = `${startWeight.toFixed(1)} lb`;
  latestEl.textContent = `${latestWeight.toFixed(1)} lb`;
  changeEl.textContent = formatSignedLb(change);

  if (currentGoalWeight === null) {
    toGoalEl.textContent = 'Set goal';
    hintEl.textContent = 'Leave blank to track without a goal.';
    return;
  }

  const remaining = latestWeight - currentGoalWeight;
  if (Math.abs(remaining) < 0.05) {
    toGoalEl.textContent = 'Reached';
    hintEl.textContent = 'Goal reached. Nice work.';
    return;
  }
  if (remaining > 0) {
    toGoalEl.textContent = `${remaining.toFixed(1)} lb above`;
    hintEl.textContent = 'You are above your goal weight.';
  } else {
    toGoalEl.textContent = `${Math.abs(remaining).toFixed(1)} lb to go`;
    hintEl.textContent = 'You are below your goal trajectory distance.';
  }
}

async function exportEntries() {
  const rows = await db.entries.orderBy('date').toArray();
  const payload = {
    exportedAt: new Date().toISOString(),
    entries: rows.map(r => ({ date: r.date, weight: r.weight, updatedAt: r.updatedAt || Date.now() }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = toISODate(new Date()).replaceAll('-', '');
  a.href = url;
  a.download = `waypoint-weight-export-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importEntries(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(entries)) throw new Error('Invalid file format');

  const clean = entries
    .map((e) => ({ date: e.date, weight: Number(e.weight), updatedAt: e.updatedAt || Date.now() }))
    .filter(e => typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isFinite(e.weight));

  if (clean.length === 0) throw new Error('No valid entries found');
  await db.entries.bulkPut(clean);
  return clean.length;
}

function wireOptionalControls() {
  const goalInput = document.getElementById('goal-input');
  currentGoalWeight = readGoalWeight();
  if (currentGoalWeight !== null) goalInput.value = currentGoalWeight;

  const persistGoal = () => {
    const raw = goalInput.value.trim();
    if (raw === '') {
      writeGoalWeight(null);
      updateGoalSnapshot();
      showToast('Goal cleared');
      return;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      showToast('Goal not saved');
      return;
    }
    writeGoalWeight(num);
    updateGoalSnapshot();
    showToast('Goal saved');
  };

  goalInput.addEventListener('change', persistGoal);

  const exportBtn = document.getElementById('export-data-btn');
  const importBtn = document.getElementById('import-data-btn');
  const importFile = document.getElementById('import-data-file');

  exportBtn.addEventListener('click', async () => {
    await exportEntries();
    showToast('Export complete');
  });

  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    try {
      const count = await importEntries(file);
      showToast(`Imported ${count} entries`);
      setTimeout(() => window.location.reload(), 500);
    } catch {
      showToast('Import failed');
    }
    importFile.value = '';
  });
}

function wireCollapsiblePanels() {
  const bindPanel = (toggleId, panelId) => {
    const toggle = document.getElementById(toggleId);
    const panel = document.getElementById(panelId);
    if (!toggle || !panel) return;

    const setExpanded = (expanded) => {
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.textContent = expanded ? 'Hide' : 'Show';
      panel.hidden = !expanded;
    };

    setExpanded(false);
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      setExpanded(!expanded);
    });
  };

  bindPanel('progress-toggle', 'progress-panel');
  bindPanel('backup-toggle', 'backup-panel');
}

// Formats a week-over-week delta (in lb) for display next to a week
// divider, returning both the text and a CSS class used to color it
// (up = gained, down = lost, flat = no change, none = no prior week).
function formatDelta(delta) {
  if (delta === null || delta === undefined) return { text: '—', cls: 'delta-none' };
  const rounded = Math.round(Math.abs(delta) * 10) / 10;
  if (rounded === 0) return { text: '0.0 lb', cls: 'delta-flat' };
  const sign = delta > 0 ? '▲' : '▼';
  const cls = delta > 0 ? 'delta-up' : 'delta-down';
  return { text: `${sign} ${rounded.toFixed(1)} lb`, cls };
}

// Formats the read-only "total" badge shown in the middle of each day
// row: just the weight that was entered for that date, to 1 decimal
// place, or an em dash if nothing has been logged yet.
function formatDayTotal(value) {
  if (value === '' || value === null || value === undefined) return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return '—';
  return `${num.toFixed(1)} lb`;
}

// Updates one day row's read-only total badge to reflect `value`
// (whatever is currently in that row's input, saved or not).
function updateDayTotalBadge(iso, value) {
  const badge = document.getElementById(`total-${iso}`);
  if (!badge) return;
  badge.textContent = formatDayTotal(value);
  badge.classList.toggle('is-empty', value === '' || value === null || value === undefined);
}

// Debounced save: waits 500ms after the last keystroke for a given date
// before writing to IndexedDB, so typing "185.5" doesn't trigger five
// separate saves. After the write completes it updates the local cache,
// shows a toast, and refreshes the week averages/deltas and the "Today"
// hint so the UI reflects the new value immediately.
async function scheduleSave(dateISO, value, options = {}) {
  const { confirmOutlier = false, delayMs = 500 } = options;
  clearTimeout(saveTimers.get(dateISO));
  const t = setTimeout(async () => {
    if (confirmOutlier && value !== '' && value !== null && value !== undefined) {
      const num = Number(value);
      if (Number.isFinite(num) && shouldConfirmOutlier(dateISO, num)) {
        const prev = findPreviousLoggedWeight(dateISO);
        const diff = Math.abs(num - prev).toFixed(1);
        const ok = window.confirm(
          `This entry is ${diff} lb away from your previous logged day (${prev.toFixed(1)} lb). Save anyway?`
        );
        if (!ok) {
          showToast('Entry not saved');
          return;
        }
      }
    }

    await setEntry(dateISO, value);
    if (value === '' || value === null) {
      entriesCache.delete(dateISO);
    } else {
      entriesCache.set(dateISO, Number(value));
    }
    showToast(value === '' ? 'Entry cleared' : 'Saved');
    updateTodayHint();
    refreshWeekDeltas();
    updateGoalSnapshot();
  }, delayMs);
  saveTimers.set(dateISO, t);
}

// Builds one <li> row for a single day in the log: a weekday/date label,
// a read-only "total" badge showing the weight entered for that date,
// and the editable weight input. Days after today are shown but
// disabled (you can't log a future weight). Pre-fills the input (and
// the badge) if an entry already exists in entriesCache. Typing in this
// row schedules a save, updates the badge immediately (no need to wait
// for the debounced save to land), and — if this row happens to be
// today — mirrors the value into the "Today" quick-entry input at the
// top of the page.
function buildDayRow(date, todayISOStr, isWeekStart = false) {
  const iso = toISODate(date);
  const isFuture = iso > todayISOStr;
  const li = document.createElement('li');
  li.className = 'day-row'
    + (isFuture ? ' is-future' : '')
    + (isWeekStart ? ' is-week-start' : '');
  li.id = `day-${iso}`;

  const dateWrap = document.createElement('div');
  dateWrap.className = 'day-row__date';
  const weekday = document.createElement('span');
  weekday.className = 'day-row__weekday';
  weekday.textContent = formatWeekdayFull(date);
  const day = document.createElement('span');
  day.className = 'day-row__day';
  day.textContent = formatShort(date);
  dateWrap.append(weekday, day);

  const existing = entriesCache.get(iso);

  // Read-only badge, sits between the date and the input, always
  // mirroring whatever is currently in the input for this day.
  const total = document.createElement('span');
  total.className = 'day-row__total' + (existing === undefined ? ' is-empty' : '');
  total.id = `total-${iso}`;
  total.textContent = formatDayTotal(existing);

  const input = document.createElement('input');
  input.type = 'number';
  input.inputMode = 'decimal';
  input.step = '0.1';
  input.placeholder = isFuture ? '—' : '0.0';
  input.setAttribute('aria-label', `Weight on ${formatShort(date)}`);
  if (isFuture) input.disabled = true;
  if (existing !== undefined) input.value = existing;

  input.addEventListener('input', () => {
    // Save while typing without interruption; outlier confirm runs on blur.
    scheduleSave(iso, input.value, { confirmOutlier: false });
    updateDayTotalBadge(iso, input.value);
    // Keep the "Today" quick-entry input in sync if this row is today's.
    if (iso === todayISOStr) {
      document.getElementById('today-input').value = input.value;
    }
  });

  input.addEventListener('blur', () => {
    scheduleSave(iso, input.value, { confirmOutlier: true, delayMs: 0 });
  });

  li.append(dateWrap, total, input);
  return li;
}

// Builds the divider row inserted before the first day of each week.
// It starts with just a "Week of ..." label; the average/delta spans
// are left empty here and filled in afterward by refreshWeekDeltas()
// (looked up via the data-week-key attribute set on each span, which
// matches the `key` field computeWeeklySummaries() returns for that
// week's Sunday).
function buildWeekDivider(startDate) {
  const wrapper = document.createElement('li');
  wrapper.style.listStyle = 'none';
  const div = document.createElement('div');
  div.className = 'week-divider';
  const label = document.createElement('span');
  label.className = 'week-divider__label';
  const end = addDays(startDate, 6);
  label.textContent = `Week of ${formatShort(startDate)}`;
  div.appendChild(label);

  const avgEl = document.createElement('span');
  avgEl.className = 'week-divider__avg';
  avgEl.dataset.weekKey = toISODate(startDate);
  div.appendChild(avgEl);

  const deltaEl = document.createElement('span');
  deltaEl.className = 'week-divider__delta';
  deltaEl.dataset.weekKey = toISODate(startDate);
  div.appendChild(deltaEl);

  wrapper.appendChild(div);
  return wrapper;
}

// Scrolls to the divider for today's Sun-Sat week so the user lands on
// the current week when opening the log, while still being able to
// scroll backward/forward through the full 365-day list.
function scrollToCurrentWeek(todayDate) {
  const todayWeekKey = toISODate(weekStart(todayDate));
  const weekAnchor = document.querySelector(`.week-divider__avg[data-week-key="${todayWeekKey}"]`);
  if (!weekAnchor) return false;
  const divider = weekAnchor.closest('.week-divider');
  if (!divider) return false;

  const todayCard = document.querySelector('.today-card');
  const stickyOffset = todayCard
    ? todayCard.getBoundingClientRect().height + 24
    : 16;
  const targetY = window.scrollY + divider.getBoundingClientRect().top - stickyOffset;
  window.scrollTo({ top: Math.max(0, targetY), behavior: 'auto' });
  return true;
}

function getYearBoundsFromEntries() {
  const currentYear = new Date().getFullYear();
  let minYear = currentYear;
  let maxYear = currentYear;

  entriesCache.forEach((_, iso) => {
    const year = Number(String(iso).slice(0, 4));
    if (!Number.isInteger(year)) return;
    if (year < minYear) minYear = year;
    if (year > maxYear) maxYear = year;
  });

  return { minYear, maxYear };
}

function getSelectableYears() {
  const { minYear, maxYear } = getYearBoundsFromEntries();
  const years = [];
  for (let year = maxYear; year >= minYear; year -= 1) {
    years.push(year);
  }
  return years;
}

function renderYearLabel(year) {
  const start = new Date(year, 0, 1);
  const end = addDays(start, daysInYear(year) - 1);
  document.getElementById('year-label').textContent =
    `${formatShort(start)}, ${start.getFullYear()} – ${formatShort(end)}, ${end.getFullYear()}`;
}

async function renderLogYear(year, today, todayISOStr) {
  const list = document.getElementById('day-list');
  list.innerHTML = '';
  renderYearLabel(year);

  const start = new Date(year, 0, 1);
  const days = daysFrom(start, daysInYear(year));
  const frag = document.createDocumentFragment();
  let lastWeekKey = null;

  days.forEach(date => {
    const wStart = weekStart(date);
    const wKey = toISODate(wStart);
    const isWeekStart = wKey !== lastWeekKey;
    if (isWeekStart) {
      frag.appendChild(buildWeekDivider(wStart));
      lastWeekKey = wKey;
    }
    frag.appendChild(buildDayRow(date, todayISOStr, isWeekStart));
  });

  list.appendChild(frag);
  await refreshWeekDeltas();

  const alignListView = () => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    if (year !== today.getFullYear()) {
      const logCard = document.querySelector('.log-days-card');
      if (logCard) logCard.scrollIntoView({ block: 'start', behavior: 'auto' });
      return;
    }

    // Primary target is the week divider; fallback is today's row.
    const didScroll = scrollToCurrentWeek(today);
    if (!didScroll) {
      const todayRow = document.getElementById(`day-${todayISOStr}`);
      if (todayRow) {
        const todayCard = document.querySelector('.today-card');
        const stickyOffset = todayCard
          ? todayCard.getBoundingClientRect().height + 24
          : 16;
        const targetY = window.scrollY + todayRow.getBoundingClientRect().top - stickyOffset;
        window.scrollTo({ top: Math.max(0, targetY), behavior: 'auto' });
      }
    }
  };

  // Run after layout settles; some mobile/PWA launches override earlier scroll.
  requestAnimationFrame(() => {
    requestAnimationFrame(alignListView);
  });
  setTimeout(alignListView, 120);
}

async function wireYearSelector(today, todayISOStr) {
  const yearSelect = document.getElementById('year-select');
  const years = getSelectableYears();
  yearSelect.innerHTML = '';

  years.forEach((year) => {
    const option = document.createElement('option');
    option.value = String(year);
    option.textContent = String(year);
    yearSelect.appendChild(option);
  });

  const savedYear = Number(localStorage.getItem(YEAR_STORAGE_KEY));
  const defaultYear = years.includes(savedYear) ? savedYear : today.getFullYear();
  activeLogYear = defaultYear;
  yearSelect.value = String(activeLogYear);

  yearSelect.addEventListener('change', async () => {
    const selected = Number(yearSelect.value);
    if (!Number.isInteger(selected)) return;
    activeLogYear = selected;
    localStorage.setItem(YEAR_STORAGE_KEY, String(activeLogYear));
    await renderLogYear(activeLogYear, today, todayISOStr);
  });

  await renderLogYear(activeLogYear, today, todayISOStr);
}

// Re-fetches weekly summaries and updates every week-divider's average
// and delta text/color in place, matched up by the data-week-key
// attribute set in buildWeekDivider. Called on load and after every
// save so the dividers always reflect the latest data without having
// to rebuild the whole day list.
async function refreshWeekDeltas() {
  const summaries = await computeWeeklySummaries();
  const byKey = new Map(summaries.map(s => [s.key, s]));
  document.querySelectorAll('.week-divider__avg').forEach(el => {
    const s = byKey.get(el.dataset.weekKey);
    el.textContent = s ? `${s.avg.toFixed(1)} lb avg` : '';
  });
  document.querySelectorAll('.week-divider__delta').forEach(el => {
    const s = byKey.get(el.dataset.weekKey);
    if (!s) {
      el.textContent = '';
      el.className = 'week-divider__delta';
      return;
    }
    const { text, cls } = formatDelta(s.delta);
    el.textContent = s.delta === null ? '' : text;
    el.className = 'week-divider__delta ' + cls;
  });
}

// Updates the small hint line under the "Today" input (e.g. "This
// week's avg is up 0.4 lb vs. last week", or an entry count if there's
// no prior week yet to compare against).
async function updateTodayHint() {
  const summaries = await computeWeeklySummaries();
  const hint = document.getElementById('today-hint');
  if (summaries.length === 0) {
    hint.textContent = '';
    return;
  }
  const current = summaries[0]; // most recent week (summaries is most-recent-first)
  if (current.delta === null) {
    hint.textContent = `${current.count} ${current.count === 1 ? 'entry' : 'entries'} logged this week`;
  } else {
    const { text } = formatDelta(current.delta);
    // Swap the ▲/▼ glyphs for plain words in this particular hint line.
    hint.textContent = `This week's avg is ${text.replace('▲', 'up').replace('▼', 'down')} vs. last week`;
  }
}

// Page entry point: loads saved data, renders the "Today" card and the
// full day list, wires up interactivity, then scrolls today's row into
// view so the user doesn't have to hunt for it in the 365-day list.
async function init() {
  const today = new Date();
  const todayISOStr = toISODate(today);
  entriesCache = await getAllEntriesMap();

  document.getElementById('today-date-display').textContent =
    `${formatWeekdayFull(today)}, ${formatShort(today)}, ${today.getFullYear()}`;

  // "Today" quick-entry input: pre-filled if already logged, and kept
  // in sync with today's row further down in the list when edited.
  const todayInput = document.getElementById('today-input');
  const existingToday = entriesCache.get(todayISOStr);
  if (existingToday !== undefined) todayInput.value = existingToday;
  todayInput.addEventListener('input', () => {
    // Save while typing without interruption; outlier confirm runs on blur.
    scheduleSave(todayISOStr, todayInput.value, { confirmOutlier: false });
    const rowInput = document.querySelector(`#day-${todayISOStr} input`);
    if (rowInput) rowInput.value = todayInput.value;
    updateDayTotalBadge(todayISOStr, todayInput.value);
  });

  todayInput.addEventListener('blur', () => {
    scheduleSave(todayISOStr, todayInput.value, { confirmOutlier: true, delayMs: 0 });
  });

  await wireYearSelector(today, todayISOStr);

  // Fill in the week-divider averages/deltas and the "Today" hint now
  // that the rows exist in the DOM.
  await updateTodayHint();
  wireCollapsiblePanels();
  wireOptionalControls();
  updateGoalSnapshot();
}

init();

// Registers the service worker (see service-worker.js) so the app's
// assets are cached for offline use. Silently ignores registration
// failure (e.g. unsupported browser) rather than blocking the page.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
