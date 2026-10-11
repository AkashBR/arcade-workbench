// The two side panels: a slim menu (an icon and a word per item), and a sub-menu that opens beside it.
// Flows and Steps open a sub-menu; the other items go straight to their page.
// It only uses what the bench already exposes (window.WB, window.App), so it can change on its own.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shell = document.querySelector('.shell');          // present on the bench page only
  const onStudio = /studio\.html$/.test(location.pathname);
  const WB = () => window.WB;
  const svg = (d, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    flows: '<rect x="3" y="4" width="7" height="6" rx="1.5"/><rect x="14" y="14" width="7" height="6" rx="1.5"/><path d="M10 7h3.500a2.500 2.500 0 0 1 2.500 2.500V14"/>',
    steps: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8.500v7M8.500 12h7"/>',
    studio: '<rect x="3" y="7" width="18" height="13" rx="2.500"/><path d="M8.500 7l1.300-2.500h4.400L15.500 7"/><circle cx="12" cy="13.500" r="3.500"/>',
    results: '<rect x="3.500" y="4.500" width="17" height="15" rx="2.500"/><circle cx="9" cy="10" r="1.600"/><path d="M4.500 17l4.500-4 3.500 3 3-2.500 4 3.500"/>',
    runs: '<path d="M4 19V5M4 19h16"/><path d="M8 15v-4M12 15V8M16 15v-6"/>',
    prompts: '<path d="M5 5h14v10H10l-5 4z"/><path d="M9 9h6M9 12h4"/>',
    models: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 6l2.500 2.500M14 8l2 2"/>',
    data: '<ellipse cx="12" cy="6.500" rx="7" ry="2.800"/><path d="M5 6.500v5c0 1.500 3.100 2.800 7 2.800s7-1.300 7-2.800v-5M5 11.500v5c0 1.500 3.100 2.800 7 2.800s7-1.300 7-2.800v-5"/>',
    docs: '<path d="M6 4h9l4 4v12H6z"/><path d="M15 4v4h4M9 12h7M9 15.500h7"/>',
    out: '<path d="M10 5H5v14h5"/><path d="M14 8l4 4-4 4M18 12H9"/>',
    flow: '<circle cx="6" cy="12" r="2.500"/><circle cx="18" cy="12" r="2.500"/><path d="M8.500 12h7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  const ITEMS = [
    { id: 'flows', label: 'Flows', sub: true },
    { id: 'steps', label: 'Steps', sub: true },
    { id: 'results', label: 'Results', act: 'results' },
    { id: 'studio', label: 'Studio', href: '/studio.html' },
    { id: 'runs', label: 'Runs', view: 'runs' },
    { id: 'prompts', label: 'Prompts', view: 'prompts' },
    { id: 'models', label: 'Keys', view: 'models' },
    { id: 'data', label: 'Data', view: 'data' },
    { id: 'docs', label: 'Docs', view: 'docs' },
  ];

  // One more starter workflow: the whole path to a page you can show. Model shots and the listing page do not
  // follow the checkout in a line; all three are fed by the product, and the listing page gathers them at the end.
  const AN = window.ArcadeNodes;
  if (AN && AN.NODES.modelShots && AN.NODES.listing && !AN.TEMPLATES.some((t) => t.id === 'listing')) {
    AN.TEMPLATES.splice(1, 0, { id: 'listing', name: 'Jewelry: prompt to listing page', title: 'Jewelry listing with model shots', blurb: 'Design, price, checkout, model shots, one page', thumb: 'Rings',
      nodes: [
        { id: 'c1', type: 'category', x: 40, y: 220, cfg: { categoryName: 'Rings' } },
        { id: 'd1', type: 'design', x: 370, y: 180, cfg: { prompt: 'A 925 sterling silver ring with a wide hammered band, no stones' } },
        { id: 'p1', type: 'price', x: 700, y: 40, cfg: { quantity: 1 } },
        { id: 'k1', type: 'checkout', x: 1030, y: 40, cfg: { quantity: 1, dropShip: true } },
        { id: 'm1', type: 'modelShots', x: 700, y: 380, cfg: {} },
        { id: 'l1', type: 'listing', x: 1360, y: 220, cfg: {} },
      ],
      edges: [['c1', 'category', 'd1', 'category'], ['d1', 'product', 'p1', 'product'], ['p1', 'product', 'k1', 'product'], ['d1', 'product', 'm1', 'product'],
        ['p1', 'product', 'l1', 'product'], ['m1', 'shots', 'l1', 'shots'], ['k1', 'checkout', 'l1', 'checkout']] });
  }

  document.body.classList.add('has-menu');
  const rail = document.createElement('nav');
  rail.className = 'mrail';
  rail.setAttribute('aria-label', 'Menu');
  rail.innerHTML = `<a class="mrail-brand" href="/#bench" title="Workbench for Arcade">W</a>`
    + ITEMS.map((it) => `<button type="button" class="mrail-item" data-id="${it.id}"${it.sub ? ' aria-expanded="false"' : ''}>${svg(ICON[it.id])}<span>${it.label}</span></button>`).join('')
    + `<span class="mrail-gap"></span><span class="mrail-who" id="railWho"></span><button type="button" class="mrail-item" data-id="out">${svg(ICON.out)}<span>Sign out</span></button>`;
  const sub = document.createElement('aside');
  sub.className = 'msub';
  sub.hidden = true;
  sub.innerHTML = '<div id="subFlows" hidden></div><div id="subSteps" hidden></div>';
  document.body.prepend(sub);
  document.body.prepend(rail);
  // The list of steps the bench already builds becomes the Steps sub-menu.
  const palette = document.getElementById('palette');
  if (palette) sub.querySelector('#subSteps').appendChild(palette);

  let open = null; // 'flows' | 'steps' | null
  const view = () => (onStudio ? 'studio' : (location.hash || '#bench').slice(1) || 'bench');
  function paint() {
    document.body.dataset.sub = open || '';
    sub.hidden = !open;
    sub.querySelector('#subFlows').hidden = open !== 'flows';
    sub.querySelector('#subSteps').hidden = open !== 'steps';
    rail.querySelectorAll('.mrail-item').forEach((b) => {
      const it = ITEMS.find((x) => x.id === b.dataset.id);
      if (!it) return;
      if (it.sub) b.setAttribute('aria-expanded', String(open === it.id));
      const here = it.sub ? open === it.id : !open && (it.view === view() || (it.id === 'studio' && onStudio));
      if (here) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  function setSub(next) {
    if (next === open) return;
    open = next;
    // Keep the bench's own idea of whether the step list is showing in step with this.
    if (shell && WB()) { const want = open === 'steps' ? 'open' : 'closed'; if (shell.dataset.palette !== want) WB().setPalette(want); }
    if (open === 'flows') drawFlows();
    paint();
  }

  // ---------- Flows sub-menu ----------
  const blank = () => ({ name: 'Untitled flow', nodes: [], edges: [] });
  const when = (iso) => { const d = new Date(iso), today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  function drawFlows() {
    const wb = WB(), box = sub.querySelector('#subFlows');
    if (!wb) return;
    const cur = wb.S.flow.id, flows = wb.S.flows.slice();
    if (cur && !flows.some((f) => f.id === cur)) flows.unshift({ id: cur, name: wb.S.flow.name || 'Untitled flow' });
    const glyph = (t) => (window.ArcadeNodes ? svg(window.ArcadeNodes.ICONS[window.ArcadeNodes.glyphKey(t.thumb || '')] || ICON.flow) : svg(ICON.flow));
    box.innerHTML = `<div class="sub-head"><b>Flows</b><button class="p-close" data-act="close" aria-label="Close this menu">×</button></div>
      <button type="button" class="sub-row new" data-act="new"><i>${svg(ICON.plus)}</i><span><b>New flow</b><small>Start with a blank bench</small></span></button>
      <div class="sub-label">Your flows</div>
      ${flows.map((f) => `<button type="button" class="sub-row" data-open="${esc(f.id)}"${f.id === cur ? ' aria-current="true"' : ''}><i>${svg(ICON.flow)}</i><span><b>${esc(f.id === cur ? wb.S.flow.name || f.name : f.name)}</b><small>${f.id === cur ? `Open now · ${wb.S.flow.nodes.length} step${wb.S.flow.nodes.length === 1 ? '' : 's'}` : f.updatedAt ? `Saved ${when(f.updatedAt)}` : 'Click to open'}</small></span></button>`).join('')}
      <div class="sub-acts"><button type="button" class="btn ghost small" data-act="dup">Duplicate this flow</button><button type="button" class="btn ghost small" data-act="del">Delete it</button></div>
      <div class="sub-label">Start from a workflow</div>
      ${wb.TEMPLATES.map((t) => `<button type="button" class="sub-row" data-tpl="${esc(t.id)}"><i>${glyph(t)}</i><span><b>${esc(t.title || t.name)}</b><small>${esc(t.blurb || '')}</small></span></button>`).join('')}
      <div class="sub-label">Files</div>
      <div class="sub-acts"><button type="button" class="btn ghost small" data-act="export">Export as JSON</button><button type="button" class="btn ghost small" data-act="import">Import JSON</button></div>`;
  }
  sub.addEventListener('click', async (e) => {
    const t = e.target.closest('#subFlows button');
    const wb = WB();
    if (!t || !wb) return;
    const d = t.dataset;
    try {
      if (d.act === 'close') return setSub(null);
      if (d.open) { if (d.open !== wb.S.flow.id) { await wb.saveNow(); await wb.openFlow(d.open); } return drawFlows(); }
      if (d.act === 'new') { await wb.saveNow(); wb.setFlow(blank()); await wb.saveNow(); return setSub(null); }
      if (d.tpl) {
        const next = wb.fromTemplate(wb.TEMPLATES.find((x) => x.id === d.tpl));
        if (wb.S.flow.nodes.length) { await wb.saveNow(); wb.setFlow(next); } else wb.setFlow({ ...next, id: wb.S.flow.id });
        await wb.saveNow();
        setSub(null);
        return requestAnimationFrame(wb.fit);
      }
      if (d.act === 'dup') {
        await wb.saveNow();
        const copy = JSON.parse(JSON.stringify({ nodes: wb.S.flow.nodes.map(({ calls, t0, progress, ...n }) => n), edges: wb.S.flow.edges }));
        wb.setFlow({ name: `${wb.S.flow.name || 'Untitled flow'} copy`, nodes: copy.nodes, edges: copy.edges }, { keepView: true });
        await wb.saveNow();
        return drawFlows();
      }
      if (d.act === 'del') {
        if (!confirm(`Delete “${wb.S.flow.name || 'Untitled flow'}”? Anything it made stays on your Arcade account.`)) return;
        await wb.saveNow();
        const gone = wb.S.flow.id;
        wb.S.flow.id = '';
        await window.App.api('flows/' + gone, { method: 'DELETE' });
        wb.S.flows = wb.S.flows.filter((f) => f.id !== gone);
        if (wb.S.flows.length) await wb.openFlow(wb.S.flows[0].id); else { wb.setFlow(blank()); await wb.saveNow(); }
        return drawFlows();
      }
      if (d.act === 'export') return document.getElementById('btnExport')?.click();
      if (d.act === 'import') { setSub(null); return document.getElementById('btnImport')?.click(); }
    } catch (err) { if (window.App) window.App.toast(err.message); }
  });

  // ---------- the menu ----------
  rail.addEventListener('click', async (e) => {
    const b = e.target.closest('.mrail-item');
    if (!b) return;
    const id = b.dataset.id, it = ITEMS.find((x) => x.id === id);
    if (id === 'out') { await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}); location.href = '/login.html'; return; }
    if (it.href) { location.href = it.href; return; }
    // Results is the bench's own panel of everything the flow has made; this opens it.
    if (it.act === 'results') { if (!shell) { location.href = '/#bench'; return; } setSub(null); if (view() !== 'bench') location.hash = '#bench'; return void setTimeout(() => document.getElementById('btnResults')?.click(), 60); }
    if (it.sub) {
      // The sub-menus belong to the bench. From another page, go there and open it on arrival.
      if (!shell) { try { sessionStorage.setItem('wb.sub', id); } catch { /* opens closed */ } location.href = '/#bench'; return; }
      if (view() !== 'bench') location.hash = '#bench';
      return setSub(open === id ? null : id);
    }
    setSub(null);
    if (shell) location.hash = '#' + it.view; else location.href = '/#' + it.view;
  });
  window.addEventListener('hashchange', () => { if (view() !== 'bench') setSub(null); paint(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && !document.querySelector('dialog[open]')) setSub(null); });
  // The bench opens and closes its step list itself too (the + button, the start card): follow it.
  // On a stacked (narrow) layout the step panel takes half the screen, so bring the steps back into what is left.
  if (shell) new MutationObserver(() => { if (innerWidth <= 1020 && WB()) requestAnimationFrame(WB().fit); }).observe(shell, { attributes: true, attributeFilter: ['data-panel'] });
  if (shell) new MutationObserver(() => { const want = shell.dataset.palette === 'open'; if (want && open !== 'steps') setSub('steps'); else if (!want && open === 'steps') setSub(null); }).observe(shell, { attributes: true, attributeFilter: ['data-palette'] });

  // ---------- loading cues ----------
  // 1. A thin bar across the top whenever the page is waiting on the server for more than a moment.
  const bar = document.createElement('div');
  bar.className = 'loadbar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Loading');
  bar.hidden = true;
  document.body.appendChild(bar);
  let waiting = 0, showTimer = null;
  const settle = () => {
    if (waiting > 0) { if (!showTimer && bar.hidden) showTimer = setTimeout(() => { showTimer = null; if (waiting > 0) bar.hidden = false; }, 250); }
    else { clearTimeout(showTimer); showTimer = null; bar.hidden = true; }
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    // Job polls come every three seconds during a run; the running cue below covers those.
    const counts = url.includes('/api/') && !url.includes('/arcade/jobs/get');
    if (counts) { waiting++; settle(); }
    return realFetch(input, init).finally(() => { if (counts) { waiting--; settle(); } });
  };
  // 2. While a flow is running: a pill on the canvas naming the step at work, and a spinner on Run flow.
  if (shell) {
    const pill = document.createElement('div');
    pill.className = 'runpill';
    pill.setAttribute('role', 'status');
    pill.hidden = true;
    document.getElementById('canvas').appendChild(pill);
    setInterval(() => {
      const wb = WB();
      if (!wb) return;
      const n = wb.S.busy && wb.S.flow.nodes.find((x) => x.status === 'running');
      document.body.toggleAttribute('data-busy', Boolean(wb.S.busy));
      pill.hidden = !n;
      if (n) {
        const secs = Math.max(0, Math.round((Date.now() - n.t0) / 1000));
        const text = `${wb.NODES[n.type].title}: ${n.progress || 'working'} · ${secs}s`;
        if (pill.textContent !== text) pill.innerHTML = `<i></i><span>${esc(text)}</span>`;
      }
    }, 400);
  }

  (async function boot() {
    paint();
    const me = window.App ? await window.App.ready.catch(() => null) : await fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (me) { const u = me.user.username; document.getElementById('railWho').textContent = u.slice(0, 1).toUpperCase(); document.getElementById('railWho').title = `Signed in as ${u}`; }
    if (!shell) return;
    let want = null;
    try { want = sessionStorage.getItem('wb.sub'); sessionStorage.removeItem('wb.sub'); } catch { /* none */ }
    if (shell.dataset.palette === 'open') want = want || 'steps';
    if (want && view() === 'bench') setTimeout(() => setSub(want), 300);
  })();
})();
