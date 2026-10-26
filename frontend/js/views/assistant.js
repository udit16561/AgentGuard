import { h, icon } from '../dom.js';
import { api, chat } from '../api.js';
import { statusChip, riskBadge, say, errorText } from '../components.js';
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
    view.append(h('section', { class: 'card', id: 'chat-off' },
      h('h2', {}, agentRole?.model ? 'The Assistant is off' : 'No Assistant model yet'),
      h('p', {}, agentRole?.model ? 'Its monthly spend cap is reached. Raise the cap or wait for next month.' : 'Add your own model and give it the agent role. Everything else in AgentGuard works without it.'),
      h('a', { class: 'btn primary', href: '#/settings/models', id: 'chat-setup' }, 'Set up a model')));
    return;
  }

  const bubble = (who, ...children) => h('div', { class: `msg ${who}` }, h('span', { class: 'sr' }, who === 'me' ? 'You said: ' : 'Assistant: '), ...children);
  const proposalCard = e => h('div', { class: 'proposal', id: e.id ? `proposal-${e.id}` : undefined },
    h('div', { class: 'top' }, h('b', {}, `${toolName(e.tool)} · ${opLabel(e.tool, e.operation)}`), statusChip(e.status), e.riskLevel ? riskBadge(e.riskLevel) : null),
    e.status === 'BLOCKED' ? h('p', { class: 'fine' }, e.message ?? 'Blocked by your settings.') : h('p', { class: 'fine' }, 'Nothing happens until you approve it.'),
    e.id && e.status !== 'BLOCKED' ? h('a', { class: 'link', href: `#/review/${encodeURIComponent(e.id)}` }, 'Review it', icon('arrow', 14)) : null);

  log.append(bubble('bot', h('p', {}, 'Hi! Tell me what you need. I will propose it, and you approve it in Review.')));

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
