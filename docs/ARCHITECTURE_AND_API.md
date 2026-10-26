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
- **Permission**: id, agentId, tool, operation, allowed (default false), limits (JSON: maxAmount, dailyCap, allowedRecipients, timeWindow)
- **Action**: id, agentId, tool, operation, payload (JSON), payloadHash, intent, riskLevel, riskScore, riskReasons[], status, createdAt
- **Approval**: id, actionId, userId, decision (`APPROVED|REJECTED`), payloadHash, reauthUsed, decidedAt, expiresAt
- **Execution**: id, actionId, adapterMode (`MOCK|LIVE`), providerRef, result, error, finishedAt
- **AuditEvent**: id, seq, actorType (`USER|AGENT|SYSTEM`), actorId, eventType, actionId?, data (JSON, secrets redacted), prevHash, hash, createdAt
- **Plan**: id, name, entitlements (JSON)

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

### Plans
- `GET /api/plans` · `GET /api/me/entitlements` · `POST /api/me/plan` (mock billing)

### Realtime
- `GET /api/stream` (SSE: new alerts, status changes)

## 4. Testability contract (required by `backend/tests/`)
- `src/app.ts` exports `createApp({ dbPath, clock?, classifier?, adapters? })` returning `{ app, clock, db }`. `clock.advanceMinutes(n)` moves time forward for expiry tests. `adapters` lets a test swap in a mock adapter (for example one that returns no provider reference, for SEC-25).
- `src/services/intent.ts` exports `classify({ tool, operation, payload, context })`.
- The audit table is named `audit_events` and has a `seq` column that starts at 1.
- `GET /api/actions/:id` (user) includes `payloadHash`, `riskLevel` and `execution` (`null` until run).

## 5. Error format
`{ "error": { "code": "PERMISSION_DENIED", "message": "...", "actionId": "..." } }`
Codes: `UNAUTHENTICATED, PERMISSION_DENIED, ENTITLEMENT_REQUIRED, APPROVAL_REQUIRED, APPROVAL_EXPIRED, PAYLOAD_CHANGED, REAUTH_REQUIRED, AGENT_PAUSED, VALIDATION_ERROR, PROVIDER_ERROR, ALREADY_DECIDED, CSRF_INVALID, RATE_LIMITED, NOT_FOUND`.

`ALREADY_DECIDED` (409) comes from DECISIONS F. `CSRF_INVALID` (403), `RATE_LIMITED` (429) and `NOT_FOUND` (404) name responses the tests already expect.
