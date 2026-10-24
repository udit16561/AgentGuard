# Project Requirements

## 1. Users
- **Owner/User:** connects tools, sets permissions, approves/rejects actions, reviews history.
- **AI Agent:** proposes actions through the backend API only. Cannot approve, edit permissions, or touch audit logs.

## 2. Supported tools (catalog) and operations

| Tool | Read ops | Write ops (always need approval unless noted) |
|---|---|---|
| Gmail | read inbox, search | send, reply, forward, delete |
| Calendar | view events | create, update, cancel, invite |
| Clock / Reminders | list alarms | set alarm/reminder (low risk, configurable) |
| WhatsApp | read chats* | send message, send media |
| Instagram | read feed/insights* | post, story, DM, comment |
| LinkedIn | read profile/feed* | post, message, connect |
| X (Twitter) | read timeline* | post, reply, DM, repost |
| Payments | view balance/history* | pay, transfer, refund, subscribe |
| Blog / CMS | list drafts | publish, edit live post, delete |

\* Availability depends on official provider APIs and account type. Prototype uses mocks.

## 3. User journeys

### J1 — Onboarding
Sign up (this also logs you in) → pick plan (default Plus during the prototype) → create first agent profile → install PWA on PC/phone.
**Accept:** user lands on dashboard with zero tools connected and all permissions OFF by default. (DECISIONS A, G)

### J2 — Connect a tool and grant permissions
Choose tool → (mock) OAuth connect → toggle operations per agent → set limits (e.g., max payment ₹2,000/day, allowed recipients, posting hours).
**Accept:** default is deny; each write operation is a separate toggle; changes are logged.

### J3 — Agent proposes an action
Agent calls `POST /api/actions` → backend checks permission → intent + risk classified → action stored as `PENDING_REVIEW` → user gets alert (in-app + push).
**Accept:** no execution occurs before approval; blocked actions are logged with reason.

### J4 — Review and decide
User opens alert → sees exact details (who, what, to whom, amount, content preview, intent, risk, reasons) → Approve or Reject (payments ≥ HIGH also require re-auth/PIN).
**Accept:** approval is bound to an action hash; the action expires a set time after it was proposed (default 10 min). `NEEDS_REVIEW` actions can be approved with re-auth. (DECISIONS C, D)

### J5 — Execution and verification
Backend re-validates permission + approval hash → calls adapter → records provider result.
**Accept:** UI shows `SUBMITTED` → `COMPLETED` / `FAILED` / `UNKNOWN`; never "done" without provider confirmation.

### J6 — Trace and audit
Timeline of every event with filters (agent, tool, risk, status, date); export on Pro.
**Accept:** entries are read-only; hash-chain integrity check shown.

### J7 — Emergency controls
"Pause all agents" kill switch; revoke a tool in one tap.
**Accept:** takes effect immediately for all pending and new actions.

### J8 — Settings and optimization
Clear local cache, switch the agent's model/API key (stored server-side, masked), notification preferences.
**Accept:** none of these settings can disable approvals or delete audit records.

## 4. Action status lifecycle
`PROPOSED → BLOCKED | PENDING_REVIEW | NEEDS_REVIEW → APPROVED | REJECTED | EXPIRED → SUBMITTED → COMPLETED | FAILED | UNKNOWN`

`NEEDS_REVIEW` is `PENDING_REVIEW` plus a warning that the classifier was unsure or details were missing; approving it needs re-auth (DECISIONS C).

## 5. Non-functional
- Mobile-first, works at 360px width; WCAG 2.1 AA.
- Alert delivery < 3 s in prototype.
- Times stored in UTC, shown in user's timezone (default Asia/Kolkata).
- Currency shown with code (INR default).
