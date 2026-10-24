# AgentGuard (prototype)

**Alert before action. Trace everything.** A PC + mobile app that controls which tools your AI agents can use, classifies the intent and risk of every action, asks you to approve consequential ones, and keeps a tamper-evident log.

> Private repository · Proprietary license (see `LICENSE`).

## Run the app (MOCK mode)
```bash
cd backend
npm install
npm run db:seed     # demo account + agent "Helper" with Payments connected; prints the agent key once
npm run dev         # open http://localhost:4000 and sign in as demo@agentguard.dev / Demo#12345
```
In a second terminal, play the agent (PowerShell: `$env:AGENT_API_KEY="ag_..."`; Git Bash: `export AGENT_API_KEY=ag_...`):
```bash
cd backend
npm run demo:agent -- pay 500 Ravi
```
Tests: `npm test` in `backend/` (API), and `npm install` then `npx playwright test` at the repo root (UI, desktop and mobile).

## Start here
1. Read `CLAUDE.md`.
2. Use the prompts in `KICKOFF_PROMPT.md` in Claude Code at the repo root, starting with prompt 0.

## Docs
- `docs/PROJECT_REQUIREMENTS.md` — features and user journeys
- `docs/ARCHITECTURE_AND_API.md` — backend design and endpoints
- `docs/SECURITY_AND_APPROVALS.md` — the guardrail rules
- `docs/INTENT_AND_RISK.md` — classification and risk scoring
- `docs/FRONTEND_GUIDE.md` — UI screens and rules
- `docs/PLANS_AND_ENTITLEMENTS.md` — Starter / Plus / Pro
- `docs/ROADMAP.md` — build order
- `docs/TEST_CASES.md` — every test case (SEC, INT, PRM, PLN, AUTH, UI)
- `docs/COMMANDS.md` — setup, run, test and git commands
- `docs/REFERENCE_REPOS.md` — open-source repos to learn from or reuse
- `backend/tests/` — acceptance tests written before the code
- `examples/demo-agent.ts` — fake agent for manual testing

All integrations are mocked until explicitly approved.
