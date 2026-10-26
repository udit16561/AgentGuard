import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { checkResolvedHost, type Lookup } from './baseUrl';
import type { Provider } from './catalog';

/**
 * Turns a stored model config into an AI SDK model (docs/MODEL_PROVIDERS.md §3). Native providers for OpenAI,
 * Anthropic, Google, Groq and Mistral; the OpenAI-compatible provider only for OpenRouter, Ollama and custom URLs.
 * Anthropic is never reached through its OpenAI-compatibility endpoint. Tests replace this factory with mock models.
 */
export interface ModelSpec { provider: Provider; modelId: string; apiKey: string | null; baseUrl: string | null }
export type ModelFactory = (spec: ModelSpec) => LanguageModel;

/** fetch for model calls: no redirects (they could point anywhere), and custom URLs re-checked against SSRF before every request. */
function guardedFetch(baseUrl: string | null, lookup?: Lookup): typeof fetch {
  return async (input, init) => {
    if (baseUrl) await checkResolvedHost(baseUrl, lookup);
    return fetch(input, { ...init, redirect: 'error' });
  };
}

export function providerFactory(opts: { lookup?: Lookup } = {}): ModelFactory {
  return ({ provider, modelId, apiKey, baseUrl }) => {
    const key = apiKey ?? undefined;
    const native = { apiKey: key, fetch: guardedFetch(null) };
    switch (provider) {
      case 'anthropic': return createAnthropic(native)(modelId);
      case 'openai': return createOpenAI(native)(modelId);
      case 'google': return createGoogle(native)(modelId);
      case 'groq': return createGroq(native)(modelId);
      case 'mistral': return createMistral(native)(modelId);
      default: {
        if (!baseUrl) throw new Error('A base URL is required');
        // Ollama ignores the key, but the client still sends one
        return createOpenAICompatible({ name: provider, baseURL: baseUrl, apiKey: key ?? 'ollama', includeUsage: true, supportsStructuredOutputs: true, fetch: guardedFetch(baseUrl, opts.lookup) })(modelId);
      }
    }
  };
}
