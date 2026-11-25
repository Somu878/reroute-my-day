// Pure rerouting logic. No I/O. Times are epoch ms internally via Date.
// Event shape: { id, title, start (ISO), end (ISO), kind: 'meeting'|'personal', flexible?: bool }
// Rules:
//  - Only personal blocks the user marked flexible may be moved.
//  - Meetings (anything with other people) are never moved.
//  - A "broken" flexible block overlaps any other event (meeting or personal).
//  - Moves stay inside working hours and never create a new overlap.

const MIN = 60000;
const t = (iso) => new Date(iso).getTime();

export function overlaps(a, b) {
  return t(a.start) < t(b.end) && t(b.start) < t(a.end);
}

export function isMovable(ev) {
  return ev.kind === 'personal' && ev.flexible === true && !ev.recurring && !ev.allDay;
}

export function findConflicts(events) {
  const out = [];
  for (const ev of events) {
    if (!isMovable(ev)) continue;
    const hit = events.filter((o) => o.id !== ev.id && overlaps(ev, o));
    // If two flexible blocks overlap, only the later-starting one is "broken".
    const blockers = hit.filter((o) => !(isMovable(o) && t(o.start) > t(ev.start)));
    if (blockers.length) out.push({ block: ev, blockers });
  }
  return out;
}

function dayWindows(dayStart, workStart, workEnd) {
  const s = new Date(dayStart); s.setHours(workStart, 0, 0, 0);
  const e = new Date(dayStart); e.setHours(workEnd, 0, 0, 0);
  return [s.getTime(), e.getTime()];
}

// Candidate slots of the block's duration. Same-day candidates always outrank later days.
// prefs (all optional, validated upstream): earliestHour, latestHour (bounds inside working hours),
// preferPart 'morning'|'afternoon', bufferMin (gap kept around other events), sameDayOnly.
export function findSlots(block, busy, opts = {}, n = 3) {
  const { workStart = 9, workEnd = 18, searchDays = 3, now = Date.now(), step = 15 * MIN, prefs = {} } = opts;
  const ws0 = Math.max(workStart, prefs.earliestHour ?? workStart), we0 = Math.min(workEnd, prefs.latestHour ?? workEnd);
  const buf = (prefs.bufferMin || 0) * MIN;
  const dur = t(block.end) - t(block.start);
  const origin = t(block.start);
  const base = new Date(origin); base.setHours(0, 0, 0, 0);
  const cands = [];
  // searchDays counts working days after the block's own day (weekends are skipped, not counted).
  for (let cal = 0, d = 0; d <= (prefs.sameDayOnly ? 0 : searchDays) && cal < 30; cal++) {
    const day = new Date(base); day.setDate(day.getDate() + cal);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    const dd = d++;
    const [ws, we] = dayWindows(day, ws0, we0);
    for (let s = ws; s + dur <= we; s += step) {
      if (s < now) continue;
      const e = s + dur;
      if (busy.some((b) => t(b.start) - buf < e && s < t(b.end) + buf)) continue;
      const hr = new Date(s).getHours();
      const partMiss = prefs.preferPart && ((prefs.preferPart === 'morning') !== (hr < 12)) ? 120 : 0;
      cands.push({ s, score: dd * 100000 + Math.abs(s - origin) / MIN + partMiss, d: dd });
    }
  }
  cands.sort((x, y) => x.score - y.score || x.s - y.s);
  // Keep options distinct by at least one hour so alternatives are meaningfully different.
  const out = [];
  for (const c of cands) { if (out.every((o) => Math.abs(o.s - c.s) >= 60 * MIN)) out.push(c); if (out.length >= n) break; }
  return out.map((c) => ({ start: new Date(c.s).toISOString(), end: new Date(c.s + dur).toISOString(), dayOffset: c.d }));
}
export const findSlot = (block, busy, opts) => findSlots(block, busy, opts, 1)[0] || null;

export function proposeReroute(events, opts = {}) {
  const conflicts = findConflicts(events);
  const broken = new Set(conflicts.map((c) => c.block.id));
  // Busy = everything that is not itself being moved. Placed moves are added as we go.
  const busy = events.filter((e) => !broken.has(e.id));
  const moves = [];
  const unresolved = [];
  // Place earlier blocks first so ordering stays stable.
  const ordered = [...conflicts].sort((a, b) => t(a.block.start) - t(b.block.start));
  for (const c of ordered) {
    const options = findSlots(c.block, busy, opts, 3);
    const idx = Math.min(opts.choices?.[c.block.id] ?? 0, options.length - 1);
    const slot = options[idx];
    if (slot) {
      moves.push({
        eventId: c.block.id, title: c.block.title,
        from: { start: c.block.start, end: c.block.end }, to: { start: slot.start, end: slot.end },
        reason: `Clashes with "${c.blockers.map((b) => b.title).join('", "')}"`,
        nextDay: slot.dayOffset > 0, options, optionIndex: idx,
      });
      busy.push({ ...c.block, start: slot.start, end: slot.end });
    } else {
      unresolved.push({ eventId: c.block.id, title: c.block.title, reason: 'No free slot inside working hours in the search window. Nothing was moved.' });
    }
  }
  return { conflicts: conflicts.map((c) => ({ blockId: c.block.id, blockers: c.blockers.map((b) => b.id) })), moves, unresolved };
}

// Validate a client-submitted plan against current state before applying. Never trust the client.
export function validateMoves(events, moves, opts = {}) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const errs = [];
  const after = events.map((e) => ({ ...e }));
  for (const m of moves) {
    const ev = byId.get(m.eventId);
    if (!ev) { errs.push(`Unknown event ${m.eventId}`); continue; }
    if (!isMovable(ev)) { errs.push(`"${ev.title}" is not a flexible personal block`); continue; }
    if (t(m.to.end) - t(m.to.start) !== t(ev.end) - t(ev.start)) errs.push(`"${ev.title}" duration changed`);
    const { workStart = 9, workEnd = 18, now = Date.now() } = opts;
    const ds = new Date(m.to.start), de = new Date(m.to.end);
    if (!(ds < de)) errs.push(`"${ev.title}" has an invalid time range`);
    else {
      const [ws, we] = dayWindows(ds, workStart, workEnd);
      if (ds.toDateString() !== de.toDateString() || ds.getTime() < ws || de.getTime() > we) errs.push(`"${ev.title}" would leave working hours`);
      if (ds.getDay() === 0 || ds.getDay() === 6) errs.push(`"${ev.title}" would land on a weekend`);
      if (ds.getTime() < now) errs.push(`"${ev.title}" would move into the past`);
    }
    const a = after.find((e) => e.id === m.eventId); a.start = m.to.start; a.end = m.to.end;
  }
  if (!errs.length) {
    for (const m of moves) {
      const a = after.find((e) => e.id === m.eventId);
      const clash = after.find((o) => o.id !== a.id && overlaps(a, o));
      if (clash) errs.push(`"${a.title}" would overlap "${clash.title}"`);
    }
  }
  return errs;
}
