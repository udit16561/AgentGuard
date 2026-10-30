# Commands Cheat Sheet

Copy-paste commands for everyone working on AgentGuard. Run them from the **repo root** unless a block says otherwise. Windows users can use PowerShell or Git Bash; where a command differs, both versions are shown.

## 0. Quick start (no API keys needed)

```bash
git clone https://github.com/<owner>/<repo>.git && cd <repo>
npm install          # also installs backend/ (postinstall)
npm run db:seed      # demo user on Pro, all 9 tools MOCK, pending alerts, offline Assistant
npm run dev          # prints the self-check, then open http://localhost:4000
```
Sign in as `demo@agentguard.dev` / `Demo#12345` (printed by the seed in development). No `.env` is needed.

## 1. One-time setup

```bash
# Requirements: Node.js LTS (>= 20), npm, Git, (optional) GitHub CLI `gh`
node -v && npm -v && git --version

# Clone the private repo
git clone https://github.com/<owner>/<repo>.git && cd <repo>

# Environment file
cp .env.example .env            # macOS / Linux / Git Bash
copy .env.example .env          # Windows CMD
```

Generate secrets for `.env`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # TOKEN_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"      # SESSION_SECRET
```

## 2. Scaffold the backend (M0, first time only)

```bash
mkdir -p backend/src/{routes,services,adapters,db,middleware} backend/tests/fixtures
cd backend
npm init -y
npm i express helmet cors express-rate-limit cookie-parser zod better-sqlite3 argon2 dotenv
npm i -D typescript tsx vitest supertest @types/express @types/cookie-parser @types/supertest \
        @types/better-sqlite3 @types/node eslint @eslint/js typescript-eslint
npx tsc --init
cd ..
```

Add these to `backend/package.json` under `"scripts"`:
```json
{
  "dev": "tsx watch src/server.ts",
  "build": "tsc -p .",
  "start": "node dist/server.js",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:security": "vitest run tests/security",
  "test:intent": "vitest run tests/intent",
  "lint": "eslint src tests",
  "db:migrate": "tsx src/db/migrate.ts",
  "db:seed": "tsx src/db/seed.ts",
  "db:reset": "tsx src/db/reset.ts"
}
```

## 3. Daily development

```bash
cd backend
npm run db:migrate          # create or update tables
npm run db:seed             # demo user, agent and mock tools (MOCK mode)
npm run dev                 # app and API at http://localhost:4000 (the backend also serves the frontend)

# On your phone, same Wi-Fi (v0.6.0): HTTPS on the LAN IP, needed for the service worker and Web Push
npm run live:check:calendar # (backend) manual, owner-run: creates then cancels one test event in the live Google Calendar
npm run dev:lan             # prints http://<LAN-IP>:4080 (install the dev certificate once) and https://<LAN-IP>:4443
#   First run adds VAPID keys, TOKEN_ENCRYPTION_KEY and DATABASE_URL to backend/.env (git-ignored).
#   Certificates live in backend/.certs/ (git-ignored). Set LAN_IP=... to pick another address.
#   Demo agent against it: AGENTGUARD_URL=https://localhost:4443 NODE_EXTRA_CA_CERTS=.certs/agentguard-dev-ca.crt npm run demo:agent -- pay 500 Ravi
```

## 4. Testing

```bash
cd backend
npm test                    # all unit and integration tests
npm run test:security       # the 3-gate and audit tests (must always pass)
npm run test:intent         # intent/risk fixture accuracy
npm run lint

# End-to-end (from repo root, once e2e/ exists)
npx playwright install --with-deps
npx playwright test
npx playwright test --project="Mobile Chrome"   # mobile viewport
```

## 5. Manual API smoke test (curl)

```bash
# 1. Sign up and log in (cookie saved to jar.txt)
curl -s -c jar.txt -X POST localhost:4000/api/auth/signup \
  -H "Content-Type: application/json" -d '{"email":"demo@test.dev","password":"Demo#12345"}'

# 2. Create an agent (copy the apiKey from the response; it is shown only once)
curl -s -b jar.txt -X POST localhost:4000/api/agents \
  -H "Content-Type: application/json" -H "X-CSRF-Token: <token>" -d '{"name":"Helper"}'

# 3. Agent proposes a payment
curl -s -X POST localhost:4000/api/actions \
  -H "Authorization: Bearer <AGENT_API_KEY>" -H "Content-Type: application/json" \
  -d '{"tool":"payments","operation":"pay","payload":{"amount":500,"currency":"INR","payee":"Ravi"}}'

# 4. See pending actions as the user
curl -s -b jar.txt "localhost:4000/api/actions?status=PENDING_REVIEW"

# 5. Verify the audit chain
curl -s -b jar.txt localhost:4000/api/audit/verify
```

## 6. Git (private repo)

```bash
git status
git checkout -b feat/m1-approvals
git add -A && git commit -m "feat(approvals): hash-bound approval with expiry"
git push -u origin feat/m1-approvals        # only when the owner says so

# Check that the repo is private
gh repo view <owner>/<repo> --json visibility
# Check that no secrets are tracked
git ls-files | grep -E "\.env$|\.db$|\.sqlite" && echo "REMOVE THESE" || echo "clean"
```

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `better-sqlite3` build error | Install build tools (`xcode-select --install` on macOS, or "Desktop development with C++" on Windows), or swap in `node:sqlite` on Node ≥ 22 |
| Cookie not set locally | Use `secure: false` only when `NODE_ENV=development` |
| CORS error | Set `CORS_ORIGIN` in `.env` to the frontend URL exactly |
| Approval says `PAYLOAD_CHANGED` | Working as designed: the agent changed details, so ask for a new approval |
