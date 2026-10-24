# Frontend Guide (HTML, CSS, JavaScript)

## 1. Scope
The frontend is a **view and decision layer**. It shows state from the backend and sends user decisions. It never enforces security, executes tool actions, or stores secrets.

## 2. Screens
1. **Dashboard** — pending alerts count, recent actions, agent status, kill switch.
2. **Alert / Review** — full action details, intent, risk badge, reasons, content preview, diff if changed; buttons **Approve** and **Reject** (equal size, no pre-selected default); re-auth modal for HIGH/CRITICAL.
3. **Tools** — catalog cards (Gmail, Calendar, Clock, WhatsApp, Instagram, LinkedIn, X, Payments, Blog), connect/disconnect, MOCK/LIVE badge.
4. **Permissions** — per agent → per tool → per operation toggles (default OFF), limits form.
5. **Activity / Audit timeline** — filters, status chips, integrity check result, export (Pro).
6. **Agents** — create, pause, rotate key (shown once), choose model.
7. **Plans** — Starter / Plus / Pro comparison, current plan, locked features labelled.
8. **Settings** — notifications, clear local cache, theme. No setting to disable approvals.

## 3. Status display
Distinct label + color + icon for: `PENDING_REVIEW, NEEDS_REVIEW, APPROVED, REJECTED, EXPIRED, BLOCKED, SUBMITTED, COMPLETED, FAILED, UNKNOWN`. Never show "Done" for `APPROVED` or `SUBMITTED`.

## 4. Rules
- Fetch with `credentials: 'include'`; send CSRF header on POST/PUT/DELETE.
- Render agent-supplied text with `textContent`, never `innerHTML`.
- Approve request must send the `payloadHash` shown on screen.
- Show countdown to approval expiry.
- Mobile-first (360px+), keyboard accessible, ARIA labels, light/dark themes.
- PWA: `manifest.webmanifest`, service worker caching static assets only (never API responses with personal data).
- No frameworks unless the owner approves; ES modules in `frontend/js/`.

## 5. Suggested JS modules
`api.js` (fetch wrapper), `state.js`, `router.js`, `views/*.js`, `components/riskBadge.js`, `components/statusChip.js`, `realtime.js` (SSE), `push.js`.
