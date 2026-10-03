'use strict';
// Key faces for the Stream Deck plugin: cockpit state in, SVG out. Pure, so
// the tests can check them without a Stream Deck.
//
//   claude, codex          the 5-hour and weekly bars, colored by pace like the panel
//   claude-allow,          the same bars; the key glows while the request next in
//   codex-allow            line is from that tool, and a press allows it once
//   request                the request that has waited longest; with none, the sessions
//   allow, always, deny    light up while a request waits
//
// Stream Deck draws SVG with Qt's SVG Tiny renderer, so the faces use plain
// shapes and text with presentation attributes: no CSS, filters or baselines.

const fs = require('fs');
const path = require('path');

// The plugin folder is linked into Stream Deck's Plugins folder; lib/ is
// found through the link.
const ROOT = path.join(fs.realpathSync(__dirname), '..', '..');
const U = require(path.join(ROOT, 'lib', 'usage'));

const ACTIONS = ['claude', 'codex', 'request', 'allow', 'always', 'deny', 'claude-allow', 'codex-allow'];
// The Stream Deck buttons share the panel's guard: a request that just
// appeared can't be answered by a press that was already on its way.
const ARM_MS = 700;

const C = {
  bg: '#000000',
  text: '#e6ebf1',
  detail: '#c5cdd6',
  dim: '#8a939e',
  faint: '#3d444d',
  track: '#262b33',
  ok: '#4c8571',
  warn: '#d8a634',
  hot: '#e5534b',
  claude: '#d97757',
  codex: '#e6ebf1',
  alert: '#ffae34',
  approve: '#2c9a5a',
  always: '#2f6fc9',
  deny: '#c4392f',
  working: '#5aa9ff',
  done: '#4fc27f',
};
const SANS = 'Segoe UI, Helvetica Neue, Arial, sans-serif';
const MONO = 'Cascadia Mono, Consolas, Menlo, monospace';
const PCT_COLOR = { ok: C.text, warn: C.warn, hot: C.hot, reset: C.faint, none: C.faint };

// ---- what the keys show ----

// state: the cockpit's /api/state, or null while the cockpit isn't running.
// armedAt(id): when that request's buttons may be pressed.
// starting: the plugin has started a cockpit server that isn't up yet.
function deckView(state, now, armedAt = () => 0, starting = false) {
  if (!state) return { connected: false, starting, request: null, count: 0, armed: false, usage: {}, sessions: {} };
  const approvals = Array.isArray(state.approvals) ? state.approvals : [];
  const request = approvals[0] ?? null; // the server lists them oldest first
  const sessions = {};
  for (const p of state.projects ?? []) for (const s of p.sessions ?? []) sessions[s.status] = (sessions[s.status] ?? 0) + 1;
  return {
    connected: true,
    request,
    count: approvals.length,
    armed: Boolean(request) && now >= armedAt(request.id),
    usage: state.usage ?? {},
    sessions,
  };
}

function face(action, view, now) {
  switch (action) {
    case 'claude':
    case 'codex':
      return usageFace(action, view, now);
    case 'claude-allow':
    case 'codex-allow': {
      const provider = action.slice(0, -'-allow'.length);
      return usageFace(provider, view, now, view.request?.agent === provider);
    }
    case 'request':
      return requestFace(view, now);
    case 'allow':
    case 'always':
    case 'deny':
      return decisionFace(action, view);
    default:
      return svg('');
  }
}

// What a press means, or why it does nothing.
function keyAction(action, view, now) {
  if (action === 'claude' || action === 'codex') return { ignore: true };
  const r = view.request;
  if (action === 'claude-allow' || action === 'codex-allow') {
    // One line, oldest first: only the tool whose request is next can answer.
    if (!r) return { ignore: true };
    if (r.agent !== action.slice(0, -'-allow'.length)) return { refuse: `next in line is ${r.agent}` };
    if (!view.armed) return { refuse: 'just appeared' };
    return { id: r.id, decision: 'allow' };
  }
  if (!r) return action === 'request' ? { ignore: true } : { refuse: 'nothing waiting' };
  if (!view.armed) return { refuse: 'just appeared' };
  if (action === 'always' && !r.always) return { refuse: 'only once for this one' };
  return { id: r.id, decision: action === 'request' ? 'terminal' : action };
}

// ---- usage ----

// glow: this tool's request is next in line, and a press on this key allows it.
function usageFace(provider, view, now, glow = false) {
  const name = provider === 'claude' ? 'CLAUDE' : 'CODEX';
  let body = text(72, 21, name, { size: 18, weight: 700, fill: C[provider], anchor: 'middle' });
  if (!view.connected) return svg(body + text(72, 84, view.starting ? 'starting…' : 'cockpit off', { size: 18, fill: C.dim, anchor: 'middle' }));
  const u = view.usage[provider];
  if (!u || (!u.fiveHour && !u.weekly)) body += text(72, 84, 'no data yet', { size: 18, fill: C.dim, anchor: 'middle' });
  else body += meter('5h', u.fiveHour, now, 26) + meter('wk', u.weekly, now, 82);
  // The request key's pulse, thin and still until the guard time has passed.
  if (glow) body += border(view.armed ? (Math.floor(now / 500) % 2 === 0 ? 7 : 3) : 2);
  return svg(body);
}

function border(width) {
  return `<rect x="4" y="4" width="136" height="136" rx="12" fill="none" stroke="${C.alert}" stroke-width="${width}"/>`;
}

// A key is 72 or 80 pixels wide. The label and the time to the reset stack on
// the left and the percent stands alone on the right: Stream Deck draws text
// wider than a browser does, and the three side by side ran into each other.
// The pace shows in the colors, as on the panel.
function meter(label, w, now, top) {
  const d = U.describeWindow(w, now);
  const level = d ? d.level : 'none';
  const live = Boolean(d) && level !== 'reset';
  const pct = d ? U.formatPercent(d.usedPercent) : '-';
  let s = text(9, top + 14, label, { size: 15, fill: C.dim });
  if (d) s += text(9, top + 31, level === 'reset' ? 'reset' : shortDuration(d.remainingSec), { size: 15, fill: C.detail });
  s += text(135, top + 31, pct, { size: pct.length > 3 ? 24 : 28, weight: 700, fill: PCT_COLOR[level], anchor: 'end' });
  const bar = { x: 9, y: top + 38, w: 126, h: 10 };
  s += `<rect x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${bar.h}" rx="3" fill="${C.track}"/>`;
  if (live && d.usedPercent > 0) {
    const fill = Math.max(4, (bar.w * Math.min(100, d.usedPercent)) / 100);
    s += `<rect x="${bar.x}" y="${bar.y}" width="${round(fill)}" height="${bar.h}" rx="3" fill="${C[level] || C.ok}"/>`;
  }
  if (live) {
    // How much of the window has passed: left of the tick is on pace.
    const x = round(bar.x + (bar.w * d.elapsedPct) / 100);
    s += `<line x1="${x}" y1="${bar.y - 4}" x2="${x}" y2="${bar.y + bar.h + 4}" stroke="${C.text}" stroke-width="3"/>`;
  }
  return s;
}

// ---- the waiting request ----

function requestFace(view, now) {
  if (!view.connected) {
    const status = view.starting ? 'starting…' : 'not running';
    return svg(text(72, 58, 'COCKPIT', { size: 18, weight: 700, fill: C.dim, anchor: 'middle' }) + text(72, 88, status, { size: 17, fill: C.dim, anchor: 'middle' }));
  }
  const r = view.request;
  if (!r) return sessionsFace(view);
  let s = border(Math.floor(now / 500) % 2 === 0 ? 7 : 3);
  s += text(14, 32, r.agent.toUpperCase(), { size: 16, weight: 700, fill: C[r.agent] || C.text });
  if (view.count > 1) s += text(130, 32, `1/${view.count}`, { size: 16, weight: 700, fill: C.alert, anchor: 'end' });
  s += text(14, 60, fit(r.title, 11), { size: 22, weight: 700 });
  wrap(firstLine(r.detail), 13, 2).forEach((line, i) => (s += text(14, 86 + i * 21, line, { size: 17, font: MONO, fill: C.detail })));
  s += text(14, 129, fit(footer(r, now), 16), { size: 15, fill: C.dim });
  return svg(s);
}

function footer(r, now) {
  const left = Math.max(0, Math.ceil((r.expiresAt - now) / 1000));
  const time = left < 120 ? `${left}s` : shortDuration(left);
  if (r.fallback === 'after') return `terminal in ${time}`;
  if (r.fallback === 'deny') return `denied in ${time}`;
  return r.project || '';
}

const SESSION_ROWS = [
  ['needs-you', 'need you', C.alert],
  ['working', 'working', C.working],
  ['your-turn', 'your turn', C.done],
  ['interrupted', 'stopped', C.dim],
];

function sessionsFace(view) {
  let s = text(72, 27, 'SESSIONS', { size: 16, weight: 700, fill: C.dim, anchor: 'middle' });
  const rows = SESSION_ROWS.filter(([status]) => view.sessions[status] > 0).slice(0, 3);
  if (!rows.length) return svg(s + text(72, 86, 'all quiet', { size: 18, fill: C.dim, anchor: 'middle' }));
  rows.forEach(([status, label, color], i) => {
    const y = 64 + i * 31;
    s += text(16, y, String(view.sessions[status]), { size: 24, weight: 700, fill: color });
    s += text(46, y, label, { size: 18 });
  });
  return svg(s);
}

// ---- Allow, Always, Deny ----

const DECISIONS = {
  allow: { label: 'ALLOW', color: C.approve, glyph: (c) => polyline('42,74 62,94 102,52', c) },
  // Two lines under it (what, and where it applies), so it sits higher.
  always: { label: 'ALWAYS', color: C.always, glyph: (c) => polyline('28,64 44,80 72,46', c, 9) + polyline('60,68 72,80 114,36', c, 9) },
  deny: { label: 'DENY', color: C.deny, glyph: (c) => polyline('48,50 96,98', c) + polyline('96,50 48,98', c) },
};

function decisionFace(kind, view) {
  const spec = DECISIONS[kind];
  const r = view.connected ? view.request : null;
  const live = Boolean(r) && (kind !== 'always' || Boolean(r.always));
  if (!live) {
    // Nothing to answer: the key stays dark, with its job written on it.
    const why = kind === 'always' && r ? text(72, 138, 'once only', { size: 13, fill: C.dim, anchor: 'middle' }) : '';
    return svg(spec.glyph(C.faint) + text(72, kind === 'always' ? 108 : 120, spec.label, { size: 20, weight: 700, fill: C.faint, anchor: 'middle' }) + why);
  }
  // Lit, but faded until the guard time has passed.
  let s = `<rect width="144" height="144" fill="${spec.color}"${view.armed ? '' : ' fill-opacity="0.4"'}/>` + spec.glyph('#ffffff');
  if (kind === 'always') {
    // "git init *" / "project": what gets remembered, and for how long.
    s += text(72, 108, spec.label, { size: 21, weight: 700, fill: '#ffffff', anchor: 'middle' });
    s += text(72, 125, fit(r.always.short || r.always.what, 17), { size: 14, fill: '#ffffff', anchor: 'middle' });
    s += text(72, 140, fit(String(r.always.where).replace(/\bthis /g, ''), 19), { size: 12, fill: '#d2e1f6', anchor: 'middle' });
    return svg(s);
  }
  s += text(72, 120, spec.label, { size: 21, weight: 700, fill: '#ffffff', anchor: 'middle' });
  if (kind === 'allow') s += text(72, 138, 'once', { size: 13, fill: '#ffffff', anchor: 'middle' });
  return svg(s);
}

// ---- SVG ----

function svg(body, bg = C.bg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${bg}"/>${body}</svg>`;
}

// setImage takes SVG as a URL-encoded data URL.
function dataUrl(image) {
  return `data:image/svg+xml,${encodeURIComponent(image)}`;
}

function text(x, y, value, { size = 18, weight = 400, fill = C.text, anchor = 'start', font = SANS } = {}) {
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
}

function polyline(points, color, width = 11) {
  return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function fit(s, max) {
  s = String(s ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function firstLine(s) {
  return (String(s ?? '').split('\n').find((l) => l.trim()) ?? '').trim();
}

// Hard wrap at max characters; the last line ends in … when there is more.
function wrap(s, max, lines) {
  const out = [];
  let rest = s;
  while (rest && out.length < lines) {
    out.push(rest.slice(0, max));
    rest = rest.slice(max);
  }
  if (rest && out.length) out[out.length - 1] = `${out[out.length - 1].slice(0, max - 1)}…`;
  return out;
}

function round(n) {
  return Math.round(n * 10) / 10;
}

// Four characters at most: <1m, 45m, 2h04, 13h, 3d4h.
function shortDuration(sec) {
  const min = Math.floor(Math.max(0, sec) / 60);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 10) return `${h}h${String(min % 60).padStart(2, '0')}`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

module.exports = { ACTIONS, ARM_MS, deckView, face, keyAction, dataUrl };
