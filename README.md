# AgentGuard

**Alert before action. Trace everything.**

- A control panel (PC + phone PWA) for the AI agents that act for you: email, calendar, messages, posts and payments.
- Every action an agent proposes is checked, scored for intent and risk, and waits for your approval when it matters.
- Every step lands in a tamper-evident audit log you can verify.

> **Version 1.0.0: mock prototype, no keys required.** Private repository · Proprietary license (see `LICENSE`).
> Want a guided tour? Follow **[DEMO.md](DEMO.md)**: 12 clicks, about 10 minutes.

---

## Key features

**Control**
- Per-agent permissions: every operation (send, post, pay, cancel…) is its own switch, OFF by default.
- Limits per tool: daily / weekly / monthly caps, per-payee caps, known payees and recipients, methods, blocked categories, hours.
- Preferences in plain language ("No emails after 9pm"), shown back as rules and saved only after you confirm.
- One-tap kill switch pauses every agent at once.
- 9 tools: Gmail, Calendar, Clock, WhatsApp, Instagram, LinkedIn, X, Blog, Payments (all simulated in MOCK mode).

**Alerts & Approval**
- New proposals appear on the dashboard within seconds (live over SSE); optional phone push alerts.
- Review screen: a preview per tool (email, post, meeting, payment receipt), risk, reasons and what changed.
- Approve or Reject, given equal weight; HIGH risk asks for your password again.
- Approvals expire (10 minutes by default) and are bound to the exact payload.

**Intent & Risk**
- Deterministic rules classify the intent and score the risk of every action (LOW → CRITICAL).
- Flags for new recipients, caps, odd hours, preference breaks and blocked categories.
- Unknown or failed classification means `NEEDS_REVIEW`, never approved.

**Audit**
- Append-only, hash-chained log of every proposal, decision, execution and setting change.
- "Verify" checks the whole chain in one click; CSV / JSON export and an integrity report (by plan).

**Plans**
- Starter, Plus and Pro (mock billing) with clear "Upgrade to unlock" labels.
- A downgrade pauses extras and never deletes anything.
- Approvals, the kill switch, alerts and the audit log are never locked behind a plan.

**Bring your own model**
- Built-in **offline assistant**: free, no key, follows simple commands ("pay Ravi 500").
- Optional: add your own model (OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, Ollama, any OpenAI-compatible server).
- Two roles: the **Assistant** (proposes actions) and the **guard** (can only raise risk). Neither can approve anything.
- Keys are encrypted and masked, with a connection test and monthly spend caps.

## Why it's useful

- AI agents can now send, post, book and pay for you, and one bad action is hard to undo.
- Most agent tools are all-or-nothing: either full access or none.
- AgentGuard sits in between: the agent can propose anything, but only what you allow can run, and only after you see it.
- A changed amount, recipient or time means a new approval, so an agent cannot swap details after you say yes.
- You can always answer "what did my agent do, and who approved it?" from a log that cannot be quietly edited.

## Screens

- **Sign in / Create account**: email and password; the demo account is printed by the seed.
- **Dashboard**: pending alerts, agents, spend vs. caps, kill switch.
- **Review**: one action in full: preview, risk, reasons, preference check, countdown, Approve / Reject.
- **Assistant**: chat with the offline assistant or your own model; proposals land in Review.
- **Tools**: connect the 9 tools, write preferences, see MOCK / LIVE status.
- **Agents**: create agents (key shown once), rotate keys, pause, set permissions and limits.
- **Audit**: timeline with filters, Verify and export.
- **Settings**: account, phone alerts, models, plans.
- **Models**: add a model, test it, assign the Assistant and guard roles.
- **Plans**: compare Starter / Plus / Pro and switch (mock billing).

## Run it in 4 steps (no API keys needed)

Requires Node.js 20+ and Git.

1. `git clone https://github.com/udit16561/AgentGuard.git && cd AgentGuard`
2. `npm install` (also installs `backend/`)
3. `npm run db:seed` (demo user on Pro, all 9 tools in MOCK mode, pending alerts, some history, offline Assistant)
4. `npm run dev`, then open **http://localhost:4000** and sign in as **`demo@agentguard.dev` / `Demo#12345`**

- On start, a self-check prints which features are on and confirms the app is 100% usable with no keys.
- Seeded alerts expire after 10 minutes; run `npm run db:seed` again for fresh ones.
- Play the agent from a second terminal: set `AGENT_API_KEY` to the key printed by the seed, then `npm run demo:agent -- pay 500 Ravi`.

## Optional: add an AI model

*Optional. Everything above works without it.*

- Settings → Models → Add a model → pick a provider, paste your key (or use Ollama locally with no key).
- Run **Test connection**, then give it the **Assistant** role, the **guard** role, or both.
- A model can only propose actions or raise risk; it never approves anything. See `docs/MODEL_PROVIDERS.md`.

## Roadmap

- 1.0.0 is the complete mock prototype: every screen and safety feature works with simulated tools.
- Future work: live integrations, one tool at a time with your own keys (Gmail, social posting, payments). See `docs/ROADMAP.md`.

## Optional: connect Google Calendar

*Optional, and off by default. Every tool runs in MOCK mode without it.*

- Needs your own Google OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and `INTEGRATION_MODE=live` in `backend/.env`.
- Without them, the Calendar card shows "Live: not configured" and keeps working in MOCK mode.
- Setup, safety rules and the manual check: `docs/LIVE_GOOGLE_CALENDAR.md`.

## Tech stack

- **Backend:** Node.js 20+, TypeScript, Express 5, SQLite (better-sqlite3), zod, argon2.
- **Models:** Vercel AI SDK (native providers + OpenAI-compatible), pinned versions.
- **Frontend:** installable PWA in plain JavaScript (ES modules, no build step), service worker, SSE, Web Push.
- **Tests:** Vitest + Supertest (API), Playwright (desktop and mobile Chrome).

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
  tests/           API and security tests (SEC-* are never edited to pass)
frontend/          the PWA (index.html, js/views, css, sw.js)
e2e/               Playwright UI tests
examples/          demo-agent.ts: a fake agent for manual testing
docs/              requirements, architecture, security, tests, decisions
```

## Run the tests

- API and security: `npm test` (from the repo root or `backend/`)
- Security only: `cd backend && npm run test:security`
- Types and lint: `cd backend && npm run typecheck && npm run lint`
- UI (desktop + mobile): `npx playwright install chromium` once, then `npm run test:e2e`
- Every test runs offline: no real provider, Google or payment call is ever made.

## Security model

- **Three gates:** every action must pass Permission, Approval and Verification; a failed gate means it does not run.
- **Hash-bound approvals:** you approve one exact payload; any change is a new approval, and approvals expire.
- **Append-only audit:** hash-chained, no update or delete endpoints; agents cannot write to audit, permissions or settings.
- **Keys encrypted:** model keys and OAuth tokens are AES-256-GCM encrypted, masked, and never sent to the browser, logs or audit.
- **Fail closed:** unknown intent, missing data, timeouts or classifier errors give `NEEDS_REVIEW`, never `APPROVED`.

## License

Proprietary. Copyright (c) 2026 Udit sharma. All rights reserved; see `LICENSE`.
