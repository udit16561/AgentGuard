# AgentGuard

**Alert before action. Trace everything.**

AgentGuard is a control panel (desktop + phone app) for the AI agents that act on your behalf: sending email, booking meetings, posting on social media and making payments. An agent can *propose* anything, but nothing runs until it passes your rules and, when it matters, your approval. Every step is recorded in a tamper-evident audit log.

> **Version 1.0.0.** Runs fully offline in **MOCK mode with no API keys**. All 9 tools are simulated, so you can try everything safely.
> Want a guided tour? Follow **[DEMO.md](DEMO.md)** (12 steps, about 10 minutes).

---

## Contents

- [Why it's useful](#why-its-useful)
- [Quick start (no keys needed)](#quick-start-no-keys-needed)
- [How to use it](#how-to-use-it)
- [Where to put API keys](#where-to-put-api-keys)
- [Key features](#key-features)
- [Security model](#security-model)
- [Project structure](#project-structure)
- [Run the tests](#run-the-tests)
- [Tech stack](#tech-stack)
- [License](#license)

---

## Why it's useful

- **Agents can act, and mistakes are hard to undo.** A wrong email, public post or payment can't be taken back.
- **Most agent tools are all-or-nothing.** You either hand over full access or none.
- **AgentGuard sits in between.** The agent proposes; only what you've allowed can run, and only after you've seen it.
- **No bait-and-switch.** You approve one exact payload. A changed amount, recipient or time needs a new approval.
- **Accountability.** You can always answer "what did my agent do, and who approved it?" from a log that cannot be quietly edited.

---

## Quick start (no keys needed)

Requires **Node.js 20+** and **Git**.

```bash
git clone https://github.com/udit16561/AgentGuard.git
cd AgentGuard
npm install        # also installs backend/
npm run db:seed    # demo user, all 9 tools in MOCK mode, pending alerts, some history
npm run dev
```

Open **http://localhost:4000** and sign in:

| Email | Password |
|---|---|
| `demo@agentguard.dev` | `Demo#12345` |

- On start, a self-check prints which features are on and confirms the app is fully usable with no keys.
- Seeded alerts expire after 10 minutes. Run `npm run db:seed` again for fresh ones.
- Next time, `npm run dev` is all you need.

**Windows note:** if `npm install` fails building `better-sqlite3`, install "Desktop development with C++" from the Visual Studio Build Tools, then retry.

---

## How to use it

### The everyday flow

1. **An agent proposes an action**, for example "pay Ravi ₹500" or "post on LinkedIn".
2. **AgentGuard checks it** against the agent's permissions, your limits and your plain-language preferences, and scores intent and risk (LOW → CRITICAL).
3. **You get an alert** on the Dashboard (and on your phone, if enabled).
4. **You review it**: a preview of exactly what will happen, the risk and why, and a countdown.
5. **You Approve or Reject.** High-risk actions ask for your password again.
6. **It runs and is logged.** Audit → Verify confirms the log hasn't been tampered with.

### Screens

| Screen | What you do there |
|---|---|
| **Dashboard** | See pending alerts, your agents, spend vs. caps, and the **kill switch** (pauses every agent at once). |
| **Review** | Inspect one action in full and Approve or Reject it. |
| **Assistant** | Chat with the built-in offline assistant (or your own model). Try `pay Ravi 500`. |
| **Tools** | Connect the 9 tools, write preferences like "No emails after 9pm", see MOCK / LIVE status. |
| **Agents** | Create agents (the API key is shown once), rotate keys, pause, set permissions and limits. |
| **Audit** | Timeline with filters, **Verify**, CSV / JSON export. |
| **Settings → Models** | Add your own AI model and assign it roles. |
| **Settings → Plans** | Compare Starter / Plus / Pro (mock billing). |

### Connect your own agent

Each agent gets an API key when you create it on the **Agents** screen (the seed prints one for the demo agent). Your agent uses that key to send proposals to AgentGuard's API. To try it with the bundled example agent, open a second terminal:

```bash
# macOS / Linux
export AGENT_API_KEY=<key printed by the seed>
# Windows PowerShell
$env:AGENT_API_KEY="<key printed by the seed>"

npm run demo:agent -- pay 500 Ravi
```

The proposal appears in **Review** within seconds. See `examples/demo-agent.ts` and `docs/ARCHITECTURE_AND_API.md` for the API.

### Guided demo

**[DEMO.md](DEMO.md)** walks through a payment, the alert, review and approve, a blocked over-cap payment, a preference catching a political post, the kill switch and audit Verify.

---

## Where to put API keys

**Every key is optional.** Without any, AgentGuard runs completely in MOCK mode. Keys live in one of two places:

### 1. In the app: your own AI model

AI model keys are **not** put in a file. Add them in the app:

**Settings → Models → Add a model** → pick a provider → paste your key → **Test connection** → assign the **Assistant** and/or **guard** role.

Supported: OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, Ollama (local, no key), and any OpenAI-compatible server. Keys are stored encrypted and shown masked. Details: `docs/MODEL_PROVIDERS.md`.

> Set `TOKEN_ENCRYPTION_KEY` (below) if you add model keys. Without it, a new random key is used each time the server starts, so saved keys can't be read after a restart and you'd have to re-enter them.

### 2. In `backend/.env`: server settings and integrations

Copy the example file into the **backend** folder and fill in only what you need:

```bash
# macOS / Linux
cp .env.example backend/.env
# Windows
copy .env.example backend\.env
```

`backend/.env` is git-ignored, so your keys are never committed. Restart `npm run dev` after editing it.

| Variable | What it's for | How to get it |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | Encrypts stored model keys and OAuth tokens. **Required in production.** | 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `SESSION_SECRET` | Signs login sessions. | Any long random string. |
| `PORT` | Server port (default `4000`). | — |
| `INTEGRATION_MODE` | `mock` (default) or `live`. `live` only affects tools you switch to LIVE on the Tools screen. | — |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Live Google Calendar. | Google Cloud Console → OAuth client (Web application), scope `calendar.events`. Full guide: `docs/LIVE_GOOGLE_CALENDAR.md`. |
| `GOOGLE_REDIRECT_URI` | Google OAuth callback. | Keep `https://localhost:4443/api/oauth/google/callback` and add it to your OAuth client. Open the app via `npm run dev:lan`. |
| `GOOGLE_OAUTH_TESTING` | `true` while your Google app is unpublished (refresh tokens expire after 7 days). | — |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Phone push alerts. | Generated automatically by `npm run dev:lan`, or run `npx web-push generate-vapid-keys`. |
| `PREFERENCE_MODEL_PROVIDER` / `PREFERENCE_MODEL_API_KEY` | Optional AI parser for plain-language preferences (`anthropic` or `none`). Falls back to the built-in parser on any error. | Your Anthropic API key. |
| `INTENT_MODEL_PROVIDER` / `INTENT_MODEL_API_KEY` | Optional intent-model layer (`none` by default). | — |
| `APPROVAL_TTL_MINUTES` | How long an approval stays valid (default `10`). | — |
| `REAUTH_WINDOW_MINUTES` | How long a password re-check lasts for high-risk approvals (default `5`). | — |
| `PASSWORD_RATE_LIMIT` | Password checks allowed per IP per 15 minutes (default `100`). Keep the default in real use. | — |

Gmail, WhatsApp, Instagram, LinkedIn, X, Blog and Payments are **simulated only** in 1.0.0. They need no keys and send nothing real. Live versions are on the roadmap (`docs/ROADMAP.md`).

---

## Key features

**Control**
- Per-agent permissions: every operation (send, post, pay, cancel…) is its own switch, OFF by default.
- Limits per tool: daily / weekly / monthly caps, per-payee caps, known payees and recipients, blocked categories, allowed hours.
- Preferences in plain language ("No emails after 9pm"), shown back as rules and saved only after you confirm.
- One-tap kill switch pauses every agent at once.
- 9 tools: Gmail, Calendar, Clock, WhatsApp, Instagram, LinkedIn, X, Blog, Payments.

**Alerts & approval**
- New proposals appear within seconds (live over SSE); optional phone push alerts.
- Previews per tool (email, post, meeting, payment receipt), with risk, reasons and what changed.
- Approve and Reject are given equal weight; HIGH risk asks for your password again.
- Approvals expire (10 minutes by default) and are bound to the exact payload.

**Intent & risk**
- Deterministic rules classify intent and score risk (LOW → CRITICAL).
- Flags for new recipients, caps, odd hours, preference breaks and blocked categories.
- An unknown or failed classification means `NEEDS_REVIEW`, never approved.

**Audit**
- Append-only, hash-chained log of every proposal, decision, execution and setting change.
- One-click Verify; CSV / JSON export and an integrity report (by plan).

**Plans**
- Starter, Plus and Pro (mock billing). A downgrade pauses extras and never deletes anything.
- Approvals, the kill switch, alerts and the audit log are never locked behind a plan.

**Bring your own model**
- Built-in offline assistant: free, no key, understands simple commands.
- Two roles: the **Assistant** (proposes actions) and the **guard** (can only raise risk). Neither can approve anything.
- Monthly spend caps per model.

---

## Security model

- **Three gates:** every action must pass Permission, Approval and Verification. A failed gate means it does not run.
- **Hash-bound approvals:** you approve one exact payload; any change needs a new approval, and approvals expire.
- **Append-only audit:** hash-chained, with no update or delete endpoints. Agents cannot write to audit, permissions or settings.
- **Keys encrypted:** model keys and OAuth tokens are AES-256-GCM encrypted, masked, and never sent to the browser, logs or audit.
- **Fail closed:** unknown intent, missing data, timeouts or classifier errors give `NEEDS_REVIEW`, never `APPROVED`.

More: `docs/SECURITY_AND_APPROVALS.md`.

---

## Project structure

```
backend/
  src/
    routes/        HTTP endpoints (auth, agents, tools, actions, decisions, audit, models, plans…)
    services/      permissions, intent & risk, proposals, execution, audit chain, preferences, plans
    adapters/mock/ the 9 simulated tools
    integrations/  live Google Calendar (optional, off by default)
    models/        bring-your-own-model + the built-in offline assistant
    db/            schema, migrate, seed, reset
    selfcheck.ts   startup feature report
  tests/           API and security tests
frontend/          the PWA (index.html, js/views, css, sw.js)
e2e/               Playwright UI tests
examples/          demo-agent.ts: a sample agent for manual testing
docs/              architecture, security, models, Google Calendar, roadmap
```

---

## Run the tests

- API and security: `npm test`
- Security only: `cd backend && npm run test:security`
- Types and lint: `cd backend && npm run typecheck && npm run lint`
- UI (desktop + mobile): `npx playwright install chromium` once, then `npm run test:e2e`

Every test runs offline. No real model, Google or payment call is ever made.

---

## Tech stack

- **Backend:** Node.js 20+, TypeScript, Express 5, SQLite (better-sqlite3), zod, argon2.
- **Models:** Vercel AI SDK (native providers + OpenAI-compatible).
- **Frontend:** installable PWA in plain JavaScript (ES modules, no build step), service worker, SSE, Web Push.
- **Tests:** Vitest + Supertest (API), Playwright (desktop and mobile Chrome).

---

## License

MIT. Copyright (c) 2026 Udit sharma. See `LICENSE`.
