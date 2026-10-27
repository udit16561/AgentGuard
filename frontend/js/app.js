import { h, icon, clear } from './dom.js';
import { api, ApiError, setUnauthenticatedHandler } from './api.js';
import { state, setCatalog, toolName } from './state.js';
import { applyTheme, OPEN } from './format.js';
import { say } from './components.js';
import { renderLogin } from './views/login.js';
import * as dashboard from './views/dashboard.js';
import * as review from './views/review.js';
import * as tools from './views/tools.js';
import * as agents from './views/agents.js';
import * as audit from './views/audit.js';
import * as settings from './views/settings.js';
import * as assistant from './views/assistant.js';
import * as plans from './views/plans.js';
import { startLive } from './live.js';

const ROUTES = { dashboard, review, assistant, tools, agents, audit, settings, plans };
// [route, label, icon, short label for the phone's bottom bar]
const NAV = [['dashboard', 'Dashboard', 'home', 'Home'], ['review', 'Review', 'inbox', 'Review'], ['assistant', 'Assistant', 'chat', 'Chat'], ['tools', 'Tools', 'plug', 'Tools'], ['agents', 'Agents', 'bot', 'Agents'], ['audit', 'Audit', 'trace', 'Audit'], ['settings', 'Settings', 'gear', 'Settings']];
const POLL_FAST_MS = 1000;    // no live stream: poll, so new alerts still show well under 3 s (UI-01)
const POLL_LIVE_MS = 15_000;  // live stream connected: polling is only a safety net

const root = document.getElementById('root');
let routeGen = 0, cleanup = null, timer = null, routed = false, navEl = null, barEl = null, viewEl = null, stream = null, pollMs = POLL_FAST_MS, modeFootEl;

function stop() {
  if (timer) clearInterval(timer); timer = null; if (cleanup) cleanup(); cleanup = null;
  if (stream) stream.close(); stream = null;
}

function poll(ms) { pollMs = ms; if (timer) clearInterval(timer); timer = setInterval(tick, ms); }

/** Live alerts (SSE): each event says only what changed, then the normal API is asked for the details. */
function connectStream() {
  if (!('EventSource' in window)) return;
  stream = new EventSource('/api/stream');
  const setLive = on => { state.live = on; window.dispatchEvent(new CustomEvent('ag:live', { detail: on })); poll(on ? POLL_LIVE_MS : POLL_FAST_MS); };
  stream.addEventListener('ready', () => setLive(true));
  stream.addEventListener('change', () => tick());
  stream.addEventListener('error', () => { if (state.live) setLive(false); });   // the browser reconnects by itself
}

/** No connection at start-up: a read-only shell. Nothing from the API is stored, so there is nothing to show or approve. */
function showOffline() {
  stop();
  clear(root);
  const retry = h('button', { type: 'button', class: 'btn primary', id: 'offline-retry' }, 'Try again');
  retry.addEventListener('click', () => location.reload());
  root.append(h('main', { class: 'offline', id: 'offline', tabindex: '-1' },
    h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, icon('shield', 20, 2.4)), 'AgentGuard'),
    h('h1', {}, 'You are offline'),
    h('p', {}, 'AgentGuard needs a connection to show what your agents want to do. Nothing can be approved offline, and agents cannot run anything that is waiting for you.'),
    h('p', { class: 'fine' }, 'For your privacy, no actions or account data are stored on this device.'),
    retry));
  window.addEventListener('online', () => location.reload(), { once: true });
}

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
        modeFootEl = h('div', { class: 'mode', id: 'mode-foot' }),
        h('p', { class: 'who' }, state.me.email))),
    h('div', { class: 'col' }, barEl, h('main', { id: 'main', tabindex: '-1' }, viewEl)))
  );
  renderNav();
  renderBar();
  renderModeFoot();
  if (!routed) { window.addEventListener('hashchange', route); routed = true; }
  route();
  tick();
  poll(POLL_FAST_MS);
  connectStream();
}

function renderNav() {
  const current = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'dashboard';
  clear(navEl).append(...NAV.map(([key, label, ic, short]) => h('a', { href: `#/${key}`, 'aria-current': current === key ? 'page' : 'false', id: `nav-${key}` },
    icon(ic, 19), h('span', { class: 'lbl' }, label), h('span', { class: 'lbl-short', 'aria-hidden': 'true' }, short),
    key === 'review' && state.pendingCount ? [h('span', { class: 'count', 'aria-hidden': 'true' }, String(state.pendingCount)), h('span', { class: 'sr' }, `, ${state.pendingCount} waiting`)] : null)));
}

/** MOCK, or which tools are LIVE (v0.8.0) */
function renderModeFoot() {
  const live = state.me?.integrations?.live ?? [];
  modeFootEl.classList.toggle('is-live', live.length > 0);
  clear(modeFootEl).append(h('span', { class: 'dot', 'aria-hidden': 'true' }), live.length
    ? h('div', {}, h('b', {}, `LIVE: ${live.map(toolName).join(', ')}`), 'Approved actions change your real account. Every other tool is simulated.')
    : h('div', {}, h('b', {}, 'MOCK mode'), 'Tools are simulated. No real payments, posts or messages.'));
}

// kill switch banner on every screen (J7), "Reconnect Google", and the offline notice
function renderBar() {
  clear(barEl);
  if (!navigator.onLine) barEl.append(h('div', { class: 'offline-bar', role: 'status', id: 'offline-bar' }, 'Offline: read-only. Nothing can be approved until you are back online.'));
  const reconnect = state.me?.integrations?.reconnect ?? [];
  if (reconnect.length) {
    const btn = h('button', { type: 'button', class: 'btn sm', id: 'bar-reconnect' }, 'Reconnect Google');
    btn.addEventListener('click', () => startLive(reconnect[0], toolName(reconnect[0]), { reconnect: true }));
    barEl.append(h('div', { class: 'reconnect-bar', role: 'status', id: 'reconnect-bar' }, `Google ${reconnect.map(toolName).join(', ')} needs you to sign in again. Live actions cannot run until then.`, btn));
  }
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
    const liveChanged = JSON.stringify(me.integrations) !== JSON.stringify(state.me?.integrations);
    state.me = me;
    if (liveChanged) renderModeFoot();
    if (pending !== state.pendingCount) { state.pendingCount = pending; renderNav(); }
    if (killChanged || liveChanged) renderBar();
    window.dispatchEvent(new CustomEvent('ag:tick', { detail: { actions, me } }));
  } catch { /* a 401 is handled by the api module; other errors retry on the next tick */ }
}

async function route() {
  if (!viewEl) return;
  const [name, param] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  const view = ROUTES[name] ?? dashboard;
  if (cleanup) cleanup();
  cleanup = null;
  renderNav();
  // each route renders into its own container: if the route changes while a screen is still loading,
  // the stale screen finishes into a detached container instead of drawing over the new one
  const gen = ++routeGen;
  const host = h('div', { class: 'view-host' });
  clear(viewEl).append(host);
  viewEl.classList.remove('view'); void viewEl.offsetWidth; viewEl.classList.add('view');   // replay the enter animation
  let done = null;
  try { done = (await view.render(host, param ? decodeURIComponent(param) : undefined)) ?? null; }
  catch (e) { host.append(h('p', { class: 'err' }, e.message)); }
  if (gen !== routeGen) { if (done) done(); return; }
  cleanup = done;
  const title = document.getElementById('title');
  if (title) title.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// views announce state changes (kill switch, decisions) with this event instead of importing the shell
window.addEventListener('ag:changed', () => { if (navEl) { renderBar(); renderNav(); tick(); } });

applyTheme();
setUnauthenticatedHandler(showLogin);
window.addEventListener('offline', () => { if (barEl) renderBar(); });
window.addEventListener('online', () => { if (barEl) { renderBar(); tick(); } });

// the service worker caches the static shell only, and turns a notification tap into a Review link
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* the app works without it */ });
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'open' && typeof e.data.url === 'string' && e.data.url.startsWith('/#/review')) location.hash = e.data.url.slice(1);
  });
}

// signed out: login; no connection at all: the offline shell
api.me().then(async me => { state.me = me; await startShell(); }, err => (err instanceof ApiError ? showLogin() : showOffline()));
