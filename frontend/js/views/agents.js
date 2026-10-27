import { h, icon, toolIcon, clear } from '../dom.js';
import { api } from '../api.js';
import { state, toolName, canAutoAllow } from '../state.js';
import { statusChip, openDialog, say, errorText, lockNote } from '../components.js';

const csv = s => s.split(',').map(x => x.trim()).filter(Boolean);
const METHOD = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet' };
/** "Ravi: 2000, Asha: 500" → { Ravi: 2000, Asha: 500 }; null if any entry is unreadable */
const payeeCaps = s => {
  const out = {};
  for (const part of csv(s)) {
    const m = /^(.+?)\s*[:=]\s*([\d,]+(?:\.\d+)?)$/.exec(part);
    if (!m || !(Number(m[2].replace(/,/g, '')) > 0)) return null;
    out[m[1].trim()] = Number(m[2].replace(/,/g, ''));
  }
  return out;
};
// which limits form a tool gets
const KIND = { payments: 'money', gmail: 'messaging', whatsapp: 'messaging', calendar: 'messaging', x: 'posting', instagram: 'posting', linkedin: 'posting', blog: 'posting', clock: 'none' };
const describeLimits = l => [
  l.dailyCap != null && `daily cap ${l.dailyCap}${l.currency ? ` ${l.currency}` : ''}`,
  l.weeklyCap != null && `weekly cap ${l.weeklyCap}`,
  l.monthlyCap != null && `monthly cap ${l.monthlyCap}`,
  l.maxAmount != null && `max ${l.maxAmount} per action`,
  l.payeeCaps && Object.keys(l.payeeCaps).length && `payee caps: ${Object.entries(l.payeeCaps).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  l.newPayees === 'block' && 'new payees blocked',
  l.allowedMethods && `methods: ${l.allowedMethods.length ? l.allowedMethods.map(m => METHOD[m] ?? m).join(', ') : 'none'}`,
  l.blockedCategories?.length && `blocked: ${l.blockedCategories.join(', ')}`,
  l.reauthAbove != null && `PIN above ${l.reauthAbove}`,
  l.allowedPayees?.length && `only pay: ${l.allowedPayees.join(', ')}`,
  l.knownPayees?.length && `known payees: ${l.knownPayees.join(', ')}`,
  l.allowedRecipients?.length && `only to: ${l.allowedRecipients.join(', ')}`,
  l.knownRecipients?.length && `known contacts: ${l.knownRecipients.join(', ')}`,
  l.maxRecipients != null && `at most ${l.maxRecipients} recipients`,
  l.timeWindow && `${l.enforceHours ? 'only' : 'flag outside'} ${l.timeWindow.start}–${l.timeWindow.end}`
].filter(Boolean).join(' · ');

/** Agents (create, pause, rotate key shown once) and their permissions: per-operation switches, OFF by default, with one limits form per tool. */
export async function render(view, agentId) {
  let agents = await api.agents();
  let ent = await api.entitlements().catch(() => null);
  const createLock = h('span', { id: 'agent-limit' });
  const showLimit = () => clear(createLock).append(ent && ent.usage.agents >= ent.entitlements.maxAgents
    ? h('span', { class: 'fine' }, `Your plan allows ${ent.entitlements.maxAgents} active agent${ent.entitlements.maxAgents === 1 ? '' : 's'}. `, lockNote(null, 'more agents')) : '');
  showLimit();
  let selected = agents.find(a => a.id === agentId) ?? agents[0];
  const agentBox = h('div', { class: 'rows', id: 'agent-list' });
  const keyBox = h('div', { 'aria-live': 'polite' });
  const permBox = h('div', { class: 'detail', id: 'permissions' });
  const name = h('input', { class: 'input', id: 'new-agent', maxlength: '60', placeholder: 'e.g. Shopping helper' });
  const create = h('button', { type: 'submit', class: 'btn primary', id: 'create-agent' }, 'Create agent');
  const form = h('form', { class: 'actions' }, h('label', { class: 'field', for: 'new-agent' }, 'New agent name', name), h('div', { class: 'actions' }, create, createLock));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    try { const a = await api.createAgent(name.value.trim()); name.value = ''; showKey(a.name, a.apiKey); agents = await api.agents(); ent = await api.entitlements().catch(() => ent); showLimit(); selected = agents.find(x => x.id === a.id); renderAgents(); await renderPermissions(); }
    catch (err) { say(errorText(err)); }
  });

  view.append(
    h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Agents and permissions'),
      h('p', {}, 'Every permission starts OFF. Turn on only what an agent needs, and set limits for each tool.'))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card', 'aria-labelledby': 'ag-h' }, h('h2', { id: 'ag-h' }, 'Agents'), agentBox, keyBox, form),
      h('section', { class: 'card', 'aria-labelledby': 'pm-h' }, h('h2', { id: 'pm-h' }, 'Permissions'), permBox)));

  function showKey(agentName, key) {
    const copy = h('button', { type: 'button', class: 'btn sm ghost' }, 'Copy key');
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(key); say('Key copied. Store it somewhere safe.'); } catch { say('Copy failed; select the key and copy it manually.'); } });
    clear(keyBox).append(h('div', { class: 'keybox', id: 'key-box' }, h('b', {}, `API key for ${agentName}: shown only once`),
      h('code', { id: 'api-key' }, key), h('p', { class: 'fine' }, 'Give it to the agent. AgentGuard stores only a hash, so it cannot show this key again. If it leaks, rotate it.'), copy));
  }

  function renderAgents() {
    clear(agentBox).append(...(agents.length ? agents.map(a => {
      const pause = h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `${a.status === 'PAUSED' ? 'Resume' : 'Pause'} ${a.name}` }, icon(a.status === 'PAUSED' ? 'play' : 'pause', 16), a.status === 'PAUSED' ? 'Resume' : 'Pause');
      const rotate = h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Rotate key for ${a.name}` }, icon('key', 16), 'Rotate key');
      const pick = h('a', { href: `#/agents/${encodeURIComponent(a.id)}`, class: 'link', 'aria-current': String(a.id === selected?.id) }, 'Permissions');
      pause.addEventListener('click', async () => { try { await api.pauseAgent(a.id, a.status !== 'PAUSED'); agents = await api.agents(); renderAgents(); say(`${a.name} ${a.status === 'PAUSED' ? 'resumed' : 'paused'}.`); } catch (e) { say(errorText(e)); } });
      rotate.addEventListener('click', () => {
        const back = h('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
        const ok = h('button', { type: 'button', class: 'btn primary' }, 'Rotate key');
        const dlg = openDialog({ title: `Rotate the key for ${a.name}?`, body: h('p', {}, 'The current key stops working immediately. You will see the new key once.'), actions: [back, ok] });
        back.addEventListener('click', () => dlg.close());
        ok.addEventListener('click', async () => { try { const r = await api.rotateKey(a.id); dlg.close(); showKey(a.name, r.apiKey); } catch (e) { dlg.close(); say(errorText(e)); } });
      });
      return h('div', { class: 'row' }, h('span', { class: 'ic' }, icon('bot')),
        h('span', { class: 'grow' }, h('span', { class: 't' }, a.name), h('span', { class: 'm' }, a.model ?? 'No model set')),
        statusChip(state.me?.killSwitch ? 'PAUSED' : a.status), a.pausedByPlan ? h('span', { class: 'badge st-PAUSED', id: `agent-plan-${a.id}` }, 'Paused by plan') : null,
        h('span', { class: 'actions' }, pick, a.pausedByPlan ? lockNote(null) : pause, rotate));
    }) : [h('p', { class: 'empty' }, 'No agents yet. Create one below.')]));
  }

  async function renderPermissions() {
    if (!selected) { clear(permBox).append(h('p', { class: 'empty' }, 'Create an agent to set its permissions.')); return; }
    const [perms, tools] = await Promise.all([api.permissions(selected.id), api.tools()]);
    const connected = new Set(tools.filter(t => t.connected).map(t => t.tool));
    const byTool = new Map();
    for (const p of perms) { if (!byTool.has(p.tool)) byTool.set(p.tool, []); byTool.get(p.tool).push(p); }
    clear(permBox).append(h('p', { class: 'fine' }, 'Showing permissions for ', h('b', {}, selected.name), '.'),
      ...[...byTool].map(([tool, ops]) => toolSection(tool, ops, connected.has(tool))));
  }

  function toolSection(tool, ops, isConnected) {
    const writes = ops.filter(p => p.write);
    const summary = h('span', { id: `limits-summary-${tool}` }, describeLimits(writes.find(p => Object.keys(p.limits ?? {}).length)?.limits ?? {}) || 'No limits set');
    const edit = KIND[tool] !== 'none' ? h('button', { type: 'button', class: 'btn sm ghost', id: `limits-${tool}`, 'aria-label': `Limits for ${toolName(tool)}` }, 'Limits') : null;
    edit?.addEventListener('click', () => limitsDialog(tool, writes, summary));
    return h('section', { class: 'perm-tool', 'aria-labelledby': `pt-${tool}` },
      h('header', {}, h('span', { class: 'ic' }, toolIcon(tool)), h('b', { id: `pt-${tool}` }, toolName(tool)),
        isConnected ? h('span', { class: 'badge st-COMPLETED' }, 'Connected') : h('a', { class: 'link', href: '#/tools' }, 'Not connected: connect in Tools'), edit),
      KIND[tool] !== 'none' ? h('div', { class: 'tool-limits' }, h('b', {}, 'Limits:'), summary) : null,
      ...ops.map(permRow));
  }

  function permRow(p) {
    const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(p.allowed), id: `perm-${p.tool}-${p.operation}`, 'aria-label': `Allow ${selected.name} to ${p.label} on ${toolName(p.tool)}` });
    sw.addEventListener('click', async () => {
      sw.disabled = true;
      try {
        await api.setPermissions(selected.id, [{ tool: p.tool, operation: p.operation, allowed: !p.allowed }]);
        p.allowed = !p.allowed; sw.setAttribute('aria-checked', String(p.allowed));
        if (autoSw) autoSw.disabled = !p.allowed;
        say(`${p.label} on ${toolName(p.tool)} is now ${p.allowed ? 'allowed' : 'off'} for ${selected.name}.`);
      } catch (e) { say(errorText(e)); }
      sw.disabled = false;
    });

    // auto-allow: reads and alarms only, LOW risk only, off by default, and every run is still in the audit log
    let autoSw = null;
    if (canAutoAllow(p.tool, p.operation)) {
      autoSw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(!!p.limits?.autoAllow), id: `auto-${p.tool}-${p.operation}`,
        'aria-label': `Run ${p.label} on ${toolName(p.tool)} without asking when the risk is LOW`, disabled: !p.allowed });
      autoSw.addEventListener('click', async () => {
        const next = !p.limits?.autoAllow;
        autoSw.disabled = true;
        try {
          await api.setPermissions(selected.id, [{ tool: p.tool, operation: p.operation, allowed: p.allowed, limits: { ...(p.limits ?? {}), autoAllow: next } }]);
          p.limits = { ...(p.limits ?? {}), autoAllow: next };
          autoSw.setAttribute('aria-checked', String(next));
          say(next ? `${p.label} now runs without asking when the risk is LOW. Every run is still logged.` : `${p.label} asks you again every time.`);
        } catch (e) { say(errorText(e)); }
        autoSw.disabled = !p.allowed;
      });
    }
    return h('div', { class: 'perm-row' },
      h('span', { class: 'lbl' }, p.label, h('span', {}, p.write ? (canAutoAllow(p.tool, p.operation) ? 'Asks you, unless auto-allowed' : 'Needs your approval each time') : 'Read only')),
      autoSw ? h('span', { class: 'auto' }, autoSw, 'Auto-allow LOW risk') : null,
      sw);
  }

  function limitsDialog(tool, writes, summaryEl) {
    const l = writes.find(p => Object.keys(p.limits ?? {}).length)?.limits ?? {};
    const kind = KIND[tool];
    const num = (id, label, v, hint) => h('label', { class: 'field', for: id }, label, hint ? h('small', {}, hint) : null, h('input', { class: 'input', id, type: 'number', min: '0', step: 'any', value: v ?? '' }));
    const txt = (id, label, v, hint) => h('label', { class: 'field', for: id }, label, hint ? h('small', {}, hint) : null, h('input', { class: 'input', id, value: v ?? '' }));
    const enforce = h('input', { type: 'checkbox', id: 'lim-enforce', checked: !!l.enforceHours });
    const sections = [];
    const methods = Object.keys(METHOD).map(m => h('input', { type: 'checkbox', id: `lim-method-${m}`, checked: !l.allowedMethods || l.allowedMethods.includes(m) }));
    const newPayees = h('select', { class: 'input', id: 'lim-new-payees' }, h('option', { value: 'approve' }, 'Ask me (raises the risk)'), h('option', { value: 'block' }, 'Block them'));
    newPayees.value = l.newPayees ?? 'approve';
    if (kind === 'money') sections.push(
      h('p', { class: 'sub-h' }, 'Caps'),
      h('div', { class: 'kv' }, num('lim-max', 'Max per payment', l.maxAmount), num('lim-cap', 'Daily cap', l.dailyCap)),
      h('div', { class: 'kv' }, num('lim-week', 'Weekly cap', l.weeklyCap, 'Monday to Sunday'), num('lim-month', 'Monthly cap', l.monthlyCap, 'Calendar month')),
      h('div', { class: 'kv' }, txt('lim-cur', 'Currency', l.currency ?? 'INR', '3 letters'), num('lim-reauth', 'Ask for PIN above', l.reauthAbove, 'Password always needed above this amount')),
      h('p', { class: 'fine' }, 'Going over any cap blocks the payment.'),
      h('p', { class: 'sub-h' }, 'Payees'),
      txt('lim-payees', 'Allowed payees', (l.allowedPayees ?? []).join(', '), 'Only these can be paid. Empty: anyone, with approval.'),
      txt('lim-known-payees', 'Known payees', (l.knownPayees ?? []).join(', '), 'Paying anyone else raises the risk.'),
      txt('lim-payee-caps', 'Per-payee cap (per month)', Object.entries(l.payeeCaps ?? {}).map(([k, v]) => `${k}: ${v}`).join(', '), 'e.g. Ravi: 2000, Asha: 500'),
      h('label', { class: 'field', for: 'lim-new-payees' }, 'New payees', newPayees),
      h('p', { class: 'sub-h' }, 'Methods'),
      h('div', { class: 'methods' }, Object.entries(METHOD).map(([m, label], i) => h('label', { class: 'actions', for: `lim-method-${m}` }, methods[i], label))),
      h('p', { class: 'sub-h' }, 'Blocked categories'),
      txt('lim-categories', 'Never pay for', (l.blockedCategories ?? []).join(', '), 'e.g. gambling, crypto, gift cards. Named: blocked. Hinted in the payee or note: riskier.'));
    if (kind === 'messaging' || kind === 'posting') sections.push(
      h('p', { class: 'sub-h' }, kind === 'posting' ? 'Direct messages' : tool === 'calendar' ? 'Attendees' : 'Recipients'),
      txt('lim-allowed', `Allowed ${tool === 'calendar' ? 'attendees' : 'recipients'}`, (l.allowedRecipients ?? []).join(', '), 'Only these. Empty: anyone, with approval.'),
      txt('lim-known', 'Known contacts', (l.knownRecipients ?? []).join(', '), 'Anyone else raises the risk.'),
      num('lim-bulk', 'Bulk limit', l.maxRecipients, 'Most recipients in one action. More is blocked.'));
    if (kind === 'posting' || kind === 'money') sections.push(
      h('p', { class: 'sub-h' }, 'Allowed hours'),
      h('div', { class: 'kv' }, h('label', { class: 'field', for: 'lim-start' }, 'From', h('input', { class: 'input', id: 'lim-start', type: 'time', value: l.timeWindow?.start ?? '' })),
        h('label', { class: 'field', for: 'lim-end' }, 'Until', h('input', { class: 'input', id: 'lim-end', type: 'time', value: l.timeWindow?.end ?? '' }))),
      h('label', { class: 'actions', for: 'lim-enforce' }, enforce, `Block ${kind === 'money' ? 'payments' : 'posts'} outside these hours (otherwise they are only flagged as riskier)`));
    const error = h('p', { class: 'err', role: 'alert', hidden: true });
    const body = h('div', { class: 'detail' }, ...sections, h('p', { class: 'fine' }, `Applies to every action ${toolName(tool)} can take. Limits never replace approval.`), error);
    const back = h('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
    const save = h('button', { type: 'button', class: 'btn primary', id: 'save-limits' }, 'Save limits');
    const dlg = openDialog({ title: `Limits for ${toolName(tool)}`, body, actions: [back, save] });
    back.addEventListener('click', () => dlg.close());
    save.addEventListener('click', async () => {
      const val = id => document.getElementById(id)?.value.trim() ?? '';
      const limits = {};
      if (kind === 'money') {
        if (val('lim-cap')) limits.dailyCap = Number(val('lim-cap'));
        if (val('lim-max')) limits.maxAmount = Number(val('lim-max'));
        if (val('lim-cur')) limits.currency = val('lim-cur').toUpperCase();
        if (val('lim-payees')) limits.allowedPayees = csv(val('lim-payees'));
        if (val('lim-known-payees')) limits.knownPayees = csv(val('lim-known-payees'));
        if (val('lim-week')) limits.weeklyCap = Number(val('lim-week'));
        if (val('lim-month')) limits.monthlyCap = Number(val('lim-month'));
        if (val('lim-reauth')) limits.reauthAbove = Number(val('lim-reauth'));
        if (val('lim-payee-caps')) {
          const caps = payeeCaps(val('lim-payee-caps'));
          if (!caps) { error.textContent = 'Write per-payee caps as “Name: amount”, separated by commas.'; error.hidden = false; return; }
          limits.payeeCaps = caps;
        }
        if (newPayees.value === 'block') limits.newPayees = 'block';
        const on = Object.keys(METHOD).filter((m, i) => methods[i].checked);
        if (on.length < methods.length) limits.allowedMethods = on;   // all on is the same as no restriction
        if (val('lim-categories')) limits.blockedCategories = csv(val('lim-categories'));
      } else {
        if (val('lim-allowed')) limits.allowedRecipients = csv(val('lim-allowed'));
        if (val('lim-known')) limits.knownRecipients = csv(val('lim-known'));
        if (val('lim-bulk')) limits.maxRecipients = Math.round(Number(val('lim-bulk')));
      }
      if ((kind === 'posting' || kind === 'money') && val('lim-start') && val('lim-end')) { limits.timeWindow = { start: val('lim-start'), end: val('lim-end') }; if (enforce.checked) limits.enforceHours = true; }
      try {
        // the same limits on every write operation of the tool; each keeps its own on/off switch and auto-allow
        await api.setPermissions(selected.id, writes.map(p => ({ tool, operation: p.operation, allowed: p.allowed, limits: { ...limits, ...(p.limits?.autoAllow ? { autoAllow: true } : {}) } })));
        for (const p of writes) p.limits = { ...limits, ...(p.limits?.autoAllow ? { autoAllow: true } : {}) };
        summaryEl.textContent = describeLimits(limits) || 'No limits set';
        dlg.close(); say(`Limits saved for ${toolName(tool)}.`);
      } catch (e) { error.textContent = errorText(e); error.hidden = false; }
    });
  }

  renderAgents();
  await renderPermissions();
}
