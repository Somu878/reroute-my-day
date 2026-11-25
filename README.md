# Reroute my day

Google Maps reroutes you when traffic changes. Calendar does nothing when your day breaks. This prototype fixes that: when a meeting lands on top of a personal work block, it proposes a repaired schedule directly on the calendar, shows before/after as dashed ghost blocks, and applies it in one click (with undo).

## Run (no install, no dependencies, Node 20+)

    cp .env.example .env     # optional for demo mode
    npm start                # http://localhost:3000
    npm test                 # 48 tests

Demo mode needs nothing. Click "Simulate: urgent meeting lands" to break the plan, review the proposal, press Apply, then Undo.

## Product rules (the thinking)
- One trigger, done well: a meeting overlaps a personal block you marked flexible (click the ⇄ on a block).
- Meetings with other people are never moved. Only your own flexible blocks move.
- Moves stay inside working hours, keep their duration, skip weekends, and never create a new overlap. Prefers the slot closest to the original time, same day first.
- Honest failure: if nothing fits in the search window, it says so and moves nothing.
- The user commits: nothing changes until Apply. Applied batches are all-or-nothing (rolled back if a write fails) and undoable.
- The server re-validates every plan before applying, so a tampered client cannot move meetings.

## AI layer (optional, off by default)
Set AI_API_KEY (OpenRouter by default; AI_BASE_URL and AI_MODEL, a comma-separated fallback list, are optional) in `.env`. Without a key the UI says "AI: off (rules only)" and shows no AI text.
With a key the model does two things only:
1. Turns a free-text preference ("keep focus work in the morning, leave 30 min buffers") into a validated object (earliest/latest hour, morning/afternoon, buffer, same-day-only) that the rules engine enforces.
2. Picks among up to 3 slots the engine already proved valid, and writes a 2-sentence explanation (shown labeled "AI-generated").
It cannot propose a time of its own, cannot move meetings, and never writes to the calendar. Its output is schema-sanitized, and the server re-validates the final plan. Event titles are passed as data. If the provider fails, you get the rules-only plan with a notice. The live provider call is UNVERIFIED (tests use a mock provider).

## Security notes
Per-session demo calendar and tokens (no shared state between visitors); signed HttpOnly SameSite=Lax session cookie, rotated on Google login; CSRF token header plus Origin check on every POST; one-time OAuth state, timing-safe compare; CSP and nosniff on pages; body size cap; sessions expire after 8h. Apply is serialized per session, refuses stale plans (calendar hash), is all-or-nothing with compensating rollback, and says exactly which blocks are stuck if rollback fails. Undo skips any block you have edited since. Tokens live in server memory only. Run it locally or behind HTTPS; it is not hardened for public multi-tenant hosting.

## Calendar safety (Google)
Cancelled, "free" (transparent) and declined events are ignored. Opaque all-day events block the whole day. Events with other attendees or owned by someone else are fixed meetings. Recurring instances are never moved. Paginated reads.

## Deploy on Render (free plan)
`render.yaml` is a Blueprint: New > Blueprint > pick this repo. It uses the Free plan, generates SESSION_SECRET, and prompts for AI_API_KEY (optional, leave blank for rules-only). The public instance runs demo mode: every visitor gets their own private sample calendar, nobody can see or change anyone else's, and no Google account is touched. Free services sleep after 15 minutes idle (about 1 minute to wake) and lose in-memory state when they restart.
To enable live Google on the deployed copy, also set OWNER_EMAIL (only that Google account can connect; strongly recommended on a shared host), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI=https://<your-service>.onrender.com/auth/callback (and add that exact URI in Google Cloud). Each visitor then connects their own Google account; tokens live only in that visitor's server session. While the Google app is in Testing, only listed test users can connect. AI calls are rate-limited (30 per visitor per hour, 300 total per hour) so a public demo cannot drain your OpenRouter key.

## Layout
- server/reroute.js  pure logic (detect, find slot, validate)
- server/demo.js     in-memory demo calendar
- server/google.js   Google Calendar adapter (OAuth + REST)
- server/index.js    HTTP API + static server
- public/            week grid, ghost blocks, proposal panel
- test/              unit and API tests

## Connecting Google (you do this part)
1. Google Cloud Console: create a project, enable Google Calendar API.
2. OAuth consent screen (add yourself as a test user), then create an OAuth client, type Web application, redirect URI `http://localhost:3000/auth/callback`.
3. Put GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET in `.env`. Restart. A "Connect Google Calendar" button appears.
Scopes used: `calendar.events`, plus `openid email` only to check OWNER_EMAIL. Events with other attendees, or that you don't organize, count as meetings. The flexible flag is saved on the event as a private extended property. Writes use If-Match etags and sendUpdates=none.

## Known limits
- Google adapter and the live AI provider are written but NOT tested against real accounts. Only the mapping logic and mocked contracts are tested.
- Sessions and the demo calendar are in memory (restart resets). Week view shows the next 5 weekdays. Time zone and working hours come from TZ/WORK_START/WORK_END of the server.
- SESSION_SECRET signs the session cookie (random per restart if unset).
- Single trigger by design. Natural next steps: overrun detection, recurring-event handling.
