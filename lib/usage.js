// Usage-window math shared by the server, the statusline script and the UI.
// Plain script: CommonJS in Node, window.CockpitUsage in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CockpitUsage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CLAUDE_WINDOWS = { five_hour: 5 * 3600, seven_day: 7 * 24 * 3600 };

  // Pace compares used% with elapsed% of the window: 60% used with 80% of the
  // week gone is fine, 40% used with 14% gone is not. Early in a window elapsed%
  // is tiny and the ratio explodes on the first request, so it is floored.
  const PACE = { floorPct: 10, warnAbove: 1.0, hotAbove: 1.3 };

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // Number(null) is 0, which would turn a missing field into "0% used".
  const toNumber = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

  // The "out in X" projection for short windows follows your recent burn, not
  // the whole-window average: a burst shows up right away, and going idle
  // brings the rate down, because it is measured up to now.
  const RECENT = { lookbackSec: 30 * 60, minSpanSec: 5 * 60, maxWindowSec: 24 * 3600 };

  // points: [[atMs, usedPercent], ...] oldest first, all in one window.
  // Returns %/second over the last 30 minutes (or since the first point), or
  // null while there is too little history to say.
  function recentRate(points, nowMs) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const startMs = nowMs - RECENT.lookbackSec * 1000;
    let base = null;
    for (const p of points) {
      if (p[0] <= startMs) base = [startMs, p[1]]; // usage as it stood when the lookback starts
      else if (!base) base = p; // history begins inside the lookback
    }
    const last = points[points.length - 1];
    const span = (nowMs - base[0]) / 1000;
    if (span < RECENT.minSpanSec) return null;
    return Math.max(0, last[1] - base[1]) / span;
  }

  // w: { usedPercent, resetsAt (unix seconds), windowSeconds, recent?, ...extra }
  // Returns w plus elapsedPct, remainingSec, ratio, level, exhaustsInSec and
  // paceBasis, or null when there is nothing to describe.
  function describeWindow(w, nowMs = Date.now()) {
    if (!w || !Number.isFinite(w.usedPercent) || !Number.isFinite(w.resetsAt)) return null;
    const remainingSec = w.resetsAt - nowMs / 1000;
    if (remainingSec <= 0) {
      // Over. The next window starts empty and gets numbers on the next API response.
      return { ...w, usedPercent: 0, elapsedPct: 0, remainingSec: 0, ratio: 0, level: 'reset', exhaustsInSec: null };
    }
    const windowSec = w.windowSeconds > 0 ? w.windowSeconds : remainingSec;
    const elapsedSec = clamp(windowSec - remainingSec, 0, windowSec);
    const elapsedPct = (100 * elapsedSec) / windowSec;
    const used = clamp(w.usedPercent, 0, 100);
    const ratio = used / Math.max(elapsedPct, PACE.floorPct);
    const level = used >= 100 || ratio > PACE.hotAbove ? 'hot' : ratio > PACE.warnAbove ? 'warn' : 'ok';
    // When the rest runs out, if before the reset: at the recent rate for short
    // windows once there is enough history, else at the average rate so far.
    const rate = windowSec <= RECENT.maxWindowSec ? recentRate(w.recent, nowMs) : null;
    const paceBasis = rate === null ? 'average' : 'recent';
    let exhaustsInSec = null;
    if (used < 100) {
      const perSec = rate !== null ? rate : elapsedSec > 0 ? used / elapsedSec : 0;
      const t = perSec > 0 ? (100 - used) / perSec : Infinity;
      if (t < remainingSec) exhaustsInSec = t;
    }
    return { ...w, usedPercent: used, elapsedPct, remainingSec, ratio, level, exhaustsInSec, paceBasis };
  }

  // 45 -> "<1m", 2700 -> "45m", 7440 -> "2h 04m", 273600 -> "3d 4h".
  // compact drops the spaces for the terminal statusline.
  function formatDuration(sec, compact = false) {
    const totalMin = Math.floor(Math.max(0, sec) / 60);
    if (totalMin < 1) return '<1m';
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    const sep = compact ? '' : ' ';
    if (d > 0) return `${d}d${sep}${h}h`;
    if (h > 0) return `${h}h${sep}${String(m).padStart(2, '0')}m`;
    return `${m}m`;
  }

  // Floors so 99.6% never reads as a limit that has not been hit yet.
  function formatPercent(p) {
    if (!Number.isFinite(p)) return '-';
    return `${p >= 100 ? 100 : Math.floor(Math.max(0, p))}%`;
  }

  return { CLAUDE_WINDOWS, PACE, RECENT, toNumber, recentRate, describeWindow, formatDuration, formatPercent };
});
