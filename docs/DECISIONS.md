# Decisions

Owner decisions that resolve gaps between the docs and the acceptance tests. Newest last. The other docs are kept in line with these.

| # | Date | Decision |
|---|---|---|
| A | 2026-10-25 | New signups start on the **Plus** plan during the prototype. `POST /api/auth/signup` accepts an optional `plan`; PLN tests choose Starter explicitly. |
| B | 2026-10-25 | SQLite has no database users, so the prototype has **no blocking trigger** on `audit_events`. Append-only is enforced by having no edit routes, the hash chain and `/api/audit/verify`. PostgreSQL GRANTs (INSERT/SELECT only) come with the migration. |
| C | 2026-10-25 | `NEEDS_REVIEW` actions **can be approved**, but are treated like HIGH: re-auth is required and the UI warns that the classifier was unsure. |
| D | 2026-10-25 | The approval window (`APPROVAL_TTL_MINUTES`, default 10) **starts when the action is proposed**. It is checked whenever the action is read or approved; an expired action becomes `EXPIRED`. |
| E | 2026-10-25 | **Bulk messaging** (more than 5 recipients) is at least **CRITICAL** (score ≥ 80), whatever the other boosts add up to. |
| F | 2026-10-25 | `POST /api/actions/:id/approve` checks in this order: owner (404) → already decided (409 `ALREADY_DECIDED`) → expired (410) → payload hash (409) → kill switch or paused agent (423) → permission and limits (403) → re-auth (401) → approve and execute. |
| G | 2026-10-25 | Signup **creates the session** (no separate login needed). Signup and login are exempt from CSRF; every other state-changing user request needs the `X-CSRF-Token` header. |
| H | 2026-10-26 | v0.4.0 payment limits and tool preferences: weeks start on **Monday** and months on the 1st, in the user's time zone; a **per-payee cap is per calendar month**. A blocked category **named** in `category` is BLOCKED, while the same words only hinted in the payee or note **raise the risk** (+25). Preferences are **per user and tool** (all agents), apply to write operations only, are **soft by default** (the user ticks "hard" on the confirm step), and hard rules are re-checked at approval and execution. |
| I | 2026-10-27 | v0.5.0 bring your own model: the **Vercel AI SDK** (exact pinned versions) with native providers for OpenAI, Anthropic, Google, Groq and Mistral, and the OpenAI-compatible provider only for OpenRouter, Ollama and custom URLs. Native providers accept **no base URL**. A role needs a **passed Test connection**; the guard also needs all **5 capability cases** to validate. Key changes need **CSRF + re-auth**; role changes need CSRF. Spend caps are in **USD per calendar month** (user's time zone) and need a catalog price. The Assistant is an agent row with **no permissions by default**, and the same proposal path as `POST /api/actions`. |
