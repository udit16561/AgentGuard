# Changelog

One line per version. Versions follow the plan in `CLAUDE.md` / owner instructions: v0.2.0 frontend, v0.3.0 all mock tools (M2), v0.4.0 tool preferences + payment limits, v0.5.0 bring your own model, v0.6.0 realtime + PWA (M4), v0.7.0 plans (M3); v0.x.1 for fixes.

- **v0.1.0** (2026-10-25, pre-release): Backend M1: permissions, intent/risk, hash-bound approvals with expiry and re-auth, append-only hash-chained audit. Mock adapters only.
- **v0.2.0** (2026-10-25, pre-release): Frontend PWA in the Countersign design: dashboard with kill switch, review with re-auth and expiry countdown, tools, agents and permissions, audit timeline with verify; demo seed. Mock only.
- **v0.3.0** (2026-10-26, pre-release): M2: mock adapters for all nine tools with realistic results, a limits form per tool, per-tool previews, "what changed" on re-proposals, opt-in auto-allow for low-risk reads and alarms (audited). Mock only.
- **v0.4.0** (2026-10-26, pre-release): Tool preferences in plain language (confirm before save, soft flags or hard blocks, per-action check on review, agent read-only access, audited) and payment limits (weekly/monthly/per-payee caps, new-payee rule, methods, categories, hours, PIN threshold, spend vs. caps on the dashboard). Mock only.
- **v0.5.1** (2026-10-27, pre-release): Security review fixes: base-URL DNS is checked at connect time (no DNS-rebinding gap) and IPv4-compatible IPv6 counts as private; Assistant provider errors are never logged; base URLs may not carry a query string or fragment.
- **v0.5.0** (2026-10-27, pre-release): Bring your own model: Settings → Models (encrypted, masked keys; Test connection with a structured-output capability test; agent and guard roles), guard in the risk layer and preference parser (raise-only, falls back to rules), Assistant chat whose actions wait for approval, SSRF-checked base URLs, monthly spend caps, audit without keys. Mock only.
