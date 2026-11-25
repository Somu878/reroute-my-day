// Google Calendar adapter. NOT exercised by the automated tests (needs real credentials).
// Uses plain fetch against the REST API. Flexible flag is stored in extendedProperties.private.
// Scope is the minimum: calendar.events (read/write events on calendars you can edit).
import crypto from 'node:crypto';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export const googleConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function authUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
  });
  return `${AUTH}?${p}`;
}

async function tokenCall(params) {
  const r = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google token error: ${j.error_description || j.error}`);
  return j;
}
export const exchangeCode = (code) => tokenCall({ code, grant_type: 'authorization_code', redirect_uri: process.env.GOOGLE_REDIRECT_URI });

export class GoogleStore {
  // session: { access_token, refresh_token, expires_at }
  constructor(session) { this.s = session; this.etags = new Map(); }
  async token() {
    if (Date.now() > this.s.expires_at - 30000 && this.s.refresh_token) {
      const j = await tokenCall({ refresh_token: this.s.refresh_token, grant_type: 'refresh_token' });
      this.s.access_token = j.access_token; this.s.expires_at = Date.now() + j.expires_in * 1000;
    }
    return this.s.access_token;
  }
  async call(path, opts = {}) {
    const r = await fetch(API + path, { ...opts, headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 412) throw new Error('This event changed in Google Calendar since the plan was made. Refresh and try again.');
    if (!r.ok) throw new Error(`Google Calendar ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  async list() {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 7);
    const out = []; let pageToken = '';
    this.etags.clear();
    do {
      const j = await this.call(`/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
      for (const e of j.items || []) { const m = mapGoogleEvent(e); if (m) { this.etags.set(e.id, e.etag); out.push(m); } }
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  async move(id, start, end) {
    await this.call(`/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`, {
      method: 'PATCH', headers: this.etags.has(id) ? { 'if-match': this.etags.get(id) } : {},
      body: JSON.stringify({ start: { dateTime: start }, end: { dateTime: end } }),
    });
  }
  async setFlexible(id, flexible) {
    await this.call(`/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`, {
      method: 'PATCH', body: JSON.stringify({ extendedProperties: { private: { reroute_flexible: String(!!flexible) } } }),
    });
  }
  async disrupt() { throw new Error('Disrupt is a demo-only helper. It never writes to your real calendar.'); }
}

// Pure mapping from a Google event resource to our model. Conservative by design:
//  - cancelled, "free" (transparent) and declined events do not block time and are skipped
//  - opaque all-day events block the whole day(s) as fixed events
//  - anything with other attendees, or not owned by the user, is a fixed meeting
//  - recurring instances are fixed (editing one instance is easy to get wrong, so we never move them)
export function mapGoogleEvent(e) {
  if (!e || e.status === 'cancelled') return null;
  if (e.transparency === 'transparent') return null;
  const me = (e.attendees || []).find((a) => a.self);
  if (me && me.responseStatus === 'declined') return null;
  const title = e.summary || '(no title)';
  if (e.start?.date && !e.start.dateTime) {
    const ymd = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };
    const start = ymd(e.start.date);
    const end = e.end?.date ? ymd(e.end.date) : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return { id: e.id, title, start: start.toISOString(), end: end.toISOString(), kind: 'meeting', allDay: true, flexible: false };
  }
  if (!e.start?.dateTime || !e.end?.dateTime) return null;
  const others = (e.attendees || []).filter((a) => !a.self).length;
  const mine = !!(e.organizer?.self || e.creator?.self);
  const personal = others === 0 && mine;
  const recurring = !!e.recurringEventId;
  return { id: e.id, title, start: e.start.dateTime, end: e.end.dateTime, kind: personal ? 'personal' : 'meeting', attendees: others,
    recurring, flexible: personal && !recurring && e.extendedProperties?.private?.reroute_flexible === 'true' };
}

export const newState = () => crypto.randomBytes(16).toString('hex');
