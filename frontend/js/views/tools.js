import { h, toolIcon, clear } from '../dom.js';
import { api } from '../api.js';
import { modeBadge, openDialog, say, errorText } from '../components.js';

const MAX = 500;
const EXAMPLES = {
  gmail: 'e.g. Use udit@work.com for clients. No emails after 9pm. Sign as \'Udit\'. Never send attachments to new recipients.',
  calendar: 'e.g. No meetings before 10am or on Sundays. Max 45 minutes.',
  x: 'e.g. Professional tone only. No posts about politics.',
  linkedin: 'e.g. Professional tone only. No posts about politics.',
  payments: 'e.g. Never pay more than ₹2,000.'
};

/**
 * Tool catalog: connect or disconnect each tool, and write preferences for it. Connecting never grants permissions,
 * and preferences never grant anything either: they can only flag or block, and are saved only after you confirm
 * what AgentGuard understood.
 */
export async function render(view) {
  const grid = h('div', { class: 'tools', id: 'tools' });
  view.append(
    h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Tools'),
      h('p', {}, 'Connect the tools your agents may use, and tell AgentGuard how you like each one used. Connecting grants nothing: each operation still needs its own permission under Agents.'))),
    grid);

  async function load(focusId) {
    const tools = await api.tools();
    const prefs = await Promise.all(tools.map(t => api.preferences(t.tool).catch(() => ({ text: '', rules: [] }))));
    clear(grid).append(...tools.map((t, i) => {
      const writes = t.operations.filter(o => o.write).length;
      const btn = h('button', { type: 'button', class: `btn sm ${t.connected ? 'ghost' : 'primary'}`, id: `tool-${t.tool}` }, t.connected ? 'Disconnect' : 'Connect');
      btn.addEventListener('click', () => (t.connected ? disconnect(t) : connect(t)));
      return h('article', { class: 'card tool', 'aria-labelledby': `tn-${t.tool}` },
        h('div', { class: 'top' }, h('span', { class: 'ic' }, toolIcon(t.tool, 20)), h('span', { class: 'name', id: `tn-${t.tool}` }, t.name), modeBadge(t.mode)),
        h('p', { class: 'fine' }, `${t.operations.length} operations · ${writes} need your approval`),
        h('p', {}, t.connected ? h('span', { class: 'badge st-COMPLETED' }, 'Connected') : h('span', { class: 'badge st-EXPIRED' }, 'Not connected')),
        h('div', { class: 'actions' }, btn),
        preferencesBox(t, prefs[i]));
    }));
    if (focusId) document.getElementById(focusId)?.focus();
  }

  function savedList(tool, rules) {
    return h('div', { class: 'pref-saved', id: `pref-saved-${tool}`, 'aria-live': 'polite' },
      rules.length ? [h('p', { class: 'sub-h' }, 'Saved rules'), h('ul', { class: 'dots' }, rules.map(r => h('li', {}, r.label, r.hard ? h('span', { class: 'flag' }, 'hard: blocks') : null)))]
        : h('p', { class: 'fine' }, 'No preferences saved.'));
  }

  function preferencesBox(t, saved) {
    const id = `pref-text-${t.tool}`;
    const text = h('textarea', { class: 'input', id, rows: '3', maxlength: String(MAX), placeholder: EXAMPLES[t.tool] ?? 'e.g. No actions after 9pm.' });
    text.value = saved.text ?? '';
    const count = h('small', { class: 'fine' }, `${text.value.length}/${MAX}`);
    text.addEventListener('input', () => { count.textContent = `${text.value.length}/${MAX}`; });
    const check = h('button', { type: 'button', class: 'btn sm', id: `pref-check-${t.tool}` }, 'Check and save…');
    let current = saved.rules ?? [];
    let list = savedList(t.tool, current);
    check.addEventListener('click', () => reviewDialog(t, text.value, current, next => { current = next; const el = savedList(t.tool, next); list.replaceWith(el); list = el; }));
    return h('div', { class: 'pref' },
      h('label', { class: 'field', for: id }, 'Preferences', h('small', {}, 'Plain language. They can only flag or block, never approve.'), text),
      h('div', { class: 'actions' }, check, count),
      list);
  }

  async function reviewDialog(t, text, savedRules, onSaved) {
    let parsed;
    try { parsed = await api.parsePreferences(t.tool, text); } catch (e) { say(errorText(e)); return; }
    // a rule that was already hard stays ticked when the same rule is understood again
    const sig = r => r.label;
    const wasHard = new Set(savedRules.filter(r => r.hard).map(sig));
    const hardBoxes = [];
    const rules = h('ul', { class: 'pref-rules', id: 'pref-rules' }, parsed.rules.map((r, i) => {
      const box = h('input', { type: 'checkbox', id: `pref-hard-${i}`, checked: wasHard.has(sig(r)) });
      hardBoxes.push(box);
      return h('li', {}, h('span', { class: 'grow' }, r.label),
        h('label', { class: 'hard', for: `pref-hard-${i}` }, box, 'Hard rule: block instead of flag'));
    }));
    const body = h('div', { class: 'detail' },
      h('p', { class: 'sub-h' }, 'I understood'),
      parsed.rules.length ? rules : h('p', { class: 'empty' }, 'No rules found in this text.'),
      parsed.ignored.length ? h('div', { class: 'err', id: 'pref-ignored', role: 'note' }, 'Ignored, because preferences can only restrict and never approve or allow anything: ',
        parsed.ignored.map(x => `“${x.text}”`).join(', ')) : null,
      parsed.unrecognized.length ? h('div', { class: 'warn', id: 'pref-unrecognized', role: 'note' }, h('b', {}, 'Not understood: '), parsed.unrecognized.map(x => `“${x}”`).join(', '), '. Rephrase it if it matters.') : null,
      h('p', { class: 'fine' }, parsed.parser === 'model' ? 'Read by the optional model, then checked against the allowed rule types.' : parsed.fallbackReason ?? 'Read by AgentGuard’s built-in rules.'),
      h('p', { class: 'fine' }, 'A broken rule raises the risk and shows on the review screen. A hard rule blocks the action instead. Nothing is saved until you confirm.'));
    const back = h('button', { type: 'button', class: 'btn ghost', id: 'pref-back' }, 'Back, edit the text');
    const confirm = h('button', { type: 'button', class: 'btn primary', id: 'pref-confirm' }, 'Confirm and save');
    const dlg = openDialog({ title: `Preferences for ${t.name}`, body, actions: [back, confirm] });
    back.addEventListener('click', () => dlg.close());
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        const saved = await api.savePreferences(t.tool, text, parsed.rules.map((r, i) => ({ ...r, hard: hardBoxes[i].checked })));
        dlg.close();
        onSaved(saved.rules);
        say(`Preferences saved for ${t.name}. Every change is in the audit log.`);
      } catch (e) { confirm.disabled = false; say(errorText(e)); }
    });
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
