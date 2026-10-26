import catalog from './catalog.json';

/**
 * Suggested models and providers (docs/MODEL_PROVIDERS.md §4). The JSON is an editable seed list:
 * prices are approximate and dated, and the user can always type any model ID.
 */
export const PROVIDERS = ['anthropic', 'openai', 'google', 'groq', 'mistral', 'openrouter', 'ollama', 'custom'] as const;
export type Provider = typeof PROVIDERS[number];
export const ROLES = ['agent', 'guard'] as const;
export type Role = typeof ROLES[number];

export interface ProviderInfo { id: Provider; name: string; kind: 'native' | 'openai-compatible'; needsKey: boolean; defaultBaseUrl?: string; note?: string }
export interface Price { input: number; output: number }

export const CATALOG = catalog as {
  checkedOn: string; note: string; providers: ProviderInfo[];
  models: { provider: Provider; modelId: string | null; label: string; role: Role; price: Price; note?: string }[];
};

export const providerInfo = (id: Provider) => CATALOG.providers.find(p => p.id === id)!;

/** Approximate USD price per 1M tokens, when the model is in the catalog. */
export function priceOf(provider: string, modelId: string): Price | null {
  return CATALOG.models.find(m => m.provider === provider && m.modelId === modelId)?.price ?? null;
}

export const costUsd = (price: Price | null, inputTokens: number, outputTokens: number) =>
  price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
