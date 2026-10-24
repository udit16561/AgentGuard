import { h, icon } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { prefs, savePrefs, clearPrefs, applyTheme } from '../format.js';
import { say } from '../components.js';

/** Display preferences and account. Deliberately has no way to disable approvals or delete audit records (UI-08). */
export async function render(view) {
  const radio = (name, value, label, current) => {
    const input = h('input', { type: 'radio', name, value, id: `${name}-${value}`, checked: current === value });
    input.addEventListener('change', () => { prefs[name] = value; savePrefs(); applyTheme(); say('Saved.'); });
    return h('label', { class: 'actions', for: `${name}-${value}` }, input, label);
  };
  const clearBtn = h('button', { type: 'button', class: 'btn ghost', id: 'clear-cache' }, 'Clear local cache');
  clearBtn.addEventListener('click', () => { clearPrefs(); applyTheme(); say('Local display settings cleared. Decisions and the audit log are untouched.'); });
  const logout = h('button', { type: 'button', class: 'btn ghost', id: 'logout' }, 'Sign out');
  logout.addEventListener('click', async () => { await api.logout().catch(() => {}); location.hash = ''; location.reload(); });

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
      h('section', { class: 'card', 'aria-labelledby': 's-acct' }, h('h2', { id: 's-acct' }, 'Account'),
        h('p', {}, state.me.email), h('p', { class: 'muted' }, `Plan: ${state.me.plan} (billing is simulated in the prototype)`), logout)));
}
