import { h, icon, announce } from './dom.js';
import { STATUS, RISK, FLAG, money, fieldLabel, fieldValue, isLongField, fmtTime } from './format.js';
import { toolName, opLabel } from './state.js';

export const statusChip = status => {
  const s = STATUS[status] ?? STATUS.UNKNOWN;
  return h('span', { class: `badge st-${STATUS[status] ? status : 'UNKNOWN'}`, 'data-status': status }, icon(s.icon, 14, 2.4), s.label);
};
export const riskBadge = level => level
  ? h('span', { class: `badge rk-${level}`, 'data-risk': level }, icon(level === 'LOW' ? 'dot' : 'alert', 14, 2.4), RISK[level] ?? level)
  : null;
export const flagChip = f => h('span', { class: 'flag' }, FLAG[f] ?? f.replace(/_/g, ' ').toLowerCase());
export const modeBadge = mode => h('span', { class: 'mock', title: mode === 'MOCK' ? 'Simulated: no real action is taken' : 'Live provider' }, mode ?? 'MOCK');

/* ---------- toasts ---------- */
export function toast(message) {
  const box = document.getElementById('toasts');
  const close = h('button', { type: 'button', 'aria-label': 'Dismiss' }, '✕');
  const t = h('div', { class: 'toast' }, h('p', {}, message), close);
  close.addEventListener('click', () => t.remove());
  box.append(t);
  setTimeout(() => t.remove(), 5000);
}

/* ---------- dialogs: focus moves in, the rest of the page is inert, Escape cancels (never approves) ---------- */
export function openDialog({ title, body, actions, label }) {
  const layer = document.getElementById('layer');
  const root = document.getElementById('root');
  const opener = document.activeElement;
  const heading = h('h2', { id: 'dlg-title', tabindex: '-1' }, title);
  const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title', 'aria-label': label }, heading, body, h('div', { class: 'actions' }, actions));
  const scrim = h('div', { class: 'scrim' });
  const onKey = e => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    scrim.remove(); dlg.remove();
    root.inert = false;
    if (opener && document.contains(opener)) opener.focus();
  }
  layer.append(scrim, dlg);
  root.inert = true;
  document.addEventListener('keydown', onKey);
  heading.focus();
  return { close, el: dlg };
}

/* ---------- action description ---------- */
const list = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
export function actionTitle(a) {
  const p = a.payload ?? {};
  const people = [...list(p.to), ...list(p.cc), ...list(p.attendees)].filter(x => typeof x === 'string');
  switch (a.intent) {
    case 'MAKE_PAYMENT': return `Pay ${money(p.amount, p.currency)} to ${p.payee ?? p.to ?? 'an unnamed payee'}`;
    case 'REFUND': return `Refund ${money(p.amount, p.currency)}`;
    case 'SUBSCRIBE': return `Subscribe to ${p.plan ?? 'a plan'} for ${money(p.amount, p.currency)}`;
    case 'SEND_EMAIL': case 'SEND_MESSAGE': return `${opLabel(a.tool, a.operation)} on ${toolName(a.tool)} to ${people.length || 'no'} recipient${people.length === 1 ? '' : 's'}`;
    case 'PUBLISH_CONTENT': case 'EDIT_CONTENT': return `${opLabel(a.tool, a.operation)} on ${toolName(a.tool)}${p.audience === 'public' ? ', publicly' : ''}`;
    case 'DELETE_CONTENT': return `Delete from ${toolName(a.tool)}`;
    default: return `${toolName(a.tool)}: ${opLabel(a.tool, a.operation)}`;
  }
}

/** The exact details the user is deciding on. Agent text goes in as text nodes only (UI-05). */
export function payloadFields(payload) {
  const p = { ...(payload ?? {}) };
  const rows = [];
  if (typeof p.amount === 'number') { rows.push(['Amount', money(p.amount, p.currency), false]); delete p.amount; delete p.currency; }
  for (const [k, v] of Object.entries(p)) rows.push([fieldLabel(k), fieldValue(v), isLongField(k)]);
  if (!rows.length) return h('p', { class: 'empty' }, 'No details were sent with this action.');
  return h('dl', { class: 'fields' }, rows.map(([k, v, long]) => h('div', {}, h('dt', {}, k), h('dd', {}, long ? h('p', { class: 'preview' }, v) : v))));
}

/** Where an action stands. A step is only "done" when the backend says so. */
export function pipeline(a) {
  const s = a.status;
  const decided = ['APPROVED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'UNKNOWN'].includes(s);
  const steps = [
    { label: 'Proposed', state: 'done', sub: fmtTime(a.createdAt, false) },
    { label: 'Classified', state: s === 'NEEDS_REVIEW' ? 'warn' : 'done', sub: s === 'NEEDS_REVIEW' ? 'Needs review' : (RISK[a.riskLevel] ?? '—') },
    { label: 'Decision', ...(s === 'PENDING_REVIEW' || s === 'NEEDS_REVIEW' ? { state: 'current', sub: 'Waiting for you' }
      : s === 'REJECTED' ? { state: 'stop', sub: 'Rejected' } : s === 'EXPIRED' ? { state: 'stop', sub: 'Expired' }
      : s === 'BLOCKED' ? { state: 'fail', sub: 'Blocked' } : { state: 'done', sub: 'Approved' }) },
    { label: 'Submitted', ...(decided && s !== 'APPROVED' ? { state: 'done', sub: 'Sent to provider' } : s === 'APPROVED' ? { state: 'current', sub: 'Starting' } : { state: 'idle', sub: 'Not sent' }) },
    { label: 'Result', ...({ COMPLETED: { state: 'done', sub: 'Confirmed' }, FAILED: { state: 'fail', sub: 'Failed' }, UNKNOWN: { state: 'warn', sub: 'Not confirmed' } }[s] ?? { state: 'idle', sub: '—' }) }
  ];
  const ICON = { done: 'ok', current: 'clock', warn: 'q', fail: 'alert', stop: 'x', idle: 'dot' };
  return h('ol', { class: 'card pipe', 'aria-label': 'Progress' }, steps.map(st =>
    h('li', { class: `step ${st.state}` }, h('span', { class: 'node' }, icon(ICON[st.state], 14, 2.8)), h('span', { class: 'sl' }, st.label), h('span', { class: 'ss' }, st.sub))));
}

export function errorText(err) {
  const map = {
    PAYLOAD_CHANGED: 'The details changed after you opened them. Nothing was approved; review the latest version.',
    APPROVAL_EXPIRED: 'This action expired. Ask the agent to propose it again.',
    REAUTH_REQUIRED: 'Please confirm your password to approve this.',
    AGENT_PAUSED: 'Agents are paused, so nothing can run. Turn the kill switch off first.',
    ALREADY_DECIDED: 'This action was already decided.',
    PERMISSION_DENIED: `Not allowed: ${err.message}`,
    RATE_LIMITED: 'Too many attempts. Wait a moment and try again.'
  };
  return map[err.code] ?? err.message ?? 'Something went wrong.';
}

// the toast area is already a polite live region, so this is read out once
export const say = msg => toast(msg);
export const alertNow = msg => announce(msg);
