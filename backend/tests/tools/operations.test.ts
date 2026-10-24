/** M2: every write operation of every tool goes through the three gates end to end (written before the adapters). */
import { describe, it, expect } from 'vitest';
import { setup, connectTool, allow, propose, getAction, approve, reauth } from '../helpers';

const OPS: [string, string, Record<string, unknown>, string][] = [
  ['gmail', 'send', { to: ['asha@example.com'], subject: 'Notes', body: 'Hi' }, 'messageId'],
  ['gmail', 'reply', { to: ['asha@example.com'], threadId: 't-1', body: 'Thanks' }, 'threadId'],
  ['gmail', 'forward', { id: 'm3', to: ['asha@example.com'] }, 'forwardedFrom'],
  ['gmail', 'delete', { ids: ['m1'] }, 'trashed'],
  ['calendar', 'create', { title: 'Sync', start: '2026-11-02T10:00:00+05:30', end: '2026-11-02T10:30:00+05:30', attendees: ['asha@example.com'] }, 'htmlLink'],
  ['calendar', 'update', { eventId: 'evt_1', start: '2026-11-02T11:00:00+05:30' }, 'updated'],
  ['calendar', 'cancel', { eventId: 'evt_2', attendees: ['asha@example.com'] }, 'cancellationsSent'],
  ['clock', 'set_alarm', { time: '07:00' }, 'alarmId'],
  ['clock', 'set_reminder', { time: '18:00', text: 'Call mom' }, 'reminderId'],
  ['whatsapp', 'send_message', { to: ['asha@example.com'], text: 'Hi' }, 'messages'],
  ['whatsapp', 'send_media', { to: ['asha@example.com'], media: ['photo.jpg'] }, 'media'],
  ['instagram', 'post', { caption: 'Sunset', media: ['img1.jpg'] }, 'permalink'],
  ['instagram', 'dm', { to: 'asha@example.com', text: 'Hi' }, 'messageId'],
  ['linkedin', 'post', { text: 'Hiring!' }, 'urn'],
  ['linkedin', 'message', { to: 'asha@example.com', text: 'Thanks' }, 'messageUrn'],
  ['x', 'post', { text: 'Launching today!' }, 'tweetId'],
  ['x', 'reply', { text: 'Thanks!', postId: '1234567890123456789' }, 'inReplyTo'],
  ['x', 'dm', { to: 'asha@example.com', text: 'Hey' }, 'dmEventId'],
  ['blog', 'publish', { title: 'Hello', body: 'First post' }, 'url'],
  ['blog', 'edit_live', { postId: 'post_7', body: 'Updated' }, 'revision'],
  ['blog', 'delete', { postId: 'post_8' }, 'status'],
  ['payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi' }, 'receiptNumber'],
  ['payments', 'refund', { txnId: 'pay_1', amount: 300, currency: 'INR' }, 'refundId'],
  ['payments', 'subscribe', { plan: 'monthly', amount: 499, currency: 'INR' }, 'subscriptionId']
];

describe('every operation needs approval, then completes with the tool’s own result', () => {
  for (const [tool, operation, payload, key] of OPS) {
    it(`OPS ${tool}.${operation}`, async () => {
      const ctx = await setup();
      await connectTool(ctx, tool);
      await allow(ctx, tool, operation, tool === 'payments' ? { dailyCap: 10000, knownPayees: ['Ravi'] } : { knownRecipients: ['asha@example.com'] });
      const res = await propose(ctx, tool, operation, payload);
      expect(res.status).toBe(201);
      expect(['PENDING_REVIEW', 'NEEDS_REVIEW']).toContain(res.body.status);   // nothing runs before approval
      const a = await getAction(ctx, res.body.id);
      expect(a.execution).toBeNull();
      await reauth(ctx);
      expect((await approve(ctx, a.id, a.payloadHash)).status).toBe(200);
      const done = await getAction(ctx, a.id);
      expect(done.status).toBe('COMPLETED');
      expect(done.execution.adapterMode).toBe('MOCK');
      expect(done.execution.result).toHaveProperty(key);
    });
  }
});
