import { h, icon } from '../dom.js';
import { api, chat } from '../api.js';
import { statusChip, riskBadge, say, errorText, withPassword } from '../components.js';
import { toolName, opLabel } from '../state.js';

/**
 * Assistant: a chat with your own model (the agent role). It is just another agent: what it proposes lands in
 * Review like any other agent's action, with the same permissions, alerts and approvals. It cannot approve anything.
 */
export async function render(view) {
  const data = await api.models().catch(() => null);
  const agentRole = data?.roles.agent;
  const log = h('div', { class: 'chat-log', id: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const input = h('textarea', { class: 'input', id: 'chat-input', rows: '2', maxlength: '4000', placeholder: 'e.g. pay Ravi ₹500 for lunch' });
  const send = h('button', { type: 'submit', class: 'btn primary', id: 'chat-send' }, icon('send', 16), 'Send');
  const form = h('form', { class: 'chat-form', id: 'chat-form' }, h('label', { class: 'sr', for: 'chat-input' }, 'Message'), input, send);
  const messages = [];

  view.append(h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Assistant'),
    h('p', {}, 'Ask in plain words. The Assistant can only propose actions; each one waits for your approval in Review, under the permissions you gave it in Agents.'))));

  if (!agentRole?.model || !agentRole.active) {
    const offline = agentRole?.model ? null : h('button', { type: 'button', class: 'btn primary', id: 'chat-offline' }, 'Use the offline assistant (no key)');
    offline?.addEventListener('click', () => useOffline(offline));
    view.append(h('section', { class: 'card', id: 'chat-off' },
      h('h2', {}, agentRole?.model ? 'The Assistant is off' : 'No Assistant model yet'),
      h('p', {}, agentRole?.model ? 'Its monthly spend cap is reached. Raise the cap or wait for next month.'
        : 'Start with the built-in offline assistant: free, no API key, nothing leaves this PC. It follows simple commands such as “pay Ravi 500”. Or add your own AI model and give it the agent role.'),
      h('div', { class: 'actions' }, offline, h('a', { class: `btn ${offline ? 'ghost' : 'primary'}`, href: '#/settings/models', id: 'chat-setup' }, 'Set up a model'))));
    return;
  }

  const bubble = (who, ...children) => h('div', { class: `msg ${who}` }, h('span', { class: 'sr' }, who === 'me' ? 'You said: ' : 'Assistant: '), ...children);
  const proposalCard = e => h('div', { class: 'proposal', id: e.id ? `proposal-${e.id}` : undefined },
    h('div', { class: 'top' }, h('b', {}, `${toolName(e.tool)} · ${opLabel(e.tool, e.operation)}`), statusChip(e.status), e.riskLevel ? riskBadge(e.riskLevel) : null),
    e.status === 'BLOCKED' ? h('p', { class: 'fine' }, e.message ?? 'Blocked by your settings.') : h('p', { class: 'fine' }, 'Nothing happens until you approve it.'),
    e.id && e.status !== 'BLOCKED' ? h('a', { class: 'link', href: `#/review/${encodeURIComponent(e.id)}` }, 'Review it', icon('arrow', 14)) : null);

  log.append(bubble('bot', h('p', {}, agentRole.model.provider === 'offline'
    ? 'Hi! I am the offline assistant: no AI, no internet. Try “pay Ravi 500”, “email asha@example.com Running late”, “meet raj@example.com Coffee chat at 11:30” or “alarm 07:00 Gym”. Everything I propose waits for your approval in Review.'
    : 'Hi! Tell me what you need. I will propose it, and you approve it in Review.')));

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send.disabled = true;
    messages.push({ role: 'user', content: text });
    log.append(bubble('me', h('p', {}, text)));
    const reply = h('p', {}, '');
    const box = bubble('bot', reply);
    log.append(box);
    let said = '';
    try {
      await chat(messages.slice(-20), e => {
        if (e.type === 'text') { said += e.text; reply.textContent = said; }
        else if (e.type === 'proposal') { box.append(proposalCard(e)); window.dispatchEvent(new CustomEvent('ag:changed')); }
        else if (e.type === 'error') box.append(h('p', { class: 'err' }, e.message));
      });
      if (said) messages.push({ role: 'assistant', content: said });
      else if (!box.querySelector('.proposal, .err')) reply.textContent = '…';
    } catch (e) { box.append(h('p', { class: 'err' }, errorText(e))); say(errorText(e)); }
    send.disabled = false;
    input.focus();
    box.scrollIntoView({ block: 'nearest' });
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

  view.append(h('section', { class: 'card chat', 'aria-labelledby': 'chat-h' },
    h('div', { class: 'card-h' }, h('h2', { id: 'chat-h' }, `Chat · ${agentRole.model.label}`), h('a', { class: 'link', href: '#/agents' }, 'Its permissions', icon('arrow', 14))),
    log,
    form));
}

/** Adds the built-in offline model (no key), tests it and makes it the Assistant; the guard role is left as it is. */
async function useOffline(btn) {
  btn.disabled = true;
  try {
    await withPassword('Confirm your password', async () => {
      const m = await api.addModel({ provider: 'offline', modelId: 'agentguard-offline', label: 'Offline assistant' });
      await api.testModel(m.id);
      const { roles } = await api.models();
      await api.setModelRoles({ agent: m.id, guard: roles.guard.model?.id ?? null });
    });
    say('The offline assistant is on. Give it permissions under Agents → Assistant.');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } catch (e) { if (e.code !== 'CANCELLED') say(errorText(e)); btn.disabled = false; }
}
