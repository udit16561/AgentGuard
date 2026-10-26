import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent, fetch as undiciFetch } from 'undici';
import { checkBaseUrl, isLocalBaseUrl, pinnedLookup, type Resolve } from './baseUrl';
import type { Provider } from './catalog';

/**
 * Turns a stored model config into an AI SDK model (docs/MODEL_PROVIDERS.md §3). Native providers for OpenAI,
 * Anthropic, Google, Groq and Mistral; the OpenAI-compatible provider only for OpenRouter, Ollama and custom URLs.
 * Anthropic is never reached through its OpenAI-compatibility endpoint. Tests replace this factory with mock models.
 */
export interface ModelSpec { provider: Provider; modelId: string; apiKey: string | null; baseUrl: string | null }
export type ModelFactory = (spec: ModelSpec) => LanguageModel;

/** Native providers: fixed public endpoints, and redirects (which could point anywhere) are refused. */
const nativeFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });

/**
 * Custom base URLs: the URL is re-checked, and the socket's own DNS lookup refuses private addresses, so the address
 * checked is the address connected to (no DNS-rebinding gap). Redirects are refused.
 */
function pinnedFetch(baseUrl: string, resolve?: Resolve): typeof fetch {
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(isLocalBaseUrl(baseUrl), resolve) as never } });
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const check = checkBaseUrl(baseUrl);
    if (!check.ok) throw new Error(check.reason);
    return undiciFetch(input as never, { ...(init as object), redirect: 'error', dispatcher } as never);
  }) as unknown as typeof fetch;
}

export function providerFactory(opts: { resolveHost?: Resolve } = {}): ModelFactory {
  const pinned = new Map<string, typeof fetch>();   // one connection pool per base URL
  const pinnedFor = (url: string) => { if (!pinned.has(url)) pinned.set(url, pinnedFetch(url, opts.resolveHost)); return pinned.get(url)!; };
  return ({ provider, modelId, apiKey, baseUrl }) => {
    const key = apiKey ?? undefined;
    const native = { apiKey: key, fetch: nativeFetch };
    switch (provider) {
      case 'anthropic': return createAnthropic(native)(modelId);
      case 'openai': return createOpenAI(native)(modelId);
      case 'google': return createGoogle(native)(modelId);
      case 'groq': return createGroq(native)(modelId);
      case 'mistral': return createMistral(native)(modelId);
      default: {
        if (!baseUrl) throw new Error('A base URL is required');
        // Ollama ignores the key, but the client still sends one
        return createOpenAICompatible({ name: provider, baseURL: baseUrl, apiKey: key ?? 'ollama', includeUsage: true, supportsStructuredOutputs: true, fetch: pinnedFor(baseUrl) })(modelId);
      }
    }
  };
}
