/** M2: each tool's MOCK adapter returns a realistic provider response, with no network (written before the adapters). */
import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../../src/adapters';

type Case = [tool: string, operation: string, payload: Record<string, unknown>, ref: RegExp, keys: string[]];
const CASES: Case[] = [
  ['gmail', 'send', { to: ['asha@example.com'], subject: 'Notes', body: 'Hi' }, /^<[a-z0-9]+@mail\.agentguard\.mock>$/, ['messageId', 'threadId', 'to', 'subject', 'labelIds', 'sentAt']],
  ['gmail', 'reply', { to: ['asha@example.com'], threadId: 't-1', body: 'Thanks' }, /@mail\.agentguard\.mock>$/, ['messageId', 'threadId', 'labelIds']],
  ['gmail', 'forward', { id: 'm3', to: ['raj@example.com'] }, /@mail\.agentguard\.mock>$/, ['messageId', 'forwardedFrom']],
  ['gmail', 'delete', { ids: ['m1', 'm2'] }, /^gmail-trash-/, ['trashed']],
  ['gmail', 'read', { query: 'is:unread' }, /^gmail-read-/, ['messages']],
  ['calendar', 'create', { title: 'Sync', start: '2026-11-02T10:00:00+05:30', end: '2026-11-02T10:30:00+05:30', attendees: ['a@co.in', 'b@co.in'] }, /^evt_/, ['eventId', 'htmlLink', 'attendees', 'invitationsSent']],
  ['calendar', 'update', { eventId: 'evt_1', start: '2026-11-02T11:00:00+05:30' }, /^evt_1$/, ['eventId', 'updated']],
  ['calendar', 'cancel', { eventId: 'evt_2', attendees: ['a@co.in'] }, /^evt_2$/, ['eventId', 'status', 'cancellationsSent']],
  ['calendar', 'invite', { eventId: 'evt_3', attendees: ['c@co.in'] }, /^evt_3$/, ['eventId', 'added']],
  ['clock', 'set_alarm', { time: '07:00', label: 'Gym' }, /^alarm_/, ['alarmId', 'time', 'enabled']],
  ['clock', 'set_reminder', { time: '18:00', text: 'Call mom' }, /^rem_/, ['reminderId', 'time', 'text']],
  ['clock', 'list_alarms', {}, /^clock-list-/, ['alarms']],
  ['whatsapp', 'send_message', { to: ['+91-98000-00001'], text: 'Reaching at 8' }, /^wamid\./, ['messages']],
  ['whatsapp', 'send_media', { to: ['+91-98000-00001'], media: ['photo.jpg'] }, /^wamid\./, ['messages', 'media']],
  ['instagram', 'post', { caption: 'Sunset', media: ['img1.jpg'] }, /^ig_/, ['mediaId', 'permalink']],
  ['instagram', 'story', { media: ['s.jpg'] }, /^igs_/, ['storyId', 'expiresAt']],
  ['instagram', 'comment', { postId: 'ig_9', text: 'Lovely' }, /^igc_/, ['commentId']],
  ['instagram', 'dm', { to: 'new_follower', text: 'Hi' }, /^igdm_/, ['messageId']],
  ['linkedin', 'post', { text: 'Hiring!' }, /^urn:li:share:/, ['urn', 'url']],
  ['linkedin', 'message', { to: 'recruiter-1', text: 'Thanks' }, /^urn:li:message:/, ['messageUrn']],
  ['linkedin', 'connect', { to: 'hm-9' }, /^li-inv-/, ['invitationId', 'status']],
  ['x', 'post', { text: 'Launching today!' }, /^\d{18,19}$/, ['tweetId', 'url']],
  ['x', 'reply', { text: 'Thanks!', postId: '1234567890123456789' }, /^\d{18,19}$/, ['tweetId', 'inReplyTo']],
  ['x', 'repost', { postId: '1234567890123456789' }, /^\d{18,19}$/, ['repostId']],
  ['x', 'dm', { to: 'random_user', text: 'Hey' }, /^dm_/, ['dmEventId']],
  ['blog', 'publish', { title: 'Hello', body: 'First post' }, /^post_/, ['postId', 'url', 'revision', 'status']],
  ['blog', 'edit_live', { postId: 'post_7', body: 'Updated' }, /^post_7$/, ['postId', 'revision']],
  ['blog', 'delete', { postId: 'post_8' }, /^post_8$/, ['postId', 'status']],
  ['payments', 'pay', { amount: 500, currency: 'INR', payee: 'Ravi' }, /^pay_/, ['transactionId', 'status', 'amount', 'currency', 'payee', 'receiptNumber']],
  ['payments', 'transfer', { amount: 200, currency: 'INR', payee: 'Ravi' }, /^pay_/, ['transactionId', 'status']],
  ['payments', 'refund', { txnId: 'pay_1', amount: 300, currency: 'INR' }, /^rfnd_/, ['refundId', 'status', 'amount']],
  ['payments', 'subscribe', { plan: 'monthly', amount: 499, currency: 'INR' }, /^sub_/, ['subscriptionId', 'status', 'nextBillingDate']],
  ['payments', 'view_balance', {}, /^bal-/, ['available', 'currency']]
];

describe('mock adapters (M2)', () => {
  for (const [tool, operation, payload, ref, keys] of CASES) {
    it(`ADP ${tool}.${operation} returns a realistic MOCK response`, async () => {
      const adapter = mockAdapter(tool);
      expect(adapter.mode).toBe('MOCK');
      const out = await adapter.execute(operation, payload, { actionId: 'act_test' });
      expect(out.providerRef).toMatch(ref);
      for (const k of keys) expect(out.result).toHaveProperty(k);
    });
  }

  it('ADP-ERR providers reject impossible requests, which the app records as FAILED', async () => {
    await expect(mockAdapter('payments').execute('pay', { amount: 0, currency: 'INR', payee: 'Ravi' }, { actionId: 'a' })).rejects.toThrow(/amount/i);
    await expect(mockAdapter('x').execute('post', { text: 'x'.repeat(281) }, { actionId: 'a' })).rejects.toThrow(/280/);
    await expect(mockAdapter('clock').execute('set_alarm', { time: '25:99' }, { actionId: 'a' })).rejects.toThrow(/time/i);
  });
});
