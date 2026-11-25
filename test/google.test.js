import test from 'node:test';
import assert from 'node:assert/strict';
import { mapGoogleEvent, GoogleStore } from '../server/google.js';
import { proposeReroute } from '../server/reroute.js';

const timed = (o = {}) => ({ id: 'e', summary: 'S', status: 'confirmed', start: { dateTime: '2030-01-02T11:00:00+05:30' }, end: { dateTime: '2030-01-02T12:00:00+05:30' }, organizer: { self: true }, ...o });

test('cancelled and transparent (free) events are skipped; declined too', () => {
  assert.equal(mapGoogleEvent(timed({ status: 'cancelled' })), null);
  assert.equal(mapGoogleEvent(timed({ transparency: 'transparent' })), null);
  assert.equal(mapGoogleEvent(timed({ attendees: [{ self: true, responseStatus: 'declined' }, { email: 'a@b.c' }] })), null);
});
test('opaque all-day event blocks the whole local day as a fixed event', () => {
  const m = mapGoogleEvent({ id: 'a', summary: 'Holiday', start: { date: '2030-01-02' }, end: { date: '2030-01-03' } });
  assert.equal(m.allDay, true); assert.equal(m.kind, 'meeting'); assert.equal(m.flexible, false);
  assert.equal(new Date(m.start).getHours(), 0); assert.equal(new Date(m.end) - new Date(m.start) >= 23 * 3600000, true);
});
test('all-day event really removes that day from candidate slots', () => {
  const day = (d, h) => new Date(2030, 0, d, h).toISOString();
  const allDay = mapGoogleEvent({ id: 'a', summary: 'OOO', start: { date: '2030-01-02' }, end: { date: '2030-01-03' } });
  const block = { id: 'p', title: 'P', start: day(2, 11), end: day(2, 13), kind: 'personal', flexible: true };
  const meet = { id: 'm', title: 'M', start: day(2, 11), end: day(2, 12), kind: 'meeting' };
  const plan = proposeReroute([allDay, block, meet], { now: 0 });
  assert.equal(plan.moves.length, 1);
  assert.equal(new Date(plan.moves[0].to.start).getDate(), 3); // not Jan 2
});
test('multi-day all-day event covers every day', () => {
  const m = mapGoogleEvent({ id: 'a', summary: 'Trip', start: { date: '2030-01-02' }, end: { date: '2030-01-05' } });
  assert.equal(Math.round((new Date(m.end) - new Date(m.start)) / 86400000), 3);
});
test('events with other attendees, or not owned by the user, are fixed meetings', () => {
  assert.equal(mapGoogleEvent(timed({ attendees: [{ self: true }, { email: 'x@y.z' }] })).kind, 'meeting');
  assert.equal(mapGoogleEvent(timed({ organizer: { self: false }, creator: { self: false } })).kind, 'meeting');
});
test('recurring instances are never flexible even if flagged', () => {
  const m = mapGoogleEvent(timed({ recurringEventId: 'r', extendedProperties: { private: { reroute_flexible: 'true' } } }));
  assert.equal(m.recurring, true); assert.equal(m.flexible, false);
  const one = mapGoogleEvent(timed({ extendedProperties: { private: { reroute_flexible: 'true' } } }));
  assert.equal(one.kind, 'personal'); assert.equal(one.flexible, true);
});
test('a recurring block that clashes is reported but never moved', () => {
  const day = (h) => new Date(2030, 0, 2, h).toISOString();
  const rec = { id: 'p', title: 'P', start: day(11), end: day(13), kind: 'personal', flexible: true, recurring: true };
  assert.equal(proposeReroute([rec, { id: 'm', title: 'M', start: day(11), end: day(12), kind: 'meeting' }], { now: 0 }).moves.length, 0);
});

function mockGoogle(handler) {
  const calls = []; const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return handler(String(url), opts); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('GoogleStore: list remembers each event ETag and move sends it as If-Match (no sendUpdates)', async () => {
  const m = mockGoogle((url, o) => o.method === 'PATCH' ? res(200, {}) : res(200, { items: [{ id: 'e1', etag: '"abc"', summary: 'Focus', status: 'confirmed', organizer: { self: true }, start: { dateTime: '2030-01-02T11:00:00+05:30' }, end: { dateTime: '2030-01-02T12:00:00+05:30' }, extendedProperties: { private: { reroute_flexible: 'true' } } }] }));
  try {
    const store = new GoogleStore({ access_token: 't', expires_at: Date.now() + 3600000 });
    const evs = await store.list(); assert.equal(evs[0].flexible, true);
    await store.move('e1', '2030-01-02T13:00:00.000Z', '2030-01-02T14:00:00.000Z');
    const patch = m.calls.find((c) => c.opts.method === 'PATCH');
    assert.equal(patch.opts.headers['if-match'], '"abc"');
    assert.match(patch.url, /sendUpdates=none/);
    assert.deepEqual(Object.keys(JSON.parse(patch.opts.body)).sort(), ['end', 'start']); // only start/end are written
  } finally { m.restore(); }
});
test('GoogleStore: a 412 (event changed since it was read) is reported as such and nothing is retried', async () => {
  const m = mockGoogle((url, o) => o.method === 'PATCH' ? res(412, {}) : res(200, { items: [{ id: 'e1', etag: '"abc"', summary: 'Focus', status: 'confirmed', organizer: { self: true }, start: { dateTime: '2030-01-02T11:00:00+05:30' }, end: { dateTime: '2030-01-02T12:00:00+05:30' } }] }));
  try {
    const store = new GoogleStore({ access_token: 't', expires_at: Date.now() + 3600000 });
    await store.list();
    await assert.rejects(() => store.move('e1', '2030-01-02T13:00:00.000Z', '2030-01-02T14:00:00.000Z'), /changed in Google Calendar/);
    assert.equal(m.calls.filter((c) => c.opts.method === 'PATCH').length, 1);
  } finally { m.restore(); }
});
