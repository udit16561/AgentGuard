/** A tool adapter. Mock adapters are the default; a live adapter exists only where the owner approved it (Google Calendar, v0.8.0). */
export interface AdapterResult {
  /** The provider's confirmation reference. Without one the action is UNKNOWN, never COMPLETED (gate 3). */
  providerRef?: string | null;
  result?: Record<string, unknown>;
}

export interface AdapterMeta {
  actionId: string;
  /** re-checks every gate; a live adapter calls it right before the provider request and stops if it throws */
  recheck?: () => void | Promise<void>;
}

export interface Adapter {
  mode: 'MOCK' | 'LIVE';
  execute(operation: string, payload: Record<string, unknown>, meta: AdapterMeta): Promise<AdapterResult>;
}
