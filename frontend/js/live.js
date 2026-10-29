import { h } from './dom.js';
import { api } from './api.js';
import { openDialog, say, errorText } from './components.js';

/**
 * Switching a tool to LIVE (Google Calendar only, v0.8.0): its own confirm dialog that says what changes, plus the
 * password, every time. Then the browser goes to Google's consent screen and comes back to Tools. Tokens never come
 * to the browser.
 */
export function startLive(tool, name, { reconnect = false } = {}) {
  const pw = h('input', { class: 'input', type: 'password', id: 'live-password', autocomplete: 'current-password' });
  const error = h('p', { class: 'err', role: 'alert', hidden: true });
  const body = h('div', { class: 'detail' },
    h('div', { id: 'live-confirm-text' },
      h('p', {}, reconnect ? `Google asked you to sign in again for ${name}.` : `${name} will use your real Google Calendar.`,
        ' Approved actions will create, change and cancel real events in your real Google Calendar.'),
      h('ul', { class: 'dots' },
        h('li', {}, 'Every action still waits for your approval, checked again right before Google is called.'),
        h('li', {}, 'No invitations are sent unless an action you approve says so.'),
        h('li', {}, 'AgentGuard asks Google for calendar events only, and keeps the sign-in encrypted on the server.'),
        h('li', {}, 'Actions proposed before this switch are blocked; the agent has to propose them again.'))),
    h('label', { class: 'field', for: 'live-password' }, 'Your AgentGuard password', pw),
    error);
  const back = h('button', { type: 'button', class: 'btn ghost', id: 'live-cancel' }, 'Cancel');
  const ok = h('button', { type: 'button', class: 'btn danger', id: 'live-continue' }, reconnect ? 'Reconnect Google' : 'Continue to Google');
  const dlg = openDialog({ title: reconnect ? 'Reconnect Google' : `Use live ${name}?`, body, actions: [back, ok] });
  back.addEventListener('click', () => dlg.close());
  const go = async () => {
    error.hidden = true;
    if (!pw.value) { error.textContent = 'Enter your password to continue.'; error.hidden = false; pw.focus(); return; }
    ok.disabled = true;
    try { await api.reauth(pw.value); } catch (e) { error.textContent = e.code === 'RATE_LIMITED' ? errorText(e) : 'That password is wrong.'; error.hidden = false; ok.disabled = false; pw.select(); return; }
    pw.value = '';
    try {
      const { url } = await api.goLive(tool);
      // only Google's consent screen, or (browser tests) our own callback
      if (!url.startsWith('https://accounts.google.com/') && !url.startsWith('/api/oauth/google/callback')) throw new Error('Unexpected sign-in address');
      location.assign(url);
    } catch (e) { ok.disabled = false; error.textContent = errorText(e); error.hidden = false; }
  };
  ok.addEventListener('click', go);
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

/** Back to MOCK: Google's grant is revoked and the tokens deleted; open live actions are blocked. */
export function stopLive(tool, name, onDone) {
  const back = h('button', { type: 'button', class: 'btn ghost' }, 'Keep live');
  const ok = h('button', { type: 'button', class: 'btn primary', id: 'confirm-mock' }, 'Switch to MOCK');
  const dlg = openDialog({ title: `Switch ${name} back to MOCK?`, body: h('p', {}, 'AgentGuard signs out of Google (the access is revoked at Google) and simulates this tool again. Live actions still waiting for you are blocked.'), actions: [back, ok] });
  back.addEventListener('click', () => dlg.close());
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try { await api.goMock(tool); dlg.close(); say(`${name} is MOCK again. Google access was revoked.`); window.dispatchEvent(new CustomEvent('ag:changed')); onDone?.(); }
    catch (e) { ok.disabled = false; say(errorText(e)); }
  });
}

/** After Google's redirect: #/tools?live=calendar | failed | denied. */
export function liveReturn() {
  const m = location.hash.match(/\?live=([a-z]+)$/);
  if (!m) return;
  history.replaceState(null, '', '#/tools');
  say(m[1] === 'failed' ? 'Google sign-in did not complete, so nothing changed. Try again.'
    : m[1] === 'denied' ? 'You declined on Google’s screen, so nothing changed.'
    : 'Calendar is LIVE. Approved actions now change your real Google Calendar.');
}
