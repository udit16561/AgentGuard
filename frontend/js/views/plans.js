import { h, icon, clear, fill } from '../dom.js';
import { api } from '../api.js';
import { state, toolName } from '../state.js';
import { openDialog, say, errorText } from '../components.js';

const rupees = n => (n ? `₹${n.toLocaleString('en-IN')} / month` : 'Free');
const ROWS = [
  ['Agents', e => String(e.maxAgents)],
  ['Connected tools', e => (e.maxConnectedTools == null ? 'All' : String(e.maxConnectedTools))],
  ['Tool catalog', e => e.toolCatalog.filter(t => t !== 'custom').map(toolName).join(', ') + (e.toolCatalog.includes('custom') ? ', custom' : '')],
  ['Audit log shown', e => `${e.auditRetentionDays} days`],
  ['Audit export', e => (e.auditExport.length ? e.auditExport.map(f => (f === 'integrity' ? 'integrity report' : f.toUpperCase())).join(' + ') : '—')],
  ['Phone alerts', e => (e.pushAlerts.includes('push') ? 'Yes' : 'In the app only')],
  ['Your own models', e => (e.modelRoles.roles.includes('agent') ? 'Guard and Assistant, any model' : 'Guard only, local or small model')]
];
const ALWAYS = ['Approvals for every action', 'The kill switch', 'Alerts in the app, live', 'The audit log and its integrity check'];

/**
 * Plans: compare Starter, Plus and Pro, and switch (mock billing). A plan never grants tool access, and the safety
 * features are on every plan. A downgrade pauses what no longer fits; nothing is deleted.
 */
export async function render(view) {
  const box = h('div', { class: 'plans', id: 'plans' });
  const pausedBox = h('div', { id: 'plan-paused' });
  view.append(
    h('div', { class: 'head' }, h('div', {},
      h('p', {}, h('a', { class: 'link', href: '#/settings' }, '← Settings')),
      h('h1', { id: 'title', tabindex: '-1' }, 'Plans'),
      h('p', {}, 'Plans unlock limits and extras. They never switch on a tool or a permission by themselves. Billing is simulated in the prototype.'))),
    h('section', { class: 'card always', 'aria-labelledby': 'always-h' }, h('h2', { id: 'always-h' }, 'On every plan, never locked'),
      h('ul', { class: 'detail' }, ALWAYS.map(t => h('li', { class: 'actions' }, icon('ok', 18, 2.6), t)))),
    pausedBox, box);

  async function load() {
    const [{ plans }, me] = await Promise.all([api.plans(), api.entitlements()]);
    fill(pausedBox, ...(me.paused.agents.length || me.paused.tools.length ? [h('div', { class: 'warn', role: 'note' },
      h('b', {}, 'Paused by your plan: '),
      [...me.paused.agents.map(a => `agent ${a.name}`), ...me.paused.tools.map(toolName)].join(', '),
      '. Nothing was deleted; upgrade to turn them back on.')] : []));
    fill(box, ...plans.map(p => {
      const current = p.id === me.plan;
      const btn = current ? h('span', { class: 'badge st-COMPLETED', id: `plan-current-${p.id}` }, 'Current plan')
        : h('button', { type: 'button', class: `btn ${p.priceInr > plans.find(x => x.id === me.plan).priceInr ? 'primary' : 'ghost'}`, id: `plan-pick-${p.id}` }, `Switch to ${p.name}`);
      if (!current) btn.addEventListener('click', () => confirmSwitch(p, plans.find(x => x.id === me.plan)));
      return h('article', { class: `card plan${current ? ' current' : ''}`, 'aria-labelledby': `plan-h-${p.id}`, id: `plan-${p.id}` },
        h('h2', { id: `plan-h-${p.id}` }, p.name), h('p', { class: 'price' }, rupees(p.priceInr), h('small', {}, ' (mock)')),
        h('dl', { class: 'plan-rows' }, ROWS.map(([k, f]) => h('div', {}, h('dt', {}, k), h('dd', {}, f(p.entitlements))))),
        btn);
    }));
  }

  async function confirmSwitch(p, from) {
    let preview;
    try { preview = await api.planPreview(p.id); } catch (e) { say(errorText(e)); return; }
    const down = p.priceInr < from.priceInr;
    const lose = [...preview.pauseAgents.map(a => `Agent “${a.name}” is paused`), ...preview.pauseTools.map(t => `${toolName(t)} is paused`)];
    const body = h('div', { class: 'detail' },
      h('p', {}, down ? `Moving from ${from.name} to ${p.name}.` : `Upgrading from ${from.name} to ${p.name}. Anything paused by your plan that fits again is turned back on.`),
      lose.length ? h('div', { class: 'warn', id: 'plan-will-pause' }, h('b', {}, 'What changes: '), h('ul', { class: 'dots' }, lose.map(t => h('li', {}, t))),
        h('p', { class: 'fine' }, 'Nothing is deleted: permissions, history and settings are kept, and come back if you upgrade again.')) : null,
      h('p', { class: 'fine' }, 'Approvals, the kill switch, alerts and the audit log stay on, on every plan. Billing is simulated.'));
    const back = h('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
    const ok = h('button', { type: 'button', class: 'btn primary', id: 'plan-confirm' }, `Switch to ${p.name}`);
    const dlg = openDialog({ title: `Switch to ${p.name}?`, body, actions: [back, ok] });
    back.addEventListener('click', () => dlg.close());
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        await api.changePlan(p.id);
        dlg.close();
        state.me = { ...state.me, plan: p.id };
        say(`You are on ${p.name} now (billing simulated). The change is in the audit log.`);
        window.dispatchEvent(new CustomEvent('ag:changed'));
        await load();
      } catch (e) { ok.disabled = false; say(errorText(e)); }
    });
  }

  await load();
}
