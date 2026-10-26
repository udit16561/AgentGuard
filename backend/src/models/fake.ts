import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ModelFactory } from './providers';

/**
 * Fake models for the browser tests only (app.ts enables this with NODE_ENV=test and MODEL_PROVIDER_MODE=fake).
 * Nothing leaves the machine: a key containing "bad" is refused, a model ID containing "prose" has no structured
 * output, and the chat model proposes "pay <name> <amount>" through the propose_action tool.
 */
const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } };
const stop = { unified: 'stop' as const, raw: undefined };
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], finishReason: stop, usage, warnings: [] });

type Prompt = { role: string; content: unknown }[];
const lastUser = (prompt: Prompt) => {
  const m = [...prompt].reverse().find(x => x.role === 'user');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : (m.content as { type: string; text?: string }[]).map(p => p.text ?? '').join(' ');
};
const PAY = /\bpay\s+([A-Za-z][\w ]{0,30}?)\s+(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\b/i;

export function fakeModelFactory(): ModelFactory {
  return ({ provider, modelId, apiKey }) => new MockLanguageModelV4({
    provider, modelId,
    doGenerate: async opts => {
      if (apiKey?.includes('bad')) throw new APICallError({ message: 'Unauthorized', url: 'https://fake.invalid', requestBodyValues: {}, statusCode: 401, isRetryable: false });
      if (opts.responseFormat?.type !== 'json' || modelId.includes('prose')) return text('OK, that looks fine.');
      const schema = JSON.stringify(opts.responseFormat.schema ?? {});
      return text(JSON.stringify(schema.includes('"rules"') ? { rules: [] } : { intent: null, riskLevel: null, riskScore: null, confidence: 0.9, reasons: [], flags: [] }));
    },
    doStream: async opts => {
      const prompt = opts.prompt as Prompt;
      const pay = PAY.exec(lastUser(prompt));
      const answered = prompt.some(m => m.role === 'tool');
      const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if (pay && !answered) {
        const input = { tool: 'payments', operation: 'pay', payload: { amount: Number(pay[2]), currency: 'INR', payee: pay[1].trim(), method: 'upi' } };
        parts.push({ type: 'tool-call', toolCallId: 'fake-1', toolName: 'propose_action', input: JSON.stringify(input) });
        parts.push({ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage });
      } else {
        const reply = answered ? 'I have proposed it. It is waiting for your approval in Review.' : 'I can propose actions for you to approve. Try “pay Ravi ₹500”.';
        parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: reply }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: stop, usage });
      }
      return { stream: new ReadableStream({ start(c) { parts.forEach(p => c.enqueue(p)); c.close(); } }) as never };
    }
  });
}
