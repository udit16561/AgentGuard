import { h, icon } from '../dom.js';
import { api } from '../api.js';
import { errorText } from '../components.js';

/** Sign in or create an account. Signing up also signs you in (docs/DECISIONS.md G). */
export function renderLogin(onSuccess) {
  let mode = 'login';
  const email = h('input', { class: 'input', id: 'email', type: 'email', autocomplete: 'email', required: true });
  const password = h('input', { class: 'input', id: 'password', type: 'password', autocomplete: 'current-password', required: true, minlength: '1' });
  const hint = h('small', { id: 'pw-hint' }, '');
  const error = h('p', { class: 'err', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary', id: 'auth-submit' }, 'Sign in');
  const tabLogin = h('button', { type: 'button', 'aria-pressed': 'true', id: 'tab-login' }, 'Sign in');
  const tabSignup = h('button', { type: 'button', 'aria-pressed': 'false', id: 'tab-signup' }, 'Create account');

  function setMode(m) {
    mode = m;
    tabLogin.setAttribute('aria-pressed', String(m === 'login'));
    tabSignup.setAttribute('aria-pressed', String(m === 'signup'));
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    password.setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
    hint.textContent = m === 'signup' ? 'At least 10 characters. New accounts start on the Plus plan (prototype).' : '';
    error.hidden = true;
  }
  tabLogin.addEventListener('click', () => setMode('login'));
  tabSignup.addEventListener('click', () => setMode('signup'));

  const form = h('form', { class: 'card auth-card', novalidate: true },
    h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, icon('shield', 20, 2.4)), 'AgentGuard'),
    h('h1', { id: 'title', tabindex: '-1' }, mode === 'login' ? 'Sign in' : 'Create account'),
    h('p', { class: 'muted' }, 'Alert before action. Trace everything.'),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Sign in or create an account' }, tabLogin, tabSignup),
    h('label', { class: 'field', for: 'email' }, 'Email', email),
    h('label', { class: 'field', for: 'password' }, 'Password', password, hint),
    error, submit,
    h('p', { class: 'fine' }, 'Demo: run ', h('code', {}, 'npm run db:seed'), ' and sign in as demo@agentguard.dev.'));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    error.hidden = true;
    if (!email.value.trim() || !password.value) { error.textContent = 'Enter your email and password.'; error.hidden = false; return; }
    submit.disabled = true;
    try {
      if (mode === 'login') await api.login(email.value.trim(), password.value);
      else await api.signup(email.value.trim(), password.value);
      password.value = '';
      await onSuccess();
    } catch (err) {
      error.textContent = err.code === 'UNAUTHENTICATED' ? 'Email or password is wrong.' : errorText(err);
      error.hidden = false;
      submit.disabled = false;
    }
  });

  setTimeout(() => email.focus(), 0);
  return h('div', { class: 'auth' }, form);
}
