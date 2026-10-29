import { h, icon, clear, fill } from '../dom.js';
import { api } from '../api.js';
import { toolName } from '../state.js';
import { EVENT, fmtTime, fmtDay } from '../format.js';
import { lockNote } from '../components.js';

/** Read-only, hash-chained audit timeline with an integrity check (J6). There is no edit or delete control. */
export async function render(view) {
  const list = h('div', { id: 'timeline' });
  const verifyOut = h('p', { 'aria-live': 'polite', id: 'verify-result' });
  const verify = h('button', { type: 'button', class: 'btn primary', id: 'verify' }, icon('shield', 18), 'Verify chain');
  const type = h('select', { class: 'input', id: 'f-type' }, h('option', { value: '' }, 'All events'), ...Object.entries(EVENT).map(([k, v]) => h('option', { value: k }, v)));
  const tool = h('select', { class: 'input', id: 'f-tool' }, h('option', { value: '' }, 'All tools'), ...['gmail', 'calendar', 'clock', 'whatsapp', 'instagram', 'linkedin', 'x', 'payments', 'blog'].map(t => h('option', { value: t }, toolName(t))));

  verify.addEventListener('click', async () => {
    verify.disabled = true;
    try {
      const r = await api.verify();
      verifyOut.className = r.ok ? 'ok' : 'err';
      verifyOut.textContent = r.ok ? `✓ Chain intact: all ${r.count} events verified. Nothing was changed or removed.` : `✗ Chain broken at event #${r.brokenAt}. A stored record was changed or removed.`;
    } catch (e) { verifyOut.className = 'err'; verifyOut.textContent = e.message; }
    verify.disabled = false;
  });
  // exports: what the plan includes is a download link; the rest is labelled "Upgrade to unlock"
  const exportsBox = h('div', { class: 'actions exports', id: 'audit-exports' });
  const retention = h('p', { class: 'fine', id: 'audit-retention' });
  api.entitlements().then(ent => {
    const fmts = [['csv', 'CSV'], ['json', 'JSON'], ['integrity', 'Integrity report']];
    exportsBox.append(h('span', { class: 'sub-h' }, 'Export'), ...fmts.map(([f, label]) => ent.entitlements.auditExport.includes(f)
      ? h('a', { class: 'btn sm', href: `/api/audit/export?format=${f}`, download: '', id: `export-${f}` }, icon('arrow', 14), label)
      : h('span', { class: 'locked-export', id: `export-${f}` }, `${label}: `, lockNote(null))));
  }).catch(() => {});
  type.addEventListener('change', load);
  tool.addEventListener('change', load);

  view.append(
    h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Audit log'),
      h('p', {}, 'Every event, oldest first. Each entry is chained to the one before it, so any change is detectable. Nobody can edit or delete entries, including agents.')),
      verify),
    verifyOut,
    exportsBox,
    retention,
    h('section', { class: 'card', 'aria-label': 'Audit events' },
      h('div', { class: 'filters' }, h('label', { class: 'field', for: 'f-type' }, 'Event', type), h('label', { class: 'field', for: 'f-tool' }, 'Tool', tool)),
      list));

  function details(e) {
    const d = e.data ?? {};
    const bits = [
      e.actorType === 'USER' ? 'by you' : e.actorType === 'AGENT' ? 'by an agent' : 'by AgentGuard',
      d.tool && `${toolName(d.tool)}${d.operation ? `.${d.operation}` : ''}`,
      d.riskLevel && `risk ${d.riskLevel}`,
      d.reason && `reason: ${d.reason}`,
      d.rule === 'autoAllow' && 'by your auto-allow rule',
      d.replacedBy && `replaced by ${d.replacedBy}`,
      d.allowed != null && `now ${d.allowed ? 'allowed' : 'off'}`,
      d.providerRef && `provider ref ${d.providerRef}`,
      d.error && `error: ${d.error}`,
      d.adapterMode && d.adapterMode
    ].filter(Boolean);
    return bits.join(' · ');
  }

  async function load() {
    const page = await api.auditPage({ eventType: type.value || undefined, tool: tool.value || undefined, limit: 1000 });
    const events = page.events;
    fill(retention, `Showing the last ${page.retentionDays} days on your plan.`, page.hiddenOlder ? [` ${page.hiddenOlder} older events are kept and still covered by the chain check. `, lockNote(null, 'a longer history')] : '');
    if (!events.length) { fill(list, h('p', { class: 'empty' }, 'No events match these filters.')); return; }
    const groups = [];
    for (const e of events) {
      const day = fmtDay(e.createdAt);
      if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, items: [] });
      groups[groups.length - 1].items.push(e);
    }
    fill(list, ...groups.map(g => h('section', { 'aria-label': g.day },
      h('h2', { class: 'sub-h' }, g.day),
      h('ol', { class: 'tl' }, g.items.map(e => h('li', { 'data-event': e.eventType },
        h('span', {}, h('time', { datetime: e.createdAt }, fmtTime(e.createdAt, false)), ' ', h('span', { class: 'seq' }, `#${e.seq}`)),
        h('span', { class: 'e' }, EVENT[e.eventType] ?? e.eventType),
        h('span', { class: 'm' }, details(e), e.actionId ? [' · ', h('a', { class: 'link', href: `#/review/${encodeURIComponent(e.actionId)}` }, 'open action')] : null)))))));
  }

  await load();
}
