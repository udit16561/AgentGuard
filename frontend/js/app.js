import { h, icon, clear } from './dom.js';
import { api, setUnauthenticatedHandler } from './api.js';
import { state, setCatalog } from './state.js';
import { applyTheme, OPEN } from './format.js';
import { say } from './components.js';
import { renderLogin } from './views/login.js';
import * as dashboard from './views/dashboard.js';
import * as review from './views/review.js';
import * as tools from './views/tools.js';
import * as agents from './views/agents.js';
import * as audit from './views/audit.js';
import * as settings from './views/settings.js';

const ROUTES = { dashboard, review, tools, agents, audit, settings };
const NAV = [['dashboard', 'Dashboard', 'home'], ['review', 'Review', 'inbox'], ['tools', 'Tools', 'plug'], ['agents', 'Agents', 'bot'], ['audit', 'Audit', 'trace'], ['settings', 'Settings', 'gear']];
const POLL_MS = 1000;   // interim until SSE in M4; keeps new alerts well under 3 s (UI-01)

const root = document.getElementById('root');
let cleanup = null, timer = null, routed = false, navEl = null, barEl = null, viewEl = null;

function stop() { if (timer) clearInterval(timer); timer = null; if (cleanup) cleanup(); cleanup = null; }

function showLogin() {
  stop();
  clear(root);
  root.append(renderLogin(async () => { state.me = await api.me(); await startShell(); }));
}

async function startShell() {
  setCatalog(await api.tools());
  clear(root);
  navEl = h('nav', { class: 'snav', 'aria-label': 'Sections' });
  barEl = h('div', { 'aria-live': 'polite' });
  viewEl = h('div', { class: 'view', id: 'view' });
  root.append(h('div', { class: 'app' },
    h('aside', { class: 'side', 'aria-label': 'AgentGuard' },
      h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, icon('shield', 20, 2.4)), 'AgentGuard'),
      h('p', { class: 'tag' }, 'Alert before action. Trace everything.'),
      navEl,
      h('div', { class: 'side-foot' },
        h('div', { class: 'mode' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('div', {}, h('b', {}, 'MOCK mode'), 'Tools are simulated. No real payments, posts or messages.')),
        h('p', { class: 'who' }, state.me.email))),
    h('div', { class: 'col' }, barEl, h('main', { id: 'main', tabindex: '-1' }, viewEl)))
  );
  renderNav();
  renderBar();
  if (!routed) { window.addEventListener('hashchange', route); routed = true; }
  route();
  tick();
  timer = setInterval(tick, POLL_MS);
}

function renderNav() {
  const current = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'dashboard';
  clear(navEl).append(...NAV.map(([key, label, ic]) => h('a', { href: `#/${key}`, 'aria-current': current === key ? 'page' : 'false', id: `nav-${key}` },
    icon(ic, 19), h('span', { class: 'lbl' }, label),
    key === 'review' && state.pendingCount ? [h('span', { class: 'count', 'aria-hidden': 'true' }, String(state.pendingCount)), h('span', { class: 'sr' }, `, ${state.pendingCount} waiting`)] : null)));
}

// kill switch banner on every screen (J7)
function renderBar() {
  clear(barEl);
  if (!state.me?.killSwitch) return;
  const resume = h('button', { type: 'button', class: 'btn sm', id: 'bar-resume' }, icon('play', 16), 'Resume agents');
  resume.addEventListener('click', async () => {
    try { state.me = { ...state.me, ...(await api.killSwitch(false)), killSwitch: false }; renderBar(); window.dispatchEvent(new CustomEvent('ag:changed')); say('Agents resumed. New proposals are allowed again.'); }
    catch (e) { say(e.message); }
  });
  barEl.append(h('div', { class: 'paused-bar', role: 'status', id: 'paused-bar' }, icon('pause', 18), 'PAUSED: the kill switch is on. No agent can propose or run anything.', resume));
}

async function tick() {
  try {
    const [me, actions] = await Promise.all([api.me(), api.actions({ limit: 200 })]);
    const pending = actions.filter(a => OPEN.includes(a.status)).length;
    const killChanged = !!me.killSwitch !== !!state.me?.killSwitch;
    state.me = me;
    if (pending !== state.pendingCount) { state.pendingCount = pending; renderNav(); }
    if (killChanged) renderBar();
    window.dispatchEvent(new CustomEvent('ag:tick', { detail: { actions, me } }));
  } catch { /* a 401 is handled by the api module; other errors retry on the next tick */ }
}

async function route() {
  if (!viewEl) return;
  const [name, param] = location.hash.replace(/^#\/?/, '').split('/');
  const view = ROUTES[name] ?? dashboard;
  if (cleanup) cleanup();
  cleanup = null;
  renderNav();
  clear(viewEl);
  viewEl.classList.remove('view'); void viewEl.offsetWidth; viewEl.classList.add('view');   // replay the enter animation
  try { cleanup = (await view.render(viewEl, param ? decodeURIComponent(param) : undefined)) ?? null; }
  catch (e) { viewEl.append(h('p', { class: 'err' }, e.message)); }
  const title = document.getElementById('title');
  if (title) title.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// views announce state changes (kill switch, decisions) with this event instead of importing the shell
window.addEventListener('ag:changed', () => { if (navEl) { renderBar(); renderNav(); } });

applyTheme();
setUnauthenticatedHandler(showLogin);
api.me().then(async me => { state.me = me; await startShell(); }, showLogin);
