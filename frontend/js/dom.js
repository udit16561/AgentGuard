/**
 * Tiny DOM builder. Strings always become text nodes (never innerHTML), so agent-supplied text
 * cannot inject markup or scripts (docs/FRONTEND_GUIDE.md §4, UI-05).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = el => { el.replaceChildren(); return el; };

// icons as shape lists, built with createElementNS (no markup strings)
const SHAPES = {
  clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3 2' }]],
  check: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M8 12.3l2.7 2.7L16 9.5' }]],
  ok: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  x: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M9 9l6 6M15 9l-6 6' }]],
  send: [['path', { d: 'M4 12l16-7-6 16-2.5-6.5z' }]],
  done: [['path', { d: 'M2.5 12.5l4 4 8-8.5' }], ['path', { d: 'M12 16l.5.5 9-9' }]],
  alert: [['path', { d: 'M12 3.5l9.5 16.5h-19z' }], ['path', { d: 'M12 10v4.5' }], ['path', { d: 'M12 17.3v.2' }]],
  q: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4' }], ['path', { d: 'M12 16.6v.2' }]],
  slash: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M6 18L18 6' }]],
  hourglass: [['path', { d: 'M7 3.5h10M7 20.5h10M8 3.5c0 5 8 5 8 8.5s-8 3.5-8 8.5M16 3.5c0 5-8 5-8 8.5s8 3.5 8 8.5' }]],
  dot: [['circle', { cx: 12, cy: 12, r: 4.5 }]],
  shield: [['path', { d: 'M12 3l7 2.8v5.4c0 4.8-3.2 8.3-7 9.8-3.8-1.5-7-5-7-9.8V5.8z' }], ['path', { d: 'M9 12l2.2 2.2L15.5 10' }]],
  home: [['path', { d: 'M4 11l8-6.5 8 6.5' }], ['path', { d: 'M6 9.5V20h12V9.5' }]],
  inbox: [['path', { d: 'M4 13l2.5-7.5h11L20 13v6H4z' }], ['path', { d: 'M4 13h4.5l1 2h5l1-2H20' }]],
  plug: [['path', { d: 'M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21' }]],
  bot: [['rect', { x: 4.5, y: 8, width: 15, height: 11, rx: 3 }], ['path', { d: 'M12 4v4M9 13h.01M15 13h.01' }]],
  trace: [['path', { d: 'M5 6h14M5 12h14M5 18h9' }]],
  gear: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8' }]],
  pause: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M10 9v6M14 9v6' }]],
  play: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M10 8.5l5 3.5-5 3.5z' }]],
  key: [['circle', { cx: 8, cy: 14, r: 3.5 }], ['path', { d: 'M10.5 11.5L19 3M15.5 6.5l2 2M13.5 8.5l1.5 1.5' }]],
  arrow: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  lock: [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }]],
  // tools
  gmail: [['rect', { x: 3, y: 5.5, width: 18, height: 13, rx: 2 }], ['path', { d: 'M3.5 7l8.5 6 8.5-6' }]],
  calendar: [['rect', { x: 3.5, y: 5, width: 17, height: 15, rx: 2 }], ['path', { d: 'M3.5 10h17M8 3v4M16 3v4' }]],
  clockTool: [['circle', { cx: 12, cy: 13, r: 7.5 }], ['path', { d: 'M12 9.5V13l2.5 1.5M5 4.5L3 6.5M19 4.5l2 2' }]],
  whatsapp: [['path', { d: 'M4 20l1.3-4A8 8 0 1 1 8.5 19z' }]],
  instagram: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 4.5 }], ['circle', { cx: 12, cy: 12, r: 3.6 }], ['path', { d: 'M16.8 7.2h.01' }]],
  linkedin: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 2.5 }], ['path', { d: 'M8 10.5V16M8 7.8v.2M11.5 16v-5.5M11.5 13c0-1.6 1-2.6 2.3-2.6s2.2.9 2.2 2.6V16' }]],
  xTool: [['path', { d: 'M5 4.5l14 15M19 4.5l-14 15' }]],
  payments: [['rect', { x: 3, y: 6, width: 18, height: 12, rx: 2 }], ['path', { d: 'M3 10h18M7 15h3' }]],
  blog: [['path', { d: 'M5 4.5h10l4 4V19.5H5z' }], ['path', { d: 'M15 4.5v4h4M8 12h8M8 15.5h6' }]],
  unknown: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M8 12h.01M12 12h.01M16 12h.01' }]]
};
const TOOL_ICON = { gmail: 'gmail', calendar: 'calendar', clock: 'clockTool', whatsapp: 'whatsapp', instagram: 'instagram', linkedin: 'linkedin', x: 'xTool', payments: 'payments', blog: 'blog' };
export const toolIcon = (tool, size = 18) => icon(TOOL_ICON[tool] ?? 'unknown', size);

export function icon(name, size = 18, strokeWidth = 2.2) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
  for (const [tag, attrs] of SHAPES[name] ?? SHAPES.unknown) {
    const s = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, String(v));
    svg.append(s);
  }
  return svg;
}

export function announce(msg) {
  const el = document.getElementById('live');
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 50);
}
