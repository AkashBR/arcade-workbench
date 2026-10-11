// The app around the bench: who is signed in, navigation, and the Runs, Models and keys,
// Prompts, Data and Docs pages. The bench itself is workbench.js.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const VIEWS = [['bench', 'Bench'], ['runs', 'Runs'], ['models', 'Models and keys'], ['prompts', 'Prompts'], ['data', 'Data'], ['docs', 'Docs']];

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try { res = await fetch('/api/' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new Error('The server is not reachable. Is `node server.js` still running?'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/login.html'; throw new Error('Signed out.'); }
    if (!res.ok) { const e = new Error(data.message || `Request failed (${res.status}).`); e.status = res.status; e.code = data.code; throw e; }
    return data;
  }
  let toastTimer;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 4600); }
  const dur = (ms) => (ms == null ? '' : (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + 's');
  const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const head = (title, lede, actions = '') => `<div class="page-head"><div><h1>${title}</h1><p class="lede">${lede}</p></div><div class="actions">${actions}</div></div>`;
  const stamp = (status, label) => `<span class="stamp" data-status="${status}">${esc(label)}</span>`;
  async function guard(box, fn) { try { await fn(); } catch (e) { if (e.message !== 'Signed out.') box.insertAdjacentHTML('beforeend', `<p class="msg bad">${esc(e.message)}</p>`); } }

  const App = { api, esc, toast, me: null, view: 'bench', onBench: [] };
  window.App = App;

  // Arcade's category list, read once and shared with the bench.
  let categoriesPromise = null;
  App.categories = () => (categoriesPromise = categoriesPromise || api('arcade/categories/list', { method: 'POST', body: {} }).then((r) => r.items || []).catch((e) => { categoriesPromise = null; throw e; }));
  async function materialsFor(categoryId) {
    if (!categoryId) return [];
    const r = await api('arcade/categories/get', { method: 'POST', body: { categoryId, selections: {} } });
    const opt = (r.options || []).find((o) => /material|metal/i.test(o.key + o.label)) || (r.options || [])[0];
    return opt ? opt.values.filter((v) => v.available).map((v) => v.label) : [];
  }
  async function suggest({ connectionId, world, categoryId, categoryName, idea, count = 4, materials }) {
    const mats = materials || (world === 'jewelry' ? await materialsFor(categoryId).catch(() => []) : []);
    return (await api('ai/suggest', { method: 'POST', body: { connectionId, world, category: categoryName || '', materials: mats, idea, count } })).suggestions;
  }
  const aiConnections = async () => (await api('connections')).connections.filter((c) => c.kind !== 'arcade');

  // ---------- keys on the page ----------
  // Two chips in the bar say whose key is in use. Clicking one opens a small box to change it.
  // Claude, OpenAI and Gemini are fully set up already, so a key is the only thing anyone adds.
  let conn = null; // what /api/connect last told us
  App.loadConnect = async () => (conn = await api('connect'));
  // Which model to use: the one marked as default, else the last one used, else the first connected.
  const DEFAULT_AI = 'arcade-workbench.ai.default', LAST_AI = 'arcade-workbench.ai';
  const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const remember = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* fine without it */ } };
  function preferredAi() {
    if (!conn) return null;
    return conn.ai.find((c) => c.id === recall(DEFAULT_AI)) || conn.ai.find((c) => c.id === recall(LAST_AI)) || conn.ai[0] || null;
  }
  // The model drop-down used wherever a model is chosen. Its last entry adds a key or changes the model, right there.
  function modelPicker(id, conns, selected) {
    const def = recall(DEFAULT_AI);
    return `<label>Model<select id="${id}" data-model-pick>${conns.length ? '' : '<option value="" selected disabled>No model connected yet</option>'}${conns.map((c) =>
      `<option value="${c.id}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}${c.model ? ' \u00b7 ' + esc(c.model) : ''}${c.id === def ? ' (default)' : ''}</option>`).join('')}<option value="__add">+ Add an API key or change the model\u2026</option></select></label>
      ${conns.length ? `<label class="choice"><input type="checkbox" data-model-default${selected && selected === def ? ' checked' : ''}><span>Use this model by default<small>Otherwise the last model you used comes first.</small></span></label>` : ''}`;
  }
  const whose = (mode) => (mode === 'host' ? 'company key' : 'your key');
  App.renderChips = function () {
    const box = $('keyChips');
    if (!box || !conn) return;
    const a = conn.arcade, m = preferredAi();
    box.innerHTML = `<button type="button" class="key" data-on="${a.source !== 'none' && !App.arcadeRefused}" data-connect="arcade" title="Change the Arcade key">${a.source === 'none' ? 'Arcade: add a key' : App.arcadeRefused ? 'Arcade: key refused' : `Arcade: ${whose(a.source)}`}</button>`
      + `<button type="button" class="key" data-on="${m ? (m.lastTest ? Boolean(m.lastTest.ok) : true) : 'none'}" data-connect="ai" title="Change the AI model used for prompt ideas">${m ? `${esc(m.name)}: ${whose(m.keyMode)}` : 'AI: add a key'}</button>`;
    box.onclick = (e) => { const b = e.target.closest('[data-connect]'); if (b) App.connectBox(b.dataset.connect); };
    if (App.onAiChange) App.onAiChange();
  };
  function connectForm(el, kind, { reason, onDone } = {}) {
    const icons = (window.ArcadeNodes && window.ArcadeNodes.ICONS) || {};
    const ic = (k) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${icons[k] || ''}</svg>`;
    const st = { provider: null, mode: 'own', key: '', busy: false, test: null, error: '', models: {} };
    const current = () => (kind === 'ai' ? conn.ai.find((x) => x.preset === st.provider) : null);
    const target = () => {
      if (kind === 'arcade') { const a = conn.arcade; return { name: 'Arcade', host: a.hostKeyAvailable, hasKey: a.hasOwnKey, hint: a.keyHint, mode: a.keyMode, keyUrl: a.keyUrl }; }
      const p = conn.providers.find((x) => x.id === st.provider), c = current();
      return { name: p.name, host: p.hostKeyAvailable, hasKey: Boolean(c && c.hasKey), hint: c && c.keyHint, mode: c ? c.keyMode : p.hostKeyAvailable ? 'host' : 'own', keyUrl: p.keyUrl };
    };
    const pickMode = () => { const t = target(); st.mode = t.mode === 'host' && t.host ? 'host' : 'own'; };
    if (kind === 'ai') { const pref = preferredAi(); st.provider = pref && conn.providers.some((p) => p.id === pref.preset) ? pref.preset : conn.providers[0].id; }
    pickMode();
    // Once a model is connected, its text models are read from the provider, so the list is always current.
    function modelRow() {
      const c = current();
      if (!c || !(c.hasKey || c.keyMode === 'host')) return '';
      const list = st.models[st.provider];
      if (list === undefined) {
        st.models[st.provider] = 'loading';
        const p = st.provider;
        api('connect/models?provider=' + p).then((r) => { st.models[p] = r.models; }).catch(() => { st.models[p] = []; }).finally(() => { if (el.isConnected) draw(); });
      }
      const ready = Array.isArray(list) && list.length;
      const names = ready ? (list.includes(c.model) || !c.model ? list : [c.model, ...list]) : [c.model || 'Picked when the key is tested'];
      return `<label class="cx-key">Model<select data-model${ready ? '' : ' disabled'}>${ready && !c.model ? '<option value="" selected disabled>Picked when the key is tested</option>' : ''}${names.map((m) => `<option${m === c.model ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select><span>${ready ? `${list.length} text models on this key. Image and audio models are left out until a step needs them.` : list === 'loading' || list === undefined ? 'Loading the models on this key…' : 'The provider did not return a model list.'}</span></label>
        <label class="cx-default"><input type="checkbox" data-cx-default${recall(DEFAULT_AI) === c.id ? ' checked' : ''}> Use ${esc(c.name)} by default</label>`;
    }
    function draw() {
      const t = target();
      el.innerHTML = `<div class="cx">
        ${reason ? `<p class="cx-why">${esc(reason)}</p>` : ''}
        ${kind === 'ai' ? `<div class="cx-label">Model maker</div><div class="cx-seg three">${conn.providers.map((p) => `<button type="button" class="cx-opt" data-provider="${p.id}" aria-pressed="${p.id === st.provider}"><b>${esc(p.name)}</b><small>${conn.ai.some((c) => c.preset === p.id) ? 'Connected' : 'Add a key'}</small></button>`).join('')}</div>` : ''}
        <div class="cx-label">Whose key?</div>
        <div class="cx-seg">
          <button type="button" class="cx-opt" data-mode="host" aria-pressed="${st.mode === 'host'}"${t.host ? '' : ' disabled'}>${ic('company')}<b>Company key</b><small>${t.host ? 'Already set up. Nothing to add.' : `Not set up for ${esc(t.name)}.`}</small></button>
          <button type="button" class="cx-opt" data-mode="own" aria-pressed="${st.mode === 'own'}">${ic('key')}<b>My own key</b><small>Stored encrypted. Only you use it.</small></button>
        </div>
        ${st.mode === 'own' ? `<label class="cx-key">${esc(t.name)} API key<input type="password" autocomplete="off" spellcheck="false" placeholder="${t.hasKey ? `Saved (${esc(t.hint)}). Paste a new one to replace it.` : 'Paste your key'}"><span>No key yet? <a href="${esc(t.keyUrl)}" target="_blank" rel="noopener">Get one from ${esc(t.name)}</a>.</span></label>` : ''}
        <div class="cx-foot"><button type="button" class="btn wire" data-save${st.busy ? ' disabled' : ''}>${st.busy ? 'Checking the key…' : 'Save and test'}</button>${st.test ? stamp(st.test.ok ? 'ok' : 'error', st.test.ok ? `Works · ${dur(st.test.ms)}` : 'Did not work') : ''}</div>
        ${st.test ? `<p class="msg ${st.test.ok ? 'ok' : 'bad'}">${esc(st.test.ok ? (kind === 'arcade' ? st.test.reply : `${t.name} answered. Using ${st.test.model}.`) : st.test.error)}</p>` : ''}
        ${st.error ? `<p class="msg bad">${esc(st.error)}</p>` : ''}
        ${kind === 'ai' ? modelRow() : ''}
        ${kind === 'ai' ? '<p class="cx-note">Everything else is already set. The model is used for prompt ideas. Other makers and custom endpoints are under Models and keys.</p>' : ''}
      </div>`;
      const input = el.querySelector('.cx-key input');
      if (input) input.value = st.key;
    }
    async function send(path, body) {
      Object.assign(st, { busy: true, error: '', test: null });
      draw();
      try {
        const r = await api(path, { method: 'POST', body });
        conn = r;
        Object.assign(st, { busy: false, test: r.test, key: '' });
        if (kind === 'arcade') App.arcadeRefused = !r.test.ok;
        else if (r.test.ok) remember(LAST_AI, r.connectionId);
        App.renderChips();
        draw();
        if (r.test.ok && onDone) onDone(r);
      } catch (err) { Object.assign(st, { busy: false, error: err.message }); draw(); }
    }
    el.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); el.querySelector('[data-save]').click(); } };
    el.onchange = (e) => {
      if (e.target.matches('[data-model]')) send('connect/model', { provider: st.provider, model: e.target.value });
      if (e.target.matches('[data-cx-default]')) { const c = current(); remember(DEFAULT_AI, e.target.checked && c ? c.id : ''); App.renderChips(); draw(); }
    };
    el.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled || !el.contains(b)) return;
      const input = el.querySelector('.cx-key input');
      if (input) st.key = input.value;
      if (b.dataset.provider) {
        Object.assign(st, { provider: b.dataset.provider, test: null, error: '', key: '' });
        pickMode();
        // Picking a maker that is already connected makes it the one in use.
        const picked = current();
        if (picked) { remember(LAST_AI, picked.id); App.renderChips(); }
        return draw();
      }
      if (b.dataset.mode) { Object.assign(st, { mode: b.dataset.mode, test: null, error: '' }); return draw(); }
      if (!('save' in b.dataset)) return;
      const t = target();
      if (st.mode === 'own' && !st.key.trim() && !t.hasKey) { st.error = `Paste your ${t.name} key first.`; return draw(); }
      delete st.models[st.provider];
      send('connect', { provider: kind === 'arcade' ? 'arcade' : st.provider, keyMode: st.mode, apiKey: st.mode === 'own' ? st.key.trim() : '' });
    };
    draw();
  }
  // The same form, placed inside a page instead of a box. Used by the Design step's panel.
  App.connectInline = async function (el, opts = {}) {
    try { if (!conn) await App.loadConnect(); } catch (e) { el.textContent = e.message; return; }
    connectForm(el, 'ai', opts);
  };
  App.aiLabel = function () { const m = preferredAi(); return m ? `${m.name} · ${m.model || 'model picked on first test'}` : 'none yet. Open this to add a key'; };
  App.hasAi = () => Boolean(preferredAi());
  // One prompt from the model in use, for filling a step's prompt box in place. Whatever is already in the box is the idea.
  App.suggestOne = async function ({ world, categoryId, categoryName, materials, idea }) {
    const m = preferredAi();
    if (!m) { const e = new Error('Add an API key first.'); e.code = 'NO_MODEL'; throw e; }
    remember(LAST_AI, m.id);
    const list = await suggest({ connectionId: m.id, world: world || 'print', categoryId, categoryName, idea, count: 1, materials });
    if (!list.length) throw new Error('The model returned nothing. Press it again.');
    return { prompt: list[0].prompt, model: `${m.name} · ${m.model}` };
  };
  App.aiInfo = function () { const m = preferredAi(); return m ? { name: m.name, model: m.model || 'model picked on first test', whose: whose(m.keyMode), preset: m.preset } : null; };
  // The small box. For Arcade the page reloads on close after a change, so the new key's catalogue is read.
  App.connectBox = async function (kind, { reason, onDone, onClose } = {}) {
    try { if (!conn) await App.loadConnect(); } catch (e) { return toast(e.message); }
    const d = $('dlg');
    let changed = false;
    d.className = 'narrow';
    d.innerHTML = `<form method="dialog"><h2>${kind === 'arcade' ? 'Arcade key' : 'AI model'}</h2><div class="dlg-body" id="cxBody"></div><menu><button class="btn ghost" value="">Done</button></menu></form>`;
    connectForm($('cxBody'), kind, { reason, onDone: (r) => { changed = true; if (onDone) onDone(r); } });
    d.onclick = null;
    d.onclose = () => { d.className = ''; if (changed && kind === 'arcade') return location.reload(); if (onClose) onClose(); };
    d.returnValue = '';
    d.showModal();
  };

  // ---------- navigation ----------
  function renderNav() {
    $('nav').innerHTML = '<div class="brand"><b>Workbench</b><span>for the Arcade API</span></div>'
      + VIEWS.map(([id, label]) => `<a class="tab" href="#${id}" data-view="${id}">${label}</a>`).join('')
      + `<span class="spacer"></span><span class="who">${esc(App.me.user.username)}${App.me.user.role === 'admin' ? ' · admin' : ''}</span><button class="out" id="signOut">Sign out</button>`;
    $('signOut').onclick = async () => { await api('logout', { method: 'POST', body: {} }).catch(() => {}); location.href = '/login.html'; };
  }
  function route() {
    const id = (location.hash || '#bench').slice(1);
    const view = VIEWS.some((v) => v[0] === id) ? id : 'bench';
    App.view = view;
    if ($('dlg').open) $('dlg').close();
    document.body.dataset.view = view;
    document.querySelectorAll('#nav a.tab').forEach((a) => { if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.id === 'page-' + view));
    if (view === 'bench') App.onBench.forEach((fn) => fn());
    else guard($('page-' + view), PAGES[view]);
  }

  // ---------- Runs ----------
  let runFilter = 'all';
  const share = (r) => `<div class="share-cell"><div class="share" role="img" aria-label="${r.ok} worked, ${r.failed} failed" title="${r.ok} worked, ${r.failed} failed">${r.ok ? `<i class="w" style="flex:${r.ok}"></i>` : ''}${r.failed ? `<i class="f" style="flex:${r.failed}"></i>` : ''}</div><b>${r.rate}%</b></div>`;
  async function pageRuns() {
    const box = $('page-runs');
    const top = head('Runs', 'Every step you run on the bench is recorded here: what worked, what did not, and why.',
      '<button class="btn ghost" data-act="refresh">Refresh</button><button class="btn ghost" data-act="clear">Clear history</button>');
    if (!box.dataset.loaded) box.innerHTML = top + '<p class="muted">Loading…</p>';
    const { stats: s, runs } = await api('runs');
    box.dataset.loaded = '1';
    if (!s.total) {
      box.innerHTML = top + '<div class="empty-note"><b>No runs yet</b>Run a step on the <a href="#bench">bench</a> and it is recorded here, with how long it took and what Arcade said.</div>';
    } else {
      const table = (rows, first, withEndpoint) => `<div class="table-wrap"><table class="grid"><thead><tr><th>${first}</th><th class="num">Runs</th><th class="num">Worked</th><th class="num">Failed</th><th>Success</th><th class="num">Typical time</th></tr></thead><tbody>${rows.map((r) =>
        `<tr><td><b>${esc(r.label.title)}</b>${withEndpoint && r.label.endpoint ? `<span class="sub">${esc(r.label.endpoint)}</span>` : ''}</td><td class="num">${r.total}</td><td class="num">${r.ok}</td><td class="num">${r.failed}</td><td>${share(r)}</td><td class="num">${r.medianMs == null ? '–' : dur(r.medianMs)}</td></tr>`).join('')}</tbody></table></div>`;
      const list = runs.filter((r) => runFilter === 'all' || (runFilter === 'ok') === (r.status === 'ok'));
      box.innerHTML = top
        + `<div class="tiles"><div class="tile"><div class="label">Success rate</div><div class="value">${s.rate}%</div><div class="sub">${s.ok} of ${s.total} step runs worked</div></div>
            <div class="tile"><div class="label">Step runs</div><div class="value">${s.total}</div><div class="sub">across ${s.byFlow.length} flow${s.byFlow.length === 1 ? '' : 's'}</div></div>
            <div class="tile"><div class="label">Worked</div><div class="value">${s.ok}</div><div class="sub">finished and returned a result</div></div>
            <div class="tile"><div class="label">Failed</div><div class="value">${s.failed}</div><div class="sub">${s.failed ? 'reasons are listed below' : 'nothing has failed'}</div></div></div>`
        + `<h2>By step</h2>${table(s.byStep, 'Step', true)}`
        + `<h2>By flow</h2>${table(s.byFlow, 'Flow', false)}`
        + (s.failures.length ? `<h2>Why steps failed</h2><ul class="reasons">${s.failures.map((f) => `<li><b>${f.count}×</b><span>${esc(f.reason)}</span></li>`).join('')}</ul>` : '')
        + `<h2>History</h2><div class="chips">${[['all', `All ${runs.length}`], ['ok', 'Worked'], ['failed', 'Failed']].map(([k, l]) => `<button class="chip" data-filter="${k}" aria-pressed="${runFilter === k}">${l}</button>`).join('')}</div>
           <div class="history">${list.map((r) => `<div class="run-row">${stamp(r.status === 'ok' ? 'ok' : 'error', r.status === 'ok' ? `Worked${r.ms != null ? ' · ' + dur(r.ms) : ''}` : `Failed${r.httpStatus ? ' · ' + r.httpStatus : ''}`)}
             <div class="what"><b>${esc(r.title)}</b> <span>${esc(r.flowName || 'Unsaved flow')}${r.world ? ' · ' + esc(r.world) : ''}</span></div><div class="when">${esc(when(r.startedAt))}</div>
             ${r.status === 'ok' ? (r.summary ? `<div class="detail">${esc(r.summary)}</div>` : '') : `<div class="detail bad">${esc(r.error || 'Unknown error')}</div>`}</div>`).join('') || '<p class="muted">Nothing matches that filter.</p>'}</div>`
        + (runs.length >= 300 ? '<p class="muted">Showing the latest 300. The totals above count everything.</p>' : '');
    }
    box.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act, filter = e.target.closest('[data-filter]')?.dataset.filter;
      if (filter) { runFilter = filter; return guard(box, pageRuns); }
      if (act === 'refresh') return guard(box, pageRuns);
      if (act === 'clear' && confirm('Clear your run history? Flows and results on the bench are not affected.')) { await api('runs', { method: 'DELETE' }); guard(box, pageRuns); }
    };
  }

  // ---------- Models and keys ----------
  const M = { conns: [], presets: [], arcadeHost: false, sel: 'arcade', draft: null, last: {} };
  const testStamp = (t) => (t ? stamp(t.ok ? 'ok' : 'error', t.ok ? `Worked · ${dur(t.ms)}` : `Failed${t.status ? ' · ' + t.status : ''}`) : stamp('idle', 'Not tested'));
  const arcadeConn = () => M.conns.find((c) => c.kind === 'arcade') || { id: null, kind: 'arcade', name: 'Arcade', keyMode: M.arcadeHost ? 'host' : 'own', hasKey: false, lastTest: null };
  const keyLine = (c, hostOk) => (c.keyMode === 'host' && hostOk ? 'Using the company key' : c.hasKey ? `Your own key <code>${esc(c.keyHint)}</code>` : hostOk && c.kind === 'arcade' ? 'Using the company key' : 'No key yet');
  async function pageModels() {
    const box = $('page-models');
    const [p, c] = await Promise.all([api('presets'), api('connections')]);
    Object.assign(M, { presets: p.presets, arcadeHost: p.arcadeHostKeyAvailable, conns: c.connections });
    const models = M.conns.filter((x) => x.kind !== 'arcade'), arc = arcadeConn();
    const item = (x, id, meta) => `<button class="conn" data-sel="${id}" aria-current="${M.sel === id}"><b>${esc(x.name)}</b>${testStamp(x.lastTest)}<span class="meta">${meta}</span></button>`;
    box.innerHTML = head('Models and keys', 'Connect Arcade and any AI model. Keys are stored encrypted on the server and never sent back to the browser.')
      + `<div class="split"><div>
          <h3>Arcade</h3><div class="conn-list">${item(arc, 'arcade', keyLine(arc, M.arcadeHost))}</div>
          <h3>AI models</h3><div class="conn-list">${models.map((x) => item(x, x.id, `${esc(x.model || 'no model chosen')} · ${keyLine(x, M.presets.find((q) => q.id === x.preset)?.hostKeyAvailable)}`)).join('')
            || '<div class="empty-note"><b>No models connected</b>Add one below to get prompt ideas from it. Bring your own key, or use the company key if one is set up.</div>'}</div>
          <h3>Add a model</h3><div class="presets">${M.presets.map((q) => `<button class="btn ghost small" data-preset="${q.id}">${esc(q.name)}</button>`).join('')}</div>
        </div><aside class="side card" id="connSide"></aside></div>
        <h2>Stores</h2><p class="lede">The shops you list products in. Connect each one once here; the List in a store and Store orders steps then only choose from them.</p>
        <div id="storesBox" style="margin-top:12px"><p class="muted">Loading\u2026</p></div>
        <h2>API watch</h2><p class="lede">A background check on the server. It compares Arcade’s published API and each maker’s model list with what it saw last time, and says what changed.</p>
        <div id="watchBox" style="margin-top:12px"><p class="muted">Loading…</p></div>`;
    renderConnSide();
    renderStores();
    renderWatch();
    box.onclick = (e) => {
      const sel = e.target.closest('[data-sel]')?.dataset.sel, preset = e.target.closest('[data-preset]')?.dataset.preset;
      if (sel) { M.sel = sel; M.draft = null; guard(box, pageModels); }
      if (preset) {
        const q = M.presets.find((x) => x.id === preset);
        M.sel = 'new';
        M.draft = { id: null, kind: q.kind, preset: q.id, name: q.name.replace(/ \(.*\)$/, ''), baseUrl: q.baseUrl, model: q.model, keyMode: q.hostKeyAvailable ? 'host' : 'own', hasKey: false, lastTest: null };
        box.querySelectorAll('.conn').forEach((b) => b.setAttribute('aria-current', 'false'));
        renderConnSide();
      }
    };
  }
  // Connected stores, on the same page as the other keys.
  async function renderStores() {
    const box = $('storesBox');
    if (!box) return;
    try {
      storesPromise = null;
      const list = await App.stores();
      if (!$('storesBox')) return;
      $('storesBox').innerHTML = `<div class="history">${list.map((s) => `<div class="run-row">${stamp(s.lastTest && s.lastTest.ok ? 'ok' : 'idle', s.lastTest && s.lastTest.ok ? 'Connected' : 'Not tested')}<div class="what"><b>${esc(s.name)}</b> <span>${esc(s.platformName)}</span></div><div class="when"><button class="btn ghost small" data-store-del="${esc(s.id)}">Remove</button></div><div class="detail">${esc(s.url)} · key <code>${esc(s.hint || 'saved')}</code></div></div>`).join('')
        || '<div class="empty-note"><b>No store connected</b>Connect a WooCommerce or Shopify store to list products in it and to turn its orders into Arcade checkouts.</div>'}</div>
        <div class="row" style="display:flex;gap:12px;align-items:center;margin-top:12px"><button class="btn" data-store-add>Connect a store</button><span class="muted">Keys are stored encrypted and never sent back to this page.</span></div>`;
      $('storesBox').onclick = async (e) => {
        if (e.target.closest('[data-store-add]')) return App.storeBox({ onClose: renderStores });
        const del = e.target.closest('[data-store-del]');
        if (del && confirm('Remove this store from the workbench? Listings already in the store stay there.')) { await api('stores/' + del.dataset.storeDel, { method: 'DELETE' }); renderStores(); }
      };
    } catch (e) { if ($('storesBox')) $('storesBox').innerHTML = `<p class="msg bad">${esc(e.message)}</p>`; }
  }
  const WATCH_WORD = { ok: ['ok', 'No change'], changed: ['stale', 'Changed'], action: ['blocked', 'Needs a look'], error: ['error', 'Check failed'], skipped: ['waiting', 'Not checked'] };
  async function renderWatch(run) {
    const box = $('watchBox');
    if (!box) return;
    try {
      const w = await api(run ? 'watch/run' : 'watch', run ? { method: 'POST', body: {} } : {});
      if (!$('watchBox')) return;
      $('watchBox').innerHTML = `<div class="history">${w.checks.map((c) => { const [st, word] = WATCH_WORD[c.status] || ['idle', c.status]; return `<div class="run-row">${stamp(st, word)}<div class="what"><b>${esc(c.label)}</b></div><div class="when">${esc(when(c.checkedAt))}</div><div class="detail">${esc(c.summary || '')}${c.changes.length ? `<ul class="watch-changes">${c.changes.map((x) => `<li class="${x.level === 'action' ? 'act' : ''}">${esc(x.text)}</li>`).join('')}</ul>` : ''}</div></div>`; }).join('')
        || '<div class="empty-note"><b>Not run yet</b>The first check runs a few seconds after the server starts.</div>'}</div>
        <div class="row" style="display:flex;gap:12px;align-items:center;margin-top:12px"><button class="btn ghost" data-act="watch">Check now</button><span class="muted">${w.everyHours > 0 ? `Runs by itself every ${w.everyHours} hours.` : 'Scheduled checks are off on this server.'}</span></div>`;
      $('watchBox').onclick = (e) => { if (e.target.closest('[data-act="watch"]')) { e.target.closest('button').disabled = true; e.target.closest('button').textContent = 'Checking…'; renderWatch(true); } };
    } catch (e) { if ($('watchBox')) $('watchBox').insertAdjacentHTML('beforeend', `<p class="msg bad">${esc(e.message)}</p>`); }
  }
  function renderConnSide() {
    const side = $('connSide');
    const c = M.sel === 'arcade' ? arcadeConn() : M.sel === 'new' ? M.draft : M.conns.find((x) => x.id === M.sel);
    if (!c) { M.sel = 'arcade'; return renderConnSide(); }
    const isArcade = c.kind === 'arcade', preset = M.presets.find((q) => q.id === c.preset);
    const hostOk = isArcade ? M.arcadeHost : Boolean(preset?.hostKeyAvailable), noKey = Boolean(preset?.noKey);
    const keyUrl = isArcade ? 'https://studio.arcade.ai/settings/api-keys' : preset?.keyUrl;
    const last = M.last[c.id || M.sel];
    side.innerHTML = `<h2 style="margin-top:0">${esc(c.id || isArcade ? c.name : 'New: ' + c.name)}</h2>
      <form class="form" id="connForm">
        ${isArcade ? '<p class="help">Every step on the bench calls Arcade with this key.</p>' : `
        <label>Name<input type="text" name="name" value="${esc(c.name)}" maxlength="60" required></label>
        <label>Base URL<input type="url" name="baseUrl" value="${esc(c.baseUrl || '')}" placeholder="https://api.example.com/v1" required></label>
        <label>Model<input type="text" name="model" value="${esc(c.model || '')}" list="modelList" placeholder="Load the list, or type a model ID" autocomplete="off"></label><datalist id="modelList"></datalist>
        <div class="row"><button type="button" class="btn ghost small" data-act="models">Load models from the provider</button><span class="help" id="modelsMsg"></span></div>`}
        ${noKey ? '<p class="help">This one runs on your machine and needs no key.</p>' : `
        <label class="choice"><input type="radio" name="keyMode" value="own"${c.keyMode !== 'host' || !hostOk ? ' checked' : ''}><span>Use my own key<small>Stored encrypted on this server. Only you can use it.</small></span></label>
        <label class="choice"><input type="radio" name="keyMode" value="host"${c.keyMode === 'host' && hostOk ? ' checked' : ''}${hostOk ? '' : ' disabled'}><span>Use the company key<small>${hostOk ? 'Already set up, so you can start without your own.' : 'No company key is set up for this provider.'}</small></span></label>
        <label>API key<input type="password" name="apiKey" autocomplete="off" spellcheck="false" placeholder="${c.hasKey ? `Saved (${esc(c.keyHint)}). Type to replace it.` : 'Paste your key'}"></label>
        ${keyUrl ? `<p class="help">No key yet? <a href="${esc(keyUrl)}" target="_blank" rel="noopener">Get one from ${esc(isArcade ? 'Arcade Studio' : preset.name)}</a>, then paste it here.</p>` : ''}`}
        <div class="row"><button class="btn wire" type="submit">Save</button>${c.id ? `<button type="button" class="btn ghost" data-act="delete">${isArcade ? 'Remove my key' : 'Delete'}</button>` : ''}</div>
        <p class="msg" id="connMsg" hidden></p>
      </form>
      <h3>Test it</h3>
      <div class="form">
        ${isArcade ? '' : '<label>Prompt<textarea id="testPrompt">Reply with the single word: ready</textarea></label>'}
        <div class="row"><button class="btn" data-act="test">${c.id || isArcade ? (isArcade ? 'Test the key' : 'Send test') : 'Save and test'}</button><span id="testOut">${last ? testStamp(last) : ''}</span></div>
        <pre class="reply${last && !last.ok ? ' bad' : ''}" id="testReply"${last ? '' : ' hidden'}>${last ? esc(last.ok ? last.reply : last.error) : ''}</pre>
      </div>`;
    const form = $('connForm'), msg = (text, cls) => { const m = $('connMsg'); m.textContent = text; m.className = 'msg ' + cls; m.hidden = false; };
    const fields = () => { const f = new FormData(form); return { kind: c.kind, preset: c.preset, name: f.get('name') || c.name, baseUrl: f.get('baseUrl') || c.baseUrl, model: f.get('model') ?? c.model, keyMode: f.get('keyMode') || 'own', apiKey: f.get('apiKey') || '' }; };
    async function save() {
      const body = fields();
      const saved = c.id ? await api('connections/' + c.id, { method: 'PUT', body }) : await api('connections', { method: 'POST', body });
      if (M.sel === 'new') M.sel = saved.id;
      M.draft = null;
      return saved;
    }
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { await save(); await pageModels(); toast('Saved.'); if (isArcade) App.onKeyChange && App.onKeyChange(); } catch (err) { msg(err.message, 'bad'); }
    };
    side.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      e.preventDefault();
      try {
        if (act === 'delete') {
          if (!confirm(isArcade ? 'Remove your Arcade key from this server?' : `Delete the connection “${c.name}”?`)) return;
          await api('connections/' + c.id, { method: 'DELETE' });
          M.sel = 'arcade';
          await pageModels();
          if (isArcade) App.onKeyChange && App.onKeyChange();
        } else if (act === 'models') {
          $('modelsMsg').textContent = 'Loading…';
          const saved = await save();
          const { models } = await api(`connections/${saved.id}/models`, { method: 'POST', body: {} });
          await pageModels();
          $('modelList').innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
          $('modelsMsg').textContent = models.length ? `${models.length} models. Click the Model box to pick one.` : 'The provider returned no models.';
        } else if (act === 'test') {
          const prompt = $('testPrompt')?.value;
          $('testOut').innerHTML = stamp('running', 'Testing');
          const saved = await save();
          const r = await api(`connections/${saved.id}/test`, { method: 'POST', body: { prompt } });
          M.last[saved.id] = r;
          if (isArcade) M.last.arcade = r;
          await pageModels();
        }
      } catch (err) { msg(err.message, 'bad'); const out = $('testOut'); if (out) out.innerHTML = ''; }
    };
  }

  // ---------- Prompts ----------
  const P = { prompts: [], conns: [], cats: [], editing: null, ideas: [], form: { world: 'jewelry', categoryId: '', idea: '', connectionId: '' }, busy: false, error: '' };
  const promptCard = (p, acts) => `<div class="prompt"><div class="top"><b>${esc(p.title)}</b>${p.world ? `<span class="tag ${p.world}">${p.world}</span>` : ''}${p.source === 'ai' ? '<span class="tag ai">from a model</span>' : ''}</div><p>${esc(p.text || p.prompt)}</p><div class="acts">${acts}</div></div>`;
  async function pagePrompts() {
    const box = $('page-prompts');
    const [pr, conns, cats] = await Promise.all([api('prompts'), aiConnections(), App.categories().catch(() => [])]);
    Object.assign(P, { prompts: pr.prompts, conns, cats });
    if (!conn) await App.loadConnect().catch(() => {});
    if (!P.form.connectionId || !conns.some((c) => c.id === P.form.connectionId)) P.form.connectionId = (preferredAi() && conns.find((c) => c.id === preferredAi().id) ? preferredAi().id : conns[0]?.id) || '';
    const catsFor = cats.filter((c) => c.world === P.form.world);
    const e = P.editing;
    box.innerHTML = head('Prompts', 'Keep the prompts that work, and ask a connected model for new ones. Use them from the Design step on the bench.', '<button class="btn" data-act="new">New prompt</button>')
      + `<div class="split"><div>
          ${e ? `<form class="form card" id="promptForm" style="margin-bottom:12px"><label>Title<input type="text" name="title" value="${esc(e.title || '')}" maxlength="80" placeholder="Hammered silver band"></label>
            <label>Prompt<textarea name="text" maxlength="1000" required placeholder="A 925 sterling silver ring with a wide hammered band, no stones">${esc(e.text || '')}</textarea></label>
            <label>For<select name="world"><option value="">Either</option><option value="jewelry"${e.world === 'jewelry' ? ' selected' : ''}>Jewelry</option><option value="print"${e.world === 'print' ? ' selected' : ''}>Print</option></select></label>
            <div class="row"><button class="btn wire" type="submit">${e.id ? 'Save changes' : 'Save prompt'}</button><button type="button" class="btn ghost" data-act="cancel">Cancel</button></div></form>` : ''}
          <div class="prompt-list">${P.prompts.map((p) => promptCard(p, `<button class="btn ghost small" data-copy="${p.id}">Copy</button><button class="btn ghost small" data-edit="${p.id}">Edit</button><button class="btn ghost small" data-del="${p.id}">Delete</button>`)).join('')
            || (e ? '' : '<div class="empty-note"><b>No prompts saved yet</b>Write one with New prompt, or ask a model for ideas on the right and save the ones you like.</div>')}</div>
        </div><aside class="side card">
          <h2 style="margin-top:0">Get ideas</h2>
          ${`<div class="form">
            ${modelPicker('ideaConn', conns, P.form.connectionId)}
            <label>For<select id="ideaWorld"><option value="jewelry"${P.form.world === 'jewelry' ? ' selected' : ''}>Jewelry</option><option value="print"${P.form.world === 'print' ? ' selected' : ''}>Print goods</option></select></label>
            <label>Category<select id="ideaCat"><option value="">Any</option>${catsFor.map((c) => `<option value="${esc(c.categoryId)}"${c.categoryId === P.form.categoryId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
            <label>Your idea, in a few words<textarea id="ideaText" placeholder="Minimal signet rings for a Gen-Z brand">${esc(P.form.idea)}</textarea></label>
            <div class="row"><button class="btn wire" data-act="suggest"${P.busy || !conns.length ? ' disabled' : ''}>${P.busy ? 'Asking the model…' : 'Suggest prompts'}</button></div>
            ${conns.length ? '' : '<p class="help">Open the Model list and choose “Add an API key”. Claude, OpenAI and Gemini are ready; only a key is needed.</p>'}
            ${P.error ? `<p class="msg bad">${esc(P.error)}</p>` : ''}
            <p class="help">The model is told Arcade’s rules, such as naming one metal the category can be made in.</p>
          </div>`}
          ${P.ideas.length ? `<h3>Suggestions</h3><div class="prompt-list">${P.ideas.map((s, i) => promptCard({ ...s, text: s.prompt }, `<button class="btn small" data-keep="${i}">Save to library</button><button class="btn ghost small" data-copyidea="${i}">Copy</button>`)).join('')}</div>` : ''}
        </aside></div>`;
    const keep = () => { if ($('ideaText')) Object.assign(P.form, { idea: $('ideaText').value, world: $('ideaWorld').value, categoryId: $('ideaCat').value, connectionId: $('ideaConn').value === '__add' ? P.form.connectionId : $('ideaConn').value }); };
    box.onchange = (ev) => {
      if (ev.target.matches('[data-model-pick]')) {
        if (ev.target.value === '__add') { keep(); return App.connectBox('ai', { onDone: (r) => { P.form.connectionId = r.connectionId; }, onClose: () => guard(box, pagePrompts) }); }
        keep(); remember(LAST_AI, P.form.connectionId); App.renderChips(); guard(box, pagePrompts);
      }
      if (ev.target.matches('[data-model-default]')) { keep(); remember(DEFAULT_AI, ev.target.checked ? P.form.connectionId : ''); App.renderChips(); guard(box, pagePrompts); }
    };
    if ($('ideaWorld')) $('ideaWorld').onchange = (ev) => { ev.stopPropagation(); keep(); P.form.categoryId = ''; guard(box, pagePrompts); };
    if ($('promptForm')) $('promptForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target), body = { title: f.get('title'), text: f.get('text'), world: f.get('world') };
      keep();
      await api(P.editing.id ? 'prompts/' + P.editing.id : 'prompts', { method: P.editing.id ? 'PUT' : 'POST', body });
      P.editing = null;
      guard(box, pagePrompts);
    };
    box.onclick = async (ev) => {
      const t = ev.target.closest('button');
      if (!t) return;
      const d = t.dataset;
      keep();
      try {
        if (d.act === 'connect') return App.connectBox('ai', { onDone: () => guard(box, pagePrompts) });
        if (d.act === 'new') { P.editing = { world: '' }; return guard(box, pagePrompts); }
        if (d.act === 'cancel') { P.editing = null; return guard(box, pagePrompts); }
        if (d.edit) { P.editing = { ...P.prompts.find((p) => p.id === d.edit) }; return guard(box, pagePrompts); }
        if (d.del && confirm('Delete this prompt?')) { await api('prompts/' + d.del, { method: 'DELETE' }); return guard(box, pagePrompts); }
        if (d.copy) { await navigator.clipboard.writeText(P.prompts.find((p) => p.id === d.copy).text); return toast('Copied.'); }
        if (d.copyidea) { await navigator.clipboard.writeText(P.ideas[Number(d.copyidea)].prompt); return toast('Copied.'); }
        if (d.keep) {
          const s = P.ideas[Number(d.keep)];
          await api('prompts', { method: 'POST', body: { title: s.title, text: s.prompt, world: P.form.world, source: 'ai' } });
          P.ideas.splice(Number(d.keep), 1);
          toast('Saved to your library.');
          return guard(box, pagePrompts);
        }
        if (d.act === 'suggest') {
          P.busy = true; P.error = '';
          guard(box, pagePrompts);
          remember(LAST_AI, P.form.connectionId);
          try { P.ideas = await suggest({ connectionId: P.form.connectionId, world: P.form.world, categoryId: P.form.categoryId, categoryName: P.cats.find((c) => c.categoryId === P.form.categoryId)?.name, idea: P.form.idea, count: 4 }); }
          catch (err) { P.error = err.message; }
          P.busy = false;
          return guard(box, pagePrompts);
        }
      } catch (err) { toast(err.message); }
    };
  }

  // The dialog the Design step opens: pick a saved prompt, or ask a model for ideas that fit the step's category.
  App.promptDialog = async function ({ tab, world, categoryId, categoryName, materials, onUse }) {
    const d = $('dlg');
    const st = { tab: tab || 'lib', prompts: [], conns: [], ideas: [], busy: false, error: '', idea: '', conn: '' };
    try { [st.prompts, st.conns] = await Promise.all([api('prompts').then((r) => r.prompts), aiConnections()]); } catch (e) { return toast(e.message); }
    st.conn = (preferredAi() && st.conns.find((c) => c.id === preferredAi().id) ? preferredAi().id : st.conns[0]?.id) || '';
    const mine = st.prompts.filter((p) => !world || !p.world || p.world === world);
    function draw() {
      const body = st.tab === 'lib'
        ? `<div class="pick-list">${mine.map((p, i) => promptCard(p, `<button type="button" class="btn small" data-use-lib="${i}">Use this prompt</button>`)).join('')
            || '<div class="empty-note"><b>Nothing saved for this yet</b>Save prompts on the Prompts page, or ask a model here.</div>'}</div>`
        : !st.conns.length || st.adding ? '<div id="pdConnect"></div>'
          : `<div class="form">${modelPicker('pdConn', st.conns, st.conn)}
              <label>Your idea, in a few words<textarea id="pdIdea" placeholder="Leave empty for a spread of options">${esc(st.idea)}</textarea></label>
              <div class="row"><button type="button" class="btn wire" data-go${st.busy ? ' disabled' : ''}>${st.busy ? 'Asking the model…' : 'Suggest prompts'}</button><span class="help">${world ? `For ${esc(categoryName || world)}${world === 'jewelry' ? ', one metal each' : ''}.` : ''}</span></div>
              ${st.error ? `<p class="msg bad">${esc(st.error)}</p>` : ''}</div>
            <div class="pick-list" style="margin-top:12px">${st.ideas.map((s, i) => promptCard({ ...s, text: s.prompt }, `<button type="button" class="btn small" data-use-idea="${i}">Use this prompt</button><button type="button" class="btn ghost small" data-keep="${i}">Save to library</button>`)).join('')}</div>`;
      d.className = 'wide';
      d.innerHTML = `<form method="dialog"><h2>Prompts</h2><div class="dlg-tabs"><button type="button" class="chip" data-tab="lib" aria-pressed="${st.tab === 'lib'}">Your library</button><button type="button" class="chip" data-tab="ai" aria-pressed="${st.tab === 'ai'}">Ask a model</button></div>
        <div class="dlg-body">${body}</div><menu><button class="btn ghost" value="">Close</button></menu></form>`;
      // No model yet: the same small key box, right here, then straight on to ideas.
      if ($('pdConnect')) connectForm($('pdConnect'), 'ai', { reason: 'Connect a model to get prompt ideas. Only a key is needed.', onDone: async (r) => { st.conns = await aiConnections(); st.conn = r.connectionId; st.adding = false; draw(); } });
    }
    draw();
    d.onclose = () => { d.className = ''; d.onclick = null; d.onchange = null; };
    d.onchange = (e) => {
      if (e.target.matches('[data-model-pick]')) {
        if ($('pdIdea')) st.idea = $('pdIdea').value;
        if (e.target.value === '__add') { st.adding = true; return draw(); }
        st.conn = e.target.value; remember(LAST_AI, st.conn); App.renderChips(); draw();
      }
      if (e.target.matches('[data-model-default]')) { remember(DEFAULT_AI, e.target.checked ? st.conn : ''); App.renderChips(); draw(); }
    };
    d.onclick = async (e) => {
      const t = e.target.closest('button, a');
      if (!t) return;
      const ds = t.dataset;
      if ($('pdIdea')) { st.idea = $('pdIdea').value; if ($('pdConn').value !== '__add') st.conn = $('pdConn').value; }
      if (ds.tab) { st.tab = ds.tab; return draw(); }
      if ('close' in ds) return d.close();
      if (ds.useLib) { onUse(mine[Number(ds.useLib)].text); return d.close(); }
      if (ds.useIdea) { onUse(st.ideas[Number(ds.useIdea)].prompt); return d.close(); }
      if (ds.keep) {
        const s = st.ideas[Number(ds.keep)];
        try { await api('prompts', { method: 'POST', body: { title: s.title, text: s.prompt, world, source: 'ai' } }); toast('Saved to your library.'); } catch (err) { toast(err.message); }
        return;
      }
      if ('go' in ds) {
        st.busy = true; st.error = ''; draw();
        try { st.ideas = await suggest({ connectionId: st.conn, world: world || 'print', categoryId, categoryName, idea: st.idea, count: 4, materials }); }
        catch (err) { st.error = err.message; }
        st.busy = false; draw();
      }
    };
    d.returnValue = '';
    d.showModal();
  };

  // ---------- stores ----------
  // WooCommerce and Shopify shops a product can be listed in. Connected from the step that uses them.
  let storesPromise = null;
  App.stores = () => (storesPromise = storesPromise || api('stores').then((r) => { App.storePlatforms = r.platforms; return r.stores; }).catch((e) => { storesPromise = null; throw e; }));
  App.storeBox = async function ({ onDone, onClose } = {}) {
    try { await App.stores(); } catch (e) { return toast(e.message); }
    const d = $('dlg');
    const st = { platform: App.storePlatforms[0].id, busy: false, error: '', vals: {} };
    const read = () => d.querySelectorAll('[data-f]').forEach((i) => { st.vals[i.dataset.f] = i.value; });
    function draw() {
      const p = App.storePlatforms.find((x) => x.id === st.platform);
      d.className = 'narrow';
      d.innerHTML = `<form method="dialog"><h2>Connect a store</h2><div class="dlg-body"><div class="cx">
        <div class="cx-label">Which kind of store?</div>
        <div class="cx-seg">${App.storePlatforms.map((x) => `<button type="button" class="cx-opt" data-platform="${x.id}" aria-pressed="${x.id === st.platform}"><b>${esc(x.name)}</b><small>${x.id === 'woocommerce' ? 'Shops on WordPress' : 'Shops on myshopify.com'}</small></button>`).join('')}</div>
        <label class="cx-key">Store address<input type="text" data-f="url" autocomplete="off" spellcheck="false" placeholder="${esc(p.urlHint)}"></label>
        ${p.fields.map((f) => `<label class="cx-key">${esc(f.label)}<input type="${f.plain ? 'text' : 'password'}" data-f="${f.key}" autocomplete="off" spellcheck="false" placeholder="${esc(f.hint)}"></label>`).join('')}
        <p class="cx-note">${esc(p.where)} Keys are stored encrypted on the server and never sent back to this page.</p>
        <div class="cx-foot"><button type="button" class="btn wire" data-save${st.busy ? ' disabled' : ''}>${st.busy ? 'Checking the store…' : 'Connect and test'}</button></div>
        ${st.error ? `<p class="msg bad">${esc(st.error)}</p>` : ''}
      </div></div><menu><button class="btn ghost" value="">Close</button></menu></form>`;
      for (const [k, v] of Object.entries(st.vals)) { const i = d.querySelector(`[data-f="${k}"]`); if (i) i.value = v; }
    }
    draw();
    d.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); d.querySelector('[data-save]').click(); } };
    d.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.platform) { Object.assign(st, { platform: b.dataset.platform, error: '', vals: {} }); return draw(); }
      if (!('save' in b.dataset)) return;
      read();
      Object.assign(st, { busy: true, error: '' });
      draw();
      try {
        const r = await api('stores', { method: 'POST', body: { platform: st.platform, ...st.vals } });
        storesPromise = null;
        toast(`${r.store.name} is connected. ${r.test.reply}`);
        if (onDone) onDone(r.store);
        d.close();
      } catch (err) { Object.assign(st, { busy: false, error: err.message }); draw(); }
    };
    d.onclose = () => { d.className = ''; d.onclick = null; d.onkeydown = null; if (onClose) onClose(); };
    d.returnValue = '';
    d.showModal();
  };

  // ---------- Data ----------
  async function pageData() {
    const box = $('page-data');
    const d = await api('data');
    const size = d.sizeBytes > 1048576 ? (d.sizeBytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(d.sizeBytes / 1024)) + ' KB';
    box.innerHTML = head('Data', 'Everything you make here is kept in one database on the server, under your account.', '<button class="btn" data-act="export">Download my data</button>')
      + `<div class="tiles">${[['Flows', d.counts.flows], ['Step runs', d.counts.runs], ['Prompts', d.counts.prompts], ['Connections', d.counts.connections]].map(([l, v]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('')}</div>
        <h2>Where it lives</h2>
        <div class="card"><dl class="facts" style="margin:0"><dt>Database</dt><dd>${esc(d.engine)}${d.isDefault ? ' · the one that ships with the workbench' : ' · connected by the admin'}</dd><dt>File</dt><dd class="mono">${esc(d.path)}</dd><dt>Size</dt><dd>${size}</dd>${d.people != null ? `<dt>People</dt><dd>${d.people} account${d.people === 1 ? '' : 's'}</dd>` : ''}</dl></div>
        <h2>Connect a different database</h2>
        ${d.isAdmin ? `<form class="form card" id="dbForm"><p class="help" style="font-size:13.5px">Point the workbench at another SQLite file, for example one on a shared or backed-up disk. A new file is created empty. Accounts live in the database, so everyone signs in again after the switch.</p>
            <label>Path to a .db or .sqlite file<input type="text" name="path" placeholder="/Users/you/data/team-workbench.db" spellcheck="false" required></label>
            <div class="row"><button class="btn wire" type="submit">Connect</button></div><p class="msg" id="dbMsg" hidden></p>
            <p class="help">Postgres and hosted databases are not supported yet.</p></form>`
          : '<div class="card"><p class="lede">Only the admin can point the workbench at a different database.</p></div>'}`;
    box.onclick = async (e) => {
      if (e.target.closest('[data-act="export"]')) {
        const data = await api('data/export');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        a.download = `workbench-${App.me.user.username}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
    };
    if ($('dbForm')) $('dbForm').onsubmit = async (e) => {
      e.preventDefault();
      const m = $('dbMsg');
      try {
        await api('data/connect', { method: 'POST', body: { path: new FormData(e.target).get('path') } });
        m.textContent = 'Connected. Taking you to sign in again.'; m.className = 'msg ok'; m.hidden = false;
        setTimeout(() => { location.href = '/login.html'; }, 1200);
      } catch (err) { m.textContent = err.message; m.className = 'msg bad'; m.hidden = false; }
    };
  }

  // ---------- Docs ----------
  async function pageDocs() {
    const box = $('page-docs');
    if (box.dataset.loaded) return;
    box.innerHTML = await (await fetch('/docs.html')).text();
    box.dataset.loaded = '1';
  }

  const PAGES = { runs: pageRuns, models: pageModels, prompts: pagePrompts, data: pageData, docs: pageDocs };
  App.ready = api('me').then(async (me) => {
    App.me = me;
    renderNav();
    await App.loadConnect().catch(() => {});
    App.renderChips();
    route();
    window.addEventListener('hashchange', route);
    return me;
  });
})();
