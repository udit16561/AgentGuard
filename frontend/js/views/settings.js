import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { prefs, savePrefs, clearPrefs, applyTheme } from '../format.js';
import { say } from '../components.js';
import * as models from './models.js';
import { pushSupport, currentSubscription, enablePush, disablePush } from '../push.js';

/** Display preferences and account. Deliberately has no way to disable approvals or delete audit records (UI-08). */
export async function render(view, param) {
  if (param === 'models') return models.render(view);
  const radio = (name, value, label, current) => {
    const input = h('input', { type: 'radio', name, value, id: `${name}-${value}`, checked: current === value });
    input.addEventListener('change', () => { prefs[name] = value; savePrefs(); applyTheme(); say('Saved.'); });
    return h('label', { class: 'actions', for: `${name}-${value}` }, input, label);
  };
  const clearBtn = h('button', { type: 'button', class: 'btn ghost', id: 'clear-cache' }, 'Clear local cache');
  clearBtn.addEventListener('click', () => { clearPrefs(); applyTheme(); say('Local display settings cleared. Decisions and the audit log are untouched.'); });
  const logout = h('button', { type: 'button', class: 'btn ghost', id: 'logout' }, 'Sign out');
  logout.addEventListener('click', async () => { await api.logout().catch(() => {}); location.hash = ''; location.reload(); });

  const alertsCard = h('section', { class: 'card', id: 'alerts-card', 'aria-labelledby': 's-alerts' });
  renderAlerts(alertsCard);

  view.append(
    h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Settings'), h('p', {}, 'Display options and your account. Safety controls cannot be switched off.'))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card', 'aria-labelledby': 's-look' }, h('h2', { id: 's-look' }, 'Appearance'),
        h('fieldset', { class: 'detail' }, h('legend', { class: 'sub-h' }, 'Theme'), radio('theme', 'system', 'Match my device', prefs.theme), radio('theme', 'light', 'Light', prefs.theme), radio('theme', 'dark', 'Dark', prefs.theme)),
        h('fieldset', { class: 'detail' }, h('legend', { class: 'sub-h' }, 'Show times in'), radio('tz', 'Asia/Kolkata', 'India Standard Time', prefs.tz), radio('tz', 'local', 'This device’s time zone', prefs.tz)),
        clearBtn,
        h('p', { class: 'fine' }, 'Clears only these display settings in this browser. It does not touch decisions, permissions or the audit log.')),
      h('section', { class: 'card', 'aria-labelledby': 's-safe' }, h('h2', { id: 's-safe' }, 'Always-on safeguards'),
        h('ul', { class: 'detail' }, [
          'Every write action waits for your approval.',
          'Approvals are bound to the exact details; any change needs a new approval.',
          'High-risk and needs-review actions ask for your password.',
          'Uncertain risk checks become “Needs review”, never an approval.',
          'The audit log cannot be edited or deleted, by you or by agents.'
        ].map(t => h('li', { class: 'actions' }, icon('ok', 18, 2.6), t))),
        h('p', { class: 'fine' }, 'These are not settings. No plan or option turns them off.')),
      alertsCard,
      h('section', { class: 'card', 'aria-labelledby': 's-models' }, h('h2', { id: 's-models' }, 'Models'),
        h('p', {}, 'Optional: use your own AI model for the Assistant and as a second opinion on risk. Without one, AgentGuard runs on its built-in rules.'),
        h('a', { class: 'btn', href: '#/settings/models', id: 'open-models' }, icon('chip', 16), 'Manage models')),
      h('section', { class: 'card', 'aria-labelledby': 's-acct' }, h('h2', { id: 's-acct' }, 'Account'),
        h('p', {}, state.me.email), h('p', { class: 'muted' }, `Plan: ${state.me.plan} (billing is simulated in the prototype)`), logout)));
}

/** Phone alerts: turn Web Push on or off for this device. Alerts open the Review screen; they never approve. */
async function renderAlerts(card) {
  const head = [h('h2', { id: 's-alerts' }, 'Phone alerts'),
    h('p', {}, 'Get a notification when an agent wants to do something, like “Helper wants to pay ₹500 to Ravi”. Tapping it opens the Review screen.'),
    h('p', { class: 'fine' }, 'Alerts never approve anything: you still decide in the app, with your password for high-risk actions.')];
  const status = h('p', { id: 'alerts-status', 'aria-live': 'polite' });
  const draw = (...parts) => clear(card).append(...head, status, ...parts);
  let key;
  try { key = await api.pushKey(); } catch { draw(); status.textContent = 'Could not check alert settings.'; return; }
  if (!key.enabled) { draw(); status.textContent = 'Phone alerts are not set up on this server (VAPID keys missing). Run npm run dev:lan, or add the VAPID keys to backend/.env.'; return; }
  const support = pushSupport();
  if (!support.ok) { draw(); status.textContent = support.why; return; }
  const sub = await currentSubscription().catch(() => null);
  const on = h('button', { type: 'button', class: 'btn primary', id: 'push-enable' }, icon('alert', 16), 'Turn on alerts on this device');
  const off = h('button', { type: 'button', class: 'btn ghost', id: 'push-disable' }, 'Turn off on this device');
  const test = h('button', { type: 'button', class: 'btn', id: 'push-test' }, 'Send a test alert');
  on.addEventListener('click', async () => {
    on.disabled = true;
    try { await enablePush(key.publicKey); say('Alerts are on for this device.'); } catch (e) { say(e.message); }
    renderAlerts(card);
  });
  off.addEventListener('click', async () => { await disablePush(); say('Alerts are off for this device.'); renderAlerts(card); });
  test.addEventListener('click', async () => {
    try { const r = await api.pushTest(); say(r.sent ? 'Test alert sent.' : 'No device received it. Turn alerts on first.'); } catch (e) { say(e.message); }
  });
  status.textContent = sub ? 'On for this device.' : 'Off for this device.';
  draw(h('div', { class: 'actions' }, ...(sub ? [test, off] : [on])));
}
