# Reference GitHub Repositories

Open-source projects worth studying or reusing. **Rule:** do not add any of these as a dependency without the owner's approval. Check each project's license before copying code. Our repo stays private and proprietary; Apache-2.0 and MIT code may be used if its license notice is kept.

## A. How AgentGuard fits

```
 AI agent (OpenAI Agents SDK / LangGraph / Claude / MCP client)
        │  proposes action (agent API key)
        ▼
 AgentGuard backend  ── policy ── intent/risk ── approval ── audit (ours)
        │  executes only after all 3 gates
        ▼
 Tool adapters (mock → Nango/official APIs) ──► Gmail, Calendar, WhatsApp, X ...
```

The agent frameworks below pause the agent; **AgentGuard is the place that decides and records**.

## B. Repositories by purpose

### 1. Agent-side approval pause (human-in-the-loop)
| Repo | Lang | License | Use it for |
|---|---|---|---|
| [openai/openai-agents-js](https://github.com/openai/openai-agents-js) (`@openai/agents`) | TS | MIT | Tools with `needsApproval: true` pause the run and return `interruptions` plus a resumable `state`. Our example agent client uses this pattern to wait for an AgentGuard decision. |
| [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs) (`@langchain/langgraph`) | TS | MIT | `interrupt()` inside a tool, resume with `new Command({ resume })`. Needs a checkpointer. Put side effects *after* the interrupt, because the node re-runs on resume. |
| [humanlayer/humanlayer](https://github.com/humanlayer/humanlayer) | Py/TS | Apache-2.0 | Early "require approval" decorator design for agent tool calls. Study only; check the project's current direction before using it. |

### 2. Tool protocol (connect agents to tools)
| Repo | Lang | License | Use it for |
|---|---|---|---|
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | TS | MIT | Later milestone: expose AgentGuard as an **MCP server**, so any MCP-capable agent must call our guarded tools. |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | TS/Py | MIT/Apache-2.0 | Reference servers (Filesystem, Git, Fetch, Memory, Time…). Many older ones (Slack, Google Drive, GitHub) are archived, so use them as code examples only. |

### 3. OAuth and tool integrations (for the live-adapter milestone)
| Repo | Lang | License | Use it for |
|---|---|---|---|
| [NangoHQ/nango](https://github.com/NangoHQ/nango) | TS | Open source (check `LICENSE`) | Managed OAuth, token refresh and 1,000+ APIs. Self-hosting is Enterprise-only, so the prototype would use Nango Cloud's free tier or direct provider APIs. |
| Composio | — | Closed tool definitions | Hosted alternative. Not open source, so it's not recommended for a private proprietary core. |
| Official APIs | — | — | Google (Gmail and Calendar APIs), WhatsApp Business Cloud API (Meta), LinkedIn, X API v2, Instagram Graph API, Razorpay or Stripe **test mode** for payments. |

### 4. Guardrails and intent/injection detection (optional classifier layer)
| Repo | Lang | License | Use it for |
|---|---|---|---|
| [NVIDIA-NeMo/Guardrails](https://github.com/NVIDIA-NeMo/Guardrails) | Python | Apache-2.0 | Input, dialog, retrieval, **execution (tool)** and output rails. It can run as a sidecar HTTP server (`nemoguardrails server`). Turn its default telemetry off. |
| [meta-llama/PurpleLlama](https://github.com/meta-llama/PurpleLlama) (LlamaFirewall) | Python | See repo | PromptGuard 2 (jailbreak and injection), AlignmentCheck (goal misalignment, experimental), CodeShield. Good for flagging prompt injection inside agent payloads. |

Use these only through `IntentService`, behind a timeout. If one errors, the action becomes `NEEDS_REVIEW` (fail closed).

### 5. Authorization policy engine (optional, after M3)
| Repo | Lang | License | Use it for |
|---|---|---|---|
| [cerbos/cerbos](https://github.com/cerbos/cerbos) | Go | Apache-2.0 | App-level permissions in YAML with CEL conditions. It's stateless and a good match for "agent X may do operation Y on tool Z under limit L". |
| [open-policy-agent/opa](https://github.com/open-policy-agent/opa) | Go | Apache-2.0 | General policy engine using Rego, which is more powerful but harder to learn. |

The prototype starts with our own `PolicyService` and can move to Cerbos when policies grow.

### 6. Observability (separate from the audit log)
| Repo | Lang | License | Use it for |
|---|---|---|---|
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | TS | MIT | Traces of LLM and agent calls, self-hostable and OpenTelemetry-based. It's for debugging and cost tracking. **It is not the audit log**: the audit log stays in our append-only, hash-chained table. |

## C. What we build ourselves (no library replaces it)
- Hash-bound approvals with expiry and re-auth
- Append-only hash-chained audit log
- Three-gate execution check
- Plan entitlements
- Approval UI on PC and mobile
