import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { toolName } from '../state.js';
import { EVENT, fmtTime, fmtDay } from '../format.js';

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
  type.addEventListener('change', load);
  tool.addEventListener('change', load);

  view.append(
    h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Audit log'),
      h('p', {}, 'Every event, oldest first. Each entry is chained to the one before it, so any change is detectable. Nobody can edit or delete entries, including agents.')),
      verify),
    verifyOut,
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
      d.allowed != null && `now ${d.allowed ? 'allowed' : 'off'}`,
      d.providerRef && `provider ref ${d.providerRef}`,
      d.error && `error: ${d.error}`,
      d.adapterMode && d.adapterMode
    ].filter(Boolean);
    return bits.join(' · ');
  }

  async function load() {
    const events = await api.audit({ eventType: type.value || undefined, tool: tool.value || undefined, limit: 1000 });
    if (!events.length) { clear(list).append(h('p', { class: 'empty' }, 'No events match these filters.')); return; }
    const groups = [];
    for (const e of events) {
      const day = fmtDay(e.createdAt);
      if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, items: [] });
      groups[groups.length - 1].items.push(e);
    }
    clear(list).append(...groups.map(g => h('section', { 'aria-label': g.day },
      h('h2', { class: 'sub-h' }, g.day),
      h('ol', { class: 'tl' }, g.items.map(e => h('li', { 'data-event': e.eventType },
        h('span', {}, h('time', { datetime: e.createdAt }, fmtTime(e.createdAt, false)), ' ', h('span', { class: 'seq' }, `#${e.seq}`)),
        h('span', { class: 'e' }, EVENT[e.eventType] ?? e.eventType),
        h('span', { class: 'm' }, details(e), e.actionId ? [' · ', h('a', { class: 'link', href: `#/review/${encodeURIComponent(e.actionId)}` }, 'open action')] : null)))))));
  }

  await load();
}
