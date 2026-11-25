// In-memory demo calendar. Seeded relative to the current week so it always looks live.
import { randomUUID } from 'node:crypto';

function at(dayOffset, h, m = 0) {
  const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString();
}
function mondayOffset() { const d = new Date().getDay(); return d === 0 ? -6 : 1 - d; }

export function seed() {
  // Use today as anchor for the demo so "now" filtering in the rerouter has room to work.
  const today = new Date().getDay();
  const day = (today === 0 || today === 6) ? mondayOffset() + 7 : 0;
  const mk = (title, off, h1, m1, h2, m2, kind, flexible, extra = {}) =>
    ({ id: randomUUID(), title, start: at(day + off, h1, m1), end: at(day + off, h2, m2), kind, flexible, ...extra });
  const extra = process.env.DEMO_ALLDAY ? [{ id: randomUUID(), title: 'Company holiday', kind: 'meeting', flexible: false, allDay: true, start: new Date(new Date(at(day + 2, 0)).setHours(0,0,0,0)).toISOString(), end: new Date(new Date(at(day + 3, 0)).setHours(0,0,0,0)).toISOString() }] : [];
  return [
    ...extra,
    mk('Team standup', 0, 9, 30, 10, 0, 'meeting', false, { attendees: 6 }),
    mk('Write proposal', 0, 11, 0, 13, 0, 'personal', true),
    mk('Lunch', 0, 13, 0, 14, 0, 'personal', false),
    mk('Admin and email', 0, 15, 30, 16, 30, 'personal', true),
    mk('Design review', 1, 10, 0, 11, 30, 'meeting', false, { attendees: 4 }),
    mk('Deep work: prototype', 1, 13, 0, 15, 0, 'personal', true),
    mk('1:1 with manager', 1, 16, 0, 16, 30, 'meeting', false, { attendees: 2 }),
    mk('Customer call', 2, 11, 0, 12, 0, 'meeting', false, { attendees: 3 }),
    mk('Review PRs', 2, 14, 0, 15, 0, 'personal', true),
  ];
}

export class DemoStore {
  constructor() { this.reset(); }
  reset() { this.events = seed(); this.undoStack = []; }
  async list() { return this.events.map((e) => ({ ...e })); }
  async move(id, start, end) {
    const e = this.events.find((x) => x.id === id);
    if (!e) throw new Error('not found');
    e.start = start; e.end = end;
  }
  async setFlexible(id, flexible) {
    const e = this.events.find((x) => x.id === id);
    if (!e) throw new Error('not found');
    if (e.kind !== 'personal') throw new Error('Only personal blocks can be flexible');
    e.flexible = !!flexible;
  }
  // Demo helper: drop a new meeting on top of the first flexible block that is still in the future.
  async disrupt() {
    const now = Date.now();
    const clash = (e) => this.events.some((o) => o.id !== e.id && o.kind === 'meeting' && new Date(o.start) < new Date(e.end) && new Date(e.start) < new Date(o.end));
    const target = this.events.filter((e) => e.flexible && new Date(e.start).getTime() > now && !clash(e))
      .sort((a, b) => new Date(a.start) - new Date(b.start))[0];
    if (!target) throw new Error('No upcoming flexible block to disrupt. Mark one flexible first.');
    const s = new Date(target.start).getTime();
    const ev = { id: randomUUID(), title: 'Urgent: incident sync', kind: 'meeting', flexible: false, attendees: 5,
      start: new Date(s + 30 * 60000).toISOString(), end: new Date(s + 90 * 60000).toISOString() };
    this.events.push(ev);
    return ev;
  }
}
