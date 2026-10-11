// Studio: choose a piece, say who wears it and how, get one image per pose, then approve, edit or redo each.
// It talks only to /api/studio/* (lib/studio.js), so it can change without touching the bench.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  const dur = (ms) => (ms == null ? '' : Math.round(ms / 1000) + 's');

  const S = { opt: null, products: null, productsError: '', shoots: [], shoot: null, plan: null, poses: new Set(), jobs: [], busy: false, editing: null, keyMsg: '', ready: {}, own: {}, promptPose: null, promptError: '' };

  // ---------- drawing ----------
  const chips = (name, list, value) => `<div class="chips-pick" data-set="${name}">${list.map((o) =>
    `<button type="button" class="chip" data-v="${esc(o.id)}" aria-pressed="${o.id === value}">${o.swatch ? `<i class="sw" style="background:${esc(o.swatch)}"></i>` : ''}${esc(o.label)}</button>`).join('')}</div>`;
  const step = (n, title, body, note = '') => `<section class="st-step"><h2><span>${n}</span>${title}</h2>${note ? `<p class="st-note">${note}</p>` : ''}${body}</section>`;

  function pieceHtml() {
    if (S.shoot) {
      const s = S.shoot;
      return `<div class="st-piece"><img src="${esc(s.sourceUrl)}" alt="The original render"><div><b>${esc(s.title)}</b><span>${esc(s.material || '')}${s.price ? ' · ' + esc(s.price) : ''}</span><span class="tag ${s.type === 'print' ? 'print' : 'jewelry'}">${esc(s.type)}</span></div><button class="btn ghost small" data-act="change">Change</button></div>`;
    }
    const past = S.shoots.length ? `<h3>Carry on with a shoot</h3><div class="st-pick">${S.shoots.map((x) => `<button type="button" data-shoot="${esc(x.id)}"><img loading="lazy" src="${esc(x.coverUrl)}" alt=""><span>${esc(x.title)}</span><small>${x.count} shot${x.count === 1 ? '' : 's'}</small></button>`).join('')}</div>` : '';
    const list = S.products == null ? '<p class="muted">Loading your products…</p>'
      : S.productsError ? `<p class="msg bad">${esc(S.productsError)}</p>`
      : S.products.length ? `<div class="st-pick">${S.products.map((p) => `<button type="button" data-product="${esc(p.productId)}"><img loading="lazy" src="${esc(p.imageUrl || '')}" alt=""><span>${esc(p.title)}</span><small>${esc(p.selectionLabel || '')}</small></button>`).join('')}</div>`
      : '<div class="empty-note"><b>No products yet</b>Make one on the <a href="/#bench">bench</a> first: a Design step with a category builds a product.</div>';
    return `${past}<h3>${S.shoots.length ? 'Or start with a product from Arcade' : 'Products on your Arcade account'}</h3>${list}`;
  }
  function keyHtml() {
    const im = S.opt.image;
    if (im.ready) return `<p class="st-note">Made with OpenAI (${esc(im.model)}), on ${im.source === 'own' ? 'your own key' : 'the company key'}. Each image is billed to that key.</p>`;
    return `<div class="st-key card"><b>One thing first: an OpenAI key</b><p>Model shots are made with OpenAI’s image model. Everything else is already set up.</p>
      <div class="form"><label>Your OpenAI API key<input type="password" id="stKey" autocomplete="off" spellcheck="false" placeholder="Paste your key"></label>
      <div class="row"><button class="btn wire" data-act="savekey">Save and test</button>${im.companyKeyAvailable ? '<button class="btn ghost" data-act="companykey">Use the company key</button>' : ''}<a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">Get a key</a></div>
      ${S.keyMsg ? `<p class="msg bad">${esc(S.keyMsg)}</p>` : ''}</div></div>`;
  }
  // ---------- the prompt ----------
  // Each pose has a ready-made prompt, built on the server from the piece and the choices. It is shown so it
  // can be read before anything is made, and rewritten: a pose with its own text uses that instead.
  const chosenPoses = () => (S.shoot ? S.shoot.poses.filter((x) => S.poses.has(x.id)) : []);
  const activePose = () => chosenPoses().find((x) => x.id === S.promptPose) || chosenPoses()[0] || null;
  const promptKey = (poseId) => JSON.stringify([S.shoot.id, poseId, S.plan.wearer, S.plan.skin, S.plan.age, S.plan.background, S.plan.light, S.plan.shape, S.plan.look]);
  function wantPrompt() {
    const pose = activePose();
    if (!pose || S.promptError) return;
    const key = promptKey(pose.id);
    if (S.ready[key]) return;
    S.ready[key] = { loading: true };
    api(`studio/shoots/${S.shoot.id}/prompt`, { method: 'POST', body: { pose: pose.id, ...S.plan, direction: '' } })
      .then((r) => { S.ready[key] = r; })
      .catch((e) => { delete S.ready[key]; S.promptError = e.message; })
      .finally(() => { if (document.activeElement?.id !== 'stPrompt' && document.activeElement?.id !== 'stDirection') draw(); });
  }
  function promptHtml() {
    const picked = chosenPoses(), pose = activePose();
    if (!pose) return '<p class="st-note">Pick a pose above to see its prompt.</p>';
    if (S.promptError) return `<p class="st-note">The prompt could not be loaded: ${esc(S.promptError)} Shots still use the ready-made prompt.</p>`;
    const ready = S.ready[promptKey(pose.id)];
    if (!ready || ready.loading) return '<p class="st-note">Writing the prompt…</p>';
    const own = S.own[pose.id];
    const tabs = picked.length > 1 ? `<div class="chips-pick st-ptabs">${picked.map((x) => `<button type="button" class="chip" data-ppose="${esc(x.id)}" aria-pressed="${x.id === pose.id}">${esc(x.label)}${S.own[x.id] ? ' · yours' : ''}</button>`).join('')}</div>` : '';
    return `${tabs}<div class="st-prompt" data-own="${own ? 'true' : 'false'}" data-pose="${esc(pose.id)}">
        <div class="st-phead"><b class="is-ready">Ready-made for this piece and your choices</b><b class="is-own">Your own prompt for “${esc(pose.label)}”</b><button type="button" class="btn ghost small is-own" data-act="readyprompt">Back to the ready-made one</button></div>
        <textarea id="stPrompt" maxlength="2400" spellcheck="true" aria-label="Prompt for ${esc(pose.label)}">${esc(own || ready.scene)}</textarea>
        <p class="st-note">Change any of it and this pose uses your words. Changing a choice above rewrites the ready-made one.</p>
        <p class="st-guard"><b>Always added, so the piece stays the one Arcade makes</b>${esc(ready.guard)}</p>
      </div>`;
  }

  // The plan starts on a recommended setup, so a shoot can be made without choosing anything.
  const firstPoses = () => (S.shoot ? S.shoot.poses.slice(0, 3).map((p) => p.id) : []);
  function onRecommended() {
    const d = S.opt.defaults, p = S.plan, first = firstPoses();
    return Object.keys(d).every((k) => p[k] === d[k]) && !(p.direction || '').trim()
      && S.poses.size === first.length && first.every((id) => S.poses.has(id)) && !Object.keys(S.own).length;
  }
  function presetHtml() {
    const d = S.opt.defaults, o = S.opt, on = onRecommended();
    const label = (list, id) => (list || []).find((x) => x.id === id)?.label;
    const what = [`First ${firstPoses().length === 3 ? 'three' : firstPoses().length} poses`, label(o.wearers, d.wearer), label(o.backgrounds, d.background), label(o.lights, d.light), label(o.shapes, d.shape)].filter(Boolean).join(' · ');
    return `<div class="preset-bar" data-on="${on}"><b>${on ? 'Recommended setup is on' : 'You changed the setup'}</b>${on ? '' : '<button type="button" class="btn ghost small" data-act="recommended">Use recommended</button>'}<p>${esc(what)}. ${on ? 'Make the shots as it is, or change anything below.' : 'One click puts the recommended choices back.'}</p></div>`;
  }
  function setupHtml() {
    const s = S.shoot, p = S.plan, o = S.opt;
    if (!s) return step(1, 'The piece', pieceHtml(), 'The Arcade render is the reference for every shot, so the piece stays the one Arcade will make.');
    const anyModel = s.poses.some((x) => S.poses.has(x.id) && x.needs === 'model');
    const count = S.poses.size;
    return step(1, 'The piece', pieceHtml())
      + presetHtml()
      + step(2, 'Poses', `<div class="st-poses">${s.poses.map((x) => `<button type="button" class="st-pose" data-pose="${esc(x.id)}" aria-pressed="${S.poses.has(x.id)}"><i aria-hidden="true"></i><b>${esc(x.label)}</b><small>${x.needs === 'model' ? 'On a model' : 'Piece only'}</small></button>`).join('')}</div>`, 'Pick as many as you want. Each one becomes one image.')
      + step(3, 'Who wears it', `<div class="tp-label">Model</div>${chips('wearer', o.wearers, p.wearer)}<div class="tp-label">Skin tone</div>${chips('skin', o.skin, p.skin)}<div class="tp-label">Age</div>${chips('age', o.ages, p.age)}
          <label class="st-check"><input type="checkbox" id="stSame"${p.consistent ? ' checked' : ''}><span>Keep the same model in every pose</span></label>`, anyModel ? '' : 'None of the poses you picked has a model in it, so this is not used.')
      + step(4, 'The look', `${o.looks ? `<div class="tp-label">Ready-made look. One click sets the mood.</div>${chips('look', o.looks, p.look || 'none')}` : ''}<div class="tp-label">Background</div>${chips('background', o.backgrounds, p.background)}<div class="tp-label">Light</div>${chips('light', o.lights, p.light)}<div class="tp-label">Shape</div>${chips('shape', o.shapes, p.shape)}`)
      + step(5, 'The prompt', promptHtml(), `This is what OpenAI’s image model (${esc(o.image.model)}) is asked for. It is ready to use as it is.`)
      + step(6, 'Anything to add', `<textarea id="stDirection" maxlength="600" placeholder="Optional. Mood, styling, framing, anything the choices above do not cover.">${esc(p.direction || '')}</textarea>`)
      + `<div class="st-go">${keyHtml()}<button class="btn wire" data-act="make"${S.busy || !count || !o.image.ready ? ' disabled' : ''}>${S.busy ? 'Making shots…' : count ? `Make ${count} shot${count === 1 ? '' : 's'}` : 'Pick a pose'}</button>${count && o.image.ready ? `<span class="st-note">One at a time, about a minute each.</span>` : ''}</div>`;
  }
  function shotCard(x) {
    const state = x.approved === true ? 'ok' : x.approved === false ? 'error' : 'ready';
    const word = x.approved === true ? 'Approved' : x.approved === false ? 'Does not match' : 'To review';
    const editing = S.editing === x.id;
    return `<article class="st-shot" data-shot="${esc(x.id)}">
      <a href="${esc(x.url)}" target="_blank" rel="noopener"><img src="${esc(x.url)}" alt="${esc(x.label)}"></a>
      <div class="st-meta"><b>${esc(x.label)}</b><span class="stamp" data-status="${state}">${word}</span></div>
      ${x.note ? `<p class="st-note">Edited: ${esc(x.note)}</p>` : ''}
      <div class="st-acts"><button class="btn small${x.approved === true ? '' : ' ghost'}" data-act="approve">${x.approved === true ? 'Approved' : 'Matches the piece'}</button><button class="btn ghost small" data-act="reject">Does not match</button></div>
      <div class="st-acts"><button class="btn ghost small" data-act="edit">Edit</button><button class="btn ghost small" data-act="redo">Redo</button><a class="btn ghost small" href="${esc(x.url)}" download="${esc((S.shoot.title + ' ' + x.label).replace(/[^\w]+/g, '-').toLowerCase())}.png">Download</a><button class="btn ghost small" data-act="remove">Remove</button></div>
      ${editing ? `<div class="st-edit"><textarea id="stEdit" placeholder="Say what to change. For example: warmer light, hand a little lower."></textarea><div class="st-acts"><button class="btn small" data-act="doedit">Make the edit</button><button class="btn ghost small" data-act="canceledit">Cancel</button></div></div>` : ''}
      <details><summary>Prompt sent</summary><p>${esc(x.prompt)}</p></details>
    </article>`;
  }
  const jobCard = (j) => `<article class="st-shot${j.error ? ' failed' : j.started ? ' making' : ' waiting'}"><div class="st-wait">${j.error ? '' : '<i></i>'}</div><div class="st-meta"><b>${esc(j.label)}</b><span class="stamp" data-status="${j.error ? 'error' : j.started ? 'running' : 'waiting'}">${j.error ? 'Failed' : j.started ? `Making ${Math.round((Date.now() - j.started) / 1000)}s` : 'Waiting'}</span></div>${j.error ? `<p class="msg bad">${esc(j.error)}</p><div class="st-acts"><button class="btn ghost small" data-dismiss="${j.id}">Dismiss</button></div>` : ''}</article>`;
  function resultsHtml() {
    const s = S.shoot;
    if (!s) return '<div class="empty-note"><b>Nothing to show yet</b>Choose a piece on the left. Its shots appear here, next to the original so you can compare.</div>';
    const shots = s.shots || [], ok = shots.filter((x) => x.approved === true).length;
    return `<div class="st-head"><div><h1>${esc(s.title)}</h1><p class="lede">${shots.length ? `${shots.length} shot${shots.length === 1 ? '' : 's'}, ${ok} approved. Compare each with the original before you use it.` : 'No shots yet. Pick poses on the left and make them.'}</p></div>
        <div class="actions">${ok ? '<button class="btn ghost" data-act="dl">Download approved</button><button class="btn ghost" data-act="csv" title="A spreadsheet of the approved shots: name, shot, link">Export list</button>' : ''}<button class="btn ghost" data-act="deleteshoot">Delete shoot</button></div></div>
      <div class="st-grid"><article class="st-shot original"><img src="${esc(s.sourceUrl)}" alt="The original render"><div class="st-meta"><b>Original from Arcade</b><span class="stamp">Reference</span></div><p class="st-note">This is what gets made. A shot is only usable if the piece in it matches this.</p></article>
        ${S.jobs.map(jobCard).join('')}${shots.slice().reverse().map(shotCard).join('')}</div>
      <details class="st-how"><summary>What goes in, and what comes out</summary><ul><li><b>In:</b> one Arcade product (its render, name, material), your poses and look, and your direction.</li><li><b>Out:</b> one image per pose, each with the exact prompt that made it.</li><li><b>After:</b> approve what matches, edit or redo what doesn’t, and download. On the bench, the Model shots step takes a Product and hands these shots on.</li></ul></details>`;
  }
  function draw() {
    // Keep what is typed in the two free-text boxes across redraws.
    if ($('stDirection') && S.plan) S.plan.direction = $('stDirection').value;
    const editText = $('stEdit') ? $('stEdit').value : '';
    $('studio').innerHTML = `<aside class="st-setup">${setupHtml()}</aside><section class="st-results">${resultsHtml()}</section>`;
    if ($('stEdit')) { $('stEdit').value = editText; }
    if (S.shoot) wantPrompt();
  }

  // ---------- doing ----------
  async function openShoot(shoot) {
    S.shoot = shoot;
    S.plan = { ...S.opt.defaults, direction: '' };
    S.poses = new Set(shoot.poses.slice(0, 3).map((p) => p.id));
    S.jobs = []; S.editing = null; S.ready = {}; S.own = {}; S.promptPose = null; S.promptError = '';
    history.replaceState(null, '', `/studio.html?shoot=${encodeURIComponent(shoot.id)}`);
    draw();
  }
  async function pump() {
    if (S.busy) return;
    S.busy = true;
    const tick = setInterval(draw, 1000);
    try {
      for (;;) {
        const job = S.jobs.find((j) => !j.started && !j.error);
        if (!job) break;
        job.started = Date.now(); draw();
        try {
          const shot = await api(job.path, { method: 'POST', body: job.body });
          S.shoot.shots.push(shot);
          S.jobs = S.jobs.filter((j) => j !== job);
        } catch (e) { job.error = e.message; if (e.code === 'NO_IMAGE_MODEL' || /key/i.test(e.message)) S.opt = await api('studio/options').catch(() => S.opt); }
        draw();
      }
    } finally { clearInterval(tick); S.busy = false; draw(); }
  }
  const queue = (label, path, body) => { S.jobs.push({ id: String(Date.now()) + Math.random(), label, path, body }); pump(); };

  $('studio').addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-act]');
    if (!t) return;
    const d = t.dataset, card = t.closest('[data-shot]'), shot = card && S.shoot?.shots.find((x) => x.id === card.dataset.shot);
    try {
      if (d.product) { t.disabled = true; return openShoot(await api('studio/shoots', { method: 'POST', body: { productId: d.product } })); }
      if (d.shoot) return openShoot(await api('studio/shoots/' + d.shoot));
      if (d.pose) { if (S.poses.has(d.pose)) S.poses.delete(d.pose); else S.poses.add(d.pose); return draw(); }
      if (d.ppose) { S.promptPose = d.ppose; return draw(); }
      if (d.v) {
        const set = t.parentElement.dataset.set;
        S.plan[set] = d.v;
        // A look brings its own background and light; changing either by hand afterwards keeps the look's styling line.
        if (set === 'look') { const look = (S.opt.looks || []).find((x) => x.id === d.v); if (look?.background) S.plan.background = look.background; if (look?.light) S.plan.light = look.light; }
        return draw();
      }
      if (d.dismiss) { S.jobs = S.jobs.filter((j) => j.id !== d.dismiss); return draw(); }
      switch (d.act) {
        case 'recommended': S.plan = { ...S.opt.defaults, direction: '' }; S.poses = new Set(firstPoses()); S.own = {}; return draw();
        case 'readyprompt': { const p = activePose(); if (p) delete S.own[p.id]; return draw(); }
        case 'change': S.shoot = null; S.shoots = (await api('studio/shoots')).shoots; history.replaceState(null, '', '/studio.html'); return draw();
        case 'make': {
          S.plan.direction = $('stDirection').value; S.plan.consistent = $('stSame').checked;
          for (const p of S.shoot.poses.filter((x) => S.poses.has(x.id))) queue(p.label, `studio/shoots/${S.shoot.id}/shots`, { pose: p.id, ...S.plan, ...(S.own[p.id] ? { prompt: S.own[p.id] } : {}) });
          return;
        }
        case 'savekey': case 'companykey': {
          const key = $('stKey').value.trim();
          if (d.act === 'savekey' && !key) { S.keyMsg = 'Paste your key first.'; return draw(); }
          t.disabled = true; S.keyMsg = '';
          const r = await api('connect', { method: 'POST', body: { provider: 'openai', keyMode: d.act === 'companykey' ? 'host' : 'own', apiKey: key } });
          if (r.test && !r.test.ok) S.keyMsg = r.test.error || 'OpenAI did not accept that key.';
          S.opt = await api('studio/options');
          return draw();
        }
        case 'approve': Object.assign(shot, await api('studio/shots/' + shot.id, { method: 'PUT', body: { approved: shot.approved === true ? null : true } })); return draw();
        case 'reject': Object.assign(shot, await api('studio/shots/' + shot.id, { method: 'PUT', body: { approved: shot.approved === false ? null : false } })); return draw();
        case 'edit': S.editing = shot.id; draw(); return $('stEdit').focus();
        case 'canceledit': S.editing = null; return draw();
        case 'doedit': { const text = $('stEdit').value.trim(); if (!text) return toast('Say what to change.'); S.editing = null; return queue(`${shot.label}, edited`, `studio/shots/${shot.id}/edit`, { instruction: text }); }
        case 'redo': return queue(shot.label, `studio/shoots/${S.shoot.id}/shots`, { pose: shot.pose, ...shot.plan });
        case 'remove': if (!confirm('Remove this shot?')) return; await api('studio/shots/' + shot.id, { method: 'DELETE' }); S.shoot.shots = S.shoot.shots.filter((x) => x !== shot); return draw();
        case 'csv': {
          // One row per approved shot, for a listing sheet or a store import.
          const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
          const rows = [['piece', 'material', 'price', 'shot', 'image']].concat(S.shoot.shots.filter((y) => y.approved === true).map((x) => [S.shoot.title, S.shoot.material || '', S.shoot.price || '', x.label, new URL(x.url, location.href).href]));
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
          a.download = `${S.shoot.title.replace(/[^\w]+/g, '-').toLowerCase()}-approved-shots.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          return;
        }
        case 'dl': for (const x of S.shoot.shots.filter((y) => y.approved === true)) { const a = document.createElement('a'); a.href = x.url; a.download = `${(S.shoot.title + ' ' + x.label).replace(/[^\w]+/g, '-').toLowerCase()}.png`; a.click(); await new Promise((r) => setTimeout(r, 300)); } return;
        case 'deleteshoot': if (!confirm('Delete this shoot and all its shots? The product on Arcade is not affected.')) return; await api('studio/shoots/' + S.shoot.id, { method: 'DELETE' }); S.shoot = null; S.shoots = (await api('studio/shoots')).shoots; history.replaceState(null, '', '/studio.html'); return draw();
      }
    } catch (err) { if (err.message !== 'Signed out.') toast(err.message); draw(); }
  });
  // Typing in the prompt box: the pose keeps its own text as soon as it differs from the ready-made one.
  $('studio').addEventListener('input', (e) => {
    if (e.target.id !== 'stPrompt' || !S.shoot) return;
    const box = e.target.closest('.st-prompt'), poseId = box.dataset.pose, ready = S.ready[promptKey(poseId)];
    const mine = e.target.value.trim() && e.target.value !== ready?.scene;
    if (mine) S.own[poseId] = e.target.value; else delete S.own[poseId];
    box.dataset.own = String(Boolean(mine));
  });
  $('studio').addEventListener('change', (e) => { if (e.target.id === 'stSame' && S.plan) S.plan.consistent = e.target.checked; });

  (async function boot() {
    try {
      const me = await api('me');
      $('who').textContent = me.user.username + (me.user.role === 'admin' ? ' · admin' : '');
      [S.opt, S.shoots] = await Promise.all([api('studio/options'), api('studio/shoots').then((r) => r.shoots)]);
      const q = new URLSearchParams(location.search);
      if (q.get('shoot')) return openShoot(await api('studio/shoots/' + q.get('shoot')));
      if (q.get('product')) return openShoot(await api('studio/shoots', { method: 'POST', body: { productId: q.get('product') } }));
      draw();
      try { S.products = (await api('arcade/products/list', { method: 'POST', body: { limit: 48 } })).items || []; }
      catch (e) { S.products = []; S.productsError = e.message; }
      if (!S.shoot) draw();
    } catch (e) { if (e.message !== 'Signed out.') $('studio').innerHTML = `<p class="msg bad" style="padding:24px">${esc(e.message)}</p>`; }
  })();
})();
