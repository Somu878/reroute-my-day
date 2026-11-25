import test from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts, proposeReroute, validateMoves } from '../server/reroute.js';

const D = (h, m = 0, day = 2) => new Date(2030, 0, day, h, m).toISOString(); // Wed Jan 2 2030
const ev = (id, title, s, e, kind, flexible = false) => ({ id, title, start: s, end: e, kind, flexible });
const O = { now: 0, workStart: 9, workEnd: 18, searchDays: 3 };

test('no conflict when meeting and block do not overlap', () => {
  const evs = [ev('m', 'M', D(9), D(10), 'meeting'), ev('p', 'P', D(11), D(13), 'personal', true)];
  assert.equal(findConflicts(evs).length, 0);
  assert.deepEqual(proposeReroute(evs, O).moves, []);
});

test('meeting over flexible block moves the block, not the meeting', () => {
  const evs = [ev('m', 'M', D(11, 30), D(12, 30), 'meeting'), ev('p', 'P', D(11), D(13), 'personal', true)];
  const plan = proposeReroute(evs, O);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].eventId, 'p');
  assert.equal(plan.moves.some((m) => m.eventId === 'm'), false);
  assert.deepEqual(validateMoves(evs, plan.moves), []);
});

test('non-flexible personal block is never moved', () => {
  const evs = [ev('m', 'M', D(11, 30), D(12, 30), 'meeting'), ev('p', 'P', D(11), D(13), 'personal', false)];
  assert.equal(proposeReroute(evs, O).moves.length, 0);
});

test('chosen slot is closest to original time and keeps duration', () => {
  const evs = [ev('m', 'M', D(11), D(12), 'meeting'), ev('p', 'P', D(11), D(13), 'personal', true)];
  const mv = proposeReroute(evs, O).moves[0];
  assert.equal(new Date(mv.to.end) - new Date(mv.to.start), 2 * 3600000);
  assert.equal(mv.to.start, D(12)); // 12-14 is closest free 2h slot
});

test('moved block stays inside working hours', () => {
  const evs = [ev('m', 'M', D(16), D(17), 'meeting'), ev('p', 'P', D(16), D(18), 'personal', true)];
  const mv = proposeReroute(evs, O).moves[0];
  assert.ok(new Date(mv.to.start).getHours() >= 9 && new Date(mv.to.end).getHours() <= 18);
});

test('two flexible blocks do not get placed on top of each other', () => {
  const evs = [ev('m', 'M', D(9), D(12), 'meeting'), ev('a', 'A', D(9), D(11), 'personal', true), ev('b', 'B', D(10), D(12), 'personal', true)];
  const plan = proposeReroute(evs, O);
  const after = evs.map((e) => { const mv = plan.moves.find((m) => m.eventId === e.id); return mv ? { ...e, ...mv.to } : e; });
  for (const x of after) for (const y of after) if (x.id < y.id) assert.ok(!(new Date(x.start) < new Date(y.end) && new Date(y.start) < new Date(x.end)), `${x.id}/${y.id} overlap`);
});

test('falls to the next working day when today is full', () => {
  const evs = [ev('m', 'M', D(9), D(18), 'meeting'), ev('p', 'P', D(11), D(13), 'personal', true)];
  const mv = proposeReroute(evs, O).moves[0];
  assert.equal(mv.nextDay, true);
});

test('honest failure: no slot means unresolved and no move', () => {
  const evs = [ev('m', 'M', D(9), D(18), 'meeting'), ev('m2', 'M2', D(9, 0, 3), D(18, 0, 3), 'meeting'), ev('m3', 'M3', D(9, 0, 4), D(18, 0, 4), 'meeting'),
    ev('m4', 'M4', D(9, 0, 7), D(18, 0, 7), 'meeting'), ev('p', 'P', D(11), D(13), 'personal', true)];
  const plan = proposeReroute(evs, { ...O, searchDays: 2 });
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.unresolved.length, 1);
});

test('skips weekends', () => {
  const fri = (h) => new Date(2030, 0, 4, h).toISOString(); // Fri Jan 4 2030
  const evs = [ev('m', 'M', fri(9), fri(18), 'meeting'), ev('p', 'P', fri(11), fri(13), 'personal', true)];
  const mv = proposeReroute(evs, O).moves[0];
  assert.equal(new Date(mv.to.start).getDay(), 1); // Monday
});

test('validateMoves rejects tampered plans', () => {
  const evs = [ev('m', 'M', D(11), D(12), 'meeting'), ev('p', 'P', D(13), D(14), 'personal', true)];
  assert.ok(validateMoves(evs, [{ eventId: 'm', to: { start: D(15), end: D(16) } }]).length, 'meeting move rejected');
  assert.ok(validateMoves(evs, [{ eventId: 'p', to: { start: D(11), end: D(12) } }]).length, 'overlap rejected');
  assert.ok(validateMoves(evs, [{ eventId: 'p', to: { start: D(15), end: D(17) } }]).length, 'duration change rejected');
  assert.deepEqual(validateMoves(evs, [{ eventId: 'p', to: { start: D(15), end: D(16) } }]), []);
});

test('prefs: morning preference, bounds, and buffer are honored', () => {
  const evs = [ev('m', 'M', D(11), D(12), 'meeting'), ev('p', 'P', D(11), D(12), 'personal', true)];
  const aft = proposeReroute(evs, { ...O, prefs: { earliestHour: 14, latestHour: 18 } }).moves[0];
  assert.ok(new Date(aft.to.start).getHours() >= 14);
  const buf = proposeReroute(evs, { ...O, prefs: { bufferMin: 30 } }).moves[0];
  assert.ok(new Date(buf.to.start) >= new Date(D(12, 30)) || new Date(buf.to.end) <= new Date(D(10, 30)));
  const same = proposeReroute([ev('m', 'M', D(9), D(18), 'meeting'), ev('p', 'P', D(11), D(12), 'personal', true)], { ...O, prefs: { sameDayOnly: true } });
  assert.equal(same.moves.length, 0); assert.equal(same.unresolved.length, 1);
});
test('offers up to 3 distinct options and honors a choice', () => {
  const evs = [ev('m', 'M', D(11), D(12), 'meeting'), ev('p', 'P', D(11), D(12), 'personal', true)];
  const plan = proposeReroute(evs, O);
  assert.ok(plan.moves[0].options.length >= 2);
  const alt = proposeReroute(evs, { ...O, choices: { p: 1 } });
  assert.equal(alt.moves[0].to.start, plan.moves[0].options[1].start);
});
test('validateMoves rejects out-of-hours, weekend and past targets', () => {
  const evs = [ev('p', 'P', D(13), D(14), 'personal', true)];
  assert.ok(validateMoves(evs, [{ eventId: 'p', to: { start: D(20), end: D(21) } }]).length);
  assert.ok(validateMoves(evs, [{ eventId: 'p', to: { start: new Date(2030, 0, 5, 10).toISOString(), end: new Date(2030, 0, 5, 11).toISOString() } }]).length);
  assert.ok(validateMoves(evs, [{ eventId: 'p', to: { start: new Date(2001, 0, 2, 10).toISOString(), end: new Date(2001, 0, 2, 11).toISOString() } }]).length);
});
