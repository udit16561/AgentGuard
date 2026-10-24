# CLAUDE.md — Master Instructions

> Read this file first, before every task. Then read the files in `docs/` that apply to the task.

## 1. What this project is

**AgentGuard** (working name) is a prototype app for **PC (web/desktop) and mobile** that sits between a user and their AI agents. It:

1. Lets the user **connect selected tools** (Gmail, Calendar, Clock/Reminders, WhatsApp, Instagram, LinkedIn, X, Payments, Blog/CMS).
2. Lets the user **grant fine-grained permissions** per agent, per tool, per operation.
3. **Classifies the intent** of every action an agent proposes and assigns a **risk level**.
4. **Alerts the user before any consequential action** and requires an explicit **Approve / Reject**.
5. **Traces every action** in a tamper-evident audit log that the AI agent can never edit or delete.
6. Offers **plan tiers** (Starter / Plus / Pro) that unlock features — never tool access by themselves.

**Core motto: Alert before action. Trace everything. The AI never controls its own guardrails.**

## 2. Document map

| File | Read when |
|---|---|
| `docs/PROJECT_REQUIREMENTS.md` | Any feature work — user journeys and acceptance criteria |
| `docs/ARCHITECTURE_AND_API.md` | Backend, data models, API endpoints |
| `docs/FRONTEND_GUIDE.md` | Any UI work (HTML, CSS, JavaScript) |
| `docs/SECURITY_AND_APPROVALS.md` | **Always** — approval, permissions, audit, secrets |
| `docs/INTENT_AND_RISK.md` | Intent classification and risk scoring |
| `docs/PLANS_AND_ENTITLEMENTS.md` | Plans, limits, premium features |
| `docs/ROADMAP.md` | Deciding what to build next |
| `docs/TEST_CASES.md` | Every task — find the test IDs your change affects |
| `docs/COMMANDS.md` | Setup, run, test, git commands |
| `docs/REFERENCE_REPOS.md` | Before adding a library or integration |

**Tests come first.** `backend/tests/security/` and `backend/tests/intent/` are acceptance tests written before the code. Make them pass by fixing code, and **never** edit or delete a `SEC-*` test to make it pass. If you think a test is wrong, stop and ask the owner.

## 3. Tech stack (prototype defaults — change only if the owner says so)

- **Frontend:** HTML, CSS, vanilla JavaScript (ES modules). Responsive, mobile-first. Installable as a **PWA** so it works on PC and phone.
- **Backend:** Node.js (LTS) + Express, TypeScript preferred.
- **Database:** SQLite for the prototype (via Prisma or better-sqlite3); schema must be portable to PostgreSQL.
- **Auth:** session cookies (HttpOnly, Secure, SameSite=Strict) or short-lived JWT + refresh. No tokens in `localStorage`.
- **Tests:** Vitest/Jest for backend, Playwright for end-to-end flows.
- **Integrations:** **mock adapters first**. Real provider adapters only after the owner explicitly approves each one.

Note: the frontend language is **JavaScript**, not Java.

## 4. Non-negotiable rules

1. **No real external action during development.** All tool adapters run in `MOCK` mode unless the owner sets `INTEGRATION_MODE=live` for a specific adapter.
2. **Three separate gates** for every action — all must pass:
   - **Permission:** is this agent allowed this tool + operation?
   - **Approval:** did the user approve *this exact* action (hash-matched)?
   - **Verification:** did the provider confirm execution?
3. **The classifier can raise risk, never lower a gate.** An AI score must never auto-approve a payment, post, message, or booking.
4. **Changed details = new approval.** If amount, recipient, content, or time changes after approval, the approval is void.
5. **Audit log is append-only.** No update/delete endpoints exist for it. Agents have zero write access to audit, permissions, or settings.
6. **Secrets never in code, logs, browser storage, or commits.** Use `.env` (git-ignored) and encrypt stored OAuth tokens.
7. **Fail closed.** Unknown intent, missing data, timeout, or classifier error ⇒ status `NEEDS_REVIEW`, never `APPROVED`.
8. **Stay in scope.** Do only what the task asks. If a task crosses frontend/backend or touches security rules, stop and explain first.

## 5. GitHub rules

- The repository is **private**. Never change visibility.
- **Never push, open PRs, or create releases unless the owner explicitly asks** in that task.
- Commit messages: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- The project uses the **proprietary license in `LICENSE`**. Do not replace or add an open-source license.
- Never commit `.env`, tokens, real user data, or database files.

## 6. Working procedure (every task)

1. Inspect the repo structure and the relevant `docs/` files.
2. State a short plan: files to create/change, and why.
3. Implement the smallest change that satisfies the task.
4. Add/update tests. Run lint and tests.
5. Report: changed files, test results, mocks used, open questions, security notes.

## 7. Repository layout (target)

```
/
├── CLAUDE.md
├── LICENSE
├── README.md
├── .env.example
├── docs/
├── frontend/          # HTML, CSS, JS, PWA manifest, service worker
│   ├── index.html
│   ├── css/
│   ├── js/
│   └── manifest.webmanifest
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   ├── services/       # policy, approval, intent, audit, entitlement
│   │   ├── adapters/       # mock + live provider adapters
│   │   ├── db/
│   │   └── middleware/
│   └── tests/
└── e2e/
```
