// The tool rail and the flows panel.
// The rail is a column of icon buttons on the left edge of the canvas; each names itself on hover.
// The flows panel lists your flows and the templates. It can be hidden and brought back from the rail.
// This file changes no flow logic: it reads the flows menu that workbench.js fills (#templates)
// and chooses from it exactly as the menu would.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas'), menu = $('templates'), add = $('btnAdd');
  if (!canvas || !menu || !add) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const OPEN = 'arcade-workbench.flows-panel';
  const ICON = {
    flows: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    flow: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 0 1 4 4v5.5"/>',
    template: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M17 14v6M14 17h6"/>',
    blank: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M12 8.5v7M8.5 12h7"/>',
    dup: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    del: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>',
    results: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4.5 17 4.5-4 3.5 3 3-2.5 4 3.5"/>',
  };
  const svg = (k) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ICON.flow}</svg>`;

  // ---------- the rail ----------
  const rail = document.createElement('div');
  rail.className = 'rail';
  rail.setAttribute('role', 'toolbar');
  rail.setAttribute('aria-label', 'Bench tools');
  canvas.insertBefore(rail, add);
  add.setAttribute('aria-label', 'Add a step');
  rail.appendChild(add);
  function tool(label, icon, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'rail-btn'; b.setAttribute('aria-label', label); b.innerHTML = svg(icon);
    b.onclick = onClick;
    rail.appendChild(b);
    return b;
  }
  const flowsBtn = tool('Flows and templates', 'flows', () => setOpen(panel.hidden));
  const results = $('btnResults');
  if (results) tool('What this flow made', 'results', () => results.click());

  // ---------- the flows panel ----------
  const panel = document.createElement('aside');
  panel.className = 'flows-panel';
  panel.setAttribute('aria-label', 'Flows and templates');
  panel.hidden = true;
  canvas.appendChild(panel);
  // Clicks and scrolling inside the rail and the panel must not pan or zoom the canvas behind them.
  for (const el of [rail, panel]) {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  function setOpen(open) {
    panel.hidden = !open;
    flowsBtn.setAttribute('aria-pressed', String(open));
    try { localStorage.setItem(OPEN, open ? 'open' : 'closed'); } catch { /* fine without it */ }
  }
  function iconFor(group, value) {
    if (ICON[value]) return value;
    return /template/i.test(group) ? 'template' : 'flow';
  }
  function render() {
    let h ='<header class="fp-head"><b>Flows</b><button type="button" class="p-close" data-close aria-label="Hide flows">×</button></header>';
    const groups = [...menu.children].filter((c) => c.tagName === 'OPTGROUP');
    for (const g of groups) {
      const items = [...g.children].filter((o) => o.value);
      if (!items.length) continue;
      h += `<h3>${esc(g.label)}</h3>`;
      for (const o of items) {
        // The menu marks the flow on the bench with "(open)"; the panel shows that as the highlighted row.
        const here = /\(open\)\s*$/.test(o.textContent);
        const name = o.textContent.replace(/\s*\(open\)\s*$/, '').trim();
        h += `<button type="button" class="fp-item" data-value="${esc(o.value)}"${here ? ' aria-current="true"' : ''}${o.disabled ? ' disabled' : ''}>${svg(iconFor(g.label, o.value))}<span>${esc(name)}</span></button>`;
      }
    }
    if (!groups.length) h += '<p class="fp-empty">Your flows appear here once they load.</p>';
    panel.innerHTML = h;
  }
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return setOpen(false);
    const item = e.target.closest('.fp-item');
    if (!item) return;
    menu.value = item.dataset.value;
    menu.dispatchEvent(new Event('change', { bubbles: true }));
  });
  new MutationObserver(render).observe(menu, { childList: true, subtree: true, characterData: true });

  // ---------- plus and minus on every step ----------
  // Plus: pick the next step and it is added beside this one, already wired to it. Use it as often as
  // you like on the same step to branch. Minus: remove the step. Both use the bench's own actions.
  const world = $('world');
  const nextMenu = document.createElement('div');
  nextMenu.className = 'next-menu';
  nextMenu.hidden = true;
  canvas.appendChild(nextMenu);
  nextMenu.addEventListener('pointerdown', (e) => e.stopPropagation());
  nextMenu.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  let from = null;

  // Every kind of step that can take something this step gives out.
  function nextOptions(node) {
    const WB = window.WB, outs = WB.NODES[node.type].outputs || [], found = [];
    for (const [type, def] of Object.entries(WB.NODES)) {
      for (const o of outs) {
        const inp = (def.inputs || []).find((i) => i.type === o.type);
        if (inp) { found.push({ type, title: def.title, group: def.group, out: o.key, inp: inp.key, carries: o.label }); break; }
      }
    }
    return found;
  }
  function closeNext() { nextMenu.hidden = true; from = null; }
  function openNext(nodeEl, handle) {
    const WB = window.WB, node = WB.G.node(nodeEl.dataset.id);
    if (!node) return;
    const options = nextOptions(node);
    from = node.id;
    let h = `<header class="fp-head"><b>Add after ${esc(WB.NODES[node.type].title)}</b><button type="button" class="p-close" data-close aria-label="Close">×</button></header>`;
    if (!options.length) h += '<p class="fp-empty">Nothing can follow this step: it gives out nothing another step takes.</p>';
    let group = '';
    for (const o of options) {
      if (o.group !== group) { group = o.group; h += `<h3>${esc(group)}</h3>`; }
      h += `<button type="button" class="fp-item" data-type="${esc(o.type)}" data-out="${esc(o.out)}" data-inp="${esc(o.inp)}"><span>${esc(o.title)}</span><small>takes the ${esc(String(o.carries).toLowerCase())}</small></button>`;
    }
    nextMenu.innerHTML = h;
    nextMenu.hidden = false;
    const c = canvas.getBoundingClientRect(), r = handle.getBoundingClientRect();
    const left = Math.min(r.right + 8 - c.left, c.width - nextMenu.offsetWidth - 12);
    const top = Math.min(Math.max(12, r.top - c.top - 20), Math.max(12, c.height - nextMenu.offsetHeight - 12));
    nextMenu.style.left = Math.max(12, left) + 'px';
    nextMenu.style.top = top + 'px';
  }
  nextMenu.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeNext();
    const item = e.target.closest('.fp-item');
    const WB = window.WB, node = item && WB.G.node(from);
    if (!item || !node) return;
    // Beside the step it comes from, under any steps already branching from it.
    const height = (id) => world.querySelector(`.node[data-id="${id}"]`)?.offsetHeight || 220;
    const kids = WB.S.flow.edges.filter((x) => x.from.node === node.id).map((x) => WB.G.node(x.to.node)).filter(Boolean);
    const y = kids.length ? Math.max(...kids.map((k) => k.y + height(k.id))) + 40 : node.y;
    const before = WB.S.flow.nodes.length;
    WB.addNode(item.dataset.type, { x: node.x + 330, y });
    const made = WB.S.flow.nodes[WB.S.flow.nodes.length - 1];
    if (WB.S.flow.nodes.length > before && made) {
      WB.connect({ node: node.id, port: item.dataset.out }, { node: made.id, port: item.dataset.inp });
      const el = world.querySelector(`.node[data-id="${made.id}"]`), c = canvas.getBoundingClientRect(), r = el?.getBoundingClientRect();
      if (r && (r.right > c.right || r.bottom > c.bottom || r.left < c.left || r.top < c.top)) WB.fit();
    }
    closeNext();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNext(); });
  canvas.addEventListener('pointerdown', (e) => { if (!e.target.closest('.n-plus')) closeNext(); });

  function dress(nodeEl) {
    if (nodeEl.querySelector(':scope > .n-plus')) return;
    const plus = document.createElement('button');
    plus.type = 'button'; plus.className = 'n-plus'; plus.setAttribute('aria-label', 'Add the next step');
    const minus = document.createElement('button');
    minus.type = 'button'; minus.className = 'n-minus'; minus.setAttribute('aria-label', 'Remove this step');
    nodeEl.append(plus, minus);
  }
  world.addEventListener('click', (e) => {
    const plus = e.target.closest('.n-plus'), minus = e.target.closest('.n-minus');
    const nodeEl = (plus || minus)?.closest('.node');
    if (!nodeEl || !window.WB) return;
    if (plus) return from === nodeEl.dataset.id && !nextMenu.hidden ? closeNext() : openNext(nodeEl, plus);
    closeNext();
    nodeEl.querySelector('.n-foot .del')?.click();
  });
  const dressAll = () => world.querySelectorAll('.node').forEach(dress);
  new MutationObserver(dressAll).observe(world, { childList: true });
  dressAll();

  // ---------- recommended setup ----------
  // A step whose choices all have a sensible default is ready to run as it is. The side panel says so,
  // names the setup, and offers one button to go back to it after changes. It presses the step's own
  // choice buttons, so the bench handles the change exactly as if a person had clicked.
  const inspector = $('inspector');
  function presetFields(def) { return (def.fields || []).filter((f) => f.kind === 'chips' && (f.default !== undefined || f.multi)); }
  function atPreset(node, def) {
    return presetFields(def).every((f) => (f.multi ? !(node.cfg[f.key] || []).length : (node.cfg[f.key] ?? f.default) === f.default))
      && (def.fields || []).filter((f) => f.kind === 'textarea' && presetFields(def).length).every((f) => !(node.cfg[f.key] || '').trim());
  }
  function presetBar() {
    const WB = window.WB, node = WB && WB.S.sel && WB.G.node(WB.S.sel);
    const setup = inspector && inspector.querySelector('.n-fields.setup');
    const old = inspector && inspector.querySelector('.preset-bar');
    const def = node && WB.NODES[node.type];
    if (!setup || !def || presetFields(def).filter((f) => f.default !== undefined).length < 2) { if (old) old.remove(); return; }
    const on = atPreset(node, def);
    let made = null;
    try { made = def.madeWith ? def.madeWith() : null; } catch { made = null; }
    let what = '';
    try { what = def.summary ? def.summary({ cfg: Object.fromEntries(presetFields(def).filter((f) => f.default !== undefined).map((f) => [f.key, f.default])) }) : ''; } catch { what = ''; }
    const html = `<b>${on ? 'Recommended setup is on' : 'You changed the setup'}</b>`
      + (on ? '' : '<button type="button" class="btn ghost small" data-preset-reset>Use recommended</button>')
      + `<p>${esc(what)}${what ? '. ' : ''}${on ? 'Run it as it is, or change anything below.' : 'One click puts the recommended choices back.'}</p>`
      + (made ? `<p class="made-with"><span data-logo="${esc(made.maker)}">Image model: <b>${esc(made.name)} · ${esc(made.model)}</b></span><em>${made.ready ? 'Set by default' : 'Set by default. Add an OpenAI key to use it'}</em></p>` : '');
    const bar = old || document.createElement('div');
    if (bar._html !== html) { bar.className = 'preset-bar'; bar.dataset.on = String(on); bar.innerHTML = html; bar._html = html; }
    if (bar.nextElementSibling !== setup) setup.parentNode.insertBefore(bar, setup);
  }
  if (inspector) {
    inspector.addEventListener('click', (e) => {
      if (!e.target.closest('[data-preset-reset]')) return;
      const WB = window.WB, node = WB.G.node(WB.S.sel), def = node && WB.NODES[node.type];
      if (!def) return;
      for (const f of def.fields || []) {
        const box = inspector.querySelector(`.n-fields.setup [data-field="${f.key}"]`);
        if (!box) continue;
        if (f.kind === 'chips' && f.multi) box.querySelectorAll('.chip[aria-pressed="true"]').forEach((b) => b.click());
        else if (f.kind === 'chips' && f.default !== undefined) { const b = box.querySelector(`.chip[data-chip="${f.default}"]`); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); }
        else if (f.kind === 'textarea') { const t = box.querySelector('textarea'); if (t && t.value) { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); } }
      }
      presetBar();
    });
    let pending = false;
    new MutationObserver(() => { if (pending) return; pending = true; setTimeout(() => { pending = false; presetBar(); }, 40); })
      .observe(inspector, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  }

  document.body.classList.add('has-rail');
  render();
  let open = false;
  try { open = localStorage.getItem(OPEN) === 'open'; } catch { /* closed */ }
  setOpen(open);
})();
