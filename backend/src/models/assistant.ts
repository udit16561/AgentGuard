import { isStepCount, streamText, tool } from 'ai';
import { z } from 'zod';
import type { Ctx } from '../context';
import { AppError } from '../http';
import { CATALOG as TOOLS } from '../services/catalog';
import { createProposal, type ProposalOptions } from '../services/proposals';
import { activeModel, ensureAssistant, recordUsage, roleState, specOf } from './store';
import { classifyError, ERROR_TEXT } from './guard';

/**
 * The agent role (docs/MODEL_PROVIDERS.md §2): a chat with the user's own model, which is just another agent.
 * Its only tool is propose_action, which goes through createProposal (the same path as POST /api/actions), so the
 * permission check, classifier, alerts, approvals and audit all apply. It has no way to approve or run anything.
 */
export const ChatBody = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(4000) }).strict()).min(1).max(30)
}).strict();

const CHAT_TIMEOUT_MS = 60_000;
const MAX_STEPS = 4;

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'proposal'; id: string | null; tool: string; operation: string; status: string; riskLevel?: string; reason?: string; message?: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };

function systemPrompt(allowed: { tool: string; operation: string }[]) {
  const list = allowed.length
    ? allowed.map(a => `- ${a.tool}.${a.operation} (${TOOLS[a.tool]?.operations[a.operation]?.label ?? a.operation})`).join('\n')
    : '- none yet: the user has not given you any permissions';
  return `You are the AgentGuard Assistant. You help the user by proposing actions with the propose_action tool.
Every proposal waits for the user's approval in AgentGuard, so never say an action is done: say it is waiting for their approval.
You cannot approve, execute, or change permissions, preferences, settings or the audit log.
Operations you may propose:
${list}
Payments need amount (number), currency (for example INR), payee and method (upi, card, netbanking or wallet). Emails need to (a list), subject and body.
If a proposal comes back BLOCKED, explain the reason briefly; do not try to get around it.`;
}

/** The agent-role model, or a 409 when none is assigned or its monthly spend cap is reached. */
export function agentModel(ctx: Ctx, userId: string) {
  const m = activeModel(ctx, userId, 'agent');
  if (m) return m;
  const capped = roleState(ctx, userId, 'agent').offReason === 'SPEND_CAP';
  throw new AppError(409, 'MODEL_UNAVAILABLE', capped ? 'The Assistant is off: its monthly spend cap is reached.' : 'No Assistant model yet. Add one under Settings → Models and give it the agent role.');
}

export async function runChat(ctx: Ctx, userId: string, body: z.infer<typeof ChatBody>, write: (e: ChatEvent) => void, opts: ProposalOptions = {}) {
  const m = agentModel(ctx, userId);
  const agent = ensureAssistant(ctx, userId);
  const allowed = ctx.db.prepare('SELECT tool, operation FROM permissions WHERE agent_id = ? AND allowed = 1 ORDER BY tool, operation').all(agent.id) as { tool: string; operation: string }[];

  const propose_action = tool({
    description: 'Propose one action for the user to approve in AgentGuard. Returns its id and status; it never runs before the user approves.',
    inputSchema: z.object({ tool: z.string().max(64), operation: z.string().max(64), payload: z.record(z.string(), z.unknown()) }),
    execute: async input => {
      try {
        const out = await createProposal(ctx, agent, input, opts);
        write({ type: 'proposal', id: out.id, tool: input.tool, operation: input.operation, status: out.status, riskLevel: out.riskLevel });
        return { id: out.id, status: out.status, riskLevel: out.riskLevel };
      } catch (e) {
        const err = e instanceof AppError ? e : null;
        const reason = err?.code ?? 'VALIDATION_ERROR';
        const message = err?.message ?? 'The proposal was not valid';
        write({ type: 'proposal', id: err?.actionId ?? null, tool: input.tool, operation: input.operation, status: 'BLOCKED', reason, message });
        return { status: 'BLOCKED', reason, message };
      }
    }
  });

  try {
    const result = streamText({
      model: ctx.modelFactory(specOf(ctx, m)), system: systemPrompt(allowed), messages: body.messages,
      tools: { propose_action }, stopWhen: isStepCount(MAX_STEPS), maxRetries: 0, abortSignal: AbortSignal.timeout(CHAT_TIMEOUT_MS)
    });
    let failure: unknown = null;
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') write({ type: 'text', text: part.text });
      else if (part.type === 'error') failure = part.error;
    }
    if (failure) throw failure;
    recordUsage(ctx, userId, 'agent', m, await result.totalUsage);
  } catch (e) {
    const code = classifyError(e);
    write({ type: 'error', code, message: ERROR_TEXT[code] });
  }
  write({ type: 'done' });
}
