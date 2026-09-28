'use strict';
// Panel renderer. State arrives over SSE; pace, countdowns and ages are
// recomputed every second. DOM nodes are keyed and reused, so an approval's
// arming delay, a hover and the scroll position survive updates.

const U = window.CockpitUsage;
const bridge = window.cockpit; // only inside the Electron window
const TOKEN = document.querySelector('meta[name="cockpit-token"]').content;
const LABELS = { fiveHour: '5h', weekly: 'week' };
const STALE_MS = 5 * 60 * 1000;
// Buttons that just appeared under the pointer can't be hit by accident.
const ARM_MS = 700;

const STATUS = {
  approval: { glyph: '!', label: 'needs approval' },
  'needs-you': { glyph: '?', label: 'needs you' },
  working: { glyph: '●', label: 'working' },
  interrupted: { glyph: '■', label: 'interrupted' },
  'your-turn': { glyph: '✓', label: 'your turn' },
  quiet: { glyph: '○', label: 'quiet' },
};
const RECENT_MARK = { you: '›', agent: '‹', tool: '$', note: '·' };

let state = null;
let attention = false;
const approvalViews = new Map(); // approval id -> { el, armedAt }
const projectViews = new Map(); // folder key -> element
const sessionViews = new Map(); // "agent:id" -> element

const fromTemplate = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

for (const el of document.querySelectorAll('.meter')) {
  el.append(document.getElementById('meter').content.cloneNode(true));
  el.querySelector('.label').textContent = LABELS[el.dataset.window];
}

// ---- usage bars ----

function renderMeter(el, w, now) {
  const d = U.describeWindow(w, now);
  const level = d ? d.level : 'none';
  el.dataset.level = level;
  el.querySelector('.fill').style.width = `${d ? d.usedPercent : 0}%`;
  el.querySelector('.tick').style.left = `${d ? d.elapsedPct : 0}%`;
  el.querySelector('.pct').textContent = !d ? '-' : U.formatPercent(d.usedPercent);
  el.querySelector('.reset').textContent = !d ? '' : level === 'reset' ? 'reset' : U.formatDuration(d.remainingSec);
  // The recent pace warns about a burst even while the bar is still green; the
  // whole-window average only speaks up once the bar is warn or hot.
  const recent = d?.paceBasis === 'recent';
  const pace = d && d.exhaustsInSec != null && (recent || level === 'warn' || level === 'hot');
  el.querySelector('.note').textContent = pace ? `out in ${U.formatDuration(d.exhaustsInSec)} at ${recent ? 'recent' : 'this'} pace` : '';
  el.title = !d
    ? 'no data yet'
    : level === 'reset'
      ? 'window reset; new numbers arrive with the next response'
      : `${U.formatPercent(d.usedPercent)} used, ${Math.round(d.elapsedPct)}% of the window gone\n` +
        `resets ${new Date(d.resetsAt * 1000).toLocaleString()} (in ${U.formatDuration(d.remainingSec)})\n` +
        `projection: ${recent ? 'your burn over the last 30 minutes' : 'average since the window started'}`;
}

function providerMeta(u, now) {
  if (!u || (!u.fiveHour && !u.weekly)) return 'no data yet';
  const parts = [];
  if (u.planType) parts.push(u.planType);
  if (u.updatedAt && now - u.updatedAt > STALE_MS) parts.push(`as of ${U.formatDuration((now - u.updatedAt) / 1000)} ago`);
  return parts.join(' · ');
}

function renderUsage(now) {
  for (const section of document.querySelectorAll('.provider')) {
    const u = state.usage?.[section.dataset.provider];
    section.querySelector('.pmeta').textContent = providerMeta(u, now);
    for (const el of section.querySelectorAll('.meter')) renderMeter(el, u?.[el.dataset.window], now);
  }
}

// ---- sessions ----

// Keep keyed children in list order; append() moves an existing node.
function syncChildren(container, items, keyOf, views, create) {
  const keep = new Set(items.map(keyOf));
  for (const [key, el] of views) {
    if (el.parentElement === container && !keep.has(key)) {
      el.remove();
      views.delete(key);
    }
  }
  return items.map((item) => {
    const key = keyOf(item);
    let el = views.get(key);
    if (!el) {
      el = create(item);
      views.set(key, el);
    }
    container.append(el);
    return [item, el];
  });
}

function renderSession(el, s, now) {
  const st = STATUS[s.status] || STATUS.quiet;
  el.dataset.status = s.status;
  el.dataset.session = s.id;
  el.querySelector('.glyph').textContent = st.glyph;
  // A pending approval is more specific than Claude Code's generic "dialog open".
  el.querySelector('.state').textContent = s.status === 'approval' ? st.label : s.waitingFor || st.label;
  el.querySelector('.agent').textContent = s.agent;
  const since = s.statusSince ?? s.lastActivityAt;
  el.querySelector('.age').textContent = since ? U.formatDuration(Math.max(0, now - since) / 1000) : '';
  const title = el.querySelector('.stitle');
  title.textContent = s.title;
  title.hidden = !s.title;
  const recentKey = JSON.stringify(s.recent);
  if (el.dataset.recent !== recentKey) {
    el.dataset.recent = recentKey;
    el.querySelector('.recent').replaceChildren(
      ...s.recent.map((r) => {
        const li = document.createElement('li');
        li.dataset.kind = r.kind;
        li.textContent = `${RECENT_MARK[r.kind] || ' '} ${r.text}`;
        li.title = r.text;
        return li;
      }),
    );
  }
}

function renderProjects(projects, now) {
  const box = document.getElementById('sessions');
  const pairs = syncChildren(box, projects, (p) => p.key, projectViews, () => fromTemplate('project'));
  for (const [p, el] of pairs) {
    el.querySelector('.project-name').textContent = p.project;
    el.title = p.cwd;
    const list = el.querySelector('.project-sessions');
    for (const [s, sel] of syncChildren(list, p.sessions, (s) => `${s.agent}:${s.id}`, sessionViews, () => fromTemplate('session'))) {
      renderSession(sel, s, now);
    }
  }
  // Sessions whose whole project row went away.
  for (const [key, el] of sessionViews) if (!el.isConnected) sessionViews.delete(key);
  document.getElementById('no-sessions').hidden = projects.length > 0;
}

// ---- approvals ----

function seconds(sec) {
  return sec < 120 ? `${Math.ceil(sec)}s` : U.formatDuration(sec);
}

function buildApproval(a) {
  const el = fromTemplate('approval');
  el.querySelector('.who').textContent = `${a.agent} · ${a.project || a.cwd || 'unknown folder'}`;
  el.querySelector('.who').title = a.cwd;
  el.querySelector('.what').textContent = a.title;
  const detail = el.querySelector('.detail');
  detail.textContent = a.detail;
  detail.hidden = !a.detail;
  const why = el.querySelector('.why');
  why.textContent = a.note;
  why.hidden = !a.note;
  for (const btn of el.querySelectorAll('button[data-decision]')) {
    btn.addEventListener('click', () => answer(a.id, btn.dataset.decision, el));
  }
  return el;
}

function updateApproval(view, a, now) {
  const sent = view.el.classList.contains('sent');
  if (!sent) for (const btn of view.el.querySelectorAll('button[data-decision]')) btn.disabled = now < view.armedAt;
  view.el.querySelector('.age').textContent = `${seconds(Math.max(0, (now - a.createdAt) / 1000))} ago`;
  const left = seconds(Math.max(0, (a.expiresAt - now) / 1000));
  if (!sent) {
    view.el.querySelector('.fallback').textContent =
      a.fallback === 'after' ? `terminal prompt in ${left}` : a.fallback === 'deny' ? `headless run: denied in ${left}` : 'also waiting in the terminal';
  }
}

// Inside its session's row when that session is listed, else in the top block.
function approvalHome(a) {
  const row = a.sessionId && document.querySelector(`.session[data-session="${CSS.escape(a.sessionId)}"] .row-approvals`);
  return row || document.getElementById('approvals');
}

function renderApprovals(list, now) {
  const ids = new Set(list.map((a) => a.id));
  for (const [id, view] of approvalViews) {
    if (!ids.has(id)) {
      view.el.remove();
      approvalViews.delete(id);
    }
  }
  for (const a of list) {
    let view = approvalViews.get(a.id);
    const fresh = !view;
    if (fresh) {
      view = { el: buildApproval(a), armedAt: now + ARM_MS };
      approvalViews.set(a.id, view);
      setTimeout(render, ARM_MS + 20);
    }
    const home = approvalHome(a);
    if (view.el.parentElement !== home) home.append(view.el);
    if (fresh) view.el.scrollIntoView({ block: 'nearest' });
    updateApproval(view, a, now);
  }
  const top = document.getElementById('approvals');
  top.hidden = top.children.length === 0;
  setAttention(list.length > 0);
}

async function answer(id, decision, el) {
  el.classList.add('sent');
  for (const btn of el.querySelectorAll('button')) btn.disabled = true;
  const fallback = el.querySelector('.fallback');
  fallback.textContent = decision === 'allow' ? 'approving' : decision === 'deny' ? 'denying' : 'handing back';
  try {
    const res = await fetch(`/api/approvals/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cockpit-Token': TOKEN },
      body: JSON.stringify({ decision }),
    });
    if (!res.ok) fallback.textContent = 'already answered';
  } catch {
    // Server unreachable: the hook falls back on its own. Let the user retry.
    el.classList.remove('sent');
    fallback.textContent = 'server unreachable';
  }
}

function setAttention(on) {
  if (on === attention) return;
  attention = on;
  document.body.classList.toggle('attention', on);
  bridge?.attention(on);
}

// ---- connections (Electron only: settings edits run in the main process) ----

const PART_LABELS = {
  'claude-usage': 'Claude Code · usage bars',
  'claude-approvals': 'Claude Code · approvals',
  'codex-approvals': 'Codex · approvals',
};
const PART_STATE = {
  on: { text: 'connected', button: 'disconnect', action: 'disconnect' },
  off: { text: 'not connected', button: 'connect', action: 'connect' },
  outdated: { text: 'needs update', button: 'update', action: 'connect' },
  unavailable: { text: 'not installed' },
  error: { text: "can't read settings" },
};

function renderSetup(s) {
  const rows = document.querySelector('#setup .setup-rows');
  rows.replaceChildren(
    ...Object.keys(PART_LABELS).map((part) => {
      const row = fromTemplate('setup-row');
      const { state, note } = s[part];
      const look = PART_STATE[state] || PART_STATE.error;
      row.dataset.state = state;
      row.querySelector('.slabel').textContent = PART_LABELS[part];
      row.querySelector('.sstate').textContent = look.text;
      row.querySelector('.snote').textContent = note || '';
      const btn = row.querySelector('.sbtn');
      btn.hidden = !look.action;
      btn.textContent = look.button || '';
      btn.addEventListener('click', () => applySetup(look.action, [part]));
      return row;
    }),
  );
  document.querySelector('#setup .setup-files').textContent = `${s.files.claude}\n${s.files.codex}`;
  // The gear carries a dot while something is ours but out of date (the app moved, an older version wrote it).
  document.getElementById('gear').classList.toggle('needs-update', Object.keys(PART_LABELS).some((p) => s[p].state === 'outdated'));
}

async function applySetup(action, parts) {
  const msg = document.querySelector('#setup .setup-msg');
  for (const b of document.querySelectorAll('#setup .sbtn')) b.disabled = true;
  const result = await bridge.setupApply(action, parts);
  if (result?.ok) {
    renderSetup(result.status);
    const lines = [...result.changed.map((f) => `updated ${f}`), ...result.backups.map((b) => `backup ${b}`), ...result.messages];
    msg.textContent = lines.join('\n') || 'nothing to change';
    msg.dataset.kind = result.messages.length ? 'action' : 'ok';
  } else {
    msg.textContent = result?.error || 'failed';
    msg.dataset.kind = 'error';
    for (const b of document.querySelectorAll('#setup .sbtn')) b.disabled = false;
  }
  msg.hidden = false;
}

async function showSetup(open) {
  const box = document.getElementById('setup');
  box.hidden = !open;
  document.getElementById('gear').setAttribute('aria-expanded', String(open));
  if (open) {
    document.querySelector('#setup .setup-msg').hidden = true;
    renderSetup(await bridge.setupStatus());
  }
}

// ---- main loop ----

function render() {
  if (!state) return;
  const now = Date.now();
  renderUsage(now);
  renderProjects(state.projects || [], now);
  renderApprovals(state.approvals || [], now); // after the rows they may live in
}

const events = new EventSource('/api/events');
events.addEventListener('state', (e) => {
  state = JSON.parse(e.data);
  document.getElementById('conn').hidden = true;
  render();
});
events.onerror = () => {
  document.getElementById('conn').hidden = false;
  // Pending requests die with the server; their hooks fall back to the terminal.
  if (state) {
    state.approvals = [];
    render();
  }
};
setInterval(render, 1000);

if (bridge) {
  document.body.classList.add('in-app');
  const pin = document.getElementById('pin');
  const showPin = (on) => pin.setAttribute('aria-pressed', String(Boolean(on)));
  bridge.isPinned().then(showPin);
  pin.addEventListener('click', async () => showPin(await bridge.setPinned(pin.getAttribute('aria-pressed') !== 'true')));
  document.getElementById('min').addEventListener('click', () => bridge.minimize());
  document.getElementById('close').addEventListener('click', () => bridge.close());
  document.getElementById('gear').addEventListener('click', () => showSetup(document.getElementById('setup').hidden));
  document.getElementById('setup-close').addEventListener('click', () => showSetup(false));
  // First run (nothing connected yet) or /#setup: start with the connections open.
  bridge.setupStatus().then((s) => {
    renderSetup(s);
    const available = Object.keys(PART_LABELS).filter((p) => s[p].state !== 'unavailable');
    if (location.hash === '#setup' || (available.length && available.every((p) => s[p].state === 'off'))) showSetup(true);
  });
}
