import { Router } from 'express';
import type { Ctx } from '../context';
import { requireCsrf, requireUser } from '../middleware/auth';
import { agentModel, ChatBody, runChat } from '../models/assistant';
import type { ProposalOptions } from '../services/proposals';

/**
 * POST /api/assistant/chat: the built-in agent (role "agent"). The reply streams as newline-delimited JSON events
 * ({type:"text"}, {type:"proposal"}, {type:"error"}, {type:"done"}). Signed-in owner only; agent keys get 401.
 */
export function assistantRoutes(ctx: Ctx, opts: ProposalOptions = {}) {
  const r = Router();
  r.post('/chat', requireUser, requireCsrf, async (req, res) => {
    const body = ChatBody.parse(req.body);
    const userId = req.user!.id;
    // refuse before streaming starts, so the client gets a normal JSON error
    agentModel(ctx, userId);
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    await runChat(ctx, userId, body, e => { res.write(`${JSON.stringify(e)}\n`); }, opts);
    res.end();
  });
  return r;
}
