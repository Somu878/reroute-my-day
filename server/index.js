import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { proposeReroute, validateMoves } from './reroute.js';
import { DemoStore } from './demo.js';
import { createAi } from './ai.js';
import { googleConfigured, authUrl, exchangeCode, GoogleStore, newState } from './google.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

// Minimal .env loader (no dependency). Existing env vars win.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const opts = (prefs) => ({
  workStart: +(process.env.WORK_START || 9), workEnd: +(process.env.WORK_END || 18), searchDays: +(process.env.SEARCH_DAYS || 3), prefs: prefs || {},
});

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sign = (sid) => crypto.createHmac('sha256', SECRET).update(sid).digest('hex').slice(0, 32);
const TTL = 8 * 3600 * 1000, MAX_SESSIONS = 1000;
const sessions = new Map();

function newSession(res) {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.last > TTL) sessions.delete(k);
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const sid = crypto.randomBytes(16).toString('hex');
  const s = { sid, last: now, csrf: crypto.randomBytes(16).toString('hex'), undo: [], lock: Promise.resolve(), aiCache: new Map() };
  sessions.set(sid, s);
  const secure = /^https:/.test(process.env.GOOGLE_REDIRECT_URI || '') ? '; Secure' : '';
  res.setHeader('set-cookie', `sid=${sid}.${sign(sid)}; HttpOnly; SameSite=Lax; Path=/${secure}`);
  return s;
}
function getSession(req, res) {
  const m = /(?:^|; )sid=([a-f0-9]+)\.([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) {
    const ok = m[2].length === 32 && crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sign(m[1])));
    const s = ok && sessions.get(m[1]);
    if (s && Date.now() - s.last < TTL) { s.last = Date.now(); return s; }
  }
  return newSession(res);
}

// Everything a session touches is its own: demo calendar, undo stack, Google tokens, prefs.
function storeFor(sess, storeFactory) {
  if (sess.google) return { store: (sess.gstore ||= new GoogleStore(sess.google)), mode: 'google' };
  return { store: (sess.demo ||= storeFactory ? storeFactory() : new DemoStore()), mode: 'demo' };
}

const planHash = (events) => crypto.createHash('sha1').update(events.map((e) => `${e.id}|${e.start}|${e.end}`).sort().join('\n')).digest('hex');
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok, bad) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 100000) { bad(new Error('Body too large')); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } });
});
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const locked = (sess, fn) => { const run = sess.lock.then(fn); sess.lock = run.catch(() => {}); return run; };

export function createServer({ ai = createAi(), storeFactory } = {}) {
  async function buildPlan(sess, store) {
    const events = await store.list();
    const hash = planHash(events);
    const o = opts(sess.prefs);
    const plan = proposeReroute(events, o);
    const out = { ...plan, planHash: hash, ai: { enabled: ai.enabled, status: ai.enabled ? 'skipped' : 'off', explanation: '', prefsText: sess.prefsText || null, prefs: sess.prefs || {} } };
    if (!ai.enabled || !plan.moves.length) return out;
    const key = hash + JSON.stringify(sess.prefs || {});
    let r = sess.aiCache.get(key);
    if (!r || (r.error && Date.now() - r.at > 30000)) {
      try { r = { ...(await ai.rank(plan, sess.prefsText)), at: Date.now() }; } catch (e) { r = { error: e.message, at: Date.now() }; }
      sess.aiCache.set(key, r);
    }
    if (r.error) { out.ai.status = 'error'; out.ai.error = 'AI unavailable, showing the rules-only plan.'; return out; }
    const ranked = proposeReroute(events, { ...o, choices: r.choices });
    // Authoritative re-check: AI choices only survive if the engine's own validation passes.
    if (validateMoves(events, ranked.moves, o).length) { out.ai.status = 'rejected'; return out; }
    return { ...ranked, planHash: hash, ai: { ...out.ai, status: 'ok', explanation: r.explanation } };
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const sess = getSession(req, res);
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Bad origin' });
        const tok = req.headers['x-csrf-token'] || '';
        if (tok.length !== sess.csrf.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(sess.csrf))) return json(res, 403, { error: 'Missing or bad CSRF token. Reload the page.' });
      }
      if (url.pathname === '/api/mode') return json(res, 200, { mode: sess.google ? 'google' : 'demo', googleAvailable: googleConfigured(), aiEnabled: ai.enabled, csrf: sess.csrf, workStart: opts().workStart, workEnd: opts().workEnd });
      if (url.pathname === '/auth/google') {
        if (!googleConfigured()) return json(res, 400, { error: 'Google is not configured. Fill GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.' });
        sess.oauthState = newState(); res.writeHead(302, { location: authUrl(sess.oauthState) }); return res.end();
      }
      if (url.pathname === '/auth/callback') {
        const got = url.searchParams.get('state') || '', want = sess.oauthState || '';
        delete sess.oauthState; // one-time use
        if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return json(res, 400, { error: 'Bad OAuth state' });
        if (url.searchParams.get('error') || !url.searchParams.get('code')) return json(res, 400, { error: 'Google sign-in was cancelled or failed' });
        const t = await exchangeCode(url.searchParams.get('code'));
        // Rotate session id and CSRF token on login (prevents session fixation).
        sessions.delete(sess.sid);
        const fresh = newSession(res);
        fresh.google = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
        res.writeHead(302, { location: '/' }); return res.end();
      }
      if (url.pathname === '/auth/disconnect' && req.method === 'POST') { delete sess.google; delete sess.gstore; sess.undo = []; return json(res, 200, { ok: true }); }

      const { store, mode } = storeFor(sess, storeFactory);
      if (url.pathname === '/api/events' && req.method === 'GET') return json(res, 200, { mode, events: await store.list() });
      if (url.pathname === '/api/reroute/plan' && req.method === 'GET') return json(res, 200, await buildPlan(sess, store));
      if (url.pathname === '/api/ai/prefs' && req.method === 'POST') {
        if (!ai.enabled) return json(res, 400, { error: 'AI is not configured (no AI_API_KEY). Rules-only mode.' });
        const { text = '' } = await body(req);
        if (!String(text).trim()) { sess.prefs = {}; sess.prefsText = null; return json(res, 200, { prefs: {} }); }
        try { sess.prefs = await ai.parsePrefs(text); sess.prefsText = String(text).slice(0, 500); } catch (e) { return json(res, 502, { error: `Could not interpret that: ${e.message}` }); }
        return json(res, 200, { prefs: sess.prefs });
      }
      if (url.pathname === '/api/reroute/apply' && req.method === 'POST') {
        const { moves = [], planHash: clientHash } = await body(req);
        return locked(sess, async () => {
          const events = await store.list();
          if (clientHash !== planHash(events)) return json(res, 409, { error: 'Your calendar changed since this plan was made. Nothing was moved. Review the new plan.', stale: true });
          if (!Array.isArray(moves) || !moves.length || new Set(moves.map((m) => m.eventId)).size !== moves.length) return json(res, 400, { error: 'Invalid move list' });
          const errs = validateMoves(events, moves, opts(sess.prefs));
          if (errs.length) return json(res, 409, { error: errs.join('; ') });
          const done = [];
          try {
            for (const m of moves) {
              const ev = events.find((e) => e.id === m.eventId);
              await store.move(m.eventId, m.to.start, m.to.end);
              done.push({ eventId: m.eventId, title: ev.title, start: ev.start, end: ev.end, to: { start: m.to.start, end: m.to.end } });
            }
          } catch (e) {
            // Compensating rollback. Report honestly if it is incomplete.
            const failed = [];
            for (const b of [...done].reverse()) { try { await store.move(b.eventId, b.start, b.end); } catch { failed.push(b.title); } }
            if (failed.length) return json(res, 502, { partial: true, restoreFailed: failed, error: `Apply failed (${e.message}) and these blocks could not be moved back: ${failed.join(', ')}. Check your calendar.` });
            return json(res, 502, { error: `Nothing was changed. ${e.message}` });
          }
          sess.undo.push(done);
          return json(res, 200, { applied: done.length, canUndo: true });
        });
      }
      if (url.pathname === '/api/reroute/undo' && req.method === 'POST') {
        return locked(sess, async () => {
          const batch = sess.undo.pop();
          if (!batch) return json(res, 409, { error: 'Nothing to undo' });
          const cur = await store.list();
          const restored = [], skipped = [];
          for (const b of batch) {
            const now = cur.find((e) => e.id === b.eventId);
            // Only undo if the event is still where we put it. Never overwrite later edits.
            if (!now || new Date(now.start).getTime() !== new Date(b.to.start).getTime()) { skipped.push(b.title); continue; }
            try { await store.move(b.eventId, b.start, b.end); restored.push(b.title); } catch { skipped.push(b.title); }
          }
          return json(res, 200, { undone: restored.length, skipped });
        });
      }
      const fm = /^\/api\/events\/([^/]+)\/flexible$/.exec(url.pathname);
      if (fm && req.method === 'POST') { const { flexible } = await body(req); await store.setFlexible(decodeURIComponent(fm[1]), flexible); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/demo/disrupt' && req.method === 'POST') { if (mode !== 'demo') return json(res, 400, { error: 'Demo only' }); return json(res, 200, { added: await store.disrupt() }); }
      if (url.pathname === '/api/demo/reset' && req.method === 'POST') { if (mode !== 'demo') return json(res, 400, { error: 'Demo only' }); store.reset(); sess.undo = []; return json(res, 200, { ok: true }); }

      let f = url.pathname === '/' ? '/index.html' : url.pathname;
      const full = path.normalize(path.join(PUBLIC, f));
      if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" }); fs.createReadStream(full).pipe(res);
    } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = +(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`Reroute my day on http://localhost:${port}  (${googleConfigured() ? 'Google configured' : 'demo mode'})`));
}
