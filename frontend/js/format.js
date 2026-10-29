import { state } from './state.js';

/** Labels and formatting. Display preferences live in localStorage; nothing secret is ever stored there. */
const PREF_KEY = 'agentguard.prefs.v1';
export const prefs = (() => {
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); return { theme: ['light', 'dark'].includes(p.theme) ? p.theme : 'system', tz: p.tz === 'local' ? 'local' : 'account' }; }
  catch { return { theme: 'system', tz: 'account' }; }
})();
export function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* preferences are optional */ } }
export function clearPrefs() { try { localStorage.removeItem(PREF_KEY); } catch { /* nothing stored */ } prefs.theme = 'system'; prefs.tz = 'account'; }
export function applyTheme() { if (prefs.theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = prefs.theme; }

/** The account's time zone (default), or this device's when chosen under Settings. */
const zone = () => (prefs.tz === 'local' ? {} : { timeZone: state.me?.timezone || 'Asia/Kolkata' });
const fmt = (opts, iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', { hour12: false, timeZoneName: 'short', ...opts, ...zone() }).format(d); };
/** Every timestamp: "29 Oct, 18:31 IST"; withDate false gives "18:31:29 IST". */
export const fmtTime = (iso, withDate = true) => fmt(withDate ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' }, iso);
/** When something is scheduled (meetings, posts): "Thu, 30 Oct, 10:00 IST". */
export const fmtWhen = iso => fmt({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, iso);
export const fmtDay = iso => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', ...zone() }).format(new Date(iso));
export function money(amount, currency) {
  if (typeof amount !== 'number') return String(amount ?? '—');
  try { return `${new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR' }).format(amount)} (${currency || 'INR'})`; }
  catch { return `${amount} ${currency ?? ''}`.trim(); }
}
export const countdown = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// docs/FRONTEND_GUIDE.md §3: distinct label + colour + icon; never "Done" for APPROVED or SUBMITTED
export const STATUS = {
  PENDING_REVIEW: { label: 'Pending review', icon: 'clock' },
  NEEDS_REVIEW: { label: 'Needs review', icon: 'q' },
  APPROVED: { label: 'Approved, not run yet', icon: 'check' },
  REJECTED: { label: 'Rejected', icon: 'x' },
  EXPIRED: { label: 'Expired', icon: 'hourglass' },
  BLOCKED: { label: 'Blocked', icon: 'slash' },
  SUBMITTED: { label: 'Submitted, awaiting provider', icon: 'send' },
  COMPLETED: { label: 'Completed (confirmed)', icon: 'done' },
  FAILED: { label: 'Failed', icon: 'alert' },
  UNKNOWN: { label: 'Unknown, not confirmed', icon: 'q' },
  ACTIVE: { label: 'Active', icon: 'play' },
  PAUSED: { label: 'Paused', icon: 'pause' }
};
export const BLOCK_REASON = {
  PERMISSION_NOT_GRANTED: 'this agent does not have that permission', UNKNOWN_OPERATION: 'AgentGuard does not know this operation',
  TOOL_NOT_CONNECTED: 'the tool is not connected', TOOL_DISCONNECTED: 'the tool was disconnected', TOOL_PAUSED_BY_PLAN: 'the tool is paused by your plan',
  LIMIT_EXCEEDED: 'it is over your daily cap', WEEKLY_LIMIT_EXCEEDED: 'it is over your weekly cap', MONTHLY_LIMIT_EXCEEDED: 'it is over your monthly cap',
  PAYEE_LIMIT_EXCEEDED: 'it is over this payee’s monthly cap', PAYEE_NOT_ALLOWED: 'this payee is not on your allowed list', NEW_PAYEE_BLOCKED: 'new payees are not allowed',
  METHOD_NOT_ALLOWED: 'this payment method is not allowed', CURRENCY_NOT_ALLOWED: 'this currency is not allowed', CATEGORY_BLOCKED: 'it is in a category you blocked',
  RECIPIENT_NOT_ALLOWED: 'a recipient is not on your allowed list', BULK_LIMIT_EXCEEDED: 'it goes to more people than you allow', OUTSIDE_ALLOWED_HOURS: 'it is outside your allowed hours',
  PREFERENCE_VIOLATION: 'it breaks a hard rule in your preferences', PREFERENCE_CHECK_FAILED: 'your preferences could not be checked',
  KILL_SWITCH: 'the kill switch is on', AGENT_PAUSED: 'the agent is paused', REPLACED: 'the agent sent a newer version', MODE_CHANGED: 'the tool switched between MOCK and LIVE',
  LIVE_UNAVAILABLE: 'live mode is not configured on this server', LIVE_NOT_IN_PLAN: 'your plan runs tools in MOCK only', RECONNECT_REQUIRED: 'Google needs you to sign in again',
  LIVE_PAYLOAD_INVALID: 'Google could not take these details', PERMISSION_DENIED: 'a permission or limit no longer allows it', PAYLOAD_CHANGED: 'the details changed after approval',
  APPROVAL_EXPIRED: 'the approval expired', ENTITLEMENT_REQUIRED: 'your plan does not include this tool'
};
export const blockText = code => BLOCK_REASON[code] ?? (code ? code.replace(/_/g, ' ').toLowerCase() : 'it is not allowed');
/** "LIMIT_EXCEEDED: This would take today's total…" from the API, in plain words: "It is over your daily cap. This would take today's total…" */
export function humanReason(msg) {
  const m = /^([A-Z][A-Z_]+): (.*)$/s.exec(String(msg ?? ''));
  if (!m) return String(msg ?? '');
  const why = blockText(m[1]);
  return `${why[0].toUpperCase()}${why.slice(1)}. ${m[2]}`;
}
export const RISK = { LOW: 'Low risk', MEDIUM: 'Medium risk', HIGH: 'High risk', CRITICAL: 'Critical risk' };
export const OPEN = ['PENDING_REVIEW', 'NEEDS_REVIEW'];

export const INTENT = {
  READ_DATA: 'Read data', SEND_MESSAGE: 'Send a message', SEND_EMAIL: 'Send an email', PUBLISH_CONTENT: 'Publish content',
  EDIT_CONTENT: 'Edit live content', DELETE_CONTENT: 'Delete content', SCHEDULE_EVENT: 'Schedule an event', MODIFY_EVENT: 'Change an event',
  CANCEL_EVENT: 'Cancel an event', SET_REMINDER: 'Set a reminder', MAKE_PAYMENT: 'Make a payment', REFUND: 'Refund', SUBSCRIBE: 'Start a subscription',
  CONNECT_SOCIAL: 'Send a connection request', UNKNOWN: 'Unknown'
};
export const FLAG = {
  PROMPT_INJECTION: 'Possible prompt injection', HOSTILE_TONE: 'Hostile tone', SENSITIVE_DATA: 'Sensitive data', UNTRUSTED_LINK: 'Untrusted link',
  BULK: 'Bulk', NEW_RECIPIENT: 'New recipient', NEW_PAYEE: 'New payee', LARGE_AMOUNT: 'Large amount', PUBLIC: 'Public', OUTSIDE_HOURS: 'Outside allowed hours',
  MISSING_DETAILS: 'Missing details', BULK_LIMIT_EXCEEDED: 'Over bulk limit', LIMIT_EXCEEDED: 'Over limit', CLASSIFIER_ERROR: 'Risk model unavailable', CLASSIFIER_INVALID: 'Risk model answer unreadable',
  LOW_CONFIDENCE: 'Risk model unsure', INTENT_MISMATCH: 'Intent disagreement', UNKNOWN_OPERATION: 'Unknown operation',
  PREFERENCE_VIOLATION: 'Breaks a preference', PREFERENCE_TOPIC: 'Blocked topic', PREFERENCE_TONE: 'Off-tone', PREFERENCE_CHECK_ERROR: 'Preferences unreadable',
  CATEGORY_MATCH: 'Looks like a blocked category', REAUTH_THRESHOLD: 'Above your PIN threshold'
};
export const EVENT = {
  USER_SIGNUP: 'Account created', LOGIN: 'Signed in', LOGIN_FAILED: 'Wrong password', LOGIN_LOCKED: 'Account locked (too many attempts)', LOGOUT: 'Signed out',
  REAUTH: 'Password confirmed', REAUTH_FAILED: 'Password confirmation failed',
  AGENT_CREATED: 'Agent created', AGENT_UPDATED: 'Agent changed', AGENT_PAUSED: 'Agent paused', AGENT_RESUMED: 'Agent resumed', AGENT_KEY_ROTATED: 'Agent key rotated',
  KILL_SWITCH_ON: 'Kill switch ON: all agents paused', KILL_SWITCH_OFF: 'Kill switch OFF: agents resumed',
  TOOL_CONNECTED: 'Tool connected', TOOL_DISCONNECTED: 'Tool disconnected', PERMISSION_CHANGED: 'Permission changed', PREFERENCE_CHANGED: 'Preferences changed',
  MODEL_KEY_ADDED: 'Model key added', MODEL_KEY_REMOVED: 'Model key removed', MODEL_ROLE_CHANGED: 'Model role changed',
  ACTION_PROPOSED: 'Action proposed by agent', ACTION_BLOCKED: 'Action blocked', ALERT_SENT: 'Alert sent to you', ACTION_EXPIRED: 'Action expired',
  APPROVAL_REFUSED: 'Approval refused', ACTION_APPROVED: 'Approved by you', ACTION_AUTO_APPROVED: 'Auto-approved by your rule (LOW risk)', ACTION_REPLACED: 'Replaced by a newer version', ACTION_REJECTED: 'Rejected by you',
  ACTION_SUBMITTED: 'Submitted to the provider', ACTION_COMPLETED: 'Completed, confirmed by the provider', ACTION_UNVERIFIED: 'No confirmation from the provider', ACTION_FAILED: 'Failed at the provider'
};

const FIELD_LABEL = {
  to: 'To', cc: 'Cc', bcc: 'Bcc', recipients: 'Recipients', subject: 'Subject', body: 'Message', text: 'Text', caption: 'Caption', note: 'Note',
  payee: 'Payee', attendees: 'Attendees', title: 'Title', time: 'Time', start: 'Starts', end: 'Ends', media: 'Media', audience: 'Audience',
  postId: 'Post', eventId: 'Event', query: 'Search', plan: 'Plan', txnId: 'Transaction', ids: 'Items', id: 'Item', range: 'Range'
};
const LONG = new Set(['body', 'text', 'caption', 'note']);
export const fieldLabel = k => FIELD_LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
export const isLongField = k => LONG.has(k);
const WHEN_FIELDS = new Set(['start', 'end', 'sendAt', 'scheduledAt', 'from', 'to_time']);
const isIsoTime = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
/** A payload value as text; scheduled times are shown in the same date format as the rest of the app. */
export const fieldValue = (v, k) => (WHEN_FIELDS.has(k) && isIsoTime(v)) ? fmtWhen(v) : Array.isArray(v) ? (v.length ? v.join(', ') : 'None') : v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—');
