import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { DemoStore } from '../server/demo.js';
import { createAi } from '../server/ai.js';

const servers = [];
async function start(opts) { const s = createServer(opts); await new Promise((r) => s.listen(0, r)); servers.push(s); return `http://localhost:${s.address().port}`; }
test.after(() => servers.forEach((s) => s.close()));

// A tiny browser: keeps the session cookie and CSRF token.
async function client(base) {
  let cookie = '';
  const raw = async (p, o = {}) => { const r = await fetch(base + p, { ...o, redirect: 'manual', headers: { cookie, ...(o.headers || {}) } }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return r; };
  const mode = await (await raw('/api/mode')).json();
  const c = { mode, raw,
    get: async (p) => { const r = await raw(p); return { status: r.status, body: await r.json() }; },
    post: async (p, b, h = {}) => { const r = await raw(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': mode.csrf, ...h }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json() }; } };
  return c;
}
async function armFlexible(c) {
  const evs = (await c.get('/api/events')).body.events;
  for (const e of evs.filter((e) => e.kind === 'personal' && new Date(e.start) > new Date())) await c.post(`/api/events/${e.id}/flexible`, { flexible: true });
}

test('demo mode default; AI reported as off without a key', async () => {
  const c = await client(await start({ ai: createAi({}) }));
  assert.equal(c.mode.mode, 'demo'); assert.equal(c.mode.aiEnabled, false);
  assert.equal((await c.post('/api/ai/prefs', { text: 'mornings' })).status, 400);
  await armFlexible(c); await c.post('/api/demo/disrupt');
  const plan = (await c.get('/api/reroute/plan')).body;
  assert.equal(plan.ai.status, 'off'); assert.equal(plan.ai.explanation, '');
});

test('end to end: disrupt, plan, apply, undo; meetings untouched', async () => {
  const c = await client(await start({ ai: createAi({}) }));
  await armFlexible(c);
  const before = (await c.get('/api/events')).body.events.filter((e) => e.kind === 'meeting');
  assert.equal((await c.get('/api/reroute/plan')).body.conflicts.length, 0);
  await c.post('/api/demo/disrupt');
  const plan = (await c.get('/api/reroute/plan')).body;
  assert.ok(plan.moves.length >= 1);
  assert.equal((await c.post('/api/reroute/apply', { moves: plan.moves, planHash: plan.planHash })).status, 200);
  const after = (await c.get('/api/events')).body.events;
  for (const m of before) assert.equal(after.find((e) => e.id === m.id).start, m.start);
  assert.equal((await c.get('/api/reroute/plan')).body.conflicts.length, 0);
  const undo = await c.post('/api/reroute/undo');
  assert.equal(undo.body.undone, plan.moves.length);
  assert.ok((await c.get('/api/reroute/plan')).body.conflicts.length >= 1);
  assert.equal((await c.post('/api/reroute/undo')).status, 409);
});

test('CSRF: POST without token or with a foreign origin is refused', async () => {
  const c = await client(await start({ ai: createAi({}) }));
  const noTok = await c.raw('/api/demo/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noTok.status, 403);
  assert.equal((await c.post('/api/demo/reset', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await c.post('/api/demo/reset')).status, 200);
});

test('sessions are isolated: one visitor cannot see or change another visitor\'s calendar', async () => {
  const base = await start({ ai: createAi({}) });
  const a = await client(base), b = await client(base);
  const ea = (await a.get('/api/events')).body.events;
  await a.post(`/api/events/${ea.find((e) => e.kind === 'personal').id}/flexible`, { flexible: true });
  const eb = (await b.get('/api/events')).body.events;
  assert.notEqual(ea[0].id, eb[0].id);
  assert.equal(eb.filter((e) => e.flexible).length, ea.filter((e) => e.flexible).length === 0 ? 0 : eb.filter((e) => e.flexible).length);
  // B cannot apply a plan to A's event ids
  const r = await b.post('/api/reroute/apply', { moves: [{ eventId: ea[0].id, to: { start: ea[0].start, end: ea[0].end } }], planHash: 'x' });
  assert.equal(r.status, 409);
  // forged cookie signature is not accepted (gets a fresh session, not A's)
  const forged = await fetch(base + '/api/events', { headers: { cookie: a.raw && 'sid=' + 'a'.repeat(32) + '.' + 'b'.repeat(32) } });
  assert.notEqual((await forged.json()).events[0].id, ea[0].id);
});

test('stale plan is refused and nothing moves', async () => {
  const c = await client(await start({ ai: createAi({}) }));
  await armFlexible(c); await c.post('/api/demo/disrupt');
  const plan = (await c.get('/api/reroute/plan')).body;
  const mover = plan.moves[0];
  await c.post('/api/demo/disrupt'); // calendar changes after the plan was shown
  const r = await c.post('/api/reroute/apply', { moves: plan.moves, planHash: plan.planHash });
  assert.equal(r.status, 409); assert.equal(r.body.stale, true);
  const ev = (await c.get('/api/events')).body.events.find((e) => e.id === mover.eventId);
  assert.equal(ev.start, mover.from.start);
});

class FlakyStore extends DemoStore {
  constructor(failRestore) { super(); this.failRestore = failRestore; this.calls = 0; this.armed = false; }
  async move(id, s, e) { if (this.armed) { this.calls++; if (this.calls === 2 || (this.failRestore && this.calls > 2)) throw new Error('boom'); } return super.move(id, s, e); }
}
async function twoBlockPlan(c) {
  // flex everything in the future, then put two meetings on two different blocks
  await armFlexible(c);
  await c.post('/api/demo/disrupt'); await c.post('/api/demo/disrupt');
  return (await c.get('/api/reroute/plan')).body;
}
test('apply failure mid-batch is rolled back and reported honestly', async () => {
  const store = new FlakyStore(false);
  const c = await client(await start({ ai: createAi({}), storeFactory: () => store }));
  const plan = await twoBlockPlan(c);
  assert.ok(plan.moves.length >= 2, 'fixture must produce two moves');
  store.armed = true;
  const r = await c.post('/api/reroute/apply', { moves: plan.moves, planHash: plan.planHash });
  assert.equal(r.status, 502); assert.match(r.body.error, /Nothing was changed/);
  store.armed = false;
  const ev = (await c.get('/api/events')).body.events;
  for (const m of plan.moves) assert.equal(ev.find((e) => e.id === m.eventId).start, m.from.start);
});
test('if rollback itself fails, the response says which blocks are stuck', async () => {
  const store = new FlakyStore(true);
  const c = await client(await start({ ai: createAi({}), storeFactory: () => store }));
  const plan = await twoBlockPlan(c);
  assert.ok(plan.moves.length >= 2, 'fixture must produce two moves');
  store.armed = true;
  const r = await c.post('/api/reroute/apply', { moves: plan.moves, planHash: plan.planHash });
  assert.equal(r.status, 502); assert.equal(r.body.partial, true); assert.ok(r.body.restoreFailed.length >= 1);
});

test('undo never overwrites a later manual edit', async () => {
  const store = new DemoStore();
  const c = await client(await start({ ai: createAi({}), storeFactory: () => store }));
  await armFlexible(c); await c.post('/api/demo/disrupt');
  const plan = (await c.get('/api/reroute/plan')).body;
  await c.post('/api/reroute/apply', { moves: plan.moves, planHash: plan.planHash });
  const m = plan.moves[0];
  store.events.find((e) => e.id === m.eventId).start = new Date(new Date(m.to.start).getTime() + 3600000).toISOString(); // user drags it elsewhere
  const undo = await c.post('/api/reroute/undo');
  assert.equal(undo.body.undone, 0); assert.deepEqual(undo.body.skipped, [m.title]);
});

test('server rejects a tampered plan that moves a meeting', async () => {
  const c = await client(await start({ ai: createAi({}) }));
  const evs = (await c.get('/api/events')).body.events;
  const hash = (await c.get('/api/reroute/plan')).body.planHash;
  const m = evs.find((e) => e.kind === 'meeting');
  assert.equal((await c.post('/api/reroute/apply', { moves: [{ eventId: m.id, to: { start: m.start, end: m.end } }], planHash: hash })).status, 409);
});

test('OAuth: callback with missing or wrong state is rejected; google start fails cleanly when unconfigured', async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  const c = await client(await start({ ai: createAi({}) }));
  assert.equal((await c.raw('/auth/google')).status, 400);
  assert.equal((await c.raw('/auth/callback?code=x&state=nope')).status, 400);
});

// ---- AI contract tests with a MOCK provider (no live LLM was called) ----
const fakeFetch = (content, status = 200) => async () => ({ ok: status === 200, status, json: async () => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }) });

test('AI: parsePrefs output is sanitized to a safe schema', async () => {
  const ai = createAi({ AI_API_KEY: 'k' }, fakeFetch({ earliestHour: 9, latestHour: 12, bufferMin: 9999, preferPart: 'night', sameDayOnly: 'yes', evil: 'rm -rf' }));
  assert.deepEqual(await ai.parsePrefs('mornings'), { earliestHour: 9, latestHour: 12 });
});
test('AI: invalid JSON from the provider is an error, not a crash', async () => {
  const ai = createAi({ AI_API_KEY: 'k' }, fakeFetch('not json'));
  await assert.rejects(() => ai.parsePrefs('x'), /invalid JSON/);
});
test('AI: ranking can only pick options the engine already produced; junk is dropped', async () => {
  const plan = { moves: [{ eventId: 'p', title: 'P', reason: 'r', options: [{ start: 'a', end: 'b' }, { start: 'c', end: 'd' }] }] };
  const ai = createAi({ AI_API_KEY: 'k' }, fakeFetch({ choices: [{ eventId: 'p', option: 7 }, { eventId: 'ghost', option: 0 }], explanation: 'P ok '.repeat(300) }));
  const r = await ai.rank(plan);
  assert.deepEqual(r.choices, {}); assert.ok(r.explanation.length <= 400);
});

test('AI on: explanation shown, choice honored, and an AI-picked option is still re-validated by the server', async () => {
  let seenBody;
  const ai = createAi({ AI_API_KEY: 'k' }, async (u, o) => { seenBody = JSON.parse(o.body); const it = JSON.parse(seenBody.messages[1].content).items[0]; return fakeFetch({ choices: [{ eventId: it.eventId, option: 1 }], explanation: `Your ${it.blockTitle} block moves to the next free hour.` })(); });
  const c = await client(await start({ ai }));
  await armFlexible(c); await c.post('/api/demo/disrupt');
  const plan = (await c.get('/api/reroute/plan')).body;
  assert.equal(plan.ai.status, 'ok'); assert.equal(plan.ai.explanation, `Your ${plan.moves[0].title} block moves to the next free hour.`);
  if (plan.moves[0].options.length > 1) assert.equal(plan.moves[0].optionIndex, 1);
  assert.equal((await c.post('/api/reroute/apply', { moves: plan.moves, planHash: plan.planHash })).status, 200);
});

test('AI outage falls back to the rules plan and says so', async () => {
  const ai = createAi({ AI_API_KEY: 'k' }, fakeFetch({}, 500));
  const c = await client(await start({ ai }));
  await armFlexible(c); await c.post('/api/demo/disrupt');
  const plan = (await c.get('/api/reroute/plan')).body;
  assert.equal(plan.ai.status, 'error'); assert.ok(plan.moves.length >= 1);
});

test('AI prefs steer slot choice but cannot break hard rules', async () => {
  const ai = createAi({ AI_API_KEY: 'k' }, async (u, o) => { const m = JSON.parse(o.body).messages[0].content; return fakeFetch(m.startsWith('Convert') ? { latestHour: 23, earliestHour: 0, bufferMin: 30 } : { choices: [], explanation: '' })(); });
  const c = await client(await start({ ai }));
  assert.equal((await c.post('/api/ai/prefs', { text: 'anytime, with buffers' })).status, 200);
  await armFlexible(c); await c.post('/api/demo/disrupt');
  const plan = (await c.get('/api/reroute/plan')).body;
  for (const m of plan.moves) { const h = new Date(m.to.start).getHours(); assert.ok(h >= 9 && new Date(m.to.end).getHours() <= 18); }
});

test('static page served', async () => {
  const r = await fetch((await start({ ai: createAi({}) })) + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /Reroute my day/);
});

test('AI explanation that names no moved block, or contains numbers, is dropped (grounding check)', async () => {
  const plan = { moves: [{ eventId: 'p', title: 'Deep work', reason: 'r', options: [{ start: 'a', end: 'b' }] }] };
  const mk = (x) => createAi({ AI_API_KEY: 'k' }, fakeFetch({ choices: [], explanation: x })).rank(plan);
  assert.equal((await mk('Everything is fine.')).explanation, '');
  assert.equal((await mk('Deep work moves to 3pm.')).explanation, '');
  assert.equal((await mk('Deep work moves later.')).explanation, 'Deep work moves later.');
});

test('AI: falls through the model list when the first model fails', async () => {
  const seen = [];
  const f = async (u, o) => { const m = JSON.parse(o.body).model; seen.push(m); return m === 'a:free' ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"earliestHour":10,"latestHour":16}' } }] }) }; };
  const ai = createAi({ AI_API_KEY: 'k', AI_MODEL: 'a:free,b:free' }, f);
  assert.deepEqual(await ai.parsePrefs('x'), { earliestHour: 10, latestHour: 16 });
  assert.deepEqual(seen, ['a:free', 'b:free']);
});

test('healthz works without a session; Secure cookie when behind an https proxy', async () => {
  const base = await start({ ai: createAi({}) });
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const r = await fetch(base + '/api/mode', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(r.headers.get('set-cookie'), /Secure/);
});
test('AI endpoints are rate limited per session', async () => {
  const ai = createAi({ AI_API_KEY: 'k' }, fakeFetch({ earliestHour: 9, latestHour: 17 }));
  const c = await client(await start({ ai }));
  let last;
  for (let i = 0; i < 32; i++) last = await c.post('/api/ai/prefs', { text: 'mornings' });
  assert.equal(last.status, 429);
});

test('AI: non-free models are dropped unless ALLOW_PAID_MODELS=1', () => {
  assert.equal(createAi({ AI_API_KEY: 'k', AI_MODEL: 'openai/gpt-4o,x:free' }).model, 'x:free');
  assert.equal(createAi({ AI_API_KEY: 'k', AI_MODEL: 'openai/gpt-4o', ALLOW_PAID_MODELS: '1' }).model, 'openai/gpt-4o');
});
