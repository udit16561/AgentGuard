# Architecture and API

## 1. Components

```
[PWA Frontend: PC + Mobile]
        │  HTTPS (cookie session)
        ▼
[Express API] ── auth middleware ── rate limiter
   ├── PolicyService       (permissions, limits, kill switch)
   ├── EntitlementService  (plan features & quotas)
   ├── IntentService       (classify intent + risk; fail closed)
   ├── ApprovalService     (hash-bound approvals, expiry, re-auth)
   ├── ExecutionService    (re-validates gates, calls adapter)
   ├── AuditService        (append-only, hash-chained)
   └── NotificationService (in-app SSE + web push)
        │
        ▼
[Adapters]  gmail · calendar · clock · whatsapp · instagram · linkedin · x · payments · blog
            each has MockAdapter (default) and LiveAdapter (owner-approved only)
        │
[SQLite → PostgreSQL]
```

Agents talk to the backend with a **per-agent API key** (scoped, revocable). Agents never get provider tokens.

## 2. Data models (minimum fields)

- **User**: id, email, passwordHash, planId, timezone, createdAt
- **Agent**: id, userId, name, model, apiKeyHash, status (`ACTIVE|PAUSED|REVOKED`)
- **ToolConnection**: id, userId, tool, status, encryptedToken, scopes[], connectedAt
- **Permission**: id, agentId, tool, operation, allowed (default false), limits (JSON: maxAmount, dailyCap, weeklyCap, monthlyCap, currency, knownPayees, allowedPayees, payeeCaps, newPayees, allowedMethods, blockedCategories, reauthAbove, knownRecipients, allowedRecipients, maxRecipients, timeWindow, enforceHours, autoAllow)
- **ToolPreference**: id, userId, tool, text (≤ 500 chars, as written), rules (JSON, confirmed by the user), updatedAt
- **Action**: id, agentId, tool, operation, payload (JSON), payloadHash, intent, riskLevel, riskScore, riskReasons[], status, preferenceCheck (followed/broken rules, or null), createdAt
- **Approval**: id, actionId, userId, decision (`APPROVED|REJECTED`), payloadHash, reauthUsed, decidedAt, expiresAt
- **Execution**: id, actionId, adapterMode (`MOCK|LIVE`), providerRef, result, error, finishedAt
- **AuditEvent**: id, seq, actorType (`USER|AGENT|SYSTEM`), actorId, eventType, actionId?, data (JSON, secrets redacted), prevHash, hash, createdAt
- **Plan**: id, name, entitlements (JSON)
- **ModelConfig**: id, userId, provider, modelId, label, baseUrl?, apiKeyEnc (AES-256-GCM), keyLast4, lastTestAt, lastTestOk, guardCapable, createdAt
- **ModelRole**: userId, role (`agent|guard`), modelConfigId?, monthlyCapUsd?
- **ModelUsage**: id, userId, role?, modelConfigId, inputTokens, outputTokens, costUsd?, createdAt
- **PushSubscription**: id, userId, endpoint (unique), p256dh, auth, createdAt
- **Agent.kind**: `external` (default) or `assistant` (the built-in Assistant)

## 3. API endpoints

### Auth (user)
- `POST /api/auth/signup` · `POST /api/auth/login` · `POST /api/auth/logout` · `POST /api/auth/reauth` · `GET /api/auth/csrf` (returns `{ token }`; send it as the `X-CSRF-Token` header)

### Agents (user)
- `GET/POST /api/agents` · `PATCH /api/agents/:id` · `POST /api/agents/:id/pause` · `POST /api/agents/:id/rotate-key`
- `POST /api/kill-switch` body `{ on: boolean }` (pause or resume all)

### Tools and permissions (user)
- `GET /api/tools` (catalog + connection state)
- `POST /api/tools/:tool/connect` (mock OAuth) · `DELETE /api/tools/:tool`
- `GET/PUT /api/agents/:id/permissions`
- `GET /api/tools/:tool/preferences` → `{ text, rules[] (with label), updatedAt }`
- `POST /api/tools/:tool/preferences/parse` body `{ text }` → `{ rules[], ignored[], unrecognized[], parser, fallbackReason? }`. Saves nothing.
- `PUT /api/tools/:tool/preferences` body `{ text, rules, confirmed: true }` → saved; audited as `PREFERENCE_CHANGED`
- `GET /api/me/spending` → `{ currency, agents: [{ agentId, agentName, today, week, month, caps: { daily, weekly, monthly } }] }`

### Agent self (agent key only)
- `GET /api/agents/me/preferences?tool=` → confirmed rules (with labels) for the tools this agent may use. Every other method is `403`.

### Actions
- `POST /api/actions` — **agent key only**. Body: `{ tool, operation, payload, replaces? }`. Returns `{ id, status, riskLevel }` (plus `result` when an auto-allowed read or alarm ran at once). `replaces` names the agent's own earlier action for the same tool; an open one becomes `BLOCKED` (`REPLACED`) and the user sees what changed.
- `GET /api/actions?status=&tool=&agent=` — user
- `GET /api/actions/:id` — user (agent may read only its own action status, and its `result` once `COMPLETED`)
- `POST /api/actions/:id/approve` — user; body `{ payloadHash }`; HIGH/CRITICAL need recent re-auth
- `POST /api/actions/:id/reject` — user; body `{ reason? }`

### Audit (read-only)
- `GET /api/audit?from=&to=&agent=&tool=` · `GET /api/audit/verify` (hash-chain check)
- `GET /api/audit/export` (Pro only)
- **No** PUT/PATCH/DELETE routes exist for audit.

### Models (user; docs/MODEL_PROVIDERS.md)
- `GET /api/models/catalog` → `{ checkedOn, providers[], models[] }` (approx. prices per 1M tokens)
- `GET /api/models` → `{ models[] (keyHint only), roles: { agent, guard: { model, cap, spent, active, offReason } }, warnings[] }` (`SAME_PROVIDER`)
- `POST /api/models` body `{ provider, modelId, apiKey?, baseUrl?, label }` → 201 (CSRF + re-auth)
- `POST /api/models/:id/test` → `{ ok, error?, message?, guard: { passed, cases: 5, failed } }` (CSRF + re-auth)
- `PUT /api/models/roles` body `{ agent: id|null, guard: id|null, caps?: { agent?, guard? } }` (CSRF; a role needs a passed test, the guard also the capability test)
- `PUT /api/models/:id/key` body `{ apiKey }` (rotate; CSRF + re-auth) · `DELETE /api/models/:id` (CSRF + re-auth; clears its roles)
- `POST /api/assistant/chat` body `{ messages[] }` → `application/x-ndjson` events `text`, `proposal`, `error`, `done`; 409 `MODEL_UNAVAILABLE` with no agent model or a reached cap

### Plans
- `GET /api/plans` · `GET /api/me/entitlements` · `POST /api/me/plan` (mock billing)

### Realtime and phone alerts (user only; agent keys get 401)
- `GET /api/stream` (SSE): `event: ready`, then `event: change` with `{ eventType, actionId }` for every audited change of this user (never payloads); heartbeat every 25 s; closes when the session ends
- `GET /api/push/key` → `{ enabled, publicKey }` · `GET /api/push/subscriptions` → `{ subscriptions: [{ id, host, createdAt }] }`
- `POST /api/push/subscriptions` body = the browser's `PushSubscription.toJSON()` (CSRF; push-service hosts only; 409 `PUSH_DISABLED` without VAPID keys) · `DELETE /api/push/subscriptions` body `{ endpoint }` · `POST /api/push/test`

## 4. Testability contract (required by `backend/tests/`)
- `src/app.ts` exports `createApp({ dbPath, clock?, classifier?, adapters?, preferenceModel?, preferenceModelTimeoutMs?, modelFactory?, modelTimeoutMs?, resolveHost?, pushSender? })` returning `{ app, clock, db }`. `clock.advanceMinutes(n)` moves time forward for expiry tests; `createClock(startMs)` pins "now" for time-of-day tests. `adapters` lets a test swap in a mock adapter (for example one that returns no provider reference, for SEC-25). `modelFactory` maps a stored model config to an AI SDK model, so tests pass mock models and never call a provider. `pushSender` replaces the Web Push sender; `resolveHost` replaces DNS for custom base URLs.
- `src/services/intent.ts` exports `classify({ tool, operation, payload, context })`.
- The audit table is named `audit_events` and has a `seq` column that starts at 1.
- `GET /api/actions/:id` (user) includes `payloadHash`, `riskLevel` and `execution` (`null` until run).

## 5. Error format
`{ "error": { "code": "PERMISSION_DENIED", "message": "...", "actionId": "..." } }`
Codes: `UNAUTHENTICATED, PERMISSION_DENIED, ENTITLEMENT_REQUIRED, APPROVAL_REQUIRED, APPROVAL_EXPIRED, PAYLOAD_CHANGED, REAUTH_REQUIRED, AGENT_PAUSED, VALIDATION_ERROR, PROVIDER_ERROR, ALREADY_DECIDED, CSRF_INVALID, RATE_LIMITED, NOT_FOUND`.

`ALREADY_DECIDED` (409) comes from DECISIONS F. `CSRF_INVALID` (403), `RATE_LIMITED` (429) and `NOT_FOUND` (404) name responses the tests already expect.
