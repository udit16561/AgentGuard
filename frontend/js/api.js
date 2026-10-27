/**
 * Fetch wrapper for the AgentGuard API (same origin). The session lives in an HttpOnly cookie the page cannot read;
 * the CSRF token is kept in memory only, never in localStorage or sessionStorage (UI-09).
 */
export class ApiError extends Error {
  constructor(status, code, message, actionId) { super(message); this.status = status; this.code = code; this.actionId = actionId; }
}

let csrf = null;
let onUnauthenticated = () => {};
export const setUnauthenticatedHandler = fn => { onUnauthenticated = fn; };

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const authRoute = path === '/api/auth/login' || path === '/api/auth/signup';
  if (method !== 'GET' && !authRoute) {
    if (!csrf) await loadCsrf();
    headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(path, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? res.statusText, data?.error?.actionId);
    if (res.status === 401 && err.code === 'UNAUTHENTICATED' && !authRoute && path !== '/api/auth/reauth') { csrf = null; onUnauthenticated(); }
    throw err;
  }
  return data;
}

export async function loadCsrf() { csrf = (await request('GET', '/api/auth/csrf')).token; }
const qs = params => {
  const p = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v != null && v !== ''));
  return p.toString() ? `?${p}` : '';
};

export const api = {
  me: () => request('GET', '/api/me'),
  signup: async (email, password) => { const r = await request('POST', '/api/auth/signup', { email, password }); await loadCsrf(); return r; },
  login: async (email, password) => { const r = await request('POST', '/api/auth/login', { email, password }); await loadCsrf(); return r; },
  logout: async () => { try { await request('POST', '/api/auth/logout', {}); } finally { csrf = null; } },
  reauth: password => request('POST', '/api/auth/reauth', { password }),

  actions: params => request('GET', `/api/actions${qs(params)}`).then(r => r.actions),
  action: id => request('GET', `/api/actions/${encodeURIComponent(id)}`),
  approve: (id, payloadHash) => request('POST', `/api/actions/${encodeURIComponent(id)}/approve`, { payloadHash }),
  reject: (id, reason) => request('POST', `/api/actions/${encodeURIComponent(id)}/reject`, reason ? { reason } : {}),

  tools: () => request('GET', '/api/tools').then(r => r.tools),
  connect: tool => request('POST', `/api/tools/${encodeURIComponent(tool)}/connect`, {}),
  disconnect: tool => request('DELETE', `/api/tools/${encodeURIComponent(tool)}`),

  agents: () => request('GET', '/api/agents').then(r => r.agents),
  createAgent: (name, model) => request('POST', '/api/agents', model ? { name, model } : { name }),
  pauseAgent: (id, paused) => request('POST', `/api/agents/${encodeURIComponent(id)}/pause`, { paused }),
  rotateKey: id => request('POST', `/api/agents/${encodeURIComponent(id)}/rotate-key`, {}),
  permissions: id => request('GET', `/api/agents/${encodeURIComponent(id)}/permissions`).then(r => r.permissions),
  setPermissions: (id, permissions) => request('PUT', `/api/agents/${encodeURIComponent(id)}/permissions`, { permissions }).then(r => r.permissions),
  killSwitch: on => request('POST', '/api/kill-switch', { on }),
  spending: () => request('GET', '/api/me/spending'),

  preferences: tool => request('GET', `/api/tools/${encodeURIComponent(tool)}/preferences`),
  parsePreferences: (tool, text) => request('POST', `/api/tools/${encodeURIComponent(tool)}/preferences/parse`, { text }),
  // only called from the confirm step: the backend refuses a save without confirmed: true
  savePreferences: (tool, text, rules) => request('PUT', `/api/tools/${encodeURIComponent(tool)}/preferences`, { text, rules, confirmed: true }),

  // bring your own model: keys go up once and never come back (only the last 4 characters are shown)
  models: () => request('GET', '/api/models'),
  modelCatalog: () => request('GET', '/api/models/catalog'),
  addModel: body => request('POST', '/api/models', body),
  testModel: id => request('POST', `/api/models/${encodeURIComponent(id)}/test`, {}),
  setModelRoles: body => request('PUT', '/api/models/roles', body),
  rotateModelKey: (id, apiKey) => request('PUT', `/api/models/${encodeURIComponent(id)}/key`, { apiKey }),
  deleteModel: id => request('DELETE', `/api/models/${encodeURIComponent(id)}`),

  // phone alerts (Web Push): the browser's subscription only; a notification can open Review, never decide
  pushKey: () => request('GET', '/api/push/key'),
  pushSubscribe: sub => request('POST', '/api/push/subscriptions', sub),
  pushUnsubscribe: endpoint => request('DELETE', '/api/push/subscriptions', { endpoint }),
  pushDevices: () => request('GET', '/api/push/subscriptions').then(r => r.subscriptions),
  pushTest: () => request('POST', '/api/push/test', {}),

  audit: params => request('GET', `/api/audit${qs(params)}`).then(r => r.events),
  auditPage: params => request('GET', `/api/audit${qs(params)}`),

  // plans (billing is mocked): plans never grant tool access; safety features are on every plan
  plans: () => request('GET', '/api/plans'),
  entitlements: () => request('GET', '/api/me/entitlements'),
  planPreview: plan => request('GET', `/api/me/plan/preview${qs({ plan })}`),
  changePlan: plan => request('POST', '/api/me/plan', { plan }),
  verify: () => request('GET', '/api/audit/verify')
};

/** POST /api/assistant/chat: calls onEvent for each streamed event ({type: text | proposal | error | done}). */
export async function chat(messages, onEvent) {
  if (!csrf) await loadCsrf();
  const res = await fetch('/api/assistant/chat', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', 'X-CSRF-Token': csrf }, body: JSON.stringify({ messages })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const err = new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? res.statusText);
    if (res.status === 401 && err.code === 'UNAUTHENTICATED') { csrf = null; onUnauthenticated(); }
    throw err;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}
