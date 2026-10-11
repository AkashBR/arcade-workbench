// Workbench engine: the canvas, the wiring, the checks and the runner.
// Capabilities live in nodes.js; nothing in here knows about a specific endpoint.
(function () {
  'use strict';
  const { NODES, GROUPS, TEMPLATES, UNAVAILABLE, ICONS, iconKey, glyphKey } = window.ArcadeNodes;
  const svg = (key, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[key] || ''}</svg>`;
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
    publish: 'Ready. Adds a product to your store. You confirm first.',
  };

  const S = { flow: { id: '', name: '', nodes: [], edges: [] }, flows: [], view: { x: 30, y: 24, k: 1 }, sel: null, selEdge: null,
    cat: { categories: [], models: [], hasKey: null, options: {}, pending: {} }, busy: false, batch: null, needFit: false, log: [],
    panel: 'none', palette: 'closed' };
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
      keepVersion(n);
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
  // ---------- versions ----------
  // A step that makes something keeps every result it has made. One is the final: it is what the step shows
  // and what the next steps receive. The others stay with the step, so nothing made is ever lost.
  const versionNote = (n) => String(n.cfg.prompt || n.cfg.instruction || (NODES[n.type].summary ? NODES[n.type].summary(n) : '') || '').slice(0, 300);
  function versionsOf(n) {
    if (NODES[n.type].cost !== 'create') return [];
    if (!n.versions?.length && n.out) { n.versions = [{ id: n.runId || uid('r'), out: n.out, at: null, ms: n.ms ?? null, note: versionNote(n) }]; n.final = n.versions[0].id; }
    return n.versions || [];
  }
  function keepVersion(n) {
    if (NODES[n.type].cost !== 'create') return;
    n.versions = (n.versions || []).filter((v) => v.out !== n.out);
    n.versions.push({ id: n.runId, out: n.out, at: Date.now(), ms: n.ms, note: versionNote(n) });
    if (n.versions.length > 16) n.versions.shift();
    n.final = n.runId;
  }
  // Choosing another version makes it the final. The steps after this one now hold results made from the old final, so they show as edited.
  function useVersion(n, id) {
    const v = versionsOf(n).find((x) => x.id === id);
    if (!v || n.status === 'running') return;
    Object.assign(n, { out: v.out, final: v.id, status: 'ok', error: null, runId: uid('r') });
    n.sig = sigOf(n);
    changed();
  }
  function dropVersion(n, id) {
    if (id === n.final) return;
    n.versions = versionsOf(n).filter((v) => v.id !== id);
    changed();
  }
  const versionThumb = (v) => v.out.product?.imageUrl || v.out.pattern?.thumbnailUrl || v.out.pattern?.imageUrl || v.out.shots?.items?.[0]?.url || '';
  async function renewVersion(n, v) {
    try {
      if (v.out.product) v.out.product = await readProduct(v.out.product.productId, v.out.product.quantity || 1, v.out.product.world);
      if (v.out.pattern) v.out.pattern = await readPattern(v.out.pattern.patternId, v.out.pattern.world);
      renderInspector(); save();
    } catch { /* the old picture stays */ }
  }
  function versionsHtml(n) {
    const others = versionsOf(n).filter((v) => v.id !== n.final).reverse();
    if (!others.length) return '';
    return `<details class="fold" data-k="versions"><summary>Other versions (${others.length})</summary>
      <p class="hint">Made earlier and kept. They are not used by the next steps unless you make one the final.</p>
      <div class="ver-grid">${others.map((v) => `<figure class="ver"><img src="${esc(versionThumb(v))}" alt="" data-ver="${esc(v.id)}">
        <figcaption>${v.out.product?.unitPrice ? `<b>${esc(money(v.out.product.unitPrice))}</b>` : ''}<span>${esc(v.note || 'No note')}</span></figcaption>
        <div class="ver-acts"><button class="btn small" data-act="ver-use" data-ver="${esc(v.id)}">Make this the final</button><button class="btn ghost small" data-act="ver-del" data-ver="${esc(v.id)}">Discard</button></div></figure>`).join('')}</div></details>`;
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
        // A step that reaches outside the bench asks first: its own question if it has one, the checkout question otherwise.
        const def = NODES[n.type];
        if (def.confirm ? !(await def.confirm(n, { ask, source: G.source })) : def.cost === 'checkout' && !(await confirmCheckout(n))) break;
        if (!(await execNode(n))) break;
      }
    } finally { S.busy = false; refreshAll(); }
  }
  // Run every step that has not worked yet, in order, one at a time. Checkouts are never included.
  async function runFlow() {
    if (S.busy) return toast('A step is already running. Steps run one at a time.');
    const todo = topo().filter((n) => statusOf(n) !== 'ok' && NODES[n.type].cost !== 'checkout' && !NODES[n.type].confirm);
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
      // The answer is taken from the button press itself. The close event covers Escape, and a hidden tab can hold it back.
      let answered = false;
      const finish = (v) => { if (answered) return; answered = true; resolve(v === 'yes' ? true : v === 'alt' ? 'alt' : false); };
      d.querySelector('form').addEventListener('submit', (e) => finish(e.submitter ? e.submitter.value : 'no'));
      d.onclose = () => finish(d.returnValue);
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
    el.dataset.group = def.group.toLowerCase(); // the stylesheet gives each group of steps its own hue
    const port = (p, dir) => `<div class="port ${dir}" data-port="${p.key}" data-type="${p.type}"><i class="dot"></i><span>${esc(p.label)}</span>${p.optional ? '<em>optional</em>' : ''}</div>`;
    // The card shows what the step is set to and what it made. Its settings are edited in the side panel.
    el.innerHTML = `
      <header class="n-head"><div><h3>${svg(iconKey(def))}<span>${esc(def.title)}</span> <span class="n-world"></span></h3></div><span class="stamp"></span></header>
      <div class="n-ports"><div class="n-in">${def.inputs.map((p) => port(p, 'in')).join('')}</div><div class="n-out">${def.outputs.map((p) => port(p, 'out')).join('')}</div></div>
      <div class="n-sum"></div><div class="n-preview"></div><div class="n-verdict"></div>
      <footer class="n-foot"><button class="btn small run">Run</button><button class="btn ghost small fork" title="Copy this step and everything after it">Fork</button><button class="btn ghost small del">Remove</button></footer>`;
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    return el;
  }
  // One line (or a few) saying what the step is set to.
  function summaryHtml(n) {
    const def = NODES[n.type];
    if (n.type === 'category') {
      const c = S.cat.categories.find((x) => x.categoryId === n.cfg.categoryId);
      return c ? `<span class="sum-cat">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="">` : `<i>${svg(glyphKey(c.name))}</i>`}${esc(c.name)}</span>` : '<span class="muted">No category chosen yet</span>';
    }
    if (def.summary) return esc(def.summary(n));
    const parts = def.fields.filter((f) => !['options', 'clusters', 'pick', 'check'].includes(f.kind) && n.cfg[f.key] !== undefined && n.cfg[f.key] !== '')
      .slice(0, 4).map((f) => (f.kind === 'textarea' ? String(n.cfg[f.key]) : `${f.label} ${n.cfg[f.key]}`));
    return parts.length ? esc(parts.join(' · ')) : '<span class="muted">Not set up yet</span>';
  }
  // Categories as picture tiles, grouped by how they are made.
  function categoryTiles(sel) {
    const cats = S.cat.categories;
    if (!cats.length) return '<p class="hint">No categories loaded. Check the Arcade key under Models and keys.</p>';
    const group = (w, label) => `<div class="tp-label">${label}</div><div class="tp-grid">${cats.filter((c) => c.world === w).map((c) =>
      `<button type="button" class="tp" data-id="${esc(c.categoryId)}" data-name="${esc(c.name)}" aria-pressed="${c.categoryId === sel}">${c.imageUrl ? `<img loading="lazy" src="${esc(c.imageUrl)}" alt="">` : `<i>${svg(glyphKey(c.name), 'ic big')}</i>`}<span>${esc(c.name)}</span></button>`).join('')}</div>`;
    return group('jewelry', 'Jewelry') + group('print', 'Print goods');
  }
  function buildFields(n, box) {
    const def = NODES[n.type];
    box.innerHTML = '';
    let pair = null;
    for (const f of def.fields) {
      const dynamic = ['options', 'clusters', 'pick', 'category', 'chips', 'store', 'collections'].includes(f.kind);
      const wrap = document.createElement(dynamic ? 'div' : 'label');
      wrap.dataset.field = f.key;
      if (f.printOnly) wrap.dataset.printOnly = '1';
      const note = f.printOnly ? '<span class="off-note" hidden>Not sent for jewelry.</span>' : '';
      const val = n.cfg[f.key];
      if (f.kind === 'textarea') wrap.innerHTML = `${esc(f.label)}<textarea maxlength="${f.max || 1000}" placeholder="${esc(f.placeholder || '')}">${esc(val || '')}</textarea>`;
      else if (f.kind === 'text') wrap.innerHTML = `${esc(f.label)}<input type="text" value="${esc(val || '')}" placeholder="${esc(f.placeholder || '')}">${note}`;
      else if (f.kind === 'number') wrap.innerHTML = `${esc(f.label)}<input type="number" value="${esc(val ?? '')}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}>`;
      else if (f.kind === 'check') { wrap.className = 'check'; wrap.innerHTML = `<input type="checkbox"${val ? ' checked' : ''}><span>${esc(f.label)}</span>`; }
      else if (f.kind === 'category') {
        wrap.className = 'tiles-pick';
        wrap.innerHTML = categoryTiles(val);
        wrap.onclick = (e) => {
          const b = e.target.closest('button[data-id]');
          if (!b) return;
          n.cfg.categoryId = b.dataset.id; n.cfg.categoryName = b.dataset.name;
          wrap.querySelectorAll('button[data-id]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          changed();
        };
      } else if (f.kind === 'model') wrap.innerHTML = `${esc(f.label)}<select><option value="">Arcade picks</option>${S.cat.models.map((m) => `<option value="${esc(m.modelId)}"${m.modelId === val ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>${note}`;
      else if (f.kind === 'chips') {
        // A row of choices, one or many. f.options is a list, or a function of the step, of { id, label, swatch? }.
        const opts = (typeof f.options === 'function' ? f.options(n, G) : f.options) || [];
        const on = (id) => (f.multi ? (n.cfg[f.key] || []).includes(id) : n.cfg[f.key] === id);
        wrap.innerHTML = `<div class="tp-label">${esc(f.label)}</div><div class="chips-pick">${opts.map((o) =>
          `<button type="button" class="chip" data-chip="${esc(o.id)}" aria-pressed="${on(o.id)}">${o.swatch ? `<i class="sw" style="background:${esc(o.swatch)}"></i>` : ''}${esc(o.label)}</button>`).join('')
          || '<span class="hint">Still loading the choices. Close this panel and open it again.</span>'}</div>`;
        wrap.onclick = (e) => {
          const b = e.target.closest('[data-chip]');
          if (!b) return;
          if (f.multi) { const cur = new Set(n.cfg[f.key] || []); if (cur.has(b.dataset.chip)) cur.delete(b.dataset.chip); else cur.add(b.dataset.chip); n.cfg[f.key] = [...cur]; }
          else n.cfg[f.key] = b.dataset.chip;
          wrap.querySelectorAll('[data-chip]').forEach((x) => x.setAttribute('aria-pressed', String(on(x.dataset.chip))));
          changed();
        };
      } else if (f.kind === 'store') {
        // The person's connected stores, with connecting a new one as the last entry.
        const drawStores = async () => {
          let list = [];
          try { list = await App.stores(); } catch (e) { wrap.innerHTML = `<p class="hint">${esc(e.message)}</p>`; return; }
          wrap.innerHTML = `<label>${esc(f.label)}<select><option value=""${n.cfg[f.key] ? '' : ' selected'} disabled>${list.length ? 'Choose a store' : 'No store connected yet'}</option>${list.map((s) =>
            `<option value="${esc(s.id)}"${s.id === n.cfg[f.key] ? ' selected' : ''}>${esc(s.name)} \u00b7 ${esc(s.platformName)}</option>`).join('')}<option value="__add">+ Connect a WooCommerce or Shopify store\u2026</option></select></label>`;
          wrap.querySelector('select').onchange = (ev) => {
            const v = ev.target.value;
            if (v === '__add') return App.storeBox({ onDone: (s) => { n.cfg[f.key] = s.id; n.cfg.storeName = s.name; changed(); }, onClose: drawStores });
            const s = list.find((x) => x.id === v);
            n.cfg[f.key] = v; n.cfg.storeName = s ? s.name : '';
            changed();
          };
        };
        drawStores();
      } else if (f.kind === 'pick') {
        wrap.className = 'picked';
        wrap.innerHTML = `<span>${val ? esc(n.cfg.pickLabel || val) : 'Nothing chosen'}</span><button class="btn ghost small" type="button">Choose from your account</button>`;
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
        const read = () => { n.cfg[f.key] = input.type === 'checkbox' ? input.checked : input.value; changed(); };
        input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', read);
      }
      if (f.kind === 'number') {
        if (!pair || pair.children.length >= 2) { pair = document.createElement('div'); pair.className = 'pair'; box.appendChild(pair); }
        pair.appendChild(wrap);
      } else { pair = null; box.appendChild(wrap); }
      if (f.assist) { box.appendChild(aiRow()); box.appendChild(assistRow(n, f, wrap)); box.appendChild(metalRow(n, f, wrap)); }
    }
  }
  // Jewelry reads the metal from the prompt. These chips write it in, from the metals the category can be made in.
  function metalRow(n, f, wrap) {
    const row = document.createElement('div');
    row.dataset.metals = '1';
    row.hidden = true;
    row.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const ta = wrap.querySelector('textarea');
      let text = ta.value;
      const tidy = (t) => t.trim().replace(/[.,\s]+$/, '');
      if (b.dataset.metal) {
        const known = [...row.querySelectorAll('[data-metal]')].map((x) => x.dataset.metal).sort((a, c) => c.length - a.length);
        const found = known.find((m) => text.toLowerCase().includes(m.toLowerCase()));
        if (found) text = text.replace(new RegExp(found.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), b.dataset.metal);
        else text = text.trim() ? `${tidy(text)}, in ${b.dataset.metal}` : `A ${b.dataset.metal} `;
      } else text = /no stones/i.test(text) ? text.replace(/,?\s*no stones/i, '') : `${tidy(text)}, no stones`;
      ta.value = text; n.cfg[f.key] = text;
      changed();
    };
    return row;
  }
  // A colour dot for a metal, worked out from its name. Arcade sends the names; the dots are ours.
  function metalDot(label) {
    const l = label.toLowerCase();
    const c = /black/.test(l) ? '#2b2b2b' : /rose/.test(l) ? '#d9a590' : /white gold/.test(l) ? '#e6e3da' : /platinum/.test(l) ? '#d5d7da' : /silver/.test(l) ? '#c5c9cf' : /vermeil/.test(l) ? '#e3c063' : /gold/.test(l) ? '#d4af37' : '';
    return c ? `<i class="sw" style="background:${c}"></i>` : '';
  }
  function renderMetals(n, row) {
    const src = G.source(n, 'category'), catId = src?.node.cfg.categoryId;
    if (G.worldOf(n) !== 'jewelry' || !catId) { row.hidden = true; return; }
    const opts = src.node.out?.category?.options || S.cat.options[catId];
    row.hidden = false;
    if (!opts) {
      // Read the category's options once, so the metals show without running the Category step.
      if (!S.cat.pending[catId]) {
        S.cat.pending[catId] = arcade('categories/get', { categoryId: catId, selections: {} }).then((r) => { S.cat.options[catId] = r.options || []; })
          .catch(() => { S.cat.options[catId] = []; }).finally(() => renderInspector());
      }
      return setHtml(row, '<div class="tp-label">Loading the metals this category can be made in…</div>');
    }
    const metal = opts.find((o) => /material|metal/i.test(o.key + o.label)) || opts[0];
    if (!metal) { row.hidden = true; return; }
    const prompt = String(n.cfg.prompt || '').toLowerCase();
    setHtml(row, `<div class="tp-label">Metal. Arcade reads it from the prompt, so pick one to write it in.</div><div class="chips-pick">${metal.values.map((v) =>
      `<button type="button" class="chip" data-metal="${esc(v.label)}" aria-pressed="${prompt.includes(v.label.toLowerCase())}"${v.available ? '' : ' disabled title="Arcade can’t make this right now"'}>${metalDot(v.label)}${esc(v.label)}</button>`).join('')}<button type="button" class="chip" data-stones="1" aria-pressed="${/no stones/.test(prompt)}">No stones</button></div>`);
  }
  // Two helpers under a prompt: pick one from the library, or ask a connected model for ideas.
  // The AI model behind "Suggest", set right here in the panel: pick a maker, add a key, choose a model.
  // It folds away once a model is connected, and stays open while there is none.
  function aiRow() {
    const d = document.createElement('details');
    d.className = 'fold ai-pick';
    d.innerHTML = '<summary></summary><div class="ai-body"></div>';
    // The closed state looks like a drop-down: what is in use, whose key, and an arrow to open it.
    const label = () => {
      const m = App.aiInfo();
      d.querySelector('summary').innerHTML = `<span class="ai-cap">AI model for prompt ideas, and its API key</span><span class="ai-box${m ? '' : ' none'}"${m ? ` data-logo="${esc(m.preset || '')}"` : ''}><b>${m ? `${esc(m.name)} \u00b7 ${esc(m.model)}` : 'Add an API key'}</b>${m ? `<em>${esc(m.whose)}</em>` : '<em>Claude, OpenAI or Gemini</em>'}<i class="ai-chev" aria-hidden="true"></i></span>`;
    };
    const build = () => { if (d.dataset.built) return; d.dataset.built = '1'; App.connectInline(d.querySelector('.ai-body')); };
    label();
    App.onAiChange = label;
    d.addEventListener('toggle', () => { if (d.open) build(); });
    if (!App.hasAi()) { d.open = true; build(); }
    return d;
  }
  function assistRow(n, f, wrap) {
    const row = document.createElement('div');
    row.className = 'assist';
    row.innerHTML = '<button type="button" data-tab="lib">From library</button><button type="button" data-tab="ai">Suggest a prompt</button>';
    row.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const src = G.source(n, 'category'), cat = src?.node.out?.category, categoryId = src?.node.cfg.categoryId;
      const metals = cat && (cat.options.find((o) => /material|metal/i.test(o.key + o.label)) || cat.options[0]);
      // Suggest writes straight into the prompt box. Whatever is already there is taken as the idea.
      if (b.dataset.tab === 'ai') {
        const ta = wrap.querySelector('textarea');
        b.disabled = true; b.textContent = 'Writing a prompt…';
        try {
          const r = await App.suggestOne({ world: G.worldOf(n), categoryId, categoryName: S.cat.categories.find((c) => c.categoryId === categoryId)?.name,
            materials: metals ? metals.values.filter((v) => v.available).map((v) => v.label) : undefined, idea: ta.value });
          ta.value = r.prompt; n.cfg[f.key] = r.prompt;
          changed();
          toast(`Written by ${r.model}. Press it again for another, or Undo to get your text back.`);
        } catch (err) {
          if (err.code === 'NO_MODEL') {
            const ai = $('inspector').querySelector('.ai-pick');
            if (ai) { ai.open = true; ai.scrollIntoView({ block: 'center' }); }
            toast('Add an API key in the box that just opened, then press Suggest a prompt again.');
          } else toast(err.message);
        } finally { b.disabled = false; b.textContent = 'Suggest a prompt'; }
        return;
      }
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
    box.innerHTML = cat.options.map((o) => `<div class="opt"><div class="tp-label">${esc(o.label)}</div><div class="chips-pick"><button type="button" class="chip" data-opt="${esc(o.key)}" data-val="" aria-pressed="${!chosen[o.key]}">Arcade picks</button>${o.values.map((v) =>
      `<button type="button" class="chip" data-opt="${esc(o.key)}" data-val="${esc(v.value)}" aria-pressed="${chosen[o.key] === v.value}"${v.available ? '' : ' disabled title="Arcade can’t make this right now"'}>${metalDot(v.label)}${esc(v.label)}</button>`).join('')}</div></div>`).join('')
      || '<p class="hint">This category has no options.</p>';
    box.onclick = (e) => {
      const b = e.target.closest('button[data-opt]');
      if (!b || b.disabled) return;
      const next = { ...(n.cfg.selections || {}) };
      if (b.dataset.val) next[b.dataset.opt] = b.dataset.val; else delete next[b.dataset.opt];
      n.cfg.selections = next;
      changed();
    };
  }
  // The chosen store's collections (Shopify) or categories (WooCommerce), as chips. The one that fits the
  // product is picked for you, with the reason shown; you can change it, or name a new one to be made.
  function renderCollections(n, box) {
    const storeId = n.cfg.storeId;
    if (!storeId) return setHtml(box, '<p class="hint">Choose a store to see its collections.</p>');
    const prod = G.source(n, 'product')?.node.out?.product;
    const cat = prod && S.cat.categories.find((c) => c.categoryId === prod.categoryId);
    const key = `${storeId}|${cat ? cat.name : ''}`, cache = (S.cat.collections = S.cat.collections || {});
    if (!cache[key]) {
      cache[key] = { loading: true };
      App.api(`stores/${storeId}/collections?category=${encodeURIComponent(cat ? cat.name : '')}&world=${encodeURIComponent(G.worldOf(n) || '')}`)
        .then((r) => { cache[key] = r; if (!n.cfg.collectionsFor || n.cfg.collectionsFor !== key) { n.cfg.collections = r.suggested; n.cfg.collectionsFor = key; save(); } })
        .catch((e) => { cache[key] = { error: e.message }; })
        .finally(() => { refreshAll(); });
    }
    const c = cache[key];
    if (c.loading) return setHtml(box, '<p class="hint">Reading the store’s collections…</p>');
    if (c.error) return setHtml(box, `<p class="hint">${esc(c.error)}</p>`);
    const chosen = n.cfg.collections || [], word = c.word || 'collection';
    const auto = JSON.stringify(chosen) === JSON.stringify(c.suggested);
    setHtml(box, `<div class="tp-label">Where it goes in the store</div><div class="chips-pick">${c.collections.map((x) =>
      `<button type="button" class="chip" data-col="${esc(x.id)}" aria-pressed="${chosen.includes(x.id)}"${x.canAdd ? '' : ' disabled title="This one fills itself by rules, so products cannot be added to it by hand"'}>${esc(x.title)}</button>`).join('') || `<span class="hint">The store has no ${word} yet.</span>`}</div>
      <p class="hint">${esc(auto ? c.why : `${chosen.length} chosen by you.`)}</p>
      <label>Or make a new ${word} named<input type="text" data-newcol placeholder="Leave empty for none"></label>`);
    const input = box.querySelector('[data-newcol]');
    if (input && document.activeElement !== input) input.value = n.cfg.newCollection || '';
    box.onclick = (e) => {
      const b = e.target.closest('button[data-col]');
      if (!b || b.disabled) return;
      const now = new Set(n.cfg.collections || []);
      if (now.has(b.dataset.col)) now.delete(b.dataset.col); else now.add(b.dataset.col);
      n.cfg.collections = [...now];
      changed();
    };
    box.oninput = (e) => { if (e.target.matches('[data-newcol]')) { n.cfg.newCollection = e.target.value; save(); } };
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
    if (NODES[n.type].preview) return NODES[n.type].preview(n); // a step may draw its own result
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
  function verdictHtml(n, st, onCard = false) {
    const out = [];
    if (st === 'running') out.push(`<p>${esc(n.progress || 'Working')}…</p>`);
    else if (st === 'error') out.push(`<p class="v-bad">${esc(n.error.message)}</p>`);
    else if (st === 'blocked' || st === 'waiting') {
      const w = whyNot(n);
      out.push(`<p class="v-block">${esc(w.text)}</p>`);
      if (w.more) out.push(`<p class="muted">${w.more} more in the details.</p>`);
    } else if (st === 'stale') out.push('<p>Changed since the last run. The result shown is the old one.</p>');
    else if (st === 'ready' && !onCard) out.push(`<p>${COST[NODES[n.type].cost]}</p>`);
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
    setHtml(el.querySelector('.n-sum'), summaryHtml(n));
    for (const o of def.outputs) el.querySelector(`.port.out[data-port="${o.key}"]`).classList.toggle('off', Boolean(o.when) && !o.when(n, G));
    el.querySelectorAll('.port').forEach((p) => {
      const dir = p.classList.contains('in') ? 'to' : 'from';
      p.classList.toggle('linked', S.flow.edges.some((e) => e[dir].node === n.id && e[dir].port === p.dataset.port));
    });
    setHtml(el.querySelector('.n-preview'), previewHtml(n));
    setHtml(el.querySelector('.n-verdict'), verdictHtml(n, st, true));
    const run = el.querySelector('.run');
    run.disabled = S.busy;
    run.textContent = st === 'running' ? 'Running' : n.out ? 'Run again' : 'Run';
  }
  function mount(n) {
    for (const f of NODES[n.type].fields) if (n.cfg[f.key] === undefined && f.default !== undefined) n.cfg[f.key] = f.default;
    const el = buildNode(n);
    $('world').appendChild(el);
    els.set(n.id, el);
  }
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
    if (S.sel === id) { S.sel = null; S.panel = 'none'; }
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
  // Selecting a step opens its panel. Selecting nothing closes the panel, unless another one is asked for.
  function select(id, panel) {
    S.sel = id; S.selEdge = null;
    S.panel = panel || (id ? 'step' : 'none');
    for (const [nid, el] of els) el.classList.toggle('sel', nid === id);
    drawEdges();
    renderInspector();
  }

  // ---------- inspector ----------
  function resultHtml(n) {
    const o = n.out;
    if (!o) return '<p class="muted">Nothing yet. Run this step to see what Arcade returns.</p>';
    if (NODES[n.type].result) return NODES[n.type].result(n);
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
    `<details class="call" data-k="${c.at}-${esc(c.endpoint)}"><summary><b class="${c.status >= 200 && c.status < 300 ? 's-ok' : 's-bad'}">${c.status}</b><span class="mono">${esc(c.endpoint)}</span><span class="muted">${c.ms}ms${c.body && typeof c.body.status === 'string' ? ' · ' + esc(c.body.status) : ''}</span></summary><pre>${esc('REQUEST\n' + JSON.stringify(c.req, null, 2) + '\n\nRESPONSE\n' + JSON.stringify(c.body, null, 2))}</pre></details>`).join('');
  // Like setHtml, but anything the reader had folded open stays open.
  function keepOpen(box, html) {
    if (!box || box._html === html) return;
    const open = new Set([...box.querySelectorAll('details[data-k]')].filter((d) => d.open).map((d) => d.dataset.k));
    box.innerHTML = html; box._html = html;
    box.querySelectorAll('details[data-k]').forEach((d) => { if (open.has(d.dataset.k)) d.open = true; });
  }
  const closeBtn = '<button class="p-close" data-act="close" aria-label="Close this panel">×</button>';
  function overviewHtml() {
    return `<div class="p-head"><div><h2>Flow check</h2></div><div class="p-head-r">${closeBtn}</div></div>
      <p class="lede">Every step is checked against Arcade’s rules before anything runs.</p>
      <div class="checklist">${topo().map((x) => { const st = statusOf(x), w = whyNot(x); return `<button data-go="${x.id}"><b>${esc(NODES[x.type].title)}</b><span class="stamp" data-status="${st}">${esc(stampText(x, st, false))}</span>${w ? `<span class="why">${esc(w.text)}</span>` : x.status === 'error' ? `<span class="why">${esc(x.error.message)}</span>` : ''}</button>`; }).join('') || '<p class="muted">No steps yet.</p>'}</div>
      <details class="fold" data-k="log"><summary>Recent API calls${S.log.length ? ` (${Math.min(14, S.log.length)})` : ''}</summary>${S.log.length ? callsHtml(S.log.slice(-14)) : '<p class="muted">None yet.</p>'}</details>`;
  }
  // Everything the flow has produced so far, in one place: products with their prices, checkout links, loose designs.
  function resultsHtml() {
    const products = new Map(), designs = new Map(), links = [];
    for (const n of topo()) {
      const o = n.out;
      if (!o) continue;
      if (o.product) products.set(o.product.productId, o.product);
      if (o.pattern) designs.set(o.pattern.patternId, o.pattern);
      if (o.checkout) links.push(o.checkout);
    }
    for (const p of products.values()) designs.delete(p.patternId);
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    return `<div class="p-head"><div><h2>What this flow made</h2></div><div class="p-head-r">${closeBtn}</div></div>
      <p class="lede">${products.size || designs.size ? `${count(products.size, 'product')}${designs.size ? `, ${count(designs.size, 'design')} without a product` : ''}${links.length ? `, ${count(links.length, 'checkout link')}` : ''}.` : 'Nothing yet. Run the flow, and what it makes shows up here.'}</p>
      <div class="made">${[...products.values()].map((p) => `<article class="made-card"><img src="${esc(p.imageUrl)}" alt="${esc(p.title)}"><div><span class="price">${esc(money(p.unitPrice) || 'Price pending')}</span><b>${esc(p.title)}</b><span class="muted">${esc([p.selectionLabel, p.maker].filter(Boolean).join(' · '))}</span>${p.quantity > 1 ? `<span class="muted">Price each at quantity ${p.quantity}</span>` : ''}</div></article>`).join('')}</div>
      ${links.length ? `<h3>Checkout links</h3>${links.map((c) => `<p><a href="${esc(c.checkoutUrl)}" target="_blank" rel="noopener">Open Arcade’s checkout page</a> <span class="muted">${esc((c.titles || []).join(', '))}</span></p>`).join('')}` : ''}
      ${designs.size ? `<h3>Designs without a product</h3><div class="i-imgs">${[...designs.values()].map((d) => `<img class="i-img" src="${esc(d.thumbnailUrl || d.imageUrl)}" alt="Design">`).join('')}</div>` : ''}`;
  }
  // The side panel. For a step it holds everything you set and everything it returned.
  // Its form is built once per step, so typing in it is never interrupted; the rest updates in place.
  function renderInspector() {
    const box = $('inspector');
    const n = S.panel === 'step' ? G.node(S.sel) : null;
    if (S.panel === 'step' && !n) S.panel = 'none';
    document.querySelector('.shell').dataset.panel = S.panel;
    if (S.panel === 'none') { if (box._for) { box._for = null; box.innerHTML = ''; } return; }
    if (S.panel === 'check') {
      if (box._for !== 'check') { box._for = 'check'; box.innerHTML = '<div id="pCheck"></div>'; box.scrollTop = 0; }
      return keepOpen($('pCheck'), overviewHtml());
    }
    if (S.panel === 'results') {
      if (box._for !== 'results') { box._for = 'results'; box.innerHTML = '<div id="pMade"></div>'; box.scrollTop = 0; }
      return setHtml($('pMade'), resultsHtml());
    }
    const def = NODES[n.type];
    if (box._for !== n.id) {
      box._for = n.id;
      box.innerHTML = `<div class="p-head"><div><span class="mono muted">${esc(def.endpoint)}</span><h2>${esc(def.title)}</h2></div><div class="p-head-r"><span class="stamp" id="pStamp"></span>${closeBtn}</div></div>
        <p class="lede">${esc(def.blurb)}</p>
        <div id="pResult"></div><div id="pActs"></div>
        ${def.fields.length ? `<details class="fold" data-k="setup"${n.out ? '' : ' open'}><summary>Set it up<span class="fold-sum" id="pSetupSum"></span></summary><div class="n-fields setup" id="pFields"></div></details>` : ''}
        <div id="pStatus"></div><div id="pMore"></div>`;
      if (def.fields.length) buildFields(n, $('pFields'));
      // The AI model and key box stays in view, above the folded setup, so it is never hidden once a step has a result.
      const aiBox = $('pFields')?.querySelector('.ai-pick');
      if (aiBox) $('pFields').closest('details').before(aiBox);
      box.scrollTop = 0;
    }
    const st = statusOf(n), world = G.worldOf(n), w = whyNot(n);
    $('pStamp').dataset.status = st;
    setHtml($('pStamp'), esc(stampText(n, st, false)));
    const fields = $('pFields');
    if (fields) {
      fields.querySelectorAll('[data-print-only]').forEach((x) => {
        x.hidden = world === 'jewelry';
      });
      for (const f of def.fields) {
        const fb = fields.querySelector(`[data-field="${f.key}"]`);
        if (f.kind === 'options') renderOptions(n, fb);
        if (f.kind === 'clusters') renderClusters(n, fb);
        if (f.kind === 'collections') renderCollections(n, fb);
      }
      const metals = fields.querySelector('[data-metals]');
      if (metals) renderMetals(n, metals);
    }
    const checkList = [
      ...checks(n).map((i) => `<li class="${i.level}">${esc(i.text)}</li>`),
      ...(w && !w.self ? [`<li class="block">${esc(w.text)}</li>`] : []),
      ...(n.status === 'error' ? [`<li class="block">Arcade said: ${esc(n.error.message)}</li>`] : []),
    ];
    const made = versionsOf(n).length, making = NODES[n.type].cost === 'create';
    keepOpen($('pResult'), `<h3>${made > 1 ? `The final, of ${made} versions` : n.out ? 'Result' : 'Nothing made yet'}</h3>${resultHtml(n)}${versionsHtml(n)}`);
    setHtml($('pActs'), `<div class="p-actions"><button class="btn wire" data-act="run"${S.busy ? ' disabled' : ''}>${st === 'running' ? 'Running' : !n.out ? 'Run this step' : making ? 'Make another version' : 'Run again'}</button><button class="btn ghost" data-act="fork">Fork</button><button class="btn ghost" data-act="del">Remove</button></div>`);
    // Folded away, the setup still says what it is set to.
    if ($('pSetupSum')) setHtml($('pSetupSum'), esc(new DOMParser().parseFromString(summaryHtml(n), 'text/html').body.textContent));
    keepOpen($('pStatus'), `<details class="fold" data-k="can"${checkList.length ? ' open' : ''}><summary>Can it run?<span class="fold-sum">${checkList.length ? 'Not yet' : 'Yes'}</span></summary><ul class="rules">${checkList.join('') || `<li class="fine">Yes. ${esc(COST[def.cost].replace(/^Ready\. /, ''))}</li>`}</ul></details>`);


    keepOpen($('pMore'), `${def.rules.length ? `<details class="fold" data-k="rules"><summary>How Arcade treats this step</summary><p>${def.worlds.map((x) => `<span class="tag ${x}">${x}</span>`).join(' ')} ${def.cost === 'read' ? '<span class="tag read">read only</span>' : ''}</p><ul class="rules">${def.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}
      <details class="fold" data-k="calls"><summary>API calls${n.calls?.length ? ` (${n.calls.length})` : ''}</summary>${n.calls?.length ? callsHtml(n.calls) : '<p class="muted">None this session.</p>'}</details>`);
  }
  // The blank bench: one click lays out a whole workflow.
  function renderStart() {
    const thumb = (name) => S.cat.categories.find((c) => c.name === name)?.imageUrl;
    $('start').innerHTML = `<div class="start-card"><h2>What do you want to make?</h2>
      <p>Pick a workflow and its steps are laid out for you. Then choose your options in the panel on the right.</p>
      <div class="start-grid">${TEMPLATES.map((t) => `<button type="button" data-tpl="${t.id}">${thumb(t.thumb) ? `<img src="${esc(thumb(t.thumb))}" alt="">` : `<i>${svg(glyphKey(t.thumb), 'ic big')}</i>`}<span><b>${esc(t.title)}</b><small>${esc(t.blurb)}</small></span></button>`).join('')}</div>
      <button type="button" class="start-alt" data-act="steps">Or add steps one at a time</button></div>`;
  }
  function setPalette(state) {
    S.palette = state;
    document.querySelector('.shell').dataset.palette = state;
    try { localStorage.setItem('arcade-workbench.palette', state); } catch { /* fine without it */ }
  }
  function renderTally() {
    const c = { ready: 0, blocked: 0, ok: 0, error: 0, running: 0 };
    for (const n of S.flow.nodes) { const st = statusOf(n); c[st === 'waiting' ? 'blocked' : st === 'stale' ? 'ok' : st]++; }
    $('tally').innerHTML = !S.flow.nodes.length ? '' : `<i>${S.flow.nodes.length} steps</i>${c.ready ? `<i>${c.ready} ready</i>` : ''}${c.blocked ? `<i class="t-hold">${c.blocked} can’t run</i>` : ''}${c.ok ? `<i class="t-ok">${c.ok} worked</i>` : ''}${c.error ? `<i class="t-bad">${c.error} failed</i>` : ''}`;
    $('start').hidden = S.flow.nodes.length > 0;
    $('btnRunFlow').disabled = S.busy;
  }
  function refreshAll() { S.flow.nodes.forEach(updateNode); drawEdges(); renderInspector(); renderTally(); }

  // ---------- saving ----------
  let saveTimer, saveWarned = false;
  const snapshot = () => ({ nodes: S.flow.nodes.map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, cfg: n.cfg, status: n.status === 'running' ? 'idle' : n.status, out: n.out || null,
    error: n.error || null, ms: n.ms ?? null, runId: n.runId || null, sig: n.sig || null, versions: n.versions || undefined, final: n.final || undefined })), edges: S.flow.edges, view: S.view });
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
    applyView(); // before setFlow, which measures port positions on the page
    setFlow({ id: f.id, name: f.name, nodes: f.data.nodes, edges: f.data.edges }, { keepView: Boolean(f.data.view) });
    applyView();
    renewed.clear(); // an image link that has expired is renewed when it fails to load, one step at a time
  }
  function changed() { save(); refreshAll(); recordHistory(); }

  // ---------- undo and redo ----------
  // Every change to the flow's shape (steps, wires, positions, settings) is remembered, up to 60 back.
  // Results are not part of it: undoing an edit never throws away something a step has made.
  const H = { undo: [], redo: [], present: null, key: '', last: 0, busy: false };
  const shapeKey = () => JSON.stringify([S.flow.nodes.map((n) => [n.id, n.type, n.x, n.y, n.cfg]), S.flow.edges.map((e) => [e.from, e.to])]);
  const fullCopy = () => JSON.stringify({ nodes: snapshot().nodes, edges: S.flow.edges });
  function resetHistory() { Object.assign(H, { undo: [], redo: [], present: fullCopy(), key: shapeKey(), last: 0 }); }
  function recordHistory() {
    if (H.busy) return;
    const key = shapeKey();
    if (H.present === null || key === H.key) { H.present = fullCopy(); H.key = key; return; }
    // Changes that land within a moment of each other (typing, or adding a step and its wire) undo as one.
    const now = Date.now();
    if (now - H.last > 700) { H.undo.push(H.present); if (H.undo.length > 60) H.undo.shift(); }
    Object.assign(H, { last: now, present: fullCopy(), key, redo: [] });
  }
  function restore(copy) {
    H.busy = true;
    const snap = JSON.parse(copy), live = new Map(S.flow.nodes.map((n) => [n.id, n]));
    // A step that still exists keeps whatever it has made since; a step coming back gets what it had then.
    S.flow.nodes = snap.nodes.map((n) => { const cur = live.get(n.id); return cur ? { ...cur, x: n.x, y: n.y, cfg: n.cfg } : { ...n, status: n.status === 'running' ? 'idle' : n.status }; });
    S.flow.edges = snap.edges;
    if (S.sel && !G.node(S.sel)) { S.sel = null; S.panel = 'none'; }
    S.selEdge = null;
    mountAll();
    $('inspector')._for = null;
    refreshAll();
    save();
    Object.assign(H, { busy: false, present: fullCopy(), key: shapeKey() });
  }
  function undo() {
    if (S.busy) return toast('Wait for the running step to finish, then undo.');
    if (!H.undo.length) return toast('Nothing to undo.');
    H.redo.push(H.present);
    restore(H.undo.pop());
    toast('Undone. Ctrl+Shift+Z brings it back.');
  }
  function redo() {
    if (S.busy) return toast('Wait for the running step to finish, then redo.');
    if (!H.redo.length) return toast('Nothing to redo.');
    H.undo.push(H.present);
    restore(H.redo.pop());
    toast('Redone.');
  }
  // Adding from the list asks first, so a stray click does not drop a step on the bench. It can be told to stop asking.
  async function askToAdd(type) {
    let off = false;
    try { off = localStorage.getItem('arcade-workbench.add-ask') === 'off'; } catch { /* ask */ }
    if (off) return addNode(type);
    const def = NODES[type];
    const yes = await ask({ title: `Add “${def.title}” to this flow?`, ok: 'Add step',
      body: `<p>${esc(def.blurb)}</p><p>It lands on the bench and its options open on the right. Ctrl+Z takes it back.</p><label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" id="skipAddAsk"> Don’t ask again, add on one click</label>` });
    if (!yes) return;
    if ($('skipAddAsk')?.checked) { try { localStorage.setItem('arcade-workbench.add-ask', 'off'); } catch { /* keep asking */ } }
    addNode(type);
  }
  const SHORTCUTS = [['Ctrl or Cmd + Z', 'Undo'], ['Ctrl or Cmd + Shift + Z, or Ctrl + Y', 'Redo'], ['Ctrl or Cmd + Enter', 'Run the selected step'], ['Ctrl or Cmd + D', 'Fork the selected step'],
    ['Delete or Backspace', 'Remove the selected step or wire'], ['Escape', 'Close the side panel'], ['Ctrl or Cmd + 0', 'Fit every step on screen'], ['Ctrl or Cmd + scroll', 'Zoom']];
  function showShortcuts() {
    ask({ title: 'Keyboard shortcuts', ok: 'Got it', body: `<dl class="facts">${SHORTCUTS.map(([k, v]) => `<dt class="mono">${k}</dt><dd>${v}</dd>`).join('')}</dl><p style="margin-top:12px">Inside a text box, Ctrl+Z undoes your typing as usual.</p>` });
  }
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
    resetHistory(); // undo does not reach back into another flow
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
    applyView(); drawEdges(); save();
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
      if (e.target.closest('.zoom, .banner, .edge, .start, .add-step')) return;
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
      }, () => { save(); recordHistory(); }); // not track(): inside wire() that name is the pointer helper
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
      if (edge) { S.sel = null; S.panel = 'none'; S.selEdge = edge.dataset.id; for (const el of els.values()) el.classList.remove('sel'); drawEdges(); return renderInspector(); }
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
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && k === 'y') { e.preventDefault(); redo(); }
      else if (mod && k === 'enter' && S.sel) { e.preventDefault(); runTo(S.sel); }
      else if (mod && k === 'd' && S.sel) { e.preventDefault(); fork(S.sel); }
      else if (mod && k === '0') { e.preventDefault(); fit(); }
    });
    window.addEventListener('resize', redraw);

    $('zoomIn').onclick = () => { const c = canvas.getBoundingClientRect(); zoomAt(c.left + c.width / 2, c.top + c.height / 2, 1.2); };
    $('zoomOut').onclick = () => { const c = canvas.getBoundingClientRect(); zoomAt(c.left + c.width / 2, c.top + c.height / 2, 1 / 1.2); };
    $('zoomFit').onclick = fit;
    $('btnUndo').onclick = undo;
    $('btnRedo').onclick = redo;
    $('btnKeys').onclick = showShortcuts;
    $('btnRunFlow').onclick = runFlow;
    $('btnExport').onclick = exportFlow;
    $('btnImport').onclick = () => $('importFile').click();
    $('importFile').onchange = (e) => { const f = e.target.files[0]; if (f) importFlow(f); e.target.value = ''; };
    $('flowName').oninput = (e) => { S.flow.name = e.target.value; save(); };
    $('inspector').addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) return select(go.dataset.go);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') return select(null);
      if (!act || !S.sel) return;
      if (act === 'run') runTo(S.sel); else if (act === 'fork') fork(S.sel); else if (act === 'del') removeNode(S.sel);
      else if (act === 'ver-use') useVersion(G.node(S.sel), e.target.closest('[data-ver]').dataset.ver);
      else if (act === 'ver-del') dropVersion(G.node(S.sel), e.target.closest('[data-ver]').dataset.ver);
      else {
        // Any other button belongs to the step itself, if the step says it handles buttons.
        const node = G.node(S.sel), def = node && NODES[node.type];
        if (def && def.onAct) def.onAct(node, act, e.target.closest('[data-act]').dataset, { ask, toast, changed });
      }
    });
    // A category picture that fails to load gives way to a plain tile.
    $('inspector').addEventListener('error', (e) => { if (e.target.tagName === 'IMG' && e.target.closest('.tp')) e.target.replaceWith(document.createElement('i')); }, true);
    $('inspector').addEventListener('error', (e) => {
      const id = e.target.tagName === 'IMG' && e.target.dataset.ver, n = id && S.sel && G.node(S.sel);
      const v = n && (n.versions || []).find((x) => x.id === id);
      if (!v || renewed.has('v:' + id) || !S.cat.hasKey) return;
      renewed.add('v:' + id);
      renewVersion(n, v);
    }, true);
    $('tally').onclick = () => select(null, 'check');
    $('btnResults').onclick = () => select(null, 'results');
    $('btnAdd').onclick = () => setPalette('open');
    $('start').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'steps') return setPalette('open');
      const t = TEMPLATES.find((x) => x.id === b.dataset.tpl);
      if (!t) return;
      setFlow({ ...fromTemplate(t), id: S.flow.id });
      const first = topo()[0];
      if (first) select(first.id);
      requestAnimationFrame(fit); // the panel has just opened, so fit the steps into what is left
    });
    document.addEventListener('click', (e) => { const m = $('more'); if (m.open && (!e.target.closest('#more') || e.target.closest('.more-menu button, .more-menu a'))) m.open = false; });
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
          if (S.flows.length) await openFlow(S.flows[0].id); else setFlow({ name: 'Untitled flow', nodes: [], edges: [] });
        }
      } catch (err) { toast(err.message); }
    };
  }

  function renderPalette() {
    let h = '';
    for (const g of GROUPS) {
      h += `<h2>${g}</h2>`;
      for (const def of Object.values(NODES).filter((d) => d.group === g)) {
        h += `<button class="cap" draggable="true" data-type="${def.type}" title="${esc(def.endpoint)}"><b>${svg(iconKey(def))}${esc(def.title)} ${def.worlds.length === 1 ? `<span class="tag ${def.worlds[0]}">${def.worlds[0]} only</span>` : ''}</b><small>${esc(def.blurb)}</small></button>`;
      }
    }
    h += '<h2>Not on the bench</h2>' + UNAVAILABLE.map((u) => `<div class="cap off" title="${esc(u.endpoint)}"><b>${esc(u.title)}</b><small>${esc(u.why)}</small></div>`).join('');
    const p = $('palette');
    p.innerHTML = '<div class="pal-head"><b>Add a step</b><button class="p-close" data-act="hide" aria-label="Hide the list of steps">\u00d7</button></div>' + h;
    p.addEventListener('click', (e) => { if (e.target.closest('[data-act="hide"]')) return setPalette('closed'); const b = e.target.closest('button.cap'); if (b) askToAdd(b.dataset.type); });
    p.addEventListener('dragstart', (e) => { const b = e.target.closest('button.cap'); if (b) e.dataTransfer.setData('text/plain', b.dataset.type); });
    renderFlowMenu();
  }

  async function boot() {
    renderPalette();
    wire();
    applyView();
    let pal = 'closed';
    try { pal = localStorage.getItem('arcade-workbench.palette') === 'open' ? 'open' : 'closed'; } catch { /* closed */ }
    setPalette(pal);
    renderStart();
    renderInspector();
    const me = await App.ready;
    LAST = `arcade-workbench.last.${me.user.username}`;
    const banner = (text) => { $('banner').textContent = text; $('banner').hidden = false; };
    const src = me.arcade.source;
    S.cat.hasKey = src !== 'none';
    // No key yet: the small key box opens here, on the bench.
    if (!S.cat.hasKey) App.connectBox('arcade', { reason: 'Add an Arcade key to run steps. Without one you can still lay out a flow and see what Arcade allows.' });
    else {
      try { S.cat.categories = await App.categories(); S.cat.models = (await arcade('models/list', {})).items || []; }
      catch (e) {
        // Being told to slow down is not a bad key.
        if (e.status === 429) banner('Arcade is asking for fewer requests right now. Wait a few seconds, then reload the page.');
        else { App.arcadeRefused = true; App.renderChips(); banner(`Arcade did not accept the request. ${e.message}`); }
      }
    }
    renderStart();
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
    if (me.user.role === 'admin' && old?.flow?.nodes?.length) { if (old.view) S.view = old.view; applyView(); setFlow(old.flow, { keepView: Boolean(old.view) }); }
    else setFlow({ name: 'Untitled flow', nodes: [], edges: [] });
  }

  window.WB = { S, G, NODES, statusOf, checks, whyNot, runTo, runFlow, fork, addNode, connect, setFlow, appendFlow, openFlow, saveNow, fromTemplate, TEMPLATES, fit, select, setPalette, undo, redo };
  boot();
})();
