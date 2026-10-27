# Live Google Calendar (v0.8.0)

The first LIVE adapter, approved by the owner for **Google Calendar only**. Every other tool stays MOCK.

## When an action is live
All of these must hold, and they are checked again right before each Google call:
1. `INTEGRATION_MODE=live` in `backend/.env`.
2. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `backend/.env`.
3. A plan with `liveIntegrations` (Plus or Pro).
4. Calendar switched to LIVE on the Tools screen: its own confirm dialog plus your password, then Google's consent screen.
5. The action was **proposed** while Calendar was LIVE. Switching modes blocks open actions; a LIVE action never runs as MOCK.

## Set up (owner, once)
1. Google Cloud console → APIs & Services → enable **Google Calendar API**.
2. OAuth consent screen: External, Testing; add your own Google account as a test user; scope `.../auth/calendar.events` only.
3. Credentials → OAuth client ID → **Web application**; authorized redirect URI `https://localhost:4443/api/oauth/google/callback`.
4. Put the client ID and secret in `backend/.env` (never in git), with `INTEGRATION_MODE=live` and a fixed `TOKEN_ENCRYPTION_KEY`
   (otherwise stored tokens become unreadable after a restart).
5. `npm run dev:lan`, open **https://localhost:4443** (Google accepts localhost redirects only), Tools → Calendar → **Use live Google Calendar…**.

## Checking it by hand
`cd backend && npm run live:check:calendar` creates one event "AgentGuard live check" an hour from now in your primary
calendar (no attendees, `sendUpdates=none`), then cancels it. It asks first (`-- --yes` skips the question), picks the one
account with Calendar LIVE (`-- --email you@example.com` if there are several), and records `LIVE_CHECK_RUN` in the audit log.
It never runs in CI: the automated tests mock Google's HTTP.

## Payloads (checked when proposed; an invalid one is BLOCKED and never reaches Google)
| Operation | Fields |
|---|---|
| `view` | `from`, `to` (ISO with offset; default the next 7 days), `max` (1–50, default 25) |
| `create` | `title`, `start`, `end` (ISO; without an offset the user's time zone or `timeZone` is used), optional `description`, `location`, `attendees` (emails), `sendInvites` |
| `update` | `eventId` plus at least one of the create fields; `start` and `end` together |
| `cancel` | `eventId`, optional `sendInvites` |

`invite` has no live form (use `update` with `attendees`). Unknown fields are refused.

## Safety
- **Invitations:** `sendUpdates=none` unless the approved payload has `sendInvites: true`. The review screen says which.
- **Hash:** any change to time, attendees, `sendInvites` or anything else is a new payload hash, so it needs a new approval.
- **Re-check:** after any token refresh, the execution service re-checks the approval (unused claim, unexpired, hash), the kill
  switch, the agent, permissions and limits, preferences, the mode and the live conditions. A closed gate means BLOCKED, nothing sent.
- **Verification:** the Google event ID is the provider reference (create uses an ID derived from the action, so it can never be
  made twice). No ID, a timeout or a 5xx on a write means **UNKNOWN** ("check your Google Calendar"); writes are never retried.
  A clear refusal is FAILED with a fixed message; Google's own error text is not passed on.
- **Tokens:** AES-256-GCM in `tool_connections`; never sent to the frontend, the audit log or the logs. Switching back to MOCK or
  disconnecting revokes the grant at Google and deletes the tokens.
- **OAuth:** authorization code + PKCE (S256); `state` is random, single use, 10 minutes, and bound to the browser that started
  it by an HttpOnly SameSite=Lax cookie (the callback is a cross-site navigation, so the Strict session cookie is not sent).
  A narrower scope, a missing refresh token or any error leaves Calendar MOCK; failures are audited as `LIVE_CONNECT_FAILED`.
- **Reconnect:** Google refusing the refresh token (`invalid_grant`: revoked, or the 7-day Testing-mode expiry) marks the
  connection for reconnecting (`LIVE_RECONNECT_NEEDED`); with `GOOGLE_OAUTH_TESTING=true` (default) the app also asks once the
  refresh token is 7 days old. A "Reconnect Google" banner shows on every screen; live proposals get `409 RECONNECT_REQUIRED`.
