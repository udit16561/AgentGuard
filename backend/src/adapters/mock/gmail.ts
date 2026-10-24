import { list, need, nowIso, rid, str, type MockTool } from './util';

const messageId = () => `<${rid('', 8)}@mail.agentguard.mock>`;
const INBOX = [
  { id: 'm1', from: 'Asha Rao <asha@example.com>', subject: 'Notes from today', snippet: 'Sharing the notes we discussed…', unread: true },
  { id: 'm2', from: 'HDFC Bank <alerts@bank.example>', subject: 'Your statement is ready', snippet: 'Your October statement…', unread: true },
  { id: 'm3', from: 'Raj K <raj@example.com>', subject: 'Invoice #4471', snippet: 'Please find the invoice attached…', unread: false }
];

/** Gmail, simulated: message ids look like real RFC 822 ids, sent mail is labelled SENT. */
export const gmail: MockTool = {
  read: p => ({ providerRef: rid('gmail-read-'), result: { query: str(p.query, 'in:inbox'), messages: INBOX.filter(m => !String(p.query ?? '').includes('is:unread') || m.unread) } }),
  search: p => ({ providerRef: rid('gmail-read-'), result: { query: str(p.query), messages: INBOX.slice(0, 2) } }),
  send: p => {
    const to = list(p.to);
    need(to.length, 'Gmail needs at least one recipient');
    const id = messageId();
    return { providerRef: id, result: { messageId: id, threadId: rid('thr_'), to, cc: list(p.cc), subject: str(p.subject, '(no subject)'), labelIds: ['SENT'], sentAt: nowIso() } };
  },
  reply: p => {
    const id = messageId();
    return { providerRef: id, result: { messageId: id, threadId: str(p.threadId) || rid('thr_'), to: list(p.to), labelIds: ['SENT'], inReplyTo: str(p.messageId) || null, sentAt: nowIso() } };
  },
  forward: p => {
    need(list(p.to).length, 'Forwarding needs a recipient');
    const id = messageId();
    return { providerRef: id, result: { messageId: id, forwardedFrom: str(p.id, 'unknown'), to: list(p.to), labelIds: ['SENT'], sentAt: nowIso() } };
  },
  delete: p => {
    const ids = list(p.ids ?? p.id);
    need(ids.length, 'Nothing to delete');
    return { providerRef: rid('gmail-trash-'), result: { trashed: ids.length, ids, recoverableUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() } };
  }
};
