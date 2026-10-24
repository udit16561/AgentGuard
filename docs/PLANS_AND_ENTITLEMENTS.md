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

## Rules
- **Default plan (prototype):** new signups start on **Plus**. Signup accepts an optional `plan` (`starter`, `plus`, `pro`). See `docs/DECISIONS.md` (A).
- Store entitlements as JSON on `Plan`; check via `EntitlementService.can(user, key)` — never hardcode plan names in logic.
- Downgrade: keep data, disable extra agents/tools (paused, not deleted); audit retained per law/settings.
- **Safety features are never paywalled**: approvals, kill switch, basic audit, and alerts are on every plan.
- Prices and billing are mocked in the prototype.
