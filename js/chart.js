// chart.js — renders the weekly-average trend chart and the full weekly history.
// Charting is done at the week level (not per day) since a single week's
// average is the more meaningful, less noisy signal for gain/loss.
//
// This is the script for chart.html (the "Trend" tab). It depends on the
// globals from db.js (loaded first, same as log.js) — specifically
// computeWeeklySummaries() and formatShort() — plus the Chart.js library
// (vendor/chart.umd.min.js), also loaded before this file.
//
// Page has two parts fed by the same `allSummaries` data:
//   1. A line chart of weekly average weight, filterable to the last
//      8 weeks / 26 weeks / all time via the range tabs.
//   2. A plain list of every week's average + delta below the chart.

let trendChart = null; // the current Chart.js instance, so it can be destroyed/rebuilt when the range tab changes
let allSummaries = []; // from computeWeeklySummaries(), most recent first
let smoothingEnabled = false;
let activeRange = '8';

// Reads a CSS custom property (e.g. '--pine') from the page's computed
// style so the chart's colors are pulled from the site's actual theme
// (defined in css/style.css) instead of being hardcoded here.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Formats a week-over-week delta for the chart's "Vs. prior wk" stat and
// the weekly history list: returns display text (e.g. "+0.6") and a
// theme color (rust = gained weight, moss = lost weight, ink-soft =
// unchanged, ink-faint = no prior week to compare to).
function formatDeltaText(delta) {
  if (delta === null || delta === undefined) return { text: '—', color: cssVar('--ink-faint') };
  const rounded = Math.round(Math.abs(delta) * 10) / 10;
  if (rounded === 0) return { text: '0.0', color: cssVar('--ink-soft') };
  const sign = delta > 0 ? '+' : '−';
  const color = delta > 0 ? cssVar('--rust') : cssVar('--moss');
  return { text: `${sign}${rounded.toFixed(1)}`, color };
}

// Trims a chronologically-ordered (oldest-first) list of summaries down
// to the selected range: the last `range` weeks, or everything if the
// range tab is "all".
function filterByRange(summariesAscending, range) {
  if (range === 'all') return summariesAscending;
  const n = Number(range);
  return summariesAscending.slice(-n);
}

function movingAverage(values, windowSize = 4) {
  return values.map((_, idx) => {
    const start = Math.max(0, idx - (windowSize - 1));
    const window = values.slice(start, idx + 1);
    const avg = window.reduce((sum, v) => sum + v, 0) / window.length;
    return Math.round(avg * 10) / 10;
  });
}

// (Re)draws the trend line chart for the given range ('8', '26', or
// 'all' — matches the data-range values on the #range-tabs buttons)
// and updates the three summary stats above it (latest week, change
// vs. prior week, average of the shown range).
function renderChart(range) {
  // allSummaries is most-recent-first; chart wants chronological order.
  const ascending = [...allSummaries].reverse();
  const shown = filterByRange(ascending, range);
  const ctx = document.getElementById('trend-canvas').getContext('2d');

  const labels = shown.map(s => `Wk ${formatShort(s.start)}`);
  const data = shown.map(s => Math.round(s.avg * 10) / 10);
  const smoothData = movingAverage(data, 4);

  const pine = cssVar('--pine');
  const ink = cssVar('--ink-soft');
  const line = cssVar('--line');

  // Destroy any previous chart instance before creating a new one —
  // Chart.js doesn't let you redraw in place on the same canvas without
  // this, and it's re-called every time the range tab changes.
  if (trendChart) trendChart.destroy();

  const datasets = [{
    label: 'Weekly average',
    data,
    borderColor: pine,
    backgroundColor: 'rgba(51, 96, 76, 0.10)',
    borderWidth: 2,
    pointRadius: shown.length > 30 ? 2 : 4,
    pointBackgroundColor: pine,
    pointHoverRadius: 6,
    fill: true,
    tension: 0.25
  }];

  if (smoothingEnabled && shown.length > 2) {
    datasets.push({
      label: '4-week smoothing',
      data: smoothData,
      borderColor: cssVar('--moss'),
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0.35,
      borderDash: [6, 4]
    });
  }

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: smoothingEnabled && shown.length > 2 },
        tooltip: {
          backgroundColor: cssVar('--pine-deep'),
          padding: 10,
          titleFont: { family: 'IBM Plex Mono' },
          bodyFont: { family: 'IBM Plex Mono' },
          callbacks: {
            label: (item) => {
              const seriesName = item.dataset.label || 'Weekly average';
              return `${seriesName}: ${item.parsed.y.toFixed(1)} lb`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: ink, font: { family: 'Inter', size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
          grid: { display: false },
          border: { color: line }
        },
        y: {
          ticks: { color: ink, font: { family: 'IBM Plex Mono', size: 11 } },
          grid: { color: line },
          border: { display: false }
        }
      }
    }
  });

  // Stats row above/below the chart: latest week's average, its change
  // vs. the prior week, and the average across whatever range is shown.
  const latestEl = document.getElementById('stat-latest');
  const changeEl = document.getElementById('stat-change');
  const avgEl = document.getElementById('stat-avg');

  if (shown.length === 0) {
    latestEl.textContent = '—';
    changeEl.textContent = '—';
    changeEl.style.color = '';
    avgEl.textContent = '—';
    return;
  }

  const latestWeek = shown[shown.length - 1]; // shown is chronological, so last = most recent in range
  const avgOfShown = shown.reduce((sum, s) => sum + s.avg, 0) / shown.length;
  const { text, color } = formatDeltaText(latestWeek.delta);

  latestEl.textContent = `${latestWeek.avg.toFixed(1)} lb`;
  changeEl.textContent = latestWeek.delta === null ? '—' : `${text} lb`;
  changeEl.style.color = color;
  avgEl.textContent = `${avgOfShown.toFixed(1)} lb`;
}

// Renders the "Weekly log" list below the chart: every week ever
// recorded (not filtered by the range tabs), most recent first, each
// with its date range, average, and delta vs. the prior week.
function renderWeeklyList() {
  const list = document.getElementById('weekly-list');
  list.innerHTML = '';

  allSummaries.forEach(s => {
    const li = document.createElement('li');
    li.className = 'weekly-row';

    const range = document.createElement('span');
    range.className = 'weekly-row__range';
    range.textContent = `${formatShort(s.start)} – ${formatShort(s.end)}`;

    const avg = document.createElement('span');
    avg.className = 'weekly-row__avg';
    avg.textContent = `${s.avg.toFixed(1)} lb avg`;

    const delta = document.createElement('span');
    delta.className = 'weekly-row__delta';
    const { text, color } = formatDeltaText(s.delta);
    delta.textContent = s.delta === null ? '—' : `${text} lb`;
    delta.style.color = color;

    li.append(range, avg, delta);
    list.appendChild(li);
  });
}

// Page entry point: loads all weekly summaries, shows the empty state
// if nothing has been logged yet, otherwise renders the chart (default
// 8-week range) and weekly list, then wires up the range-tab buttons.
async function init() {
  allSummaries = await computeWeeklySummaries();

  if (allSummaries.length === 0) {
    document.getElementById('chart-section').hidden = true;
    document.getElementById('empty-state').hidden = false;
    return;
  }

  renderChart('8');
  activeRange = '8';
  renderWeeklyList();

  // Each range tab (8 wks / 26 wks / All) re-renders the chart with a
  // different window and toggles aria-pressed for accessibility/styling
  // of the active tab. The weekly list below isn't affected by this —
  // it always shows full history.
  document.querySelectorAll('#range-tabs button').forEach(btn => {
    if (!btn.dataset.range) return;
    btn.addEventListener('click', () => {
      document.querySelectorAll('#range-tabs button[data-range]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      activeRange = btn.dataset.range;
      renderChart(activeRange);
    });
  });

  const smoothBtn = document.getElementById('smooth-toggle');
  smoothBtn.addEventListener('click', () => {
    smoothingEnabled = !smoothingEnabled;
    smoothBtn.setAttribute('aria-pressed', smoothingEnabled ? 'true' : 'false');
    renderChart(activeRange);
  });
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
