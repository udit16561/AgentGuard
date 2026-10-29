import { h, icon, toolIcon } from './dom.js';
import { money, fieldLabel, fieldValue, fmtWhen } from './format.js';
import { toolName } from './state.js';

/**
 * A familiar picture of what the action will look like: an email draft, a post card, a meeting card,
 * a chat bubble, an alarm or a payment receipt. Everything the agent wrote goes in as text only.
 */
const list = v => (Array.isArray(v) ? v : v == null ? [] : [v]).filter(x => typeof x === 'string');
const str = v => (typeof v === 'string' ? v : '');
const initials = s => s.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';
const avatar = s => h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(s));
const when = iso => (Number.isNaN(Date.parse(iso)) ? String(iso ?? '') : fmtWhen(iso));
const frame = (kind, title, ...children) => h('section', { class: 'card', id: 'preview', 'aria-labelledby': 'preview-h' },
  h('div', { class: 'card-h' }, h('h2', { id: 'preview-h' }, title), h('span', { class: 'mock' }, 'Preview')), h('div', { class: `pv ${kind}` }, ...children));

function email(a) {
  const p = a.payload;
  const verb = { reply: 'Reply', forward: 'Forward' }[a.operation] ?? 'New message';
  const head = (k, v) => h('div', { class: 'em-row' }, h('span', { class: 'em-k' }, k), h('span', { class: 'em-v' }, v));
  return frame('email', `Email draft · ${verb}`,
    head('From', 'You, sent by your agent'), head('To', list(p.to).join(', ') || '(nobody)'),
    list(p.cc).length ? head('Cc', list(p.cc).join(', ')) : null,
    head('Subject', str(p.subject) || (a.operation === 'forward' ? `Fwd: message ${str(p.id)}` : '(no subject)')),
    h('p', { class: 'em-body' }, str(p.body) || (a.operation === 'forward' ? 'The original message is forwarded as is.' : '')),
    list(p.attachments).length ? h('p', { class: 'chips' }, list(p.attachments).map(f => h('span', { class: 'flag' }, `📎 ${f}`))) : null);
}

function post(a) {
  const p = a.payload;
  const text = str(p.text) || str(p.caption) || str(p.body);
  const audience = p.audience === 'public' || ['instagram', 'blog', 'linkedin'].includes(a.tool) && !p.audience ? 'Public' : str(p.audience) || 'Your followers';
  const verb = { reply: 'Reply', repost: 'Repost', comment: 'Comment', story: 'Story (24 hours)', edit_live: 'Edit to a live post', publish: 'Blog post' }[a.operation] ?? 'Post';
  return frame('post-card', `${toolName(a.tool)} · ${verb}`,
    h('div', { class: 'pc-head' }, h('span', { class: 'ic' }, toolIcon(a.tool)), h('span', { class: 'pc-who' }, h('b', {}, 'Your account'), h('span', {}, `on ${toolName(a.tool)}`)), h('span', { class: 'badge st-NEEDS_REVIEW' }, audience)),
    str(p.title) ? h('h3', { class: 'pc-title' }, str(p.title)) : null,
    text ? h('p', { class: 'pc-text' }, text) : null,
    p.postId ? h('p', { class: 'fine' }, `${a.operation === 'repost' ? 'Reposting' : 'On'} post ${p.postId}`) : null,
    list(p.media).length ? h('div', { class: 'pc-media' }, list(p.media).map(m => h('span', { class: 'pc-thumb' }, icon('blog', 18), m))) : null,
    a.tool === 'x' && text ? h('p', { class: `fine ${text.length > 280 ? 'over' : ''}` }, `${text.length}/280 characters`) : null);
}

function meeting(a) {
  const p = a.payload;
  const people = list(p.attendees).filter(x => !['you', 'me', 'self'].includes(x.toLowerCase()));
  const verb = { create: 'New meeting', invite: 'Adding people', update: 'Changing a meeting', cancel: 'Cancelling a meeting' }[a.operation] ?? 'Meeting';
  const note = a.operation === 'cancel' ? 'will get a cancellation' : a.operation === 'update' ? 'will be told about the change' : 'will get an invitation';
  return frame('meeting', `Calendar · ${verb}`,
    h('div', { class: `mt-head ${a.operation === 'cancel' ? 'cancel' : ''}` }, icon('calendar', 22),
      h('div', {}, h('b', {}, str(p.title) || (p.eventId ? `Event ${p.eventId}` : 'Untitled meeting')),
        h('p', {}, p.start ? `${when(p.start)}${p.end ? ` → ${when(p.end).split(', ').pop()}` : ''}` : str(p.time) ? when(p.time) : 'Time not given'))),
    h('p', { class: 'sub-h' }, people.length ? `${people.length} attendee${people.length === 1 ? '' : 's'} ${note}` : 'No other attendees'),
    h('ul', { class: 'attendees' }, people.map(x => h('li', { class: 'attendee' }, avatar(x), h('span', {}, x)))));
}

function chat(a) {
  const p = a.payload;
  return frame('chat', `${toolName(a.tool)} · Message`,
    h('p', { class: 'sub-h' }, `To ${list(p.to).join(', ') || '(nobody)'}`),
    h('div', { class: 'bubble' }, h('p', {}, str(p.text) || ' '), list(p.media).length ? h('p', { class: 'chips' }, list(p.media).map(m => h('span', { class: 'flag' }, `📎 ${m}`))) : null, h('span', { class: 'tick' }, 'not sent yet')));
}

function alarm(a) {
  const p = a.payload;
  return frame('alarm', a.operation === 'set_reminder' ? 'Reminder' : 'Alarm',
    h('p', { class: 'al-time' }, str(p.time) || '--:--'), h('p', {}, str(p.label) || str(p.text) || (a.operation === 'set_reminder' ? 'Reminder' : 'Alarm')),
    h('p', { class: 'fine' }, 'On your phone. Easy to turn off later.'));
}

function receipt(a) {
  const p = a.payload, r = a.execution?.result ?? {};
  const paid = a.status === 'COMPLETED';
  const title = { refund: 'Refund', subscribe: 'Subscription' }[a.operation] ?? 'Payment';
  const row = (k, v) => v == null || v === '' ? null : h('div', { class: 'rc-row' }, h('span', {}, k), h('b', {}, String(v)));
  return frame('receipt', `${title} receipt`,
    h('p', { class: 'rc-amount' }, money(p.amount, p.currency)),
    h('p', { class: `rc-stamp ${paid ? 'paid' : ''}` }, paid ? (a.operation === 'refund' ? 'Refunded' : 'Paid') : a.status === 'FAILED' ? 'Payment failed' : 'Not paid yet'),
    row('To', str(p.payee) || str(p.to)), row('Plan', str(p.plan)), row('Note', str(p.note)), row('Refund of', str(p.txnId)),
    row('Receipt', r.receiptNumber), row('Transaction', r.transactionId ?? r.refundId ?? r.subscriptionId), row('Next billing', r.nextBillingDate),
    h('p', { class: 'fine' }, paid ? 'Confirmed by the payment provider (simulated).' : 'Nothing is charged unless you approve and the provider confirms.'));
}

function danger(a) {
  const p = a.payload;
  const items = list(p.ids ?? p.id ?? p.postId);
  return frame('danger-card', 'Deletion',
    h('p', { class: 'dg' }, icon('alert', 20), ` This will delete ${items.length > 1 ? `${items.length} items` : items[0] ?? 'content'} from ${toolName(a.tool)}.`),
    h('p', { class: 'fine' }, a.tool === 'gmail' ? 'Emails go to Trash for 30 days.' : 'This may not be recoverable.'));
}

function readAccess(a) {
  return frame('read', `${toolName(a.tool)} · Read access`,
    h('p', {}, `Your agent wants to read from ${toolName(a.tool)}.`),
    Object.keys(a.payload).length ? h('dl', { class: 'fields' }, Object.entries(a.payload).map(([k, v]) => h('div', {}, h('dt', {}, fieldLabel(k)), h('dd', {}, fieldValue(v))))) : null,
    h('p', { class: 'fine' }, 'Reading changes nothing. You can let LOW-risk reads run without asking, under Agents.'));
}

export function preview(a) {
  const op = a.operation;
  if (a.intent === 'DELETE_CONTENT') return danger(a);
  if (a.intent === 'READ_DATA') return readAccess(a);
  if (a.tool === 'payments') return receipt(a);
  if (a.tool === 'gmail') return email(a);
  if (a.tool === 'calendar') return meeting(a);
  if (a.tool === 'clock') return alarm(a);
  if (a.tool === 'whatsapp' || op === 'dm' || op === 'message') return chat(a);
  if (['x', 'instagram', 'linkedin', 'blog'].includes(a.tool)) return op === 'connect' ? chat({ ...a, payload: { to: a.payload.to, text: a.payload.note ?? 'Connection request' } }) : post(a);
  return null;
}

/** Field-by-field changes since the version this action replaces. */
export function changesCard(a) {
  if (!a.replaces) return null;
  const show = v => (v == null ? '(none)' : fieldValue(v));
  return h('section', { class: 'card changes', id: 'changes', 'aria-labelledby': 'changes-h' },
    h('h2', { id: 'changes-h' }, icon('alert', 18), ' What changed since the agent’s last version'),
    a.changes.length
      ? h('ul', { class: 'diff' }, a.changes.map(c => h('li', { 'data-field': c.field }, h('b', {}, `${fieldLabel(c.field)}: `), h('del', {}, show(c.before)), ' → ', h('ins', {}, show(c.after)))))
      : h('p', {}, 'Nothing changed in the details.'),
    h('p', { class: 'fine' }, `The earlier version is ${a.replaces.status === 'BLOCKED' ? 'blocked and can no longer run' : a.replaces.status.toLowerCase().replace('_', ' ')}. `,
      h('a', { class: 'link', href: `#/review/${encodeURIComponent(a.replaces.id)}` }, 'See the earlier version')));
}
