import { h, icon, toolIcon, clear, fill } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { OPEN, fmtTime } from '../format.js';
import { statusChip, riskBadge, actionTitle, say, errorText } from '../components.js';

/** Dashboard: pending alerts, kill switch, recent actions, agent status (docs/FRONTEND_GUIDE.md §2.1). */
export async function render(view) {
  const heroCount = h('span', { class: 'big', id: 'pending-count' }, '0');
  const heroPills = h('div', { class: 'pills' });
  const heroCta = h('div');
  const waiting = h('div', { class: 'rows', id: 'waiting' });
  const recent = h('div', { class: 'rows', id: 'recent' });
  const agentList = h('div', { class: 'rows', id: 'agents' });
  const killCard = h('section', { class: 'card kill', 'aria-labelledby': 'kill-h' });
  const spendBox = h('div', { class: 'rows' });
  const spendCard = h('section', { class: 'card', id: 'spending', 'aria-labelledby': 'sp-h' },
    h('div', { class: 'card-h' }, h('h2', { id: 'sp-h' }, 'Spending against your caps'), h('a', { class: 'link', href: '#/agents' }, 'Set caps', icon('arrow', 14))), spendBox);
  const live = h('span', { class: 'live-status', id: 'live-status', role: 'status' });
  const showLive = () => { live.classList.toggle('on', !!state.live); live.textContent = state.live ? 'Live' : 'Connecting…'; };
  showLive();
  let agents = await api.agents();
  let sig = '';

  view.append(
    h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Dashboard'), h('p', {}, 'What your agents want to do, and where each request stands.')), live),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card hero', 'aria-labelledby': 'hero-k' }, h('span', { class: 'k', id: 'hero-k' }, 'Waiting for your decision'), heroCount, heroPills,
        h('p', {}, 'Nothing runs until you approve it.'), heroCta),
      killCard),
    h('div', { class: 'grid-3' },
      h('section', { class: 'card', 'aria-labelledby': 'w-h' }, h('div', { class: 'card-h' }, h('h2', { id: 'w-h' }, 'Needs your decision'), h('a', { class: 'link', href: '#/review' }, 'Review all', icon('arrow', 14))), waiting),
      h('section', { class: 'card', 'aria-labelledby': 'r-h' }, h('div', { class: 'card-h' }, h('h2', { id: 'r-h' }, 'Recent actions'), h('a', { class: 'link', href: '#/audit' }, 'Audit log', icon('arrow', 14))), recent),
      h('section', { class: 'card', 'aria-labelledby': 'a-h' }, h('div', { class: 'card-h' }, h('h2', { id: 'a-h' }, 'Agents'), h('a', { class: 'link', href: '#/agents' }, 'Manage', icon('arrow', 14))), agentList)),
    spendCard
  );

  // whole rupees stay short ("₹10,000"); paise only when there are some
  const cash = (n, currency) => { try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n); } catch { return `${n} ${currency}`; } };
  function meter(id, label, spent, cap, currency) {
    const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;
    const fill = h('span', { class: 'fill' });
    fill.style.width = `${pct}%`;   // CSSOM, allowed by the CSP
    const level = !cap ? '' : spent >= cap ? ' full' : pct >= 80 ? ' near' : '';
    return h('div', { class: `spend${level}`, id },
      h('p', { class: 'spend-t' }, h('b', {}, label), cap ? `${cash(spent, currency)} of ${cash(cap, currency)}` : `${cash(spent, currency)} · no cap`),
      cap ? h('span', { class: 'meter', role: 'meter', 'aria-label': `${label}: spent of cap`, 'aria-valuemin': '0', 'aria-valuemax': String(cap), 'aria-valuenow': String(spent) }, fill) : null);
  }
  async function renderSpending() {
    let data;
    try { data = await api.spending(); } catch { return; }
    fill(spendBox, ...(data.agents.length ? data.agents.map(a => h('div', { class: 'spend-agent' },
      h('p', { class: 't' }, icon('payments', 16), ' ', a.agentName),
      h('div', { class: 'spend-grid' },
        meter(`spend-${a.agentId}-today`, 'Today', a.today, a.caps.daily, data.currency),
        meter(`spend-${a.agentId}-week`, 'This week', a.week, a.caps.weekly, data.currency),
        meter(`spend-${a.agentId}-month`, 'This month', a.month, a.caps.monthly, data.currency))))
      : [h('p', { class: 'empty' }, 'No agent may make payments yet.')]));
  }

  const row = a => h('a', { class: 'row', href: `#/review/${encodeURIComponent(a.id)}` }, h('span', { class: 'ic' }, toolIcon(a.tool)),
    h('span', { class: 'grow' }, h('span', { class: 't' }, actionTitle(a)), h('span', { class: 'm' }, `${a.agentName ?? 'Agent'} · ${fmtTime(a.createdAt)}`)),
    h('span', { class: 'chips' }, OPEN.includes(a.status) ? riskBadge(a.riskLevel) : statusChip(a.status)));

  function renderKill() {
    const on = !!state.me?.killSwitch;
    killCard.classList.toggle('on', on);
    const btn = h('button', { type: 'button', class: `btn big-btn ${on ? 'ghost' : 'danger'}`, id: 'kill-switch', 'aria-pressed': String(on) },
      icon(on ? 'play' : 'pause', 20), on ? 'Resume all agents' : 'Pause all agents');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.killSwitch(!on);
        state.me = { ...state.me, killSwitch: !on };
        window.dispatchEvent(new CustomEvent('ag:changed'));   // shell banner, plus this card and the agent list
        say(!on ? 'All agents paused. Pending actions cannot run.' : 'Agents resumed.');
        document.getElementById('kill-switch')?.focus();
      } catch (e) { say(errorText(e)); btn.disabled = false; }
    });
    fill(killCard, 
      h('h2', { id: 'kill-h' }, 'Kill switch'),
      h('p', {}, on ? 'PAUSED. No agent can propose or run anything, including actions already waiting.' : 'One tap pauses every agent at once, including actions already waiting for you.'),
      btn,
      h('p', { class: 'fine' }, 'This is always available, on every plan.'));
  }

  function renderAgents() {
    fill(agentList, ...(agents.length ? agents.map(a => h('div', { class: 'row' }, h('span', { class: 'ic' }, icon('bot')),
      h('span', { class: 'grow' }, h('span', { class: 't' }, a.name), h('span', { class: 'm' }, a.kind === 'assistant' ? 'Built-in Assistant (model under Settings → Models)' : a.model ?? 'No model set')),
      statusChip(state.me?.killSwitch ? 'PAUSED' : a.status)))
      : [h('p', { class: 'empty' }, 'No agents yet. Create one under Agents.')]));
  }

  function update(actions) {
    const open = actions.filter(a => OPEN.includes(a.status));
    const next = JSON.stringify([open.map(a => [a.id, a.status]), actions.slice(0, 8).map(a => [a.id, a.status])]);
    if (next === sig) return;
    sig = next;
    heroCount.textContent = String(open.length);
    const high = open.filter(a => a.riskLevel === 'HIGH' || a.riskLevel === 'CRITICAL').length;
    fill(heroPills, h('span', { class: 'pill' }, `${high} high or critical`), h('span', { class: 'pill' }, `${open.filter(a => a.status === 'NEEDS_REVIEW').length} need review`));
    fill(heroCta, open.length ? h('a', { class: 'btn', href: `#/review/${encodeURIComponent(open[0].id)}` }, 'Start reviewing', icon('arrow', 16)) : h('p', {}, h('b', {}, 'All caught up.')));
    fill(waiting, ...(open.length ? open.slice(0, 5).map(row) : [h('p', { class: 'empty' }, 'Nothing is waiting for you.')]));
    renderSpending();
    fill(recent, ...(actions.length ? actions.slice(0, 6).map(row) : [h('p', { class: 'empty' }, 'No actions yet. Your agents’ proposals appear here.')]));
  }

  renderKill();
  renderAgents();
  update(await api.actions({ limit: 200 }));
  const onTick = e => { update(e.detail.actions); if (killCard.classList.contains('on') !== !!e.detail.me.killSwitch) { renderKill(); renderAgents(); } };
  const onChanged = () => { renderKill(); renderAgents(); };
  window.addEventListener('ag:tick', onTick);
  window.addEventListener('ag:live', showLive);
  showLive();   // the stream may have connected while this screen was loading
  window.addEventListener('ag:changed', onChanged);
  return () => { window.removeEventListener('ag:tick', onTick); window.removeEventListener('ag:changed', onChanged); window.removeEventListener('ag:live', showLive); };
}
