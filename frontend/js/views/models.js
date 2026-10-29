import { h, icon, clear, fill } from '../dom.js';
import { api } from '../api.js';
import { openDialog, say, errorText, lockNote, withPassword as sensitive } from '../components.js';

const ROLE_TEXT = {
  agent: ['Agent', 'Powers the Assistant chat. It is just another agent: everything it proposes waits for your approval.'],
  guard: ['Guard', 'Optional second opinion on risk, and drafts preference rules for you to confirm. It can only raise risk, never approve.']
};
const ERROR = {
  INVALID_KEY: 'The provider rejected the API key.', MODEL_NOT_FOUND: 'The provider does not know this model ID.', RATE_LIMITED: 'Rate-limited. Try again later.',
  TIMEOUT: 'The model did not answer in time.', BLOCKED_URL: 'The base URL points to a private network, so it was blocked.', UNREACHABLE: 'The server could not be reached.', PROVIDER_ERROR: 'The provider returned an error.'
};
const lastTest = new Map();   // the latest test message per model, kept across re-renders
const usd = n => `$${Number(n).toFixed(n < 1 ? 3 : 2)}`;

/**
 * Settings → Models: bring your own model (docs/MODEL_PROVIDERS.md). Everything still works with no model at all.
 * Keys are sent once, stored encrypted, and only ever shown as their last 4 characters. Changing keys asks for the password.
 */
export async function render(view) {
  const [catalog, ent] = await Promise.all([api.modelCatalog(), api.entitlements().catch(() => null)]);
  const roleAllowed = role => !ent || ent.entitlements.modelRoles.roles.includes(role);
  const providers = Object.fromEntries(catalog.providers.map(p => [p.id, p]));
  const rolesBox = h('section', { class: 'card', id: 'model-roles', 'aria-labelledby': 'mr-h' });
  const listBox = h('section', { class: 'card', id: 'model-list', 'aria-labelledby': 'ml-h' });
  const addBox = h('section', { class: 'card', id: 'model-add-card', 'aria-labelledby': 'ma-h' });

  view.append(
    h('div', { class: 'head' }, h('div', {},
      h('p', {}, h('a', { class: 'link', href: '#/settings' }, '← Settings')),
      h('h1', { id: 'title', tabindex: '-1' }, 'Models'),
      h('p', {}, 'Optional: bring your own AI model. With no model, AgentGuard runs on its built-in rules. A model never approves anything, and never changes permissions, preferences or the audit log.'))),
    h('div', { class: 'grid-2' }, rolesBox, addBox), listBox);

  const fail = e => { if (e.code !== 'CANCELLED') say(errorText(e)); };

  async function load() {
    const data = await api.models();
    renderRoles(data);
    renderList(data);
  }

  function renderRoles(data) {
    const tested = data.models.filter(m => m.testOk);
    const select = role => {
      const current = data.roles[role].model?.id ?? '';
      const options = (role === 'guard' ? tested.filter(m => m.guardCapable) : tested);
      return h('select', { class: 'input', id: `role-${role}` },
        h('option', { value: '', selected: !current }, 'None (built-in rules only)'),
        options.map(m => h('option', { value: m.id, selected: m.id === current }, `${m.label} · ${m.modelId}`)));
    };
    const selects = { agent: select('agent'), guard: select('guard') };
    const caps = Object.fromEntries(['agent', 'guard'].map(role => [role, h('input', { class: 'input', id: `cap-${role}`, type: 'number', min: '0', step: '0.5', inputmode: 'decimal', placeholder: 'No cap', value: data.roles[role].cap ?? '' })]));
    const save = h('button', { type: 'button', class: 'btn primary', id: 'roles-save' }, 'Save roles');
    save.addEventListener('click', async () => {
      const cap = role => (caps[role].value === '' ? null : Number(caps[role].value));
      save.disabled = true;
      try {
        const out = await api.setModelRoles({ agent: selects.agent.value || null, guard: selects.guard.value || null, caps: { agent: cap('agent'), guard: cap('guard') } });
        renderRoles({ ...data, ...out });
        say('Roles saved. The change is in the audit log.');
      } catch (e) { save.disabled = false; fail(e); }
    });
    const status = role => {
      const r = data.roles[role];
      if (!r.model) return h('p', { class: 'fine' }, 'Off: built-in rules only.');
      if (!r.active) return h('p', { class: 'err', id: `role-off-${role}` }, `Off: the monthly spend cap is reached (${usd(r.spent)} of ${usd(r.cap)}). Built-in rules are used until next month.`);
      return h('p', { class: 'fine' }, r.cap != null ? `About ${usd(r.spent)} of ${usd(r.cap)} used this month.` : `About ${usd(r.spent)} used this month (approx., from token counts).`);
    };
    fill(rolesBox, 
      h('h2', { id: 'mr-h' }, 'Roles'),
      ...['agent', 'guard'].map(role => h('div', { class: 'detail' },
        h('label', { class: 'field', for: `role-${role}` }, ROLE_TEXT[role][0], h('small', {}, ROLE_TEXT[role][1]), selects[role]),
        !roleAllowed(role) ? h('p', { id: `role-lock-${role}` }, lockNote(null, 'the Assistant'))
          : role === 'guard' && ent && !ent.entitlements.modelRoles.guardTiers.includes('frontier') ? h('p', { class: 'fine' }, 'Your plan allows a local or small guard model. ', lockNote(null, 'any model')) : null,
        h('label', { class: 'field', for: `cap-${role}` }, 'Monthly spend cap (USD, optional)', h('small', {}, 'When reached, the role switches off and the built-in rules take over.'), caps[role]),
        status(role))),
      data.warnings.includes('SAME_PROVIDER')
        ? h('div', { class: 'warn', id: 'same-provider', role: 'note' }, h('b', {}, 'Same provider for both roles. '), 'Pick a different provider for the guard, so one model is not checking itself.') : null,
      h('p', { class: 'fine' }, tested.length ? 'Only models that passed Test connection are listed. The guard also needs to pass the structured-output test.' : 'Add a model and run Test connection first.'),
      save);
  }

  function renderList(data) {
    fill(listBox, h('h2', { id: 'ml-h' }, 'Your models'),
      data.models.length ? h('div', { class: 'rows' }, data.models.map(modelRow)) : h('p', { class: 'empty' }, 'No models yet. AgentGuard is using its built-in rules.'));
  }

  function modelRow(m) {
    const p = providers[m.provider];
    const result = h('p', { class: 'fine', id: `test-result-${m.id}`, 'aria-live': 'polite' },
      lastTest.get(m.id) ?? (m.testOk == null ? 'Not tested yet.' : m.testOk ? `Connected. ${m.guardCapable ? 'Passed the structured-output test: can be the guard.' : 'Failed the structured-output test: agent role only.'}` : 'The last test failed.'));
    const test = h('button', { type: 'button', class: 'btn sm', id: `test-${m.id}` }, 'Test connection');
    test.addEventListener('click', () => sensitive(`Test ${m.label}`, async () => {
      test.disabled = true; result.textContent = 'Testing…';
      try {
        const out = await api.testModel(m.id);
        const text = out.ok ? `Connected. ${out.guard?.passed ? 'Passed the structured-output test (5 of 5): can be the guard.' : `Failed the structured-output test (${out.guard ? out.guard.cases - out.guard.failed : 0} of 5): agent role only.`}` : `Failed: ${ERROR[out.error] ?? out.message}`;
        lastTest.set(m.id, text);
        result.textContent = text;
        await load();
      } finally { test.disabled = false; }
    }).catch(fail));
    const rotate = h('button', { type: 'button', class: 'btn sm ghost', id: `rotate-${m.id}` }, 'Replace key');
    rotate.addEventListener('click', () => rotateDialog(m));
    const del = h('button', { type: 'button', class: 'btn sm danger', id: `delete-${m.id}` }, 'Delete');
    del.addEventListener('click', () => deleteDialog(m));
    const price = m.price ? ` · approx. $${m.price.input} / $${m.price.output} per 1M tokens` : '';
    return h('div', { class: 'row model-row', id: `model-${m.id}` },
      h('span', { class: 'ic' }, icon('chip', 20)),
      h('span', { class: 'grow' },
        h('span', { class: 't' }, m.label),
        h('span', { class: 'm' }, `${p?.name ?? m.provider} · ${m.modelId}${price}`),
        h('span', { class: 'm' }, m.keyHint ? `Key ${m.keyHint}` : 'No key', m.baseUrl ? ` · ${m.baseUrl}` : ''),
        result),
      h('span', { class: 'actions wrap' }, test, rotate, del));
  }

  function rotateDialog(m) {
    const key = h('input', { class: 'input', type: 'password', id: 'rotate-key', autocomplete: 'off', spellcheck: 'false' });
    const back = h('button', { type: 'button', class: 'btn ghost' }, 'Cancel');
    const ok = h('button', { type: 'button', class: 'btn primary', id: 'rotate-ok' }, 'Replace key');
    const dlg = openDialog({ title: `Replace the key for ${m.label}`, body: h('label', { class: 'field', for: 'rotate-key' }, 'New API key', h('small', {}, 'The old key is overwritten. Only the last 4 characters are ever shown again.'), key), actions: [back, ok] });
    back.addEventListener('click', () => dlg.close());
    ok.addEventListener('click', () => { dlg.close(); sensitive('Confirm your password', () => api.rotateModelKey(m.id, key.value.trim())).then(async () => { say('Key replaced.'); await load(); }, fail); });
  }

  function deleteDialog(m) {
    const back = h('button', { type: 'button', class: 'btn ghost' }, 'Keep it');
    const ok = h('button', { type: 'button', class: 'btn danger', id: 'confirm-delete-model' }, `Delete ${m.label}`);
    const dlg = openDialog({ title: `Delete ${m.label}?`, body: h('p', {}, 'The key is erased. Any role using this model switches off, and the built-in rules take over. The audit log keeps a record (without the key).'), actions: [back, ok] });
    back.addEventListener('click', () => dlg.close());
    ok.addEventListener('click', () => { dlg.close(); sensitive('Confirm your password', () => api.deleteModel(m.id)).then(async () => { say(`${m.label} deleted.`); await load(); }, fail); });
  }

  function renderAdd() {
    const provider = h('select', { class: 'input', id: 'model-provider' }, catalog.providers.map(p => h('option', { value: p.id }, p.name)));
    const modelId = h('input', { class: 'input', id: 'model-id', list: 'model-suggestions', autocomplete: 'off', spellcheck: 'false', placeholder: 'Pick a suggestion or type any model ID' });
    const suggestions = h('datalist', { id: 'model-suggestions' });
    const key = h('input', { class: 'input', type: 'password', id: 'model-key', autocomplete: 'off', spellcheck: 'false' });
    const url = h('input', { class: 'input', id: 'model-url', type: 'url', inputmode: 'url', spellcheck: 'false' });
    const label = h('input', { class: 'input', id: 'model-label', maxlength: '60' });
    const urlField = h('label', { class: 'field', for: 'model-url' }, 'Base URL', h('small', {}, 'https:// URLs, or http://localhost only. Private network addresses are blocked.'), url);
    const keyHelp = h('small', {});
    const hints = h('div', { class: 'detail', id: 'model-hints' });
    const add = h('button', { type: 'button', class: 'btn primary', id: 'model-add' }, 'Add model');
    const keyField = h('label', { class: 'field', for: 'model-key' }, 'API key', keyHelp, key);

    function sync() {
      const p = providers[provider.value];
      urlField.hidden = p.kind !== 'openai-compatible';
      url.value = p.defaultBaseUrl ?? '';
      keyHelp.textContent = p.needsKey ? 'Stored encrypted. Only the last 4 characters are shown again.' : 'Optional for this provider.';
      keyField.hidden = p.kind === 'builtin';
      if (p.kind === 'builtin') { modelId.value = catalog.models.find(m => m.provider === p.id)?.modelId ?? ''; label.value ||= 'Offline assistant'; }
      const models = catalog.models.filter(m => m.provider === p.id);
      fill(suggestions, ...models.filter(m => m.modelId).map(m => h('option', { value: m.modelId }, `${m.label} (${m.role}, approx. $${m.price.input} / $${m.price.output})`)));
      fill(hints, 
        p.note ? h('p', { class: 'fine' }, p.note) : null,
        models.length ? h('ul', { class: 'dots suggest' }, models.map(m => h('li', {}, h('b', {}, m.label), ` · suggested for ${m.role === 'guard' ? 'the guard' : 'the agent'} · approx. $${m.price.input} in / $${m.price.output} out per 1M tokens`, m.note ? ` · ${m.note}` : ''))) : null,
        models.length ? h('p', { class: 'fine' }, `Prices are approximate, checked on ${catalog.checkedOn}.`) : null);
    }
    provider.addEventListener('change', sync);
    modelId.addEventListener('change', () => { if (!label.value) label.value = catalog.models.find(m => m.modelId === modelId.value)?.label ?? modelId.value; });
    add.addEventListener('click', async () => {
      const p = providers[provider.value];
      const body = { provider: p.id, modelId: modelId.value.trim(), label: (label.value || modelId.value).trim() };
      if (key.value.trim() && p.kind !== 'builtin') body.apiKey = key.value.trim();
      if (p.kind === 'openai-compatible' && url.value.trim()) body.baseUrl = url.value.trim();
      add.disabled = true;
      try {
        await sensitive('Confirm your password to add a key', () => api.addModel(body));
        key.value = ''; modelId.value = ''; label.value = '';
        say('Model added. Run Test connection before giving it a role.');
        await load();
      } catch (e) { fail(e); }
      add.disabled = false;
    });

    fill(addBox, h('h2', { id: 'ma-h' }, 'Add a model'),
      h('div', { class: 'detail' },
        h('label', { class: 'field', for: 'model-provider' }, 'Provider', provider),
        h('label', { class: 'field', for: 'model-id' }, 'Model ID', modelId, suggestions),
        keyField,
        urlField,
        h('label', { class: 'field', for: 'model-label' }, 'Name', h('small', {}, 'For you, e.g. "Work Claude".'), label),
        hints, add));
    sync();
  }

  renderAdd();
  await load();
}
