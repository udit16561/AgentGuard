# Roadmap

Build in order. Each milestone ends with tests passing and a short report to the owner.

## M0 — Scaffold
Repo layout, `.gitignore`, `.env.example`, lint, test runners, health endpoint, static frontend shell.

## M1 — Core guarded workflow (mock only)  ← first priority
1. User signup/login, one agent with API key.
2. Mock-connect one tool (Payments) and toggle `pay` permission.
3. Agent posts a payment action → permission check → intent/risk → `PENDING_REVIEW`.
4. Dashboard alert → Approve/Reject (hash-bound, expiry, re-auth for HIGH).
5. Backend re-validates gates → MockAdapter → `COMPLETED`.
6. Hash-chained audit timeline + verify.

## M2 — All mock tools
Gmail, Calendar, Clock, WhatsApp, Instagram, LinkedIn, X, Blog adapters in MOCK mode; permission limits UI.

## M2b — Tool preferences and payment limits (v0.4.0)
Payment limits: per-transaction max, daily/weekly/monthly caps, payee rules (allowed, per-payee cap, block or ask for new payees), methods, blocked categories, allowed hours, PIN above a threshold, spend vs. caps on the dashboard.
Tool preferences: free text per tool → deterministic parser (optional small model) → user confirms the rules → every proposal is checked (exact checks, TF-IDF topics, tone lexicon). A broken rule raises risk; a hard rule blocks; nothing is ever approved by a preference. See docs/PREFERENCES.md.

## M2c — Bring your own model (v0.5.0)
Settings → Models: the user's own provider and API key (encrypted, masked), suggested models from `backend/src/models/catalog.json` or any model ID, Test connection with a structured-output capability test, and two optional roles. **Guard:** the intent/risk model layer and the preference parser (raise-only, falls back to the deterministic rules). **Agent:** the Assistant chat, just another agent whose tool calls become proposals. SSRF-checked base URLs, optional monthly spend cap per role, audit without keys. See docs/MODEL_PROVIDERS.md.

## M4 — Realtime + PWA (v0.6.0)
Alerts on the phone are the core of the app, so this comes before plans. Installable PWA (manifest, icons, service worker caching static files only), offline read-only shell, live alerts over SSE, Web Push (VAPID) that opens the Review screen and never approves, phone layout for review and the kill switch, `npm run dev:lan` for HTTPS on the LAN.

## M3 — Plans & entitlements (v0.7.0)
Starter/Plus/Pro through EntitlementService: agents, tools and catalog, audit retention and export (with an integrity report on Pro), phone alerts, model roles. Plans screen with mock switching; locked features say "Upgrade to unlock"; a downgrade pauses, never deletes.

## M5 — Intent model layer
The guard role (v0.5.0) is the first model layer; still to do: evaluation fixtures to measure a guard model's accuracy.

## M6 — First live integration (v0.8.0, owner-approved)
Google Calendar via Google's own OAuth and Calendar API: view, create, update, cancel. LIVE only when switched on per tool (confirm + password) with `INTEGRATION_MODE=live`; gates re-checked right before each call; no invitations unless approved; Reconnect Google banner; manual `npm run live:check:calendar`. Every other tool stays MOCK.

## Later
Native wrappers (Capacitor/Tauri), team accounts, policy templates.
