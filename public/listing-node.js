// The "Listing page" step for the bench.
// Arcade's checkout page is Arcade's own: it shows Arcade's picture of the product and nothing can be added to it.
// This step puts a page in front of it instead: the product, its model shots, the price, and a Buy button
// that opens Arcade's checkout. It reads what the steps before it made and calls nothing itself.
// Loaded after nodes.js and before workbench.js, so the step is in the catalogue when the bench starts.
(function () {
  'use strict';
  const A = window.ArcadeNodes, App = window.App;
  if (!A) return;
  const esc = (App && App.esc) || ((s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const money = (p) => (p ? (p.currency === 'USD' ? '$' : '') + Number(p.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (p.currency === 'USD' ? '' : ' ' + p.currency) : '');
  // The listing travels to the page inside the link, so the page needs nothing saved on the server.
  const pack = (listing) => btoa(unescape(encodeURIComponent(JSON.stringify(listing)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const linkFor = (listing) => `/listing.html#${pack(listing)}`;

  A.ICONS.listing = '<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><rect x="7" y="6.5" width="10" height="6" rx="1"/><path d="M7 15.500h10M7 18h5"/>';

  A.NODES.listing = {
    type: 'listing', title: 'Listing page', group: 'Sell', endpoint: 'workbench · listing', worlds: ['print', 'jewelry'], cost: 'read',
    blurb: 'Puts the product, its model shots, the price and the buy link on one page you can show.',
    rules: [
      'Arcade’s checkout page shows Arcade’s own picture of the product. Model shots cannot be added to it.',
      'This page sits in front of the checkout: your shots, the price, and a Buy button that opens Arcade’s checkout.',
      'Connect Model shots to show them. Without them the page shows Arcade’s picture alone.',
      'Connect a Checkout link to switch the Buy button on.',
      'The page opens in this browser while you are signed in. It is not public yet.',
    ],
    inputs: [
      { key: 'product', type: 'product', label: 'Product' },
      { key: 'shots', type: 'shots', label: 'Shots', optional: true },
      { key: 'checkout', type: 'checkout', label: 'Checkout', optional: true },
    ],
    outputs: [{ key: 'listing', type: 'listing', label: 'Listing' }],
    fields: [{ key: 'name', kind: 'text', label: 'Listing name', placeholder: 'Leave empty to use the product’s name' }],
    summary: (n) => (n.out?.listing ? `${n.out.listing.shots.length} model shot${n.out.listing.shots.length === 1 ? '' : 's'} · ${n.out.listing.checkoutUrl ? 'Buy button on' : 'no buy link yet'}` : 'Product, shots and buy link on one page'),
    world: (n, g) => g.inWorld(n, 'product') ?? null,
    check: (n, g) => {
      const notes = [];
      if (!g.connected(n, 'shots')) notes.push({ level: 'warn', text: 'No Model shots connected, so the page will show Arcade’s picture alone.' });
      if (!g.connected(n, 'checkout')) notes.push({ level: 'warn', text: 'No Checkout link connected, so the Buy button will be off.' });
      return notes;
    },
    run: async (n, inp) => {
      const p = inp.product, s = inp.shots || null, c = inp.checkout || null;
      return { listing: {
        title: String(n.cfg.name || '').trim() || p.title, price: money(p.unitPrice), maker: p.maker || '', material: p.selectionLabel || '',
        description: String(p.description || '').split(/\r?\n/).filter((line) => line.trim() && !/^\s*[-•]/.test(line)).join(' ').slice(0, 600),
        // Studio keeps its own copy of Arcade's render; Arcade's own link expires, so prefer the copy when there is one.
        renderUrl: s?.sourceUrl || p.imageUrl, shots: (s?.items || []).map((x) => ({ label: x.label, url: x.url })),
        checkoutUrl: c?.checkoutUrl || '', productId: p.productId, made: new Date().toISOString(),
      } };
    },
    preview: (n) => {
      const l = n.out.listing;
      if (!l) return '';
      return `<div class="pv"><img src="${esc(l.shots[0]?.url || l.renderUrl)}" alt=""><div><span class="price">${esc(l.price || 'Price pending')}</span><span class="title">${esc(l.title)}</span><a href="${esc(linkFor(l))}" target="_blank" rel="noopener">Open the page</a></div></div>`;
    },
    result: (n) => {
      const l = n.out.listing;
      if (!l) return '';
      const pics = [{ label: 'As made', url: l.renderUrl }, ...l.shots];
      return `<p class="lede">${l.shots.length ? `${l.shots.length} model shot${l.shots.length === 1 ? '' : 's'} beside Arcade’s picture.` : 'Arcade’s picture alone. Connect Model shots to add yours.'} ${l.checkoutUrl ? 'The Buy button opens Arcade’s checkout.' : 'The Buy button is off until a Checkout link is connected.'}</p>
        <div class="i-imgs">${pics.map((x) => `<img class="i-img" src="${esc(x.url)}" alt="${esc(x.label)}" title="${esc(x.label)}">`).join('')}</div>
        <p style="margin-top:12px"><a class="btn wire" style="text-decoration:none" href="${esc(linkFor(l))}" target="_blank" rel="noopener">Open the listing page</a></p>`;
    },
  };
})();
