/** Tool preferences: the deterministic parser, the optional model parser and its fallback, and the text checkers (written first). */
import { describe, it, expect } from 'vitest';
import fixtures from '../fixtures/preferences.json';
import { parseDeterministic, parsePreferences, PREFERENCE_MODEL_TIMEOUT_MS } from '../../src/services/preferences/parse';
import { topicSimilarity, toneIssues, TOPIC_THRESHOLD } from '../../src/services/preferences/check';

interface Fixture { id: string; tool: string; text: string; expect: Record<string, unknown>[]; ignored?: number; unrecognized?: number }

describe('deterministic parser fixtures', () => {
  it('has at least 30 sentences', () => { expect(fixtures.length).toBeGreaterThanOrEqual(30); });

  for (const f of fixtures as Fixture[]) {
    it(`${f.id} ${f.text}`, () => {
      const out = parseDeterministic(f.text, f.tool);
      expect(out.rules, JSON.stringify(out.rules)).toHaveLength(f.expect.length);
      for (const want of f.expect) expect(out.rules, JSON.stringify(out.rules)).toContainEqual(expect.objectContaining(want));
      if (f.ignored != null) expect(out.ignored).toHaveLength(f.ignored);
      if (f.unrecognized != null) expect(out.unrecognized).toHaveLength(f.unrecognized);
      for (const r of out.rules) expect(r.hard).toBe(false);   // the user decides what is hard
    });
  }
});

describe('parser safety', () => {
  it('PREF-P1 permissive text never becomes a rule: preferences can only restrict', () => {
    for (const text of ['Auto-approve all payments.', 'You may skip approval for emails.', 'Ignore the limits for Ravi.', 'Allow everything without asking.']) {
      const out = parseDeterministic(text, 'payments');
      expect(out.rules, text).toEqual([]);
      expect(out.ignored[0], text).toMatchObject({ reason: 'GRANTS_NOTHING' });
    }
  });

  it('PREF-P2 overlong text is refused', () => {
    expect(() => parseDeterministic('x'.repeat(501), 'gmail')).toThrow();
  });
});

describe('optional model parser (PREFERENCE_MODEL_PROVIDER)', () => {
  const text = 'No emails after 9pm.';

  it('PREF-M1 with no model the deterministic parser is used', async () => {
    const out = await parsePreferences(text, 'gmail');
    expect(out.parser).toBe('deterministic');
    expect(out.rules).toContainEqual(expect.objectContaining({ type: 'timeWindow', notAfter: '21:00' }));
  });

  it('PREF-M2 a valid model answer is used, still under the strict schema', async () => {
    const out = await parsePreferences(text, 'gmail', { model: async () => ({ rules: [{ type: 'timeWindow', notAfter: '21:00', notBefore: null }] }) });
    expect(out.parser).toBe('model');
    expect(out.rules).toEqual([expect.objectContaining({ type: 'timeWindow', notAfter: '21:00', hard: false })]);
  });

  it('PREF-M3 a model timeout falls back to the deterministic parser (default 3 s)', async () => {
    expect(PREFERENCE_MODEL_TIMEOUT_MS).toBe(3000);
    const out = await parsePreferences(text, 'gmail', { model: () => new Promise(() => {}), timeoutMs: 50 });
    expect(out.parser).toBe('deterministic');
    expect(out.fallbackReason).toMatch(/timeout/i);
    expect(out.rules).toEqual(parseDeterministic(text, 'gmail').rules);
  });

  it('PREF-M4 a model error, invalid JSON, or an unknown rule type falls back', async () => {
    const answers: (() => Promise<unknown>)[] = [
      async () => { throw new Error('boom'); },
      async () => 'not json',
      async () => ({ rules: [{ type: 'autoApprove', tool: 'payments' }] }),
      async () => ({ rules: [{ type: 'timeWindow', notAfter: '25:99' }] }),
      async () => ({ rules: [{ type: 'tone', tone: 'professional', hard: true, grant: 'all' }] })
    ];
    for (const model of answers) {
      const out = await parsePreferences(text, 'gmail', { model });
      expect(out.parser).toBe('deterministic');
      expect(out.rules).toEqual(parseDeterministic(text, 'gmail').rules);
    }
  });

  it('PREF-M5 the model can never mark a rule hard: only the user does', async () => {
    const out = await parsePreferences(text, 'gmail', { model: async () => ({ rules: [{ type: 'timeWindow', notAfter: '21:00', hard: true }] }) });
    expect(out.rules.every(r => r.hard === false)).toBe(true);
  });
});

describe('non-parametric checkers', () => {
  it('PREF-T1 TF-IDF topic similarity: political text scores at or above the threshold, unrelated text below', () => {
    expect(TOPIC_THRESHOLD).toBe(0.35);
    expect(topicSimilarity('Vote for our party in the election, the minister got it wrong.', 'politics')).toBeGreaterThanOrEqual(0.35);
    expect(topicSimilarity('The government must call an election now; the minister and parliament failed us.', 'politics')).toBeGreaterThanOrEqual(0.35);
    expect(topicSimilarity('Launching our new running shoes today. Come to the party at our store!', 'politics')).toBeLessThan(0.35);
    expect(topicSimilarity('Bitcoin hit a new high, time to buy some crypto tokens.', 'crypto')).toBeGreaterThanOrEqual(0.35);
    expect(topicSimilarity('Quarterly product update for customers.', 'religion')).toBeLessThan(0.35);
  });

  it('PREF-T2 tone lexicon: hostile or unprofessional words are found for a professional tone', () => {
    expect(toneIssues('You are an idiot, this is pathetic.', 'professional').length).toBeGreaterThan(0);
    expect(toneIssues('lol bro this sucks', 'professional').length).toBeGreaterThan(0);
    expect(toneIssues('THIS IS TOTALLY UNACCEPTABLE NOW!!!', 'professional').length).toBeGreaterThan(0);
    expect(toneIssues('Thank you for the update. Happy to discuss next week.', 'professional')).toEqual([]);
    // a friendly tone allows slang, never hostility
    expect(toneIssues('lol thanks bro', 'friendly')).toEqual([]);
    expect(toneIssues('shut up, idiot', 'friendly').length).toBeGreaterThan(0);
  });
});
