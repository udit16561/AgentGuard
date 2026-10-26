# Plans and Entitlements

Plans unlock **features and limits**. They never grant tool access — the user must still connect each tool and toggle each permission.

| Entitlement key | Starter | Plus | Pro |
|---|---|---|---|
| `maxAgents` | 1 | 3 | 10 |
| `maxConnectedTools` | 3 | 6 | all |
| `toolCatalog` | Gmail, Calendar, Clock | + WhatsApp, LinkedIn, Payments | + Instagram, X, Blog, custom |
| `riskExplanations` | basic level | detailed reasons | detailed + tone flags |
| `customPolicies` | no | limits per tool | full rules (hours, payees, caps) |
| `auditRetentionDays` | 30 | 180 | 730 |
| `auditExport` | no | CSV | CSV + JSON + integrity report |
| `pushAlerts` | in-app | in-app + push | + email digest |
| `liveIntegrations` | no | owner-approved | owner-approved |
| `modelRoles` | guard only, local or small model | guard + agent (Assistant), any model | guard + agent, any model |
| mock price | free | ₹299 / month | ₹799 / month |

## Rules
- **Default plan (prototype):** new signups start on **Plus**. Signup accepts an optional `plan` (`starter`, `plus`, `pro`). See `docs/DECISIONS.md` (A).
- Store entitlements as JSON on `Plan`; check via `EntitlementService.can(user, key)` — never hardcode plan names in logic.
- Downgrade: keep data, disable extra agents/tools (paused, not deleted); audit retained per law/settings.
- **Safety features are never paywalled**: approvals, kill switch, basic audit, and alerts are on every plan.
- Prices and billing are mocked in the prototype.

## Enforcement (v0.7.0)
- `backend/src/services/entitlements.ts` (EntitlementService) is the only place plan checks happen; plan names appear only in `services/plans.ts` (PLN-12 checks this). A refused feature is `402 ENTITLEMENT_REQUIRED` with "Upgrade to unlock …" and `upgradeTo` (the cheapest plan that allows it).
- **Agents:** `maxAgents` counts ACTIVE agents (the built-in Assistant included). Creating or resuming past it is refused.
- **Tools:** connecting needs the tool in `toolCatalog` and a free slot under `maxConnectedTools`.
- **Audit:** the log is never locked. `auditRetentionDays` sets how far back it is shown; older events are kept and `/api/audit/verify` covers them all. Export: CSV, JSON, and an integrity report (whole-chain verify, head hash, SHA-256 of the exported events); each export is audited.
- **Phone alerts:** Web Push needs `pushAlerts` to include `push`; in-app and live (SSE) alerts are on every plan.
- **Model roles:** `modelRoles.roles` and, for the guard, `guardTiers` (local = Ollama or a localhost URL; small = a catalog guard-tier model; frontier; unknown).
- **Downgrade:** extra agents (newest first, the Assistant last) become PAUSED with `paused_by_plan`; extra tools become `PAUSED_PLAN` (proposals get 402). Push devices and model configs are kept; roles the plan lacks show `offReason: PLAN`. An upgrade resumes what fits. Nothing is deleted; every change is audited as `PLAN_CHANGED`.
- **Never locked:** approvals, the kill switch, in-app and live alerts, the audit log and its verification.
