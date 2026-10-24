/** A tool adapter. Mock adapters are the default; live adapters need owner approval per provider (docs/ROADMAP.md M6). */
export interface AdapterResult {
  /** The provider's confirmation reference. Without one the action is UNKNOWN, never COMPLETED (gate 3). */
  providerRef?: string | null;
  result?: Record<string, unknown>;
}

export interface Adapter {
  mode: 'MOCK' | 'LIVE';
  execute(operation: string, payload: Record<string, unknown>, meta: { actionId: string }): Promise<AdapterResult>;
}
