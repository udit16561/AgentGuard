import type { Ctx } from '../context';
import type { ErrorCode } from '../http';
import { connection, isLiveTool, liveUnavailable, needsReconnect, RECONNECT_TEXT, UNAVAILABLE_TEXT, type LiveConn } from './google/oauth';
import { checkLivePayload } from './google/calendar';

/**
 * Part of gate 1 for a tool in LIVE mode (called by checkPolicy on propose, approve and right before the call):
 * live mode on this server, a plan with live integrations, a working Google sign-in, and a payload Google can take.
 * A LIVE action that fails here is refused; it never falls back to MOCK.
 */
export function liveGate(ctx: Ctx, userId: string, tool: string, operation: string, payload: Record<string, unknown>, conn: LiveConn):
  null | { status: number; code: ErrorCode; reason: string; message: string } {
  const unavailable = liveUnavailable(ctx);
  if (!isLiveTool(tool) || unavailable) return { status: 409, code: 'LIVE_UNAVAILABLE', reason: 'LIVE_UNAVAILABLE', message: UNAVAILABLE_TEXT[unavailable ?? 'INTEGRATION_MODE_OFF'] };
  if (!ctx.entitlements.can(userId, { feature: 'liveIntegrations' })) return { status: 402, code: 'ENTITLEMENT_REQUIRED', reason: 'LIVE_NOT_IN_PLAN', message: 'Upgrade to unlock live integrations: your plan runs tools in MOCK only' };
  if (needsReconnect(ctx, conn)) return { status: 409, code: 'RECONNECT_REQUIRED', reason: 'RECONNECT_REQUIRED', message: RECONNECT_TEXT };
  const checked = checkLivePayload(operation, payload);
  if (!checked.ok) return { status: 400, code: 'VALIDATION_ERROR', reason: 'LIVE_PAYLOAD_INVALID', message: checked.message };
  return null;
}

/** Live status of each tool for the Tools screen and the "Reconnect Google" banner. Never includes a token. */
export function liveStatus(ctx: Ctx, userId: string, tool: string) {
  if (!isLiveTool(tool)) return { available: false, reconnect: false, reason: 'NO_LIVE_ADAPTER' };
  const c = connection(ctx, userId, tool);
  return { available: !liveUnavailable(ctx), reconnect: needsReconnect(ctx, c), reason: liveUnavailable(ctx), locked: ctx.entitlements.lock(userId, { feature: 'liveIntegrations' }) };
}

export function liveSummary(ctx: Ctx, userId: string) {
  const rows = ctx.db.prepare("SELECT tool, status, mode, live_state, live_since, encrypted_token FROM tool_connections WHERE user_id = ? AND mode = 'LIVE' AND status = 'CONNECTED'").all(userId) as (LiveConn & { tool: string })[];
  return { live: rows.map(r => r.tool), reconnect: rows.filter(r => needsReconnect(ctx, r)).map(r => r.tool) };
}
