// The "Model shots" step for the bench. It is a thin front for Studio: the same routes, the same choices.
// Loaded after nodes.js and before workbench.js, so the step is in the catalogue when the bench starts.
(function () {
  'use strict';
  const A = window.ArcadeNodes, App = window.App;
  if (!A || !App) return;
  const esc = App.esc;
  let options = null;
  App.ready.then(() => App.api('studio/options')).then((o) => { options = o; }).catch(() => {});

  A.ICONS.modelShots = '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.500 7l1.300-2.500h4.400L15.500 7"/><circle cx="12" cy="13.500" r="3.500"/>';
  if (!A.GROUPS.includes('Photos')) A.GROUPS.splice(Math.max(0, A.GROUPS.indexOf('Sell')), 0, 'Photos');

  const pieceType = (title) => (/earring/i.test(title) ? 'earrings' : /necklace|pendant|chain/i.test(title) ? 'necklace' : /ring|band/i.test(title) ? 'ring' : 'print');
  // What kind of piece will arrive: read it off the product if it exists, otherwise off the category feeding the flow.
  function typeFor(n, g) {
    let src = g.source(n, 'product');
    const title = src?.node.out?.product?.title;
    if (title) return pieceType(title);
    for (let cur = src?.node, hops = 0; cur && hops < 8; hops++) {
      if (cur.type === 'category') return cur.cfg.categoryName ? pieceType(cur.cfg.categoryName) : 'ring';
      src = g.source(cur, 'category') || g.source(cur, 'product') || g.source(cur, 'pattern');
      cur = src?.node;
    }
    return g.worldOf(n) === 'print' ? 'print' : 'ring';
  }
  const pick = (list, id) => (options?.[list] || []).find((x) => x.id === id);

  A.NODES.modelShots = {
    type: 'modelShots', title: 'Model shots', group: 'Photos', endpoint: 'studio · images/edits', worlds: ['print', 'jewelry'], cost: 'create',
    blurb: 'Puts the piece on a model in the poses you pick. The Arcade render is the reference, so the piece stays the one Arcade will make.',
    rules: [
      'It needs a product. That product’s Arcade render is the reference image for every shot.',
      'It needs an OpenAI key. Shots are made with OpenAI’s GPT Image 2.5 model, one at a time. That model is set for you.',
      'Each pose is one image, and each image is billed to that key.',
      'Check every shot against the original. If the piece changed, redo or edit the shot in Studio.',
      'Shots are kept in Studio, where you can approve, edit, redo and download them.',
    ],
    // The image model this step uses, shown at the top of its setup. It is set by default; OPENAI_IMAGE_MODEL on the server changes it.
    madeWith: () => (options?.image ? { maker: 'openai', name: 'OpenAI', model: options.image.model, ready: options.image.ready } : null),
    inputs: [{ key: 'product', type: 'product', label: 'Product' }],
    outputs: [{ key: 'shots', type: 'shots', label: 'Shots' }],
    fields: [
      { key: 'poses', kind: 'chips', label: 'Poses. One image each.', multi: true, options: (n, g) => options?.poses[typeFor(n, g)] || [] },
      { key: 'wearer', kind: 'chips', label: 'Who wears it', default: 'woman', options: () => options?.wearers || [] },
      { key: 'skin', kind: 'chips', label: 'Skin tone', default: 'any', options: () => options?.skin || [] },
      { key: 'background', kind: 'chips', label: 'Background', default: 'studio', options: () => options?.backgrounds || [] },
      { key: 'shape', kind: 'chips', label: 'Shape', default: 'square', options: () => options?.shapes || [] },
      { key: 'direction', kind: 'textarea', label: 'Direction, in your own words', max: 600, placeholder: 'Optional. Mood, styling, framing.' },
    ],
    summary: (n) => `${n.cfg.poses?.length ? n.cfg.poses.length + ' poses' : 'First three poses'} · ${pick('wearers', n.cfg.wearer)?.label || 'Woman'} · ${pick('backgrounds', n.cfg.background)?.label || 'Soft studio'}`,
    world: (n, g) => g.inWorld(n, 'product') ?? null,
    check: () => (options && !options.image.ready ? [{ level: 'block', text: 'Add an OpenAI key to make model shots. Open Studio to add it.' }] : []),
    run: async (n, inp) => {
      n.progress = 'Reading the piece';
      const shoot = await App.api('studio/shoots', { method: 'POST', body: { productId: inp.product.productId } });
      const fits = shoot.poses.map((p) => p.id);
      let poses = (n.cfg.poses || []).filter((p) => fits.includes(p));
      if (!poses.length) poses = fits.slice(0, 3);
      const items = [];
      for (let i = 0; i < poses.length; i++) {
        n.progress = `Making shot ${i + 1} of ${poses.length}`;
        const s = await App.api(`studio/shoots/${shoot.id}/shots`, { method: 'POST', body: { pose: poses[i], wearer: n.cfg.wearer, skin: n.cfg.skin, background: n.cfg.background, shape: n.cfg.shape, direction: n.cfg.direction } });
        items.push({ id: s.id, label: s.label, url: s.url });
      }
      return { shots: { shootId: shoot.id, title: shoot.title, sourceUrl: shoot.sourceUrl, items } };
    },
    preview: (n) => {
      const s = n.out.shots;
      if (!s) return '';
      return `<div class="st-strip">${s.items.slice(0, 4).map((x) => `<img src="${esc(x.url)}" alt="${esc(x.label)}" title="${esc(x.label)}">`).join('')}${s.items.length > 4 ? `<span>+${s.items.length - 4}</span>` : ''}</div>`;
    },
    result: (n) => {
      const s = n.out.shots;
      if (!s) return '';
      return `<p class="lede">${s.items.length} shot${s.items.length === 1 ? '' : 's'} of ${esc(s.title)}. Compare each one with the original before you use it.</p>
        <div class="st-result"><figure><img src="${esc(s.sourceUrl)}" alt="The original render"><figcaption>Original from Arcade</figcaption></figure>${s.items.map((x) =>
          `<figure><img src="${esc(x.url)}" alt="${esc(x.label)}"><figcaption>${esc(x.label)}</figcaption></figure>`).join('')}</div>
        <p style="margin-top:12px"><a class="btn ghost" style="text-decoration:none" href="/studio.html?shoot=${encodeURIComponent(s.shootId)}">Approve, edit or redo in Studio</a></p>`;
    },
  };

  // A way into Studio from the main navigation.
  App.ready.then(() => {
    const nav = document.getElementById('nav'), spacer = nav && nav.querySelector('.spacer');
    if (!spacer || nav.querySelector('[data-studio]')) return;
    const a = document.createElement('a');
    a.className = 'tab'; a.href = '/studio.html'; a.textContent = 'Studio'; a.dataset.studio = '1';
    nav.insertBefore(a, spacer);
  }).catch(() => {});
})();
