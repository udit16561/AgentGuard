import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export type ErrorCode =
  | 'UNAUTHENTICATED' | 'PERMISSION_DENIED' | 'ENTITLEMENT_REQUIRED' | 'APPROVAL_REQUIRED' | 'APPROVAL_EXPIRED'
  | 'PAYLOAD_CHANGED' | 'REAUTH_REQUIRED' | 'AGENT_PAUSED' | 'VALIDATION_ERROR' | 'PROVIDER_ERROR'
  | 'ALREADY_DECIDED' | 'CSRF_INVALID' | 'RATE_LIMITED' | 'NOT_FOUND' | 'MODEL_UNAVAILABLE' | 'PUSH_DISABLED'
  | 'LIVE_UNAVAILABLE' | 'RECONNECT_REQUIRED' | 'MODE_CHANGED';

/** Thrown anywhere in a route; turned into the documented error format by errorHandler. */
export class AppError extends Error {
  constructor(public status: number, public code: ErrorCode, message: string, public actionId?: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new AppError(404, 'NOT_FOUND', what);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.actionId ? { actionId: err.actionId } : {}), ...(err.extra ?? {}) } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } });
    return;
  }
  // body-parser errors (bad JSON, too large) carry a status
  const status = (err as { status?: number }).status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body could not be read' } });
    return;
  }
  console.error(err instanceof Error ? err.message : 'Unexpected error');   // never log request bodies: they may hold secrets
  res.status(500).json({ error: { code: 'PROVIDER_ERROR', message: 'Unexpected server error' } });
}
