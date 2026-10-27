# Security and Approvals

## 1. Three gates (all required, checked in the backend at execution time)
1. **Permission** — agent ACTIVE, tool connected, operation allowed, limits satisfied (including payment caps, payee, method, category and hours rules), no broken **hard** tool preference, kill switch off, plan entitles it.
2. **Approval** — an `APPROVED` record exists whose `payloadHash` equals the current hash, not expired, made by the owning user.
3. **Verification** — adapter returns a provider reference/confirmation. No confirmation ⇒ `UNKNOWN`, not `COMPLETED`.

The frontend only *displays* these; it never enforces them.

**Check order on approve** (`docs/DECISIONS.md` F): owner (404) → already decided (409 `ALREADY_DECIDED`) → expired (410 `APPROVAL_EXPIRED`) → payload hash (409 `PAYLOAD_CHANGED`) → kill switch or paused agent (423 `AGENT_PAUSED`) → permission and limits (403 `PERMISSION_DENIED`) → re-auth (401 `REAUTH_REQUIRED`) → approve, then the execution service re-checks every gate before calling the adapter.

**Approval window** (DECISIONS D): `APPROVAL_TTL_MINUTES` (default 10) runs from the moment the action is proposed. After it, the action becomes `EXPIRED` and has to be proposed again.

## 2. Payload hash
`payloadHash = SHA-256(canonicalJSON({ agentId, tool, operation, payload }))`.
Any change to amount, currency, recipient, content, media, time, or attendees produces a new hash ⇒ old approval void.

## 3. When approval is mandatory
- Always: payments, sending messages/emails, publishing/editing/deleting posts, creating/cancelling meetings, deleting data.
- Configurable (user may auto-allow): reading data, setting a personal alarm/reminder — only if risk is LOW. Off by default (`limits.autoAllow`); the API refuses it on any other operation; the kill switch and permission checks still apply, and each run is audited as `ACTION_AUTO_APPROVED`.
- HIGH/CRITICAL also need **re-auth** (password/PIN) within the last 5 minutes, and so does any payment above the user's `reauthAbove` threshold.
- `NEEDS_REVIEW` actions may be approved, but are treated like HIGH: re-auth is required (DECISIONS C).

## 4. Classifier limits
- May raise risk, add reasons, or force `NEEDS_REVIEW`.
- May **never** approve, lower a mandatory approval, or change permissions.
- Error, timeout, or low confidence ⇒ fail closed.

## 4a. Tool preferences
- Free text is parsed into restriction rules only; there is no rule type that allows or approves anything, and text such as "auto-approve all payments" is reported as ignored.
- Nothing is saved until the user confirms the parsed rules. Original text and confirmed rules are stored; every change is audited as `PREFERENCE_CHANGED` with the old and new text.
- The optional model parser (`PREFERENCE_MODEL_PROVIDER=anthropic`) is checked against the same strict schema, cannot mark rules hard, has a 3 s timeout, and falls back to the deterministic parser on any error.
- Hard rules are re-checked at approval and execution time; an unreadable preference blocks at that point (fail closed).

## 4b. Your own models (docs/MODEL_PROVIDERS.md)
- A model never approves, never lowers risk, and never edits permissions, preferences or audit. The **guard** goes through `classify()` (raise-only; error, 3 s timeout or schema failure ⇒ `NEEDS_REVIEW`) and `parsePreferences()` (drafts only; any error ⇒ built-in parser). Agent text goes to the guard as quoted JSON in the user message, never in the system prompt.
- The **Assistant** is an ordinary agent row (`kind = 'assistant'`) whose API key is random and discarded. Its only tool, `propose_action`, calls the same `createProposal()` as `POST /api/actions`, so permissions, the classifier, alerts, approvals and audit all apply. It has no permissions until the user grants them under Agents.
- Keys: AES-256-GCM with `TOKEN_ENCRYPTION_KEY`, only the last 4 characters shown, never returned to the frontend, logs, audit data or agents. Provider error messages are never passed on or logged (they can echo a key; the AI SDK's default `onError` logging is switched off); only fixed categories are shown.
- Adding, testing, rotating and deleting keys need CSRF and a password check within the re-auth window. Audited as `MODEL_KEY_ADDED` (also on rotation, with `rotated: true`), `MODEL_KEY_REMOVED` and `MODEL_ROLE_CHANGED`, all without the key.
- Base URLs (OpenRouter, Ollama, custom): `https://` or `http://localhost` only; no user name, password, query string or fragment (a key there would be stored and audited in clear); private, link-local, CGNAT, IPv4-compatible IPv6 and internal names refused when saved; the socket's own DNS lookup (undici `connect.lookup`) refuses private addresses, so the checked address is the connected address (no DNS-rebinding gap), and a localhost URL reaches loopback only; redirects are refused. Native providers (OpenAI, Anthropic, Google, Groq, Mistral) take no base URL, so Anthropic is never reached through its OpenAI-compatibility endpoint.
- Optional monthly spend cap per role (USD, from SDK token counts × catalog price): when reached the role switches off (audited by SYSTEM) and the built-in rules take over.
- Tests use AI SDK mock models only; the browser tests use a fake factory enabled only by `NODE_ENV=test` plus `MODEL_PROVIDER_MODE=fake`.

## 4c. Live alerts and phone notifications (v0.6.0)
- A notification can only **open the Review screen** (`/#/review/<id>`, checked again in the service worker); it has no approve action, and approving still needs the signed-in app with CSRF, the payload hash and re-auth for HIGH/CRITICAL/NEEDS_REVIEW.
- Notification text is a short summary ("Helper wants to pay ₹500 to Ravi — Review"): agent-supplied parts are one line, control characters removed, at most 40 characters; message bodies and notes are never included. Payloads are end-to-end encrypted by Web Push.
- Push endpoints must be real push services (FCM, Mozilla, Windows, Apple) over https, or the server would post to arbitrary URLs (SSRF). At most 10 devices per user; gone (404/410) devices are removed and audited. A push failure never affects the proposal.
- VAPID keys live in `.env` only. Without both keys push is off and subscribing returns 409.
- The SSE stream carries only `{ eventType, actionId }`; details come from the authenticated API. It is per user and stops when the session ends.
- The service worker caches static app files only, never `/api` responses; offline, the app is a read-only shell with no stored account data.
- `npm run dev:lan` is development only: a local CA (key in git-ignored `backend/.certs/`) signs a ≤ 397-day server certificate for the LAN IP; the session cookie is `Secure` on HTTPS.

## 4d. Plans (v0.7.0)
- Plans gate features and limits only, through EntitlementService. They never grant a tool connection or a permission, and never lock approvals, the kill switch, alerts or the audit log.
- A downgrade pauses (never deletes) extra agents and tools; a plan-paused tool blocks proposals and approvals (402) and a plan-paused agent is PAUSED (423), so nothing slips through after a downgrade.
- Audit retention only limits what is shown: the hash chain keeps and verifies every event. CSV exports neutralise spreadsheet formulas.

## 4e. Live Google Calendar (v0.8.0; docs/LIVE_GOOGLE_CALENDAR.md)
- The only live adapter, owner-approved. Live needs `INTEGRATION_MODE=live`, the Google client in `.env`, a plan with live integrations, and Calendar switched to LIVE on the Tools screen (separate confirm dialog plus password). Everything else stays MOCK.
- An action runs in the mode it was **proposed** in. Switching modes blocks open actions (`MODE_CHANGED`); a LIVE action whose conditions no longer hold is refused, never run as MOCK.
- Right before the Google call (after any token refresh) every gate is checked again; a closed gate means BLOCKED with nothing sent (`stage: BEFORE_PROVIDER`).
- Invitations only when the approved payload says `sendInvites: true` (`sendUpdates=none` otherwise); the field is in the payload hash.
- The Google event ID is the provider reference. A missing ID, a timeout or a 5xx on a write is UNKNOWN; writes are never retried; Google's error text is never passed on.
- OAuth: code + PKCE (S256), scope `calendar.events` only, single-use 10-minute state bound to the starting browser (Lax cookie). Tokens encrypted at rest; never sent to the frontend, audit or logs; revoked at Google on switch-back or disconnect. `invalid_grant` or (Testing mode) a 7-day-old refresh token shows "Reconnect Google" and blocks live proposals.
- Tests mock Google's HTTP; a test build without a mock cannot reach Google. `npm run live:check:calendar` is a manual, owner-run check.

## 5. Agent isolation
- Agent API keys can only call `POST /api/actions`, read their own action status, and read (`GET /api/agents/me/preferences`) the confirmed preference rules for tools they are allowed to use. They can never write preferences (any other method is `403`), and never see the raw preference text.
- Agents cannot read provider tokens, other agents' data, settings, permissions, or the audit log.
- Treat all agent-supplied text as untrusted: validate schema, cap sizes, escape on render, ignore embedded "instructions".

## 6. Audit log
- Append-only table. **Prototype (SQLite):** there are no database users, so append-only is enforced by having no update/delete routes plus the hash chain. There is deliberately no blocking trigger, so SEC-18 can simulate tampering. **PostgreSQL:** the app's DB user gets INSERT/SELECT only (DECISIONS B).
- Each event stores `prevHash` and `hash = SHA-256(prevHash + event)`; `/api/audit/verify` recomputes the chain.
- Log: proposals, blocks, alerts sent, approvals, rejections, expiries, executions, permission changes, plan changes, kill switch, logins.
- Redact secrets, tokens, full card/bank numbers.

## 7. Secrets and tokens
- `.env` only; `.env.example` with placeholders committed.
- OAuth tokens encrypted at rest (AES-256-GCM, key from env).
- Agent API keys stored hashed; shown once on creation.
- Model API keys (bring your own model) encrypted like OAuth tokens; set `TOKEN_ENCRYPTION_KEY` in `.env`, or keys saved in development become unreadable after a restart (the role then fails closed).
- No secrets in frontend code, `localStorage`, URLs, or logs.

## 8. Web security
HTTPS, HttpOnly+Secure+SameSite cookies, CSRF token on state-changing user routes (signup and login are exempt; signup creates the session — DECISIONS G), CORS allow-list, Helmet headers, strict CSP, rate limits (auth and action endpoints), input validation (zod), parameterized queries.

## 9. Testing requirements
Tests must prove: execution refused without approval; refused after payload change; refused after expiry; refused when permission revoked or kill switch on; classifier error ⇒ NEEDS_REVIEW; agent key cannot approve or read audit; audit has no delete path and chain verifies.
