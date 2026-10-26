/**
 * Fake providers for the MOD-BYO-* tests: AI SDK mock models only, so no test ever calls a real API.
 * Each test builds a factory that maps a stored model config ({ provider, modelId, apiKey, baseUrl }) to a mock.
 */
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

export interface ModelCall { provider: string; modelId: string; apiKey: string | null; baseUrl: string | null }
type Prompt = { role: string; content: unknown }[];

export const usage = (input = 10, output = 5) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined }
});
export const reply = (text: string, u = usage()) => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: undefined }, usage: u, warnings: [] });

/** A guard answer that is valid for the structured-output schema and adds no risk. */
export const calmGuard = { intent: null, riskLevel: null, riskScore: null, confidence: 0.95, reasons: [], flags: [] };

export const invalidKey = (key: string) => new APICallError({
  message: `Incorrect API key provided: ${key}`, url: 'https://api.example.test/v1/chat', requestBodyValues: {}, statusCode: 401, isRetryable: false
});

/** Concatenated text of a prompt, to check what the model was shown. */
export function promptText(prompt: Prompt, role?: string) {
  return prompt.filter(m => !role || m.role === role).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
}

/** A guard-style model: answers every JSON request with `answer(prompt)`; a key containing "bad" is refused with 401. */
export function guardModel(cfg: ModelCall, answer: (prompt: Prompt) => unknown = () => calmGuard, u = usage()) {
  return new MockLanguageModelV4({
    provider: cfg.provider, modelId: cfg.modelId,
    doGenerate: async (opts) => {
      if (cfg.apiKey?.includes('bad')) throw invalidKey(cfg.apiKey);
      const prompt = opts.prompt as Prompt;
      if (opts.responseFormat?.type !== 'json') return reply('OK', u);
      return reply(JSON.stringify(answer(prompt)), u);
    }
  });
}

/** A model with no structured output: always answers in prose. */
export function proseModel(cfg: ModelCall) {
  return new MockLanguageModelV4({ provider: cfg.provider, modelId: cfg.modelId, doGenerate: async () => reply('Sure! The action looks fine to me.') });
}

/** A model that never answers (to hit the 3 s guard timeout, shortened in tests). */
export function hangingModel(cfg: ModelCall) {
  return new MockLanguageModelV4({
    provider: cfg.provider, modelId: cfg.modelId,
    doGenerate: async (opts) => {
      if (opts.responseFormat?.type !== 'json') return reply('OK');
      return new Promise((_resolve, reject) => opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
  });
}

type StreamStep = { text: string } | { toolCall: { toolName: string; input: Record<string, unknown> } };
/** A chat model that streams the given steps in order, one step per model call. */
export function chatModel(cfg: ModelCall, steps: StreamStep[], u = usage()) {
  let i = 0;
  const model = new MockLanguageModelV4({
    provider: cfg.provider, modelId: cfg.modelId,
    doGenerate: async () => reply('OK', u),
    doStream: async () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if ('text' in step) parts.push({ type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: step.text }, { type: 'text-end', id: 't1' });
      else parts.push({ type: 'tool-call', toolCallId: `call-${i}`, toolName: step.toolCall.toolName, input: JSON.stringify(step.toolCall.input) });
      parts.push({ type: 'finish', finishReason: { unified: 'text' in step ? 'stop' : 'tool-calls', raw: undefined }, usage: u });
      return { stream: new ReadableStream({ start(c) { parts.forEach(p => c.enqueue(p)); c.close(); } }) as never };
    }
  });
  return model;
}
