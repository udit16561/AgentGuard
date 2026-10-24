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

## M3 — Plans & entitlements
Starter/Plus/Pro, gating, locked-feature UI.

## M4 — Realtime + PWA
SSE alerts, web push, installable on PC/mobile, offline shell.

## M5 — Intent model layer
Optional LLM classifier with JSON schema validation and evaluation fixtures.

## M6 — First live integration (owner approval required)
One provider via its official API (e.g., Google Calendar), sandbox/test account first.

## Later
Native wrappers (Capacitor/Tauri), team accounts, policy templates.
