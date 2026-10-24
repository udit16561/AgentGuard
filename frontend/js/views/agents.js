import { h, icon, toolIcon, clear } from '../dom.js';
import { api } from '../api.js';
import { state, toolName } from '../state.js';
import { statusChip, openDialog, say, errorText } from '../components.js';

const csv = s => s.split(',').map(x => x.trim()).filter(Boolean);
const describeLimits = l => [
  l.dailyCap != null && `daily cap ${l.dailyCap}${l.currency ? ` ${l.currency}` : ''}`,
  l.maxAmount != null && `max ${l.maxAmount} per action`,
  l.knownPayees?.length && `known payees: ${l.knownPayees.join(', ')}`,
  l.knownRecipients?.length && `known contacts: ${l.knownRecipients.join(', ')}`,
  l.allowedRecipients?.length && `only to: ${l.allowedRecipients.join(', ')}`,
  l.timeWindow && `hours ${l.timeWindow.start}–${l.timeWindow.end}`
].filter(Boolean).join(' · ');

/** Agents (create, pause, rotate key shown once) and their per-tool, per-operation permissions, OFF by default. */
export async function render(view, agentId) {
  let agents = await api.agents();
  let selected = agents.find(a => a.id === agentId) ?? agents[0];
  const agentBox = h('div', { class: 'rows', id: 'agent-list' });
  const keyBox = h('div', { 'aria-live': 'polite' });
  const permBox = h('div', { class: 'detail', id: 'permissions' });
  const name = h('input', { class: 'input', id: 'new-agent', maxlength: '60', placeholder: 'e.g. Shopping helper' });
  const create = h('button', { type: 'submit', class: 'btn primary', id: 'create-agent' }, 'Create agent');
  const form = h('form', { class: 'actions' }, h('label', { class: 'field', for: 'new-agent' }, 'New agent name', name), h('div', { class: 'actions' }, create));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    try { const a = await api.createAgent(name.value.trim()); name.value = ''; showKey(a.name, a.apiKey); agents = await api.agents(); selected = agents.find(x => x.id === a.id); renderAgents(); await renderPermissions(); }
    catch (err) { say(errorText(err)); }
  });

  view.append(
    h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Agents and permissions'),
      h('p', {}, 'Every permission starts OFF. Turn on only the operations an agent needs, and add limits.'))),
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
        statusChip(state.me?.killSwitch ? 'PAUSED' : a.status), h('span', { class: 'actions' }, pick, pause, rotate));
    }) : [h('p', { class: 'empty' }, 'No agents yet. Create one below.')]));
  }

  async function renderPermissions() {
    if (!selected) { clear(permBox).append(h('p', { class: 'empty' }, 'Create an agent to set its permissions.')); return; }
    const [perms, tools] = await Promise.all([api.permissions(selected.id), api.tools()]);
    const connected = new Set(tools.filter(t => t.connected).map(t => t.tool));
    const byTool = new Map();
    for (const p of perms) { if (!byTool.has(p.tool)) byTool.set(p.tool, []); byTool.get(p.tool).push(p); }
    clear(permBox).append(h('p', { class: 'fine' }, `Showing permissions for `, h('b', {}, selected.name), '.'),
      ...[...byTool].map(([tool, ops]) => h('section', { class: 'perm-tool', 'aria-labelledby': `pt-${tool}` },
        h('header', {}, h('span', { class: 'ic' }, toolIcon(tool)), h('b', { id: `pt-${tool}` }, toolName(tool)),
          connected.has(tool) ? h('span', { class: 'badge st-COMPLETED' }, 'Connected') : h('a', { class: 'link', href: '#/tools' }, 'Not connected: connect in Tools')),
        ...ops.map(p => permRow(p)))));
  }

  function permRow(p) {
    const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(p.allowed), id: `perm-${p.tool}-${p.operation}`, 'aria-label': `Allow ${selected.name} to ${p.label} on ${toolName(p.tool)}` });
    const limits = h('p', { class: 'limits' }, describeLimits(p.limits));
    sw.addEventListener('click', async () => {
      sw.disabled = true;
      try {
        await api.setPermissions(selected.id, [{ tool: p.tool, operation: p.operation, allowed: !p.allowed }]);
        p.allowed = !p.allowed; sw.setAttribute('aria-checked', String(p.allowed));
        say(`${p.label} on ${toolName(p.tool)} is now ${p.allowed ? 'allowed' : 'off'} for ${selected.name}.`);
      } catch (e) { say(errorText(e)); }
      sw.disabled = false;
    });
    const edit = p.write ? h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': `Limits for ${p.label} on ${toolName(p.tool)}` }, 'Limits') : null;
    edit?.addEventListener('click', () => limitsDialog(p, limits));
    return h('div', { class: 'perm-row' }, h('span', { class: 'lbl' }, p.label, h('span', {}, p.write ? 'Needs your approval each time' : 'Read only')), edit, sw, limits);
  }

  function limitsDialog(p, limitsText) {
    const l = p.limits ?? {};
    const num = (id, label, v) => h('label', { class: 'field', for: id }, label, h('input', { class: 'input', id, type: 'number', min: '0', step: 'any', value: v ?? '' }));
    const txt = (id, label, v, hint) => h('label', { class: 'field', for: id }, label, hint ? h('small', {}, hint) : null, h('input', { class: 'input', id, value: v ?? '' }));
    const money = p.tool === 'payments';
    const body = h('div', { class: 'detail' },
      money ? h('div', { class: 'kv' }, num('lim-cap', 'Daily cap', l.dailyCap), num('lim-max', 'Max per action', l.maxAmount)) : null,
      money ? h('div', { class: 'kv' }, txt('lim-cur', 'Currency', l.currency ?? 'INR', '3 letters, e.g. INR'), txt('lim-payees', 'Known payees', (l.knownPayees ?? []).join(', '), 'Comma separated. New payees raise the risk.')) : null,
      !money ? txt('lim-known', 'Known contacts', (l.knownRecipients ?? []).join(', '), 'Comma separated. New contacts raise the risk.') : null,
      !money ? txt('lim-allowed', 'Only allow these recipients', (l.allowedRecipients ?? []).join(', '), 'Leave empty to allow anyone (with approval).') : null,
      h('div', { class: 'kv' }, h('label', { class: 'field', for: 'lim-start' }, 'Allowed from', h('input', { class: 'input', id: 'lim-start', type: 'time', value: l.timeWindow?.start ?? '' })),
        h('label', { class: 'field', for: 'lim-end' }, 'Allowed until', h('input', { class: 'input', id: 'lim-end', type: 'time', value: l.timeWindow?.end ?? '' }))),
      h('p', { class: 'fine' }, 'Limits never replace approval: every write action still waits for you.'));
    const error = h('p', { class: 'err', role: 'alert', hidden: true });
    body.append(error);
    const back = h('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
    const save = h('button', { type: 'button', class: 'btn primary', id: 'save-limits' }, 'Save limits');
    const dlg = openDialog({ title: `Limits: ${p.label} on ${toolName(p.tool)}`, body, actions: [back, save] });
    back.addEventListener('click', () => dlg.close());
    save.addEventListener('click', async () => {
      const val = id => document.getElementById(id)?.value.trim() ?? '';
      const limits = {};
      if (money) {
        if (val('lim-cap')) limits.dailyCap = Number(val('lim-cap'));
        if (val('lim-max')) limits.maxAmount = Number(val('lim-max'));
        if (val('lim-cur')) limits.currency = val('lim-cur').toUpperCase();
        if (val('lim-payees')) limits.knownPayees = csv(val('lim-payees'));
      } else {
        if (val('lim-known')) limits.knownRecipients = csv(val('lim-known'));
        if (val('lim-allowed')) limits.allowedRecipients = csv(val('lim-allowed'));
      }
      if (val('lim-start') && val('lim-end')) limits.timeWindow = { start: val('lim-start'), end: val('lim-end') };
      try {
        await api.setPermissions(selected.id, [{ tool: p.tool, operation: p.operation, allowed: p.allowed, limits }]);
        p.limits = limits; limitsText.textContent = describeLimits(limits);
        dlg.close(); say('Limits saved.');
      } catch (e) { error.textContent = errorText(e); error.hidden = false; }
    });
  }

  renderAgents();
  await renderPermissions();
}
