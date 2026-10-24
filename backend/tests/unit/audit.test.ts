/** Unit tests for the audit service and redaction, below the API (complements SEC-17, SEC-18, SEC-24). */
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db';
import { createClock } from '../../src/clock';
import { createAuditService } from '../../src/services/audit';
import { redact } from '../../src/services/redact';

const fresh = () => { const db = openDb(':memory:'); return { db, audit: createAuditService(db, createClock()) }; };

describe('audit service', () => {
  it('AUD-01 sequence starts at 1 and the chain verifies', () => {
    const { audit } = fresh();
    expect(audit.append({ userId: 'u1', actorType: 'USER', actorId: 'u1', eventType: 'USER_SIGNUP' })).toBe(1);
    audit.append({ userId: 'u1', actorType: 'AGENT', actorId: 'a1', eventType: 'ACTION_PROPOSED', data: { tool: 'payments' } });
    expect(audit.verify()).toEqual({ ok: true, count: 2 });
  });

  it('AUD-02 editing any column of a stored row is detected at that row', () => {
    const { db, audit } = fresh();
    for (let i = 0; i < 3; i++) audit.append({ userId: 'u1', actorType: 'SYSTEM', actorId: null, eventType: `E${i}` });
    db.prepare("UPDATE audit_events SET event_type = 'HIDDEN' WHERE seq = 2").run();
    expect(audit.verify()).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('AUD-03 deleting a row is detected', () => {
    const { db, audit } = fresh();
    for (let i = 0; i < 3; i++) audit.append({ userId: 'u1', actorType: 'SYSTEM', actorId: null, eventType: `E${i}` });
    db.prepare('DELETE FROM audit_events WHERE seq = 2').run();
    expect(audit.verify()).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it('AUD-04 lists only the requesting user’s events', () => {
    const { audit } = fresh();
    audit.append({ userId: 'u1', actorType: 'USER', actorId: 'u1', eventType: 'A' });
    audit.append({ userId: 'u2', actorType: 'USER', actorId: 'u2', eventType: 'B' });
    expect(audit.list('u1').map(e => e.eventType)).toEqual(['A']);
  });
});

describe('redaction', () => {
  it('RED-01 masks card and account numbers and drops secret keys', () => {
    const out = JSON.stringify(redact({ cardNumber: '4111 1111 1111 1111', note: 'acct 123456789012', apiKey: 'sk_live_x', nested: { password: 'p' }, amount: 500 }));
    expect(out).not.toContain('4111 1111 1111 1111');
    expect(out).not.toContain('123456789012');
    expect(out).not.toContain('sk_live_x');
    expect(out).toContain('****1111');
    expect(out).toContain('"amount":500');
  });
});
