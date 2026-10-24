# Prompt Library

Paste these into Claude Code from the repo root. Each one works on its own, so anyone on the team can use them.

## 0. Kickoff (first session)
```
Read CLAUDE.md and every file in docs/. Do not write code yet.
1. Summarize the project in 5 lines.
2. List contradictions or gaps in the docs.
3. Propose the plan for M0 + M1 (docs/ROADMAP.md): files, packages (see docs/COMMANDS.md §2), and which
   test IDs from docs/TEST_CASES.md each step will turn green.
4. Wait for my "go".
Rules: mock integrations only, no git push, keep LICENSE, never edit SEC-* tests.
```

## 1. Build backend milestone M1 (test-driven)
```
Implement M1 from docs/ROADMAP.md in backend/.
The acceptance tests already exist in backend/tests/security/gates.test.ts and backend/tests/intent/.
Follow the testability contract in docs/ARCHITECTURE_AND_API.md §4.
Work in small steps: after each step run `npm test` and tell me which test IDs pass.
Do not modify any SEC-* test. Mock adapters only. Stop when all SEC-* and INT-* tests pass.
```

## 2. Frontend-only task
```
Frontend task only (frontend/). Follow docs/FRONTEND_GUIDE.md. Do not change backend/ or API contracts.
If the UI needs data the API doesn't return, use a clearly labelled mock and list the gap.
Cover the related UI-* cases from docs/TEST_CASES.md with Playwright tests in e2e/.
Task: <describe screen or change>
```

## 3. Backend-only task
```
Backend task only (backend/). Follow docs/ARCHITECTURE_AND_API.md and docs/SECURITY_AND_APPROVALS.md.
Write the tests first (add new IDs to docs/TEST_CASES.md), then the code. Mock adapters only.
Task: <describe endpoint/service>
```

## 4. Connect frontend to backend
```
Wire frontend/js/api.js to the real backend endpoints. Remove the matching mocks.
Use credentials:'include' and the X-CSRF-Token header. Add an SSE listener for /api/stream.
Verify UI-01, UI-02, UI-04, UI-06 and UI-09 with Playwright on desktop and "Mobile Chrome".
```

## 5. Add a mock tool adapter
```
Add a MOCK adapter for <tool> with operations <list>.
Register it in the tool catalog, map each operation to an intent and base risk per docs/INTENT_AND_RISK.md,
add permission toggles, add fixtures to backend/tests/fixtures/intents.json,
and add tests proving it cannot execute without approval.
```

## 6. Add a live integration (only after owner approval)
```
Owner-approved: build a LIVE adapter for <provider> using its official API in sandbox/test mode.
Check docs/REFERENCE_REPOS.md §3 first and propose: auth method, scopes (minimum needed), token storage,
and whether to use Nango or the provider API directly. Wait for my "go" before writing code.
LIVE mode must stay off unless INTEGRATION_MODE=live is set for this adapter.
```

## 7. Optional AI classifier layer
```
Add the optional model layer to IntentService per docs/INTENT_AND_RISK.md §3.
Strict JSON schema validation, 3 s timeout, fail closed to NEEDS_REVIEW.
It may only raise risk or add flags. Prove it with SEC-19, SEC-20 and INT-10.
```

## 8. Security review (read-only)
```
Review the codebase against docs/SECURITY_AND_APPROVALS.md and every SEC-* case in docs/TEST_CASES.md.
Report PASS/FAIL per item with file:line references. Do not change code.
```

## 9. Bug fix
```
Bug: <what happened, expected, steps>.
First write a failing test that reproduces it, then fix the code, then run the full test suite.
```

## 10. Commit (only when asked)
```
Run lint and all tests. If they pass, commit with a Conventional Commit message. Do not push.
```

## 11. End-of-day report
```
Summarize today's changes: files changed, test IDs now passing or failing, mocks still in use,
open questions, and the next step from docs/ROADMAP.md.
```
