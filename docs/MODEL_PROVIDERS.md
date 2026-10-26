# Bring Your Own Model (BYOM)

Researched 26 Oct 2026. Verdict: **feasible**, using the Vercel AI SDK in the Node backend.

## 1. What the user does
Settings → **Models** → choose a provider → paste an API key → pick a model from the suggested list, or type any model ID → **Test connection** → assign it a role.
The app must still work with **zero keys**: everything falls back to the deterministic classifier and preference parser.

## 2. Model roles
| Role | Purpose | Required? | Suggested tier |
|---|---|---|---|
| `agent` | Built-in assistant: the user chats ("pay Ravi ₹500", "book a meeting with Asha tomorrow") and the model proposes actions. It is **just another agent**: every tool call goes through `POST /api/actions` and the three gates. | Optional | Frontier |
| `guard` | Optional model layer for intent/risk and the preference parser (INTENT_AND_RISK §3, PREFERENCES). It may only raise risk, add flags, or draft rules for the user to confirm. | Optional | Small |
| none | Deterministic rules plus TF-IDF | Always on | — |

Rules:
- A model never approves, never lowers risk, and never edits permissions, preferences or audit. Same gates as any agent.
- Recommend a **different provider** for `guard` than for `agent`, so one model isn't checking itself, and show a warning if they're the same.
- A guard error, timeout (3 s) or schema failure leads to `NEEDS_REVIEW`.

## 3. Library choice
- **Use:** the Vercel AI SDK (`ai` package plus `@ai-sdk/*` providers). It's TypeScript, matches the backend, gives one API for text, tool calling and structured output, and covers OpenAI, Anthropic, Google, Mistral, Groq, DeepSeek, xAI, Cohere, Together, Fireworks, Cerebras and others. For any other OpenAI-compatible server (OpenRouter, Ollama, LM Studio, a custom URL), use its OpenAI-compatible provider package. Pin exact versions.
- **Don't use** Anthropic's OpenAI-compatibility endpoint. Anthropic says it isn't for production, and it silently ignores `response_format` and `strict`. Use the native `@ai-sdk/anthropic` provider instead.
- **Skip LiteLLM** for now. It's Python (a separate proxy service), and it's only worth it later for team budgets.
- Structured output support varies by model (the AI SDK provider table marks some Together, Fireworks and DeepInfra models ✗, and Groq offers `json_object` only). So the guard role must pass a capability test: a real schema call with 5 sample cases, checked with zod. Fail means the model can't be assigned to `guard`.

## 4. Suggested models (seed list, editable JSON: `backend/src/models/catalog.json`)
Prices are USD per 1M tokens (input/output), taken from public pricing pages in October 2026. Show them as "approx." with a "checked on" date. The user can always type any model ID.

**Frontier (role: agent)**
| Provider | Model ID | Approx. price |
|---|---|---|
| Anthropic | `claude-opus-5-5` | $4 / $20 |
| Anthropic | `claude-sonnet-5-5` | $2 / $10 |
| OpenAI | `gpt-6.1-sol` | $2 / $10 |
| OpenAI | `gpt-6-astra` | $10 / $50 |
| Google | Gemini 3.1 Pro (preview; read the ID from the provider's model list) | $2 / $12 |

**Small (role: guard)**
| Provider | Model ID | Approx. price |
|---|---|---|
| Anthropic | `claude-haiku-5-5` | $0.10 / $0.50 (prompts ≤ 100K) |
| OpenAI | `gpt-6-luna` | $0.10 / $0.50 |
| Google | `gemini-3.1-flash-lite` | $0.25 / $1.50, free tier available |
| Google | `gemini-3.8-flash` | $0.75 / $3.75 until 31 Dec 2026 |

**Local / free (either role, guard recommended)**
| Provider | Setup | Notes |
|---|---|---|
| Ollama | Base URL `http://localhost:11434/v1`, any key | MIT runtime. Qwen 3, Llama, Gemma, Phi or Mistral; a 7B Q4 model fits in about 8 GB of VRAM. Supports JSON-schema output. Nothing leaves the PC. |
| OpenRouter | `https://openrouter.ai/api/v1`, IDs like `anthropic/claude-sonnet-...` | One key for many models. Filter to models that support structured outputs. |

## 5. Security for user API keys
- Encrypt at rest (AES-256-GCM, the existing token key). Show only the last 4 characters. Never return a key to the frontend, logs, audit data or agents.
- Only the owner can add, test, rotate or delete keys, with CSRF and re-auth. Every change is audited (`MODEL_KEY_ADDED/REMOVED`, `MODEL_ROLE_CHANGED`) without the key itself.
- Custom base URLs: allow `https://` URLs and `http://localhost` only. Block private-network addresses other than localhost (SSRF protection).
- Optional per-role monthly spend cap. Count tokens from the SDK's usage data. When the cap is reached, the role is switched off and the app falls back to deterministic rules.
- Prompt injection: agent-supplied text goes to the guard as quoted data, never as instructions. Guard output is schema-validated and can only raise risk.

## 6. API
- `GET /api/models/catalog`: the suggested list
- `GET /api/models`: the user's configured models (masked)
- `POST /api/models`: `{ provider, modelId, apiKey?, baseUrl?, label }`
- `POST /api/models/:id/test`: connectivity, plus the structured-output capability test for guard
- `PUT /api/models/roles`: `{ agent: id|null, guard: id|null }`
- `DELETE /api/models/:id`
- `POST /api/assistant/chat`: built-in agent (role `agent`). It streams a reply, and its tool calls become proposals.

## 7. Tests (MOD-BYO-*)
No key means the app runs on deterministic rules · invalid key fails the test · a model with no structured output can't be the guard · a guard timeout gives NEEDS_REVIEW · the key never appears in any API response, log or audit row · an agent key can't read or change models · an assistant chat that tries to pay creates PENDING_REVIEW, not COMPLETED · an SSRF base URL is rejected · the spend cap switches the role off · a prompt-injection text sent to the guard can't lower risk. Tests use a **fake provider** (an AI SDK mock model), with no real API calls in CI.
