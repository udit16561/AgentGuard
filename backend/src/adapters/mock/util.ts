import crypto from 'node:crypto';
import type { AdapterResult } from '../types';

/** Thrown by a mock provider for a request a real provider would refuse; the execution service records FAILED. */
export class ProviderError extends Error {}

export type MockOperation = (payload: Record<string, unknown>, meta: { actionId: string }) => AdapterResult;
export type MockTool = Record<string, MockOperation>;

export const rid = (prefix = '', bytes = 6) => `${prefix}${crypto.randomBytes(bytes).toString('hex')}`;
export const digits = (n: number) => { let s = String(1 + crypto.randomInt(9)); while (s.length < n) s += crypto.randomInt(10); return s; };
export const nowIso = () => new Date().toISOString();
export const list = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x): x is string => typeof x === 'string');
export const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
export function need(cond: unknown, message: string): asserts cond { if (!cond) throw new ProviderError(message); }
