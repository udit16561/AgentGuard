/** Labels and formatting. Display preferences live in localStorage; nothing secret is ever stored there. */
const PREF_KEY = 'agentguard.prefs.v1';
export const prefs = (() => {
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); return { theme: ['light', 'dark'].includes(p.theme) ? p.theme : 'system', tz: p.tz === 'local' ? 'local' : 'Asia/Kolkata' }; }
  catch { return { theme: 'system', tz: 'Asia/Kolkata' }; }
})();
export function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* preferences are optional */ } }
export function clearPrefs() { try { localStorage.removeItem(PREF_KEY); } catch { /* nothing stored */ } prefs.theme = 'system'; prefs.tz = 'Asia/Kolkata'; }
export function applyTheme() { if (prefs.theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = prefs.theme; }

const zone = () => (prefs.tz === 'local' ? {} : { timeZone: 'Asia/Kolkata' });
export const fmtTime = (iso, withDate = true) => {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: withDate ? undefined : '2-digit', hour12: false, timeZoneName: 'short', ...(withDate ? { day: 'numeric', month: 'short' } : {}), ...zone() }).format(d);
};
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
  MISSING_DETAILS: 'Missing details', LIMIT_EXCEEDED: 'Over limit', CLASSIFIER_ERROR: 'Risk model unavailable', CLASSIFIER_INVALID: 'Risk model answer unreadable',
  LOW_CONFIDENCE: 'Risk model unsure', INTENT_MISMATCH: 'Intent disagreement', UNKNOWN_OPERATION: 'Unknown operation'
};
export const EVENT = {
  USER_SIGNUP: 'Account created', LOGIN: 'Signed in', LOGIN_FAILED: 'Wrong password', LOGIN_LOCKED: 'Account locked (too many attempts)', LOGOUT: 'Signed out',
  REAUTH: 'Password confirmed', REAUTH_FAILED: 'Password confirmation failed',
  AGENT_CREATED: 'Agent created', AGENT_UPDATED: 'Agent changed', AGENT_PAUSED: 'Agent paused', AGENT_RESUMED: 'Agent resumed', AGENT_KEY_ROTATED: 'Agent key rotated',
  KILL_SWITCH_ON: 'Kill switch ON: all agents paused', KILL_SWITCH_OFF: 'Kill switch OFF: agents resumed',
  TOOL_CONNECTED: 'Tool connected', TOOL_DISCONNECTED: 'Tool disconnected', PERMISSION_CHANGED: 'Permission changed',
  ACTION_PROPOSED: 'Action proposed by agent', ACTION_BLOCKED: 'Action blocked', ALERT_SENT: 'Alert sent to you', ACTION_EXPIRED: 'Action expired',
  APPROVAL_REFUSED: 'Approval refused', ACTION_APPROVED: 'Approved by you', ACTION_REJECTED: 'Rejected by you',
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
export const fieldValue = v => Array.isArray(v) ? (v.length ? v.join(', ') : 'None') : v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—');
