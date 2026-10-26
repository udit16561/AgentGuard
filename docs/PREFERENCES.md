# Tool Preferences and Payment Limits (v0.4.0)

## 1. What they are
Each tool has a **Preferences** box (≤ 500 characters, plain language), for example:
- Gmail: "Use udit@work.com for clients. No emails after 9pm. Sign as 'Udit'. Never send attachments to new recipients."
- Calendar: "No meetings before 10am or on Sundays. Max 45 minutes."
- X / LinkedIn: "Professional tone only. No posts about politics."

Preferences are **per user and tool**: every agent is held to them. They apply to write operations only. Reads are never checked.

## 2. Parsing (`backend/src/services/preferences/parse.ts`)
1. **Deterministic parser (default, non-parametric).** The text is split into sentences and matched with regex and keyword patterns: times ("after 9pm", "08:00–22:00"), days and weekends, email addresses and `@domains`, amounts (₹, Rs, INR), durations, never/always/only phrases, and lists of topics.
2. **Optional small model**, used when `PREFERENCE_MODEL_PROVIDER=anthropic`. The model is set by `PREFERENCE_MODEL` (default `claude-haiku-5-5`) and the key by `PREFERENCE_MODEL_API_KEY`, both in `.env`. Since v0.5.0 the user's own **guard** model (Settings → Models) takes this place when one is assigned. Its answer has to pass the same strict zod schema within **3 s**. On any error, timeout or answer outside the schema, the deterministic parser is used, and the response says why.
3. **Grants are ignored.** Sentences such as "auto-approve all payments" or "skip approval" never become rules. They are listed back to the user as ignored.
4. **The user confirms.** The confirm step shows "I understood: …", one line per rule, each with a *Hard rule* switch. Nothing is saved until **Confirm and save**. The original text and the confirmed rules are both stored. Each save is audited as `PREFERENCE_CHANGED`, with the old and new text.

## 3. Rule types (all restrictions)
| Type | Fields | Checked against |
|---|---|---|
| `account` | accounts[], purpose? | `payload.from` / `payload.account` must be one of the accounts |
| `recipient` | mode `allow`/`deny`, values[] (addresses or `@domain`) | to, cc, bcc, attendees, recipients |
| `timeWindow` | notBefore?, notAfter? (HH:MM) | a meeting's start, a scheduled send, an alarm's time, otherwise now (user's time zone) |
| `dayBlock` | days[] | the same reference time's weekday |
| `maxDuration` | minutes | end − start, or `durationMinutes` |
| `requiredText` | text | the message text (case-insensitive) |
| `blockedTopics` | topics[] | TF-IDF cosine similarity ≥ **0.35** ⇒ `PREFERENCE_TOPIC` |
| `tone` | professional / formal / friendly / casual | lexicon of hostile and unprofessional words, shouting ⇒ `PREFERENCE_TONE` |
| `attachmentPolicy` | `none` / `knownRecipientsOnly` | attachments vs. the permission's known recipients |
| `maxAmount` | amount | `payload.amount` |

No rule type allows, approves or widens anything.

## 4. Checking every proposal (`check.ts`, wired into gate 1)
- A **soft** rule that is broken adds +20 risk (at most +40) and a reason ("Breaks your preference: …"), with the flag `PREFERENCE_VIOLATION`.
- A **hard** rule that is broken makes the action **BLOCKED** (`403 PERMISSION_DENIED`, reason `PREFERENCE_VIOLATION`). It is checked again at approval and at execution.
- If the checker fails or the stored rules can't be read, the action goes to `NEEDS_REVIEW` (`PREFERENCE_CHECK_ERROR`). At approval time the same failure blocks the action.
- Following every rule never lowers risk and never approves anything.
- The review screen shows "Preference check: ✔ follows / ⚠ breaks: <rule>".

## 5. Agents
`GET /api/agents/me/preferences[?tool=]` returns the confirmed rules, with their labels, for the tools the agent may use. A well-behaved agent can follow them up front. Agents never see the raw text and can never write preferences.

## 6. Payment limits (Agents → Payments → Limits)
| Limit | Key | Effect |
|---|---|---|
| Per-transaction max | `maxAmount` | over ⇒ BLOCKED |
| Daily / weekly / monthly cap | `dailyCap`, `weeklyCap`, `monthlyCap` | over ⇒ BLOCKED. Weeks start Monday, months on the 1st (DECISIONS H). |
| Allowed payees | `allowedPayees` | anyone else ⇒ BLOCKED |
| Per-payee cap | `payeeCaps` `{ name: amount }` | per calendar month; over ⇒ BLOCKED |
| New payees | `newPayees` `approve` (default) / `block` | approve: +20 risk; block: BLOCKED |
| Methods | `allowedMethods` (upi, card, netbanking, wallet) | method switched off ⇒ BLOCKED; missing ⇒ NEEDS_REVIEW |
| Blocked categories | `blockedCategories` | named in `category` ⇒ BLOCKED; hinted in payee or note ⇒ +25 `CATEGORY_MATCH` |
| Allowed hours | `timeWindow` + `enforceHours` | outside ⇒ BLOCKED when enforced, otherwise +10 |
| PIN above | `reauthAbove` | the password is always needed above it (`REAUTH_THRESHOLD`) |

The dashboard shows each agent's spending today, this week and this month against its caps (`GET /api/me/spending`). Spending counts payments that are approved, submitted, completed or unconfirmed, not ones still waiting.
