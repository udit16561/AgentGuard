import crypto from 'node:crypto';

/** Stable JSON: object keys sorted at every level, so equal data always hashes the same. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort()
      .filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** docs/SECURITY_AND_APPROVALS.md §2: payloadHash = SHA-256(canonicalJSON({ agentId, tool, operation, payload })) */
export const payloadHash = (agentId: string, tool: string, operation: string, payload: unknown) =>
  sha256(canonicalJSON({ agentId, tool, operation, payload }));

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
