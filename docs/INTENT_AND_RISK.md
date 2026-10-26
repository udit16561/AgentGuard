# Intent Classification and Risk Scoring

## 1. Purpose
Explain to the user *what the agent is trying to do* and *how risky it is*, so the alert is meaningful. It is advisory; it never decides approval.

## 2. Intent categories
`READ_DATA, SEND_MESSAGE, SEND_EMAIL, PUBLISH_CONTENT, EDIT_CONTENT, DELETE_CONTENT, SCHEDULE_EVENT, MODIFY_EVENT, CANCEL_EVENT, SET_REMINDER, MAKE_PAYMENT, REFUND, SUBSCRIBE, CONNECT_SOCIAL, UNKNOWN`

## 3. Prototype approach (two layers)
1. **Rule layer (deterministic, always runs):** map tool+operation to base intent and base risk; apply rule boosts.
2. **Optional model layer:** an LLM or small classifier reads the payload and may add reasons, sentiment/tone flags (e.g., aggressive message, misleading post), or raise risk. Output must be strict JSON validated by schema; otherwise ignored and status = NEEDS_REVIEW.

## 4. Risk levels
| Level | Score | Examples |
|---|---|---|
| LOW | 0–24 | read inbox, personal alarm |
| MEDIUM | 25–49 | message to known contact, calendar invite to self |
| HIGH | 50–79 | public post, email to new recipient, payment under limit |
| CRITICAL | 80–100 | payment over limit/new payee, delete data, mass messaging |

## 5. Risk boosts (add to score)
- New/unknown recipient or payee +20
- Amount > 50% of daily cap +15; over cap ⇒ BLOCKED
- Public audience +15
- Outside allowed hours +10
- Bulk (> 5 recipients) +20, and the result is **at least CRITICAL** (score ≥ 80), matching "mass messaging" in §4 (DECISIONS E)
- Negative/hostile tone or sensitive content flagged +15
- Links/attachments from untrusted source +10
- Payload contains instruction-like text aimed at the system (prompt injection) +25 and flag
- Payment whose payee or note hints at a blocked category (e.g. "casino" when gambling is blocked) +25, flag `CATEGORY_MATCH`. A category named outright in `category` is BLOCKED by the policy instead.
- Over the daily, weekly, monthly or per-payee cap ⇒ BLOCKED. New payee: +20 (or BLOCKED when the user set `newPayees: "block"`).
- Payment above the user's PIN threshold: flag `REAUTH_THRESHOLD`; approval always needs the password.
- Payment method missing while methods are restricted ⇒ `NEEDS_REVIEW` (`MISSING_DETAILS`).
- Each broken **soft** tool preference +20 (at most +40), flag `PREFERENCE_VIOLATION` (plus `PREFERENCE_TOPIC` or `PREFERENCE_TONE`). A broken **hard** preference is BLOCKED. A preference that cannot be checked ⇒ `NEEDS_REVIEW` (`PREFERENCE_CHECK_ERROR`). Preferences never lower risk. See docs/PREFERENCES.md.

## 6. Output shape
```json
{ "intent": "MAKE_PAYMENT", "riskLevel": "HIGH", "riskScore": 62,
  "confidence": 0.91, "reasons": ["New payee", "Amount 60% of daily cap"],
  "flags": [] }
```
Confidence < 0.6 or intent `UNKNOWN` ⇒ `NEEDS_REVIEW`. A `NEEDS_REVIEW` action can still be approved, with re-auth, like HIGH (DECISIONS C).

## 7. Evaluation
Keep a labelled fixture set (`backend/tests/fixtures/intents.json`, ≥ 50 cases across tools). Report accuracy per intent and ensure no CRITICAL case is ever scored below HIGH.
