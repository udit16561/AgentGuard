import { h, toolIcon, clear } from '../dom.js';
import { api } from '../api.js';
import { modeBadge, openDialog, say, errorText } from '../components.js';

/** Tool catalog: connect or disconnect each tool. Connecting never grants permissions by itself. */
export async function render(view) {
  const grid = h('div', { class: 'tools', id: 'tools' });
  view.append(
    h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Tools'),
      h('p', {}, 'Connect the tools your agents may use. Connecting grants nothing: each operation still needs its own permission under Agents.'))),
    grid);

  async function load(focusId) {
    const tools = await api.tools();
    clear(grid).append(...tools.map(t => {
      const writes = t.operations.filter(o => o.write).length;
      const btn = h('button', { type: 'button', class: `btn sm ${t.connected ? 'ghost' : 'primary'}`, id: `tool-${t.tool}` }, t.connected ? 'Disconnect' : 'Connect');
      btn.addEventListener('click', () => (t.connected ? disconnect(t) : connect(t)));
      return h('article', { class: 'card tool', 'aria-labelledby': `tn-${t.tool}` },
        h('div', { class: 'top' }, h('span', { class: 'ic' }, toolIcon(t.tool, 20)), h('span', { class: 'name', id: `tn-${t.tool}` }, t.name), modeBadge(t.mode)),
        h('p', { class: 'fine' }, `${t.operations.length} operations · ${writes} need your approval`),
        h('p', {}, t.connected ? h('span', { class: 'badge st-COMPLETED' }, 'Connected') : h('span', { class: 'badge st-EXPIRED' }, 'Not connected')),
        h('div', { class: 'actions' }, btn));
    }));
    if (focusId) document.getElementById(focusId)?.focus();
  }

  async function connect(t) {
    try { await api.connect(t.tool); say(`${t.name} connected (MOCK). Turn on permissions under Agents.`); await load(`tool-${t.tool}`); }
    catch (e) { say(errorText(e)); }
  }

  function disconnect(t) {
    const back = h('button', { type: 'button', class: 'btn ghost' }, 'Keep connected');
    const ok = h('button', { type: 'button', class: 'btn danger', id: 'confirm-disconnect' }, `Disconnect ${t.name}`);
    const dlg = openDialog({ title: `Disconnect ${t.name}?`, body: h('p', {}, 'Every agent loses its permissions for this tool, and any of its actions waiting for you are blocked. The audit log keeps a record.'), actions: [back, ok] });
    back.addEventListener('click', () => dlg.close());
    ok.addEventListener('click', async () => {
      try { await api.disconnect(t.tool); dlg.close(); say(`${t.name} disconnected.`); await load(`tool-${t.tool}`); }
      catch (e) { dlg.close(); say(errorText(e)); }
    });
  }

  await load();
}
