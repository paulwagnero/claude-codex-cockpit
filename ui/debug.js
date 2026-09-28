'use strict';
// Raw live view of /api/events, for debugging. Recomputes pace every second so
// countdowns move between server pushes.

const U = window.CockpitUsage;
const $ = (id) => document.getElementById(id);
let last = null;

function row(label, w, now) {
  const d = U.describeWindow(w, now);
  if (!d) return `${label}  no data yet`;
  if (d.level === 'reset') return `${label}  reset, waiting for the next response`;
  const pct = U.formatPercent(d.usedPercent).padStart(4);
  return `${label}  ${pct}  ${d.level.padEnd(4)}  ${String(Math.round(d.elapsedPct)).padStart(3)}% of window gone  resets in ${U.formatDuration(d.remainingSec)}`;
}

function block(name, u, now) {
  const age = u.updatedAt ? `  (numbers from ${U.formatDuration((now - u.updatedAt) / 1000)} ago)` : '';
  const plan = u.planType ? `  plan ${u.planType}` : '';
  return [`${name}${plan}${age}`, row('  5h  ', u.fiveHour, now), row('  week', u.weekly, now)].join('\n');
}

function render() {
  if (!last) return;
  const now = Date.now();
  const { claude, codex } = last.usage;
  $('summary').textContent = `${block('claude', claude, now)}\n\n${block('codex', codex, now)}`;
  $('raw').textContent = JSON.stringify(last, null, 2);
}

const events = new EventSource('/api/events');
events.addEventListener('state', (e) => {
  last = JSON.parse(e.data);
  render();
});
events.onopen = () => ($('status').textContent = 'live');
events.onerror = () => ($('status').textContent = 'reconnecting');
setInterval(render, 1000);
