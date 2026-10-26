import { h, icon, toolIcon, clear } from '../dom.js';
import { api } from '../api.js';
import { toolName, opLabel } from '../state.js';
import { OPEN, INTENT, fmtTime, countdown } from '../format.js';
import { statusChip, riskBadge, flagChip, modeBadge, actionTitle, payloadFields, pipeline, openDialog, say, errorText } from '../components.js';
import { preview, changesCard } from '../previews.js';

/**
 * Review: the queue plus the full details of one action (docs/FRONTEND_GUIDE.md §2.2).
 * The approve request sends the payloadHash that was on screen; the backend refuses it if anything changed.
 */
export async function render(view, selectedId) {
  let filter = 'open', actions = await api.actions({ limit: 200 }), current = null, listSig = '', detailSig = '', timer = null;
  const queue = h('ul', { class: 'qlist', id: 'queue' });
  const detail = h('section', { class: 'detail', 'aria-labelledby': 'detail-h', id: 'detail' });
  const segOpen = h('button', { type: 'button', id: 'seg-open' }, 'Needs decision');
  const segAll = h('button', { type: 'button', id: 'seg-all' }, 'All');
  segOpen.addEventListener('click', () => { filter = 'open'; renderQueue(true); });
  segAll.addEventListener('click', () => { filter = 'all'; renderQueue(true); });

  view.append(
    h('div', { class: 'head' }, h('div', {}, h('h1', { id: 'title', tabindex: '-1' }, 'Review'), h('p', {}, 'Check the exact details, then approve or reject. Nothing is approved by default.'))),
    h('div', { class: 'review' },
      h('section', { class: 'card queue', 'aria-label': 'Proposed actions' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Which actions to list' }, segOpen, segAll), queue),
      detail));

  const visible = () => filter === 'open' ? actions.filter(a => OPEN.includes(a.status)) : actions;

  function renderQueue(force = false) {
    segOpen.setAttribute('aria-pressed', String(filter === 'open'));
    segAll.setAttribute('aria-pressed', String(filter === 'all'));
    segOpen.textContent = `Needs decision · ${actions.filter(a => OPEN.includes(a.status)).length}`;
    segAll.textContent = `All · ${actions.length}`;
    const list = visible();
    const sig = JSON.stringify([filter, selectedId, list.map(a => [a.id, a.status])]);
    if (!force && sig === listSig) return;
    listSig = sig;
    clear(queue).append(...(list.length ? list.map(a => h('li', {}, h('a', { class: 'qitem', href: `#/review/${encodeURIComponent(a.id)}`, 'aria-current': String(a.id === selectedId), id: `q-${a.id}` },
      h('span', { class: 'ic' }, toolIcon(a.tool)),
      h('span', { class: 'qmain' }, h('span', { class: 'qtitle' }, actionTitle(a)), h('span', { class: 'qmeta' }, `${a.agentName ?? 'Agent'} · ${fmtTime(a.createdAt)}`),
        h('span', { class: 'chips' }, riskBadge(a.riskLevel), statusChip(a.status))))))
      : [h('li', { class: 'empty' }, filter === 'open' ? 'Nothing is waiting. Choose “All” to see earlier actions.' : 'No actions yet.')]));
  }

  async function loadDetail(force = false) {
    if (!selectedId) selectedId = visible()[0]?.id ?? actions[0]?.id;
    if (!selectedId) { clear(detail).append(h('div', { class: 'card' }, h('h2', { id: 'detail-h' }, 'No actions yet'), h('p', { class: 'muted' }, 'When an agent proposes something, it appears here for your decision.'))); return; }
    try { current = await api.action(selectedId); }
    catch { clear(detail).append(h('div', { class: 'card' }, h('h2', { id: 'detail-h' }, 'Action not found'), h('p', { class: 'muted' }, 'It may belong to another account.'))); return; }
    const sig = JSON.stringify([current.status, current.execution, current.approval]);
    if (!force && sig === detailSig) return;
    detailSig = sig;
    renderDetail(current);
  }

  function renderDetail(a) {
    if (timer) clearInterval(timer);
    const open = OPEN.includes(a.status);
    const parts = [
      h('div', { class: 'd-top' },
        h('p', { class: 'd-kicker' }, h('span', { class: 'ic' }, toolIcon(a.tool)), `${toolName(a.tool)} · ${opLabel(a.tool, a.operation)} · proposed by ${a.agentName ?? 'an agent'}`, modeBadge('MOCK')),
        h('h2', { id: 'detail-h', tabindex: '-1' }, actionTitle(a)),
        h('p', { class: 'fine' }, `${a.id} · ${fmtTime(a.createdAt)}`),
        h('div', { class: 'chips' }, riskBadge(a.riskLevel), statusChip(a.status))),
      pipeline(a)
    ];
    if (a.status === 'NEEDS_REVIEW') parts.push(h('div', { class: 'warn', role: 'note' }, h('b', {}, 'AgentGuard is not sure about this one. '), 'Details are missing or the risk check was uncertain, so check everything yourself. Approving needs your password.'));
    if (a.status === 'BLOCKED') parts.push(h('div', { class: 'err', role: 'note' }, `Blocked: ${a.blockReason ?? 'not allowed'}. It cannot run.`));

    parts.push(changesCard(a), preview(a));
    parts.push(h('section', { class: 'card', 'aria-labelledby': 'd-details' }, h('h2', { id: 'd-details' }, 'Exact details'), payloadFields(a.payload)));
    parts.push(h('section', { class: 'card', 'aria-labelledby': 'd-risk' },
      h('div', { class: 'card-h' }, h('h2', { id: 'd-risk' }, 'Intent and risk'), h('span', { class: 'adv' }, 'Advisory')),
      h('div', { class: 'kv' },
        h('div', {}, h('p', { class: 'sub-h' }, 'Intent'), h('p', {}, INTENT[a.intent] ?? a.intent ?? '—')),
        h('div', {}, h('p', { class: 'sub-h' }, 'Risk'), h('p', {}, riskBadge(a.riskLevel), ` ${a.riskScore ?? '—'}/100`)),
        h('div', {}, h('p', { class: 'sub-h' }, 'Confidence'), h('p', {}, a.confidence == null ? '—' : `${Math.round(a.confidence * 100)}%`)),
        h('div', {}, h('p', { class: 'sub-h' }, 'Flags'), h('p', { class: 'chips' }, a.flags.length ? a.flags.map(flagChip) : 'None'))),
      a.reasons.length ? h('div', {}, h('p', { class: 'sub-h' }, 'Why'), h('ul', { class: 'dots', id: 'reasons' }, a.reasons.map(r => h('li', {}, r)))) : h('p', { class: 'empty' }, 'No risk factors found.'),
      h('p', { class: 'fine' }, 'The risk check helps you decide. It never approves anything by itself.')));

    const auto = a.approval?.reason === 'AUTO_ALLOWED';
    if (a.approval) parts.push(h('section', { class: 'card', 'aria-labelledby': 'd-dec' }, h('h2', { id: 'd-dec' }, auto ? 'Auto-approved' : 'Your decision'),
      h('p', {}, auto ? `Ran without asking at ${fmtTime(a.approval.decidedAt)}, because you auto-allow LOW-risk ${a.intent === 'SET_REMINDER' ? 'alarms' : 'reads'} for this agent.`
        : `${a.approval.decision === 'APPROVED' ? 'Approved' : 'Rejected'} by you at ${fmtTime(a.approval.decidedAt)}${a.approval.reauthUsed ? ', password confirmed' : ''}.`),
      a.approval.reason && !auto ? h('p', { class: 'muted' }, `Reason: ${a.approval.reason}`) : null));
    if (a.execution) {
      const shown = Object.entries(a.execution.result ?? {}).filter(([, v]) => v != null && typeof v !== 'object').slice(0, 8);
      parts.push(h('section', { class: 'card', 'aria-labelledby': 'd-exe' }, h('h2', { id: 'd-exe' }, 'Result from the provider'),
        h('p', {}, modeBadge(a.execution.adapterMode), ' ',
          a.status === 'COMPLETED' ? `Confirmed. Reference ${a.execution.providerRef}.` : a.status === 'FAILED' ? `Failed: ${a.execution.error ?? 'provider error'}.` : 'No confirmation received, so the outcome is unknown.'),
        shown.length ? h('dl', { class: 'result' }, shown.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])) : null));
    }

    if (open) parts.push(decisionBar(a));
    clear(detail).append(...parts.filter(Boolean));   // native append would print null as text
  }

  function decisionBar(a) {
    const shownHash = a.payloadHash;   // this exact value is what gets approved
    const expires = Date.parse(a.expiresAt), created = Date.parse(a.createdAt);
    const fill = h('div', { class: 'fill' });
    const left = h('span', { class: 't', id: 'countdown' }, '—');
    const timerBox = h('div', { class: 'timer', role: 'timer', 'aria-label': 'Time left to decide' }, h('p', { class: 'sub-h' }, 'Expires in'), left, h('div', { class: 'bar', 'aria-hidden': 'true' }, fill));
    const reject = h('button', { type: 'button', class: 'btn reject', id: 'btn-reject' }, icon('x', 18), 'Reject');
    const approve = h('button', { type: 'button', class: 'btn primary approve', id: 'btn-approve' }, icon('check', 18), 'Approve…');
    reject.addEventListener('click', () => rejectDialog(a));
    approve.addEventListener('click', () => approveDialog(a, shownHash));

    const tick = () => {
      const ms = expires - Date.now();
      left.textContent = ms > 0 ? countdown(ms) : 'Expired';
      fill.style.width = `${Math.max(0, Math.min(100, (ms / (expires - created)) * 100))}%`;   // CSSOM, allowed by the CSP
      timerBox.classList.toggle('low', ms < 60_000);
      if (ms <= 0) { approve.disabled = true; reject.disabled = true; clearInterval(timer); setTimeout(() => refresh(true), 800); }
    };
    tick();
    timer = setInterval(tick, 1000);
    return h('div', { class: 'decide', role: 'region', 'aria-label': 'Your decision' },
      h('div', { class: 'kv' }, timerBox, h('div', {}, h('p', { class: 'sub-h' }, 'Details check'), h('p', { class: 'hash', title: shownHash }, `${shownHash.slice(0, 16)}…`),
        h('p', { class: 'fine' }, a.requiresReauth ? 'Approving needs your password.' : 'Approving opens a final review.'))),
      h('div', { class: 'pair' }, reject, approve));
  }

  function approveDialog(a, shownHash) {
    const pw = h('input', { class: 'input', type: 'password', id: 'reauth-password', autocomplete: 'current-password' });
    const error = h('p', { class: 'err', role: 'alert', hidden: true });
    const back = h('button', { type: 'button', class: 'btn ghost', id: 'dlg-back' }, 'Back, don’t approve');
    const confirm = h('button', { type: 'button', class: 'btn primary', id: 'dlg-approve' }, a.requiresReauth ? 'Confirm password and approve' : 'Approve');
    const body = h('div', { class: 'detail' },
      h('p', { class: 'summary' }, actionTitle(a)), h('p', { class: 'chips' }, riskBadge(a.riskLevel), statusChip(a.status)),
      payloadFields(a.payload),
      a.requiresReauth ? h('div', { class: 'reauth', id: 'reauth-box' },
        h('label', { class: 'field', for: 'reauth-password' }, a.status === 'NEEDS_REVIEW' ? 'This needs review: confirm your password' : `${a.riskLevel === 'CRITICAL' ? 'Critical' : 'High'}-risk action: confirm your password`, pw),
        h('p', { class: 'fine' }, 'Required for high-risk and needs-review actions. Your password is sent once and never stored in the browser.')) : null,
      h('p', { class: 'fine' }, 'You are approving exactly these details (check ', h('code', {}, shownHash.slice(0, 12)), '). If the agent changes anything, this approval will not apply. Approving is your decision; the result comes from the provider.'),
      error);
    const dlg = openDialog({ title: 'Final review', body, actions: [back, confirm] });
    back.addEventListener('click', () => { dlg.close(); say('Not approved. The action is still waiting.'); });
    confirm.addEventListener('click', async () => {
      error.hidden = true;
      if (a.requiresReauth && !pw.value) { error.textContent = 'Enter your password to approve.'; error.hidden = false; pw.focus(); return; }
      confirm.disabled = true; back.disabled = true;
      try {
        if (a.requiresReauth) {
          try { await api.reauth(pw.value); } catch { error.textContent = 'That password is wrong.'; error.hidden = false; confirm.disabled = false; back.disabled = false; pw.select(); return; }
          pw.value = '';
        }
        const after = await api.approve(a.id, shownHash);
        dlg.close();
        say(after.status === 'COMPLETED' ? 'Approved. The provider confirmed it ran.' : after.status === 'UNKNOWN' ? 'Approved, but the provider did not confirm the result.' : `Approved. Status: ${after.status}.`);
        window.dispatchEvent(new CustomEvent('ag:changed'));
        await refresh(true);
        document.getElementById('detail-h')?.focus();
      } catch (err) {
        error.textContent = errorText(err); error.hidden = false; back.disabled = false;
        if (['PAYLOAD_CHANGED', 'APPROVAL_EXPIRED', 'ALREADY_DECIDED', 'PERMISSION_DENIED', 'AGENT_PAUSED'].includes(err.code)) refresh(true);
        else confirm.disabled = false;
      }
    });
  }

  function rejectDialog(a) {
    const reason = h('textarea', { class: 'input', id: 'reject-reason', rows: '3', maxlength: '500' });
    const back = h('button', { type: 'button', class: 'btn ghost', id: 'dlg-back' }, 'Back');
    const confirm = h('button', { type: 'button', class: 'btn reject', id: 'dlg-reject' }, 'Reject');
    const error = h('p', { class: 'err', role: 'alert', hidden: true });
    const dlg = openDialog({ title: 'Reject this action?', body: h('div', { class: 'detail' }, h('p', { class: 'summary' }, actionTitle(a)),
      h('label', { class: 'field', for: 'reject-reason' }, 'Reason ', h('small', {}, '(optional, saved in the audit log)'), reason), error), actions: [back, confirm] });
    back.addEventListener('click', () => dlg.close());
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try { await api.reject(a.id, reason.value.trim() || undefined); dlg.close(); say('Rejected. It will not run.'); window.dispatchEvent(new CustomEvent('ag:changed')); await refresh(true); }
      catch (err) { error.textContent = errorText(err); error.hidden = false; confirm.disabled = false; refresh(true); }
    });
  }

  async function refresh(force = false) {
    actions = await api.actions({ limit: 200 });
    renderQueue(force);
    await loadDetail(force);
  }

  renderQueue(true);
  await loadDetail(true);
  const onTick = e => { actions = e.detail.actions; renderQueue(); if (!document.querySelector('#layer .dialog')) loadDetail(); };
  window.addEventListener('ag:tick', onTick);
  return () => { window.removeEventListener('ag:tick', onTick); if (timer) clearInterval(timer); };
}
