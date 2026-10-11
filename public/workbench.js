// Workbench engine: the canvas, the wiring, the checks and the runner.
// Capabilities live in nodes.js; nothing in here knows about a specific endpoint.
(function () {
  'use strict';
  const { NODES, GROUPS, TEMPLATES, UNAVAILABLE } = window.ArcadeNodes;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (p) => `${p}-${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const LEGACY = 'arcade-workbench.flow.v1'; // where a flow lived before accounts existed
  let LAST = 'arcade-workbench.last';
  const NODE_W = 264;
  const COST = {
    read: 'Ready. Reads only, nothing is created.',
    create: 'Ready. Makes something new on your Arcade account, about a minute.',
    checkout: 'Ready. Creates a real checkout. You confirm first.',
  };

  const S = { flow: { id: '', name: '', nodes: [], edges: [] }, flows: [], view: { x: 30, y: 24, k: 1 }, sel: null, selEdge: null,
    cat: { categories: [], models: [], hasKey: null }, busy: false, batch: null, needFit: false, log: [] };
  const els = new Map();
  const renewed = new Set();

  // ---------- graph ----------
  let depth = 0;
  const G = {
    node: (id) => S.flow.nodes.find((n) => n.id === id),
    edgesIn: (n, key) => S.flow.edges.filter((e) => e.to.node === n.id && (key == null || e.to.port === key)),
    edgesOut: (n, key) => S.flow.edges.filter((e) => e.from.node === n.id && (key == null || e.from.port === key)),
    connected: (n, key) => G.edgesIn(n, key).length > 0,
    source: (n, key) => { const e = G.edgesIn(n, key)[0]; const node = e && G.node(e.from.node); return node ? { node, port: e.from.port } : null; },
    inWorld: (n, key) => { const s = G.source(n, key); return s ? G.worldOf(s.node) : undefined; },
    worldOf: (n) => {
      const def = NODES[n.type];
      if (!def.world || depth > 40) return null;
      depth++;
      try { return def.world(n, G) ?? null; } finally { depth--; }
    },
    categoryWorld: (id) => S.cat.categories.find((c) => c.categoryId === id)?.world ?? null,
  };

  function descendants(root) {
    const seen = new Set(), stack = [root.id];
    while (stack.length) {
      for (const e of S.flow.edges.filter((x) => x.from.node === stack[stack.length - 1] && !seen.has(x.to.node))) { seen.add(e.to.node); stack.push(e.to.node); continue; }
      stack.pop();
    }
    return [...seen].map(G.node).filter(Boolean);
  }
  function topo() {
    const left = new Map(S.flow.nodes.map((n) => [n.id, new Set(G.edgesIn(n).map((e) => e.from.node))]));
    const out = [];
    while (left.size) {
      const ready = [...left].filter(([, deps]) => ![...deps].some((d) => left.has(d))).map(([id]) => id);
      if (!ready.length) break;
      ready.sort((a, b) => G.node(a).x - G.node(b).x || G.node(a).y - G.node(b).y);
      for (const id of ready) { out.push(G.node(id)); left.delete(id); }
    }
    return out;
  }

  // ---------- checks: can this step run, and if not, why ----------
  function checks(n) {
    const def = NODES[n.type], items = [];
    for (const p of def.inputs) {
      const edges = G.edgesIn(n, p.key);
      if (!edges.length) { if (!p.optional) items.push({ level: 'block', text: `Connect a ${p.type === 'pattern' ? 'design' : p.type} to this step.` }); continue; }
      for (const e of edges) {
        const src = G.node(e.from.node);
        const o = src && NODES[src.type].outputs.find((x) => x.key === e.from.port);
        if (o?.when && !o.when(src, G)) items.push({ level: 'block', text: o.whyNot });
      }
    }
    if (def.check) items.push(...def.check(n, G));
    return items;
  }
  function whyNot(n, d = 0) {
    const own = checks(n).filter((i) => i.level === 'block');
    if (own.length) return { text: own[0].text, more: own.length - 1, self: true };
    if (d > 40) return null;
    for (const p of NODES[n.type].inputs) {
      for (const e of G.edgesIn(n, p.key)) {
        const src = G.node(e.from.node);
        if (!src || src.out) continue;
        const r = whyNot(src, d + 1);
        if (r) return { text: `${NODES[src.type].title} step: ${r.text}`, more: 0, self: false };
      }
    }
    return null;
  }
  function sigOf(n) {
    return JSON.stringify([n.cfg, NODES[n.type].inputs.map((p) => G.edgesIn(n, p.key).map((e) => [e.from.node, e.from.port, G.node(e.from.node)?.runId || null]))]);
  }
  function statusOf(n) {
    if (n.status === 'running') return 'running';
    if (n.status === 'error') return 'error';
    if (n.status === 'ok') return n.sig === sigOf(n) ? 'ok' : 'stale';
    const w = whyNot(n);
    return w ? (w.self ? 'blocked' : 'waiting') : 'ready';
  }
  const dur = (ms) => (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + 's';
  function stampText(n, st, live = true) {
    switch (st) {
      case 'running': return live ? `Running ${Math.round((Date.now() - n.t0) / 1000)}s` : 'Running';
      case 'ok': return `Worked${n.ms != null ? ' · ' + dur(n.ms) : ''}`;
      case 'stale': return 'Edited since run';
      case 'error': return `Failed${n.error?.status ? ' · ' + n.error.status : ''}`;
      case 'blocked': return 'Can’t run';
      case 'waiting': return 'Waiting';
      default: return 'Ready';
    }
  }

  // ---------- Arcade calls ----------
  function logCall(node, endpoint, req, status, body, ms, quiet) {
    const entry = { endpoint, req, status, body, ms, quiet, at: Date.now(), node: node ? NODES[node.type].title : null };
    for (const list of [node && (node.calls = node.calls || []), S.log]) {
      if (!list) continue;
      const last = list[list.length - 1];
      if (quiet && last && last.quiet && last.endpoint === endpoint) list[list.length - 1] = entry; else list.push(entry);
      if (list.length > 120) list.shift();
    }
  }
  // One call through the local server. Waits and retries on 429/5xx with the same body.
  async function arcade(endpoint, body = {}, { node = null, quiet = false } = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const t0 = performance.now();
      let res, data;
      try {
        res = await fetch('/api/arcade/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        data = await res.json();
      } catch (e) {
        logCall(node, endpoint, body, 0, { message: String(e) }, Math.round(performance.now() - t0), quiet);
        throw new Error('The local server is not reachable. Is `node server.js` still running?');
      }
      logCall(node, endpoint, body, res.status, data, Math.round(performance.now() - t0), quiet);
      if (res.status === 401 && data.code === 'SIGN_IN') { location.href = '/login.html'; throw new Error('Signed out.'); }
      if (res.ok) return data;
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 409 && /start/i.test(data.message || ''));
      if (retryable && attempt < 4 && data.code !== 'NO_KEY' && data.code !== 'UPSTREAM_UNREACHABLE') {
        await sleep((Number(res.headers.get('Retry-After')) || 3 * (attempt + 1)) * 1000);
        continue;
      }
      const err = new Error(`${res.status}${data.code ? ' ' + data.code : ''}: ${data.message || data.error || 'Request failed'}`);
      err.status = res.status; err.data = data;
      throw err;
    }
  }
  async function readPattern(patternId, world, node) {
    const p = await arcade('patterns/get', { patternId }, { node });
    return { patternId: p.patternId, imageUrl: p.imageUrl, thumbnailUrl: p.thumbnailUrl, width: p.width, height: p.height, prompt: p.prompt, sourcePatternId: p.sourcePatternId, world: world ?? null };
  }
  async function readProduct(productId, quantity, world, node) {
    const p = await arcade('products/get', { productId, quantity }, { node });
    return { productId: p.productId, title: p.title, imageUrl: p.images?.[0]?.url || p.imageUrl, images: (p.images || []).map((i) => i.url),
      unitPrice: p.unitPrice, maker: p.maker?.name || '', selectionLabel: p.selectionLabel, description: p.description,
      volumeDiscounts: p.volumeDiscounts, patternId: p.patternId, categoryId: p.categoryId, quantity,
      world: world ?? G.categoryWorld(p.categoryId) };
  }
  function ctxFor(n) {
    return {
      uid,
      category: (id) => S.cat.categories.find((c) => c.categoryId === id),
      arcade: (endpoint, body) => arcade(endpoint, body, { node: n }),
      readPattern: (id, world) => readPattern(id, world, n),
      readProduct: (id, qty, world) => readProduct(id, qty, world, n),
      // Starts a job and polls it every 3 seconds until it finishes.
      job: async (endpoint, body, label) => {
        n.progress = label;
        const started = await arcade(endpoint, body, { node: n });
        for (;;) {
          await sleep(3000);
          const job = await arcade('jobs/get', { jobId: started.jobId }, { node: n, quiet: true });
          if (job.status === 'succeeded') return job;
          if (job.status === 'failed') throw new Error(job.error?.message || 'The job failed.');
        }
      },
    };
  }

  // ---------- running ----------
  async function execNode(n) {
    const def = NODES[n.type];
    Object.assign(n, { status: 'running', error: null, progress: 'Starting', calls: [], t0: Date.now() });
    refreshAll();
    const tick = setInterval(() => updateStamp(n), 1000);
    try {
      const inp = {};
      for (const p of def.inputs) {
        const vals = G.edgesIn(n, p.key).map((e) => G.node(e.from.node)?.out?.[e.from.port]).filter(Boolean);
        if (!vals.length && G.connected(n, p.key)) throw new Error(`The step before this one has no ${p.type === 'pattern' ? 'design' : p.type} to pass on. Run it again.`);
        inp[p.key] = p.multi ? vals : vals[0];
      }
      n.out = await def.run(n, inp, ctxFor(n));
      Object.assign(n, { status: 'ok', ms: Date.now() - n.t0, runId: uid('r') });
      n.sig = sigOf(n);
    } catch (e) {
      Object.assign(n, { status: 'error', error: { message: e.message, status: e.status || null }, ms: Date.now() - n.t0 });
    } finally {
      clearInterval(tick);
      n.progress = '';
    }
    reportRun(n);
    changed();
    return n.status === 'ok';
  }
  // Every finished step goes into the run history on the server, worked or not.
  function reportRun(n) {
    const def = NODES[n.type], o = (n.status === 'ok' && n.out) || {};
    const summary = o.product ? `${o.product.title}${o.product.unitPrice ? ' \u00b7 ' + money(o.product.unitPrice) : ''}` : o.pattern ? `Design, ${o.pattern.width} \u00d7 ${o.pattern.height}`
      : o.category ? `${o.category.name} (${o.category.world})` : o.checkout ? 'Checkout link created' : o.order ? (o.order.paid ? `Order ${o.order.orderNumber}: ${o.order.status}` : 'Not paid yet') : null;
    App.api('runs', { method: 'POST', body: { flowId: S.flow.id, flowName: S.flow.name, batchId: S.batch, nodeId: n.id, nodeType: n.type, title: def.title, endpoint: def.endpoint, world: G.worldOf(n),
      status: n.status, httpStatus: n.error?.status || null, error: n.error?.message || null, ms: n.ms, summary, startedAt: new Date(n.t0).toISOString() } }).catch(() => {});
  }
  async function confirmCheckout(n) {
    const products = G.edgesIn(n, 'product').map((e) => G.node(e.from.node)?.out?.[e.from.port]).filter(Boolean);
    return ask({ title: 'Create a real checkout?', ok: 'Create checkout',
      body: `<p>This makes a checkout on your Arcade account for:</p><ul>${products.map((p) => `<li>${esc(p.title)} × ${esc(n.cfg.quantity || 1)}${p.unitPrice ? ' · ' + esc(money(p.unitPrice)) + ' each' : ''}</li>`).join('') || '<li>the connected products</li>'}</ul><p>Nothing is charged until someone pays on Arcade’s page. The workbench never pays.</p>` });
  }
  // Run one step. Steps before it that have no result yet run first.
  async function runTo(id) {
    if (S.busy) return toast('A step is already running. Steps run one at a time.');
    const target = G.node(id);
    const plan = [];
    (function need(n) {
      for (const e of G.edgesIn(n)) { const src = G.node(e.from.node); if (src && !src.out && !plan.includes(src)) need(src); }
      if (!plan.includes(n)) plan.push(n);
    })(target);
    for (const n of plan) {
      const b = checks(n).find((i) => i.level === 'block');
      if (b) { select(n.id); return toast(`${NODES[n.type].title} can’t run. ${b.text}`); }
    }
    S.busy = true; S.batch = uid('b');
    try {
      for (const n of plan) {
        if (NODES[n.type].cost === 'checkout' && !(await confirmCheckout(n))) break;
        if (!(await execNode(n))) break;
      }
    } finally { S.busy = false; refreshAll(); }
  }
  // Run every step that has not worked yet, in order, one at a time. Checkouts are never included.
  async function runFlow() {
    if (S.busy) return toast('A step is already running. Steps run one at a time.');
    const todo = topo().filter((n) => statusOf(n) !== 'ok' && NODES[n.type].cost !== 'checkout');
    const set = new Set(), plan = [];
    for (const n of todo) {
      if (checks(n).some((i) => i.level === 'block')) continue;
      const fed = G.edgesIn(n).every((e) => { const src = G.node(e.from.node); return src && (set.has(src.id) || (src.out && !todo.includes(src))); });
      if (fed) { plan.push(n); set.add(n.id); }
    }
    if (!plan.length) return toast(todo.length ? 'Nothing can run yet. Open a step marked “Can’t run” to see why.' : 'Every step has already worked. Change one, or fork it, to run again.');
    const creates = plan.filter((n) => NODES[n.type].cost === 'create').length;
    const skipped = todo.length - plan.length;
    const go = await ask({ title: `Run ${plan.length} step${plan.length === 1 ? '' : 's'}?`, ok: 'Run',
      body: `<ul>${plan.map((n) => `<li>${esc(NODES[n.type].title)}${NODES[n.type].cost === 'create' ? ' · makes something new' : ''}</li>`).join('')}</ul>`
        + (creates ? `<p>${creates === 1 ? 'One of these makes' : creates + ' of these make'} something new on your Arcade account, about a minute each. They run one at a time.</p>` : '<p>These only read from Arcade. Nothing is created.</p>')
        + (skipped ? `<p>${skipped} step${skipped === 1 ? '' : 's'} can’t run and will be skipped.</p>` : '')
        + '<p>Checkout links are never part of Run flow.</p>' });
    if (!go) return;
    S.busy = true; S.batch = uid('b');
    const failed = new Set();
    try {
      for (const n of plan) {
        if (G.edgesIn(n).some((e) => failed.has(e.from.node))) { failed.add(n.id); continue; }
        if (!(await execNode(n))) failed.add(n.id);
      }
    } finally { S.busy = false; refreshAll(); }
    toast(failed.size ? `${plan.length - failed.size} worked, ${failed.size} did not. Open the failed step to see what Arcade said.` : `All ${plan.length} worked.`);
  }
  // Image links expire. Re-read a step's result by ID to renew them.
  async function renew(n) {
    try {
      if (n.out?.product) n.out.product = await readProduct(n.out.product.productId, n.out.product.quantity || 1, n.out.product.world);
      if (n.out?.pattern) n.out.pattern = await readPattern(n.out.pattern.patternId, n.out.pattern.world);
      updateNode(n); renderInspector(); save();
    } catch { /* the old result stays on screen */ }
  }

  // ---------- small UI helpers ----------
  const money = (p) => (p ? (p.currency === 'USD' ? '$' : '') + Number(p.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (p.currency === 'USD' ? '' : ' ' + p.currency) : '');
  function setHtml(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
  let toastTimer;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 4600); }
  // Resolves true for the main button, 'alt' for the optional second one, false for Cancel.
  function ask({ title, body, ok = 'Continue', alt = '' }) {
    return new Promise((resolve) => {
      const d = $('dlg');
      d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><div class="dlg-body">${body}</div><menu><button class="btn ghost" value="no">Cancel</button>${alt ? `<button class="btn ghost" value="alt">${esc(alt)}</button>` : ''}<button class="btn wire" value="yes">${esc(ok)}</button></menu></form>`;
      d.returnValue = 'no';
      d.onclose = () => resolve(d.returnValue === 'yes' ? true : d.returnValue === 'alt' ? 'alt' : false);
      d.showModal();
    });
  }
  async function pick(listEndpoint) {
    const r = await arcade(listEndpoint, { limit: 24 });
    const items = r.items || [];
    return new Promise((resolve) => {
      const d = $('dlg');
      d.innerHTML = `<form method="dialog"><h2>Choose from your account</h2><div class="dlg-body">${items.length ? 'Newest first.' : 'Nothing saved on this account yet.'}<div class="grid-pick">${items.map((it, i) =>
        `<button value="${i}"><img loading="lazy" src="${esc(it.thumbnailUrl || it.imageUrl || '')}" alt="">${esc((it.title || it.prompt || 'Untitled').slice(0, 44))}</button>`).join('')}</div></div><menu><button class="btn ghost" value="">Cancel</button></menu></form>`;
      d.returnValue = '';
      d.onclose = () => resolve(d.returnValue === '' ? null : items[Number(d.returnValue)]);
      d.showModal();
    });
  }

  // ---------- node rendering ----------
  function buildNode(n) {
    const def = NODES[n.type];
    const el = document.createElement('article');
    el.className = 'node';
    el.dataset.id = n.id;
    const port = (p, dir) => `<div class="port ${dir}" data-port="${p.key}" data-type="${p.type}"><i class="dot"></i><span>${esc(p.label)}</span>${p.optional ? '<em>optional</em>' : ''}</div>`;
    el.innerHTML = `
      <header class="n-head"><div><span class="n-ep">${esc(def.endpoint)}</span><h3>${esc(def.title)} <span class="n-world"></span></h3></div><span class="stamp"></span></header>
      <div class="n-ports"><div class="n-in">${def.inputs.map((p) => port(p, 'in')).join('')}</div><div class="n-out">${def.outputs.map((p) => port(p, 'out')).join('')}</div></div>
      <div class="n-fields"></div><div class="n-preview"></div><div class="n-verdict"></div>
      <footer class="n-foot"><button class="btn small run">Run</button><button class="btn ghost small fork" title="Copy this step and everything after it">Fork</button><button class="btn ghost small del">Remove</button></footer>`;
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    buildFields(n, el.querySelector('.n-fields'));
    return el;
  }
  function categorySelect(sel) {
    const cats = S.cat.categories;
    const by = (w) => cats.filter((c) => c.world === w).map((c) => `<option value="${esc(c.categoryId)}"${c.categoryId === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    return `<option value="">${cats.length ? 'Choose…' : 'No categories loaded'}</option><optgroup label="Jewelry">${by('jewelry')}</optgroup><optgroup label="Print">${by('print')}</optgroup>`;
  }
  function buildFields(n, box) {
    const def = NODES[n.type];
    box.innerHTML = '';
    let pair = null;
    for (const f of def.fields) {
      if (n.cfg[f.key] === undefined && f.default !== undefined) n.cfg[f.key] = f.default;
      const dynamic = f.kind === 'options' || f.kind === 'clusters' || f.kind === 'pick';
      const wrap = document.createElement(dynamic ? 'div' : 'label');
      wrap.dataset.field = f.key;
      if (f.printOnly) wrap.dataset.printOnly = '1';
      const note = f.printOnly ? '<span class="off-note" hidden>Not sent for jewelry.</span>' : '';
      const val = n.cfg[f.key];
      if (f.kind === 'textarea') wrap.innerHTML = `${esc(f.label)}<textarea maxlength="${f.max || 1000}" placeholder="${esc(f.placeholder || '')}">${esc(val || '')}</textarea>`;
      else if (f.kind === 'text') wrap.innerHTML = `${esc(f.label)}<input type="text" value="${esc(val || '')}" placeholder="${esc(f.placeholder || '')}">${note}`;
      else if (f.kind === 'number') wrap.innerHTML = `${esc(f.label)}<input type="number" value="${esc(val ?? '')}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}>`;
      else if (f.kind === 'check') { wrap.className = 'check'; wrap.innerHTML = `<input type="checkbox"${val ? ' checked' : ''}><span>${esc(f.label)}</span>`; }
      else if (f.kind === 'category') wrap.innerHTML = `${esc(f.label)}<select>${categorySelect(val)}</select>`;
      else if (f.kind === 'model') wrap.innerHTML = `${esc(f.label)}<select><option value="">Arcade picks</option>${S.cat.models.map((m) => `<option value="${esc(m.modelId)}"${m.modelId === val ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>${note}`;
      else if (f.kind === 'pick') {
        wrap.className = 'picked';
        wrap.innerHTML = `<span>${val ? esc(n.cfg.pickLabel || val) : 'Nothing chosen'}</span><button class="btn ghost small" type="button">Choose</button>`;
        wrap.querySelector('button').onclick = async () => {
          try {
            const it = await pick(f.list);
            if (!it) return;
            n.cfg[f.key] = it[f.idKey];
            n.cfg.pickLabel = (it.title || it.prompt || it[f.idKey]).slice(0, 60);
            wrap.querySelector('span').textContent = n.cfg.pickLabel;
            changed();
            runTo(n.id);
          } catch (e) { toast(e.message); }
        };
      }
      const input = dynamic ? null : wrap.querySelector('textarea, input, select');
      if (input) {
        const read = () => {
          n.cfg[f.key] = input.type === 'checkbox' ? input.checked : input.value;
          if (f.kind === 'category') n.cfg.categoryName = S.cat.categories.find((c) => c.categoryId === input.value)?.name || '';
          changed();
        };
        input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', read);
      }
      if (f.kind === 'number') {
        if (!pair || pair.children.length >= 2) { pair = document.createElement('div'); pair.className = 'pair'; box.appendChild(pair); }
        pair.appendChild(wrap);
      } else { pair = null; box.appendChild(wrap); }
      if (f.assist) box.appendChild(assistRow(n, f, wrap));
    }
  }
  // Two helpers under a prompt: pick one from the library, or ask a connected model for ideas.
  function assistRow(n, f, wrap) {
    const row = document.createElement('div');
    row.className = 'assist';
    row.innerHTML = '<button type="button" data-tab="lib">From library</button><button type="button" data-tab="ai">Suggest</button>';
    row.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const src = G.source(n, 'category'), cat = src?.node.out?.category, categoryId = src?.node.cfg.categoryId;
      const metals = cat && (cat.options.find((o) => /material|metal/i.test(o.key + o.label)) || cat.options[0]);
      App.promptDialog({ tab: b.dataset.tab, world: G.worldOf(n), categoryId, categoryName: S.cat.categories.find((c) => c.categoryId === categoryId)?.name,
        materials: metals ? metals.values.filter((v) => v.available).map((v) => v.label) : undefined,
        onUse: (text) => { n.cfg[f.key] = text; wrap.querySelector('textarea').value = text; changed(); } });
    };
    return row;
  }
  // Options come from the Category step feeding this one, once it has run.
  function renderOptions(n, box) {
    const cat = G.source(n, 'category')?.node.out?.category;
    const sig = cat ? cat.categoryId + JSON.stringify(n.cfg.selections || {}) : 'none';
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    if (!cat) { box.innerHTML = '<p class="hint">Arcade picks the options. Run the Category step to choose them yourself.</p>'; return; }
    const chosen = n.cfg.selections || {};
    box.innerHTML = cat.options.map((o) => `<label style="margin-bottom:6px">${esc(o.label)}<select data-opt="${esc(o.key)}"><option value="">Arcade picks</option>${o.values.map((v) =>
      `<option value="${esc(v.value)}"${chosen[o.key] === v.value ? ' selected' : ''}${v.available ? '' : ' disabled'}>${esc(v.label)}${v.available ? '' : ' (can’t be made)'}</option>`).join('')}</select></label>`).join('')
      || '<p class="hint">This category has no options.</p>';
    box.querySelectorAll('select').forEach((s) => {
      s.onchange = () => {
        const next = { ...(n.cfg.selections || {}) };
        if (s.value) next[s.dataset.opt] = s.value; else delete next[s.dataset.opt];
        n.cfg.selections = next;
        changed();
      };
    });
  }
  // Recolor needs the design's main colors, which only exist once the step before it has run.
  function renderClusters(n, box) {
    const pat = G.source(n, 'pattern')?.node.out?.pattern;
    const loaded = pat && n.cfg.clustersFor === pat.patternId && n.cfg.clusters?.length;
    const sig = `${pat?.patternId || 'none'}|${loaded ? n.cfg.clusters.length : 0}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    if (!pat) { box.innerHTML = '<p class="hint">Run the step before this one, then load its colors.</p>'; return; }
    if (!loaded) {
      box.innerHTML = '<button class="btn ghost small" type="button">Load this design’s colors</button>';
      box.querySelector('button').onclick = async () => {
        try {
          const r = await arcade('patterns/refine/recolorClusters', { requestId: uid('clusters'), patternId: pat.patternId }, { node: n });
          n.cfg.clusters = (r.clusters || []).map((c) => ({ clusterId: c.clusterId, color: c.color, to: c.color }));
          n.cfg.clustersFor = pat.patternId;
          changed();
        } catch (e) { toast(e.message); }
      };
      return;
    }
    box.innerHTML = `<div class="swatches">${n.cfg.clusters.map((c, i) => `<div><i style="background:${esc(c.color)}"></i>${esc(c.color)} → <input type="color" value="${esc(c.to)}" data-i="${i}" aria-label="Replacement for ${esc(c.color)}"></div>`).join('')}</div>`;
    box.querySelectorAll('input').forEach((inp) => { inp.oninput = () => { n.cfg.clusters[Number(inp.dataset.i)].to = inp.value; changed(); }; });
  }
  function previewHtml(n) {
    const o = n.out;
    if (!o) return '';
    if (o.product) {
      const p = o.product;
      return `<div class="pv"><img src="${esc(p.imageUrl)}" alt=""><div><span class="price">${esc(money(p.unitPrice) || 'Price pending')}</span><span class="title">${esc(p.title)}</span><span class="muted">${esc(p.maker)}${p.quantity > 1 ? ' · each at qty ' + p.quantity : ''}</span></div></div>`;
    }
    if (o.pattern) return `<div class="pv"><img src="${esc(o.pattern.thumbnailUrl || o.pattern.imageUrl)}" alt=""><div><span class="title">Design ready</span><span class="muted">${o.pattern.width} × ${o.pattern.height}</span></div></div>`;
    if (o.category) {
      const c = o.category;
      const opts = c.options.slice(0, 3).map((x) => {
        const yes = x.values.filter((v) => v.available), no = x.values.filter((v) => !v.available);
        return `<span><b>${esc(x.label)}:</b> ${yes.slice(0, 6).map((v) => esc(v.label)).join(', ')}${yes.length > 6 ? ` +${yes.length - 6} more` : ''}${no.length ? ` <span class="no">${no.length} can’t be made</span>` : ''}</span>`;
      }).join('');
      return `<div class="pv-text">${opts || '<span>No options.</span>'}${c.options.length > 3 ? `<span class="muted">+${c.options.length - 3} more options in the details.</span>` : ''}</div>`;
    }
    if (o.checkout) return `<div class="pv-text"><span><a href="${esc(o.checkout.checkoutUrl)}" target="_blank" rel="noopener">Open Arcade’s checkout page</a></span><span class="mono">checkout ${esc(o.checkout.checkoutId)}</span></div>`;
    if (o.order) return `<div class="pv-text"><span>${o.order.paid ? `Order ${esc(o.order.orderNumber)}: <b>${esc(o.order.status)}</b>, ${esc(money(o.order.total))}` : 'No order yet. The checkout has not been paid.'}</span></div>`;
    return '';
  }
  function verdictHtml(n, st) {
    const out = [];
    if (st === 'running') out.push(`<p>${esc(n.progress || 'Working')}…</p>`);
    else if (st === 'error') out.push(`<p class="v-bad">${esc(n.error.message)}</p>`);
    else if (st === 'blocked' || st === 'waiting') {
      const w = whyNot(n);
      out.push(`<p class="v-block">${esc(w.text)}</p>`);
      if (w.more) out.push(`<p class="muted">${w.more} more in the details.</p>`);
    } else if (st === 'stale') out.push('<p>Changed since the last run. The result shown is the old one.</p>');
    else if (st === 'ready') out.push(`<p>${COST[NODES[n.type].cost]}</p>`);
    if (st !== 'running') for (const i of checks(n).filter((x) => x.level === 'warn')) out.push(`<p class="v-warn">${esc(i.text)}</p>`);
    return out.join('');
  }
  function updateStamp(n) { const el = els.get(n.id); if (el) setHtml(el.querySelector('.stamp'), esc(stampText(n, statusOf(n)))); }
  function updateNode(n) {
    const el = els.get(n.id);
    if (!el) return;
    const def = NODES[n.type], st = statusOf(n), world = G.worldOf(n);
    el.dataset.status = st;
    el.classList.toggle('sel', S.sel === n.id);
    setHtml(el.querySelector('.stamp'), esc(stampText(n, st)));
    setHtml(el.querySelector('.n-world'), world ? `<span class="tag ${world}">${world}</span>` : '');
    el.querySelectorAll('[data-print-only]').forEach((w) => {
      const off = world === 'jewelry';
      w.querySelectorAll('input, select').forEach((i) => { i.disabled = off; });
      w.querySelector('.off-note').hidden = !off;
    });
    for (const f of def.fields) {
      const box = el.querySelector(`[data-field="${f.key}"]`);
      if (f.kind === 'options') renderOptions(n, box);
      if (f.kind === 'clusters') renderClusters(n, box);
    }
    for (const o of def.outputs) el.querySelector(`.port.out[data-port="${o.key}"]`).classList.toggle('off', Boolean(o.when) && !o.when(n, G));
    el.querySelectorAll('.port').forEach((p) => {
      const dir = p.classList.contains('in') ? 'to' : 'from';
      p.classList.toggle('linked', S.flow.edges.some((e) => e[dir].node === n.id && e[dir].port === p.dataset.port));
    });
    setHtml(el.querySelector('.n-preview'), previewHtml(n));
    setHtml(el.querySelector('.n-verdict'), verdictHtml(n, st));
    const run = el.querySelector('.run');
    run.disabled = S.busy;
    run.textContent = st === 'running' ? 'Running' : n.out ? 'Run again' : 'Run';
  }
  function mount(n) { const el = buildNode(n); $('world').appendChild(el); els.set(n.id, el); }
  function mountAll() { for (const el of els.values()) el.remove(); els.clear(); S.flow.nodes.forEach(mount); }

  // ---------- wires ----------
  function portPos(nodeId, key, dir) {
    const dot = els.get(nodeId)?.querySelector(`.port.${dir}[data-port="${key}"] .dot`);
    if (!dot) return null;
    const r = dot.getBoundingClientRect(), w = $('world').getBoundingClientRect();
    return { x: (r.left + r.width / 2 - w.left) / S.view.k, y: (r.top + r.height / 2 - w.top) / S.view.k };
  }
  const curve = (a, b) => { const dx = Math.max(50, Math.abs(b.x - a.x) * 0.5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };
  function drawEdges() {
    let html = '';
    for (const e of S.flow.edges) {
      const a = portPos(e.from.node, e.from.port, 'out'), b = portPos(e.to.node, e.to.port, 'in');
      if (!a || !b) continue;
      const src = G.node(e.from.node), dst = G.node(e.to.node);
      const dstStatus = statusOf(dst);
      const cls = dst.status === 'running' ? 'flowing' : dstStatus === 'blocked' ? 'blocked' : src.out?.[e.from.port] ? 'done' : '';
      const d = curve(a, b), sel = S.selEdge === e.id;
      html += `<g class="edge ${cls}${sel ? ' sel' : ''}" data-id="${e.id}"><path class="hit" d="${d}"></path><path class="line" d="${d}"></path>${sel
        ? `<g class="cut-btn" data-cut="${e.id}" transform="translate(${(a.x + b.x) / 2},${(a.y + b.y) / 2})"><circle r="10"></circle><path d="M-4,-4 L4,4 M4,-4 L-4,4"></path></g>` : ''}</g>`;
    }
    $('edges').innerHTML = html;
  }
  function isUpstream(maybeAncestorId, ofId) {
    const seen = new Set(), stack = [ofId];
    while (stack.length) {
      const id = stack.pop();
      if (id === maybeAncestorId) return true;
      for (const e of S.flow.edges) if (e.to.node === id && !seen.has(e.from.node)) { seen.add(e.from.node); stack.push(e.from.node); }
    }
    return false;
  }
  function connect(from, to) {
    const sn = G.node(from.node), tn = G.node(to.node);
    if (sn.id === tn.id) return toast('A step can’t feed itself.');
    const so = NODES[sn.type].outputs.find((o) => o.key === from.port), ti = NODES[tn.type].inputs.find((i) => i.key === to.port);
    if (!so || !ti) return;
    if (so.type !== ti.type) return toast(`A ${so.label.toLowerCase()} can’t plug into a ${ti.label.toLowerCase()} input.`);
    if (isUpstream(tn.id, sn.id)) return toast('That would make a loop.');
    if (S.flow.edges.some((e) => e.from.node === sn.id && e.from.port === so.key && e.to.node === tn.id && e.to.port === ti.key)) return;
    if (!ti.multi) S.flow.edges = S.flow.edges.filter((e) => !(e.to.node === tn.id && e.to.port === ti.key));
    S.flow.edges.push({ id: uid('e'), from, to });
    changed();
    const why = checks(tn).find((i) => i.level === 'block');
    if (why) toast(`Connected, but ${NODES[tn.type].title} can’t run. ${why.text}`);
  }

  // ---------- flow edits ----------
  function addNode(type, pos) {
    const c = $('canvas').getBoundingClientRect();
    let p = pos || { x: (c.width / 2 - S.view.x) / S.view.k - NODE_W / 2, y: (c.height / 4 - S.view.y) / S.view.k };
    while (S.flow.nodes.some((n) => Math.abs(n.x - p.x) < 20 && Math.abs(n.y - p.y) < 20)) p = { x: p.x + 28, y: p.y + 28 };
    const n = { id: uid('n'), type, x: Math.round(p.x), y: Math.round(p.y), cfg: {}, status: 'idle', out: null };
    S.flow.nodes.push(n);
    mount(n);
    select(n.id);
    changed();
  }
  function removeNode(id) {
    const n = G.node(id);
    if (!n) return;
    if (n.status === 'running') return toast('Wait for this step to finish before removing it.');
    S.flow.nodes = S.flow.nodes.filter((x) => x.id !== id);
    S.flow.edges = S.flow.edges.filter((e) => e.from.node !== id && e.to.node !== id);
    els.get(id)?.remove(); els.delete(id);
    if (S.sel === id) S.sel = null;
    changed();
  }
  // Fork: copy this step and everything after it, fed by the same steps as the original.
  function fork(id) {
    const root = G.node(id);
    const set = [root, ...descendants(root)];
    const ids = new Set(set.map((n) => n.id));
    const box = (n) => ({ x0: n.x, x1: n.x + NODE_W, y0: n.y, y1: n.y + (els.get(n.id)?.offsetHeight || 300) });
    const mine = set.map(box);
    const x0 = Math.min(...mine.map((b) => b.x0)), x1 = Math.max(...mine.map((b) => b.x1)), y0 = Math.min(...mine.map((b) => b.y0));
    const floor = Math.max(...S.flow.nodes.map(box).filter((b) => b.x1 > x0 - 20 && b.x0 < x1 + 20).map((b) => b.y1));
    const dy = floor - y0 + 44;
    const map = new Map();
    for (const n of set) {
      const copy = { id: uid('n'), type: n.type, x: n.x, y: Math.round(n.y + dy), cfg: structuredClone(n.cfg), status: 'idle', out: null };
      map.set(n.id, copy.id);
      S.flow.nodes.push(copy);
      mount(copy);
    }
    for (const e of [...S.flow.edges]) {
      if (ids.has(e.to.node)) S.flow.edges.push({ id: uid('e'), from: { node: map.get(e.from.node) || e.from.node, port: e.from.port }, to: { node: map.get(e.to.node), port: e.to.port } });
    }
    select(map.get(id));
    changed();
    els.get(map.get(id))?.scrollIntoView?.({ block: 'nearest' });
    toast(`Forked ${set.length} step${set.length === 1 ? '' : 's'}. Change the copy and run it to compare.`);
  }
  function select(id) {
    if (S.sel === id && !S.selEdge) return;
    S.sel = id; S.selEdge = null;
    for (const [nid, el] of els) el.classList.toggle('sel', nid === id);
    drawEdges();
    renderInspector();
  }

  // ---------- inspector ----------
  function resultHtml(n) {
    const o = n.out;
    if (!o) return '<p class="muted">Nothing yet. Run this step to see what Arcade returns.</p>';
    let h = '';
    if (o.product) {
      const p = o.product;
      const tiers = p.volumeDiscounts?.tiers?.length ? p.volumeDiscounts.tiers.map((t) => `${t.discountPercent}% from ${money({ amount: t.minimumSpend, currency: p.volumeDiscounts.currency })}`).join(', ') : 'None';
      h += `<img class="i-img" src="${esc(p.imageUrl)}" alt="${esc(p.title)}">`;
      if (p.images.length > 1) h += `<div class="i-imgs">${p.images.slice(1).map((u) => `<img class="i-img" src="${esc(u)}" alt="">`).join('')}</div>`;
      h += `<dl class="facts"><dt>Unit price</dt><dd><span class="big">${esc(money(p.unitPrice) || 'Pending')}</span>${p.quantity > 1 && p.unitPrice ? ` <span class="muted">× ${p.quantity} = ${esc(money({ amount: Number(p.unitPrice.amount) * p.quantity, currency: p.unitPrice.currency }))}</span>` : ''}</dd>
        <dt>Title</dt><dd>${esc(p.title)}</dd><dt>Options</dt><dd>${esc(p.selectionLabel || '')}</dd><dt>Maker</dt><dd>${esc(p.maker)}</dd>
        <dt>Volume discounts</dt><dd>${esc(tiers)}</dd><dt>Images</dt><dd>${p.images.length} from Arcade</dd>
        ${p.description ? `<dt>Details</dt><dd>${esc(p.description)}</dd>` : ''}
        <dt>productId</dt><dd class="mono">${esc(p.productId)}</dd></dl>`;
    }
    if (o.pattern) {
      const p = o.pattern;
      if (!o.product) h += `<img class="i-img" src="${esc(p.imageUrl)}" alt="Design">`;
      h += `<dl class="facts"><dt>Size</dt><dd>${p.width} × ${p.height}</dd>${p.prompt ? `<dt>Prompt</dt><dd>${esc(p.prompt)}</dd>` : ''}<dt>patternId</dt><dd class="mono">${esc(p.patternId)}</dd></dl>`;
    }
    if (o.category) {
      const c = o.category;
      h += `<dl class="facts"><dt>Category</dt><dd>${esc(c.name)} <span class="tag ${c.world}">${c.world}</span></dd>${c.options.map((x) =>
        `<dt>${esc(x.label)}</dt><dd>${x.values.map((v) => (v.available ? esc(v.label) : `<s class="muted">${esc(v.label)}</s>`)).join(', ')}</dd>`).join('')}</dl>
        <p class="muted" style="margin-top:8px">Struck-through values can’t be made right now.</p>`;
    }
    if (o.checkout) h += `<p><a href="${esc(o.checkout.checkoutUrl)}" target="_blank" rel="noopener">Open Arcade’s checkout page</a></p><dl class="facts"><dt>checkoutId</dt><dd class="mono">${esc(o.checkout.checkoutId)}</dd></dl>`;
    if (o.order) h += `<p>${o.order.paid ? `Order ${esc(o.order.orderNumber)}: ${esc(o.order.status)}, ${esc(money(o.order.total))}.` : 'No order yet. The checkout has not been paid.'}</p>`;
    return h;
  }
  const callsHtml = (calls) => calls.slice().reverse().map((c) =>
    `<details class="call"><summary><b class="${c.status >= 200 && c.status < 300 ? 's-ok' : 's-bad'}">${c.status}</b><span class="mono">${esc(c.endpoint)}</span><span class="muted">${c.ms}ms${c.body && typeof c.body.status === 'string' ? ' · ' + esc(c.body.status) : ''}</span></summary><pre>${esc('REQUEST\n' + JSON.stringify(c.req, null, 2) + '\n\nRESPONSE\n' + JSON.stringify(c.body, null, 2))}</pre></details>`).join('');
  function renderInspector() {
    const n = S.sel && G.node(S.sel);
    let h;
    if (n) {
      const def = NODES[n.type], st = statusOf(n), items = checks(n), w = whyNot(n);
      const checkList = [
        ...items.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`),
        ...(w && !w.self ? [`<li class="block">${esc(w.text)}</li>`] : []),
        ...(n.status === 'error' ? [`<li class="block">Arcade said: ${esc(n.error.message)}</li>`] : []),
      ];
      h = `<div class="i-top"><div><span class="mono muted">${esc(def.endpoint)}</span><h2>${esc(def.title)}</h2></div><span class="stamp" data-status="${st}">${esc(stampText(n, st, false))}</span></div>
        <p class="lede">${esc(def.blurb)}</p>
        <p>${def.worlds.map((x) => `<span class="tag ${x}">${x}</span>`).join(' ')} ${def.cost === 'read' ? '<span class="tag read">read only</span>' : ''}</p>
        <h3>Can it run?</h3><ul class="rules">${checkList.join('') || '<li class="fine">Yes. Nothing stops this step.</li>'}</ul>
        <h3>Result</h3>${resultHtml(n)}
        ${def.rules.length ? `<h3>How Arcade treats this step</h3><ul class="rules">${def.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        <h3>API calls</h3>${n.calls?.length ? callsHtml(n.calls) : '<p class="muted">None this session.</p>'}`;
    } else {
      const order = topo();
      h = `<h2>Flow check</h2><p class="lede">Every step is checked against Arcade’s rules before anything runs.</p>
        <div class="checklist">${order.map((x) => { const st = statusOf(x), w = whyNot(x); return `<button data-go="${x.id}"><b>${esc(NODES[x.type].title)}</b><span class="stamp" data-status="${st}">${esc(stampText(x, st, false))}</span>${w ? `<span class="why">${esc(w.text)}</span>` : x.status === 'error' ? `<span class="why">${esc(x.error.message)}</span>` : ''}</button>`; }).join('') || '<p class="muted">No steps yet.</p>'}</div>
        <h3>Recent API calls</h3>${S.log.length ? callsHtml(S.log.slice(-14)) : '<p class="muted">None yet.</p>'}`;
    }
    const box = $('inspector');
    if (box._html === h) return;
    const open = [...box.querySelectorAll('details')].map((d) => d.open);
    box.innerHTML = h; box._html = h;
    if (open.some(Boolean)) { const ds = [...box.querySelectorAll('details')]; const shift = ds.length - open.length; open.forEach((o, i) => { if (o && ds[i + shift]) ds[i + shift].open = true; }); }
  }
  function renderTally() {
    const c = { ready: 0, blocked: 0, ok: 0, error: 0, running: 0 };
    for (const n of S.flow.nodes) { const st = statusOf(n); c[st === 'waiting' ? 'blocked' : st === 'stale' ? 'ok' : st]++; }
    $('tally').innerHTML = `<i>${S.flow.nodes.length} steps</i>${c.ready ? `<i>${c.ready} ready</i>` : ''}${c.blocked ? `<i class="t-hold">${c.blocked} can’t run</i>` : ''}${c.ok ? `<i class="t-ok">${c.ok} worked</i>` : ''}${c.error ? `<i class="t-bad">${c.error} failed</i>` : ''}`;
    $('empty').hidden = S.flow.nodes.length > 0;
    $('btnRunFlow').disabled = S.busy;
  }
  function refreshAll() { S.flow.nodes.forEach(updateNode); drawEdges(); renderInspector(); renderTally(); }

  // ---------- saving ----------
  let saveTimer, saveWarned = false;
  const snapshot = () => ({ nodes: S.flow.nodes.map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, cfg: n.cfg, status: n.status === 'running' ? 'idle' : n.status, out: n.out || null,
    error: n.error || null, ms: n.ms ?? null, runId: n.runId || null, sig: n.sig || null })), edges: S.flow.edges, view: S.view });
  // Flows are saved to the signed-in person's account on the server.
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!S.flow.id) return;
    const id = S.flow.id, name = S.flow.name || 'Untitled flow';
    try {
      await App.api('flows/' + id, { method: 'PUT', body: { name, data: snapshot() } });
      saveWarned = false;
      const known = S.flows.find((f) => f.id === id);
      if (!known) { S.flows.unshift({ id, name }); renderFlowMenu(); } else if (known.name !== name) { known.name = name; renderFlowMenu(); }
    } catch (e) {
      if (!saveWarned && e.message !== 'Signed out.') { saveWarned = true; toast(`This flow could not be saved. ${e.message}`); }
    }
  }
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); }
  function renderFlowMenu() {
    const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
    $('templates').innerHTML = '<option value="">Flows and templates\u2026</option>'
      + (S.flows.length ? `<optgroup label="Your flows">${S.flows.map((f) => opt('open:' + f.id, f.id === S.flow.id ? `${f.name} (open)` : f.name)).join('')}</optgroup>` : '')
      + `<optgroup label="New from a template">${TEMPLATES.map((t) => opt('tpl:' + t.id, t.name)).join('')}</optgroup>`
      + `<optgroup label="This flow">${opt('blank', 'New blank flow')}${opt('dup', 'Duplicate this flow')}${opt('del', 'Delete this flow')}</optgroup>`;
  }
  async function openFlow(id) {
    const f = await App.api('flows/' + id);
    if (f.data.view) S.view = f.data.view;
    setFlow({ id: f.id, name: f.name, nodes: f.data.nodes, edges: f.data.edges }, { keepView: Boolean(f.data.view) });
    applyView();
    renewed.clear(); // an image link that has expired is renewed when it fails to load, one step at a time
  }
  function changed() { save(); refreshAll(); }
  function resolveNames() {
    for (const n of S.flow.nodes) {
      if (n.type !== 'category' || !S.cat.categories.length) continue;
      const known = S.cat.categories.some((c) => c.categoryId === n.cfg.categoryId);
      if (!known && n.cfg.categoryName) n.cfg.categoryId = S.cat.categories.find((c) => c.name === n.cfg.categoryName)?.categoryId || '';
    }
  }
  function setFlow(flow, { keepView = false } = {}) {
    S.flow = { id: flow.id || uid('f'), name: flow.name || 'Untitled flow', nodes: flow.nodes.filter((n) => NODES[n.type]), edges: flow.edges };
    const ids = new Set(S.flow.nodes.map((n) => n.id));
    S.flow.edges = S.flow.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node));
    S.sel = null; S.selEdge = null;
    $('flowName').value = S.flow.name;
    resolveNames();
    mountAll();
    refreshAll();
    try { localStorage.setItem(LAST, S.flow.id); } catch { /* fine without it */ }
    if (!keepView) { if (App.view === 'bench') fit(); else S.needFit = true; }
    renderFlowMenu();
    save();
  }
  // Put another flow under what is already on the bench, so flows can be compared side by side.
  function appendFlow(flow) {
    const bottoms = S.flow.nodes.map((n) => n.y + (els.get(n.id)?.offsetHeight || 300));
    const dy = (bottoms.length ? Math.max(...bottoms) + 90 : 0) - Math.min(...flow.nodes.map((n) => n.y));
    const dx = (S.flow.nodes.length ? Math.min(...S.flow.nodes.map((n) => n.x)) : 40) - Math.min(...flow.nodes.map((n) => n.x));
    for (const n of flow.nodes) { n.x += dx; n.y += dy; S.flow.nodes.push(n); }
    S.flow.edges.push(...flow.edges);
    resolveNames();
    flow.nodes.forEach(mount);
    changed();
    fit();
  }
  function fromTemplate(t) {
    const map = new Map(t.nodes.map((n) => [n.id, uid('n')]));
    return { name: t.name, nodes: t.nodes.map((n) => ({ id: map.get(n.id), type: n.type, x: n.x, y: n.y, cfg: structuredClone(n.cfg), status: 'idle', out: null })),
      edges: t.edges.map(([a, ap, b, bp]) => ({ id: uid('e'), from: { node: map.get(a), port: ap }, to: { node: map.get(b), port: bp } })) };
  }
  function exportFlow() {
    const data = { app: 'arcade-workbench', version: 1, name: S.flow.name, nodes: S.flow.nodes.map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, cfg: n.cfg })), edges: S.flow.edges };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = (S.flow.name || 'flow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.flow.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importFlow(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('missing steps or wires');
      setFlow({ name: data.name, nodes: data.nodes.map((n) => ({ id: String(n.id), type: n.type, x: Number(n.x) || 0, y: Number(n.y) || 0, cfg: n.cfg || {}, status: 'idle', out: null })),
        edges: data.edges.filter((e) => e?.from?.node && e?.to?.node).map((e) => ({ id: uid('e'), from: { node: String(e.from.node), port: e.from.port }, to: { node: String(e.to.node), port: e.to.port } })) });
      toast(`Imported “${S.flow.name}”. Results are not part of a flow file, so run it to fill it in.`);
    } catch (e) { toast(`That file is not a workbench flow: ${e.message}`); }
  }

  // ---------- view ----------
  function applyView() {
    const { x, y, k } = S.view;
    $('world').style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    const c = $('canvas');
    c.style.backgroundPosition = `${x}px ${y}px`;
    c.style.backgroundSize = `${24 * k}px ${24 * k}px`;
    $('zoomLabel').textContent = Math.round(k * 100) + '%';
  }
  function zoomAt(cx, cy, factor) {
    const c = $('canvas').getBoundingClientRect();
    const px = cx - c.left, py = cy - c.top, k = clamp(S.view.k * factor, 0.3, 1.6);
    const wx = (px - S.view.x) / S.view.k, wy = (py - S.view.y) / S.view.k;
    S.view = { k, x: px - wx * k, y: py - wy * k };
    applyView(); save();
  }
  function fit() {
    if (!S.flow.nodes.length) { S.view = { x: 30, y: 24, k: 1 }; return applyView(); }
    const c = $('canvas').getBoundingClientRect();
    const xs = S.flow.nodes.map((n) => [n.x, n.x + NODE_W]).flat(), ys = S.flow.nodes.map((n) => [n.y, n.y + (els.get(n.id)?.offsetHeight || 300)]).flat();
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const k = clamp(Math.min((c.width - 60) / w, (c.height - 60) / h), 0.5, 1);
    S.view = { k, x: Math.max(24, (c.width - w * k) / 2) - Math.min(...xs) * k, y: Math.max(24, (c.height - h * k) / 2) - Math.min(...ys) * k };
    applyView(); save();
  }

  // ---------- pointer: pan, drag a step, pull a wire ----------
  function wire() {
    const canvas = $('canvas'), world = $('world');
    const toWorld = (e) => { const w = world.getBoundingClientRect(); return { x: (e.clientX - w.left) / S.view.k, y: (e.clientY - w.top) / S.view.k }; };
    let raf = 0;
    const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawEdges(); }); };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const nodeEl = e.target.closest('.node'), port = e.target.closest('.port.out');
      if (nodeEl && port) return pullWire(e, nodeEl.dataset.id, port);
      if (nodeEl) { select(nodeEl.dataset.id); if (e.target.closest('.n-head')) dragNode(e, nodeEl); return; }
      if (e.target.closest('.zoom, .banner, .edge')) return;
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      S.selEdge = null; select(null);
      pan(e);
    });
    function track(e, move, done) {
      const mv = (ev) => move(ev), up = (ev) => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); done && done(ev); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      e.preventDefault();
    }
    function pan(e) {
      const sx = e.clientX, sy = e.clientY, v = { ...S.view };
      canvas.classList.add('panning');
      track(e, (ev) => { S.view = { ...v, x: v.x + ev.clientX - sx, y: v.y + ev.clientY - sy }; applyView(); }, () => { canvas.classList.remove('panning'); save(); });
    }
    function dragNode(e, el) {
      const n = G.node(el.dataset.id), sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
      track(e, (ev) => {
        n.x = Math.round(ox + (ev.clientX - sx) / S.view.k); n.y = Math.round(oy + (ev.clientY - sy) / S.view.k);
        el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
        redraw();
      }, save);
    }
    function pullWire(e, nodeId, port) {
      const key = port.dataset.port, type = port.dataset.type, a = portPos(nodeId, key, 'out'), temp = $('wire-temp');
      if (port.classList.contains('off')) { const o = NODES[G.node(nodeId).type].outputs.find((x) => x.key === key); return toast(o.whyNot); }
      canvas.classList.add('wiring');
      document.querySelectorAll('.port.in').forEach((p) => { const ok = p.dataset.type === type && p.closest('.node').dataset.id !== nodeId; p.classList.toggle('can', ok); p.classList.toggle('cant', !ok); });
      temp.hidden = false;
      track(e, (ev) => { temp.setAttribute('d', curve(a, toWorld(ev))); }, (ev) => {
        temp.hidden = true; temp.setAttribute('d', '');
        canvas.classList.remove('wiring');
        document.querySelectorAll('.port.in').forEach((p) => p.classList.remove('can', 'cant'));
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetNode = under?.closest('.node');
        if (!targetNode || targetNode.dataset.id === nodeId) return;
        // Dropping on a port uses that port; dropping anywhere else on a step uses its first matching input.
        const inPort = under.closest('.port.in') || [...targetNode.querySelectorAll('.port.in')].find((p) => p.dataset.type === type);
        if (!inPort) return toast(`${NODES[G.node(targetNode.dataset.id).type].title} has no ${type === 'pattern' ? 'design' : type} input.`);
        connect({ node: nodeId, port: key }, { node: targetNode.dataset.id, port: inPort.dataset.port });
      });
    }

    canvas.addEventListener('wheel', (e) => {
      const scroller = e.target.closest('textarea');
      if (scroller && scroller.scrollHeight > scroller.clientHeight && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      else { S.view = { ...S.view, x: S.view.x - e.deltaX, y: S.view.y - e.deltaY }; applyView(); save(); }
    }, { passive: false });

    world.addEventListener('click', (e) => {
      const cut = e.target.closest('[data-cut]');
      if (cut) { S.flow.edges = S.flow.edges.filter((x) => x.id !== cut.dataset.cut); S.selEdge = null; return changed(); }
      const edge = e.target.closest('.edge');
      if (edge) { S.sel = null; S.selEdge = edge.dataset.id; for (const el of els.values()) el.classList.remove('sel'); drawEdges(); return renderInspector(); }
      const btn = e.target.closest('.n-foot button'), nodeEl = e.target.closest('.node');
      if (!btn || !nodeEl) return;
      if (btn.classList.contains('run')) runTo(nodeEl.dataset.id);
      else if (btn.classList.contains('fork')) fork(nodeEl.dataset.id);
      else if (btn.classList.contains('del')) removeNode(nodeEl.dataset.id);
    });
    // An expired image link fails to load: renew that step's result once.
    world.addEventListener('error', (e) => {
      const id = e.target.tagName === 'IMG' && e.target.closest('.node')?.dataset.id;
      if (!id || renewed.has(id) || !S.cat.hasKey) return;
      renewed.add(id);
      renew(G.node(id));
    }, true);

    canvas.addEventListener('dragover', (e) => e.preventDefault());
    canvas.addEventListener('drop', (e) => {
      const type = e.dataTransfer.getData('text/plain');
      if (!NODES[type]) return;
      e.preventDefault();
      const p = toWorld(e);
      addNode(type, { x: p.x - NODE_W / 2, y: p.y - 20 });
    });

    window.addEventListener('keydown', (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || $('dlg').open) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (S.selEdge) { S.flow.edges = S.flow.edges.filter((x) => x.id !== S.selEdge); S.selEdge = null; changed(); }
        else if (S.sel) removeNode(S.sel);
      }
      if (e.key === 'Escape') { S.selEdge = null; select(null); drawEdges(); }
    });
    window.addEventListener('resize', redraw);

    $('zoomIn').onclick = () => { const c = canvas.getBoundingClientRect(); zoomAt(c.left + c.width / 2, c.top + c.height / 2, 1.2); };
    $('zoomOut').onclick = () => { const c = canvas.getBoundingClientRect(); zoomAt(c.left + c.width / 2, c.top + c.height / 2, 1 / 1.2); };
    $('zoomFit').onclick = fit;
    $('btnRunFlow').onclick = runFlow;
    $('btnExport').onclick = exportFlow;
    $('btnImport').onclick = () => $('importFile').click();
    $('importFile').onchange = (e) => { const f = e.target.files[0]; if (f) importFlow(f); e.target.value = ''; };
    $('flowName').oninput = (e) => { S.flow.name = e.target.value; save(); };
    $('inspector').addEventListener('click', (e) => { const go = e.target.closest('[data-go]'); if (go) select(go.dataset.go); });
    $('templates').onchange = async (e) => {
      const v = e.target.value;
      e.target.value = '';
      if (!v) return;
      try {
        if (v.startsWith('open:')) { await saveNow(); return await openFlow(v.slice(5)); }
        if (v.startsWith('tpl:')) {
          const next = fromTemplate(TEMPLATES.find((t) => t.id === v.slice(4)));
          if (!S.flow.nodes.length) return setFlow({ ...next, id: S.flow.id });
          const how = await ask({ title: 'Start a new flow, or add to this one?', ok: 'New flow', alt: 'Add below',
            body: '<p>A new flow leaves this one saved under your flows. Add below puts the template on the same bench, so you can compare them.</p>' });
          if (how === 'alt') return appendFlow(next);
          if (how) { await saveNow(); setFlow(next); }
          return;
        }
        if (v === 'blank') { await saveNow(); return setFlow({ name: 'Untitled flow', nodes: [], edges: [] }); }
        if (v === 'dup') {
          await saveNow();
          const copy = JSON.parse(JSON.stringify(snapshot()));
          return setFlow({ name: `${S.flow.name} copy`, nodes: copy.nodes, edges: copy.edges }, { keepView: true });
        }
        if (v === 'del') {
          if (!(await ask({ title: `Delete \u201c${S.flow.name}\u201d?`, ok: 'Delete', body: '<p>The flow is removed from your account. Anything it made stays on your Arcade account, and its run history is kept.</p>' }))) return;
          clearTimeout(saveTimer);
          const gone = S.flow.id;
          S.flow.id = '';
          await App.api('flows/' + gone, { method: 'DELETE' });
          S.flows = S.flows.filter((f) => f.id !== gone);
          if (S.flows.length) await openFlow(S.flows[0].id); else setFlow(fromTemplate(TEMPLATES[0]));
        }
      } catch (err) { toast(err.message); }
    };
  }

  function renderPalette() {
    let h = '';
    for (const g of GROUPS) {
      h += `<h2>${g}</h2>`;
      for (const def of Object.values(NODES).filter((d) => d.group === g)) {
        h += `<button class="cap" draggable="true" data-type="${def.type}" title="${esc(def.endpoint)}"><b>${esc(def.title)} ${def.worlds.length === 1 ? `<span class="tag ${def.worlds[0]}">${def.worlds[0]} only</span>` : ''}</b><small>${esc(def.blurb)}</small></button>`;
      }
    }
    h += '<h2>Not on the bench</h2>' + UNAVAILABLE.map((u) => `<div class="cap off" title="${esc(u.endpoint)}"><b>${esc(u.title)}</b><small>${esc(u.why)}</small></div>`).join('');
    const p = $('palette');
    p.innerHTML = h;
    p.addEventListener('click', (e) => { const b = e.target.closest('button.cap'); if (b) addNode(b.dataset.type); });
    p.addEventListener('dragstart', (e) => { const b = e.target.closest('button.cap'); if (b) e.dataTransfer.setData('text/plain', b.dataset.type); });
    renderFlowMenu();
  }

  async function boot() {
    renderPalette();
    wire();
    applyView();
    const me = await App.ready;
    LAST = `arcade-workbench.last.${me.user.username}`;
    const banner = (text) => { $('banner').textContent = text; $('banner').hidden = false; };
    const src = me.arcade.source;
    S.cat.hasKey = src !== 'none';
    $('keyState').dataset.on = String(S.cat.hasKey);
    $('keyState').textContent = src === 'own' ? 'arcade: your key' : src === 'host' ? 'arcade: host key' : 'no arcade key';
    if (!S.cat.hasKey) banner('No Arcade key yet. Add yours under Models and keys. You can still lay out a flow and see what Arcade allows.');
    else {
      try { S.cat.categories = await App.categories(); S.cat.models = (await arcade('models/list', {})).items || []; }
      catch (e) { $('keyState').dataset.on = 'false'; $('keyState').textContent = 'key refused'; banner(`Arcade did not accept the request. ${e.message}`); }
    }
    App.onBench.push(() => requestAnimationFrame(() => { if (App.keyChanged) return location.reload(); if (S.needFit) { S.needFit = false; fit(); } refreshAll(); }));
    App.onKeyChange = () => { App.keyChanged = true; };
    try { S.flows = (await App.api('flows')).flows; } catch { S.flows = []; }
    let last = null;
    try { last = localStorage.getItem(LAST); } catch { /* no storage */ }
    const first = S.flows.some((f) => f.id === last) ? last : S.flows[0]?.id;
    if (first) return openFlow(first);
    // First sign-in: the admin keeps a flow that was built in this browser before accounts existed.
    let old = null;
    try { old = JSON.parse(localStorage.getItem(LEGACY) || 'null'); } catch { /* start fresh */ }
    if (me.user.role === 'admin' && old?.flow?.nodes?.length) { if (old.view) S.view = old.view; setFlow(old.flow, { keepView: Boolean(old.view) }); applyView(); }
    else setFlow(fromTemplate(TEMPLATES[0]));
  }

  window.WB = { S, G, NODES, statusOf, checks, whyNot, runTo, runFlow, fork, addNode, connect, setFlow, appendFlow, openFlow, saveNow, fromTemplate, TEMPLATES, fit };
  boot();
})();
