const HH = 48, START = 8, END = 19;
const $ = (s) => document.querySelector(s);
let state = { events: [], plan: null, mode: 'demo', cfg: {} };
let csrf = '';

const api = async (p, o) => { const r = await fetch(p, o); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
const post = (p, b) => api(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(b || {}) });
const fmt = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
const dayKey = (d) => new Date(d).toDateString();

function toast(msg, undo) {
  const t = $('#toast'); t.hidden = false; t.innerHTML = `<span></span>${undo ? '<button>Undo</button>' : ''}`; t.firstChild.textContent = msg;
  if (undo) t.querySelector('button').onclick = async () => { await post('/api/reroute/undo'); t.hidden = true; load(); };
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 10000);
}

function visibleDays() {
  const days = []; const d = new Date(); d.setHours(0, 0, 0, 0);
  while (days.length < 5) { if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d)); d.setDate(d.getDate() + 1); }
  return days;
}

function place(el, ev) {
  const s = new Date(ev.start), e = new Date(ev.end);
  const top = ((s.getHours() + s.getMinutes() / 60) - START) * HH, h = ((e - s) / 3600000) * HH;
  el.style.top = top + 'px'; el.style.height = Math.max(h - 2, 18) + 'px';
}

function render() {
  const g = $('#grid'); g.style.setProperty('--hh', HH + 'px'); g.innerHTML = '';
  const days = visibleDays();
  g.append(Object.assign(document.createElement('div'), { className: 'dh' }));
  days.forEach((d) => { const h = document.createElement('div'); h.className = 'dh' + (dayKey(d) === dayKey(new Date()) ? ' today' : ''); h.innerHTML = `${d.toLocaleDateString([], { weekday: 'short' })}<b>${d.getDate()}</b>`; g.append(h); });
  const hours = document.createElement('div'); hours.className = 'hours';
  for (let h = START; h < END; h++) hours.innerHTML += `<div>${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</div>`;
  g.append(hours);
  const moves = state.plan ? state.plan.moves : [];
  const movingIds = new Set(moves.map((m) => m.eventId));
  const brokenIds = new Set((state.plan?.conflicts || []).map((c) => c.blockId));
  days.forEach((d) => {
    const col = document.createElement('div'); col.className = 'col'; col.style.height = (END - START) * HH + 'px'; col.dataset.day = dayKey(d);
    if (dayKey(d) === dayKey(new Date())) { const n = new Date(); const l = document.createElement('div'); l.className = 'now'; l.style.top = ((n.getHours() + n.getMinutes() / 60) - START) * HH + 'px'; if (n.getHours() >= START && n.getHours() < END) col.append(l); }
    for (const ev of state.events.filter((e) => dayKey(e.start) === dayKey(d))) {
      const el = document.createElement('div');
      el.className = 'ev ' + (ev.kind === 'meeting' ? 'meeting' : ev.flexible ? 'flex' : 'personal') + (brokenIds.has(ev.id) ? ' broken' : '') + (movingIds.has(ev.id) ? ' moving' : '');
      el.dataset.title = ev.title;
      el.innerHTML = `<b></b><small>${fmt(ev.start)} - ${fmt(ev.end)}${ev.kind === 'meeting' ? ' · ' + (ev.attendees || '') + ' people' : ev.flexible ? ' · flexible' : ''}</small>`;
      el.querySelector('b').textContent = ev.title; place(el, ev);
      if (ev.allDay) { el.className = 'ev allday'; el.style.top = '0px'; el.style.height = (END - START) * HH + 'px'; el.innerHTML = '<b></b><small>All day (blocks the day)</small>'; el.querySelector('b').textContent = ev.title; col.append(el); continue; }
      if (ev.kind === 'personal') { const b = document.createElement('button'); b.className = 'tog'; b.textContent = '⇄'; b.title = ev.flexible ? 'Make fixed' : 'Make flexible (allow rerouting)'; b.onclick = async () => { try { await post(`/api/events/${encodeURIComponent(ev.id)}/flexible`, { flexible: !ev.flexible }); load(); } catch (e) { toast(e.message); } }; el.append(b); }
      col.append(el);
    }
    for (const m of moves.filter((m) => dayKey(m.to.start) === dayKey(d))) {
      const el = document.createElement('div'); el.className = 'ev ghost'; el.dataset.ghost = m.title;
      el.innerHTML = `<b></b><small>${fmt(m.to.start)} - ${fmt(m.to.end)} (proposed)</small>`; el.querySelector('b').textContent = m.title; place(el, m.to); col.append(el);
    }
    g.append(col);
  });
  renderPanel();
}

function renderPanel() {
  const p = state.plan, banner = $('#banner'), panel = $('#proposal'); panel.innerHTML = '';
  if (!p || (!p.conflicts.length)) { banner.innerHTML = '<div class="ok">✓ Your plan is intact. Nothing needs rerouting.</div>'; return; }
  const n = p.conflicts.length;
  banner.innerHTML = `<div class="warn">Your day changed. ${n} personal block${n > 1 ? 's' : ''} now clash${n > 1 ? '' : 'es'} with a meeting.</div>`;
  if (p.ai?.status === 'ok' && p.ai.explanation) { const x = document.createElement('div'); x.className = 'ai'; x.innerHTML = '<span class="tag">AI-generated explanation</span><p></p>'; x.querySelector('p').textContent = p.ai.explanation; panel.append(x); }
  if (p.ai?.status === 'error') { const x = document.createElement('div'); x.className = 'ai err'; x.textContent = p.ai.error; panel.append(x); }
  for (const m of p.moves) {
    const c = document.createElement('div'); c.className = 'card';
    c.innerHTML = `<h3></h3><div class="reason"></div><div class="ba"><span class="l">Was</span><span class="from">${fmtDay(m.from.start)}, ${fmt(m.from.start)} - ${fmt(m.from.end)}</span><span class="l">Now</span><b>${fmtDay(m.to.start)}, ${fmt(m.to.start)} - ${fmt(m.to.end)}${m.nextDay ? ' (another day)' : ''}</b></div>`;
    c.querySelector('h3').textContent = m.title; c.querySelector('.reason').textContent = m.reason; panel.append(c);
  }
  for (const u of p.unresolved) {
    const c = document.createElement('div'); c.className = 'card stuck';
    c.innerHTML = '<h3></h3><div class="reason"></div>'; c.querySelector('h3').textContent = `Can't fit: ${u.title}`; c.querySelector('.reason').textContent = u.reason + ' Decide manually, or free up time.'; panel.append(c);
  }
  if (p.moves.length) {
    const a = document.createElement('div'); a.className = 'actions';
    a.innerHTML = `<button class="primary" id="apply">Apply ${p.moves.length} change${p.moves.length > 1 ? 's' : ''}</button><button class="ghost" id="dismiss">Dismiss</button>`;
    panel.append(a);
    $('#apply').onclick = async () => { try { const r = await post('/api/reroute/apply', { moves: p.moves, planHash: p.planHash }); await load(); toast(`Moved ${r.applied} block${r.applied > 1 ? 's' : ''}. Meetings untouched.`, true); } catch (e) { toast(e.message); load(); } };
    $('#dismiss').onclick = () => { state.plan = { ...state.plan, moves: [] }; render(); };
  }
}

async function load() {
  csrf = (await api('/api/mode')).csrf;
  const [cfg, ev, plan] = await Promise.all([api('/api/mode'), api('/api/events'), api('/api/reroute/plan')]);
  state = { cfg, mode: ev.mode, events: ev.events, plan };
  $('#mode').textContent = ev.mode === 'demo' ? 'Demo mode (sample data)' : 'Google Calendar (live)';
  $('#demoTools').style.display = ev.mode === 'demo' ? 'flex' : 'none';
  $('#connect').style.display = ev.mode === 'demo' && cfg.googleAvailable ? '' : 'none';
  $('#ai').textContent = cfg.aiEnabled ? 'AI: on (explains and ranks; rules decide what is allowed)' : 'AI: off (rules only, no API key)';
  $('#prefs').style.display = cfg.aiEnabled ? 'flex' : 'none';
  if (cfg.aiEnabled && plan.ai?.prefsText) $('#prefsText').placeholder = 'Active: ' + plan.ai.prefsText;
  render();
}
$('#prefsGo').onclick = async () => { try { await post('/api/ai/prefs', { text: $('#prefsText').value }); load(); } catch (e) { toast(e.message); } };
$('#disrupt').onclick = async () => { try { await post('/api/demo/disrupt'); load(); } catch (e) { toast(e.message); } };
$('#reset').onclick = async () => { await post('/api/demo/reset'); load(); };
$('#connect').onclick = () => (location.href = '/auth/google');
(async () => {
  try {
    // Demo convenience: /?scenario=disrupt starts with the day already broken (demo mode only).
    if (new URLSearchParams(location.search).get('scenario') === 'disrupt') { csrf = (await api('/api/mode')).csrf; try { await post('/api/demo/disrupt'); } catch {} }
    await load();
  } catch (e) { toast(e.message); }
})();
